'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JobsService } = require('../src/jobs/service');

function createService(overrides = {}) {
  return new JobsService({
    store: overrides.store || {
      createJob: (input) => input,
      getJob: () => null,
      listJobs: () => [],
      updateJobStatus: () => null,
      deleteJob: () => false,
    },
    parseReminderSchedule: overrides.parseReminderSchedule || ((kind, expr, timezone) => ({ kind, expr, timezone })),
    computeNextRunAt: overrides.computeNextRunAt || (() => '2026-04-21T01:30:00.000Z'),
    resolveOwnerTarget: overrides.resolveOwnerTarget || (() => ({ channel: 'feishu', target: 'oc_target_1' })),
    assertDeliveryTarget: overrides.assertDeliveryTarget,
  });
}

test('createReminderJob rejects reminder delivery when target channel is unavailable', () => {
  const service = createService({
    resolveOwnerTarget: () => ({
      channel: 'wecom',
      target: 'external_user_dad',
      chatType: 'p2p',
    }),
    assertDeliveryTarget: ({ channel }) => {
      if (channel === 'wecom') {
        throw new Error('WeCom reminders require bot channel credentials');
      }
    },
  });

  assert.throws(
    () => service.createReminderJob({
      creatorId: 'ou_admin_1',
      ownerId: 'parent-dad',
      scheduleKind: 'daily',
      scheduleExpr: '09:30',
      timezone: 'Asia/Shanghai',
      text: '记得吃药',
    }),
    /WeCom reminders require bot channel credentials/
  );
});

test('listJobs forwards creatorId filters to the store', () => {
  const calls = [];
  const service = createService({
    store: {
      createJob: (input) => input,
      getJob: () => null,
      listJobs: (input) => {
        calls.push(input);
        return [];
      },
      updateJobStatus: () => null,
      deleteJob: () => false,
    },
  });

  service.listJobs({ status: 'active', ownerId: 'owner-parent', creatorId: 'ou_admin_1', limit: 5 });

  assert.deepEqual(calls, [{
    status: 'active',
    ownerId: 'owner-parent',
    creatorId: 'ou_admin_1',
    limit: 5,
  }]);
});
