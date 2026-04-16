#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0

SERVICE_NAME="${SERVICE_NAME:-openmist.service}"
WEB_PORT="${WEB_PORT:-3003}"
JOURNAL_LINES="${CHECK_SERVICE_JOURNAL_LINES:-80}"

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

read_journal() {
  local active_since="$1"
  if sudo -n true >/dev/null 2>&1; then
    if [[ -n "$active_since" ]]; then
      sudo -n journalctl -u "$SERVICE_NAME" --since "$active_since" --no-pager 2>/dev/null || true
    else
      sudo -n journalctl -u "$SERVICE_NAME" -n "$JOURNAL_LINES" --no-pager 2>/dev/null || true
    fi
  else
    if [[ -n "$active_since" ]]; then
      journalctl -u "$SERVICE_NAME" --since "$active_since" --no-pager 2>/dev/null || true
    else
      journalctl -u "$SERVICE_NAME" -n "$JOURNAL_LINES" --no-pager 2>/dev/null || true
    fi
  fi
}

echo "OpenMist service check"
echo "Repo: $ROOT_DIR"
echo "Service: $SERVICE_NAME"

SERVICE_STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
if [[ "$SERVICE_STATE" == "active" ]]; then
  pass "systemd service active"
else
  fail "systemd service is not active ($SERVICE_STATE)"
fi

ACTIVE_SINCE="$(systemctl show "$SERVICE_NAME" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
JOURNAL_OUTPUT="$(read_journal "$ACTIVE_SINCE")"

if grep -Fq 'Fatal error:' <<<"$JOURNAL_OUTPUT"; then
  fail "fatal startup error found in recent logs"
fi

if grep -Fq 'Gateway running' <<<"$JOURNAL_OUTPUT"; then
  pass "gateway startup confirmed"
else
  fail "gateway startup marker missing from recent logs"
fi

if grep -Fq '[WebAdapter] Listening on 127.0.0.1:' <<<"$JOURNAL_OUTPUT"; then
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || printf '000')"
  if [[ "$HTTP_CODE" == "000" ]]; then
    fail "web adapter log exists but local port check failed"
  else
    pass "web adapter reachable on 127.0.0.1:${WEB_PORT} (HTTP ${HTTP_CODE})"
  fi
else
  warn "web adapter startup marker missing from recent logs"
fi

if grep -Fq '[Feishu] Startup blocked by platform prerequisites:' <<<"$JOURNAL_OUTPUT"; then
  warn "Feishu startup blocked by platform prerequisites"
fi

if grep -Fq '[VectorStore] Initialized' <<<"$JOURNAL_OUTPUT"; then
  pass "VectorStore initialized"
elif grep -Fq '[VectorStore] Init failed' <<<"$JOURNAL_OUTPUT"; then
  warn "VectorStore degraded to keyword search fallback"
else
  warn "VectorStore status not found in recent logs"
fi

exit "$STATUS"
