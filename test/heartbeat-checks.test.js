'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSslCertPaths } = require('../src/heartbeat/checks');

describe('heartbeat SSL checks', () => {
  it('skips unreadable entries and continues scanning the rest of the nginx directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-heartbeat-ssl-'));
    const nginxEnabledDir = path.join(tmp, 'sites-enabled');
    fs.mkdirSync(nginxEnabledDir, { recursive: true });

    fs.writeFileSync(
      path.join(nginxEnabledDir, 'a.conf'),
      'ssl_certificate /etc/ssl/legacy/a.pem;\n'
    );
    fs.mkdirSync(path.join(nginxEnabledDir, 'b-dir'));
    fs.writeFileSync(
      path.join(nginxEnabledDir, 'c.conf'),
      'ssl_certificate /etc/ssl/legacy/c.pem;\n'
    );

    const alerts = checkSslCertPaths({
      nginxEnabledDir,
      sslCertPath: '/etc/letsencrypt/live/example/fullchain.pem',
    });

    assert.deepEqual(alerts, [
      '[SSL告警] a.conf: 非标准证书路径 → ssl_certificate /etc/ssl/legacy/a.pem;',
      '[SSL告警] c.conf: 非标准证书路径 → ssl_certificate /etc/ssl/legacy/c.pem;',
    ]);
  });
});
