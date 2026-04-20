'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JobsStore } = require('../src/jobs/store');
const { JobsService } = require('../src/jobs/service');
const { OwnerTargets } = require('../src/jobs/targets');
const { JobsNotifier } = require('../src/jobs/notifier');
const { ReminderScheduler } = require('../src/jobs/scheduler');
const { computeNextRunAt: computeReminderNextRunAt } = require('../src/jobs/schedule');
const { FeishuAdapter } = require('../src/channels/feishu');
const { WeComAdapter } = require('../src/channels/wecom');

describe('JobsService', () => {
  let tempRoot;
  let store;
  let ownerTargets;
  let service;
  let parseScheduleCalls;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-jobs-service-'));
    store = new JobsStore({ dbPath: path.join(tempRoot, 'data', 'jobs.db') });
    const targetsPath = path.join(tempRoot, 'private', 'owner-targets.json');
    fs.mkdirSync(path.dirname(targetsPath), { recursive: true });
    fs.writeFileSync(
      targetsPath,
      JSON.stringify({
        'owner-1': { channel: 'feishu', target: 'chat-owner-1' },
      }),
      'utf8'
    );
    ownerTargets = new OwnerTargets({ filePath: targetsPath });
    parseScheduleCalls = [];

    service = new JobsService({
      store,
      parseReminderSchedule: (...args) => {
        parseScheduleCalls.push(args);
        return {
          kind: args[0],
          expr: args[1],
          timezone: 'Asia/Shanghai',
          time: '09:30',
        };
      },
      computeNextRunAt: (parsed, nowIso) => {
        if (parsed.kind === 'daily' && nowIso === '2026-04-20T02:00:00.000Z') {
          return '2026-04-21T01:30:00.000Z';
        }

        if (parsed.kind === 'daily') {
          return '2026-04-20T01:30:00.000Z';
        }

        if (parsed.kind === 'once') {
          return '2099-01-01T01:30:00.000Z';
        }

        return '2026-04-21T01:30:00.000Z';
      },
      resolveOwnerTarget: (ownerId) => ownerTargets.get(ownerId),
    });
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a reminder job with the resolved owner target and computed next run', () => {
    const job = service.createReminderJob({
      creatorId: 'creator-1',
      ownerId: 'owner-1',
      scheduleKind: 'daily',
      scheduleExpr: '09:30',
      timezone: 'Asia/Shanghai',
      text: 'Stand up',
    });

    assert.equal(job.type, 'reminder');
    assert.equal(job.creator_id, 'creator-1');
    assert.equal(job.owner_id, 'owner-1');
    assert.equal(job.delivery_channel, 'feishu');
    assert.equal(job.delivery_target, 'chat-owner-1');
    assert.equal(job.status, 'active');
    assert.equal(job.schedule_kind, 'daily');
    assert.equal(job.schedule_expr, '09:30');
    assert.equal(job.timezone, 'Asia/Shanghai');
    assert.equal(job.next_run_at, '2026-04-20T01:30:00.000Z');
    assert.deepEqual(job.payload, { text: 'Stand up' });
    assert.deepEqual(store.getJob(job.id), job);
    assert.deepEqual(parseScheduleCalls, [['daily', '09:30', 'Asia/Shanghai']]);
  });

  it('pauses and resumes a reminder job', () => {
    const job = service.createReminderJob({
      creatorId: 'creator-2',
      ownerId: 'owner-1',
      scheduleKind: 'daily',
      scheduleExpr: '09:30',
      timezone: 'Asia/Shanghai',
      text: 'Daily sync',
    });

    const paused = service.pauseJob(job.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.next_run_at, '2026-04-20T01:30:00.000Z');

    const resumed = service.resumeJob(job.id, '2026-04-20T02:00:00.000Z');
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.next_run_at, '2026-04-21T01:30:00.000Z');
  });

  it('deletes a reminder job', () => {
    const job = service.createReminderJob({
      creatorId: 'creator-3',
      ownerId: 'owner-1',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-20 09:30',
      timezone: 'Asia/Shanghai',
      text: 'One-time reminder',
    });

    assert.equal(service.deleteJob(job.id), true);
    assert.equal(service.getJob(job.id), null);
    assert.equal(store.getJob(job.id), null);
  });
});

describe('ReminderScheduler', () => {
  let tempRoot;
  let store;
  let notifier;
  let scheduler;
  let sent;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-jobs-scheduler-'));
    store = new JobsStore({ dbPath: path.join(tempRoot, 'data', 'jobs.db') });
    notifier = new JobsNotifier();
    sent = [];

    notifier.register('feishu', async (message) => {
      sent.push(message);
      return { ok: true };
    });

    scheduler = new ReminderScheduler({
      store,
      notifier,
      computeNextRunAt: () => null,
    });
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('sends a due reminder to the owner default endpoint and records the run and notification', async () => {
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-1',
      ownerId: 'owner-1',
      deliveryChannel: 'feishu',
      deliveryTarget: 'owner-default-endpoint',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-20 09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'active',
      payload: { text: 'Take a break' },
      policy: {},
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    await scheduler.tick('2026-04-20T01:30:00.000Z');
    await scheduler.tick('2026-04-20T01:30:00.000Z');

    const runRow = store.getRun(sent[0].meta.runId);
    const jobRow = store.getJob(job.id);
    const notifications = store.listNotificationsByJobId(job.id);
    assert.deepEqual(sent, [
      {
        channel: 'feishu',
        target: 'owner-default-endpoint',
        text: 'Take a break',
        meta: {
          jobId: job.id,
          runId: runRow.id,
        },
      },
    ]);

    assert.equal(runRow.status, 'succeeded');
    assert.equal(runRow.trigger_type, 'schedule');
    assert.equal(runRow.started_at, '2026-04-20T01:30:00.000Z');
    assert.equal(runRow.finished_at, '2026-04-20T01:30:00.000Z');
    assert.equal(jobRow.last_run_at, '2026-04-20T01:30:00.000Z');
    assert.equal(jobRow.next_run_at, null);
    assert.equal(store.listDueJobs('2026-04-20T01:30:00.000Z').length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, 'sent');
    assert.equal(notifications[0].channel, 'feishu');
    assert.equal(notifications[0].target, 'owner-default-endpoint');
    assert.equal(notifications[0].message, 'Take a break');
    assert.equal(notifications[0].attempted_at, '2026-04-20T01:30:00.000Z');
  });

  it('does not double-send when a nested tick overlaps the same due job', async () => {
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-overlap',
      ownerId: 'owner-overlap',
      deliveryChannel: 'feishu',
      deliveryTarget: 'owner-default-endpoint',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-20 09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'active',
      payload: { text: 'Overlap check' },
      policy: {},
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    let reentered = false;
    notifier.register('feishu', async (message) => {
      sent.push(message);
      if (!reentered) {
        reentered = true;
        await scheduler.tick('2026-04-20T01:30:00.000Z');
      }
      return { ok: true };
    });

    await scheduler.tick('2026-04-20T01:30:00.000Z');

    const jobRow = store.getJob(job.id);
    const notifications = store.listNotificationsByJobId(job.id);

    assert.equal(sent.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(jobRow.last_run_at, '2026-04-20T01:30:00.000Z');
    assert.equal(jobRow.next_run_at, null);
  });

  it('keeps a due job due when run creation fails inside the claim transaction', async () => {
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-atomic',
      ownerId: 'owner-atomic',
      deliveryChannel: 'feishu',
      deliveryTarget: 'owner-default-endpoint',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-20 09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'active',
      payload: { text: 'Atomic check' },
      policy: {},
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    store.createRun = () => {
      throw new Error('run insert failed');
    };

    await assert.rejects(
      scheduler.tick('2026-04-20T01:30:00.000Z'),
      /run insert failed/
    );

    const jobRow = store.getJob(job.id);
    assert.equal(jobRow.last_run_at, null);
    assert.equal(jobRow.next_run_at, '2026-04-20T01:30:00.000Z');
    assert.equal(store.listDueJobs('2026-04-20T01:30:00.000Z').length, 1);
    assert.equal(sent.length, 0);
  });

  it('advances a recurring reminder to the next run after a tick', async () => {
    const recurringScheduler = new ReminderScheduler({
      store,
      notifier,
      computeNextRunAt: computeReminderNextRunAt,
    });

    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-2',
      ownerId: 'owner-2',
      deliveryChannel: 'feishu',
      deliveryTarget: 'owner-default-endpoint',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'daily',
      scheduleExpr: '09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'active',
      payload: { text: 'Daily check-in' },
      policy: {},
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    await recurringScheduler.tick('2026-04-20T01:30:00.000Z');

    const jobRow = store.getJob(job.id);

    assert.equal(sent.length, 1);
    assert.equal(jobRow.last_run_at, '2026-04-20T01:30:00.000Z');
    assert.equal(jobRow.next_run_at, '2026-04-21T01:30:00.000Z');
    assert.deepEqual(
      store.listDueJobs('2026-04-20T01:30:00.000Z').map((dueJob) => dueJob.id),
      []
    );
  });

  it('keeps delivery successful when notification accounting fails and passes chatType through meta', async () => {
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-3',
      ownerId: 'owner-3',
      deliveryChannel: 'wecom',
      deliveryTarget: 'chat-wecom',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-20 09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'active',
      payload: { text: 'Group reminder' },
      policy: { chatType: 'group' },
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    notifier.register('wecom', async (message) => {
      sent.push(message);
      return { ok: true };
    });

    store.createNotification = () => {
      throw new Error('notification insert failed');
    };

    await scheduler.tick('2026-04-20T01:30:00.000Z');

    const runRow = store.getRun(sent[0].meta.runId);
    const jobRow = store.getJob(job.id);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'wecom');
    assert.equal(sent[0].meta.chatType, 'group');
    assert.equal(runRow.status, 'succeeded');
    assert.deepEqual(runRow.output, {
      delivered: true,
      notificationRecorded: false,
      notificationError: 'notification insert failed',
    });
    assert.equal(runRow.error_text, null);
    assert.equal(jobRow.last_run_at, '2026-04-20T01:30:00.000Z');
    assert.equal(jobRow.next_run_at, null);
    assert.equal(store.listNotificationsByJobId(job.id).length, 0);
  });
});

describe('Reminder send helpers', () => {
  it('surfaces Feishu reminder delivery failures', async () => {
    const adapter = Object.create(FeishuAdapter.prototype);
    adapter.formatter = {
      format: (text) => ({ content: JSON.stringify({ text }), msg_type: 'text' }),
    };
    adapter._splitMessage = (text) => [text];
    adapter._resolvePendingImages = async (formatted) => formatted;
    adapter.client = {
      im: {
        message: {
          create: async () => {
            throw new Error('feishu boom');
          },
        },
      },
    };

    await assert.rejects(
      adapter.sendReminder({ chatId: 'chat-feishu', text: 'hello' }),
      /feishu boom/
    );
  });

  it('surfaces WeCom reminder delivery failures when websocket send is unavailable', async () => {
    const adapter = Object.create(WeComAdapter.prototype);
    adapter.ws = null;

    await assert.rejects(
      adapter.sendReminder({ chatId: 'chat-wecom', text: 'hello' }),
      /WebSocket is not open/
    );

    adapter.ws = {
      readyState: 1,
      send: (_payload, callback) => {
        callback(new Error('wecom boom'));
      },
    };

    await assert.rejects(
      adapter.sendReminder({ chatId: 'chat-wecom', text: 'hello' }),
      /wecom boom/
    );
  });
});
