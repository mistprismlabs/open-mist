#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyEnvUpdates } = require('../src/config/env-file');

function isReferenceLikeSecret(value) {
  const stringValue = String(value || '').trim();
  if (!stringValue) return true;
  if (stringValue === '****') return true;
  if ((stringValue.startsWith('{') && stringValue.endsWith('}')) || stringValue.includes("'source'") || stringValue.includes('"source"')) {
    return true;
  }
  return false;
}

function extractLarkAppConfig(config) {
  const candidate = Array.isArray(config?.apps)
    ? [...config.apps].reverse().find((app) => app && app.appId && app.appSecret)
    : config;

  if (!candidate?.appId) {
    throw new Error('Lark config is missing appId');
  }
  if (typeof candidate.appSecret !== 'string' || isReferenceLikeSecret(candidate.appSecret)) {
    throw new Error('Lark config must contain a plain appSecret value');
  }

  return {
    appId: String(candidate.appId),
    appSecret: String(candidate.appSecret),
  };
}

function buildLarkEnvUpdates(appConfig, authStatus = {}) {
  const updates = {
    FEISHU_APP_ID: appConfig.appId,
    FEISHU_APP_SECRET: appConfig.appSecret,
  };

  if (authStatus.userOpenId) {
    updates.FEISHU_OWNER_ID = String(authStatus.userOpenId);
  }

  return updates;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeEnvFile(envFile, updates) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const next = applyEnvUpdates(current, updates);
  fs.writeFileSync(envFile, next);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      result[key] = value;
    } else {
      result._.push(arg);
    }
  }
  return result;
}

function printUsage() {
  console.log(`Usage:
  node scripts/bootstrap-config.js set --env-file .env KEY VALUE [KEY VALUE ...]
  node scripts/bootstrap-config.js import-lark [--env-file .env] [--config-file ~/.lark-cli/config.json] [--auth-file auth.json]

Commands:
  set          Write one or more KEY VALUE pairs into .env using shell-safe formatting
  import-lark  Import FEISHU_APP_ID / FEISHU_APP_SECRET and optional FEISHU_OWNER_ID from lark-cli config
`);
}

function commandSet(args) {
  if (args._.length < 3 || args._.length % 2 === 0) {
    throw new Error('set requires KEY VALUE pairs');
  }
  const envFile = path.resolve(process.cwd(), args['env-file'] || '.env');
  const updates = {};
  for (let i = 1; i < args._.length; i += 2) {
    updates[args._[i]] = args._[i + 1];
  }
  writeEnvFile(envFile, updates);
  console.log(`Updated ${envFile}`);
}

function commandImportLark(args) {
  const envFile = path.resolve(process.cwd(), args['env-file'] || '.env');
  const configFile = path.resolve(String(args['config-file'] || path.join(os.homedir(), '.lark-cli', 'config.json')));
  const appConfig = extractLarkAppConfig(readJsonFile(configFile));
  const authStatus = args['auth-file'] ? readJsonFile(path.resolve(String(args['auth-file']))) : {};
  const updates = buildLarkEnvUpdates(appConfig, authStatus);
  writeEnvFile(envFile, updates);
  console.log(`Imported Lark app config into ${envFile}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'set') {
    commandSet(args);
    return;
  }
  if (command === 'import-lark') {
    commandImportLark(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  extractLarkAppConfig,
  buildLarkEnvUpdates,
  isReferenceLikeSecret,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
