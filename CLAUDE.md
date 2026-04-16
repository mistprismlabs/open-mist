# OpenMist - Claude Agent SDK Gateway

## 项目概述

基于 Claude Agent SDK 的生产级智能助手网关，支持飞书/企业微信多通道。

## 开发指南

### 环境要求

- Node.js >= 18
- Claude CLI（用于 heartbeat 守护进程）

### 启动

```bash
npm start
```

### 项目结构

```
src/        — 核心代码
agents/     — 推荐引擎
scripts/    — 运维脚本
docs/       — API 参考文档
```

### 回复格式

- 回复通过飞书卡片展示，支持 Markdown
- 表格自动转换为飞书原生表格组件
- 保持回复简洁

## 可用 MCP Servers

- **video-downloader**: 视频下载
- **tencent-cos**: 腾讯云对象存储

## 环境变量

参见 `.env.example`

## 当前模型版本

代码中不要硬编码模型 ID，统一用环境变量（`CLAUDE_MODEL`、`RECOMMEND_MODEL`）。

| 模型 | 环境变量 | 用途 |
|------|---------|------|
| Opus 4.6 | `CLAUDE_MODEL` | 主对话模型 |
| Sonnet 4.6 | `RECOMMEND_MODEL` | 推荐管线 |
