# Changelog

本项目以“稳定可长期运维”为目标；对外接口字段与部署行为尽量保持兼容。

## Unreleased

（暂无）

## 0.7.5

- 部署：内置固定版本的上游 IPQuality 脚本到 `vendor/ipquality/ip.sh`，安装脚本启用 `/ipquality` 时默认指向仓库内文件，不再要求维护者先手动创建 `/root/IPQuality/ip.sh`。
- 新增：可选 `/ipquality` 能力，使用固定本地脚本路径异步执行 IPQuality，并新增 `/ipquality/status` 查看当前运行态与最近一次成功/失败结果。
- 新增：`src/ipquality/` 子系统与 `ipquality_state.json` 状态文件，服务启动时会把“上次进程异常中断的 running run”修复为失败态，避免永久卡在 running。
- 新增：安装脚本支持配置 `IPQUALITY_ENABLED` / `IPQUALITY_SCRIPT_PATH`；缺文件只给出安装期警告，真正调用 `/ipquality` 时再按当前文件状态返回错误。
- 测试：回归脚本补充 `ipquality` 配置校验、状态修复、运行中复用、成功落盘、失败落盘等用例。
- 文档：修正 `install.sh` 安装完成提示、README、AGENTS 与对接文档中的 CarpoolNotifier 配置示例；`CHANGEIP_ENDPOINTS_JSON` 现在只填 ip-changer 根地址，bot 侧 `CHANGEIP_SERVERS` 对可调用 ip-changer 统一写 `LABEL:script`，不再把本机 `exec/http_flow` provider 原样写入 bot 配置。

## 0.7.0

- 破坏性更新：`ip-events` 契约版本提升到 `2026-04-03.v1`。`channel` 已经变成必带硬语义，因此不再沿用旧版本号混用新旧 sender。
- 修复：`REPORT_CHANNEL` 现在在配置加载阶段就会按 `ip-events` 同一套规则校验；非法值会直接启动失败，不再等到 `/changeip` 或自然监测真正发事件时才报 `invalid channel`。
- 边界：`script` / `exec` provider 明确收回到 Debian/Ubuntu 服务器环境，固定依赖 `/bin/bash`；非 Linux 开发机只在回归层跳过相关执行用例，不再通过生产代码提供运行时兼容。
- 修复：当 `CHANGEIP_ENABLED=1` 且需要安排重启时，配置加载阶段现在要求系统存在 `/usr/sbin/shutdown` 或 `/sbin/shutdown`；不再退回 PATH 里的 `shutdown` 再把失败留到运行时。
- 修复：`/info` 与 `/changeip` 现在严格要求请求体为 JSON 对象；数组、数字、字符串等非对象 JSON 会直接返回 `400`，不再落到后续鉴权分支。
- 契约：`ip-events` payload 统一改为始终显式携带 `channel`；空字符串继续表示禁用频道播报，不再保留“省略 channel”的旧语义。
- 测试：回归脚本补充“空字符串合法、缺 `channel`/非法 `channel` 会被拒绝”的契约检查，避免两端文档与实现再次漂移。

## 0.6.0

- 重构：`src/` 目录按领域收敛为 `change/`、`monitor/`、`network/`、`contracts/`、`ip/`、`runtime/`，并补充模块地图 `docs/ARCHITECTURE.md`。
- 强化：新增“超时 pending 会话 + ip-events 500/超时”故障注入回归用例，确保会话持续重试且 `pending_timeout_stuck_alerts_total` 指标可观测。
- 新增：可选 IPv6 自然变化监测（`IPV6_MONITOR_ENABLED`，监测间隔复用 `IP_MONITOR_INTERVAL_SECONDS`），上报 `event=ipv6_changed`，并在 `/info` 返回 `notified_ipv6` / `ipv6_monitor_enabled`。
- 语义保持：`/changeip` 会话判定与 `change_*` 事件仍只基于 IPv4。
- 优化：自然 IPv4/IPv6 变化事件在上报失败重试时复用同一 `op_id`（`IP_STATE_FILE` 记录 pending `op_id + old/new`），降低短暂故障下的重复播报风险。
- 修复：pending runner 在同一 tick 内 provider 启动后会基于最新会话状态尽快上报 `change_started`，避免在 `monitor_after_ms` 前被动延迟。
- 优化：IPv6 检测源改为优先 IPv6 专用入口（`api6.ipify.org` 等），并增加启动可达性探测与错误日志节流（默认 5 分钟）以降低噪音。
- 重构：监测模块拆分为 `src/monitor/` 子模块（pending/natural/scheduler/helpers），并统一自然 IPv4/IPv6 监测执行器，降低重复分支。
- 重构：`http_flow` 编译器拆分为 `src/providers/httpFlow/compile/*` 子模块（shared/steps/flow），`compile.js` 保持兼容入口。
- 新增：事件契约模块 `src/contracts/ipEvents.js`，统一 `event` 枚举与必填字段校验；上报前会做本地契约校验。
- 修复：`/changeip` 先持久化 `pending_change` 再进入异步流程，消除“基线未初始化时并发触发多次脚本”的竞态窗口。
- 修复：`change_started` 上报改为按 `op_id` 回读并更新 pending，避免 spawn 失败后旧异步回调把 pending 写回（状态复活）。
- 新增：`/changeip` provider 架构（`CHANGEIP_PROVIDER=script|exec|http_flow`），并拆分到 `src/providers/` 模块。
- 新增：`exec` provider（执行任意本地命令）与统一 provider 调度入口。
- 变更（破坏性）：当 `CHANGEIP_ENABLED=1` 时必须显式配置 `CHANGEIP_PROVIDER`（不再隐式默认脚本 provider）。
- 强化：`CHANGEIP_SCRIPT` 校验增加“必须绝对路径 + 必须常规文件”。
- 强化：新增脚本早退检测（启动后短时间内非 0/信号退出直接判失败），`/changeip` 返回 `500 changeip script exited early` 并上报 `change_failed`。
- 新增：`scripts/changeip_regression.js` 零依赖回归脚本，覆盖 `/changeip` 并发与关键失败路径（含 `exec` provider 并发用例）。
- 新增：`http_flow` provider 可用（flow JSON 执行器，支持 cookie、重定向、变量模板、提取与断言步骤）。
- 新增：示例 flow 文件 `flows/samples/ippanel.boil.network.sample.json`。
- 新增：回归脚本 `http_flow` 用例，覆盖“登录 + 重定向 + 触发动作”链路。
- 新增：`http_flow` `request` 步骤支持 `allow_network_error=true`，用于“触发后立即断网”的末步动作场景。
- 新增：`http_flow` `request` 步骤支持 `retries/retry_delay_ms`，并新增 `wait_until` 轮询步骤用于慢页面收敛。
- 新增：`http_flow` 重试在收到 `429` + `Retry-After` 时会优先按服务端建议等待，降低限流放大风险。
- 调整：统一 provider 启动语义为“通过启动探测即视为已触发”，`http_flow` 改为后台执行并在启动探测窗口内失败时返回 `500`。
- 优化：新增 `detachedCommandProvider` 工厂，合并 `script/exec` provider 重复启动逻辑。
- 优化：`http_flow` 增加按文件 `mtime/size` 的编译缓存，减少重复编译开销。
- 文档：新增 `docs/BOIL_FLOW.md`（boil 面板专用 flow 配置/映射/排障说明），并在 README/RUNBOOK 增加入口。
- 文档：补齐 `/changeip` 关键语义（`ok=true` 仅表示触发已接受、`409 in-progress`、`ip-events` 依赖）与 `pending_change` 状态文件说明，降低新会话接手成本。
- 重构：抽离 `src/change/session.js`，统一 `pending_change` 会话状态迁移与 `change_*` 事件构造/发送逻辑。
- 重构：统一 provider 错误模型（稳定 `provider_error_code`），降低上层分支判断复杂度。
- 重构：回归测试拆分为 `scripts/changeip_regression/harness.js` + `scripts/changeip_regression/cases.js`，便于后续按 provider 扩展用例。
- 重构：`http_flow` provider 拆分为编译/模板/http/cookie/运行时模块，降低单文件复杂度。
- 强化：`http_flow` 增加编译期校验与预编译（步骤结构、变量依赖、状态码与正则格式），不合法 flow 在执行前即失败。

## 0.5.0

- 变更（破坏性）：移除旧上报配置 `IP_REPORT_ENDPOINT/IP_REPORT_TOKEN` 与 `/internal/ip-changed`，统一改为事件流上报 `IP_EVENTS_ENDPOINT/IP_EVENTS_TOKEN` → `POST /internal/ip-events`。
- 新增：自然 IPv4 变化事件 `event=ipv4_changed`（携带 `op_id/ts/old_ipv4/new_ipv4`）。
- 新增：脚本换 IP 事件 `change_started/change_succeeded/change_no_change/change_failed`，并在 `/changeip` 返回 `op_id` 用于 bot 会话关联。
- 新增：`pending_change.json` 持久化（跨重启恢复），解决“脚本换 IP 失败但公网 IPv4 未变化导致 bot 会话卡住”。
- 变更（破坏性）：`REBOOT_DELAY_MINUTES` 仅允许 `-1` 或 `1..15`，禁止 `0`。
- 重构：代码拆分为 `src/` 模块化（仍然不引入任何第三方依赖）。
- 修复：换 IP 会话的监测起点会自动考虑 `REBOOT_DELAY_MINUTES`，避免在重启前误判为 `change_no_change`。
- 修复：当 `REBOOT_DELAY_MINUTES=-1` 且网络仍可用时，`ip-changer` 会等待一次断网/恢复或超时后才上报 `change_no_change`，避免脚本执行中误判。
- 优化：`REPORT_CHANNEL` 允许留空（仅通知管理员）；自然 IPv4 监测仍会初始化基线并上报事件（channel 为空）。

## 0.4.0

- 新增：支持 `REBOOT_DELAY_MINUTES=-1` 禁用重启（仍可触发脚本）。
- 变更：安装脚本支持输入 `-1` 并在安装结果中明确展示“重启已禁用”。
- 运维：将 `install.sh` / `uninstall.sh` 标记为可执行，避免在 VPS 上 `chmod` 导致 `git pull` 误判为本地改动。
- 文档：同步更新 README / SPEC / RUNBOOK 对该行为的说明。

## 0.3.0

- 文档：新增 `AGENTS.md` 与 `docs/`（SPEC / INTEGRATION / RUNBOOK），用于快速恢复上下文与降低维护成本。
- 强化：安装脚本对输入做校验并安全写入环境文件；默认关闭 `/changeip`，避免误开风险。
- 强化：服务端健壮性与安全性（token 常量时间比较、请求体大小限制、异常处理与更准确的 /info 状态）。

## 0.2.0

- 新增：公网 **IPv4** 变化监测与上报（仅变化时播报）。
- 新增：/info 接口用于让 CarpoolNotifier 获取服务器标签/频道/基线 IP。
- 强化：出站请求强制 IPv4，避免混入 IPv6。

## 0.1.0

- 初始版本：HTTP 服务 + 可选 `/changeip`（触发脚本 + 安排重启），systemd 安装/卸载脚本与 README。
