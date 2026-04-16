'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCardBuilder } = require('../src/channels/feishu-cards');

const PROJECT_ROOT = path.join(__dirname, '..');

function readProjectFile(relPath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('public surface docs', () => {
  it('does not advertise the retired feishu-bitable MCP in runtime-facing docs', () => {
    const docs = [
      readProjectFile('CLAUDE.md'),
      readProjectFile('README.en.md'),
    ];

    for (const content of docs) {
      assert.ok(!content.includes('feishu-bitable'));
    }
  });

  it('does not keep legacy feishu-bot.service references in comparison docs', () => {
    const content = readProjectFile('docs/wechat-mp-api/04-vs-wecom.md');
    assert.ok(!content.includes('feishu-bot.service'));
  });
});

describe('public surface cards', () => {
  const builder = createCardBuilder({
    session: { sessions: {}, get() { return null; }, getHistory() { return []; } },
    gateway: { _getSessionSize() { return 0; } },
    memory: { activeConversations: new Map(), getStats() { return { shortTerm: { totalConversations: 0, entityCount: 0 }, activeConversations: 0 }; } },
    metrics: { summarize() { return { total: 0, hitRate: 0, avgRetrievalMs: 0 }; } },
  });

  it('keeps task help and onboarding defaults generic', () => {
    const taskCard = JSON.stringify(builder.buildTaskCard());
    const onboardingCard = JSON.stringify(builder.buildOnboardingCard());

    assert.ok(!taskCard.includes('Jarvis'));
    assert.ok(!onboardingCard.includes('Jarvis'));
    assert.ok(!onboardingCard.includes('先生'));
  });
});

describe('public surface scripts', () => {
  it('keeps daily briefing script free of private branding and fixed local proxy/model assumptions', () => {
    const content = readProjectFile('scripts/fetch-daily-briefing.js');

    assert.ok(!content.includes('JarvisBriefing/1.0'));
    assert.ok(!content.includes('http://127.0.0.1:7890'));
    assert.ok(!content.includes('claude-haiku-4-5-20251001'));
  });

  it('keeps runtime model selection free of hardcoded model IDs', () => {
    const runtimeFiles = [
      'src/claude.js',
      'src/task-executor.js',
      'src/channels/web.js',
      'src/memory/memory-manager.js',
      'scripts/fetch-github-updates.js',
      'admin.js',
    ];

    for (const file of runtimeFiles) {
      const content = readProjectFile(file);
      assert.ok(!content.includes('claude-opus-4-6'), `${file} should not hardcode claude-opus-4-6`);
      assert.ok(!content.includes('claude-sonnet-4-6'), `${file} should not hardcode claude-sonnet-4-6`);
      assert.ok(!content.includes('claude-haiku-4-5-20251001'), `${file} should not hardcode claude-haiku-4-5-20251001`);
    }
  });
});
