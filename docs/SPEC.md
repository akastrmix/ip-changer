# ip-changer — SPEC（行为规格）

本文档以“可验证的行为约定”为目标，描述 `ip-changer` 的对外接口、状态存储与 IPv4 监测/上报的关键规则。

## 1. 组件与职责

`ip-changer` 仅包含一个常驻服务：

- Node.js 脚本：`changeip_http_server.js`
  - 监听 HTTP 端口（默认 `0.0.0.0:8787`）
  - 可选：提供 `/changeip` 触发换 IP + 重启
  - 可选：公网 IPv4 监测并上报到 CarpoolNotifier（仅在变化时上报）

非目标：

- 不负责 Telegram 交互（由 CarpoolNotifier 负责）
- 不负责数据库/持久业务逻辑（只维护自己极小的状态文件）
- 不负责自动安装系统依赖

## 2. 运行环境与依赖

- OS：Debian/Ubuntu 系
- Node.js：建议 16+（不依赖第三方包）
- systemd：用于自启与守护（通过 `install.sh` 安装）
- 如果启用 `/changeip`：需要 root 权限调用 `shutdown` 与执行 `CHANGEIP_SCRIPT`

## 3. 配置（环境变量）

通过 `/etc/default/changeip-http` 注入（或手动 `ENV=... node ...`）。

必需：

- `AUTH_TOKEN`：入站鉴权密钥（`/info`、`/changeip` 使用）

HTTP 服务：

- `PORT`：监听端口（默认 `8787`，范围 `1-65535`）

一键换 IP（可选）：

- `CHANGEIP_ENABLED`：`1/0`（默认建议 `0`）
- `CHANGEIP_SCRIPT`：脚本绝对路径（默认 `/root/changeip.sh`）
- `REBOOT_DELAY_MINUTES`：脚本触发后，几分钟后重启（默认 `16`，范围 `1-10080`）

IPv4 监测与上报（可选）：

- `IP_MONITOR_ENABLED`：`1/0`
- `IP_MONITOR_INTERVAL_SECONDS`：检测间隔（默认 `60`，最小 `10`）
- `IP_STATE_FILE`：状态文件（默认 `/var/lib/changeip-http/ip_state.json`）
- `IP_REPORT_ENDPOINT`：上报地址（例如 `https://<worker>/internal/ip-changed`）
- `IP_REPORT_TOKEN`：上报鉴权密钥（Bearer token）
- `SERVER_LABEL`：服务器标识（用于多服务器区分）
- `REPORT_CHANNEL`：播报目标（`@channel` 或私有频道 `-100...` chat_id）

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
  - `ip_monitor_enabled`：只有监测真正“可用”时为 true（即 `IP_MONITOR_ENABLED=1` 且 endpoint/token 都存在）
  - `notified_ipv4`：状态文件中的 `notified_ipv4`（可能为 `null`）

### 4.3 `POST /changeip`（可选）

仅当 `CHANGEIP_ENABLED=1` 时启用，否则：

- `403` `{ ok:false, error:"changeip disabled" }`

启用时：

- 鉴权：Body 必须包含 `{ "token": "<AUTH_TOKEN>" }`，否则 `403`
- 失败：
  - 脚本不存在：`500` `changeip script not found`
  - 脚本不可读：`500` `changeip script not readable`
  - spawn 失败：`500` `failed to spawn changeip script`
- 成功：
  - 后台执行：`/bin/bash <CHANGEIP_SCRIPT>`（不要求可执行位，但要求可读）
  - 安排重启：`shutdown -r +<REBOOT_DELAY_MINUTES>`
  - 返回 `200`，包含：
    - `message`
    - `server_label`
    - `channel`
    - `old_ipv4`（来自状态文件 `notified_ipv4`，可为 `null`）

## 5. IPv4 监测与上报规则

### 5.1 IPv4 获取

- 只获取并验证 **IPv4**（正则+每段 0-255）
- 会尝试多个来源（依次重试），直到拿到合法 IPv4 或全部失败
- 为保证“只走 IPv4 出站”，HTTP(S) 请求强制 `family=4`

### 5.2 何时上报

- **首次运行**：只初始化基线（写入 `notified_ipv4`），不进行上报
- 后续运行：当检测到当前 IPv4 `!= notified_ipv4` 时：
  - 发送上报到 `IP_REPORT_ENDPOINT`
  - 上报成功才会更新 `notified_ipv4`
  - 上报失败会保留旧的 `notified_ipv4`，从而在下一次检测仍会继续尝试上报（直到成功）

### 5.3 上报请求格式

Header：

- `Authorization: Bearer <IP_REPORT_TOKEN>`

JSON Body：

```json
{
  "server_label": "HKT",
  "channel": "-1001234567890",
  "old_ipv4": "1.2.3.4",
  "new_ipv4": "5.6.7.8",
  "detected_at": "2025-12-17T08:00:00.000Z"
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

