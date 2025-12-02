#!/bin/bash

set -e

if [ "$EUID" -ne 0 ]; then
  echo "请以 root 身份运行此脚本（sudo ./install.sh）"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node 命令，请先安装 Node.js（例如：apt install -y nodejs）后再运行本脚本。"
  exit 1
fi

echo "=== IPChanger HTTP 服务安装 ==="

read -rp "HTTP 监听端口 [默认 8787]: " PORT
PORT="${PORT:-8787}"

read -rp "changeip.sh 脚本绝对路径 [默认 /changeip.sh]: " CHANGEIP_SCRIPT
CHANGEIP_SCRIPT="${CHANGEIP_SCRIPT:-/changeip.sh}"

read -rp "重启延迟（分钟）[默认 16]: " REBOOT_DELAY_MINUTES
REBOOT_DELAY_MINUTES="${REBOOT_DELAY_MINUTES:-16}"

read -rp "共享密钥 AUTH_TOKEN（留空则自动生成）: " AUTH_TOKEN
if [ -z "$AUTH_TOKEN" ]; then
  if command -v openssl >/dev/null 2>&1; then
    AUTH_TOKEN="$(openssl rand -base64 32 | tr -d '=+/')"
  else
    AUTH_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
  fi
  echo "已自动生成 AUTH_TOKEN：$AUTH_TOKEN"
fi

ENV_FILE="/etc/default/changeip-http"
SERVICE_FILE="/etc/systemd/system/changeip-http.service"

echo "写入配置到 $ENV_FILE ..."
cat >"$ENV_FILE" <<EOF
AUTH_TOKEN=$AUTH_TOKEN
CHANGEIP_SCRIPT=$CHANGEIP_SCRIPT
PORT=$PORT
REBOOT_DELAY_MINUTES=$REBOOT_DELAY_MINUTES
NODE_ENV=production
EOF

echo "创建 systemd 服务到 $SERVICE_FILE ..."
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=HTTP trigger for changeip.sh
After=network.target

[Service]
Type=simple
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/changeip_http_server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "重新加载 systemd ..."
systemctl daemon-reload

echo "启用并立即启动 changeip-http 服务 ..."
systemctl enable --now changeip-http

echo "=== 安装完成 ==="
echo "服务名: changeip-http"
echo "监听端口: $PORT"
echo "changeip.sh 路径: $CHANGEIP_SCRIPT"
echo "AUTH_TOKEN: $AUTH_TOKEN"
echo
echo "请在 Telegram 机器人所在环境中配置："
echo "  CHANGEIP_ENDPOINT=http://<VPS_IP>:$PORT/changeip"
echo "  CHANGEIP_TOKEN=$AUTH_TOKEN"

