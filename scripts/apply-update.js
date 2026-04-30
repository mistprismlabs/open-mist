#!/usr/bin/env node

/**
 * 更新执行脚本 — cron 每 5 分钟轮询
 *
 * 读取 data/updates/available.json，执行已批准的更新
 * 更新完成后写 last-update.json，bot 重启时读取并发通知
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = process.env.SERVICE_NAME || 'openmist.service';
const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const UPDATES_DIR = path.join(PROJECT_DIR, 'data', 'updates');

const AVAILABLE_FILE = path.join(UPDATES_DIR, 'available.json');
const LAST_UPDATE_FILE = path.join(UPDATES_DIR, 'last-update.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function exec(cmd) {
  try {
    return execSync(cmd, {
      cwd: PROJECT_DIR,
      timeout: 120_000,
      encoding: 'utf-8',
      env: { ...process.env, ALL_PROXY: 'socks5://127.0.0.1:7890' },
    }).trim();
  } catch (err) {
    log(`Command failed: ${cmd} — ${err.message}`);
    return null;
  }
}

function main() {
  if (!fs.existsSync(AVAILABLE_FILE)) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(AVAILABLE_FILE, 'utf-8'));
  } catch {
    return;
  }

  const approved = (data.updates || []).filter(u => u.approved);
  if (approved.length === 0) return;

  log(`发现 ${approved.length} 个已批准的更新`);

  const results = [];
  let needRestart = false;

  for (const update of approved) {
    log(`执行更新: ${update.label} (${update.source})`);

    if (update.source === 'claude-cli') {
      const out = exec('npm install -g @anthropic-ai/claude-code@latest');
      if (out !== null) {
        results.push({ source: update.source, label: update.label, success: true, from: update.current, to: update.latest });
        log(`Claude CLI 更新成功`);
      } else {
        results.push({ source: update.source, label: update.label, success: false });
        log(`Claude CLI 更新失败`);
      }
    }

    if (update.source === 'agent-sdk') {
      const out = exec('npm install @anthropic-ai/claude-agent-sdk@latest');
      if (out !== null) {
        results.push({ source: update.source, label: update.label, success: true, from: update.current, to: update.latest });
        needRestart = true;
        log(`Agent SDK 更新成功`);
      } else {
        results.push({ source: update.source, label: update.label, success: false });
        log(`Agent SDK 更新失败`);
      }
    }

    if (update.source === 'repo') {
      const pullOut = exec('git pull origin main');
      if (pullOut !== null) {
        exec('npm install');
        results.push({ source: update.source, label: update.label, success: true, from: update.current, to: update.latest });
        needRestart = true;
        log(`仓库更新成功`);
      } else {
        results.push({ source: update.source, label: update.label, success: false });
        log(`仓库更新失败`);
      }
    }
  }

  // 写完成标记
  const lastUpdate = {
    completedAt: new Date().toISOString(),
    results,
    notified: false,
  };
  fs.writeFileSync(LAST_UPDATE_FILE, JSON.stringify(lastUpdate, null, 2));

  // 清理 available.json
  fs.unlinkSync(AVAILABLE_FILE);

  log(`更新完成: ${results.filter(r => r.success).length}/${results.length} 成功`);

  // 重启服务
  if (needRestart) {
    log(`需要重启 ${SERVICE_NAME}...`);
    try {
      execSync(`sudo systemctl restart ${SERVICE_NAME}`, { timeout: 30_000 });
      log('服务重启成功');
    } catch (err) {
      log(`服务重启失败: ${err.message}`);
    }
  }
}

main();
