'use strict';

const { computeNextRunAt: computeReminderNextRunAt, parseReminderSchedule } = require('./schedule');

class ReminderScheduler {
  constructor({ store, notifier, computeNextRunAt }) {
    if (!store) {
      throw new Error('store is required');
    }
    if (!notifier) {
      throw new Error('notifier is required');
    }

    this.store = store;
    this.notifier = notifier;
    this.computeNextRunAt = computeNextRunAt;
    this._timer = null;
  }

  start(intervalMs = 60_000) {
    if (this._timer) {
      return this._timer;
    }

    this._timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[Jobs] ReminderScheduler tick failed:', error);
      });
    }, intervalMs);

    return this._timer;
  }

  stop() {
    if (!this._timer) {
      return;
    }

    clearInterval(this._timer);
    this._timer = null;
  }

  async tick(nowIso = new Date().toISOString()) {
    const dueJobs = this.store.listDueJobs(nowIso);

    for (const job of dueJobs) {
      const nextRunAt = this._computeNextRunAt(job, nowIso);
      const claimed = this.store.claimDueJobAndCreateRun({
        jobId: job.id,
        nowIso,
        nextRunAt,
        triggerType: 'schedule',
        startedAt: nowIso,
        runStatus: 'running',
      });

      if (!claimed) {
        continue;
      }

      const { job: claimedJob, run } = claimed;

      const text = this._buildReminderText(claimedJob);
      const target = claimedJob.delivery_target;
      const meta = this._buildNotificationMeta(claimedJob, run.id);
      let deliverySucceeded = false;
      let deliveryErrorText = null;
      let notificationErrorText = null;

      try {
        await this.notifier.send({
          channel: job.delivery_channel,
          target,
          text,
          meta,
        });
        deliverySucceeded = true;
      } catch (error) {
        deliveryErrorText = error?.message || String(error);
      }

      if (deliverySucceeded) {
        try {
          this.store.createNotification({
            jobId: job.id,
            runId: run.id,
            channel: job.delivery_channel,
            target,
            status: 'sent',
            message: text,
            attemptedAt: nowIso,
          });
        } catch (error) {
          notificationErrorText = error?.message || String(error);
        }
      }

      const status = deliverySucceeded ? 'succeeded' : 'failed';
      const output = deliverySucceeded
        ? (notificationErrorText
            ? { delivered: true, notificationRecorded: false, notificationError: notificationErrorText }
            : { delivered: true, notificationRecorded: true })
        : { delivered: false, error: deliveryErrorText };

      this.store.finishRun({
        runId: run.id,
        status,
        finishedAt: nowIso,
        output,
        errorText: deliverySucceeded ? null : deliveryErrorText,
      });
    }
  }

  _computeNextRunAt(job, nowIso) {
    if (job.schedule_kind === 'once') {
      return null;
    }

    if (typeof this.computeNextRunAt === 'function') {
      const parsed = parseReminderSchedule(job.schedule_kind, job.schedule_expr, job.timezone);
      const tickAfterNow = new Date(new Date(nowIso).getTime() + 1).toISOString();
      return this.computeNextRunAt(parsed, tickAfterNow);
    }

    return computeReminderNextRunAt(
      parseReminderSchedule(job.schedule_kind, job.schedule_expr, job.timezone),
      new Date(new Date(nowIso).getTime() + 1).toISOString()
    );
  }

  _buildReminderText(job) {
    const payload = job?.payload || {};
    if (payload.text != null && payload.text !== '') return String(payload.text);
    if (payload.message != null && payload.message !== '') return String(payload.message);
    return '';
  }

  _buildNotificationMeta(job, runId) {
    const meta = {
      jobId: job.id,
      runId,
    };

    if (job?.policy && typeof job.policy === 'object' && job.policy.chatType) {
      meta.chatType = job.policy.chatType;
    }

    return meta;
  }
}

module.exports = { ReminderScheduler };
