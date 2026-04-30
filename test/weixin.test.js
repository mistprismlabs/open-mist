'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../package.json');
const {
  buildWeixinClientVersion,
  buildWeixinSessionKey,
  extractWeixinText,
  buildWeixinSendMessageBody,
  loadWeixinAccountCredential,
  saveWeixinAccountCredential,
  loadWeixinPollState,
  saveWeixinPollState,
  resolveWeixinPollStatePath,
} = require('../src/channels/weixin');

describe('weixin adapter helpers', () => {
  it('builds uint32 client version from semver', () => {
    assert.equal(buildWeixinClientVersion('1.3.0'), (1 << 16) | (3 << 8));
    assert.equal(buildWeixinClientVersion('2.1.8'), (2 << 16) | (1 << 8) | 8);
  });

  it('extracts text from text item', () => {
    assert.equal(extractWeixinText({
      item_list: [{ type: 1, text_item: { text: '你好微信' } }],
    }), '你好微信');
  });

  it('falls back to voice transcript text', () => {
    assert.equal(extractWeixinText({
      item_list: [{ type: 3, voice_item: { text: '语音转文字' } }],
    }), '语音转文字');
  });

  it('builds direct and group session keys', () => {
    assert.equal(buildWeixinSessionKey({ userId: 'u1', chatId: 'ignored', isGroup: false }), 'weixin:u1');
    assert.equal(buildWeixinSessionKey({ userId: 'u1', chatId: 'g1', isGroup: true }), 'weixin-group:g1');
  });

  it('builds minimal sendmessage payload', () => {
    const payload = buildWeixinSendMessageBody({
      to: 'wxid_123',
      text: 'OK',
      contextToken: 'ctx_abc',
      clientId: 'client_1',
    });

    assert.equal(payload.msg.to_user_id, 'wxid_123');
    assert.equal(payload.msg.client_id, 'client_1');
    assert.equal(payload.msg.message_type, 2);
    assert.equal(payload.msg.message_state, 2);
    assert.equal(payload.msg.context_token, 'ctx_abc');
    assert.equal(payload.msg.item_list[0].type, 1);
    assert.equal(payload.msg.item_list[0].text_item.text, 'OK');
    assert.equal(payload.base_info.channel_version, packageJson.version);
  });

  it('loads stored credential from openmist account dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-weixin-'));
    saveWeixinAccountCredential({
      accountId: 'wx-new',
      token: 'new-token',
      baseUrl: 'https://new.example',
      userId: 'u-new',
      stateDir: tmp,
    });

    const cred = loadWeixinAccountCredential({ stateDir: tmp });
    assert.equal(cred.accountId, 'wx-new');
    assert.equal(cred.token, 'new-token');
    assert.equal(cred.baseUrl, 'https://new.example');
    assert.equal(cred.userId, 'u-new');
  });

  it('persists and reloads poll state by account id', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-weixin-poll-'));
    saveWeixinPollState({
      accountId: 'wx/account:1',
      stateDir: tmp,
      getUpdatesBuf: 'cursor-123',
    });

    const state = loadWeixinPollState({ accountId: 'wx/account:1', stateDir: tmp });
    assert.equal(state.getUpdatesBuf, 'cursor-123');

    const statePath = resolveWeixinPollStatePath({ accountId: 'wx/account:1', stateDir: tmp });
    assert.equal(path.basename(statePath), 'wx_account_1.json');
  });
});
