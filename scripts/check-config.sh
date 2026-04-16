#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_FILE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
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

read_env_value() {
  local key="$1"
  local file="$2"
  local line

  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf ''
    return 0
  fi

  line="${line#*=}"
  line="$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

is_placeholder_value() {
  local value="$1"
  local normalized

  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  [[ -z "$normalized" ]] && return 0
  [[ "$normalized" == *"your_"* ]] && return 0
  [[ "$normalized" == *"your-"* ]] && return 0
  [[ "$normalized" == *"your key"* ]] && return 0
  [[ "$normalized" == *"example"* ]] && return 0
  [[ "$normalized" == *"/path/to/"* ]] && return 0
  [[ "$normalized" == "your-domain.com" ]] && return 0

  return 1
}

is_reference_like_value() {
  local value="$1"
  local normalized

  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  [[ "$normalized" == "****" ]] && return 0
  [[ "$normalized" == \{*\} ]] && return 0
  [[ "$normalized" == *"'source'"* ]] && return 0
  [[ "$normalized" == *"\"source\""* ]] && return 0

  return 1
}

require_value() {
  local key="$1"
  local value
  value="$(read_env_value "$key" "$ENV_FILE")"
  if ! is_placeholder_value "$value"; then
    pass "$key configured"
  else
    fail "$key is required but missing or still using a placeholder value"
  fi
}

require_any_value() {
  local description="$1"
  shift
  local key
  local value

  for key in "$@"; do
    value="$(read_env_value "$key" "$ENV_FILE")"
    if ! is_placeholder_value "$value"; then
      pass "$description configured via $key"
      return 0
    fi
  done

  fail "$description is required but missing or still using placeholder values ($*)"
}

check_optional_group() {
  local label="$1"
  shift
  local keys=("$@")
  local key
  local value
  local present_count=0
  local missing=()

  for key in "${keys[@]}"; do
    value="$(read_env_value "$key" "$ENV_FILE")"
    if is_placeholder_value "$value"; then
      missing+=("$key")
    else
      present_count=$((present_count + 1))
    fi
  done

  if [[ "$present_count" -eq 0 ]]; then
    warn "$label credentials are empty; this channel will stay disabled"
    return 0
  fi

  if [[ "$present_count" -ne "${#keys[@]}" ]]; then
    fail "$label is partially configured; required keys: ${keys[*]}; missing: ${missing[*]}"
    return 1
  fi

  pass "$label credentials look complete"
  return 0
}

echo "OpenMist config check"
echo "Repo: $ROOT_DIR"

if [[ -f "$EXAMPLE_FILE" ]]; then
  pass ".env.example found"
else
  fail ".env.example missing"
fi

if [[ -f "$ENV_FILE" ]]; then
  pass ".env found"
else
  fail ".env missing; create it with: cp .env.example .env"
  exit "$STATUS"
fi

require_any_value "Anthropic-compatible API credential" "ANTHROPIC_API_KEY" "ANTHROPIC_AUTH_TOKEN"

ANTHROPIC_BASE_URL_VALUE="$(read_env_value ANTHROPIC_BASE_URL "$ENV_FILE")"
CLAUDE_MODEL_VALUE="$(read_env_value CLAUDE_MODEL "$ENV_FILE")"
RECOMMEND_MODEL_VALUE="$(read_env_value RECOMMEND_MODEL "$ENV_FILE")"

if ! is_placeholder_value "$ANTHROPIC_BASE_URL_VALUE"; then
  pass "ANTHROPIC_BASE_URL configured"
  if is_placeholder_value "$CLAUDE_MODEL_VALUE"; then
    fail "CLAUDE_MODEL is required when ANTHROPIC_BASE_URL is set; use a provider-specific model ID"
  else
    pass "CLAUDE_MODEL configured for custom provider"
  fi
  if is_placeholder_value "$RECOMMEND_MODEL_VALUE"; then
    warn "RECOMMEND_MODEL empty; recommendation paths will fall back to CLAUDE_MODEL"
  else
    pass "RECOMMEND_MODEL configured for custom provider"
  fi
else
  warn "ANTHROPIC_BASE_URL empty; runtime will use Anthropic's default API endpoint"
fi

FEISHU_APP_ID_VALUE="$(read_env_value FEISHU_APP_ID "$ENV_FILE")"
FEISHU_APP_SECRET_VALUE="$(read_env_value FEISHU_APP_SECRET "$ENV_FILE")"

if ! is_placeholder_value "$FEISHU_APP_ID_VALUE" || ! is_placeholder_value "$FEISHU_APP_SECRET_VALUE"; then
  if ! is_placeholder_value "$FEISHU_APP_ID_VALUE" && ! is_placeholder_value "$FEISHU_APP_SECRET_VALUE"; then
    if is_reference_like_value "$FEISHU_APP_SECRET_VALUE"; then
      fail "Feishu channel is using a reference-like app secret; write a plain app secret value into .env"
    else
    pass "Feishu channel credentials look complete"
    fi
  else
    fail "Feishu channel is partially configured or still using placeholder values; FEISHU_APP_ID and FEISHU_APP_SECRET must be set together"
  fi
else
  warn "Feishu channel credentials are empty; the Feishu adapter will stay disabled"
fi

check_optional_group "WeCom app channel" \
  "WECOM_CORP_ID" \
  "WECOM_AGENT_ID" \
  "WECOM_AGENT_SECRET" \
  "WECOM_TOKEN" \
  "WECOM_ENCODING_AES_KEY"

check_optional_group "WeCom bot channel" \
  "WECOM_BOT_ID" \
  "WECOM_BOT_SECRET"

SERVICE_NAME_VALUE="$(read_env_value SERVICE_NAME "$ENV_FILE")"
if [[ -n "$SERVICE_NAME_VALUE" ]]; then
  pass "SERVICE_NAME configured"
else
  warn "SERVICE_NAME missing; set it before writing a systemd unit"
fi

APP_USER_VALUE="$(read_env_value APP_USER "$ENV_FILE")"
if [[ -n "$APP_USER_VALUE" ]]; then
  pass "APP_USER configured"
else
  warn "APP_USER missing; set it if you deploy with a dedicated Linux user"
fi

PROJECT_DIR_VALUE="$(read_env_value PROJECT_DIR "$ENV_FILE")"
if [[ -n "$PROJECT_DIR_VALUE" ]]; then
  pass "PROJECT_DIR configured"
else
  warn "PROJECT_DIR missing; helpful for heartbeat and ops scripts"
fi

WEB_PORT_VALUE="$(read_env_value WEB_PORT "$ENV_FILE")"
if [[ -n "$WEB_PORT_VALUE" ]]; then
  pass "WEB_PORT configured"
else
  warn "WEB_PORT missing; set an instance-specific web port before starting systemd on shared hosts"
fi

HEARTBEAT_TIMEZONE_VALUE="$(read_env_value HEARTBEAT_TIMEZONE "$ENV_FILE")"
if [[ -n "$HEARTBEAT_TIMEZONE_VALUE" ]]; then
  pass "HEARTBEAT_TIMEZONE configured"
else
  warn "HEARTBEAT_TIMEZONE empty; runtime will use the system time zone"
fi

HEARTBEAT_MODEL_VALUE="$(read_env_value HEARTBEAT_MODEL "$ENV_FILE")"
if [[ -n "$HEARTBEAT_MODEL_VALUE" ]]; then
  pass "HEARTBEAT_MODEL configured"
else
  warn "HEARTBEAT_MODEL empty; runtime will fall back to Claude Code defaults"
fi

NGINX_ENABLED_DIR_VALUE="$(read_env_value NGINX_ENABLED_DIR "$ENV_FILE")"
if [[ -n "$NGINX_ENABLED_DIR_VALUE" ]]; then
  pass "NGINX_ENABLED_DIR configured"
else
  warn "NGINX_ENABLED_DIR empty; nginx certificate checks will be skipped"
fi

exit "$STATUS"
