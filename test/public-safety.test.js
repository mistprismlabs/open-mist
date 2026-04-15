'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const FILES = [
  'README.md',
  'README.en.md',
  '.env.example',
  'src/claude.js',
  'src/heartbeat.js',
  'scripts/sync-memory.sh',
  'admin.js',
  'scripts/apply-update.js',
];

const FORBIDDEN_PATTERNS = [
  { label: 'private user path', pattern: /\/home\/jarvis\// },
  { label: 'private host alias', pattern: /\bSYNC_REMOTE:-tencent\b|\bSYNC_REMOTE=.?tencent\b/ },
  { label: 'private service default', pattern: /feishu-bot\.service/ },
  { label: 'private aux service default', pattern: /xuanxue-api\.service/ },
];

describe('public safety', () => {
  for (const relPath of FILES) {
    it(`${relPath} avoids private deployment defaults`, () => {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
      for (const rule of FORBIDDEN_PATTERNS) {
        assert.ok(!rule.pattern.test(content), `${relPath} contains ${rule.label}`);
      }
    });
  }
});
