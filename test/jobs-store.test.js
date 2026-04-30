'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JobsStore } = require('../src/jobs/store');

describe('JobsStore', () => {
  let tempRoot;
  let dbPath;
  let store;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmist-jobs-'));
    dbPath = path.join(tempRoot, 'data', 'jobs.db');
    store = new JobsStore({ dbPath });
  });

  afterEach(() => {
    if (store) store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates reminder jobs with creator, owner, and delivery fields', () => {
    const createdAt = '2026-04-20T09:00:00.000Z';
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'user_creator',
      ownerId: 'user_owner',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat_123',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'cron',
      scheduleExpr: '0 9 * * *',
      nextRunAt: '2026-04-20T10:00:00.000Z',
      status: 'active',
      payload: { text: 'Stand up' },
      policy: { retries: 2 },
      createdAt,
      updatedAt: createdAt,
    });

    assert.ok(job.id);
    assert.equal(job.type, 'reminder');
    assert.equal(job.creator_id, 'user_creator');
    assert.equal(job.owner_id, 'user_owner');
    assert.equal(job.delivery_channel, 'feishu');
    assert.equal(job.delivery_target, 'chat_123');
    assert.equal(job.timezone, 'Asia/Shanghai');
    assert.equal(job.schedule_kind, 'cron');
    assert.equal(job.schedule_expr, '0 9 * * *');
    assert.equal(job.next_run_at, '2026-04-20T10:00:00.000Z');
    assert.equal(job.status, 'active');
    assert.deepEqual(job.payload, { text: 'Stand up' });
    assert.deepEqual(job.policy, { retries: 2 });
    assert.equal(job.created_at, createdAt);
    assert.equal(job.updated_at, createdAt);

    const loaded = store.getJob(job.id);
    assert.deepEqual(loaded, job);
  });

  it('lists due active jobs ordered by next_run_at', () => {
    const later = store.createJob({
      type: 'reminder',
      creatorId: 'creator-a',
      ownerId: 'owner-a',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat-a',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: 'later',
      nextRunAt: '2026-04-20T09:45:00.000Z',
      status: 'active',
      payload: { label: 'later' },
      policy: {},
    });
    const earliest = store.createJob({
      type: 'reminder',
      creatorId: 'creator-b',
      ownerId: 'owner-b',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat-b',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: 'earlier',
      nextRunAt: '2026-04-20T09:15:00.000Z',
      status: 'active',
      payload: { label: 'earlier' },
      policy: {},
    });
    store.createJob({
      type: 'reminder',
      creatorId: 'creator-c',
      ownerId: 'owner-c',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat-c',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: 'inactive',
      nextRunAt: '2026-04-20T08:00:00.000Z',
      status: 'paused',
      payload: { label: 'paused' },
      policy: {},
    });

    const dueJobs = store.listDueJobs('2026-04-20T10:00:00.000Z');
    assert.deepEqual(
      dueJobs.map((job) => job.id),
      [earliest.id, later.id]
    );
    assert.deepEqual(
      dueJobs.map((job) => job.next_run_at),
      ['2026-04-20T09:15:00.000Z', '2026-04-20T09:45:00.000Z']
    );
  });

  it('lists recent jobs with optional status and owner filters', () => {
    store.createJob({
      id: 'job-old',
      type: 'reminder',
      creatorId: 'creator-a',
      ownerId: 'owner-a',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat-a',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'daily',
      scheduleExpr: '09:30',
      nextRunAt: '2026-04-20T01:30:00.000Z',
      status: 'paused',
      payload: { text: 'older' },
      policy: {},
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    store.createJob({
      id: 'job-new',
      type: 'reminder',
      creatorId: 'creator-b',
      ownerId: 'owner-a',
      deliveryChannel: 'weixin',
      deliveryTarget: 'wx-user',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: '2026-04-21 08:00',
      nextRunAt: '2026-04-21T00:00:00.000Z',
      status: 'active',
      payload: { text: 'newer' },
      policy: {},
      createdAt: '2026-04-20T01:00:00.000Z',
      updatedAt: '2026-04-20T01:00:00.000Z',
    });
    store.createJob({
      id: 'job-other-owner',
      type: 'reminder',
      creatorId: 'creator-c',
      ownerId: 'owner-b',
      deliveryChannel: 'wecom',
      deliveryTarget: 'wecom-user',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'weekday',
      scheduleExpr: '18:00',
      nextRunAt: '2026-04-20T10:00:00.000Z',
      status: 'active',
      payload: { text: 'other owner' },
      policy: {},
      createdAt: '2026-04-20T02:00:00.000Z',
      updatedAt: '2026-04-20T02:00:00.000Z',
    });

    assert.deepEqual(
      store.listJobs({ limit: 2 }).map((job) => job.id),
      ['job-other-owner', 'job-new']
    );
    assert.deepEqual(
      store.listJobs({ ownerId: 'owner-a' }).map((job) => job.id),
      ['job-new', 'job-old']
    );
    assert.deepEqual(
      store.listJobs({ status: 'active', ownerId: 'owner-a' }).map((job) => job.id),
      ['job-new']
    );
  });

  it('records runs and notification attempts', () => {
    const job = store.createJob({
      type: 'reminder',
      creatorId: 'creator-run',
      ownerId: 'owner-run',
      deliveryChannel: 'feishu',
      deliveryTarget: 'chat-run',
      timezone: 'Asia/Shanghai',
      scheduleKind: 'once',
      scheduleExpr: 'run',
      nextRunAt: '2026-04-20T08:00:00.000Z',
      status: 'active',
      payload: { label: 'run' },
      policy: {},
    });

    const run = store.createRun({
      jobId: job.id,
      triggerType: 'schedule',
      startedAt: '2026-04-20T08:00:01.000Z',
      status: 'running',
    });

    store.finishRun({
      runId: run.id,
      status: 'succeeded',
      finishedAt: '2026-04-20T08:00:02.000Z',
      output: { delivered: true },
    });

    const notification = store.createNotification({
      jobId: job.id,
      runId: run.id,
      channel: 'feishu',
      target: 'chat-run',
      status: 'sent',
      message: 'Reminder delivered',
      attemptedAt: '2026-04-20T08:00:02.500Z',
    });

    const runRow = store.getRun(run.id);
    const notificationRow = store.getNotification(notification.id);

    assert.equal(runRow.job_id, job.id);
    assert.equal(runRow.trigger_type, 'schedule');
    assert.equal(runRow.started_at, '2026-04-20T08:00:01.000Z');
    assert.equal(runRow.status, 'succeeded');
    assert.equal(runRow.finished_at, '2026-04-20T08:00:02.000Z');
    assert.deepEqual(runRow.output, { delivered: true });
    assert.equal(runRow.error_text, null);

    assert.equal(notificationRow.job_id, job.id);
    assert.equal(notificationRow.run_id, run.id);
    assert.equal(notificationRow.channel, 'feishu');
    assert.equal(notificationRow.target, 'chat-run');
    assert.equal(notificationRow.status, 'sent');
    assert.equal(notificationRow.message, 'Reminder delivered');
    assert.equal(notificationRow.attempted_at, '2026-04-20T08:00:02.500Z');
    assert.equal(notificationRow.error_text, null);
  });
});
