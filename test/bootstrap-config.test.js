'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  formatEnvValue,
  applyEnvUpdates,
} = require('../src/config/env-file');

const {
  extractLarkAppConfig,
  buildLarkEnvUpdates,
} = require('../scripts/bootstrap-config');

test('formatEnvValue quotes unsafe values for shell-safe .env output', () => {
  assert.equal(formatEnvValue('simple-value_123'), 'simple-value_123');
  assert.equal(formatEnvValue('value with spaces'), '"value with spaces"');
  assert.equal(formatEnvValue("{'source': 'keychain', 'id': 'appsecret'}"), '"{\'source\': \'keychain\', \'id\': \'appsecret\'}"');
});

test('applyEnvUpdates writes quoted values into .env content', () => {
  const result = applyEnvUpdates('FOO=bar\n', {
    FEISHU_APP_SECRET: "{'source': 'keychain', 'id': 'appsecret'}",
    ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
  });

  assert.match(result, /^FOO=bar/m);
  assert.match(result, /^FEISHU_APP_SECRET="\{'source': 'keychain', 'id': 'appsecret'\}"$/m);
  assert.match(result, /^ANTHROPIC_BASE_URL=https:\/\/api\.minimaxi\.com\/anthropic$/m);
});

test('extractLarkAppConfig supports raw apps-array config shape', () => {
  const config = {
    apps: [
      { appId: 'cli_old', appSecret: 'old_secret' },
      { appId: 'cli_new', appSecret: 'new_secret' },
    ],
  };

  assert.deepEqual(extractLarkAppConfig(config), {
    appId: 'cli_new',
    appSecret: 'new_secret',
  });
});

test('extractLarkAppConfig supports flat config shape', () => {
  const config = {
    appId: 'cli_flat',
    appSecret: 'flat_secret',
  };

  assert.deepEqual(extractLarkAppConfig(config), {
    appId: 'cli_flat',
    appSecret: 'flat_secret',
  });
});

test('extractLarkAppConfig rejects masked or reference-like app secrets', () => {
  assert.throws(() => extractLarkAppConfig({
    appId: 'cli_bad',
    appSecret: '****',
  }), /plain appSecret/i);

  assert.throws(() => extractLarkAppConfig({
    appId: 'cli_bad',
    appSecret: "{'source': 'keychain', 'id': 'appsecret'}",
  }), /plain appSecret/i);

  assert.throws(() => extractLarkAppConfig({
    appId: 'cli_bad',
    appSecret: { source: 'keychain', id: 'appsecret' },
  }), /plain appSecret/i);
});

test('buildLarkEnvUpdates maps app config and owner id to OpenMist env vars', () => {
  const updates = buildLarkEnvUpdates(
    { appId: 'cli_app', appSecret: 'plain_secret' },
    { userOpenId: 'ou_owner' },
  );

  assert.deepEqual(updates, {
    FEISHU_APP_ID: 'cli_app',
    FEISHU_APP_SECRET: 'plain_secret',
    FEISHU_OWNER_ID: 'ou_owner',
  });
});

test('check-config rejects reference-like Feishu app secrets', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-config-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'check-config.sh'),
    path.join(scriptsDir, 'check-config.sh'),
  );

  fs.writeFileSync(path.join(tempRoot, '.env.example'), 'FEISHU_APP_SECRET=your_app_secret\n');
  fs.writeFileSync(path.join(tempRoot, '.env'), [
    'ANTHROPIC_API_KEY=sk-test',
    'FEISHU_APP_ID=cli_app',
    'FEISHU_APP_SECRET="{\'source\': \'keychain\', \'id\': \'appsecret\'}"',
  ].join('\n'));

  const result = spawnSync('bash', [path.join(scriptsDir, 'check-config.sh')], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /plain app secret|reference-like|partially configured/i);
});

test('check-config rejects partially configured WeCom channels', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-wecom-config-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'check-config.sh'),
    path.join(scriptsDir, 'check-config.sh'),
  );

  fs.writeFileSync(path.join(tempRoot, '.env.example'), 'WECOM_CORP_ID=your_corp_id\n');
  fs.writeFileSync(path.join(tempRoot, '.env'), [
    'ANTHROPIC_API_KEY=sk-test',
    'WECOM_CORP_ID=corp_id',
    'WECOM_AGENT_ID=1000001',
    'WECOM_AGENT_SECRET=agent_secret',
  ].join('\n'));

  const result = spawnSync('bash', [path.join(scriptsDir, 'check-config.sh')], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /WeCom app channel is partially configured/i);
  assert.match(result.stdout, /WECOM_TOKEN/i);
  assert.match(result.stdout, /WECOM_ENCODING_AES_KEY/i);
});

test('check-config treats inline-comment empty auth values as missing', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-auth-config-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'check-config.sh'),
    path.join(scriptsDir, 'check-config.sh'),
  );

  fs.writeFileSync(path.join(tempRoot, '.env.example'), [
    'ANTHROPIC_AUTH_TOKEN=                 # Claude Code / Anthropic-compatible providers can also use this token env',
    'ANTHROPIC_BASE_URL=                   # Optional, e.g. https://api.minimaxi.com/anthropic',
    'CLAUDE_MODEL=',
    'RECOMMEND_MODEL=',
  ].join('\n'));
  fs.writeFileSync(path.join(tempRoot, '.env'), fs.readFileSync(path.join(tempRoot, '.env.example')));

  const result = spawnSync('bash', [path.join(scriptsDir, 'check-config.sh')], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Anthropic-compatible API credential.*required/i);
});

test('check-config warns when WEB_PORT is missing for instance config', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-web-port-config-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'check-config.sh'),
    path.join(scriptsDir, 'check-config.sh'),
  );

  fs.writeFileSync(path.join(tempRoot, '.env.example'), 'WEB_PORT=3003\n');
  fs.writeFileSync(path.join(tempRoot, '.env'), [
    'ANTHROPIC_API_KEY=sk-test',
    'SERVICE_NAME=openmist-clawtest.service',
    'APP_USER=clawtest',
    'PROJECT_DIR=/home/clawtest/open-mist',
  ].join('\n'));

  const result = spawnSync('bash', [path.join(scriptsDir, 'check-config.sh')], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WEB_PORT missing/i);
});
