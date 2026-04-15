---
paths:
  - "src/heartbeat.js"
  - "scripts/heartbeat-daily-report.js"
---
# 心跳系统规则

## 架构
- heartbeat.service: systemd 守护进程，每 30 分钟巡检
- 两阶段: 原生检查（Node.js，快速）→ AI 巡检（claude -p，Sonnet）
- 日报: cron 07:00 运行 heartbeat-daily-report.js

## 修改注意事项
- 新增巡检项: 原生检查加在 nativeChecks()，AI 检查加在 buildPrompt()
- 新增 cron 任务: 必须同时更新 buildPrompt() 中的日志检查时间窗口
- 修复操作: 必须与当前部署环境声明的 sudo/systemd 权限一致，不要写死某个私有 sudoers 文件
- 修复失败: 必须告警，不能静默跳过

## 可执行的修复操作清单
1. systemctl restart `$SERVICE_NAME`
2. 重跑 cron 脚本（node scripts/xxx.js）
3. chown `$APP_USER:$APP_USER` data/ 下的文件
4. cleanup-media.sh（磁盘告警时）
5. kill 孤儿进程（ppid=1）
