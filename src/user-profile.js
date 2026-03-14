/**
 * 用户画像存储
 *
 * 首次对话时收集用户偏好（助手名称、称呼、场景、语言），
 * 后续对话注入 system prompt 实现个性化。
 */

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', 'data', 'user-profiles.json');

class UserProfileStore {
  constructor() {
    this.profiles = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PROFILE_PATH)) {
        this.profiles = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
      }
    } catch (err) {
      console.warn('[UserProfile] Load failed:', err.message);
      this.profiles = {};
    }
  }

  _save() {
    try {
      const dir = path.dirname(PROFILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROFILE_PATH, JSON.stringify(this.profiles, null, 2));
    } catch (err) {
      console.warn('[UserProfile] Save failed:', err.message);
    }
  }

  hasProfile(chatId) {
    return !!this.profiles[chatId];
  }

  get(chatId) {
    return this.profiles[chatId] || null;
  }

  set(chatId, profile) {
    const now = new Date().toISOString();
    const existing = this.profiles[chatId];
    this.profiles[chatId] = {
      agentName: profile.agentName || 'Jarvis',
      userName: profile.userName || '先生',
      role: profile.role || 'personal',
      language: profile.language || 'zh',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this._save();
  }
}

module.exports = { UserProfileStore };
