'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'check-service.sh');

function makeFakeCommand(binDir, name, body) {
  const filePath = path.join(binDir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  fs.chmodSync(filePath, 0o755);
}

function runServiceCheck({ serviceState = 'active', activeSince = 'Thu 2026-04-16 09:27:34 CST', journal = '', curlCode = '404', extraEnv = {} } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-service-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(scriptPath, path.join(scriptsDir, 'check-service.sh'));

  makeFakeCommand(binDir, 'systemctl', `
if [[ "$1" == "is-active" ]]; then
  printf '%s\\n' "\${SERVICE_STATE:-inactive}"
  exit 0
fi
if [[ "$1" == "show" ]]; then
  printf '%s\\n' "\${SERVICE_ACTIVE_SINCE:-}"
  exit 0
fi
printf 'ignored\\n'
`);

  makeFakeCommand(binDir, 'journalctl', `
printf '%s' "\${JOURNAL_OUTPUT:-}"
`);

  makeFakeCommand(binDir, 'curl', `
printf '%s' "\${CURL_CODE:-000}"
`);

  const result = spawnSync('bash', [path.join(scriptsDir, 'check-service.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SERVICE_STATE: serviceState,
      SERVICE_ACTIVE_SINCE: activeSince,
      JOURNAL_OUTPUT: journal,
      CURL_CODE: curlCode,
      SERVICE_NAME: 'openmist-test.service',
      WEB_PORT: '3003',
      ...extraEnv,
    },
  });

  return result;
}

test('check-service passes for active service with healthy startup logs', () => {
  const result = runServiceCheck({
    journal: [
      '[VectorStore] Initialized (sqlite-vec ready)',
      '[OpenMist] Gateway running ✓',
      '[WebAdapter] Listening on 127.0.0.1:3003',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /service active/i);
  assert.match(result.stdout, /gateway startup confirmed/i);
  assert.match(result.stdout, /web adapter reachable/i);
  assert.match(result.stdout, /vectorstore initialized/i);
});

test('check-service warns when vector store falls back but service still runs', () => {
  const result = runServiceCheck({
    journal: [
      '[VectorStore] Init failed (falling back to keyword search): module mismatch',
      '[OpenMist] Gateway running ✓',
      '[WebAdapter] Listening on 127.0.0.1:3003',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /keyword search fallback|vectorstore degraded/i);
});

test('check-service fails when systemd service is not active', () => {
  const result = runServiceCheck({
    serviceState: 'inactive',
    journal: '',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /service is not active/i);
});

test('check-service fails when fatal startup error is present', () => {
  const result = runServiceCheck({
    journal: [
      '[OpenMist] Fatal error: bad config',
      '[WebAdapter] Listening on 127.0.0.1:3003',
    ].join('\n'),
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /fatal startup error/i);
});

test('check-service warns when Feishu startup is blocked by platform prerequisites', () => {
  const result = runServiceCheck({
    journal: [
      '[Feishu] Startup blocked by platform prerequisites: verify event subscription, long connection, and platform status. Original error: code: 1000040345 system busy',
      '[OpenMist] Gateway running ✓',
      '[WebAdapter] Listening on 127.0.0.1:3003',
      '[VectorStore] Initialized (sqlite-vec ready)',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /feishu startup blocked by platform prerequisites/i);
});
