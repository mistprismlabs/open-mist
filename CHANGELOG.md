# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0] - 2026-03-16

### Added

- **多租户记忆隔离** — userId 全链路传递（VectorStore → ShortTermMemory → MemoryManager → Gateway → FeishuAdapter），不同用户的记忆互不可见
- **Prompt Caching** — `complete()` 启用 `cache_control: ephemeral`，系统提示词缓存命中后费用降 90%
- **JSON Schema 结构化输出** — `complete()` 支持 `options.schema`，通过 tool_use 强制结构化返回，替代 `parseJSON` fallback
- **effort 智能省钱** — Gateway 评估消息复杂度（代码块/文件路径/技术关键词/长度），自动设置 `low`/`high` effort
- **Haiku 意图提取** — 对话结束时用 Haiku 模型生成精炼 `userIntent`（20 字以内），提升记忆检索精度
- **keyDecisions 自动提取** — Haiku + JSON Schema 从对话中提取关键决策（最多 3 条），写入短期记忆
- **ADMIN_USER_ID 迁移** — 启动时自动将旧数据（无 userId）归位到管理员，fallback 链：`ADMIN_USER_ID` → `FEISHU_OWNER_ID` → `'default'`

### Changed

- VectorStore `memories` 表新增 `user_id` 列（ALTER TABLE 自动迁移）
- `complete()` 请求头增加 `anthropic-beta: prompt-caching-2024-07-31`
- `complete()` system 参数从字符串改为数组格式（支持 cache_control）
- `chat()` 新增第 4 参数 `chatOptions`（支持 effort）
- `_extractIntent()` 从同步改为异步（Haiku API 调用）

## [1.2.0] - 2026-03-14

### Added

- **MMR 重排序** — 记忆检索结果通过 Maximal Marginal Relevance 去冗余，基于 Jaccard 相似度（tags + entities），避免相似记忆扎堆
- **时间衰减 + 常青豁免** — 30 天半衰期自然衰减旧记忆，`importance >= 8` 的记忆永不衰减
- **用户初始化（Onboarding）** — 首次对话弹出设置卡片（助手名称、称呼、场景、语言），偏好自动注入 system prompt
- **Dev Skills 飞书菜单** — `/dev-go`（快速开发）、`/dev-fix`（Bug 修复）、`/dev-refactor`（代码重构）一键触发
- **自动更新机制** — 每天 5:00 检查 3 个源（Claude CLI / Agent SDK / 仓库），飞书卡片批准后自动执行，bot 重启发完成通知
- **UserProfileStore** (`src/user-profile.js`) — 用户画像持久化存储

### Changed

- Agent SDK 升级到 `^0.2.40`（并发 session 修复、内存泄漏修复）
- 记忆检索管线重构：`_mergeResults → _applyTimeDecay → _applyMMR → map`
- 向量搜索返回 `created_at` 字段
- 同步脚本：`scripts/` 改为全量同步，新增 `.claude/skills/` 同步

## [1.1.0] - 2026-03-10

### Added

- **OpenMist CLI** (`openmist`) — 交互式命令行管理工具
  - 系统状态面板（服务状态、内存、磁盘、对话指标）
  - 三级配置树导航（48 个配置项，5 大分类）
  - API 连通性测试（Claude、飞书、企微、DashScope）
  - 系统诊断（环境检查、资源检查、SSL 证书）
  - 日志查看（静态日志 + 实时 tail）
  - 服务控制（restart/stop/status）
- 子命令模式：`openmist status`、`openmist test`、`openmist config`
- 单元测试覆盖所有纯逻辑函数（22 个测试用例）
- `APP_USER` 和 `SERVICE_NAME` 环境变量支持

### Changed

- `.env.example` 补充管理工具相关环境变量

## [1.0.1] - 2026-03-09

### Fixed

- 清理剩余私有硬编码

## [1.0.0] - 2026-03-07

### Added

- 初始开源发布
- Claude Agent SDK 网关核心
- 飞书 + 企业微信多通道支持
- 安全守卫（hooks.js）
- 三层记忆系统
- 自愈守护进程
- MCP 工具集成
