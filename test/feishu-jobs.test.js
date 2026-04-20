'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FeishuAdapter } = require('../src/channels/feishu');

test.afterEach(() => {
  delete process.env.JOBS_ADMIN_IDS;
  delete process.env.ADMIN_USER_ID;
  delete process.env.FEISHU_OWNER_ID;
});

function createAdapter() {
  const adapter = Object.create(FeishuAdapter.prototype);
  adapter.handled = new Map();
  adapter.pendingOnboarding = new Map();
  adapter.userProfile = { hasProfile: () => true, get: () => ({}) };
  adapter.cards = {
    buildReminderCard: () => ({ card: 'reminder' }),
  };
  adapter.jobsService = {
    createReminderJob: () => {
      throw new Error('not stubbed');
    },
    getJob: () => null,
    listJobs: () => [],
    pauseJob: () => null,
    resumeJob: () => null,
    deleteJob: () => false,
  };
  adapter._checkPendingNotifications = async () => {};
  adapter._reply = async () => {};
  adapter._replyCard = async () => {};
  adapter._sendMessage = async () => {};
  adapter._sendCardToChat = async () => {};
  return adapter;
}

function buildTextMessage(text) {
  return {
    message: {
      message_id: 'om_message_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: String(Date.now()),
      content: JSON.stringify({ text }),
    },
    sender: {
      sender_id: {
        open_id: 'ou_operator_1',
      },
    },
  };
}

test('menu command /remind opens the reminder card', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_operator_1';
  const adapter = createAdapter();
  const cards = [];
  adapter._replyCard = async (_messageId, card) => {
    cards.push(card);
  };

  await adapter._handleMenuCommand('om_message_1', 'oc_chat_1', 'remind', 'ou_operator_1');

  assert.deepEqual(cards, [{ card: 'reminder' }]);
});

test('reminder form submit creates a reminder job through JobsService', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_operator_1';
  const adapter = createAdapter();
  const created = [];
  const sent = [];
  adapter.jobsService.createReminderJob = (input) => {
    created.push(input);
    return {
      id: 'job_reminder_1',
      owner_id: input.ownerId,
      schedule_kind: input.scheduleKind,
      schedule_expr: input.scheduleExpr,
      next_run_at: '2026-04-21T01:30:00.000Z',
      payload: { text: input.text },
    };
  };
  adapter._sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
  };

  const result = await adapter._handleCardAction({
    context: { open_chat_id: 'oc_chat_1' },
    operator: { operator_id: { open_id: 'ou_operator_1' } },
    action: {
      form_value: {
        reminder_owner_id: 'owner-parent',
        reminder_schedule_kind: 'daily',
        reminder_schedule_expr: '09:30',
        reminder_timezone: 'Asia/Shanghai',
        reminder_text: '记得吃药',
      },
    },
  });

  assert.deepEqual(created, [{
    creatorId: 'ou_operator_1',
    ownerId: 'owner-parent',
    scheduleKind: 'daily',
    scheduleExpr: '09:30',
    timezone: 'Asia/Shanghai',
    text: '记得吃药',
  }]);
  assert.equal(result?.toast?.type, 'success');
  assert.match(result?.toast?.content || '', /已创建提醒/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat_1');
  assert.match(sent[0].text, /job_reminder_1/);
});

test('open_command remind opens the reminder card for jobs admins', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_operator_1';

  const adapter = createAdapter();
  const sent = [];
  adapter._sendCardToChat = async (chatId, card) => {
    sent.push({ chatId, card });
  };

  const result = await adapter._handleCardAction({
    context: { open_chat_id: 'oc_chat_1' },
    operator: { operator_id: { open_id: 'ou_operator_1' } },
    action: {
      value: {
        action: 'open_command',
        cmd: 'remind',
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat_1');
  assert.deepEqual(sent[0].card, { card: 'reminder' });
  assert.equal(result?.toast?.type, 'info');
});

test('open_command remind is rejected for non-admin operators', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_admin_1';

  const adapter = createAdapter();
  const sent = [];
  adapter._sendCardToChat = async (chatId, card) => {
    sent.push({ chatId, card });
  };

  const result = await adapter._handleCardAction({
    context: { open_chat_id: 'oc_chat_1' },
    operator: { operator_id: { open_id: 'ou_operator_1' } },
    action: {
      value: {
        action: 'open_command',
        cmd: 'remind',
      },
    },
  });

  assert.equal(sent.length, 0);
  assert.equal(result?.toast?.type, 'error');
  assert.match(result?.toast?.content || '', /管理员/);
});

test('reminder form submit is rejected for non-admin operators', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_admin_1';

  const adapter = createAdapter();
  const created = [];
  adapter.jobsService.createReminderJob = (input) => {
    created.push(input);
    return { id: 'job_should_not_exist' };
  };

  const result = await adapter._handleCardAction({
    context: { open_chat_id: 'oc_chat_1' },
    operator: { operator_id: { open_id: 'ou_operator_1' } },
    action: {
      form_value: {
        reminder_owner_id: 'owner-parent',
        reminder_schedule_kind: 'daily',
        reminder_schedule_expr: '09:30',
        reminder_timezone: 'Asia/Shanghai',
        reminder_text: '记得吃药',
      },
    },
  });

  assert.deepEqual(created, []);
  assert.equal(result?.toast?.type, 'error');
  assert.match(result?.toast?.content || '', /管理员/);
});

test('/jobs lists reminder jobs in chat', async () => {
  const adapter = createAdapter();
  const replies = [];
  let listInput = null;
  adapter.jobsService.listJobs = (input) => {
    listInput = input;
    return ([
      {
        id: 'job_a',
        owner_id: 'owner-parent',
        status: 'active',
        schedule_kind: 'daily',
        schedule_expr: '09:30',
        next_run_at: '2026-04-21T01:30:00.000Z',
        payload: { text: '记得吃药' },
      },
    ]);
  };
  adapter._reply = async (_messageId, text) => {
    replies.push(text);
  };

  await adapter._handleMessage(buildTextMessage('/jobs'));

  assert.deepEqual(listInput, { limit: 10, creatorId: 'ou_operator_1' });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /job_a/);
  assert.match(replies[0], /owner-parent/);
  assert.match(replies[0], /记得吃药/);
});

test('/jobs lets admins list recent reminder jobs globally', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_operator_1';

  const adapter = createAdapter();
  const replies = [];
  let listInput = null;
  adapter.jobsService.listJobs = (input) => {
    listInput = input;
    return ([
      {
        id: 'job_a',
        owner_id: 'owner-parent',
        status: 'active',
        schedule_kind: 'daily',
        schedule_expr: '09:30',
        next_run_at: '2026-04-21T01:30:00.000Z',
        payload: { text: '记得吃药' },
      },
    ]);
  };
  adapter._reply = async (_messageId, text) => {
    replies.push(text);
  };

  await adapter._handleMessage(buildTextMessage('/jobs'));

  assert.deepEqual(listInput, { limit: 10 });
  assert.equal(replies.length, 1);
});

test('/job pause <id> is rejected when operator is neither admin nor creator', async () => {
  const adapter = createAdapter();
  const paused = [];
  const replies = [];
  adapter.jobsService.getJob = () => ({
    id: 'job_pause_1',
    creator_id: 'ou_other_1',
  });
  adapter.jobsService.pauseJob = (jobId) => {
    paused.push(jobId);
    return { id: jobId, status: 'paused' };
  };
  adapter._reply = async (_messageId, text) => {
    replies.push(text);
  };

  await adapter._handleMessage(buildTextMessage('/job pause job_pause_1'));

  assert.deepEqual(paused, []);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /无权限/);
});

test('/job pause <id> lets admins manage any reminder job', async () => {
  process.env.JOBS_ADMIN_IDS = 'ou_operator_1';

  const adapter = createAdapter();
  const paused = [];
  const replies = [];
  adapter.jobsService.getJob = () => ({
    id: 'job_pause_1',
    creator_id: 'ou_other_1',
  });
  adapter.jobsService.pauseJob = (jobId) => {
    paused.push(jobId);
    return { id: jobId, status: 'paused' };
  };
  adapter._reply = async (_messageId, text) => {
    replies.push(text);
  };

  await adapter._handleMessage(buildTextMessage('/job pause job_pause_1'));

  assert.deepEqual(paused, ['job_pause_1']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /已暂停/);
});

test('/job pause <id> pauses a reminder job through JobsService for the creator', async () => {
  const adapter = createAdapter();
  const paused = [];
  const replies = [];
  adapter.jobsService.getJob = () => ({
    id: 'job_pause_1',
    creator_id: 'ou_operator_1',
  });
  adapter.jobsService.pauseJob = (jobId) => {
    paused.push(jobId);
    return { id: jobId, status: 'paused' };
  };
  adapter._reply = async (_messageId, text) => {
    replies.push(text);
  };

  await adapter._handleMessage(buildTextMessage('/job pause job_pause_1'));

  assert.deepEqual(paused, ['job_pause_1']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /已暂停/);
  assert.match(replies[0], /job_pause_1/);
});
