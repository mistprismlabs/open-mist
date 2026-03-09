const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const TASKS_DIR = process.env.TASKS_DIR || path.join(PROJECT_DIR, 'data/tasks');
const MAX_BUDGET_USD = parseFloat(process.env.TASK_MAX_BUDGET_USD || '2.0');
const MAX_TURNS = 50;

// Lazy-load ESM SDK (same pattern as claude.js)
let _query = null;
async function loadSDK() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

class TaskExecutor {
  constructor() {
    this.runningTasks = new Map();
  }

  /**
   * 执行构建任务
   * @param {string} instruction - 用户指令（如 "做一个倒计时到春节的网页"）
   * @param {function} onProgress - 进度回调 (message: string) => void
   * @returns {{ taskId, outputDir, type, result }}
   */
  async execute(instruction, onProgress = () => {}) {
    const taskId = crypto.randomBytes(4).toString('hex');
    const taskDir = path.join(TASKS_DIR, taskId);

    fs.mkdirSync(taskDir, { recursive: true });
    console.log(`[TaskExecutor] Task ${taskId} started: ${instruction.substring(0, 80)}`);

    this.runningTasks.set(taskId, { instruction, startTime: Date.now() });

    try {
      const query = await loadSDK();

      const options = {
        model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        cwd: taskDir,
        persistSession: false,
        agents: [
          {
            name: 'builder',
            model: 'sonnet',
            description: '代码编写助手。负责创建文件、编写代码、调试和测试。',
          },
        ],
      };

      const prompt = `你是一个项目构建助手。用户要求你创建一个项目。

## 任务
${instruction}

## 规则
1. 在当前目录下创建项目文件
2. 使用 builder 子智能体来编写代码
3. 完成后，在当前目录根部创建一个 task-meta.json 文件，包含：
   - type: "static"（纯 HTML/CSS/JS）或 "node"（需要 Node.js 运行）
   - entry: 入口文件路径（static 类型填 "index.html"，node 类型填主文件如 "server.js"）
   - title: 项目简短标题
   - description: 一句话描述
4. 对于静态网页项目，直接创建 index.html（含内联 CSS/JS 即可）
5. 对于 Node.js 项目，创建 package.json 和入口文件，监听 PORT 环境变量
6. 确保项目可以独立运行，不依赖外部构建工具`;

      let resultText = '';
      let totalCost = 0;

      for await (const message of query({ prompt, options })) {
        if (message.type === 'assistant' && message.message?.content) {
          // 提取文本内容作为进度
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              const preview = block.text.substring(0, 100);
              onProgress(preview);
            }
          }
        }
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            resultText = message.result;
            totalCost = message.cost_usd || 0;
          } else {
            throw new Error(message.result || 'Task execution failed');
          }
        }
      }

      // 读取 task-meta.json
      const metaPath = path.join(taskDir, 'task-meta.json');
      let meta = { type: 'static', entry: 'index.html', title: 'Task', description: '' };
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch (e) {
          console.warn(`[TaskExecutor] Failed to parse task-meta.json: ${e.message}`);
        }
      }

      const elapsed = ((Date.now() - this.runningTasks.get(taskId).startTime) / 1000).toFixed(1);
      console.log(`[TaskExecutor] Task ${taskId} completed in ${elapsed}s, cost: $${totalCost.toFixed(4)}`);

      return {
        taskId,
        outputDir: taskDir,
        type: meta.type || 'static',
        entry: meta.entry || 'index.html',
        title: meta.title || 'Task',
        description: meta.description || '',
        result: resultText,
        cost: totalCost,
      };
    } finally {
      this.runningTasks.delete(taskId);
    }
  }
}

module.exports = { TaskExecutor };
