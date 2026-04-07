#!/bin/bash

set -e

umask 077

prompt_int() {
  local prompt="$1"
  local default="$2"
  local min="$3"
  local max="$4"
  local value=""

  while true; do
    read -rp "$prompt [默认 $default]: " value
    value="${value:-$default}"
    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge "$min" ] && [ "$value" -le "$max" ]; then
      printf '%s' "$value"
      return 0
    fi
    echo "输入无效，请输入 $min-$max 之间的数字。"
  done
}

prompt_int_or_neg1() {
  local prompt="$1"
  local default="$2"
  local min="$3"
  local max="$4"
  local value=""

  while true; do
    read -rp "$prompt [默认 $default]: " value
    value="${value:-$default}"
    if [ "$value" = "-1" ]; then
      printf '%s' "$value"
      return 0
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge "$min" ] && [ "$value" -le "$max" ]; then
      printf '%s' "$value"
      return 0
    fi
    echo "输入无效，请输入 -1（不重启）或 $min-$max 之间的数字。"
  done
}

env_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

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

PORT="$(prompt_int "HTTP 监听端口" "8787" "1" "65535")"

read -rp "是否启用一键换 IP 接口 /changeip? [y/N]: " CHANGEIP_ENABLED_INPUT
CHANGEIP_ENABLED_INPUT="${CHANGEIP_ENABLED_INPUT:-N}"
CHANGEIP_ENABLED=0
case "$(echo "$CHANGEIP_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
  y|yes|1) CHANGEIP_ENABLED=1 ;;
esac

CHANGEIP_PROVIDER=""
CHANGEIP_SCRIPT=""
CHANGEIP_EXEC_COMMAND=""
CHANGEIP_HTTP_FLOW_FILE=""
REBOOT_DELAY_MINUTES=""
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  while true; do
    read -rp "请选择 /changeip provider（script/exec/http_flow）: " CHANGEIP_PROVIDER
    CHANGEIP_PROVIDER="$(echo "${CHANGEIP_PROVIDER:-}" | tr '[:upper:]' '[:lower:]')"
    case "$CHANGEIP_PROVIDER" in
      script|exec|http_flow) break ;;
      *) echo "输入无效，请输入 script / exec / http_flow。" ;;
    esac
  done

  case "$CHANGEIP_PROVIDER" in
    script)
      read -rp "changeip.sh 脚本绝对路径 [默认 /root/changeip.sh]: " CHANGEIP_SCRIPT
      CHANGEIP_SCRIPT="${CHANGEIP_SCRIPT:-/root/changeip.sh}"

      if [ ! -f "$CHANGEIP_SCRIPT" ]; then
        echo "警告：未找到脚本文件：$CHANGEIP_SCRIPT"
        echo "你仍然可以继续安装，但 /changeip 将在脚本存在之前返回 500。"
      fi
      ;;
    exec)
      while [ -z "$CHANGEIP_EXEC_COMMAND" ]; do
        read -rp "请输入 exec 命令（例如 python3 /root/xxx.py）: " CHANGEIP_EXEC_COMMAND
        CHANGEIP_EXEC_COMMAND="${CHANGEIP_EXEC_COMMAND:-}"
        if [ -z "$CHANGEIP_EXEC_COMMAND" ]; then
          echo "exec 命令不能为空。"
        fi
      done
      ;;
    http_flow)
      while [ -z "$CHANGEIP_HTTP_FLOW_FILE" ]; do
        read -rp "请输入 http_flow JSON 文件绝对路径: " CHANGEIP_HTTP_FLOW_FILE
        CHANGEIP_HTTP_FLOW_FILE="${CHANGEIP_HTTP_FLOW_FILE:-}"
        if [ -z "$CHANGEIP_HTTP_FLOW_FILE" ]; then
          echo "http_flow 文件路径不能为空。"
        fi
      done
      if [ ! -f "$CHANGEIP_HTTP_FLOW_FILE" ]; then
        echo "警告：未找到 http_flow 文件：$CHANGEIP_HTTP_FLOW_FILE"
        echo "你仍然可以继续安装，但 /changeip 会在文件存在且内容合法前返回 500。"
      fi
      ;;
  esac

  REBOOT_DELAY_MINUTES="$(prompt_int_or_neg1 "重启延迟（分钟，-1 表示不重启）" "1" "1" "15")"
fi

read -rp "入站鉴权密钥 AUTH_TOKEN（留空则自动生成）: " AUTH_TOKEN
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

read -rp "播报目标（@channel 或 -100... chat_id；留空=禁用频道播报）: " REPORT_CHANNEL

IP_EVENTS_ENABLED=1
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "提示：/changeip 依赖事件流上报，已自动启用 IP_EVENTS_ENABLED=1。"
else
  read -rp "是否启用事件流上报到 CarpoolNotifier（/internal/ip-events）? [Y/n]: " IP_EVENTS_ENABLED_INPUT
  IP_EVENTS_ENABLED_INPUT="${IP_EVENTS_ENABLED_INPUT:-Y}"
  case "$(echo "$IP_EVENTS_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
    n|no|0) IP_EVENTS_ENABLED=0 ;;
  esac
fi

IP_EVENTS_ENDPOINT=""
IP_EVENTS_TOKEN=""
if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  while [ -z "$IP_EVENTS_ENDPOINT" ]; do
    read -rp "CarpoolNotifier 事件流上报地址（例如 https://<worker>/internal/ip-events）: " IP_EVENTS_ENDPOINT
    IP_EVENTS_ENDPOINT="${IP_EVENTS_ENDPOINT:-}"
    if [ -z "$IP_EVENTS_ENDPOINT" ]; then
      echo "上报地址不能为空。若暂时不需要对接 CarpoolNotifier，请选择关闭事件流上报。"
    fi
  done

  read -rp "上报密钥 IP_EVENTS_TOKEN（留空则自动生成）: " IP_EVENTS_TOKEN
  if [ -z "$IP_EVENTS_TOKEN" ]; then
    if command -v openssl >/dev/null 2>&1; then
      IP_EVENTS_TOKEN="$(openssl rand -base64 32 | tr -d '=+/')"
    else
      IP_EVENTS_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
    fi
    echo "已自动生成 IP_EVENTS_TOKEN：$IP_EVENTS_TOKEN"
  fi
fi

if [ "$CHANGEIP_ENABLED" -eq 1 ] && [ "$IP_EVENTS_ENABLED" -ne 1 ]; then
  echo "错误：/changeip 需要事件流上报（IP_EVENTS_ENABLED=1），否则机器人无法可靠收敛会话。"
  exit 1
fi

IP_MONITOR_ENABLED=0
IPV6_MONITOR_ENABLED=0
IP_MONITOR_INTERVAL_SECONDS=""

if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  read -rp "是否启用公网 IPv4 变化监测并上报到 CarpoolNotifier? [Y/n]: " IP_MONITOR_ENABLED_INPUT
  IP_MONITOR_ENABLED_INPUT="${IP_MONITOR_ENABLED_INPUT:-Y}"
  IP_MONITOR_ENABLED=1
  case "$(echo "$IP_MONITOR_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
    n|no|0) IP_MONITOR_ENABLED=0 ;;
  esac

  read -rp "是否启用公网 IPv6 变化监测并上报到 CarpoolNotifier? [y/N]: " IPV6_MONITOR_ENABLED_INPUT
  IPV6_MONITOR_ENABLED_INPUT="${IPV6_MONITOR_ENABLED_INPUT:-N}"
  IPV6_MONITOR_ENABLED=0
  case "$(echo "$IPV6_MONITOR_ENABLED_INPUT" | tr '[:upper:]' '[:lower:]')" in
    y|yes|1) IPV6_MONITOR_ENABLED=1 ;;
  esac
else
  echo "提示：未启用事件流上报（IP_EVENTS_ENABLED=0），IPv4/IPv6 监测上报已自动禁用。"
fi

IP_STATE_FILE="/var/lib/changeip-http/ip_state.json"

if [ "$IP_MONITOR_ENABLED" -eq 1 ] || [ "$IPV6_MONITOR_ENABLED" -eq 1 ]; then
  IP_MONITOR_INTERVAL_SECONDS="$(prompt_int "IPv4/IPv6 监测间隔（秒）" "60" "10" "86400")"
fi

ENV_FILE="/etc/default/changeip-http"
SERVICE_FILE="/etc/systemd/system/changeip-http.service"

echo
echo "=== 安装前配置预览 ==="
echo "PORT: $PORT"
echo "AUTH_TOKEN: 已设置（长度 ${#AUTH_TOKEN}）"
echo "SERVER_LABEL: $SERVER_LABEL"
echo "REPORT_CHANNEL: ${REPORT_CHANNEL:-<empty>}"
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "CHANGEIP_ENABLED: 1"
  echo "CHANGEIP_PROVIDER: $CHANGEIP_PROVIDER"
  case "$CHANGEIP_PROVIDER" in
    script)
      echo "CHANGEIP_SCRIPT: $CHANGEIP_SCRIPT"
      ;;
    exec)
      echo "CHANGEIP_EXEC_COMMAND: 已配置"
      ;;
    http_flow)
      echo "CHANGEIP_HTTP_FLOW_FILE: $CHANGEIP_HTTP_FLOW_FILE"
      ;;
  esac
  echo "REBOOT_DELAY_MINUTES: $REBOOT_DELAY_MINUTES"
else
  echo "CHANGEIP_ENABLED: 0"
fi
if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  echo "IP_EVENTS_ENABLED: 1"
  echo "IP_EVENTS_ENDPOINT: $IP_EVENTS_ENDPOINT"
  echo "IP_EVENTS_TOKEN: 已设置（长度 ${#IP_EVENTS_TOKEN}）"
else
  echo "IP_EVENTS_ENABLED: 0"
fi
if [ "$IP_EVENTS_ENABLED" -ne 1 ]; then
  echo "IP_MONITOR_ENABLED: 0（未启用 ip-events，上报/监测不可用）"
  echo "IPV6_MONITOR_ENABLED: 0（未启用 ip-events，上报/监测不可用）"
else
  echo "IP_MONITOR_ENABLED: $IP_MONITOR_ENABLED"
  echo "IPV6_MONITOR_ENABLED: $IPV6_MONITOR_ENABLED"
  if [ "$IP_MONITOR_ENABLED" -eq 1 ] || [ "$IPV6_MONITOR_ENABLED" -eq 1 ]; then
    echo "IP_MONITOR_INTERVAL_SECONDS: $IP_MONITOR_INTERVAL_SECONDS"
  fi
fi
echo
read -rp "确认写入配置并重启服务? [Y/n]: " INSTALL_CONFIRM_INPUT
INSTALL_CONFIRM_INPUT="${INSTALL_CONFIRM_INPUT:-Y}"
case "$(echo "$INSTALL_CONFIRM_INPUT" | tr '[:upper:]' '[:lower:]')" in
  n|no|0)
    echo "已取消安装，未写入任何文件。"
    exit 0
    ;;
esac

echo "写入配置到 $ENV_FILE ..."
{
  printf 'AUTH_TOKEN=%s\n' "$(env_quote "$AUTH_TOKEN")"
  printf 'PORT=%s\n' "$(env_quote "$PORT")"
  printf 'CHANGEIP_ENABLED=%s\n' "$(env_quote "$CHANGEIP_ENABLED")"
  printf 'SERVER_LABEL=%s\n' "$(env_quote "$SERVER_LABEL")"
  printf 'REPORT_CHANNEL=%s\n' "$(env_quote "$REPORT_CHANNEL")"
  printf 'NODE_ENV=%s\n' "$(env_quote "production")"
} >"$ENV_FILE"

if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  {
    printf 'CHANGEIP_PROVIDER=%s\n' "$(env_quote "$CHANGEIP_PROVIDER")"
    printf 'REBOOT_DELAY_MINUTES=%s\n' "$(env_quote "$REBOOT_DELAY_MINUTES")"
  } >>"$ENV_FILE"

  case "$CHANGEIP_PROVIDER" in
    script)
      printf 'CHANGEIP_SCRIPT=%s\n' "$(env_quote "$CHANGEIP_SCRIPT")" >>"$ENV_FILE"
      ;;
    exec)
      printf 'CHANGEIP_EXEC_COMMAND=%s\n' "$(env_quote "$CHANGEIP_EXEC_COMMAND")" >>"$ENV_FILE"
      ;;
    http_flow)
      printf 'CHANGEIP_HTTP_FLOW_FILE=%s\n' "$(env_quote "$CHANGEIP_HTTP_FLOW_FILE")" >>"$ENV_FILE"
      ;;
  esac
fi

if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  {
    printf 'IP_EVENTS_ENABLED=%s\n' "$(env_quote "1")"
    printf 'IP_EVENTS_ENDPOINT=%s\n' "$(env_quote "$IP_EVENTS_ENDPOINT")"
    printf 'IP_EVENTS_TOKEN=%s\n' "$(env_quote "$IP_EVENTS_TOKEN")"
  } >>"$ENV_FILE"
fi

if [ "$IP_MONITOR_ENABLED" -eq 1 ] || [ "$IPV6_MONITOR_ENABLED" -eq 1 ]; then
  mkdir -p "$(dirname "$IP_STATE_FILE")"
  chmod 700 "$(dirname "$IP_STATE_FILE")" || true
  {
    printf 'IP_MONITOR_INTERVAL_SECONDS=%s\n' "$(env_quote "$IP_MONITOR_INTERVAL_SECONDS")"
    printf 'IP_STATE_FILE=%s\n' "$(env_quote "$IP_STATE_FILE")"
  } >>"$ENV_FILE"
fi

if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
  {
    printf 'IP_MONITOR_ENABLED=%s\n' "$(env_quote "1")"
  } >>"$ENV_FILE"
fi

if [ "$IPV6_MONITOR_ENABLED" -eq 1 ]; then
  {
    printf 'IPV6_MONITOR_ENABLED=%s\n' "$(env_quote "1")"
  } >>"$ENV_FILE"
fi

chmod 600 "$ENV_FILE" || true

echo "创建 systemd 服务到 $SERVICE_FILE ..."
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=HTTP trigger for changeip providers
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

echo "启用并启动/重启 changeip-http 服务 ..."
systemctl enable changeip-http
systemctl restart changeip-http

echo "=== 安装完成 ==="
echo "服务名: changeip-http"
echo "监听端口: $PORT"
echo "AUTH_TOKEN: $AUTH_TOKEN"
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "已启用 /changeip"
  echo "CHANGEIP_PROVIDER: $CHANGEIP_PROVIDER"
  case "$CHANGEIP_PROVIDER" in
    script)
      echo "changeip.sh 路径: $CHANGEIP_SCRIPT"
      ;;
    exec)
      echo "exec 命令: 已配置（出于安全考虑不在此回显）"
      ;;
    http_flow)
      echo "http_flow 文件: $CHANGEIP_HTTP_FLOW_FILE"
      ;;
  esac
  if [ "$REBOOT_DELAY_MINUTES" = "-1" ]; then
    echo "重启: 已禁用（REBOOT_DELAY_MINUTES=-1）"
  else
    echo "重启延迟: $REBOOT_DELAY_MINUTES 分钟"
  fi
else
  echo "未启用 /changeip"
fi
if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  echo "已启用 ip-events 上报"
  echo "SERVER_LABEL: $SERVER_LABEL"
  echo "REPORT_CHANNEL: $REPORT_CHANNEL"
  echo "IP_EVENTS_ENDPOINT: $IP_EVENTS_ENDPOINT"
  echo "IP_EVENTS_TOKEN: $IP_EVENTS_TOKEN"
  if [ "$IP_MONITOR_ENABLED" -eq 1 ]; then
    echo "已启用 IPv4 变化监测（仅在变化时上报）"
    echo "IP_MONITOR_INTERVAL_SECONDS: $IP_MONITOR_INTERVAL_SECONDS"
  else
    echo "未启用 IPv4 变化监测"
  fi
  if [ "$IPV6_MONITOR_ENABLED" -eq 1 ]; then
    echo "已启用 IPv6 变化监测（仅在变化时上报）"
    echo "IPV6 监测间隔复用 IP_MONITOR_INTERVAL_SECONDS: $IP_MONITOR_INTERVAL_SECONDS"
  else
    echo "未启用 IPv6 变化监测"
  fi
else
  echo "未启用 ip-events 上报"
fi
echo
if [ "$CHANGEIP_ENABLED" -eq 1 ]; then
  echo "请在 CarpoolNotifier（Cloudflare Worker）中为该服务器配置："
  echo "  - 在 wrangler.toml 的 vars 里，把此服务器根地址加入 CHANGEIP_ENDPOINTS_JSON："
  echo "      {\"$SERVER_LABEL\":\"http://<VPS_IP>:$PORT\", ...}"
  echo "    CarpoolNotifier 会自动推导 /changeip 与 /info；不要在这里填 /changeip 路径。"
  echo "  - 把此服务器加入 CHANGEIP_SERVERS（bot 侧可调用的 ip-changer 统一标记为 script）："
  echo "      $SERVER_LABEL:script"
  if [ "$CHANGEIP_PROVIDER" != "script" ]; then
    echo "    注意：本机 CHANGEIP_PROVIDER=$CHANGEIP_PROVIDER 只属于 ip-changer 内部 provider；CarpoolNotifier 侧仍写 script。"
  fi
  echo "  - 使用 secret 配置 CHANGEIP_TOKENS_JSON（JSON 需包含所有服务器的条目）："
  echo "      wrangler secret put CHANGEIP_TOKENS_JSON"
  echo "    并填入：{\"$SERVER_LABEL\":\"$AUTH_TOKEN\", ...}"
fi
if [ "$IP_EVENTS_ENABLED" -eq 1 ]; then
  echo "请在 CarpoolNotifier（Cloudflare Worker）中配置密钥："
  echo "  wrangler secret put IP_EVENTS_TOKEN"
  echo "并填入上面的 IP_EVENTS_TOKEN"
fi

echo
echo "排障常用命令："
echo "  systemctl status changeip-http --no-pager"
echo "  journalctl -u changeip-http -n 200 --no-pager"
echo
echo "安全提示：AUTH_TOKEN 属于密钥；若启用 ip-events，请同时妥善保存 IP_EVENTS_TOKEN。"
