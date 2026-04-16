'use strict';

function parseEnvFile(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      entries.push({ type: 'comment', raw: line });
    } else {
      const eq = line.indexOf('=');
      if (eq > 0) {
        entries.push({ type: 'var', key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim(), raw: line });
      } else {
        entries.push({ type: 'comment', raw: line });
      }
    }
  }
  return entries;
}

function replaceEnvVar(content, key, newValue) {
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^${key}\\s*=`))) {
      lines[i] = `${key}=${newValue}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${newValue}`);
  return lines.join('\n');
}

function formatEnvValue(value) {
  const stringValue = String(value ?? '');
  if (/^[A-Za-z0-9_./:@+-]+$/.test(stringValue)) {
    return stringValue;
  }
  return JSON.stringify(stringValue);
}

function applyEnvUpdates(content, updates) {
  let nextContent = content;
  for (const [key, value] of Object.entries(updates)) {
    nextContent = replaceEnvVar(nextContent, key, formatEnvValue(value));
  }
  return nextContent;
}

module.exports = {
  parseEnvFile,
  replaceEnvVar,
  formatEnvValue,
  applyEnvUpdates,
};
