# brief 与确定性检查

> 本文是 [brief-checks.md](brief-checks.md) 的中文译本，如与原文有出入，以原文为准。

conductor 应当在 fan-out 之前创建一份共享的 **brief**，并在验收结果之前
运行**确定性检查**。这取代了原先那种昂贵的
模式：

```text
translate all files -> full LLM audit -> harmonize -> final audit
```

改为：

```text
brief + parallel workers -> deterministic check -> accept (or targeted fix)
```

## 1. brief

`enhance_brief` 把 brief 存入 `~/.my-harness-enhance/projects/<hash>/sessions/<sid>/brief.json`，并
把它的紧凑形式注入每个 worker。

字段：

| 字段 | 含义 |
|---|---|
| `profile` | `general`、`docs`、`code`、`research`、`ops` |
| `inputs` | 在 brief 时捕获的源路径 + SHA256 |
| `pairs` | docs 任务：源文件 -> 中文目标文件 |
| `glossary` | 源术语、目标术语、`translate` 或 `keep` |
| `ownership` | code 任务允许改动的文件 glob（通配模式） |
| `checks` | 检查器（checker）id：`inputs`、`docs`、`scope`、`command:test/lint/typecheck/build`，或一个已注册的命令 |
| `notes` | 特定档案（profile）的规则（格式、行尾、代码围栏） |

对于一个 docs 任务：

```json
{
  "profile": "docs",
  "glossary": [
    { "source": "tool", "target": "工具", "mode": "translate" },
    { "source": "worker", "target": "worker", "mode": "keep" }
  ]
}
```

省略该项时，配对会从 `*.zh-CN.md` 文件自动发现。

对于一个 code 任务：

```json
{
  "profile": "code",
  "ownership": ["src/**", "test/**", "package.json"],
  "checks": ["scope", "command:test"]
}
```

`profile: code` 的默认值是 `scope` 和 `command:test`。`command:test`
对 code 任务是强制的：scope/lint/build 检查不能取代它。`inputs` 是
**针对 `land` 的前置守卫（preflight guard）**，而不是 land 之后的检查：land 会
在应用补丁*之前*，针对干净基线为 inputs 计算 hash（失败即为
`worktree.inputs_preflight` 阻塞项），并把 `inputs` 排除在
应用后的检查之外，因为已 land 的补丁可能合理地修改 brief 已算过
hash 的文件。用 `inputs` 固定那些在 brief 与交付之间不得漂移的
参考文件。

`command:test` 会被自动发现：
优先取 `config.verification.commands.test`；否则当 `package.json` 有 `test`
脚本时用 `npm test`；否则当存在 Node 测试文件时用 `node --test`。`lint`、`typecheck`
和 `build` 使用对应的 npm 脚本。
已注册的命令仍然优先，它们也是运行任意命令
id 的唯一方式。

非法的检查器 id 和 shell 字符串会被 `enhance_brief` 拒绝；请使用
检查器 id，而不是命令。文档对等性（parity）请用 `docs`，而不是 shell 测试。

## 2. 检查

`enhance_check` 返回有界的 JSON：

```json
{
  "ok": false,
  "checked": ["inputs", "docs"],
  "findings": [
    { "level": "blocker", "rule": "docs.fence-content", "message": "..." }
  ],
  "summary": { "blockers": 1, "warnings": 0, "infos": 0 },
  "task_ids_completed": [],
  "task_ids_pending_land": [],
  "task_ids_blocked_by_land": []
}
```

内置检查器：

- `inputs`：每个输入的 hash 仍与 brief 一致；源文件过期是一个
  阻塞项。`land` 在应用之前运行它，绝不在之后。
- `docs`：标题、围栏代码块的内容、表格、内联代码、数字
  多重集合（multiset）、未解析的链接、行尾，以及术语表词条。
- `scope`：使用 `git status --porcelain` 和 `ownership`；code 任务需要一个
  git worktree。ownership 之外的文件是阻塞项。
- `command:<id>`：一个已注册的命令；非零退出即阻塞项。

`enhance_check` 会写入 `last-check.json`，capsule 会显示它的状态。对于
docs 和非 worktree 的检查，传入 `task_ids` 会把那些 plan 任务标记为
completed。对于有活跃 worktree 的 code 任务，检查必须伴随该
worktree 运行，会设置 `land_required: true`，并让 owner 保持 `in_progress` 且
带上 `task_ids_pending_land`；其余依赖/验证任务的 task id 保持
pending，并在 `task_ids_blocked_by_land` 中上报。只有
`enhance_worktree land` 才会把 owner 标记为 completed。

## 3. 策略

- 确定性检查先运行。
- 全量语义审计只用于检查失败、需求含糊，或者
  抽样评审；它不是默认动作。
- 失败的检查路由到所属的 task/文件；不要发起一轮全局的
  一致化（harmonization）修补。
- worker 都是叶子节点。conductor 是唯一的路由者。
- `check_result` 在 worker envelope 中仅供参考；`enhance_check` / `land` 才是
  权威结果。worker 永远不能把自己的 plan 任务标记为 complete。
  每个 envelope 都会被标上 `check_result.source: worker`，
  而 harness 自己写的 `last-check.json` 标 `source: harness`，
  两者不会被读成同一个事实。worker 引用的 artifact handle 会到 store 里核对，
  缺失的会列进 `provenance.artifacts_missing`，
  而不是被静默接受。
- 不要在确定性检查之前派发验证 worker，也不要用 worker 去替代
  一个配置错误的检查；修正 brief 后重新运行。

## 4. code 专属规则

- code worker 的 ownership 必须互不相交；否则就串行执行。
- 优先为每个 worker 使用一个 git worktree 或隔离的 checkout。code 档案
  使用 `enhance_worktree`；code worker 必须在精确注册过的
  worktree 内运行，并且在 `land` 成功之前，交付都未完成。
- 在 worker 内运行有针对性的测试；`land` 会针对基线把 brief 检查重跑
  一次，所以不要额外加一个验证 worker。
- 保持 worker 提示精简：不要要求 hash、对等性脚本、完整的
  自我审计、提交、分支或合并。worker 把改动留在
  worktree 里；`land` 负责集成。
- 不要让 worker 弱化测试；测试文件是被归属/冻结的，或者单独
  评审。
- 按设计，没有 git 的 code 任务对 `scope` 来说就是阻塞项。

## 5. 任务粒度

一个任务是一个**交付单元（delivery unit）**：一个 owner、一套 brief/检查、一个
worktree/land 边界。它不是一个步骤。

- **合并是默认。** 当小的独立文件或工作项共享 ownership 和检查，且能装进一个 worker
  context 时，就把它们放进一个任务：docs 最多
  3 个小文件或总共约 500 行；code 是一个连贯的改动，通常 <=3
  个文件，包含它的测试。
- **只在** ownership 或检查不同、依赖要求串行、工作量大到可以并行化，
  或 worker 返回 `needs_split` 时，
  才拆分。
- **绝不是任务。** 验证/检查、commit/land、清理，以及
  plan/reason 都是 harness 职责（`enhance_check`、`land`、capsule），不是
  plan 任务。
- **单小文件下限。** 没有可合并的东西：一个 execute worker
  就是下限，不额外添加 verify/cleanup worker。如果这仍然
  比直接会话更慢，那是一个快速路径（fast-path）决策，而不是拆分
  决策。

四个 e2e 会话各自运行了一个 execute worker；额外的时间来自
worker 启动和 conductor 轮次——以及，在这个修复之前，来自
verify/cleanup 任务——而不是来自文件数量。

## 6. 升级后重启

`enhance_brief` 和 `enhance_check` 是 MCP 工具。安装这个版本后，重启一次 Qoder 或 ZCode，
这样正在运行的 `harness-enhance` MCP server
会重新加载新的工具列表和描述。hooks（brief 注入、plan 同步、
派发门禁（dispatch gates））使用全新的 hook 进程，立即生效。
