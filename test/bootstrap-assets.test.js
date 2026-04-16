const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const deployDocPath = path.join(root, 'docs', 'deploy.md');
const checkRuntimePath = path.join(root, 'scripts', 'check-runtime.sh');
const checkConfigPath = path.join(root, 'scripts', 'check-config.sh');
const checkServicePath = path.join(root, 'scripts', 'check-service.sh');
const bootstrapConfigPath = path.join(root, 'scripts', 'bootstrap-config.js');
const bootstrapUserPath = path.join(root, 'scripts', 'bootstrap-user.sh');
const bootstrapRuntimePath = path.join(root, 'scripts', 'bootstrap-runtime.sh');
const bootstrapServicePath = path.join(root, 'scripts', 'bootstrap-service.sh');
const bootstrapSkillPath = path.join(root, '.claude', 'skills', 'openmist-bootstrap.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('bootstrap assets exist and mention first-time server prerequisites', () => {
  for (const filePath of [deployDocPath, checkRuntimePath, checkConfigPath, checkServicePath, bootstrapConfigPath, bootstrapUserPath, bootstrapRuntimePath, bootstrapServicePath, bootstrapSkillPath]) {
    assert.ok(fs.existsSync(filePath), `${path.relative(root, filePath)} should exist`);
  }

  const deployDoc = read(deployDocPath);
  assert.match(deployDoc, /Ubuntu/i);
  assert.match(deployDoc, /ssh\s+<user>@<host>|ssh\s+\$\{?user\}?@/i);
  assert.match(deployDoc, /sudo/i);
  assert.match(deployDoc, /Claude Code CLI|claude/i);
  assert.match(deployDoc, /Lark CLI|lark-cli/i);
  assert.match(deployDoc, /cp\s+\.env\.example\s+\.env/i);
  assert.match(deployDoc, /check-runtime\.sh/);
  assert.match(deployDoc, /check-config\.sh/);
  assert.match(deployDoc, /check-service\.sh/);
  assert.match(deployDoc, /bootstrap-config\.js/);
  assert.match(deployDoc, /bootstrap-user\.sh/);
  assert.match(deployDoc, /bootstrap-runtime\.sh/);
  assert.match(deployDoc, /bootstrap-service\.sh/);
});

test('bootstrap shell scripts are syntactically valid and perform expected checks', () => {
  for (const filePath of [checkRuntimePath, checkConfigPath, checkServicePath, bootstrapUserPath, bootstrapRuntimePath, bootstrapServicePath]) {
    const result = spawnSync('bash', ['-n', filePath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `${path.basename(filePath)} should pass bash -n`);
  }

  const runtimeScript = read(checkRuntimePath);
  assert.match(runtimeScript, /node/);
  assert.match(runtimeScript, /npm/);
  assert.match(runtimeScript, /git/);
  assert.match(runtimeScript, /claude/);
  assert.match(runtimeScript, /lark/i);
  assert.match(runtimeScript, /systemctl/);

  const configScript = read(checkConfigPath);
  assert.match(configScript, /\.env\.example/);
  assert.match(configScript, /\.env/);
  assert.match(configScript, /FEISHU_APP_ID/);
  assert.match(configScript, /FEISHU_APP_SECRET/);
  assert.match(configScript, /WECOM_CORP_ID/);
  assert.match(configScript, /WECOM_AGENT_ID/);
  assert.match(configScript, /WECOM_AGENT_SECRET/);
  assert.match(configScript, /WECOM_TOKEN/);
  assert.match(configScript, /WECOM_ENCODING_AES_KEY/);
  assert.match(configScript, /WECOM_BOT_ID/);
  assert.match(configScript, /WECOM_BOT_SECRET/);
  assert.match(configScript, /ANTHROPIC_API_KEY/);
  assert.match(configScript, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(configScript, /ANTHROPIC_BASE_URL/);
  assert.match(configScript, /WEB_PORT/);
  assert.match(configScript, /is_placeholder_value|your_key|your_app_secret/i);

  const bootstrapConfigScript = read(bootstrapConfigPath);
  assert.match(bootstrapConfigScript, /import-lark/);
  assert.match(bootstrapConfigScript, /FEISHU_APP_SECRET/);
  assert.match(bootstrapConfigScript, /shell-safe|env/i);

  const bootstrapUserScript = read(bootstrapUserPath);
  assert.match(bootstrapUserScript, /useradd/);
  assert.match(bootstrapUserScript, /usermod/);
  assert.match(bootstrapUserScript, /BOOTSTRAP_DRY_RUN/);

  const bootstrapRuntimeScript = read(bootstrapRuntimePath);
  assert.match(bootstrapRuntimeScript, /apt-get install -y git curl build-essential python3 make g\+\+/);
  assert.match(bootstrapRuntimeScript, /@anthropic-ai\/claude-code/);
  assert.match(bootstrapRuntimeScript, /@larksuite\/cli/);
  assert.match(bootstrapRuntimeScript, /setup_\$\{NODE_MAJOR\}\.x|setup_22\.x/);

  const bootstrapServiceScript = read(bootstrapServicePath);
  assert.match(bootstrapServiceScript, /EnvironmentFile=/);
  assert.match(bootstrapServiceScript, /sudo .*tee|sudo .*install|sudo .*mkdir/);
  assert.match(bootstrapServiceScript, /NODE_BIN|src\/index\.js/);
  assert.match(bootstrapServiceScript, /systemctl daemon-reload/);
  assert.match(bootstrapServiceScript, /BOOTSTRAP_SKIP_SYSTEMCTL/);

  const serviceScript = read(checkServicePath);
  assert.match(serviceScript, /systemctl/);
  assert.match(serviceScript, /journalctl/);
  assert.match(serviceScript, /Gateway running/);
  assert.match(serviceScript, /WebAdapter|Listening on 127\.0\.0\.1/);
});

test('public bootstrap and check shell scripts are executable', () => {
  for (const filePath of [checkRuntimePath, checkConfigPath, checkServicePath, bootstrapUserPath, bootstrapRuntimePath, bootstrapServicePath]) {
    const mode = fs.statSync(filePath).mode;
    assert.ok((mode & 0o111) !== 0, `${path.basename(filePath)} should be executable`);
  }
});

test('bootstrap skill points agents to the repo docs and check scripts', () => {
  const skill = read(bootstrapSkillPath);
  assert.match(skill, /Ubuntu/i);
  assert.match(skill, /SSH/i);
  assert.match(skill, /docs\/deploy\.md/);
  assert.match(skill, /scripts\/check-runtime\.sh/);
  assert.match(skill, /scripts\/check-config\.sh/);
  assert.match(skill, /scripts\/check-service\.sh/);
  assert.match(skill, /scripts\/bootstrap-user\.sh/);
  assert.match(skill, /scripts\/bootstrap-runtime\.sh/);
  assert.match(skill, /scripts\/bootstrap-service\.sh/);
  assert.match(skill, /阶段|Phase/i);
  assert.match(skill, /暂停|stop|wait/i);
  assert.match(skill, /成功标准|success criteria/i);
  assert.match(skill, /只在必要时|only ask/i);
});

test('deploy doc covers user-local CLI installation details', () => {
  const deployDoc = read(deployDocPath);
  assert.match(deployDoc, /\.local\/bin/);
  assert.match(deployDoc, /npm config set prefix/i);
});

test('deploy doc defines an AI execution protocol with pause points and success gates', () => {
  const deployDoc = read(deployDocPath);

  assert.match(deployDoc, /AI 执行协议|Execution Protocol/i);
  assert.match(deployDoc, /Phase 1|阶段一/i);
  assert.match(deployDoc, /Phase 2|阶段二/i);
  assert.match(deployDoc, /Phase 3|阶段三/i);
  assert.match(deployDoc, /需要用户参与|pause points|暂停点/i);
  assert.match(deployDoc, /成功标准|success criteria/i);
  assert.match(deployDoc, /check-runtime\.sh/);
  assert.match(deployDoc, /check-config\.sh/);
  assert.match(deployDoc, /check-service\.sh/);
});

test('docs and env example mention Anthropic-compatible providers', () => {
  const deployDoc = read(deployDocPath);
  const readme = read(path.join(root, 'README.md'));
  const envExample = read(path.join(root, '.env.example'));

  assert.match(readme, /ANTHROPIC_BASE_URL/);
  assert.match(readme, /MiniMax|兼容提供商|Anthropic 兼容/i);
  assert.match(deployDoc, /ANTHROPIC_BASE_URL/);
  assert.match(deployDoc, /MiniMax|Anthropic 兼容/i);
  assert.match(envExample, /ANTHROPIC_BASE_URL/);
  assert.match(envExample, /ANTHROPIC_AUTH_TOKEN/);
});

test('.env example and deploy doc use the runtime WeCom variable names', () => {
  const deployDoc = read(deployDocPath);
  const envExample = read(path.join(root, '.env.example'));

  assert.match(envExample, /WECOM_AGENT_ID/);
  assert.match(envExample, /WECOM_AGENT_SECRET/);
  assert.match(envExample, /WECOM_TOKEN/);
  assert.match(envExample, /WECOM_ENCODING_AES_KEY/);
  assert.match(envExample, /WECOM_BOT_ID/);
  assert.match(envExample, /WECOM_BOT_SECRET/);
  assert.doesNotMatch(envExample, /WECOM_APP_AGENT_ID|WECOM_APP_SECRET|WECOM_APP_TOKEN|WECOM_APP_ENCODING_AES_KEY|WECOM_BOT_KEY/);
  assert.match(deployDoc, /WECOM_AGENT_ID/);
  assert.match(deployDoc, /WECOM_BOT_ID/);
});

test('.env example and deploy doc mention the instance-specific web port', () => {
  const deployDoc = read(deployDocPath);
  const envExample = read(path.join(root, '.env.example'));

  assert.match(envExample, /WEB_PORT=/);
  assert.match(deployDoc, /WEB_PORT/);
  assert.match(deployDoc, /3003/);
  assert.match(deployDoc, /同机多实例|multiple instances|实例级/i);
});
