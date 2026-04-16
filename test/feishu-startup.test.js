'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FeishuStartupError,
  classifyFeishuStartupError,
} = require('../src/channels/feishu-startup');

test('classifyFeishuStartupError marks Feishu platform prerequisite issues', () => {
  const error = classifyFeishuStartupError(new Error('code: 1000040345 system busy'));

  assert.ok(error instanceof FeishuStartupError);
  assert.equal(error.kind, 'platform_prerequisite');
  assert.match(error.message, /event subscription|long connection|open platform/i);
});

test('classifyFeishuStartupError marks PingInterval failures as platform prerequisite issues', () => {
  const error = classifyFeishuStartupError(new TypeError("Cannot read properties of undefined (reading 'PingInterval')"));

  assert.ok(error instanceof FeishuStartupError);
  assert.equal(error.kind, 'platform_prerequisite');
  assert.match(error.message, /platform prerequisites/i);
});

test('classifyFeishuStartupError preserves runtime failures as runtime errors', () => {
  const error = classifyFeishuStartupError(new Error('ECONNREFUSED 127.0.0.1'));

  assert.ok(error instanceof FeishuStartupError);
  assert.equal(error.kind, 'runtime_failure');
  assert.match(error.message, /runtime failure/i);
  assert.match(error.message, /ECONNREFUSED/i);
});
