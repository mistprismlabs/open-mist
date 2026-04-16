'use strict';

const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

const START_TIME = Date.now();

/**
 * 飞书卡片构建器工厂
 * 纯 JSON 构建，无副作用（除 _buildCosCard 需要网络请求）
 */
function createCardBuilder({ session, gateway, memory, metrics }) {

  function _createCard(title, template, elements) {
    return {
      schema: '2.0',
      config: { width_mode: 'fill' },
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    };
  }

  function _getSessionLabel(chatId, sessionId) {
    const info = session.sessions[chatId];
    if (info?.name) return info.name;
    // 从活跃对话取首条用户消息
    const active = memory.activeConversations?.get(sessionId);
    if (active?.messages?.length > 0) {
      const first = active.messages.find(m => m.role === 'user');
      if (first?.content) {
        const text = first.content.substring(0, 20);
        return text + (first.content.length > 20 ? '…' : '');
      }
    }
    return `会话 ${sessionId.substring(0, 6)}`;
  }

  function _getContextPercent(sessionId) {
    const sizeBytes = gateway._getSessionSize(sessionId);
    const maxBytes = 10 * 1024 * 1024; // 10MB
    return Math.min(Math.round(sizeBytes / maxBytes * 100), 100);
  }

  function _formatAge(updatedAt) {
    if (!updatedAt) return '刚刚';
    const age = Math.round((Date.now() - updatedAt) / 60000);
    if (age < 1) return '刚刚';
    if (age < 60) return `${age} 分钟前`;
    if (age < 1440) return `${Math.floor(age / 60)} 小时前`;
    return `${Math.floor(age / 1440)} 天前`;
  }

  function _formatHistoryDate(ts) {
    return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function _historyLabel(h) {
    return h.name || h.firstMessage || h.sessionId.substring(0, 8) + '...';
  }

  function buildSessionCard(chatId, notice) {
    const sessionId = session.get(chatId);
    const sessionInfo = session.sessions[chatId];
    const history = session.getHistory(chatId);
    const elements = [];

    if (notice) {
      elements.push({ tag: 'markdown', content: `✅ ${notice}` });
      elements.push({ tag: 'hr' });
    }

    // === 当前会话 ===
    if (sessionId) {
      const label = _getSessionLabel(chatId, sessionId);
      const pct = _getContextPercent(sessionId);
      const filled = Math.round(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      const ageText = _formatAge(sessionInfo?.updatedAt);

      elements.push({ tag: 'markdown', content: `**当前会话**\n🟢 ${label}` });
      elements.push({ tag: 'markdown', content: `上下文 ${bar} ${pct}%　·　${ageText}` });

      // 按钮行：命名 + 新建 + 结束
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          {
            tag: 'column', width: 'auto',
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: '✏️ 命名' }, type: 'default', value: { action: 'open_rename' } }],
          },
          {
            tag: 'column', width: 'auto',
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'primary', value: { action: 'create_session' } }],
          },
          {
            tag: 'column', width: 'auto',
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: '结束' }, type: 'danger', value: { action: 'end_session' } }],
          },
        ],
      });
    } else {
      elements.push({ tag: 'markdown', content: '**无活跃会话**\n下次发消息时自动创建。' });
      elements.push({ tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'primary', value: { action: 'create_session' } });
    }

    // === 历史会话 ===
    if (history.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `**历史会话**（${history.length} 个）` });

      // 最近一条直接展示
      const latest = history[0];
      const latestLabel = _historyLabel(latest);
      const latestDate = _formatHistoryDate(latest.endedAt);
      elements.push({ tag: 'markdown', content: `📌 ${latestLabel}　·　${latestDate}` });
      elements.push({ tag: 'button', text: { tag: 'plain_text', content: '切换到此会话' }, type: 'default', value: { action: 'switch_session', targetSessionId: latest.sessionId } });

      // 更多历史 → 下拉
      if (history.length > 1) {
        elements.push({
          tag: 'select_static',
          name: 'switch_session_select',
          placeholder: { tag: 'plain_text', content: '选择更多历史会话...' },
          options: history.slice(1, 10).map(h => {
            const label = _historyLabel(h);
            const endDate = _formatHistoryDate(h.endedAt);
            return { text: { tag: 'plain_text', content: `${label} · ${endDate}` }, value: h.sessionId };
          }),
        });
      }
    }

    return _createCard('会话管理', 'blue', elements);
  }

  function buildRenameCard(chatId) {
    const sessionInfo = session.sessions[chatId];
    return _createCard('命名会话', 'blue', [
      {
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
            text: { tag: 'plain_text', content: '确认' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_rename',
          },
        ],
      },
    ]);
  }

  function buildStatusCard(handledCount) {
    const uptimeMs = Date.now() - START_TIME;
    const uptimeH = Math.floor(uptimeMs / 3600000);
    const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
    const mem = process.memoryUsage();
    const memMB = Math.round(mem.rss / 1024 / 1024);
    const activeSessions = Object.keys(session.sessions).length;

    const statusText = [
      `**运行时间** ${uptimeH}小时${uptimeM}分钟`,
      `**内存占用** ${memMB}MB`,
      `**活跃会话** ${activeSessions}个`,
      `**已处理消息** ${handledCount}条`,
    ].join('\n');

    return _createCard('系统状态', 'green', [
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

  function buildLogCard(recentLogs) {
    if (recentLogs.length === 0) {
      return _createCard('消息日志', 'orange', [
        { tag: 'markdown', content: '暂无处理记录（重启后清空）' },
      ]);
    }

    const lines = recentLogs.slice().reverse().map(log => {
      const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false });
      const text = log.text.length > 20 ? log.text.substring(0, 20) + '...' : log.text;
      const icon = log.status === '成功' ? '✅' : '❌';
      return `${icon} \`${time}\` ${text} (${log.responseTime}s)`;
    }).join('\n');

    return _createCard('消息日志', 'orange', [
      { tag: 'markdown', content: `最近 ${recentLogs.length} 条记录：\n\n${lines}` },
    ]);
  }

  async function buildCosCard() {
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
        return `- \`${prefix}/\` ${info.count}个文件, ${_formatSize(info.size)}`;
      }).join('\n');

      const statusText = [
        `**文件总数** ${files.length}`,
        `**总大小** ${_formatSize(totalSize)}`,
        '',
        groupLines,
      ].join('\n');

      return _createCard('COS 存储概览', 'purple', [
        { tag: 'markdown', content: statusText },
      ]);
    } catch (err) {
      return _createCard('COS 存储概览', 'red', [
        { tag: 'markdown', content: `查询失败: ${err.message}` },
      ]);
    }
  }

  function buildMemoryCard() {
    const stats = memory.getStats();
    const m = metrics.summarize(7);

    const statLines = [
      `短期记忆 ${stats.shortTerm.totalConversations} 条 · 实体 ${stats.shortTerm.entityCount} 个 · 进行中 ${stats.activeConversations} 个`,
    ];
    if (m.total > 0) {
      statLines.push(`7天 ${m.total} 次对话 · 命中率 ${(m.hitRate * 100).toFixed(0)}% · 检索 ${m.avgRetrievalMs}ms`);
    }

    return _createCard('记忆系统', 'wathet', [
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

  function buildBuildCard() {
    return _createCard('项目构建', 'purple', [
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

  function buildTaskCard() {
    return _createCard('执行任务', 'turquoise', [
      { tag: 'markdown', content: '让助手在服务器上执行任务，完成后发送通知。\n\n**能做什么**\n- 服务器运维：检查状态、分析日志、清理文件、查看进程\n- 数据操作：抓取网页、更新多维表格、生成报告\n- 项目构建：生成网页/应用并自动部署\n- 脚本执行：运行任意 shell 或 Node.js 脚本' },
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

  function buildUpdateCard() {
    const availablePath = path.join(__dirname, '..', '..', 'data', 'updates', 'available.json');
    if (!fs.existsSync(availablePath)) {
      return _createCard('系统更新', 'green', [
        { tag: 'markdown', content: '当前系统已是最新版本，没有可用更新。' },
      ]);
    }

    try {
      const data = JSON.parse(fs.readFileSync(availablePath, 'utf-8'));
      const updates = data.updates || [];
      if (updates.length === 0) {
        return _createCard('系统更新', 'green', [
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

      return _createCard('系统更新', 'orange', [
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
      return _createCard('系统更新', 'red', [
        { tag: 'markdown', content: `读取更新信息失败：${err.message}` },
      ]);
    }
  }

  function buildDevCard(skillName) {
    const configs = {
      'dev-go': { title: '快速开发', color: 'green', placeholder: '例：给 heartbeat 加一个检查 swap 使用率的原生检查', desc: '从需求到部署一步完成：编码 → 测试 → 提交 → 部署' },
      'dev-fix': { title: 'Bug 修复', color: 'red', placeholder: '例：feishu-bot 发消息偶尔超时，日志有 ETIMEOUT', desc: '定位问题并修复：查日志 → 找根因 → 最小修复 → 验证' },
      'dev-refactor': { title: '代码重构', color: 'orange', placeholder: '例：把 feishu.js 的卡片构建方法提取到独立文件', desc: '安全地改善代码结构：分析 → 安全网 → 小步重构 → 验证' },
    };
    const cfg = configs[skillName] || configs['dev-go'];
    return _createCard(cfg.title, cfg.color, [
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

  function buildOnboardingCard() {
    return _createCard('欢迎使用', 'indigo', [
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
            default_value: process.env.BOT_NAME || 'OpenMist',
            width: 'fill',
          },
          {
            tag: 'input',
            name: 'user_name',
            placeholder: { tag: 'plain_text', content: '你希望被怎么称呼' },
            default_value: '',
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

  function buildHelpCard() {
    const botName = process.env.BOT_NAME || 'OpenMist';
    const taskDomain = process.env.TASK_DOMAIN || 'your-domain.com';
    return _createCard(`${botName} 指令中心`, 'indigo', [
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

  function buildSkillVetterCard(pluginName, report, verdict, pendingTask) {
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

    return _createCard(`Skill 审查：${pluginName}`, colorMap[verdict] || 'orange', elements);
  }

  function _formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  return {
    _createCard,
    buildSessionCard,
    buildRenameCard,
    buildStatusCard,
    buildLogCard,
    buildCosCard,
    buildMemoryCard,
    buildBuildCard,
    buildTaskCard,
    buildUpdateCard,
    buildDevCard,
    buildOnboardingCard,
    buildHelpCard,
    buildSkillVetterCard,
    _formatSize,
  };
}

module.exports = { createCardBuilder };
