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

read -rp "是否启用一键换 IP 接口 /changeip? [Y/n]: " CHANGEIP_ENABLED_INPUT
CHANGEIP_ENABLED_INPUT="${CHANGEIP_ENABLED_INPUT:-Y}"
CHANGEIP_ENABLED=1
case "$(echo "$CHANGEIP_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
  n|no|0) CHANGEIP_ENABLED=0 ;;
esac

CHANGEIP_SCRIPT=""
REBOOT_DELAY_MINUTES=""
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  read -rp "changeip.sh 脚本绝对路径 [默认 /root/changeip.sh]: " CHANGEIP_SCRIPT
  CHANGEIP_SCRIPT="${CHANGEIP_SCRIPT:-/root/changeip.sh}"

  read -rp "重启延迟（分钟）[默认 16]: " REBOOT_DELAY_MINUTES
  REBOOT_DELAY_MINUTES="${REBOOT_DELAY_MINUTES:-16}"
fi

read -rp "共享密钥 AUTH_TOKEN（留空则自动生成）: " AUTH_TOKEN
if [ -z "$AUTH_TOKEN" ]; then
  if command -v openssl >/dev/null 2>&1; then
    AUTH_TOKEN="$(openssl rand -base64 32 | tr -d '=+/')"
  else
    AUTH_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
  fi
  echo "已自动生成 AUTH_TOKEN：$AUTH_TOKEN"
fi

DEFAULT_LABEL="$(hostname 2>/dev/null || echo "SERVER")"
read -rp "服务器标识（用于多服务器区分）[默认 $DEFAULT_LABEL]: " SERVER_LABEL
SERVER_LABEL="${SERVER_LABEL:-$DEFAULT_LABEL}"

read -rp "播报频道 @用户名（例如 @my_channel，可留空）: " REPORT_CHANNEL

read -rp "是否启用公网 IPv4 变化监测并上报到 CarpoolNotifier? [Y/n]: " IP_MONITOR_ENABLED_INPUT
IP_MONITOR_ENABLED_INPUT="${IP_MONITOR_ENABLED_INPUT:-Y}"
IP_MONITOR_ENABLED=1
case "$(echo "$IP_MONITOR_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
  n|no|0) IP_MONITOR_ENABLED=0 ;;
esac

IP_REPORT_ENDPOINT=""
IP_REPORT_TOKEN=""
IP_MONITOR_INTERVAL_SECONDS=""
IP_STATE_FILE="/var/lib/changeip-http/ip_state.json"

if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
  read -rp "CarpoolNotifier 上报地址（例如 https://<worker>/internal/ip-changed）: " IP_REPORT_ENDPOINT

  read -rp "上报密钥 IP_REPORT_TOKEN（留空则自动生成）: " IP_REPORT_TOKEN
  if [ -z "$IP_REPORT_TOKEN" ]; then
    if command -v openssl >/dev/null 2>&1; then
      IP_REPORT_TOKEN="$(openssl rand -base64 32 | tr -d '=+/')"
    else
      IP_REPORT_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
    fi
    echo "已自动生成 IP_REPORT_TOKEN：$IP_REPORT_TOKEN"
  fi

  read -rp "监测间隔（秒）[默认 60]: " IP_MONITOR_INTERVAL_SECONDS
  IP_MONITOR_INTERVAL_SECONDS="${IP_MONITOR_INTERVAL_SECONDS:-60}"
fi

ENV_FILE="/etc/default/changeip-http"
SERVICE_FILE="/etc/systemd/system/changeip-http.service"

echo "写入配置到 $ENV_FILE ..."
cat >"$ENV_FILE" <<EOF
AUTH_TOKEN=$AUTH_TOKEN
PORT=$PORT
CHANGEIP_ENABLED=$CHANGEIP_ENABLED
SERVER_LABEL=$SERVER_LABEL
REPORT_CHANNEL=$REPORT_CHANNEL
NODE_ENV=production
EOF

if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  cat >>"$ENV_FILE" <<EOF
CHANGEIP_SCRIPT=$CHANGEIP_SCRIPT
REBOOT_DELAY_MINUTES=$REBOOT_DELAY_MINUTES
EOF
fi

if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
  mkdir -p "$(dirname "$IP_STATE_FILE")"
  chmod 700 "$(dirname "$IP_STATE_FILE")" || true
  cat >>"$ENV_FILE" <<EOF
IP_MONITOR_ENABLED=1
IP_MONITOR_INTERVAL_SECONDS=$IP_MONITOR_INTERVAL_SECONDS
IP_STATE_FILE=$IP_STATE_FILE
IP_REPORT_ENDPOINT=$IP_REPORT_ENDPOINT
IP_REPORT_TOKEN=$IP_REPORT_TOKEN
EOF
fi

chmod 600 "$ENV_FILE" || true

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
echo "AUTH_TOKEN: $AUTH_TOKEN"
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "已启用 /changeip"
  echo "changeip.sh 路径: $CHANGEIP_SCRIPT"
  echo "重启延迟: $REBOOT_DELAY_MINUTES 分钟"
else
  echo "未启用 /changeip"
fi
if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
  echo "已启用 IPv4 监测上报"
  echo "SERVER_LABEL: $SERVER_LABEL"
  echo "REPORT_CHANNEL: $REPORT_CHANNEL"
  echo "IP_REPORT_ENDPOINT: $IP_REPORT_ENDPOINT"
  echo "IP_REPORT_TOKEN: $IP_REPORT_TOKEN"
else
  echo "未启用 IPv4 监测上报"
fi
echo
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "请在 Telegram 机器人所在环境中配置："
  echo "  CHANGEIP_ENDPOINT=http://<VPS_IP>:$PORT/changeip"
  echo "  CHANGEIP_TOKEN=$AUTH_TOKEN"
fi
if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
  echo "请在 CarpoolNotifier（Cloudflare Worker）中配置密钥："
  echo "  wrangler secret put IP_REPORT_TOKEN"
  echo "并填入上面的 IP_REPORT_TOKEN"
fi
