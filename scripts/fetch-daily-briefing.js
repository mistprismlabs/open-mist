/**
 * 每日资讯简报 - 多信源采集与飞书推送
 *
 * 采集 8 个信源 → 写入飞书多维表格 → 发送卡片通知
 * 用法: node scripts/fetch-daily-briefing.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const lark = require("@larksuiteoapi/node-sdk");
const { parseStringPromise } = require("xml2js");
const fs = require("fs");
const path = require("path");

const { enqueue } = require('./notify-queue');
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;
const OWNER_OPEN_ID = process.env.FEISHU_OWNER_ID || '';
const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "briefing-config.json");
const UA = "Mozilla/5.0 (compatible; OpenMistBriefing/1.0)";
const ENGLISH_SOURCES = new Set(["HN", "McKinsey", "GitHub", "arXiv"]);
const CLAUDE_API_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const CLAUDE_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const RECOMMEND_MODEL = process.env.RECOMMEND_MODEL || process.env.CLAUDE_MODEL || "";
const PROXY_URL = process.env.BRIEFING_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

// ── 代理设置（海外源按环境变量启用） ──

let proxyDispatcher = null;
try {
  const { ProxyAgent } = require("undici");
  if (PROXY_URL) proxyDispatcher = new ProxyAgent(PROXY_URL);
} catch {
  if (PROXY_URL) console.warn("[proxy] undici unavailable, overseas sources may fail");
}

async function fetchText(url, overseas = false) {
  const opts = { headers: { "User-Agent": UA } };
  if (overseas && proxyDispatcher) opts.dispatcher = proxyDispatcher;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

async function fetchJSON(url, overseas = false) {
  const text = await fetchText(url, overseas);
  return JSON.parse(text);
}

async function fetchRSS(url, overseas = false) {
  const xml = await fetchText(url, overseas);
  return parseStringPromise(xml);
}

function stripHTML(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function safeISO(dateStr) {
  if (!dateStr) return "";
  try { return new Date(dateStr).toISOString(); } catch { return String(dateStr); }
}

// ── 8 个信源采集函数 ──

async function fetchHackerNews() {
  const ids = (await fetchJSON(
    "https://hacker-news.firebaseio.com/v0/topstories.json", true
  )).slice(0, 20);
  const items = await Promise.all(
    ids.map(id =>
      fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, true)
        .catch(() => null)
    )
  );
  return items.filter(Boolean).map(item => ({
    来源: "HN", 分类: "科技社区",
    标题: item.title || "",
    摘要: stripHTML(item.text).substring(0, 500),
    链接: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    热度: item.score || 0,
    发布时间: item.time ? new Date(item.time * 1000).toISOString() : "",
  }));
}

async function fetch36kr() {
  const data = await fetchRSS("https://36kr.com/feed");
  return (data.rss?.channel?.[0]?.item || []).map(item => ({
    来源: "36kr", 分类: "中文科技",
    标题: item.title?.[0] || "",
    摘要: stripHTML(item.description?.[0]).substring(0, 500),
    链接: item.link?.[0] || "",
    热度: 0,
    发布时间: safeISO(item.pubDate?.[0]),
  }));
}

async function fetchEEO() {
  const data = await fetchRSS("http://www.eeo.com.cn/rss.xml");
  return (data.rss?.channel?.[0]?.item || []).map(item => ({
    来源: "经济观察报", 分类: "财经媒体",
    标题: item.title?.[0] || "",
    摘要: stripHTML(item.description?.[0]).substring(0, 500),
    链接: item.link?.[0] || "",
    热度: 0,
    发布时间: safeISO(item.pubDate?.[0]),
  }));
}

async function fetchMcKinsey() {
  const data = await fetchRSS("https://www.mckinsey.com/Insights/rss.aspx", true);
  return (data.rss?.channel?.[0]?.item || []).slice(0, 20).map(item => ({
    来源: "McKinsey", 分类: "商业战略",
    标题: item.title?.[0] || "",
    摘要: stripHTML(item.description?.[0]).substring(0, 500),
    链接: item.link?.[0] || "",
    热度: 0,
    发布时间: safeISO(item.pubDate?.[0]),
  }));
}

async function fetchGithubTrending() {
  const langs = ["python", "javascript", "go"];
  const feeds = await Promise.all(
    langs.map(lang =>
      fetchRSS(
        `https://mshibanami.github.io/GitHubTrendingRSS/daily/${lang}.xml`, true
      ).catch(() => null)
    )
  );
  const seen = new Set();
  const items = [];
  for (const data of feeds) {
    if (!data) continue;
    for (const item of data.rss?.channel?.[0]?.item || []) {
      const link = item.link?.[0] || "";
      if (seen.has(link)) continue;
      seen.add(link);
      items.push({
        来源: "GitHub", 分类: "开源",
        标题: item.title?.[0] || "",
        摘要: stripHTML(item.description?.[0]).substring(0, 500),
        链接: link,
        热度: 0,
        发布时间: safeISO(item.pubDate?.[0]),
      });
    }
  }
  return items;
}

async function fetchCninfo() {
  const body = new URLSearchParams({
    pageNum: "1", pageSize: "20",
    column: "szse_latest", tabName: "latest",
    sortName: "", sortType: "", clusterFlag: "true",
  });
  const res = await fetch("http://www.cninfo.com.cn/new/disclosure", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      "Accept": "*/*",
      "Origin": "http://www.cninfo.com.cn",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Response: { classifiedAnnouncements: [[...], [...]] }
  const all = (data.classifiedAnnouncements || []).flat();
  return all.slice(0, 20).map(a => ({
    来源: "巨潮", 分类: "A股公告",
    标题: `[${a.secCode || ""}] ${a.secName || ""} - ${a.announcementTitle || ""}`,
    摘要: a.announcementTitle || "",
    链接: a.adjunctUrl ? `http://static.cninfo.com.cn/${a.adjunctUrl}` : "",
    热度: 0,
    发布时间: a.announcementTime ? new Date(a.announcementTime).toISOString() : "",
  }));
}

async function fetchArxiv() {
  const url = "http://export.arxiv.org/api/query?search_query=cat:cs.AI"
    + "&sortBy=submittedDate&sortOrder=descending&max_results=20";
  const data = await fetchRSS(url, true);
  return (data.feed?.entry || []).map(entry => ({
    来源: "arXiv", 分类: "AI论文",
    标题: (entry.title?.[0] || "").replace(/\s+/g, " ").trim(),
    摘要: (entry.summary?.[0] || "").replace(/\s+/g, " ").trim().substring(0, 500),
    链接: entry.id?.[0] || "",
    热度: 0,
    发布时间: entry.published?.[0] || "",
  }));
}

// Morgan Stanley 暂无公开 RSS，预留接口
// async function fetchMorganStanley() { ... }

// ── Bitable 管理 ──

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return null;
}

function saveConfig(config) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function setupBitable() {
  console.log("[bitable] Creating app...");

  // 1. Create app
  const appRes = await client.bitable.app.create({ data: { name: "每日资讯简报" } });
  if (appRes.code !== 0) throw new Error(`Create app: ${appRes.msg}`);
  const appToken = appRes.data.app.app_token;
  const appUrl = appRes.data.app.url;
  console.log(`[bitable] app_token: ${appToken}`);

  // 2. Get default table
  const tblRes = await client.bitable.appTable.list({ path: { app_token: appToken } });
  if (tblRes.code !== 0) throw new Error(`List tables: ${tblRes.msg}`);
  const tableId = tblRes.data.items[0].table_id;

  // 3. Create fields
  const fields = [
    {
      field_name: "来源", type: 3,
      property: { options: [
        { name: "HN" }, { name: "36kr" }, { name: "经济观察报" }, { name: "McKinsey" },
        { name: "GitHub" }, { name: "巨潮" }, { name: "arXiv" },
      ] },
    },
    {
      field_name: "分类", type: 3,
      property: { options: [
        { name: "科技社区" }, { name: "中文科技" }, { name: "财经媒体" }, { name: "商业战略" },
        { name: "开源" }, { name: "A股公告" }, { name: "AI论文" },
      ] },
    },
    { field_name: "标题", type: 1 },
    { field_name: "摘要", type: 1 },
    { field_name: "链接", type: 15 },
    { field_name: "热度", type: 2 },
    { field_name: "发布时间", type: 1 },
    { field_name: "英文标题", type: 1 },
    { field_name: "采集日期", type: 5 },
  ];
  for (const f of fields) {
    const r = await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId }, data: f,
    });
    if (r.code !== 0) console.warn(`  field "${f.field_name}": ${r.msg}`);
    else console.log(`  field "${f.field_name}" ok`);
  }

  // 4. Grant access
  await client.request({
    method: "POST",
    url: `/open-apis/drive/v1/permissions/${appToken}/members`,
    params: { type: "bitable", need_notification: true },
    data: { member_type: "openid", member_id: OWNER_OPEN_ID, perm: "full_access" },
  });
  console.log("[bitable] access granted");

  const config = { app_token: appToken, table_id: tableId, url: appUrl };
  saveConfig(config);
  return config;
}

// ── 英文标题翻译 ──

async function translateBatch(titles) {
  if (!RECOMMEND_MODEL) throw new Error("RECOMMEND_MODEL or CLAUDE_MODEL is required for translation");
  const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const res = await fetch(CLAUDE_API_BASE + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: RECOMMEND_MODEL,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `将以下英文标题翻译为简洁的中文。保持编号格式，每行一条，只输出翻译结果。\n\n${numbered}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`翻译 API ${res.status}`);
  const data = await res.json();
  const lines = data.content[0].text.trim().split("\n").filter(Boolean);
  const result = {};
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s*(.+)/);
    if (m) result[parseInt(m[1]) - 1] = m[2].trim();
  }
  return result;
}

async function translateItems(items) {
  const englishItems = items.filter(it => ENGLISH_SOURCES.has(it.来源));
  if (!englishItems.length || !CLAUDE_API_KEY) return;
  if (!RECOMMEND_MODEL) {
    console.warn("[翻译] skip: RECOMMEND_MODEL or CLAUDE_MODEL not set");
    return;
  }

  console.log(`[翻译] ${englishItems.length} 条英文内容...`);
  const batchSize = 50;
  for (let i = 0; i < englishItems.length; i += batchSize) {
    const batch = englishItems.slice(i, i + batchSize);
    try {
      // GitHub: 用摘要（英文描述）翻译，仓库名是专有名词不翻译
      const toTranslate = batch.map(it =>
        it.来源 === "GitHub" ? (it.摘要 || it.标题) : it.标题
      );
      const translations = await translateBatch(toTranslate);
      for (const [idx, cn] of Object.entries(translations)) {
        const item = batch[parseInt(idx)];
        item.英文标题 = item.标题;
        if (item.来源 === "GitHub") {
          item.标题 = item.英文标题 + " — " + cn;
        } else {
          item.标题 = cn;
        }
      }
    } catch (e) {
      console.warn(`[翻译] batch ${Math.floor(i / batchSize) + 1} failed: ${e.message}`);
    }
  }
  const translated = englishItems.filter(it => it.英文标题).length;
  console.log(`[翻译] ${translated}/${englishItems.length} 条完成`);
}

async function writeToBitable(config, items) {
  const records = items.map((item, idx) => {
    const fields = {
      "编号": String(idx + 1),
      "来源": item.来源,
      "分类": item.分类,
      "标题": item.标题,
      "摘要": item.摘要,
      "链接": { link: item.链接, text: item.标题 },
      "热度": item.热度 || 0,
      "发布时间": item.发布时间,
      "采集日期": Date.now(),
    };
    if (item.英文标题) fields["英文标题"] = item.英文标题;
    return { fields };
  });

  // batchCreate limit: 500
  let total = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const res = await client.bitable.appTableRecord.batchCreate({
      path: { app_token: config.app_token, table_id: config.table_id },
      data: { records: batch },
    });
    if (res.code !== 0) throw new Error(`batchCreate: ${res.msg}`);
    total += res.data.records.length;
  }
  return total;
}

// ── 飞书卡片 ──

function buildCard(results, config) {
  const date = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  const ok = results.filter(r => !r.error);
  const fail = results.filter(r => r.error);
  const totalItems = ok.reduce((s, r) => s + r.count, 0);

  // 信源统计
  const stats = results
    .map(r => r.error ? `**${r.name}** ⚠️` : `**${r.name}** ${r.count}条`)
    .join(" · ");

  // 精选内容（每个成功信源取第1条）
  const featured = ok
    .filter(r => r.items?.length)
    .map(r => `- ${r.items[0].标题.substring(0, 45)} (${r.name})`);

  const elements = [
    { tag: "markdown", content: `共采集 **${totalItems}** 条资讯\n${stats}` },
  ];

  if (featured.length) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `**精选内容**\n${featured.join("\n")}` });
  }

  if (fail.length) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `**采集异常**\n${fail.map(e => `⚠️ ${e.name}: ${e.error}`).join("\n")}`,
    });
  }

  if (config?.url) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "查看完整多维表格" },
        url: config.url,
        type: "primary",
      }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `每日资讯简报 ${date}` },
      template: fail.length > ok.length ? "red" : "blue",
    },
    elements,
  };
}

async function sendCard(card) {
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: NOTIFY_CHAT_ID,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
}

// ── 主流程 ──

const SOURCES = [
  { name: "HN",       fn: fetchHackerNews },
  { name: "36kr",     fn: fetch36kr },
  { name: "经济观察报", fn: fetchEEO },
  { name: "McKinsey", fn: fetchMcKinsey },
  { name: "GitHub",   fn: fetchGithubTrending },
  { name: "巨潮",     fn: fetchCninfo },
  { name: "arXiv",    fn: fetchArxiv },
];

async function main() {
  const startTime = Date.now();
  console.log("====== 每日资讯简报 ======");
  console.log(`时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n`);

  // 1. 并行采集
  const settled = await Promise.allSettled(
    SOURCES.map(async (src) => {
      console.log(`[${src.name}] 采集中...`);
      const items = await src.fn();
      console.log(`[${src.name}] ${items.length} 条 ✓`);
      return { name: src.name, items, count: items.length };
    })
  );

  const results = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const err = s.reason?.message || String(s.reason);
    console.error(`[${SOURCES[i].name}] ✗ ${err}`);
    return { name: SOURCES[i].name, error: err, items: [], count: 0 };
  });

  // 2. 合并
  const allItems = results.flatMap(r => r.items || []);
  console.log(`\n总计: ${allItems.length} 条`);

  if (!allItems.length) {
    console.error("所有信源均采集失败");
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: NOTIFY_CHAT_ID, msg_type: "text",
        content: JSON.stringify({ text: "❌ 每日资讯简报：所有信源采集失败" }),
      },
    });
    process.exit(1);
  }

  // 3. 翻译英文标题
  await translateItems(allItems);

  // 4. Bitable（首次创建，后续复用）
  let config = loadConfig();
  if (!config) config = await setupBitable();

  // 5. 写入
  const written = await writeToBitable(config, allItems);
  console.log(`写入 Bitable: ${written} 条`);

  // 6. 写入通知队列
  const ok = results.filter(r => !r.error);
  const totalItems = ok.reduce((s, r) => s + r.count, 0);
  enqueue({ source: '每日简报', status: results.some(r => r.error) ? 'warn' : 'ok', summary: `${totalItems} 条资讯, ${ok.length}/${results.length} 信源成功` });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n====== 完成 (${elapsed}s) ======`);
}

main().catch(async (err) => {
  console.error("[致命错误]", err.message || err);
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: NOTIFY_CHAT_ID, msg_type: "text",
        content: JSON.stringify({ text: `❌ 每日资讯简报失败\n${err.message || err}` }),
      },
    });
  } catch {}
  process.exit(1);
});
