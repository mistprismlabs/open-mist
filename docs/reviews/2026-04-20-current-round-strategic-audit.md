# OpenMist 当前轮次战略审计与 PR 盘点（2026-04-20）

## 目的

这份文档不是做“代码注释汇总”，而是给 maintainer 和后续 Codex 执行窗口一个统一判断入口：

1. 现在这个项目的主线到底是什么。
2. 当前这一轮 PR 和规划文档是否沿着同一条主线推进。
3. 哪些 PR 可以合，哪些不能合，为什么。
4. 下一步重构和推进，应该先做什么，不该先做什么。

---

## 一句话结论

OpenMist 当前的**正确主线**是：

> **把 Claude Code / Agent SDK 作为运行时，做一个面向 IM / Web / 自托管场景的生产级运行网关与运维外壳。**

当前这轮工作的**方向大体是对的**，核心都在补“生产可靠性”：
- 会话恢复
- 多通道路由
- 异常告警回到源会话
- heartbeat 自愈边界收缩
- 升级场景状态迁移
- 公共仓边界收紧

但当前最大的问题不是“方向错”，而是：

> **规划、PR 切分、公开文档、实际代码，四条线没有完全同步。**

所以现在最重要的不是继续扩功能，而是先把这一轮工作按主线收口、拆清楚、合干净。

---

## 项目主线判断

### 核心资产（应该继续投资）

1. **Gateway / Claude runtime 集成**
   - 会话管理
   - 上下文注入
   - 运行时能力协商
   - 错误恢复
   - 进度与告警路由

2. **Memory 系统**
   - 短期记忆
   - 向量检索
   - 会话结束归档
   - 多租户隔离

3. **安全与审计 Hooks**
   - 运行时硬拦截
   - 工具调用审计

4. **渠道适配器**
   - Feishu
   - WeCom
   - Weixin

5. **自托管运维外壳**
   - bootstrap/check/service
   - heartbeat/self-healing
   - 管理 CLI

### 次级能力（应该控边界）

1. Web 需求澄清 / 需求提交
2. Feishu Bitable 工单流
3. Demo 生成与自动部署
4. 一些实例化运营脚本

这些不是没价值，而是**不能继续反客为主**。

---

## 当前项目的真实状态

### 方向上是同一条线，但层次混在一起

当前代码和文档展示出来的不是一个“单纯聊天机器人”，而是一个混合体：

- IM 网关
- Web 需求入口
- Demo 生成与交付管线
- 单机自愈运维层
- AI 驱动的部署与升级辅助系统

这意味着 OpenMist 已经从“单点 bot”演变成了**小型运行平台**。

### 问题不在于做了太多，而在于没有清楚表达“哪些是平台主线，哪些是业务侧扩展”

当前仓库最容易让人看不清的根因不是代码量，而是：

- README/CLAUDE/`.env.example`/规划文档没有同步表达真实结构
- PR 经常跨多条线叠在一起
- 一部分“边界治理”计划已经写出来了，但实际模板和代码还没跟上

---

## 当前轮次 PR 审计

### PR #3 — stale Claude session recovery

**结论：可以优先合。**

这是一个典型的核心可靠性修复，目标清楚、边界清楚、收益明确：
- 解决持久化 session 已失效时的错误恢复
- 自动清掉过期绑定，再建立新会话
- 有对应回归测试

**价值：**
- 属于 Gateway 主线
- 直接提升真实生产对话可用性
- 风险低，作用明确

**建议：**
- 保持单独合并，不要并入更大的堆叠 PR。

---

### PR #5 — multi-channel progress routing

**结论：可以优先合。**

这是一个渠道隔离正确性修复，解决 Feishu / Weixin 进度通知串线的问题。

**价值：**
- 也是 Gateway 主线
- 修的是“多通道架构正确性”，不是业务花活
- 测试覆盖点合理

**建议：**
- 合并后把 `progressTargetId` 机制当成后续异常告警回源路由的标准接口。

---

### PR #6 — heartbeat hardening + upgrade migration note

**结论：可以继续推进，但最好再做一次 scope 宣告。**

这个 PR 实际包含两件事：
1. heartbeat 自愈守护硬化
2. 升级到新 checkout 时的状态迁移提醒/协议补充

这两个点都属于“生命周期可靠性”线，放在一个 PR 里还能接受，**比 #7 干净得多**。

**优点：**
- 方向对：从“能跑”走向“长期可维护、可升级”
- orphan cleanup 从“任何裸 Claude 进程”收缩到 OpenMist 特定残留，方向正确
- 把 heartbeat 拆成 logging / checks / prompt / index 小模块，是合理的小步重构

**风险：**
- 这是“战术修正”，不是“平台边界最终答案”
- 升级状态迁移只是补协议，不是从根上解决 `data/` / `session` / checkout 路径耦合

**建议：**
- 可以合，但要明确：
  - 这是 reliability patch，不是最终 architecture fix
  - 后续仍要单独立项做 `DATA_DIR` / 状态目录抽象

---

### PR #7 — source chat failure notices + runtime capabilities（当前最新）

**结论：不要按现在这个形态直接合。必须拆。**

原因不是它没价值，而是它**把多个已存在或已在别的 PR 出现的主题又叠了一遍**：
- progress routing 继续扩展
- stale session recovery 的历史提交也挂在这个分支里
- heartbeat / upgrade / hygiene 文档提交也在这个分支时间线上
- 最新真正新增的内容又混进了两类不同性质的变更：
  1. 异常告警回到源 chat
  2. runtime CLI capability prompt 注入

这两个点本身就应该拆开。

#### PR #7 中值得保留的部分

1. **异常告警优先回到源 chat**
   - 这是对 PR #5 的自然延续
   - 属于“消息与运维反馈一致性”
   - 应该保留

2. **progress callback 注册机制升级**
   - 这是多通道路由继续成熟的一部分
   - 方向正确

#### PR #7 中不该跟它捆在一起的部分

1. **runtime CLI capability prompt 注入**
   - 这是“模型行为引导”层改动
   - 不是纯修 bug
   - 会扩大 system prompt 责任面
   - 应该单独评估

2. **历史堆叠提交**
   - 让 review 目标变模糊
   - 会让 merge 顺序和回滚边界变差

#### 对 PR #7 的明确处理建议

- 不要直接 merge 当前 #7
- 先 rebase 到最新 main
- 只保留“异常告警回源 chat”这一个主题，重开一个干净 PR
- runtime capability prompt 注入单独新 PR，或者先转 issue / design note

---

## 当前规划文档与主线是否一致

### 一致的部分

#### 1. Public hygiene / public boundary
方向是对的。

因为 OpenMist 明确想做“公共主仓 + 私有实例层”的分层，公共仓必须持续收紧：
- 不带私有默认值
- 不带私有 branding
- 不带本机路径
- 不带实例化运维约定

这是对的，而且必须继续做。

#### 2. Upgrade state migration
方向也是对的。

这说明项目已经从“首次部署”思维，进入“长期运维 + 升级迁移”思维。
这不是跑偏，而是成熟化的信号。

#### 3. Heartbeat hardening
方向同样对。

这说明你没有急着“推翻 heartbeat”，而是在先把真实线上会炸的问题压住：
- 日志目录启动安全
- orphan cleanup 误杀边界
- 模块拆分

这是正确的小步重构方式。

---

## 最关键的不一致点

### 1. README / 结构文档明显落后于真实代码

当前 README 仍然更像在描述一个以 Feishu / WeCom 为主的聊天型代理，但真实代码已经出现：
- Weixin 通道
- Web channel
- Web 需求与交付流
- 多层运维脚本
- heartbeat 自愈体系

这会导致：
- 新加入的执行窗口误判项目边界
- review 时看不清哪些是“核心”，哪些是“实例扩展”

### 2. 公开边界治理还没完全落地到模板层

public-hygiene 的方向明确是对的，但当前仓库仍然存在：
- `.env.example` 里残留实例化变量
- metadata / version / license / changelog 不同步
- `CLAUDE.md` 结构描述过时

也就是说，**边界治理还是“进行中”，不是“已完成”。**

### 3. PR 切分习惯仍然影响主线可见性

当前最伤主线清晰度的，不是单个坏文件，而是：
- 一条 PR 叠多个主题
- 旧提交历史不清理
- bugfix 和 prompt 行为改动混发

这会让项目看起来像在“漂移”，其实很多时候只是“没拆干净”。

---

## 当前阶段的战略判断

### 不是重复造轮子

OpenMist 当前**不是在重造 Claude Code / Agent SDK 本身**。
真正自研的价值点仍然成立：
- 多渠道接入
- 会话路由与恢复
- 记忆与上下文编排
- 安全 hooks
- 单机自愈与升级守护

这些不是 SDK 直接给的。

### 但正在重复“业务胶水”与“实例胶水”

当前真正需要警惕的不是 runtime，而是：
- 业务入口逻辑继续塞进 adapter
- 实例部署私货继续留在主仓
- 更多需求流 / demo 流 / 工单流不断挤压核心 runtime 可见性

所以：

> **OpenMist 值得继续做，但下一阶段不能再靠“继续加东西”推进，而要靠“边界重构”推进。**

---

## 下一步重构优先级

### 第一优先级：先合干净当前这一轮 focused reliability PR

优先顺序建议：
1. PR #3
2. PR #5
3. PR #6
4. 从 #7 里拆出“异常告警回源 chat”单独合
5. runtime capability prompt 注入单独评估

### 第二优先级：补一份真实的架构文档

建议新增：
- `docs/ARCHITECTURE.md`

明确写清：
- 核心层：Gateway / Claude / Hooks / Memory
- 适配层：Feishu / WeCom / Weixin / Web
- 运维层：bootstrap / check / heartbeat / admin
- 扩展层：web intake / demo deploy / bitable flow
- 哪些属于开源主仓核心
- 哪些属于实例扩展

### 第三优先级：进入“边界重构”而不是“功能扩张”

最需要做的是：
- 把 Gateway 再继续抽出 conversation orchestration / prompt building / progress routing 职责
- 把 WebAdapter 从“适配器”与“业务应用”中分开
- 把 upgrade-state 和 data/session path 问题单独立项，不再只靠部署协议兜底

---

## 给后续 Codex 执行窗口的明确约束

### 允许做

1. 只处理一个清晰问题
2. 先补测试，再补实现
3. runtime 修复可以带同主题文档更新
4. 允许做小步内部拆分，但不能顺手做大改架构

### 不允许做

1. 不要顺手改无关 README / 文案 / lint
2. 不要把两个不同目标塞进同一 PR
3. 不要扩展 Web 产品流
4. 不要把私有实例默认值带回公共仓
5. 不要在 Gateway 再塞新的“顺手功能”

### Codex 下一步建议指令

```text
请只处理当前轮次的“核心可靠性收口”，不要扩功能。

优先顺序：
1. 合并或重建 focused PR：stale session recovery / multi-channel progress routing / heartbeat hardening
2. 把最新 PR 中“异常告警回源 chat”单独抽成一个干净 PR
3. runtime capability prompt 注入不要混在 bugfix PR 里，单独做 design review
4. 不要新增 Web/Demo/需求提交流功能
5. 如果要改文档，只允许同步当前这一条 runtime 变更，不要顺手重写全仓文档

验收标准：
- 每条 PR 只有一个主题
- 能单独回滚
- 有针对性的回归测试
- 不引入新的私有默认值
- 不扩大 Gateway 的职责面
```

---

## Maintainer 当前决策

### 可以继续推进
- #3
- #5
- #6

### 不能按现状直接合
- #7

### 当前真正该收口的，不是功能，而是边界

> OpenMist 当前不是战略失焦，而是工程收口失焦。
>
> 现在这轮工作应以“可靠性收口 + PR 拆清 + 文档同步”为目标结束，
> 而不是继续加新能力。

## 补充盘点：PR #9 — reminder-first jobs runtime（2026-04-20 复审收口）

**结论：方向正确，当前已具备进入 ready-for-review 判断的条件。**

这条 PR 的战略位置不是“顺手再加个命令”，而是把 OpenMist 从“会话网关 + 自愈外壳”向“秘书型任务层”推进了一步。它首次把提醒型 jobs 作为独立子系统引入：

- persistent jobs / runs / notifications
- owner -> endpoint 投递映射
- once / daily / weekday / weekly 调度
- scheduler 启动 wiring
- Feishu 管理入口 `/remind`、`/jobs`、`/job pause|resume|delete`

### 与主线是否一致

一致。

因为 OpenMist 当前的合理演进，不只是把 Claude 接进聊天，而是形成：

1. 运行时网关
2. 记忆层
3. 多通道触达
4. 自托管运维层
5. 轻量任务层

PR #9 落在第 5 层，是“秘书型任务 / 被动提醒 / 多终端投递”的第一块拼图，不是跑偏。

### 这条 PR 复审中的关键收口

#### 已修掉的主要 blocker

1. **Feishu admin / owner 权限边界已补上**
   - `/remind` 默认只开放给 `JOBS_ADMIN_IDS`
   - `/jobs` 对非管理员只展示自己创建的任务
   - `/job pause|resume|delete` 要求管理员或 creator

2. **help card 的 `/remind` 路径已真正接通**
   - 不再出现按钮可见但 handler 未连接的情况

3. **WeCom capability gating 已明确**
   - app-only WeCom 仍可接消息
   - reminder 投递明确要求 bot credentials
   - 运行时与部署文档对齐

4. **stale one-time reminder 语义已收干净**
   - 创建过去的 once reminder 现在直接拒绝
   - 恢复已过期的 once reminder 现在也直接拒绝
   - 不再产生 `active + null next_run_at` 的僵尸任务

### 当前判断

按当前 diff 和最近一轮 focused regression 来看：

- 这条 PR 仍然是单一主题的 feature slice
- 不需要再拆 PR
- 当前没有继续阻塞合并的 blocker
- 可以从 Draft 往 ready-for-review 走

### 非阻塞 follow-up

后续建议单独立项，不放在本 PR 内继续膨胀：

1. **jobs 抽象是否继续泛化**
   - 当前 schema 是泛 jobs
   - 但 scheduler 仍然是 reminder-first
   - 后续要么明确它就是 reminder runtime
   - 要么把 type filtering / executor model 一并补成 generic jobs runtime

2. **owner-target 私有映射的治理**
   - 继续保持私有文件，不回流主仓
   - 后续如果多实例部署增多，可以再考虑目录和校验工具化

### Maintainer 当前决策补充

#### 可以继续推进
- #3
- #5
- #6
- #9（进入 ready-for-review 判断）

#### 不能按现状直接合
- #7

### 给后续 Codex 窗口的约束补充

如果接着在 jobs 线上推进：

- 只允许继续做 reminder 线的 focused patch
- 不要顺手扩展成通用任务平台
- 不要把更多管理入口继续堆进 Feishu adapter
- 如果要扩 jobs 类型，先出 design note / issue，再开新 PR
