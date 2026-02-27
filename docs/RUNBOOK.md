# ip-changer — RUNBOOK（部署/运维/排障）

本文档面向“把项目部署到更多 VPS”的运维场景，提供最少步骤与明确的排障路径。

## 1. 两种安装模式（建议先选好）

### A. 仅监测上报（推荐用于 HKT 等无法脚本换 IP 的 VPS）

- 关闭 `/changeip`
- 开启 IPv4 监测上报
- 可选：关闭入站端口（只做出站上报即可）

### B. 监测上报 + 一键换 IP（支持多种 provider）

- 开启 `/changeip`
- 配置 `CHANGEIP_PROVIDER` 与对应 provider 参数，再配置 `REBOOT_DELAY_MINUTES`（可设为 `-1` 禁用重启）
  - `script`：`CHANGEIP_SCRIPT`
  - `exec`：`CHANGEIP_EXEC_COMMAND`
  - `http_flow`：`CHANGEIP_HTTP_FLOW_FILE`（可参考 `flows/ippanel.boil.network.sample.json`）
- 开启 IPv4 监测上报（推荐，用于自动播报与会话编辑）

## 2. 标准安装（Debian/Ubuntu）

1) 安装 Node.js（若系统没有）：

```bash
apt update
apt install -y nodejs
```

2) 克隆并安装：

```bash
cd /root
git clone https://github.com/akastrmix/ip-changer.git
cd ip-changer
./install.sh
```

如果提示 `Permission denied`，再执行：

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

安装脚本会：

- 写入 `/etc/default/changeip-http`
- 写入 `/etc/systemd/system/changeip-http.service`
- `systemctl enable changeip-http && systemctl restart changeip-http`

## 3. 修改配置

直接编辑：

- `/etc/default/changeip-http`

然后：

```bash
systemctl restart changeip-http
```

提示：

- 重新运行 `./install.sh` 也可以“重写配置文件并重启”，但会提示你重新输入参数；若你不想改 bot/worker 配置，务必沿用原 token。

## 4. 更新代码（GitHub 更新后）

```bash
cd /root/ip-changer
git pull
systemctl restart changeip-http
```

## 5. 卸载（完全移除系统级改动）

```bash
cd /root/ip-changer
./uninstall.sh
```

卸载会删除：

- `/etc/systemd/system/changeip-http.service`
- `/etc/default/changeip-http`
- `/var/lib/changeip-http`

不会删除：

- 你的 provider 相关文件（例如 `/root/changeip.sh`、自定义 flow JSON 等）
- 你的仓库目录（可手动 `rm -rf /root/ip-changer`）

## 6. 验证与测试

### 6.1 本机健康检查

```bash
curl http://127.0.0.1:8787/
```

### 6.2 `/info`（需要 AUTH_TOKEN）

```bash
curl -X POST http://127.0.0.1:8787/info -H 'Content-Type: application/json' -d '{"token":"<AUTH_TOKEN>"}'
```

### 6.3 IPv4 上报验证（推荐）

最直接的验证方式是在 CarpoolNotifier 增加/使用测试命令向频道发消息（例如 `/test_ip_channel`）。

若要验证 `ip-changer → Worker` 是否通：

- 检查日志：`journalctl -u changeip-http -n 200 --no-pager`
- 检查状态文件：`cat /var/lib/changeip-http/ip_state.json`
  - 若上报失败，`last_report_error` 会记录最近一次失败的错误摘要
  - 若一直未能初始化基线，说明公网 IPv4 获取可能失败（可查看日志中的 `monitor error:`）

### 6.4 `/changeip`（可能触发真实重启，取决于 `REBOOT_DELAY_MINUTES`，谨慎）

如果你只想测试 provider 触发但不想重启，可先在 `/etc/default/changeip-http` 设置：

- `REBOOT_DELAY_MINUTES=-1`

并执行 `systemctl restart changeip-http` 后再测试。

```bash
curl -X POST http://127.0.0.1:8787/changeip -H 'Content-Type: application/json' -d '{"token":"<AUTH_TOKEN>"}'
```

## 7. 安全建议

- **强烈建议**只在受控网络开放 `PORT`：
  - 仅监测上报模式：可直接把入站 `8787` 关掉（不影响出站上报）
  - 一键换 IP 模式：建议用防火墙限制来源（只允许你的管理 IP 或可信反代）
- `AUTH_TOKEN` / `IP_EVENTS_TOKEN` 必须随机且保密
- token 轮换：
  - 修改 VPS：`/etc/default/changeip-http` 后重启
  - 同步更新 Worker/CarpoolNotifier 对应的 token

## 8. 常见问题排障

### 服务启动失败

```bash
systemctl status changeip-http --no-pager
journalctl -u changeip-http -n 200 --no-pager
```

常见原因：

- `AUTH_TOKEN` 为空：服务会拒绝启动
- 端口被占用：修改 `PORT` 后重启
- `node` 不存在：先安装 `nodejs`

### `/info` 或 `/changeip` 返回 403

- token 不匹配（CarpoolNotifier 中该 `SERVER_LABEL` 的 token 与 VPS 的 `AUTH_TOKEN` 必须一致；通常在 `CHANGEIP_TOKENS_JSON` 里配置）
- 或 `/changeip` 未启用（`CHANGEIP_ENABLED=0`）

### `/changeip` 返回 500

- `CHANGEIP_PROVIDER` 未配置或取值非法（`script` / `exec` / `http_flow`）
- 可优先查看响应字段 `provider_error_code`：`provider.unsupported` / `provider.config_invalid` / `provider.spawn_failed` / `provider.exited_early` / `provider.runtime_failed`
- provider=`script` 时：`CHANGEIP_SCRIPT` 路径不合法（必须为绝对路径，且指向可读的常规文件）
- provider=`script` 时：脚本创建进程失败（`failed to spawn changeip script`）
- provider=`script` 时：脚本启动后立即异常退出（`changeip script exited early`）
- provider=`exec` 时：命令为空/创建失败/启动后异常退出
- provider=`http_flow` 时：flow 文件 JSON 非法、步骤执行失败或模板变量缺失
- 状态文件无法写入（`failed to persist change session`）

### Worker 返回 401

- `IP_EVENTS_TOKEN` 不一致（多台 VPS 建议共用同一个 token）

### 频道收不到消息

- bot 没进频道或权限不够（建议设为管理员并允许编辑消息）
- `REPORT_CHANNEL` 写错：公有用 `@xxx`，私有用 `-100...`

## 9. 上报接口（/internal/ip-events）

你已确认：不做向下兼容，因此 `ip-changer` 只上报到 `/internal/ip-events`：

1) CarpoolNotifier：配置 secret `IP_EVENTS_TOKEN`
2) VPS ip-changer：配置并启用：
   - `IP_EVENTS_ENABLED=1`
   - `IP_EVENTS_ENDPOINT=https://<worker>/internal/ip-events`
   - `IP_EVENTS_TOKEN=<same as worker secret>`

## 10. 回归脚本（开发验证）

在调整 `/changeip` 相关逻辑后，建议运行：

```bash
cd /root/ip-changer
node scripts/changeip_regression.js
```

该脚本不依赖第三方包，会临时启动本地测试服务，验证并发与失败路径（结束后自动清理临时文件）。
维护方式：基础能力在 `scripts/changeip_regression/harness.js`，具体用例在 `scripts/changeip_regression/cases.js`。
