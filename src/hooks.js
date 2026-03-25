const fs = require("fs");
const path = require("path");

const AUDIT_LOG = path.join(__dirname, "..", "logs", "audit.jsonl");
const SKILL_WHITELIST = path.join(__dirname, "..", "data", "skill-whitelist.json");
const logsDir = path.dirname(AUDIT_LOG);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ============================================================
// 1. 安全配置
// ============================================================

// Bash: 硬拦截（仅拦截不可逆破坏 + 秘钥泄露 + 提权到 root）
// 设计原则：系统管理命令交给 OS 层（sudoers），hooks 只管"绝对不能发生"的事
const BASH_BLOCKED = [
  // --- 不可逆破坏 ---
  /\brm\s+(-\w+\s+)*\//,        // rm with absolute path
  /\brm\s+-rf\b/,                // rm -rf
  /\bmkfs\b/,                    // format filesystem
  /\bdd\s+if=/,                  // dd disk operations
  />\s*\/dev\/sd/,               // write to disk device
  /:(){ :\|:& };:/,              // fork bomb
  /\breboot\b/,                  // reboot
  /\bshutdown\b/,                // shutdown

  // --- 秘钥/凭证泄露 ---
  /\bcat\s+.*\.env\b/,           // cat .env
  /\bless\s+.*\.env\b/,          // less .env
  /\bhead\s+.*\.env\b/,          // head .env
  /\btail\s+.*\.env\b/,          // tail .env
  /ANTHROPIC_API_KEY/,           // API key reference
  /ANTHROPIC_AUTH_TOKEN/,        // auth token reference
  /ANTHROPIC_BASE_URL/,         // base URL
  /COS_SECRET/i,                 // COS credentials
  /DASHSCOPE_API_KEY/i,          // DashScope key
  /FEISHU_APP_SECRET/i,          // Feishu secret
  /GITHUB_PERSONAL_ACCESS/i,    // GitHub PAT

  // --- 环境变量整体泄露 ---
  /\benv\s*$/,                   // bare "env" (allow "env VAR=x cmd")
  /\bprintenv\s*$/,              // bare "printenv" (allow "printenv PATH")
  /\bset\s*$/,                   // bare "set" (dumps all vars)

  // --- 提权到 root shell ---
  /\bsu\s*-?\s*$/,               // su / su -
  /\bsudo\s+su\b/,               // sudo su
  /\bsudo\s+-i\b/,               // sudo -i
  /\bsudo\s+bash\b/,             // sudo bash
  /\bsudo\s+sh\b/,               // sudo sh
  /\bsudo\s+zsh\b/,              // sudo zsh

  // --- 反弹 Shell ---
  /\bnc\s+-.*[le]\b/,            // netcat listen/exec
  /\bncat\b.*(-e|-l)/,           // ncat exec/listen
  /\bsocat\b/,                   // socat

  // --- Shell 注入 ---
  /\beval\b/,                    // eval
  /\|\s*sh\s*$/,                 // pipe to sh (end of cmd)
  /\|\s*bash\s*$/,               // pipe to bash (end of cmd)
  /\|\s*zsh\s*$/,                // pipe to zsh (end of cmd)

  // --- SQL 危险操作 ---
  /drop\s+table/i,
  /drop\s+database/i,
  /truncate\s+table/i,

  // --- C2 fix: Bash 文件操作绕过 Write/Edit 拦截 ---
  />\s*.*\.claude\/(skills|commands)\//,                    // echo/重定向写入
  /\b(cp|mv|tee|install)\b.*\.claude\/(skills|commands)\//,  // 文件复制/移动
  /\bln\s+-s.*\.claude\/(skills|commands)\//,               // 符号链接（M1 fix）

  // --- SSL 证书管理 ---
  /\bcertbot\b/,  // 禁止运行 certbot（*.mistprism.com 通配符证书已覆盖所有子域名，永远不需要单独申请新证书）
];

// Write/Edit: 允许写入的路径
const PROJECT_ROOT = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const SITES_ROOT = process.env.SITES_DIR || path.join(path.dirname(PROJECT_ROOT), 'sites');
const escapedProject = PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedSites = SITES_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WRITE_ALLOWED = [
  new RegExp('^' + escapedSites + '/'),                      // 站点部署
  new RegExp('^' + escapedProject + '/media/'),              // 媒体文件
  new RegExp('^' + escapedProject + '/data/'),               // 数据目录
  new RegExp('^' + escapedProject + '/docs/'),               // 文档
  new RegExp('^' + escapedProject + '/[^/]*$'),              // 项目根目录文件(package.json等)
  new RegExp('^' + escapedProject + '/src/'),                // 源代码
  new RegExp('^' + escapedProject + '/logs/'),               // 日志
  /^\/tmp\//,                                                 // 临时文件
];

// Write/Edit: 即使在允许路径内也禁止的文件
const WRITE_BLOCKED_FILES = [
  /\.env$/,
  /\.env\./,
  /\.service$/,
  /\.ssh\//,
  /id_rsa/,
  /id_ed25519/,
  /authorized_keys/,
  /skill-whitelist\.json$/,          // C1 fix: 白名单文件只能通过 approveSkill() 写入
];

// ============================================================
// 2. 安全守卫（PreToolUse）
// ============================================================

const securityGuard = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const deny = (reason) => {
    console.warn(`[Security] BLOCKED: ${reason}`);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `安全策略：${reason}`,
      },
    };
  };

  if (input.tool_name === "Bash") {
    const cmd = String(input.tool_input?.command || "").trim();
    if (!cmd) return deny("空命令");

    // Skill/Plugin 安装/更新审核网关
    const installMatch = cmd.match(/\bclaude\s+plugin\s+(install|update)\s+(\S+)/);
    if (installMatch) {
      const action = installMatch[1];
      const pluginName = installMatch[2];
      if (!isSkillApproved(pluginName)) {
        return deny(
          `插件「${pluginName}」尚未通过安全审查。` +
          `请先使用 /skill-vetter 对该插件进行审查，审查报告会发送到飞书由用户确认。` +
          `用户确认后即可${action === 'update' ? '更新' : '安装'}。`
        );
      }
      // 已审核通过，放行
      console.log(`[Security] Plugin ${action} approved: ${pluginName}`);
    }

    // 多命令链检查
    const subCommands = cmd.split(/&&|\|\||;/).map(s => s.trim()).filter(Boolean);
    for (const sub of subCommands) {
      for (const pattern of BASH_BLOCKED) {
        if (pattern.test(sub)) {
          return deny(`危险操作: ${pattern.source.substring(0, 40)} → ${cmd.substring(0, 60)}`);
        }
      }
    }
    // 完整命令也检查
    for (const pattern of BASH_BLOCKED) {
      if (pattern.test(cmd)) {
        return deny(`危险操作: ${pattern.source.substring(0, 40)} → ${cmd.substring(0, 60)}`);
      }
    }
  }

  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    const filePath = String(input.tool_input?.file_path || "");
    return checkWritePath(filePath, input.tool_name);
  }

  return {};
};

// Skill 目录路径模式（项目级 + 用户级）
const SKILL_DIR_PATTERNS = [
  /\.claude\/skills\//,
  /\.claude\/commands\//,
];

function checkWritePath(rawPath, toolName) {
  const deny = (reason) => {
    console.warn(`[Security] BLOCKED ${toolName}: ${reason}`);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `安全策略：${reason}`,
      },
    };
  };

  if (!rawPath) return deny("空文件路径");

  // M2 fix: 路径标准化，防止 // 或 ./ 等变体绕过
  const filePath = path.normalize(rawPath);

  // Skill/Command 文件写入审核：必须通过 Skill Vetter 白名单
  if (SKILL_DIR_PATTERNS.some(p => p.test(filePath))) {
    const fileName = path.basename(filePath, '.md');
    if (isSkillApproved(fileName)) {
      console.log(`[Security] Skill write approved: ${filePath}`);
      return {};  // 已审核，放行
    }
    return deny(
      `Skill 文件「${fileName}」尚未通过安全审查。` +
      `请先使用 /skill-vetter 对该 skill 内容进行审查，审查报告会发送到飞书由用户确认。` +
      `用户确认后即可写入。`
    );
  }

  for (const pattern of WRITE_BLOCKED_FILES) {
    if (pattern.test(filePath)) {
      return deny(`禁止写入受保护文件: ${filePath}`);
    }
  }

  const allowed = WRITE_ALLOWED.some(p => p.test(filePath));
  if (!allowed) {
    return deny(`禁止写入该路径: ${filePath}（允许: sites/, media/, data/, docs/, src/, logs/, /tmp/）`);
  }

  return {};
}

// ============================================================
// 3. 审计日志（PostToolUse）
// ============================================================

const auditLogger = async (input) => {
  if (input.hook_event_name === "PostToolUse") {
    const entry = {
      ts: new Date().toISOString(),
      tool: input.tool_name,
      input: JSON.stringify(input.tool_input || {}).substring(0, 200),
      sessionId: input.session_id,
    };
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  }
  return {};
};

// ============================================================
// 4. 执行过程错误日志收集（PostToolUse）
// ============================================================

const executionLogs = new Map();

const errorCollector = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};

  const sessionId = input.session_id;
  const toolName = input.tool_name;
  const toolOutput = String(input.tool_output || "");
  const exitCode = input.tool_input?.exit_code;

  let errorInfo = null;

  if (toolName === "Bash" && exitCode && exitCode !== 0) {
    errorInfo = {
      tool: toolName,
      cmd: String(input.tool_input?.command || "").substring(0, 100),
      error: toolOutput.substring(0, 200),
      ts: new Date().toISOString(),
    };
  }

  if (!errorInfo && /error|failed|exception|traceback|ENOENT|EACCES|EPERM/i.test(toolOutput.substring(0, 500))) {
    if (!/0 matches|no files found/i.test(toolOutput)) {
      errorInfo = {
        tool: toolName,
        warning: toolOutput.substring(0, 200),
        ts: new Date().toISOString(),
      };
    }
  }

  if (errorInfo) {
    if (!executionLogs.has(sessionId)) executionLogs.set(sessionId, []);
    executionLogs.get(sessionId).push(errorInfo);
  }

  return {};
};

function getExecutionLog(sessionId) {
  return executionLogs.get(sessionId) || [];
}

function clearExecutionLog(sessionId) {
  executionLogs.delete(sessionId);
}

// ============================================================
// 5. 记忆系统钩子
// ============================================================

let onPostToolUse = null;
let onSessionEnd = null;
let onPreCompact = null;
let onPostCompact = null;
let onStopFailure = null;
let onToolFailure = null;

const toolUseTracker = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  if (onPostToolUse) {
    try {
      await onPostToolUse(input.session_id, input.tool_name, input.tool_input || {});
    } catch (e) { console.warn('[Hooks] toolUseTracker error:', e.message); }
  }
  return {};
};

const sessionEndHook = async (input) => {
  if (input.hook_event_name === "Stop") {
    console.log(`[Hooks] Session stopped: ${input.session_id}`);
    if (onSessionEnd) {
      try { await onSessionEnd(input.session_id); } catch (e) {
        console.error("[Hooks] sessionEnd error:", e.message);
      }
    }
    setTimeout(() => clearExecutionLog(input.session_id), 5000);
  }
  return {};
};

const preCompactHook = async (input) => {
  if (input.hook_event_name === "PreCompact") {
    console.log(`[Hooks] PreCompact triggered: ${input.session_id}`);
    if (onPreCompact) {
      try { await onPreCompact(input.session_id); } catch (e) {
        console.error("[Hooks] preCompact error:", e.message);
      }
    }
  }
  return {};
};

const postCompactHook = async (input) => {
  if (input.hook_event_name === "PostCompact") {
    const summary = input.compact_summary || null;
    console.log(`[Hooks] PostCompact completed: ${input.session_id}${summary ? ` (summary: ${summary.substring(0, 80)}...)` : ''}`);
    if (onPostCompact) {
      try { await onPostCompact(input.session_id, summary); } catch (e) {
        console.error("[Hooks] postCompact error:", e.message);
      }
    }
  }
  return {};
};

// ============================================================
// 6.5 API 错误处理（StopFailure）
// ============================================================

const stopFailureHook = async (input) => {
  if (input.hook_event_name !== "StopFailure") return {};

  const sessionId = input.session_id;
  const error = input.error || input.stop_reason || 'unknown';
  console.error(`[Hooks] StopFailure: session=${sessionId}, error=${JSON.stringify(error).substring(0, 200)}`);

  // 审计日志
  const entry = {
    ts: new Date().toISOString(),
    event: 'StopFailure',
    error: JSON.stringify(error).substring(0, 500),
    sessionId,
  };
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");

  if (onStopFailure) {
    try { await onStopFailure(sessionId, error); } catch (e) {
      console.error("[Hooks] stopFailure callback error:", e.message);
    }
  }

  return {};
};

// ============================================================
// 6. 工具失败处理（PostToolUseFailure）
// ============================================================

const failureLogger = async (input) => {
  if (input.hook_event_name !== "PostToolUseFailure") return {};

  const sessionId = input.session_id;
  const toolName = input.tool_name;
  const error = String(input.error || "unknown error");

  // 审计日志
  const entry = {
    ts: new Date().toISOString(),
    tool: toolName,
    input: JSON.stringify(input.tool_input || {}).substring(0, 200),
    error: error.substring(0, 300),
    status: "failed",
    sessionId,
  };
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");

  // 填充 executionLogs（供 gateway 消费）
  if (!executionLogs.has(sessionId)) executionLogs.set(sessionId, []);
  executionLogs.get(sessionId).push({
    tool: toolName,
    error: error.substring(0, 200),
    ts: new Date().toISOString(),
  });

  console.warn(`[Hooks] Tool failed: ${toolName} — ${error.substring(0, 100)}`);
  if (onToolFailure) {
    try { await onToolFailure(sessionId, toolName, error, input.tool_input || {}); }
    catch (e) { console.warn('[Hooks] toolFailure callback error:', e.message); }
  }
  return {};
};

// ============================================================
// 7. Skill 审核白名单
// ============================================================

function _loadWhitelist() {
  try {
    if (fs.existsSync(SKILL_WHITELIST)) {
      return JSON.parse(fs.readFileSync(SKILL_WHITELIST, 'utf-8'));
    }
  } catch (e) {
    console.warn('[Security] Whitelist load failed:', e.message);
  }
  return {};
}

function isSkillApproved(name) {
  const wl = _loadWhitelist();
  return !!wl[name];
}

const VALID_SKILL_NAME = /^[a-zA-Z0-9._-]+$/;

function approveSkill(name, verdict) {
  // H2 fix: 格式校验
  if (!name || !VALID_SKILL_NAME.test(name)) {
    console.warn(`[Security] Invalid skill name rejected: ${name}`);
    return false;
  }
  // L2 fix: BLOCK 级别禁止写入白名单
  if (verdict === 'BLOCK') {
    console.warn(`[Security] BLOCK verdict cannot be approved: ${name}`);
    return false;
  }
  const wl = _loadWhitelist();
  wl[name] = { approvedAt: new Date().toISOString(), verdict };
  const dir = path.dirname(SKILL_WHITELIST);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SKILL_WHITELIST, JSON.stringify(wl, null, 2));
  console.log(`[Security] Skill approved: ${name}`);
  return true;
}

// ============================================================
// 8. 导出
// ============================================================

function setPostToolUseCallback(fn) { onPostToolUse = fn; }
function setSessionEndCallback(fn) { onSessionEnd = fn; }
function setPreCompactCallback(fn) { onPreCompact = fn; }
function setPostCompactCallback(fn) { onPostCompact = fn; }
function setStopFailureCallback(fn) { onStopFailure = fn; }
function setToolFailureCallback(fn) { onToolFailure = fn; }

const hooks = {
  PreToolUse: [{ hooks: [securityGuard] }],
  PostToolUse: [{ hooks: [auditLogger, errorCollector, toolUseTracker] }],
  PostToolUseFailure: [{ hooks: [failureLogger] }],
  Stop: [{ hooks: [sessionEndHook] }],
  PreCompact: [{ hooks: [preCompactHook] }],
  PostCompact: [{ hooks: [postCompactHook] }],
  StopFailure: [{ hooks: [stopFailureHook] }],
};

module.exports = {
  hooks,
  setPostToolUseCallback,
  setSessionEndCallback,
  setPreCompactCallback,
  setPostCompactCallback,
  setStopFailureCallback,
  setToolFailureCallback,
  getExecutionLog,
  clearExecutionLog,
  approveSkill,
  isSkillApproved,
  // Exported for testing
  BASH_BLOCKED,
  WRITE_ALLOWED,
  checkWritePath,
};
