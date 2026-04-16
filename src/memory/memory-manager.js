/**
 * 分层记忆管理器
 *
 * 核心职责：
 * 1. 协调短期记忆和归档层
 * 2. 智能压缩工作记忆
 * 3. 检索相关记忆并注入上下文
 */

const fs = require("fs");
const path = require("path");
const { ShortTermMemory } = require("./short-term");
const { VectorStore } = require("./vector-store");
const { generateUUID } = require("./types");
const { Archive } = require("../archive");
const { ClaudeClient, resolveConfiguredModel } = require("../claude");

// 压缩触发阈值
const COMPRESS_SIZE_THRESHOLD = 8 * 1024 * 1024;  // 8MB
const COMPRESS_MESSAGE_THRESHOLD = 80;
const COMPRESS_TIME_THRESHOLD = 2 * 60 * 60 * 1000; // 2 小时

// 混合检索权重
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

const MEMORY_MODEL = resolveConfiguredModel(process.env.RECOMMEND_MODEL, process.env.CLAUDE_MODEL);
const DEFAULT_USER_ID = process.env.ADMIN_USER_ID || process.env.FEISHU_OWNER_ID || 'default';

class MemoryManager {
  constructor() {
    this.shortTerm = new ShortTermMemory();
    this.vectorStore = new VectorStore();
    this.archive = new Archive();
    this.activeConversations = new Map();
    this._claude = null;
  }

  _getClaudeClient() {
    if (!this._claude) this._claude = new ClaudeClient();
    return this._claude;
  }

  // ==================== 对话追踪 ====================

  startConversation(sessionId, chatId, chatType, userId) {
    if (this.activeConversations.has(sessionId)) return;

    this.activeConversations.set(sessionId, {
      conversationId: generateUUID(),
      sessionId,
      chatId,
      userId: userId || DEFAULT_USER_ID,
      chatType: chatType || "飞书群聊",
      startTime: new Date().toISOString(),
      messageCount: 0,
      messages: [],
      toolsUsed: new Set(),
      filesModified: new Set(),
      entities: new Set(),
    });

    console.log(`[MemoryManager] Started tracking: ${sessionId.substring(0, 8)}...`);
  }

  recordMessage(sessionId, message) {
    const conv = this.activeConversations.get(sessionId);
    if (!conv) return;

    conv.messageCount++;
    conv.messages.push({
      role: message.role,
      content: message.content?.substring(0, 500),
      timestamp: new Date().toISOString(),
    });

    if (conv.messages.length > 100) {
      conv.messages = conv.messages.slice(-100);
    }
  }

  recordToolUse(sessionId, toolName, result) {
    const conv = this.activeConversations.get(sessionId);
    if (!conv) return;
    conv.toolsUsed.add(toolName);
    if (["Edit", "Write", "NotebookEdit"].includes(toolName) && result?.file_path) {
      conv.filesModified.add(result.file_path);
    }
  }

  recordEntities(sessionId, entities) {
    const conv = this.activeConversations.get(sessionId);
    if (!conv) return;
    entities.forEach(e => conv.entities.add(e));
  }

  // ==================== 归档层写入 ====================

  /**
   * 实时追加消息到归档（由 feishu.js 调用）
   */
  archiveMessage(chatId, role, content, sessionId, extras) {
    this.archive.append({
      chatId,
      role,
      content,
      sessionId,
      toolsUsed: extras?.toolsUsed || [],
      mediaFiles: extras?.mediaFiles || [],
    });
  }

  // ==================== 压缩判断 ====================

  shouldCompress(sessionId) {
    const conv = this.activeConversations.get(sessionId);
    if (!conv) return false;

    // 刚重建的 session（messageCount < 2）不触发压缩
    // 防止 PreCompact/rotate 重建后因 session 文件仍大而立即触发二次压缩
    if (conv.messageCount < 2) return false;

    if (conv.messageCount >= COMPRESS_MESSAGE_THRESHOLD) return true;

    const duration = Date.now() - new Date(conv.startTime).getTime();
    if (duration >= COMPRESS_TIME_THRESHOLD) return true;

    try {
      const os = require("os");
      const SESSION_DIR = process.env.SESSION_DIR || path.join(os.homedir(), ".claude", "projects", "-home-" + (process.env.USER || "user") + "-" + path.basename(process.cwd()));
      const sessionFile = path.join(SESSION_DIR, `${sessionId}.jsonl`);
      const stats = fs.statSync(sessionFile);
      if (stats.size >= COMPRESS_SIZE_THRESHOLD) return true;
    } catch {}

    return false;
  }

  // ==================== 对话结束处理 ====================

  async endConversation(sessionId) {
    const conv = this.activeConversations.get(sessionId);
    if (!conv) {
      console.log(`[MemoryManager] Skip end: session ${sessionId.substring(0, 8)} not tracked (already ended or rotated)`);
      return null;
    }

    const endTime = new Date().toISOString();

    const summary = {
      conversationId: conv.conversationId,
      chatId: conv.chatId,
      userId: conv.userId || DEFAULT_USER_ID,
      sessionId: conv.sessionId,
      chatType: conv.chatType,
      startTime: conv.startTime,
      endTime,
      messageCount: conv.messageCount,
      summary: {
        userIntent: await this._extractIntent(conv.messages),
        keyDecisions: await this._extractKeyDecisions(conv.messages),
        outcome: "对话正常结束",
        entities: [...conv.entities],
      },
      context: {
        workingDirectory: process.cwd(),
        gitBranch: "main",
        filesModified: [...conv.filesModified],
        toolsUsed: [...conv.toolsUsed],
      },
      importance: this._calculateImportance(conv),
      tags: this._extractTags(conv),
    };

    // 保存到短期记忆
    this.shortTerm.save(summary);

    // 异步写入向量存储（不阻塞主流程）
    const vectorText = `${summary.summary.userIntent}\n${summary.tags.join(", ")}\n${[...conv.entities].join(", ")}`;
    this.vectorStore.store(summary.conversationId, vectorText, {
      chatId: conv.chatId,
      userId: conv.userId || DEFAULT_USER_ID,
      importance: summary.importance,
    }).catch(err => console.warn("[MemoryManager] Vector store failed:", err.message));

    // 写入归档结束标记
    this.archive.markSessionEnd(conv.chatId, sessionId);

    this.activeConversations.delete(sessionId);
    console.log(`[MemoryManager] Ended conversation: ${sessionId.substring(0, 8)}... (${conv.messageCount} messages)`);

    return summary;
  }

  async _extractIntent(messages) {
    const userMessages = messages.filter(m => m.role === "user");
    if (userMessages.length === 0) return "未知意图";

    // 尝试用 Haiku 提取精炼意图
    if (MEMORY_MODEL) {
      try {
      const texts = userMessages.slice(0, 5).map(m => m.content).join("\n");
      const result = await this._getClaudeClient().complete(
        "你是一个意图提取器。用一句话概括用户的核心意图（20字以内），只输出意图本身，不要解释。",
        texts,
        { model: MEMORY_MODEL, maxTokens: 100 }
      );
      const intent = result.text.trim();
      if (intent && intent.length <= 100) return intent;
      } catch (err) {
        console.warn("[MemoryManager] Intent extraction failed, fallback:", err.message);
      }
    }

    // fallback: 截取前 100 字
    const first = userMessages[0].content;
    return first.length <= 100 ? first : first.substring(0, 100) + "...";
  }

  async _extractKeyDecisions(messages) {
    if (messages.length < 2) return [];

    if (MEMORY_MODEL) {
      try {
      const texts = messages.slice(0, 20).map(m => `[${m.role}]: ${m.content}`).join("\n");
      const result = await this._getClaudeClient().complete(
        "你是一个决策提取器。从对话中提取关键决策，返回 JSON 数组，每条 < 60 字，最多 3 条。只输出 JSON 数组，例如 [\"决策1\", \"决策2\"]。如果没有明确决策，返回空数组 []。",
        texts,
        {
          model: MEMORY_MODEL,
          maxTokens: 300,
          schema: {
            type: "object",
            properties: {
              decisions: {
                type: "array",
                items: { type: "string", maxLength: 60 },
                maxItems: 3,
              },
            },
            required: ["decisions"],
          },
        }
      );
      // schema 模式返回 json 字段
      if (result.json?.decisions) {
        return result.json.decisions.slice(0, 3);
      }
      // fallback: 文本模式解析
      if (result.text) {
        const { parseJSON } = require("../claude");
        return parseJSON(result.text).slice(0, 3);
      }
      } catch (err) {
        console.warn("[MemoryManager] Key decisions extraction failed:", err.message);
      }
    }
    return [];
  }

  _calculateImportance(conv) {
    let score = 5;
    if (conv.messageCount > 20) score += 1;
    if (conv.messageCount > 50) score += 1;
    if (conv.toolsUsed.size > 5) score += 1;
    if (conv.filesModified.size > 0) score += 1;
    if (conv.filesModified.size > 5) score += 1;
    return Math.min(score, 10);
  }

  _extractTags(conv) {
    const tags = new Set();
    const toolTags = {
      Edit: "代码修改", Write: "文件创建", Bash: "命令执行",
      Grep: "代码搜索", WebFetch: "网络请求", WebSearch: "信息检索",
    };
    for (const tool of conv.toolsUsed) {
      if (toolTags[tool]) tags.add(toolTags[tool]);
    }
    if (conv.chatType === "自动任务") tags.add("自动任务");
    return [...tags];
  }

  // ==================== 记忆检索 ====================

  async retrieveRelevantMemories(userMessage, chatId, userId) {
    const keywords = this._extractKeywords(userMessage);

    // 关键词和向量检索并行
    const [keywordResults, vectorResults] = await Promise.all([
      Promise.resolve(this.shortTerm.getMostRelevant(keywords, 5, chatId, userId)),
      this.vectorStore.search(userMessage, 5, chatId, userId),
    ]);

    // 混合排序 → 时间衰减 → MMR 重排序
    const merged = this._mergeResults(keywordResults, vectorResults);
    const decayed = this._applyTimeDecay(merged);
    const diversified = this._applyMMR(decayed, 0.7, 3);
    const recentConversations = diversified.map(s => s.conv);

    const systemMessage = this._formatContextInjection(recentConversations);
    return { recentConversations, systemMessage };
  }

  /**
   * 合并关键词和向量检索结果，加权去重
   */
  _mergeResults(keywordResults, vectorResults) {
    const scoreMap = new Map(); // conversationId → { conv, score }

    // 关键词结果：用实际 relevance score × 权重（不再排名归一化，防止低相关记录虚高）
    for (const item of keywordResults) {
      const id = item.conv.conversationId;
      scoreMap.set(id, { conv: item.conv, score: KEYWORD_WEIGHT * item.score });
    }

    // 向量结果：通过 conversationId 匹配到 shortTerm 中的完整记录
    for (let i = 0; i < vectorResults.length; i++) {
      const vr = vectorResults[i];
      const normalizedScore = vr.similarity || (1 - i / vectorResults.length);
      const existing = scoreMap.get(vr.id);

      if (existing) {
        // 两个检索都命中：加分
        existing.score += VECTOR_WEIGHT * normalizedScore;
      } else {
        // 只有向量命中：从 shortTerm 中找完整记录
        const conv = this.shortTerm.getByConversationId(vr.id);
        if (conv) {
          scoreMap.set(vr.id, { conv, score: VECTOR_WEIGHT * normalizedScore });
        }
      }
    }

    // 过滤低相关性结果（纯时间分 ~0.06，语义相关才能过 0.10）
    return [...scoreMap.values()]
      .sort((a, b) => b.score - a.score)
      .filter(s => s.score >= 0.10);
  }

  /**
   * 时间衰减：30 天半衰期，importance >= 8 的常青记忆豁免
   */
  _applyTimeDecay(scoredItems) {
    const HALF_LIFE_DAYS = 30;
    const LN2 = Math.LN2;
    const now = Date.now();

    return scoredItems.map(item => {
      // 常青豁免：重要记忆不衰减
      if (item.conv.importance >= 8) return item;

      const endTime = item.conv.endTime ? new Date(item.conv.endTime).getTime() : now;
      const daysAgo = (now - endTime) / (24 * 60 * 60 * 1000);
      const decay = Math.exp(-LN2 / HALF_LIFE_DAYS * daysAgo);

      return { conv: item.conv, score: item.score * decay };
    }).sort((a, b) => b.score - a.score);
  }

  /**
   * MMR 重排序：贪心选择，降低与已选项相似的候选分数
   * λ=0.7 偏重相关性，0.3 惩罚冗余
   */
  _applyMMR(scoredItems, lambda = 0.7, targetCount = 3) {
    if (scoredItems.length <= 1) return scoredItems;

    const selected = [];
    const remaining = [...scoredItems];

    // 第一个直接选最高分
    selected.push(remaining.shift());

    while (selected.length < targetCount && remaining.length > 0) {
      let bestIdx = 0;
      let bestMMR = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        // 计算与已选项的最大相似度
        const maxSim = Math.max(...selected.map(s => this._jaccardSimilarity(candidate.conv, s.conv)));
        const mmr = lambda * candidate.score - (1 - lambda) * maxSim;
        if (mmr > bestMMR) {
          bestMMR = mmr;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
  }

  /**
   * Jaccard 相似度：基于 tags + entities 的集合交并比
   */
  _jaccardSimilarity(convA, convB) {
    const setA = new Set([
      ...(convA.tags || []),
      ...(convA.summary?.entities || []),
    ]);
    const setB = new Set([
      ...(convB.tags || []),
      ...(convB.summary?.entities || []),
    ]);

    if (setA.size === 0 && setB.size === 0) return 0;

    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  _extractKeywords(text) {
    const stopWords = new Set([
      "的", "了", "是", "在", "我", "你", "他", "她", "它",
      "这", "那", "和", "与", "或", "但", "因为", "所以",
      "the", "a", "an", "is", "are", "was", "were", "be",
      "to", "of", "and", "in", "that", "it", "for", "on",
    ]);
    const words = text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
    const codePatterns = text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) || [];
    return [...new Set([...words, ...codePatterns])].slice(0, 20);
  }

  _formatContextInjection(conversations) {
    if (conversations.length === 0) return "";

    let message = "# 相关历史记忆\n\n## 最近对话（来自短期记忆）\n";
    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const dateStr = conv.endTime?.split("T")[0];
      message += `\n${i + 1}. **[${dateStr}] ${conv.summary?.userIntent || "未知意图"}**\n`;
      if (conv.summary?.keyDecisions?.length > 0) {
        const decisions = conv.summary.keyDecisions.slice(0, 2).map(d => d.substring(0, 60)).join("; ");
        message += `   - 关键决策: ${decisions}\n`;
      }
      if (conv.summary?.outcome) {
        message += `   - 结果: ${conv.summary.outcome.substring(0, 80)}\n`;
      }
      if (conv.context?.filesModified?.length > 0) {
        message += `   - 相关文件: ${conv.context.filesModified.slice(0, 3).join(", ")}\n`;
      }
    }
    return message + "\n";
  }

  // ==================== 手动写入记忆 ====================

  async saveManual(content, chatId, userId) {
    const id = generateUUID();
    const now = new Date().toISOString();
    const summary = {
      conversationId: id,
      chatId: chatId || 'manual',
      userId: userId || DEFAULT_USER_ID,
      sessionId: 'manual',
      chatType: '手动记忆',
      startTime: now,
      endTime: now,
      messageCount: 1,
      summary: {
        userIntent: content.substring(0, 100),
        keyDecisions: [content],
        outcome: '手动写入',
        entities: [],
      },
      context: { workingDirectory: '', gitBranch: '', filesModified: [], toolsUsed: [] },
      importance: 9,
      tags: ['手动记忆'],
    };

    this.shortTerm.save(summary);
    await this.vectorStore.store(id, content, { chatId: chatId || 'manual', userId: userId || DEFAULT_USER_ID, importance: 9 })
      .catch(err => console.warn('[MemoryManager] Manual save vector failed:', err.message));

    console.log(`[MemoryManager] Manual memory saved: ${content.substring(0, 50)}`);
    return { success: true, id };
  }

  // ==================== 统计 ====================

  getStats() {
    return {
      shortTerm: this.shortTerm.getStats(),
      vectorStore: this.vectorStore.getStats(),
      archive: this.archive.getStats(),
      activeConversations: this.activeConversations.size,
    };
  }

  cleanup() {
    const deleted = this.shortTerm.deleteExpired();
    console.log(`[MemoryManager] Cleanup: ${deleted} expired conversations removed`);
    return deleted;
  }

  // ==================== Compact Summary 存储 ====================

  async storeCompactSummary(sessionId, summary) {
    const conv = this.activeConversations.get(sessionId);
    const id = `compact-${sessionId.substring(0, 8)}-${Date.now()}`;
    await this.vectorStore.store(id, summary, {
      chatId: conv?.chatId || 'unknown',
      userId: conv?.userId || DEFAULT_USER_ID,
      importance: 7,
      type: 'compact_summary',
      ts: new Date().toISOString(),
    });
  }
}

module.exports = { MemoryManager };
