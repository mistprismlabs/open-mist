# Heartbeat Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden OpenMist's project-specific heartbeat daemon so it boots reliably, avoids over-broad orphan cleanup, and becomes easier to maintain without changing its role.

**Architecture:** Keep Heartbeat OpenMist-specific and preserve its external behavior. Split the current single file into small internal modules for logging, checks, prompt generation, and entry orchestration, then tighten the orphan cleanup policy and add startup safety around the `logs/` directory.

**Tech Stack:** Node.js, CommonJS, `node:test`, shell-safe filesystem operations, existing OpenMist env/runtime conventions

---

## File Map

- Create: `src/heartbeat/index.js`
  - Heartbeat entry orchestration, interval scheduling, and lifecycle wiring
- Create: `src/heartbeat/logging.js`
  - Log directory bootstrap, heartbeat log writer, and notification helper
- Create: `src/heartbeat/checks.js`
  - Native checks and project-scoped orphan matching
- Create: `src/heartbeat/prompt.js`
  - Claude巡检 prompt 生成
- Modify: `src/heartbeat.js`
  - Convert into a thin compatibility entry that imports the new module entrypoint
- Create: `test/heartbeat-bootstrap.test.js`
  - Covers log directory bootstrap and entry safety
- Modify: `test/heartbeat-boundary.test.js`
  - Add orphan cleanup boundary assertions without widening the scope into generic tooling

---

### Task 1: Guard Heartbeat Startup With Log Bootstrap

**Files:**
- Create: `test/heartbeat-bootstrap.test.js`
- Create: `src/heartbeat/logging.js`
- Modify: `src/heartbeat.js`

- [ ] **Step 1: Write the failing bootstrap test**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureHeartbeatLogFile } = require('../src/heartbeat/logging');

describe('heartbeat bootstrap', () => {
  it('creates the logs directory before writing heartbeat.log', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-hb-'));
    const logFile = ensureHeartbeatLogFile(projectDir);

    assert.equal(logFile, path.join(projectDir, 'logs', 'heartbeat.log'));
    assert.ok(fs.existsSync(path.join(projectDir, 'logs')));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/heartbeat-bootstrap.test.js
```

Expected: FAIL with a module/function-not-found error because `src/heartbeat/logging.js` and `ensureHeartbeatLogFile()` do not exist yet.

- [ ] **Step 3: Write the minimal logging bootstrap module**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function ensureHeartbeatLogFile(projectDir) {
  const logsDir = path.join(projectDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, 'heartbeat.log');
}

function createHeartbeatLogger(projectDir) {
  const logFile = ensureHeartbeatLogFile(projectDir);

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    fs.appendFileSync(logFile, `${line}\n`);
  }

  function notify(text) {
    try {
      execFileSync('node', ['scripts/send-notify.js', text], {
        cwd: projectDir,
        timeout: 15_000,
      });
      log('通知已发送');
    } catch (err) {
      log(`通知发送失败: ${err.message}`);
    }
  }

  return { logFile, log, notify };
}

module.exports = {
  ensureHeartbeatLogFile,
  createHeartbeatLogger,
};
```

- [ ] **Step 4: Rewire `src/heartbeat.js` into a thin entry shell**

Replace the top-level behavior with a compatibility entry that delegates to the new heartbeat module:

```js
'use strict';

const { startHeartbeat } = require('./heartbeat/index');

startHeartbeat();
```

Expected note: `startHeartbeat()` will be implemented in a later task, so do not run the full suite yet. This step only removes direct top-level file/log boot logic from `src/heartbeat.js`.

- [ ] **Step 5: Run the bootstrap test to verify it passes**

Run:

```bash
node --test test/heartbeat-bootstrap.test.js
```

Expected: PASS

- [ ] **Step 6: Commit the bootstrap safety slice**

```bash
git add test/heartbeat-bootstrap.test.js src/heartbeat/logging.js src/heartbeat.js
git commit -m "fix(heartbeat): bootstrap log directory safely"
```

---

### Task 2: Tighten Orphan Cleanup Boundaries

**Files:**
- Modify: `test/heartbeat-boundary.test.js`
- Create: `src/heartbeat/checks.js`

- [ ] **Step 1: Add a failing orphan-boundary test**

Append the following test to `test/heartbeat-boundary.test.js`:

```js
  it('does not treat any bare claude process as a killable orphan', () => {
    const forbiddenPatterns = [
      "/^claude\\\\b/",
      "/\\\\/\\\\.local\\\\/bin\\\\/claude/",
    ];

    for (const token of forbiddenPatterns) {
      assert.ok(!heartbeatSource.includes(token), `heartbeat.js still uses broad orphan pattern ${token}`);
    }
  });
```

- [ ] **Step 2: Run the boundary test to verify it fails**

Run:

```bash
node --test test/heartbeat-boundary.test.js
```

Expected: FAIL because `src/heartbeat.js` still contains the broad `claude` orphan patterns.

- [ ] **Step 3: Create a focused `checks` module with safer orphan matching**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');

function buildOrphanPatterns(appUser) {
  return [
    new RegExp(`^sudo su - ${appUser}`),
    new RegExp(`^su - ${appUser}`),
    /^nano \/etc\//,
    /claude auth login/,
  ];
}

function cleanOrphans({ appUser, logger }) {
  const patterns = buildOrphanPatterns(appUser);

  try {
    const lines = execSync('ps -eo pid,ppid,cmd --no-headers', { timeout: 5_000 })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    const killed = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, ppid, cmd] = match;
      if (ppid !== '1') continue;
      if (!patterns.some(re => re.test(cmd))) continue;

      try {
        execFileSync('sudo', ['/usr/bin/kill', '-9', pid], { timeout: 3_000 });
        killed.push(`${pid}(${cmd.slice(0, 35)})`);
      } catch (err) {
        logger?.log?.(`[cleanOrphans] kill ${pid} 已消失: ${err.message}`);
      }
    }
    return killed;
  } catch (err) {
    logger?.log?.(`[cleanOrphans] 执行失败: ${err.message}`);
    return [];
  }
}

function checkMemory(logger) {
  try {
    const out = execSync("free -m | awk '/Mem:/{print $3,$2}'", { timeout: 5_000 })
      .toString()
      .trim();
    const [used, total] = out.split(' ').map(Number);
    return { used, total, pct: Math.round((used / total) * 100) };
  } catch (err) {
    logger?.log?.(`[checkMemory] 读取内存失败: ${err.message}`);
    return null;
  }
}

function checkFilePermissions({ projectDir, appUser }) {
  const alerts = [];
  try {
    const badFiles = execFileSync('find', [path.join(projectDir, 'data'), '-not', '-user', appUser, '-type', 'f'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!badFiles) return alerts;

    const files = badFiles.split('\n');
    const memoryFiles = files.filter(f => f.includes('/data/memory/'));
    const topFiles = files.filter(f => !f.includes('/data/memory/'));

    if (memoryFiles.length > 0) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', '-R', `${appUser}:${appUser}`, path.join(projectDir, 'data', 'memory')], { timeout: 5_000 });
        alerts.push(`[已修复] data/memory/ 权限异常并已修正（${memoryFiles.length}个文件）`);
      } catch (err) {
        alerts.push(`[告警] data/memory/ 权限修复失败: ${err.message}`);
      }
    }

    for (const file of topFiles) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', `${appUser}:${appUser}`, file], { timeout: 5_000 });
        alerts.push(`[已修复] ${path.basename(file)} 权限已修正`);
      } catch (err) {
        alerts.push(`[告警] ${path.basename(file)} 权限修复失败: ${err.message}`);
      }
    }
  } catch {
    return alerts;
  }
  return alerts;
}

function checkVectorStoreWritable({ projectDir, appUser }) {
  const alerts = [];
  const dbPath = path.join(projectDir, 'data', 'memory', 'vectors.db');
  try {
    if (fs.existsSync(dbPath)) fs.accessSync(dbPath, fs.constants.W_OK);
  } catch {
    try {
      execFileSync('sudo', ['/usr/bin/chown', `${appUser}:${appUser}`, dbPath], { timeout: 5_000 });
      alerts.push('[已修复] vectors.db 权限异常并已修正');
    } catch (err) {
      alerts.push(`[告警] vectors.db 不可写且修复失败: ${err.message}`);
    }
  }
  return alerts;
}

function checkSslCertPaths({ nginxEnabledDir, sslCertPath }) {
  const alerts = [];
  if (!nginxEnabledDir || !sslCertPath) return alerts;

  const standardDir = sslCertPath.substring(0, sslCertPath.lastIndexOf('/') + 1);
  try {
    for (const file of fs.readdirSync(nginxEnabledDir)) {
      const content = fs.readFileSync(path.join(nginxEnabledDir, file), 'utf8');
      const certLines = content.split('\n').filter(line => line.trim().startsWith('ssl_certificate'));
      for (const line of certLines) {
        if (!line.includes(standardDir)) {
          alerts.push(`[SSL告警] ${file}: 非标准证书路径 → ${line.trim()}`);
        }
      }
    }
  } catch {
    return alerts;
  }
  return alerts;
}

module.exports = {
  buildOrphanPatterns,
  cleanOrphans,
  checkMemory,
  checkFilePermissions,
  checkVectorStoreWritable,
  checkSslCertPaths,
};
```

- [ ] **Step 4: Run the boundary test to verify it passes**

Run:

```bash
node --test test/heartbeat-boundary.test.js
```

Expected: PASS

- [ ] **Step 5: Commit the safer orphan cleanup slice**

```bash
git add test/heartbeat-boundary.test.js src/heartbeat/checks.js
git commit -m "fix(heartbeat): narrow orphan cleanup scope"
```

---

### Task 3: Extract Prompt Generation And Runtime Orchestration

**Files:**
- Create: `src/heartbeat/prompt.js`
- Create: `src/heartbeat/index.js`
- Modify: `src/heartbeat.js`

- [ ] **Step 1: Add the prompt module**

```js
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
```

- [ ] **Step 2: Add the runtime entry module**

```js
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHeartbeatLogger } = require('./logging');
const {
  cleanOrphans,
  checkMemory,
  checkFilePermissions,
  checkVectorStoreWritable,
  checkSslCertPaths,
} = require('./checks');
const { buildHeartbeatPrompt } = require('./prompt');

const INTERVAL = 30 * 60 * 1000;
const TIMEOUT = 300_000;

function startHeartbeat() {
  const projectDir = process.env.PROJECT_DIR || process.cwd();
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const heartbeatModel = process.env.HEARTBEAT_MODEL || process.env.RECOMMEND_MODEL || process.env.CLAUDE_MODEL || '';
  const heartbeatTimezone = process.env.HEARTBEAT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const appUser = process.env.APP_USER || 'openmist';
  const botService = process.env.SERVICE_NAME || 'openmist.service';
  const auxService = process.env.AUX_SERVICE_NAME || '';
  const healthcheckUrl = process.env.AUX_HEALTHCHECK_URL || '';
  const nginxEnabledDir = process.env.NGINX_ENABLED_DIR || '';
  const sslCertPath = process.env.SSL_CERT_PATH || '';

  const logger = createHeartbeatLogger(projectDir);
  let checking = false;

  function runClaude(prompt) {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--bare', '--allowedTools', 'Bash,Read', '--output-format', 'text'];
      if (heartbeatModel) args.splice(3, 0, '--model', heartbeatModel);

      const child = spawn(claudeBin, args, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let done = false;

      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          child.kill('SIGKILL');
          reject(new Error(`超时(${TIMEOUT / 1000}秒)`));
        }
      }, TIMEOUT);

      child.on('close', code => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`exit ${code}: ${stderr.slice(-300).trim()}`));
      });

      child.on('error', err => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async function heartbeat() {
    if (checking) {
      logger.log('上次巡检仍在运行，跳过');
      return;
    }
    checking = true;
    logger.log('开始巡检');

    const orphansKilled = cleanOrphans({ appUser, logger });
    const memory = checkMemory(logger);

    if (orphansKilled.length > 0) {
      logger.log('[孤儿清理] killed ' + orphansKilled.length + ': ' + orphansKilled.join(' | '));
      logger.notify('[Heartbeat] 清理了 ' + orphansKilled.length + ' 个孤儿进程: ' + orphansKilled.slice(0, 3).join(', '));
    }

    if (memory && memory.pct > 85) {
      logger.log(`[内存告警] ${memory.used}MB / ${memory.total}MB (${memory.pct}%)`);
      logger.notify('[Heartbeat] 内存使用率 ' + memory.pct + '%，已超过 85% 阈值');
    }

    for (const alert of checkFilePermissions({ projectDir, appUser })) {
      logger.log('[权限修复] ' + alert);
      logger.notify('[Heartbeat] ' + alert);
    }

    for (const alert of checkVectorStoreWritable({ projectDir, appUser })) {
      logger.log('[VectorStore] ' + alert);
      logger.notify('[Heartbeat] ' + alert);
    }

    for (const alert of checkSslCertPaths({ nginxEnabledDir, sslCertPath })) {
      logger.log('[SSL巡检] ' + alert);
      logger.notify('[Heartbeat] ' + alert);
    }

    try {
      const prompt = buildHeartbeatPrompt({
        heartbeatTimezone,
        projectDir,
        appUser,
        botService,
        auxService,
        healthcheckUrl,
        native: { orphansKilled, memory },
      });
      const result = await runClaude(prompt);
      const firstLine = result.split('\n')[0].trim();
      logger.log('巡检结果: ' + firstLine);
      if (result.includes('HEARTBEAT_OK')) logger.log('巡检正常');
      else logger.log('巡检输出: ' + result.slice(0, 300));
    } catch (err) {
      logger.log('巡检失败: ' + err.message);
      logger.notify('[Heartbeat] 巡检失败: ' + err.message.slice(0, 200));
    } finally {
      checking = false;
    }
  }

  logger.log('Heartbeat 守护进程启动');
  heartbeat();
  setInterval(heartbeat, INTERVAL);

  process.on('SIGTERM', () => {
    logger.log('收到 SIGTERM，退出');
    process.exit(0);
  });
}

module.exports = { startHeartbeat };
```

- [ ] **Step 3: Re-run the heartbeat-focused tests**

Run:

```bash
node --test test/heartbeat-bootstrap.test.js test/heartbeat-boundary.test.js
```

Expected: PASS

- [ ] **Step 4: Commit the module extraction slice**

```bash
git add src/heartbeat/index.js src/heartbeat/prompt.js src/heartbeat.js
git commit -m "refactor(heartbeat): split runtime modules"
```

---

### Task 4: Run Regression And Verify Plan Boundaries

**Files:**
- Test: `test/heartbeat-bootstrap.test.js`
- Test: `test/heartbeat-boundary.test.js`
- Test: `test/smoke.test.js`

- [ ] **Step 1: Run the heartbeat-focused regression suite**

Run:

```bash
node --test test/heartbeat-bootstrap.test.js test/heartbeat-boundary.test.js
```

Expected: PASS with 0 failures.

- [ ] **Step 2: Run the smoke suite**

Run:

```bash
npm test -- --test-name-pattern='smoke|heartbeat boundary|heartbeat bootstrap'
```

Expected: PASS. `smoke.test.js` should continue skipping direct heartbeat module loading if that skip already exists.

- [ ] **Step 3: Review scope control**

Run:

```bash
git diff --stat HEAD~3..HEAD
```

Expected: only heartbeat modules, heartbeat entry wiring, and heartbeat tests changed. No `jobs`, `scheduler`, or deployment architecture changes.

- [ ] **Step 4: Commit the final verification checkpoint if needed**

If the previous task commits already cover the whole slice, skip this step. Otherwise:

```bash
git add test/heartbeat-bootstrap.test.js test/heartbeat-boundary.test.js
git commit -m "test(heartbeat): cover bootstrap and orphan boundaries"
```

---

## Self-Review

- Spec coverage:
  - Startup safety: Task 1
  - Safer orphan cleanup: Task 2
  - Internal module split: Task 3
  - Keep OpenMist-specific role and avoid `jobs/scheduler`: Task 4 scope control
- Placeholder scan:
  - No `TBD`, `TODO`, or implicit “write tests later” steps remain
  - Every code-changing step includes concrete code
- Type consistency:
  - `ensureHeartbeatLogFile()`, `createHeartbeatLogger()`, `buildOrphanPatterns()`, `cleanOrphans()`, `buildHeartbeatPrompt()`, and `startHeartbeat()` are defined before they are referenced in later tasks
