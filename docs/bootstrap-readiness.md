# OpenMist Bootstrap Readiness

本文档记录两类信息：

1. 已经通过真实空 Ubuntu 服务器部署验证过的初始化结论
2. 在设计最终 `openmist-bootstrap` skill 之前，仍需收口的初始化缺口

目标不是写 skill 本身，而是先把“AI 一步一步执行时依赖的稳定底座”补齐。

---

## 当前结论

OpenMist 已经具备第一轮真实服务器部署能力，但还没有完全达到“用户一句提示词 + 一个 skill，AI 即可稳定完成初始化”的状态。

更准确地说：

- 主部署路径已经跑通
- 大坑已经暴露出一批
- 现在最应该做的是把这些已知坑固化成脚本、检查项和明确规则
- skill 应该是最后一层薄编排，而不是把这些判断逻辑塞进提示词里

---

## 已验证完成

以下结论已经在真实“空 Ubuntu 服务器 + SSH 首次部署”路径上验证过：

### 1. 基础部署入口已建立

- `docs/deploy.md` 已明确 SSH 前提、空服务器假设和首次部署顺序
- `scripts/check-runtime.sh` 能检查空机是否具备运行前置条件
- `scripts/check-config.sh` 能检查 `.env` 是否完整
- `.claude/skills/openmist-bootstrap.md` 已作为 repo 内 skill 入口存在

### 2. 空服务器运行时依赖路径已验证

真实服务器部署表明，以下依赖不能假设预装：

- `node`
- `npm`
- `git`
- `claude`
- `lark-cli`
- 编译工具链（`make` / `g++` / `python3`）

并且普通用户安装 CLI 时，推荐稳定路径是：

- `~/.local/bin`
- `npm config set prefix ~/.local`

### 3. Claude Code CLI 与项目依赖边界已验证

- 项目依赖中的 `@anthropic-ai/claude-agent-sdk` 由 `npm install` 安装
- 系统级 `claude` CLI 仍然需要单独安装，用于：
  - `CLAUDE.md` / settings 行为
  - `claude auth login`
  - `claude doctor`
  - heartbeat / runtime 检查链路

### 4. Anthropic 兼容提供商路径已验证

MiniMax 的 Anthropic 兼容方案已验证可用：

- `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`
- `CLAUDE_MODEL=MiniMax-M2.7`
- `RECOMMEND_MODEL=MiniMax-M2.7-highspeed`

仓库公开入口已补齐：

- `.env.example`
- `scripts/check-config.sh`
- `README.md`
- `README.en.md`
- `docs/deploy.md`

现在部署入口会明确承认 Anthropic 兼容提供商，而不是只默认 Anthropic 官方接口。

### 5. Node ABI / 本地编译问题已验证

真实服务器部署暴露出：

- `better-sqlite3`
- `sqlite-vec`

在 Node 升级后可能需要重新编译，否则服务虽然启动，但向量记忆会降级。

这意味着初始化流程必须考虑：

- `npm install`
- 必要时 `npm rebuild`

### 6. 服务已经能够实际启动

第一轮真实服务器测试表明：

- `systemd` 服务能拉起
- OpenMist 主进程能进入运行态
- WebAdapter 能监听
- VectorStore 可在重编依赖后恢复正常

因此，当前剩余问题已经不是“主程序起不来”，而是“初始化底座还不够产品化”。

---

## 已识别的大坑

以下问题已经通过真实服务器部署暴露出来，后续不应再靠 AI 临场猜：

### 1. `.env` 必须 shell-safe

初始化结果最终要落到：

- shell
- `systemd EnvironmentFile`
- 检查脚本

因此 `.env` 必须始终是纯 `KEY=value` 文本，不允许写入对象、调试结构、CLI 内部对象字符串。

### 2. 通道启用必须遵守统一规则

每个通道都应该只允许三种状态：

- 未配置：跳过，不启动
- 半配置：明确失败并提示缺失项
- 完整配置：启动

不能再保留“尽量启动，再在日志里失败重连”的隐式行为。

### 3. 只做 runtime/config 检查还不够

当前已有：

- `check-runtime.sh`
- `check-config.sh`

但还缺少服务级检查脚本，用于回答：

- 服务是否真的启动成功
- 关键组件是否初始化成功
- 当前部署是否“可用”而不仅仅是“命令执行成功”

---

## 设计最终 Skill 前还差哪些项

### Batch 1: Config Substrate

这是当前最优先的一批。

目标：让 AI 能把初始化结果稳定落到可运行的 `.env`。

需要完成：

- [x] 明确 `.env` 规则：只允许纯 `KEY=value`
- [x] 新增配置写入脚本：`scripts/bootstrap-config.js`
- [x] 标准化 Feishu/Lark 初始化结果写回 `.env` 的方式（`import-lark`）
- [x] 避免把 CLI 内部对象或占位结构直接写入配置文件
- [x] 为 `.env` 写入逻辑补测试

### Batch 2: Service Substrate

目标：让 AI 在启动服务后，有统一办法判断部署是否真正完成。

需要完成：

- [x] 新增 `scripts/check-service.sh`
- [x] 统一 systemd 启动后的健康判断
- [x] 检查 VectorStore 是否初始化成功
- [x] 检查 WebAdapter / 监听状态
- [x] 将启动期 `error/fatal` 日志纳入可判定输出
- [ ] 明确“服务可用 / 部分完成 / 明确失败”的返回标准

### Batch 3: Channel Bootstrap Rules

目标：让通道初始化可自动化，而不是依赖日志碰运气。

需要完成：

- [x] 收口 Feishu / WeCom 通道的基础启用条件
- [x] 明确 Feishu 事件订阅 / 长连接相关的外部前提
- [x] 将“平台侧未配置”与“程序本身失败”区分开
- [x] 清理未配置时仍尝试启动的通道逻辑
- [x] 对半配置状态做 fail-fast

当前已完成的收口：

- 新增 `src/channel-bootstrap.js`，统一判定 Feishu / WeCom 的通道三态
- `src/index.js` 已接入这套规则：未配置跳过，半配置直接报错
- `scripts/check-config.sh` 现在会在启动前拦截 Feishu / WeCom 半配置
- `.env.example` 与 `docs/deploy.md` 已统一成代码真实读取的 WeCom 变量名
- 新增 `src/channels/feishu-startup.js`，将 Feishu 平台侧阻塞与运行时异常分开分类
- `scripts/check-service.sh` 现在会把 Feishu 平台侧阻塞作为 warning 暴露出来

### Batch 4: Bootstrap Scripts

目标：让 skill 调用稳定脚本，而不是拼接大量 shell。

需要完成：

- [x] `scripts/bootstrap-user.sh`
- [x] `scripts/bootstrap-runtime.sh`
- [x] `scripts/bootstrap-service.sh`

建议职责：

- `bootstrap-user.sh`：创建应用用户、目录、sudo 配置
- `bootstrap-runtime.sh`：安装系统依赖、Node、CLI
- `bootstrap-service.sh`：生成并启用 systemd unit

当前已完成的收口：

- `bootstrap-user.sh` 已支持创建普通用户、补 sudo 组、准备 home 目录，并提供 dry-run
- `bootstrap-runtime.sh` 已支持基础 apt 依赖、NodeSource Node 安装、用户级 npm prefix、Claude Code CLI、`lark-cli`
- `bootstrap-service.sh` 已支持渲染 systemd unit，并可按需跳过 `systemctl enable/start`

### Batch 5: Provider Cleanup

目标：默认保持官方 Anthropic 路径，同时去掉运行时代码里写死的具体模型 ID。

当前已完成的收口：

- [x] `src/claude.js`
- [x] `src/channels/web.js`
- [x] `src/task-executor.js`
- [x] `src/memory/memory-manager.js`
- [x] `scripts/fetch-github-updates.js`
- [x] `admin.js`

结果：

- SDK 路径不再偷偷注入 `claude-opus/sonnet/haiku` 这类固定模型
- 直接走 Anthropic Messages API 的路径，改为从环境变量取模型；缺失时给出清晰错误
- 记忆提炼、日报摘要这类非核心路径，在缺失模型时安全降级，而不是写死某个小模型

### Batch 6: AI Execution Protocol

目标：让最终 skill 只负责编排，不承载隐含判断。

当前已完成的收口：

- [x] 检查 SSH
- [x] 创建普通用户
- [x] 安装 runtime
- [x] 安装 Claude Code CLI
- [x] 安装 `lark-cli`
- [x] clone + `npm install`
- [x] 初始化 `.env`
- [x] `check-runtime.sh`
- [x] `check-config.sh`
- [x] `check-service.sh`
- [x] 只在扫码/授权/密钥输入时停下来问用户

结果：

- `docs/deploy.md` 已新增明确的 AI 执行协议、暂停点和成功标准
- `.claude/skills/openmist-bootstrap.md` 已收成阶段化执行 skill
- README 入口已明确要求 AI 先读部署文档和 repo-local skill，再按阶段执行

---

## 什么状态下才适合开始设计 Skill

以下条件满足后，再把 `openmist-bootstrap` 做成最终版本会更稳：

- `.env` 写入链路稳定
- 服务级检查脚本存在
- 通道启用/禁用规则清晰
- bootstrap 脚本已具备最小可复用性
- Anthropic 兼容提供商路径不再依赖隐式默认

满足这些条件后，skill 应该只做四件事：

1. 读取仓库文档
2. 按固定顺序调用脚本
3. 只在必要时向用户提问
4. 输出结构化的初始化结果

这才是最终想要的状态：

用户一句提示词发给 AI，AI 读取 repo 文档和 skill，按顺序执行初始化，而不是现场发明流程。
