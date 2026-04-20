'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeParseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value, fallback = '{}') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function hydrateJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    creator_id: row.creator_id,
    owner_id: row.owner_id,
    delivery_channel: row.delivery_channel,
    delivery_target: row.delivery_target,
    timezone: row.timezone,
    schedule_kind: row.schedule_kind,
    schedule_expr: row.schedule_expr,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    status: row.status,
    payload: safeParseJson(row.payload_json, {}),
    policy: safeParseJson(row.policy_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    trigger_type: row.trigger_type,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    output: safeParseJson(row.output_json, null),
    error_text: row.error_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    run_id: row.run_id,
    channel: row.channel,
    target: row.target,
    status: row.status,
    message: row.message,
    attempted_at: row.attempted_at,
    error_text: row.error_text,
    created_at: row.created_at,
  };
}

const NEXT_RUN_AT_UNSET = Symbol('next_run_at_unset');

class JobsStore {
  constructor({ dbPath }) {
    if (!dbPath) {
      throw new Error('dbPath is required');
    }

    this.dbPath = dbPath;
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        delivery_channel TEXT NOT NULL,
        delivery_target TEXT NOT NULL,
        timezone TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        output_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS job_notifications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        run_id TEXT,
        channel TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        error_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES job_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_next_run_at
        ON jobs(status, next_run_at);
    `);
  }

  createJob(input) {
    const now = input.createdAt || input.created_at || new Date().toISOString();
    const job = {
      id: input.id || crypto.randomUUID(),
      type: input.type,
      creator_id: input.creatorId || input.creator_id,
      owner_id: input.ownerId || input.owner_id,
      delivery_channel: input.deliveryChannel || input.delivery_channel,
      delivery_target: input.deliveryTarget || input.delivery_target,
      timezone: input.timezone,
      schedule_kind: input.scheduleKind || input.schedule_kind,
      schedule_expr: input.scheduleExpr || input.schedule_expr,
      next_run_at: input.nextRunAt || input.next_run_at || null,
      last_run_at: input.lastRunAt || input.last_run_at || null,
      status: input.status || 'active',
      payload_json: toJson(input.payload ?? input.payload_json ?? {}),
      policy_json: toJson(input.policy ?? input.policy_json ?? {}),
      created_at: now,
      updated_at: input.updatedAt || input.updated_at || now,
    };

    this.db.prepare(`
      INSERT INTO jobs (
        id, type, creator_id, owner_id, delivery_channel, delivery_target,
        timezone, schedule_kind, schedule_expr, next_run_at, last_run_at,
        status, payload_json, policy_json, created_at, updated_at
      ) VALUES (
        @id, @type, @creator_id, @owner_id, @delivery_channel, @delivery_target,
        @timezone, @schedule_kind, @schedule_expr, @next_run_at, @last_run_at,
        @status, @payload_json, @policy_json, @created_at, @updated_at
      )
    `).run(job);

    return hydrateJob(job);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return hydrateJob(row);
  }

  updateJobStatus({ jobId, status, nextRunAt = NEXT_RUN_AT_UNSET, updatedAt = new Date().toISOString() }) {
    const current = this.getJob(jobId);
    if (!current) {
      return null;
    }

    const resolvedNextRunAt = nextRunAt === NEXT_RUN_AT_UNSET ? current.next_run_at : nextRunAt;

    this.db.prepare(`
      UPDATE jobs
      SET status = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, resolvedNextRunAt, updatedAt, jobId);

    return this.getJob(jobId);
  }

  deleteJob(id) {
    const result = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id);
    return hydrateRun(row);
  }

  getNotification(id) {
    const row = this.db.prepare('SELECT * FROM job_notifications WHERE id = ?').get(id);
    return hydrateNotification(row);
  }

  listDueJobs(nowIso) {
    const rows = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE status = 'active'
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
      ORDER BY next_run_at ASC, created_at ASC, id ASC
    `).all(nowIso);

    return rows.map(hydrateJob);
  }

  listJobs({ status = null, ownerId = null, limit = 20 } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (ownerId) {
      conditions.push('owner_id = ?');
      params.push(ownerId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const cappedLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const rows = this.db.prepare(`
      SELECT *
      FROM jobs
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, cappedLimit);

    return rows.map(hydrateJob);
  }

  createRun({ jobId, triggerType, startedAt, status }) {
    const now = startedAt || new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      job_id: jobId,
      trigger_type: triggerType,
      started_at: startedAt || now,
      finished_at: null,
      status,
      output_json: null,
      error_text: null,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO job_runs (
        id, job_id, trigger_type, started_at, finished_at, status,
        output_json, error_text, created_at, updated_at
      ) VALUES (
        @id, @job_id, @trigger_type, @started_at, @finished_at, @status,
        @output_json, @error_text, @created_at, @updated_at
      )
    `).run(row);

    return hydrateRun(row);
  }

  finishRun({ runId, status, finishedAt, output, errorText = null }) {
    const updatedAt = finishedAt || new Date().toISOString();
    const outputJson = output === undefined ? null : toJson(output, null);

    this.db.prepare(`
      UPDATE job_runs
      SET status = ?, finished_at = ?, output_json = ?, error_text = ?, updated_at = ?
      WHERE id = ?
    `).run(status, finishedAt, outputJson, errorText, updatedAt, runId);

    const row = this.db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId);
    return hydrateRun(row);
  }

  createNotification({
    jobId,
    runId,
    channel,
    target,
    status,
    message,
    attemptedAt,
    errorText = null,
  }) {
    const attempted = attemptedAt || new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      job_id: jobId,
      run_id: runId || null,
      channel,
      target,
      status,
      message,
      attempted_at: attempted,
      error_text: errorText,
      created_at: attempted,
    };

    this.db.prepare(`
      INSERT INTO job_notifications (
        id, job_id, run_id, channel, target, status, message,
        attempted_at, error_text, created_at
      ) VALUES (
        @id, @job_id, @run_id, @channel, @target, @status, @message,
        @attempted_at, @error_text, @created_at
      )
    `).run(row);

    return hydrateNotification(row);
  }

  listNotificationsByJobId(jobId) {
    const rows = this.db.prepare(`
      SELECT *
      FROM job_notifications
      WHERE job_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(jobId);

    return rows.map(hydrateNotification);
  }

  markJobTriggered({ jobId, triggeredAt, nextRunAt = null }) {
    const updatedAt = triggeredAt || new Date().toISOString();

    this.db.prepare(`
      UPDATE jobs
      SET last_run_at = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(triggeredAt, nextRunAt, updatedAt, jobId);

    return this.getJob(jobId);
  }

  claimDueJob({ jobId, nowIso, nextRunAt = null }) {
    const updatedAt = nowIso || new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE jobs
      SET last_run_at = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
    `).run(updatedAt, nextRunAt, updatedAt, jobId, nowIso);

    if (result.changes === 0) {
      return null;
    }

    return this.getJob(jobId);
  }

  restoreClaimedJob({
    jobId,
    lastRunAt = null,
    nextRunAt = null,
    updatedAt = new Date().toISOString(),
  }) {
    this.db.prepare(`
      UPDATE jobs
      SET last_run_at = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(lastRunAt, nextRunAt, updatedAt, jobId);

    return this.getJob(jobId);
  }

  claimDueJobAndCreateRun({
    jobId,
    nowIso,
    nextRunAt = null,
    triggerType,
    startedAt,
    runStatus,
  }) {
    const timestamp = nowIso || new Date().toISOString();
    const tx = this.db.transaction((input) => {
      const claim = this.db.prepare(`
        UPDATE jobs
        SET last_run_at = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?
          AND status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
      `).run(input.timestamp, input.nextRunAt, input.timestamp, input.jobId, input.timestamp);

      if (claim.changes === 0) {
        return null;
      }

      const run = this.createRun({
        jobId: input.jobId,
        triggerType: input.triggerType,
        startedAt: input.startedAt || input.timestamp,
        status: input.runStatus,
      });

      return {
        job: this.getJob(input.jobId),
        run,
      };
    });

    return tx({
      jobId,
      timestamp,
      nextRunAt,
      triggerType,
      startedAt,
      runStatus,
    });
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { JobsStore };
