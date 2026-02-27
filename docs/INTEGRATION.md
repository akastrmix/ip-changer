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
  - 正在进行的换 IP 会话（用于编辑同一条频道播报）
  - 频道消息的 message_id 等

### 1.2 `REPORT_CHANNEL`

`ip-changer` 将频道目标透传给 CarpoolNotifier。

支持两种格式：

- 公有频道：`@channel_username`
- 私有频道/超级群：`-100xxxxxxxxxx`（chat_id）

注意：bot 必须被拉入频道，并具备发送/编辑消息权限（建议设为管理员）。

可留空：

- `REPORT_CHANNEL` 可以留空，表示不向频道播报（CarpoolNotifier 仍会通知管理员，并使用事件流收敛会话/锁）。

## 2. 方向 A：CarpoolNotifier → ip-changer（可选一键换 IP）

### 2.1 `/changeip` 触发（可选）

前提：VPS 上 `CHANGEIP_ENABLED=1` 且已配置 `CHANGEIP_PROVIDER`。

CarpoolNotifier 配置（按 `SERVER_LABEL` 做映射，便于多服务器扩容）：

- `CHANGEIP_ENDPOINTS_JSON`（vars）：例如 `{"CMHK":"http://<VPS_IP>:8787/changeip"}`
- `CHANGEIP_TOKENS_JSON`（secret）：例如 `{"CMHK":"<AUTH_TOKEN>"}`（必须等于 VPS 上 `AUTH_TOKEN`）
- `CHANGEIP_SERVERS`（vars）：确保包含该服务器并标记 provider（例如 `CMHK:script` / `CMHK:exec` / `CMHK:http_flow`）

请求：

- `POST /changeip`
- JSON `{ "token": "<AUTH_TOKEN>" }`

返回（节选）：

- `reboot_scheduled`：是否安排重启
- `reboot_delay_minutes`：重启延迟分钟；当 `REBOOT_DELAY_MINUTES=-1` 时返回 `-1`

说明：

- 若 VPS 设置 `REBOOT_DELAY_MINUTES=-1`，provider 触发仍会执行，但**不会**执行重启。

### 2.2 `/info` 查询

CarpoolNotifier 用它来获取：

- `server_label`
- `channel`
- `changeip_provider`
- `notified_ipv4`（用于“预告/开始”文案里的基线 IP）

请求：

- `POST /info`
- JSON `{ "token": "<AUTH_TOKEN>" }`

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
- “换 IP 会话”的状态上报使用 `change_*` 事件，即使最终 IP 没变也要上报 `change_no_change`/`change_failed`

重要建议：

- 多台 VPS 可以共用同一个 `IP_EVENTS_TOKEN`（Worker 目前按全局单钥匙设计）。
  - 如未来需要每台 VPS 单独 token，再扩展 Worker 鉴权逻辑即可。

判定规则（v1，与你确认的口径一致）：

- provider 成功触发后立刻上报 `change_started`
- 触发后等待 `CHANGE_MONITOR_START_DELAY_SECONDS` 再尝试获取公网 IPv4
  - 若设置了重启延迟（`REBOOT_DELAY_MINUTES=1..15`），则会在“预计重启时间”之后再加上该延迟，避免在重启前误判为 `change_no_change`
- 获取到合法公网 IPv4 后即可判定终态：
  - `!= old_ipv4` → `change_succeeded`
  - `== old_ipv4`：
    - 若安排了重启（`REBOOT_DELAY_MINUTES=1..15`）：立即判定为 `change_no_change`
    - 若不重启（`REBOOT_DELAY_MINUTES=-1`）：为避免 provider 执行中误判，会等待一次断网/恢复或超时后才判定 `change_no_change`
- 10 分钟内始终拿不到公网 IPv4 → `change_failed`（`no_ipv4_observed`）

补充：`op_id`

- `op_id` 是“一次换 IP 操作”的唯一标识，建议把它视为该次换 IP 的“会话/操作 ID”。
- `POST /changeip` 成功返回体里必须包含 `op_id`，并且后续所有 `change_*` 事件都要带相同 `op_id`。

### B2.3 上报 payload

最小必需字段：

```json
{
  "server_label": "CMHK",
  "channel": "-1001234567890",
  "op_id": "20260128T061500Z_cmhk_7f2c0f",
  "ts": "2026-01-28T06:15:00.000Z",
  "event": "change_started"
}
```

事件类型与可选字段见本仓库：`docs/SPEC.md`。

## 4. 典型流程

### 4.1 自然 IPv4 变化

1. `ip-changer` 发现 IPv4 变化
2. `ip-changer` 调用 Worker `/internal/ip-events`（`event=ipv4_changed`）
3. CarpoolNotifier：
   - 若当前存在“换 IP 会话”，则编辑会话消息并追加频道行
   - 否则向频道 + 管理员广播一条“公网 IP 变化”消息，并（可选）进入锁定期防止重复触发

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
