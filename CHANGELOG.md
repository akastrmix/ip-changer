# Changelog

本项目以“稳定可长期运维”为目标；对外接口字段与部署行为尽量保持兼容。

## Unreleased

- （暂无）

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
