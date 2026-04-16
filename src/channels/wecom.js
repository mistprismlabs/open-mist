const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');
const WebSocket = require('ws');
const { MEDIA_DIR } = require('../claude');
const { UserProfileStore } = require('../user-profile');

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';
const MAX_TEXT_LEN = 2048;
const STALE_THRESHOLD_MS = 30 * 1000;

// WebSocket 常量
const WS_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_INTERVAL = 30 * 1000;
const MAX_RECONNECT_DELAY = 60 * 1000;
const MAX_MISSED_PONGS = 3;

class WeComAdapter {
  constructor({ gateway, port = parseInt(process.env.WECOM_PORT || '3001', 10) }) {
    this.gateway = gateway;
    this.port = port;
    this.server = null;
    this.handled = new Map();

    // 企微配置
    this.corpId = process.env.WECOM_CORP_ID;
    this.agentId = parseInt(process.env.WECOM_AGENT_ID);
    this.secret = process.env.WECOM_AGENT_SECRET;

    // App 通道凭证（HTTP 回调）
    this.channels = {
      app: this._buildChannel(process.env.WECOM_TOKEN, process.env.WECOM_ENCODING_AES_KEY),
    };

    // Bot 通道凭证（WebSocket 长连接）
    this.botId = process.env.WECOM_BOT_ID;
    this.botSecret = process.env.WECOM_BOT_SECRET;

    // WebSocket 状态
    this.ws = null;
    this.heartbeatTimer = null;
    this.missedPongs = 0;
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._closing = false;
    this._subscribed = false;

    // Access Token 缓存
    this._accessToken = null;
    this._tokenExpiry = 0;

    this.userProfile = new UserProfileStore();

    if (!fs.existsSync(MEDIA_DIR)) {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
  }

  _buildChannel(token, encodingAESKey) {
    if (!token || !encodingAESKey) return null;
    return {
      token,
      aesKey: Buffer.from(encodingAESKey + '=', 'base64'),
    };
  }

  /** 根据 URL 路径选择通道凭证（仅 App 通道） */
  _getChannel(url) {
    if (url.startsWith('/callback') && this.channels.app) {
      return { ...this.channels.app, source: 'app' };
    }
    return null;
  }

  // ==================== 生命周期 ====================

  async start() {
    // 1. App 通道: HTTP server（仅 /callback）
    if (this.channels.app) {
      await this._startHttpServer();
    }

    // 2. Bot 通道: WebSocket 长连接
    if (this.botId && this.botSecret) {
      this._connectWebSocket();
    }

    const sources = [];
    if (this.channels.app) sources.push('app(HTTP)');
    if (this.botId && this.botSecret) sources.push('bot(WebSocket)');
    console.log(`[WeCom] Channels: ${sources.join(', ')}`);
  }

  async _startHttpServer() {
    this.server = http.createServer((req, res) => {
      if (req.url.startsWith('/callback')) {
        const channel = this._getChannel(req.url);
        if (!channel) {
          res.writeHead(500);
          res.end('No channel configured');
          return;
        }
        if (req.method === 'GET') {
          this._verifyURL(req, res, channel);
        } else if (req.method === 'POST') {
          this._handleCallback(req, res, channel);
        } else {
          res.writeHead(405);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[WeCom] HTTP server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    this._closing = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.server) {
      return new Promise(resolve => this.server.close(resolve));
    }
  }

  // ==================== WebSocket 长连接（Bot 通道） ====================

  _connectWebSocket() {
    if (this._closing) return;

    console.log(`[WeCom] WebSocket connecting to ${WS_URL}...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[WeCom] WebSocket connected, subscribing...');
      this.reconnectAttempts = 0;
      this._subscribe();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleWsMessage(msg);
      } catch (err) {
        console.error('[WeCom] WebSocket message parse error:', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`[WeCom] WebSocket closed: code=${code} reason=${reason || 'none'}`);
      this._subscribed = false;
      this._stopHeartbeat();
      if (!this._closing) this._reconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WeCom] WebSocket error:', err.message);
    });
  }

  _subscribe() {
    this._wsSend({
      cmd: 'aibot_subscribe',
      headers: { req_id: crypto.randomUUID() },
      body: { bot_id: this.botId, secret: this.botSecret },
    });
  }

  _wsSend(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn('[WeCom] WebSocket not open, cannot send:', payload.cmd);
    }
  }

  _handleWsMessage(msg) {
    const cmd = msg.cmd;

    // 无 cmd 的响应（如订阅响应或 ping ack）直接用 errcode 判断
    if (!cmd) {
      if (msg.errcode === 0) {
        if (!this._subscribed) {
          this._subscribed = true;
          console.log('[WeCom] WebSocket subscribed successfully');
          this._startHeartbeat();
        }
      } else if (msg.errcode !== undefined) {
        console.error(`[WeCom] WS response error: ${msg.errcode} ${msg.errmsg}`);
      } else {
        console.log(`[WeCom] Unknown WS message: ${JSON.stringify(msg).substring(0, 200)}`);
      }
      return;
    }

    switch (cmd) {
      case 'pong':
        this.missedPongs = 0;
        break;

      case 'aibot_msg_callback':
        this._handleBotWsMessage(msg.headers?.req_id, msg.body).catch(err => {
          console.error('[WeCom] Bot WS message error:', err.message);
        });
        break;

      case 'aibot_event_callback':
        this._handleBotWsEvent(msg.headers?.req_id, msg.body).catch(err => {
          console.error('[WeCom] Bot WS event error:', err.message);
        });
        break;

      case 'disconnected_event':
        console.warn('[WeCom] Received disconnected_event, will reconnect after delay');
        this._stopHeartbeat();
        if (this.ws) { this.ws.close(); this.ws = null; }
        this._reconnectTimer = setTimeout(() => this._connectWebSocket(), 5000);
        break;

      case 'aibot_respond_msg_response':
      case 'aibot_send_msg_response':
        if (msg.errcode !== 0) {
          console.error(`[WeCom] ${cmd} error: ${msg.errcode} ${msg.errmsg}`);
        }
        break;

      default:
        console.log(`[WeCom] Unhandled WS cmd: ${cmd}, msg: ${JSON.stringify(msg).substring(0, 200)}`);
    }
  }

  // ==================== 心跳 ====================

  _startHeartbeat() {
    this._stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      this.missedPongs++;
      if (this.missedPongs > MAX_MISSED_PONGS) {
        console.warn('[WeCom] Heartbeat timeout, reconnecting...');
        this._stopHeartbeat();
        if (this.ws) { this.ws.close(); this.ws = null; }
        this._reconnect();
        return;
      }
      this._wsSend({ cmd: 'ping', headers: { req_id: crypto.randomUUID() } });
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ==================== 重连 ====================

  _reconnect() {
    if (this._closing) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    console.log(`[WeCom] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this._reconnectTimer = setTimeout(() => this._connectWebSocket(), delay);
  }

  // ==================== WebSocket 消息处理 ====================

  async _handleBotWsMessage(reqId, body) {
    const msg = {
      msgid: body.msgid,
      userId: body.from?.userid,
      chatId: body.chatid,
      chatType: body.chattype,  // 'single' | 'group'
      msgtype: body.msgtype,
      text: body.text,
      image: body.image,
      mixed: body.mixed,
      voice: body.voice,
      file: body.file,
      video: body.video,
    };

    // 去重
    if (msg.msgid && this.handled.has(msg.msgid)) return;
    if (msg.msgid) {
      this.handled.set(msg.msgid, Date.now());
      if (this.handled.size > 1000) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [k, v] of this.handled) {
          if (v < cutoff) this.handled.delete(k);
        }
      }
    }

    let text = '';
    let mediaFiles = [];
    const streamId = crypto.randomUUID();

    if (msg.msgtype === 'text') {
      text = msg.text?.content || '';
      if (msg.chatType === 'group' && text) {
        text = text.replace(/@[\w\u4e00-\u9fa5]+\s*/, '').trim();
      }
    } else if (msg.msgtype === 'voice') {
      text = msg.voice?.content || '[语音消息]';
    } else if (msg.msgtype === 'image') {
      console.log(`[WeCom] WS received image from ${msg.userId}`);
      let saved;
      if (msg.image?.url) {
        saved = await this._downloadMediaFromWs(msg.image.url, msg.image.aeskey, 'image');
      }
      if (saved) {
        mediaFiles.push(saved);
        text = '[用户发送了一张图片]';
      } else {
        this._wsReply(reqId, streamId, '抱歉，图片下载失败，请重新发送。');
        return;
      }
    } else if (msg.msgtype === 'mixed') {
      console.log(`[WeCom] WS received mixed message from ${msg.userId}`);
      for (const item of (msg.mixed?.msg_item || [])) {
        if (item.msgtype === 'text') {
          const t = (item.text?.content || '').replace(/@[\w\u4e00-\u9fa5]+\s*/g, '').trim();
          if (t) text += (text ? ' ' : '') + t;
        } else if (item.msgtype === 'image' && item.image?.url) {
          const saved = await this._downloadMediaFromWs(item.image.url, item.image.aeskey, 'image');
          if (saved) mediaFiles.push(saved);
        }
      }
      if (!text && mediaFiles.length > 0) text = '[用户发送了图片]';
    } else if (msg.msgtype === 'file') {
      console.log(`[WeCom] WS received file from ${msg.userId}`);
      if (msg.file?.url) {
        const saved = await this._downloadMediaFromWs(msg.file.url, msg.file.aeskey, 'file');
        if (saved) {
          mediaFiles.push(saved);
          text = '[用户发送了文件]';
        } else {
          this._wsReply(reqId, streamId, '抱歉，文件下载失败，请重新发送。');
          return;
        }
      }
    } else if (msg.msgtype === 'video') {
      this._wsReply(reqId, streamId, '暂不支持视频消息，请发送文字或图片。');
      return;
    } else if (msg.msgtype === 'event') {
      // 事件走 aibot_event_callback，不应到这里
      return;
    } else {
      console.log(`[WeCom] Unsupported WS message type: ${msg.msgtype}`);
      return;
    }

    if (!text && mediaFiles.length === 0) return;

    const isGroup = msg.chatType === 'group';
    const channelLabel = isGroup ? '企微群聊' : '企微私聊';
    const sessionId = isGroup ? `wecom-group:${msg.chatId}` : `wecom:${msg.userId}`;

    // /test 命令
    if (text === '/test') {
      const testMsg = this._buildTestMessage();
      this._wsReply(reqId, streamId, this._transformForBot(testMsg));
      return;
    }

    // /session 命令
    if (text === '/session' || text === '/session new') {
      if (text === '/session new') {
        const sid = this.gateway.session.get(sessionId);
        if (sid) await this.gateway._endSession(sid);
        this.gateway.session.clear(sessionId);
      }
      await this._sendSessionCardWs(reqId, msg.userId, msg.chatId, msg.chatType, sessionId,
        text === '/session new' ? '✅ 已创建新会话' : null);
      return;
    }

    console.log(`[WeCom] [bot-ws] ${channelLabel} from ${msg.userId}: ${text.substring(0, 80)}`);

    // 流式：先发"正在思考..."
    this._wsSend({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'stream', stream: { id: streamId, finish: false, content: '正在思考...' } },
    });

    try {
      const profileId = isGroup ? msg.chatId : msg.userId;
      const result = await this.gateway.processMessage({
        chatId: sessionId,
        text,
        mediaFiles,
        chatType: isGroup ? 'group' : 'p2p',
        channelLabel,
        senderName: isGroup ? msg.userId : undefined,
        userProfile: this.userProfile.get(profileId),
      });

      const content = this._transformForBot(result.text);
      this._wsSend({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: true, content } },
      });
    } catch (err) {
      console.error('[WeCom] WS processing error:', err.message);
      this._wsSend({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: '抱歉，处理消息时出错，请稍后重试。' } },
      });
    }

    for (const f of mediaFiles) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }

  /** 便捷方法：通过 WS 发送一次性文本回复 */
  _wsReply(reqId, streamId, content) {
    this._wsSend({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'stream', stream: { id: streamId, finish: true, content } },
    });
  }

  // ==================== WebSocket 事件处理 ====================

  async _handleBotWsEvent(reqId, body) {
    const eventType = body.event_type;
    console.log(`[WeCom] WS event: ${eventType}`);

    switch (eventType) {
      case 'enter_chat': {
        this._wsSend({
          cmd: 'aibot_respond_welcome_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'markdown', markdown: { content: `你好，我是 ${process.env.BOT_NAME || 'OpenMist'}，有什么可以帮你的？` } },
        });
        break;
      }

      case 'template_card_event': {
        await this._handleCardEventWs(reqId, body);
        break;
      }

      case 'feedback_event': {
        console.log(`[WeCom] Feedback event: ${JSON.stringify(body)}`);
        break;
      }

      default:
        console.log(`[WeCom] Unhandled WS event: ${eventType}`);
    }
  }

  async _handleCardEventWs(reqId, body) {
    const eventData = body.template_card_event;
    if (!eventData || eventData.card_type !== 'button_interaction') return;

    const userId = body.from?.userid;
    const chatId = body.chatid;
    const chatType = body.chattype || 'single';
    const isGroup = chatType === 'group';
    const sessionKey = isGroup ? `wecom-group:${chatId}` : `wecom:${userId}`;
    const responseKey = eventData.response_key;

    console.log(`[WeCom] WS card action: ${responseKey} on ${sessionKey}`);

    let notice = null;
    if (responseKey === 'create_session' || responseKey === 'end_session') {
      const sid = this.gateway.session.get(sessionKey);
      if (sid) await this.gateway._endSession(sid);
      this.gateway.session.clear(sessionKey);
      notice = responseKey === 'create_session' ? '✅ 已创建新会话' : '✅ 会话已结束';
    }

    await this._sendSessionCardWs(reqId, userId, chatId, chatType, sessionKey, notice);
  }

  async _sendSessionCardWs(reqId, userId, chatId, chatType, sessionKey, notice) {
    const sessionId = this.gateway.session.get(sessionKey);
    const sessionInfo = this.gateway.session.sessions[sessionKey];

    let descText;
    if (sessionId) {
      const size = this.gateway._getSessionSize(sessionId);
      const age = sessionInfo?.updatedAt
        ? Math.round((Date.now() - sessionInfo.updatedAt) / 60000) : 0;
      descText = `会话 ID: ${sessionId.substring(0, 8)}...  |  大小: ${(size / 1024).toFixed(0)} KB  |  最近活动: ${age} 分钟前`;
    } else {
      descText = '无活跃会话，发消息将自动创建新会话';
    }

    const card = {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        main_title: { title: notice || '会话管理', desc: descText },
        task_id: 'wecom-session',
        card_action: { type: 1, url: process.env.SITE_BASE_URL || '' },
        button_list: [
          { text: '新建会话', key: 'create_session', type: 1, style: 3 },
          { text: '结束会话', key: 'end_session', type: 1, style: 2 },
        ],
      },
    };

    this._wsSend({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: card,
    });
  }

  // ==================== 主动推送（Bot WebSocket） ====================

  sendMessage(chatId, chatType, content, msgtype = 'markdown') {
    this._wsSend({
      cmd: 'aibot_send_msg',
      headers: { req_id: crypto.randomUUID() },
      body: {
        chatid: chatId,
        chat_type: chatType === 'group' ? 2 : 1,
        msgtype,
        markdown: { content },
      },
    });
  }

  // ==================== URL 验证（GET，App 通道） ====================

  _verifyURL(req, res, channel) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const msgSignature = url.searchParams.get('msg_signature');
      const timestamp = url.searchParams.get('timestamp');
      const nonce = url.searchParams.get('nonce');
      const echostr = url.searchParams.get('echostr');

      if (!msgSignature || !timestamp || !nonce || !echostr) {
        res.writeHead(400);
        res.end('Missing parameters');
        return;
      }

      const signature = this._computeSignature(channel.token, timestamp, nonce, echostr);
      if (signature !== msgSignature) {
        console.error(`[WeCom] URL verification signature mismatch (${channel.source})`);
        res.writeHead(403);
        res.end('Signature mismatch');
        return;
      }

      const decrypted = this._decrypt(channel.aesKey, echostr);
      console.log(`[WeCom] URL verification passed (${channel.source})`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(decrypted);
    } catch (err) {
      console.error(`[WeCom] URL verification failed (${channel.source}):`, err.message);
      res.writeHead(500);
      res.end('Internal error');
    }
  }

  // ==================== 消息回调（POST，App 通道） ====================

  _handleCallback(req, res, channel) {
    let body = '';
    const MAX_BODY = 10 * 1024 * 1024;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
      }
    });
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');

      try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        let encrypt, msgSignature, timestamp, nonce;

        if (body.trimStart().startsWith('{')) {
          const json = JSON.parse(body);
          encrypt = json.encrypt || json.Encrypt;
          msgSignature = json.msgsignature || urlObj.searchParams.get('msg_signature');
          timestamp = String(json.timestamp || urlObj.searchParams.get('timestamp'));
          nonce = String(json.nonce || urlObj.searchParams.get('nonce'));
        } else {
          const outerXml = await parseStringPromise(body, { explicitArray: false });
          encrypt = outerXml.xml.Encrypt;
          msgSignature = urlObj.searchParams.get('msg_signature');
          timestamp = urlObj.searchParams.get('timestamp');
          nonce = urlObj.searchParams.get('nonce');
        }

        if (!encrypt) {
          console.error(`[WeCom] No encrypt field in callback (${channel.source})`);
          return;
        }

        const signature = this._computeSignature(channel.token, timestamp, nonce, encrypt);
        if (signature !== msgSignature) {
          console.error(`[WeCom] Signature mismatch (${channel.source})`);
          return;
        }

        const decrypted = this._decrypt(channel.aesKey, encrypt);

        // App 通道解密后是 XML
        let msg;
        if (decrypted.trimStart().startsWith('{')) {
          msg = JSON.parse(decrypted);
        } else {
          const innerXml = await parseStringPromise(decrypted, { explicitArray: false });
          msg = innerXml.xml;
        }
        console.log(`[WeCom] App message (${channel.source}): MsgType=${msg.MsgType}`);

        await this._processAppMessage(msg);
      } catch (err) {
        console.error(`[WeCom] Callback error (${channel.source}):`, err.message);
      }
    });
  }

  // ==================== App 通道消息处理 ====================

  async _processAppMessage(msg) {
    const msgId = msg.MsgId;
    const msgType = msg.MsgType;
    const userId = msg.FromUserName;
    const chatId = msg.ChatId;
    const chatType = chatId ? 'group' : 'single';

    // 去重
    if (msgId && this.handled.has(msgId)) return;
    if (msgId) {
      this.handled.set(msgId, Date.now());
      if (this.handled.size > 1000) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [k, v] of this.handled) {
          if (v < cutoff) this.handled.delete(k);
        }
      }
    }

    // 消息时效检查
    const createTime = parseInt(msg.CreateTime || 0) * 1000;
    if (createTime && Date.now() - createTime > STALE_THRESHOLD_MS) {
      console.log(`[WeCom] Skipping stale message ${msgId}`);
      return;
    }

    let text = '';
    let mediaFiles = [];

    if (msgType === 'text') {
      text = msg.Content || '';
    } else if (msgType === 'image') {
      const saved = await this._downloadMedia(msg.MediaId || msg.media_id, 'image');
      if (saved) {
        mediaFiles.push(saved);
        text = '[用户发送了一张图片]';
      } else {
        await this._sendAppReply(userId, '抱歉，图片下载失败，请重新发送。');
        return;
      }
    } else if (msgType === 'file') {
      const saved = await this._downloadMedia(msg.MediaId || msg.media_id, 'file');
      if (saved) {
        mediaFiles.push(saved);
        text = '[用户发送了文件]';
      } else {
        await this._sendAppReply(userId, '抱歉，文件下载失败，请重新发送。');
        return;
      }
    } else if (msgType === 'video') {
      await this._sendAppReply(userId, '暂不支持视频消息，请发送文字或图片。');
      return;
    } else if (msgType === 'event') {
      // App 通道事件暂不处理
      return;
    } else {
      console.log(`[WeCom] Unsupported App message type: ${msgType}`);
      return;
    }

    if (!text && mediaFiles.length === 0) return;

    const isGroup = chatType === 'group';
    const channelLabel = isGroup ? '企微群聊' : '企微私聊';
    const sessionId = isGroup ? `wecom-group:${chatId}` : `wecom:${userId}`;

    // /test 命令
    if (text === '/test') {
      await this._sendAppReply(userId, this._buildTestMessage());
      return;
    }

    // /session 命令
    if (text === '/session' || text === '/session new') {
      if (text === '/session new') {
        const sid = this.gateway.session.get(sessionId);
        if (sid) await this.gateway._endSession(sid);
        this.gateway.session.clear(sessionId);
      }
      const notice = text === '/session new' ? '✅ 已创建新会话' : null;
      await this._sendAppSessionCard(userId, chatId, chatType, sessionId, notice);
      return;
    }

    console.log(`[WeCom] [app] ${channelLabel} from ${userId}: ${text.substring(0, 80)}`);

    try {
      const profileId = isGroup ? chatId : userId;
      const result = await this.gateway.processMessage({
        chatId: sessionId,
        text,
        mediaFiles,
        chatType: isGroup ? 'group' : 'p2p',
        channelLabel,
        senderName: isGroup ? userId : undefined,
        userProfile: this.userProfile.get(profileId),
      });

      await this._sendAppReply(userId, result.text);
    } catch (err) {
      console.error('[WeCom] App processing error:', err.message);
      await this._sendAppReply(userId, '抱歉，处理消息时出错，请稍后重试。');
    }

    for (const f of mediaFiles) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }

  async _sendAppSessionCard(userId, _chatId, _chatType, sessionKey, notice) {
    const sessionId = this.gateway.session.get(sessionKey);
    const sessionInfo = this.gateway.session.sessions[sessionKey];

    let descText;
    if (sessionId) {
      const size = this.gateway._getSessionSize(sessionId);
      const age = sessionInfo?.updatedAt
        ? Math.round((Date.now() - sessionInfo.updatedAt) / 60000) : 0;
      descText = `会话 ID: ${sessionId.substring(0, 8)}...  |  大小: ${(size / 1024).toFixed(0)} KB  |  最近活动: ${age} 分钟前`;
    } else {
      descText = '无活跃会话，发消息将自动创建新会话';
    }

    await this._sendAppReply(userId,
      `**${notice || '会话管理'}**\n\n${descText}\n\n发 \`/session new\` 新建会话`);
  }

  // ==================== 消息发送 ====================

  _splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  }

  // Bot 通道不支持多行代码块，转为纯文本标注
  _transformForBot(text) {
    return text
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const label = lang ? `**[${lang}]**` : '**[代码]**';
        return `${label}\n${code.trim()}`;
      })
      .replace(/~~(.+?)~~/g, '$1');
  }

  /** App 通道回复：message/send API */
  async _sendAppReply(userId, text) {
    const chunks = this._splitMessage(text, MAX_TEXT_LEN);
    for (const chunk of chunks) {
      await this._apiPost('/message/send', {
        touser: userId,
        msgtype: 'markdown',
        agentid: this.agentId,
        markdown: { content: chunk },
      });
    }
  }

  // ==================== 媒体下载 ====================

  /** WebSocket 模式：通过 url + aeskey 下载并解密媒体 */
  async _downloadMediaFromWs(url, aeskey, type) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let buffer = Buffer.from(await response.arrayBuffer());

      // 如果有 aeskey，需要 AES-256-CBC 解密
      if (aeskey) {
        const key = Buffer.from(aeskey, 'base64');
        const iv = key.subarray(0, 16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
      }

      // 类型检测
      const ext = this._detectExt(buffer, type);
      const filename = `wecom_ws_${Date.now()}${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(`[WeCom] WS media saved: ${filePath} (${buffer.length} bytes)`);
      return { type: type === 'image' ? 'image' : 'file', path: filePath, name: filename };
    } catch (err) {
      console.error(`[WeCom] WS media download failed: ${err.message}`);
      return null;
    }
  }

  _detectExt(buffer, type) {
    if (type === 'image') {
      if (buffer[0] === 0xFF && buffer[1] === 0xD8) return '.jpg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50) return '.png';
      if (buffer[0] === 0x47 && buffer[1] === 0x49) return '.gif';
      if (buffer[0] === 0x52 && buffer[1] === 0x49) return '.webp';
      return '.jpg';
    }
    return '.bin';
  }

  /** App 通道：通过 media_id 下载 */
  async _downloadMedia(mediaId, type) {
    try {
      const token = await this._getAccessToken();
      const url = `${WECOM_API}/media/get?access_token=${token}&media_id=${mediaId}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const disposition = response.headers.get('content-disposition') || '';
      const contentType = response.headers.get('content-type') || '';
      let filename = `wecom_${Date.now()}`;

      const nameMatch = disposition.match(/filename="?(.+?)"?$/i);
      if (nameMatch) {
        filename = path.basename(nameMatch[1]);
      } else if (type === 'image') {
        const ext = contentType.includes('png') ? '.png' : '.jpg';
        filename += ext;
      }

      const filePath = path.join(MEDIA_DIR, filename);
      const buffer = Buffer.from(await response.arrayBuffer());

      if (contentType.includes('json')) {
        const errBody = JSON.parse(buffer.toString());
        throw new Error(`WeCom API error: ${errBody.errmsg || JSON.stringify(errBody)}`);
      }

      fs.writeFileSync(filePath, buffer);
      console.log(`[WeCom] Media saved: ${filePath} (${buffer.length} bytes)`);
      return { type: type === 'image' ? 'image' : 'file', path: filePath, name: filename };
    } catch (err) {
      console.error(`[WeCom] Media download failed: ${err.message}`);
      return null;
    }
  }

  // ==================== Access Token（App 通道） ====================

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const url = `${WECOM_API}/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.errcode !== 0) {
      throw new Error(`Token fetch failed: ${data.errmsg}`);
    }

    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    console.log(`[WeCom] Access token refreshed, expires in ${data.expires_in}s`);
    return this._accessToken;
  }

  // ==================== API 请求（App 通道） ====================

  async _apiPost(endpoint, body) {
    try {
      const token = await this._getAccessToken();
      const url = `${WECOM_API}${endpoint}?access_token=${token}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.errcode !== 0) {
        console.error(`[WeCom] API ${endpoint} error: ${data.errmsg}`);
      }
      return data;
    } catch (err) {
      console.error(`[WeCom] API ${endpoint} failed: ${err.message}`);
      return null;
    }
  }

  // ==================== 加解密（App 通道） ====================

  _computeSignature(token, timestamp, nonce, encrypt) {
    const items = [token, timestamp, nonce, encrypt].sort();
    return crypto.createHash('sha1').update(items.join('')).digest('hex');
  }

  _decrypt(aesKey, encrypted) {
    const encryptedBuf = Buffer.from(encrypted, 'base64');
    const iv = aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);

    let decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);

    // PKCS#7 去填充
    const padLen = decrypted[decrypted.length - 1];
    decrypted = decrypted.subarray(0, decrypted.length - padLen);

    // 前 16 字节随机数，4 字节消息长度（网络字节序），消息内容，CorpID
    const msgLen = decrypted.readUInt32BE(16);
    const message = decrypted.subarray(20, 20 + msgLen).toString('utf-8');
    return message;
  }

  // ==================== 工具方法 ====================

  _buildTestMessage() {
    return [
      '# 一、标题与强调',
      '',
      '这是正文内容，**这里是加粗的重要信息**，阅读时视觉权重更高。*这里是斜体文字*，通常用于术语、书名或补充说明。',
      '',
      '# 二、代码',
      '',
      '行内代码示例：调用 `gateway.processMessage()` 时需要传入 `chatId` 和 `text` 两个必填参数。',
      '',
      '# 三、引用',
      '',
      '> 引用块通常用于摘录、注意事项或对话。',
      '> 第二行引用内容会紧接在第一行下方。',
      '',
      '# 四、无序列表',
      '',
      '- **飞书**：WebSocket 长连接，支持卡片交互、任务调度、媒体推送',
      '- **企业微信（Bot）**：WebSocket 长连接，支持流式输出和主动推送',
      '- **企业微信（App）**：HTTP API，可主动推送',
      '',
      '# 五、有序列表',
      '',
      '1. 用户发送消息到飞书或企微',
      '2. Gateway 检索相关历史记忆并注入上下文',
      '3. 调用 Claude SDK 处理消息',
      '4. 将结果回复给用户，并写入记忆归档',
      '',
      '# 六、表格',
      '',
      '| 渠道 | 协议 | 主动推送 | 流式输出 |',
      '|------|------|----------|----------|',
      '| 飞书 | WebSocket | ✅ | ✅ |',
      '| 企微 Bot | WebSocket | ✅ | ✅ |',
      '| 企微 App | HTTP API | ✅ | ❌ |',
      '',
      `相关链接：[${process.env.BOT_NAME || 'OpenMist'} 主页](${process.env.SITE_BASE_URL || ''})`,
      '',
      '---',
      '',
      '以上覆盖了企微 Bot Markdown 支持的全部格式。',
    ].join('\n');
  }
}

module.exports = { WeComAdapter };
