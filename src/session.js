const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

class SessionStore {
  constructor() {
    this.sessions = {};
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(SESSIONS_FILE)) {
        this.sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
        // 迁移旧格式 { sessionId, updatedAt } → 新格式
        for (const chatId of Object.keys(this.sessions)) {
          this._migrate(chatId);
        }
      }
    } catch (e) {
      console.warn('[Session] Failed to load sessions:', e.message);
      this.sessions = {};
    }
  }

  _migrate(chatId) {
    const s = this.sessions[chatId];
    if (!s || s.createdAt) return; // 已是新格式
    this.sessions[chatId] = {
      sessionId: s.sessionId,
      name: null,
      createdAt: s.updatedAt || Date.now(),
      updatedAt: s.updatedAt || Date.now(),
      history: [],
    };
  }

  _save() {
    const dir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFile(SESSIONS_FILE, JSON.stringify(this.sessions, null, 2), err => {
      if (err) console.error('[Session] Failed to save sessions:', err.message);
    });
  }

  get(chatId) {
    return this.sessions[chatId]?.sessionId || null;
  }

  set(chatId, sessionId) {
    const existing = this.sessions[chatId];
    if (existing) {
      if (existing.sessionId === sessionId) {
        existing.updatedAt = Date.now();
      } else {
        // 新 session（清空后首次 set，或异常情况）
        existing.sessionId = sessionId;
        existing.name = null;
        existing.createdAt = Date.now();
        existing.updatedAt = Date.now();
        // history 保留
      }
    } else {
      this.sessions[chatId] = {
        sessionId,
        name: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      };
    }
    this._save();
  }

  setName(chatId, name) {
    const s = this.sessions[chatId];
    if (!s) return;
    s.name = name || null;
    s.updatedAt = Date.now();
    this._save();
  }

  getHistory(chatId) {
    return this.sessions[chatId]?.history || [];
  }

  /**
   * 将当前会话移入历史，重置 sessionId/name/createdAt
   */
  archiveCurrent(chatId) {
    const s = this.sessions[chatId];
    if (!s || !s.sessionId) return;
    if (!s.history) s.history = [];
    s.history.unshift({
      sessionId: s.sessionId,
      name: s.name || null,
      createdAt: s.createdAt || s.updatedAt,
      endedAt: Date.now(),
    });
    if (s.history.length > 10) s.history = s.history.slice(0, 10);
    s.sessionId = null;
    s.name = null;
    s.createdAt = null;
    s.updatedAt = Date.now();
    this._save();
  }

  /**
   * 从历史中恢复指定 sessionId 为当前会话
   */
  restore(chatId, targetSessionId) {
    if (!this.sessions[chatId]) {
      this.sessions[chatId] = { sessionId: null, name: null, createdAt: null, updatedAt: Date.now(), history: [] };
    }
    const s = this.sessions[chatId];
    const idx = (s.history || []).findIndex(h => h.sessionId === targetSessionId);
    let histEntry = null;
    if (idx >= 0) {
      histEntry = s.history[idx];
      s.history.splice(idx, 1);
    }
    s.sessionId = targetSessionId;
    s.name = histEntry?.name || null;
    s.createdAt = histEntry?.createdAt || Date.now();
    s.updatedAt = Date.now();
    this._save();
  }

  clear(chatId) {
    this.archiveCurrent(chatId);
  }
}

module.exports = { SessionStore };
