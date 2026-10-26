# 路线图

> 本文是 [roadmap.md](roadmap.md) 的中文译本，如与原文有出入，以原文为准。

主指标是注意力密度；增长速度是预算，token 成本是经济约束。
下面的顺序按这个优先级排：v0.2 是机器部分，v0.3 是主指标以及它需要的注入方式，
v0.4 是证据和周边工具。

## v0.2（已完成）

- 核心 contract、用户级状态注册表（state registry）、artifact store、capsule、指标。
- Qoder adapter：复用官方 `general-purpose`/`Explore`；仅当官方缺少
  no-tools 等价物时才安装 `mhe-reasoner`。
- auto conductor：不做 agent/model 选择；已注册项目里的每个主会话
  都是 conductor。
- 用户级状态：`~/.my-harness-enhance/projects/<hash>/`；仓库里没有 `.router`。
- 全局模式：每台机器安装一次；任意 workspace 的新会话
  自动注册；MCP 工具按 `project`/env/cwd 路由；已有会话不会被
  retrofit。
- 会话级状态分片：goal、brief、plan、jobs、capsule、worktrees 按会话隔离；
  config、artifacts、metrics、logs 按项目共享。
  同一 workspace 的两个并发会话已验证。
- 代码任务的隔离 git worktree，包括把脏基线带进 worktree，
  以及 land 失败时按路径精确还原。
- Qoder 与 ZCode 共用一套 hook-policy 核心，并有 conformance 测试。
- 保留期限与垃圾回收：`mhe gc` 默认只出计划；metrics 与 logs 30 天 +
  5 MiB，artifacts 30 天并有 7 天宽限，decisions 180 天（默认关闭），
  worktrees 7 天。
- 330 个测试；demo；基准测试；带 1 个 fallback agent 的 Qoder 安装；
  已安装环境的 hook 模拟；两个真实会话加一次双会话 run。
- 一个 conductor + 原生 worker；worker 都是叶子节点（禁止 Agent/Task），所以
  不存在静默的嵌套扇出。

## v0.3（下一步）：注意力指标

这一版才让那个主张可测。在它落地之前，项目只能展示 token 增长，
展示不了注意力密度。

### 注入：别再付两次

- 会话开始和每次压缩时各做一次全量注入；
  普通回合只给短锚加状态差异。
  现状是每条用户消息都重发完整策略和整份 capsule。
- MCP 工具只回变化的那个任务或句柄，而不是回显整份 plan 和 state。
- 每个被截断的段落都标 `shown X of Y`，
  让 conductor 知道自己没看到什么。
- capsule 降级分三档，而不是全有/全无。

### 度量：让目标可证伪

- 逐轮的注意力遥测：注入了什么、哪部分相关、conductor 接下来做了什么。
- 行为标签，尽可能做成确定性判定：在当前任务上的下一步动作、做错任务、
  重读、失败后的恢复。
- 派生 `b`（每轮增长），并和 `M_T`、`B`、`C` 一起报；
  四个都报，绝不单报 `M_T`。
- 一个不逐轮重启 CLI 的长周期对比，这样数字才和真实会话一致。

### 投影：注意力包与调度器

- 每个任务的注意力状态：下一步动作、阻塞项、优先级、漏掉的代价、
  新鲜度、权威性。
- frontier 与调度器：决定哪个任务就绪、下一轮该花在谁身上。
- packet 编译器：输出当前决策的工作集
  （ROLE、NOW、DECIDE、BLOCKERS、CHANGED、MUST、TRUST、PARKED、MORE），
  而不是把账本重述一遍。
- 注意力债：统计未闭合循环数，超过阈值就禁止开新任务。

### 门槛

- 验收 provenance：由 harness 跑 checks，并标明结果是已验证还是只是自称。
- 错误分类，配重试预算、死信和熔断。
- 状态文件版本与迁移；Windows、macOS、Linux 三平台 CI 矩阵。

## v0.4（之后）

- 注意力回归套件：needle、干扰项、顺序、截断、恢复、冲突，
  改动让注意力变差时能回滚。
- 与 packet 同源的人用态势报告：卡在哪、改了什么、哪些可信。
- 模型画像与平台能力矩阵
  （turn start、tool anchor、compaction、状态行、packet、遥测）。
- 跨 harness 的 worker，conductor 仍只在一个 harness 上；
  增加 Codex、DSH 等 adapter。
- 多机器安装 runbook 验证。

## 非目标

- 搞一个同级协商的多 agent 社会。决策者只有一个。
- 纯提示词约定。能确定的地方就用确定性机制强制执行。
- 在官方/用户 agent 已经够用的时候，再装一套新的 agent 集群。
- 用回答质量换更小 context 的 token 优化器。token 成本是优先级最低的一项。
- 长期记忆。这一层管当前会话的模型看到什么；
  它明天记得什么，属于另一个系统。