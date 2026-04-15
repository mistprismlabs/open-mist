'use strict';

/**
 * 冒烟测试：验证所有模块能正常加载，不会因语法错误、缺失依赖而崩溃。
 * 这是最廉价也最有效的测试——如果 require() 失败，说明部署必定失败。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const MODULES = [
  { name: 'hooks', path: '../src/hooks' },
  { name: 'claude', path: '../src/claude' },
  { name: 'gateway', path: '../src/gateway' },
  { name: 'message-formatter', path: '../src/message-formatter' },
  { name: 'deployer', path: '../src/deployer' },
  // heartbeat 跳过：模块加载时启动 setInterval，会阻止进程退出
  { name: 'memory/short-term', path: '../src/memory/short-term' },
  { name: 'memory/memory-manager', path: '../src/memory/memory-manager' },
  { name: 'memory/vector-store', path: '../src/memory/vector-store' },
  { name: 'channels/base', path: '../src/channels/base' },
  { name: 'channels/feishu', path: '../src/channels/feishu' },
  { name: 'channels/feishu-cards', path: '../src/channels/feishu-cards' },
  { name: 'channels/feishu-message-api', path: '../src/channels/feishu-message-api' },
  { name: 'channels/feishu-media', path: '../src/channels/feishu-media' },
  { name: 'channels/wecom', path: '../src/channels/wecom' },
  { name: 'channels/weixin', path: '../src/channels/weixin' },
];

describe('smoke: all modules load without error', () => {
  for (const mod of MODULES) {
    it(`require("${mod.path}") succeeds`, () => {
      const exported = require(mod.path);
      assert.ok(exported, `${mod.name} exported nothing`);
      assert.equal(typeof exported, 'object', `${mod.name} should export an object`);
    });
  }
});
