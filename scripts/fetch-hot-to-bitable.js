/**
 * 热搜追踪系统 - 数据采集与增长追踪
 *
 * 工作流程：
 *   1. 从 DailyHotApi 获取各平台热搜
 *   2. 查询 Bitable 上一轮数据（search API）
 *   3. 读取本地文件获取今日首轮数据
 *   4. 计算增长值、排名变化、日增长值、状态
 *   5. 批量写入新记录
 *   6. 发送飞书群通知
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

const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const API_BASE = "http://127.0.0.1:6688";
const LIMIT = 50;
const DATA_DIR = path.join(__dirname, "..", "data");
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;

// 平台配置
const PLATFORMS = [
  { name: "微博",     route: "weibo",    tableId: process.env.WEIBO_TABLE_ID },
  { name: "抖音",     route: "douyin",   tableId: process.env.DOUYIN_TABLE_ID },
  { name: "今日头条", route: "toutiao",  tableId: process.env.TOUTIAO_TABLE_ID },
];

// ── 工具函数 ──

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

/** 从 Bitable 富文本字段提取纯文本 */
function extractText(field) {
  if (!field) return "";
  if (typeof field === "string") return field;
  if (Array.isArray(field)) return field.map(s => s.text || "").join("");
  return String(field);
}

/** 获取上一轮数据（search API 按时间倒序取最近一批） */
async function getLastBatch(tableId) {
  const res = await client.request({
    method: "POST",
    url: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
    data: {
      sort: [{ field_name: "抓取时间", desc: true }],
      page_size: LIMIT,
      field_names: ["标题", "排名", "热度", "抓取时间"],
    },
  });
  if (res.code !== 0) return [];
  return (res.data.items || []).map(r => ({
    title: extractText(r.fields["标题"]),
    rank:  r.fields["排名"],
    hot:   r.fields["热度"],
  }));
}

/** 获取/保存今日首轮快照（本地文件） */
function getTodayTag() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getFirstBatchPath(route) {
  return path.join(DATA_DIR, `first-batch-${route}-${getTodayTag()}.json`);
}

function loadFirstBatch(route) {
  const fp = getFirstBatchPath(route);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

function saveFirstBatch(route, items) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const fp = getFirstBatchPath(route);
  if (!fs.existsSync(fp)) {
    // 只在今天首次运行时保存
    const snapshot = items.map((item, i) => ({
      title: item.title,
      rank: i + 1,
      hot: item.hot || 0,
    }));
    fs.writeFileSync(fp, JSON.stringify(snapshot));
    return snapshot;
  }
  return null; // 已存在，不覆盖
}

function buildMap(records) {
  const m = new Map();
  if (!records) return m;
  for (const r of records) {
    if (r.title && !m.has(r.title)) {
      m.set(r.title, r);
    }
  }
  return m;
}

/** 批量写入记录 */
async function batchInsert(tableId, records) {
  if (!records.length) return 0;
  const res = await client.bitable.appTableRecord.batchCreate({
    path: { app_token: APP_TOKEN, table_id: tableId },
    data: { records },
  });
  if (res.code !== 0) throw new Error(`写入失败: ${res.msg} (code: ${res.code})`);
  return res.data.records.length;
}

/** 清理过期的首轮快照文件（保留最近 3 天） */
function cleanOldSnapshots() {
  if (!fs.existsSync(DATA_DIR)) return;
  const today = new Date();
  const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("first-batch-"));
  for (const f of files) {
    const match = f.match(/(\d{4}-\d{2}-\d{2})\.json$/);
    if (match && new Date(match[1]) < threeDaysAgo) {
      fs.unlinkSync(path.join(DATA_DIR, f));
    }
  }
}

// ── 核心逻辑 ──

async function processPlatform(platform) {
  const { name, route, tableId } = platform;
  console.log(`\n[${name}] 获取数据...`);

  // 1. 获取当前热搜
  let apiData;
  try {
    apiData = await fetchJson(`${API_BASE}/${route}`);
  } catch (e) {
    console.log(`[${name}] ⚠ API 请求失败: ${e.message}`);
    return { name, error: e.message };
  }
  const items = (apiData.data || []).slice(0, LIMIT);
  if (!items.length) {
    console.log(`[${name}] ⚠ 无数据`);
    return { name, error: "无数据" };
  }

  // 2. 保存/读取今日首轮快照
  saveFirstBatch(route, items);
  const firstBatch = loadFirstBatch(route);
  const firstMap = buildMap(firstBatch);

  // 3. 获取上一轮数据
  const lastBatch = await getLastBatch(tableId).catch(() => []);
  const lastMap = buildMap(lastBatch);

  const now = Date.now();
  const batchId = new Date(now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log(`[${name}] 当前 ${items.length} 条, 上轮 ${lastMap.size} 条, 今日首轮 ${firstMap.size} 条`);

  // 4. 计算增长并构建记录
  let newCount = 0, upCount = 0, downCount = 0, steadyCount = 0;

  const records = items.map((item, i) => {
    const rank = i + 1;
    const hot = item.hot || 0;
    const prev = lastMap.get(item.title);
    const first = firstMap.get(item.title);

    let growth = null;
    let rankChange = null;
    let dailyGrowth = null;
    let status;

    if (!prev) {
      status = "新";
      newCount++;
    } else {
      growth = hot - (prev.hot || 0);
      rankChange = (prev.rank || rank) - rank;
      if (growth > 0) { status = "上升"; upCount++; }
      else if (growth < 0) { status = "下降"; downCount++; }
      else { status = "持平"; steadyCount++; }
    }

    if (first) {
      dailyGrowth = hot - (first.hot || 0);
    }

    const fields = {
      "标题": item.title,
      "排名": rank,
      "热度": hot,
      "状态": status,
      "链接": { link: item.url, text: item.title },
      "抓取时间": now,
    };
    if (growth !== null) fields["增长值"] = growth;
    if (rankChange !== null) fields["排名变化"] = rankChange;
    if (dailyGrowth !== null) fields["日增长值"] = dailyGrowth;

    return { fields };
  });

  // 5. 写入
  const count = await batchInsert(tableId, records);
  console.log(`[${name}] 写入 ${count} 条 ✓  (新${newCount} 升${upCount} 降${downCount} 平${steadyCount})`);

  return { name, count, newCount, upCount, downCount, steadyCount };
}

// ── 主流程 ──

async function main() {
  const startTime = Date.now();
  const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  console.log("====== 热搜追踪系统 ======");
  console.log(`时间: ${timeStr}`);

  cleanOldSnapshots();

  const results = [];
  for (const p of PLATFORMS) {
    const result = await processPlatform(p);
    if (result) results.push(result);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n====== 采集完成 (${elapsed}s) ======`);

  // 写入通知队列
  const summaryParts = results.filter(r => !r.error).map(r => `${r.name} ${r.count}`);
  enqueue({ source: '热搜采集', status: results.some(r => r.error) ? 'warn' : 'ok', summary: `${summaryParts.join(' / ')} (${elapsed}s)` });
}

main().catch(async (err) => {
  console.error("[致命错误]", err.message || err);
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: NOTIFY_CHAT_ID,
        msg_type: "text",
        content: JSON.stringify({ text: `❌ 热搜采集失败\n${err.message || err}` }),
      },
    });
  } catch {}
  process.exit(1);
});
