# ip-changer — RUNBOOK（部署/运维/排障）

本文档面向“把项目部署到更多 VPS”的运维场景，提供最少步骤与明确的排障路径。

## 1. 两种安装模式（建议先选好）

### A. 仅监测上报（推荐用于 HKT 等无法脚本换 IP 的 VPS）

- 关闭 `/changeip`
- 开启 IPv4 监测上报
- 可选：关闭入站端口（只做出站上报即可）

### B. 监测上报 + 一键换 IP（用于 CMHK 等支持脚本换 IP 的 VPS）

- 开启 `/changeip`
- 配置 `CHANGEIP_SCRIPT` 与 `REBOOT_DELAY_MINUTES`
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

- 你的 `/root/changeip.sh`
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
- 观察 `ip report failed:` 是否出现

### 6.4 `/changeip`（会触发真实重启，谨慎）

```bash
curl -X POST http://127.0.0.1:8787/changeip -H 'Content-Type: application/json' -d '{"token":"<AUTH_TOKEN>"}'
```

## 7. 安全建议

- **强烈建议**只在受控网络开放 `PORT`：
  - 仅监测上报模式：可直接把入站 `8787` 关掉（不影响出站上报）
  - 一键换 IP 模式：建议用防火墙限制来源（只允许你的管理 IP 或可信反代）
- `AUTH_TOKEN` / `IP_REPORT_TOKEN` 必须随机且保密
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

- token 不匹配（CarpoolNotifier 的 `CHANGEIP_TOKEN` 与 VPS 的 `AUTH_TOKEN` 必须一致）
- 或 `/changeip` 未启用（`CHANGEIP_ENABLED=0`）

### Worker 返回 401

- `IP_REPORT_TOKEN` 不一致（多台 VPS 建议共用同一个 token）

### 频道收不到消息

- bot 没进频道或权限不够（建议设为管理员并允许编辑消息）
- `REPORT_CHANNEL` 写错：公有用 `@xxx`，私有用 `-100...`

