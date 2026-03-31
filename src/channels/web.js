'use strict';
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const SYSTEM_PROMPT = `你是一位顶级产品经理，专门帮助非技术用户把模糊想法变成可以直接执行的需求方案。

## 对话原则
1. 温和亲切，像朋友聊天
2. 一次只问一个问题
3. 用户答不出时，给 2-4 个选项让他选
4. 检测到方案先行时（"用多agent做XX"），先剥离方案，搞清楚问题本身

## 三个阶段（按顺序走完）

### 阶段一：需求澄清
收集以下六个维度，信息不完整时继续追问：
- 谁在用（WHO）
- 现在怎么做（AS-IS）
- 核心痛点（PAIN）
- 为什么要解决（WHY）
- 成功标准（DONE）
- 约束条件（LIMIT：预算/时间/技术）

### 阶段二：技术方案推介
六个维度收集完后，推介 2-3 个技术方案。每个方案用大白话解释：
- 一句话说清楚这个方案是什么
- 生活类比（让完全不懂技术的人也能理解）
- 优点和缺点（用用户关心的维度，如成本、上手难度、效果）
- 适合什么情况

然后给出推荐方案和理由，请用户选择。
**注意：只介绍方案，不执行任何操作。**

### 阶段三：收集联系方式 + 输出确认卡
用户选定方案后，问：
「最后一步，留个联系方式方便后续跟进（微信号或手机号，可跳过）：」

无论用户是否填写，都输出确认卡。格式必须严格如下：

【需求确认】
**一句话总结：** [用一句话概括需求]
**谁在用：** [用户角色]
**现状：** [现在怎么做]
**核心痛点：** [最痛的地方]
**目标：** [解决后的效果]
**成功标准：** [怎么算做好了]
**约束条件：** [预算/时间/技术限制]
**选定方案：** [用户选择的方案名称]
**方案描述：** [该方案的技术实现方向，50字以内]
**预期产物：** [做完交付什么，如：网页工具/脚本/自动化流程]
**联系方式：** [用户填写的联系方式，未填写则写"未提供"]
【/需求确认】

以上信息准确吗？如果确认，点击下方的「提交需求」按钮！

---

对话语言：全程中文，亲切自然。`;

const INIT_MESSAGE = '你好！我是你的需求顾问 🙋 今天有什么想法或者烦恼，随便说，我帮你理清楚～';

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const mod = options.port === 80 ? http : https;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getFeishuToken() {
  const body = JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
  const res = await httpsRequest({
    hostname: 'open.feishu.cn',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  return res.body.tenant_access_token;
}

async function submitToFeishu(username, summary, turns, extra = {}) {
  const token = await getFeishuToken();
  const appToken = process.env.CLARIFY_BITABLE_APP_TOKEN;
  const tableId = process.env.CLARIFY_BITABLE_TABLE_ID;
  const body = JSON.stringify({
    fields: {
      '用户名': username,
      '提交时间': new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      '需求摘要': summary,
      '对话轮数': turns,
      '状态': '待处理',
      ...(extra.contact   && { '联系方式': extra.contact }),
      ...(extra.solution  && { '选定方案': extra.solution }),
    }
  });
  const res = await httpsRequest({
    hostname: 'open.feishu.cn',
    path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.body.code !== 0) throw new Error(JSON.stringify(res.body));
  // 返回 record_id 供后续评估写回
  return res.body.data?.record?.record_id || null;
}

// 更新飞书记录（写入评估结果）
async function updateFeishuRecord(recordId, fields) {
  const token = await getFeishuToken();
  const appToken = process.env.CLARIFY_BITABLE_APP_TOKEN;
  const tableId = process.env.CLARIFY_BITABLE_TABLE_ID;
  const body = JSON.stringify({ fields });
  const res = await httpsRequest({
    hostname: 'open.feishu.cn',
    path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.body.code !== 0) throw new Error(JSON.stringify(res.body));
}

// ── Demo 执行 Pipeline ──────────────────────────────────────────

// 按用户名查飞书记录
async function findFeishuRecord(username) {
  const token = await getFeishuToken();
  const appToken = process.env.CLARIFY_BITABLE_APP_TOKEN;
  const tableId  = process.env.CLARIFY_BITABLE_TABLE_ID;
  const res = await httpsRequest({
    hostname: 'open.feishu.cn',
    path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=50`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const items = res.body.data?.items || [];
  // 找最新一条匹配用户名且是「可做Demo」的记录
  const matched = items.filter(r =>
    r.fields['用户名'] === username &&
    r.fields['是否建议Demo'] === '建议Demo'
  );
  if (!matched.length) throw new Error(`未找到用户「${username}」的可执行需求`);
  return matched[matched.length - 1]; // 最新一条
}

// 根据飞书字段生成技术 brief，然后调 Claude 生成 demo 代码
async function generateDemoCode(fields) {
  const apiKey  = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const model   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const isHttps = baseUrl.protocol === 'https:';
  const mod     = isHttps ? https : http;

  const brief = `你是一位全栈工程师，根据以下需求文档生成一个可以直接运行的 HTML Demo。

## 用户需求
${fields['需求摘要'] || ''}

## 选定方案
${fields['选定方案'] || ''} — ${fields['评估结论'] || ''}

## 预期产物
${fields['推荐方案'] || '单文件网页'}

## 技术要求
- 输出单文件 HTML（完全自包含，可直接在浏览器打开）
- 功能实际可用，不是纯 mockup，要有真实的交互逻辑
- 使用 CDN 引入所需库（Tailwind CSS, Alpine.js, Chart.js 等按需选择）
- 界面中文，简洁美观
- 用注释说明关键逻辑
- 如有表单，提交后给出反馈
- 数据可以用模拟数据，但交互要真实

只输出 HTML 代码，从 <!DOCTYPE html> 开始，不要任何解释文字。`;

  const bodyStr = JSON.stringify({
    model,
    messages: [{ role: 'user', content: brief }],
    max_tokens: 4096,
  });

  const result = await new Promise((resolve, reject) => {
    const r = mod.request({
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: (baseUrl.pathname || '').replace(/\/$/, '') + '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
      },
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    r.on('error', reject);
    r.write(bodyStr); r.end();
  });

  const code = result.content?.[0]?.text || '';
  if (!code.includes('<!DOCTYPE')) throw new Error('Claude 未返回有效 HTML');
  return code;
}

// 部署 demo 到子域名（复用 Deployer 的 sudo 权限机制）
async function deployDemo(username, htmlCode) {
  const fs   = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  // 中文用户名会变空，加时间戳后缀确保唯一
  const nameSlug = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  const slug     = (nameSlug || 'u') + '-' + Date.now().toString(36).slice(-4);
  const taskId   = `clarify-${slug}`;
  const sitesDir = process.env.SITES_DIR;

  // 写 HTML 到临时输出目录
  const outputDir = path.join(sitesDir, `_tmp_${taskId}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'index.html'), htmlCode, 'utf8');

  // 用 Deployer 部署（它内部用 sudo cp 处理 nginx conf）
  const { Deployer } = require(path.join(__dirname, '..', 'deployer'));
  const deployer = new Deployer();
  const { url } = await deployer.deploy({
    taskId,
    outputDir,
    type: 'static',
    entry: 'index.html',
  });

  // 清理临时目录
  try { fs.rmSync(outputDir, { recursive: true }); } catch (_) {}

  return url;
}

// 完整 demo 执行入口
async function executeDemo(username) {
  const log = [];
  const logStep = (msg) => { log.push(msg); console.log(`[Demo] ${msg}`); };

  logStep(`开始为「${username}」生成 Demo`);

  // 1. 读飞书记录
  const record = await findFeishuRecord(username);
  const recordId = record.record_id;
  logStep(`找到记录 ${recordId}`);

  // 更新状态为「执行中」
  await updateFeishuRecord(recordId, { '状态': '执行中', '执行日志': log.join('\n') });

  // 2. 生成代码
  logStep('调用 Claude 生成 Demo 代码...');
  const html = await generateDemoCode(record.fields);
  logStep(`代码生成完成，${html.length} 字符`);

  // 3. 部署
  logStep('部署到子域名...');
  const url = await deployDemo(username, html);
  logStep(`部署成功：${url}`);

  // 4. 更新飞书记录
  await updateFeishuRecord(recordId, {
    '状态': '已完成',
    'Demo地址': url,
    '执行日志': log.join('\n'),
  });

  // 5. 飞书通知
  const { spawn } = require('child_process');
  const notifyScript = require('path').join(__dirname, '..', '..', 'scripts', 'send-notify.js');
  const msg = `🎉 Demo 已生成！\n用户：${username}\n地址：${url}\n需求：${String(record.fields['需求摘要'] || '').slice(0, 80)}`;
  spawn('node', [notifyScript, msg], { detached: true, stdio: 'ignore' }).unref();

  return { url, log };
}

// ── Demo 执行 Pipeline 结束 ────────────────────────────────────

// 评估需求（提交后异步执行，不阻塞用户）
async function evaluateRequirement(summary, recordId) {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const isHttps = baseUrl.protocol === 'https:';
  const mod = isHttps ? https : http;

  const evalPrompt = `你是一位资深产品经理和技术架构师，请评估以下用户需求，给出简洁的评估结论。

【需求内容】
${summary}

请严格按以下格式输出，不要多余内容：

是否建议Demo：[建议Demo / 文字结论 / 信息不足]
技术难度：[⭐ 简单 / ⭐⭐ 中等 / ⭐⭐⭐ 复杂]
评估结论：[2-3句话说明这个需求的核心价值、可行性、主要风险]
推荐方案：[简要描述最合适的实现方向，50字以内]

判断标准：
- 建议Demo：需求清晰、技术上可在1-2小时内用AI工具做出可演示的原型
- 文字结论：需求合理但实现复杂，或更适合给出方案建议而非现场Demo
- 信息不足：需求太模糊，无法判断方向`;

  const bodyStr = JSON.stringify({
    model,
    messages: [{ role: 'user', content: evalPrompt }],
    max_tokens: 400,
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const r = mod.request({
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path: (baseUrl.pathname || '').replace(/\/$/, '') + '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(bodyStr); r.end();
    });

    const text = result.content?.[0]?.text || '';
    console.log('[WebAdapter] Eval result:\n' + text);

    // 解析评估结果
    const demoMatch  = text.match(/是否建议Demo：(.+)/);
    const diffMatch  = text.match(/技术难度：(.+)/);
    const conclMatch = text.match(/评估结论：([\s\S]*?)(?=推荐方案：|$)/);
    const planMatch  = text.match(/推荐方案：([\s\S]*?)$/);

    const fields = { '状态': '评估中' };
    if (demoMatch)  fields['是否建议Demo'] = demoMatch[1].trim();
    if (diffMatch)  fields['技术难度']     = diffMatch[1].trim();
    if (conclMatch) fields['评估结论']     = conclMatch[1].trim();
    if (planMatch)  fields['推荐方案']     = planMatch[1].trim();
    // 评估完改状态
    fields['状态'] = demoMatch?.[1]?.includes('建议Demo') ? '可做Demo' : '已评估';

    await updateFeishuRecord(recordId, fields);
    console.log(`[WebAdapter] Eval written to record ${recordId}`);

    // 发飞书通知（非阻塞）
    const { spawn } = require('child_process');
    const notifyScript = require('path').join(__dirname, '..', '..', 'scripts', 'send-notify.js');
    const msg = [
      `📋 新需求已评估`,
      `结论：${fields['是否建议Demo'] || '?'} | 难度：${fields['技术难度'] || '?'}`,
      `需求：${summary.split('\n')[0].slice(0, 60)}...`,
      `评估：${(fields['评估结论'] || '').slice(0, 80)}`,
    ].join('\n');
    spawn('node', [notifyScript, msg], { detached: true, stdio: 'ignore' }).unref();

  } catch (err) {
    console.error('[WebAdapter] Eval error:', err.message);
    // 评估失败不影响用户，静默处理
  }
}

class WebAdapter {
  constructor() {
    this.sessions = new Map();    // token -> { username, createdAt }
    this.conversations = new Map(); // username -> Array<{role, content}>
    this.app = express();
    this._setup();
  }

  get platform() { return 'web'; }

  _setup() {
    this.app.use(express.json());
    this.app.use('/clarify', express.static(path.join(__dirname, '..', '..', 'public', 'clarify')));

    // 认证
    this.app.post('/api/clarify/auth', (req, res) => {
      const { inviteCode, username } = req.body;
      const expected = process.env.INVITE_CODE;
      if (!expected) return res.status(500).json({ error: '服务配置错误' });
      if (!inviteCode || !username || inviteCode.trim().toUpperCase() !== expected.toUpperCase()) {
        return res.status(401).json({ error: '邀请码错误或用户名为空' });
      }
      const name = username.trim().slice(0, 20);
      const token = Buffer.from(`${name}:${Date.now()}`).toString('base64');
      this.sessions.set(token, { username: name, createdAt: Date.now() });
      console.log(`[WebAdapter] Auth: ${name}`);
      res.json({ token, username: name });
    });

    // SSE 聊天
    this.app.get('/api/clarify/chat', async (req, res) => {
      const username = this._validateToken(req);
      if (!username) return res.status(401).json({ error: '请先登录' });

      const message = (req.query.message || '').trim();
      if (!message) return res.status(400).json({ error: '消息不能为空' });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // 开场白：不调用 Claude
      if (message === '__init__') {
        const history = this.conversations.get(username) || [];
        if (history.length === 0) {
          this.conversations.set(username, [{ role: 'assistant', content: INIT_MESSAGE }]);
          const escaped = INIT_MESSAGE.replace(/\n/g, '\\n');
          res.write(`data: ${escaped}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 追加用户消息
      const history = this.conversations.get(username) || [];
      history.push({ role: 'user', content: message });

      // 限制历史长度
      const messages = history; // 不限制历史长度

      // 调用 Claude Messages API (streaming)
      const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
      const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
      const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

      const bodyStr = JSON.stringify({
        model,
        system: SYSTEM_PROMPT,
        messages,
        stream: true,
        max_tokens: 2048,
      });

      const isHttps = baseUrl.protocol === 'https:';
      const mod = isHttps ? https : http;
      const reqOptions = {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path: baseUrl.pathname.replace(/\/$/, '') + '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      };

      let fullReply = '';

      const claudeReq = mod.request(reqOptions, (claudeRes) => {
        let buffer = '';
        claudeRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留不完整的行

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                const text = evt.delta.text;
                fullReply += text;
                const escaped = text.replace(/\n/g, '\\n');
                res.write(`data: ${escaped}\n\n`);
              }
            } catch (_) {}
          }
        });

        claudeRes.on('end', () => {
          // 保存 assistant 回复到历史
          if (fullReply) {
            history.push({ role: 'assistant', content: fullReply });
            this.conversations.set(username, history);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });

      claudeReq.on('error', (err) => {
        console.error('[WebAdapter] Claude API error:', err.message);
        res.write('data: [ERROR]\n\n');
        res.end();
      });

      claudeReq.write(bodyStr);
      claudeReq.end();
    });

    // 提炼需求摘要（中途提交时调用）
    this.app.post('/api/clarify/summarize', async (req, res) => {
      const username = this._validateToken(req);
      if (!username) return res.status(401).json({ error: '请先登录' });

      const history = this.conversations.get(username) || [];
      if (history.length < 2) {
        return res.json({ summary: '对话内容较少，请继续聊几句再提交～' });
      }

      const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
      const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
      const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
      const isHttps = baseUrl.protocol === 'https:';
      const mod = isHttps ? require('https') : require('http');

      const extractPrompt = `请根据以下对话记录，提炼用户的需求关键信息。
如果某个维度在对话中没有明确提到，写"未明确"。
只输出以下格式，不要其他任何内容：

一句话总结：[用一句话概括核心需求]
谁在用：[使用者是谁]
现状：[目前怎么做]
核心痛点：[最核心的问题]
目标：[希望达到的效果]
成功标准：[怎么算做好了]
约束条件：[预算/时间/技术等限制]`;

      const messages = [...history, { role: 'user', content: extractPrompt }];
      const bodyStr = JSON.stringify({ model, messages, max_tokens: 512 });

      try {
        const result = await new Promise((resolve, reject) => {
          const r = mod.request({
            hostname: baseUrl.hostname,
            port: baseUrl.port || (isHttps ? 443 : 80),
            path: (baseUrl.pathname || '').replace(/\/$/, '') + '/v1/messages',
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(bodyStr),
            },
          }, (resp) => {
            let d = '';
            resp.on('data', c => d += c);
            resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          });
          r.on('error', reject);
          r.write(bodyStr); r.end();
        });
        const text = result.content?.[0]?.text || '提炼失败，请重试';
        console.log(`[WebAdapter] Summarize: ${username}`);
        res.json({ summary: text });
      } catch (err) {
        console.error('[WebAdapter] Summarize error:', err.message);
        res.status(500).json({ error: '提炼失败，请重试' });
      }
    });

    // 提交需求
    this.app.post('/api/clarify/submit', async (req, res) => {
      const username = this._validateToken(req);
      if (!username) return res.status(401).json({ error: '请先登录' });

      const history = this.conversations.get(username) || [];
      const assistantMsgs = history.filter(m => m.role === 'assistant');
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.content || '无内容';
      const summary  = (req.body.summary  || '').trim() || lastAssistant;
      const turns    = Math.floor(history.filter(m => m.role === 'user').length);
      const extra    = {
        contact:  (req.body.contact  || '').trim() || null,
        solution: (req.body.solution || '').trim() || null,
      };

      try {
        const recordId = await submitToFeishu(username, summary, turns, extra);
        console.log(`[WebAdapter] Submit: ${username} (${turns} turns) record:${recordId}`);
        res.json({ success: true, message: '需求已提交！我们会尽快处理 🎉' });

        // fire-and-forget：提交成功后异步评估，不阻塞用户
        if (recordId) {
          evaluateRequirement(summary, recordId).catch(err =>
            console.error('[WebAdapter] Background eval failed:', err.message)
          );
        }
      } catch (err) {
        console.error('[WebAdapter] Feishu submit error:', err.message);
        res.status(500).json({ error: '提交失败，请重试' });
      }
    });

    // 执行 Demo 生成（管理员手动触发）
    this.app.post('/api/clarify/execute', async (req, res) => {
      const adminKey = process.env.CLARIFY_ADMIN_KEY;
      if (adminKey && req.headers['x-admin-key'] !== adminKey) {
        return res.status(403).json({ error: '无权限' });
      }
      const { username } = req.body;
      if (!username) return res.status(400).json({ error: '缺少 username' });

      // 立即返回，后台异步执行
      res.json({ success: true, message: `开始为「${username}」生成 Demo，完成后会飞书通知` });

      executeDemo(username).catch(err => {
        console.error(`[Demo] 执行失败 ${username}:`, err.message);
        // 尝试更新飞书状态为失败
        findFeishuRecord(username)
          .then(record => updateFeishuRecord(record.record_id, {
            '状态': '执行失败',
            '执行日志': err.message,
          }))
          .catch(() => {});
      });
    });

    // 清除对话（重新开始）
    this.app.post('/api/clarify/reset', (req, res) => {
      const username = this._validateToken(req);
      if (!username) return res.status(401).json({ error: '请先登录' });
      this.conversations.delete(username);
      res.json({ success: true });
    });
  }

  _validateToken(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return null;
    // 无状态验证：base64 解码出 "username:timestamp"
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const name = decoded.split(':')[0];
      if (!name) return null;
      return name;
    } catch (_) { return null; }
  }

  async start() {
    const port = parseInt(process.env.WEB_PORT || '3003', 10);
    this.app.listen(port, '127.0.0.1', () => {
      console.log(`[WebAdapter] Listening on 127.0.0.1:${port}`);
    });
  }

  async stop() {}
}

module.exports = { WebAdapter };
