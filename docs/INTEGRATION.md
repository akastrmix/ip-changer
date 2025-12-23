# ip-changer ↔ CarpoolNotifier 对接说明

本文档描述 `ip-changer` 与 CarpoolNotifier（Cloudflare Worker 上的 Telegram bot）之间的接口契约与配置方式，目标是：多 VPS 可扩容、低耦合、易排障。

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

## 2. 方向 A：CarpoolNotifier → ip-changer（可选一键换 IP）

### 2.1 `/changeip` 触发（可选）

前提：VPS 上 `CHANGEIP_ENABLED=1`。

CarpoolNotifier 配置：

- `CHANGEIP_ENDPOINT`：例如 `http://<VPS_IP>:8787/changeip`
- `CHANGEIP_TOKEN`：必须等于 VPS 上 `AUTH_TOKEN`

请求：

- `POST /changeip`
- JSON `{ "token": "<AUTH_TOKEN>" }`

### 2.2 `/info` 查询

CarpoolNotifier 用它来获取：

- `server_label`
- `channel`
- `notified_ipv4`（用于“预告/开始”文案里的基线 IP）

请求：

- `POST /info`
- JSON `{ "token": "<AUTH_TOKEN>" }`

## 3. 方向 B：ip-changer → CarpoolNotifier（IPv4 变化上报）

### 3.1 Worker 内部接口

CarpoolNotifier 需要实现内部路由（示例）：

- `POST /internal/ip-changed`
  - Header：`Authorization: Bearer <IP_REPORT_TOKEN>`

Worker 侧配置（建议使用 secret）：

- `IP_REPORT_TOKEN`

### 3.2 VPS 上报配置

VPS 侧配置：

- `IP_MONITOR_ENABLED=1`
- `IP_REPORT_ENDPOINT=https://<worker>/internal/ip-changed`
- `IP_REPORT_TOKEN=<same as worker secret>`
- `SERVER_LABEL=<unique label>`
- `REPORT_CHANNEL=@xxx` 或 `-100...`

重要建议：

- **多台 VPS 建议共用同一个 `IP_REPORT_TOKEN`**（Worker 目前是全局单钥匙）。
  - 如果未来需要细粒度权限（每台 VPS 单独 token），再扩展 Worker 鉴权逻辑即可。

## 4. 典型流程

### 4.1 自然 IPv4 变化

1. `ip-changer` 发现 IPv4 变化
2. `ip-changer` 调用 Worker `/internal/ip-changed`
3. CarpoolNotifier：
   - 若当前存在“换 IP 会话”，则编辑会话消息并追加频道行
   - 否则向频道 + 管理员广播一条“公网 IP 变化”消息，并（可选）进入锁定期防止重复触发

### 4.2 机器人触发换 IP（脚本 + 重启）

1. 用户/管理员在 Telegram 交互中触发
2. CarpoolNotifier 调用 `ip-changer /info` 获取基线与频道
3. CarpoolNotifier 在频道发布“预告”（可选）并安排任务
4. 到达执行时间后，CarpoolNotifier 调用 `ip-changer /changeip`
5. VPS 执行脚本并重启
6. IP 变化后 `ip-changer` 上报 → CarpoolNotifier 编辑同一条频道消息追加结果

## 5. 常见错误与定位

- Worker 返回 `401 unauthorized`：`IP_REPORT_TOKEN` 不一致
- `ip-changer /info` 或 `/changeip` 返回 `403`：`AUTH_TOKEN` 不一致或 `/changeip` 未启用
- 频道无消息：bot 未进频道/无权限，或 `REPORT_CHANNEL` 填写格式不对

