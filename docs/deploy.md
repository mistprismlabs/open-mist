# OpenMist 首次部署（空 Ubuntu 服务器）

本文档对应的默认场景是：

- 你刚买了一台 Ubuntu 服务器
- 服务器上除了操作系统之外，基本没有额外运行时
- 你在本地电脑上，已经能通过 SSH 连上服务器
- 后续部署和运行都尽量使用一个普通用户，而不是长期使用 `root`

如果你希望 AI 帮你完成部署，优先让它先阅读本文档，再执行仓库内的检查脚本：

- `scripts/check-runtime.sh`
- `scripts/check-config.sh`
- `scripts/check-service.sh`
- `scripts/bootstrap-config.js`
- `scripts/bootstrap-user.sh`
- `scripts/bootstrap-runtime.sh`
- `scripts/bootstrap-service.sh`
- `.claude/skills/openmist-bootstrap.md`

如果你想先了解当前初始化准备度和剩余缺口，再看：

- `docs/bootstrap-readiness.md`

## 1. SSH 前提与连接方式

开始部署前，先满足这几个前提：

- 本地电脑已经安装了 `ssh`
- 你知道服务器的公网 IP 或域名
- 你至少有一个能登录服务器的账号
- 如果登录账号不是 `root`，它需要具备 `sudo` 权限

推荐使用 SSH 密钥登录，密码登录只作为兼容方案。

常见连接方式：

```bash
ssh root@<host>
```

```bash
ssh <user>@<host>
```

如果是第一次连接，系统通常会要求确认 host key；确认后再继续。

如果你准备让 AI 代为部署，先确保当前环境已经能成功执行：

```bash
ssh <user>@<host>
```

文档后续步骤默认你已经登录进服务器。

如果当前只有 `root`，推荐先创建专用普通用户，再继续后续部署：

```bash
BOOTSTRAP_DRY_RUN=1 APP_USER=openmist bash ./scripts/bootstrap-user.sh
```

## 2. 默认部署假设

OpenMist 的公开部署入口默认假设如下：

- 目标系统：Ubuntu
- 服务管理：`systemd`
- 应用运行用户：普通用户（可 `sudo`）
- 部署目录：用户 home 下任意可写目录
- 实例配置：从 `.env.example` 复制生成 `.env`

以下内容不应写死在源码中，而应来自 `.env` 或部署时输入：

- 私有域名、路径、SSH alias
- systemd 服务名
- 飞书/Lark 凭据
- 通知目标、open_id、chat_id
- 私有 persona 或私有运维约定

## 3. 部署顺序

空服务器首次部署，建议严格按下面顺序：

1. 登录服务器并创建普通应用用户（如果当前只有 `root`）
2. 安装系统依赖：`git`、`curl`、`build-essential`、Node.js
3. 安装并检查 `Claude Code CLI`
4. 安装并检查 `lark-cli`
5. 克隆 `open-mist` 仓库并执行 `npm install`
6. 复制 `.env.example` 为 `.env`
7. 只填写本次实例真正需要的配置
8. 运行 `scripts/check-runtime.sh`
9. 运行 `scripts/check-config.sh`
10. 用 `systemd` 启动并运行 `scripts/check-service.sh`

如果你希望 AI 尽量少拼接命令，可以优先调用：

- `scripts/bootstrap-user.sh`
- `scripts/bootstrap-runtime.sh`
- `scripts/bootstrap-service.sh`

## 3.1 AI 执行协议

如果你是把部署工作交给 AI，这里应该遵守固定顺序，不要跳步骤：

### Phase 1: SSH Gate

- 先确认用户本地到服务器的 `ssh <user>@<host>` 已可用
- 如果当前环境无法 SSH 登录，先停在这里，不要继续猜测远端环境

### Phase 2: User Bootstrap

- 如果当前只有 `root`，先创建普通用户
- 优先用 `scripts/bootstrap-user.sh`
- 如果已经有合适的普通用户，可直接复用

### Phase 3: Runtime Bootstrap

- 先跑 `scripts/check-runtime.sh`
- 缺项时优先用 `scripts/bootstrap-runtime.sh`
- 再跑一次 `scripts/check-runtime.sh`

### Phase 4: Repo Bootstrap

- `git clone`
- `cd open-mist`
- `npm install`

### Phase 5: Config Bootstrap

- `cp .env.example .env`
- 如需写入配置，优先使用 `node scripts/bootstrap-config.js`
- 如果同机还有别的 OpenMist 实例，显式写入当前实例自己的 `WEB_PORT`
- 运行 `scripts/check-config.sh`

### Phase 6: Service Bootstrap

- 优先使用 `scripts/bootstrap-service.sh`
- 先生成 unit，再决定是否 `systemctl enable --now`

### Phase 7: Verification

- `scripts/check-runtime.sh`
- `scripts/check-config.sh`
- `scripts/check-service.sh`
- `npm test`

## 3.2 需要用户参与的暂停点

AI 只应在以下情况暂停：

- 需要用户提供 API key、app secret、chat id、open id 等实例密钥
- `claude` 登录需要用户完成设备码或网页登录
- `lark-cli config init` / `lark-cli auth login` 需要用户扫码或打开授权链接
- 系统无法自动推断 SSH 用户、部署目录、服务名

除这些情况外，AI 应该继续执行，不要把可自动探测的步骤抛给用户决定。

## 3.3 成功标准

只有同时满足以下条件，才算首次部署完成：

- `scripts/check-runtime.sh` 通过
- `scripts/check-config.sh` 通过
- `scripts/check-service.sh` 通过，或只剩平台侧 warning
- `npm test` 通过
- `systemd` 服务处于可运行状态，核心网关已经启动

## 4. 系统依赖

建议先准备基础系统依赖：

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential
```

如果你要把这一步交给 repo 脚本：

```bash
BOOTSTRAP_DRY_RUN=1 bash ./scripts/bootstrap-runtime.sh
```

Node.js 建议使用官方长期支持版本。安装完成后至少确认：

```bash
node --version
npm --version
git --version
```

## 5. Claude Code CLI

OpenMist 把 Claude Code 当作运行时使用，因此 `Claude Code CLI` 是运行前置条件。

在普通用户部署场景下，推荐使用用户级全局安装，避免把 CLI 装进 root 私有环境：

```bash
mkdir -p ~/.local/bin
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
npm install -g @anthropic-ai/claude-code
```

安装完成后至少确认：

```bash
claude --version
```

如果还没有登录或授权，按 CLI 提示完成认证。
仓库内的 `scripts/check-runtime.sh` 会检查 `claude` 是否可执行，并提醒你完成后续认证。

## 6. Lark CLI

Claude 侧的飞书/Lark 平台操作，统一走官方 `lark-cli` / `lark-*` skills。

同样推荐用普通用户自己的 npm prefix 安装：

```bash
mkdir -p ~/.local/bin
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
npm install -g @larksuite/cli
```

安装完成后至少确认下面两步：

```bash
lark-cli --help
```

```bash
lark-cli config init --new
```

如需用户身份授权，按需执行：

```bash
lark-cli auth login --scope "<scope>"
```

如果 AI 在帮你部署，它应该把授权链接发给你，只在需要扫码或授权时暂停。

## 7. 克隆仓库与安装依赖

```bash
git clone https://github.com/mistprismlabs/open-mist.git
cd open-mist
npm install
```

如果 `npm install` 失败，优先检查系统编译工具链是否完整，再回头运行：

```bash
./scripts/check-runtime.sh
```

## 8. 初始化 .env

从公开模板生成实例配置：

```bash
cp .env.example .env
```

默认规则：

- 能从系统推断的，不要求用户填写
- Claude / Agent SDK 已有合理默认行为的，不重复造默认值
- 涉及实例密钥和私有标识的，放进 `.env`
- 同机多实例时，实例级监听端口必须显式写入，不要复用默认值

部署时至少检查：

- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`
- 如果要启用飞书通道：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`
- 如果要启用飞书机器人默认通知对象：相关 `open_id` / `chat_id`
- 如果要启用企业微信 App 通道：`WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_AGENT_SECRET`、`WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY`
- 如果要启用企业微信 Bot 通道：`WECOM_BOT_ID`、`WECOM_BOT_SECRET`
- 如果要启用 COS、DashScope、Weixin：对应凭据

如果你不是直接连 Anthropic，而是使用 Anthropic 兼容提供商（例如 MiniMax），再额外填写：

- `ANTHROPIC_BASE_URL`
- `CLAUDE_MODEL`
- `RECOMMEND_MODEL`

MiniMax 的常见写法示例：

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
CLAUDE_MODEL=MiniMax-M2.7
RECOMMEND_MODEL=MiniMax-M2.7-highspeed
```

如果同一台机器上要跑多个 OpenMist 实例，再额外为当前实例写一个未占用的 web 端口：

```bash
WEB_PORT=3003
```

例如第二个实例可以改成 `3303`、`3304` 等未占用端口。

配置完成后执行：

```bash
./scripts/check-config.sh
```

如果你需要把初始化得到的配置安全写回 `.env`，使用：

```bash
node scripts/bootstrap-config.js set --env-file .env KEY VALUE
```

如果你已经完成 `lark-cli config init`，并希望把飞书应用配置导入 `.env`：

```bash
node scripts/bootstrap-config.js import-lark --env-file .env
```

## 9. 运行检查脚本

仓库提供两个公开检查脚本：

```bash
./scripts/check-runtime.sh
```

用于检查：

- Ubuntu / systemd 前提
- `node` / `npm` / `git`
- `claude`
- `lark-cli`
- 常见编译工具链

```bash
./scripts/check-config.sh
```

用于检查：

- `.env.example` 是否存在
- `.env` 是否已创建
- 必填配置是否完整
- 飞书、企业微信等可选通道是否出现“填了一半”的配置错误
- `WEB_PORT` 是否已为当前实例显式写入

```bash
./scripts/check-service.sh
```

用于检查：

- `systemd` 服务是否 active
- 最近日志里是否完成 gateway 启动
- WebAdapter 是否监听成功
- VectorStore 是否正常初始化或已经降级
- 启动日志里是否出现 fatal error
- Feishu 是否被平台侧前提阻塞（例如事件订阅 / 长连接未就绪）

`scripts/check-service.sh` 会优先读取 `.env` 中的 `WEB_PORT`；如果你想临时覆盖，也可以显式传入：

```bash
WEB_PORT=3304 ./scripts/check-service.sh
```

如果你已经填了 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，但日志里出现下面这类信息：

- `system busy`
- `PingInterval`
- `Startup blocked by platform prerequisites`

优先把它判断为“飞书开放平台侧前提未完成”，而不是 OpenMist 主程序本身崩溃。此时先检查：

- 飞书应用是否已正确启用事件订阅
- 长连接（WebSocket）所需能力是否已开通
- 应用权限与 Open Platform 状态是否正常

## 10. 用 systemd 启动

建议使用 `.env` 中的 `SERVICE_NAME`，不要写死私有服务名。
如果同机已经存在其他 OpenMist 实例，先确认当前 `.env` 里的 `WEB_PORT` 没有冲突，再启动 service。

最小服务文件示例：

```ini
[Unit]
Description=OpenMist Gateway
After=network.target

[Service]
Type=simple
User=openmist
WorkingDirectory=/home/openmist/open-mist
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/home/openmist/open-mist/.env

[Install]
WantedBy=multi-user.target
```

启用后验证：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now <your-service-name>
sudo systemctl status <your-service-name>
```

如果你希望先生成 unit 再手工检查：

```bash
BOOTSTRAP_SKIP_SYSTEMCTL=1 SERVICE_NAME=openmist.service APP_USER=openmist PROJECT_DIR=/home/openmist/open-mist bash ./scripts/bootstrap-service.sh
```

## 11. 给 AI 的标准提示词

你可以把下面这段发给 AI，让它在服务器上执行首次部署：

```text
通过 SSH 登录我的 Ubuntu 服务器，按 open-mist 仓库里的 docs/deploy.md 和 .claude/skills/openmist-bootstrap.md 完成首次部署。

要求：
1. 严格按执行协议分阶段推进，不要跳步骤
2. 先确认我本地到服务器的 SSH 已可用
3. 优先调用仓库里的 bootstrap/check 脚本，不要现场重写整套流程
4. 只在需要密钥、授权链接、扫码或无法自动推断的部署参数时暂停问我
5. 不要写死任何私有路径、域名、服务名、SSH alias 或 persona
6. 最后必须执行 scripts/check-runtime.sh、scripts/check-config.sh、scripts/check-service.sh 和 npm test
```
