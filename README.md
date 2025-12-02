# IPChanger HTTP Trigger for Telegram Bot

一个极简的 HTTP 服务，用于在 Debian VPS 上通过 Telegram 机器人一键执行 `changeip.sh` 并安排自动重启，从而更换服务器公网 IP。

本项目只负责：

- 在 VPS 上监听一个本地 HTTP 接口（默认 `0.0.0.0:8787`）。
- 接收到带有共享密钥的请求后：
  - 后台执行 `changeip.sh`（你已有的换 IP 脚本）。
  - 调用 `shutdown -r +N` 安排若干分钟后自动重启。

你现有的 Telegram 机器人（例如 CarpoolNotifier）只需要在收到 `/changeip` 指令后，向该 HTTP 接口发一个带密钥的 POST 请求即可。

---

## 1. 文件结构与运行方式

本仓库包含以下主要文件：

- `changeip.sh`
  - 你已有的换 IP 脚本。默认假定它位于 VPS 根目录 `/changeip.sh`。
  - 内容示例（仅供参考）：先 `ifdown` 网卡、等待 900 秒，再 `ifup` 获取新 IP。
- `changeip_http_server.js`
  - 使用 Node.js 编写的极简 HTTP 服务。
  - 监听一个端口，接受 `POST /changeip` 请求，校验密钥后后台执行 `changeip.sh` 和系统重启。
  - 不依赖任何第三方 NPM 包，仅使用 Node 标准库（`http`、`child_process`）。
- `install.sh`
  - 安装脚本：创建 systemd 服务、配置环境变量、启用并启动该 HTTP 服务。
- `uninstall.sh`
  - 卸载脚本：停用并删除 systemd 服务和配置，恢复系统到安装前状态（不删除你的 `changeip.sh` 和仓库代码）。

安装完成后，对服务器产生的**持久影响**仅包括：

- 创建 systemd 单元：`/etc/systemd/system/changeip-http.service`
- 创建环境变量配置文件：`/etc/default/changeip-http`

卸载脚本会删除上述两个文件并重新加载 systemd，确保**不留下任何系统级残留**。

> 仓库本身（即你 `git clone` 的目录）视为源码目录，由你自行决定是否删除。

---

## 2. 依赖与系统要求

目标环境：**Debian / Ubuntu 系** VPS，具有以下条件：

- 已存在且可手动执行的换 IP 脚本 `changeip.sh`：
  - 默认路径：`/changeip.sh`（可在安装时自定义）。
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
  - `POST /changeip`
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
          "message": "changeip started, reboot scheduled in <N> minutes"
        }
        ```

所有行为均由以下环境变量控制（通过 `/etc/default/changeip-http` 配置）：

- `AUTH_TOKEN`：共享密钥，必须设置。用于认证来自 Telegram 机器人的请求。
- `CHANGEIP_SCRIPT`：`changeip.sh` 的绝对路径（默认 `/changeip.sh`）。
- `PORT`：HTTP 监听端口（默认 `8787`）。
- `REBOOT_DELAY_MINUTES`：调用 `changeip.sh` 后，几分钟后重启（默认 `16`，建议大于脚本内部的等待时间）。

---

## 4. 安装流程（推荐方式）

以下步骤假定你已经将本项目推送到 GitHub，并在 VPS 上使用 `root` 用户操作。

### 4.1 克隆仓库

```bash
cd /root
git clone https://github.com/<your-name>/ipchanger-http.git
cd ipchanger-http   # 或者你的仓库目录名
```

> 替换 `https://github.com/<your-name>/ipchanger-http.git` 为你自己的仓库地址。

### 4.2 确认 `changeip.sh` 可用

确保你的 VPS 上存在脚本，并以 `root` 手动执行无误：

```bash
ls /changeip.sh
chmod +x /changeip.sh
/bin/bash /changeip.sh
```

如路径不同，请记住其绝对路径，稍后安装脚本会询问。

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
   - `changeip.sh` 路径（默认 `/changeip.sh`）
   - 重启延迟分钟数（默认 `16`）
   - 共享密钥 `AUTH_TOKEN`：
     - 如果留空，则自动生成一个高随机度的字符串并保存。
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

然后测试 `/changeip` 接口（将 `<YOUR_TOKEN>` 替换为安装时显示/设置的 `AUTH_TOKEN`）：

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
cd /root/ipchanger-http   # 或你的仓库目录
./uninstall.sh
```

卸载脚本执行的操作：

1. `systemctl stop changeip-http`（停止服务，忽略失败）
2. `systemctl disable changeip-http`（取消开机自启）
3. 删除 systemd 单元文件：`/etc/systemd/system/changeip-http.service`
4. 删除环境配置文件：`/etc/default/changeip-http`
5. `systemctl daemon-reload`

卸载后系统中不再有任何与本项目相关的 systemd 配置或环境文件，**不会影响其他模块的正常运行**。

若你希望连源码一并删除，只需手动：

```bash
rm -rf /root/ipchanger-http
```

---

## 6. 与 Telegram 机器人（CarpoolNotifier）对接

你已有的 CarpoolNotifier 机器人可以通过新增 `/changeip` 管理员命令来调用此 HTTP 服务（该命令的示例实现已经在原项目中添加，不再赘述），整体流程如下：

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

> 安全建议：
> - 尽量只在内网或受控网络中开放该端口（如通过防火墙限制来源 IP）。
> - `AUTH_TOKEN` 要足够随机且保密，只在 CarpoolNotifier 环境变量和安装日志（你自己留存）中使用。

---

## 7. 更新与维护

### 7.1 更新代码

当你在 GitHub 上更新了此项目后，在 VPS 上执行：

```bash
cd /root/ipchanger-http   # 或你的仓库目录
git pull
systemctl restart changeip-http
```

即可让新版本生效。无需重新运行 `install.sh`，除非你想修改端口、脚本路径等基础配置。

### 7.2 修改配置

- 编辑 `/etc/default/changeip-http`，修改任意环境变量：
  - `AUTH_TOKEN`
  - `CHANGEIP_SCRIPT`
  - `PORT`
  - `REBOOT_DELAY_MINUTES`
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
  AUTH_TOKEN=... CHANGEIP_SCRIPT=/changeip.sh PORT=8787 REBOOT_DELAY_MINUTES=16 \
    node changeip_http_server.js
  ```
  即可启动服务，但不具备开机自启与守护功能。

- **Q: CarpoolNotifier 必须部署在 VPS 上吗？**  
  A: 不需要。CarpoolNotifier 可以继续部署在 Cloudflare Worker 上，只要它能访问你的 VPS HTTP 端口即可（你需要在防火墙或安全组中允许来自相应 IP 的访问）。

