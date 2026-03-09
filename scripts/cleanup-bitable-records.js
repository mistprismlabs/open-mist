/**
 * Bitable 自动清理 - 按保留天数删除过期记录
 *
 * 清理策略：
 *   热搜表（微博/抖音/头条）: 3 天
 *   选题池: 7 天
 *   每日资讯简报: 30 天
 *   GitHub 更新: 30 天
 *
 * Cron: 30 6 * * * (每天 6:30)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const lark = require("@larksuiteoapi/node-sdk");
const fs = require("fs");
const path = require("path");

const { enqueue } = require('./notify-queue');

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;
const DATA_DIR = path.join(__dirname, "..", "data");

function loadJSON(filepath) {
  if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return null;
}

// ── 清理单张表 ──

async function cleanTable(appToken, tableId, dateField, retainDays) {
  const cutoff = Date.now() - retainDays * 86400000;
  const expiredIds = [];
  let pageToken;

  // 分页遍历，收集过期 record_id
  do {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;

    const res = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params,
    });
    if (res.code !== 0) throw new Error(`list failed: ${res.msg} (code: ${res.code})`);

    for (const record of res.data.items || []) {
      const val = record.fields[dateField];
      if (typeof val === "number" && val < cutoff) {
        expiredIds.push(record.record_id);
      }
    }

    pageToken = res.data.has_more ? res.data.page_token : null;
  } while (pageToken);

  // 分批删除（每批 500 条）
  for (let i = 0; i < expiredIds.length; i += 500) {
    const batch = expiredIds.slice(i, i + 500);
    const res = await client.bitable.appTableRecord.batchDelete({
      path: { app_token: appToken, table_id: tableId },
      data: { records: batch },
    });
    if (res.code !== 0) throw new Error(`batchDelete failed: ${res.msg} (code: ${res.code})`);
  }

  return expiredIds.length;
}

// ── 清理配置 ──

function buildTableConfigs() {
  const hotAppToken = process.env.BITABLE_APP_TOKEN;
  const briefingConfig = loadJSON(path.join(DATA_DIR, "briefing-config.json"));
  const githubConfig = loadJSON(path.join(DATA_DIR, "github-updates-config.json"));

  const tables = [
    { name: "微博热搜",     appToken: hotAppToken,                  tableId: "tbl5aqZfZXM3ZIoo", dateField: "抓取时间", retainDays: 3 },
    { name: "抖音热搜",     appToken: hotAppToken,                  tableId: "tblOeIfLwyjoQeHA", dateField: "抓取时间", retainDays: 3 },
    { name: "头条热搜",     appToken: hotAppToken,                  tableId: "tblVjQD65Xk7Y0fe", dateField: "抓取时间", retainDays: 3 },
    { name: "选题池",       appToken: hotAppToken,                  tableId: "tblTxYb4A8KHHFmh", dateField: "推荐时间", retainDays: 7 },
    { name: "每日资讯简报", appToken: briefingConfig?.app_token,     tableId: "tbliUNHr7vFl4jRK", dateField: "采集日期", retainDays: 30 },
    { name: "GitHub 更新",  appToken: githubConfig?.app_token,      tableId: "tblS2P3uNlhc2ZVr", dateField: "采集日期", retainDays: 30 },
  ];

  return tables;
}

// ── 主流程 ──

async function main() {
  const startTime = Date.now();
  const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  console.log("====== Bitable 自动清理 ======");
  console.log(`时间: ${timeStr}\n`);

  const tables = buildTableConfigs();
  const results = [];

  for (const t of tables) {
    if (!t.appToken) {
      console.log(`[${t.name}] 跳过（未找到 app_token）`);
      results.push({ name: t.name, skipped: true });
      continue;
    }

    try {
      const deleted = await cleanTable(t.appToken, t.tableId, t.dateField, t.retainDays);
      console.log(`[${t.name}] 删除 ${deleted} 条过期记录（保留 ${t.retainDays} 天）`);
      results.push({ name: t.name, deleted });
    } catch (e) {
      console.error(`[${t.name}] 清理失败: ${e.message}`);
      results.push({ name: t.name, error: e.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalDeleted = results.reduce((s, r) => s + (r.deleted || 0), 0);
  const errors = results.filter(r => r.error);

  console.log(`\n====== 清理完成 (${elapsed}s)，共删除 ${totalDeleted} 条 ======`);

  // 写入通知队列
  if (totalDeleted > 0 || errors.length > 0) {
    enqueue({ source: 'Bitable清理', status: errors.length > 0 ? 'warn' : 'ok', summary: `删除 ${totalDeleted} 条 (${elapsed}s)${errors.length ? `, ${errors.length}张表失败` : ''}` });
  } else {
    enqueue({ source: 'Bitable清理', status: 'ok', summary: `无需清理 (${elapsed}s)` });
  }
}

main().catch(async (err) => {
  console.error("[致命错误]", err.message || err);
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: NOTIFY_CHAT_ID,
        msg_type: "text",
        content: JSON.stringify({ text: `❌ Bitable 清理失败\n${err.message || err}` }),
      },
    });
  } catch {}
  process.exit(1);
});
