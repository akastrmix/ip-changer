# ip-changer — HTTP Trigger + IPv4/IPv6 变化监测

一个极简的常驻服务，用于在 Debian VPS 上：

- （可选）通过 HTTP 触发 provider（脚本/命令/http_flow），并按配置可选自动重启，实现一键更换公网 IP
- （可选）通过 HTTP 异步触发本机 IPQuality 检测，并保存最近一次成功/失败结果
- 监测公网 **IPv4/IPv6** 是否发生变化，并上报到 CarpoolNotifier（Cloudflare Worker）

本项目只负责：

- 在 VPS 上监听一个 HTTP 接口（默认 `0.0.0.0:8787`）。
- （可选）接收到带密钥的请求后按 provider 执行换 IP 触发动作，并按 `REBOOT_DELAY_MINUTES` 可选安排重启（`-1` 表示不重启）。
- （可选）接收到带密钥的请求后异步执行本机固定路径的 IPQuality 脚本，并保存最近一次运行状态。
- 定期检测公网 IPv4/IPv6 变化并上报到 CarpoolNotifier。

---

## 文档导航（建议新开对话先读）

- `AGENTS.md`：项目约束/不变量（给 AI/协作者看的“快速上手”）
- `docs/SPEC.md`：行为规格（接口、状态文件、监测/上报规则）
- `docs/INTEGRATION.md`：与 CarpoolNotifier 的对接契约
- `docs/RUNBOOK.md`：运维手册（部署/更新/排障）
- `docs/ARCHITECTURE.md`：`src/` 模块分层与职责地图
- `docs/BOIL_FLOW.md`：Boil 面板专用 flow 说明（变量映射、流程、兜底与排障）
- `CHANGELOG.md`：版本变更记录

---

## 1. 文件结构与运行方式

本仓库包含以下主要文件：

- `changeip_http_server.js`
  - 使用 Node.js 编写的极简常驻服务（HTTP + IPv4/IPv6 监测上报）。
  - 不依赖任何第三方 NPM 包，仅使用 Node 标准库。
- `install.sh`
  - 安装脚本：创建 systemd 服务、配置环境变量、启用并启动该 HTTP 服务。
- `uninstall.sh`
  - 卸载脚本：停用并删除 systemd 服务和配置，恢复系统到安装前状态（不删除你的 provider 相关脚本/配置和仓库代码）。
- `flows/`
  - `http_flow` 配置目录；生产 flow 与示例文件都放在这里（例如 `flows/ippanel.boil.network.HKT.json`、`flows/store.moonvm.com.json`、`flows/samples/store.moonvm.com.sample.json`）。
- `src/`
  - `change/trigger.js`：`/changeip` 入口编排（会话创建、provider 触发、可选重启）。
  - `change/session.js`：`pending_change` 状态机与 `change_*` 事件构造/上报。
  - `ipquality/`：`/ipquality` 触发、运行态与最近一次结果落盘。
  - `monitor.js`：会话终态判定（`change_succeeded/no_change/failed`，仅基于 IPv4）与自然 IPv4/IPv6 监测。
  - `contracts/ipEvents.js`：事件契约（枚举、版本、字段校验）。
  - `providers/`：`script` / `exec` / `http_flow` provider 及公共错误模型。

如果启用 `/changeip`，你需要按 provider 准备触发能力：

- `script` provider：准备可由 `/bin/bash <CHANGEIP_SCRIPT>` 执行的脚本（例如 `/root/changeip.sh`）
- `exec` provider：准备可执行命令（`CHANGEIP_EXEC_COMMAND`）
- `http_flow` provider：准备 flow JSON 文件（`CHANGEIP_HTTP_FLOW_FILE`）

如果启用 `/ipquality`，优先使用仓库内固定版本：

- `vendor/ipquality/ip.sh`
- 安装后常见绝对路径：`/root/ip-changer/vendor/ipquality/ip.sh`

ip-changer 不会在运行时 `curl | bash` 拉最新版；更新 IPQuality 应随仓库更新一起审查、提交、部署。

`script` / `exec` provider 明确以 Debian/Ubuntu 服务器环境为目标，依赖 `/bin/bash`；不再为 Windows 开发机做运行时兼容分支。

安装完成后，对服务器产生的**主要持久影响**包括：

- 创建 systemd 单元：`/etc/systemd/system/changeip-http.service`
- `systemctl enable changeip-http` 会创建开机自启的 symlink：`/etc/systemd/system/multi-user.target.wants/changeip-http.service`
- 创建环境变量配置文件：`/etc/default/changeip-http`
- （启用监测上报时）创建状态目录：`/var/lib/changeip-http`（用于保存上次已上报 IPv4/IPv6，卸载会删除）

卸载脚本会删除上述文件/目录并重新加载 systemd，确保**不留下任何系统级残留**。

> 仓库本身（即你 `git clone` 的目录）视为源码目录，由你自行决定是否删除。

---

## 2. 依赖与系统要求

目标环境：**Debian / Ubuntu 系** VPS，具有以下条件：

- 安装了 Node.js（建议 16+，能运行普通 Node 脚本）。
- 若启用 `/changeip`，需按所选 provider 预先准备好可触发的换 IP 机制（脚本/命令/flow 文件）。

如果你尚未安装 Node.js，可在 Debian / Ubuntu 上执行：

```bash
apt update
apt install -y nodejs
```

> 安装脚本 **不会自动安装 Node.js**，以避免对系统其他模块产生不可预期影响。如果需要，可以按上面命令手动安装。

---

## 3. HTTP 服务行为说明

`changeip_http_server.js` 行为简要说明：

- 监听地址：`0.0.0.0:<PORT>`（默认 `8787`）。
- 支持的接口：
  - `GET /`
    - 健康检查，返回：
      ```json
      { "ok": true, "service": "changeip-http" }
      ```
  - `POST /info`
    - 获取本机 `SERVER_LABEL` / `REPORT_CHANNEL` / 上次已记录的 IPv4/IPv6（不触发换 IP）。
    - 请求头：`Content-Type: application/json`
    - 请求体示例：
      ```json
      { "token": "YOUR_SHARED_SECRET" }
      ```
    - 校验规则：
      - 请求体必须是 JSON 对象；数组、数字、字符串等非对象 JSON 会直接返回 `400`。
      - `token` 字段必须等于环境变量 `AUTH_TOKEN`。
      - 不满足则返回 `403`。
    - 返回示例：
      ```json
      {
        "ok": true,
        "server_label": "CMHK",
        "channel": "@your_channel",
        "changeip_enabled": true,
        "changeip_provider": "script",
        "ip_events_enabled": true,
        "ip_monitor_enabled": true,
        "ipv6_monitor_enabled": false,
        "ip_events_contract_version": "2026-04-03.v1",
        "ip_events_contract_versions_supported": ["2026-04-03.v1"],
        "notified_ipv4": "1.2.3.4",
        "notified_ipv6": null,
        "runtime_metrics": {
          "uptime_seconds": 123,
          "counters": {
            "ip_event_post_attempts_total": 8,
            "ip_event_post_ok_total": 8
          }
        }
      }
      ```
    - 说明：
      - `channel` 可能为空字符串；这表示关闭频道播报，但不影响 `/info` 或 `/changeip` 主流程。
      - `ip_events_enabled`：事件流上报是否可用（需要 `IP_EVENTS_ENABLED=1` 且配置了 `IP_EVENTS_ENDPOINT/IP_EVENTS_TOKEN`）。
      - `ip_monitor_enabled`：IPv4 变化监测是否可用（需要 `IP_MONITOR_ENABLED=1` 且 `ip_events_enabled=true`）。
      - `ipv6_monitor_enabled`：IPv6 变化监测是否可用（需要 `IPV6_MONITOR_ENABLED=1` 且 `ip_events_enabled=true`）。
      - `ip_events_contract_version`：当前上报契约版本。
      - `runtime_metrics`：当前进程运行指标（用于排障：上报成功率、最近错误、监测 tick）。
  - `POST /changeip`
    - 仅当 `CHANGEIP_ENABLED=1` 时可用；否则返回 `403`。
    - 请求头：`Content-Type: application/json`
    - 请求体示例：
      ```json
      { "token": "YOUR_SHARED_SECRET" }
      ```
      可选（仅用于排障）：清理“已超时”的换 IP 会话并重新触发：
      ```json
      { "token": "YOUR_SHARED_SECRET", "force": true }
      ```
    - 校验规则：
      - 请求体必须是 JSON 对象；数组、数字、字符串等非对象 JSON 会直接返回 `400`。
      - `token` 字段必须等于环境变量 `AUTH_TOKEN`。
      - 不满足则返回 `403`。
      - 事件流上报必须可用（`IP_EVENTS_ENABLED=1` 且 `IP_EVENTS_ENDPOINT/IP_EVENTS_TOKEN` 已配置），否则返回 `500 ip events not configured`。
      - 若当前已有进行中的换 IP 会话，返回 `409`：
        ```json
        {
          "ok": false,
          "error": "change already in progress",
          "op_id": "20260128T061500Z_cmhk_7f2c0f"
        }
        ```
        - 若请求体包含 `force:true` 且该会话的 `timeout_at_ms` 合法且已超时，会先清理旧会话再触发新会话（返回 `200`）
        - 若会话时序字段不合法，则 `force:true` 不会做推导式清理，仍返回 `409`
      - `CHANGEIP_PROVIDER` 在启用 `/changeip` 时必须显式配置（`script` / `exec` / `http_flow`）。
      - `script` provider：要求 `CHANGEIP_SCRIPT` 为可读常规文件（绝对路径）。
      - `exec` provider：要求 `CHANGEIP_EXEC_COMMAND` 非空。
    - `http_flow` provider：要求 `CHANGEIP_HTTP_FLOW_FILE` 为可读常规文件（绝对路径，内容需为合法 flow JSON）。
    - 通过校验后：
      - 会先落盘创建本次换 IP 的 `pending_change` 会话，并尽快返回 `200`（避免“触发后立刻断网”导致响应丢失）。
      - provider 启动与可选重启安排由后台的 pending runner 执行；最终成功/失败以 `change_*` 事件为准。
      - 若校验阶段失败（配置/资源不可用），返回 `500`，并带稳定错误码字段：
        ```json
        {
          "ok": false,
          "error": "changeip script not found",
          "provider_error_code": "provider.config_invalid"
        }
        ```
        `provider_error_code` 取值：`provider.unsupported` / `provider.config_invalid`
      - 返回：
        ```json
        {
          "ok": true,
          "op_id": "20260128T061500Z_cmhk_7f2c0f",
          "message": "changeip started, ...",
          "changeip_provider": "script",
          "server_label": "CMHK",
          "channel": "@your_channel",
          "old_ipv4": "1.2.3.4",
          "reboot_schedule_requested": true,
          "reboot_delay_minutes": 1
        }
        ```
        `old_ipv4` 可能为 `null`（例如首次触发且尚未拿到基线时）；此时会话后续会以 `change_failed(reason=old_ipv4_unknown)` 收敛，不会再从其它状态源回填基线。
        `channel` 也可能为空字符串；这表示本次只做会话与管理员侧收敛，不要求频道播报可用。
    - 重要说明：
      - `/changeip` 返回 `ok=true` 仅表示“本次触发请求被接受且会话已落盘，provider 启动已异步调度”。
      - 最终是否换 IP 成功，以后续事件 `change_succeeded` / `change_no_change` / `change_failed` 为准。
    - 资源防护（稳定性）：
      - 服务端显式设置 HTTP 超时（`request=300s`、`headers=60s`、`keep-alive=5s`），降低慢连接长期占用风险。
      - 上游 HTTP 响应读取存在大小上限：通用请求（IPv4/IPv6 获取、ip-events 上报）默认上限约 `1 MiB`，`http_flow` 请求默认上限约 `4 MiB`；超限会中断并记为失败。
      - 上游若在响应体未完整前提前断开，会立即按失败处理（不等待超时）。
      - 出站 HTTP 默认启用连接复用（keep-alive agent），减少高频请求下的握手与 CPU 开销。
  - `POST /ipquality`
    - 仅当 `IPQUALITY_ENABLED=1` 时可用；否则返回 `403`。
    - 请求体示例：
      ```json
      { "token": "YOUR_SHARED_SECRET" }
      ```
    - 触发语义：
      - 若当前无运行中的检测，会立即落盘 `current_run` 并返回 `200`，后台异步执行 `/bin/bash <IPQUALITY_SCRIPT_PATH> -4 -n`
      - 当前只解析并保存 IPv4 报告 URL；上游脚本的双栈输出会产生两个报告链接，暂不用于本接口
      - 若当前已有运行中的检测，会返回 `200 state=running` 并复用同一个 `run_id`
    - 成功条件：
      - 输出中能提取到至少一个 `https://...svg` 报告链接（当前取最后一个匹配）
      - 若脚本已打印报告链接，即使上游脚本最后返回非 0 退出码，也按成功保存报告
      - 若输出中没有报告链接，再按超时/非 0 退出码/无报告链接记录失败
    - 失败示例：
      - `ipquality script path must be absolute`
      - `ipquality script not found`
      - `ipquality script is not a regular file`
      - `ipquality script not readable`
      - `ipquality timed out after 600s`
      - `ipquality report url not found`
  - `POST /ipquality/status`
    - 返回当前 `ipquality` 能力状态、运行中的 `current_run`，以及最近一次 `last_success` / `last_failure`
    - 即使 `IPQUALITY_ENABLED=0` 也会返回 `200`，并明确给出 `ipquality_enabled=false`

所有行为均由以下环境变量控制（通过 `/etc/default/changeip-http` 配置）：

- `AUTH_TOKEN`：入站鉴权密钥，必须设置。用于认证来自 Telegram 机器人的请求。
- `PORT`：HTTP 监听端口（默认 `8787`）。
- `CHANGEIP_ENABLED`：是否启用 `/changeip` 接口（`1` 启用，`0` 关闭）。
- `CHANGEIP_PROVIDER`：`/changeip` provider（`script` / `exec` / `http_flow`；启用 `/changeip` 时必填）
- `CHANGEIP_SCRIPT`：当 provider=`script` 时使用的脚本绝对路径
- `CHANGEIP_EXEC_COMMAND`：当 provider=`exec` 时执行的命令
- `CHANGEIP_HTTP_FLOW_FILE`：当 provider=`http_flow` 时使用的 flow JSON 绝对路径
- `REBOOT_DELAY_MINUTES`：触发 provider 后，几分钟后重启（设置为 `-1` 表示不执行重启；否则仅允许 `1..15`，禁止 `0`）。
- 当 `CHANGEIP_ENABLED=1` 且 `REBOOT_DELAY_MINUTES!= -1` 时，服务会在启动时要求系统存在 `/usr/sbin/shutdown` 或 `/sbin/shutdown`；缺失则直接拒绝启动。
- `IPQUALITY_ENABLED`：是否启用 `/ipquality` 接口（`1` 启用，`0` 关闭）
- `IPQUALITY_SCRIPT_PATH`：当 `IPQUALITY_ENABLED=1` 时使用的 IPQuality 脚本绝对路径
- `IPQUALITY_STATE_FILE`：IPQuality 运行态与最近一次结果状态文件（默认 `/var/lib/changeip-http/ipquality_state.json`）
- `IPQUALITY_TIMEOUT_SECONDS`：单次 IPQuality 运行超时（默认 `600` 秒）
- 数值型配置只在“未设置”时使用默认值；若填了非法值或超出允许范围，服务会在启动时直接拒绝。

### 3.1 `http_flow` 配置文件（`CHANGEIP_HTTP_FLOW_FILE`）

`http_flow` provider 会按 JSON 中的步骤顺序执行 HTTP 流程，适合“登录面板 + 依次点击按钮”这类换 IP 场景。

- 推荐从示例文件开始改：`flows/samples/ippanel.boil.network.sample.json`
- 若你的 provider 是“访问一个固定 URL 就触发换 IP”（例如 MoonVM DDNS 链接），可直接参考：`flows/samples/store.moonvm.com.sample.json`
- 当前仓库也提供了按站点命名的生产版 flow：`flows/store.moonvm.com.json`
- 路径迁移提示：旧路径 `flows/ippanel.boil.network.sample.json` 已废弃，请改用 `flows/samples/ippanel.boil.network.sample.json`
- 若你使用 boil 面板，建议同时阅读：`docs/BOIL_FLOW.md`
- boil 现成生产 flow（按服务器拆分）：
  - `flows/ippanel.boil.network.HKT.json`
  - `flows/ippanel.boil.network.HKBN.json`
- 使用上述按服务器拆分的 flow 时，通常只需要 `BOIL_ACCOUNT/BOIL_PASSWORD`；`router_id/interface` 已固定在 flow 文件中。
- 支持步骤类型：
  - `request`：发送 HTTP 请求（支持 `json` / `form` / `body`）
  - `wait_until`：按固定间隔轮询请求，直到断言通过或超时（`timeout_ms` 为硬超时）
  - `extract`：从响应中正则提取变量
  - `assert`：对响应/变量做断言
  - `sleep`：等待毫秒
  - `set`：设置流程变量（可从环境变量读取）
- `request` 步骤支持 `allow_network_error: true`（适用于“最后一步触发后立即断网”的面板；该步网络错误会被视为可接受，不直接判失败）。
- `request` 步骤支持 `retries` 与 `retry_delay_ms`（用于临时失败自动重试；当返回 `429` 且存在 `Retry-After` 头时，会优先按该头等待后再重试）。
- 单次 `request` 响应体读取默认有大小保护（约 `4 MiB`），超限会立即失败，避免异常大页面占满内存。
- `http_flow` 里的布尔字段必须写成 JSON 布尔值（`true/false`），不能写字符串（例如 `"true"`）。
- 对于“本机发起请求后自身公网 IP 立刻变化”的 provider，推荐把触发步骤设为最后一步，并开启 `allow_network_error=true`；这样即使 TCP 在响应返回前被中断，也会交给 `/changeip` 会话监测去判定最终是否成功。
- 如果上游像 MoonVM 一样会返回 `200 + {"ok":false}` 这种“HTTP 成功但业务失败”的响应，建议在触发步骤后补一条 `assert`，要求“只要拿到了响应体，就必须匹配 `ok:true`”；这样既兼容断连，也不会把坏 token/坏 product 误判成成功触发。
- `wait_until` 结构为：
  - `request`：要轮询的请求对象（同 `request` 步骤字段）
  - `assert`：判断条件（同 `assert` 步骤字段）
  - `timeout_ms` / `interval_ms`：总超时与轮询间隔
- `http_flow` 采用“启动探测窗口”（约 `1.5s`）：用于尽快识别“启动就失败”的情况并把会话标记为 `change_failed(http_flow_failed)`；`/changeip` 通常已在此之前返回 `200`。
- 支持变量模板：
  - `${var_name}`：引用 flow 内变量
  - `${ENV:VAR_NAME}`：引用系统环境变量（推荐用于账号密码）
- 会自动维护 cookie 会话并跟随重定向（默认开启）。
- flow 文件会在每次触发时按文件 `mtime/size` 做缓存校验并自动重编译；通常改完 flow 后无需重启服务。
- flow 在执行前会先做编译期校验（JSON 结构、步骤字段、变量引用、正则/状态码格式），不合法会直接返回 `500`。

建议不要把敏感账号密码明文写进 flow 文件，而是放到环境变量，再通过 `${ENV:...}` 引用。

MoonVM 这类“单 URL 触发”场景的最小配置通常如下：

- `CHANGEIP_PROVIDER=http_flow`
- `CHANGEIP_HTTP_FLOW_FILE=/root/ip-changer/flows/store.moonvm.com.json`
- `MOONVM_IPTOKEN=<换 IP token>`

示例里使用了浏览器 `User-Agent`，因为实测 `store.moonvm.com/ddns.php?...` 在无浏览器 UA 的客户端上可能返回 `403`；从浏览器或带浏览器 UA 的请求访问时可正常返回 `200` 与 JSON（例如 `{"ok":true,"code":200,"newip":"..."}`）。同样实测坏 token/坏 product 时会返回 `200 + {"ok":false,"code":501}`，所以 MoonVM flow 里额外补了 body 断言。

### 3.2 IPv4/IPv6 监测与上报说明

当 `IP_MONITOR_ENABLED=1` 时，服务会定期获取公网 **IPv4**；当 `IPV6_MONITOR_ENABLED=1` 时，会定期获取公网 **IPv6**。若与各自“上次已成功上报”的基线不同，则向 CarpoolNotifier 的内部接口上报一次（仅在变化时上报）。

注意：

- `/changeip` 会话收敛与 `change_*` 事件仍然只看 IPv4，IPv6 当前仅用于自然变化记录。
- IPv4 检测请求强制 `family=4`，IPv6 检测请求强制 `family=6`。
- 启动时会先做一次 IPv6 可达性探测；若暂不可用，会提示并继续后台重试（IPv4/IPv6 监测错误日志默认按 5 分钟节流输出）。
- 若你设置了 `IP_MONITOR_ENABLED=1`，但未配置 `IP_EVENTS_ENDPOINT` 或 `IP_EVENTS_TOKEN`，监测不会生效；此时 `/info` 返回的 `ip_monitor_enabled` 也会为 `false`。
- 若你设置了 `IPV6_MONITOR_ENABLED=1`，但未配置 `IP_EVENTS_ENDPOINT` 或 `IP_EVENTS_TOKEN`，监测同样不会生效；此时 `/info` 返回的 `ipv6_monitor_enabled` 会为 `false`。

环境变量：

- `IP_MONITOR_ENABLED`：`1/0`，启用/关闭 IPv4 监测上报
- `IP_MONITOR_INTERVAL_SECONDS`：IPv4/IPv6 监测间隔秒数（默认 `60`）
- `IPV6_MONITOR_ENABLED`：`1/0`，启用/关闭 IPv6 监测上报（默认 `0`）
- `IP_STATE_FILE`：状态文件路径（默认 `/var/lib/changeip-http/ip_state.json`）
- `PENDING_CHANGE_FILE`：换 IP 会话状态文件路径（默认 `/var/lib/changeip-http/pending_change.json`）
- `IP_EVENTS_ENABLED`：`1/0`，启用/关闭事件流上报（`POST /internal/ip-events`）
- `IP_EVENTS_ENDPOINT`：CarpoolNotifier 上报地址（例如 `https://<worker>/internal/ip-events`）
- `IP_EVENTS_TOKEN`：上报鉴权密钥（HTTP Header：`Authorization: Bearer <token>`）
- `CHANGE_MONITOR_START_DELAY_SECONDS`：触发 provider 后延迟多久开始判定（默认 `30`；有重启时会叠加到预计重启后）
- `CHANGE_MONITOR_INTERVAL_SECONDS`：换 IP 会话进行中的判定间隔（默认 `10`）
- `CHANGE_MONITOR_TIMEOUT_SECONDS`：换 IP 会话超时（默认 `1800`）
- `SERVER_LABEL`：服务器标识（用于多服务器区分）
- `REPORT_CHANNEL`：播报目标（支持 `@channel_username` 或私有频道/超级群 `-100...` chat_id；可留空表示不向频道播报，仅通知管理员；格式非法会在启动时直接拒绝）
- `IP_STATE_FILE` / `PENDING_CHANGE_FILE` 若存在，必须是可读取的合法 JSON 对象；语法损坏或权限错误会在启动时直接拒绝，而不会被当作“空状态”。
- 若运行中再读到损坏的 `IP_STATE_FILE` / `PENDING_CHANGE_FILE`，进程会直接退出，由 systemd 拉起，而不是继续带着坏状态运行。

调度语义说明：

- `IP_MONITOR_INTERVAL_SECONDS` 与 `CHANGE_MONITOR_INTERVAL_SECONDS` 是两条独立调度线，各自按自己的间隔运行，不会互相“取最小值”覆盖。

---

## 4. 安装流程（推荐方式）

以下步骤假定你已经将本项目推送到 GitHub，并在 VPS 上使用 `root` 用户操作。

### 4.1 克隆仓库

```bash
cd /root
git clone https://github.com/akastrmix/ip-changer.git
cd ip-changer   # 仓库目录
```

> 替换 `https://github.com/<your-name>/ip-changer.git` 为你自己的仓库地址。

### 4.2 确认 IPQuality 脚本可用（仅在启用 `/ipquality` 时）

仓库自带固定版本的 IPQuality 脚本。先确认文件存在：

```bash
ls -l /root/ip-changer/vendor/ipquality/ip.sh
```

再安装脚本运行时，如果你选择启用 `/ipquality`，这一项直接回车使用默认值即可：

```text
IPQuality 脚本绝对路径 [默认 /root/ip-changer/vendor/ipquality/ip.sh]:
```

`/ipquality` 运行时会执行：

```bash
/bin/bash /root/ip-changer/vendor/ipquality/ip.sh -4 -n
```

其中 `-4` 表示只检测 IPv4；`-n` 表示跳过 IPQuality 自己的系统检测/依赖安装。请先安装运行依赖：

```bash
apt update
apt install -y jq curl bc netcat-openbsd dnsutils iproute2
```

### 4.3 确认 `/changeip` provider 资源可用（仅在启用时）

如果你计划启用 `/changeip`，请先准备 provider 对应资源：

- `script`：确认脚本存在并可由 `/bin/bash <CHANGEIP_SCRIPT>` 执行
- `exec`：确认命令可在 root 环境直接执行
- `http_flow`：确认 flow JSON 文件存在且可读，并根据面板实际请求链填写步骤

### 4.4 确认 Node.js 可用

```bash
node -v
```

如输出版本号（例如 `v18.x.x`）则表示可用；否则请安装：

```bash
apt update
apt install -y nodejs
```

### 4.5 运行安装脚本

运行安装脚本：

```bash
./install.sh
```

如果提示 `Permission denied`，再执行：

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

> 注意：`install.sh` 每次执行都会**完整重写** `/etc/default/changeip-http`。  
> 若你在该文件里手工添加过自定义环境变量（例如 provider 依赖变量），重装前请先备份并在安装后恢复。

安装脚本会进行以下操作：

1. 检查是否以 `root` 身份运行。
2. 检查 `node` 命令是否存在。
3. 询问配置项（有默认值）：
   - HTTP 端口（默认 `8787`）
   - 是否启用 `/changeip`（默认关闭）
   - 若启用 `/changeip`：
     - 选择 `CHANGEIP_PROVIDER`（`script` / `exec` / `http_flow`）
     - provider=`script`：输入 `CHANGEIP_SCRIPT`
     - provider=`exec`：输入 `CHANGEIP_EXEC_COMMAND`
     - provider=`http_flow`：输入 `CHANGEIP_HTTP_FLOW_FILE`
     - 重启延迟分钟数（默认 `1`；输入 `-1` 表示不执行重启；否则仅允许 `1..15`，禁止 `0`）
     - 事件流上报会自动启用（`IP_EVENTS_ENABLED=1`）
   - 是否启用 `/ipquality`（默认关闭）
     - 若启用：输入 `IPQUALITY_SCRIPT_PATH`
     - 默认路径为当前仓库内的 `vendor/ipquality/ip.sh`
     - 若你手动填的路径不存在，只会给出警告；等真正调用 `/ipquality` 时再按当前文件状态返回错误
   - 入站鉴权密钥 `AUTH_TOKEN`（留空则自动生成）
   - 服务器标识 `SERVER_LABEL`（用于多服务器区分）
      - 播报频道 `REPORT_CHANNEL`（例如 `@my_channel`，可留空=禁用频道播报；非空时必须是合法频道用户名或负数 chat_id）
   - 若未启用 `/changeip`：是否启用事件流上报（ip-events）
   - 若启用事件流上报：
     - 上报地址 `IP_EVENTS_ENDPOINT`（CarpoolNotifier 内部接口：`/internal/ip-events`）
     - 上报密钥 `IP_EVENTS_TOKEN`（留空则自动生成）
   - 是否启用 IPv4 变化监测（仅在变化时上报）
   - 若启用 IPv4 或 IPv6 变化监测：
     - 检测间隔秒数（默认 `60`）
   - 是否启用 IPv6 变化监测（仅在变化时上报，默认关闭；监测间隔复用 IPv4 的 `IP_MONITOR_INTERVAL_SECONDS`）
4. 展示配置预览并二次确认（确认后才会写入文件和重启服务）
5. 创建环境配置文件：`/etc/default/changeip-http`
6. 创建 systemd 服务：`/etc/systemd/system/changeip-http.service`
7. 运行：
   - `systemctl daemon-reload`
   - `systemctl enable changeip-http`
   - `systemctl restart changeip-http`

安装成功后，你可以检查服务状态：

```bash
systemctl status changeip-http
```

以及监听端口：

```bash
ss -tlnp | grep 8787   # 如使用默认端口
```

### 4.6 手动验证 HTTP 服务

在 VPS 上本机访问：

```bash
curl http://127.0.0.1:8787/
```

应返回：

```json
{"ok":true,"service":"changeip-http"}
```

如需测试 `/info`（将 `<YOUR_TOKEN>` 替换为安装时显示/设置的 `AUTH_TOKEN`）：

```bash
curl -X POST "http://127.0.0.1:8787/info" -H "Content-Type: application/json" -d '{"token":"<YOUR_TOKEN>"}'
```

如果你启用了 `/changeip`，再测试 `/changeip` 接口（将 `<YOUR_TOKEN>` 替换为安装时显示/设置的 `AUTH_TOKEN`）：

```bash
curl -X POST "http://127.0.0.1:8787/changeip" \
  -H "Content-Type: application/json" \
  -d '{"token":"<YOUR_TOKEN>"}'
```

看到 `ok: true` 代表本次触发已被接受；最终是否换 IP 成功需以后续 `change_*` 事件为准。若返回里 `reboot_schedule_requested=true` 说明计划安排重启（实际是否成功安排以日志与终态事件为准），`reboot_delay_minutes` 为计划的延迟分钟（注意这会触发实际的换 IP 逻辑，请谨慎测试）。

如果你启用了 `/ipquality`，再测试触发与状态查询：

```bash
curl -X POST "http://127.0.0.1:8787/ipquality" \
  -H "Content-Type: application/json" \
  -d '{"token":"<YOUR_TOKEN>"}'

curl -X POST "http://127.0.0.1:8787/ipquality/status" \
  -H "Content-Type: application/json" \
  -d '{"token":"<YOUR_TOKEN>"}'
```

`/ipquality` 返回 `state=started` 表示已接受并开始后台执行；`state=running` 表示当前已有检测在跑。最近一次成功的 `report_url` 与失败原因可从 `/ipquality/status` 查看。

---

## 5. 卸载流程（完全移除系统改动）

当你不再需要该服务时，可以通过卸载脚本**完全移除所有系统级改动**：

```bash
cd /root/ip-changer   # 或你的仓库目录
./uninstall.sh
```

卸载脚本执行的操作：

1. `systemctl stop changeip-http`（停止服务，忽略失败）
2. `systemctl disable changeip-http`（取消开机自启）
3. 删除 systemd 单元文件：`/etc/systemd/system/changeip-http.service`
4. 删除环境配置文件：`/etc/default/changeip-http`
5. 删除状态目录：`/var/lib/changeip-http`
6. `systemctl daemon-reload`

卸载后系统中不再有任何与本项目相关的 systemd 配置或环境文件，**不会影响其他模块的正常运行**。

若你希望连源码一并删除，只需手动：

```bash
rm -rf /root/ip-changer
```

---

## 6. 与 Telegram 机器人（CarpoolNotifier）对接

CarpoolNotifier 机器人在触发换 IP 时会调用本服务的 `/changeip` 接口，整体流程如下：

1. 在 VPS 上按本 README 安装并启动本服务。
2. 记住以下两项配置：
   - `AUTH_TOKEN`：安装时设置或自动生成的值。
   - `SERVER_LABEL`：本机标签（例如 `CMHK` / `HKT` / `HKBN`），用于在 bot 侧区分不同服务器。
   - `PORT`：HTTP 端口（默认 `8787`）。
   - `CHANGEIP_PROVIDER`：对应 provider（`script` / `exec` / `http_flow`）。
3. 在 CarpoolNotifier（Cloudflare Worker）中为该 `SERVER_LABEL` 配置“地址 + token”映射：
   - `CHANGEIP_ENDPOINTS_JSON`（vars）：`{"<SERVER_LABEL>":"http://<VPS_IP>:8787"}`
     - 这里只填 ip-changer 服务器根地址；CarpoolNotifier 会自动推导 `/changeip` 与 `/info`
   - `CHANGEIP_TOKENS_JSON`（secret）：`{"<SERVER_LABEL>":"<AUTH_TOKEN>"}`
   - `CHANGEIP_SERVERS`（vars）：确保包含该服务器；bot 侧可调用的 ip-changer 统一标记为 `script`（例如 `CMHK:script`）
     - `CHANGEIP_PROVIDER=exec/http_flow` 只属于本机 ip-changer 内部触发方式，不能原样写到 CarpoolNotifier 的 `CHANGEIP_SERVERS`
4. 重新部署 / 启动 CarpoolNotifier，使其读取新的配置。
5. 用管理员账号向 Telegram 机器人发送 `/changeip`：
   - 机器人会校验你是否管理员。
   - 按 `SERVER_LABEL` 找到对应的 ip-changer 服务器并触发换 IP。
   - 通过后提示“已收到更换 IP 请求”；是否重启取决于该 VPS 的 `REBOOT_DELAY_MINUTES` 配置。
   - VPS 后台按 provider 执行换 IP 动作；若配置 `REBOOT_DELAY_MINUTES=1..15` 则会在设定时间后重启，`-1` 则不重启。

> 说明：机器人也可以调用本服务的 `/info` 获取 `server_label` / `channel` / `notified_ipv4` / `notified_ipv6`。当前 `notified_ipv6` 仅用于日志与排障，不参与 `/changeip` 成功判定；`runtime_metrics` 可用于快速定位“为什么最近没上报/上报失败”。

> 安全建议：
> - 尽量只在内网或受控网络中开放该端口（如通过防火墙限制来源 IP）。
> - `AUTH_TOKEN` 要足够随机且保密，只在 CarpoolNotifier 环境变量和安装日志（你自己留存）中使用。

### 6.1 IP 事件流对接（IPv4 播报 + IPv6 管理员通知）

`ip-changer` 会向 CarpoolNotifier 的内部接口上报事件流（自然变化 + 换 IP 状态），因此你需要在 Cloudflare Worker 中配置密钥：

- `IP_EVENTS_TOKEN`（secret）：与 VPS 上 `IP_EVENTS_TOKEN` 完全一致

并确保 Worker 中已实现内部路由：

- `POST /internal/ip-events`（鉴权：`Authorization: Bearer <IP_EVENTS_TOKEN>`）
  - 事件体会自动携带 `contract_version`（当前 `2026-04-03.v1`）

随后：

- 当 VPS 公网 IPv4 发生变化时，CarpoolNotifier 会按既有逻辑播报/通知。
- 当 VPS 公网 IPv6 发生变化时，CarpoolNotifier 会写入 `iplog` 事件日志并通知管理员（不向频道播报）。

---

## 7. 更新与维护

### 7.1 更新代码

当你在 GitHub 上更新了此项目后，在 VPS 上执行：

```bash
cd /root/ip-changer   # 或你的仓库目录
git pull
systemctl restart changeip-http
```

即可让新版本生效。无需重新运行 `install.sh`，除非你想修改端口、脚本路径等基础配置。  
若你选择重跑 `install.sh`：脚本会完整覆盖 `/etc/default/changeip-http`，不会保留旧文件中的额外自定义项。

### 7.2 修改配置

- 编辑 `/etc/default/changeip-http`，修改任意环境变量：
  - `AUTH_TOKEN`
  - `PORT`
  - `CHANGEIP_ENABLED`
  - `CHANGEIP_PROVIDER`
  - `CHANGEIP_SCRIPT`
  - `CHANGEIP_EXEC_COMMAND`
  - `CHANGEIP_HTTP_FLOW_FILE`
  - `REBOOT_DELAY_MINUTES`
  - `IPQUALITY_ENABLED`
  - `IPQUALITY_SCRIPT_PATH`
  - `IPQUALITY_STATE_FILE`
  - `IPQUALITY_TIMEOUT_SECONDS`
  - `IP_MONITOR_ENABLED`
  - `IP_MONITOR_INTERVAL_SECONDS`
  - `IPV6_MONITOR_ENABLED`
  - `CHANGE_MONITOR_START_DELAY_SECONDS`
  - `CHANGE_MONITOR_INTERVAL_SECONDS`
  - `CHANGE_MONITOR_TIMEOUT_SECONDS`
  - `IP_EVENTS_ENABLED`
  - `IP_EVENTS_ENDPOINT`
  - `IP_EVENTS_TOKEN`
  - `SERVER_LABEL`
  - `REPORT_CHANNEL`
- 然后重启服务：

```bash
systemctl restart changeip-http
```

如果你修改了 `AUTH_TOKEN`，记得同步更新 CarpoolNotifier 中该 `SERVER_LABEL` 对应的 `CHANGEIP_TOKENS_JSON` 条目。

### 7.3 本地回归脚本（开发/改动后建议执行）

仓库提供了一个零依赖回归脚本，用于覆盖 `/changeip` 的关键并发与异常路径：

```bash
node scripts/changeip_regression.js
```

当前覆盖点：

- quick cases（运行器级）：
  - 监测调度：pending 超时后的重试时间按 `CHANGE_MONITOR_INTERVAL_SECONDS` 回退（不立即重试）
  - 监测调度：pending 超时且终态事件上报失败时，超时未收敛告警按窗口节流（避免刷屏）
  - 监测调度：pending 会话存在时暂停自然监测调度（避免 busy loop）
  - IPv4/IPv6 监测：错误日志按窗口节流，并在恢复后仅记录一次 recovered 日志
- 配置解析：IPv6 监测开关生效且复用 `IP_MONITOR_INTERVAL_SECONDS`，并验证 `ipv6` 自然事件 op_id 后缀格式
- 配置解析：数值型配置超出允许范围时立即启动失败，不做静默回退或 clamp
  - 事件契约：`event` 枚举与必填字段按 `src/contracts/ipEvents.js` 校验
  - `wait_until` 硬超时（请求耗时超过 deadline 必须失败）
  - `request` 重试收敛（按 `retries/retry_delay_ms` 成功）
  - `429 Retry-After` 优先等待策略
  - 上游提前断连（truncated response）快速失败路径（通用网络层与 `http_flow`）
  - `ip-events` 终态事件短重试（`change_*` 在瞬时 5xx 下会快速重试；自然事件保持单次上报）
  - 会话状态持久化失败可观测（`pending_change` 不可写时会显式返回持久化失败）
- 并发请求 `/changeip`（`script` 与 `exec` provider）：只允许 1 个成功，其余返回 `409`
- `CHANGEIP_SCRIPT` 相对路径：返回 `500 changeip script path must be absolute`
- `CHANGEIP_SCRIPT` 非常规文件：返回 `500 changeip script is not a regular file`
- `IPQUALITY_SCRIPT_PATH` 相对路径：返回 `500 ipquality script path must be absolute`
- `IPQUALITY_SCRIPT_PATH` 非常规文件：返回 `500 ipquality script is not a regular file`
- `/ipquality` 运行中重复触发：返回 `200 state=running` 并复用已有 `run_id`
- `/ipquality` 成功：会把 `last_success.report_url` 写入 `ipquality_state.json`
- `/ipquality` 打印了报告链接但退出码非 0：按成功处理并保存报告链接
- `/ipquality` 输出中无报告链接：会写入 `last_failure.error=ipquality report url not found`
- 脚本快速异常退出：`/changeip` 可能已返回 `200`；随后会尽快上报 `change_failed(reason=script_exited_early)` 并在 `ip-events` 可达时及时清理 `pending_change.json`
- `exec` 命令快速异常退出：`/changeip` 可能已返回 `200`；随后会尽快上报 `change_failed(reason=exec_exited_early)` 并在 `ip-events` 可达时及时清理 `pending_change.json`
- 脚本快速异常退出 + 首次 `change_failed` 上报被拒：会保留 `pending_change.json` 并由监测循环重试同一终态，成功后再清理
- 旧/不完整 `pending_change.json`：不会做兼容补全；会先尝试上报 `change_failed(invalid_pending_*)`，成功后清理（若上报不可达则保留并重试）；若缺少可用 `op_id` 则直接清理
- 损坏的 `ip_state.json` / `pending_change.json`：启动时直接失败，不会被当作“文件不存在”继续运行
- 运行中被外部写坏的 `pending_change.json`：进程会直接退出，而不是继续监测/重试
- 会话缺少 `old_ipv4`：终态会收敛为 `change_failed(old_ipv4_unknown)`，不会再从 `ip_state` 回填基线
- `http_flow` provider：验证“登录 + 重定向 + 触发动作”流程（含 cookie 会话与变量提取）
- `http_flow` provider：验证编译期校验（未知变量引用会在执行前直接拒绝）
- `ip-events` 返回 `500`：验证“已超时 pending 会话”会持续重试并记录 stuck alert 指标
- `ip-events` 请求超时：验证“已超时 pending 会话”在网络慢/超时下同样可观测并保持会话不丢失

说明：

- 完整的 `script` / `exec` provider 回归默认面向 Linux 目标机。
- 在非 Linux 开发机上运行 `node scripts/changeip_regression.js` 时，这两类“真正执行 `/bin/bash`”的 case 会被跳过；这不会改变生产环境仅支持 Debian/Ubuntu 的结论。

---

## 8. 常见问题

- **Q: 安装脚本会不会影响系统其它服务？**  
  A: 除创建一个 systemd 服务、一个环境配置文件，以及运行态状态目录 `/var/lib/changeip-http`（含 `ip_state.json` / `pending_change.json` / `ipquality_state.json`）外，不会更改系统其它配置，也不会安装/卸载系统包。卸载脚本会删除这些系统级改动，恢复到安装前状态。

- **Q: 可以不用 systemd，直接前台运行吗？**  
  A: 可以。在仓库目录直接运行：
  ```bash
  AUTH_TOKEN=... PORT=8787 CHANGEIP_ENABLED=1 CHANGEIP_PROVIDER=script CHANGEIP_SCRIPT=/root/changeip.sh REBOOT_DELAY_MINUTES=1 \
  IPQUALITY_ENABLED=1 IPQUALITY_SCRIPT_PATH=/root/ip-changer/vendor/ipquality/ip.sh IPQUALITY_TIMEOUT_SECONDS=600 \
  IP_EVENTS_ENABLED=1 IP_EVENTS_ENDPOINT=... IP_EVENTS_TOKEN=... \
  IP_MONITOR_ENABLED=1 IP_MONITOR_INTERVAL_SECONDS=60 IPV6_MONITOR_ENABLED=0 SERVER_LABEL=... REPORT_CHANNEL=@... \
  node changeip_http_server.js
  ```
  即可启动服务，但不具备开机自启与守护功能。

- **Q: CarpoolNotifier 必须部署在 VPS 上吗？**  
  A: 不需要。CarpoolNotifier 可以继续部署在 Cloudflare Worker 上，只要它能访问你的 VPS HTTP 端口即可（你需要在防火墙或安全组中允许来自相应 IP 的访问）。
