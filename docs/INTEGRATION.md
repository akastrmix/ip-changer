# ip-changer ↔ CarpoolNotifier 对接说明

本文档描述 `ip-changer` 与 CarpoolNotifier（Cloudflare Worker 上的 Telegram bot）之间的接口契约与配置方式，目标是：多 VPS 可扩容、低耦合、易排障。

破坏性更新说明：

- 你已确认不做向下兼容，因此本项目以 **事件流** 形式与 CarpoolNotifier 对接：
  - 唯一上报入口：`POST /internal/ip-events`
  - 旧的 `/internal/ip-changed` / `IP_REPORT_*` 不再使用

## 1. 数据/身份约定

### 1.1 `SERVER_LABEL`

- 每台 VPS 必须设置唯一且稳定的 `SERVER_LABEL`（例如 `CMHK` / `HKT` / `iCable`）。
- CarpoolNotifier 以 `server_label` 作为主键存储：
  - 上次 IPv4
  - 上次 IPv6（仅日志/排障用途）
  - 正在进行的换 IP 会话（用于编辑同一条频道播报）
  - 频道消息的 message_id 等

### 1.2 `REPORT_CHANNEL`

`ip-changer` 将频道目标透传给 CarpoolNotifier。

支持两种格式：

- 公有频道：`@channel_username`
- 私有频道/超级群：负数 chat_id（常见为 `-100xxxxxxxxxx`）

注意：bot 必须被拉入频道，并具备发送/编辑消息权限（建议设为管理员）。

可留空：

- `REPORT_CHANNEL` 可以留空，表示不向频道播报（CarpoolNotifier 仍会通知管理员，并使用事件流收敛会话/锁）。
- `REPORT_CHANNEL` 若非空，必须是合法 `@channel_username` 或负数 chat_id；格式非法会在 `ip-changer` 启动时直接拒绝。

## 2. 方向 A：CarpoolNotifier → ip-changer（可选一键换 IP）

### 2.1 `/changeip` 触发（可选）

前提：VPS 上 `CHANGEIP_ENABLED=1`、已配置 `CHANGEIP_PROVIDER`，且 ip-events 上报已启用（`IP_EVENTS_ENABLED=1` + endpoint/token）。

CarpoolNotifier 配置（按 `SERVER_LABEL` 做映射，便于多服务器扩容）：

- `CHANGEIP_ENDPOINTS_JSON`（vars）：例如 `{"CMHK":"http://<VPS_IP>:8787"}`
  - 只填 ip-changer 服务器根地址；CarpoolNotifier 会自动推导 `/changeip` 与 `/info`
- `CHANGEIP_TOKENS_JSON`（secret）：例如 `{"CMHK":"<AUTH_TOKEN>"}`（必须等于 VPS 上 `AUTH_TOKEN`）
- `CHANGEIP_SERVERS`（vars）：确保包含该服务器；bot 侧可调用的 ip-changer 统一标记为 `script`（例如 `CMHK:script`）
  - `CHANGEIP_PROVIDER=exec/http_flow` 只属于本机 ip-changer 内部 provider，不能原样写到 CarpoolNotifier 的 `CHANGEIP_SERVERS`

请求：

- `POST /changeip`
- JSON 对象 `{ "token": "<AUTH_TOKEN>" }`
  - 若请求体不是 JSON 对象（例如 `[]`、`123`），服务会直接返回 `400`，不会再落到 `403 forbidden`
  - 可选：`{ "force": true }` 用于清理“已超时”的会话并重新触发（一般仅用于人工排障；bot 默认不应使用）
    - 仅当会话的 `timeout_at_ms` 合法且已超时（或 `terminal_sent=true`）时才允许清理；超时字段损坏时不会做推导式清理

返回（节选）：

- `reboot_schedule_requested`：是否计划安排重启（`REBOOT_DELAY_MINUTES!=-1`）
- `reboot_delay_minutes`：计划的重启延迟分钟；当 `REBOOT_DELAY_MINUTES=-1` 时为 `-1`

说明：

- 若 VPS 设置 `REBOOT_DELAY_MINUTES=-1`，provider 触发仍会执行，但**不会**执行重启。
- 若 VPS 设置 `REBOOT_DELAY_MINUTES=1..15`，ip-changer 会在启动时要求系统存在 `/usr/sbin/shutdown` 或 `/sbin/shutdown`；缺失时服务不会启动。
- 若该 VPS 已有进行中的换 IP 会话，`/changeip` 会返回 `409 change already in progress`，并携带现有 `op_id`（CarpoolNotifier 应按“已在进行中”处理，而不是重复触发）。
- `/changeip` 的 `ok=true` 表示“触发已接受”，不保证此时 provider 已完成启动探测；provider 启动/终态以 `change_*` 事件为准。

### 2.2 `/info` 查询

CarpoolNotifier 用它来获取：

- `server_label`
- `channel`
- `changeip_provider`
- `notified_ipv4`（用于“预告/开始”文案里的基线 IP）
- `notified_ipv6`（用于日志与排障；不参与 `/changeip` 会话判定）
- `ip_events_contract_version`（当前事件契约版本）
- `runtime_metrics`（上报成功率、最近错误、监测 tick 等运行指标）

请求：

- `POST /info`
- JSON 对象 `{ "token": "<AUTH_TOKEN>" }`
  - 若请求体不是 JSON 对象（例如 `[]`、`123`），服务会直接返回 `400`

## 3. 方向 B：ip-changer → CarpoolNotifier（事件流上报）

你已确认：不做向下兼容，因此本项目以 **`/internal/ip-events`** 作为唯一上报入口（旧的 `/internal/ip-changed` / `IP_REPORT_*` 不再使用）。

### 3.1 Worker 内部接口

- `POST /internal/ip-events`
  - Header：`Authorization: Bearer <IP_EVENTS_TOKEN>`

Worker 侧配置（建议使用 secret）：

- `IP_EVENTS_TOKEN`

### 3.2 VPS 上报配置

VPS 侧配置：

- `IP_EVENTS_ENABLED=1`
- `IP_EVENTS_ENDPOINT=https://<worker>/internal/ip-events`
- `IP_EVENTS_TOKEN=<same as worker secret>`
- `SERVER_LABEL=<unique label>`
- `REPORT_CHANNEL=@xxx` 或 `-100...`

与 `IP_MONITOR_*` 的关系：

- `IP_MONITOR_ENABLED=1`：启用“自然变化”监测，但上报事件改为 `ipv4_changed`（仍然只在变化时上报）
- `IPV6_MONITOR_ENABLED=1`：启用 IPv6 自然变化监测，上报事件为 `ipv6_changed`（记录到 iplog，并通知管理员；不向频道播报）
- “换 IP 会话”的状态上报使用 `change_*` 事件，即使最终 IP 没变也要上报 `change_no_change`/`change_failed`

重要建议：

- 多台 VPS 可以共用同一个 `IP_EVENTS_TOKEN`（Worker 目前按全局单钥匙设计）。
  - 如未来需要每台 VPS 单独 token，再扩展 Worker 鉴权逻辑即可。

判定规则（v1，与你确认的口径一致）：

- provider 成功触发后会尽快上报 `change_started`（best-effort；允许延迟/丢失；CarpoolNotifier 不依赖该事件来触发“开始更换”播报，而是以调用 `POST /changeip` 成功为准）
- provider 启动探测失败时会上报 `change_failed`；若首次上报失败，会保留 pending 会话并重试同一 `change_failed`（`reason` 不变）
- `change_*` 终态事件上报带短重试（最多 3 次，带退避抖动）；`ipv4_changed/ipv6_changed` 自然事件保持单次上报
- 若 `pending_change` 字段不合法，会尝试上报 `change_failed(invalid_pending_*)`，成功后清理会话
- 若 `pending_change` 缺少可用 `op_id`，会直接清理会话（因为无法构造合法 `change_failed` 事件）
- `/changeip` 会话终态判定只看 IPv4；IPv6 不参与 `change_*` 语义
- 触发后等待 `CHANGE_MONITOR_START_DELAY_SECONDS` 再尝试获取公网 IPv4
  - 若设置了重启延迟（`REBOOT_DELAY_MINUTES=1..15`），则会在“预计重启时间”之后再加上该延迟，避免在重启前误判为 `change_no_change`
- 获取到合法公网 IPv4 后即可判定终态：
  - `old_ipv4` 缺失 → `change_failed`（`old_ipv4_unknown`）；`ip-changer` 不会再从 `ip_state` 或额外公网查询回填该基线
  - `!= old_ipv4` → `change_succeeded`
  - `== old_ipv4`：
    - 若安排了重启（`REBOOT_DELAY_MINUTES=1..15`）：立即判定为 `change_no_change`
    - 若不重启（`REBOOT_DELAY_MINUTES=-1`）：为避免 provider 执行中误判，会等待一次断网/恢复或超时后才判定 `change_no_change`
- 30 分钟内始终拿不到公网 IPv4 → `change_failed`（`no_ipv4_observed`）

补充：`op_id`

- `op_id` 是“一次换 IP 操作”的唯一标识，建议把它视为该次换 IP 的“会话/操作 ID”。
- `POST /changeip` 成功返回体里必须包含 `op_id`，并且后续所有 `change_*` 事件都要带相同 `op_id`。
- `POST /changeip` 的 `ok=true` 仅表示触发已接受；最终成功/失败以后续 `change_*` 终态事件为准。

### 3.3 上报 payload

最小必需字段（`channel` 必带）：

- `channel` 的值必须是 `@xxx`、负数 chat_id（常见为 `-100...`）或空字符串
- 空字符串表示禁用频道播报
- `ip-changer` 会始终显式发送 `channel`；Worker 不再接受“省略 channel 再回退旧状态”的旧语义

```json
{
  "server_label": "CMHK",
  "channel": "-1001234567890",
  "op_id": "20260128T061500Z_cmhk_7f2c0f",
  "ts": "2026-01-28T06:15:00.000Z",
  "contract_version": "2026-04-03.v1",
  "event": "change_started"
}
```

事件类型与可选字段见本仓库：`docs/SPEC.md`。

代码契约（与文档同步维护）：

- `src/contracts/ipEvents.js`：事件枚举、`contract_version`、每种事件的必填字段、payload 基础校验

## 4. 典型流程

### 4.1 自然 IP 变化

1. `ip-changer` 发现 IPv4 或 IPv6 变化
2. `ip-changer` 调用 Worker `/internal/ip-events`（`event=ipv4_changed` 或 `event=ipv6_changed`）
3. CarpoolNotifier：
   - `ipv4_changed`：保留现有行为（会话编辑/频道与管理员通知/冷却锁）
   - `ipv6_changed`：记录到 `iplog` 事件日志，并通知管理员；不向频道播报

### 4.2 机器人触发换 IP（provider + 可选重启）

1. 用户/管理员在 Telegram 交互中触发
2. CarpoolNotifier 调用 `ip-changer /info` 获取基线与频道
3. CarpoolNotifier 在频道发布“预告”（可选）并安排任务
4. 到达执行时间后，CarpoolNotifier 调用 `ip-changer /changeip`
5. VPS 执行 provider；若 `REBOOT_DELAY_MINUTES=1..15` 则按配置重启，`-1` 则不重启
6. IP 变化后 `ip-changer` 上报 → CarpoolNotifier 编辑同一条频道消息追加结果

## 5. 常见错误与定位

- Worker 返回 `401 unauthorized`：`IP_EVENTS_TOKEN` 不一致
- `ip-changer /info` 或 `/changeip` 返回 `403`：`AUTH_TOKEN` 不一致或 `/changeip` 未启用
- 频道无消息：bot 未进频道/无权限，或 `REPORT_CHANNEL` 填写格式不对

## 6. 跨仓库变更清单（强制）

本仓库与 CarpoolNotifier 通过接口 + 事件契约耦合：**任何一侧改动契约语义，都必须同步改另一侧**，否则一定会出现“事件被拒收/会话不收敛/频道不更新”等线上问题。

触发联动的常见改动：

- `/changeip` 或 `/info`：返回字段/语义/错误码/鉴权（含 `ok`/`op_id`/`provider_error_code`/`ip_events_contract_version`）
- ip-events：`contract_version`、事件类型枚举、必填字段、幂等键（`server_label + op_id + event`）、乱序/终态优先规则
- `change_failed.reason` 的列表或语义（会影响 bot 文案与告警分流）
- `REPORT_CHANNEL` “允许为空=禁用频道播报”的语义

快速定位（对接文件）：

- 本仓库：`docs/SPEC.md`、`src/contracts/ipEvents.js`
- CarpoolNotifier：`docs/changeip/IP_CHANGER.md`、`docs/changeip/IP_EVENTS.md`、`src/services/changeip/ipChanger.js`、`src/services/ipChanges/contract.js`

交付前必须跑：

- 本仓库：`node scripts/changeip_regression.js`
- CarpoolNotifier：`bash scripts/check.sh`
