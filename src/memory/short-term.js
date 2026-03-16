/**
 * 短期记忆管理器
 *
 * 分层保留策略：
 * - 7天内：全量保留
 * - 7-30天：压缩保留（只保留摘要，删除详细 messages）
 * - 30天后：仅保留重要度 >= 8 的记录
 */

const fs = require("fs");
const path = require("path");
const { generateUUID } = require("./types");

const MEMORY_DIR = path.join(__dirname, "..", "..", "data", "memory");
const SHORT_TERM_FILE = path.join(MEMORY_DIR, "short-term.json");
const MAX_CONVERSATIONS = 100;

// 保留策略阈值
const FULL_RETENTION_DAYS = 7;
const COMPRESSED_RETENTION_DAYS = 30;
const PERMANENT_IMPORTANCE_THRESHOLD = 8;

class ShortTermMemory {
  constructor() {
    this.data = {
      version: "2.0",
      conversations: [],
      index: { byTag: {}, byEntity: {}, byDate: {} },
      metadata: { totalConversations: 0, oldestConversation: null, lastCleanup: null },
    };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      if (fs.existsSync(SHORT_TERM_FILE)) {
        const raw = fs.readFileSync(SHORT_TERM_FILE, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch (err) {
      console.warn("[ShortTermMemory] Failed to load:", err.message);
    }

    // 一次性迁移：将无 userId 的旧记录归位到管理员
    const adminUserId = process.env.ADMIN_USER_ID || process.env.FEISHU_OWNER_ID;
    if (adminUserId) {
      let migrated = 0;
      for (const conv of this.data.conversations) {
        if (!conv.userId || conv.userId === 'default') {
          conv.userId = adminUserId;
          migrated++;
        }
      }
      if (migrated > 0) {
        console.log(`[ShortTermMemory] Migrated ${migrated} records to admin user ${adminUserId.substring(0, 8)}...`);
        this._save();
      }
    }
  }

  _save() {
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(SHORT_TERM_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error("[ShortTermMemory] Failed to save:", err.message);
    }
  }

  _rebuildIndex() {
    this.data.index = { byTag: {}, byEntity: {}, byDate: {} };

    for (const conv of this.data.conversations) {
      const id = conv.conversationId;
      const date = conv.endTime?.split("T")[0];

      for (const tag of (conv.tags || [])) {
        if (!this.data.index.byTag[tag]) this.data.index.byTag[tag] = [];
        this.data.index.byTag[tag].push(id);
      }
      for (const entity of (conv.summary?.entities || [])) {
        if (!this.data.index.byEntity[entity]) this.data.index.byEntity[entity] = [];
        this.data.index.byEntity[entity].push(id);
      }
      if (date) {
        if (!this.data.index.byDate[date]) this.data.index.byDate[date] = [];
        this.data.index.byDate[date].push(id);
      }
    }

    this.data.metadata.totalConversations = this.data.conversations.length;
    if (this.data.conversations.length > 0) {
      this.data.metadata.oldestConversation = this.data.conversations[0].startTime;
    }
  }

  save(summary) {
    const id = summary.conversationId || generateUUID();
    const record = { ...summary, conversationId: id };

    const existingIdx = this.data.conversations.findIndex(
      c => c.conversationId === id || c.sessionId === summary.sessionId
    );

    if (existingIdx >= 0) {
      this.data.conversations[existingIdx] = record;
    } else {
      this.data.conversations.push(record);
    }

    this._applyRetentionPolicy();
    this._rebuildIndex();
    this._save();
    return id;
  }

  /**
   * 分层保留策略
   */
  _applyRetentionPolicy() {
    const now = Date.now();
    const fullCutoff = now - FULL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const compressCutoff = now - COMPRESSED_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    this.data.conversations = this.data.conversations.filter(c => {
      const endTime = new Date(c.endTime).getTime();

      // 7天内：全量保留
      if (endTime >= fullCutoff) return true;

      // 7-30天：压缩保留
      if (endTime >= compressCutoff) {
        if (!c.compressed) {
          c.compressed = true;
          c.compressedAt = new Date().toISOString();
          // 删除详细消息，只保留摘要
          delete c.messages;
        }
        return true;
      }

      // 30天后：仅保留重要度 >= 8
      return (c.importance || 0) >= PERMANENT_IMPORTANCE_THRESHOLD;
    });

    // 超量限制
    if (this.data.conversations.length > MAX_CONVERSATIONS) {
      this.data.conversations.sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
      this.data.conversations = this.data.conversations.slice(0, MAX_CONVERSATIONS);
    }

    this.data.metadata.lastCleanup = new Date().toISOString();
  }

  searchByTags(tags, limit) {
    limit = limit || 5;
    const matchedIds = new Set();
    for (const tag of tags) {
      (this.data.index.byTag[tag] || []).forEach(id => matchedIds.add(id));
    }
    return this.data.conversations
      .filter(c => matchedIds.has(c.conversationId))
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
      .slice(0, limit);
  }

  searchByEntities(entities, limit) {
    limit = limit || 5;
    const matchedIds = new Set();
    for (const entity of entities) {
      (this.data.index.byEntity[entity] || []).forEach(id => matchedIds.add(id));
    }
    return this.data.conversations
      .filter(c => matchedIds.has(c.conversationId))
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
      .slice(0, limit);
  }

  getRecent(n) {
    return this.data.conversations
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
      .slice(0, n || 10);
  }

  getByDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return this.data.conversations.filter(c => {
      const d = new Date(c.endTime);
      return d >= start && d <= end;
    });
  }

  getBySessionId(sessionId) {
    return this.data.conversations.find(c => c.sessionId === sessionId) || null;
  }

  getByConversationId(conversationId) {
    return this.data.conversations.find(c => c.conversationId === conversationId) || null;
  }

  deleteExpired() {
    const beforeCount = this.data.conversations.length;
    this._applyRetentionPolicy();
    this._rebuildIndex();
    this._save();
    return beforeCount - this.data.conversations.length;
  }

  search(keyword, limit) {
    limit = limit || 10;
    const lower = keyword.toLowerCase();
    return this.data.conversations
      .filter(c => {
        const fields = [
          c.summary?.userIntent, c.summary?.outcome,
          ...(c.summary?.keyDecisions || []),
          ...(c.summary?.entities || []),
          ...(c.tags || []),
        ].join(" ").toLowerCase();
        return fields.includes(lower);
      })
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
      .slice(0, limit);
  }

  calculateRelevance(conv, keywords) {
    const tags = new Set(conv.tags || []);
    const entities = new Set(conv.summary?.entities || []);
    const keywordSet = new Set(keywords.map(k => k.toLowerCase()));
    let score = 0;

    const tagOverlap = [...tags].filter(t =>
      [...keywordSet].some(k => t.toLowerCase().includes(k))
    ).length;
    score += 0.4 * (tagOverlap / Math.max(keywordSet.size, 1));

    const entityOverlap = [...entities].filter(e =>
      [...keywordSet].some(k => e.toLowerCase().includes(k))
    ).length;
    score += 0.4 * (entityOverlap / Math.max(keywordSet.size, 1));

    const daysAgo = (Date.now() - new Date(conv.endTime).getTime()) / (24 * 60 * 60 * 1000);
    score += 0.2 * Math.exp(-0.1 * daysAgo);

    return Math.min(score, 1);
  }

  getMostRelevant(keywords, limit, chatId, userId) {
    limit = limit || 5;
    return this.data.conversations
      .filter(conv => !chatId || conv.chatId === chatId)
      .filter(conv => !userId || (conv.userId || 'default') === userId)
      .map(conv => ({ conv, score: this.calculateRelevance(conv, keywords) }))
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getStats() {
    return {
      totalConversations: this.data.conversations.length,
      oldestConversation: this.data.metadata.oldestConversation,
      lastCleanup: this.data.metadata.lastCleanup,
      tagCount: Object.keys(this.data.index.byTag).length,
      entityCount: Object.keys(this.data.index.byEntity).length,
    };
  }
}

module.exports = { ShortTermMemory };
