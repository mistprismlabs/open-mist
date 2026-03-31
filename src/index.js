require('dotenv').config();
const { Gateway } = require('./gateway');
const { FeishuAdapter } = require('./channels/feishu');
const { ClaudeClient } = require('./claude');
const { SessionStore } = require('./session');
const { BitableLogger } = require('./bitable');
const { TaskExecutor } = require('./task-executor');
const { Deployer } = require('./deployer');

async function main() {
  const BOT_NAME = process.env.BOT_NAME || 'OpenMist';
  console.log(`[${BOT_NAME}] Starting gateway...`);

  const gateway = new Gateway({
    session: new SessionStore(),
    claude: new ClaudeClient(),
  });

  const feishu = new FeishuAdapter({
    gateway,
    bitable: new BitableLogger(),
    taskExecutor: new TaskExecutor(),
    deployer: new Deployer(),
  });

  await feishu.start();

  // Web channel（需求许愿池）
  const { WebAdapter } = require("./channels/web");
  const web = new WebAdapter();
  await web.start();

  // 企业微信（可选，仅当配置了 WECOM_CORP_ID 时启动）
  if (process.env.WECOM_CORP_ID) {
    const { WeComAdapter } = require('./channels/wecom');
    const wecom = new WeComAdapter({ gateway });
    await wecom.start();
  }

  console.log(`[${BOT_NAME}] Gateway running ✓`);
}

main().catch(err => {
  const BOT_NAME = process.env.BOT_NAME || 'OpenMist';
  console.error(`[${BOT_NAME}] Fatal error:`, err);
  process.exit(1);
});
