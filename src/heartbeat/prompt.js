'use strict';

function buildHeartbeatPrompt({
  heartbeatTimezone,
  projectDir,
  appUser,
  botService,
  auxService,
  healthcheckUrl,
  native,
}) {
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    timeZone: heartbeatTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const checks = [
    `systemctl is-active ${botService}`,
    ...(auxService ? [`systemctl is-active ${auxService}`] : []),
    ...(healthcheckUrl ? [`curl -s -o /dev/null -w "%{http_code}" ${healthcheckUrl}`] : []),
    'df -h / | tail -1',
    'du -sh media/',
  ];

  const ctx = [];
  if (native.orphansKilled.length > 0) {
    ctx.push(`已自动清理孤儿进程${native.orphansKilled.length}个: ${native.orphansKilled.join(', ')}`);
  }
  if (native.memory && native.memory.pct > 85) {
    ctx.push(`内存使用率${native.memory.pct}%（${native.memory.used}MB/${native.memory.total}MB）超过85%阈值`);
  }

  return '巡检。北京时间 ' + timeStr + '。工作目录 ' + projectDir + '。' +
    `【你的权限】你以 ${appUser} 用户运行，请只执行当前部署环境明确授予的 sudo 权限。` +
    (ctx.length ? '【原生检查】' + ctx.join('；') + '。' : '') +
    '【故障判定规则】' +
    `${botService} 非active→sudo systemctl restart ${botService}；` +
    (auxService ? `${auxService} 非active` + (healthcheckUrl ? `或 health 接口 ${healthcheckUrl} 非预期` : '') + `→sudo systemctl restart ${auxService}；` : '') +
    '磁盘>80%或media>1GB→告警；' +
    '发现任何故障→用 node scripts/send-notify.js "[Heartbeat] 具体问题" 发送告警。' +
    '用一个Bash调用执行: ' + checks.join(' && echo --- && ') + '。' +
    '分析结果。全部正常输出HEARTBEAT_OK。' +
    '【自动修复规则】你不只是报告问题，发现问题后先尝试修复，修复失败再告警。' +
    '可执行的修复操作：' +
    `(1) ${botService} 挂掉→sudo systemctl restart ${botService}；` +
    `(2) 磁盘>85%→执行 ${projectDir}/scripts/cleanup-media.sh；` +
    `(3) 文件权限异常→sudo chown -R ${appUser}:${appUser} ${projectDir}/data/memory/。` +
    '报告格式: 修复成功用"[已修复] xxx（原因: yyy）", 修复失败用"[需人工] xxx（尝试: yyy, 结果: zzz）", 一切正常只回复HEARTBEAT_OK或简洁正常状态';
}

module.exports = { buildHeartbeatPrompt };
