'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const heartbeatSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'heartbeat.js'),
  'utf8'
);

describe('heartbeat boundary', () => {
  it('does not hardcode instance task log checks', () => {
    const forbiddenLogs = [
      'logs/fetch-hot.log',
      'logs/recommend.log',
      'logs/briefing.log',
      'logs/claude-update.log',
      'logs/update-check.log',
      'logs/cleanup-media.log',
      'logs/digest.log',
      'logs/feishu-bot.log',
    ];

    for (const logName of forbiddenLogs) {
      assert.ok(!heartbeatSource.includes(logName), `heartbeat.js still references ${logName}`);
    }
  });

  it('does not hardcode instance task reruns', () => {
    const forbiddenScripts = [
      'fetch-hot-to-bitable.js',
      'fetch-daily-briefing.js',
      'fetch-github-updates.js',
      'export-daily-digest.js',
    ];

    for (const scriptName of forbiddenScripts) {
      assert.ok(!heartbeatSource.includes(scriptName), `heartbeat.js still references ${scriptName}`);
    }
  });

  it('does not hardcode timezone, model, or nginx path assumptions', () => {
    const forbiddenAssumptions = [
      "timeZone: 'Asia/Shanghai'",
      "'--model', 'claude-sonnet-4-6'",
      "const nginxDir = '/etc/nginx/sites-enabled'",
    ];

    for (const token of forbiddenAssumptions) {
      assert.ok(!heartbeatSource.includes(token), `heartbeat.js still hardcodes ${token}`);
    }
  });
});
