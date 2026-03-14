/**
 * 老李选题推荐系统
 * Skill2(选题生成师) + Skill3(选题审核官) + 反馈循环
 *
 * 用法：
 *   node recommend-topics.js           # 处理所有平台
 *   node recommend-topics.js toutiao   # 只处理今日头条
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const lark = require("@larksuiteoapi/node-sdk");

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const APP_TOKEN = process.env.BITABLE_APP_TOKEN;
const POOL_TABLE = process.env.TOPIC_POOL_TABLE_ID;

const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://aicoding.api.zeroclover.io") + "/v1/messages";
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const MODEL = process.env.RECOMMEND_MODEL || "claude-sonnet-4-6";
const MAX_RETRIES = 1; // 降低重试次数，节省 API 调用

const ALL_PLATFORMS = [
  { name: "微博",     route: "weibo",    tableId: process.env.WEIBO_TABLE_ID },
  { name: "抖音",     route: "douyin",   tableId: process.env.DOUYIN_TABLE_ID },
  { name: "今日头条", route: "toutiao",  tableId: process.env.TOUTIAO_TABLE_ID },
  { name: "知乎",     route: "zhihu",    tableId: process.env.ZHIHU_TABLE_ID },
  { name: "哔哩哔哩", route: "bilibili", tableId: process.env.BILIBILI_TABLE_ID },
];

// ── Prompts ──

const SKILL2_SYSTEM = `你是「老李动画」选题生成师。从热搜话题中筛选适合「老李」这个角色的选题。

## 老李人设
- 40岁中年男人，办公室打工人
- 性格：乐观中带点无奈，犀利中透着温情
- 擅长：职场吐槽、社会观察、谐音梗、反转幽默
- 风格：用小人物视角解读大事件，笑中带泪

## 适配度标准
- **高**：天然适合老李（职场、社会民生、中年共鸣、有反转空间、全民热议）
- **中**：可以用老李角度切入但需要改编
- **低**：距离老李人设较远（纯八卦、专业技术、敏感政治、小众圈层）

## 输出格式
只返回 JSON 数组，每条简洁：
[{"title":"原标题","rating":"高","reason":"一句话","quote":"老李金句"}]

重要：必须对每条话题都给出评估（包括低适配的），不要跳过任何一条。金句要接地气。只返回 JSON。`;

const SKILL3_SYSTEM = `你是「老李动画」选题审核官。审核选题生成师的输出质量。

审核标准：适配度合理、理由具体、金句有趣符合角色。
超过 70% 合格则 approved=true。

只返回 JSON：
{"approved":true/false,"feedback":"评价","issues":[{"title":"标题","problem":"问题","suggestion":"建议"}]}`;

// ── Claude API ──

async function callClaude(system, userMessage) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16384,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const usage = data.usage || {};
  console.log(`    [API] stop:${data.stop_reason} in:${usage.input_tokens} out:${usage.output_tokens}`);
  return data.content[0].text;
}

/** 从 AI 响应中提取 JSON（容错） */
function parseJSON(text) {
  // 去掉 code block 标记
  let s = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  // 找 JSON 数组
  const i = s.indexOf("[");
  if (i >= 0) s = s.slice(i);
  try { return JSON.parse(s); } catch {}
  // 截断恢复：逐步回退找最后可解析的 }]
  for (let pos = s.lastIndexOf("}"); pos > 0; pos = s.lastIndexOf("}", pos - 1)) {
    try { return JSON.parse(s.slice(0, pos + 1) + "]"); } catch {}
  }
  throw new Error("JSON parse failed");
}

// ── Bitable ──

function extractText(field) {
  if (!field) return "";
  if (typeof field === "string") return field;
  if (Array.isArray(field)) return field.map(s => s.text || "").join("");
  return String(field);
}

/** 获取最近一批记录（同一轮采集，2分钟内） */
async function getLatestBatch(tableId) {
  const res = await client.request({
    method: "POST",
    url: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
    data: {
      sort: [{ field_name: "抓取时间", desc: true }],
      page_size: 200,
      field_names: ["标题", "排名", "热度", "增长值", "状态", "适配度", "链接", "抓取时间"],
    },
  });
  if (res.code !== 0) throw new Error(`搜索失败: ${res.msg}`);
  const all = (res.data.items || []).map(r => ({
    record_id: r.record_id,
    title: extractText(r.fields["标题"]),
    rank: r.fields["排名"],
    hot: r.fields["热度"] || 0,
    growth: r.fields["增长值"] || 0,
    status: extractText(r.fields["状态"]),
    rating: extractText(r.fields["适配度"]),
    link: r.fields["链接"],
    time: r.fields["抓取时间"],
  }));
  if (!all.length) return [];
  // 只保留最新一批（与第一条记录的抓取时间差 < 2 分钟）
  const latestTime = all[0].time;
  const cutoff = latestTime - 2 * 60 * 1000;
  return all.filter(r => r.time >= cutoff);
}

async function batchUpdateRecords(tableId, updates) {
  if (!updates.length) return 0;
  const res = await client.bitable.appTableRecord.batchUpdate({
    path: { app_token: APP_TOKEN, table_id: tableId },
    data: { records: updates },
  });
  if (res.code !== 0) throw new Error(`更新失败: ${res.msg} (${res.code})`);
  return updates.length;
}

/** 获取选题池已有标题（去重用） */
async function getPoolTitles() {
  const res = await client.request({
    method: "POST",
    url: `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${POOL_TABLE}/records/search`,
    data: { page_size: 500, field_names: ["标题", "来源平台"] },
  });
  const set = new Set();
  for (const item of (res.data?.items || [])) {
    const t = extractText(item.fields["标题"]);
    const p = extractText(item.fields["来源平台"]);
    set.add(p + "|" + t);
  }
  return set;
}

async function writeToPool(records) {
  if (!records.length) return 0;
  const res = await client.bitable.appTableRecord.batchCreate({
    path: { app_token: APP_TOKEN, table_id: POOL_TABLE },
    data: { records },
  });
  if (res.code !== 0) throw new Error(`写入选题池失败: ${res.msg}`);
  return res.data.records.length;
}

// ── 核心流程 ──

async function processPlatform(platform, poolTitles) {
  const { name, tableId } = platform;
  console.log(`\n[${name}] 获取最新一批热搜...`);

  const records = await getLatestBatch(tableId);
  const unrated = records.filter(r => !r.rating);

  if (!unrated.length) {
    console.log(`[${name}] 最新批次已全部评分，跳过`);
    return;
  }
  console.log(`[${name}] 最新批次 ${records.length} 条，未评分 ${unrated.length} 条`);

  // 构建话题列表
  const topicList = unrated.map(r =>
    `${r.rank}. ${r.title} | 热度:${r.hot} 增长:${r.growth} 状态:${r.status}`
  ).join("\n");

  const baseInput = `以下是${name}热搜 ${unrated.length} 条话题，评估对「老李」的适配度：\n\n${topicList}`;

  // Skill2 → Skill3 循环
  let recommendations = null;
  let feedback = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isRetry = attempt > 0;
    const input = isRetry
      ? `${baseInput}\n\n## 审核反馈\n${feedback}`
      : baseInput;

    console.log(`[${name}] Skill2 ${isRetry ? `重试(${attempt})` : "评估中"}...`);
    const skill2Raw = await callClaude(SKILL2_SYSTEM, input);

    try {
      recommendations = parseJSON(skill2Raw);
    } catch (e) {
      console.log(`[${name}] ⚠ Skill2 解析失败: ${e.message}`);
      console.log(`[${name}]   前200字: ${skill2Raw.slice(0, 200)}`);
      return;
    }

    console.log(`[${name}] Skill3 审核中...`);
    const skill3Input = `审核${name}热搜 ${recommendations.length} 条推荐：\n${JSON.stringify(recommendations, null, 2)}`;
    const skill3Raw = await callClaude(SKILL3_SYSTEM, skill3Input);

    let review;
    try { review = parseJSON(skill3Raw); } catch { break; }

    if (review.approved) {
      console.log(`[${name}] ✓ 审核通过`);
      break;
    } else {
      feedback = review.feedback || "质量不达标";
      if (review.issues?.length) {
        feedback += "\n" + review.issues.map(i => `- ${i.title}: ${i.problem}`).join("\n");
      }
      console.log(`[${name}] ✗ 驳回: ${(review.feedback || "").slice(0, 60)}`);
      if (attempt === MAX_RETRIES) console.log(`[${name}] 达最大重试，采用当前结果`);
    }
  }

  if (!recommendations?.length) return;

  // 匹配 & 更新
  const recMap = new Map(recommendations.map(r => [r.title, r]));
  const updates = [];
  const poolRecords = [];
  const counts = { high: 0, mid: 0, low: 0 };

  for (const record of unrated) {
    const rec = recMap.get(record.title) || { rating: "低", reason: "未评估", quote: "" };

    updates.push({
      record_id: record.record_id,
      fields: { "适配度": rec.rating, "推荐理由": rec.reason, "老李金句": rec.quote },
    });

    if (rec.rating === "高") counts.high++;
    else if (rec.rating === "中") counts.mid++;
    else counts.low++;

    // 高适配 + 选题池没有 → 写入
    if (rec.rating === "高" && !poolTitles.has(name + "|" + record.title)) {
      const linkUrl = record.link?.link || "";
      poolRecords.push({
        fields: {
          "来源平台": name,
          "标题": record.title,
          "热度": record.hot,
          "增长值": record.growth || 0,
          "适配度": "高",
          "推荐理由": rec.reason,
          "老李金句": rec.quote,
          ...(linkUrl ? { "链接": { link: linkUrl, text: record.title } } : {}),
          "推荐时间": Date.now(),
        },
      });
      poolTitles.add(name + "|" + record.title); // 防本次重复
    }
  }

  if (updates.length) {
    const n = await batchUpdateRecords(tableId, updates);
    console.log(`[${name}] 更新 ${n} 条 (高${counts.high} 中${counts.mid} 低${counts.low})`);
  }
  if (poolRecords.length) {
    const n = await writeToPool(poolRecords);
    console.log(`[${name}] → 选题池 +${n} 条`);
  } else {
    console.log(`[${name}] 选题池无新增（已有或无高适配）`);
  }
}

// ── 主流程 ──

async function main() {
  const startTime = Date.now();
  const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const filterRoute = process.argv[2]; // 可选：只处理指定平台

  let platforms = ALL_PLATFORMS;
  if (filterRoute) {
    platforms = ALL_PLATFORMS.filter(p => p.route === filterRoute);
    if (!platforms.length) {
      console.log(`未知平台: ${filterRoute}，可选: ${ALL_PLATFORMS.map(p=>p.route).join(", ")}`);
      return;
    }
  }

  console.log("====== 老李选题推荐系统 ======");
  console.log(`时间: ${timeStr} | 模型: ${MODEL}`);
  if (filterRoute) console.log(`指定平台: ${filterRoute}`);

  // 预加载选题池标题（去重）
  const poolTitles = await getPoolTitles();
  console.log(`选题池已有 ${poolTitles.size} 条`);

  for (const p of platforms) {
    try {
      await processPlatform(p, poolTitles);
    } catch (err) {
      console.log(`[${p.name}] ✗ 错误: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n====== 完成 (${elapsed}s) ======`);
}

main().catch(err => {
  console.error("[致命错误]", err.message || err);
  process.exit(1);
});
