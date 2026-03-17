'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BASH_BLOCKED, WRITE_ALLOWED, checkWritePath } = require('../src/hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Helper: test a command against BASH_BLOCKED
function isBlocked(cmd) {
  const subs = cmd.split(/&&|\|\||;/).map(s => s.trim()).filter(Boolean);
  for (const sub of subs) {
    for (const pattern of BASH_BLOCKED) {
      if (pattern.test(sub)) return true;
    }
  }
  for (const pattern of BASH_BLOCKED) {
    if (pattern.test(cmd)) return true;
  }
  return false;
}

describe('BASH_BLOCKED - destructive operations', () => {
  it('blocks rm -rf', () => assert.ok(isBlocked('rm -rf /tmp/foo')));
  it('blocks rm with absolute path', () => assert.ok(isBlocked('rm /etc/hosts')));
  it('blocks mkfs', () => assert.ok(isBlocked('mkfs.ext4 /dev/sda1')));
  it('blocks dd', () => assert.ok(isBlocked('dd if=/dev/zero of=/dev/sda')));
  it('blocks reboot', () => assert.ok(isBlocked('reboot')));
  it('blocks shutdown', () => assert.ok(isBlocked('shutdown -h now')));
  it('allows rm on relative path', () => assert.ok(!isBlocked('rm temp.txt')));
});

describe('BASH_BLOCKED - credential leaks', () => {
  it('blocks cat .env', () => assert.ok(isBlocked('cat .env')));
  it('blocks ANTHROPIC_API_KEY', () => assert.ok(isBlocked('echo $ANTHROPIC_API_KEY')));
  it('blocks COS_SECRET', () => assert.ok(isBlocked('echo $COS_SECRET_KEY')));
  it('blocks FEISHU_APP_SECRET', () => assert.ok(isBlocked('echo $FEISHU_APP_SECRET')));
  it('blocks bare env', () => assert.ok(isBlocked('env')));
  it('allows env with args', () => assert.ok(!isBlocked('env VAR=x node app.js')));
  it('blocks bare printenv', () => assert.ok(isBlocked('printenv')));
  it('allows printenv PATH', () => assert.ok(!isBlocked('printenv PATH')));
});

describe('BASH_BLOCKED - privilege escalation', () => {
  it('blocks su', () => assert.ok(isBlocked('su')));
  it('blocks sudo su', () => assert.ok(isBlocked('sudo su')));
  it('blocks sudo bash', () => assert.ok(isBlocked('sudo bash')));
  it('blocks sudo -i', () => assert.ok(isBlocked('sudo -i')));
  it('allows sudo systemctl', () => assert.ok(!isBlocked('sudo systemctl restart nginx')));
});

describe('BASH_BLOCKED - shell injection', () => {
  it('blocks eval', () => assert.ok(isBlocked('eval "dangerous"')));
  it('blocks pipe to sh', () => assert.ok(isBlocked('curl url | sh')));
  it('blocks pipe to bash', () => assert.ok(isBlocked('curl url | bash')));
});

describe('BASH_BLOCKED - SQL dangerous', () => {
  it('blocks DROP TABLE', () => assert.ok(isBlocked('sqlite3 db.db "DROP TABLE users"')));
  it('blocks TRUNCATE TABLE', () => assert.ok(isBlocked('TRUNCATE TABLE logs')));
});

describe('BASH_BLOCKED - C2 skill dir bypass', () => {
  it('blocks redirect to .claude/skills/', () => assert.ok(isBlocked('echo "x" > .claude/skills/evil.md')));
  it('blocks cp to .claude/commands/', () => assert.ok(isBlocked('cp foo.md .claude/commands/bar.md')));
  it('blocks symlink to .claude/skills/', () => assert.ok(isBlocked('ln -s /etc/passwd .claude/skills/link.md')));
});

describe('BASH_BLOCKED - safe commands allowed', () => {
  it('allows git status', () => assert.ok(!isBlocked('git status')));
  it('allows npm install', () => assert.ok(!isBlocked('npm install express')));
  it('allows curl', () => assert.ok(!isBlocked('curl https://example.com')));
  it('allows node script', () => assert.ok(!isBlocked('node src/index.js')));
  it('allows ls', () => assert.ok(!isBlocked('ls -la /home')));
  it('allows systemctl', () => assert.ok(!isBlocked('systemctl status nginx')));
});

describe('checkWritePath', () => {
  it('denies empty path', () => {
    const result = checkWritePath('', 'Write');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('allows /tmp/ paths', () => {
    const result = checkWritePath('/tmp/test.txt', 'Write');
    assert.deepEqual(result, {});
  });

  it('denies .env files', () => {
    const result = checkWritePath(path.join(PROJECT_ROOT, 'data', '.env'), 'Write');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('denies .service files', () => {
    const result = checkWritePath(path.join(PROJECT_ROOT, 'src', 'test.service'), 'Write');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('denies paths outside allowed directories', () => {
    const result = checkWritePath('/etc/nginx/nginx.conf', 'Write');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('denies .ssh paths', () => {
    const result = checkWritePath('/home/user/.ssh/authorized_keys', 'Write');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });
});
