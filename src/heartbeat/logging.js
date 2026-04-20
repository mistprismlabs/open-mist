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
