const lark = require("@larksuiteoapi/node-sdk");
const { MessageFormatter } = require("../message-formatter");
const { MEDIA_DIR } = require("../claude");
const { UserProfileStore } = require("../user-profile");
const COS = require("cos-nodejs-sdk-v5");
const fs = require("fs");
const path = require("path");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");
const https = require("https");
const http = require("http");
const execFileAsync = promisify(execFileCb);

const { approveSkill } = require("../hooks");

const STALE_THRESHOLD_MS = 30 * 1000;
const SUPPORTED_MSG_TYPES = ["text", "image", "post", "file"];
const DOWNLOADS_DIR = path.join(__dirname, "..", "..", "downloads");
const START_TIME = Date.now();

class FeishuAdapter {
  constructor({ gateway, bitable, taskExecutor, deployer }) {
    this.gateway = gateway;
    // 通过 gateway 访问共享资源（卡片构建等需要）
    this.session = gateway.session;
    this.memory = gateway.memory;
    this.metrics = gateway.metrics;
    // 飞书专有
    this.bitable = bitable;
    this.taskExecutor = taskExecutor;
    this.deployer = deployer;
    this.handled = new Map();

    this.client = new lark.Client({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    this.formatter = new MessageFormatter();
    this.userProfile = new UserProfileStore();
    this.pendingOnboarding = new Map(); // chatId → { messageId, text, mediaFiles }
    this.recentLogs = []; // 最近处理记录（内存中，重启清空）

    // 确保 media 目录存在
    if (!fs.existsSync(MEDIA_DIR)) {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
  }

  async start() {
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        this._handleMessage(data).catch((err) =>
          console.error("[Feishu] Unhandled error:", err.message)
        );
      },
    });

    // 注册卡片回调 — 长连接模式下通过 EventDispatcher 接收
    eventDispatcher.register({
      "card.action.trigger": (data) => {
        return this._handleCardAction(data);
      },
    });

    const wsClient = new lark.WSClient({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
    });

    await wsClient.start({ eventDispatcher });
    console.log("[Feishu] WebSocket connected (with card action handler)");

    // 启动时检查是否有刚完成的更新需要通知
    this._checkLastUpdate();
  }

  _checkLastUpdate() {
    const lastUpdatePath = path.join(__dirname, '..', '..', 'data', 'updates', 'last-update.json');
    try {
      if (!fs.existsSync(lastUpdatePath)) return;
      const data = JSON.parse(fs.readFileSync(lastUpdatePath, 'utf-8'));
      if (data.notified) return;

      const results = data.results || [];
      const succeeded = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      let msg = `[系统更新完成] ${succeeded.length}/${results.length} 成功`;
      if (succeeded.length > 0) {
        msg += '\n' + succeeded.map(r => `✅ ${r.label}: ${r.from} → ${r.to}`).join('\n');
      }
      if (failed.length > 0) {
        msg += '\n' + failed.map(r => `❌ ${r.label}: 更新失败`).join('\n');
      }

      // 标记已通知
      data.notified = true;
      fs.writeFileSync(lastUpdatePath, JSON.stringify(data, null, 2));

      // 发到飞书群
      const { execFileSync } = require('child_process');
      execFileSync('node', ['scripts/send-notify.js', msg], {
        cwd: path.join(__dirname, '..', '..'),
        timeout: 15_000,
      });
      console.log('[Feishu] Update completion notification sent');
    } catch (err) {
      console.warn('[Feishu] Check last update failed:', err.message);
    }
  }

  // ==================== 消息处理 ====================

  async _handleMessage(data) {
    const { message } = data;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    const chatType = message.chat_type;
    const msgType = message.message_type;

    if (!SUPPORTED_MSG_TYPES.includes(msgType)) return;

    const createTime = parseInt(message.create_time);
    if (createTime) {
      const ageMs = Date.now() - createTime;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.log(`[Feishu] Skipping stale message ${messageId} (${Math.round(ageMs / 1000)}s old)`);
        return;
      }
    }

    if (this.handled.has(messageId)) return;
    this.handled.set(messageId, Date.now());
    if (this.handled.size > 1000) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of this.handled) {
        if (v < cutoff) this.handled.delete(k);
      }
    }

    let text = "";
    let mediaFiles = [];
    const startTime = Date.now();

    try {
      const content = JSON.parse(message.content);

      if (msgType === "image") {
        const imageKey = content.image_key;
        console.log(`[Feishu] Received image: ${imageKey}`);
        const saved = await this._saveImage(messageId, imageKey);
        if (saved) {
          mediaFiles.push(saved);
          text = "[用户发送了一张图片]";
        } else {
          await this._reply(messageId, "抱歉先生，图片下载失败，请重新发送。");
          return;
        }
      } else if (msgType === "post") {
        const parsed = this._parsePostContent(content);
        text = parsed.text;
        for (const imageKey of parsed.imageKeys) {
          console.log(`[Feishu] Post image: ${imageKey}`);
          const saved = await this._saveImage(messageId, imageKey);
          if (saved) mediaFiles.push(saved);
        }
        console.log(`[Feishu] Post parsed - text: ${text.substring(0, 50)}, images: ${mediaFiles.length}`);
      } else if (msgType === "file") {
        const fileKey = content.file_key;
        const fileName = content.file_name || 'unknown';
        console.log(`[Feishu] Received file: ${fileName} (${fileKey})`);
        const saved = await this._saveFile(messageId, fileKey, fileName);
        if (saved) {
          mediaFiles.push(saved);
          text = `[用户发送了文件: ${fileName}]`;
        } else {
          await this._reply(messageId, "抱歉先生，文件下载失败，请重新发送。");
          return;
        }
      } else {
        text = content.text || "";
      }

      if (chatType === "group") {
        const hasMention = message.mentions && message.mentions.length > 0;
        if (!hasMention) return;
        text = text.replace(/@_user_\w+/g, "").trim();
      }

      if (!text && mediaFiles.length === 0) return;

      const senderId = data.sender?.sender_id?.open_id;
      console.log(`[Feishu] Message from ${chatId}${senderId ? ` (${senderId.substring(0, 8)})` : ''}: ${text.substring(0, 80)}`);

      await this._checkPendingNotifications(messageId);

      // === 菜单指令处理 ===
      const bareCmd = text.match(/^\/(build|task|session|status|help|log|cos|memory|dev-go|dev-fix|dev-refactor|update)$/);
      if (bareCmd) {
        await this._handleMenuCommand(messageId, chatId, bareCmd[1]);
        return;
      }

      const buildMatch = text.match(/^\/build\s+(.+)/s);
      if (buildMatch && this.taskExecutor) {
        await this._handleTask(messageId, chatId, buildMatch[1].trim());
        return;
      }

      const taskMatch = text.match(/^\/task\s+(.+)/s);
      if (taskMatch) {
        await this._reply(messageId, `⚡ 收到，开始执行…`);
        this._runGatewayTaskAsync(chatId, taskMatch[1].trim());
        return;
      }

      // === Onboarding 门控 ===
      if (!this.userProfile.hasProfile(chatId)) {
        this.pendingOnboarding.set(chatId, { messageId, text, mediaFiles });
        await this._replyCard(messageId, this._buildOnboardingCard());
        return;
      }

      // === 通过 Gateway 处理核心管线 ===
      await this._addReaction(messageId, "OnIt");

      const beforeDownloadTime = Date.now();
      const result = await this.gateway.processMessage({
        chatId,
        text,
        mediaFiles,
        chatType,
        channelLabel: chatType === 'group' ? '飞书群聊' : '飞书私聊',
        senderName: chatType === 'group' ? senderId : undefined,
        userProfile: this.userProfile.get(chatId),
        userId: senderId,
      });

      const responseTime = (Date.now() - startTime) / 1000;

      await this._reply(messageId, result.text);
      await this._addReaction(messageId, "DONE");

      // 推送新下载的媒体文件（视频直接在聊天中播放）
      await this._pushNewDownloads(messageId, chatId, beforeDownloadTime);

      // === 记忆指标收集 ===
      try {
        const pm = result.pipelineMetrics;
        const contextTokens = Math.round((pm.memoryContext || "").length / 4);
        const totalTokens = Math.round((pm.enrichedPrompt || "").length / 4) + Math.round((result.text || "").length / 4);
        let memoryAgeDays = null;
        if (pm.retrievalMemories.length > 0) {
          const newest = pm.retrievalMemories[0];
          if (newest.endTime) memoryAgeDays = (Date.now() - new Date(newest.endTime).getTime()) / (24 * 60 * 60 * 1000);
        }
        this.metrics.record({
          chatId,
          sessionId: result.sessionId,
          retrievalHit: pm.injectedCount > 0,
          retrievalMs: pm.retrievalMs,
          contextTokens,
          totalTokens,
          responseBytes: Buffer.byteLength(result.text || "", "utf-8"),
          memoryAgeDays,
          injectedCount: pm.injectedCount,
        });
      } catch (metricsErr) {
        console.warn("[Feishu] Metrics record failed:", metricsErr.message);
      }
      this._pushLog(chatId, text, responseTime, '成功');
      this.bitable.logChat({
        chatId,
        userMessage: text,
        jarvisReply: result.text,
        responseTime: Math.round(responseTime * 10) / 10,
        status: "成功",
        sessionId: result.sessionId,
      });
    } catch (err) {
      const responseTime = (Date.now() - startTime) / 1000;
      console.error(`[Feishu] Error handling message ${messageId}:`, err.message);
      await this._reply(messageId, `抱歉先生，处理时遇到了问题：${err.message}`);

      this._pushLog(chatId, text, responseTime, '失败');
      this.bitable.logChat({
        chatId,
        userMessage: text,
        jarvisReply: err.message,
        responseTime: Math.round(responseTime * 10) / 10,
        status: "失败",
        sessionId: "",
      });
    }
  }

  // ==================== 媒体文件下载 ====================

  async _saveImage(messageId, imageKey) {
    try {
      console.log(`[Feishu] Downloading image: ${imageKey}`);
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: "image" },
      });

      if (resp && typeof resp.getReadableStream === "function") {
        const stream = resp.getReadableStream();
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const fileName = `img-${Date.now()}-${imageKey.substring(0, 8)}.png`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, buffer);
        console.log(`[Feishu] Image saved: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
        return { type: 'image', path: filePath, name: fileName };
      }

      console.error("[Feishu] Unexpected image response format");
      return null;
    } catch (err) {
      console.error("[Feishu] Failed to download image:", err.message);
      return null;
    }
  }

  async _saveFile(messageId, fileKey, fileName) {
    try {
      console.log(`[Feishu] Downloading file: ${fileName} (${fileKey})`);
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: "file" },
      });

      if (resp && typeof resp.getReadableStream === "function") {
        const stream = resp.getReadableStream();
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const safeName = `${Date.now()}-${fileName}`;
        const filePath = path.join(MEDIA_DIR, safeName);
        fs.writeFileSync(filePath, buffer);
        console.log(`[Feishu] File saved: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
        return { type: 'file', path: filePath, name: fileName };
      }

      console.error("[Feishu] Unexpected file response format");
      return null;
    } catch (err) {
      console.error("[Feishu] Failed to download file:", err.message);
      return null;
    }
  }

  // ==================== Post 内容解析 ====================

  _parsePostContent(content) {
    let text = '';
    const imageKeys = [];
    const post = content.zh_cn || content.en_us || content;
    const title = post.title || '';
    const paragraphs = post.content || [];

    for (const paragraph of paragraphs) {
      for (const element of paragraph) {
        if (element.tag === 'text') {
          text += element.text || '';
        } else if (element.tag === 'img') {
          if (element.image_key) imageKeys.push(element.image_key);
        } else if (element.tag === 'at') {
          // skip
        } else if (element.tag === 'a') {
          text += element.text || element.href || '';
        }
      }
      text += '\n';
    }

    if (title) {
      text = title + '\n' + text;
    }

    return { text: text.trim(), imageKeys };
  }

  // ==================== 卡片交互 ====================

  async _handleCardAction(data) {
    try {
      const action = data.action;
      const actionValue = action?.value || {};
      const actionType = actionValue.action;
      const chatId = data.context?.open_chat_id || data.open_chat_id;
      if (!chatId) {
        console.warn('[Feishu] Card action missing chatId:', JSON.stringify(data.context || {}).slice(0, 200));
        return { toast: { type: 'error', content: '无法识别来源会话' } };
      }

      console.log(`[Feishu] Card action: ${actionType} from chat ${chatId}`);

      if (actionType === 'create_session') {
        const existingSessionId = this.session.get(chatId);
        if (existingSessionId) {
          await this.gateway._endSession(existingSessionId);
        }
        this.session.clear(chatId);
        return this._cardResponse(this._buildSessionCard(chatId, '已创建新会话'), '已创建新会话');
      }

      if (actionType === 'end_session') {
        const existingSessionId = this.session.get(chatId);
        if (existingSessionId) {
          await this.gateway._endSession(existingSessionId);
        }
        this.session.clear(chatId);
        return this._cardResponse(this._buildSessionCard(chatId, '已结束当前会话'), '会话已结束');
      }

      if (actionType === 'switch_session') {
        const targetSessionId = actionValue.targetSessionId;
        if (!targetSessionId) return { toast: { type: 'error', content: '无效的会话 ID' } };
        await this.gateway.switchSession(chatId, targetSessionId);
        return this._cardResponse(this._buildSessionCard(chatId, '已切换到历史会话'), '已切换');
      }

      if (actionType === 'approve_update') {
        return this._handleUpdateAction(chatId, true);
      }

      if (actionType === 'deny_update') {
        return this._handleUpdateAction(chatId, false);
      }

      // Skill Vetter 审核确认/拒绝
      if (actionType === 'approve_skill') {
        const pluginName = actionValue.pluginName;
        const verdict = actionValue.verdict || 'SAFE';
        const pendingTask = actionValue.pendingTask || null;
        if (!pluginName) return { toast: { type: 'error', content: '缺少插件名称' } };
        approveSkill(pluginName, verdict);
        // 确认后直接安装，安装完成后续接原任务
        this._installAndResumeAsync(chatId, pluginName, pendingTask);
        return { toast: { type: 'success', content: `已批准「${pluginName}」，正在安装…` } };
      }

      if (actionType === 'deny_skill') {
        const pluginName = actionValue.pluginName || '未知';
        console.log(`[Security] Skill denied by user: ${pluginName}`);
        return { toast: { type: 'info', content: `已拒绝安装「${pluginName}」` } };
      }

      if (actionType === 'refresh_status') {
        return this._cardResponse(this._buildStatusCard(), '状态已刷新');
      }

      // select_static 回调（历史会话切换）
      if (action.name === 'switch_session_select' && action.option) {
        const targetSessionId = action.option;
        await this.gateway.switchSession(chatId, targetSessionId);
        return this._cardResponse(this._buildSessionCard(chatId, '已切换到历史会话'), '已切换');
      }

      if (action.action_type === 'form_submit') {
        if (action.form_value?.project_desc !== undefined) {
          const desc = action.form_value.project_desc.trim();
          if (!desc) return { toast: { type: 'error', content: '请输入项目描述' } };
          const msgId = data.context?.open_message_id;
          this._executeTaskAsync(msgId, chatId, desc);
          const preview = desc.length > 30 ? desc.slice(0, 30) + '…' : desc;
          return { toast: { type: 'success', content: `收到，开始构建：${preview}` } };
        }
        if (action.form_value?.task_instruction !== undefined) {
          const instruction = action.form_value.task_instruction.trim();
          if (!instruction) return { toast: { type: 'error', content: '请输入任务说明' } };
          this._runGatewayTaskAsync(chatId, instruction);
          const preview = instruction.length > 30 ? instruction.slice(0, 30) + '…' : instruction;
          return { toast: { type: 'success', content: `收到，开始执行：${preview}` } };
        }
        if (action.form_value?.session_name !== undefined) {
          const name = action.form_value.session_name.trim();
          this.session.setName(chatId, name);
          const msg = name ? `会话已命名为「${name}」` : '已清除会话名称';
          return this._cardResponse(this._buildSessionCard(chatId, msg), msg);
        }
        if (action.form_value?.memory_content !== undefined) {
          const content = action.form_value.memory_content.trim();
          if (!content) return { toast: { type: 'error', content: '请输入要记住的内容' } };
          await this.memory.saveManual(content, chatId);
          const preview = content.length > 20 ? content.slice(0, 20) + '…' : content;
          return { toast: { type: 'success', content: `已记住：${preview}` } };
        }
        if (action.form_value?.search_query !== undefined) {
          const query = action.form_value.search_query.trim();
          if (!query) return { toast: { type: 'error', content: '请输入搜索关键词' } };
          const results = await this.memory.retrieveRelevantMemories(query, chatId);
          const convs = results.recentConversations;
          if (convs.length === 0) {
            return { toast: { type: 'info', content: '未找到相关记忆' } };
          }
          const lines = convs.map((c, i) => {
            const date = c.endTime?.split('T')[0] || '未知';
            const intent = c.summary?.userIntent || '未知意图';
            return `${i + 1}. **[${date}]** ${intent}`;
          });
          await this._sendCardToChat(chatId, this._createCard(`记忆搜索：${query}`, 'wathet', [
            { tag: 'markdown', content: `找到 ${convs.length} 条相关记忆：\n\n${lines.join('\n')}` },
          ]));
          return { toast: { type: 'info', content: `找到 ${convs.length} 条相关记忆` } };
        }
        if (action.form_value?.dev_instruction !== undefined) {
          const instruction = action.form_value.dev_instruction.trim();
          if (!instruction) return { toast: { type: 'error', content: '请输入描述' } };
          // 从按钮的 value 中获取 skill 名称
          const skillName = action.form_value?.skill || action.name?.replace('submit_', '') || 'dev-go';
          const fullInstruction = `/${skillName} ${instruction}`;
          this._runGatewayTaskAsync(chatId, fullInstruction);
          const preview = instruction.length > 30 ? instruction.slice(0, 30) + '...' : instruction;
          return { toast: { type: 'success', content: `收到，开始执行：${preview}` } };
        }
        if (action.form_value?.agent_name !== undefined || action.form_value?.submit_onboarding !== undefined) {
          const profile = {
            agentName: (action.form_value.agent_name || 'Jarvis').trim(),
            userName: (action.form_value.user_name || '先生').trim(),
            role: action.form_value.role || 'personal',
            language: action.form_value.language || 'zh',
          };
          this.userProfile.set(chatId, profile);
          console.log(`[Feishu] Onboarding completed for ${chatId}:`, profile);

          // 处理暂存的原始消息
          const pending = this.pendingOnboarding.get(chatId);
          if (pending) {
            this.pendingOnboarding.delete(chatId);
            // 异步处理原始消息，不阻塞卡片响应
            setImmediate(() => {
              this._processAfterOnboarding(pending.messageId, chatId, pending.text, pending.mediaFiles);
            });
          }

          return { toast: { type: 'success', content: `你好${profile.userName}！${profile.agentName} 为你服务` } };
        }
        return { toast: { type: 'error', content: '请输入内容' } };
      }

      if (actionType === 'open_command') {
        const cmd = actionValue.cmd || action.option;
        let card;
        if (cmd === 'build') card = this._buildBuildCard();
        else if (cmd === 'task') card = this._buildTaskCard();
        else if (cmd === 'session') card = this._buildSessionCard(chatId);
        else if (cmd === 'status') card = this._buildStatusCard();
        else if (cmd === 'log') card = this._buildLogCard();
        else if (cmd === 'memory') card = this._buildMemoryCard();
        else if (cmd === 'cos') card = await this._buildCosCard();
        else if (cmd === 'dev-go' || cmd === 'dev-fix' || cmd === 'dev-refactor') card = this._buildDevCard(cmd);
        if (card) await this._sendCardToChat(chatId, card);
        return { toast: { type: 'info', content: `已打开 /${cmd}` } };
      }

      console.warn(`[Feishu] Unknown card action: ${actionType}`);
      return undefined;
    } catch (err) {
      console.error("[Feishu] Card action error:", err.message);
      return { toast: { type: 'error', content: `操作失败：${err.message}` } };
    }
  }

  _cardResponse(card, toastContent) {
    const resp = { card: { type: 'raw', data: card } };
    if (toastContent) {
      resp.toast = { type: 'success', content: toastContent };
    }
    return resp;
  }

  // ==================== 卡片构建 ====================

  /** 创建标准 v2 卡片骨架 */
  _createCard(title, template, elements) {
    return {
      schema: '2.0',
      config: { width_mode: 'fill' },
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    };
  }

  _buildSessionCard(chatId, notice) {
    const sessionId = this.session.get(chatId);
    const sessionInfo = this.session.sessions[chatId];
    const history = this.session.getHistory(chatId);
    const elements = [];

    if (notice) {
      elements.push({ tag: 'markdown', content: `✅ ${notice}` });
      elements.push({ tag: 'hr' });
    }

    elements.push({ tag: 'markdown', content: '会话保存对话上下文，上下文越大回复越慢。话题切换或响应变慢时可新建会话。' });
    elements.push({ tag: 'hr' });

    // 当前会话信息 + 命名表单
    if (sessionId) {
      const size = this.gateway._getSessionSize(sessionId);
      const age = sessionInfo?.updatedAt ? Math.round((Date.now() - sessionInfo.updatedAt) / 60000) : 0;
      const sizeKB = (size / 1024).toFixed(0);
      const ageText = age < 60 ? `${age} 分钟前` : `${Math.floor(age / 60)} 小时前`;
      const nameLabel = sessionInfo?.name ? `「${sessionInfo.name}」 ` : '';
      elements.push({ tag: 'markdown', content: `**当前会话** ${nameLabel}\`${sessionId.substring(0, 8)}...\`\n上下文：${sizeKB} KB　·　活动：${ageText}` });
      elements.push({
        tag: 'form',
        name: 'rename_form',
        elements: [
          {
            tag: 'input',
            name: 'session_name',
            placeholder: { tag: 'plain_text', content: '给这个会话起个名字...' },
            default_value: sessionInfo?.name || '',
            width: 'fill',
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '更新名称' },
            type: 'default',
            action_type: 'form_submit',
            name: 'submit_rename',
          },
        ],
      });
    } else {
      elements.push({ tag: 'markdown', content: '**无活跃会话**\n下次发消息时将自动创建新会话。' });
    }

    elements.push({ tag: 'hr' });

    // 历史会话列表
    if (history.length > 0) {
      elements.push({ tag: 'markdown', content: '**历史会话**' });
      elements.push({
        tag: 'select_static',
        name: 'switch_session_select',
        placeholder: { tag: 'plain_text', content: '选择历史会话...' },
        options: history.slice(0, 10).map(h => {
          const label = h.name || h.sessionId.substring(0, 8) + '...';
          const endDate = new Date(h.endedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return { text: { tag: 'plain_text', content: `${label} · ${endDate}` }, value: h.sessionId };
        }),
      });
    } else {
      elements.push({ tag: 'markdown', content: '**历史会话**\n暂无历史会话' });
    }

    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            { tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'primary', value: { action: 'create_session' } },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            { tag: 'button', text: { tag: 'plain_text', content: '结束会话' }, type: 'danger', value: { action: 'end_session' } },
          ],
        },
      ],
    });

    return this._createCard('会话管理', 'blue', elements);
  }

  _buildStatusCard() {
    const uptimeMs = Date.now() - START_TIME;
    const uptimeH = Math.floor(uptimeMs / 3600000);
    const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
    const mem = process.memoryUsage();
    const memMB = Math.round(mem.rss / 1024 / 1024);
    const activeSessions = Object.keys(this.session.sessions).length;

    const statusText = [
      `**运行时间** ${uptimeH}小时${uptimeM}分钟`,
      `**内存占用** ${memMB}MB`,
      `**活跃会话** ${activeSessions}个`,
      `**已处理消息** ${this.handled.size}条`,
    ].join('\n');

    return this._createCard('系统状态', 'green', [
      { tag: 'markdown', content: statusText },
      { tag: 'hr' },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '刷新' },
        type: 'default',
        value: { action: 'refresh_status' },
      },
    ]);
  }

  _buildLogCard() {
    if (this.recentLogs.length === 0) {
      return this._createCard('消息日志', 'orange', [
        { tag: 'markdown', content: '暂无处理记录（重启后清空）' },
      ]);
    }

    const lines = this.recentLogs.slice().reverse().map(log => {
      const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false });
      const text = log.text.length > 20 ? log.text.substring(0, 20) + '...' : log.text;
      const icon = log.status === '成功' ? '✅' : '❌';
      return `${icon} \`${time}\` ${text} (${log.responseTime}s)`;
    }).join('\n');

    return this._createCard('消息日志', 'orange', [
      { tag: 'markdown', content: `最近 ${this.recentLogs.length} 条记录：\n\n${lines}` },
    ]);
  }

  async _buildCosCard() {
    try {
      const cos = new COS({
        SecretId: process.env.COS_SECRET_ID,
        SecretKey: process.env.COS_SECRET_KEY,
      });

      const data = await new Promise((resolve, reject) => {
        cos.getBucket({
          Bucket: process.env.COS_BUCKET,
          Region: process.env.COS_REGION,
          MaxKeys: 1000,
        }, (err, data) => err ? reject(err) : resolve(data));
      });

      const files = data.Contents || [];
      const totalSize = files.reduce((sum, f) => sum + Number(f.Size), 0);

      const groups = {};
      for (const f of files) {
        const prefix = f.Key.split('/')[0] || '(root)';
        if (!groups[prefix]) groups[prefix] = { count: 0, size: 0 };
        groups[prefix].count++;
        groups[prefix].size += Number(f.Size);
      }

      const groupLines = Object.entries(groups).map(([prefix, info]) => {
        return `- \`${prefix}/\` ${info.count}个文件, ${this._formatSize(info.size)}`;
      }).join('\n');

      const statusText = [
        `**文件总数** ${files.length}`,
        `**总大小** ${this._formatSize(totalSize)}`,
        '',
        groupLines,
      ].join('\n');

      return this._createCard('COS 存储概览', 'purple', [
        { tag: 'markdown', content: statusText },
      ]);
    } catch (err) {
      return this._createCard('COS 存储概览', 'red', [
        { tag: 'markdown', content: `查询失败: ${err.message}` },
      ]);
    }
  }

  _buildMemoryCard() {
    const stats = this.memory.getStats();
    const m = this.metrics.summarize(7);

    const statLines = [
      `短期记忆 ${stats.shortTerm.totalConversations} 条 · 实体 ${stats.shortTerm.entityCount} 个 · 进行中 ${stats.activeConversations} 个`,
    ];
    if (m.total > 0) {
      statLines.push(`7天 ${m.total} 次对话 · 命中率 ${(m.hitRate * 100).toFixed(0)}% · 检索 ${m.avgRetrievalMs}ms`);
    }

    return this._createCard('记忆系统', 'wathet', [
          { tag: 'markdown', content: statLines.join('\n') },
          { tag: 'hr' },
          {
            tag: 'form',
            name: 'memory_save_form',
            elements: [
              {
                tag: 'input',
                name: 'memory_content',
                placeholder: { tag: 'plain_text', content: '记住：下周一有产品评审...' },
                width: 'fill',
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '记住' },
                type: 'primary',
                action_type: 'form_submit',
                name: 'submit_memory_save',
              },
            ],
          },
          { tag: 'hr' },
          {
            tag: 'form',
            name: 'memory_search_form',
            elements: [
              {
                tag: 'input',
                name: 'search_query',
                placeholder: { tag: 'plain_text', content: '搜索：关于 nginx 的配置...' },
                width: 'fill',
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '搜索' },
                type: 'default',
                action_type: 'form_submit',
                name: 'submit_memory_search',
              },
            ],
          },
    ]);
  }

  _buildBuildCard() {
    return this._createCard('项目构建', 'purple', [
      { tag: 'markdown', content: `根据描述自动生成代码，部署到 ${process.env.TASK_DOMAIN || 'your-domain.com'} 子域名。\n\n**能做什么**\n- 网页小游戏（贪吃蛇、俄罗斯方块、华容道…）\n- 工具页面（倒计时、计算器、转换器…）\n- 数据展示（图表、排行榜、仪表盘…）\n- 任何静态网页或 Node.js 应用` },
      { tag: 'hr' },
      {
        tag: 'form',
        name: 'build_form',
        elements: [
          {
            tag: 'input',
            name: 'project_desc',
            required: true,
            input_type: 'multiline_text',
            rows: 6,
            width: 'fill',
            placeholder: { tag: 'plain_text', content: '例：做一个倒计时到除夕的网页，背景用烟花动画' },
            max_length: 500,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '开始构建' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_build',
          },
        ],
      },
    ]);
  }

  _buildTaskCard() {
    return this._createCard('执行任务', 'turquoise', [
      { tag: 'markdown', content: '让 Jarvis 在服务器上执行任务，完成后发送通知。\n\n**能做什么**\n- 服务器运维：检查状态、分析日志、清理文件、查看进程\n- 数据操作：抓取网页、更新多维表格、生成报告\n- 项目构建：生成网页/应用并自动部署\n- 脚本执行：运行任意 shell 或 Node.js 脚本' },
      { tag: 'hr' },
      {
        tag: 'form',
        name: 'task_form',
        elements: [
          {
            tag: 'input',
            name: 'task_instruction',
            required: true,
            input_type: 'multiline_text',
            rows: 6,
            width: 'fill',
            placeholder: { tag: 'plain_text', content: '例：检查服务器磁盘使用情况，列出占用最大的 10 个目录' },
            max_length: 500,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '开始执行' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_task',
          },
        ],
      },
    ]);
  }

  _buildUpdateCard() {
    const availablePath = path.join(__dirname, '..', '..', 'data', 'updates', 'available.json');
    if (!fs.existsSync(availablePath)) {
      return this._createCard('系统更新', 'green', [
        { tag: 'markdown', content: '当前系统已是最新版本，没有可用更新。' },
      ]);
    }

    try {
      const data = JSON.parse(fs.readFileSync(availablePath, 'utf-8'));
      const updates = data.updates || [];
      if (updates.length === 0) {
        return this._createCard('系统更新', 'green', [
          { tag: 'markdown', content: '没有可用更新。' },
        ]);
      }

      const lines = updates.map(u => {
        const status = u.approved ? '✅ 已批准' : '⏳ 待批准';
        if (u.source === 'repo') {
          return `- **${u.label}** ${u.current} → ${u.latest}（落后 ${u.behind} 个提交）${status}`;
        }
        return `- **${u.label}** ${u.current} → ${u.latest} ${status}`;
      });

      const checkedAt = new Date(data.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      return this._createCard('系统更新', 'orange', [
        { tag: 'markdown', content: `检查时间：${checkedAt}\n\n${lines.join('\n')}` },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          columns: [
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '全部批准' }, type: 'primary', value: { action: 'approve_update' } }] },
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '跳过' }, type: 'default', value: { action: 'deny_update' } }] },
          ],
        },
      ]);
    } catch (err) {
      return this._createCard('系统更新', 'red', [
        { tag: 'markdown', content: `读取更新信息失败：${err.message}` },
      ]);
    }
  }

  _handleUpdateAction(chatId, approve) {
    const availablePath = path.join(__dirname, '..', '..', 'data', 'updates', 'available.json');
    try {
      if (!fs.existsSync(availablePath)) {
        return { toast: { type: 'info', content: '没有待处理的更新' } };
      }
      if (approve) {
        const data = JSON.parse(fs.readFileSync(availablePath, 'utf-8'));
        data.updates.forEach(u => { u.approved = true; });
        fs.writeFileSync(availablePath, JSON.stringify(data, null, 2));
        console.log(`[Feishu] Updates approved by chat ${chatId}`);
        return { toast: { type: 'success', content: '已批准全部更新，将在 5 分钟内执行' } };
      } else {
        fs.unlinkSync(availablePath);
        console.log(`[Feishu] Updates skipped by chat ${chatId}`);
        return { toast: { type: 'info', content: '已跳过本次更新' } };
      }
    } catch (err) {
      return { toast: { type: 'error', content: `操作失败：${err.message}` } };
    }
  }

  _buildDevCard(skillName) {
    const configs = {
      'dev-go': { title: '快速开发', color: 'green', placeholder: '例：给 heartbeat 加一个检查 swap 使用率的原生检查', desc: '从需求到部署一步完成：编码 → 测试 → 提交 → 部署' },
      'dev-fix': { title: 'Bug 修复', color: 'red', placeholder: '例：feishu-bot 发消息偶尔超时，日志有 ETIMEOUT', desc: '定位问题并修复：查日志 → 找根因 → 最小修复 → 验证' },
      'dev-refactor': { title: '代码重构', color: 'orange', placeholder: '例：把 feishu.js 的卡片构建方法提取到独立文件', desc: '安全地改善代码结构：分析 → 安全网 → 小步重构 → 验证' },
    };
    const cfg = configs[skillName] || configs['dev-go'];
    return this._createCard(cfg.title, cfg.color, [
      { tag: 'markdown', content: cfg.desc },
      { tag: 'hr' },
      {
        tag: 'form',
        name: `${skillName}_form`,
        elements: [
          {
            tag: 'input',
            name: 'dev_instruction',
            required: true,
            input_type: 'multiline_text',
            rows: 6,
            width: 'fill',
            placeholder: { tag: 'plain_text', content: cfg.placeholder },
            max_length: 500,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '开始' },
            type: 'primary',
            action_type: 'form_submit',
            name: `submit_${skillName}`,
            value: { skill: skillName },
          },
        ],
      },
    ]);
  }

  _buildOnboardingCard() {
    return this._createCard('欢迎使用', 'indigo', [
      { tag: 'markdown', content: '你好！我是你的智能助手。在开始之前，让我了解一下你的偏好。' },
      { tag: 'hr' },
      {
        tag: 'form',
        name: 'onboarding_form',
        elements: [
          {
            tag: 'input',
            name: 'agent_name',
            placeholder: { tag: 'plain_text', content: '助手名称' },
            default_value: 'Jarvis',
            width: 'fill',
          },
          {
            tag: 'input',
            name: 'user_name',
            placeholder: { tag: 'plain_text', content: '你希望被怎么称呼' },
            default_value: '先生',
            width: 'fill',
          },
          {
            tag: 'select_static',
            name: 'role',
            placeholder: { tag: 'plain_text', content: '使用场景' },
            options: [
              { text: { tag: 'plain_text', content: '个人助手' }, value: 'personal' },
              { text: { tag: 'plain_text', content: '开发辅助' }, value: 'dev' },
              { text: { tag: 'plain_text', content: '团队协作' }, value: 'team' },
            ],
          },
          {
            tag: 'select_static',
            name: 'language',
            placeholder: { tag: 'plain_text', content: '回复语言' },
            options: [
              { text: { tag: 'plain_text', content: '中文' }, value: 'zh' },
              { text: { tag: 'plain_text', content: 'English' }, value: 'en' },
            ],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '开始使用' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_onboarding',
          },
        ],
      },
    ]);
  }

  _buildHelpCard() {
    const botName = process.env.BOT_NAME || 'OpenMist';
    const taskDomain = process.env.TASK_DOMAIN || 'your-domain.com';
    return this._createCard(`${botName} 指令中心`, 'indigo', [
      { tag: 'markdown', content: `点击按钮直接打开对应功能。也可以直接发文字、图片或文件与 ${botName} 对话。` },
      { tag: 'hr' },
      { tag: 'markdown', content: `**🔨 构建项目** \`/build\`\n生成网页或应用，自动部署到 ${taskDomain} 子域名\n适合：游戏、工具页、数据展示、静态或 Node.js 项目` },
      { tag: 'button', text: { tag: 'plain_text', content: '打开' }, type: 'primary', value: { action: 'open_command', cmd: 'build' } },
      { tag: 'hr' },
      { tag: 'markdown', content: `**⚡ 执行任务** \`/task\`\n让 ${botName} 在服务器执行任务，完成后通知\n适合：运维操作、数据处理、日志分析、脚本执行` },
      { tag: 'button', text: { tag: 'plain_text', content: '打开' }, type: 'primary', value: { action: 'open_command', cmd: 'task' } },
      { tag: 'hr' },
      { tag: 'markdown', content: '**开发工具**' },
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '/dev-go' }, type: 'primary', value: { action: 'open_command', cmd: 'dev-go' } }] },
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '/dev-fix' }, type: 'danger', value: { action: 'open_command', cmd: 'dev-fix' } }] },
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '/dev-refactor' }, type: 'default', value: { action: 'open_command', cmd: 'dev-refactor' } }] },
        ],
      },
      { tag: 'hr' },
      { tag: 'markdown', content: '**更多功能**' },
      {
        tag: 'overflow',
        value: { action: 'open_command' },
        options: [
          { text: { tag: 'plain_text', content: '💬 会话管理' }, value: 'session' },
          { text: { tag: 'plain_text', content: '📊 系统状态' }, value: 'status' },
          { text: { tag: 'plain_text', content: '📋 消息日志' }, value: 'log' },
          { text: { tag: 'plain_text', content: '🧠 记忆系统' }, value: 'memory' },
          { text: { tag: 'plain_text', content: '☁️ COS 存储' }, value: 'cos' },
        ],
      },
    ]);
  }

  _pushLog(chatId, text, responseTime, status) {
    this.recentLogs.push({
      time: Date.now(),
      chatId: chatId.substring(chatId.length - 6),
      text: text || '[媒体文件]',
      responseTime: Math.round(responseTime * 10) / 10,
      status,
    });
    if (this.recentLogs.length > 20) this.recentLogs.shift();
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  // ==================== 菜单指令 ====================

  async _handleMenuCommand(messageId, chatId, cmd) {
    if (cmd === 'session') {
      await this._replyCard(messageId, this._buildSessionCard(chatId));
      return;
    }

    if (cmd === 'status') {
      await this._replyCard(messageId, this._buildStatusCard());
      return;
    }

    if (cmd === 'log') {
      await this._replyCard(messageId, this._buildLogCard());
      return;
    }

    if (cmd === 'cos') {
      const card = await this._buildCosCard();
      await this._replyCard(messageId, card);
      return;
    }

    if (cmd === 'memory') {
      await this._replyCard(messageId, this._buildMemoryCard());
      return;
    }

    if (cmd === 'build') {
      await this._replyCard(messageId, this._buildBuildCard());
      return;
    }

    if (cmd === 'task') {
      await this._replyCard(messageId, this._buildTaskCard());
      return;
    }

    if (cmd === 'dev-go' || cmd === 'dev-fix' || cmd === 'dev-refactor') {
      await this._replyCard(messageId, this._buildDevCard(cmd));
      return;
    }

    if (cmd === 'update') {
      await this._replyCard(messageId, this._buildUpdateCard());
      return;
    }

    if (cmd === 'help') {
      await this._replyCard(messageId, this._buildHelpCard());
      return;
    }

    await this._reply(messageId, '未知指令，发送 /help 查看可用指令。');
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

  async _reply(messageId, text) {
    try {
      const chunks = this._splitMessage(text, 3500);
      for (const chunk of chunks) {
        let formatted = this.formatter.format(chunk);

        if (formatted.pendingImages && formatted.pendingImages.length > 0) {
          formatted = await this._resolvePendingImages(formatted);
        }

        await this.client.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: formatted.content,
            msg_type: formatted.msg_type,
          },
        });
      }
    } catch (err) {
      console.error("[Feishu] Failed to send reply:", err.message);
    }
  }

  async _replyCard(messageId, card) {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } catch (err) {
      console.error("[Feishu] Failed to send card reply:", err.message);
    }
  }

  async _sendCardToChat(chatId, card) {
    try {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
        params: { receive_id_type: 'chat_id' },
      });
    } catch (err) {
      console.error('[Feishu] Failed to send card to chat:', err.message);
    }
  }

  async _sendMessage(chatId, text) {
    try {
      const chunks = this._splitMessage(text, 3500);
      for (const chunk of chunks) {
        let formatted = this.formatter.format(chunk);

        if (formatted.pendingImages && formatted.pendingImages.length > 0) {
          formatted = await this._resolvePendingImages(formatted);
        }

        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            content: formatted.content,
            msg_type: formatted.msg_type,
          },
          params: { receive_id_type: "chat_id" },
        });
      }
    } catch (err) {
      console.error("[Feishu] Failed to send message:", err.message);
    }
  }

  async _addReaction(messageId, emojiType) {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch (err) {
      console.warn("[Feishu] Reaction failed:", emojiType, err.message?.substring(0, 80));
    }
  }

  // ==================== 图片处理（AI 回复中的图片） ====================

  /**
   * 处理格式化结果中的待上传图片：下载 → 上传飞书 → 替换占位符
   */
  async _resolvePendingImages(formatted) {
    let contentStr = formatted.content;

    for (let i = 0; i < formatted.pendingImages.length; i++) {
      const img = formatted.pendingImages[i];
      const placeholder = `__PENDING_IMG_${i}__`;

      try {
        const imageKey = await this._downloadAndUploadImage(img.url);
        if (imageKey) {
          contentStr = contentStr.replace(placeholder, imageKey);
        } else {
          contentStr = this._replaceImgWithFallback(contentStr, placeholder, img);
        }
      } catch (err) {
        console.warn(`[Feishu] Image processing failed: ${err.message}`);
        contentStr = this._replaceImgWithFallback(contentStr, placeholder, img);
      }
    }

    return { msg_type: formatted.msg_type, content: contentStr };
  }

  /**
   * 上传图片到飞书，支持本地路径和远程 URL
   * - file:///path/to/image.png → 直接读本地文件上传
   * - /path/to/image.png → 直接读本地文件上传
   * - https://... → 先下载再上传
   */
  async _downloadAndUploadImage(imageUrl) {
    let localPath = null;
    let needCleanup = false;

    try {
      // 本地文件：file:// 协议或绝对路径
      if (imageUrl.startsWith('file://')) {
        localPath = imageUrl.replace('file://', '');
      } else if (imageUrl.startsWith('/')) {
        localPath = imageUrl;
      }

      if (localPath) {
        if (!fs.existsSync(localPath)) {
          throw new Error(`Local file not found: ${localPath}`);
        }
        console.log(`[Feishu] Uploading local image: ${localPath} (${(fs.statSync(localPath).size / 1024).toFixed(0)}KB)`);
      } else {
        // 远程 URL：先下载到临时文件
        localPath = path.join(MEDIA_DIR, `tmp-upload-${Date.now()}.img`);
        needCleanup = true;
        const buffer = await this._downloadFromUrl(imageUrl);
        fs.writeFileSync(localPath, buffer);
        console.log(`[Feishu] Image downloaded: ${(buffer.length / 1024).toFixed(0)}KB from ${imageUrl.substring(0, 80)}`);
      }

      // 上传到飞书
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(localPath),
        },
      });

      const imageKey = uploadResp?.image_key || uploadResp?.data?.image_key;
      if (imageKey) {
        console.log(`[Feishu] Image uploaded to Feishu: ${imageKey}`);
      }
      return imageKey;
    } finally {
      if (needCleanup) {
        try { fs.unlinkSync(localPath); } catch {}
      }
    }
  }

  /**
   * 从 URL 下载文件，支持重定向
   */
  _downloadFromUrl(url, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const request = client.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._downloadFromUrl(res.headers.location, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }

  /**
   * 图片上传失败时，将 img 元素替换为 markdown 链接作为降级方案
   */
  _replaceImgWithFallback(contentStr, placeholder, img) {
    try {
      const card = JSON.parse(contentStr);
      card.elements = card.elements.map(el => {
        if (el.tag === 'img' && el.img_key === placeholder) {
          return { tag: 'markdown', content: `[${img.alt || '图片'}](${img.url})` };
        }
        return el;
      });
      return JSON.stringify(card);
    } catch {
      return contentStr.replace(`"${placeholder}"`, '""');
    }
  }

  // ==================== 媒体推送 ====================

  async _pushNewDownloads(messageId, chatId, sinceTimestamp) {
    try {
      if (!fs.existsSync(DOWNLOADS_DIR)) return;
      const files = fs.readdirSync(DOWNLOADS_DIR);
      for (const file of files) {
        const match = file.match(/^(\d+)-/);
        if (match && parseInt(match[1]) >= sinceTimestamp) {
          const filePath = path.join(DOWNLOADS_DIR, file);
          await this._sendMediaToChat(messageId, chatId, filePath);
        }
      }
    } catch (err) {
      console.warn('[Feishu] Push downloads failed:', err.message);
    }
  }

  async _sendMediaToChat(messageId, chatId, filePath) {
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fileStat = fs.statSync(filePath);
    const sizeMB = fileStat.size / 1024 / 1024;

    if (sizeMB > 30) {
      console.log(`[Feishu] File too large for direct push (${sizeMB.toFixed(1)}MB): ${fileName}`);
      return;
    }

    const isVideo = ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);
    const isAudio = ['.mp3', '.ogg', '.wav', '.opus', '.m4a'].includes(ext);

    try {
      const fileType = isVideo ? 'mp4' : isAudio ? 'opus' : 'stream';
      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = uploadResp?.file_key || uploadResp?.data?.file_key;
      if (!fileKey) {
        console.error('[Feishu] File upload returned no file_key:', JSON.stringify(uploadResp).substring(0, 200));
        return;
      }

      if (isVideo) {
        let imageKey = null;
        try {
          imageKey = await this._generateAndUploadThumbnail(filePath);
        } catch (thumbErr) {
          console.warn('[Feishu] Thumbnail generation failed (non-blocking):', thumbErr.message);
        }

        const content = imageKey
          ? { file_key: fileKey, image_key: imageKey }
          : { file_key: fileKey };

        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'media',
            content: JSON.stringify(content),
          },
          params: { receive_id_type: 'chat_id' },
        });
        console.log(`[Feishu] Pushed video: ${fileName} (${sizeMB.toFixed(1)}MB)`);
      } else {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
          params: { receive_id_type: 'chat_id' },
        });
        console.log(`[Feishu] Pushed file: ${fileName} (${sizeMB.toFixed(1)}MB)`);
      }
    } catch (err) {
      console.error(`[Feishu] Media push failed for ${fileName}: ${err.message}`);
    }
  }

  async _generateAndUploadThumbnail(videoPath) {
    const thumbPath = videoPath + '.thumb.jpg';
    try {
      await execFileAsync('/usr/bin/ffmpeg', [
        '-i', videoPath,
        '-ss', '00:00:01',
        '-frames:v', '1',
        '-vf', 'scale=480:-1',
        '-y',
        thumbPath,
      ], { timeout: 10000 });

      if (!fs.existsSync(thumbPath)) return null;

      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(thumbPath),
        },
      });

      fs.unlinkSync(thumbPath);

      const imageKey = uploadResp?.image_key || uploadResp?.data?.image_key;
      if (imageKey) {
        console.log(`[Feishu] Thumbnail uploaded: ${imageKey}`);
      }
      return imageKey;
    } catch (err) {
      try { fs.unlinkSync(thumbPath); } catch {}
      throw err;
    }
  }

  // ==================== 消息扩展能力 ====================

  /**
   * 编辑已发送的消息内容（仅支持文本和富文本）
   */
  async editMessage(messageId, newContent, msgType = 'text') {
    try {
      const content = msgType === 'text'
        ? JSON.stringify({ text: newContent })
        : newContent;
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: { content, msg_type: msgType },
      });
      console.log(`[Feishu] Message edited: ${messageId}`);
      return true;
    } catch (err) {
      console.error(`[Feishu] Edit message failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 撤回消息
   */
  async recallMessage(messageId) {
    try {
      await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      console.log(`[Feishu] Message recalled: ${messageId}`);
      return true;
    } catch (err) {
      console.error(`[Feishu] Recall message failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 转发消息到指定聊天
   */
  async forwardMessage(messageId, receiverId, receiveIdType = 'chat_id') {
    try {
      const resp = await this.client.im.message.forward({
        path: { message_id: messageId },
        data: { receive_id: receiverId },
        params: { receive_id_type: receiveIdType },
      });
      const newMsgId = resp?.message_id || resp?.data?.message_id;
      console.log(`[Feishu] Message forwarded: ${messageId} → ${receiverId} (new: ${newMsgId})`);
      return newMsgId;
    } catch (err) {
      console.error(`[Feishu] Forward message failed: ${err.message}`);
      return null;
    }
  }

  /**
   * 查询消息已读状态
   */
  async getReadUsers(messageId) {
    try {
      const items = [];
      let pageToken;
      do {
        const params = { user_id_type: 'open_id', page_size: 100 };
        if (pageToken) params.page_token = pageToken;
        const resp = await this.client.im.message.readUsers({
          path: { message_id: messageId },
          params,
        });
        const data = resp?.data || resp;
        if (data?.items) items.push(...data.items);
        pageToken = data?.page_token;
      } while (pageToken);
      console.log(`[Feishu] Read users for ${messageId}: ${items.length}`);
      return { readCount: items.length, users: items };
    } catch (err) {
      console.error(`[Feishu] Get read users failed: ${err.message}`);
      return { readCount: 0, users: [] };
    }
  }

  /**
   * 获取聊天历史消息
   */
  async getChatHistory(chatId, { startTime, endTime, pageSize = 20, pageToken } = {}) {
    try {
      const params = {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: pageSize,
      };
      if (startTime) params.start_time = String(startTime);
      if (endTime) params.end_time = String(endTime);
      if (pageToken) params.page_token = pageToken;

      const resp = await this.client.im.message.list({ params });
      const data = resp?.data || resp;
      const messages = (data?.items || []).map(m => ({
        messageId: m.message_id,
        msgType: m.msg_type,
        createTime: m.create_time,
        senderId: m.sender?.id,
        content: m.body?.content,
      }));
      console.log(`[Feishu] Chat history for ${chatId}: ${messages.length} messages`);
      return { messages, hasMore: data?.has_more, pageToken: data?.page_token };
    } catch (err) {
      console.error(`[Feishu] Get chat history failed: ${err.message}`);
      return { messages: [], hasMore: false };
    }
  }

  /**
   * Pin 消息
   */
  async pinMessage(messageId) {
    try {
      await this.client.im.pin.create({
        data: { message_id: messageId },
      });
      console.log(`[Feishu] Message pinned: ${messageId}`);
      return true;
    } catch (err) {
      console.error(`[Feishu] Pin message failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 取消 Pin 消息
   */
  async unpinMessage(messageId) {
    try {
      await this.client.im.pin.delete({
        path: { message_id: messageId },
      });
      console.log(`[Feishu] Message unpinned: ${messageId}`);
      return true;
    } catch (err) {
      console.error(`[Feishu] Unpin message failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 获取群内 Pin 消息列表
   */
  async getPinnedMessages(chatId) {
    try {
      const items = [];
      let pageToken;
      do {
        const params = { chat_id: chatId, page_size: 50 };
        if (pageToken) params.page_token = pageToken;
        const resp = await this.client.im.pin.list({ params });
        const data = resp?.data || resp;
        if (data?.items) items.push(...data.items);
        pageToken = data?.page_token;
      } while (pageToken);
      console.log(`[Feishu] Pinned messages in ${chatId}: ${items.length}`);
      return items;
    } catch (err) {
      console.error(`[Feishu] Get pinned messages failed: ${err.message}`);
      return [];
    }
  }

  // ==================== 任务构建 ====================

  async _processAfterOnboarding(messageId, chatId, text, mediaFiles) {
    try {
      await this._addReaction(messageId, 'OnIt');
      const result = await this.gateway.processMessage({
        chatId,
        text,
        mediaFiles,
        chatType: 'p2p',
        channelLabel: '飞书私聊',
        userProfile: this.userProfile.get(chatId),
      });
      await this._reply(messageId, result.text);
      await this._addReaction(messageId, 'DONE');
    } catch (err) {
      console.error('[Feishu] Post-onboarding processing failed:', err.message);
      await this._reply(messageId, `抱歉，处理时遇到了问题：${err.message}`);
    }
  }

  // ==================== Skill Vetter ====================

  /**
   * 构建 Skill Vetter 审查报告卡片
   * @param {string} pluginName - 插件名称
   * @param {string} report - 审查报告 markdown
   * @param {string} verdict - SAFE/WARNING/DANGER/BLOCK
   * @param {string} [pendingTask] - 触发安装的原始任务描述（用于审批后续接）
   */
  buildSkillVetterCard(pluginName, report, verdict, pendingTask) {
    const colorMap = { SAFE: 'green', WARNING: 'orange', DANGER: 'red', BLOCK: 'red' };
    const elements = [
      { tag: 'markdown', content: report },
    ];

    if (pendingTask) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `**待续任务**: ${pendingTask}` });
    }

    if (verdict !== 'BLOCK') {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '确认安装' },
              type: 'primary',
              value: { action: 'approve_skill', pluginName, verdict, pendingTask: pendingTask || '' },
            }],
          },
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '拒绝' },
              type: 'danger',
              value: { action: 'deny_skill', pluginName },
            }],
          },
        ],
      });
    }

    return this._createCard(`Skill 审查：${pluginName}`, colorMap[verdict] || 'orange', elements);
  }

  async _installAndResumeAsync(chatId, pluginName, pendingTask) {
    try {
      const claudeBin = process.env.CLAUDE_BIN || 'claude';
      const { stdout } = await execFileAsync(
        claudeBin,
        ['plugin', 'install', pluginName],
        { timeout: 30000 }
      );
      const output = (stdout || '').trim();
      await this._sendMessage(chatId, `插件「${pluginName}」安装完成。${output ? '\n' + output : ''}`);

      // 有待续任务 → 安装完成后自动续接
      if (pendingTask) {
        await this._sendMessage(chatId, `继续执行之前的任务…`);
        this._runGatewayTaskAsync(chatId, pendingTask);
      }
    } catch (err) {
      console.error(`[Security] Plugin install failed: ${pluginName}`, err.message);
      await this._sendMessage(chatId, `插件「${pluginName}」安装失败：${err.message}`);
    }
  }

  async _runGatewayTaskAsync(chatId, instruction) {
    try {
      const result = await this.gateway.processMessage({
        chatId,
        text: instruction,
        mediaFiles: [],
        chatType: 'p2p',
        channelLabel: '飞书私聊',
      });
      await this._sendMessage(chatId, result.text);
    } catch (err) {
      console.error('[Feishu] Gateway task failed:', err.message);
      await this._sendMessage(chatId, `任务执行失败：${err.message}`);
    }
  }

  async _handleTask(messageId, chatId, instruction) {
    await this._addReaction(messageId, "OnIt");
    await this._reply(messageId, `收到，开始构建：${instruction}\n\n这可能需要几分钟，完成后会通知您。`);
    this._executeTaskAsync(messageId, chatId, instruction);
  }

  async _executeTaskAsync(messageId, chatId, instruction) {
    const startTime = Date.now();
    try {
      const result = await this.taskExecutor.execute(instruction, (progress) => {
        console.log(`[Feishu] Task progress: ${progress}`);
      });

      let replyText = `构建完成！\n\n📋 ${result.title}\n${result.description}`;

      if (this.deployer) {
        try {
          const deployment = await this.deployer.deploy(result);
          replyText += `\n\n🔗 访问地址：${deployment.url}`;
        } catch (deployErr) {
          console.error('[Feishu] Deploy failed:', deployErr.message);
          replyText += `\n\n⚠️ 部署失败：${deployErr.message}\n文件已生成在服务器 ${result.outputDir}`;
        }
      } else {
        replyText += `\n\n📁 文件位置：${result.outputDir}`;
      }

      replyText += `\n\n💰 费用：$${result.cost.toFixed(4)}`;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      replyText += `\n⏱️ 耗时：${elapsed}秒`;

      await this._sendMessage(chatId, replyText);
      await this._addReaction(messageId, "DONE");

      this.bitable.logChat({
        chatId,
        userMessage: `/build ${instruction}`,
        jarvisReply: replyText,
        responseTime: Math.round((Date.now() - startTime) / 100) / 10,
        status: "成功",
        sessionId: "",
      });
    } catch (err) {
      console.error('[Feishu] Task execution failed:', err.message);
      const replyText = `构建失败：${err.message}`;
      await this._sendMessage(chatId, replyText);

      this.bitable.logChat({
        chatId,
        userMessage: `/build ${instruction}`,
        jarvisReply: err.message,
        responseTime: Math.round((Date.now() - startTime) / 100) / 10,
        status: "失败",
        sessionId: "",
      });
    }
  }

  // ==================== 系统通知 ====================

  async _checkPendingNotifications(messageId) {
    const notificationPath = path.join(__dirname, "..", "..", "data", "pending-notification.json");
    try {
      if (fs.existsSync(notificationPath)) {
        const notification = JSON.parse(fs.readFileSync(notificationPath, "utf-8"));
        if (!notification.read) {
          console.log("[Feishu] 发送系统通知:", notification.title);
          await this._reply(messageId, notification.message);
          fs.unlinkSync(notificationPath);
        }
      }
    } catch (err) {
      console.warn("[Feishu] 检查通知失败:", err.message);
    }
  }
}

module.exports = { FeishuAdapter };
