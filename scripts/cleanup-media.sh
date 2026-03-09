#\!/bin/bash
# 清理 media/ 下超过 7 天的文件
MEDIA_DIR="/home/jarvis/jarvis-gateway/media"

if [ \! -d "$MEDIA_DIR" ]; then
  echo "[$(date)] media/ 目录不存在，跳过"
  exit 0
fi

# 统计清理前状态
BEFORE_SIZE=$(du -sh "$MEDIA_DIR" | cut -f1)
FILES=$(find "$MEDIA_DIR" -type f -mtime +7)
COUNT=$(echo "$FILES" | grep -c . 2>/dev/null || echo 0)

if [ -z "$FILES" ]; then
  echo "[$(date)] 无需清理，没有超过 7 天的文件（当前: $BEFORE_SIZE）"
  exit 0
fi

# 执行删除
echo "$FILES" | xargs rm -f

# 清理空子目录
find "$MEDIA_DIR" -type d -empty -not -path "$MEDIA_DIR" -delete 2>/dev/null

AFTER_SIZE=$(du -sh "$MEDIA_DIR" | cut -f1)
echo "[$(date)] 清理完成: 删除 $COUNT 个文件, $BEFORE_SIZE -> $AFTER_SIZE"
