# ip-changer — HTTP Trigger + IPv4 变化监测

一个极简的常驻服务，用于在 Debian VPS 上：

- （可选）通过 HTTP 触发 `changeip.sh` + 自动重启，实现一键更换公网 IP
- 监测公网 **IPv4** 是否发生变化，并上报到 CarpoolNotifier（Cloudflare Worker），由机器人自动播报到频道 + 管理员

本项目只负责：

- 在 VPS 上监听一个 HTTP 接口（默认 `0.0.0.0:8787`）。
- （可选）接收到带密钥的请求后后台执行 `changeip.sh` 并安排重启。
- 定期检测公网 IPv4 变化并上报到 CarpoolNotifier。

---

## 1. 文件结构与运行方式

本仓库包含以下主要文件：

- `changeip_http_server.js`
  - 使用 Node.js 编写的极简常驻服务（HTTP + IPv4 监测上报）。
  - 不依赖任何第三方 NPM 包，仅使用 Node 标准库。
- `install.sh`
  - 安装脚本：创建 systemd 服务、配置环境变量、启用并启动该 HTTP 服务。
- `uninstall.sh`
  - 卸载脚本：停用并删除 systemd 服务和配置，恢复系统到安装前状态（不删除你的 `changeip.sh` 和仓库代码）。

在服务器上，你需要自备一个可用的换 IP 脚本：

- `/root/changeip.sh`
  - 实际执行换 IP 的脚本，本项目默认假定它位于 `/root/changeip.sh`。
  - 该脚本 **不包含在仓库中**，由你自行维护。

安装完成后，对服务器产生的**持久影响**仅包括：

- 创建 systemd 单元：`/etc/systemd/system/changeip-http.service`
- 创建环境变量配置文件：`/etc/default/changeip-http`
- （启用监测上报时）创建状态目录：`/var/lib/changeip-http`（用于保存上次已上报 IPv4，卸载会删除）

卸载脚本会删除上述文件/目录并重新加载 systemd，确保**不留下任何系统级残留**。

> 仓库本身（即你 `git clone` 的目录）视为源码目录，由你自行决定是否删除。

---

## 2. 依赖与系统要求

目标环境：**Debian / Ubuntu 系** VPS，具有以下条件：

- （如果启用 `/changeip`）已存在且可手动执行的换 IP 脚本 `changeip.sh`：
  - 默认路径：`/root/changeip.sh`（可在安装时自定义）。
  - 使用 `root` 权限执行时应能成功完成换 IP。
- 安装了 Node.js（建议 16+，能运行普通 Node 脚本）。

如果你尚未安装 Node.js，可在 Debian / Ubuntu 上执行：

```bash
apt update
apt install -y nodejs
```

> 安装脚本 **不会自动安装 Node.js**，以避免对系统其他模块产生不可预期影响。如果需要，可以按上面命令手动安装。

---

## 3. HTTP 服务行为说明

`changeip_http_server.js` 行为简要说明：

- 监听地址：`0.0.0.0:<PORT>`（默认 `8787`）。
- 支持的接口：
  - `GET /`
    - 健康检查，返回：
      ```json
      { "ok": true, "service": "changeip-http" }
      ```
  - `POST /info`
    - 获取本机 `SERVER_LABEL` / `REPORT_CHANNEL` / 上次已记录的 IPv4（不触发换 IP）。
    - 请求头：`Content-Type: application/json`
    - 请求体示例：
      ```json
      { "token": "YOUR_SHARED_SECRET" }
      ```
    - 校验规则：
      - `token` 字段必须等于环境变量 `AUTH_TOKEN`。
      - 不满足则返回 `403`。
    - 返回示例：
      ```json
      {
        "ok": true,
        "server_label": "CMHK",
        "channel": "@your_channel",
        "changeip_enabled": true,
        "ip_monitor_enabled": true,
        "notified_ipv4": "1.2.3.4"
      }
      ```
    - 说明：
      - `ip_monitor_enabled` 只有在 **监测功能已开启** 且同时配置了 `IP_REPORT_ENDPOINT` / `IP_REPORT_TOKEN` 时才会为 `true`（即监测实际处于工作状态）。
  - `POST /changeip`
    - 仅当 `CHANGEIP_ENABLED=1` 时可用；否则返回 `403`。
    - 请求头：`Content-Type: application/json`
    - 请求体示例：
      ```json
      { "token": "YOUR_SHARED_SECRET" }
      ```
    - 校验规则：
      - `token` 字段必须等于环境变量 `AUTH_TOKEN`。
      - 不满足则返回 `403`。
    - 通过校验后：
      - 后台执行：`/bin/bash <CHANGEIP_SCRIPT>`
      - 立即安排系统重启：
        ```bash
        shutdown -r +<REBOOT_DELAY_MINUTES>
        ```
      - 返回：
        ```json
        {
          "ok": true,
          "message": "changeip started, reboot scheduled in <N> minutes",
          "server_label": "CMHK",
          "channel": "@your_channel",
          "old_ipv4": "1.2.3.4"
        }
        ```

所有行为均由以下环境变量控制（通过 `/etc/default/changeip-http` 配置）：

- `AUTH_TOKEN`：共享密钥，必须设置。用于认证来自 Telegram 机器人的请求。
- `CHANGEIP_SCRIPT`：`changeip.sh` 的绝对路径（默认 `/root/changeip.sh`）。
- `PORT`：HTTP 监听端口（默认 `8787`）。
- `REBOOT_DELAY_MINUTES`：调用 `changeip.sh` 后，几分钟后重启（默认 `16`，建议大于脚本内部的等待时间）。
- `CHANGEIP_ENABLED`：是否启用 `/changeip` 接口（`1` 启用，`0` 关闭）。

### 3.1 IPv4 监测与上报说明

当 `IP_MONITOR_ENABLED=1` 时，服务会定期获取公网 **IPv4**，若与“上次已成功上报的 IPv4”不同，则向 CarpoolNotifier 的内部接口上报一次（仅在变化时播报）。

注意：

- 为满足“只播报 IPv4”，本服务对公网 IP 获取与上报请求均强制使用 **IPv4 出站**（`family=4`）。
- 若你设置了 `IP_MONITOR_ENABLED=1`，但未配置 `IP_REPORT_ENDPOINT` 或 `IP_REPORT_TOKEN`，服务会在启动日志中提示并自动禁用监测；此时 `/info` 返回的 `ip_monitor_enabled` 也会为 `false`。

环境变量：

- `IP_MONITOR_ENABLED`：`1/0`，启用/关闭监测上报
- `IP_MONITOR_INTERVAL_SECONDS`：检测间隔秒数（默认 `60`）
- `IP_STATE_FILE`：状态文件路径（默认 `/var/lib/changeip-http/ip_state.json`）
- `IP_REPORT_ENDPOINT`：CarpoolNotifier 上报地址（例如 `https://<worker>/internal/ip-changed`）
- `IP_REPORT_TOKEN`：上报鉴权密钥（HTTP Header：`Authorization: Bearer <token>`）
- `SERVER_LABEL`：服务器标识（用于多服务器区分）
- `REPORT_CHANNEL`：播报频道（`@channel_username`）

---

## 4. 安装流程（推荐方式）

以下步骤假定你已经将本项目推送到 GitHub，并在 VPS 上使用 `root` 用户操作。

### 4.1 克隆仓库

```bash
cd /root
git clone https://github.com/<your-name>/ip-changer.git
cd ip-changer   # 仓库目录
```

> 替换 `https://github.com/<your-name>/ip-changer.git` 为你自己的仓库地址。

### 4.2 确认 `changeip.sh` 可用

确保你的 VPS 上存在脚本，并以 `root` 手动执行无误：

```bash
ls -l /root/changeip.sh
/bin/bash /root/changeip.sh
```

如路径不同，请记住其绝对路径，稍后安装脚本会询问。

> 说明：本项目通过 `/bin/bash <CHANGEIP_SCRIPT>` 执行脚本，因此脚本 **可执行位不是必须**；但如果你希望直接 `./changeip.sh` 运行，可以自行 `chmod +x`。

### 4.3 确认 Node.js 可用

```bash
node -v
```

如输出版本号（例如 `v18.x.x`）则表示可用；否则请安装：

```bash
apt update
apt install -y nodejs
```

### 4.4 运行安装脚本

赋予脚本可执行权限并运行：

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

安装脚本会进行以下操作：

1. 检查是否以 `root` 身份运行。
2. 检查 `node` 命令是否存在。
3. 询问配置项（有默认值）：
   - HTTP 端口（默认 `8787`）
   - 是否启用 `/changeip`（不支持脚本换 IP 的 VPS 可关闭）
   - 若启用 `/changeip`：
     - `changeip.sh` 路径（默认 `/root/changeip.sh`）
     - 重启延迟分钟数（默认 `16`）
   - 共享密钥 `AUTH_TOKEN`（留空则自动生成）
   - 服务器标识 `SERVER_LABEL`（用于多服务器区分）
   - 播报频道 `REPORT_CHANNEL`（例如 `@my_channel`，可留空）
   - 是否启用 IPv4 监测上报（建议开启以实现自动播报）
   - 若启用监测上报：
     - 上报地址 `IP_REPORT_ENDPOINT`（CarpoolNotifier 内部接口）
     - 上报密钥 `IP_REPORT_TOKEN`（留空则自动生成）
     - 检测间隔秒数（默认 `60`）
4. 创建环境配置文件：`/etc/default/changeip-http`
5. 创建 systemd 服务：`/etc/systemd/system/changeip-http.service`
6. 运行：
   - `systemctl daemon-reload`
   - `systemctl enable --now changeip-http`

安装成功后，你可以检查服务状态：

```bash
systemctl status changeip-http
```

以及监听端口：

```bash
ss -tlnp | grep 8787   # 如使用默认端口
```

### 4.5 手动验证 HTTP 服务

在 VPS 上本机访问：

```bash
curl http://127.0.0.1:8787/
```

应返回：

```json
{"ok":true,"service":"changeip-http"}
```

如需测试 `/info`（将 `<YOUR_TOKEN>` 替换为安装时显示/设置的 `AUTH_TOKEN`）：

```bash
curl -X POST "http://127.0.0.1:8787/info" -H "Content-Type: application/json" -d '{"token":"<YOUR_TOKEN>"}'
```

如果你启用了 `/changeip`，再测试 `/changeip` 接口（将 `<YOUR_TOKEN>` 替换为安装时显示/设置的 `AUTH_TOKEN`）：

```bash
curl -X POST "http://127.0.0.1:8787/changeip" \
  -H "Content-Type: application/json" \
  -d '{"token":"<YOUR_TOKEN>"}'
```

看到 `ok: true` 且提示即将重启，即代表服务工作正常（注意这会触发实际的换 IP + 重启逻辑，请谨慎测试）。

---

## 5. 卸载流程（完全移除系统改动）

当你不再需要该服务时，可以通过卸载脚本**完全移除所有系统级改动**：

```bash
cd /root/ip-changer   # 或你的仓库目录
./uninstall.sh
```

卸载脚本执行的操作：

1. `systemctl stop changeip-http`（停止服务，忽略失败）
2. `systemctl disable changeip-http`（取消开机自启）
3. 删除 systemd 单元文件：`/etc/systemd/system/changeip-http.service`
4. 删除环境配置文件：`/etc/default/changeip-http`
5. 删除状态目录：`/var/lib/changeip-http`
6. `systemctl daemon-reload`

卸载后系统中不再有任何与本项目相关的 systemd 配置或环境文件，**不会影响其他模块的正常运行**。

若你希望连源码一并删除，只需手动：

```bash
rm -rf /root/ip-changer
```

---

## 6. 与 Telegram 机器人（CarpoolNotifier）对接

CarpoolNotifier 机器人在触发换 IP 时会调用本服务的 `/changeip` 接口，整体流程如下：

1. 在 VPS 上按本 README 安装并启动本服务。
2. 记住以下两项配置：
   - `AUTH_TOKEN`：安装时设置或自动生成的值。
   - `PORT`：HTTP 端口（默认 `8787`）。
3. 在 CarpoolNotifier 的运行环境中配置以下环境变量：
   - `CHANGEIP_ENDPOINT`：
     - 例如：`http://<VPS_IP>:8787/changeip`
     - 如果 CarpoolNotifier 与本服务部署在同一台 VPS，可使用 `http://127.0.0.1:8787/changeip`
   - `CHANGEIP_TOKEN`：
     - 与上一步中的 `AUTH_TOKEN` 完全一致。
4. 重新部署 / 启动 CarpoolNotifier，使其读取新的环境变量。
5. 用管理员账号向 Telegram 机器人发送 `/changeip`：
   - 机器人会校验你是否管理员。
   - 向 `CHANGEIP_ENDPOINT` 发送带 `CHANGEIP_TOKEN` 的 POST 请求。
   - 通过后提示“已收到更换 IP 请求……约 15 分钟后自动重启”。
   - VPS 后台执行 `changeip.sh` 并在设定时间后重启。

> 说明：机器人也可以调用本服务的 `/info` 获取 `server_label` / `channel` / `notified_ipv4`，用于在频道内提前发布“即将换 IP”预告，并在同一条消息中持续更新进度。

> 安全建议：
> - 尽量只在内网或受控网络中开放该端口（如通过防火墙限制来源 IP）。
> - `AUTH_TOKEN` 要足够随机且保密，只在 CarpoolNotifier 环境变量和安装日志（你自己留存）中使用。

### 6.1 IPv4 自动播报对接

`ip-changer` 会向 CarpoolNotifier 的内部接口上报 IPv4 变化，因此你需要在 Cloudflare Worker 中配置密钥：

- `IP_REPORT_TOKEN`（secret）：与 VPS 上 `IP_REPORT_TOKEN` 完全一致

并确保 Worker 中已实现内部路由：

- `POST /internal/ip-changed`（鉴权：`Authorization: Bearer <IP_REPORT_TOKEN>`）

随后，当 VPS 公网 IPv4 发生变化时，CarpoolNotifier 会自动播报到 `REPORT_CHANNEL`（以及管理员）。

---

## 7. 更新与维护

### 7.1 更新代码

当你在 GitHub 上更新了此项目后，在 VPS 上执行：

```bash
cd /root/ip-changer   # 或你的仓库目录
git pull
systemctl restart changeip-http
```

即可让新版本生效。无需重新运行 `install.sh`，除非你想修改端口、脚本路径等基础配置。

### 7.2 修改配置

- 编辑 `/etc/default/changeip-http`，修改任意环境变量：
  - `AUTH_TOKEN`
  - `PORT`
  - `CHANGEIP_ENABLED`
  - `CHANGEIP_SCRIPT`
  - `REBOOT_DELAY_MINUTES`
  - `IP_MONITOR_ENABLED`
  - `IP_MONITOR_INTERVAL_SECONDS`
  - `IP_REPORT_ENDPOINT`
  - `IP_REPORT_TOKEN`
  - `SERVER_LABEL`
  - `REPORT_CHANNEL`
- 然后重启服务：

```bash
systemctl restart changeip-http
```

如果你修改了 `AUTH_TOKEN`，记得同步更新 CarpoolNotifier 的 `CHANGEIP_TOKEN`。

---

## 8. 常见问题

- **Q: 安装脚本会不会影响系统其它服务？**  
  A: 除创建一个 systemd 服务和一个环境配置文件外，不会更改任何系统配置，也不会安装/卸载系统包。卸载脚本会删除这两项，恢复到安装前状态。

- **Q: 可以不用 systemd，直接前台运行吗？**  
  A: 可以。在仓库目录直接运行：
  ```bash
  AUTH_TOKEN=... PORT=8787 CHANGEIP_ENABLED=1 CHANGEIP_SCRIPT=/root/changeip.sh REBOOT_DELAY_MINUTES=16 \
  IP_MONITOR_ENABLED=1 IP_REPORT_ENDPOINT=... IP_REPORT_TOKEN=... SERVER_LABEL=... REPORT_CHANNEL=@... \
  node changeip_http_server.js
  ```
  即可启动服务，但不具备开机自启与守护功能。

- **Q: CarpoolNotifier 必须部署在 VPS 上吗？**  
  A: 不需要。CarpoolNotifier 可以继续部署在 Cloudflare Worker 上，只要它能访问你的 VPS HTTP 端口即可（你需要在防火墙或安全组中允许来自相应 IP 的访问）。
