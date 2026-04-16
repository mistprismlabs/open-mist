#!/usr/bin/env bash

set -euo pipefail

BOOTSTRAP_DRY_RUN="${BOOTSTRAP_DRY_RUN:-0}"
NODE_MAJOR="${NODE_MAJOR:-22}"
FORCE_INSTALL_NODE="${FORCE_INSTALL_NODE:-0}"
HOME_DIR="${HOME:-$HOME}"
NPM_PREFIX_DIR="${NPM_PREFIX_DIR:-$HOME_DIR/.local}"
NPM_BIN_DIR="${NPM_BIN_DIR:-$NPM_PREFIX_DIR/bin}"
NODESOURCE_SCRIPT="/tmp/openmist-nodesource-setup.sh"

run_cmd() {
  if [[ "$BOOTSTRAP_DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

append_export_if_missing() {
  local target_file="$1"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  if [[ "$BOOTSTRAP_DRY_RUN" == "1" ]]; then
    printf '[dry-run] ensure %s contains: %s\n' "$target_file" "$line"
    return 0
  fi
  touch "$target_file"
  if ! grep -Fqx "$line" "$target_file"; then
    printf '%s\n' "$line" >>"$target_file"
  fi
}

echo "OpenMist runtime bootstrap"
echo "NODE_MAJOR=$NODE_MAJOR"

run_cmd sudo apt-get update
run_cmd sudo apt-get install -y git curl build-essential python3 make g++

if [[ "$FORCE_INSTALL_NODE" == "1" ]]; then
  run_cmd curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$NODESOURCE_SCRIPT"
  run_cmd sudo -E bash "$NODESOURCE_SCRIPT"
  run_cmd sudo apt-get install -y nodejs
elif command -v node >/dev/null 2>&1; then
  printf '[PASS] node already installed: %s\n' "$(command -v node)"
else
  run_cmd curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$NODESOURCE_SCRIPT"
  run_cmd sudo -E bash "$NODESOURCE_SCRIPT"
  run_cmd sudo apt-get install -y nodejs
fi

run_cmd mkdir -p "$NPM_BIN_DIR"
run_cmd npm config set prefix "$NPM_PREFIX_DIR"
append_export_if_missing "$HOME_DIR/.bashrc"
append_export_if_missing "$HOME_DIR/.profile"

run_cmd npm install -g @anthropic-ai/claude-code
run_cmd npm install -g @larksuite/cli

printf '[PASS] bootstrap-runtime complete\n'
