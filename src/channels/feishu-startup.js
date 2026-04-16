'use strict';

const PLATFORM_PREREQUISITE_PATTERNS = [
  /system busy/i,
  /1000040345/,
  /PingInterval/i,
];

class FeishuStartupError extends Error {
  constructor(kind, message, originalError) {
    super(message);
    this.name = 'FeishuStartupError';
    this.kind = kind;
    this.originalError = originalError;
  }
}

function classifyFeishuStartupError(error) {
  const originalMessage = error?.message || String(error);
  const isPlatformPrerequisite = PLATFORM_PREREQUISITE_PATTERNS.some((pattern) => pattern.test(originalMessage));

  if (isPlatformPrerequisite) {
    return new FeishuStartupError(
      'platform_prerequisite',
      `Feishu startup blocked by platform prerequisites: verify event subscription, long connection, and Open Platform status. Original error: ${originalMessage}`,
      error,
    );
  }

  return new FeishuStartupError(
    'runtime_failure',
    `Feishu startup failed due to a runtime failure: ${originalMessage}`,
    error,
  );
}

module.exports = {
  FeishuStartupError,
  classifyFeishuStartupError,
};
