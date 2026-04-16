'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveChannelBootstrapPlan,
  ChannelConfigError,
} = require('../src/channel-bootstrap');

test('Feishu channel is skipped when credentials are fully absent', () => {
  const plan = resolveChannelBootstrapPlan({});

  assert.deepEqual(plan.feishu, {
    enabled: false,
    reason: 'missing_credentials',
  });
});

test('Feishu channel throws when credentials are partially configured', () => {
  assert.throws(
    () => resolveChannelBootstrapPlan({ FEISHU_APP_ID: 'cli_app' }),
    (error) => {
      assert.ok(error instanceof ChannelConfigError);
      assert.match(error.message, /feishu channel is partially configured/i);
      assert.match(error.message, /FEISHU_APP_ID/i);
      assert.match(error.message, /FEISHU_APP_SECRET/i);
      return true;
    }
  );
});

test('Feishu channel is enabled when both credentials are present', () => {
  const plan = resolveChannelBootstrapPlan({
    FEISHU_APP_ID: 'cli_app',
    FEISHU_APP_SECRET: 'plain_secret',
  });

  assert.deepEqual(plan.feishu, {
    enabled: true,
    reason: 'configured',
  });
});

test('WeCom channel is skipped when both app and bot credentials are absent', () => {
  const plan = resolveChannelBootstrapPlan({});

  assert.deepEqual(plan.wecom, {
    enabled: false,
    reason: 'missing_credentials',
    activeSources: [],
  });
});

test('WeCom channel throws when app credentials are partially configured', () => {
  assert.throws(
    () => resolveChannelBootstrapPlan({
      WECOM_CORP_ID: 'corp_id',
      WECOM_AGENT_ID: '1000001',
      WECOM_AGENT_SECRET: 'agent_secret',
    }),
    (error) => {
      assert.ok(error instanceof ChannelConfigError);
      assert.match(error.message, /wecom app channel is partially configured/i);
      assert.match(error.message, /WECOM_TOKEN/i);
      assert.match(error.message, /WECOM_ENCODING_AES_KEY/i);
      return true;
    }
  );
});

test('WeCom channel throws when bot credentials are partially configured', () => {
  assert.throws(
    () => resolveChannelBootstrapPlan({
      WECOM_BOT_ID: 'bot_id',
    }),
    (error) => {
      assert.ok(error instanceof ChannelConfigError);
      assert.match(error.message, /wecom bot channel is partially configured/i);
      assert.match(error.message, /WECOM_BOT_ID/i);
      assert.match(error.message, /WECOM_BOT_SECRET/i);
      return true;
    }
  );
});

test('WeCom channel is enabled when either app or bot credentials are complete', () => {
  const appOnly = resolveChannelBootstrapPlan({
    WECOM_CORP_ID: 'corp_id',
    WECOM_AGENT_ID: '1000001',
    WECOM_AGENT_SECRET: 'agent_secret',
    WECOM_TOKEN: 'token',
    WECOM_ENCODING_AES_KEY: 'encoding_aes_key',
  });
  assert.deepEqual(appOnly.wecom, {
    enabled: true,
    reason: 'configured',
    activeSources: ['app'],
  });

  const botOnly = resolveChannelBootstrapPlan({
    WECOM_BOT_ID: 'bot_id',
    WECOM_BOT_SECRET: 'bot_secret',
  });
  assert.deepEqual(botOnly.wecom, {
    enabled: true,
    reason: 'configured',
    activeSources: ['bot'],
  });
});
