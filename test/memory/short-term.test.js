'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ShortTermMemory } = require('../../src/memory/short-term');

// Test instance method via prototype
const stm = Object.create(ShortTermMemory.prototype);

describe('ShortTermMemory.calculateRelevance', () => {
  const baseConv = {
    tags: ['nginx', 'deploy'],
    summary: { entities: ['systemd', 'feishu-bot'] },
    endTime: new Date().toISOString(),
  };

  it('returns high score for matching tags', () => {
    const score = stm.calculateRelevance(baseConv, ['nginx', 'deploy']);
    assert.ok(score > 0.5, `expected > 0.5, got ${score}`);
  });

  it('returns low score for unrelated keywords', () => {
    const score = stm.calculateRelevance(baseConv, ['python', 'tensorflow']);
    // Only time component contributes
    assert.ok(score < 0.3, `expected < 0.3, got ${score}`);
  });

  it('decays score for old conversations', () => {
    const oldConv = {
      ...baseConv,
      endTime: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    };
    const recentScore = stm.calculateRelevance(baseConv, ['nginx']);
    const oldScore = stm.calculateRelevance(oldConv, ['nginx']);
    assert.ok(recentScore > oldScore, 'recent should score higher than old');
  });
});
