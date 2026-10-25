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

- Qoder context 面板的细分分类（实机快照里 detail 为空）。
- 更大负载下免费 `qfmodel` 的限流/质量。
- 当 conductor model 为 qwen 3.5
  9b/7b 时与旧 `bash-delegate` hook 的交互（会打印告警；改用非 9B model 或移除旧 hook）。
- ZCode adapter 与 macOS/Linux 实机运行。
- 仓库现在已有 git 历史；2026-10-19 之前的条目早于它。

## 9. 长周期 A/B（2026-10-25）

runner 以 headless 方式驱动 Qoder CLI：每个 run 15 turns，
每个 arm 跑两个 repeat，模型固定不变。

```bash
node bin/mhe.mjs ab \
  --baseline-config ~/.mhe-test/qoder-baseline \
  --treatment-config ~/.mhe-test/qoder-treatment \
  --treatment-home ~/.mhe-test/state-treatment \
  --arm both --turns 15 --repeats 2 --model Qwen3.8-Flash \
  --out ~/.mhe-test/ab-results/long-01
```

| arm | runs | turns | cli failures | final tests | ctx delta avg | ctx last avg | minutes | denials |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 2 | 30 | 0 | 2/2 | 0.1922 | 0.2998 | 19.9 | 0 |
| treatment | 2 | 30 | 1 | 2/2 | 0.4801 | 0.6189 | 47.7 | 15 |

逐个 run：

| run | turns | final tests | context first -> last | wall | denials |
| --- | --- | ---: | --- | ---: | --- |
| baseline-r1 | 15/15 | 46 | 0.1077 -> 0.2982 | 608s | 0 |
| treatment-r1 | 15/15 | 3 | 0.1391 -> 0.8213 | 914s | 5（1 allowlist，4 dispatch） |
| treatment-r2 | 14/15 | 57 | 0.1385 -> 0.4164（max 0.7886） | 1950s | 10（7 dispatch，3 verification） |
| baseline-r2 | 15/15 | 45 | 0.1075 -> 0.3013 | 589s | 0 |

怎么读这组数：两个 arm 最终都是绿的测试套件，
也就是说这层没有把任务搞坏。但代价更高：墙钟时间是 2.4 倍，
context 增长是 2.5 倍，还多出
15 次 baseline 从未有过的 hook 拒绝。treatment-r1 里这道门把 run 压到
只剩 3 条测试（对照约 46 条），因为每次会写代码的派发都被拒了；
treatment-r2 追平到 57 条测试，但为此花了 1950s、1 次 CLI 失败
和 1 次 compaction。

原因就写在拒绝计数里：treatment-r2 直到第 14/15 步才写出
`profile: "code"` 的 brief，于是 code 门只在最后才武装起来，
更早的派发都因为会话档案还没声明而被拒。

### 修复之后的复跑

baseline arm 不加载这层，所以只重跑 treatment arm：

```bash
node bin/mhe.mjs ab \
  --baseline-config ~/.mhe-test/qoder-baseline \
  --treatment-config ~/.mhe-test/qoder-treatment \
  --treatment-home ~/.mhe-test/state-treatment \
  --arm treatment --turns 15 --repeats 1 --model Qwen3.8-Flash \
  --out ~/.mhe-test/ab-results/treatment-fix-01
```

| run | turns | final tests | context first -> last | wall | denials |
| --- | --- | ---: | --- | ---: | ---: |
| treatment-r1 | 15/15 | 38 | 0.1282 -> 0.5149 | 3062s | 0 |

死锁没有了：拒绝数是 0，档案在第 2 步那次会写代码的派发之前就声明好了，
而不是拖到第 14 步；11 个 plan 任务落地，收尾时测试套件是绿的，
回报上来的 7 个 worker envelope 也全部 valid。

这轮还暴露了一件事：会派发 worker 的 turn 跑不完 runner 的五分钟单轮上限，
15 轮里有 8 轮被砍在上限上，所以它们在统计里被记成了 CLI failure。
会话跨过这些砍断继续往前走（plan 一直在推进），但被派出去的 worker
有一半没来得及回报：14 个派出去了，回来 7 个。
runner 现在把单轮超时和 CLI failure 分开计数，
而不是笼统计成 CLI failure，
这样统计里才分得清「跑得慢」和「跑挂了」；
`~/.mhe-test/ab-results/treatment-fix-02` 那一轮
用十五分钟的单轮上限把两个 arm 重跑。

## 10. 派发死锁与它的两个修复

上面那些拒绝来自两把互相独立的锁。

**档案未声明。** 没有 brief 的会话等于还没声明自己的档案。
这时派发会写代码的 worker 会被拒绝，因为这种 worker 会直接改共享
checkout，而之后再切到 code 档案就会撞上脏 base，
任何 worktree 都无法从它创建。只读 worker（`Explore`、investigator、
planner、verifier）仍然可以派发。拒绝信息会直接给出出路，
而不只是陈述事实：

```
declare the session profile before dispatching a worker that writes: call enhance_brief profile=code (with the ownership globs) first, then enhance_plan, enhance_worktree create task_id=<id>, and dispatch with the returned task_id/worktree prefix. A worker dispatched before the brief edits the shared checkout, which later blocks worktree creation. A non-code profile (general, docs, research, ops) also declares the profile and keeps this dispatch ungated.
```

**脏基线。** 即使档案已经声明，`enhance_worktree create` 仍会拒绝
带未提交改动的基线，而脏基线没法分叉，于是会话被永久卡住。
`carry_base=true` 就是出路：

1. 未提交状态通过一个临时索引拍快照（`read-tree HEAD` + `add -A` +
   `write-tree` + `commit-tree`），得到的是一个 commit 对象，
   既不碰工作区，也不碰暂存区，更不碰引用命名空间。
   快照里既有已跟踪的改动，也有未跟踪的文件。
2. worktree 就建在那个快照上，所以 worker 从基线的真实内容出发，
   而 worktree 自身是干净的。
3. 基线保留自己的未提交状态。land 会把任务的工作成果叠加在其上，
   失败的 land 会精确还原被改动的那些路径以及已暂存/未暂存的划分，
   而携带之后基线又动过的情况会被拒绝（`worktree.base_changed`），
   而不是覆盖更新的工作。

写代码之前先在临时仓库里量过：拍快照后基线的 status 逐字节不变，
补丁里只有 worker 自己的活儿，还原能精确复现 land 之前的状态，
包括 `A  已暂存` 与 ` M 未暂存` 的区别以及那些未跟踪文件。

两个修复在真实会话里都成立：上面那轮复跑的拒绝数是 0，
档案在第一次会写代码的派发之前就声明好了，
后面的任务走了 carry 路径，落在了保留自己未提交状态的基线上。

有一条行为值得知道：`land` 默认不提交，
所以基线会把落地的改动留成未暂存状态。
于是下一个 worktree 是从脏基线出来的，还得再带一次 `carry_base=true`。

## 11. 两个 adapter 共用一套策略核心

Qoder 与 ZCode 两个 adapter 各自带了一份 conductor/worker 工具策略的
私有副本，于是同一个 payload 在两个 harness 上可能被判成不同的结果。
现在这份策略住在 `src/core/hook-policy.mjs`，而与 harness 无关的
recall MCP server 也从 Qoder adapter 挪到了
`src/mcp/recall-server.mjs`。

`test/adapter-conformance.test.mjs` 断言两个 adapter 都导入这份共享核心、
都不再定义那些私有副本，并且同一个 payload 在两边得到相同的决定与
相同的理由。

## 12. 保留期限与垃圾回收

`mhe gc` 先出计划，再按需执行。在这台机器上计划收集不到任何东西：
每个 artifact 要么被引用，要么还在自己的窗口内；state home 一共
3.6 MB，分布在 10 个 project 上。窗口分别是：metrics 与 logs 30 天
加 5 MiB，artifacts 30 天并有 7 天宽限，decisions 180 天（当前关闭），
worktrees 7 天。

## 13. 隔离检查（每次安装之后）

- `~/.qoder-cn/settings.json`：2772 字节，没有 `hooks` 键，MCP server 是
  `Hugging Face`、`GitHub`、`ComfyUI`、`rea`、`openviking`，没有 harness 条目。
- `~/.qoder-cn/hooks/`：空。
- `~/.zcode/hooks.json` 与 `~/.zcode/mcp.json`：0 处 harness 引用。
- A/B 全程跑在 `~/.mhe-test/` 下的
  `--config-dir` 副本里。

## 14. 同一 workspace 里的两个会话（F-12）

两个 `--session-id` 不同的 CLI 会话并发跑在同一个 workspace 上，
用的是隔离的 treatment config。各自拿到自己的分片。

| 检查项 | 结果 |
| --- | --- |
| 分片独立 | `sessions/<A>/` 与 `sessions/<B>/` 各自有 goal、brief、plan、capsule、session |
| 项目级共享 | config、decisions、metrics、artifacts、logs 与 sessions.json 留在项目根 |
| 不串台 | 两个 capsule 都不含对方会话的目标或任务 |
| `mhe report --session` | 各自 3 条指标，零交叉聚合 |
| 续跑 | `-r <id>` 记录 `source: "resume"` 并重建 capsule（256 tokens） |

goal、brief、plan 是按需创建的：一个不派发 worker 的 docs 会话
不会有 jobs、last-check 或 worktrees 文件。

一个观察：A 的 conductor 调了 `enhance_goal` 自己定了目标，
B 的 conductor 跳过了，于是 B 保留了 SessionStart 用 prompt 填的那个。
两种情况下分片都保持隔离，但"conductor 自己定目标"目前是约定，
不是被强制的东西。
