require('dotenv').config();
const { Gateway } = require('./gateway');
const { FeishuAdapter } = require('./channels/feishu');
const { ClaudeClient } = require('./claude');
const { SessionStore } = require('./session');
const { BitableLogger } = require('./bitable');
const { TaskExecutor } = require('./task-executor');
const { Deployer } = require('./deployer');
const { WeixinAdapter } = require('./channels/weixin');
const { resolveChannelBootstrapPlan } = require('./channel-bootstrap');

const activeAdapters = [];

function retainAdapter(adapter) {
  activeAdapters.push(adapter);
  return adapter;
}

async function main() {
  const BOT_NAME = process.env.BOT_NAME || 'OpenMist';
  console.log(`[${BOT_NAME}] Starting gateway...`);
  const channelPlan = resolveChannelBootstrapPlan(process.env);

  const gateway = new Gateway({
    session: new SessionStore(),
    claude: new ClaudeClient(),
  });

  const feishu = retainAdapter(new FeishuAdapter({
    gateway,
    bitable: new BitableLogger(),
    taskExecutor: new TaskExecutor(),
    deployer: new Deployer(),
  }));

  if (channelPlan.feishu.enabled) {
    await feishu.start();
  } else {
    console.log(`[${BOT_NAME}] Feishu channel skipped (missing credentials)`);
  }

  // Web channel（需求许愿池）
  const { WebAdapter } = require("./channels/web");
  const web = retainAdapter(new WebAdapter());
  await web.start();

  if (channelPlan.wecom.enabled) {
    const { WeComAdapter } = require('./channels/wecom');
    const wecom = retainAdapter(new WeComAdapter({ gateway }));
    await wecom.start();
  } else {
    console.log(`[${BOT_NAME}] WeCom channel skipped (missing credentials)`);
  }

  if (String(process.env.WEIXIN_ENABLED).toLowerCase() === 'true') {
    const weixin = retainAdapter(new WeixinAdapter({ gateway }));
    await weixin.start();
  }

  console.log(`[${BOT_NAME}] Gateway running ✓`);
}

main().catch(err => {
  const BOT_NAME = process.env.BOT_NAME || 'OpenMist';
  console.error(`[${BOT_NAME}] Fatal error:`, err);
  process.exit(1);
});
