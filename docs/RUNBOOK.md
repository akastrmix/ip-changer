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
- 可选开启 IPv6 监测上报（当前仅记日志，不做额外播报）

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

- 写入 `/etc/default/changeip-http`
- 写入 `/etc/systemd/system/changeip-http.service`
- `systemctl enable changeip-http && systemctl restart changeip-http`

## 3. 修改配置

直接编辑：

- `/etc/default/changeip-http`

然后：

```bash
systemctl restart changeip-http
```

提示：

- 重新运行 `./install.sh` 也可以“重写配置文件并重启”，但会提示你重新输入参数；若你不想改 bot/worker 配置，务必沿用原 token。

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

### 6.5 Boil 场景 5 分钟验收清单

1) 检查关键变量是否齐全：

```bash
grep -E 'CHANGEIP_PROVIDER|CHANGEIP_HTTP_FLOW_FILE|BOIL_ACCOUNT|BOIL_PASSWORD|BOIL_ROUTER_ID|BOIL_INTERFACE|REBOOT_DELAY_MINUTES' /etc/default/changeip-http
```

2) 检查 flow 路径是否存在且是绝对路径（示例与生产不要混用）：

```bash
ls -l /root/ip-changer/flows/ippanel.boil.network.json
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

- `CHANGEIP_PROVIDER` 未配置或取值非法（`script` / `exec` / `http_flow`）
- 可优先查看响应字段 `provider_error_code`：`provider.unsupported` / `provider.config_invalid` / `provider.spawn_failed` / `provider.exited_early` / `provider.runtime_failed`
- provider=`script` 时：`CHANGEIP_SCRIPT` 路径不合法（必须为绝对路径，且指向可读的常规文件）
- provider=`script` 时：脚本创建进程失败（`failed to spawn changeip script`）
- provider=`script` 时：脚本启动后立即异常退出（`changeip script exited early`）
- provider=`exec` 时：命令为空/创建失败/启动后异常退出
- provider=`http_flow` 时：flow 文件 JSON 非法、模板变量缺失，或在启动探测窗口内步骤失败
- provider=`http_flow` 时：若 `/changeip` 已返回 `200`，后续后台步骤失败会写日志（例如 `background http_flow runtime error`），最终以 `change_*` 事件为准
- 状态文件无法写入（`failed to persist change session`）

### `/changeip` 返回 409

- 含义：当前已有进行中的换 IP 会话（返回体会带 `op_id`）
- 常见原因：上一轮还在等待监测窗口、重启后恢复中、或终态事件上报失败导致会话未清空
- 排查建议：
  - 查看日志：`journalctl -u changeip-http -n 200 --no-pager`
  - 查看会话文件：`cat /var/lib/changeip-http/pending_change.json`
  - 等待当前会话收敛；不要重复强制触发同一台 VPS

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
   - `IPV6_MONITOR_ENABLED=1`（可选，IPv6 监测；仅日志）

## 10. 回归脚本（开发验证）

在调整 `/changeip` 相关逻辑后，建议运行：

```bash
cd /root/ip-changer
node scripts/changeip_regression.js
```

该脚本不依赖第三方包，会先执行运行器级 quick cases，再执行端到端服务用例（结束后自动清理临时文件）。
维护方式：
- 基础能力在 `scripts/changeip_regression/harness.js`
- 运行器级 quick cases 在 `scripts/changeip_regression/quickCases.js`
- 端到端用例在 `scripts/changeip_regression/cases.js`
