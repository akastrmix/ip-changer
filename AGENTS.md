# ip-changer — Agent Notes (for AI / contributors)

本文件是新对话的“硬约束索引页”。  
目标：让协作者在不依赖聊天上下文的情况下，快速按统一规则改动本项目。

## MUST（必须遵守）

- 轻量化：
  - `changeip_http_server.js` 只允许 Node 标准库，不可引入第三方 NPM 包。
  - 运行时保持单 Node 进程，不增加额外守护进程/数据库。
- 系统边界：
  - 安装/卸载只可影响：
    - `/etc/systemd/system/changeip-http.service`
    - `/etc/default/changeip-http`
    - `/var/lib/changeip-http/`（`ip_state.json` / `pending_change.json` / `ipquality_state.json`）
  - 不可改动系统其它模块（系统包、sysctl、全局 cron 等）。
- 语义边界：
  - IPv6 仅用于自然变化记录（`ipv6_changed`），`/changeip` 会话收敛仍只看 IPv4。
  - `/changeip` 的 `ok=true` 仅表示“触发已接受且会话已落盘，provider 启动已异步调度”，最终结果以 `change_*` 事件为准。
- 契约稳定：
  - `GET /`、`POST /info`、`POST /changeip`、`POST /ipquality`、`POST /ipquality/status` 与 ip-events 字段语义应尽量保持稳定。
  - 必要变更时必须同步更新 `docs/SPEC.md`、`docs/INTEGRATION.md`；若命中跨仓库契约，再同步改 CarpoolNotifier 对接端。
- 跨仓库联动（重要）：
  - 当你改动以下任一项，必须同时 review/修改 **CarpoolNotifier**（代码 + 文档 + 回归），否则大概率“单边改动导致线上卡死/不播报/误告警”：
    - `/changeip` 或 `/info` 的返回字段/语义/错误码/鉴权（含 `ok`/`op_id`/`provider_error_code`/`ip_events_contract_version` 等）
    - ip-events：`contract_version`、事件枚举、必填字段、幂等键（`server_label + op_id + event`）与乱序/终态优先规则
    - `change_failed.reason` 列表或语义（会影响 bot 文案与告警分流）
    - `REPORT_CHANNEL` “允许为空=禁用频道播报”的语义
  - 快速定位（对接文件）：
    - 本仓库：`docs/SPEC.md`、`docs/INTEGRATION.md`、`src/contracts/ipEvents.js`
    - CarpoolNotifier：`docs/changeip/IP_CHANGER.md`、`docs/changeip/IP_EVENTS.md`、`src/services/changeip/ipChanger.js`、`src/services/ipChanges/contract.js`
  - 交付前必须跑：
    - 本仓库：`node scripts/changeip_regression.js`
    - CarpoolNotifier：`bash scripts/check.sh`
- 结构一致性：
  - 新增/重构代码必须遵循 `docs/ARCHITECTURE.md` 的目录分层。
  - 不得继续在 `src/` 根目录堆叠新的业务模块文件。
  - 若调整模块职责或新增一级领域目录，必须同步更新 `docs/ARCHITECTURE.md`。
- 文档同步：
  - 任何功能变化必须同步更新 README 与对应 docs 文档，避免“代码变了文档没变”。
- 回归强制：
  - 只要命中以下任一条件，交付前必须执行：`node scripts/changeip_regression.js`
    - 修改 `changeip_http_server.js`
    - 修改 `src/*.js`
    - 修改 `scripts/changeip_regression.js` 或 `scripts/changeip_regression/*.js`
    - 修改 `install.sh` / `uninstall.sh` 且影响 `/changeip` 行为
  - 回归失败不得交付，必须修复至通过。
  - 若行为语义变化（并发、状态文件、上报、错误码、脚本校验等），必须同步增强至少 1 个回归 case。

## SHOULD（推荐）

- 默认优先可维护性与长期稳定性，不为“强兼容”牺牲架构清晰度。
- 功能模块尽量小而独立，避免单文件职责过重。
- 多服务器场景下继续使用 `SERVER_LABEL` + `REPORT_CHANNEL` 区分实例。
- 避免采用降级处理、兜底方案、临时补丁、启发式方法、局部稳定手段等叠补丁和增加代码复杂度的方案，也不要写过度防御性代码和过度考虑兼容性，尽可能 fail fast / 重构为最优解。
- 保持项目风格统一，设计新功能的时候应当遵从项目其他部分类似的仓库文件分布/命名模式等风格。

## 快速恢复（新对话 5 分钟）

1. 先读：`AGENTS.md`、`docs/SPEC.md`、`docs/ARCHITECTURE.md`。
2. 若涉及 `http_flow`/boil：再读 `docs/BOIL_FLOW.md` 与 `flows/ippanel.boil.network.HKT.json` / `flows/ippanel.boil.network.HKBN.json`。
3. 执行 `git status --short`，识别已有改动；不要回滚不属于本任务的内容。
4. 按需改动代码与文档；命中回归条件时执行 `node scripts/changeip_regression.js`。
5. 交付前确认 README/SPEC/INTEGRATION/RUNBOOK/ARCHITECTURE 是否已同步。

## src 放置规则（摘要）

- `src/change/`：`/changeip` 编排与会话状态机。
- `src/monitor/`：调度、自然监测、pending 收敛。
- `src/network/`：HTTP 客户端与 ip-events 上报。
- `src/contracts/`：事件契约与字段校验。
- `src/ip/`：IPv4/IPv6 获取与校验。
- `src/runtime/`：运行时指标。
- `src/providers/`：`script` / `exec` / `http_flow` provider。
- `src/ipquality/`：`/ipquality` 触发、状态文件与后台执行。
- `src/` 根目录仅保留稳定公共入口模块（如 `monitor.js`、`config.js`、`state.js`、`opId.js`）。

详见：`docs/ARCHITECTURE.md`

## 关键文档入口

- `README.md`：项目介绍、安装、配置、回归总览。
- `docs/SPEC.md`：接口与行为规格（判定语义、状态文件、错误语义）。
- `docs/INTEGRATION.md`：与 CarpoolNotifier 的事件契约。
- `docs/RUNBOOK.md`：部署/更新/排障流程。
- `docs/ARCHITECTURE.md`：`src/` 分层与职责地图。

## 常用排障命令

- `systemctl status changeip-http --no-pager`
- `journalctl -u changeip-http -n 200 --no-pager`
- `curl http://127.0.0.1:8787/`
- `curl -X POST http://127.0.0.1:8787/info -H 'Content-Type: application/json' -d '{"token":"..."}'`
