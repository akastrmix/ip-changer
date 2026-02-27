# ip-changer — Agent Notes (for AI / contributors)

本文件用于让新开对话的 AI/协作者在 **不依赖聊天上下文** 的情况下，快速理解并遵守本项目的核心约束。

## 目标与不变量

- **轻量化**
  - `changeip_http_server.js` **不允许引入任何第三方 NPM 包**，仅使用 Node 标准库。
  - 运行时常驻一个 Node 进程；不引入额外守护进程/数据库。
- **高度独立化**
  - 安装/卸载只能影响与本项目相关的 systemd 单元、环境文件与本项目状态目录。
  - 不应修改系统其它模块（例如：不自动安装系统包、不改 sysctl、不改全局 cron 等）。
- **可选的一键换 IP**
  - `/changeip` 只是可选能力（某些 VPS 不支持换 IP 脚本）。
  - 默认建议关闭；开启时以服务器自带脚本为准（通常为 `/root/changeip.sh`）。
- **只播报 IPv4**
  - 公网 IP 检测与上报必须只使用 IPv4（当前实现强制 `family=4`）。
- **多服务器可扩容**
  - 每台 VPS 独立配置 `SERVER_LABEL` 与 `REPORT_CHANNEL`，CarpoolNotifier 以 `server_label` 区分服务器。
- **README 清晰化**
  - README 必须拥有完整和清晰的项目介绍以及使用方法以让运维人员理解此项目并了解它对服务器的影响，任何功能上的更改都必须同步到 README 以确保内容为最新。
- **不必强兼容**
  - 当“强行兼容”会导致实现臃肿、复杂度上升或风险更高时，可以直接采用更好的新架构/重构方案。优先可维护性与长期稳定性，避免为了兼容而“修修补补”堆出隐性分支与不确定性。
- **模块化设计**
  - 每个功能部分尽量独立以保证局部改动不会影响全局稳定性。同时，当某个模块包含的内容过大功能过多的时候有必要拆分为更小的模块组合以提升可维护性。

## 仓库文件地图

- `changeip_http_server.js`
  - 常驻 HTTP 服务（/ /info /changeip）+ IPv4 变化监测 + 事件流上报。
- `src/`
  - 纯 Node 标准库模块（配置解析/状态文件/IPv4 获取/事件上报/监测循环等），便于维护但不引入依赖。
  - `src/providers/`：`/changeip` provider 模块（`script` / `exec` / `http_flow`）与统一入口。
- `install.sh`
  - 写入 `/etc/default/changeip-http`，创建 `/etc/systemd/system/changeip-http.service`，启用服务。
- `uninstall.sh`
  - 停用并删除上述 systemd 单元与环境文件，并删除 `/var/lib/changeip-http`。
- `README.md`
  - 面向运维/用户的安装说明与影响说明。
- `docs/`
  - `SPEC.md`：行为规格（接口、状态文件、监测逻辑、边界条件）
  - `INTEGRATION.md`：与 CarpoolNotifier 的对接契约
  - `RUNBOOK.md`：运维手册（部署/更新/排障）

## 接口契约（字段尽量保持稳定）

`ip-changer` 对外暴露：

- `GET /`：健康检查
- `POST /info`：读取 `server_label` / `channel` / `changeip_provider` / `notified_ipv4` 等信息（鉴权：JSON `{ token }`）
- `POST /changeip`：可选启用；触发 provider（按 `REBOOT_DELAY_MINUTES` 可选安排重启，`-1` 表示不重启）（鉴权：JSON `{ token }`）

`ip-changer` 上报到 CarpoolNotifier：

- `POST <IP_EVENTS_ENDPOINT>`（Worker 的 `/internal/ip-events`）
  - Header：`Authorization: Bearer <IP_EVENTS_TOKEN>`
  - Body（最小字段）：`{ server_label, channel, op_id, ts, event, ... }`
    - 自然变化：`event=ipv4_changed` + `old_ipv4/new_ipv4`
    - 换 IP 会话：`event=change_started/change_succeeded/change_no_change/change_failed`（见 `docs/SPEC.md`）

上述字段名/语义应尽量保持稳定；若必须变更，需同步更新文档与 CarpoolNotifier。

## 系统级改动范围（不可越界）

安装后允许的系统级持久改动只有：

- `/etc/systemd/system/changeip-http.service`
- `/etc/default/changeip-http`
- `/var/lib/changeip-http/`（用于保存状态文件；卸载会删除）
  - `ip_state.json`：上次已上报 IPv4（基线）
  - `pending_change.json`：正在进行的换 IP 操作（用于跨重启恢复）

卸载脚本必须完全移除这些改动，并且不删除用户自有的 `/root/changeip.sh` 或仓库目录。

## 开发/排障常用命令

- 查看服务：`systemctl status changeip-http --no-pager`
- 查看日志：`journalctl -u changeip-http -n 200 --no-pager`
- 健康检查：`curl http://127.0.0.1:8787/`
- 查看 info：`curl -X POST http://127.0.0.1:8787/info -H 'Content-Type: application/json' -d '{"token":"..."}'`

## 回归脚本强制规则（AI 必须执行）

- 回归脚本：`node scripts/changeip_regression.js`
- 触发条件（满足任一即必须运行）：
  - 修改 `changeip_http_server.js`
  - 修改 `src/*.js`
  - 修改 `scripts/changeip_regression.js`
  - 修改 `install.sh` / `uninstall.sh` 且可能影响 `/changeip` 相关行为
- 交付前要求：
  - 回归脚本必须通过；失败时不得直接交付，必须继续修复直到通过。
  - 最终回复必须包含“已运行回归脚本”与结果摘要（通过/失败、关键 case）。
- 覆盖面维护（自动扩展）：
  - 若本次改动改变了 `/changeip`、并发控制、状态文件（`pending_change.json` / `ip_state.json`）、事件上报、脚本校验或错误码语义，必须同步更新 `scripts/changeip_regression.js`。
  - 每次此类行为变更，至少新增或强化 1 个对应测试 case（不能只改实现不改测试）。
  - 若当前环境确实无法运行脚本，需在最终回复明确说明阻塞原因、已尝试命令及建议补跑命令。
