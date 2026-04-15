# OpenMist CLI 使用指南

OpenMist 提供交互式命令行管理工具，用于查看系统状态、管理配置、诊断问题和控制服务。

## 安装

项目 clone 后即可使用：

```bash
# 方式一：npm link（推荐）
cd open-mist
npm link

# 方式二：直接运行
node admin.js
```

安装后可通过 `openmist` 命令启动。

## 快速上手

```bash
# 进入交互式菜单
openmist

# 子命令模式（非交互）
openmist status    # 查看系统状态
openmist test      # 运行所有诊断
openmist config    # 查看当前配置
```

## 功能

### 系统状态

显示系统面板信息：
- 服务运行状态和运行时间
- 内存和磁盘用量（带进度条）
- 对话指标和活跃会话数
- 定时任务数量

### 配置管理

三级树状导航浏览和编辑 `.env` 配置：

```
IM 通道
├── 飞书
│   ├── 机器人（APP_ID, APP_SECRET, OWNER_ID）
│   └── 多维表格（APP_TOKEN, TABLE_ID...）
└── 企业微信
    ├── 应用（CORP_ID, AGENT_ID, AGENT_SECRET）
    └── 回调 & 机器人（TOKEN, AES_KEY...）
AI 能力
├── Claude（API_KEY, BASE_URL, MODEL...）
└── 语义记忆 DashScope（API_KEY）
附加功能
├── 腾讯云 COS
├── 网站部署
├── 视频下载
└── GitHub
系统
├── 通知
└── 运行时
```

- 敏感值（含 KEY/SECRET/TOKEN/PASSWORD）自动脱敏显示
- 修改配置后自动备份 `.env.bak`，原子写入
- 修改后自动重启服务并测试相关 API 连通性

### 系统诊断

- **API 连通性**: 并行测试 Claude、飞书、企微、DashScope 四个 API
- **环境检查**: Node.js、ffmpeg、nginx、SSL 证书有效期
- **资源检查**: 磁盘用量、内存用量、data/ 目录权限、vectors.db 可写性

### 日志查看

- 飞书机器人日志（最近 50 行）
- 心跳巡检日志（最近 50 行）
- 审计日志（最近 20 条，JSON 格式化显示）
- 实时日志（`tail -f`，Ctrl+C 返回）

### 服务控制

通过 systemctl 管理服务：重启、停止、查看详细状态。操作前需确认。

> **注意**: 服务控制功能仅在 Linux 上可用。macOS 上此菜单会显示"仅支持 Linux"。

## 安全特性

- 以 root 运行时显示警告，建议切换到普通用户
- `.env` 不存在时引导从 `.env.example` 复制
- 配置修改使用原子写入（先写临时文件再 rename）
- 文件权限设为 0600（仅 owner 可读写）
- 敏感值脱敏显示（`sk-a****3456`）

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_USER` | 运行用户名（用于权限检查和提示） | `openmist` |
| `SERVICE_NAME` | systemd 服务名 | `openmist.service` |
| `NO_COLOR` | 设置后禁用彩色输出 | - |
