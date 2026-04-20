'use strict';

class JobsService {
  constructor({ store, parseReminderSchedule, computeNextRunAt, resolveOwnerTarget, assertDeliveryTarget = null }) {
    if (!store) {
      throw new Error('store is required');
    }
    if (typeof parseReminderSchedule !== 'function') {
      throw new Error('parseReminderSchedule must be a function');
    }
    if (typeof computeNextRunAt !== 'function') {
      throw new Error('computeNextRunAt must be a function');
    }
    if (typeof resolveOwnerTarget !== 'function') {
      throw new Error('resolveOwnerTarget must be a function');
    }

    this.store = store;
    this.parseReminderSchedule = parseReminderSchedule;
    this.computeNextRunAt = computeNextRunAt;
    this.resolveOwnerTarget = resolveOwnerTarget;
    this.assertDeliveryTarget = assertDeliveryTarget;
  }

  createReminderJob({ creatorId, ownerId, scheduleKind, scheduleExpr, timezone, text }) {
    const resolvedTarget = this._resolveOwnerTarget(ownerId);
    this._assertDeliveryTarget(resolvedTarget);
    const parsedSchedule = this.parseReminderSchedule(scheduleKind, scheduleExpr, timezone);
    const nextRunAt = this.computeNextRunAt(parsedSchedule, new Date().toISOString());
    this._assertNextRunAt(nextRunAt, 'create');
    const policy = {};

    if (resolvedTarget.chatType) {
      policy.chatType = resolvedTarget.chatType;
    }

    return this.store.createJob({
      type: 'reminder',
      creatorId,
      ownerId,
      deliveryChannel: resolvedTarget.channel,
      deliveryTarget: resolvedTarget.target,
      timezone,
      scheduleKind,
      scheduleExpr,
      nextRunAt,
      status: 'active',
      payload: { text },
      policy,
    });
  }

  getJob(id) {
    return this.store.getJob(id);
  }

  listJobs({ status, ownerId, creatorId, limit } = {}) {
    return this.store.listJobs({ status, ownerId, creatorId, limit });
  }

  pauseJob(id) {
    return this.store.updateJobStatus({
      jobId: id,
      status: 'paused',
    });
  }

  resumeJob(id, nowIso = new Date().toISOString()) {
    const job = this.store.getJob(id);
    if (!job) {
      return null;
    }

    const parsedSchedule = this.parseReminderSchedule(job.schedule_kind, job.schedule_expr, job.timezone);
    const nextRunAt = this.computeNextRunAt(parsedSchedule, nowIso);
    this._assertNextRunAt(nextRunAt, 'resume');

    return this.store.updateJobStatus({
      jobId: id,
      status: 'active',
      nextRunAt,
      updatedAt: nowIso,
    });
  }

  deleteJob(id) {
    return this.store.deleteJob(id);
  }

  _resolveOwnerTarget(ownerId) {
    const resolvedTarget = this.resolveOwnerTarget(ownerId);
    if (!resolvedTarget) {
      throw new Error(`Owner target not found for owner: ${ownerId}`);
    }

    const channel = resolvedTarget.channel || resolvedTarget.delivery_channel;
    const target = resolvedTarget.target || resolvedTarget.delivery_target;
    if (!channel || !target) {
      throw new Error(`Invalid owner target for owner: ${ownerId}`);
    }

    return {
      channel,
      target,
      chatType: resolvedTarget.chatType || resolvedTarget.chat_type || null,
    };
  }

  _assertDeliveryTarget(resolvedTarget) {
    if (typeof this.assertDeliveryTarget !== 'function') {
      return;
    }

    this.assertDeliveryTarget(resolvedTarget);
  }

  _assertNextRunAt(nextRunAt, operation) {
    if (nextRunAt != null) {
      return;
    }

    if (operation === 'resume') {
      throw new Error('Reminder time has already passed and cannot be resumed.');
    }

    throw new Error('Reminder time has already passed.');
  }
}

module.exports = { JobsService };
