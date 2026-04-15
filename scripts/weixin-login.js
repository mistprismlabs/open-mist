#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const {
  loadWeixinAccountCredential,
  saveWeixinAccountCredential,
  resolveWeixinStateDir,
  resolveWeixinAccountsDir,
} = require('../src/channels/weixin');

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_INTERVAL_MS = 1_000;

function ensureFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('Current Node.js runtime does not provide fetch(). Please use Node.js 18+.');
  }
}

function normalizeBotType(botType = DEFAULT_BOT_TYPE) {
  const normalized = String(botType || '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('WEIXIN_BOT_TYPE must be a numeric string, for example 3.');
  }
  return normalized;
}

function ensureDirectoryWritable(dirPath, label) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`${label}不可写：${dirPath}（${String(err.message || err)}）`);
  }
}

function runPreflightChecks({
  botType = DEFAULT_BOT_TYPE,
  stateDir = process.env.WEIXIN_STATE_DIR,
  accountId = process.env.WEIXIN_ACCOUNT_ID,
} = {}) {
  ensureFetch();
  const normalizedBotType = normalizeBotType(botType);
  const resolvedStateDir = resolveWeixinStateDir(stateDir);
  const accountsDir = resolveWeixinAccountsDir({ stateDir: resolvedStateDir });
  ensureDirectoryWritable(resolvedStateDir, '微信状态目录');
  ensureDirectoryWritable(accountsDir, '微信账号目录');
  const existingCredential = accountId
    ? loadWeixinAccountCredential({ accountId, stateDir: resolvedStateDir })
    : null;
  return {
    botType: normalizedBotType,
    stateDir: resolvedStateDir,
    accountsDir,
    existingCredential,
  };
}

async function getJson(url, timeoutMs = QR_LONG_POLL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status}: ${rawText}`);
    }
    return rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildBotQrcodeUrl(botType = DEFAULT_BOT_TYPE) {
  return `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
}

function buildQrcodeStatusUrl(baseUrl, qrcode) {
  return `${baseUrl.replace(/\/$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
}

async function fetchQRCode(botType = DEFAULT_BOT_TYPE) {
  const result = await getJson(buildBotQrcodeUrl(botType), 15_000);
  if (!result?.qrcode || !result?.qrcode_img_content) {
    throw new Error('QR code response is missing qrcode or qrcode_img_content');
  }
  return {
    qrcode: result.qrcode,
    qrcodeUrl: result.qrcode_img_content,
  };
}

async function pollQRStatus({ baseUrl, qrcode }) {
  return getJson(buildQrcodeStatusUrl(baseUrl, qrcode), QR_LONG_POLL_TIMEOUT_MS);
}

async function printQrCode(qrcodeUrl) {
  try {
    const qrterm = require('qrcode-terminal');
    qrterm.generate(qrcodeUrl, { small: true });
  } catch {
    console.log('[OpenMist] 未安装 qrcode-terminal，改为输出二维码链接。');
  }
  console.log('[OpenMist] 如二维码未正常显示，请直接在浏览器打开以下链接扫码：');
  console.log(qrcodeUrl);
}

async function startWeixinLoginWithQr({ botType = DEFAULT_BOT_TYPE } = {}) {
  const { qrcode, qrcodeUrl } = await fetchQRCode(botType);
  return {
    sessionKey: randomUUID(),
    qrcode,
    qrcodeUrl,
    apiBaseUrl: FIXED_BASE_URL,
    startedAt: Date.now(),
  };
}

async function waitForWeixinLogin({ session, timeoutMs = 480_000, botType = DEFAULT_BOT_TYPE } = {}) {
  if (!session?.qrcode) {
    return { connected: false, message: '当前没有进行中的登录，请先生成二维码。' };
  }

  const deadline = Date.now() + Math.max(timeoutMs, 1_000);
  let active = { ...session };
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    try {
      const statusResponse = await pollQRStatus({
        baseUrl: active.apiBaseUrl || FIXED_BASE_URL,
        qrcode: active.qrcode,
      });

      switch (statusResponse?.status) {
        case 'wait':
        case undefined:
          process.stdout.write('.');
          break;
        case 'scaned':
          if (!scannedPrinted) {
            process.stdout.write('\n[OpenMist] 已扫码，请在微信中继续确认...\n');
            scannedPrinted = true;
          }
          break;
        case 'scaned_but_redirect':
          if (statusResponse.redirect_host) {
            active.apiBaseUrl = `https://${statusResponse.redirect_host}`;
          }
          break;
        case 'expired': {
          qrRefreshCount += 1;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            return {
              connected: false,
              message: '登录超时：二维码多次过期，请重新开始登录流程。',
            };
          }
          process.stdout.write(`\n[OpenMist] 二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
          const refreshed = await fetchQRCode(botType);
          active = {
            ...active,
            qrcode: refreshed.qrcode,
            qrcodeUrl: refreshed.qrcodeUrl,
            apiBaseUrl: FIXED_BASE_URL,
            startedAt: Date.now(),
          };
          scannedPrinted = false;
          await printQrCode(refreshed.qrcodeUrl);
          break;
        }
        case 'confirmed':
          if (!statusResponse.ilink_bot_id) {
            return {
              connected: false,
              message: '登录失败：服务器未返回 ilink_bot_id。',
            };
          }
          return {
            connected: true,
            accountId: statusResponse.ilink_bot_id,
            botToken: statusResponse.bot_token,
            baseUrl: statusResponse.baseurl || active.apiBaseUrl || FIXED_BASE_URL,
            userId: statusResponse.ilink_user_id,
            message: '✅ 与微信连接成功！',
          };
        default:
          return {
            connected: false,
            message: `登录失败：未知状态 ${statusResponse.status}`,
          };
      }
    } catch (err) {
      return {
        connected: false,
        message: `登录失败：${String(err.message || err)}`,
      };
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    connected: false,
    message: '登录超时，请重试。',
  };
}

async function main() {
  console.log('[OpenMist] 启动微信原生扫码登录...');
  const preflight = runPreflightChecks({
    botType: process.env.WEIXIN_BOT_TYPE || DEFAULT_BOT_TYPE,
    stateDir: process.env.WEIXIN_STATE_DIR,
    accountId: process.env.WEIXIN_ACCOUNT_ID,
  });

  console.log(`[OpenMist] 使用 bot_type=${preflight.botType}`);
  console.log(`[OpenMist] 微信状态目录: ${preflight.stateDir}`);
  console.log(`[OpenMist] 微信账号目录: ${preflight.accountsDir}`);
  if (preflight.existingCredential) {
    console.log(`[OpenMist] 检测到已有账号凭据：${preflight.existingCredential.accountId}`);
  }

  const session = await startWeixinLoginWithQr({ botType: preflight.botType });
  await printQrCode(session.qrcodeUrl);

  const result = await waitForWeixinLogin({
    session,
    timeoutMs: Number(process.env.WEIXIN_LOGIN_TIMEOUT_MS || 480_000),
    botType: preflight.botType,
  });

  process.stdout.write('\n');

  if (!result.connected) {
    throw new Error(result.message);
  }

  const filePath = saveWeixinAccountCredential({
    accountId: result.accountId,
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
    stateDir: preflight.stateDir,
  });

  console.log('[OpenMist] 扫码登录完成。');
  console.log(`[OpenMist] 凭据已保存到: ${filePath}`);
  console.log('[OpenMist] 现在可直接启动 OpenMist：');
  console.log('  1. 在 .env 中设置 WEIXIN_ENABLED=true');
  console.log(`  2. 如需固定账号，可设置 WEIXIN_ACCOUNT_ID=${result.accountId}`);
  console.log('  3. 启动 OpenMist，若未显式配置 WEIXIN_TOKEN，会自动读取本地凭据');
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[OpenMist] ${err.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  normalizeBotType,
  runPreflightChecks,
  buildBotQrcodeUrl,
  buildQrcodeStatusUrl,
  fetchQRCode,
  pollQRStatus,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
};
