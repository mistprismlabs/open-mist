#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-openmist.service}"
APP_USER="${APP_USER:-openmist}"
PROJECT_DIR="${PROJECT_DIR:-}"
ENV_FILE_PATH="${ENV_FILE_PATH:-${PROJECT_DIR:+$PROJECT_DIR/.env}}"
SYSTEMD_OUTPUT_DIR="${SYSTEMD_OUTPUT_DIR:-/etc/systemd/system}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
BOOTSTRAP_SKIP_SYSTEMCTL="${BOOTSTRAP_SKIP_SYSTEMCTL:-0}"

if [[ -z "$PROJECT_DIR" ]]; then
  echo "[FAIL] PROJECT_DIR is required"
  exit 1
fi

if [[ -z "$NPM_BIN" ]]; then
  echo "[FAIL] npm not found; set NPM_BIN or install npm first"
  exit 1
fi

UNIT_PATH="$SYSTEMD_OUTPUT_DIR/$SERVICE_NAME"

UNIT_CONTENT="[Unit]
Description=OpenMist Gateway
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NPM_BIN start
Restart=always
EnvironmentFile=$ENV_FILE_PATH

[Install]
WantedBy=multi-user.target
"

echo "OpenMist service bootstrap"
echo "SERVICE_NAME=$SERVICE_NAME"
echo "UNIT_PATH=$UNIT_PATH"

mkdir -p "$SYSTEMD_OUTPUT_DIR"
cat >"$UNIT_PATH" <<EOF
$UNIT_CONTENT
EOF

printf '[PASS] wrote systemd unit: %s\n' "$UNIT_PATH"

if [[ "$BOOTSTRAP_SKIP_SYSTEMCTL" == "1" ]]; then
  printf '[WARN] skipping systemctl enable/start\n'
  exit 0
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"
printf '[PASS] bootstrap-service complete\n'
