const { setPostToolUseCallback, setSessionEndCallback, setPreCompactCallback } = require('./hooks');
const { MemoryManager } = require('./memory');
const { MemoryMetrics } = require('./memory/metrics');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_MAX_SIZE_MB = 10;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_DIR = process.env.SESSION_DIR || path.join(os.homedir(), '.claude', 'projects', '-home-' + (process.env.USER || 'user') + '-' + path.basename(process.cwd()));

class Gateway {
  constructor({ session, claude, memory }) {
    this.session = session;
    this.claude = claude;
    this.memory = memory || new MemoryManager();
    this.metrics = new MemoryMetrics();

    // Hook: 会话结束时保存摘要
    setSessionEndCallback(async (sessionId) => {
      await this._endSession(sessionId);
    });

    // Hook: 上下文压缩前保存记忆（防止 compaction 丢失对话状态）
    setPreCompactCallback(async (sessionId) => {
      const conv = this.memory.activeConversations.get(sessionId);
      if (!conv) return;
      const chatId = conv.chatId;
      const chatType = conv.chatType;
      console.log(`[Gateway] PreCompact: saving memory for session ${sessionId.substring(0, 8)}...`);
      await this._endSession(sessionId);
      // 压缩后对话继续，重新开始追踪
      this.memory.startConversation(sessionId, chatId, chatType);
    });

    // Hook: 工具使用记录（PostToolUse → 记忆追踪）
    setPostToolUseCallback((sessionId, toolName, toolInput) => {
      try {
        this.memory.recordToolUse(sessionId, toolName, toolInput);
      } catch (err) {
        // 非阻塞：记录失败不影响主流程
      }
    });
  }

  /**
   * 核心处理管线：记忆检索 → Session → Claude → 记忆追踪
   * @returns {{ text, sessionId, isNewSession, pipelineMetrics }}
   */
  async processMessage({ chatId, text, mediaFiles = [], chatType, channelLabel, senderName, userProfile }) {
    // 1. 记忆检索
    let memoryContext = '';
    let retrievalMs = 0, injectedCount = 0, retrievalMemories = [];
    const retrievalStart = Date.now();
    try {
      const memories = await this.memory.retrieveRelevantMemories(text, chatId);
      memoryContext = memories.systemMessage || '';
      if (memoryContext) {
        console.log(`[Gateway] Injected ${memories.recentConversations.length} relevant memories`);
        injectedCount = memories.recentConversations.length;
        retrievalMemories = memories.recentConversations || [];
      }
    } catch (err) {
      console.warn('[Gateway] Memory retrieval failed (non-blocking):', err.message);
    }
    retrievalMs = Date.now() - retrievalStart;

    // 2. Session 过期/大小检查 + 轮转
    let existingSessionId = this.session.get(chatId);
    let isNewSession = !existingSessionId;

    if (existingSessionId) {
      const size = this._getSessionSize(existingSessionId);
      if (size > SESSION_MAX_SIZE_MB * 1024 * 1024) {
        console.log(`[Gateway] Session ${existingSessionId.substring(0, 8)} too large (${Math.round(size / 1024 / 1024)}MB), rotating`);
        await this._endSession(existingSessionId);
        this.session.clear(chatId);
        existingSessionId = null;
        isNewSession = true;
      } else if (Date.now() - (this.session.sessions[chatId]?.updatedAt || 0) > SESSION_MAX_AGE_MS) {
        console.log('[Gateway] Session expired, rotating');
        await this._endSession(existingSessionId);
        this.session.clear(chatId);
        existingSessionId = null;
        isNewSession = true;
      }
    }

    // 3. 构建带记忆上下文的 prompt
    const enrichedPrompt = this._buildEnrichedPrompt(text, memoryContext, senderName, userProfile);

    // 4. Claude 调用（resume 失败自动重试）
    let response;
    try {
      response = await this.claude.chat(enrichedPrompt, existingSessionId, mediaFiles);
    } catch (err) {
      if (existingSessionId && err.message.includes('exited with code')) {
        console.warn(`[Gateway] Resume failed (${err.message}), retrying with fresh session`);
        this.session.clear(chatId);
        isNewSession = true;
        try {
          response = await this.claude.chat(enrichedPrompt, null, mediaFiles);
        } catch (retryErr) {
          // P5-3: 重试也失败时保存 sessionId，防止会话丢失
          if (retryErr.sessionId) {
            this.session.set(chatId, retryErr.sessionId);
          }
          throw retryErr;
        }
      } else {
        // P5-3: Claude 调用失败时保存 sessionId，防止会话丢失
        if (err.sessionId) {
          this.session.set(chatId, err.sessionId);
        }
        throw err;
      }
    }

    // 5. Session 保存 + 记忆追踪
    if (response.sessionId) {
      this.session.set(chatId, response.sessionId);

      if (isNewSession) {
        this.memory.startConversation(response.sessionId, chatId, channelLabel || chatType);
      }
      this.memory.recordMessage(response.sessionId, { role: 'user', content: text });
      this.memory.archiveMessage(chatId, 'user', text, response.sessionId, { mediaFiles: mediaFiles.map(f => f.path) });
      this.memory.recordMessage(response.sessionId, { role: 'assistant', content: response.result });
      this.memory.archiveMessage(chatId, 'assistant', response.result, response.sessionId);

      // 实体提取：从用户消息和助手回复中提取关键词
      try {
        const entities = this._extractEntities(text, response.result);
        if (entities.length > 0) {
          this.memory.recordEntities(response.sessionId, entities);
        }
      } catch (err) {
        // 非阻塞：实体提取失败不影响主流程
      }

      // 检查是否需要压缩/保存摘要
      if (this.memory.shouldCompress(response.sessionId)) {
        console.log(`[Gateway] Memory compress triggered for session ${response.sessionId.substring(0, 8)}`);
        try {
          await this._endSession(response.sessionId);
          this.memory.startConversation(response.sessionId, chatId, channelLabel || chatType);
        } catch (err) {
          console.warn('[Gateway] Memory compress failed:', err.message);
        }
      }
    }

    return {
      text: response.result,
      sessionId: response.sessionId,
      isNewSession,
      pipelineMetrics: {
        retrievalMs,
        injectedCount,
        retrievalMemories,
        memoryContext,
        enrichedPrompt,
      },
    };
  }

  _buildEnrichedPrompt(userMessage, memoryContext, senderName, userProfile) {
    const message = senderName ? `[${senderName}]: ${userMessage}` : userMessage;
    let prefix = '';

    // 注入用户偏好
    if (userProfile) {
      const prefs = [];
      if (userProfile.userName) prefs.push(`称呼用户为「${userProfile.userName}」`);
      if (userProfile.agentName) prefs.push(`你的名字是 ${userProfile.agentName}`);
      if (userProfile.language === 'en') prefs.push('使用英文回复');
      if (prefs.length > 0) {
        prefix += `<user-preferences>${prefs.join('；')}</user-preferences>\n\n`;
      }
    }

    if (memoryContext) {
      prefix += `<memory-context>\n${memoryContext}</memory-context>\n\n`;
    }

    return prefix ? prefix + message : message;
  }

  _getSessionSize(sessionId) {
    try {
      const sessionFile = path.join(SESSION_DIR, `${sessionId}.jsonl`);
      return fs.statSync(sessionFile).size;
    } catch {
      return 0;
    }
  }

  /**
   * 从文本中提取实体关键词（简单规则，不依赖 AI）
   * - 代码标识符（驼峰/下划线命名，如 processMessage、user_count）
   * - 技术术语（nginx、docker、redis 等常见词）
   * - 文件路径（/开头或含.扩展名）
   */
  _extractEntities(...texts) {
    const combined = texts.join(' ');
    const entities = new Set();

    // 代码标识符：camelCase, snake_case, PascalCase（至少含一个大写或下划线）
    const codeIds = combined.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g) || [];
    const camelCase = combined.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) || [];
    const snakeCase = combined.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];

    for (const id of [...codeIds, ...camelCase, ...snakeCase]) {
      if (id.length >= 4 && id.length <= 60) entities.add(id);
    }

    // 文件路径
    const filePaths = combined.match(/(?:\/[\w.-]+){2,}/g) || [];
    for (const fp of filePaths) {
      if (fp.length <= 100) entities.add(fp);
    }

    // 技术术语（常见的不太可能出现在普通中文对话中的词）
    const TECH_TERMS = new Set([
      'nginx', 'docker', 'redis', 'mysql', 'postgresql', 'mongodb',
      'node', 'nodejs', 'python', 'golang', 'rust', 'java',
      'git', 'github', 'gitlab', 'npm', 'yarn', 'pnpm',
      'api', 'sdk', 'mcp', 'ssh', 'ssl', 'tls', 'http', 'https',
      'linux', 'ubuntu', 'debian', 'centos',
      'systemd', 'cron', 'tmux', 'vim',
      'claude', 'openai', 'gpt', 'llm', 'embedding',
      'feishu', 'bitable', 'webhook', 'websocket',
      'cos', 'oss', 's3', 'cdn',
      'typescript', 'javascript', 'json', 'yaml', 'toml',
      'react', 'vue', 'nextjs', 'express', 'fastify',
      'kubernetes', 'k8s', 'terraform', 'ansible',
      'sqlite', 'postgres', 'influxdb', 'prometheus', 'grafana',
    ]);

    const words = combined.toLowerCase().split(/[\s,;:!?。，；：！？()\[\]{}"'`]+/);
    for (const w of words) {
      if (TECH_TERMS.has(w)) entities.add(w);
    }

    return [...entities].slice(0, 30);
  }

  /**
   * 切换到历史会话（归档当前 → 恢复目标）
   */
  async switchSession(chatId, targetSessionId) {
    const currentSessionId = this.session.get(chatId);
    if (currentSessionId && currentSessionId !== targetSessionId) {
      await this._endSession(currentSessionId);
      this.session.archiveCurrent(chatId);
    }
    this.session.restore(chatId, targetSessionId);
  }

  async _endSession(sessionId) {
    try {
      await this.memory.endConversation(sessionId);
    } catch (err) {
      console.warn('[Gateway] Failed to end conversation:', err.message);
    }
  }
}

module.exports = { Gateway };
