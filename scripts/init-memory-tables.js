#!/usr/bin/env node
/**
 * 初始化长期记忆 Bitable 表结构
 *
 * 创建三张表：
 * 1. 对话摘要表 (conversation_summaries)
 * 2. 实体知识表 (knowledge_entities)
 * 3. 用户偏好表 (user_preferences)
 *
 * 使用方法：
 *   node scripts/init-memory-tables.js [app_token]
 *
 * 如果不提供 app_token，会创建新的 Bitable 应用
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const lark = require('@larksuiteoapi/node-sdk');

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const OWNER_OPEN_ID = process.env.FEISHU_OWNER_ID || '';

/**
 * 授权访问
 */
async function grantAccess(appToken) {
  return await client.request({
    method: 'POST',
    url: '/open-apis/drive/v1/permissions/' + appToken + '/members',
    params: { type: 'bitable', need_notification: true },
    data: {
      member_type: 'openid',
      member_id: OWNER_OPEN_ID,
      perm: 'full_access',
    },
  });
}

/**
 * 创建或使用现有 Bitable 应用
 */
async function getOrCreateApp(appToken) {
  if (appToken) {
    console.log(`Using existing Bitable app: ${appToken}`);
    return appToken;
  }

  console.log('Creating new Bitable app...');
  const res = await client.bitable.app.create({
    data: { name: 'Jarvis 长期记忆' },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to create app: ${res.msg}`);
  }

  const newAppToken = res.data.app.app_token;
  console.log(`Created Bitable app: ${newAppToken}`);
  console.log(`URL: ${res.data.app.url}`);

  // 授权
  await grantAccess(newAppToken);
  console.log('Access granted to owner');

  return newAppToken;
}

/**
 * 创建表
 */
async function createTable(appToken, name, fields) {
  console.log(`Creating table: ${name}...`);

  const res = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: {
      table: {
        name,
        fields,
      },
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to create table ${name}: ${res.msg}`);
  }

  console.log(`Created table: ${name} (${res.data.table_id})`);
  return res.data.table_id;
}

/**
 * 对话摘要表字段定义
 */
const conversationSummaryFields = [
  { field_name: '会话ID', type: 1 },           // 文本
  { field_name: '对话类型', type: 3, property: {
    options: [
      { name: '飞书群聊' },
      { name: '飞书私聊' },
      { name: '自动任务' },
    ],
  }},
  { field_name: '聊天ID', type: 1 },           // 文本
  { field_name: '开始时间', type: 5 },          // 日期
  { field_name: '结束时间', type: 5 },          // 日期
  { field_name: '消息数量', type: 2 },          // 数字
  { field_name: '摘要', type: 1 },             // 文本
  { field_name: '关键决策', type: 1 },          // 文本 (JSON)
  { field_name: '相关项目', type: 1 },          // 文本
  { field_name: '情感倾向', type: 3, property: {
    options: [
      { name: '正面' },
      { name: '中性' },
      { name: '负面' },
    ],
  }},
  { field_name: '话题标签', type: 4, property: {
    options: [
      { name: '技术' },
      { name: '产品' },
      { name: '运维' },
      { name: '日常' },
      { name: '系统设计' },
      { name: '代码修改' },
      { name: '自动任务' },
      { name: '错误' },
    ],
  }},
  { field_name: '重要性', type: 2 },            // 数字 (1-10)
];

/**
 * 实体知识表字段定义
 */
const knowledgeEntityFields = [
  { field_name: '实体名称', type: 1 },          // 文本
  { field_name: '实体类型', type: 3, property: {
    options: [
      { name: '项目' },
      { name: '服务' },
      { name: '工具' },
      { name: '概念' },
      { name: '人物' },
      { name: '平台' },
    ],
  }},
  { field_name: '别名', type: 1 },             // 文本 (JSON)
  { field_name: '描述', type: 1 },             // 文本
  { field_name: '首次提及', type: 5 },          // 日期
  { field_name: '最后更新', type: 5 },          // 日期
  { field_name: '提及次数', type: 2 },          // 数字
  { field_name: '关联实体', type: 1 },          // 文本 (逗号分隔)
  { field_name: '关系类型', type: 1 },          // 文本 (JSON)
  { field_name: '状态', type: 3, property: {
    options: [
      { name: '活跃' },
      { name: '归档' },
      { name: '过时' },
    ],
  }},
  { field_name: '元数据', type: 1 },            // 文本 (JSON)
];

/**
 * 用户偏好表字段定义
 */
const userPreferenceFields = [
  { field_name: '偏好类型', type: 3, property: {
    options: [
      { name: '平台偏好' },
      { name: '内容偏好' },
      { name: '工作流偏好' },
      { name: '通信风格' },
      { name: '技术栈' },
      { name: '其他' },
    ],
  }},
  { field_name: '偏好键', type: 1 },           // 文本
  { field_name: '偏好值', type: 1 },           // 文本 (JSON)
  { field_name: '数据来源', type: 3, property: {
    options: [
      { name: '用户反馈' },
      { name: '行为推断' },
      { name: '系统统计' },
    ],
  }},
  { field_name: '置信度', type: 2 },           // 数字 (0-100)
  { field_name: '采样数量', type: 2 },          // 数字
  { field_name: '记录时间', type: 5 },          // 日期
  { field_name: '有效期至', type: 5 },          // 日期
  { field_name: '备注', type: 1 },             // 文本
];

/**
 * 主函数
 */
async function main() {
  const appToken = process.argv[2] || null;

  try {
    // 1. 获取或创建应用
    const finalAppToken = await getOrCreateApp(appToken);

    // 2. 创建三张表
    const conversationTableId = await createTable(
      finalAppToken,
      '对话摘要',
      conversationSummaryFields
    );

    const entityTableId = await createTable(
      finalAppToken,
      '实体知识',
      knowledgeEntityFields
    );

    const preferenceTableId = await createTable(
      finalAppToken,
      '用户偏好',
      userPreferenceFields
    );

    // 3. 输出配置
    console.log('\n========== 配置信息 ==========');
    console.log('请将以下配置添加到 .env 文件：\n');
    console.log(`MEMORY_APP_TOKEN=${finalAppToken}`);
    console.log(`CONVERSATION_TABLE_ID=${conversationTableId}`);
    console.log(`ENTITY_TABLE_ID=${entityTableId}`);
    console.log(`PREFERENCE_TABLE_ID=${preferenceTableId}`);
    console.log('\n==============================');

    console.log('\n✅ 长期记忆表初始化完成！');

  } catch (err) {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  }
}

main();
