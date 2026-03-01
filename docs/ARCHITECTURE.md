# src 架构说明

`src/` 按领域职责组织，避免业务逻辑继续堆在根目录。

## 目录分层

- `change/`
  - `trigger.js`：`/changeip` 触发入口编排。
  - `session.js`：对外稳定入口（`pending_change.json` 生命周期、`change_*` 事件与会话落盘）。
  - `session/`：`session.js` 的内部拆分模块（shared/store/mutations/payloads/events）。
- `monitor/`
  - `start.js`：监测调度主循环。
  - `natural.js`：自然 IPv4/IPv6 监测与变化上报。
  - `pending.js`：换 IP 会话 runner 对外入口（内部模块见 `monitor/pending/`）。
  - `pending/`：pending runner 内部模块（validate/provider/reboot/terminal/invalid/runner）。
  - `helpers.js`：调度时间与监测日志辅助函数。
- `network/`
  - `keepAliveAgents.js`：HTTP keep-alive agent 配置工厂（`http.js` 与 `http_flow` 共享，避免参数漂移）。
  - `http.js`：底层 HTTP 请求封装。
  - `responseText.js`：HTTP 响应体读取与大小保护（通用网络层与 `http_flow` 共享）。
  - `ipEvents.js`：ip-events 客户端（发送前本地契约校验）。
- `contracts/`
  - `ipEvents.js`：事件枚举、版本、必填字段与 payload 校验。
- `ip/`
  - `ipv4.js`、`ipv6.js`：公网 IP 获取与格式校验。
- `runtime/`
  - `metrics.js`：运行时计数器与最近错误。
- `providers/`
  - `/changeip` provider 适配层（`script` / `exec` / `http_flow`）及公共工具。
  - `httpFlow/compile/steps/`：`http_flow` 编译阶段的步骤解析子模块（request/assert/extract/wait_until/set/sleep）。

## 根目录保留模块

`src/` 根目录仅保留稳定公共模块与聚合入口：

- `config.js`、`state.js`、`opId.js`、`monitor.js`

## 进程入口

进程级入口文件位于仓库根目录：

- `changeip_http_server.js`
