'use strict';

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function findMissing(env, keys) {
  return keys.filter((key) => !hasValue(env[key]));
}

class ChannelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelConfigError';
  }
}

function resolveFeishuPlan(env) {
  const keys = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
  const presentCount = keys.filter((key) => hasValue(env[key])).length;
  if (presentCount === 0) {
    return { enabled: false, reason: 'missing_credentials' };
  }
  if (presentCount !== keys.length) {
    throw new ChannelConfigError(
      `Feishu channel is partially configured; required keys: ${keys.join(', ')}; missing: ${findMissing(env, keys).join(', ')}`
    );
  }
  return { enabled: true, reason: 'configured' };
}

function resolveWeComPlan(env) {
  const appKeys = [
    'WECOM_CORP_ID',
    'WECOM_AGENT_ID',
    'WECOM_AGENT_SECRET',
    'WECOM_TOKEN',
    'WECOM_ENCODING_AES_KEY',
  ];
  const botKeys = ['WECOM_BOT_ID', 'WECOM_BOT_SECRET'];
  const activeSources = [];

  const appPresentCount = appKeys.filter((key) => hasValue(env[key])).length;
  if (appPresentCount > 0 && appPresentCount !== appKeys.length) {
    throw new ChannelConfigError(
      `WeCom app channel is partially configured; required keys: ${appKeys.join(', ')}; missing: ${findMissing(env, appKeys).join(', ')}`
    );
  }
  if (appPresentCount === appKeys.length) {
    activeSources.push('app');
  }

  const botPresentCount = botKeys.filter((key) => hasValue(env[key])).length;
  if (botPresentCount > 0 && botPresentCount !== botKeys.length) {
    throw new ChannelConfigError(
      `WeCom bot channel is partially configured; required keys: ${botKeys.join(', ')}; missing: ${findMissing(env, botKeys).join(', ')}`
    );
  }
  if (botPresentCount === botKeys.length) {
    activeSources.push('bot');
  }

  if (activeSources.length === 0) {
    return { enabled: false, reason: 'missing_credentials', activeSources: [] };
  }

  return { enabled: true, reason: 'configured', activeSources };
}

function resolveChannelBootstrapPlan(env = process.env) {
  return {
    feishu: resolveFeishuPlan(env),
    wecom: resolveWeComPlan(env),
  };
}

module.exports = {
  resolveChannelBootstrapPlan,
  ChannelConfigError,
};
