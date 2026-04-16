/**
 * GitHub 仓库更新日报采集
 * 监控指定仓库的 releases 和 commits，推送到飞书群
 * Cron: 每天 8:00 运行
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const lark = require("@larksuiteoapi/node-sdk");
const { parseStringPromise } = require("xml2js");
const fs = require("fs");
const path = require("path");

// ── 配置 ──────────────────────────────────────────────
const CLAUDE_API_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const CLAUDE_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const SUMMARY_MODEL = process.env.RECOMMEND_MODEL || process.env.CLAUDE_MODEL || "";
const { enqueue } = require('./notify-queue');
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID;
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_PATH = path.join(DATA_DIR, "github-updates-cache.json");
const CONFIG_PATH = path.join(DATA_DIR, "github-updates-config.json");

const REPOS = [
  { owner: "anthropics", repo: "claude-code", label: "Claude Code" },
  { owner: "openai", repo: "codex", label: "OpenAI Codex" },
  { owner: "openclaw", repo: "openclaw", label: "OpenClaw" },
];

const UA = "Mozilla/5.0 (compatible; JarvisBot/1.0)";

// ── Lark Client ───────────────────────────────────────
const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

// ── Proxy（GitHub 需要代理）─────────────────────────────
let proxyDispatcher = null;
try {
  const { ProxyAgent } = require("undici");
  proxyDispatcher = new ProxyAgent("http://127.0.0.1:7890");
} catch {
  console.warn("[proxy] undici unavailable, GitHub feeds may fail");
}

// ── 工具函数 ──────────────────────────────────────────
function today() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function loadJSON(filepath) {
  if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return null;
}

function saveJSON(filepath, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

async function fetchAtom(url) {
  const opts = { headers: { "User-Agent": UA } };
  if (proxyDispatcher) opts.dispatcher = proxyDispatcher;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const xml = await res.text();
  return parseStringPromise(xml, { explicitArray: false });
}

// ── Atom Feed 采集 ────────────────────────────────────
function parseEntries(atomResult) {
  const feed = atomResult?.feed;
  if (!feed?.entry) return [];
  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  return entries.map((e) => ({
    id: e.id,
    title: (e.title?._ || e.title || "").trim(),
    link: e.link?.$?.href || e.link?.href || "",
    author: e.author?.name || "",
    updated: e.updated || "",
    summary: (e.content?._ || e.content || "").replace(/<[^>]+>/g, "").trim().slice(0, 200),
  }));
}

async function fetchRepoUpdates(owner, repo) {
  const base = `https://github.com/${owner}/${repo}`;
  const [releasesAtom, commitsAtom] = await Promise.all([
    fetchAtom(`${base}/releases.atom`),
    fetchAtom(`${base}/commits.atom`),
  ]);
  return {
    releases: parseEntries(releasesAtom),
    commits: parseEntries(commitsAtom),
  };
}

// ── 增量检测 ──────────────────────────────────────────
function detectNew(entries, cachedIds) {
  if (!cachedIds || cachedIds.length === 0) return []; // 首次运行不推送
  return entries.filter((e) => !cachedIds.includes(e.id));
}

function updateCache(cache, repoKey, type, entries) {
  if (!cache[repoKey]) cache[repoKey] = {};
  cache[repoKey][type] = entries.map((e) => e.id);
}

// ── Bitable 自动创建 ──────────────────────────────────
async function ensureBitable() {
  const config = loadJSON(CONFIG_PATH);
  if (config) return config;

  console.log("[bitable] 首次运行，创建多维表格...");
  const app = await client.bitable.app.create({
    data: { name: "GitHub 仓库更新", folder_token: "" },
  });
  const appToken = app.data.app.app_token;

  const tables = await client.bitable.appTable.list({
    path: { app_token: appToken },
  });
  const tableId = tables.data.items[0].table_id;

  // 先创建一个自定义字段（Bitable 要求至少保留一个字段才能删除其他的）
  await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: { field_name: "仓库", type: 3 },
  });

  // 删除默认字段（多维表格自带的空列）
  const existingFields = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  for (const f of existingFields.data.items) {
    if (f.field_name === "仓库") continue; // 保留刚创建的
    try {
      await client.bitable.appTableField.delete({
        path: { app_token: appToken, table_id: tableId, field_id: f.field_id },
      });
    } catch {}
  }

  // 删除默认空行
  const existingRecords = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 500 },
  });
  if (existingRecords.data.items?.length > 0) {
    await client.bitable.appTableRecord.batchDelete({
      path: { app_token: appToken, table_id: tableId },
      data: { records: existingRecords.data.items.map((r) => r.record_id) },
    });
  }

  // 创建剩余自定义字段（"仓库"已在上方创建）
  const fields = [
    { field_name: "类型", type: 3 },       // 单选
    { field_name: "标题", type: 1 },       // 文本
    { field_name: "链接", type: 15 },      // URL
    { field_name: "作者", type: 1 },       // 文本
    { field_name: "内容摘要", type: 1 },   // 文本
    { field_name: "发布时间", type: 1 },   // 文本（Atom 时间格式不定，用文本）
    { field_name: "采集日期", type: 5 },   // 日期
  ];
  for (const f of fields) {
    await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: f,
    });
  }

  // 开放权限
  try {
    await client.request({
      method: "POST",
      url: `/open-apis/drive/v1/permissions/${appToken}/public`,
      params: { type: "bitable" },
      data: { external_access_entity: "open", security_entity: "anyone_can_view", link_share_entity: "anyone_readable" },
    });
  } catch (e) {
    console.warn("[bitable] 权限设置失败（可忽略）:", e.message);
  }

  const url = `https://mistprism.feishu.cn/base/${appToken}?table=${tableId}`;
  const result = { app_token: appToken, table_id: tableId, url };
  saveJSON(CONFIG_PATH, result);
  console.log("[bitable] 创建完成:", url);
  return result;
}

// ── Bitable 写入 ──────────────────────────────────────
async function writeToBitable(config, repoLabel, type, entries) {
  if (entries.length === 0) return;
  const records = entries.map((e) => ({
    fields: {
      "仓库": repoLabel,
      "类型": type,
      "标题": e.title,
      "链接": { link: e.link, text: e.title },
      "作者": e.author,
      "内容摘要": e.summary,
      "发布时间": e.updated,
      "采集日期": Date.now(),
    },
  }));
  for (let i = 0; i < records.length; i += 500) {
    await client.bitable.appTableRecord.batchCreate({
      path: { app_token: config.app_token, table_id: config.table_id },
      data: { records: records.slice(i, i + 500) },
    });
  }
}

// ── 过滤无意义 commits ────────────────────────────────
function filterCommits(commits) {
  return commits.filter((c) =>
    !c.title.startsWith("chore: Update CHANGELOG") &&
    !c.title.startsWith("Merge pull request") &&
    !c.title.startsWith("chore: Update CHANGELOG.md")
  );
}

// ── AI 摘要生成 ──────────────────────────────────────
async function generateSummary(allUpdates) {
  if (!CLAUDE_API_KEY) return null;
  if (!SUMMARY_MODEL) return null;

  // 只给 AI 有实际更新的仓库数据
  const updatesWithContent = allUpdates.filter(
    ({ releases, commits, error }) => !error && (releases.length > 0 || filterCommits(commits).length > 0)
  );
  if (updatesWithContent.length === 0) return null;

  const lines = [];
  for (const { label, releases, commits } of updatesWithContent) {
    lines.push(`## ${label}`);
    if (releases.length > 0) {
      lines.push("Releases:");
      for (const r of releases) lines.push(`- ${r.title}: ${r.summary}`);
    }
    const meaningful = filterCommits(commits);
    if (meaningful.length > 0) {
      lines.push("Commits:");
      for (const c of meaningful) lines.push(`- ${c.title}: ${c.summary}`);
    }
  }

  try {
    const fetchOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: `你是技术简报编辑。将以下 GitHub 仓库更新翻译为中文简报，输出 JSON。

要求：
- repos 数组中每个仓库一个对象
- releases: 每个 release 用一句话概括核心变更（15字以内），格式 "版本号 — 中文摘要"
- commits: 只保留有实际意义的提交，每条一句话中文概括（15字以内）
- highlight: 如果有重大更新（新模型、重大功能、破坏性变更）写一句话，否则 null

只输出 JSON，不要其他内容：
{"repos":[{"name":"仓库名","releases":["v1.0 — 摘要"],"commits":["修复了XX问题"]}],"highlight":"...或null"}

原始数据：
${lines.join("\n")}`,
        }],
      }),
    };
    if (proxyDispatcher) fetchOpts.dispatcher = proxyDispatcher;
    const res = await fetch(CLAUDE_API_BASE + "/v1/messages", fetchOpts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    // 提取 JSON（可能包在 ```json 里）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn("[summary] AI 摘要生成失败:", e.message);
    return null;
  }
}

// ── 飞书卡片构建 ──────────────────────────────────────
function buildCardElements(allUpdates, aiSummary, bitableUrl) {
  const elements = [];

  // 概览统计 — 始终展示所有仓库
  const stats = allUpdates.map(({ label, releases, commits, error }) => {
    if (error) return `**${label}** ⚠️ 采集失败`;
    const parts = [];
    if (releases.length > 0) parts.push(`${releases.length} releases`);
    const mc = filterCommits(commits);
    if (mc.length > 0) parts.push(`${mc.length} commits`);
    return parts.length > 0 ? `**${label}** ${parts.join(" · ")}` : `**${label}** 暂无更新`;
  }).join("  |  ");
  elements.push({ tag: "markdown", content: stats });

  // 每个仓库的详情 — 始终展示
  for (let i = 0; i < allUpdates.length; i++) {
    const { label, releases, commits, error } = allUpdates[i];
    const aiRepo = aiSummary?.repos?.find((r) => r.name === label);
    const lines = [];

    if (error) {
      lines.push("⚠️ 本次采集失败，将在下次重试");
    } else if (releases.length === 0 && filterCommits(commits).length === 0) {
      lines.push("💤 暂无更新");
    } else {
      // Releases
      if (releases.length > 0) {
        for (let j = 0; j < releases.length && j < 5; j++) {
          const r = releases[j];
          const aiLine = aiRepo?.releases?.[j];
          lines.push(aiLine ? `📦 ${aiLine}` : `📦 [${r.title}](${r.link})`);
        }
      }

      // Commits
      const meaningful = filterCommits(commits);
      if (meaningful.length > 0) {
        const commitLines = [];
        for (let j = 0; j < meaningful.length && j < 5; j++) {
          const aiLine = aiRepo?.commits?.[j];
          commitLines.push(`· ${aiLine || meaningful[j].title}`);
        }
        if (meaningful.length > 5) commitLines.push(`· _...及其他 ${meaningful.length - 5} 条_`);
        lines.push(`🔧 **提交** (${meaningful.length})\n${commitLines.join("\n")}`);
      }
    }

    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `**${label}**\n${lines.join("\n")}` });
  }

  // 重点关注
  if (aiSummary?.highlight) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `⚡ **重点关注**：${aiSummary.highlight}` });
  }

  // 操作按钮
  elements.push({ tag: "hr" });
  elements.push({
    tag: "action",
    actions: [{
      tag: "button",
      text: { tag: "plain_text", content: "查看完整记录" },
      url: bitableUrl,
      type: "primary",
    }],
  });

  return elements;
}

// ── 主流程 ─────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] GitHub 更新采集开始`);

  const cache = loadJSON(CACHE_PATH) || {};
  const bitableConfig = await ensureBitable();

  const allUpdates = []; // 所有仓库（含无更新的，用于完整日报）
  let totalNew = 0;
  let isFirstRun = Object.keys(cache).length === 0;

  for (const { owner, repo, label } of REPOS) {
    const key = `${owner}/${repo}`;
    console.log(`[fetch] ${key}...`);

    try {
      const { releases, commits } = await fetchRepoUpdates(owner, repo);
      console.log(`[fetch] ${key}: ${releases.length} releases, ${commits.length} commits`);

      const isRepoFirstRun = !cache[key];
      const newReleases = isRepoFirstRun ? releases : detectNew(releases, cache[key]?.releases);
      const newCommits = isRepoFirstRun ? commits : detectNew(commits, cache[key]?.commits);

      if (newReleases.length > 0 || newCommits.length > 0) {
        console.log(`[write] ${key}: ${newReleases.length} releases, ${newCommits.length} commits`);
        await writeToBitable(bitableConfig, label, "Release", newReleases);
        await writeToBitable(bitableConfig, label, "Commit", newCommits);
      }

      // 始终记录所有仓库状态（首次运行的仓库标记为无更新，不计入推送）
      const pushReleases = (!isFirstRun && !isRepoFirstRun) ? newReleases : [];
      const pushCommits = (!isFirstRun && !isRepoFirstRun) ? newCommits : [];
      allUpdates.push({ label, releases: pushReleases, commits: pushCommits });
      totalNew += pushReleases.length + pushCommits.length;

      updateCache(cache, key, "releases", releases);
      updateCache(cache, key, "commits", commits);
    } catch (err) {
      console.error(`[error] ${key}:`, err.message);
      // 采集失败也记录，卡片中标记错误
      allUpdates.push({ label, releases: [], commits: [], error: true });
    }
  }

  saveJSON(CACHE_PATH, cache);

  if (isFirstRun) {
    enqueue({ source: 'GitHub监控', status: 'ok', summary: '首次运行，缓存已建立' });
    console.log("[首次运行] 缓存已建立");
    return;
  }

  if (totalNew === 0) {
    enqueue({ source: 'GitHub监控', status: 'ok', summary: '无新更新' });
    console.log("[完成] 无新更新");
    return;
  }

  // 生成 AI 摘要并发送飞书卡片
  console.log('[summary] 生成中文简报...');
  const aiSummary = await generateSummary(allUpdates);
  if (aiSummary) console.log('[summary] AI 摘要完成');

  const elements = buildCardElements(allUpdates, aiSummary, bitableConfig.url);
  const hasError = allUpdates.some(u => u.error);
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: NOTIFY_CHAT_ID,
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: 'GitHub 更新日报' },
          template: hasError ? 'yellow' : 'blue',
        },
        elements,
      }),
    },
  });

  enqueue({ source: 'GitHub监控', status: hasError ? 'warn' : 'ok', summary: `${totalNew} 条新更新` });
  console.log(`[完成] 推送 ${totalNew} 条更新到飞书群`);
}

// ── 启动 ──────────────────────────────────────────────
main().catch(async (err) => {
  console.error("[致命错误]", err.message || err);
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: NOTIFY_CHAT_ID,
        msg_type: "text",
        content: JSON.stringify({ text: `❌ GitHub 更新日报失败\n${err.message || err}` }),
      },
    });
  } catch {}
  process.exit(1);
});
