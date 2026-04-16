'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('index startup stays alive when only the web adapter is active', () => {
  const result = spawnSync(process.execPath, ['src/index.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 1500,
    env: {
      ...process.env,
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      WECOM_CORP_ID: '',
      WECOM_AGENT_ID: '',
      WECOM_AGENT_SECRET: '',
      WECOM_TOKEN: '',
      WECOM_ENCODING_AES_KEY: '',
      WECOM_BOT_ID: '',
      WECOM_BOT_SECRET: '',
      WEIXIN_ENABLED: 'false',
      WEB_PORT: '0',
    },
  });

  assert.equal(result.error?.code, 'ETIMEDOUT', result.stdout + result.stderr);
  assert.match(result.stdout, /Gateway running/);
});

test('index startup retains server handles after a forced GC cycle', () => {
  const probe = `
    process.env.FEISHU_APP_ID = '';
    process.env.FEISHU_APP_SECRET = '';
    process.env.WECOM_CORP_ID = '';
    process.env.WECOM_AGENT_ID = '';
    process.env.WECOM_AGENT_SECRET = '';
    process.env.WECOM_TOKEN = '';
    process.env.WECOM_ENCODING_AES_KEY = '';
    process.env.WECOM_BOT_ID = '';
    process.env.WECOM_BOT_SECRET = '';
    process.env.WEIXIN_ENABLED = 'false';
    process.env.WEB_PORT = '0';
    require('./src/index');
    setTimeout(() => {
      if (global.gc) global.gc();
      const handles = process._getActiveHandles().map((h) => h.constructor?.name || typeof h);
      if (!handles.includes('Server')) {
        console.error('HANDLES', handles.join(','));
        process.exit(1);
      }
      process.exit(0);
    }, 300);
  `;

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
    env: process.env,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Gateway running/);
});
