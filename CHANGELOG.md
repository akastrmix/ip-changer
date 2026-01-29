# Changelog

本项目以“稳定可长期运维”为目标；对外接口字段与部署行为尽量保持兼容。

## Unreleased

（暂无）

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
