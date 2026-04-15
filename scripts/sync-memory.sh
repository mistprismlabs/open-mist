#!/usr/bin/env bash
# sync-memory.sh — 将本地 MEMORY.md 备份到服务器
# 用法: bash scripts/sync-memory.sh
set -euo pipefail

MEMORY_DIR="${LOCAL_MEMORY_DIR:-$HOME/.claude/memory}"
REMOTE="${SYNC_REMOTE:?SYNC_REMOTE env required}"
REMOTE_DIR="${PROJECT_DIR:?PROJECT_DIR env required}/data/memory-backup"
REMOTE_OWNER="${APP_USER:-openmist}:${APP_USER:-openmist}"

if [ ! -f "$MEMORY_DIR/MEMORY.md" ]; then
  echo "[sync-memory] MEMORY.md not found, skip"
  exit 0
fi

# 确保远端目录存在
ssh "$REMOTE" "mkdir -p $REMOTE_DIR && chown $REMOTE_OWNER $REMOTE_DIR" 2>/dev/null

# rsync 所有 memory 文件（MEMORY.md + 可能的 topic files）
rsync -az --delete "$MEMORY_DIR/" "$REMOTE:$REMOTE_DIR/"
ssh "$REMOTE" "chown -R $REMOTE_OWNER $REMOTE_DIR" 2>/dev/null

echo "[sync-memory] $(date '+%H:%M') synced $(ls "$MEMORY_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ') files to $REMOTE:$REMOTE_DIR/"
