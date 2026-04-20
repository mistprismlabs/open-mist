const lark = require("@larksuiteoapi/node-sdk");
const { MessageFormatter } = require("../message-formatter");
const { MEDIA_DIR } = require("../claude");
const { UserProfileStore } = require("../user-profile");
const fs = require("fs");
const path = require("path");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFileCb);

const { approveSkill } = require("../hooks");
const { createCardBuilder } = require("./feishu-cards");
const { FeishuMessageAPI } = require("./feishu-message-api");
const { FeishuMedia } = require("./feishu-media");
const { classifyFeishuStartupError } = require("./feishu-startup");

const STALE_THRESHOLD_MS = 30 * 1000;
const SUPPORTED_MSG_TYPES = ["text", "image", "post", "file"];
const FEISHU_PROGRESS_PREFIX = 'feishu:';

class FeishuAdapter {
  constructor({ gateway, bitable, taskExecutor, deployer, jobsService }) {
    this.gateway = gateway;
    // 通过 gateway 访问共享资源（卡片构建等需要）
    this.session = gateway.session;
    this.memory = gateway.memory;
    this.metrics = gateway.metrics;
    // 飞书专有
    this.bitable = bitable;
    this.taskExecutor = taskExecutor;
    this.deployer = deployer;
    this.jobsService = jobsService || null;
    this.handled = new Map();
    this._lastProgress = new Map(); // chatId → timestamp，进度防刷屏
    this._placeholders = new Map(); // chatId → placeholderId，流式占位消息

    // 注册进度回调：优先 edit 占位消息，无占位时新发消息
    this.gateway.registerProgressCallback('feishu', async (targetId, info) => {
      if (typeof targetId !== 'string' || !targetId.startsWith(FEISHU_PROGRESS_PREFIX)) return false;
      const chatId = targetId.slice(FEISHU_PROGRESS_PREFIX.length);
      const now = Date.now();
      // 重试通知不受防刷屏限制（用户需即时感知）
      const isRetry = info?.type === 'retry';
      const isAlert = info?.type === 'alert';
      if (!isRetry && !isAlert && now - (this._lastProgress.get(chatId) || 0) < 30000) return;
      if (!isRetry && !isAlert) this._lastProgress.set(chatId, now);

      let text;
      if (isRetry) {
        text = `⏳ API 重试中（第 ${info.attempt}/${info.maxRetries} 次，状态 ${info.errorStatus}）`;
      } else if (isAlert) {
        text = info.text || info.summary || info.description || null;
      } else {
        text = typeof info === 'string' ? info : (info?.summary || info?.description || null);
      }
      if (!text) return false;
      const placeholderId = this._placeholders.get(chatId);
      if (placeholderId) {
        const placeholderText = isAlert ? text : `⏳ ${text}`;
        const edited = await this.messageAPI.editMessage(placeholderId, placeholderText).catch(() => false);
        return Boolean(edited);
      } else {
        try {
          const outboundText = isAlert ? text : `⚙️ ${text}`;
          await this._sendMessage(chatId, outboundText);
          return true;
        } catch (e) {
          console.warn('[Feishu] progress notify failed:', e.message);
          return false;
        }
      }
    });

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

    // 拆分模块
    this.cards = createCardBuilder({
      session: this.session,
      gateway: this.gateway,
      memory: this.memory,
      metrics: this.metrics,
    });
    this.messageAPI = new FeishuMessageAPI(this.client);
    this.media = new FeishuMedia(this.client, { mediaDir: MEDIA_DIR });

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

    try {
      await wsClient.start({ eventDispatcher });
      console.log("[Feishu] WebSocket connected (with card action handler)");
    } catch (error) {
      const startupError = classifyFeishuStartupError(error);
      if (startupError.kind === 'platform_prerequisite') {
        console.warn(`[Feishu] ${startupError.message}`);
        return;
      }
      throw startupError;
    }

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
        const saved = await this.media.saveImage(messageId, imageKey);
        if (saved) {
          mediaFiles.push(saved);
          text = "[用户发送了一张图片]";
        } else {
          await this._reply(messageId, "抱歉先生，图片下载失败，请重新发送。");
          return;
        }
      } else if (msgType === "post") {
        const parsed = this.media.parsePostContent(content);
        text = parsed.text;
        for (const imageKey of parsed.imageKeys) {
          console.log(`[Feishu] Post image: ${imageKey}`);
          const saved = await this.media.saveImage(messageId, imageKey);
          if (saved) mediaFiles.push(saved);
        }
        console.log(`[Feishu] Post parsed - text: ${text.substring(0, 50)}, images: ${mediaFiles.length}`);
      } else if (msgType === "file") {
        const fileKey = content.file_key;
        const fileName = content.file_name || 'unknown';
        console.log(`[Feishu] Received file: ${fileName} (${fileKey})`);
        const saved = await this.media.saveFile(messageId, fileKey, fileName);
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
      const bareCmd = text.match(/^\/(build|task|remind|jobs|session|status|help|log|cos|memory|dev-go|dev-fix|dev-refactor|update)$/);
      if (bareCmd) {
        await this._handleMenuCommand(messageId, chatId, bareCmd[1], senderId || chatId);
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

      const jobCommandMatch = text.match(/^\/job\s+(pause|resume|delete)\s+([A-Za-z0-9_-]+)\s*$/);
      if (jobCommandMatch) {
        await this._handleJobControlCommand(messageId, senderId || chatId, jobCommandMatch[1], jobCommandMatch[2]);
        return;
      }

      // === Onboarding 门控 ===
      if (!this.userProfile.hasProfile(chatId)) {
        this.pendingOnboarding.set(chatId, { messageId, text, mediaFiles });
        await this._replyCard(messageId, this.cards.buildOnboardingCard());
        return;
      }

      // === 通过 Gateway 处理核心管线 ===
      await this._addReaction(messageId, "OnIt");

      // 发占位消息，处理完成后 edit 为正式回复
      const placeholderId = await this._sendPlaceholder(chatId);
      if (placeholderId) this._placeholders.set(chatId, placeholderId);

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
        progressTargetId: `${FEISHU_PROGRESS_PREFIX}${chatId}`,
      });

      // 清理占位映射
      this._placeholders.delete(chatId);

      const responseTime = (Date.now() - startTime) / 1000;

      // 结果回填：短消息 edit 占位，长消息/卡片 recall 占位后 reply
      const formatted = this.formatter.format(result.text);
      const canEdit = placeholderId && formatted.msg_type === 'text' && result.text.length <= 3500;
      if (canEdit) {
        const edited = await this.messageAPI.editMessage(placeholderId, result.text);
        if (!edited) await this._reply(messageId, result.text); // API 失败降级
      } else {
        if (placeholderId) await this.messageAPI.recallMessage(placeholderId).catch(() => {});
        await this._reply(messageId, result.text);
      }

      await this._addReaction(messageId, "DONE");

      // 推送新下载的媒体文件（视频直接在聊天中播放）
      await this.media.pushNewDownloads(chatId, beforeDownloadTime);

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
      // 会话切换通知：连续失败后自动切换，给友好提示
      if (err.sessionSwitched) {
        const shortId = (err.brokenSessionId || '').substring(0, 8);
        await this._reply(messageId,
          `⚠️ 当前会话（${shortId}）连续 ${err.failCount} 次无响应，已自动切换新会话。\n历史记录保留，请重新发送您的请求。`
        );
      } else {
        await this._reply(messageId, `抱歉先生，处理时遇到了问题：${err.message}`);
      }

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

      console.log(`[Feishu] Card action: ${actionType || action?.name || 'form'} from chat ${chatId}`);

      if (actionType === 'open_rename') {
        await this._sendCardToChat(chatId, this.cards.buildRenameCard(chatId));
        return { toast: { type: 'info', content: '请在下方卡片中命名' } };
      }

      if (actionType === 'create_session') {
        const existingSessionId = this.session.get(chatId);
        const firstMessage = this._getFirstMessage(existingSessionId);
        if (existingSessionId) {
          await this.gateway._endSession(existingSessionId);
        }
        this.session.clear(chatId, { firstMessage });
        return this._cardResponse(this.cards.buildSessionCard(chatId, '已重置，发消息自动开始新会话'), '已重置');
      }

      if (actionType === 'end_session') {
        const existingSessionId = this.session.get(chatId);
        const firstMessage = this._getFirstMessage(existingSessionId);
        if (existingSessionId) {
          await this.gateway._endSession(existingSessionId);
        }
        this.session.clear(chatId, { firstMessage });
        return this._cardResponse(this.cards.buildSessionCard(chatId, '已结束当前会话'), '会话已结束');
      }

      if (actionType === 'switch_session') {
        const targetSessionId = actionValue.targetSessionId;
        if (!targetSessionId) return { toast: { type: 'error', content: '无效的会话 ID' } };
        await this.gateway.switchSession(chatId, targetSessionId);
        return this._cardResponse(this.cards.buildSessionCard(chatId, '已切换到历史会话'), '已切换');
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
        return this._cardResponse(this.cards.buildStatusCard(this.handled.size), '状态已刷新');
      }

      // select_static 回调（历史会话切换）
      // WS 模式下 action 结构为 { tag: "select_static", option: "sessionId" }，无 name 属性
      const selectOption = action.option;
      if (action.tag === 'select_static' && selectOption) {
        const targetSessionId = typeof selectOption === 'string' ? selectOption : selectOption.value;
        await this.gateway.switchSession(chatId, targetSessionId);
        return this._cardResponse(this.cards.buildSessionCard(chatId, '已切换到历史会话'), '已切换');
      }

      if (action.action_type === 'form_submit' || action.form_value) {
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
        if (action.form_value?.reminder_owner_id !== undefined) {
          if (!this.jobsService) {
            return { toast: { type: 'error', content: '提醒任务功能暂未启用' } };
          }

          const operatorId = this._resolveCardOperatorId(data, chatId);
          if (!this._isJobsAdmin(operatorId)) {
            return { toast: { type: 'error', content: '只有提醒任务管理员可以创建或代管提醒任务。' } };
          }

          const ownerId = action.form_value.reminder_owner_id.trim();
          const scheduleKind = String(action.form_value.reminder_schedule_kind || '').trim();
          const scheduleExpr = String(action.form_value.reminder_schedule_expr || '').trim();
          const timezone = String(action.form_value.reminder_timezone || process.env.JOBS_DEFAULT_TIMEZONE || 'Asia/Shanghai').trim();
          const reminderText = String(action.form_value.reminder_text || '').trim();

          if (!ownerId || !scheduleKind || !scheduleExpr || !reminderText) {
            return { toast: { type: 'error', content: '请完整填写提醒任务表单' } };
          }

          const job = this.jobsService.createReminderJob({
            creatorId: operatorId,
            ownerId,
            scheduleKind,
            scheduleExpr,
            timezone,
            text: reminderText,
          });

          await this._sendMessage(
            chatId,
            `已创建提醒任务：${job.id}\nowner: ${job.owner_id}\nschedule: ${job.schedule_kind} ${job.schedule_expr}\nnext: ${job.next_run_at || '待计算'}\ntext: ${job.payload?.text || ''}`
          );
          return { toast: { type: 'success', content: `已创建提醒：${job.id}` } };
        }
        if (action.form_value?.session_name !== undefined) {
          const name = action.form_value.session_name.trim();
          this.session.setName(chatId, name);
          const msg = name ? `会话已命名为「${name}」` : '已清除会话名称';
          return this._cardResponse(this.cards.buildSessionCard(chatId, msg), msg);
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
          await this._sendCardToChat(chatId, this.cards._createCard(`记忆搜索：${query}`, 'wathet', [
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
        if (cmd === 'build') card = this.cards.buildBuildCard();
        else if (cmd === 'task') card = this.cards.buildTaskCard();
        else if (cmd === 'remind') {
          const operatorId = this._resolveCardOperatorId(data, chatId);
          if (!this._isJobsAdmin(operatorId)) {
            return { toast: { type: 'error', content: '只有提醒任务管理员可以打开提醒管理入口。' } };
          }
          card = this.cards.buildReminderCard();
        }
        else if (cmd === 'session') card = this.cards.buildSessionCard(chatId);
        else if (cmd === 'status') card = this.cards.buildStatusCard(this.handled.size);
        else if (cmd === 'log') card = this.cards.buildLogCard(this.recentLogs);
        else if (cmd === 'memory') card = this.cards.buildMemoryCard();
        else if (cmd === 'cos') card = await this.cards.buildCosCard();
        else if (cmd === 'dev-go' || cmd === 'dev-fix' || cmd === 'dev-refactor') card = this.cards.buildDevCard(cmd);
        if (card) await this._sendCardToChat(chatId, card);
        return { toast: { type: 'info', content: `已打开 /${cmd}` } };
      }

      console.warn(`[Feishu] Unknown card action: ${actionType}, full action: ${JSON.stringify(action).substring(0, 300)}`);
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

  _getFirstMessage(sessionId) {
    if (!sessionId) return null;
    const conv = this.memory.activeConversations?.get(sessionId);
    if (!conv?.messages?.length) return null;
    const first = conv.messages.find(m => m.role === 'user');
    if (!first?.content) return null;
    const text = first.content.substring(0, 30);
    return text + (first.content.length > 30 ? '…' : '');
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

  async _handleJobControlCommand(messageId, operatorId, action, jobId) {
    if (!this.jobsService) {
      await this._reply(messageId, '提醒任务功能暂未启用。');
      return;
    }

    const job = this.jobsService.getJob(jobId);
    if (!job) {
      await this._reply(messageId, `未找到提醒任务：${jobId}`);
      return;
    }

    if (!this._canManageJob(operatorId, job)) {
      await this._reply(messageId, `你无权限管理提醒任务：${jobId}`);
      return;
    }

    if (action === 'pause') {
      const pausedJob = this.jobsService.pauseJob(jobId);
      await this._reply(messageId, pausedJob ? `已暂停提醒任务：${jobId}` : `未找到提醒任务：${jobId}`);
      return;
    }

    if (action === 'resume') {
      const resumedJob = this.jobsService.resumeJob(jobId);
      await this._reply(messageId, resumedJob ? `已恢复提醒任务：${jobId}` : `未找到提醒任务：${jobId}`);
      return;
    }

    if (action === 'delete') {
      const deleted = this.jobsService.deleteJob(jobId);
      await this._reply(messageId, deleted ? `已删除提醒任务：${jobId}` : `未找到提醒任务：${jobId}`);
      return;
    }

    await this._reply(messageId, '不支持的任务操作。');
  }

  _formatJobsListText(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return '当前没有提醒任务。';
    }

    const lines = jobs.map((job, index) => {
      const text = job?.payload?.text || '';
      return [
        `${index + 1}. \`${job.id}\``,
        `owner=${job.owner_id}`,
        `status=${job.status}`,
        `schedule=${job.schedule_kind} ${job.schedule_expr}`,
        `next=${job.next_run_at || '无'}`,
        text ? `text=${text}` : null,
      ].filter(Boolean).join(' | ');
    });

    return `当前提醒任务：\n${lines.join('\n')}`;
  }

  _resolveCardOperatorId(data, fallbackChatId) {
    return data?.operator?.operator_id?.open_id
      || data?.operator?.operator_id?.user_id
      || data?.operator?.open_id
      || fallbackChatId;
  }

  _getJobsAdminIds() {
    const raw = [
      process.env.JOBS_ADMIN_IDS || '',
      process.env.ADMIN_USER_ID || '',
      process.env.FEISHU_OWNER_ID || '',
    ].filter(Boolean).join(',');

    return new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    );
  }

  _isJobsAdmin(operatorId) {
    if (!operatorId) {
      return false;
    }
    return this._getJobsAdminIds().has(operatorId);
  }

  _canManageJob(operatorId, job) {
    if (!job) {
      return false;
    }
    if (this._isJobsAdmin(operatorId)) {
      return true;
    }
    return Boolean(operatorId) && job.creator_id === operatorId;
  }

  // ==================== 菜单指令 ====================

  async _handleMenuCommand(messageId, chatId, cmd, operatorId = null) {
    if (cmd === 'session') {
      await this._replyCard(messageId, this.cards.buildSessionCard(chatId));
      return;
    }

    if (cmd === 'status') {
      await this._replyCard(messageId, this.cards.buildStatusCard(this.handled.size));
      return;
    }

    if (cmd === 'log') {
      await this._replyCard(messageId, this.cards.buildLogCard(this.recentLogs));
      return;
    }

    if (cmd === 'cos') {
      const card = await this.cards.buildCosCard();
      await this._replyCard(messageId, card);
      return;
    }

    if (cmd === 'memory') {
      await this._replyCard(messageId, this.cards.buildMemoryCard());
      return;
    }

    if (cmd === 'build') {
      await this._replyCard(messageId, this.cards.buildBuildCard());
      return;
    }

    if (cmd === 'task') {
      await this._replyCard(messageId, this.cards.buildTaskCard());
      return;
    }

    if (cmd === 'remind') {
      if (!this._isJobsAdmin(operatorId)) {
        await this._reply(messageId, '只有提醒任务管理员可以打开提醒管理入口。');
        return;
      }
      await this._replyCard(messageId, this.cards.buildReminderCard());
      return;
    }

    if (cmd === 'jobs') {
      const jobs = this.jobsService
        ? this.jobsService.listJobs(this._isJobsAdmin(operatorId)
            ? { limit: 10 }
            : { limit: 10, creatorId: operatorId })
        : [];
      await this._reply(messageId, this._formatJobsListText(jobs));
      return;
    }

    if (cmd === 'dev-go' || cmd === 'dev-fix' || cmd === 'dev-refactor') {
      await this._replyCard(messageId, this.cards.buildDevCard(cmd));
      return;
    }

    if (cmd === 'update') {
      await this._replyCard(messageId, this.cards.buildUpdateCard());
      return;
    }

    if (cmd === 'help') {
      await this._replyCard(messageId, this.cards.buildHelpCard());
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
      await this._sendMessageInternal(chatId, text);
    } catch (err) {
      console.error("[Feishu] Failed to send message:", err.message);
    }
  }

  async sendReminder({ chatId, text }) {
    return this._sendMessageStrict(chatId, text);
  }

  async _sendMessageStrict(chatId, text) {
    return this._sendMessageInternal(chatId, text);
  }

  async _sendMessageInternal(chatId, text) {
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
  }

  async _sendPlaceholder(chatId) {
    try {
      const res = await this.client.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: '⏳ 正在思考...' }),
          msg_type: 'text',
        },
        params: { receive_id_type: 'chat_id' },
      });
      return res?.data?.message_id || null;
    } catch (err) {
      console.warn('[Feishu] Placeholder send failed:', err.message);
      return null;
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
        const buffer = await this.media.downloadFromUrl(imageUrl);
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

  // ==================== 更新操作 ====================

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

  // ==================== 任务执行 ====================

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
        progressTargetId: `${FEISHU_PROGRESS_PREFIX}${chatId}`,
      });
      await this._reply(messageId, result.text);
      await this._addReaction(messageId, 'DONE');
    } catch (err) {
      console.error('[Feishu] Post-onboarding processing failed:', err.message);
      await this._reply(messageId, `抱歉，处理时遇到了问题：${err.message}`);
    }
  }

  // ==================== Skill Vetter（公共 API 代理） ====================

  buildSkillVetterCard(...args) {
    return this.cards.buildSkillVetterCard(...args);
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
        progressTargetId: `${FEISHU_PROGRESS_PREFIX}${chatId}`,
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
