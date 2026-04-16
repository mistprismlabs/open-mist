#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0

pass() {
  printf '[PASS] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1"
  STATUS=1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

check_cmd() {
  local cmd="$1"
  local label="$2"
  if have_cmd "$cmd"; then
    pass "$label: $(command -v "$cmd")"
  else
    fail "$label missing ($cmd)"
  fi
}

echo "OpenMist runtime check"
echo "Repo: $ROOT_DIR"

if [[ -f /etc/os-release ]]; then
  if grep -qi '^ID=ubuntu' /etc/os-release || grep -qi '^ID_LIKE=.*ubuntu' /etc/os-release; then
    pass "Ubuntu detected"
  else
    warn "Non-Ubuntu system detected; OpenMist deploy docs target Ubuntu first"
  fi
else
  warn "/etc/os-release not found; cannot verify distro"
fi

if have_cmd systemctl; then
  pass "systemd available"
else
  fail "systemd is not available"
fi

if have_cmd sudo; then
  if sudo -n true >/dev/null 2>&1; then
    pass "sudo available without prompt"
  else
    warn "sudo exists but may prompt for a password"
  fi
else
  warn "sudo not found; install it or use root with care during bootstrap"
fi

check_cmd git "git"
check_cmd curl "curl"
check_cmd node "node"
check_cmd npm "npm"
check_cmd python3 "python3"
check_cmd make "make"
check_cmd g++ "g++"

if have_cmd claude; then
  pass "Claude Code CLI: $(command -v claude)"
else
  fail "Claude Code CLI missing (claude)"
fi

if have_cmd lark-cli; then
  pass "Lark CLI: $(command -v lark-cli)"
elif have_cmd lark; then
  pass "Lark CLI alias: $(command -v lark)"
else
  fail "Lark CLI missing (expected lark-cli or lark)"
fi

if [[ -f "$ROOT_DIR/package.json" ]]; then
  pass "package.json found"
else
  fail "package.json not found"
fi

if [[ -d "$ROOT_DIR/node_modules" ]]; then
  pass "node_modules already present"
else
  warn "node_modules missing; run npm install after cloning the repo"
fi

exit "$STATUS"
