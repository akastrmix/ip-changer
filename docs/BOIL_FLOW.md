# Boil Flow 专用说明（`ippanel.boil.network`）

本文档只描述 `http_flow` 在 `https://ippanel.boil.network` 的专用配置与运维要点。

对应 flow 文件：

- `flows/ippanel.boil.network.HKT.json`
- `flows/ippanel.boil.network.HKBN.json`
- `flows/samples/ippanel.boil.network.sample.json`

## 0. 文件角色（production vs sample）

- 生产文件（按服务器拆分）：
  - `flows/ippanel.boil.network.HKT.json`
  - `flows/ippanel.boil.network.HKBN.json`
  - `CHANGEIP_HTTP_FLOW_FILE` 应指向当前 VPS 对应的那一个。
- 示例文件：`flows/samples/ippanel.boil.network.sample.json`
  - 仅作为模板/备份，不建议直接作为生产路径。

## 1. 适用范围

- 目标场景：登录 Boil 面板，执行“一键查询全部 IP”，再触发指定服务器的“换 IP”。
- 当前版本定位：可上线的稳定版（v1），优先稳态可维护，不追求复杂分支。

## 2. 必填环境变量

以下变量必须在 VPS 的 `/etc/default/changeip-http` 中配置：

- `CHANGEIP_PROVIDER=http_flow`
- `CHANGEIP_HTTP_FLOW_FILE=/root/ip-changer/flows/ippanel.boil.network.HKT.json`（或 HKBN；按实际路径调整）
- `BOIL_ACCOUNT=<登录账号>`
- `BOIL_PASSWORD=<登录密码>`

注意：

- 当前生产 flow（`HKT/HKBN`）已把 `router_id/interface` 固定在文件内，不再强制依赖环境变量 `BOIL_ROUTER_ID/BOIL_INTERFACE`。
- 若你改为使用 sample 模板 flow，再需要在环境变量里配置 `BOIL_ROUTER_ID/BOIL_INTERFACE`，并确保与 `SERVER_LABEL` 一一对应，避免串台。

## 3. 建议的多机映射表（可选）

建议在你自己的运维台账维护如下映射（示例）：

| SERVER_LABEL | BOIL_ROUTER_ID | BOIL_INTERFACE |
| --- | --- | --- |
| HKT | 131 | adsl1 |
| HKBN | 208 | vwan32 |

部署前先核对这张表，再写入对应 flow 文件（或 sample flow + 环境变量）。

## 4. 当前流程（v1）

1. `submit_login_form`
   - `POST /login`
   - 发送 `account/password`
   - 允许状态码：`200/302`
   - 重试：`retries=2`，`retry_delay_ms=1200`
2. `query_all_before_reconnect`
   - `POST /api/query_all`
   - 请求体：`{}`
   - 允许状态码：`200/202`
   - 重试：`retries=1`，`retry_delay_ms=1000`
3. `wait_before_reconnect`
   - 固定等待 `5000ms`
4. `trigger_reconnect`
   - `POST /api/reconnect`
   - 请求体：`{"router_id":"...","interface":"..."}`
   - 允许状态码：`200/202`
   - 重试：`retries=3`，`retry_delay_ms=1500`
   - `allow_network_error=true`（触发后立即断网时不直接判 provider 失败）
   - 注意布尔字段必须使用 JSON 布尔值（`true/false`），不要写成字符串（如 `"true"`）

## 5. `/changeip` 成功语义（避免误判）

- `/changeip` 返回 `{"ok":true}` 仅表示“本次触发已被接受且会话已落盘，pending runner 将尽快启动 flow”。
- 它不保证此时 flow 已完成启动探测；对 boil 这类“触发后可能立即断网”的面板，这是为了避免响应丢失。
- 它不等价于“公网 IP 已确认变更”。
- 若返回 `409 change already in progress`，表示该 VPS 仍有未收敛会话；应继续跟踪该 `op_id`，不要重复触发。
- `http_flow` 带启动探测窗口（约 `1.5s`）：
  - 窗口内失败：通常 `/changeip` 已返回 `200`，随后会尽快上报 `change_failed(reason=http_flow_failed)`
  - 窗口后后台失败：同样由 `change_*` 终态事件收敛（并在日志中记录 `background http_flow runtime error`）
  - 只有“配置/编译期校验失败”（如 JSON 非法、模板变量缺失/未知变量引用、文件不可读）才会让 `/changeip` 直接返回 `500`
- 最终结果以后续会话事件为准：
  - `change_succeeded`：确认变更成功
  - `change_no_change`：执行了流程但 IP 未变化
  - `change_failed`：流程或后续监测失败
- 对 boil 这类“触发后可能立即断网”的面板，`allow_network_error=true` 会让触发步骤的网络错误可接受，因此更要以后续事件作为最终判定。

## 6. 兜底策略

### 6.1 重试策略

- 每个 `request` 可单独配置 `retries` + `retry_delay_ms`。
- 若响应为 `429` 且存在 `Retry-After` 头，会优先按 `Retry-After` 等待后再重试。
- 若没有 `Retry-After`，回退到 `retry_delay_ms`。

### 6.2 断网策略

- `trigger_reconnect` 开启 `allow_network_error=true`。
- 适配“点击换 IP 后连接立刻中断”的面板行为。
- 这种情况下 `/changeip` 不会因为该步网络错误直接失败，后续由监测状态机判定 `change_succeeded/change_no_change/change_failed`。

### 6.3 Flow 热更新策略

- `http_flow` 会按文件 `mtime/size` 做编译缓存校验。
- 正常情况下，更新当前 `CHANGEIP_HTTP_FLOW_FILE` 指向的 flow 后，下一次 `/changeip` 会自动生效，无需重启服务。
- 若你做了“同大小且极短时间内覆盖写入”的极端编辑，建议手动 `systemctl restart changeip-http` 避免缓存误判。

## 7. 已知边界

- 当前未使用“真实就绪信号”判断（即未启用 Boil 专用 `wait_until` 条件分支）。
- 如果面板在 `query_all + 5s` 后仍未准备好，`reconnect` 仍可能失败。
- Cloudflare challenge/验证码/2FA 不在该 flow 覆盖范围内。

## 8. 典型排障

### 8.1 `/changeip` 返回 500（多为配置/编译期校验失败）

```bash
journalctl -u changeip-http -n 200 --no-pager
```

优先看 `/changeip` 响应里的 `provider_error_code`（`provider.config_invalid` / `provider.unsupported`），再看日志中的：

- `changeip http_flow flow failed (...)`
- 失败步骤名（如 `step X (trigger_reconnect)`）

如果 `/changeip` 返回 `200` 但很快出现 `change_failed(reason=http_flow_failed)`，同样按以上日志定位具体 step。

### 8.2 怀疑串台（换错机器）

```bash
grep -E 'SERVER_LABEL|CHANGEIP_HTTP_FLOW_FILE|BOIL_ROUTER_ID|BOIL_INTERFACE' /etc/default/changeip-http
```

优先核对 `CHANGEIP_HTTP_FLOW_FILE` 是否指向正确的 HKT/HKBN 文件；若你用 sample flow，再核对 `BOIL_ROUTER_ID/BOIL_INTERFACE`。

### 8.3 快速验证接口

```bash
curl -X POST http://127.0.0.1:8787/changeip \
  -H 'Content-Type: application/json' \
  -d '{"token":"<AUTH_TOKEN>"}'
```

再看：

```bash
journalctl -u changeip-http -n 200 --no-pager
```

## 9. 后续增强方向

- 若后续抓到 Boil 的“就绪响应字段”，可升级为 `wait_until` 版本，替代固定 `sleep`。
- 若频繁触发 `429`，可增大 `query_all`/`reconnect` 的 `retries` 与 `retry_delay_ms`。
