/**
 * Jarvis 分层记忆系统 - 数据类型定义
 *
 * 三层记忆模型：
 * 1. 工作记忆 (Working Memory) - Claude SDK Session
 * 2. 短期记忆 (Short-term Memory) - 本地 JSON
 * 3. 长期记忆 (Long-term Memory) - 飞书 Bitable
 */

/**
 * 对话摘要
 * @typedef {Object} ConversationSummary
 * @property {string} conversationId - 唯一标识
 * @property {string} chatId - 飞书 chat_id
 * @property {string} sessionId - Claude SDK session_id
 * @property {string} startTime - ISO 8601 开始时间
 * @property {string} endTime - ISO 8601 结束时间
 * @property {number} messageCount - 消息数量
 * @property {Object} summary - 摘要内容
 * @property {string} summary.userIntent - 用户意图
 * @property {string[]} summary.keyDecisions - 关键决策
 * @property {string} summary.outcome - 结果
 * @property {string[]} summary.entities - 提及实体
 * @property {Object} context - 上下文信息
 * @property {string} context.workingDirectory - 工作目录
 * @property {string} context.gitBranch - Git 分支
 * @property {string[]} context.filesModified - 修改的文件
 * @property {string[]} context.toolsUsed - 使用的工具
 * @property {number} importance - 重要性评分 1-10
 * @property {string[]} tags - 标签
 * @property {boolean} compressed - 是否已压缩
 * @property {string|null} compressedAt - 压缩时间
 */

/**
 * 用户偏好
 * @typedef {Object} UserPreference
 * @property {string} preferenceId - 唯一标识
 * @property {'内容偏好'|'工作流偏好'|'通信风格'|'技术栈'} category - 类别
 * @property {string} key - 偏好键
 * @property {string|Object} value - 偏好值
 * @property {number} confidence - 置信度 0-1
 * @property {string} firstLearnedAt - 首次学习时间
 * @property {string} lastUpdatedAt - 最后更新时间
 * @property {string[]} sourceConversations - 来源对话
 */

/**
 * 知识实体
 * @typedef {Object} KnowledgeEntity
 * @property {string} entityId - 唯一标识
 * @property {string} entityName - 实体名称
 * @property {'项目'|'服务'|'工具'|'概念'|'人物'} entityType - 实体类型
 * @property {string} description - 描述
 * @property {string[]} tags - 标签
 * @property {number} importance - 重要性 1-10
 * @property {string} firstMentionedAt - 首次提及时间
 * @property {string} lastMentionedAt - 最后提及时间
 * @property {number} mentionCount - 提及次数
 * @property {string[]} relatedEntities - 关联实体 ID
 * @property {Object} structuredInfo - 结构化信息
 */

/**
 * 重要决策
 * @typedef {Object} ImportantDecision
 * @property {string} decisionId - 唯一标识
 * @property {string} title - 标题
 * @property {string} content - 详细内容
 * @property {string} decisionTime - 决策时间
 * @property {string} conversationId - 关联对话
 * @property {'技术选型'|'架构设计'|'流程规范'|'业务策略'} decisionType - 决策类型
 * @property {string[]} impactScope - 影响范围
 * @property {'执行中'|'已完成'|'已废弃'} status - 状态
 * @property {string} followUpActions - 后续行动
 * @property {string[]} relatedEntities - 关联实体
 */

/**
 * 上下文注入
 * @typedef {Object} ContextInjection
 * @property {ConversationSummary[]} recentConversations - 最近对话
 * @property {KnowledgeEntity[]} relatedEntities - 相关实体
 * @property {UserPreference[]} relevantPreferences - 相关偏好
 * @property {string} systemMessage - 格式化的系统消息
 */

/**
 * 生成 UUID v4
 * @returns {string}
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = {
  generateUUID,
};
