'use strict';

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

      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });

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

      if (result.includes('HEARTBEAT_OK')) {
        logger.log('巡检正常');
      } else {
        logger.log('巡检输出: ' + result.slice(0, 300));
      }
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
