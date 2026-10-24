# 验证日志（2026-10-18，v0.2）

> 本文是 [validation.md](validation.md) 的中文译本，如与原文有出入，以原文为准。

这里记录的是这台机器上实际运行过的内容，不是计划中的内容。

## 1. 测试套件

```bash
cd <repo>
node --test
```

结果：**202 个测试，202 pass，0 fail**。

> 2026-10-24 复核：新增 20 条测试（8 条修复回归、7 条文档结构、2 条 report、1 条 hook 遥测、1 条 tail 读取、1 条 MCP 诊断），Windows 222/222；macOS 基线未复跑。同日 demo 输出为 715 envelope tokens / 389 capsule tokens（上方 2026-10-18 数字保留为历史记录）。

覆盖范围包括：

- contract 解析/校验/压缩、无效结果替换，以及显式
  的截断告警；
- 用户级状态注册表，goal/plan/jobs/decisions/session/metrics、锁，以及
  一个 6 进程并发 job-upsert 测试；
- 内容寻址的 artifacts、有界读取、英文/中文检索；
- 原生 agent 的能力策略（`Explore`、`general-purpose`、`mhe-reasoner`）
  与 `mhe-*` fallback 解析；叶子 worker 强制（不允许嵌套 Agent/Task）；
- hooks：未注册项目之外保持休眠，auto conductor，原生 worker
  策略，原生 TaskCreate/Get/Update/List 拒绝，SubagentStart contract，
  SubagentStop 合法/非法（带 retryable jobs），PostToolUse 规范化，
  无效结果的 artifact handle，大输出捕获，PreCompact，禁用时
  no-op，仅记录错误（errors-only）；
- installer：原生复用，本机一个 `mhe-reasoner` fallback，
  缺失 reasoner 时的 fallback，旧 `hr-*` 删除，旧 `.router` 迁移，
  幂等，卸载时保留官方/用户 agent；
- MCP server：`enhance_*` 工具，goal/state/capabilities/recall，仅按 id 的 plan
  任务，cwd 与 active 的隔离，无效 handle；
- capsule：一份共享的 hook/MCP 预算，仅限叶子节点的 worker contract；
- benchmark 与 demo。

## 2. Demo 与 benchmark

```bash
node bin/mhe.mjs demo
node bin/mhe.mjs bench
```

Demo：3 个 plan 任务，4 个 envelope（约 665 估算 tokens），capsule 约 339 tokens，
校验器检查 3 项（2 pass），模拟 54,767 -> 7,457（减少 86.4%）。

benchmark（只算主 context）：

| scenario | baseline | conductor | reduction |
|---|---:|---:|---:|
| light | 34,122 | 7,170 | 79.0% |
| medium | 92,623 | 9,061 | 90.2% |
| heavy | 244,023 | 12,741 | 94.8% |

## 3. Qoder 安装（v0.2、auto、原生复用）

```bash
node bin/mhe.mjs install qoder --root <repo>
```

实际观测：

- 配置目录：`~/.qoder-cn`
- 状态目录：`~/.my-harness-enhance/projects/<key>`
- settings 备份：`~/.qoder-cn/settings.json.harness-enhance-<timestamp>.bak`
- 能力映射：
  - investigate -> `Explore`
  - plan -> `Explore`
  - execute -> `general-purpose`
  - verify_read -> `Explore`
  - verify_run -> `general-purpose`
  - write -> `general-purpose`
  - reason -> `mhe-reasoner`
  - lead -> `general-purpose`
- 已安装的 fallback agent：`mhe-reasoner`（官方没有 no-tools 等价物）
- 已删除的旧 agent：`hr-executor`、`hr-investigator`、`hr-lead`、
  `hr-planner`、`hr-reasoner`、`hr-router`、`hr-verifier`、`hr-writer`
- 保留的官方/用户 agent：`general-purpose`、`Explore`、`env-runner`、
  `reasoner`
- 已安装的 hooks：SessionStart、UserPromptSubmit、PreToolUse、SubagentStart、
  SubagentStop、PostToolUse、PreCompact、Stop
- MCP server：`harness-enhance`（stdio）；旧 `harness-router` 已删除
- 仓库 `.router`：不存在
- `mhe doctor`：所有检查 ok

### 全局模式（安装时间 18:30）

```bash
node bin/mhe.mjs install qoder --global
```

实际观测：

- `~/.my-harness-enhance/global.json` -> `autoRegister: true`,
  `configDir: ~/.qoder-cn`;
- Qoder MCP `harness-enhance` 环境变量 -> `MY_HARNESS_ENHANCE_GLOBAL=1`（不绑定固定
  项目）；
- 全局安装 8 个 hooks；settings 备份
  `settings.json.harness-enhance-20261018103042.bak`；
- `doctor --root <workspace>`（一个未注册的 workspace）-> ok，
  显示全局模式与 "auto on first session"；
- 自动注册只作用于**新**的 SessionStart（`startup`/`new`/`clear`）。
  在未注册 workspace 上只触发 PreToolUse 的测试保持静默（已补测试）。
- 发现并清理了一次对已在运行的 workspace-root 会话的误注册；已有会话
  不会被 retrofit。
- MCP `enhance_*` 工具按 `project` 参数解析，其次是
  `MY_HARNESS_ENHANCE_PROJECT`，再次是 MCP 进程的 cwd；全局
  `active.json` 不再作为兜底。Capsule 里包含 `PROJECT`。
- Qoder 在 18:33:37 重启；新的 MCP server 进程在 18:33:44 启动
  （独立进程），跑的是全局代码。
- 首个全局 workspace 会话 `aebbad10-e969-468e-bbfc-202aa5d9c5a2`
  （cwd `<workspace>`，model `qfmodel`）：自动注册，conductor
  policy/capsule 已创建，随后 conductor 派发给原生 `Explore`。
- 首个 Explore 结果被拒绝，因为 evidence 条目是文件路径
  （旧的严格 handle 校验）。已修复：evidence 接受路径/URL；只有 artifacts
  才要求内部 handle。
- conductor 用内联 contract 重新派发；第二次 Explore 返回
  `status=ok`，conductor 在 18:39:33 给出最终答复
  （24 个目录，22 个非空项目）。
- 指向 `harness_enhance` 的 `mcp_get` 网关调用被放行；对其他
  MCP server 的调用仍然拒绝。
- 新增按会话维度的 conductor map：只强制在 SessionStart 标记的那个会话；
  更早的 workspace-root 会话 `76ec7a18` 没有被劫持。
- 全局模式现在已在一个真实的新 workspace 会话上端到端验证通过。

## 4. 安装后 hook 模拟（原生 agent）

使用 `settings.json` 里原样的命令，`cwd` 指向本项目，并且
`model=qfmodel`：

- `SessionStart` -> `MY-HARNESS-ENHANCE CONDUCTOR` policy + capsule + WORKERS
  映射。
- `PreToolUse` `Bash` -> deny。
- `PreToolUse` `Agent(Explore)` 和 `Agent(general-purpose)` -> allowed；
  `Agent(env-runner)` -> denied（旧的自定义 executor 不在能力映射里）。
- `PreToolUse` `Agent(Plan)` -> denied（不在能力映射里）。
- `PreToolUse` `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` -> denied；
  conductor 必须使用 `enhance_plan`。
- worker 的 `PreToolUse` `Agent`/`Task` 对所有 worker 都是 denied，包括
  `general-purpose`；worker 都是叶子节点，必须返回 `needs_split`。
- `SubagentStart` `Explore` -> 带 `role: investigate|plan|verify_read` 的 worker contract。contract 里不再宣称 depth/max-depth 护栏。
- `PostToolUse` `Agent` 收到合法 envelope -> compact envelope，
  `status=ok`；非法结果 -> 失败 envelope，带 `next` 和
  `data.artifact_handle`。
- `logging=errors` 下的常规操作不写审计日志；被拒绝的操作会写。
- 之后清理了测试状态；用户级状态目录里只剩 `config.json` 和 `capabilities.json`。
  真实会话的测试状态已归档到
  `~/.my-harness-enhance/legacy/`。

## 5. 首个真实 Qoder 会话（60c87313）

会话：`60c87313-cdf1-4a4e-a38d-e1ffcdf2d2b9`，cwd
`<repo>`，model `qfmodel`，创建于 18:16:30。

实际观测：

- auto conductor 生效：`session.json` role=conductor，goal/capsule 已创建，
  `jobs.json` 跟踪各 worker。没有做任何 agent/model 选择。
- conductor 派发给原生 `Explore` worker。它自己没有尝试
  Bash/Read。
- 首轮：在这个层介入之前，Qoder worker 传输就失败了（先是 `Transport closed`，
  随后 `Network attempt failed at timeout`）。用户在 18:16:54
  重试；第二轮成功。
- 三个 Explore worker：
  - `aExplore-464...`：合法 envelope，但 `data` >4000 chars。**旧的**
    validator 把整个 envelope 判为无效（`data exceeds 4000 chars`）。
  - `aExplore-2abeb...`：合法 envelope，但 evidence >8 entries。**旧的**
    validator 同样判其无效（`evidence exceeds 8 entries`）。
  - `aExplore-2076885e...`：修复之后完成；job 状态 **ok**，envelope
    被 conductor 接受。
- conductor 针对这些失败做了适配：并行重新派发了限定范围的任务，
  使用那个合法 envelope 加上首次失败里的原始摘录，并在 18:23:55 给出最终答复。
  最终答复正确地
  把仓库识别为 my-harness-enhance v0.2.0。
- 18:19:57 的主 context 占用快照：**7.4%**（模型窗口 400k；
  面板快照里的细分分类仍为空）。仓库原始内容
  留在 worker 的 context 里；conductor 只看到 compact envelope。

本次会话期间/之后所做的修复：

- `Explore` 现在可以使用它的原生 `Bash` 工具；只拒绝 Write/Edit/Agent/Task。
  持久化的 `capabilities` 配置已刷新。
- 超长的 `summary` / `evidence` / `artifacts` / `open_questions` / `data` 会被
  **截断**，而不是用来把一个本来合法的 envelope 判为无效。
- 提取 worker 结果时优先使用 `last_assistant_message`。
- 即使并行 worker 没有发出 `SubagentStart`，
  `SubagentStop` 也会创建/更新一个 job（带 role/depth）。

## 6. 写入 + 验证会话（c1f3a1b9）

会话：`c1f3a1b9-406a-435d-98a6-1766e2cd92ae`，cwd
`<repo>`，model `qfmodel`。

实际观测：

- conductor 自动注册；派发两个原生 `Explore` worker，
  `mhe-reasoner` 负责断言设计，`general-purpose` 负责写入，
  另一个 `general-purpose` 负责独立验证。
- conductor 自己没有写入或执行任何东西；它使用的是
  `enhance_plan`/`enhance_job` 和 compact envelope。
- `mhe-reasoner` 在约 5.5 分钟后返回合法 envelope。
- 写入 worker 只新增了 `test/global.test.mjs`（67 行，10 个测试）；
  全量套件 83/83，新文件 10/10，原有七个文件 73/73。
- `src/` 未被改动：最新的 mtime 是 `src/core/contract.mjs` 19:27:40，
  早于 19:38:15 新建的测试文件。
- conductor 在 11:43 的最终答复引用了 `file:line` 证据，并主动指出
  两个注意点（文档 baseline 72 与实际 73；`process.cwd()` 的可移植性）。

暴露出的非阻塞问题：

- 第一次 `enhance_plan` 调用漏了 `title`，被 MCP schema 拒绝；
  conductor 带上 title 重试后成功。schema 现在只要求
  `id`，title 缺失时回退到 `task`/`id`。
- 文档此前仍写着 72 个测试；现已更新。
- 新测试用了 `process.cwd()`；已改为临时路径。

## 7. 评审驱动的加固（696968ee）

另一个独立的 Qoder 评审会话检查了这个层。确认并修复：

- **并发读-改-写：**`goal`、`plan`、`jobs`、`session` 和
  `sessions` 的写入原本在锁之外；`jobs.json` 是并发
  `SubagentStop` 的关键路径。现在全部走 `withLock`（10s 超时，30s
  失效），并有一个 6 进程 upsert 测试断言不会丢 job。
- **无效 envelope 的恢复：**`SubagentStop` 现在会在 job 里记录一个合成的失败
  envelope，并附上 `retryable: true` 和 `next`；conductor 不
  再需要从空 envelope 去推断要不要重试。`PostToolUse` 的非法
  输出里包含原始 artifact handle。
- **静默截断：**规范化后的 envelope 会带上 `warnings`；compact 输出
  会记录每一次裁剪。超长的 evidence/artifacts/questions/data 仍然
  会被截断，但 conductor 能看到它发生过。
- **假旋钮：**`maxDepth`/`maxFanout` 已移除。worker 在 `PreToolUse`
  被强制为叶子节点（即使 `general-purpose` 也 denied Agent/Task）；
  worker contract 不再宣称有 depth 护栏。
- **任务图分裂：**原生 `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`
  被 denied；`enhance_plan` 是唯一持久的任务图。
- **workspace 状态串用：**MCP `contextFor` 不再回退到全局
  `active.json`；它按 `project`、然后是 env、然后是 server cwd 解析。
- **预算不一致：**hook 注入和 MCP `enhance_state` 现在使用同一个
  `maxCapsuleTokens`；`maxStateTokens` 已移除。
- **artifact summary 的问题：**摘要会折叠空白并按词边界
  截断，而不是直接切 240 个字符。

两条评审结论被收窄：

- conductor 的 `PostToolUse` 路径本来就会渲染 `invalidResultEnvelope`
  并带上 "re-delegate" 指令；缺的闭环是 job 级别的
  记录，现已修复。
- 评审给出的 72/72 已过时；评审当时的 baseline 是 73。

## 8. 仍待验证

- 长周期任务与 `PreCompact` 后的状态保真。
- Qoder context 面板的细分分类（实机快照里 detail 为空）。
- 更大负载下免费 `qfmodel` 的限流/质量。
- 当 conductor model 为 qwen 3.5
  9b/7b 时与旧 `bash-delegate` hook 的交互（会打印告警；改用非 9B model 或移除旧 hook）。
- ZCode adapter 与 macOS/Linux 实机运行。
- 仓库现在已有 git 历史；2026-10-19 之前的条目早于它。
