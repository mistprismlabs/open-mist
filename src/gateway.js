const { setPostToolUseCallback, setSessionEndCallback, setPreCompactCallback, setPostCompactCallback, setStopFailureCallback, setToolFailureCallback, setTaskCreatedCallback } = require("./hooks");
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
    this.progressCallbacks = new Map();
    this._retryState = new Map(); // chatId → {attempt, maxRetries, errorStatus, ts}
    this._sessionFailures = new Map(); // chatId:sessionId → {count, lastError, ts}
    this._sessionToChatId = new Map(); // sessionId → chatId（用于 TaskCreated 等 hook 反向路由）
    this._sessionToProgressTarget = new Map(); // sessionId → progressTargetId（任务进度按通道路由）
    this._taskNotifyTs = new Map(); // chatId → lastNotifyTs（防刷屏：同一 chat 30s 内只发一条）

    // Hook: 会话结束时保存摘要
    setSessionEndCallback(async (sessionId) => {
      await this._endSession(sessionId);
    });

    // Hook: 上下文压缩前保存记忆（防止 compaction 丢失对话状态）
    setPreCompactCallback(async (sessionId) => {
      const conv = this.memory.activeConversations.get(sessionId);
      if (!conv) return;
      const { chatId, chatType, userId } = conv;
      console.log(`[Gateway] PreCompact: saving memory for session ${sessionId.substring(0, 8)}...`);
      await this._endSession(sessionId);
      // 压缩后对话继续，重新开始追踪
      this.memory.startConversation(sessionId, chatId, chatType, userId);
    });

    // Hook: 工具使用记录（PostToolUse → 记忆追踪）
    setPostToolUseCallback((sessionId, toolName, toolInput) => {
      try {
        this.memory.recordToolUse(sessionId, toolName, toolInput);
      } catch (err) {
        // 非阻塞：记录失败不影响主流程
      }
    });

    // Hook: 上下文压缩完成后，用 compact_summary 存入向量记忆
    setPostCompactCallback(async (sessionId, compactSummary) => {
      console.log(`[Gateway] PostCompact: session=${sessionId?.substring(0, 8)}, hasSummary=${!!compactSummary}`);

      if (sessionId) {
        if (compactSummary && compactSummary.trim()) {
          try {
            await this.memory.storeCompactSummary(sessionId, compactSummary);
            console.log(`[Gateway] PostCompact: compact_summary stored (${compactSummary.length} chars)`);
          } catch (e) {
            console.warn('[Gateway] PostCompact: store summary failed:', e.message);
          }
        }
        if (this.memory.activeConversations.has(sessionId)) {
          console.log(`[Gateway] PostCompact: memory tracking active for ${sessionId.substring(0, 8)}...`);
        }
      }
    });

    // Hook: API 错误（限流/认证失败等）— 标记 session 异常 + 飞书通知
    let _lastStopFailureNotify = 0;
    setStopFailureCallback(async (sessionId, error) => {
      const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
      console.error(`[Gateway] StopFailure: session ${sessionId?.substring(0, 8)}... error:`, errorStr.substring(0, 200));

      // 清理该 session 的活跃对话追踪，避免脏状态
      const conv = this.memory.activeConversations.get(sessionId);
      if (sessionId) {
        this.memory.activeConversations.delete(sessionId);
      }

      // 飞书通知（5分钟内最多1次，防刷屏）
      const now = Date.now();
      if (now - _lastStopFailureNotify < 5 * 60 * 1000) return;
      _lastStopFailureNotify = now;

      // 判断是否刚经历过重试（60秒内有重试记录 = 重试耗尽，否则 = 突发失败）
      const chatId = conv?.chatId;
      const retryState = chatId ? this._retryState.get(chatId) : null;
      const wasRetrying = retryState && (now - retryState.ts < 60 * 1000);

      let emoji, category;
      if (wasRetrying) {
        emoji = '⏳';
        category = `重试耗尽（${retryState.attempt}/${retryState.maxRetries} 次后失败，状态 ${retryState.errorStatus}）`;
        if (chatId) this._retryState.delete(chatId); // 清理重试状态
      } else {
        const lower = errorStr.toLowerCase();
        if (lower.includes('rate') || lower.includes('429') || lower.includes('throttl')) {
          emoji = '🚦'; category = '限流 (Rate Limit)';
        } else if (lower.includes('auth') || lower.includes('401') || lower.includes('403') || lower.includes('key')) {
          emoji = '🔑'; category = '认证失败 (Auth Error)';
        } else if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('server')) {
          emoji = '💥'; category = '服务端错误 (Server Error)';
        } else {
          emoji = '❌'; category = '未知错误';
        }
      }

      const { spawn } = require("child_process");
      const msg = [
        `${emoji} Jarvis API 异常: ${category}`,
        `错误: ${errorStr.substring(0, 150)}`,
        `Session: ${sessionId ? sessionId.substring(0, 8) : 'unknown'}`,
      ].join("\n");
      const notifyScript = require("path").join(__dirname, "..", "scripts", "send-notify.js");
      spawn("node", [notifyScript, msg], { detached: true, stdio: "ignore" }).unref();
    });

    // Hook: 工具执行失败 — 发飞书通知（2分钟内最多1次，防刷屏）
    let _lastToolFailureNotify = 0;
    setToolFailureCallback(async (sessionId, toolName, error) => {
      const now = Date.now();
      if (now - _lastToolFailureNotify < 2 * 60 * 1000) return;
      _lastToolFailureNotify = now;
      const { spawn } = require("child_process");
      const msg = [
        "⚠️ Jarvis 工具执行失败",
        "工具: " + toolName,
        "错误: " + error.substring(0, 150),
        "Session: " + (sessionId ? sessionId.substring(0, 8) : "unknown"),
      ].join("\n");
      const notifyScript = require("path").join(__dirname, "..", "scripts", "send-notify.js");
      spawn("node", [notifyScript, msg], { detached: true, stdio: "ignore" }).unref();
    });

    // Hook: 任务创建通知（TaskCreated → onProgress → 用户所在渠道）
    setTaskCreatedCallback(async (sessionId, _taskId, subject) => {
      if (!subject || subject.length < 3) return; // 过滤空任务
      const chatId = this._sessionToChatId.get(sessionId);
      const progressTargetId = this._sessionToProgressTarget.get(sessionId);
      if (!chatId || !progressTargetId || this.progressCallbacks.size === 0) return;

      // 30s 防刷屏：同一 chat 内连续任务只通知一次
      const now = Date.now();
      if (now - (this._taskNotifyTs.get(chatId) || 0) < 30 * 1000) return;
      this._taskNotifyTs.set(chatId, now);

      this._emitProgress(progressTargetId, `📋 ${subject}`);
    });
  }

  /**
   * 核心处理管线：记忆检索 → Session → Claude → 记忆追踪
   * @returns {{ text, sessionId, isNewSession, pipelineMetrics }}
   */
  registerProgressCallback(name, fn) {
    if (!name) throw new Error('progress callback name is required');
    if (typeof fn !== 'function') throw new Error('progress callback must be a function');
    this.progressCallbacks.set(name, fn);
    return () => this.progressCallbacks.delete(name);
  }

  setProgressCallback(fn) {
    return this.registerProgressCallback('default', fn);
  }

  _emitProgress(targetId, info) {
    for (const callback of this.progressCallbacks.values()) {
      callback(targetId, info);
    }
  }

  async processMessage({ chatId, text, mediaFiles = [], chatType, channelLabel, senderName, userProfile, userId, progressTargetId }) {
    // 1. 记忆检索
    let memoryContext = '';
    let retrievalMs = 0, injectedCount = 0, retrievalMemories = [];
    const retrievalStart = Date.now();
    try {
      const memories = await this.memory.retrieveRelevantMemories(text, chatId, userId);
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

    // 4. 评估消息复杂度 → effort 参数
    const effort = this._assessEffort(text);
    if (effort) {
      console.log(`[Gateway] Effort: ${effort} (text length: ${text.length})`);
    }

    // 5. Claude 调用（resume 失败自动重试）
    const onProgress = (this.progressCallbacks.size > 0 && progressTargetId)
      ? (summary) => this._emitProgress(progressTargetId, summary)
      : undefined;
    const onRetry = (info) => { this._retryState.set(chatId, { ...info, ts: Date.now() }); };
    const onSessionInit = (sessionId) => {
      this._sessionToChatId.set(sessionId, chatId);
      if (progressTargetId) this._sessionToProgressTarget.set(sessionId, progressTargetId);
    };
    let response;
    try {
      response = await this.claude.chat(enrichedPrompt, existingSessionId, mediaFiles, { effort, onProgress, onRetry, onSessionInit });
    } catch (err) {
      if (existingSessionId && err.message.includes('exited with code')) {
        console.warn(`[Gateway] Resume failed (${err.message}), retrying with fresh session`);
        this.session.clear(chatId);
        isNewSession = true;
        try {
          response = await this.claude.chat(enrichedPrompt, null, mediaFiles, { effort, onProgress });
        } catch (retryErr) {
          // P5-3: 重试也失败时保存 sessionId，防止会话丢失
          if (retryErr.sessionId) {
            this.session.set(chatId, retryErr.sessionId);
            this._sessionToChatId.set(retryErr.sessionId, chatId);
          }
          throw retryErr;
        }
      } else {
        // P5-3: Claude 调用失败时保存 sessionId，防止会话丢失
        // 但若是 "No result from Claude" 连续失败同一 session → 自动切换
        if (err.sessionId) {
          const failKey = `${chatId}:${err.sessionId.substring(0, 8)}`;
          const prev = this._sessionFailures.get(failKey) || { count: 0 };
          const newCount = prev.count + 1;

          if (err.message === 'No result from Claude' && newCount >= 1) {
            // 第一次 No result 就切换：session 损坏时继续 resume 只会更糟
            console.warn(`[Gateway] Session ${err.sessionId.substring(0, 8)} returned no result, switching to new session`);
            this.session.clear(chatId);
            this._sessionFailures.delete(failKey);
            // 在 error 上标记，让 channel 层发特殊通知
            err.sessionSwitched = true;
            err.brokenSessionId = err.sessionId;
            err.failCount = newCount;
          } else {
            this.session.set(chatId, err.sessionId);
            this._sessionToChatId.set(err.sessionId, chatId);
            if (err.message === 'No result from Claude') {
              this._sessionFailures.set(failKey, { count: newCount, lastError: err.message, ts: Date.now() });
            }
          }
        }
        throw err;
      }
    }

    // 6. Session 保存 + 记忆追踪（成功时清除失败计数）
    if (response.sessionId) {
      this.session.set(chatId, response.sessionId);
      this._sessionToChatId.set(response.sessionId, chatId); // 反向路由（供 TaskCreated hook 使用）
      // 清除该 chat 所有失败计数
      for (const k of this._sessionFailures.keys()) {
        if (k.startsWith(chatId + ':')) this._sessionFailures.delete(k);
      }

      if (isNewSession) {
        this.memory.startConversation(response.sessionId, chatId, channelLabel || chatType, userId);
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
          this.memory.startConversation(response.sessionId, chatId, channelLabel || chatType, userId);
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
   * 评估消息复杂度，决定 effort 级别
   * @returns {'low'|'high'|undefined}
   */
  _assessEffort(text) {
    const len = text.length;
    const hasCodeBlock = /```/.test(text);
    const hasFilePath = /\/[\w.-]+\//.test(text);
    const complexKeywords = /部署|重构|分析|优化|迁移|设计|架构|debug|refactor|deploy|migrate/i;
    const hasComplexKeyword = complexKeywords.test(text);

    if (hasCodeBlock || hasFilePath || hasComplexKeyword || len > 200) {
      return 'high';
    }
    if (len < 50) {
      return 'low';
    }
    return undefined; // 使用默认值
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
      // 取首条用户消息作为历史摘要
      const conv = this.memory.activeConversations?.get(currentSessionId);
      let firstMessage = null;
      if (conv?.messages?.length) {
        const first = conv.messages.find(m => m.role === 'user');
        if (first?.content) {
          firstMessage = first.content.substring(0, 30);
          if (first.content.length > 30) firstMessage += '…';
        }
      }
      await this._endSession(currentSessionId);
      this.session.archiveCurrent(chatId, { firstMessage });
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
