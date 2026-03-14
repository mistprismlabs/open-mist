# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
