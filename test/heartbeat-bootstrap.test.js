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
