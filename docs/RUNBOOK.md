# ip-changer — RUNBOOK（部署/运维/排障）

本文档面向“把项目部署到更多 VPS”的运维场景，提供最少步骤与明确的排障路径。

## 1. 两种安装模式（建议先选好）

### A. 仅监测上报（推荐用于 HKT 等无法脚本换 IP 的 VPS）

- 关闭 `/changeip`
- 开启 IPv4 监测上报（可选再开启 IPv6 监测）
- 可选：关闭入站端口（只做出站上报即可）

### B. 监测上报 + 一键换 IP（支持多种 provider）

- 开启 `/changeip`
- 开启 ip-events（`IP_EVENTS_ENABLED=1` + endpoint/token）；`/changeip` 依赖事件流收敛会话
- 配置 `CHANGEIP_PROVIDER` 与对应 provider 参数，再配置 `REBOOT_DELAY_MINUTES`（可设为 `-1` 禁用重启）
  - `script`：`CHANGEIP_SCRIPT`
  - `exec`：`CHANGEIP_EXEC_COMMAND`
  - `http_flow`：`CHANGEIP_HTTP_FLOW_FILE`（可参考 `flows/samples/ippanel.boil.network.sample.json`）
- 开启 IPv4 监测上报（推荐，用于自动播报与会话编辑）
- 可选开启 IPv6 监测上报（写入 iplog 并通知管理员；不向频道播报）
- 可选开启 `/ipquality`，用于在 VPS 本机异步执行固定路径的 IPQuality 脚本
  - 需要额外配置：`IPQUALITY_ENABLED=1`、`IPQUALITY_SCRIPT_PATH=/abs/path/to/ip.sh`
  - 当前阶段仅提供本机触发与状态查询，不负责“每日一次”业务判断，也不直接参与 `/changeip` 会话

若使用 boil 面板：请同时阅读 `docs/BOIL_FLOW.md`（包含变量映射、重试策略与“串台”排障建议）。

## 2. 标准安装（Debian/Ubuntu）

1) 安装 Node.js（若系统没有）：

```bash
apt update
apt install -y nodejs
```

2) 克隆并安装：

```bash
cd /root
git clone https://github.com/akastrmix/ip-changer.git
cd ip-changer
./install.sh
```

如果提示 `Permission denied`，再执行：

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

安装脚本会：

- 在写入前展示配置预览并二次确认（确认后才会写入并重启）
- 写入 `/etc/default/changeip-http`
- 写入 `/etc/systemd/system/changeip-http.service`
- `systemctl enable changeip-http && systemctl restart changeip-http`

补充：若你启用了 `/changeip`，安装脚本会自动启用 `IP_EVENTS_ENABLED=1`，并继续要求填写 `IP_EVENTS_ENDPOINT/IP_EVENTS_TOKEN`。

若你启用了 `/ipquality`：

- 仓库自带固定版本脚本：`vendor/ipquality/ip.sh`
- 安装脚本默认会把 `IPQUALITY_SCRIPT_PATH` 指向当前仓库内的 `vendor/ipquality/ip.sh`
- ip-changer 会用 `/bin/bash <IPQUALITY_SCRIPT_PATH> -4 -n` 执行；`-4` 表示只生成 IPv4 报告，`-n` 表示跳过 IPQuality 自己的依赖安装器
- 若你手动填的路径不存在，也可以先完成部署；等真正调用 `/ipquality` 时，服务会按当前文件状态返回明确错误

注意：`./install.sh` 每次执行都会完整覆盖 `/etc/default/changeip-http`，不会保留旧文件中的额外自定义环境变量。

## 3. 修改配置

直接编辑：

- `/etc/default/changeip-http`

然后：

```bash
systemctl restart changeip-http
```

提示：

- 重新运行 `./install.sh` 也可以“重写配置文件并重启”，但会提示你重新输入参数；若你不想改 bot/worker 配置，务必沿用原 token。
- `./install.sh` 会完整重写 `/etc/default/changeip-http`。如果你手工加过自定义变量（例如 provider 所需变量），请先备份并在安装后恢复。
- 若你启用了 `/ipquality`，常改的额外变量有：
  - `IPQUALITY_ENABLED`
  - `IPQUALITY_SCRIPT_PATH`
  - `IPQUALITY_STATE_FILE`
  - `IPQUALITY_TIMEOUT_SECONDS`

## 4. 更新代码（GitHub 更新后）

```bash
cd /root/ip-changer
git pull
systemctl restart changeip-http
```

## 5. 卸载（完全移除系统级改动）

```bash
cd /root/ip-changer
./uninstall.sh
```

卸载会删除：

- `/etc/systemd/system/changeip-http.service`
- `/etc/systemd/system/multi-user.target.wants/changeip-http.service`（由 `systemctl enable` 创建的自启 symlink）
- `/etc/default/changeip-http`
- `/var/lib/changeip-http`

不会删除：

- 你的 provider 相关文件（例如 `/root/changeip.sh`、自定义 flow JSON 等）
- 你的仓库目录（可手动 `rm -rf /root/ip-changer`）

## 6. 验证与测试

### 6.1 本机健康检查

```bash
curl http://127.0.0.1:8787/
```

### 6.2 `/info`（需要 AUTH_TOKEN）

```bash
curl -X POST http://127.0.0.1:8787/info -H 'Content-Type: application/json' -d '{"token":"<AUTH_TOKEN>"}'
```

### 6.3 IPv4/IPv6 上报验证（推荐）

最直接的验证方式是在 CarpoolNotifier 增加/使用测试命令向频道发消息（例如 `/test_ip_channel`）。

若要验证 `ip-changer → Worker` 是否通：

- 检查日志：`journalctl -u changeip-http -n 200 --no-pager`
- 检查状态文件：`cat /var/lib/changeip-http/ip_state.json`
  - 若上报失败，`last_report_error` 会记录最近一次失败的错误摘要
  - 若一直未能初始化基线，说明公网 IPv4 获取可能失败（可查看日志中的 `monitor error:`）
  - IPv6 监测开启后，状态文件会增加 `notified_ipv6` / `observed_ipv6` / `last_report_error_ipv6`

### 6.4 `/changeip`（可能触发真实重启，取决于 `REBOOT_DELAY_MINUTES`，谨慎）

如果你只想测试 provider 触发但不想重启，可先在 `/etc/default/changeip-http` 设置：

- `REBOOT_DELAY_MINUTES=-1`

并执行 `systemctl restart changeip-http` 后再测试。

```bash
curl -X POST http://127.0.0.1:8787/changeip -H 'Content-Type: application/json' -d '{"token":"<AUTH_TOKEN>"}'
```

说明：

- `{"ok":true}` 代表触发已接受，不代表最终换 IP 一定成功。
- 最终结果请看后续事件：`change_succeeded` / `change_no_change` / `change_failed`。
- 若返回 `409 change already in progress`，表示当前已有会话未收敛；可用返回里的 `op_id` 继续跟踪同一会话结果。

### 6.5 `/ipquality`（可选）

前提：

- `IPQUALITY_ENABLED=1`
- `IPQUALITY_SCRIPT_PATH` 指向 VPS 本地已存在的固定脚本；推荐使用 `/root/ip-changer/vendor/ipquality/ip.sh`

触发一次检测：

```bash
curl -X POST http://127.0.0.1:8787/ipquality \
  -H 'Content-Type: application/json' \
  -d '{"token":"<AUTH_TOKEN>"}'
```

查看最近状态：

```bash
curl -X POST http://127.0.0.1:8787/ipquality/status \
  -H 'Content-Type: application/json' \
  -d '{"token":"<AUTH_TOKEN>"}'
```

判读方式：

- `state=started`：本次请求已创建新的后台任务
- `state=running`：当前已有检测在跑，本次不会重复启动第二份脚本
- `last_success.report_url`：最近一次成功提取出的在线报告链接
- `last_failure.error`：最近一次失败原因

当前 `/ipquality` 只保存 IPv4 报告 URL。若后续要展示 IPv6，应先把状态/HTTP 契约扩展为 `ipv4_report_url` + `ipv6_report_url`，再让 CarpoolNotifier 同步扩展 D1 缓存、Telegram 模板和每日缓存逻辑；不要在只支持单 `report_url` 的契约下重新启用 IPQuality 双栈输出。

补充：

- 当前阶段不会自动回调 CarpoolNotifier，也不内置“每天只跑一次”判断
- 服务重启时若发现旧的 `current_run` 还停留在运行中，会把它修复成 `last_failure.error=service_restarted_during_ipquality_run`

### 6.6 Boil 场景 5 分钟验收清单

1) 检查关键变量是否齐全：

```bash
grep -E 'CHANGEIP_PROVIDER|CHANGEIP_HTTP_FLOW_FILE|BOIL_ACCOUNT|BOIL_PASSWORD|REBOOT_DELAY_MINUTES|BOIL_ROUTER_ID|BOIL_INTERFACE' /etc/default/changeip-http
```

说明：`BOIL_ROUTER_ID/BOIL_INTERFACE` 仅在你使用 sample 模板 flow 时需要；若使用 `HKT/HKBN` 拆分 flow，可不配置。

2) 检查当前 `CHANGEIP_HTTP_FLOW_FILE` 指向的 flow 是否存在且是绝对路径（示例与生产不要混用）：

```bash
bash -lc '. /etc/default/changeip-http; echo "$CHANGEIP_HTTP_FLOW_FILE"; ls -l "$CHANGEIP_HTTP_FLOW_FILE"'
```

3) 重启服务并确认启动正常：

```bash
systemctl restart changeip-http
systemctl status changeip-http --no-pager
```

4) 触发一次 `/changeip`（建议先设 `REBOOT_DELAY_MINUTES=-1` 做首轮验收）：

```bash
curl -X POST http://127.0.0.1:8787/changeip \
  -H 'Content-Type: application/json' \
  -d '{"token":"<AUTH_TOKEN>"}'
```

5) 看日志确认流程与结果事件是否收敛：

```bash
journalctl -u changeip-http -n 200 --no-pager
```

重点观察：

- 是否出现 `changeip http_flow flow failed`（若有，先修 flow/变量）
- 是否出现最终会话事件：`change_succeeded` / `change_no_change` / `change_failed`

## 7. 安全建议

- **强烈建议**只在受控网络开放 `PORT`：
  - 仅监测上报模式：可直接把入站 `8787` 关掉（不影响出站上报）
  - 一键换 IP 模式：建议用防火墙限制来源（只允许你的管理 IP 或可信反代）
- `AUTH_TOKEN` / `IP_EVENTS_TOKEN` 必须随机且保密
- token 轮换：
  - 修改 VPS：`/etc/default/changeip-http` 后重启
  - 同步更新 Worker/CarpoolNotifier 对应的 token

## 8. 常见问题排障

### 服务启动失败

```bash
systemctl status changeip-http --no-pager
journalctl -u changeip-http -n 200 --no-pager
```

常见原因：

- `AUTH_TOKEN` 为空：服务会拒绝启动
- 端口被占用：修改 `PORT` 后重启
- `node` 不存在：先安装 `nodejs`

### `/info` 或 `/changeip` 返回 403

- token 不匹配（CarpoolNotifier 中该 `SERVER_LABEL` 的 token 与 VPS 的 `AUTH_TOKEN` 必须一致；通常在 `CHANGEIP_TOKENS_JSON` 里配置）
- 或 `/changeip` 未启用（`CHANGEIP_ENABLED=0`）

### `/changeip` 返回 500

说明：为适配“触发后立刻断网”的 provider，`/changeip` 通常会**先落盘会话并尽快返回 `200`**。因此：

- `/changeip` 返回 `500` 更多表示“校验阶段失败”或“状态文件无法落盘”，而不是 provider 运行时失败。

常见原因：

- 未启用事件流上报（`IP_EVENTS_ENABLED=1` 且 `IP_EVENTS_ENDPOINT/IP_EVENTS_TOKEN` 配齐），会返回 `500 ip events not configured`
- `CHANGEIP_PROVIDER` 未配置或取值非法（`script` / `exec` / `http_flow`）
- 可优先查看响应字段 `provider_error_code`（仅校验失败时返回）：`provider.unsupported` / `provider.config_invalid`
- provider=`script`：
  - `CHANGEIP_SCRIPT` 路径不合法（必须为绝对路径，且指向可读的常规文件）
- provider=`exec`：
  - `CHANGEIP_EXEC_COMMAND` 为空
- provider=`http_flow`：
  - flow 文件不可读/JSON 非法
  - 模板变量缺失/未知变量引用等“编译期”错误
- 状态文件无法写入（`failed to persist change session`）

如果 `/changeip` 返回 `200` 但随后很快出现 `change_failed(reason=spawn_failed|*_exited_early|http_flow_failed)`，请按日志与 `change_*` 事件排障（`journalctl -u changeip-http ...`），最终以 `change_*` 终态为准。

### `/changeip` 返回 409

- 含义：当前已有进行中的换 IP 会话（返回体会带 `op_id`）
- 常见原因：上一轮还在等待监测窗口、重启后恢复中、或终态事件上报失败导致会话未清空
- 排查建议：
  - 查看日志：`journalctl -u changeip-http -n 200 --no-pager`
- 查看会话文件：`cat /var/lib/changeip-http/pending_change.json`
- 等待当前会话收敛；不要重复强制触发同一台 VPS

### `/ipquality` 返回 403

- `IPQUALITY_ENABLED=0`
- 或者你改完配置后还没 `systemctl restart changeip-http`

### `/ipquality` 返回 500

常见原因：

- `IPQUALITY_SCRIPT_PATH` 不是绝对路径
- `IPQUALITY_SCRIPT_PATH` 不存在、不可读，或不是常规文件
- 脚本执行超时（`IPQUALITY_TIMEOUT_SECONDS`）
- 脚本输出里没提取到 `https://...svg` 报告链接
- `IPQUALITY_STATE_FILE` 不是合法 JSON 对象，导致状态读写报错

优先排查：

```bash
journalctl -u changeip-http -n 200 --no-pager
cat /var/lib/changeip-http/ipquality_state.json
```

### `/ipquality/status` 看不到最近结果

- 若 `last_success` 和 `last_failure` 都为空，通常表示这台机器还没成功跑过任何一次检测
- 若只有 `current_run`，说明脚本仍在执行中；再次触发 `/ipquality` 只会返回同一个 `run_id`
- 若服务刚在运行中重启，旧 run 会被修复为 `last_failure.error=service_restarted_during_ipquality_run`

### Worker 返回 401

- `IP_EVENTS_TOKEN` 不一致（多台 VPS 建议共用同一个 token）

### 频道收不到消息

- bot 没进频道或权限不够（建议设为管理员并允许编辑消息）
- `REPORT_CHANNEL` 写错：公有用 `@xxx`，私有用 `-100...`

## 9. 上报接口（/internal/ip-events）

你已确认：不做向下兼容，因此 `ip-changer` 只上报到 `/internal/ip-events`：

1) CarpoolNotifier：配置 secret `IP_EVENTS_TOKEN`
2) VPS ip-changer：配置并启用：
   - `IP_EVENTS_ENABLED=1`
   - `IP_EVENTS_ENDPOINT=https://<worker>/internal/ip-events`
   - `IP_EVENTS_TOKEN=<same as worker secret>`
   - `IP_MONITOR_ENABLED=1`（IPv4 监测）
   - `IPV6_MONITOR_ENABLED=1`（可选，IPv6 监测；写入 iplog 并通知管理员；不向频道播报）

## 10. 回归脚本（开发验证）

在调整 `/changeip`、`/ipquality`、状态文件或安装脚本后，建议运行：

```bash
cd /root/ip-changer
node scripts/changeip_regression.js
```

该脚本不依赖第三方包，会先执行运行器级 quick cases，再执行端到端服务用例（结束后自动清理临时文件）。
维护方式：
- 基础能力在 `scripts/changeip_regression/harness.js`
- 运行器级 quick cases 在 `scripts/changeip_regression/quickCases.js`
- 端到端用例在 `scripts/changeip_regression/cases.js`
