# ip-changer — SPEC（行为规格）

本文档以“可验证的行为约定”为目标，描述 `ip-changer` 的对外接口、状态存储与 IPv4/IPv6 监测/上报的关键规则。

代码契约入口：`src/contracts/ipEvents.js`（事件枚举、`contract_version`、必填字段约束，发送前本地校验）。

## 1. 组件与职责

`ip-changer` 仅包含一个常驻服务：

- Node.js 脚本：`changeip_http_server.js`
  - 监听 HTTP 端口（默认 `0.0.0.0:8787`）
  - 可选：提供 `/changeip` 触发换 IP + 可选重启（`REBOOT_DELAY_MINUTES=-1` 时不重启）
- 可选：公网 IPv4/IPv6 监测并上报到 CarpoolNotifier（仅在变化时上报）

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
- `script` / `exec` provider 依赖 `/bin/bash`，以 Debian/Ubuntu 服务器环境为边界；不提供 Windows 运行时兼容

## 3. 配置（环境变量）

通过 `/etc/default/changeip-http` 注入（或手动 `ENV=... node ...`）。

必需：

- `AUTH_TOKEN`：入站鉴权密钥（`/info`、`/changeip` 使用）

HTTP 服务：

- `PORT`：监听端口（默认 `8787`，范围 `1-65535`）
- 数值型配置仅在“未设置”时使用默认值；若填了非法值、非整数或超出允许范围，服务会在配置加载阶段直接拒绝启动

一键换 IP（可选）：

- `CHANGEIP_ENABLED`：`1/0`（默认建议 `0`）
- `CHANGEIP_PROVIDER`：provider 类型（`script` / `exec` / `http_flow`；当 `CHANGEIP_ENABLED=1` 时必填）
- `CHANGEIP_SCRIPT`：provider=`script` 时使用的脚本绝对路径
- `CHANGEIP_EXEC_COMMAND`：provider=`exec` 时执行的命令
- `CHANGEIP_HTTP_FLOW_FILE`：provider=`http_flow` 时使用的 flow JSON 绝对路径
- `REBOOT_DELAY_MINUTES`：provider 触发后，几分钟后重启（设置为 `-1` 表示不重启；否则仅允许 `1..15`，禁止 `0`）
- 当 `CHANGEIP_ENABLED=1` 且 `REBOOT_DELAY_MINUTES!=-1` 时，配置加载阶段必须能找到 `/usr/sbin/shutdown` 或 `/sbin/shutdown`；否则直接启动失败

`http_flow` flow 文件要点（v1）：

- 执行前会先进行“编译期校验”（结构、步骤字段、模板变量引用、正则/状态码格式）
- 顶层需包含非空 `steps` 数组
- 支持步骤：`request` / `wait_until` / `extract` / `assert` / `sleep` / `set`
- `request` 步骤可设置 `allow_network_error=true`：用于“触发后立即断网”的最后一步请求，网络错误会被视为可接受
- `request` 步骤支持 `retries` / `retry_delay_ms`：用于临时失败自动重试（当响应为 `429` 且有 `Retry-After` 头时，优先按该值等待）
- `wait_until`：按 `interval_ms` 轮询 `request`，直到 `assert` 通过或 `timeout_ms` 超时（硬超时；超时后成功结果无效）
- 支持模板：`${var_name}` 与 `${ENV:VAR_NAME}`
- 自动维护 cookie 会话并支持重定向（默认开启）
- `http_flow` 的布尔字段必须是 JSON 布尔值（`true/false`），例如：`follow_redirects`、`allow_network_error`、`trim`、`decode_uri_component`、`assert.exists`

自然 IP 监测与上报（可选）：

- `IP_MONITOR_ENABLED`：`1/0`（IPv4）
- `IP_MONITOR_INTERVAL_SECONDS`：IPv4/IPv6 检测间隔（默认 `60`，最小 `10`）
- `IPV6_MONITOR_ENABLED`：`1/0`（IPv6，默认 `0`）
- `IP_STATE_FILE`：状态文件（默认 `/var/lib/changeip-http/ip_state.json`）
- `SERVER_LABEL`：服务器标识（用于多服务器区分）
- `REPORT_CHANNEL`：播报目标（`@channel` 或负数 chat_id，常见为 `-100...`；可留空表示不向频道播报，仅通知管理员；格式非法会在配置加载阶段直接拒绝）

事件流上报（破坏性更新：唯一上报入口）：

- `IP_EVENTS_ENABLED`：`1/0`
- `IP_EVENTS_ENDPOINT`：例如 `https://<worker>/internal/ip-events`
- `IP_EVENTS_TOKEN`：Bearer token（与 Worker secret `IP_EVENTS_TOKEN` 一致）
- `CHANGE_MONITOR_START_DELAY_SECONDS`：触发 provider 后延迟多久开始监测（默认 `30`；若设置了重启延迟，则会在“预计重启时间”之后再加上该延迟）
- `CHANGE_MONITOR_INTERVAL_SECONDS`：监测间隔（默认 `10`；仅在“换 IP 会话进行中”使用）
- `CHANGE_MONITOR_TIMEOUT_SECONDS`：监测超时（默认 `1800` / 30 分钟）

关于 interval（避免“重复监测”误解）：

- 日常“自然变化”监测中，IPv4 与 IPv6 复用 `IP_MONITOR_INTERVAL_SECONDS`。
- “换 IP 会话”需要更快收敛（默认 10s），因此提供 `CHANGE_MONITOR_INTERVAL_SECONDS`。
- 三者是独立调度线：自然 IPv4、自然 IPv6 与会话监测各自按自己的 `next_due` 运行，不互相覆盖间隔配置。

判定规则（v1）：

- `/changeip` 会话终态判定只看 IPv4；IPv6 当前不参与 `change_*` 语义。
- 开始监测后，获取到合法公网 IPv4 后即可判定终态：
  - 若 `old_ipv4` 缺失（会话创建时未拿到基线）：
    - 不会再从 `IP_STATE_FILE` 或额外公网查询回填基线
    - 会直接收敛为 `change_failed`（`old_ipv4_unknown`）
  - 若 `ip1 != old_ipv4`：`change_succeeded`
  - 若 `ip1 == old_ipv4`：
    - 若安排了重启（`REBOOT_DELAY_MINUTES=1..15`）：立即判定为 `change_no_change`
    - 若不重启（`REBOOT_DELAY_MINUTES=-1`）：为避免“provider 执行中但网络仍可用”的误判，会等待一次“断网→恢复”或超时后再判定为 `change_no_change`
- 超时仍无法获取公网 IPv4：`change_failed`（`no_ipv4_observed`）
- 若会话已超时且终态事件连续上报失败：会保持 `pending_change` 并按 `CHANGE_MONITOR_INTERVAL_SECONDS` 重试；同时输出节流告警（默认每 5 分钟最多一次）
- 若 `pending_change` 字段不合法：会尝试上报 `change_failed`（`invalid_pending_schema` / `invalid_pending_timing`），上报成功后清理会话；若上报不可达则保留会话并重试（若 payload 本身非法则直接清理）
- 若 `pending_change` 缺少可用 `op_id`：无法构造合法 `change_failed` payload，会直接清理会话（清理失败则按监测间隔重试清理）

重启延迟规则：

- `REBOOT_DELAY_MINUTES=-1`：不重启（允许）
- `REBOOT_DELAY_MINUTES=1..15`：允许
- `REBOOT_DELAY_MINUTES=0`：禁止（避免“立刻重启”导致流程不确定）
- 其它：禁止

## 4. HTTP 接口

HTTP 防护约束（资源与稳定性）：

- 入站请求体大小限制：`/info` 与 `/changeip` 默认最多读取 `1024` bytes，超限返回 `413`
- 服务端显式设置超时：`request=300s`、`headers=60s`、`keep-alive=5s`
- 出站 HTTP 响应体读取有大小上限：
  - 通用请求（公网 IP 获取、ip-events 上报）：约 `1 MiB`
  - `http_flow` 请求步骤：约 `4 MiB`
  - 超限即中断读取并按失败处理
- 若上游在响应体未完整前提前断开连接，会立即按失败处理（不等待到请求超时）
- 出站 HTTP 默认使用 keep-alive 连接复用（通用网络层与 `http_flow` 均启用），降低重复握手开销
- `change_*` 终态事件上报带短重试（最多 3 次，带退避抖动）；自然变化事件（`ipv4_changed` / `ipv6_changed`）保持单次上报

### 4.1 `GET /`

- 返回：`200` JSON `{ "ok": true, "service": "changeip-http" }`

### 4.2 `POST /info`

- 鉴权：Body 必须是 JSON 对象，且包含 `{ "token": "<AUTH_TOKEN>" }`
- 若 Body 不是 JSON 对象（例如 `[]`、`123`、`"abc"`），返回 `400` `{ ok:false, error:"json body must be an object" }`
- 失败：`403` `{ ok:false, error:"forbidden" }`
- 成功：`200`，包含：
  - `server_label`
  - `channel`
  - `changeip_enabled`
  - `changeip_provider`：`CHANGEIP_PROVIDER`（未启用 `/changeip` 时为 `null`）
  - `ip_events_enabled`：事件流上报是否可用（`IP_EVENTS_ENABLED=1` 且 endpoint/token 均非空）
  - `ip_monitor_enabled`：只有监测真正“可用”时为 true（即 `IP_MONITOR_ENABLED=1` 且 `IP_EVENTS_*` 配置齐全）
  - `ipv6_monitor_enabled`：只有 IPv6 监测真正“可用”时为 true（即 `IPV6_MONITOR_ENABLED=1` 且 `IP_EVENTS_*` 配置齐全）
  - `ip_events_contract_version`：当前上报使用的契约版本（例如 `2026-04-03.v1`）
  - `ip_events_contract_versions_supported`：当前支持的契约版本列表
  - `notified_ipv4`：状态文件中的 `notified_ipv4`（可能为 `null`）
  - `notified_ipv6`：状态文件中的 `notified_ipv6`（可能为 `null`）
  - `runtime_metrics`：进程内运行时指标（上报成功/失败计数、监测 tick 计数、最近错误）

### 4.3 `POST /changeip`（可选）

仅当 `CHANGEIP_ENABLED=1` 时启用，否则：

- `403` `{ ok:false, error:"changeip disabled" }`

启用时：

- 鉴权：Body 必须是 JSON 对象，且包含 `{ "token": "<AUTH_TOKEN>" }`，否则 `403`
  - 若 Body 不是 JSON 对象（例如 `[]`、`123`、`"abc"`），返回 `400` `{ ok:false, error:"json body must be an object" }`
  - 可选：`{ "force": true }` 用于清理“已超时”的 `pending_change` 会话并重新触发
    - 仅当会话的 `timeout_at_ms` 合法且已超时（或 `terminal_sent=true`）时才允许清理；时序字段损坏时不会做推导式清理
- 若未启用事件流上报（`IP_EVENTS_ENABLED=1` 且配置齐全），则会返回 `500`：`ip events not configured`
- 若存在进行中的会话（`pending_change.json` 里已有 `op_id`），默认返回 `409`：`change already in progress`（并带现有 `op_id`）
  - 若请求带 `force=true` 且该会话的 `timeout_at_ms` 合法且已超时（或 `terminal_sent=true`），则会先清理旧会话再触发新会话
- provider 规则：
  - `CHANGEIP_PROVIDER` 必须为 `script` / `exec` / `http_flow`
  - provider=`http_flow` 时，flow 文件必须是合法 JSON 对象，且包含非空 `steps` 数组
- 失败：
  - provider=`script`：
    - 脚本路径不是绝对路径：`500` `changeip script path must be absolute`
    - 脚本不存在：`500` `changeip script not found`
    - 脚本不是常规文件：`500` `changeip script is not a regular file`
    - 脚本不可读：`500` `changeip script not readable`
  - provider=`exec`：
    - 命令为空：`500` `changeip exec command is empty`
  - provider=`http_flow`：
    - flow JSON 非法：`500` `invalid http_flow json: ...`
    - flow 顶层结构非法：`500` `http_flow file must be a JSON object`
    - `steps` 为空或不是数组：`500` `http_flow steps must be a non-empty array`
  - 启动探测/运行时失败：
    - `/changeip` 的 `ok=true` 仅表示“触发已接受”，不保证此时 provider 已完成启动探测。
    - provider 的 `spawn_failed` / `*_exited_early` / `http_flow_failed` 等启动/运行时失败会尽快上报 `change_failed(reason=...)`，并由监测循环在必要时重试同一终态事件。
  - 仅“校验阶段失败”的 `500` 响应包含 `provider_error_code`（用于稳定机读分支）：
    - `provider.unsupported`
    - `provider.config_invalid`
  - provider 启动失败时会尝试立即上报 `change_failed`；若该次上报被拒绝/超时，会保留 pending 会话并由监测循环重试同一 `change_failed`（`reason` 维持原失败原因）
- 成功：
  - 后台执行：按 provider 触发（`script` / `exec` / `http_flow`）
  - 重启行为：
    - 若 `REBOOT_DELAY_MINUTES=-1`：不执行重启
    - 否则安排重启：使用固定路径 `/usr/sbin/shutdown` 或 `/sbin/shutdown` 执行 `shutdown -r +<REBOOT_DELAY_MINUTES>`；二进制缺失会在启动阶段直接失败
  - 返回 `200`，包含：
    - `op_id`（用于 bot 会话关联）
    - `message`
    - `changeip_provider`
    - `server_label`
    - `channel`
    - `old_ipv4`（优先来自状态文件 `notified_ipv4`，其次 `observed_ipv4`，可为 `null`）
    - `reboot_schedule_requested`（是否计划安排重启；`REBOOT_DELAY_MINUTES!=-1`）
    - `reboot_delay_minutes`（计划的重启延迟分钟；`REBOOT_DELAY_MINUTES=-1` 时为 `-1`）
  - 语义说明：
    - `200 + ok=true` 表示“触发已接受”，不表示最终换 IP 成功。
    - 最终结果以后续会话终态事件 `change_succeeded` / `change_no_change` / `change_failed` 为准。

## 5. 自然 IP 监测与上报规则

### 5.1 IPv4/IPv6 获取

- 只获取并验证 **IPv4**（正则+每段 0-255）
- 只获取并验证 **IPv6**（`net.isIP(...) === 6`）
- 各协议都会尝试多个来源（依次重试），直到拿到合法地址或全部失败
- IPv4 检测请求强制 `family=4`，IPv6 检测请求强制 `family=6`
- 上述出站请求的响应体读取默认受 `~1 MiB` 上限保护，避免异常大响应造成内存占用抬升
- 事件上报请求保持默认 `family=4`，不因事件类型切换到 IPv6 出站
- 启动时会先做一次 IPv6 可达性探测；若失败仅告警一次并继续后台重试，IPv4/IPv6 监测错误日志按节流窗口输出（默认 5 分钟）

### 5.2 何时上报

- **首次运行**：各协议各自初始化基线（写入 `notified_ipv4` / `notified_ipv6`），不进行上报
- 后续运行：当检测到当前 IPv4 `!= notified_ipv4` 时：
  - 发送事件上报到 `IP_EVENTS_ENDPOINT`（`event=ipv4_changed`）
  - 上报成功才会更新 `notified_ipv4`
  - 上报失败会保留旧的 `notified_ipv4`，从而在下一次检测仍会继续尝试上报（直到成功）
  - 为避免短暂故障导致“同一次变化被重复播报”：同一次观测到的变化会先把 `op_id + old/new` 持久化到状态文件，并在后续重试中复用同一个 `op_id`；上报成功（或变化回滚到基线）后会清理该 pending 记录
- 后续运行：当检测到当前 IPv6 `!= notified_ipv6` 时：
  - 发送事件上报到 `IP_EVENTS_ENDPOINT`（`event=ipv6_changed`）
  - 上报成功才会更新 `notified_ipv6`
  - 上报失败会保留旧的 `notified_ipv6`，从而在下一次检测仍会继续尝试上报（直到成功）
  - 同理：IPv6 自然变化上报失败重试也会复用同一个 `op_id`（直到成功或回滚）

### 5.3 上报请求格式

Header：

- `Authorization: Bearer <IP_EVENTS_TOKEN>`

JSON Body：

- `channel` 为必带字段
  - 值只能是 `@xxx`、负数 chat_id（常见为 `-100...`）或空字符串
  - 空字符串表示禁用频道播报
  - `ip-changer` 不再发送“省略 channel”的旧 payload

```json
{
  "server_label": "HKT",
  "channel": "-1001234567890",
  "op_id": "20260128T061500Z_hkt_ipv4_7f2c0f",
  "ts": "2025-12-17T08:00:00.000Z",
  "contract_version": "2026-04-03.v1",
  "event": "ipv4_changed",
  "old_ipv4": "1.2.3.4",
  "new_ipv4": "5.6.7.8"
}
```

IPv6 自然变化事件示例：

```json
{
  "server_label": "HKT",
  "channel": "-1001234567890",
  "op_id": "20260128T061500Z_hkt_ipv6_7f2c0f",
  "ts": "2025-12-17T08:00:00.000Z",
  "contract_version": "2026-04-03.v1",
  "event": "ipv6_changed",
  "old_ipv6": "240e:3a1:1000::10",
  "new_ipv6": "240e:3a1:1000::11"
}
```

### 5.4 状态文件格式（`IP_STATE_FILE`）

JSON 对象（以当前版本定义为准，不承诺向后兼容旧字段）：

- 若文件存在但不是合法 JSON 对象，或当前进程无权读取，服务会在启动时直接失败；不会把该情况当作“空状态”
- 若运行中再次读取到损坏/不可读的 `IP_STATE_FILE`，服务会直接退出，由外部守护进程拉起；不会继续带着坏状态运行

- `notified_ipv4`：上次“成功上报”的 IPv4（基线）
- `observed_ipv4`：最近一次观测到的 IPv4
- `notified_ipv6`：上次“成功上报”的 IPv6（基线，可选）
- `observed_ipv6`：最近一次观测到的 IPv6（可选）
- `updated_at`：最近一次更新状态的时间（ISO）
- `last_report_at`：最近一次成功上报时间（ISO，可选）
- `last_report_error`：最近一次上报失败的错误摘要（可选）
- `last_report_at_ipv6`：最近一次 IPv6 成功上报时间（ISO，可选）
- `last_report_error_ipv6`：最近一次 IPv6 上报失败摘要（可选）
- `pending_ipv4_op_id` / `pending_ipv4_old_ipv4` / `pending_ipv4_new_ipv4`（可选）：
  - 当观测到 IPv4 变化但上报尚未成功时，用于暂存本次变化的 `op_id + old/new`，以便重试时保持幂等（避免重复播报）
  - 上报成功或变化回滚到基线（`observed_ipv4 == notified_ipv4`）后会清理该字段
- `pending_ipv6_op_id` / `pending_ipv6_old_ipv6` / `pending_ipv6_new_ipv6`（可选）：同理（用于 `ipv6_changed`）

写入采用 `*.tmp` + rename，并对临时文件做 `fsync`（目录 `fsync` 为 best-effort），尽量降低断电场景下丢最近一次写入的概率。

### 5.5 会话文件格式（`PENDING_CHANGE_FILE`）

JSON 对象（用于跨重启恢复；字段按当前版本严格校验，不兼容旧格式）：

- 若文件存在但 JSON 语法损坏、不是对象或无法读取，服务会在启动时直接失败；只有“文件不存在”才表示当前无 pending 会话
- 若运行中再次读取到损坏/不可读的 `PENDING_CHANGE_FILE`，服务会直接退出，由外部守护进程拉起；不会继续做降级重试

- `op_id`：当前换 IP 会话 ID
- `server_label` / `channel`：本次会话路由字段
- `old_ipv4`：会话基线 IP（可为空）
- `provider_start_attempted`：是否已尝试启动 provider（用于跨重启避免重复触发；启动探测窗口内崩溃也会留下该标记）
- `provider_start_attempted_at`：启动 provider 尝试时间（ISO，可为空字符串）
- `provider_started`：provider 是否已通过启动探测（`false` 时不会发送 `change_started`）
- `provider_failed_reason`：provider 启动失败时的失败原因（用于重试 `change_failed` 保持 reason 稳定；未失败时为空字符串）
- `started_at`：会话创建时间（ISO）
- `reboot_delay_minutes`：本次会话采用的重启策略（`-1` 或 `1..15`）
- `reboot_schedule_attempted`：是否已尝试安排重启（仅 `reboot_delay_minutes != -1` 时有意义）
- `reboot_scheduled`：是否已成功安排重启
- `reboot_schedule_error`：安排重启失败的错误摘要（可为空字符串）
- `reboot_scheduled_at`：重启安排时间（ISO，可为空字符串）
- `started_sent`：`change_started` 是否已成功上报（best-effort；消费者不应依赖该事件来触发播报或做终态收敛）
- `monitor_after_ms`：允许开始判定终态的最早时间戳（毫秒）
- `timeout_at_ms`：会话超时截止时间戳（毫秒）
- `offline_observed`（可选）：无重启模式下是否观测到过断网
- `timeout_stuck_alert_next_at_ms`（可选）：下一次允许输出“超时未收敛”告警的时间戳（毫秒）
- `timeout_stuck_alert_count`（可选）：本会话已输出的“超时未收敛”告警次数
- `timeout_stuck_alert_last_at`（可选）：最近一次“超时未收敛”告警时间（ISO）
- `timeout_stuck_alert_last_reason`（可选）：最近一次“超时未收敛”告警原因摘要
- `last_error`（可选）：最近一次上报失败摘要
- `terminal_sent`：终态（`change_*`）是否已成功上报
- `terminal_event`：已上报的终态事件名（可为空字符串）
- `terminal_reason`：已上报的终态 reason（可为空字符串）
- `terminal_ipv4`：本次会话最终观测到的 IPv4（用于跨重启持久化 `ip_state`；可为空字符串）
- `terminal_sent_at`：终态上报时间（ISO，可为空字符串）

并发约束：

- 同一时刻只允许一个会话；存在 `op_id` 时新的 `/changeip` 必须返回 `409`。
