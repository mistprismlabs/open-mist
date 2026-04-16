'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WebAdapter } = require('../src/channels/web');

test('WebAdapter.start retains a listening server and stop closes it', async () => {
  const original = process.env.WEB_PORT;
  process.env.WEB_PORT = '0';

  try {
    const adapter = new WebAdapter();
    await adapter.start();

    assert.ok(adapter.server, 'server should be retained on the adapter');
    assert.equal(adapter.server.listening, true);

    await adapter.stop();
    assert.equal(adapter.server.listening, false);
  } finally {
    if (original === undefined) {
      delete process.env.WEB_PORT;
    } else {
      process.env.WEB_PORT = original;
    }
  }
});
