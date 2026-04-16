// Heartbeat 守护进程 — 每 30 分钟唤醒执行系统巡检
// 由 systemd heartbeat.service 管理，不要直接 node 启动

const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTERVAL = 30 * 60 * 1000; // 30 分钟
const TIMEOUT = 300_000;          // 单次 Claude 巡检最多 5 分钟
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const HEARTBEAT_MODEL = process.env.HEARTBEAT_MODEL || process.env.RECOMMEND_MODEL || process.env.CLAUDE_MODEL || '';
const HEARTBEAT_TIMEZONE = process.env.HEARTBEAT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const APP_USER = process.env.APP_USER || 'openmist';
const BOT_SERVICE = process.env.SERVICE_NAME || 'openmist.service';
const AUX_SERVICE = process.env.AUX_SERVICE_NAME || '';
const HEALTHCHECK_URL = process.env.AUX_HEALTHCHECK_URL || '';
const LOG_FILE = path.join(PROJECT_DIR, 'logs/heartbeat.log');

// 孤儿进程特征：ppid=1 且命令匹配以下模式（SSH 遗留 / 卡死进程）
const ORPHAN_PATTERNS = [
  new RegExp(`^sudo su - ${APP_USER}`),
  new RegExp(`^su - ${APP_USER}`),
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
 * H4: 文件权限巡检 — data/ 目录下非 APP_USER 属主的文件
 * sudoers 允许的修复范围应与部署环境保持一致
 */
function checkFilePermissions() {
  const alerts = [];
  try {
    const badFiles = execFileSync('find', [PROJECT_DIR + '/data', '-not', '-user', APP_USER, '-type', 'f'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!badFiles) return alerts;

    const files = badFiles.split('\n');
    const memoryFiles = files.filter(f => f.includes('/data/memory/'));
    const topFiles = files.filter(f => !f.includes('/data/memory/'));

    // data/memory/ 下的文件：递归修复
    if (memoryFiles.length > 0) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', '-R', `${APP_USER}:${APP_USER}`, PROJECT_DIR + '/data/memory/'], { timeout: 5_000 });
        alerts.push('[已修复] data/memory/ 权限异常并已修正（' + memoryFiles.length + '个文件）');
      } catch (e) {
        alerts.push('[告警] data/memory/ 权限修复失败: ' + e.message);
      }
    }

    // data/ 根目录下的文件：逐个修复（sudoers 允许 chown data/*）
    for (const f of topFiles) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', `${APP_USER}:${APP_USER}`, f], { timeout: 5_000 });
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
 * 扫描配置的 NGINX_ENABLED_DIR 下所有配置，发现非标证书路径即告警
 * 标准路径从 SSL_CERT_PATH 环境变量读取；未配置目录时跳过巡检
 */
function checkSslCertPaths() {
  const alerts = [];
  const nginxDir = process.env.NGINX_ENABLED_DIR || '';
  // 从环境变量读取标准证书路径（与 deployer.js 保持一致）
  const standardCert = process.env.SSL_CERT_PATH || '';
  if (!standardCert || !nginxDir) return alerts; // 未配置时跳过巡检
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
      execFileSync('sudo', ['/usr/bin/chown', `${APP_USER}:${APP_USER}`, PROJECT_DIR + '/data/memory/vectors.db'], { timeout: 5_000 });
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
      '--output-format', 'text',
    ];
    if (HEARTBEAT_MODEL) args.splice(3, 0, '--model', HEARTBEAT_MODEL);

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
    timeZone: HEARTBEAT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  // ── 基础检查（每次都执行）──
  const checks = [
    `systemctl is-active ${BOT_SERVICE}`,
    ...(AUX_SERVICE ? [`systemctl is-active ${AUX_SERVICE}`] : []),
    ...(HEALTHCHECK_URL ? [`curl -s -o /dev/null -w "%{http_code}" ${HEALTHCHECK_URL}`] : []),
    'df -h / | tail -1',
    'du -sh media/',
  ];

  // 把原生检查结果注入上下文
  const ctx = [];
  if (native.orphansKilled.length > 0)
    ctx.push('已自动清理孤儿进程' + native.orphansKilled.length + '个: ' + native.orphansKilled.join(', '));
  if (native.memory && native.memory.pct > 85)
    ctx.push('内存使用率' + native.memory.pct + '%（' + native.memory.used + 'MB/' + native.memory.total + 'MB）超过85%阈值');

  return '巡检。北京时间 ' + timeStr + '。工作目录 ' + PROJECT_DIR + '。' +
    `【你的权限】你以 ${APP_USER} 用户运行，请只执行当前部署环境明确授予的 sudo 权限。` +
    (ctx.length ? '【原生检查】' + ctx.join('；') + '。' : '') +
    '【故障判定规则】' +
    `${BOT_SERVICE} 非active→sudo systemctl restart ${BOT_SERVICE}；` +
    (AUX_SERVICE ? `${AUX_SERVICE} 非active` + (HEALTHCHECK_URL ? `或 health 接口 ${HEALTHCHECK_URL} 非预期` : '') + `→sudo systemctl restart ${AUX_SERVICE}；` : '') +
    '磁盘>80%或media>1GB→告警；' +
    '发现任何故障→用 node scripts/send-notify.js "[Heartbeat] 具体问题" 发送告警。' +
    '用一个Bash调用执行: ' + checks.join(' && echo --- && ') + '。' +
    '分析结果。全部正常输出HEARTBEAT_OK。' +
    '【自动修复规则】你不只是报告问题，发现问题后先尝试修复，修复失败再告警。' +
    '可执行的修复操作：' +
    `(1) ${BOT_SERVICE} 挂掉→sudo systemctl restart ${BOT_SERVICE}；` +
    `(2) 磁盘>85%→执行 ${PROJECT_DIR}/scripts/cleanup-media.sh；` +
    `(3) 文件权限异常→sudo chown -R ${APP_USER}:${APP_USER} ${PROJECT_DIR}/data/memory/。` +
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
  const memory = checkMemory();

  if (orphansKilled.length > 0) {
    log('[孤儿清理] killed ' + orphansKilled.length + ': ' + orphansKilled.join(' | '));
    notify('[Heartbeat] 清理了 ' + orphansKilled.length + ' 个孤儿进程: ' + orphansKilled.slice(0, 3).join(', '));
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
    const prompt = buildPrompt({ orphansKilled, memory });
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
