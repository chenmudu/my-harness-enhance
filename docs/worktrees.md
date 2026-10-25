# Worktrees for the code profile

> Chinese version: [worktrees.zh-CN.md](worktrees.zh-CN.md).

The `code` profile works best when each task edits in isolation instead of
sharing one checkout. This layer adds git-only worktrees under the user-level
state home, dependency gates at both worktree creation and worker dispatch,
worktree-aware checks, patch landing back onto a clean base checkout, and
automatic discovery of `npm` verification scripts or `node --test`.

## 1. Where worktrees live

```text
~/.my-harness-enhance/worktrees/<projectKey>/<sessionKey>/<task_id>
```

The directory is outside the target repository working tree, so no task
leaks files into the shared checkout. Git keeps its own bookkeeping in the
repository's `.git/worktrees/`; nothing else is written into the repo.
Respects `MY_HARNESS_ENHANCE_HOME` overrides.
New worktrees use the session directory; the old
`worktrees/<projectKey>/<task_id>` path stays readable for existing worktrees.

Registry: `~/.my-harness-enhance/projects/<hash>/sessions/<sid>/worktrees.json`
maps task id to `{ path, head, created_at, status }`, written atomically under
the state lock. The legacy project-level `worktrees.json` is read as a fallback
when a session registry does not exist yet.

## 2. `enhance_worktree` (MCP tool)

Actions: `create`, `list`, `diff`, `land`, `remove`. Arguments: `project`,
`session` (from the capsule), `action`, `task_id` (required except for `list`).
No arbitrary shell is exposed.

`create` enforces three gates, in order:

1. **Plan gate (code-level)**: `task_id` must exist in `plan.json`, and every
   `depends_on` task must have status `completed`. Otherwise the call returns
   a blocker listing each missing dependency with its status and nothing is
   created. This makes task ordering in the code profile enforced, not
   advisory.
2. **Clean baseline**: the project must be a git worktree with an empty
   `git status --porcelain`. Dirty baselines are rejected; there is no
   silent snapshot of uncommitted state.
3. **Safety**: `task_id` is a strict slug (no separators, no `..`), and the
   target must resolve inside the managed directory and outside the repo. An
   existing path is refused.

Creation runs `git worktree add --detach <path> HEAD` and returns
`{ ok, task_id, path, head, prompt_prefix }`. `prompt_prefix` is the exact
two-line dispatch header (`task_id: <id>` and `worktree: <path>`) to place at
the top of the worker prompt.

`diff` returns bounded output: `git diff <creation-base>` (committed, staged,
unstaged, and intent-to-add untracked work) capped at ~40k chars, plus the
changed-file list capped at 200 entries, with a `truncated` flag. Committed
worktree commits are included; the diff is not limited to `HEAD`.
`remove` is safe: uncommitted changes block removal. A worktree whose status
is `landed` can be removed with `discard=true` when cleanup left it dirty.

### Landing a task (`land`)

`land` moves a finished task's work from the isolated worktree back into the
main checkout as a patch, as a safe integration flow:

1. The worktree is resolved and validated exactly like `diff`/`remove`.
2. The base checkout must be clean (`worktree.dirty` blocker otherwise) —
   there is no silent patch onto uncommitted state.
3. Everything inside the worktree is staged with `git add -A` (the worktree
   is isolated and single-task), so the patch covers **committed, staged,
   unstaged, and untracked** work. A staging failure is a blocker. A worktree
   with no changes against its creation base is refused (`worktree.empty`).
4. The patch is produced with `git diff <creation-base> --binary`, so a worker
   that committed inside the worktree still lands correctly. It is applied to
   the main checkout only after `git apply --check` succeeds; a rejected patch
   stops before anything lands.
5. **Checks, default on** (`run_checks`, default `true`): before applying,
   `inputs` runs as a **preflight against the clean base** when the brief's
   checks include it; a preflight failure is a blocker
   (`worktree.inputs_preflight`) and nothing is applied or reverted. After
   applying, the remaining brief checks run against the **base checkout**
   (no `worktree` argument) with `inputs` excluded: the landed patch may
   itself edit input files, so re-hashing them post-apply would fail by
   design. If nothing remains after the exclusion, the land passes with a
   warning. If no brief exists, checks are skipped with a returned warning —
   never invented. Pass `run_checks: false` to opt out explicitly.
6. **Commit, opt-in** (`commit`, default `false`): if the checks pass,
   `git add -A` and create exactly one new commit, subject
   `harness: land <task_id>`. Existing history is never amended or reset.
   If the checkout cannot author a commit (no `user.name`/`user.email`), a
   deterministic harness identity is used
   (`my-harness-enhance <harness@local>`), and the result reports which
   identity was used.
7. **Failure is a full revert**: if the checks fail after applying (or a
   commit attempt fails), the base is restored to its pre-land state
   (`git reset --hard HEAD` plus `git clean -fd`, safe because the base was
   required clean and only contains the applied patch). The result carries
   `reverted: true`, the failed `checks` findings, and a blocker rule
   (`worktree.checks_failed`, `worktree.commit_failed`, ...). The worktree
   always stays intact so the worker can fix and re-land.
8. The result is bounded: `{ ok, task_id, applied_files, applied_count,
   patch_bytes, patch (≤40k chars, `truncated` flag), worktree, base,
   checks {ran, skipped, ok, checked, findings, summary},
   inputs_preflight (passed | failed | skipped),
   commit {created, hash, subject, identity}, task_status, warnings, note }`
   — never a raw dump.
9. **Landing is the completion point.** On success the plan task is marked
   `completed` and the worktree is reset to its creation base, with registry
   status `landed`; only then does `enhance_check` stop reporting
   `LAND REQUIRED`. Whatever post-apply checks ran are written as the
   durable `last-check.json` — on success (`landed: true`,
   `land_required: false`) and on failure (`landed: false`,
   `land_required: true`) — so the capsule and the dispatch/verification
   gates see the landed state without another `enhance_check` round.

With checks passing and `commit=false`, the main checkout is deliberately
left dirty: reviewing, testing further, and committing remain the
conductor's (or an integration worker's) job. The commit decision belongs to
the first `land` call (`commit=true`), because a landed base is dirty and a
second `land` is refused until the base is clean again. `land` never
auto-merges and never removes the worktree; removal stays explicit. A
successful `land` resets the worktree, so `remove` normally succeeds without
a manual reset; if the reset itself failed, `remove` accepts
`discard=true` only for a worktree already marked `landed`.

## 3. Worktree-aware checks

`runBriefChecks(root, brief, config, checkerIds, { worktree })` and
`enhance_check` accept an optional `worktree` path:

- `scope` runs `git status --porcelain --untracked-files=all` inside the
  worktree; ownership globs are relative to the worktree. Without a
  worktree, behavior is unchanged (the main checkout).
- `command:*` checkers run with the worktree as working directory, so tests
  exercise the task's code, not the clean baseline.
- The path is validated before anything runs: it must sit under the
  project's managed worktrees directory or appear in the registry, and its
  `git common dir` must match the project's. An invalid path is a hard
  blocker (`worktree.invalid`); checks never fall back to the main checkout.
- For a code task with an active worktree, `enhance_check` refuses to run
  without that worktree (`worktree.check_required`). A passing check keeps
  the owner `in_progress` and returns `task_ids_pending_land`; other
  dependent/verification ids stay pending in `task_ids_blocked_by_land`.
  Only a successful `land` marks the owner `completed`. The happy path calls
  `land` directly: it runs the same checks, so a separate `enhance_check`
  turn is unnecessary.
- `Stop` hooks in both adapters request continuation when a code worktree has
  unlanded changes, so a conductor cannot claim completion before landing.

## 4. Command auto-discovery

`command:<id>` checkers look for a registered command in
`config.verification.commands` first. If absent and the id is `test`, `lint`,
`typecheck`, or `build`, the checker inspects `package.json` scripts and runs
the matching npm script (`npm test`, `npm run lint`, ...). If `test` is
missing but Node test files exist, it falls back to `node --test`;
`NODE_TEST_CONTEXT` is stripped so a harness running under a test runner
still executes the project's tests. Registered commands still win; other ids
remain `command.unknown` blockers. Non-zero exit is a blocker; output stays
bounded at 1200 chars.

## 5. Dispatch dependency gate (code profile)

The Qoder conductor's `PreToolUse` hook enforces the plan graph at dispatch
time, not just at worktree creation:

- The gate runs only when the stored brief has `profile === 'code'`, and
  only for the conductor dispatching `Agent`/`Task`. Non-code briefs, other
  tools, and worker events are completely unaffected.
- A session that has no brief yet has not declared its profile. Dispatching a
  worker that can write is denied until the profile is declared, because such
  a worker would edit the shared checkout, and a later switch to the code
  profile would then find a dirty base that no worktree can be created from.
  Read-only workers (`Explore`, investigator, planner, verifier) stay
  dispatchable without a brief. A non-code profile (`general`, `docs`,
  `research`, `ops`) declares the profile without arming the worktree gate.
- Every code dispatch must name its plan task in the tool input `prompt`
  or `description`, e.g. the line `task_id: T2` (also accepted:
  `task_id=T2`; case-insensitive, first match wins), and must include
  `worktree: <path>` with the exact path returned by `create`.
- Missing `task_id` or `worktree` is denied. An id that is not in
  `plan.json` is denied. A dispatch whose `depends_on` tasks are not all
  `completed` is denied with the missing ids and their statuses (same check
  as `create`, via `checkTaskDependencies`). A mismatched worktree path is
  denied with the expected path.
- Once a task's deterministic check has passed, further dispatch for that
  task is denied; the conductor must call `enhance_worktree land` instead.

Example dispatch prompt that passes the gate:

```text
task_id: T2
worktree: <exact path returned by enhance_worktree create>
Implement the landing path in src/core/worktree.mjs. Work only inside
that worktree. Return the standard worker envelope.
```

## 6. Typical flow

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

## 7. Boundaries and limitations

- **Landing is patch application, not merging.** `land` refuses a dirty
  base and refuses a patch that does not apply cleanly (`apply --check`);
  it never resolves conflicts and never removes the worktree. Merge/cherry-
  pick strategies stay the conductor's responsibility. `diff` remains a
  bounded review patch, now including committed worktree work.
- Checks during `land` are **default on** against the base checkout and
  must be opted out explicitly (`run_checks=false`); commits are **default
  off** (`commit=true` to opt in). A failing check or commit reverts the
  base completely (`reset --hard` + `clean -fd`, sound only because the
  base was required clean beforehand) and keeps the worktree for a fix and
  re-land; existing history is never amended or reset.
- After a passing `land` without `commit`, the main checkout is dirty
  **by design**: further integration belongs to the conductor or an
  integration worker.
- Untracked files appear in `changed_files` and in the `land` patch; `diff`
  uses intent-to-add only while computing the patch and restores the index
  before returning.
- Gitignored files are never landed: staging inside the worktree uses
  `git add -A`, which respects `.gitignore`.
- The dispatch gate is hook behavior shared by the Qoder and ZCode adapters;
  it reads the same plan and brief state as `create`, so MCP and hook views
  cannot diverge.
- The project must be a git repository (git on PATH, worktree-capable
  git ≥ 2.31 for common-dir verification).
- Removal is non-forcing for unlanded work: a dirty worktree must be landed
  or explicitly cleaned by the user first. `discard=true` is accepted only
  after a successful landing.
- `~/.my-harness-enhance` must not be nested inside the project (rejected
  by the containment check).
