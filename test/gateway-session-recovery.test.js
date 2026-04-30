'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway');

function createMemoryStub() {
  return {
    activeConversations: new Map(),
    retrieveRelevantMemories: async () => ({ systemMessage: '', recentConversations: [] }),
    startConversation() {},
    recordMessage() {},
    archiveMessage() {},
    recordEntities() {},
    shouldCompress() { return false; },
  };
}

describe('Gateway session recovery', () => {
  it('retries with a fresh session when the stored session no longer exists', async () => {
    const calls = [];
    const session = {
      sessions: {
        chat1: { updatedAt: Date.now() },
      },
      get(chatId) {
        assert.equal(chatId, 'chat1');
        return 'dead-session-id';
      },
      setCalls: [],
      set(chatId, sessionId) {
        this.setCalls.push({ chatId, sessionId });
      },
      clearCalls: [],
      clear(chatId) {
        this.clearCalls.push(chatId);
      },
    };

    const claude = {
      async chat(prompt, sessionId) {
        calls.push({ prompt, sessionId });
        if (sessionId) {
          const err = new Error('No conversation found with session ID: dead-session-id');
          err.sessionId = 'replacement-session-id';
          throw err;
        }
        return { result: 'fresh reply', sessionId: 'new-session-id' };
      },
    };

    const gateway = new Gateway({
      session,
      claude,
      memory: createMemoryStub(),
    });

    gateway._getSessionSize = () => 0;
    gateway._buildEnrichedPrompt = (text) => text;
    gateway._assessEffort = () => 'low';

    const result = await gateway.processMessage({
      chatId: 'chat1',
      text: 'hi',
      mediaFiles: [],
      chatType: 'p2p',
      channelLabel: '飞书私聊',
      senderName: 'Tempest',
      userProfile: { agentName: '小鱼' },
      userId: 'ou_user',
    });

    assert.equal(result.text, 'fresh reply');
    assert.deepEqual(calls, [
      { prompt: 'hi', sessionId: 'dead-session-id' },
      { prompt: 'hi', sessionId: null },
    ]);
    assert.deepEqual(session.clearCalls, ['chat1']);
    assert.deepEqual(session.setCalls, [{ chatId: 'chat1', sessionId: 'new-session-id' }]);
  });
});
