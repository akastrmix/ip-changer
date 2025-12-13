#!/bin/bash

set -e

if [ "$EUID" -ne 0 ]; then
  echo "请以 root 身份运行此脚本（sudo ./uninstall.sh）"
  exit 1
fi

ENV_FILE="/etc/default/changeip-http"
SERVICE_FILE="/etc/systemd/system/changeip-http.service"
STATE_DIR="/var/lib/changeip-http"

echo "=== 卸载 IPChanger HTTP 服务 ==="

if systemctl list-unit-files | grep -q '^changeip-http.service'; then
  echo "停止 changeip-http 服务（如在运行）..."
  systemctl stop changeip-http || true

  echo "禁用 changeip-http 服务开机自启..."
  systemctl disable changeip-http || true
fi

echo "删除 systemd 单元文件（如存在）: $SERVICE_FILE"
rm -f "$SERVICE_FILE"

echo "删除环境配置文件（如存在）: $ENV_FILE"
rm -f "$ENV_FILE"

echo "删除状态目录（如存在）: $STATE_DIR"
rm -rf "$STATE_DIR"

echo "重新加载 systemd ..."
systemctl daemon-reload

echo "=== 卸载完成 ==="
echo "系统级改动已移除。如需彻底清理源码，请手动删除本仓库目录。"
