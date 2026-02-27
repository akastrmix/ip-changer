# Changelog

本项目以“稳定可长期运维”为目标；对外接口字段与部署行为尽量保持兼容。

## Unreleased

- 修复：`/changeip` 先持久化 `pending_change` 再进入异步流程，消除“基线未初始化时并发触发多次脚本”的竞态窗口。
- 修复：`change_started` 上报改为按 `op_id` 回读并更新 pending，避免 spawn 失败后旧异步回调把 pending 写回（状态复活）。
- 新增：`/changeip` provider 架构（`CHANGEIP_PROVIDER=script|exec|http_flow`），并拆分到 `src/providers/` 模块。
- 新增：`exec` provider（执行任意本地命令）与统一 provider 调度入口。
- 变更（破坏性）：当 `CHANGEIP_ENABLED=1` 时必须显式配置 `CHANGEIP_PROVIDER`（不再隐式默认脚本 provider）。
- 强化：`CHANGEIP_SCRIPT` 校验增加“必须绝对路径 + 必须常规文件”。
- 强化：新增脚本早退检测（启动后短时间内非 0/信号退出直接判失败），`/changeip` 返回 `500 changeip script exited early` 并上报 `change_failed`。
- 新增：`scripts/changeip_regression.js` 零依赖回归脚本，覆盖 `/changeip` 并发与关键失败路径（含 `exec` provider 并发用例）。
- 新增：`http_flow` provider 可用（flow JSON 执行器，支持 cookie、重定向、变量模板、提取与断言步骤）。
- 新增：示例 flow 文件 `flows/ippanel.boil.network.sample.json`。
- 新增：回归脚本 `http_flow` 用例，覆盖“登录 + 重定向 + 触发动作”链路。
- 重构：抽离 `src/changeSession.js`，统一 `pending_change` 会话状态迁移与 `change_*` 事件构造/发送逻辑。
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
