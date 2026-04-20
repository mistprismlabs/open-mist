'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');

function buildOrphanPatterns(appUser) {
  return [
    new RegExp(`^sudo su - ${appUser}`),
    new RegExp(`^su - ${appUser}`),
    /^nano \/etc\//,
    /claude auth login/,
  ];
}

function cleanOrphans({ appUser, logger }) {
  const patterns = buildOrphanPatterns(appUser);

  try {
    const lines = execSync('ps -eo pid,ppid,cmd --no-headers', { timeout: 5_000 })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    const killed = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;

      const [, pid, ppid, cmd] = match;
      if (ppid !== '1') continue;
      if (!patterns.some(re => re.test(cmd))) continue;

      try {
        execFileSync('sudo', ['/usr/bin/kill', '-9', pid], { timeout: 3_000 });
        killed.push(`${pid}(${cmd.slice(0, 35)})`);
      } catch (err) {
        logger?.log?.(`[cleanOrphans] kill ${pid} 已消失: ${err.message}`);
      }
    }

    return killed;
  } catch (err) {
    logger?.log?.(`[cleanOrphans] 执行失败: ${err.message}`);
    return [];
  }
}

function checkMemory(logger) {
  try {
    const out = execSync("free -m | awk '/Mem:/{print $3,$2}'", { timeout: 5_000 })
      .toString()
      .trim();
    const [used, total] = out.split(' ').map(Number);
    return { used, total, pct: Math.round((used / total) * 100) };
  } catch (err) {
    logger?.log?.(`[checkMemory] 读取内存失败: ${err.message}`);
    return null;
  }
}

function checkFilePermissions({ projectDir, appUser }) {
  const alerts = [];

  try {
    const badFiles = execFileSync(
      'find',
      [path.join(projectDir, 'data'), '-not', '-user', appUser, '-type', 'f'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    if (!badFiles) return alerts;

    const files = badFiles.split('\n');
    const memoryFiles = files.filter(file => file.includes('/data/memory/'));
    const topFiles = files.filter(file => !file.includes('/data/memory/'));

    if (memoryFiles.length > 0) {
      try {
        execFileSync(
          'sudo',
          ['/usr/bin/chown', '-R', `${appUser}:${appUser}`, path.join(projectDir, 'data', 'memory')],
          { timeout: 5_000 }
        );
        alerts.push(`[已修复] data/memory/ 权限异常并已修正（${memoryFiles.length}个文件）`);
      } catch (err) {
        alerts.push(`[告警] data/memory/ 权限修复失败: ${err.message}`);
      }
    }

    for (const file of topFiles) {
      try {
        execFileSync('sudo', ['/usr/bin/chown', `${appUser}:${appUser}`, file], { timeout: 5_000 });
        alerts.push(`[已修复] ${path.basename(file)} 权限已修正`);
      } catch (err) {
        alerts.push(`[告警] ${path.basename(file)} 权限修复失败: ${err.message}`);
      }
    }
  } catch {
    return alerts;
  }

  return alerts;
}

function checkVectorStoreWritable({ projectDir, appUser }) {
  const alerts = [];
  const dbPath = path.join(projectDir, 'data', 'memory', 'vectors.db');

  try {
    if (fs.existsSync(dbPath)) {
      fs.accessSync(dbPath, fs.constants.W_OK);
    }
  } catch {
    try {
      execFileSync('sudo', ['/usr/bin/chown', `${appUser}:${appUser}`, dbPath], { timeout: 5_000 });
      alerts.push('[已修复] vectors.db 权限异常并已修正');
    } catch (err) {
      alerts.push(`[告警] vectors.db 不可写且修复失败: ${err.message}`);
    }
  }

  return alerts;
}

function checkSslCertPaths({ nginxEnabledDir, sslCertPath }) {
  const alerts = [];
  if (!nginxEnabledDir || !sslCertPath) return alerts;

  const standardDir = sslCertPath.substring(0, sslCertPath.lastIndexOf('/') + 1);

  try {
    for (const file of fs.readdirSync(nginxEnabledDir)) {
      const filePath = path.join(nginxEnabledDir, file);
      try {
        if (!fs.statSync(filePath).isFile()) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const certLines = content.split('\n').filter(line => line.trim().startsWith('ssl_certificate'));

        for (const line of certLines) {
          if (!line.includes(standardDir)) {
            alerts.push(`[SSL告警] ${file}: 非标准证书路径 → ${line.trim()}`);
          }
        }
      } catch {}
    }
  } catch {
    return alerts;
  }

  return alerts;
}

module.exports = {
  buildOrphanPatterns,
  cleanOrphans,
  checkMemory,
  checkFilePermissions,
  checkVectorStoreWritable,
  checkSslCertPaths,
};
