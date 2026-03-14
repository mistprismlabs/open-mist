/**
 * 每日知识摘要导出器
 *
 * 运行时间: 每天 23:55
 * 输出路径: docs/digests/daily/YYYY-MM-DD.md
 *
 * 用法:
 *   node scripts/export-daily-digest.js                  # 导出今日摘要
 *   node scripts/export-daily-digest.js --date 2026-02-10  # 导出指定日期
 */

const fs = require('fs');
const path = require('path');

class DailyDigestExporter {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data', 'memory');
    this.outputDir = path.join(__dirname, '..', 'docs', 'digests', 'daily');
  }

  /**
   * 加载短期记忆数据
   */
  loadShortTermMemory() {
    const filePath = path.join(this.dataDir, 'short-term.json');
    if (!fs.existsSync(filePath)) {
      console.log('[DailyDigest] 短期记忆文件不存在');
      return { conversations: [], indices: {} };
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /**
   * 获取指定日期的对话
   */
  getConversationsForDate(memory, targetDate) {
    const dateIndex = memory.index?.byDate || memory.indices?.byDate || {};
    const conversationIds = dateIndex[targetDate] || [];

    return conversationIds
      .map(id => memory.conversations.find(c => c.conversationId === id))
      .filter(Boolean);
  }

  /**
   * 聚合统计数据
   */
  aggregateStats(conversations) {
    const toolsUsed = new Set();
    let totalMessages = 0;
    const filesModified = new Set();
    let totalImportance = 0;

    for (const conv of conversations) {
      totalMessages += conv.messageCount || 0;
      totalImportance += conv.importance || 5;
      (conv.context?.toolsUsed || []).forEach(t => toolsUsed.add(t));
      (conv.context?.filesModified || []).forEach(f => filesModified.add(f));
    }

    return {
      conversationCount: conversations.length,
      totalMessages,
      toolsUsed: [...toolsUsed],
      filesModified: [...filesModified],
      avgImportance: conversations.length > 0
        ? (totalImportance / conversations.length).toFixed(1)
        : '0.0',
    };
  }

  /**
   * 提取实体索引
   */
  extractEntities(conversations) {
    const entityMap = new Map();

    conversations.forEach((conv, idx) => {
      const entities = conv.summary?.entities || [];
      entities.forEach(e => {
        if (!entityMap.has(e)) {
          entityMap.set(e, { count: 0, conversations: [] });
        }
        const entry = entityMap.get(e);
        entry.count++;
        entry.conversations.push(idx + 1);
      });
    });

    return entityMap;
  }

  /**
   * 生成 Markdown 内容
   */
  generateMarkdown(date, conversations, stats, entities) {
    const now = new Date().toISOString().split('T')[1].split('.')[0];

    let md = `# Jarvis 知识摘要 - ${date}\n\n`;
    md += `> 自动生成于 ${now}\n\n`;

    // 统计表
    md += `## 📊 今日统计\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| 对话数量 | ${stats.conversationCount} |\n`;
    md += `| 消息总数 | ${stats.totalMessages} |\n`;
    md += `| 使用工具 | ${stats.toolsUsed.join(', ') || '无'} |\n`;
    md += `| 修改文件 | ${stats.filesModified.length} 个 |\n`;
    md += `| 平均重要性 | ${stats.avgImportance} / 10 |\n\n`;

    // 主要话题
    md += `## 🎯 主要话题\n\n`;

    const sortedConvs = [...conversations].sort((a, b) =>
      (b.importance || 5) - (a.importance || 5)
    );

    sortedConvs.forEach((conv, idx) => {
      const intent = conv.summary?.userIntent || '未知意图';
      const importance = conv.importance || 5;

      md += `### ${idx + 1}. ${intent} (重要性: ${importance}/10)\n`;

      const startTime = conv.startTime?.split('T')[1]?.split('.')[0];
      if (startTime) {
        md += `- **开始时间**: ${startTime}\n`;
      }

      if (conv.summary?.keyDecisions?.length > 0) {
        md += `- **关键决策**: ${conv.summary.keyDecisions.join('; ')}\n`;
      }

      if (conv.summary?.outcome) {
        md += `- **执行结果**: ${conv.summary.outcome}\n`;
      }

      if (conv.context?.filesModified?.length > 0) {
        const files = conv.context.filesModified.slice(0, 5);
        md += `- **涉及文件**: ${files.join(', ')}`;
        if (conv.context.filesModified.length > 5) {
          md += ` (+${conv.context.filesModified.length - 5} more)`;
        }
        md += '\n';
      }

      if (conv.tags?.length > 0) {
        md += `- **标签**: ${conv.tags.join(', ')}\n`;
      }

      md += '\n';
    });

    // 实体索引
    if (entities.size > 0) {
      md += `## 🏷️ 实体索引\n\n`;
      md += `| 实体 | 出现次数 | 相关对话 |\n|------|----------|----------|\n`;

      // 按出现次数排序
      const sortedEntities = [...entities.entries()]
        .sort((a, b) => b[1].count - a[1].count);

      sortedEntities.forEach(([entity, info]) => {
        md += `| ${entity} | ${info.count} | #${info.conversations.join(', #')} |\n`;
      });
      md += '\n';
    }

    md += `---\n*生成自 Jarvis 记忆系统 v1.1*\n`;

    return md;
  }

  /**
   * 确保目录存在
   */
  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 导出指定日期的摘要
   */
  async export(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    console.log(`[DailyDigest] 开始导出 ${targetDate} 的摘要...`);

    // 1. 加载短期记忆
    const memory = this.loadShortTermMemory();

    // 2. 获取当日对话
    const conversations = this.getConversationsForDate(memory, targetDate);

    if (conversations.length === 0) {
      console.log(`[DailyDigest] ${targetDate} 无对话记录，跳过`);
      return null;
    }

    console.log(`[DailyDigest] 找到 ${conversations.length} 个对话`);

    // 3. 聚合统计
    const stats = this.aggregateStats(conversations);

    // 4. 提取实体
    const entities = this.extractEntities(conversations);

    // 5. 生成 Markdown
    const markdown = this.generateMarkdown(targetDate, conversations, stats, entities);

    // 6. 写入文件
    this.ensureDir(this.outputDir);
    const outputPath = path.join(this.outputDir, `${targetDate}.md`);
    fs.writeFileSync(outputPath, markdown);

    console.log(`[DailyDigest] ✓ 导出完成: ${outputPath}`);
    return outputPath;
  }
}

// 命令行参数解析
function parseArgs() {
  const args = process.argv.slice(2);
  let date = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      date = args[i + 1];
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error('[DailyDigest] 错误: 日期格式应为 YYYY-MM-DD');
        process.exit(1);
      }
    }
  }

  return { date };
}

// 主入口
if (require.main === module) {
  const { date } = parseArgs();
  const exporter = new DailyDigestExporter();

  exporter.export(date)
    .then(result => {
      if (result) {
        console.log('[DailyDigest] 任务完成');
      } else {
        console.log('[DailyDigest] 无数据需要导出');
      }
    })
    .catch(err => {
      console.error('[DailyDigest] 错误:', err);
      process.exit(1);
    });
}

module.exports = { DailyDigestExporter };
