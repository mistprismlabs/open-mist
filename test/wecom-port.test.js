'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WeComAdapter } = require('../src/channels/wecom');

test('WeComAdapter honors WECOM_PORT when provided', () => {
  const original = process.env.WECOM_PORT;
  process.env.WECOM_PORT = '3301';

  try {
    const adapter = new WeComAdapter({ gateway: {} });
    assert.equal(adapter.port, 3301);
  } finally {
    if (original === undefined) {
      delete process.env.WECOM_PORT;
    } else {
      process.env.WECOM_PORT = original;
    }
  }
});
