# 架构

> 本文是 [architecture.md](architecture.md) 的中文译本，如与原文有出入，以原文为准。

## 1. 问题

在执行长周期（long-horizon）任务时，单个 agent 会话把大部分注意力
都花在执行细节上：原始工具输出、它自己的推理轨迹、工具/MCP schema、
过期的计划（plan）、重复读取，以及失败的尝试。模型的 context 不断增长，但
有用的信号并没有随之增长。失败模式是目标漂移（goal drift）、重复、约束丢失，
以及“上下文腐坏”（context rot），而且这些都远早于窗口被填满的时候。

解决办法不是更大的窗口，也不是对同一份逐字记录（transcript）做更聪明的摘要。
解决办法是改变主模型每一轮所看到的东西：

- 在主 context 中保留一个很小的控制平面（control plane）；
- 把执行与调查挪到彼此隔离的 worker context 中；
- 只返回一个有界的、结构化的结果；
- 把持久状态留在逐字记录之外。

## 2. 五个层次（layer）

### 2.1 经济层：谁付费，谁干活

结构性不变量是**一个决策者（decision-maker）+ 多个执行 context**。
成本是这套结构之上的一项策略（policy），而不是结构本身的一部分。

默认策略：

- 付费的强模型 = conductor（判断、路由、验收、综合）；
- 免费/便宜但有能力的模型 = worker（调查、执行、验证、起草）；
  在 Qoder 上，默认的 worker 是 `qfmodel`（Qwen3.8-Flash）；
- 关键的验证或困难的子任务可以升级（escalate）为付费 worker；
- 涉及隐私的任务可以跑在本地模型上。

每个 worker 档案（profile）都声明一份成本/能力档案：成本档（cost tier）、模型、
context 上限、工具集、延迟、可靠性。conductor 选择最便宜的、
能满足该任务能力门槛的 worker。
不要把“模型 A 永远做 X”这类规则写死。

状态（v0.2）：这是策略目标，不是运行时路由器。
`src/core/capabilities.mjs` 只硬编码了一张静态的 role -> 候选 agent 表；
唯一的模型字段是 fallback agent 模板里的 `model: qfmodel`。
成本/能力路由与每任务预算属于 v0.3（见 `roadmap.md`）。

免费 worker 有风险：限流（rate limit）、工具可靠性更弱、context 上限，
以及隐藏的策略过滤。这一层必须有 fallback（付费/本地 worker）和结果校验。
最终裁决权永远不属于免费 worker。

### 2.2 拓扑层：context 所在位置

四种拓扑（topology），一个契约（contract）：

| 拓扑 | 何时使用 | 主要成本 | 备注 |
|---|---|---|---|
| 同会话 subagent | 默认 | 最低 | 隔离的 context；父级只看到结果 |
| 嵌套 subagent（树/DAG） | 未来；v0.2 未启用 | 深度 x 延迟 | 需要显式的深度/扇出强制；每一层都返回有界结果 |
| 同一 harness、多模型/多会话 | 长时间运行、不同的模型/权限/沙箱、需要在主会话之外存活 | 传输 + 同步 | Qoder 的跨会话在 Windows 上不受支持；ZCode 没有任意总线；退回到 subagent |
| 跨 harness 多 agent | 另一个 harness 有独有能力/模型/工具 | 最高 | 最后手段；统一的传输契约；v0.1 不包含 |

统一的原语（primitive）是：

```
delegate(task, refs, schema, mode) -> job_id
status(job_id) -> state
result(job_id) -> envelope
send(job_id, message) -> ack        (if bidirectional)
cancel(job_id)
```

主模型看到的是 `delegate`，永远看不到 worker 的逐字记录。

**深度是一个工具，不是一个目标。** 每多一层都会增加延迟、成本和错误
传播。v0.2 强制只有一层：worker 不得使用 `Agent`/`Task`；需要拆分的
worker 返回 `needs_split`，并附上建议的子图，由 conductor
来决定。嵌套 worker 是一种未来的拓扑，不是当前对外承诺的护栏
（guardrail）；如果引入，深度/扇出（fan-out）必须在代码里强制执行。

### 2.3 Harness 层：使用原生原语

不要重新实现 harness 已经提供的东西。adapter 把契约映射到
原生机制上。

| 能力 | Qoder | ZCode | Codex | DSH |
|---|---|---|---|---|
| 限制主工具 | `PreToolUse` deny（auto；原生 main 保留完整 schema） | `--disallowed-tools` | agent 角色/工具策略（部分） | `ctx.tools.restrict` |
| 隔离 worker | subagent，独立的逐字记录/压缩 | `Agent` subagent | `spawn_agent` + 线程 | subagent 插件 |
| 只回传 worker 结果 | 父级看到结果，看不到逐字记录 | `Agent` 最终消息 | 父级最终消息 | delegate 结果 |
| 改写工具输出 | `PostToolUse.updatedToolOutput` | 仅 `additionalContext` | hooks（部分） | 工具流水线 |
| 校验 worker 停止 | `SubagentStop` | 无 `SubagentStop` | subagent stop hooks | `outputSchema` |
| 在压缩时注入 | `PreCompact`/`PostCompact` + `SessionStart(compact)` | `SessionStart(compact)` | pre/post compact hooks | 压缩接缝（seam） |
| Headless / SDK | `qoder -p`、Agent SDK | `-p`、app-server | `codex exec`、SDK | `dsh --profile headless`、SDK/ACP |
| 免费 worker 模型 | `qfmodel`（Qwen3.8-Flash） | 取决于 provider | 付费/Responses | 模型无关 |

规则：

- 优先用确定性强制（hook/flag/schema），而不是靠 prompt 去遵守。
- 尊重 harness 的沙箱（sandbox）、权限和平台限制。
- 当某个能力缺失时，优雅降级：
  - 无法改写输出 -> 由 conductor 侧做归一化/截断；
  - 没有 `SubagentStop` 校验 -> conductor 自己解析并重新派发；
  - 没有跨会话 -> 使用 subagent。
- 为每个 adapter 写一份能力描述符（capability descriptor）。这样 conductor 策略
  就能按能力来选择拓扑，而不是按 harness 名字。

#### 激活方式（Activation，Qoder v0.2）

- 全局 auto 模式：每台机器安装一次；任意 workspace 中**第一个新**
  会话会被自动注册（SessionStart startup/new/clear）。已经在跑的
  会话不会被 retrofit。已注册 workspace 里的每个主会话
  都是 conductor；不按会话选择 agent/model
  （worker 角色由 §2.1 的静态候选表解析）。
- 项目级（project-scoped）auto 模式：显式安装单个项目；它会立刻注册。适合严格管控
  或者按项目设置 fallback agent。
- Hooks 注入策略并 deny 掉非 conductor 的工具。
  原生 main agent 保留它完整的工具 schema；节省来自消息/工具结果
  和 worker context，而不是静态的 schema。
- 复用优先：官方的 `general-purpose`/`Explore`；`mhe-reasoner` 是唯一的
  no-tools fallback。旧的 `reasoner` 和 `env-runner` 不再被选中。
  只有出现能力缺口时才会安装 `mhe-*` fallback。
- worker 都是叶子节点：`PreToolUse` 对所有 worker 都 deny `Agent`/`Task`，
  包括 `general-purpose`。conductor 是唯一的路由者。
- 只有 conductor 会话和被映射的原生 worker 会写 capsule/jobs/审计日志。
  已注册项目之外的无关会话处于休眠状态。

### 2.4 契约层：不变量 vs 实现细节

**不变量（所有 harness 通用）：**

1. 只有一个决策者；worker 无状态、无目标，也不谈判。
2. 主 context = 目标/约束 + 任务图/路由表 + 结果摘要 + 决策。
   不含原始工具输出、worker 推理或逐字记录。
3. worker 结果 = 有界的 envelope，包含 status、summary、evidence、artifacts、
   open questions、next step、needs_split、data、cost、confidence。
4. 进度 = status + 里程碑（milestone）；失败 = 结构化的错误；
   需要有限的下钻（drill-down）时用 `enhance_recall(handle)`。
5. 粗粒度拆分在 conductor 里做；细粒度任务图由一个 planner worker
   提出，并由 conductor 批准。
6. 按成本/能力路由；选最便宜的合格 worker。
7. 先做确定性强制，再谈 prompt 引导。

**实现细节（每个 harness 各自）：**

skills、AGENTS.md、MCP server、hook 脚本、agent 定义、workflow、
goal/plan 原语、会话存储。它们只是*如何实现*某条不变量而已。
不要把某个机制当成架构本身。

### 2.5 运维层：稳定、效率、契合、证明

**稳定性：**

- 关键边界用 hooks/flags/schema 来强制；
- 对 read-modify-write 的状态加项目级锁（lock）；原子写入；
- v0.2 强制叶子 worker（Agent/Task 被 deny）；
- 如果引入嵌套 worker，就要有最大深度、最大扇出、
  每个节点的 token/时间/工具预算；
- 失败时的 fallback（付费/本地 worker）；
- 可观测性（observability）：job id/树、hook 日志、成本。

**效率：**

- conductor 的调用要少且小；worker 免费/并行；
- 裁剪工具 schema（conductor 暴露约 13 个工具，而不是 36+）；
- 稳定的前缀 / KV cache；
- artifact 复用、内容寻址（content-addressed）去重；
- 按任务复杂度选拓扑：简单任务 -> 一个 worker；不要树。

**契合：**

- 使用原生原语；尊重平台限制；
- 降级，而不是跟 harness 硬抗；
- 状态格式保持与 harness 无关（JSON/Markdown）。

**证明：**

- baseline vs conductor：主 context 的 token、构成、worker 调用、
  任务成功率、验收失败、人工干预、成本/延迟；
- 用大海捞针测试（needle test）验证目标/约束的保留；
- 压缩（compaction）保真度的 A/B 对比；
- 如果 conductor 变成了橡皮图章（rubber stamp），说明校验/evidence 设计失败了；
- 如果树太深或者调用爆炸，说明粒度/路由失败了。

## 3. 状态模型

用户级状态（项目仓库里不放任何东西）：

```
~/.my-harness-enhance/
  projects.json                    project path -> state dir
  projects/<hash>/
    config.json                    conductor mode, capabilities, logging
    capabilities.json              resolved role -> native agent mapping
    goal.json                      canonical goal, acceptance, constraints
    plan.json                      task graph
    decisions.jsonl                append-only decisions
    jobs.json                      job status, agent id/type/role, envelope summary
    session.json                   current session role/model/source
    capsule.md                     compact state injected into the conductor
    artifacts/                     content-addressed raw evidence
    metrics.jsonl                  hook/routing metrics
    logs/                          errors-only by default
  legacy/                          migrated old .router dirs
```

状态存储才是唯一事实源（source of truth）。逐字记录不是。

`capsule.md` 是注入给 conductor 的紧凑状态；`jobs.json` 是路由表；
`logs/hooks.jsonl` 是可选项（默认只记错误），不含 prompt 和原始输出；
`artifacts/` 存放原始 evidence。这些文件只会为
conductor 会话和被映射的原生 worker 创建，
不会为无关会话创建。

## 4. Hooks（Qoder adapter）

| 事件 | 角色 |
|---|---|
| `SessionStart` | 识别 conductor 会话；注入策略 + capsule；在 compact/resume 时重新注入 |
| `UserPromptSubmit` | 设定首个 goal；把后续追问写入日志；重新注入 capsule |
| `PreToolUse` | conductor 工具白名单；按 agent 类型套用原生 worker 策略（readonly/leaf/notools/lead）；subagent 白名单 |
| `SubagentStart` | 创建 job；注入角色 + worker 契约 + goal/验收标准 |
| `SubagentStop` | 解析/存储 envelope；更新 job |
| `PostToolUse` | 把 `Agent` 结果规范化成紧凑的 envelope；捕获过大的 worker 工具输出 |
| `PreCompact` | 从状态重新生成 capsule（不是从逐字记录） |
| `Stop` | 写 capsule；code worktree 未 land 时阻止完成 |

关键的设计选择是：**压缩是确定性的、基于状态的**。
它并不是让已经退化的主模型去总结自己的逐字记录。

## 5. 这不是什么

- 这不是一个多 agent 社会。决策者只有一个。
- v0.2 里它不是一个跨 harness 的编排器。一个 harness，一个 adapter。
- 这不是一个纯 prompt 的约定。边界由 hooks 强制执行。
- 它也不是 harness 原生 subagent 的替代品。它是叠在它们之上的
  策略与契约层。
