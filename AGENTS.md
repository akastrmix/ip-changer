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

## 仓库文件地图

- `changeip_http_server.js`
  - 常驻 HTTP 服务（/ /info /changeip）+ IPv4 变化监测 + 上报。
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

## 接口契约（务必保持兼容）

`ip-changer` 对外暴露：

- `GET /`：健康检查
- `POST /info`：读取 `server_label` / `channel` / `notified_ipv4` 等信息（鉴权：JSON `{ token }`）
- `POST /changeip`：可选启用；触发脚本 + 安排重启（鉴权：JSON `{ token }`）

`ip-changer` 上报到 CarpoolNotifier：

- `POST <IP_REPORT_ENDPOINT>`（通常为 Worker 的 `/internal/ip-changed`）
  - Header：`Authorization: Bearer <IP_REPORT_TOKEN>`
  - Body：`{ server_label, channel, old_ipv4, new_ipv4, detected_at }`

上述字段名/语义应尽量保持稳定；若必须变更，需同步更新文档与 CarpoolNotifier。

## 系统级改动范围（不可越界）

安装后允许的系统级持久改动只有：

- `/etc/systemd/system/changeip-http.service`
- `/etc/default/changeip-http`
- `/var/lib/changeip-http/`（仅在启用监测时，用于保存上次已上报 IPv4）

卸载脚本必须完全移除这些改动，并且不删除用户自有的 `/root/changeip.sh` 或仓库目录。

## 开发/排障常用命令

- 查看服务：`systemctl status changeip-http --no-pager`
- 查看日志：`journalctl -u changeip-http -n 200 --no-pager`
- 健康检查：`curl http://127.0.0.1:8787/`
- 查看 info：`curl -X POST http://127.0.0.1:8787/info -H 'Content-Type: application/json' -d '{"token":"..."}'`

