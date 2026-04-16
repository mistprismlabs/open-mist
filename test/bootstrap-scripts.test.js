'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bootstrapUserPath = path.join(root, 'scripts', 'bootstrap-user.sh');
const bootstrapRuntimePath = path.join(root, 'scripts', 'bootstrap-runtime.sh');
const bootstrapServicePath = path.join(root, 'scripts', 'bootstrap-service.sh');

function makeFakeCommand(binDir, name, body) {
  const filePath = path.join(binDir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  fs.chmodSync(filePath, 0o755);
}

test('bootstrap-user.sh creates missing app user in dry-run mode', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-bootstrap-user-'));
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  makeFakeCommand(binDir, 'id', `
if [[ "$1" == "-u" ]]; then
  exit 1
fi
if [[ "$1" == "-nG" ]]; then
  printf 'users\n'
  exit 0
fi
exit 1
`);

  const result = spawnSync('bash', [bootstrapUserPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      APP_USER: 'clawtest',
      APP_HOME: '/home/clawtest',
      BOOTSTRAP_DRY_RUN: '1',
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /useradd --create-home --shell \/bin\/bash clawtest/);
  assert.match(result.stdout, /usermod -aG sudo clawtest/);
  assert.match(result.stdout, /install -d -o clawtest -g clawtest \/home\/clawtest/);
});

test('bootstrap-runtime.sh plans apt and CLI setup in dry-run mode', () => {
  const result = spawnSync('bash', [bootstrapRuntimePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BOOTSTRAP_DRY_RUN: '1',
      FORCE_INSTALL_NODE: '1',
      HOME: '/home/clawtest',
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /apt-get update/);
  assert.match(result.stdout, /apt-get install -y git curl build-essential python3 make g\+\+/);
  assert.match(result.stdout, /deb\.nodesource\.com\/setup_22\.x/);
  assert.match(result.stdout, /npm config set prefix (\/home\/clawtest|~)\/\.local/);
  assert.match(result.stdout, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(result.stdout, /npm install -g @larksuite\/cli/);
});

test('bootstrap-service.sh renders a systemd unit into a custom output directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-bootstrap-service-'));
  const outputDir = path.join(tempRoot, 'systemd');
  fs.mkdirSync(outputDir, { recursive: true });

  const result = spawnSync('bash', [bootstrapServicePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SYSTEMD_OUTPUT_DIR: outputDir,
      BOOTSTRAP_SKIP_SYSTEMCTL: '1',
      SERVICE_NAME: 'openmist-test.service',
      APP_USER: 'clawtest',
      PROJECT_DIR: '/home/clawtest/open-mist',
      ENV_FILE_PATH: '/home/clawtest/open-mist/.env',
      NPM_BIN: '/usr/bin/npm',
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const unitPath = path.join(outputDir, 'openmist-test.service');
  assert.ok(fs.existsSync(unitPath), 'systemd unit should be written');

  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /^User=clawtest$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/clawtest\/open-mist$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/npm start$/m);
  assert.match(unit, /^EnvironmentFile=\/home\/clawtest\/open-mist\/\.env$/m);
});
