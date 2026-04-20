'use strict';

const WEEKDAY_TO_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function assertTimezone(timezone) {
  if (!timezone) {
    throw new Error('timezone is required');
  }
}

function normalizeTimezone(timezone) {
  assertTimezone(timezone);

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }

    throw error;
  }
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid time: ${value}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid time: ${value}`);
  }

  return { hour, minute, time: value };
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }

  return { year, month, day, date: value };
}

function parseReminderSchedule(kind, expr, timezone) {
  const normalizedTimezone = normalizeTimezone(timezone);

  if (kind === 'once') {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 2) {
      throw new Error(`Invalid once schedule: ${expr}`);
    }

    const date = parseDate(parts[0]);
    const time = parseTime(parts[1]);
    return {
      kind,
      expr,
      timezone: normalizedTimezone,
      date: date.date,
      time: time.time,
    };
  }

  if (kind === 'daily' || kind === 'weekday') {
    const time = parseTime(expr);
    return {
      kind,
      expr,
      timezone: normalizedTimezone,
      time: time.time,
    };
  }

  if (kind === 'weekly') {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 2) {
      throw new Error(`Invalid weekly schedule: ${expr}`);
    }

    const day = parts[0].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(WEEKDAY_TO_INDEX, day)) {
      throw new Error(`Invalid weekly day: ${parts[0]}`);
    }

    const time = parseTime(parts[1]);
    return {
      kind,
      expr,
      timezone: normalizedTimezone,
      day,
      time: time.time,
    };
  }

  throw new Error(`Unsupported schedule kind: ${kind}`);
}

function getParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US-u-hc-h23', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);

  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    weekday: result.weekday.toLowerCase(),
  };
}

function localDateToUtc(year, month, day, hour, minute, timezone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;

  for (let i = 0; i < 3; i += 1) {
    const parts = getParts(new Date(guess), timezone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const diff = actual - target;
    if (diff === 0) {
      return new Date(guess);
    }

    guess -= diff;
  }

  return new Date(guess);
}

function addDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function computeNextRunAt(parsed, nowIso) {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid nowIso: ${nowIso}`);
  }

  const { timezone } = parsed;
  const nowParts = getParts(now, timezone);
  const [hourText, minuteText] = parsed.time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (parsed.kind === 'once') {
    const dateParts = parseDate(parsed.date);
    const timeParts = parseTime(parsed.time);
    const runAt = localDateToUtc(
      dateParts.year,
      dateParts.month,
      dateParts.day,
      timeParts.hour,
      timeParts.minute,
      timezone
    );
    return runAt.getTime() >= now.getTime() ? runAt.toISOString() : null;
  }

  if (parsed.kind === 'daily' || parsed.kind === 'weekday') {
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidateDate = addDays(nowParts.year, nowParts.month, nowParts.day, offset);
      const candidate = localDateToUtc(
        candidateDate.year,
        candidateDate.month,
        candidateDate.day,
        hour,
        minute,
        timezone
      );
      const weekday = getParts(candidate, timezone).weekday;
      if (parsed.kind === 'weekday' && !['mon', 'tue', 'wed', 'thu', 'fri'].includes(weekday)) {
        continue;
      }
      if (candidate.getTime() >= now.getTime()) {
        return candidate.toISOString();
      }
    }

    return null;
  }

  if (parsed.kind === 'weekly') {
    const targetIndex = WEEKDAY_TO_INDEX[parsed.day];
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidateDate = addDays(nowParts.year, nowParts.month, nowParts.day, offset);
      const candidate = localDateToUtc(
        candidateDate.year,
        candidateDate.month,
        candidateDate.day,
        hour,
        minute,
        timezone
      );
      const weekday = getParts(candidate, timezone).weekday;
      if (WEEKDAY_TO_INDEX[weekday] !== targetIndex) {
        continue;
      }
      if (candidate.getTime() >= now.getTime()) {
        return candidate.toISOString();
      }
    }

    return null;
  }

  throw new Error(`Unsupported schedule kind: ${parsed.kind}`);
}

module.exports = { parseReminderSchedule, computeNextRunAt };
