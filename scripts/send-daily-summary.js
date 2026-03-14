// 每日运营聚合报告 — 读取通知队列，发送飞书卡片
// Cron: 0 9 * * * node scripts/send-daily-summary.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const lark = require('@larksuiteoapi/node-sdk');
const { QUEUE_PATH } = require('./notify-queue');

const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

function readQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  const lines = fs.readFileSync(QUEUE_PATH, 'utf-8').split('\n').filter(Boolean);
  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function statusIcon(status) {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠️';
  return '❌';
}

// 同 source 多条记录合并为一条汇总
function mergeItems(items) {
  const groups = {};
  for (const item of items) {
    if (!groups[item.source]) groups[item.source] = [];
    groups[item.source].push(item);
  }

  return Object.values(groups).map(entries => {
    if (entries.length === 1) return entries[0];

    const failCount = entries.filter(e => e.status !== 'ok').length;
    const hasError = entries.some(e => e.status === 'error');
    const hasWarn = entries.some(e => e.status === 'warn');
    const status = hasError ? 'error' : hasWarn ? 'warn' : 'ok';
    const lastSummary = entries[entries.length - 1].summary;

    const countNote = failCount === 0
      ? `今日 ${entries.length} 次，全部正常`
      : `今日 ${entries.length} 次，${failCount} 次异常`;

    return { source: entries[0].source, status, summary: `${countNote} | 最新：${lastSummary}` };
  });
}

function buildCard(rawItems) {
  const items = mergeItems(rawItems);
  const date = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const okCount = items.filter(i => i.status === 'ok').length;
  const warnCount = items.filter(i => i.status === 'warn').length;
  const errorCount = items.filter(i => i.status === 'error').length;

  // 卡片颜色
  let template = 'green';
  if (errorCount > 0) template = 'red';
  else if (warnCount > 0) template = 'yellow';

  // 通知列表
  const lines = items.map(i => `${statusIcon(i.status)} **${i.source}** — ${i.summary}`);

  // 底部统计
  const statParts = [`${items.length} 项任务`, `${okCount} 项正常`];
  if (warnCount > 0) statParts.push(`${warnCount} 项警告`);
  if (errorCount > 0) statParts.push(`${errorCount} 项异常`);

  const elements = [
    { tag: 'markdown', content: lines.join('\n') },
    { tag: 'hr' },
    { tag: 'markdown', content: `📊 ${statParts.join(' | ')}` },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `Jarvis 每日运营报告 ${date}` },
      template,
    },
    elements,
  };
}

async function main() {
  const items = readQueue();

  if (items.length === 0) {
    console.log('[daily-summary] 队列为空，跳过发送');
    return;
  }

  const card = buildCard(items);

  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: NOTIFY_CHAT_ID,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });

  // 清空队列
  fs.writeFileSync(QUEUE_PATH, '');
  console.log(`[daily-summary] 已发送 ${items.length} 条聚合通知`);
}

main().catch(err => {
  console.error('[daily-summary] 失败:', err.message || err);
  process.exit(1);
});
