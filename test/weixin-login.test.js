'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBotType,
  runPreflightChecks,
  buildBotQrcodeUrl,
  buildQrcodeStatusUrl,
  waitForWeixinLogin,
} = require('../scripts/weixin-login');

describe('weixin native login helpers', () => {
  it('normalizes numeric bot type', () => {
    assert.equal(normalizeBotType(' 3 '), '3');
  });

  it('rejects invalid bot type', () => {
    assert.throws(() => normalizeBotType('abc'), /WEIXIN_BOT_TYPE must be a numeric string/);
  });

  it('runs preflight checks and prepares writable dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-weixin-preflight-'));
    const result = runPreflightChecks({ stateDir: tmp, botType: '3' });
    assert.equal(result.botType, '3');
    assert.equal(result.stateDir, tmp);
    assert.equal(result.accountsDir, path.join(tmp, 'accounts'));
    assert.equal(fs.existsSync(result.stateDir), true);
    assert.equal(fs.existsSync(result.accountsDir), true);
    assert.equal(result.existingCredential, null);
  });

  it('builds qrcode fetch url', () => {
    assert.equal(
      buildBotQrcodeUrl('3'),
      'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3'
    );
  });

  it('builds qrcode status url', () => {
    assert.equal(
      buildQrcodeStatusUrl('https://foo.example/', 'qr token'),
      'https://foo.example/ilink/bot/get_qrcode_status?qrcode=qr%20token'
    );
  });

  it('returns confirmed login payload when poller succeeds', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        status: 'confirmed',
        bot_token: 'bot-token',
        ilink_bot_id: 'bot-id',
        baseurl: 'https://redirect.example',
        ilink_user_id: 'user-id',
      }),
    });

    try {
      const result = await waitForWeixinLogin({
        session: { qrcode: 'qr-1', apiBaseUrl: 'https://ilinkai.weixin.qq.com' },
        timeoutMs: 1_000,
      });
      assert.equal(result.connected, true);
      assert.equal(result.botToken, 'bot-token');
      assert.equal(result.accountId, 'bot-id');
      assert.equal(result.baseUrl, 'https://redirect.example');
      assert.equal(result.userId, 'user-id');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns expired failure after too many refresh attempts', async () => {
    const originalFetch = global.fetch;
    global.fetch = async url => ({
      ok: true,
      text: async () => String(url).includes('get_bot_qrcode')
        ? JSON.stringify({ qrcode: 'qr-new', qrcode_img_content: 'https://qr.example/new' })
        : JSON.stringify({ status: 'expired' }),
    });

    try {
      const result = await waitForWeixinLogin({
        session: { qrcode: 'qr-1', qrcodeUrl: 'https://qr.example/1', apiBaseUrl: 'https://ilinkai.weixin.qq.com' },
        timeoutMs: 5_000,
      });
      assert.equal(result.connected, false);
      assert.match(result.message, /二维码多次过期/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
