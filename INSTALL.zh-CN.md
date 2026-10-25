# 安装 — my-harness-enhance

> 本文是 [INSTALL.md](INSTALL.md) 的中文译本，如与原文有出入，以原文为准。

**读者：在一台机器上安装本项目的 agent/LLM。** 按对应的平台/harness
章节操作，运行验证命令，并如实报告哪些是复用的、哪些是新装的、
哪些被跳过了。

核心规则：**复用优先**。优先级是官方 harness agent > 用户已装的
agent > 我们的 `mhe-*` fallback。绝不删除官方 agent。只有当能力表
证明存在缺口时才安装 fallback。状态存放在用户目录，
绝不放在项目仓库里。

---

## 1. 前置检查（Preflight）

1. Node.js `^22.19.0 || >=24.0.0`：
   ```bash
   node -v
   ```
2. 已安装 harness。本仓库实现 **Qoder**（第一个 adapter）和 **ZCode**
   （第二个 adapter）。两个 harness 分别安装；不要把一个 adapter 的命令
   套到另一个上。
3. 选定要增强的**项目（project）**。用一个专门的项目：auto 模式下，该项目里的
   每个主会话都会成为 conductor。不要在仍在跑旧的临时工作流的
   workspace 里启用它。
4. 找到 harness 配置目录：
   - Qoder：若设置了 `QODER_CONFIG_DIR`，以它为准；Windows
     `%USERPROFILE%\.qoder-cn`（CN）或 `%USERPROFILE%\.qoder`（INTL）；
     macOS/Linux `~/.qoder-cn` 或 `~/.qoder`。
   - ZCode：若设置了 `ZCODE_CONFIG_DIR`，以它为准；否则
     `~/.zcode/cli`。
5. 清点 agent（不要改动官方的）：
   ```bash
   ls "<qoder-config-dir>/agents"
   ```
   官方内置 agent 不是文件：`general-purpose`、`Explore`。
   Qoder 的无工具推理角色使用 `mhe-reasoner` fallback；旧的
   用户 `reasoner` 留在磁盘上，但**不再被选中**。
   `env-runner` 是旧的自定义 executor，同样**不再被选中**。
   ZCode 的自定义 agent 由 plugin 提供；`<zcode-config-dir>/agents`
   是运行时 subagent 存储，不是 agent 定义目录。不要把 `.md` 定义放进去。
6. 绝不删除 `general-purpose` 或 `Explore`；只有用户明确要求时才移除
   某个用户 agent。

状态目录（所有平台）：`~/.my-harness-enhance`（Windows：
`%USERPROFILE%\.my-harness-enhance`）。不会向仓库写入任何内容。

---

## 2. 写死的能力策略（capability policy）

这不是一个 LLM 打分步骤。安装器按顺序套用这张表。

| 角色 | 优先复用 | 次选 | 仅缺口时安装 |
|---|---|---|---|
| investigate | `Explore`（官方） | `general-purpose` | `mhe-investigator` |
| plan | `Explore` | `general-purpose` | `mhe-planner` |
| execute | `general-purpose`（官方） | — | `mhe-executor` |
| verify_read | `Explore` | `general-purpose` | `mhe-verifier` |
| verify_run | `general-purpose` | — | `mhe-verifier` |
| write | `general-purpose` | — | `mhe-writer` |
| reason | — | — | `mhe-reasoner` |
| lead | `general-purpose` | — | `mhe-lead` |

按 agent 类型划分的工具策略：

- `Explore`：只读；允许它的原生 Bash 做只读检查；禁止
  Write/Edit/Agent/Task。
- `general-purpose`：官方的 executor/lead；文件系统工具全开；作为 worker
  时禁止 Agent/Task（只允许一级派发）。
- `env-runner`：旧的用户自定义 executor；不再被选中。
- `reasoner`：旧的无工具 agent；留在磁盘上但不被选中。
- `mhe-reasoner`：无工具；只做分析。
- `mhe-*`：与所属角色的策略一致；所有 worker 都是叶子节点。

运行时规则：若选中的 worker 失败或返回非法 envelope，
conductor 会尝试该角色列出的下一个候选。只有能力缺失
才会导致安装一个 fallback agent。

Adapter 特定的 reason 处理：

- **Qoder** 在 role 空缺时安装 `mhe-reasoner` 无工具 fallback。
- **ZCode** 没有无工具内置 agent，也没有可写的自定义 agent 定义目录。
  adapter 把 `reason` 解析为内置只读 `Explore`，标记
  `compatibility: readonly`。conductor 必须指示它只根据给定材料推理、
  不要使用工具；实际约束是 Explore 自己的只读策略。严格无工具需要额外
  安装 ZCode plugin agent。

在本机上的预期 Qoder 结果是 **1 个 fallback agent**（`mhe-reasoner`）：

```text
investigate -> Explore
plan        -> Explore
execute     -> general-purpose
verify_read -> Explore
verify_run  -> general-purpose
write       -> general-purpose
reason      -> mhe-reasoner
lead        -> general-purpose
```

---

## 3. 在 Qoder 上安装

在仓库根目录执行：

**全局模式（global mode）是推荐的默认方式：一台机器安装一次，之后任意
workspace 都可用。**

```bash
# 1) inspect: no writes
node bin/mhe.mjs install qoder --global --dry-run

# 2) real install: backs up settings.json, merges hooks/MCP, writes global.json
node bin/mhe.mjs install qoder --global

# 3) restart Qoder ONCE so the harness-enhance MCP server reloads in global mode

# 4) open ANY workspace and start a NEW session. No agent/model selection.
#    SessionStart (startup/new/clear) auto-registers that workspace.

# 5) verify (after the first session, or before it in global mode)
node bin/mhe.mjs doctor --root "<any-workspace>"
node bin/mhe.mjs capabilities --root "<workspace>"
```

全局安装会做的事：

- 写入 `~/.my-harness-enhance/global.json`，其中 `autoRegister: true`；
- 合并 7 个 Qoder hooks 和 `harness-enhance` MCP server（全局 env；
  不绑定固定项目）；
- **不**注册任何项目，也**不**向任何 workspace 写入；
- 移除遗留的 `hr-*` agent（是我们创建的），保留官方/用户 agent；
- 保留旧的 `bash-delegate` hook，但如果它存在会给出警告。

在某个 workspace 的第一个**新**会话上，hook 会：

- 把该 workspace 注册进 `~/.my-harness-enhance/projects.json`；
- 针对该 workspace 从官方/用户 agent 解析能力；
- 创建 `config.json` + `capabilities.json`，位于
  `~/.my-harness-enhance/projects/<hash>/` 目录下；
- 注入 conductor 策略和 capsule；原生主会话成为
  conductor。

已经在运行的会话**不会被 retrofit**；只有新会话才会自动注册。
MCP 的 `enhance_*` 工具从 capsule 中取 `project: <PROJECT>`；如果省略，
就回退到 `MY_HARNESS_ENHANCE_PROJECT` 或 MCP 进程的 cwd。全局的
`active.json` 不用于路由，因此并行的 workspace 彼此隔离。

单个项目仍然可以使用 project-scoped 安装：

```bash
node bin/mhe.mjs install qoder --root "<absolute-project-path>"
```

它会立即注册该项目，并能为能力缺口安装 `mhe-*` fallback agent；
想要严格的逐项目控制或需要 fallback 时使用它。

---

## 3b. 在 ZCode 上安装

ZCode 是第二个 adapter。它使用 ZCode 原生 hooks 和 MCP，不向目标
workspace 写入任何内容。

```bash
# 1) inspect: no writes
node bin/mhe.mjs install zcode --global --dry-run

# 2) real install: backs up the ZCode config, merges hooks/MCP
node bin/mhe.mjs install zcode --global

# 3) restart ZCode ONCE so hooks and the MCP server reload

# 4) open a NEW session in any workspace; SessionStart auto-registers it

# 5) verify
node bin/mhe.mjs doctor zcode --root "<workspace>"
node bin/mhe.mjs capabilities --root "<workspace>"
```

ZCode 全局安装会：

- 把 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`
  hooks 合并进 `<zcode-config-dir>/config.json`；
- 打开 `hooks.enabled` 并添加 `harness-enhance` MCP server；
- 在 `~/.my-harness-enhance/global.json` 写入 `zcode` 自动注册标记；
  Qoder 的全局设置保持不变；
- 不写 agent 定义、不写项目仓库，也不安装 no-tools agent
  （见上面的 reason compatibility）。

项目级安装同样可用：

```bash
node bin/mhe.mjs install zcode --root "<project>"
node bin/mhe.mjs doctor zcode --root "<project>"
```

ZCode 特定契约：

- 没有 SubagentStart/SubagentStop。hook 要求 conductor 的每个
  `Agent`/`Task` prompt 内嵌 `enhance_worker_contract` 文本，并在 dispatch
  时记录 synthetic job，在 PostToolUse 完成。
- 没有 result rewrite。worker 结果必须通过 contract 保持紧凑；原始结果仍会
  到达 conductor。
- 没有 PreCompact。capsule 在 `Stop` 写入，并在 `SessionStart` 的
  `source=compact` 时重新注入。
- code brief 下，dispatch 还必须带 `task_id: <plan id>`；依赖必须 completed。

---

## 4. 平台说明

| 平台 | Qoder 配置 | 状态目录 | 说明 |
|---|---|---|---|
| Windows | `%USERPROFILE%\.qoder-cn` / `.qoder` | `%USERPROFILE%\.my-harness-enhance` | hook 命令会给 `node.exe` 加引号并使用正斜杠路径；无需管理员权限 |
| macOS | `~/.qoder-cn` / `~/.qoder` | `~/.my-harness-enhance` | 相同的 hooks；`process.execPath` |
| Linux | `~/.qoder-cn` / `~/.qoder` | `~/.my-harness-enhance` | 相同的 hooks；`process.execPath` |

代码里没有硬编码的盘符路径。安装器使用
`os.homedir()` 和 `process.execPath`；hook 命令按当前平台
生成。

多台机器：在每台机器上各自执行这份 runbook。项目源码是可移植的；
状态/注册表是每台机器本地各一份。不要把另一台机器的
`~/.my-harness-enhance` 状态拷贝过来。

---

## 5. 状态文件与仓库污染

```
~/.my-harness-enhance/
  projects.json                         # project path -> state dir
  projects/<hash>/
    config.json                         # conductor mode, capability config, logging
    capabilities.json                   # resolved role -> native agent mapping
    decisions.jsonl                     # append-only decisions
    sessions.json                       # host session -> id, host_pid, cwd, last_seen
    artifacts/                          # evidence (local; may contain secrets)
    logs/                               # errors-only by default
    metrics.jsonl
    sessions/<sid>/
      goal.json                         # canonical goal/acceptance/constraints
      brief.json                        # shared brief for this session
      plan.json                         # task graph
      jobs.json                         # worker routing/status
      session.json                      # current session role/model/source
      last-check.json                   # durable deterministic check result
      capsule.md                        # compact state injected into the conductor
      journal.md                        # follow-up prompts
      worktrees.json                    # task id -> path, head, status
  worktrees/<projectKey>/<sessionKey>/<task_id>
  legacy/                               # migrated old .router dirs
```

- 工作状态按会话放在 `sessions/<sid>/` 下；config、capabilities、
  decisions、artifacts、metrics、`sessions.json` 和 logs 是共享的。
- 项目仓库里没有 `.router`。
- `logs/` 默认 **errors-only**；想在
  `config.json` 里设 `logging: "decisions"` 可做完整的决策审计，设 `"off"` 则关闭。
- `capsule.md` 是工作状态，不是聊天记录。
- `jobs.json` 是路由表。
- `artifacts/` 可能包含敏感内容；保持在本地，
  分享前先做脱敏处理。

---

## 6. 验证

```bash
node --test                 # 327 tests
node bin/mhe.mjs bench      # main-context simulation
node bin/mhe.mjs demo       # state/contract/artifact demo
node bin/mhe.mjs doctor --root "<project>"
```

真实会话检查清单：

1. 在项目里新开一个 Qoder 会话；不需要选 agent/model。
2. conductor 只应调用 `Agent`/`Task` 和 `enhance_*`；如果它去调用
   Bash/Read/Write/Edit，hook 会拒绝并提示它去派发。
3. worker 应为：investigate/plan/verify_read 用 `Explore`，
   execute/write/verify_run 用 `general-purpose`，纯推理用
   `mhe-reasoner`，lead/复杂任务用 `general-purpose`。
4. conductor 把 `enhance_plan` 作为唯一的任务图；原生
   `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` 被拒绝。
5. `capsule.md`、`jobs.json` 和 `logs/` 只应因 conductor/worker 活动而出现；
   无关会话保持静默。
6. 非法的 worker 结果在到达 conductor 之前会被替换成有效的失败 envelope；
   该 job 同时记录 `retryable: true` 和 `next`。
7. 对比 Qoder 的 context 面板：conductor 的 `messages` 占比应保持平稳，
   而不是随原始工具输出增长。

没有真正跑过真实 Qoder 会话，就不要声称它通过了验证；
安装器/hook 模拟不是真实的模型会话。

---

## 7. 清理、迁移与回滚

```bash
node bin/mhe.mjs disable --root "<project>"   # hooks no-op, installation stays
node bin/mhe.mjs enable --root "<project>"
node bin/mhe.mjs uninstall qoder --root "<project>"  # remove hooks/MCP/our agents
node bin/mhe.mjs reset --root "<project>"           # archive goal/jobs/artifacts, keep config/capabilities
```

- `uninstall` 会移除 `harness-enhance` hooks/MCP 和 `mhe-*`/`hr-*` agent；
  它保留 `general-purpose`/`Explore`（官方）和用户自有的 agent，
  并保留用户级状态以便查看。
- 每次写入前都会在 `settings.json` 旁边生成设置备份。
- 移除遗留 `hr-*` 是预期行为；它们是我们创建的。官方 agent
  永不删除。
- `mhe-reasoner` 是已安装的无工具 fallback。若旧会话仍引用它，
  保留旧的 `reasoner` 文件，
  但不要把它放回能力表。

---

## 8. 故障排查

| 症状 | 检查 |
|---|---|
| hooks 不触发 | `mhe doctor`；配置目录；开一个**新**会话；设置备份 |
| conductor 未被识别 | 项目已注册？cwd 在项目内？`programs.json` 条目；auto 模式 |
| 缺少 MCP `enhance_*` 工具 | 设置里的 `mcpServers.harness-enhance`；`MY_HARNESS_ENHANCE_PROJECT`；新会话 |
| worker 未被使用 | `mhe capabilities`；conductor 可能选了靠后的候选 |
| 没有 capsule/jobs/logs | 日志默认 errors-only；检查状态目录；常规操作不写审计日志 |
| 9B conductor 不派发 | 旧的 `bash-delegate` hook 可能挡住原生 worker；改用非 9B 模型或移除那个旧 hook |
| Qoder CN 与 INTL | `QODER_CONFIG_DIR`、`~/.qoder-cn`、`~/.qoder` |
| 仓库里仍有遗留 `.router` | 重新执行 install；它会迁移/移除；不要提交它 |

---

## 9. ZCode adapter 状态与限制

ZCode adapter 已实现项目级和全局模式。它只安装 hooks 和共享 MCP server；
不会往 `<zcode-config-dir>/agents` 写 agent 定义（该目录是运行时 subagent
存储）。

以下能力是补偿而不是原生支持：

- **没有 SubagentStart**：conductor 每次 `Agent`/`Task` 的 prompt 必须带
  `enhance_worker_contract` 文本，否则 PreToolUse 拒绝派发。
- **没有 SubagentStop**：dispatch 时记录 synthetic running job，PostToolUse
  完成（并行同类型 worker 用 FIFO 匹配）。
- **没有 result rewrite**：contract 让 worker 输出保持紧凑，但原始工具结果仍会
  到达 conductor；不要声称输出被改写。
- **没有 PreCompact**：`Stop` 写 capsule；compact-source `SessionStart`
  重新注入 capsule。
- **没有 no-tools agent**：`reason` 解析到内置 `Explore`，标记
  `compatibility: readonly`。conductor 指示它不要用工具，Explore 的只读策略
  是实际约束。严格 no-tools 需要额外安装 ZCode plugin agent。

MCP server 与 Qoder 共享；两个 adapter 使用同一套用户级状态和
brief/check/worktree 能力。安装 ZCode 后必须重启一次，hooks/MCP 才会加载。
用 `mhe doctor zcode --root "<project>"` 和
`mhe capabilities --root "<project>"` 验证；`reason` 应显示只读兼容，
而不是 missing fallback。
