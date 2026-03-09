const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');
const { MEDIA_DIR } = require('../claude');

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';
const MAX_TEXT_LEN = 2048;
const STALE_THRESHOLD_MS = 30 * 1000;

class WeComAdapter {
  constructor({ gateway, port = 3001 }) {
    this.gateway = gateway;
    this.port = port;
    this.server = null;
    this.handled = new Map();

    // 企微配置
    this.corpId = process.env.WECOM_CORP_ID;
    this.agentId = parseInt(process.env.WECOM_AGENT_ID);
    this.secret = process.env.WECOM_AGENT_SECRET;

    // 双通道凭证: 自建应用(/callback) + 智能机器人(/callback/bot)
    this.channels = {
      app: this._buildChannel(process.env.WECOM_TOKEN, process.env.WECOM_ENCODING_AES_KEY),
      bot: this._buildChannel(process.env.WECOM_BOT_TOKEN, process.env.WECOM_BOT_ENCODING_AES_KEY),
    };

    // Access Token 缓存
    this._accessToken = null;
    this._tokenExpiry = 0;

    // 确保 media 目录存在
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

  /** 根据 URL 路径选择通道凭证 */
  _getChannel(url) {
    if (url.includes('/callback/bot') && this.channels.bot) {
      return { ...this.channels.bot, source: 'bot' };
    }
    if (this.channels.app) {
      return { ...this.channels.app, source: 'app' };
    }
    return null;
  }

  // ==================== 生命周期 ====================

  async start() {
    this.server = http.createServer((req, res) => {
      if (req.url.startsWith('/callback')) {
        const channel = this._getChannel(req.url);
        if (!channel) {
          console.error(`[WeCom] No credentials for path: ${req.url}`);
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

    const sources = Object.entries(this.channels)
      .filter(([, ch]) => ch)
      .map(([name]) => name);
    console.log(`[WeCom] Channels: ${sources.join(', ')}`);

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[WeCom] HTTP server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      return new Promise(resolve => this.server.close(resolve));
    }
  }

  // ==================== URL 验证（GET） ====================

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

  // ==================== 消息回调（POST） ====================

  _handleCallback(req, res, channel) {
    let body = '';
    const MAX_BODY = 10 * 1024 * 1024; // 10MB
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        console.error('[WeCom] Request body too large, rejecting');
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
      }
    });
    req.on('end', async () => {
      // 立即返回 200，避免企微超时
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');

      try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);

        // 智能机器人发 JSON，自建应用发 XML
        // JSON 格式: { "encrypt": "...", "msgsignature": "...", "timestamp": 123, "nonce": "..." }
        // XML 格式: <xml><Encrypt>...</Encrypt>...</xml>
        let encrypt, msgSignature, timestamp, nonce;

        if (body.trimStart().startsWith('{')) {
          const json = JSON.parse(body);
          encrypt = json.encrypt || json.Encrypt;
          // 智能机器人把签名参数放在 JSON body 里（同时也在 URL 里，以 JSON body 为准）
          msgSignature = json.msgsignature || urlObj.searchParams.get('msg_signature');
          timestamp = String(json.timestamp || urlObj.searchParams.get('timestamp'));
          nonce = String(json.nonce || urlObj.searchParams.get('nonce'));
          console.log(`[WeCom] JSON callback (${channel.source}): ts=${timestamp} nonce=${nonce}`);
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
          console.error(`[WeCom] Signature mismatch (${channel.source}): computed=${signature.substring(0,8)}... received=${(msgSignature||'').substring(0,8)}...`);
          return;
        }

        const decrypted = this._decrypt(channel.aesKey, encrypt);

        // 解密后智能机器人是 JSON，自建应用是 XML
        let msg;
        if (decrypted.trimStart().startsWith('{')) {
          msg = JSON.parse(decrypted);
          console.log(`[WeCom] Bot message (${channel.source}): msgtype=${msg.msgtype}, chattype=${msg.chattype}`);
        } else {
          const innerXml = await parseStringPromise(decrypted, { explicitArray: false });
          msg = innerXml.xml;
          console.log(`[WeCom] App message (${channel.source}): MsgType=${msg.MsgType}`);
        }

        await this._processMessage(msg, channel.source);
      } catch (err) {
        console.error(`[WeCom] Callback error (${channel.source}):`, err.message);
      }
    });
  }

  // ==================== 消息处理 ====================

  async _processMessage(msg, source) {
    // 智能机器人 JSON 格式: { msgid, from: {userid}, chatid, chattype, msgtype, text: {content}, response_url }
    // 自建应用 XML 格式:  { MsgId, FromUserName, MsgType, Content, CreateTime }
    const isBot = source === 'bot';

    const msgId   = isBot ? msg.msgid    : msg.MsgId;
    const msgType = isBot ? msg.msgtype  : msg.MsgType;
    const userId  = isBot ? (msg.from?.userid || msg.from) : msg.FromUserName;
    const chatId  = isBot ? msg.chatid   : msg.ChatId;   // 群聊 ID
    const chatType = isBot ? msg.chattype : (msg.ChatId ? 'group' : 'single'); // group/single
    const responseUrl = isBot ? msg.response_url : null; // 智能机器人主动回复用

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

    // 自建应用做消息时效检查（机器人无 CreateTime）
    if (!isBot) {
      const createTime = parseInt(msg.CreateTime || 0) * 1000;
      if (createTime && Date.now() - createTime > STALE_THRESHOLD_MS) {
        console.log(`[WeCom] Skipping stale message ${msgId}`);
        return;
      }
    }

    let text = '';
    let mediaFiles = [];

    if (msgType === 'text') {
      // 智能机器人: msg.text.content；自建应用: msg.Content
      text = (isBot ? msg.text?.content : msg.Content) || '';
      // 群聊中可能带 @前缀，去掉
      if (chatType === 'group' && text) {
        text = text.replace(/@[\w\u4e00-\u9fa5]+\s*/, '').trim();
      }
    } else if (msgType === 'voice' && isBot) {
      // 智能机器人语音消息会自动转文字
      text = msg.voice?.content || '[语音消息]';
    } else if (msgType === 'image') {
      console.log(`[WeCom] Received image from ${userId} (${source})`);
      let saved;
      if (isBot && msg.image?.url) {
        // Bot 通道：直接 URL
        saved = await this._downloadImageFromUrl(msg.image.url);
      } else {
        // App 通道：media_id
        saved = await this._downloadMedia(msg.MediaId || msg.media_id, 'image');
      }
      if (saved) {
        mediaFiles.push(saved);
        text = '[用户发送了一张图片]';
      } else {
        await this._sendReply(userId, chatId, chatType, responseUrl, '抱歉，图片下载失败，请重新发送。');
        return;
      }
    } else if (msgType === 'mixed' && isBot) {
      // Bot 通道图文混排
      console.log(`[WeCom] Received mixed message from ${userId}`);
      for (const item of (msg.mixed?.msg_item || [])) {
        if (item.msgtype === 'text') {
          const t = (item.text?.content || '').replace(/@[\w\u4e00-\u9fa5]+\s*/g, '').trim();
          if (t) text += (text ? ' ' : '') + t;
        } else if (item.msgtype === 'image' && item.image?.url) {
          const saved = await this._downloadImageFromUrl(item.image.url);
          if (saved) mediaFiles.push(saved);
        }
      }
      if (!text && mediaFiles.length > 0) text = '[用户发送了图片]';
    } else if (msgType === 'file') {
      const mediaId = msg.MediaId || msg.media_id;
      console.log(`[WeCom] Received file from ${userId} (${source})`);
      const saved = await this._downloadMedia(mediaId, 'file');
      if (saved) {
        mediaFiles.push(saved);
        text = '[用户发送了文件]';
      } else {
        await this._sendReply(userId, chatId, chatType, responseUrl, '抱歉，文件下载失败，请重新发送。');
        return;
      }
    } else if (msgType === 'video') {
      await this._sendReply(userId, chatId, chatType, responseUrl, '暂不支持视频消息，请发送文字或图片。');
      return;
    } else if (msgType === 'event') {
      if (msg.event?.eventtype === 'template_card_event') {
        await this._handleCardEvent(msg);
      }
      return;
    } else {
      console.log(`[WeCom] Unsupported message type: ${msgType} (${source})`);
      return;
    }

    if (!text && mediaFiles.length === 0) return;

    const isGroup = chatType === 'group';
    const channelLabel = isGroup ? '企微群聊' : '企微私聊';
    const sessionId = isGroup ? `wecom-group:${chatId}` : `wecom:${userId}`;

    // /test 命令：发送格式测试消息
    if (text === '/test') {
      const testMsg = [
        '# 一、标题与强调',
        '',
        '这是正文内容，**这里是加粗的重要信息**，阅读时视觉权重更高。*这里是斜体文字*，通常用于术语、书名或补充说明。也可以同时使用 ***加粗+斜体*** 来强调关键词。',
        '',
        '# 二、代码',
        '',
        '行内代码示例：调用 `gateway.processMessage()` 时需要传入 `chatId` 和 `text` 两个必填参数。',
        '',
        '# 三、引用',
        '',
        '> 引用块通常用于摘录、注意事项或对话。',
        '> 第二行引用内容会紧接在第一行下方，',
        '> 可以连续写多行，左侧会有统一的竖线标识。',
        '',
        '# 四、无序列表',
        '',
        '- **飞书**：WebSocket 长连接，支持卡片交互、任务调度、媒体推送',
        '- **企业微信（Bot）**：HTTP 回调，支持 Markdown 和按钮卡片',
        '- **企业微信（App）**：可主动推送，支持更丰富的卡片类型',
        '- **后续规划**：微信公众号接入、钉钉接入',
        '',
        '# 五、有序列表',
        '',
        '1. 用户发送消息到飞书或企微',
        '2. Gateway 检索相关历史记忆并注入上下文',
        '3. 调用 Claude SDK 处理消息',
        '4. 将结果回复给用户，并写入记忆归档',
        '5. 定期压缩历史会话，防止 Session 膨胀',
        '',
        '# 六、多行代码块',
        '',
        '```javascript',
        'async function processMessage({ chatId, text }) {',
        '  const memory = await retrieveRelevantMemories(text, chatId);',
        '  const response = await claude.chat(text, sessionId);',
        '  return response.result;',
        '}',
        '```',
        '',
        '# 七、删除线',
        '',
        '~~这段文字被删除了~~ 这段正常显示。旧版本用 ~~setTimeout~~ 替换为 Promise.race。',
        '',
        '# 八、表格',
        '',
        '| 渠道 | 协议 | 主动推送 | 卡片交互 |',
        '|------|------|----------|----------|',
        '| 飞书 | WebSocket | ✅ | ✅ |',
        '| 企微 Bot | HTTP 回调 | ❌ | ✅ |',
        '| 企微 App | HTTP API | ✅ | ✅ |',
        '',
        '# 九、链接与分隔',
        '',
        `相关链接：[${process.env.BOT_NAME || 'OpenMist'} 主页](${process.env.SITE_BASE_URL || ''}) · [企微开发文档](https://developer.work.weixin.qq.com)`,
        '',
        '---',
        '',
        '以上覆盖了企微 Bot Markdown 支持的全部格式。',
      ].join('\n');
      await this._sendReply(userId, chatId, chatType, responseUrl, testMsg);
      return;
    }

    // /session 命令
    if (text === '/session' || text === '/session new') {
      if (text === '/session new') {
        const sid = this.gateway.session.get(sessionId);
        if (sid) await this.gateway._endSession(sid);
        this.gateway.session.clear(sessionId);
      }
      await this._sendSessionCard(responseUrl, userId, chatId, chatType, sessionId,
        text === '/session new' ? '✅ 已创建新会话' : null);
      return;
    }

    console.log(`[WeCom] [${source}] ${channelLabel} from ${userId}: ${text.substring(0, 80)}`);

    try {
      const result = await this.gateway.processMessage({
        chatId: sessionId,
        text,
        mediaFiles,
        chatType: isGroup ? 'group' : 'p2p',
        channelLabel,
        senderName: isGroup ? userId : undefined,
      });

      await this._sendReply(userId, chatId, chatType, responseUrl, result.text);
    } catch (err) {
      console.error(`[WeCom] Processing error (${source}):`, err.message);
      await this._sendReply(userId, chatId, chatType, responseUrl, '抱歉，处理消息时出错，请稍后重试。');
    }

    // 清理媒体文件
    for (const f of mediaFiles) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }

  // ==================== 卡片交互 ====================

  async _sendSessionCard(responseUrl, userId, chatId, chatType, sessionKey, notice) {
    const sessionId = this.gateway.session.get(sessionKey);
    const sessionInfo = this.gateway.session.sessions[sessionKey];

    // 构建会话信息描述（bot 卡片只用 main_title.desc，不支持 horizontal_content_list）
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
    if (responseUrl) {
      try {
        const resp = await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
        const data = await resp.json();
        if (data.errcode !== 0) {
          console.error(`[WeCom] Card send error: ${data.errmsg}, falling back to text`);
          await this._sendReply(userId, chatId, chatType, responseUrl,
            `**${notice || '会话管理'}**\n\n${descText}\n\n发 \`/session new\` 新建会话`);
        }
      } catch (err) {
        console.error(`[WeCom] Card send failed: ${err.message}`);
      }
    } else {
      // 自建应用 fallback：发文字
      await this._sendReply(userId, chatId, chatType, null,
        `**${notice || '会话管理'}**\n\n${descText}\n\n发 \`/session new\` 新建会话`);
    }
  }

  async _handleCardEvent(msg) {
    const isGroup = msg.chattype === 'group';
    const userId = msg.from?.userid || msg.from;
    const chatId = msg.chatid;
    const responseUrl = msg.response_url;
    const eventData = msg.event?.template_card_event;
    if (!eventData || eventData.card_type !== 'button_interaction') return;
    const sessionKey = isGroup ? `wecom-group:${chatId}` : `wecom:${userId}`;
    const responseKey = eventData.response_key;
    console.log(`[WeCom] Card action: ${responseKey} on ${sessionKey}`);
    let notice = null;
    if (responseKey === 'create_session' || responseKey === 'end_session') {
      const sid = this.gateway.session.get(sessionKey);
      if (sid) await this.gateway._endSession(sid);
      this.gateway.session.clear(sessionKey);
      notice = responseKey === 'create_session' ? '✅ 已创建新会话' : '✅ 会话已结束';
    }
    if (responseUrl) {
      await this._sendSessionCard(responseUrl, userId, chatId, msg.chattype, sessionKey, notice);
    }
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

  /**
   * 统一回复：
   * - 智能机器人有 response_url → 直接 POST 到 response_url（无需 access_token）
   * - 自建应用 → message/send API
   */
  // Bot 通道不支持多行代码块，转为纯文本标注
  _transformForBot(text) {
    return text
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const label = lang ? `**[${lang}]**` : '**[代码]**';
        return `${label}\n${code.trim()}`;
      })
      .replace(/~~(.+?)~~/g, '$1');
  }

  async _sendReply(userId, chatId, chatType, responseUrl, text) {
    const content = responseUrl ? this._transformForBot(text) : text;
    const chunks = this._splitMessage(content, MAX_TEXT_LEN);

    if (responseUrl) {
      // 智能机器人：使用 response_url 回复（只能用一次，合并所有 chunk）
      const merged = chunks.join('\n\n');
      try {
        const resp = await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content: merged } }),
        });
        const data = await resp.json();
        if (data.errcode !== 0) {
          console.error(`[WeCom] response_url reply error: ${data.errmsg}`);
        }
      } catch (err) {
        console.error(`[WeCom] response_url reply failed: ${err.message}`);
      }
    } else {
      // 自建应用：message/send API
      for (const chunk of chunks) {
        await this._apiPost('/message/send', {
          touser: userId,
          msgtype: 'markdown',
          agentid: this.agentId,
          markdown: { content: chunk },
        });
      }
    }
  }

  // ==================== 媒体下载 ====================

  // Bot 通道图片：先直接 URL 下载，验证 Content-Type；非图片则回退到 API 下载
  async _downloadImageFromUrl(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') || '';
      const buffer = Buffer.from(await response.arrayBuffer());

      // 验证是否为真实图片（标准图片头：JPEG=ffd8ff, PNG=89504e47, GIF=47494638, WebP=52494646）
      const isImage = contentType.startsWith('image/') ||
        (buffer[0] === 0xFF && buffer[1] === 0xD8) ||  // JPEG
        (buffer[0] === 0x89 && buffer[1] === 0x50) ||  // PNG
        (buffer[0] === 0x47 && buffer[1] === 0x49) ||  // GIF
        (buffer[0] === 0x52 && buffer[1] === 0x49);    // WebP/RIFF

      if (!isImage) {
        console.warn(`[WeCom] Bot image URL returned non-image data (WeCom proprietary format), skipping`);
        return null;
      }

      const ext = contentType.includes('png') ? '.png' : '.jpg';
      const filename = `wecom_bot_${Date.now()}${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(`[WeCom] Bot image saved: ${filePath} (${buffer.length} bytes)`);
      return { type: 'image', path: filePath, name: filename };
    } catch (err) {
      console.error(`[WeCom] Bot image download failed: ${err.message}`);
      return null;
    }
  }

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
        filename = path.basename(nameMatch[1]); // 防路径遍历
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

      return {
        type: type === 'image' ? 'image' : 'file',
        path: filePath,
        name: filename,
      };
    } catch (err) {
      console.error(`[WeCom] Media download failed: ${err.message}`);
      return null;
    }
  }

  // ==================== Access Token ====================

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

  // ==================== API 请求 ====================

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

  // ==================== 加解密 ====================

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

    // 前 16 字节随机数，接着 4 字节消息长度（网络字节序），然后是消息内容，最后是 CorpID
    const msgLen = decrypted.readUInt32BE(16);
    const message = decrypted.subarray(20, 20 + msgLen).toString('utf-8');
    return message;
  }
}

module.exports = { WeComAdapter };
