---
name: openmist-bootstrap
description: Use when deploying OpenMist onto a freshly provisioned Ubuntu server over SSH, after the user already has a working SSH login path and wants the AI to drive initialization with minimal questions.
---

# OpenMist Bootstrap

用在 `open-mist` 的首次部署场景：一台刚装完 Ubuntu 的服务器、一个已经能 SSH 登录的账号、尽量少的用户决策。

先读取这些文件，再开始执行：

- `docs/deploy.md`
- `scripts/check-runtime.sh`
- `scripts/check-config.sh`
- `scripts/check-service.sh`
- `scripts/bootstrap-user.sh`
- `scripts/bootstrap-runtime.sh`
- `scripts/bootstrap-service.sh`

## 执行原则

- 优先调用仓库内脚本，不要现场重写长命令流程
- 能自动探测的，不问用户
- 只在必要时暂停
- 一次只向用户要一个缺失输入
- 不写死任何私有路径、域名、服务名、SSH alias、persona、通知目标
- 默认按官方 Anthropic 路径部署；如果用户自己改兼容 provider，不额外阻止

## Phase 1: SSH Gate

目标：确认当前环境真的可以开始远程部署。

必须满足：

- 用户已经能从本地电脑执行 `ssh <user>@<host>`
- 当前会话具备可用的 SSH 目标

如果以下任一条件不满足，立即暂停：

- 用户没有提供可登录的 SSH 目标
- SSH 登录失败
- 远端账号没有 `sudo`，且当前阶段无法继续

## Phase 2: User Bootstrap

目标：把部署落到普通用户，而不是长期用 `root`。

优先动作：

```bash
BOOTSTRAP_DRY_RUN=1 APP_USER=openmist bash ./scripts/bootstrap-user.sh
```

需要真实执行时，再去掉 `BOOTSTRAP_DRY_RUN`。

如果服务器上已经有合适的普通用户，可以直接复用，不强制创建新用户。

## Phase 3: Runtime Bootstrap

目标：补齐空 Ubuntu 服务器的运行时和 CLI。

固定顺序：

1. 运行 `scripts/check-runtime.sh`
2. 如有缺项，优先使用 `scripts/bootstrap-runtime.sh`
3. 再次运行 `scripts/check-runtime.sh`

这一阶段只负责：

- `git`
- `curl`
- `build-essential`
- `node`
- `npm`
- `claude`
- `lark-cli`

## Phase 4: Repo Bootstrap

目标：把仓库和项目依赖装到位。

固定顺序：

1. `git clone`
2. `cd open-mist`
3. `npm install`

如果 `npm install` 失败，先回到运行时和编译工具链检查，不要跳过错误继续后面的 `.env` 和 `systemd`。

## Phase 5: Config Bootstrap

目标：得到一个可运行、shell-safe 的 `.env`。

固定顺序：

1. `cp .env.example .env`
2. 如需写配置，优先使用 `node scripts/bootstrap-config.js`
3. 运行 `scripts/check-config.sh`

## 暂停点

只在以下情况暂停并等待用户：

- 需要用户提供 API key、app secret、chat id、open id 等实例密钥
- `claude` 需要登录或设备码授权
- `lark-cli config init` / `lark-cli auth login` 需要用户点击链接或扫码
- 用户必须决定 SSH 用户、部署目录或服务名，而且系统无法自动推断

如果出现暂停点：

- 只提当前这一个阻塞项
- 用户完成后，从当前阶段继续，不要重跑已经通过的阶段

## Phase 6: Service Bootstrap

目标：生成并启动 `systemd` 服务。

优先使用：

```bash
BOOTSTRAP_SKIP_SYSTEMCTL=1 SERVICE_NAME=openmist.service APP_USER=openmist PROJECT_DIR=/home/openmist/open-mist bash ./scripts/bootstrap-service.sh
```

先生成 unit，确认路径和用户正确，再决定是否执行 `systemctl daemon-reload` 和 `enable --now`。

## Phase 7: Verification

目标：判断部署是否真正完成，而不是只看命令跑完。

固定顺序：

1. `scripts/check-runtime.sh`
2. `scripts/check-config.sh`
3. `scripts/check-service.sh`
4. `npm test`

## 成功标准

只有同时满足以下条件，才算首次部署完成：

- `scripts/check-runtime.sh` 通过
- `scripts/check-config.sh` 通过
- `scripts/check-service.sh` 通过，或只剩平台侧 warning
- `npm test` 通过
- 服务处于可运行状态，核心网关已启动

## 失败处理

- 未配置的可选通道：跳过
- 半配置通道：立刻停下并修配置，不继续部署
- 平台侧前提缺失：明确告诉用户这是平台配置问题，不混成程序崩溃
- 私有实例需求：指出超出 `open-mist` 主仓边界
