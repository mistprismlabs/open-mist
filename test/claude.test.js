'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJSON, _fixUnescapedQuotes, buildQueryOptions } = require('../src/claude');

describe('_fixUnescapedQuotes', () => {
  it('passes through valid JSON unchanged', () => {
    const input = '{"key": "value"}';
    assert.equal(_fixUnescapedQuotes(input), input);
  });

  it('escapes unescaped quote inside string value', () => {
    const input = '{"key": "he said "hello" today"}';
    const result = _fixUnescapedQuotes(input);
    assert.ok(JSON.parse(result)); // should be parseable now
    assert.equal(JSON.parse(result).key, 'he said "hello" today');
  });

  it('preserves already escaped quotes', () => {
    const input = '{"key": "he said \\"hello\\" today"}';
    const result = _fixUnescapedQuotes(input);
    const parsed = JSON.parse(result);
    assert.equal(parsed.key, 'he said "hello" today');
  });

  it('handles empty string value', () => {
    const input = '{"key": ""}';
    assert.equal(_fixUnescapedQuotes(input), input);
  });

  it('handles multiple keys', () => {
    const input = '{"a": "1", "b": "2"}';
    assert.equal(_fixUnescapedQuotes(input), input);
  });
});

describe('buildQueryOptions', () => {
  it('does not expose the retired feishu MCP', () => {
    const options = buildQueryOptions('test-model', {});

    assert.ok(!('feishu' in options.mcpServers));
    assert.ok(!options.allowedTools.includes('mcp__feishu__*'));
  });

  it('keeps the remaining MCP servers and core settings', () => {
    const options = buildQueryOptions('test-model', {});

    assert.deepEqual(Object.keys(options.mcpServers).sort(), ['scrapling', 'tencent-cos', 'video-downloader']);
    assert.ok(options.allowedTools.includes('mcp__video-downloader__*'));
    assert.ok(options.allowedTools.includes('mcp__tencent-cos__*'));
    assert.ok(options.allowedTools.includes('mcp__scrapling__*'));
    assert.deepEqual(options.settingSources, ['project', 'user']);
    assert.equal(options.agentProgressSummaries, true);
  });

  it('applies optional effort and resume values', () => {
    const options = buildQueryOptions('test-model', {}, {
      effort: 'high',
      resume: 'session-123',
    });

    assert.equal(options.effort, 'high');
    assert.equal(options.resume, 'session-123');
  });

  it('omits model when no explicit model is provided', () => {
    const options = buildQueryOptions('', {});

    assert.ok(!('model' in options));
  });
});

describe('parseJSON', () => {
  it('parses valid JSON directly', () => {
    const result = parseJSON('{"name": "test"}');
    assert.deepEqual(result, { name: 'test' });
  });

  it('strips markdown code fences', () => {
    const result = parseJSON('```json\n{"name": "test"}\n```');
    assert.deepEqual(result, { name: 'test' });
  });

  it('extracts JSON from surrounding text', () => {
    const result = parseJSON('Here is the result: {"name": "test"}');
    assert.deepEqual(result, { name: 'test' });
  });

  it('parses JSON array', () => {
    const result = parseJSON('[1, 2, 3]');
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('throws on completely invalid input', () => {
    assert.throws(() => parseJSON('not json at all'), /JSON parse failed/);
  });

  it('handles JSON with leading text', () => {
    const result = parseJSON('Here is the JSON {"name": "test"}');
    assert.equal(result.name, 'test');
  });

  it('handles nested objects', () => {
    const input = '{"user": {"name": "test", "age": 30}}';
    const result = parseJSON(input);
    assert.equal(result.user.name, 'test');
    assert.equal(result.user.age, 30);
  });

  it('handles unescaped quotes via _fixUnescapedQuotes fallback', () => {
    // This should be recovered by the _fixUnescapedQuotes fallback
    const input = '{"msg": "he said "hi" ok"}';
    const result = parseJSON(input);
    assert.equal(result.msg, 'he said "hi" ok');
  });
});
