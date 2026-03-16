const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { hooks } = require("./hooks");

const execFileAsync = promisify(execFile);
const IMAGE_COMPRESS_THRESHOLD = 512 * 1024; // 512KB 以上才压缩
const IMAGE_MAX_DIM = 1024;                   // 压缩后长边最大 1024px

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-6';
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const MEDIA_DIR = path.join(__dirname, '..', 'media');

// Lazy-load ESM module (SDK is ESM-only, our project is CommonJS)
let _query = null;
async function loadSDK() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

const MCP_FEISHU_SERVER = {
  command: process.env.MCP_NODE_PATH || process.execPath,
  args: [process.env.MCP_FEISHU_PATH || __dirname + "/mcp-feishu.mjs"],
};

const MCP_VIDEO_SERVER = {
  command: process.env.MCP_NODE_PATH || process.execPath,
  args: [__dirname + "/mcp-video.mjs"],
};

const MCP_COS_SERVER = {
  command: process.env.MCP_NODE_PATH || process.execPath,
  args: [__dirname + "/mcp-cos.mjs"],
  env: {
    COS_SECRET_ID: process.env.COS_SECRET_ID,
    COS_SECRET_KEY: process.env.COS_SECRET_KEY,
  },
};

/**
 * JSON 解析（多策略 fallback）
 */
function parseJSON(text) {
  let s = text.replace(/\`\`\`json\s*/g, "").replace(/\`\`\`/g, "").trim();
  try { return JSON.parse(s); } catch {}

  const i = s.indexOf("[") >= 0 ? s.indexOf("[") : s.indexOf("{");
  if (i >= 0) s = s.slice(i);
  try { return JSON.parse(s); } catch {}

  // 截断恢复
  for (let pos = s.lastIndexOf("}"); pos > 0; pos = s.lastIndexOf("}", pos - 1)) {
    const suffix = s[i] === "[" ? "]" : "}";
    try { return JSON.parse(s.slice(0, pos + 1) + suffix); } catch {}
  }

  // 修复未转义双引号（Claude 在字符串值中直接写引号的常见错误）
  try { return JSON.parse(_fixUnescapedQuotes(s)); } catch {}

  console.error("[parseJSON] All attempts failed. Raw text:", text.slice(0, 500));
  throw new Error("JSON parse failed");
}

// 逐字符扫描，对字符串值内部的裸 " 补转义
function _fixUnescapedQuotes(s) {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && inString) {
      result += ch + (s[i + 1] || '');
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
      } else {
        // 向后跳过空白，看下一个有效字符
        let j = i + 1;
        while (j < s.length && ' \t\r\n'.includes(s[j])) j++;
        const next = j < s.length ? s[j] : '';
        // 如果下一个有效字符是 JSON 结构符，说明这个 " 是关闭引号
        if (!next || ':,}]'.includes(next)) {
          inString = false;
          result += ch;
        } else {
          result += '\\"';
        }
      }
      i++;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

class ClaudeClient {
  constructor({ model } = {}) {
    this.model = model || DEFAULT_MODEL;
    this.baseUrl = BASE_URL;
    this.apiKey = API_KEY;
  }

  /**
   * 单轮 Messages API 调用（推荐管线用）
   */
  async complete(system, userMessage, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 4096;

    const body = {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    };

    // Schema 模式：通过 tool_use 强制结构化返回
    if (options.schema) {
      body.tools = [{
        name: 'structured_output',
        description: 'Return structured data',
        input_schema: options.schema,
      }];
      body.tool_choice = { type: 'tool', name: 'structured_output' };
    }

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();

    // Schema 模式：从 tool_use block 提取 JSON
    if (options.schema) {
      const toolBlock = data.content.find(b => b.type === 'tool_use');
      if (toolBlock) {
        return {
          json: toolBlock.input,
          usage: data.usage || {},
          stop_reason: data.stop_reason,
        };
      }
      // fallback: 如果没有 tool_use block，按文本处理
    }

    return {
      text: data.content[0].text,
      usage: data.usage || {},
      stop_reason: data.stop_reason,
    };
  }

  /**
   * @param {string} prompt
   * @param {string|null} sessionId
   * @param {Array<{type: string, path: string, name: string}>} mediaFiles
   * @param {{ effort?: 'low'|'high' }} chatOptions
   */
  async chat(prompt, sessionId = null, mediaFiles = [], chatOptions = {}) {
    const query = await loadSDK();

    const options = {
      model: this.model,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
      settingSources: ['project', 'user'],
      mcpServers: {
        "feishu": MCP_FEISHU_SERVER,
        "video-downloader": MCP_VIDEO_SERVER,
        "tencent-cos": MCP_COS_SERVER,
      },
      allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "Write", "Edit", "Bash", "mcp__feishu__*", "mcp__video-downloader__*", "mcp__tencent-cos__*"],
      hooks,
    };

    if (chatOptions.effort) {
      options.effort = chatOptions.effort;
    }

    if (sessionId) {
      options.resume = sessionId;
    }

    // 图片处理：ImageMagick 压缩（大图）→ Read 工具（Claude 直接看图）
    let queryPrompt = prompt;
    const tmpFiles = [];

    if (mediaFiles.length > 0) {
      const fileParts = [];

      for (const f of mediaFiles) {
        if (f.type === 'image') {
          let readPath = f.path;
          try {
            const { size } = fs.statSync(f.path);
            if (size > IMAGE_COMPRESS_THRESHOLD) {
              const tmp = f.path + '._compressed.jpg';
              await execFileAsync('convert', [
                '-resize', `${IMAGE_MAX_DIM}x${IMAGE_MAX_DIM}>`,
                '-quality', '85',
                f.path, tmp,
              ], { timeout: 15000 });
              tmpFiles.push(tmp);
              readPath = tmp;
              console.log(`[Claude] Image compressed: ${(size / 1024).toFixed(0)}KB → ${(fs.statSync(tmp).size / 1024).toFixed(0)}KB`);
            }
          } catch (err) {
            console.warn(`[Claude] Compress failed, image skipped: ${err.message.split('\n')[0]}`);
            continue;
          }
          fileParts.push(`图片: ${readPath}`);
        } else {
          fileParts.push(`文件 (${f.name}): ${f.path}`);
        }
      }

      const userText = prompt || '请查看这些内容并回答';
      if (fileParts.length > 0) {
        queryPrompt = `用户发送了以下文件，请先用 Read 工具查看：\n${fileParts.join('\n')}\n\n${userText}`;
      }
    }

    console.log(`[Claude] Calling (${this.model}): ${sessionId ? 'resume ' + sessionId.substring(0, 8) + '...' : 'new session'}`);
    const startTime = Date.now();

    let resultText = '';
    let resultSessionId = '';

    try {
      for await (const message of query({ prompt: queryPrompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          resultSessionId = message.session_id;
          if (message.mcp_servers) {
            const serverInfo = Array.isArray(message.mcp_servers) ? message.mcp_servers.map(s => `${s.name}:${s.status}`) : Object.keys(message.mcp_servers);
            console.log('[Claude] MCP servers:', serverInfo.join(', '));
          }
        }
        if (message.type === 'result') {
          resultSessionId = message.session_id || resultSessionId;
          if (message.subtype === 'success') {
            resultText = message.result;
          } else if (message.subtype === 'error_max_turns') {
            // maxTurns 用完：返回已有结果而非报错
            console.warn(`[Claude] Max turns reached (${message.num_turns}), cost: $${message.total_cost_usd?.toFixed(2)}, duration: ${Math.round((message.duration_ms || 0) / 1000)}s`);
            resultText = message.result || '任务较复杂，已处理了一部分。你可以继续发消息让我接着完成剩余部分。';
          } else {
            const errorDetail = message.result || message.error || JSON.stringify(message);
            console.error(`[Claude] SDK error (subtype=${message.subtype}):`, errorDetail);
            const err = new Error(errorDetail || 'Claude returned an error');
            err.sessionId = resultSessionId; // P5-3: 附带 sessionId 防丢失
            throw err;
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Claude] Response in ${elapsed}s, session: ${resultSessionId?.substring(0, 8)}...`);

      if (!resultText) {
        const err = new Error('No result from Claude');
        err.sessionId = resultSessionId; // P5-3: 附带 sessionId 防丢失
        throw err;
      }

      return { result: resultText, sessionId: resultSessionId };
    } finally {
      for (const tmp of tmpFiles) try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

module.exports = { ClaudeClient, parseJSON, MEDIA_DIR };
