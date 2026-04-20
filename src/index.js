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
const { JobsStore } = require('./jobs/store');
const { OwnerTargets } = require('./jobs/targets');
const { JobsNotifier } = require('./jobs/notifier');
const { JobsService } = require('./jobs/service');
const { ReminderScheduler } = require('./jobs/scheduler');
const { parseReminderSchedule, computeNextRunAt } = require('./jobs/schedule');

const activeAdapters = [];
const activeResources = [];

function retainAdapter(adapter) {
  activeAdapters.push(adapter);
  return adapter;
}

function retainResource(resource) {
  activeResources.push(resource);
  return resource;
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

  const jobsStore = new JobsStore({
    dbPath: process.env.JOBS_DB_PATH || 'data/jobs.db',
  });
  const ownerTargets = new OwnerTargets({
    filePath: process.env.JOB_TARGETS_PATH || 'data/job-targets.json',
  });
  const jobsNotifier = new JobsNotifier();
  const jobsService = new JobsService({
    store: jobsStore,
    parseReminderSchedule,
    computeNextRunAt,
    resolveOwnerTarget: (ownerId) => ownerTargets.get(ownerId),
  });
  const reminderScheduler = new ReminderScheduler({
    store: jobsStore,
    notifier: jobsNotifier,
    computeNextRunAt,
  });
  retainResource({
    jobsStore,
    ownerTargets,
    jobsNotifier,
    jobsService,
    reminderScheduler,
  });

  jobsNotifier.register('feishu', async ({ target, text }) => {
    return feishu.sendReminder({ chatId: target, text });
  });

  if (channelPlan.feishu.enabled) {
    await feishu.start();
  } else {
    console.log(`[${BOT_NAME}] Feishu channel skipped (missing credentials)`);
  }

  // Web channel（需求许愿池）
  const { WebAdapter } = require("./channels/web");
  const web = retainAdapter(new WebAdapter());
  await web.start();

  let wecom = null;
  if (channelPlan.wecom.enabled) {
    const { WeComAdapter } = require('./channels/wecom');
    wecom = retainAdapter(new WeComAdapter({ gateway }));
    jobsNotifier.register('wecom', async ({ target, text, meta = {} }) => {
      return wecom.sendReminder({
        chatId: target,
        chatType: meta.chatType || 'p2p',
        text,
      });
    });
    await wecom.start();
  } else {
    console.log(`[${BOT_NAME}] WeCom channel skipped (missing credentials)`);
  }

  let weixin = null;
  if (String(process.env.WEIXIN_ENABLED).toLowerCase() === 'true') {
    weixin = retainAdapter(new WeixinAdapter({ gateway }));
    jobsNotifier.register('weixin', async ({ target, text }) => {
      return weixin.sendReminder({ userId: target, text });
    });
    await weixin.start();
  }

  reminderScheduler.start(Number(process.env.JOBS_TICK_INTERVAL_MS || '60000'));

  console.log(`[${BOT_NAME}] Gateway running ✓`);
}

main().catch(err => {
  const BOT_NAME = process.env.BOT_NAME || 'OpenMist';
  console.error(`[${BOT_NAME}] Fatal error:`, err);
  process.exit(1);
});
