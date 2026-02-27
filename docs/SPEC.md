# ip-changer — SPEC（行为规格）

本文档以“可验证的行为约定”为目标，描述 `ip-changer` 的对外接口、状态存储与 IPv4 监测/上报的关键规则。

## 1. 组件与职责

`ip-changer` 仅包含一个常驻服务：

- Node.js 脚本：`changeip_http_server.js`
  - 监听 HTTP 端口（默认 `0.0.0.0:8787`）
  - 可选：提供 `/changeip` 触发换 IP + 可选重启（`REBOOT_DELAY_MINUTES=-1` 时不重启）
- 可选：公网 IPv4 监测并上报到 CarpoolNotifier（仅在变化时上报）

破坏性更新说明：

- 为解决“脚本换 IP 失败但公网 IPv4 未变化导致 bot 会话卡住”，本项目已升级为 **事件流** 上报（不做向下兼容）。
- 唯一上报入口：`POST /internal/ip-events`。
- 事件包含 `op_id` + `event`（started/succeeded/no_change/failed…），用于让 CarpoolNotifier 收敛频道消息与锁定期。

非目标：

- 不负责 Telegram 交互（由 CarpoolNotifier 负责）
- 不负责数据库/持久业务逻辑（只维护自己极小的状态文件）
- 不负责自动安装系统依赖

## 2. 运行环境与依赖

- OS：Debian/Ubuntu 系
- Node.js：建议 16+（不依赖第三方包）
- systemd：用于自启与守护（通过 `install.sh` 安装）
- 如果启用 `/changeip`：需要 root 权限调用 `shutdown` 与执行 provider 触发动作（脚本/命令/http_flow）

## 3. 配置（环境变量）

通过 `/etc/default/changeip-http` 注入（或手动 `ENV=... node ...`）。

必需：

- `AUTH_TOKEN`：入站鉴权密钥（`/info`、`/changeip` 使用）

HTTP 服务：

- `PORT`：监听端口（默认 `8787`，范围 `1-65535`）

一键换 IP（可选）：

- `CHANGEIP_ENABLED`：`1/0`（默认建议 `0`）
- `CHANGEIP_PROVIDER`：provider 类型（`script` / `exec` / `http_flow`；当 `CHANGEIP_ENABLED=1` 时必填）
- `CHANGEIP_SCRIPT`：provider=`script` 时使用的脚本绝对路径
- `CHANGEIP_EXEC_COMMAND`：provider=`exec` 时执行的命令
- `CHANGEIP_HTTP_FLOW_FILE`：provider=`http_flow` 时使用的 flow JSON 绝对路径
- `REBOOT_DELAY_MINUTES`：provider 触发后，几分钟后重启（设置为 `-1` 表示不重启；否则仅允许 `1..15`，禁止 `0`）

`http_flow` flow 文件要点（v1）：

- 执行前会先进行“编译期校验”（结构、步骤字段、模板变量引用、正则/状态码格式）
- 顶层需包含非空 `steps` 数组
- 支持步骤：`request` / `extract` / `assert` / `sleep` / `set`
- 支持模板：`${var_name}` 与 `${ENV:VAR_NAME}`
- 自动维护 cookie 会话并支持重定向（默认开启）

IPv4 监测与上报（可选）：

- `IP_MONITOR_ENABLED`：`1/0`
- `IP_MONITOR_INTERVAL_SECONDS`：检测间隔（默认 `60`，最小 `10`）
- `IP_STATE_FILE`：状态文件（默认 `/var/lib/changeip-http/ip_state.json`）
- `SERVER_LABEL`：服务器标识（用于多服务器区分）
- `REPORT_CHANNEL`：播报目标（`@channel` 或私有频道 `-100...` chat_id；可留空表示不向频道播报，仅通知管理员）

事件流上报（破坏性更新：唯一上报入口）：

- `IP_EVENTS_ENABLED`：`1/0`
- `IP_EVENTS_ENDPOINT`：例如 `https://<worker>/internal/ip-events`
- `IP_EVENTS_TOKEN`：Bearer token（与 Worker secret `IP_EVENTS_TOKEN` 一致）
- `CHANGE_MONITOR_START_DELAY_SECONDS`：触发 provider 后延迟多久开始监测（默认 `30`；若设置了重启延迟，则会在“预计重启时间”之后再加上该延迟）
- `CHANGE_MONITOR_INTERVAL_SECONDS`：监测间隔（默认 `10`；仅在“换 IP 会话进行中”使用）
- `CHANGE_MONITOR_TIMEOUT_SECONDS`：监测超时（默认 `600` / 10 分钟）

关于 interval（避免“重复监测”误解）：

- 日常“自然变化”监测使用 `IP_MONITOR_INTERVAL_SECONDS`（默认 60s）。
- “换 IP 会话”需要更快收敛（默认 10s），因此提供 `CHANGE_MONITOR_INTERVAL_SECONDS`。
- 实现上不要求同时跑两套定时器：可以只跑一个循环；当存在换 IP 会话时临时提速到更快的间隔，从而避免重复请求。

判定规则（v1）：

- 开始监测后，获取到合法公网 IPv4 后即可判定终态：
  - 若 `ip1 != old_ipv4`：`change_succeeded`
  - 若 `ip1 == old_ipv4`：
    - 若安排了重启（`REBOOT_DELAY_MINUTES=1..15`）：立即判定为 `change_no_change`
    - 若不重启（`REBOOT_DELAY_MINUTES=-1`）：为避免“provider 执行中但网络仍可用”的误判，会等待一次“断网→恢复”或超时后再判定为 `change_no_change`
- 超时仍无法获取公网 IPv4：`change_failed`（`no_ipv4_observed`）

重启延迟规则：

- `REBOOT_DELAY_MINUTES=-1`：不重启（允许）
- `REBOOT_DELAY_MINUTES=1..15`：允许
- `REBOOT_DELAY_MINUTES=0`：禁止（避免“立刻重启”导致流程不确定）
- 其它：禁止

## 4. HTTP 接口

### 4.1 `GET /`

- 返回：`200` JSON `{ "ok": true, "service": "changeip-http" }`

### 4.2 `POST /info`

- 鉴权：Body 必须包含 `{ "token": "<AUTH_TOKEN>" }`
- 失败：`403` `{ ok:false, error:"forbidden" }`
- 成功：`200`，包含：
  - `server_label`
  - `channel`
  - `changeip_enabled`
  - `changeip_provider`：`CHANGEIP_PROVIDER`（未启用 `/changeip` 时为 `null`）
  - `ip_monitor_enabled`：只有监测真正“可用”时为 true（即 `IP_MONITOR_ENABLED=1` 且 `IP_EVENTS_*` 配置齐全）
  - `notified_ipv4`：状态文件中的 `notified_ipv4`（可能为 `null`）

### 4.3 `POST /changeip`（可选）

仅当 `CHANGEIP_ENABLED=1` 时启用，否则：

- `403` `{ ok:false, error:"changeip disabled" }`

启用时：

- 鉴权：Body 必须包含 `{ "token": "<AUTH_TOKEN>" }`，否则 `403`
- 若未启用事件流上报（`IP_EVENTS_ENABLED=1` 且配置齐全），则会返回 `500`：`ip events not configured`
- provider 规则：
  - `CHANGEIP_PROVIDER` 必须为 `script` / `exec` / `http_flow`
  - provider=`http_flow` 时，flow 文件必须是合法 JSON 对象，且包含非空 `steps` 数组
- 失败：
  - provider=`script`：
    - 脚本路径不是绝对路径：`500` `changeip script path must be absolute`
    - 脚本不存在：`500` `changeip script not found`
    - 脚本不是常规文件：`500` `changeip script is not a regular file`
    - 脚本不可读：`500` `changeip script not readable`
    - spawn 失败：`500` `failed to spawn changeip script`
    - 脚本启动后很快异常退出：`500` `changeip script exited early`
  - provider=`exec`：
    - 命令为空：`500` `changeip exec command is empty`
    - spawn 失败：`500` `failed to spawn changeip exec command`
    - 命令启动后很快异常退出：`500` `changeip exec command exited early`
  - provider=`http_flow`：
    - flow JSON 非法：`500` `invalid http_flow json: ...`
    - flow 顶层结构非法：`500` `http_flow file must be a JSON object`
    - `steps` 为空或不是数组：`500` `http_flow steps must be a non-empty array`
    - 执行中步骤失败（例如断言失败/变量缺失/请求异常）：`500` `changeip http_flow flow failed`
  - 所有 provider 启动失败响应都包含 `provider_error_code`，用于稳定机读分支：
    - `provider.unsupported`
    - `provider.config_invalid`
    - `provider.spawn_failed`
    - `provider.exited_early`
    - `provider.runtime_failed`
- 成功：
  - 后台执行：按 provider 触发（`script` / `exec` / `http_flow`）
  - 重启行为：
    - 若 `REBOOT_DELAY_MINUTES=-1`：不执行重启
    - 否则安排重启：`shutdown -r +<REBOOT_DELAY_MINUTES>`
  - 返回 `200`，包含：
    - `op_id`（用于 bot 会话关联）
    - `message`
    - `changeip_provider`
    - `server_label`
    - `channel`
    - `old_ipv4`（来自状态文件 `notified_ipv4`，可为 `null`）
    - `reboot_scheduled` / `reboot_delay_minutes`（用于调试，向后兼容新增字段）

## 5. IPv4 监测与上报规则

### 5.1 IPv4 获取

- 只获取并验证 **IPv4**（正则+每段 0-255）
- 会尝试多个来源（依次重试），直到拿到合法 IPv4 或全部失败
- 为保证“只走 IPv4 出站”，HTTP(S) 请求强制 `family=4`

### 5.2 何时上报

- **首次运行**：只初始化基线（写入 `notified_ipv4`），不进行上报
- 后续运行：当检测到当前 IPv4 `!= notified_ipv4` 时：
  - 发送事件上报到 `IP_EVENTS_ENDPOINT`（`event=ipv4_changed`）
  - 上报成功才会更新 `notified_ipv4`
  - 上报失败会保留旧的 `notified_ipv4`，从而在下一次检测仍会继续尝试上报（直到成功）

### 5.3 上报请求格式

Header：

- `Authorization: Bearer <IP_EVENTS_TOKEN>`

JSON Body：

```json
{
  "server_label": "HKT",
  "channel": "-1001234567890",
  "op_id": "20260128T061500Z_hkt_ipv4_7f2c0f",
  "ts": "2025-12-17T08:00:00.000Z",
  "event": "ipv4_changed",
  "old_ipv4": "1.2.3.4",
  "new_ipv4": "5.6.7.8"
}
```

### 5.4 状态文件格式（`IP_STATE_FILE`）

JSON 对象（字段可能随版本增加，但保持向后兼容）：

- `notified_ipv4`：上次“成功上报”的 IPv4（基线）
- `observed_ipv4`：最近一次观测到的 IPv4
- `updated_at`：最近一次更新状态的时间（ISO）
- `last_report_at`：最近一次成功上报时间（ISO，可选）
- `last_report_error`：最近一次上报失败的错误摘要（可选）

写入采用 `*.tmp` + rename 的方式，尽量避免半写入。
