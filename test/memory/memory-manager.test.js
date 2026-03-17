'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryManager } = require('../../src/memory/memory-manager');

// Test instance methods via prototype
const mm = Object.create(MemoryManager.prototype);

describe('MemoryManager._extractKeywords', () => {
  it('extracts Chinese and English words', () => {
    const result = mm._extractKeywords('部署 nginx 服务器');
    assert.ok(result.includes('部署'));
    assert.ok(result.includes('nginx'));
    assert.ok(result.includes('服务器'));
  });

  it('filters stop words from word list', () => {
    const result = mm._extractKeywords('这是一个测试');
    assert.ok(!result.includes('是'));
    assert.ok(!result.includes('这'));
  });

  it('extracts code patterns', () => {
    const result = mm._extractKeywords('修改 process.env.NODE_ENV 变量');
    assert.ok(result.some(k => k.includes('process')));
  });

  it('limits to 20 keywords', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `keyword${i}`).join(' ');
    const result = mm._extractKeywords(longText);
    assert.ok(result.length <= 20);
  });
});

describe('MemoryManager._jaccardSimilarity', () => {
  it('returns 1 for identical conversations', () => {
    const conv = { tags: ['a', 'b'], summary: { entities: ['x'] } };
    assert.equal(mm._jaccardSimilarity(conv, conv), 1);
  });

  it('returns 0 for completely different conversations', () => {
    const a = { tags: ['a', 'b'], summary: { entities: ['x'] } };
    const b = { tags: ['c', 'd'], summary: { entities: ['y'] } };
    assert.equal(mm._jaccardSimilarity(a, b), 0);
  });

  it('returns 0 for two empty conversations', () => {
    assert.equal(mm._jaccardSimilarity({}, {}), 0);
  });

  it('returns partial overlap score', () => {
    const a = { tags: ['a', 'b', 'c'], summary: { entities: [] } };
    const b = { tags: ['b', 'c', 'd'], summary: { entities: [] } };
    const sim = mm._jaccardSimilarity(a, b);
    // intersection=2(b,c), union=4(a,b,c,d) → 0.5
    assert.equal(sim, 0.5);
  });
});

describe('MemoryManager._applyTimeDecay', () => {
  it('does not decay high-importance items', () => {
    const items = [{ conv: { importance: 8, endTime: '2020-01-01T00:00:00Z' }, score: 1.0 }];
    const result = mm._applyTimeDecay(items);
    assert.equal(result[0].score, 1.0);
  });

  it('decays old items', () => {
    const recent = { conv: { endTime: new Date().toISOString() }, score: 1.0 };
    const old = { conv: { endTime: '2020-01-01T00:00:00Z' }, score: 1.0 };
    const result = mm._applyTimeDecay([recent, old]);
    assert.ok(result[0].score > result[1].score || result[0].conv === recent.conv);
  });

  it('preserves order by score after decay', () => {
    const now = new Date().toISOString();
    const items = [
      { conv: { endTime: now }, score: 0.9 },
      { conv: { endTime: now }, score: 0.5 },
    ];
    const result = mm._applyTimeDecay(items);
    assert.ok(result[0].score >= result[1].score);
  });
});

describe('MemoryManager._mergeResults', () => {
  it('merges keyword-only results', () => {
    const kw = [{ conv: { conversationId: 'a' }, score: 0.5 }];
    const result = mm._mergeResults(kw, []);
    assert.equal(result.length, 1);
  });

  it('filters low-score results (< 0.10)', () => {
    const kw = [{ conv: { conversationId: 'a' }, score: 0.01 }];
    const result = mm._mergeResults(kw, []);
    assert.equal(result.length, 0);
  });

  it('combines scores for items in both results', () => {
    const conv = { conversationId: 'a' };
    const kw = [{ conv, score: 0.5 }];
    const vec = [{ id: 'a', similarity: 0.8 }];
    // Need shortTerm for vector-only lookups, but for items already in kw it just adds
    const result = mm._mergeResults(kw, vec);
    assert.ok(result[0].score > 0.5 * 0.3); // keyword weight * score
  });
});

describe('MemoryManager._applyMMR', () => {
  it('returns empty for empty input', () => {
    assert.deepEqual(mm._applyMMR([]), []);
  });

  it('returns single item unchanged', () => {
    const items = [{ conv: { tags: ['a'] }, score: 1.0 }];
    const result = mm._applyMMR(items);
    assert.equal(result.length, 1);
  });

  it('selects highest-scoring item first', () => {
    const items = [
      { conv: { tags: ['a'], summary: { entities: [] } }, score: 0.9 },
      { conv: { tags: ['b'], summary: { entities: [] } }, score: 0.5 },
    ];
    const result = mm._applyMMR(items, 0.7, 2);
    assert.equal(result[0].score, 0.9);
  });

  it('respects targetCount', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      conv: { tags: [`tag${i}`], summary: { entities: [] } },
      score: 1 - i * 0.1,
    }));
    const result = mm._applyMMR(items, 0.7, 3);
    assert.equal(result.length, 3);
  });
});
