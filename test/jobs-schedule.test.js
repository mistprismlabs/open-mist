'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeNextRunAt, parseReminderSchedule } = require('../src/jobs/schedule');

describe('parseReminderSchedule', () => {
  it('parses once, daily, weekday, and weekly reminder schedules', () => {
    assert.deepEqual(
      parseReminderSchedule('once', '2026-04-20 09:30', 'Asia/Shanghai'),
      {
        kind: 'once',
        expr: '2026-04-20 09:30',
        timezone: 'Asia/Shanghai',
        date: '2026-04-20',
        time: '09:30',
      }
    );

    assert.deepEqual(
      parseReminderSchedule('daily', '09:30', 'Asia/Shanghai'),
      {
        kind: 'daily',
        expr: '09:30',
        timezone: 'Asia/Shanghai',
        time: '09:30',
      }
    );

    assert.deepEqual(
      parseReminderSchedule('weekday', '09:30', 'UTC'),
      {
        kind: 'weekday',
        expr: '09:30',
        timezone: 'UTC',
        time: '09:30',
      }
    );

    assert.deepEqual(
      parseReminderSchedule('weekly', 'mon 09:30', 'UTC'),
      {
        kind: 'weekly',
        expr: 'mon 09:30',
        timezone: 'UTC',
        day: 'mon',
        time: '09:30',
      }
    );
  });

  it('rejects unsupported reminder expressions', () => {
    assert.throws(() => parseReminderSchedule('daily', '9:30', 'UTC'));
    assert.throws(() => parseReminderSchedule('weekly', 'funday 09:30', 'UTC'));
    assert.throws(() => parseReminderSchedule('once', '2026/04/20 09:30', 'UTC'));
  });

  it('rejects invalid timezone names up front', () => {
    assert.throws(
      () => parseReminderSchedule('daily', '09:30', 'Not/AZone'),
      /Invalid timezone: Not\/AZone/
    );
  });
});

describe('computeNextRunAt', () => {
  it('computes the one-time run in the configured timezone', () => {
    const parsed = parseReminderSchedule('once', '2026-04-20 09:30', 'Asia/Shanghai');

    assert.equal(computeNextRunAt(parsed, '2026-04-20T00:00:00.000Z'), '2026-04-20T01:30:00.000Z');
    assert.equal(computeNextRunAt(parsed, '2026-04-20T02:00:00.000Z'), null);
  });

  it('uses the parsed once fields directly instead of reparsing expr', () => {
    const parsed = parseReminderSchedule('once', '2026-04-20 09:30', 'Asia/Shanghai');
    parsed.expr = 'broken expr';

    assert.equal(computeNextRunAt(parsed, '2026-04-20T00:00:00.000Z'), '2026-04-20T01:30:00.000Z');
  });

  it('computes the next recurring run for daily, weekday, and weekly schedules', () => {
    const daily = parseReminderSchedule('daily', '09:30', 'Asia/Shanghai');
    const weekday = parseReminderSchedule('weekday', '09:30', 'UTC');
    const weekly = parseReminderSchedule('weekly', 'tue 09:30', 'UTC');

    assert.equal(computeNextRunAt(daily, '2026-04-20T00:00:00.000Z'), '2026-04-20T01:30:00.000Z');
    assert.equal(computeNextRunAt(daily, '2026-04-20T02:00:00.000Z'), '2026-04-21T01:30:00.000Z');
    assert.equal(computeNextRunAt(weekday, '2026-04-25T10:00:00.000Z'), '2026-04-27T09:30:00.000Z');
    assert.equal(computeNextRunAt(weekly, '2026-04-20T10:00:00.000Z'), '2026-04-21T09:30:00.000Z');
  });
});
