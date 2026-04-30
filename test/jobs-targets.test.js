'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OwnerTargets } = require('../src/jobs/targets');

describe('OwnerTargets', () => {
  let tempRoot;
  let targetsPath;
  let targets;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-targets-'));
    targetsPath = path.join(tempRoot, 'private', 'owner-targets.json');
    targets = new OwnerTargets({ filePath: targetsPath });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns an empty map and null lookups when the file is missing', () => {
    assert.deepEqual(targets.loadAll(), {});
    assert.equal(targets.get('owner-a'), null);
  });

  it('loads a private owner target map from JSON and resolves exact owner ids', () => {
    fs.mkdirSync(path.dirname(targetsPath), { recursive: true });
    fs.writeFileSync(
      targetsPath,
      JSON.stringify({
        'owner-a': { channel: 'feishu', target: 'chat-a' },
        'owner-b': { channel: 'wecom', target: 'room-b' },
      }),
      'utf8'
    );

    assert.deepEqual(targets.loadAll(), {
      'owner-a': { channel: 'feishu', target: 'chat-a' },
      'owner-b': { channel: 'wecom', target: 'room-b' },
    });
    assert.deepEqual(targets.get('owner-b'), { channel: 'wecom', target: 'room-b' });
    assert.equal(targets.get('missing-owner'), null);
  });
});
