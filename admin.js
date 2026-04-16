#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { parseEnvFile, replaceEnvVar } = require('./src/config/env-file');

const PROJECT_DIR = __dirname;
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const ENV_EXAMPLE = path.join(PROJECT_DIR, '.env.example');
const PKG = require(path.join(PROJECT_DIR, 'package.json'));
const IS_LINUX = process.platform === 'linux';
const SERVICE_NAME = process.env.SERVICE_NAME || 'openmist.service';

// ─── ANSI 颜色（F10: 检测 NO_COLOR / 非 TTY） ───────────────
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code) => useColor ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s;
const green = c('32');
const red = c('31');
const yellow = c('33');
const dim = c('2');
const bold = c('1');
const cyan = c('36');

// ─── 辅助函数 ────────────────────────────────────────────────
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function formatDuration(ms) {
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${mins}分钟`;
  return `${mins}分钟`;
}

function formatBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function progressBar(pct, width = 16) {
  const filled = Math.round(pct * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function isSensitive(key) {
  return /KEY|SECRET|TOKEN|PASSWORD/i.test(key);
}

// 三级配置导航：分类 → 子分类 → 变量
const CONFIG_TREE = [
  { id: 'im', name: 'IM 通道', children: [
    { id: 'feishu', name: '飞书', children: [
      { id: 'feishu-bot', name: '机器人', keys: {
        FEISHU_APP_ID: '应用 ID', FEISHU_APP_SECRET: '应用密钥', FEISHU_OWNER_ID: '管理员 Open ID',
      }},
      { id: 'feishu-bitable', name: '多维表格', keys: {
        BITABLE_APP_TOKEN: '主表 App Token', BITABLE_TABLE_ID: '主表 Table ID',
        CHAT_LOG_APP_TOKEN: '对话日志 App Token', CHAT_LOG_TABLE_ID: '对话日志 Table ID',
        WEIBO_TABLE_ID: '微博热搜表', DOUYIN_TABLE_ID: '抖音热搜表',
        TOUTIAO_TABLE_ID: '头条热搜表', TOPIC_POOL_TABLE_ID: '话题池表',
      }},
    ]},
    { id: 'wecom', name: '企业微信', children: [
      { id: 'wecom-app', name: '应用', keys: {
        WECOM_CORP_ID: '企业 ID', WECOM_AGENT_ID: '应用 ID', WECOM_AGENT_SECRET: '应用密钥',
      }},
      { id: 'wecom-callback', name: '回调 & 机器人', keys: {
        WECOM_TOKEN: '回调 Token', WECOM_ENCODING_AES_KEY: '回调加密 Key',
        WECOM_BOT_TOKEN: '机器人 Token', WECOM_BOT_ENCODING_AES_KEY: '机器人加密 Key',
        WECOM_BOT_KEY: 'Webhook Key',
      }},
    ]},
  ]},
  { id: 'ai', name: 'AI 能力', children: [
    { id: 'claude', name: 'Claude', keys: {
      ANTHROPIC_API_KEY: 'API 密钥（官方）', ANTHROPIC_AUTH_TOKEN: '中转站 Token', ANTHROPIC_BASE_URL: '中转站地址',
      CLAUDE_MODEL: '模型', CLAUDE_PATH: 'CLI 路径', CLAUDE_BIN: 'CLI 二进制路径',
    }},
    { id: 'dashscope', name: '语义记忆 (DashScope)', keys: {
      DASHSCOPE_API_KEY: 'API 密钥',
    }},
  ]},
  { id: 'extra', name: '附加功能', children: [
    { id: 'cos', name: '腾讯云 COS', keys: {
      COS_SECRET_ID: 'Secret ID', COS_SECRET_KEY: 'Secret Key', COS_BUCKET: 'Bucket', COS_REGION: 'Region',
    }},
    { id: 'deploy', name: '网站部署', keys: {
      SITES_DIR: '站点目录', SSL_CERT_PATH: 'SSL 证书路径', SSL_KEY_PATH: 'SSL 密钥路径',
      TASK_DOMAIN: '域名', SITE_BASE_URL: '站点地址',
    }},
    { id: 'download', name: '视频下载', keys: {
      DOWNLOADS_DIR: '下载目录', DOWNLOADS_BASE_URL: '下载地址', YT_DLP_PATH: 'yt-dlp 路径',
    }},
    { id: 'github', name: 'GitHub', keys: {
      GITHUB_TOKEN: 'Personal Access Token', GITHUB_OWNER: '组织/用户名',
    }},
  ]},
  { id: 'system', name: '系统', children: [
    { id: 'notify', name: '通知', keys: {
      NOTIFY_CHAT_ID: '通知群 Chat ID',
    }},
    { id: 'runtime', name: '运行时', keys: {
      PROJECT_DIR: '项目目录', TASKS_DIR: '任务目录', BOT_NAME: '机器人名称',
      TASK_MAX_BUDGET_USD: '任务预算上限 (USD)',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 'Agent Teams',
    }},
  ]},
];

// 扁平化收集所有叶子节点（有 keys 的）
function collectLeaves(nodes) {
  const leaves = [];
  for (const node of nodes) {
    if (node.keys) leaves.push(node);
    if (node.children) leaves.push(...collectLeaves(node.children));
  }
  return leaves;
}
const ALL_LEAVES = collectLeaves(CONFIG_TREE);

// 变量名 → 友好名称
const KEY_LABELS = {};
for (const leaf of ALL_LEAVES) {
  for (const [k, v] of Object.entries(leaf.keys)) KEY_LABELS[k] = v;
}

function friendlyName(key) {
  return KEY_LABELS[key] || key;
}

// 所有已知变量名集合
const ALL_KNOWN_KEYS = new Set(ALL_LEAVES.flatMap(leaf => Object.keys(leaf.keys)));

// ─── 系统状态 ────────────────────────────────────────────────
async function showDashboard() {
  console.log('\n  ' + bold('系统状态'));
  console.log('  ' + dim('────────'));

  // 服务状态
  if (IS_LINUX) {
    const active = run(`systemctl is-active ${SERVICE_NAME}`);
    const timestamp = run(`systemctl show ${SERVICE_NAME} -p ActiveEnterTimestamp --value`);
    let uptime = '';
    if (timestamp) {
      const ms = Date.now() - new Date(timestamp).getTime();
      if (ms > 0) uptime = ` (${formatDuration(ms)})`;
    }
    const status = active === 'active' ? green('● 运行中') : red('● 已停止');
    console.log(`  服务:       ${status}${uptime}`);
  } else {
    console.log(`  服务:       ${dim('仅支持 Linux')}`);
  }

  // 内存
  if (IS_LINUX) {
    const memLine = run("free -m | awk '/^Mem:/ {print $2,$3}'");
    if (memLine) {
      const [total, used] = memLine.split(' ').map(Number);
      const pct = used / total;
      console.log(`  内存:       ${(used/1024).toFixed(1)}G / ${(total/1024).toFixed(1)}G (${Math.round(pct*100)}%)  ${progressBar(pct)}`);
    }
  }

  // 磁盘
  if (IS_LINUX) {
    const dfLine = run("df -BG / | awk 'NR==2 {print $2,$3,$5}'");
    if (dfLine) {
      const parts = dfLine.split(' ');
      const total = parseInt(parts[0]);
      const used = parseInt(parts[1]);
      const pct = used / total;
      console.log(`  磁盘:       ${used}G / ${total}G (${Math.round(pct*100)}%)  ${progressBar(pct)}`);
    }
  }

  console.log('');

  // 对话指标（安全加载）
  try {
    const { MemoryMetrics } = require('./src/memory/metrics.js');
    const metrics = new MemoryMetrics();
    const summary = metrics.summarize(7);
    const todaySummary = metrics.summarize(1);
    console.log(`  今日对话:   ${todaySummary.total} 次`);
    console.log(`  记忆命中率: ${Math.round(summary.hitRate * 100)}% (7天)`);
    if (summary.avgRetrievalMs) console.log(`  平均延迟:   ${Math.round(summary.avgRetrievalMs)}ms`);
  } catch {
    console.log(`  对话指标:   ${dim('不可用')}`);
  }

  // 活跃会话
  try {
    const { SessionStore } = require('./src/session.js');
    const store = new SessionStore();
    const active = Object.values(store.sessions).filter(s => s.sessionId !== null).length;
    console.log(`  活跃会话:   ${active} 个`);
  } catch {
    console.log(`  活跃会话:   ${dim('不可用')}`);
  }

  // 定时任务（F11）
  if (IS_LINUX) {
    const cronCount = run("crontab -l 2>/dev/null | grep -v '^#' | grep -c '.'") || '0';
    console.log(`  定时任务:   ${cronCount} 个`);
  }

  console.log('');
  console.log(`  版本: ${bold(PKG.name)} ${PKG.version} | Node ${process.version}`);
  console.log('');
}

// ─── 配置管理 ────────────────────────────────────────────────
async function showConfig() {
  if (!fs.existsSync(ENV_FILE)) {
    console.log(yellow('\n  未检测到 .env 文件'));
    return;
  }
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const envMap = {};
  parseEnvFile(content).filter(e => e.type === 'var').forEach(e => { envMap[e.key] = e.value; });

  console.log('');
  for (const category of CONFIG_TREE) {
    console.log(`  ${bold(category.name)}`);
    for (const child of category.children) {
      // child 可能是叶子（有 keys）或子分类（有 children）
      const leaves = child.keys ? [child] : (child.children || []);
      for (const leaf of leaves) {
        if (!leaf.keys) continue;
        const activeKeys = Object.keys(leaf.keys).filter(k => envMap[k] !== undefined);
        if (activeKeys.length === 0) continue;
        console.log(`    ${dim('── ' + (child.keys ? child.name : child.name + ' / ' + leaf.name) + ' ──')}`);
        for (const key of activeKeys) {
          const display = isSensitive(key) ? mask(envMap[key]) : envMap[key];
          console.log(`    ${(leaf.keys[key] || key).padEnd(22)} ${display}`);
        }
      }
    }
    console.log('');
  }

  // 不在任何分组中的变量
  const extras = Object.keys(envMap).filter(k => !ALL_KNOWN_KEYS.has(k));
  if (extras.length > 0) {
    console.log(`  ${bold('其他')}`);
    for (const key of extras) {
      const display = isSensitive(key) ? mask(envMap[key]) : envMap[key];
      console.log(`    ${key.padEnd(22)} ${display}`);
    }
    console.log('');
  }
}

async function editConfig() {
  const { select, input, password, confirm } = require('@inquirer/prompts');
  if (!fs.existsSync(ENV_FILE)) {
    console.log(yellow('\n  未检测到 .env 文件'));
    return;
  }
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const envMap = {};
  parseEnvFile(content).filter(e => e.type === 'var').forEach(e => { envMap[e.key] = e.value; });

  // 第一级：选分类（IM 通道 / AI 能力 / 附加功能 / 系统）
  const catChoices = CONFIG_TREE.map(cat => ({ name: cat.name, value: cat.id }));
  const extraKeys = Object.keys(envMap).filter(k => !ALL_KNOWN_KEYS.has(k));
  if (extraKeys.length > 0) catChoices.push({ name: '其他', value: '__other__' });
  catChoices.push({ name: '← 返回', value: 'back' });

  const catId = await select({ message: '选择分类:', choices: catChoices });
  if (catId === 'back') return;

  // 特殊：其他（不在树中的变量）
  if (catId === '__other__') {
    const key = await selectVariable(select, extraKeys, envMap);
    if (key) await editVariable(key, envMap, content, input, password, confirm);
    return;
  }

  const category = CONFIG_TREE.find(c => c.id === catId);

  // 第二级：选子分类（飞书 / 企业微信 / Claude ...）
  const subChoices = category.children.map(sub => ({ name: sub.name, value: sub.id }));
  subChoices.push({ name: '← 返回', value: 'back' });

  const subId = await select({ message: `${category.name} >`, choices: subChoices });
  if (subId === 'back') return;

  const sub = category.children.find(s => s.id === subId);

  // 如果子分类直接有 keys（叶子），直接选变量
  if (sub.keys) {
    const key = await selectVariable(select, Object.keys(sub.keys), envMap);
    if (key) await editVariable(key, envMap, content, input, password, confirm);
    return;
  }

  // 第三级：选叶子节点（机器人 / 多维表格 ...）
  const leafChoices = sub.children.map(leaf => ({ name: leaf.name, value: leaf.id }));
  leafChoices.push({ name: '← 返回', value: 'back' });

  const leafId = await select({ message: `${category.name} > ${sub.name} >`, choices: leafChoices });
  if (leafId === 'back') return;

  const leaf = sub.children.find(l => l.id === leafId);
  const key = await selectVariable(select, Object.keys(leaf.keys), envMap);
  if (key) await editVariable(key, envMap, content, input, password, confirm);
}

async function selectVariable(select, keys, envMap) {
  const varChoices = keys.map(k => {
    const val = envMap[k];
    const display = val !== undefined ? (isSensitive(k) ? mask(val) : val) : dim('未设置');
    return { name: `${friendlyName(k)}  ${dim(display)}`, value: k, description: k };
  });
  varChoices.push({ name: '← 返回', value: 'back' });

  const key = await select({ message: '选择配置项:', choices: varChoices });
  return key === 'back' ? null : key;
}

async function editVariable(key, envMap, content, input, password, confirm) {
  const currentVal = envMap[key] || '';
  console.log(`  ${dim(key)}`);
  console.log(`  当前值: ${isSensitive(key) ? mask(currentVal) : currentVal}`);

  const prompt = isSensitive(key) ? password : input;
  const newValue = await prompt({ message: '新值:' });
  if (!newValue) { console.log(dim('  已取消')); return; }

  const confirmed = await confirm({ message: '确认修改？', default: false });
  if (!confirmed) { console.log(dim('  已取消')); return; }

  // F5: 备份
  fs.copyFileSync(ENV_FILE, ENV_FILE + '.bak');

  // F4: 原子写入 mode 0o600
  const updated = replaceEnvVar(content, key, newValue);
  const tmpFile = ENV_FILE + '.tmp';
  fs.writeFileSync(tmpFile, updated, { mode: 0o600 });
  fs.renameSync(tmpFile, ENV_FILE);
  console.log(green('  ✓ 配置已更新') + dim('（备份: .env.bak）'));

  // 重启服务
  if (IS_LINUX) {
    try {
      execSync(`sudo systemctl restart ${SERVICE_NAME}`, { timeout: 15000 });
      const active = run(`systemctl is-active ${SERVICE_NAME}`);
      if (active === 'active') {
        console.log(green('  ✓ 服务重启完成'));
      } else {
        console.log(red('  ✗ 服务未成功启动') + dim('，旧配置已备份到 .env.bak'));
      }
    } catch {
      console.log(yellow('  ⚠ 服务重启失败（检查 sudo 权限）'));
    }

    // F7: 修改后自动测对应 API
    await autoTestForKey(key);
  }
}

async function autoTestForKey(key) {
  const keyToTest = {
    ANTHROPIC_API_KEY: 'claude', ANTHROPIC_AUTH_TOKEN: 'claude', ANTHROPIC_BASE_URL: 'claude',
    FEISHU_APP_ID: 'feishu', FEISHU_APP_SECRET: 'feishu',
    WECOM_CORP_ID: 'wecom', WECOM_AGENT_SECRET: 'wecom',
    DASHSCOPE_API_KEY: 'dashscope',
  };
  const testName = keyToTest[key];
  if (testName) {
    console.log(dim(`\n  自动验证 ${testName} 连通性...`));
    const result = await testSingleAPI(testName);
    const icon = result.ok ? green('✓') : red('✗');
    console.log(`  ${result.name.padEnd(15)} ${icon}  ${result.detail}`);
  }
}

async function configMenu() {
  const { select } = require('@inquirer/prompts');
  while (true) {
    const action = await select({
      message: '配置管理',
      choices: [
        { name: '查看当前配置', value: 'show' },
        { name: '修改配置项', value: 'edit' },
        { name: '← 返回', value: 'back' },
      ],
    });
    if (action === 'back') break;
    if (action === 'show') { await showConfig(); await waitKey(); }
    if (action === 'edit') await editConfig();
  }
}

// ─── 连通性测试 ──────────────────────────────────────────────
async function testSingleAPI(name) {
  require('dotenv').config({ path: ENV_FILE, quiet: true });
  const env = process.env;
  const timeout = 5000;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    if (name === 'claude') {
      const authToken = env.ANTHROPIC_AUTH_TOKEN;
      const apiKey = env.ANTHROPIC_API_KEY;
      const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      const model = env.CLAUDE_MODEL?.trim();
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (authToken) headers['authorization'] = `Bearer ${authToken}`;
      else if (apiKey) headers['x-api-key'] = apiKey;
      else { clearTimeout(timer); return { name: 'Claude API', ok: false, detail: '未配置' }; }
      if (!model) { clearTimeout(timer); return { name: 'Claude API', ok: false, detail: '缺少 CLAUDE_MODEL' }; }

      const start = Date.now();
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      clearTimeout(timer);
      const ms = Date.now() - start;
      // F9: 200/400/429 都算连通
      const ok = [200, 400, 429].includes(res.status);
      return { name: 'Claude API', ok, detail: ok ? `${ms}ms` : `HTTP ${res.status}` };
    }

    if (name === 'feishu') {
      if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
        clearTimeout(timer);
        return { name: '飞书 API', ok: false, detail: '未配置' };
      }
      const start = Date.now();
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
      });
      clearTimeout(timer);
      const ms = Date.now() - start;
      const data = await res.json();
      return { name: '飞书 API', ok: data.code === 0, detail: data.code === 0 ? `${ms}ms` : `code=${data.code}` };
    }

    if (name === 'wecom') {
      if (!env.WECOM_CORP_ID || !env.WECOM_AGENT_SECRET) {
        clearTimeout(timer);
        return { name: '企微 API', ok: false, detail: '未配置' };
      }
      const start = Date.now();
      const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${env.WECOM_CORP_ID}&corpsecret=${env.WECOM_AGENT_SECRET}`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - start;
      const data = await res.json();
      return { name: '企微 API', ok: data.errcode === 0, detail: data.errcode === 0 ? `${ms}ms` : `errcode=${data.errcode}` };
    }

    if (name === 'dashscope') {
      if (!env.DASHSCOPE_API_KEY) {
        clearTimeout(timer);
        return { name: 'DashScope', ok: false, detail: '未配置' };
      }
      const start = Date.now();
      const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.DASHSCOPE_API_KEY}` },
        body: JSON.stringify({ model: 'text-embedding-v4', input: ['test'] }),
      });
      clearTimeout(timer);
      const ms = Date.now() - start;
      const ok = [200, 400, 429].includes(res.status);
      return { name: 'DashScope', ok, detail: ok ? `${ms}ms` : `HTTP ${res.status}` };
    }

    return { name, ok: false, detail: '未知测试' };
  } catch (e) {
    return { name, ok: false, detail: e.name === 'AbortError' ? '超时 (5s)' : e.message };
  }
}

async function testAllAPIs() {
  console.log(`\n  ${dim('── API 连通性 ──')}`);
  const results = await Promise.allSettled([
    testSingleAPI('claude'),
    testSingleAPI('feishu'),
    testSingleAPI('wecom'),
    testSingleAPI('dashscope'),
  ]);
  for (const r of results) {
    const result = r.status === 'fulfilled' ? r.value : { name: '?', ok: false, detail: r.reason?.message };
    const icon = result.ok ? green('✓') : red('✗');
    console.log(`  ${result.name.padEnd(15)} ${icon}  ${result.detail}`);
  }
}

// ─── 系统诊断 ────────────────────────────────────────────────
async function checkEnvironment() {
  console.log(`\n  ${dim('── 环境检查 ──')}`);
  const checks = [
    { name: 'Node.js', cmd: 'node --version' },
    { name: 'ffmpeg', cmd: 'ffmpeg -version 2>/dev/null | head -1' },
    { name: 'nginx', cmd: IS_LINUX ? 'systemctl is-active nginx' : 'nginx -v 2>&1' },
  ];
  for (const chk of checks) {
    const result = run(chk.cmd);
    const ok = !!result;
    console.log(`  ${chk.name.padEnd(15)} ${ok ? green('✓') : red('✗')}  ${ok ? result.split('\n')[0].trim() : '未安装'}`);
  }
  // SSL 证书
  if (IS_LINUX) {
    const certPath = process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/default/fullchain.pem';
    const expiry = run(`openssl x509 -enddate -noout -in "${certPath}" 2>/dev/null | cut -d= -f2`);
    if (expiry) {
      const expDate = new Date(expiry);
      const daysLeft = Math.floor((expDate - Date.now()) / 86400000);
      const ok = daysLeft > 14;
      console.log(`  ${'SSL 证书'.padEnd(15)} ${ok ? green('✓') : yellow('⚠')}  有效至 ${expDate.toISOString().slice(0, 10)} (${daysLeft}天)`);
    } else {
      console.log(`  ${'SSL 证书'.padEnd(15)} ${dim('无法检测')}`);
    }
  }
}

async function checkResources() {
  console.log(`\n  ${dim('── 资源检查 ──')}`);
  if (IS_LINUX) {
    // 磁盘
    const dfLine = run("df -h / | awk 'NR==2 {print $5}'");
    const diskPct = parseInt(dfLine) || 0;
    console.log(`  ${'磁盘'.padEnd(15)} ${diskPct < 80 ? green('✓') : yellow('⚠')}  ${dfLine}`);

    // 内存
    const memLine = run("free -m | awk '/^Mem:/ {printf \"%.0f%%\", $3/$2*100}'");
    const memPct = parseInt(memLine) || 0;
    console.log(`  ${'内存'.padEnd(15)} ${memPct < 80 ? green('✓') : yellow('⚠')}  ${memLine}`);
  }

  // data/ 权限
  const dataDir = path.join(PROJECT_DIR, 'data');
  if (fs.existsSync(dataDir) && IS_LINUX) {
    const owner = run(`stat -c '%U:%G' ${dataDir}`);
    const ok = owner === (process.env.APP_USER || 'openmist') + ':' + (process.env.APP_USER || 'openmist');
    console.log(`  ${'data/ 权限'.padEnd(15)} ${ok ? green('✓') : red('✗')}  ${owner}`);
  }

  // vectors.db
  const vectorsDb = path.join(PROJECT_DIR, 'data/memory/vectors.db');
  if (fs.existsSync(vectorsDb)) {
    try {
      fs.accessSync(vectorsDb, fs.constants.W_OK);
      console.log(`  ${'vectors.db'.padEnd(15)} ${green('✓')}  可写`);
    } catch {
      console.log(`  ${'vectors.db'.padEnd(15)} ${red('✗')}  不可写`);
    }
  }
}

async function runAllDiagnostics() {
  await testAllAPIs();
  await checkEnvironment();
  await checkResources();
  console.log('');
}

async function diagnosticsMenu() {
  const { select } = require('@inquirer/prompts');
  while (true) {
    const action = await select({
      message: '系统诊断',
      choices: [
        { name: '一键全部测试', value: 'all' },
        { name: 'API 连通性', value: 'api' },
        { name: '环境检查', value: 'env' },
        { name: '资源检查', value: 'res' },
        { name: '← 返回', value: 'back' },
      ],
    });
    if (action === 'back') break;
    if (action === 'all') await runAllDiagnostics();
    if (action === 'api') { await testAllAPIs(); console.log(''); }
    if (action === 'env') { await checkEnvironment(); console.log(''); }
    if (action === 'res') { await checkResources(); console.log(''); }
    await waitKey();
  }
}

// ─── 日志查看 ────────────────────────────────────────────────
async function showStaticLog(label, logPath, lines = 50) {
  console.log(`\n  ${bold(label)} ${dim(`(最近 ${lines} 行)`)}\n`);
  if (!fs.existsSync(logPath)) {
    console.log(dim('  日志文件不存在: ' + logPath));
    return;
  }
  const output = run(`tail -${lines} "${logPath}"`);
  if (output) console.log(output);
  else console.log(dim('  (空)'));
  console.log('');
}

async function showAuditLog() {
  const auditFile = path.join(PROJECT_DIR, 'data/audit.jsonl');
  console.log(`\n  ${bold('审计日志')} ${dim('(最近 20 条)')}\n`);
  if (!fs.existsSync(auditFile)) {
    console.log(dim('  审计日志不存在'));
    return;
  }
  const lines = run(`tail -20 "${auditFile}"`);
  if (!lines) { console.log(dim('  (空)')); return; }
  for (const line of lines.split('\n')) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.timestamp || entry.ts).toLocaleString('zh-CN');
      console.log(`  ${dim(time)}  ${entry.action || entry.type || ''}  ${entry.detail || entry.message || ''}`);
    } catch {
      console.log(`  ${dim(line)}`);
    }
  }
  console.log('');
}

// F1: tail -f 带 SIGINT 清理
async function showRealtimeLog(logFile) {
  if (!fs.existsSync(logFile)) {
    console.log(dim('\n  日志文件不存在: ' + logFile));
    return;
  }
  console.log(dim(`\n  实时日志: ${logFile}`));
  console.log(dim('  按 Ctrl+C 返回菜单\n'));

  const child = spawn('tail', ['-f', '--follow=name', logFile], { stdio: 'inherit' });
  const cleanup = () => { child.kill(); };
  process.on('SIGINT', cleanup);

  await new Promise(resolve => {
    child.on('exit', () => {
      process.removeListener('SIGINT', cleanup);
      resolve();
    });
  });
  console.log('');
}

async function logsMenu() {
  const { select } = require('@inquirer/prompts');
  const logsDir = path.join(PROJECT_DIR, 'logs');

  while (true) {
    const action = await select({
      message: '日志查看',
      choices: [
        { name: '飞书机器人日志 (最近 50 行)', value: 'bot' },
        { name: '心跳巡检日志 (最近 50 行)', value: 'heartbeat' },
        { name: '审计日志 (最近 20 条)', value: 'audit' },
        { name: '实时日志 (Ctrl+C 退出)', value: 'realtime' },
        { name: '← 返回', value: 'back' },
      ],
    });
    if (action === 'back') break;
    if (action === 'bot') { await showStaticLog('飞书机器人日志', path.join(logsDir, 'bot.log')); await waitKey(); }
    if (action === 'heartbeat') { await showStaticLog('心跳巡检日志', path.join(logsDir, 'heartbeat.log')); await waitKey(); }
    if (action === 'audit') { await showAuditLog(); await waitKey(); }
    if (action === 'realtime') {
      const logFile = await select({
        message: '选择日志文件:',
        choices: [
          { name: 'bot.log', value: path.join(logsDir, 'bot.log') },
          { name: 'heartbeat.log', value: path.join(logsDir, 'heartbeat.log') },
        ],
      });
      await showRealtimeLog(logFile);
    }
  }
}

// ─── 服务控制 ────────────────────────────────────────────────
async function serviceMenu() {
  if (!IS_LINUX) {
    console.log(yellow('\n  服务控制仅支持 Linux\n'));
    await waitKey();
    return;
  }

  const { select, confirm } = require('@inquirer/prompts');
  while (true) {
    // 显示当前状态
    const active = run(`systemctl is-active ${SERVICE_NAME}`);
    const pid = run(`systemctl show ${SERVICE_NAME} -p MainPID --value`);
    const timestamp = run(`systemctl show ${SERVICE_NAME} -p ActiveEnterTimestamp --value`);
    let uptime = '';
    if (timestamp && active === 'active') {
      const ms = Date.now() - new Date(timestamp).getTime();
      if (ms > 0) uptime = `  ${formatDuration(ms)}`;
    }

    const statusIcon = active === 'active' ? green('● 运行中') : red('● 已停止');
    console.log(`\n  ${SERVICE_NAME}  ${statusIcon}  PID ${pid || '-'}${uptime}\n`);

    const action = await select({
      message: '服务控制',
      choices: [
        { name: '重启服务', value: 'restart' },
        { name: '停止服务', value: 'stop' },
        { name: '查看详细状态', value: 'detail' },
        { name: '← 返回', value: 'back' },
      ],
    });
    if (action === 'back') break;

    if (action === 'detail') {
      console.log('');
      const detail = run(`systemctl status ${SERVICE_NAME} 2>&1`);
      console.log(detail || dim('  无法获取'));
      console.log('');
      await waitKey();
    }

    if (action === 'restart') {
      const confirmed = await confirm({ message: `确定要重启 ${SERVICE_NAME}？`, default: false });
      if (confirmed) {
        try {
          execSync(`sudo systemctl restart ${SERVICE_NAME}`, { timeout: 15000 });
          const newActive = run(`systemctl is-active ${SERVICE_NAME}`);
          if (newActive === 'active') {
            const newPid = run(`systemctl show ${SERVICE_NAME} -p MainPID --value`);
            console.log(green(`  ✓ 服务已重启 (PID ${newPid})`));
          } else {
            console.log(red('  ✗ 服务未成功启动'));
          }
        } catch {
          console.log(red('  ✗ 重启失败（检查 sudo 权限）'));
        }
      }
    }

    if (action === 'stop') {
      const confirmed = await confirm({ message: `确定要停止 ${SERVICE_NAME}？`, default: false });
      if (confirmed) {
        try {
          execSync(`sudo systemctl stop ${SERVICE_NAME}`, { timeout: 15000 });
          console.log(green('  ✓ 服务已停止'));
        } catch {
          console.log(red('  ✗ 停止失败（检查 sudo 权限）'));
        }
      }
    }
  }
}

// ─── 主菜单 ──────────────────────────────────────────────────
async function waitKey() {
  const { select } = require('@inquirer/prompts');
  await select({ message: '', choices: [{ name: '← 按回车返回', value: 'back' }] });
}

async function mainMenu() {
  const { select } = require('@inquirer/prompts');

  // 欢迎头
  console.log(`
  ${cyan('╭───────────────────────────╮')}
  ${cyan('│')}  OpenMist 管理工具 v${PKG.version}   ${cyan('│')}
  ${cyan('╰───────────────────────────╯')}
  `);

  while (true) {
    const action = await select({
      message: '选择操作',
      choices: [
        { name: '📊  系统状态', value: 'status' },
        { name: '⚙️   配置管理', value: 'config' },
        { name: '🔍  系统诊断', value: 'diagnostics' },
        { name: '📋  日志查看', value: 'logs' },
        { name: '🔄  服务控制', value: 'service' },
        { name: '❌  退出', value: 'exit' },
      ],
    });
    if (action === 'exit') break;
    if (action === 'status') { await showDashboard(); await waitKey(); }
    if (action === 'config') await configMenu();
    if (action === 'diagnostics') await diagnosticsMenu();
    if (action === 'logs') await logsMenu();
    if (action === 'service') await serviceMenu();
  }
}

// ─── 入口 ────────────────────────────────────────────────────
async function main() {
  // F3: root 用户警告
  if (process.getuid?.() === 0) {
    console.warn(yellow('⚠ 当前以 root 运行，修改 .env 后文件属主将变为 root'));
    console.warn(yellow(`  建议: su - ${process.env.APP_USER || 'openmist'} 后再运行`));
  }

  // F2: .env 不存在时引导
  if (!fs.existsSync(ENV_FILE) && fs.existsSync(ENV_EXAMPLE)) {
    console.log(yellow('\n  未检测到 .env 文件'));
    try {
      const { confirm } = require('@inquirer/prompts');
      if (await confirm({ message: '从 .env.example 复制？', default: true })) {
        fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
        console.log(green('  ✓ 已创建 .env，请进入「配置管理」填写必要配置'));
      }
    } catch {
      console.log(dim('  请手动复制: cp .env.example .env'));
    }
  }

  // 加载 .env
  try { require('dotenv').config({ path: ENV_FILE, quiet: true }); } catch {}

  // F8: 子命令模式
  const cmd = process.argv[2];
  if (cmd === 'status') { await showDashboard(); process.exit(0); }
  if (cmd === 'test') { await runAllDiagnostics(); process.exit(0); }
  if (cmd === 'config') { await showConfig(); process.exit(0); }

  // 交互式菜单
  await mainMenu();
}

// 导出纯逻辑函数供测试
module.exports = { mask, formatDuration, formatBytes, progressBar, parseEnvFile, replaceEnvVar };

// 仅直接运行时启动（require 时不执行）
if (require.main === module) {
  main().catch(e => {
    console.error(red('错误: ') + e.message);
    process.exit(1);
  });
}
