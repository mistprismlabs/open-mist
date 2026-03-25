// Heartbeat 守护进程 — 每 30 分钟唤醒执行系统巡检
// 由 systemd heartbeat.service 管理，不要直接 node 启动

const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTERVAL = 30 * 60 * 1000; // 30 分钟
const TIMEOUT = 300_000;          // 单次 Claude 巡检最多 5 分钟
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const LOG_FILE = path.join(PROJECT_DIR, 'logs/heartbeat.log');

// 孤儿进程特征：ppid=1 且命令匹配以下模式（SSH 遗留 / 卡死进程）
const ORPHAN_PATTERNS = [
  /^sudo su - jarvis/,
  /^su - jarvis/,
  /^nano \/etc\//,
  /claude auth login/,
  /\/\.local\/bin\/claude/,    // 遗留的 claude -p 进程
  /^claude\b/,                  // 裸 claude 命令
];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function notify(text) {
  try {
    execFileSync('node', ['scripts/send-notify.js', text], {
      cwd: PROJECT_DIR,
      timeout: 15_000,
    });
    log('通知已发送');
  } catch (err) {
    log('通知发送失败: ' + err.message);
  }
}

// ── 原生检查（不依赖 Claude，快速执行）────────────────────────

/**
 * 检测并清理孤儿进程
 * 返回 killed 列表（字符串）
 */
function cleanOrphans() {
  try {
    const lines = execSync('ps -eo pid,ppid,cmd --no-headers', { timeout: 5_000 })
      .toString().trim().split('\n');

    const killed = [];
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, pid, ppid, cmd] = m;
      if (ppid !== '1') continue;
      if (!ORPHAN_PATTERNS.some(re => re.test(cmd))) continue;

      try {
        execFileSync('sudo', ['/usr/bin/kill', '-9', pid], { timeout: 3_000 });
        killed.push(pid + '(' + cmd.slice(0, 35) + ')');
      } catch (e) { console.debug('[cleanOrphans] kill', pid, '已消失:', e.message); }
    }
    return killed;
  } catch (err) {
    log('[cleanOrphans] 执行失败: ' + err.message);
    return [];
  }
}

/**
 * 扫描最近 40 分钟内的 feishu-bot 日志，统计错误模式
 * 用时间戳过滤而非固定行数，避免历史错误反复触发告警
 */
function scanRecentLogs() {
  const logPath = path.join(PROJECT_DIR, 'logs/feishu-bot.log');
  if (!fs.existsSync(logPath)) return { errors: 0, permErrors: 0 };
  try {
    const cutoff = Date.now() - 40 * 60 * 1000; // 40 分钟（略大于巡检间隔 30 分钟）
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-500);
    const recent = lines.filter(l => {
      const m = l.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      return m && new Date(m[1]).getTime() > cutoff;
    });
    const errors = recent.filter(l => /\[ERROR\]|Error:/.test(l)).length;
    const permErrors = recent.filter(l => /EACCES|permission denied/i.test(l)).length;
    return { errors, permErrors };
  } catch (e) {
    console.warn('[scanRecentLogs] 读取日志失败:', e.message);
    return { errors: 0, permErrors: 0 };
  }
}

/**
 * 读取内存使用率
 */
function checkMemory() {
  try {
    const out = execSync("free -m | awk '/Mem:/{print $3,$2}'", { timeout: 5_000 })
      .toString().trim();
    const [used, total] = out.split(' ').map(Number);
    return { used, total, pct: Math.round(used / total * 100) };
  } catch (e) {
    console.warn('[checkMemory] 读取内存失败:', e.message);
    return null;
  }
}

/**
 * H4: 文件权限巡检 — data/ 目录下非 jarvis 属主的文件
 * sudoers 允许: chown jarvis:jarvis data/*（单层）+ chown -R data/memory/（递归）
 */
function checkFilePermissions() {
  const alerts = [];
  try {
    const badFiles = execFileSync('find', [PROJECT_DIR + '/data', '-not', '-user', 'jarvis', '-type', 'f'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!badFiles) return alerts;

    const files = badFiles.split('\n');
    const memoryFiles = files.filter(f => f.includes('/data/memory/'));
    const topFiles = files.filter(f => !f.includes('/data/memory/'));

    // data/memory/ 下的文件：递归修复
    if (memoryFiles.length > 0) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', '-R', 'jarvis:jarvis', PROJECT_DIR + '/data/memory/'], { timeout: 5_000 });
        alerts.push('[已修复] data/memory/ 权限异常并已修正（' + memoryFiles.length + '个文件）');
      } catch (e) {
        alerts.push('[告警] data/memory/ 权限修复失败: ' + e.message);
      }
    }

    // data/ 根目录下的文件：逐个修复（sudoers 允许 chown data/*）
    for (const f of topFiles) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', 'jarvis:jarvis', f], { timeout: 5_000 });
        alerts.push('[已修复] ' + path.basename(f) + ' 权限已修正');
      } catch (e) {
        alerts.push('[告警] ' + path.basename(f) + ' 权限修复失败: ' + e.message);
      }
    }
  } catch (e) { console.warn('[checkFilePermissions] 巡检失败:', e.message); }
  return alerts;
}

/**
 * H5b: nginx SSL 证书路径巡检
 * 扫描 /etc/nginx/sites-enabled/ 下所有配置，发现非标证书路径即告警
 * 标准路径从 SSL_CERT_PATH 环境变量读取
 */
function checkSslCertPaths() {
  const alerts = [];
  const nginxDir = '/etc/nginx/sites-enabled';
  // 从环境变量读取标准证书路径（与 deployer.js 保持一致）
  const standardCert = process.env.SSL_CERT_PATH || '';
  if (!standardCert) return alerts; // 未配置时跳过巡检
  // 取证书所在目录作为匹配基准（去掉文件名）
  const standardDir = standardCert.substring(0, standardCert.lastIndexOf('/') + 1);
  try {
    const files = fs.readdirSync(nginxDir);
    for (const file of files) {
      const filePath = nginxDir + '/' + file;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const certLines = content.split('\n').filter(l => l.trim().startsWith('ssl_certificate'));
        for (const line of certLines) {
          if (!line.includes(standardDir)) {
            alerts.push(`[SSL告警] ${file}: 非标准证书路径 → ${line.trim()}`);
          }
        }
      } catch { /* 跳过无法读取的文件 */ }
    }
  } catch (e) {
    console.warn('[checkSslCertPaths] 巡检失败:', e.message);
  }
  return alerts;
}

/**
 * H5: VectorStore 可写性检查
 */
function checkVectorStoreWritable() {
  const alerts = [];
  const dbPath = path.join(PROJECT_DIR, 'data/memory/vectors.db');
  try {
    if (fs.existsSync(dbPath)) {
      fs.accessSync(dbPath, fs.constants.W_OK);
    }
  } catch {
    try {
      execFileSync('sudo', ['/usr/bin/chown', 'jarvis:jarvis', PROJECT_DIR + '/data/memory/vectors.db'], { timeout: 5_000 });
      alerts.push('[已修复] vectors.db 权限异常并已修正');
    } catch (e2) {
      alerts.push('[告警] vectors.db 不可写且修复失败: ' + e2.message);
    }
  }
  return alerts;
}

// ─────────────────────────────────────────────────────────────

function runClaude(prompt) {
  return new Promise(function (resolve, reject) {
    const args = [
      '-p', prompt,
      '--bare',
      '--allowedTools', 'Bash,Read',
      '--model', 'claude-sonnet-4-6',
      '--output-format', 'text',
    ];

    // stdin 必须设为 ignore，否则 claude 会等待 stdin 关闭
    const child = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '', done = false;
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('超时(' + (TIMEOUT / 1000) + '秒)')); }
    }, TIMEOUT);

    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error('exit ' + code + ': ' + stderr.slice(-300).trim()));
    });

    child.on('error', err => {
      if (done) return;
      done = true; clearTimeout(timer); reject(err);
    });
  });
}

function buildPrompt(native) {
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const hour = parseInt(now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false,
  }));
  const dow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();

  // ── 基础检查（每次都执行）──
  const checks = [
    'systemctl is-active feishu-bot.service',
    'systemctl is-active xuanxue-api.service',
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3721/api/health',
    'tail -50 logs/feishu-bot.log | grep -i "error\\|fatal" | tail -3',
    'df -h / | tail -1',
    'du -sh media/',
    'tail -5 logs/fetch-hot.log',
  ];

  // ── 时间窗口检查（cron 执行后检查对应日志）──
  const cronRules = [];

  // 选题推荐（cron 6:00）→ 6:30~8:00 检查
  if (hour >= 6 && hour <= 8) {
    checks.push('tail -8 logs/recommend.log');
    cronRules.push('recommend.log: 出现ERROR/503/processed:0→选题推荐失败,告警并提示用户手动重跑');
  }

  // 资讯日报（cron 7:30）→ 8:00~9:30 检查
  if (hour >= 8 && hour <= 9) {
    checks.push('tail -10 logs/briefing.log 2>/dev/null || echo BRIEFING_NO_LOG');
    cronRules.push('briefing.log: 出现ERROR/采集失败/BRIEFING_NO_LOG→资讯日报异常,告警');
  }

  // Claude Code 自动更新（cron 3:00）→ 3:30~4:30 检查
  if (hour >= 3 && hour <= 4) {
    checks.push('tail -5 logs/claude-update.log');
    cronRules.push('claude-update.log: 出现error/fatal→Claude更新失败,告警');
  }

  // 更新检查（cron 5:00）→ 5:30~6:30 检查
  if (hour >= 5 && hour <= 6) {
    checks.push('tail -5 logs/update-check.log');
    cronRules.push('update-check.log: 出现error/失败→更新检查异常,告警');
  }

  // 媒体清理（cron 4:00）→ 4:30~5:30 检查
  if (hour >= 4 && hour <= 5) {
    checks.push('tail -5 logs/cleanup-media.log');
    cronRules.push('cleanup-media.log: 出现error→媒体清理失败,告警');
  }

  // 每日摘要（cron 23:55）→ 次日 0:00~1:00 检查
  if (hour === 0) {
    checks.push('tail -5 logs/digest.log');
    cronRules.push('digest.log: 出现error→每日摘要导出失败,告警');
  }

  // 周报+记忆周报（周日 22:00/23:00）→ 周日 23:30 或周一 0:00 检查
  if ((dow === 0 && hour >= 23) || (dow === 1 && hour === 0)) {
    checks.push('tail -15 logs/digest.log');
    cronRules.push('digest.log(周报): 出现error→周报导出失败,告警');
  }

  // 把原生检查结果注入上下文
  const ctx = [];
  if (native.orphansKilled.length > 0)
    ctx.push('已自动清理孤儿进程' + native.orphansKilled.length + '个: ' + native.orphansKilled.join(', '));
  if (native.permErrors > 0)
    ctx.push('日志发现' + native.permErrors + '处EACCES权限错误，请检查文件所有者');
  if (native.memory && native.memory.pct > 85)
    ctx.push('内存使用率' + native.memory.pct + '%（' + native.memory.used + 'MB/' + native.memory.total + 'MB）超过85%阈值');

  return '巡检。北京时间 ' + timeStr + '。工作目录 ' + PROJECT_DIR + '。' +
    '【你的权限】你以 jarvis 用户运行，拥有以下 sudo NOPASSWD 权限：' +
    '(1) sudo systemctl {restart,stop,start,status} feishu-bot* — 飞书机器人服务管理；' +
    '(2) sudo systemctl {restart,stop,start,status} heartbeat* — 心跳服务自身管理；' +
    '(3) sudo kill -9 <pid> — 清理任意用户的孤儿进程；' +
    '(4) sudo nginx -t/-s reload — Nginx 配置测试和重载。' +
    '不要尝试执行超出以上范围的 sudo 命令。' +
    (ctx.length ? '【原生检查】' + ctx.join('；') + '。' : '') +
    '【故障判定规则】' +
    'feishu-bot非active→sudo systemctl restart feishu-bot.service；' +
    'xuanxue-api非active或health接口非200→sudo systemctl restart xuanxue-api.service；' +
    '磁盘>80%或media>1GB→告警；' +
    'fetch-hot.log: 出现ERROR或写入0条→热搜采集异常,告警；' +
    (cronRules.length ? cronRules.join('；') + '。' : '') +
    '发现任何故障→用 node scripts/send-notify.js "[Heartbeat] 具体问题" 发送告警。' +
    '用一个Bash调用执行: ' + checks.join(' && echo --- && ') + '。' +
    '分析结果。全部正常输出HEARTBEAT_OK。' +
    '【自动修复规则】你不只是报告问题，发现问题后先尝试修复，修复失败再告警。' +
    '可执行的修复操作：' +
    '(1) feishu-bot挂掉→sudo systemctl restart feishu-bot.service；' +
    '(2) cron脚本上次执行失败(日志显示Error/失败)→重跑一次: ' +
    `热搜采集: cd ${PROJECT_DIR} && node scripts/fetch-hot-to-bitable.js, ` +
    `每日简报: cd ${PROJECT_DIR} && node scripts/fetch-daily-briefing.js, ` +
    `GitHub更新: cd ${PROJECT_DIR} && node scripts/fetch-github-updates.js, ` +
    `每日摘要: cd ${PROJECT_DIR} && node scripts/export-daily-digest.js ` +
    '(注意: 推荐脚本orchestrator.js耗时长，只在6:00-7:00之间重跑)；' +
    `(3) 磁盘>85%→执行 ${PROJECT_DIR}/scripts/cleanup-media.sh；` +
    `(4) 文件权限异常→sudo chown -R jarvis:jarvis ${PROJECT_DIR}/data/memory/。` +
    '报告格式: 修复成功用"[已修复] xxx（原因: yyy）", 修复失败用"[需人工] xxx（尝试: yyy, 结果: zzz）", 一切正常只回复HEARTBEAT_OK或简洁正常状态';
}

// ─────────────────────────────────────────────────────────────

let checking = false;

async function heartbeat() {
  if (checking) { log('上次巡检仍在运行，跳过'); return; }
  checking = true;
  log('开始巡检');

  // ── 1. 原生检查（快速，无 AI token）──
  const orphansKilled = cleanOrphans();
  const logScan = scanRecentLogs();
  const memory = checkMemory();

  if (orphansKilled.length > 0) {
    log('[孤儿清理] killed ' + orphansKilled.length + ': ' + orphansKilled.join(' | '));
    notify('[Heartbeat] 清理了 ' + orphansKilled.length + ' 个孤儿进程: ' + orphansKilled.slice(0, 3).join(', '));
  }
  if (logScan.permErrors > 0) {
    log('[权限告警] 近期日志发现 ' + logScan.permErrors + ' 处 EACCES');
    notify('[Heartbeat] 权限错误: 日志中发现 ' + logScan.permErrors + ' 处 EACCES，请检查文件所有者');
  }
  if (memory && memory.pct > 85) {
    log('[内存告警] ' + memory.used + 'MB / ' + memory.total + 'MB (' + memory.pct + '%)');
    notify('[Heartbeat] 内存使用率 ' + memory.pct + '%，已超过 85% 阈值');
  }

  // H4: 文件权限巡检
  const permAlerts = checkFilePermissions();
  for (const a of permAlerts) {
    log('[权限修复] ' + a);
    notify('[Heartbeat] ' + a);
  }

  // H5: VectorStore 可写性检查
  const vecAlerts = checkVectorStoreWritable();
  for (const a of vecAlerts) {
    log('[VectorStore] ' + a);
    notify('[Heartbeat] ' + a);
  }

  // H5b: SSL 证书路径巡检
  const sslAlerts = checkSslCertPaths();
  for (const a of sslAlerts) {
    log('[SSL巡检] ' + a);
    notify('[Heartbeat] ' + a);
  }

  // ── 2. Claude AI 巡检──
  try {
    const prompt = buildPrompt({ orphansKilled, permErrors: logScan.permErrors, memory });
    const result = await runClaude(prompt);
    const firstLine = result.split('\n')[0].trim();
    log('巡检结果: ' + firstLine);

    if (result.includes('HEARTBEAT_OK')) {
      log('巡检正常');
    } else {
      log('巡检输出: ' + result.slice(0, 300));
    }
  } catch (err) {
    log('巡检失败: ' + err.message);
    notify('[Heartbeat] 巡检失败: ' + err.message.slice(0, 200));
  } finally {
    checking = false;
  }
}

// 启动
log('Heartbeat 守护进程启动');
heartbeat();
setInterval(heartbeat, INTERVAL);

// 优雅退出
process.on('SIGTERM', () => {
  log('收到 SIGTERM，退出');
  process.exit(0);
});
