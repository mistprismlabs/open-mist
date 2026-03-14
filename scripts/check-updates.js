#!/usr/bin/env node

/**
 * 更新检查脚本 — cron 每天 5:00 运行
 *
 * 检查 3 个源：Claude Code CLI、Agent SDK、OpenMist 仓库
 * 有更新 → 写 data/updates/available.json + 发飞书通知卡片
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
const UPDATES_DIR = path.join(PROJECT_DIR, 'data', 'updates');
const AVAILABLE_FILE = path.join(UPDATES_DIR, 'available.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: PROJECT_DIR,
      timeout: 30_000,
      encoding: 'utf-8',
      env: { ...process.env, ALL_PROXY: 'socks5://127.0.0.1:7890' },
      ...opts,
    }).trim();
  } catch (err) {
    log(`Command failed: ${cmd} — ${err.message}`);
    return null;
  }
}

function checkClaudeCLI() {
  const current = exec('claude --version');
  if (!current) return null;

  const latest = exec('npm view @anthropic-ai/claude-code version');
  if (!latest) return null;

  if (current.includes(latest)) return null;

  return {
    source: 'claude-cli',
    label: 'Claude Code CLI',
    current: current.replace(/\n/g, ' ').trim(),
    latest,
  };
}

function checkAgentSDK() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8'));
    const currentSpec = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
    if (!currentSpec) return null;

    // 读取实际安装版本
    const installedPkg = path.join(PROJECT_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
    let current = 'unknown';
    if (fs.existsSync(installedPkg)) {
      current = JSON.parse(fs.readFileSync(installedPkg, 'utf-8')).version;
    }

    const latest = exec('npm view @anthropic-ai/claude-agent-sdk version');
    if (!latest || current === latest) return null;

    return {
      source: 'agent-sdk',
      label: 'Agent SDK',
      current,
      latest,
    };
  } catch {
    return null;
  }
}

function checkRepo() {
  // 先 fetch
  exec('git fetch origin main');

  const local = exec('git rev-parse HEAD');
  const remote = exec('git rev-parse origin/main');
  if (!local || !remote || local === remote) return null;

  // 统计差异
  const behind = exec('git rev-list HEAD..origin/main --count');

  return {
    source: 'repo',
    label: 'OpenMist 仓库',
    current: local.substring(0, 8),
    latest: remote.substring(0, 8),
    behind: parseInt(behind) || 0,
  };
}

async function sendNotification(updates) {
  const lines = updates.map(u => {
    if (u.source === 'repo') {
      return `- **${u.label}**: ${u.current} → ${u.latest}（落后 ${u.behind} 个提交）`;
    }
    return `- **${u.label}**: ${u.current} → ${u.latest}`;
  });

  const message = `[更新检查] 发现 ${updates.length} 个可用更新：\n${lines.join('\n')}\n\n请在飞书中发送 /update 查看详情并批准更新。`;

  try {
    const { execFileSync } = require('child_process');
    execFileSync('node', ['scripts/send-notify.js', message], {
      cwd: PROJECT_DIR,
      timeout: 15_000,
    });
    log('通知已发送');
  } catch (err) {
    log(`通知发送失败: ${err.message}`);
  }
}

async function main() {
  log('开始检查更新...');

  if (!fs.existsSync(UPDATES_DIR)) {
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
  }

  const updates = [];

  const cli = checkClaudeCLI();
  if (cli) { updates.push(cli); log(`Claude CLI: ${cli.current} → ${cli.latest}`); }

  const sdk = checkAgentSDK();
  if (sdk) { updates.push(sdk); log(`Agent SDK: ${sdk.current} → ${sdk.latest}`); }

  const repo = checkRepo();
  if (repo) { updates.push(repo); log(`仓库: ${repo.current} → ${repo.latest} (behind ${repo.behind})`); }

  if (updates.length === 0) {
    log('全部是最新版本');
    // 清理旧的 available 文件
    if (fs.existsSync(AVAILABLE_FILE)) fs.unlinkSync(AVAILABLE_FILE);
    return;
  }

  // 写入 available.json
  const data = {
    checkedAt: new Date().toISOString(),
    updates: updates.map(u => ({ ...u, approved: false })),
  };
  fs.writeFileSync(AVAILABLE_FILE, JSON.stringify(data, null, 2));
  log(`写入 ${AVAILABLE_FILE}`);

  // 发送通知
  await sendNotification(updates);

  log(`检查完成，发现 ${updates.length} 个更新`);
}

main().catch(err => {
  log(`检查失败: ${err.message}`);
  process.exit(1);
});
