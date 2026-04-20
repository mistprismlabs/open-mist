'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../../package.json');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const STALE_THRESHOLD_MS = 30 * 1000;
const HANDLED_TTL_MS = 5 * 60 * 1000;
const MAX_HANDLED = 1000;
const WEIXIN_STATE_DIR = path.join(__dirname, '..', '..', 'data', 'weixin');
const WEIXIN_PROGRESS_PREFIX = 'weixin:';

const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const MESSAGE_ITEM_TEXT = 1;
const WEIXIN_APP_ID = 'bot';

function buildWeixinClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version || '0.0.0')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildWeixinBaseInfo() {
  return { channel_version: packageJson.version || 'unknown' };
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function buildWeixinHeaders(body, token) {
  return {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': WEIXIN_APP_ID,
    'iLink-App-ClientVersion': String(buildWeixinClientVersion(packageJson.version)),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function extractWeixinText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    if (item?.type === MESSAGE_ITEM_TEXT && item?.text_item?.text != null) {
      return String(item.text_item.text).trim();
    }
    if (item?.voice_item?.text) {
      return String(item.voice_item.text).trim();
    }
  }
  return '';
}

function buildWeixinSessionKey({ userId, chatId, isGroup }) {
  if (isGroup) return `weixin-group:${chatId}`;
  return `weixin:${userId}`;
}

function buildWeixinSendMessageBody({ to, text, contextToken, clientId }) {
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: text
        ? [{ type: MESSAGE_ITEM_TEXT, text_item: { text } }]
        : undefined,
      context_token: contextToken || undefined,
    },
    base_info: buildWeixinBaseInfo(),
  };
}

function sanitizeWeixinStateKey(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveWeixinStateDir(stateDir = process.env.WEIXIN_STATE_DIR?.trim()) {
  return stateDir || WEIXIN_STATE_DIR;
}

function resolveWeixinAccountsDir({ stateDir } = {}) {
  return path.join(resolveWeixinStateDir(stateDir), 'accounts');
}

function resolveWeixinAccountPath({ accountId, stateDir } = {}) {
  if (!accountId) {
    throw new Error('accountId is required');
  }
  return path.join(resolveWeixinAccountsDir({ stateDir }), `${sanitizeWeixinStateKey(accountId)}.json`);
}

function listWeixinAccountFiles({ stateDir } = {}) {
  const accountsDir = resolveWeixinAccountsDir({ stateDir });
  if (!fs.existsSync(accountsDir)) return [];
  return fs.readdirSync(accountsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(accountsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function loadWeixinAccountCredential({ accountId, stateDir } = {}) {
  const requestedId = accountId ? sanitizeWeixinStateKey(accountId) : null;
  const files = listWeixinAccountFiles({ stateDir });
  for (const file of files) {
    const basename = path.basename(file, '.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const parsedId = parsed?.accountId ? sanitizeWeixinStateKey(parsed.accountId) : basename;
      if (requestedId && basename !== requestedId && parsedId !== requestedId) continue;
      if (!parsed?.token) continue;
      return {
        accountId: parsed.accountId || basename,
        token: parsed.token,
        baseUrl: parsed.baseUrl || DEFAULT_BASE_URL,
        userId: parsed.userId,
        source: file,
      };
    } catch {}
  }
  return null;
}

function saveWeixinAccountCredential({ accountId, token, baseUrl, userId, stateDir } = {}) {
  if (!accountId) throw new Error('accountId is required');
  if (!token) throw new Error('token is required');
  const filePath = resolveWeixinAccountPath({ accountId, stateDir });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify({
    accountId,
    token,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    userId: userId || null,
    savedAt: now,
  }, null, 2));
  return filePath;
}

function resolveWeixinPollStatePath({ accountId, stateDir } = {}) {
  const dir = resolveWeixinStateDir(stateDir);
  return path.join(dir, `${sanitizeWeixinStateKey(accountId)}.json`);
}

function loadWeixinPollState({ accountId, stateDir } = {}) {
  const filePath = resolveWeixinPollStatePath({ accountId, stateDir });
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.getUpdatesBuf !== 'string' || !parsed.getUpdatesBuf) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveWeixinPollState({ accountId, stateDir, getUpdatesBuf } = {}) {
  if (!getUpdatesBuf) return;
  const filePath = resolveWeixinPollStatePath({ accountId, stateDir });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    accountId: accountId || null,
    getUpdatesBuf,
    updatedAt: Date.now(),
  }, null, 2));
}

class WeixinAdapter {
  constructor({ gateway }) {
    this.gateway = gateway;
    this.stateDir = resolveWeixinStateDir();
    this.storedCredential = loadWeixinAccountCredential({
      accountId: process.env.WEIXIN_ACCOUNT_ID,
      stateDir: this.stateDir,
    });
    this.baseUrl = process.env.WEIXIN_BASE_URL || this.storedCredential?.baseUrl || DEFAULT_BASE_URL;
    this.token = process.env.WEIXIN_TOKEN || this.storedCredential?.token;
    this.accountId = process.env.WEIXIN_ACCOUNT_ID || this.storedCredential?.accountId || 'default';
    this.longPollTimeoutMs = Number(process.env.WEIXIN_LONG_POLL_TIMEOUT_MS || DEFAULT_LONG_POLL_TIMEOUT_MS);
    this.allowFrom = String(process.env.WEIXIN_ALLOW_FROM || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.handled = new Map();
    this.contextTokens = new Map();
    this.progressNotifiedAt = new Map();
    this.pollState = loadWeixinPollState({ accountId: this.accountId, stateDir: this.stateDir });
    this.getUpdatesBuf = this.pollState?.getUpdatesBuf || '';
    this._closing = false;
    this._loopPromise = null;

    this.gateway.registerProgressCallback('weixin', async (targetId, info) => {
      if (typeof targetId !== 'string' || !targetId.startsWith(WEIXIN_PROGRESS_PREFIX)) return false;

      const userId = targetId.slice(WEIXIN_PROGRESS_PREFIX.length);
      const now = Date.now();
      const isRetry = info?.type === 'retry';
      const isAlert = info?.type === 'alert';
      if (!isRetry && !isAlert && now - (this.progressNotifiedAt.get(userId) || 0) < 30 * 1000) return false;

      let text;
      if (isRetry) {
        text = `⏳ API 重试中（第 ${info.attempt}/${info.maxRetries} 次，状态 ${info.errorStatus}）`;
      } else if (isAlert) {
        text = info.text || info.summary || info.description || null;
      } else {
        const rawText = typeof info === 'string' ? info : (info?.summary || info?.description || null);
        if (!rawText || !rawText.startsWith('📋 ')) return false;
        this.progressNotifiedAt.set(userId, now);
        text = `⚙️ ${rawText}`;
      }
      if (!text) return false;

      try {
        await this._sendText({
          to: userId,
          text,
          contextToken: this.contextTokens.get(userId),
        });
        return true;
      } catch (err) {
        console.warn('[Weixin] Progress notify failed:', err.message);
        return false;
      }
    });
  }

  get platform() {
    return 'weixin';
  }

  async start() {
    if (String(process.env.WEIXIN_ENABLED).toLowerCase() !== 'true') return;
    if (!this.token) {
      throw new Error('WEIXIN_TOKEN is required when WEIXIN_ENABLED=true (or run npm run weixin:login to save a local credential)');
    }
    this._closing = false;
    this._loopPromise = this._pollLoop();
    const source = this.storedCredential?.source ? ` via ${this.storedCredential.source}` : '';
    const cursor = this.getUpdatesBuf ? ' (restored cursor)' : '';
    console.log(`[Weixin] Long-poll started: ${this.baseUrl}${source}${cursor}`);
  }

  async stop() {
    this._closing = true;
    if (this._loopPromise) {
      await this._loopPromise.catch(() => {});
      this._loopPromise = null;
    }
  }

  async _pollLoop() {
    let nextTimeoutMs = this.longPollTimeoutMs;
    let consecutiveFailures = 0;

    while (!this._closing) {
      try {
        const response = await this._getUpdates(nextTimeoutMs);
        if (response?.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms;
        }

        const isApiError =
          (response?.ret !== undefined && response.ret !== 0) ||
          (response?.errcode !== undefined && response.errcode !== 0);

        if (isApiError) {
          consecutiveFailures += 1;
          console.error(`[Weixin] getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ''}`);
          await this._sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures = 0;

        if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf && response.get_updates_buf !== this.getUpdatesBuf) {
          this.getUpdatesBuf = response.get_updates_buf;
          saveWeixinPollState({
            accountId: this.accountId,
            stateDir: this.stateDir,
            getUpdatesBuf: this.getUpdatesBuf,
          });
        }

        for (const message of response?.msgs || []) {
          await this._handleMessage(message);
        }
      } catch (err) {
        if (this._closing) return;
        consecutiveFailures += 1;
        console.error(`[Weixin] poll error: ${String(err.message || err)}`);
        await this._sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
      }
    }
  }

  async _handleMessage(message) {
    if (!message?.from_user_id) return;
    if (this.allowFrom.length > 0 && !this.allowFrom.includes(message.from_user_id)) return;

    const handledKey = this._messageKey(message);
    if (this.handled.has(handledKey)) return;
    this.handled.set(handledKey, Date.now());
    this._evictHandled();

    const createTimeMs = Number(message.create_time_ms || 0);
    if (createTimeMs && Date.now() - createTimeMs > STALE_THRESHOLD_MS) {
      console.log(`[Weixin] Skipping stale message ${handledKey}`);
      return;
    }

    const text = extractWeixinText(message);
    if (!text) {
      console.log(`[Weixin] Unsupported inbound message from ${message.from_user_id}`);
      return;
    }

    const isGroup = Boolean(message.group_id);
    const channelLabel = isGroup ? '微信龙虾群聊' : '微信龙虾私聊';
    const chatId = isGroup ? (message.group_id || message.session_id || message.from_user_id) : message.from_user_id;
    const sessionKey = buildWeixinSessionKey({
      userId: message.from_user_id,
      chatId,
      isGroup,
    });

    if (message.context_token) {
      this.contextTokens.set(message.from_user_id, message.context_token);
    }

    console.log(`[Weixin] ${channelLabel} from ${message.from_user_id}: ${text.substring(0, 80)}`);

    try {
      const result = await this.gateway.processMessage({
        chatId: sessionKey,
        text,
        mediaFiles: [],
        chatType: isGroup ? 'group' : 'p2p',
        channelLabel,
        senderName: isGroup ? message.from_user_id : undefined,
        userId: message.from_user_id,
        progressTargetId: `${WEIXIN_PROGRESS_PREFIX}${message.from_user_id}`,
      });

      await this._sendText({
        to: message.from_user_id,
        text: result.text,
        contextToken: message.context_token || this.contextTokens.get(message.from_user_id),
      });
    } catch (err) {
      console.error('[Weixin] Message processing error:', err.message);
      await this._sendText({
        to: message.from_user_id,
        text: '抱歉，处理消息时出错，请稍后重试。',
        contextToken: message.context_token || this.contextTokens.get(message.from_user_id),
      }).catch(sendErr => {
        console.error('[Weixin] Fallback send error:', sendErr.message);
      });
    }
  }

  _messageKey(message) {
    if (message.message_id != null) return `id:${message.message_id}`;
    if (message.seq != null) return `seq:${message.seq}`;
    return [message.from_user_id, message.create_time_ms, extractWeixinText(message)].join(':');
  }

  _evictHandled() {
    const cutoff = Date.now() - HANDLED_TTL_MS;
    for (const [key, seenAt] of this.handled) {
      if (seenAt < cutoff || this.handled.size > MAX_HANDLED) {
        this.handled.delete(key);
      } else {
        break;
      }
    }
  }

  async _getUpdates(timeoutMs) {
    const requestBody = {
      get_updates_buf: this.getUpdatesBuf || '',
      base_info: buildWeixinBaseInfo(),
    };

    try {
      return await this._postJson('ilink/bot/getupdates', requestBody, timeoutMs);
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: this.getUpdatesBuf };
      }
      throw err;
    }
  }

  async _sendText({ to, text, contextToken }) {
    const clientId = crypto.randomUUID();
    const body = buildWeixinSendMessageBody({
      to,
      text,
      contextToken,
      clientId,
    });
    await this._postJson('ilink/bot/sendmessage', body, DEFAULT_API_TIMEOUT_MS);
    return { messageId: clientId };
  }

  async sendReminder({ userId, text }) {
    return this._sendText({
      to: userId,
      text,
      contextToken: this.contextTokens.get(userId),
    });
  }

  async _postJson(endpoint, payload, timeoutMs) {
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(new URL(endpoint, this._ensureTrailingSlash(this.baseUrl)), {
        method: 'POST',
        headers: buildWeixinHeaders(body, this.token),
        body,
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`${endpoint} ${response.status}: ${rawText}`);
      }
      return rawText ? JSON.parse(rawText) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  _ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
  }

  async _sleep(ms) {
    if (this._closing) return;
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  WeixinAdapter,
  buildWeixinClientVersion,
  buildWeixinSessionKey,
  extractWeixinText,
  buildWeixinSendMessageBody,
  sanitizeWeixinStateKey,
  resolveWeixinStateDir,
  resolveWeixinAccountsDir,
  resolveWeixinAccountPath,
  listWeixinAccountFiles,
  loadWeixinAccountCredential,
  saveWeixinAccountCredential,
  resolveWeixinPollStatePath,
  loadWeixinPollState,
  saveWeixinPollState,
};
