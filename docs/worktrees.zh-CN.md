# 代码档案（profile）的 worktree

> 本文是 [worktrees.md](worktrees.md) 的中文译本，如与原文有出入，以原文为准。

`code` 档案在每个任务隔离编辑、而不是共用同一个检出
（checkout）时表现最好。这一层会在用户级状态目录（state home）下添加
仅 git 的 worktree，在 worktree 创建和 worker 派发两处都设有依赖门禁
（dependency gate），提供感知 worktree 的检查、把补丁 land 回干净基线检出
的流程，以及 `npm` 验证脚本或 `node --test` 的自动发现。

## 1. worktree 放在哪里

```text
~/.my-harness-enhance/worktrees/<projectKey>/<sessionKey>/<task_id>
```

这个目录位于目标仓库的工作树（working tree）之外，因此不会有任务把文件泄漏
进共用的检出。Git 把自己的记账信息放在仓库的
`.git/worktrees/` 里；除此之外不会向仓库写入任何东西。
遵循 `MY_HARNESS_ENHANCE_HOME` 的覆盖设置。
新 worktree 使用会话目录；旧的
`worktrees/<projectKey>/<task_id>` 路径对已有 worktree 保持可读。

注册表（registry）：
`~/.my-harness-enhance/projects/<hash>/sessions/<sid>/worktrees.json`
把 task id 映射到 `{ path, head, created_at, status }`，并在状态锁（state lock）下原子
写入。当会话注册表不存在时，回退读取项目级的旧 `worktrees.json`。

## 2. `enhance_worktree`（MCP 工具）

动作：`create`、`list`、`diff`、`land`、`remove`。参数：`project`、
`session`（来自 capsule）、`action`、`task_id`（除 `list` 外均必填）。
不会对外暴露任意 shell 命令。

`create` 会按顺序强制三道门禁（gate）：

1. **plan 门禁（代码层）**：`task_id` 必须存在于 `plan.json` 里，并且每个
   `depends_on` 任务的状态都必须是 `completed`。否则调用会返回一个阻塞项
   （blocker），逐条列出每个缺失依赖及其状态，而且什么都不创建。这
   样 code 档案里的任务顺序就成了强制约束，而不是
   仅供参考的建议。
2. **干净基线（clean baseline）**：项目必须是一个
   `git status --porcelain` 为空的 git worktree。脏基线会被拒绝；不存在
   对未提交状态做静默快照这种事。`carry_base=true` 是显式的选择开关，
   它把未提交状态带进 worktree，而不是拒绝——见下面的
   「携带脏基线」。
3. **安全性**：`task_id` 是严格的 slug（没有分隔符、没有 `..`），并且
   目标路径必须解析到受管理目录之内、仓库之外。
   已存在的路径会被拒绝。

创建过程会运行 `git worktree add --detach <path> HEAD`，并返回
`{ ok, task_id, path, head, prompt_prefix }`。`prompt_prefix` 就是要放在
worker prompt 最前面的那两行派发头部（`task_id: <id>` 和
`worktree: <path>`），必须一字不差。

`diff` 返回有界（bounded）输出：`git diff <creation-base>`（已提交、已暂存、
未暂存，以及 intent-to-add 的未跟踪改动）以 ~40k 字符封顶，外加
最多 200 条的变更文件列表，并带有一个 `truncated` 标志。已提交的
worktree 提交也包含在内；diff 并不局限于 `HEAD`。
`remove` 是安全的：未提交的改动会阻塞移除。状态为 `landed` 的 worktree，
可以在清理之后仍然是脏的情况下用 `discard=true` 移除。

### 把一个任务 land 回主检出（`land`）

`land` 以一个补丁的形式，把已完成任务的工作成果从隔离的 worktree 搬回
主检出（main checkout），这是一条安全的集成流程：

1. worktree 的解析与验证完全照搬 `diff`/`remove` 的做法。
2. 基线检出必须是干净的（否则给出 `worktree.dirty` 阻塞项）——不会
   把补丁静默地打到未提交的状态之上。用 `carry_base=true` 创建的
   worktree 是唯一的例外：它的基线本来就应当持有被携带的状态，
   land 会检查基线是否仍然持有它。
3. worktree 里的一切都用 `git add -A` 暂存（worktree 是隔离的、
   只服务单个任务），所以补丁覆盖**已提交、已暂存、
   未暂存和未跟踪**的工作。暂存失败就是一个阻塞项。相对它的
   创建基线没有任何改动的 worktree 会被拒绝（`worktree.empty`）。
4. 补丁用 `git diff <creation-base> --binary` 生成，所以在 worktree 里
   提交过的 worker 依然能够正确 land。只有在 `git apply --check` 成功
   之后才把它应用到主检出；被拒绝的补丁会在任何东西 land 之前
   停下。
5. **检查，默认开启**（`run_checks`，默认 `true`）：在应用之前，当
   brief 的检查项里包含 `inputs` 时，它会作为**针对干净基线的预检
   （preflight）**运行；预检失败是一个阻塞项
   （`worktree.inputs_preflight`），既不会应用任何东西，也不会回滚任何东西。应用
   之后，剩余的 brief 检查针对**基线检出**运行（不带 `worktree` 参数），
   并排除 `inputs`：已经 land 的补丁本身就可能编辑输入文件，所以
   在应用之后重新计算它们的 hash 从设计上就一定会失败。排除之后
   若没有任何剩余项，land 会带着一条警告通过。如果不存在 brief，
   检查会被跳过并返回一条警告——绝不会凭空编造。请传 `run_checks: false`
   来显式退出。
6. **提交，需要主动选择**（`commit`，默认 `false`）：如果检查通过，
   就 `git add -A` 并恰好创建一个新提交，subject 为
   `harness: land <task_id>`。已有历史永远不会被 amend 或 reset。
   如果检出无法撰写提交（没有 `user.name`/`user.email`），就会使用一个
   确定性的 harness 身份
   （`my-harness-enhance <harness@local>`），并且结果会报告用的是哪个
   身份。
7. **失败就是完全回滚**：如果应用之后检查失败（或提交尝试失败），
   基线会被恢复到 land 之前的状态
   （`git reset --hard HEAD` 加上 `git clean -fd`，之所以安全是因为基线
   事先被要求是干净的，并且只包含被应用的那个补丁）。结果里会带上
   `reverted: true`、失败的那些 `checks` 发现项，以及一条阻塞项规则
   （`worktree.checks_failed`、`worktree.commit_failed` 等）。worktree 始终
   保持完好，这样 worker 可以修复之后再次 land。
8. 返回的结果是有界的：`{ ok, task_id, applied_files, applied_count,
   patch_bytes, patch (≤40k chars, `truncated` flag), worktree, base,
   checks {ran, skipped, ok, checked, findings, summary},
   inputs_preflight (passed | failed | skipped),
   commit {created, hash, subject, identity}, task_status, warnings, note }`
   ——绝不会倾倒原始内容。
9. **land 就是完成点。**成功时 plan 任务被标记为
   `completed`，worktree 被重置到它的创建基线，注册表状态为
   `landed`；只有到那时 `enhance_check` 才会不再报告
   `LAND REQUIRED`。所有在应用后运行过的检查都会被写成持久化的
   `last-check.json`——成功时（`landed: true`、
   `land_required: false`）和失败时（`landed: false`、
   `land_required: true`）都写——这样 capsule 和派发/验证门禁看到的就是
   已经 land 的状态，不需要再来一轮 `enhance_check`。

检查通过且 `commit=false` 时，主检出会被有意留在脏状态：评审、进一步
测试和提交仍然是 conductor（或一个集成 worker）的工作。提交
这个决定属于第一次 `land` 调用（`commit=true`），因为已 land 的
基线是脏的，而在基线重新变干净之前，第二次 `land` 会被拒绝。
`land` 从不自动合并，也从不移除 worktree；移除始终要保持显式。一次
成功的 `land` 会重置 worktree，所以 `remove` 通常不需要
手动重置就能成功；如果重置本身就失败了，`remove` 只对
已经标记为 `landed` 的 worktree 接受
`discard=true`。

### 携带脏基线（`carry_base`）

脏基线默认会被拒绝，拒绝信息里会点名这条逃生通道。
`create` 带上 `carry_base=true` 时改为给基线拍快照，而不是拒绝它：

1. 未提交状态通过一个**临时索引**捕获（`read-tree HEAD` + `add -A` +
   `write-tree` + `commit-tree`）：那是一个 commit 对象，既不碰工作区，
   也不碰用户自己的暂存区，更不碰引用命名空间。基线上不会被提交、
   不会 stash、也不会被回滚。快照里既有已跟踪的改动，也有未跟踪的
   文件（被 ignore 的除外），因为要基于基线继续干活的 worker 需要的是
   基线真实拥有的那些文件。
2. worktree 就**建在那个快照上**
   （`git worktree add --detach <path> <snapshot>`），所以 worker 从基线的
   真实内容出发，而 worktree 自身是干净的。
3. 基线保留自己的未提交状态，原封不动。快照会连同任务一起记进
   worktree 注册表，还会一并记下原始的暂存区状态，这样失败的 land
   才能精确还原已暂存/未暂存的划分。

对被携带的 worktree 做 `land`，是把任务的工作成果**叠加**在被携带的
状态之上：补丁是相对快照算出来的，所以它能打到脏基线上。
失败的 land 会把基线精确还原——同样的文件、同样的已暂存/未暂存
划分，用户的未跟踪文件不受影响。如果携带之后基线又动过，
land 会被拒绝（`worktree.base_changed`），而不是覆盖更新的工作。
`commit=true` 只提交被 land 的那些路径，所以被携带的工作永远不会被
卷进 harness 的那个提交里。

## 3. 感知 worktree 的检查

`runBriefChecks(root, brief, config, checkerIds, { worktree })` 和
`enhance_check` 都接受一个可选的 `worktree` 路径：

- `scope` 在 worktree 内部运行
  `git status --porcelain --untracked-files=all`；ownership glob 是相对于
  worktree 的。没有 worktree 时行为不变（就是主检出）。
- `command:*` 检查器（checker）以 worktree 作为工作目录运行，因此
  测试跑的是这个任务的代码，而不是干净的基线。
- 在任何东西运行之前先验证这个路径：它必须位于该项目的受管理
  worktrees 目录之下，或者出现在注册表里，并且它的
  `git common dir` 必须与项目的一致。无效路径是一个硬
  阻塞项（`worktree.invalid`）；检查绝不会回退到主检出。
- 对于一个存在活跃 worktree 的 code 任务，`enhance_check` 拒绝在没有
  那个 worktree 的情况下运行（`worktree.check_required`）。一次通过的检查会让
  owner 保持 `in_progress` 并返回 `task_ids_pending_land`；其他
  依赖方/验证方的 id 会留在 `task_ids_blocked_by_land` 里保持 pending。
  只有一次成功的 `land` 才会把 owner 标记为 `completed`。顺利路径直接
  调用 `land`：它运行的是同一批检查，所以额外的一轮
  `enhance_check` 并不必要。
- 两个 adapter 里的 `Stop` hook，在 code worktree 还有未 land 的改动时
  会请求继续，所以 conductor 无法在 land 之前宣称完成。

## 4. 命令自动发现

`command:<id>` 检查器会优先在
`config.verification.commands` 里查找已注册的命令。如果不存在且 id 是 `test`、`lint`、
`typecheck` 或 `build`，检查器就会查看 `package.json` 的 scripts 并运行
匹配的那个 npm 脚本（`npm test`、`npm run lint` 等）。如果 `test` 不
存在但 Node 测试文件确实存在，它就回退到 `node --test`；
`NODE_TEST_CONTEXT` 会被剥离，因此在某个测试运行器之下运行的 harness
仍然会执行项目自己的测试。已注册的命令依然优先；其他 id
仍然是 `command.unknown` 阻塞项。非零退出码就是阻塞项；输出保持
在 1200 字符的有界上限之内。

## 5. 派发依赖门禁（code 档案）

Qoder conductor 的 `PreToolUse` hook 在派发时刻就强制执行 plan 图，
而不只是在 worktree 创建时：

- 该门禁只在已存储的 brief 满足 `profile === 'code'` 时运行，且只
  针对派发 `Agent`/`Task` 的 conductor。非 code 的 brief、其他
  工具和 worker 事件完全不受影响。
- 还没有 brief 的会话等于尚未声明档案。
  此时派发「能写」的 worker 会被拒绝，直到档案被声明为止：这样的
  worker 会直接改共享 checkout，而之后再切到 code 档案就会遇到
  脏 base，任何 worktree 都无法从它创建。只读 worker
  （`Explore`、investigator、planner、verifier）在没有 brief 时
  仍然可以派发。非 code 档案（`general`、`docs`、`research`、`ops`）
  同样算声明了档案，只是不开启 worktree 门禁。
- 每一次 code 派发都必须在工具输入 `prompt` 或 `description` 里
  点名它的 plan 任务，例如 `task_id: T2` 这样一行（也接受
  `task_id=T2`；不区分大小写，第一个匹配生效），并且必须包含
  `worktree: <path>`，路径必须是 `create` 返回的那个精确路径。
- 缺少 `task_id` 或 `worktree` 会被拒绝。不在
  `plan.json` 里的 id 会被拒绝。`depends_on` 任务没有全部
  `completed` 的派发会被拒绝，并给出缺失的 id 和它们的状态（经由
  `checkTaskDependencies` 做的、与 `create` 相同的那个检查）。不匹配的
  worktree 路径会被拒绝，并给出期望的路径。
- 一旦某个任务的确定性检查已经通过，针对该任务的进一步派发就会被
  拒绝；conductor 必须改为调用 `enhance_worktree land`。

能通过该门禁的派发 prompt 示例：

```text
task_id: T2
worktree: <exact path returned by enhance_worktree create>
Implement the landing path in src/core/worktree.mjs. Work only inside
that worktree. Return the standard worker envelope.
```

## 6. 典型流程

```text
enhance_plan (tasks with depends_on)
enhance_brief (profile=code, ownership=[src/**, test/**])
enhance_worktree create task_id=T2      # returns prompt_prefix; blocked until T1 is completed
  -> dispatch the worker with task_id: T2 and worktree: <path> at the top
  -> worker edits only inside the worktree path; do not commit or audit
enhance_worktree land task_id=T2 commit=true
  -> runs the brief checks against the base; owner task completed; worktree reset
  -> checks fail: base reverted, worktree kept for a targeted fix
enhance_worktree remove task_id=T2     # explicit cleanup after landing
```

## 7. 边界与限制

- **land 是应用补丁，不是合并。**`land` 会拒绝脏基线，也会拒绝
  无法干净应用的补丁（`apply --check`）；它从不解决冲突，也从不
  移除 worktree。merge/cherry-
  pick 策略仍然是 conductor 的责任。`diff` 依旧是一个有界的评审
  补丁，现在也包含已提交的 worktree 工作。
- `land` 期间的检查**默认开启**，针对的是基线检出，
  必须显式选择退出（`run_checks=false`）；提交是**默认关闭**
  （`commit=true` 才是选择进入）。失败的检查或提交会把基线完全
  回滚（`reset --hard` + `clean -fd`，只有因为事先要求基线干净
  它才是可靠的），并保留 worktree 用于修复和再次
  land；已有历史永远不会被 amend 或 reset。
- 一次通过的 `land` 但没有 `commit` 之后，主检出是脏的，
  **这是设计如此**：后续集成属于 conductor 或一个
  集成 worker。
- 未跟踪的文件会出现在 `changed_files` 里，也会出现在 `land` 的补丁里；
  `diff` 只在计算补丁的过程中使用 intent-to-add，并在返回之前
  恢复索引。
- 被 Git 忽略的文件永远不会被 land：worktree 内的暂存用的是
  `git add -A`，它会遵守 `.gitignore`。
- 派发门禁是 Qoder 和 ZCode 两个 adapter 共享的 hook 行为；
  它读取的 plan 和 brief 状态与 `create` 完全相同，所以 MCP 视图和
  hook 视图不可能分叉。
- 项目必须是一个 git 仓库（PATH 里有 git，并且有支持 worktree 的
  git ≥ 2.31，用于 common-dir 验证）。
- 对于未 land 的工作，移除不是强制性的：一个脏 worktree 必须先被 land，
  或者由用户先显式清理。`discard=true` 只在一次成功的 land
  之后才会被接受。
- `~/.my-harness-enhance` 不得嵌套在项目内部（会被包含性
  检查拒绝）。
