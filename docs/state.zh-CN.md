# 状态与注入

> 本文是 [state.md](state.md) 的中文译本，如与原文有出入，以原文为准。

本页描述 harness 在磁盘上存了什么、每个文件由哪个数据结构支撑，以及 hook 向 conductor 和 worker 注入了什么。它与 [architecture.md](architecture.md)（为什么有这些层）和 [qoder-adapter.md](qoder-adapter.md)（Qoder 专属路径）互补。

## 1. 状态在哪里

默认状态主目录是 `~/.my-harness-enhance`；`MY_HARNESS_ENHANCE_HOME` 可以覆盖（A/B runner 用的是 `~/.mhe-test/state-treatment`）。不会往项目仓库里写任何东西。

`projects.json` 位于状态主目录根部，把规范化后的项目根目录映射到 16 位 SHA-256 项目 key。共享状态在 `projects/<key>/`；每个会话的工作状态在 `projects/<key>/sessions/<sessionKey>/`。

`sessionKey` 会把宿主 session id 转小写、删除 `[a-z0-9-]` 之外的字符、截断到 64 个字符（空 id 归一为 `default`）。只有完全不传 session 时，`storePaths` 才使用 `projects/<key>/` 下的旧版项目级文件。

目录结构：

```text
~/.my-harness-enhance/
├── projects.json
└── projects/<key>/
    ├── config.json  capabilities.json
    ├── decisions.jsonl  sessions.json  metrics.jsonl
    ├── artifacts/  logs/  .lock
    └── sessions/<sessionKey>/
        ├── goal.json  brief.json  plan.json  jobs.json
        ├── journal.md  last-check.json  session.json
        ├── worktrees.json  capsule.md
        └── injection.json  packet.json  now.json
```

### 1.1 项目级文件

| 文件 | 作用 | 内容 | 来源 |
|---|---|---|---|
| `config.json` | 项目配置 | 默认值叠加覆盖：enabled、conductor、envelope、context 预算、capabilities、GC | `loadConfig` / `saveConfig`，`src/core/config.mjs` |
| `capabilities.json` | 探测到的宿主能力 | 允许的 subagent、hook 事件、工具名 | `src/core/capabilities.mjs` |
| `decisions.jsonl` | 只追加的决策日志 | 每条决策一行 JSON | `appendDecision` / `readDecisions`，`src/core/store.mjs` |
| `sessions.json` | 会话索引 | id、role、model、`host_pid`、cwd、`last_seen` | `markSession` / `readSessions`，`src/core/store.mjs` |
| `artifacts/` | 内容寻址的证据 | worker 结果、文件、diff、日志 | `putArtifact` / `listArtifacts`，`src/core/artifacts.mjs` |
| `metrics.jsonl` | 只追加的指标流 | 事件、role、token、credits、耗时 | `appendMetric`，`src/core/store.mjs`；adapter 负责记录事件 |
| `logs/` | hook 与运行时日志 | 每个事件一行 JSON | adapter 的 `log` 辅助函数 |
| `.lock` | 跨进程写锁 | 状态写入者使用的锁文件 | `withLock`，`src/core/store.mjs` |

### 1.2 会话分片

| 文件 | 作用 | 内容 | 来源 |
|---|---|---|---|
| `goal.json` | 用户目标 | `text`、`acceptance[]`、`constraints[]`、`version`、`updated_at` | `writeGoal` / `readGoal` |
| `brief.json` | 持久任务契约 | `profile`、`inputs[]`、`pairs[]`、`checks[]`、`glossary[]`、`ownership[]`、`notes`、`goal_version` | `writeBrief` / `readBrief`；`src/core/brief.mjs` |
| `plan.json` | 任务与注意力元数据 | `version: 2`、`tasks[]`、`updated_at` | `writePlan` / `readPlan` / `updatePlanTask` |
| `jobs.json` | 派工账本 | `jobs[]`：agent、type、role、status、`task_id`、envelope、结果 handle | `upsertJob` / `readJobs` |
| `journal.md` | 用户 prompt | 只追加的 Markdown，每个 prompt 一个带时间戳的 section | `appendJournal` |
| `last-check.json` | 权威检查结果 | `ok`、`checked[]`、`findings[]`、`source`、`worktree` | `writeLastCheck` / `readLastCheck` |
| `session.json` | 会话角色标记 | `role`、`model`、`source`、`fresh`、`host_pid`、`cwd` | `writeSession` / `readSession` |
| `worktrees.json` | 代码 worktree 注册表 | `worktrees`：id 到 path、status、时间戳 | `writeWorktrees` / `readWorktrees` |
| `capsule.md` | 派生出的完整账本 | PROJECT、SESSION、NEXT、LAST CHECK、GOAL、ACCEPTANCE、CONSTRAINTS、WORKERS、BRIEF、PLAN、ACTIVE JOBS、WORKTREES、RECENT DECISIONS、ARTIFACTS | `buildCapsule` / `writeCapsule`；`src/core/capsule.mjs` |
| `injection.json` | delta 簿记 | 上次注入时每个 section 标题到内容 hash | `recordInjection` |
| `packet.json` | delta 簿记 | 上一轮 plan 状态与 check 标签 | `buildPacket` |
| `now.json` | 提醒去重 | 上一条 `[NOW]` 行 | `nowReminder` |

写者：hooks 负责 `goal`、`journal`、`jobs`、`capsule`、`injection`、`packet`、`now`；conductor 的 MCP 工具写 `brief.json`、`plan.json`、`last-check.json`、`worktrees.json`、`decisions.jsonl`；adapter 写 `session.json`。
worker 从不写状态文件：它只返回一个 JSON envelope，由 `SubagentStop` 落盘。
`last-check.json` 只有一个权威来源：harness 的检查或成功的 `land`，绝不是 worker 的自报。

最后三个文件是簿记，不是内容。`capsule.md` 是在 `SessionStart`、`UserPromptSubmit`、`PreCompact`、`Stop` 时重建的派生完整账本，用于恢复和查看；它不会每轮注入。
每轮注入的是 packet，直接由 `goal.json`、`brief.json`、`plan.json`、`jobs.json` 和 `last-check.json` 构建。

## 2. 数据结构

### 2.1 Goal

```json
{
  "text": "what the user asked for",
  "acceptance": ["observable completion criterion"],
  "constraints": ["non-negotiable boundary"],
  "version": 1,
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

`writeGoal` 只在 `replace` 为真或还没有 goal 时替换目标；否则保留文本并把 prompt 追加到 `journal.md`。替换目标会删除 `brief.json` 和 `last-check.json`，避免旧验收标准残留。

### 2.2 Brief

```json
{
  "version": 1,
  "profile": "general | docs | code",
  "inputs": [{ "path": "src/a.mjs", "sha256": "..." }],
  "pairs": [{ "source": "docs/a.md", "target": "docs/a.zh-CN.md" }],
  "checks": ["inputs", "docs", "command:test"],
  "glossary": [{ "source": "router", "target": "conductor", "mode": "keep" }],
  "ownership": ["src/**"],
  "notes": "free text",
  "goal_version": 1
}
```

brief 是 conductor、worker 和 checker 共享的持久契约。`goal_version` 把它绑定到产生它的 goal。

### 2.3 Plan task

```json
{
  "id": "t1",
  "title": "delivery unit",
  "status": "pending | in_progress | completed | blocked | cancelled",
  "worker": "general-purpose",
  "depends_on": ["t0"],
  "acceptance": "what the checker must observe",
  "evidence": ["artifact-or-path"],
  "next_action": "one concrete next step",
  "blockers": ["what prevents progress"],
  "priority": 3,
  "cost_of_miss": "why a miss matters",
  "authority": "brief | user | harness",
  "confidence": 0.8,
  "as_of": "2026-01-01T00:00:00.000Z"
}
```

`readPlan` 会派生 `stale`（pending 或 in_progress 且距 `as_of` 超过 24 小时），但从不存储它。plan 最多 50 个任务；jobs 最多 100 个。

### 2.4 Job

```json
{
  "id": "job_...",
  "agent_id": "host agent id",
  "type": "general-purpose",
  "role": "execute",
  "task_id": "t1",
  "status": "running | ok | failed | blocked | invalid_result",
  "envelope": {},
  "result_handle": "artifact handle",
  "retryable": false,
  "error_class": "",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

`upsertJob` 在 `SubagentStart` 创建 job，在 `SubagentStop` 用解析后的 envelope 和 artifact handle 更新它。没有有效 `task_id` 的 job 无法同步 plan。

### 2.5 Session 与 check

```json
{ "role": "conductor", "model": "qfmodel", "source": "startup", "fresh": false, "host_pid": 1234, "cwd": "D:\\project" }
```

```json
{ "ok": true, "checked": ["inputs"], "findings": [], "source": "harness", "worktree": "" }
```

`last-check.json` 只由 harness（`enhance_check` 或成功的 `land`）或显式调用者写入；worker 的自报永远不会成为权威结果。

## 3. hook 注入了什么

| 事件 | 对象 | 载荷 | 预算 | 来源 |
|---|---|---|---|---|
| `SessionStart` | conductor | conductor policy 加完整 packet | packet 最多 1,800 token，policy 另计 | `conductorInjection` |
| `UserPromptSubmit` | conductor | 回合 anchor 加**只有变化的** packet section | 源 packet 最多 1,800 token；实际注入约 216 token/轮 | `conductorTurnInjection` |
| `SubagentStart` | worker | worker contract、goal、acceptance、constraints、brief | 总共 900 token；brief 先裁到 1,000 字符 | `workerInjection` |
| `PreToolUse` | conductor 与 worker | 不注入上下文；只允许或拒绝工具调用 | 无 | `hook-policy.mjs` |
| `SubagentStop` | 无 | 解析 envelope、存 artifact、更新 job 和 plan | 无 | `onSubagentStop` |
| `PostToolUse` | conductor | 压缩后的 worker envelope 加一条 `[NOW]` frontier 提醒 | envelope 上限加一行 | `compactEnvelope` / `nowReminder` |
| `PreCompact` | 无 | 重建 capsule 并写 compaction 指标；下一次 `SessionStart` 重新注入 policy 和 packet | 无 | `onPreCompact` |
| `Stop` | conductor | 代码 worktree 未 land 时拒绝停止；否则写指标 | 无 | `onStop` |

`SessionStart` 时 hook 会为每个 packet section 记录哈希到 `injection.json`。之后每轮重建 packet、比较哈希，只注入变化的 section 加 anchor；被移除的 section 会按标题列出。
`packet.json` 记住上一轮的 plan 状态和 check 标签，packet 的 `CHANGED` 就是这样渲染出来的。

worker 永远不会收到 `plan.json`、`jobs.json`、`journal.md` 或其他任务的状态。任务细节（精确路径、方法、输出格式）来自 conductor 的 `Agent`/`Task` prompt，那个通道不受 `SubagentStart` hook 截断。

Qoder 会在约 5,000 到 6,000 token 处截断 `SubagentStart` 的 additional context，所以 900 token 的 worker 注入是有意保守。加大预算并不保证送达。

## 4. 任务生命周期

```mermaid
sequenceDiagram
  participant U as User
  participant H as Hooks
  participant C as Conductor
  participant W as Worker
  U->>H: prompt
  H->>H: set or journal goal; build packet; hash sections
  H->>C: turn anchor plus changed sections
  C->>H: enhance_brief and enhance_plan when missing
  C->>H: Agent or Task with task_id, paths, method, output
  H->>W: worker contract, goal, brief
  W->>W: read inputs and produce the artifact
  W-->>H: JSON envelope
  H->>H: parse, store artifact, update job and plan
  H-->>C: compact envelope plus NOW
  C->>H: enhance_check or enhance_worktree land
  H-->>C: authoritative result
  C-->>U: decision and next action
```

1. `UserPromptSubmit` 在首个 prompt 设置 goal，在新的实质性 prompt 上替换 goal，否则追加到 journal；然后构建 packet 并注入 anchor 加变化 section。
2. conductor 读 anchor，在 brief 和 plan 缺失时创建它们，并选择一个交付单元：一个 plan task，一个 owner、一套 brief/check、一个 land 边界。
3. conductor 写派工 prompt，包含精确的 `task_id`、输入路径、方法、输出路径和禁止动作。
4. `SubagentStart` 创建 job，并注入 worker contract、goal 和 brief。worker 看不到 plan。
5. worker 读输入、产出 artifact，并返回一个 JSON envelope。
6. `SubagentStop` 解析 envelope，把原始结果存成 artifact，更新 job，并同步 plan 状态。`PostToolUse` 压缩 envelope 并追加 `[NOW]` 提醒。
7. conductor 跑确定性检查（`enhance_check`）或对代码执行 `land`。只有那个结果能完成任务。
8. conductor 在决策需要跨会话保留时记录 decision；下一个 prompt 从第 1 步开始，只带 delta anchor。

当前 policy 禁止做仓库工作，所以第 2 步一定是委派；把小项合并成一个 task 是允许的，但直接做不允许。待定的决策是要不要加入“直接做还是委派”的规则；见下面的 D-1。

## 5. 当前限制

| ID | 限制 | 影响 | 预期修法 |
|---|---|---|---|
| D-1 | conductor policy 禁止做仓库工作，哪怕很小的读取也变成 worker 派工 | 收费 worker 让成本翻倍；免费 worker 增加墙钟和信封 | 按工件大小、复用和隔离需求，加入“直接做 / 委派 / 合并”的决策规则 |
| D-2 | `SubagentStart` 没有传 `task_id`，注入的 contract 写的是 `task_id: unassigned` | job 与 plan 的关联依赖 conductor 的 prompt 和 envelope | 从派工文本解析 `task_id`，并注入结构化 task card |
| D-3 | `fit(contract + goal + brief, 900)` 从尾部截断 | goal 一长就可能切掉 brief 和 checks；worker 看不到验收标准 | 给每个 section 分预算，并显式标记截断 |
| D-4 | 回合 anchor 说不要调用 `enhance_state`，即使 packet 是 compact | conductor 无法补取 packet 省略的 section | packet mode 不是 `full` 时允许一次 state 调用 |
| D-5 | worker 没有拿到 `brief_hash` 或 `plan_version` | 结果可能基于过期的 brief，复用 worker 时更明显 | 把版本放进 worker 注入，并要求 envelope 带回 |
| D-6 | 复用和合并没有建模成 adapter capability | Qoder 永远冷启动；ZCode 的复用无法由 policy 选择 | 在能力矩阵中加 `worker_resume` 和 `agent_messaging`，按能力分支 |