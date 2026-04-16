#!/usr/bin/env bash

set -euo pipefail

APP_USER="${APP_USER:-openmist}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_HOME="${APP_HOME:-/home/$APP_USER}"
APP_SHELL="${APP_SHELL:-/bin/bash}"
BOOTSTRAP_DRY_RUN="${BOOTSTRAP_DRY_RUN:-0}"

run_cmd() {
  if [[ "$BOOTSTRAP_DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

echo "OpenMist user bootstrap"
echo "APP_USER=$APP_USER"
echo "APP_HOME=$APP_HOME"

if id -u "$APP_USER" >/dev/null 2>&1; then
  printf '[PASS] user already exists: %s\n' "$APP_USER"
else
  run_cmd sudo useradd --create-home --shell "$APP_SHELL" "$APP_USER"
fi

if id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -Fxq sudo; then
  printf '[PASS] user already in sudo group: %s\n' "$APP_USER"
else
  run_cmd sudo usermod -aG sudo "$APP_USER"
fi

run_cmd sudo install -d -o "$APP_USER" -g "$APP_GROUP" "$APP_HOME"

printf '[PASS] bootstrap-user complete\n'
