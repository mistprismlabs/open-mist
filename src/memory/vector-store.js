/**
 * 语义向量存储
 *
 * 写入路径（endConversation 时异步调用）：
 *   文本 → DashScope API embed → sqlite-vec INSERT
 *
 * 查询路径（retrieveRelevantMemories 时）：
 *   查询文本 → DashScope embed → sqlite-vec cosine search → top-K
 *
 * 降级：DashScope 不可用时静默跳过，回退到关键词匹配
 */

const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "..", "data", "memory");
const DB_PATH = path.join(DB_DIR, "vectors.db");

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-v4";
const DIMENSIONS = 1024;

const EMBED_CACHE_MAX = 50;
const EMBED_CACHE_TTL = 60 * 60 * 1000; // 1 小时

class VectorStore {
  constructor() {
    this.db = null;
    this.available = false;
    this._embedCache = new Map(); // key: text → { embedding, expires }
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

      const Database = require("better-sqlite3");
      this.db = new Database(DB_PATH);

      // 加载 sqlite-vec 扩展
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);

      // 创建表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          chat_id TEXT,
          user_id TEXT DEFAULT 'default',
          text TEXT,
          importance INTEGER DEFAULT 5,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 迁移：旧表可能缺 user_id 列
      try {
        this.db.exec(`ALTER TABLE memories ADD COLUMN user_id TEXT DEFAULT 'default'`);
      } catch {
        // 列已存在，忽略
      }

      // 一次性迁移：将 'default' 记录归位到管理员
      const adminUserId = process.env.ADMIN_USER_ID || process.env.FEISHU_OWNER_ID;
      if (adminUserId) {
        const migrated = this.db.prepare(
          `UPDATE memories SET user_id = ? WHERE user_id = 'default'`
        ).run(adminUserId);
        if (migrated.changes > 0) {
          console.log(`[VectorStore] Migrated ${migrated.changes} records to admin user ${adminUserId.substring(0, 8)}...`);
        }
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${DIMENSIONS}]
        )
      `);

      this.available = true;
      console.log("[VectorStore] Initialized (sqlite-vec ready)");
    } catch (err) {
      console.warn("[VectorStore] Init failed (falling back to keyword search):", err.message);
      this.available = false;
    }
  }

  /**
   * 调用 DashScope API 生成 embedding
   * @returns {Float32Array|null}
   */
  async embed(text) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      console.warn("[VectorStore] DASHSCOPE_API_KEY not set, skipping embed");
      return null;
    }

    // 查 LRU 缓存
    const cacheKey = text.substring(0, 200);
    const cached = this._embedCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.embedding;
    }

    try {
      const res = await fetch(DASHSCOPE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text.substring(0, 8000), // API 限制
          dimensions: DIMENSIONS,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`);
      }

      const data = await res.json();
      const embedding = new Float32Array(data.data[0].embedding);

      // 写入缓存，超量时淘汰最早的 key
      if (this._embedCache.size >= EMBED_CACHE_MAX) {
        this._embedCache.delete(this._embedCache.keys().next().value);
      }
      this._embedCache.set(cacheKey, { embedding, expires: Date.now() + EMBED_CACHE_TTL });

      return embedding;
    } catch (err) {
      console.warn("[VectorStore] Embed failed:", err.message);
      return null;
    }
  }

  /**
   * 存储对话摘要的向量
   */
  async store(id, text, meta = {}) {
    if (!this.available) return false;

    const embedding = await this.embed(text);
    if (!embedding) {
      console.warn("[VectorStore] Embed returned null, skipping vector storage for:", id);
      return false;
    }

    try {
      // 写入元数据
      this.db.prepare(`
        INSERT OR REPLACE INTO memories (id, chat_id, user_id, text, importance, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(id, meta.chatId || "", meta.userId || "default", text.substring(0, 2000), meta.importance || 5);

      // 写入向量
      this.db.prepare(`
        INSERT OR REPLACE INTO vec_memories (id, embedding)
        VALUES (?, ?)
      `).run(id, Buffer.from(embedding.buffer));

      return true;
    } catch (err) {
      console.warn("[VectorStore] Store failed:", err.message);
      return false;
    }
  }

  /**
   * 语义搜索
   * @returns {Array<{id, text, chatId, importance, distance}>}
   */
  async search(query, topK = 5, chatId = null, userId = null) {
    if (!this.available) return [];

    const embedding = await this.embed(query);
    if (!embedding) {
      console.warn("[VectorStore] Embed returned null, falling back to keyword search");
      return [];
    }

    try {
      const queryBuf = Buffer.from(embedding.buffer);

      // 构建过滤条件
      const conditions = ['v.embedding MATCH ?', 'k = ?'];
      const params = [queryBuf, topK * 2];

      if (chatId) {
        conditions.push('m.chat_id = ?');
        params.push(chatId);
      }
      if (userId) {
        conditions.push('m.user_id = ?');
        params.push(userId);
      }

      const sql = `
        SELECT v.id, v.distance, m.text, m.chat_id, m.user_id, m.importance, m.created_at
        FROM vec_memories v
        JOIN memories m ON v.id = m.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY v.distance
      `;
      const rows = this.db.prepare(sql).all(...params).slice(0, topK);

      return rows.map(r => ({
        id: r.id,
        text: r.text,
        chatId: r.chat_id,
        importance: r.importance,
        distance: r.distance,
        createdAt: r.created_at,
        // cosine similarity ≈ 1 - distance (sqlite-vec 默认 L2, 但 vec0 cosine 距离)
        similarity: Math.max(0, 1 - r.distance),
      }));
    } catch (err) {
      console.warn("[VectorStore] Search failed:", err.message);
      return [];
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    if (!this.available) return { available: false, count: 0 };
    try {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM memories").get();
      return { available: true, count: row.count };
    } catch {
      return { available: false, count: 0 };
    }
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}

module.exports = { VectorStore };
