'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway');

// Test private methods via prototype (no constructor side effects)
const gw = Object.create(Gateway.prototype);

describe('Gateway._assessEffort', () => {
  it('returns low for short simple text', () => {
    assert.equal(gw._assessEffort('你好'), 'low');
  });

  it('returns high for text with code block', () => {
    assert.equal(gw._assessEffort('请看 ```js\nconsole.log()```'), 'high');
  });

  it('returns high for text with file path', () => {
    assert.equal(gw._assessEffort('修改 /src/index.js 文件'), 'high');
  });

  it('returns high for complex keywords', () => {
    assert.equal(gw._assessEffort('帮我部署这个服务'), 'high');
    assert.equal(gw._assessEffort('重构这个模块'), 'high');
    assert.equal(gw._assessEffort('分析一下性能'), 'high');
  });

  it('returns high for long text', () => {
    assert.equal(gw._assessEffort('a'.repeat(201)), 'high');
  });

  it('returns low for medium-short text without complex keywords', () => {
    // < 50 chars, no complex keywords → low
    assert.equal(gw._assessEffort('今天天气不错啊'), 'low');
  });
});

describe('Gateway progress routing', () => {
  it('routes progress events to the notifier that matches the progress target', async () => {
    const feishuCalls = [];
    const weixinCalls = [];
    const gateway = new Gateway({
      session: {
        sessions: {},
        get() { return null; },
        set() {},
        clear() {},
      },
      claude: {
        async chat(_prompt, _sessionId, _mediaFiles, opts = {}) {
          if (opts.onProgress) opts.onProgress('midway');
          return { result: 'ok', sessionId: 'sess-router' };
        },
      },
      memory: {
        retrieveRelevantMemories: async () => ({ systemMessage: '', recentConversations: [] }),
        startConversation() {},
        recordMessage() {},
        archiveMessage() {},
        recordEntities() {},
        shouldCompress() { return false; },
      },
    });

    gateway.registerProgressCallback('feishu', (targetId, info) => {
      if (!targetId.startsWith('feishu:')) return;
      feishuCalls.push({ targetId, info });
    });
    gateway.registerProgressCallback('weixin', (targetId, info) => {
      if (!targetId.startsWith('weixin:')) return;
      weixinCalls.push({ targetId, info });
    });

    await gateway.processMessage({
      chatId: 'weixin:user-1',
      text: 'hi',
      chatType: 'p2p',
      channelLabel: '微信龙虾私聊',
      userId: 'wx-user',
      progressTargetId: 'weixin:user-1',
    });

    assert.deepEqual(feishuCalls, []);
    assert.deepEqual(weixinCalls, [{ targetId: 'weixin:user-1', info: 'midway' }]);
  });

  it('does not forward progress when progressTargetId is missing', async () => {
    const progressCalls = [];
    const chatCalls = [];
    const gateway = new Gateway({
      session: {
        sessions: {},
        get() { return null; },
        set() {},
        clear() {},
      },
      claude: {
        async chat(_prompt, _sessionId, _mediaFiles, opts = {}) {
          if (opts.onProgress) opts.onProgress('midway');
          chatCalls.push(Boolean(opts.onProgress));
          return { result: 'ok', sessionId: 'sess-1' };
        },
      },
      memory: {
        retrieveRelevantMemories: async () => ({ systemMessage: '', recentConversations: [] }),
        startConversation() {},
        recordMessage() {},
        archiveMessage() {},
        recordEntities() {},
        shouldCompress() { return false; },
      },
    });

    gateway.setProgressCallback((targetId, info) => {
      progressCalls.push({ targetId, info });
    });

    const result = await gateway.processMessage({
      chatId: 'wechat-session',
      text: 'hi',
      chatType: 'p2p',
      channelLabel: '微信龙虾私聊',
      userId: 'wx-user',
    });

    assert.equal(result.text, 'ok');
    assert.deepEqual(chatCalls, [false]);
    assert.deepEqual(progressCalls, []);
  });

  it('forwards progress to explicit progress target', async () => {
    const progressCalls = [];
    const gateway = new Gateway({
      session: {
        sessions: {},
        get() { return null; },
        set() {},
        clear() {},
      },
      claude: {
        async chat(_prompt, _sessionId, _mediaFiles, opts = {}) {
          if (opts.onProgress) opts.onProgress('midway');
          return { result: 'ok', sessionId: 'sess-2' };
        },
      },
      memory: {
        retrieveRelevantMemories: async () => ({ systemMessage: '', recentConversations: [] }),
        startConversation() {},
        recordMessage() {},
        archiveMessage() {},
        recordEntities() {},
        shouldCompress() { return false; },
      },
    });

    gateway.setProgressCallback((targetId, info) => {
      progressCalls.push({ targetId, info });
    });

    await gateway.processMessage({
      chatId: 'feishu-chat',
      text: 'hi',
      chatType: 'p2p',
      channelLabel: '飞书私聊',
      userId: 'ou_xxx',
      progressTargetId: 'feishu-chat',
    });

    assert.deepEqual(progressCalls, [{ targetId: 'feishu-chat', info: 'midway' }]);
  });
});

describe('Gateway._extractEntities', () => {
  it('extracts camelCase identifiers', () => {
    const result = gw._extractEntities('修改 processMessage 函数');
    assert.ok(result.includes('processMessage'));
  });

  it('extracts snake_case identifiers', () => {
    const result = gw._extractEntities('检查 user_count 变量');
    assert.ok(result.includes('user_count'));
  });

  it('extracts file paths', () => {
    const result = gw._extractEntities('编辑 /src/hooks.js 文件');
    assert.ok(result.some(e => e.includes('/src/hooks.js')));
  });

  it('extracts tech terms', () => {
    const result = gw._extractEntities('配置 nginx 和 docker');
    assert.ok(result.includes('nginx'));
    assert.ok(result.includes('docker'));
  });

  it('handles multiple text inputs', () => {
    const result = gw._extractEntities('用户问题', '涉及 redis 缓存');
    assert.ok(result.includes('redis'));
  });

  it('limits output to 30 entities', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `var_name_${i}`).join(' ');
    const result = gw._extractEntities(longText);
    assert.ok(result.length <= 30);
  });

  it('filters short identifiers', () => {
    const result = gw._extractEntities('a b ab abc');
    assert.ok(!result.includes('a'));
    assert.ok(!result.includes('ab'));
  });

  it('extracts dotted identifiers', () => {
    const result = gw._extractEntities('调用 process.env.NODE_ENV');
    assert.ok(result.some(e => e.includes('process.env')));
  });
});
