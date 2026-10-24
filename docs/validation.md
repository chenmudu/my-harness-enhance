# Validation log (2026-10-18, v0.2)

> Chinese version: [validation.zh-CN.md](validation.zh-CN.md).

This records what was actually run on this machine, not what is planned.

## 1. Test suite

```bash
cd D:/project/github/my-harness-enhance
node --test
```

Result: **202 tests, 202 pass, 0 fail**.

> 2026-10-24 复核：新增 20 条测试（8 条修复回归、7 条文档结构、2 条 report、1 条 hook 遥测、1 条 tail 读取、1 条 MCP 诊断），Windows 222/222；macOS 基线未复跑。同日 demo 输出为 715 envelope tokens / 389 capsule tokens（上方 2026-10-18 数字保留为历史记录）。

Coverage includes:

- contract parse/validate/compact, invalid-result replacement, and explicit
  truncation warnings;
- user-level state registry, goal/plan/jobs/decisions/session/metrics, lock, and
  a 6-process concurrent job-upsert test;
- content-addressed artifacts, bounded read, English/Chinese search;
- native-agent capability policy (`Explore`, `general-purpose`, `mhe-reasoner`)
  and `mhe-*` fallback resolution; leaf-worker enforcement (no nested Agent/Task);
- hooks: dormant outside registered projects, auto conductor, native worker
  policies, native TaskCreate/Get/Update/List denial, SubagentStart contract,
  SubagentStop valid/invalid with retryable jobs, PostToolUse normalization,
  invalid-result artifact handles, large-output capture, PreCompact, disabled
  no-op, errors-only logging;
- installer: native reuse, one `mhe-reasoner` fallback on this machine,
  missing-reasoner fallback, legacy `hr-*` removal, legacy `.router` migration,
  idempotency, uninstall keeping official/user agents;
- MCP server: `enhance_*` tools, goal/state/capabilities/recall, id-only plan
  tasks, cwd-vs-active isolation, invalid handle;
- capsule: one shared hook/MCP budget, leaf-only worker contract;
- benchmark and demo.

## 2. Demo and benchmark

```bash
node bin/mhe.mjs demo
node bin/mhe.mjs bench
```

Demo: 3 plan tasks, 4 envelopes (~665 estimated tokens), capsule ~339 tokens,
verifier checks 3 (2 pass), simulated 54,767 -> 7,457 (86.4% reduction).

Benchmark (main context only):

| scenario | baseline | conductor | reduction |
|---|---:|---:|---:|
| light | 34,122 | 7,170 | 79.0% |
| medium | 92,623 | 9,061 | 90.2% |
| heavy | 244,023 | 12,741 | 94.8% |

## 3. Qoder installation (v0.2, auto, native reuse)

```bash
node bin/mhe.mjs install qoder --root "D:/project/github/my-harness-enhance"
```

Observed:

- config dir: `C:\Users\Administrator\.qoder-cn`
- state dir: `C:\Users\Administrator\.my-harness-enhance\projects\7aec27593e59fcf2`
- settings backup: `C:\Users\Administrator\.qoder-cn\settings.json.harness-enhance-20261018060404.bak`
- capability mapping:
  - investigate -> `Explore`
  - plan -> `Explore`
  - execute -> `general-purpose`
  - verify_read -> `Explore`
  - verify_run -> `general-purpose`
  - write -> `general-purpose`
  - reason -> `mhe-reasoner`
  - lead -> `general-purpose`
- fallback agents installed: `mhe-reasoner` (no official no-tools equivalent)
- removed legacy agents: `hr-executor`, `hr-investigator`, `hr-lead`,
  `hr-planner`, `hr-reasoner`, `hr-router`, `hr-verifier`, `hr-writer`
- official/user agents kept: `general-purpose`, `Explore`, `env-runner`,
  `reasoner`
- hooks installed: SessionStart, UserPromptSubmit, PreToolUse, SubagentStart,
  SubagentStop, PostToolUse, PreCompact, Stop
- MCP server: `harness-enhance` (stdio); legacy `harness-router` removed
- repo `.router`: absent
- `mhe doctor`: all checks ok

### Global mode (installed 18:30)

```bash
node bin/mhe.mjs install qoder --global
```

Observed:

- `~/.my-harness-enhance/global.json` -> `autoRegister: true`,
  `configDir: C:/Users/Administrator/.qoder-cn`;
- Qoder MCP `harness-enhance` env -> `MY_HARNESS_ENHANCE_GLOBAL=1` (no fixed
  project);
- 8 hooks installed globally; settings backup
  `settings.json.harness-enhance-20261018103042.bak`;
- `doctor --root D:/project/github/blog` (an unregistered workspace) -> ok,
  showing global mode and "auto on first session";
- auto-register is restricted to **new** SessionStart (`startup`/`new`/`clear`).
  A PreToolUse-only test on an unregistered workspace stayed silent (test added).
- An accidental registration of the already-running workspace-root session was
  found and cleaned; existing sessions are not retrofitted.
- MCP `enhance_*` tools resolve per `project` argument, then
  `MY_HARNESS_ENHANCE_PROJECT`, then the MCP process cwd; the global
  `active.json` is no longer a fallback. Capsule includes `PROJECT`.
- Qoder was restarted at 18:33:37; the new MCP server process started at 18:33:44
  (PID 19708) from the global code.
- First global workspace session `aebbad10-e969-468e-bbfc-202aa5d9c5a2`
  (cwd `D:\project\github`, model `qfmodel`): auto-registered, conductor
  policy/capsule created, and the conductor delegated to native `Explore`.
- First Explore result was rejected because evidence entries were file paths
  (old strict handle check). Fixed: evidence accepts paths/URLs; only artifacts
  require internal handles.
- The conductor re-delegated with the inline contract; second Explore returned
  `status=ok` and the conductor produced the final answer at 18:39:33
  (24 directories, 22 non-empty projects).
- `mcp_get` gateway calls targeting `harness_enhance` are allowed; calls to other
  MCP servers remain denied.
- Per-session conductor map added: only the session marked at SessionStart is
  enforced; the older workspace-root session `76ec7a18` was not hijacked.
- Global mode is now validated end-to-end on a real new workspace session.

## 4. Installed-hook simulation (native agents)

Using the exact commands from `settings.json`, with `cwd` in the project and
`model=qfmodel` (auto mode, no selection):

- `SessionStart` -> `MY-HARNESS-ENHANCE CONDUCTOR` policy + capsule + WORKERS
  mapping.
- `PreToolUse` `Bash` -> deny.
- `PreToolUse` `Agent(Explore)` and `Agent(general-purpose)` -> allowed;
  `Agent(env-runner)` -> denied (old custom executor not in the capability map).
- `PreToolUse` `Agent(Plan)` -> denied (not in the capability map).
- `PreToolUse` `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` -> denied; the
  conductor must use `enhance_plan`.
- Worker `PreToolUse` `Agent`/`Task` -> denied for all workers, including
  `general-purpose`; workers are leaves and must return `needs_split`.
- `SubagentStart` `Explore` -> worker contract with `role: investigate|plan|verify_read`. The contract no longer advertises a depth/max-depth guardrail.
- `PostToolUse` `Agent` with a valid envelope -> compact envelope,
  `status=ok`; invalid result -> failure envelope with `next` and
  `data.artifact_handle`.
- Normal operations with `logging=errors` do not write an audit log; denials do.
- Test state was cleaned afterward; only `config.json` and `capabilities.json`
  remain in the user-level state dir. The real-session test state is archived under
  `~/.my-harness-enhance/legacy/`.

## 5. First real Qoder session (60c87313)

Session: `60c87313-cdf1-4a4e-a38d-e1ffcdf2d2b9`, cwd
`D:\project\github\my-harness-enhance`, model `qfmodel`, created 18:16:30.

Observed:

- Auto conductor activated: `session.json` role=conductor, goal/capsule created,
  and `jobs.json` tracked workers. No agent/model selection was made.
- The conductor delegated to native `Explore` workers. It did not attempt
  Bash/Read itself.
- First turn: Qoder worker transport failed (`Transport closed`, then
  `Network attempt failed at timeout`) before the layer was involved. The user
  retried at 18:16:54; the second turn worked.
- Three Explore workers:
  - `aExplore-464...`: valid envelope, but `data` >4000 chars. The **old**
    validator rejected the whole envelope (`data exceeds 4000 chars`).
  - `aExplore-2abeb...`: valid envelope, but evidence >8 entries. The **old**
    validator rejected it (`evidence exceeds 8 entries`).
  - `aExplore-2076885e...`: completed after the fixes; job status **ok**, envelope
    accepted by the conductor.
- The conductor adapted to the failures: it re-delegated bounded tasks in
  parallel, used the valid envelope plus the raw excerpt from the first
  failure, and produced a final answer at 18:23:55. The final answer correctly
  identified the repository as my-harness-enhance v0.2.0.
- Main context usage snapshot at 18:19:57: **7.4%** (model window 400k;
  detailed categories were still empty in the panel snapshot). Raw repo content
  stayed in worker contexts; the conductor saw compact envelopes.

Fixes made during/after this session:

- `Explore` now may use its native `Bash` tool; only Write/Edit/Agent/Task are
  denied. The persisted `capabilities` config was refreshed.
- Oversized `summary` / `evidence` / `artifacts` / `open_questions` / `data` are
  **truncated**, not used to reject an otherwise valid envelope.
- `last_assistant_message` is preferred when extracting a worker result.
- `SubagentStop` creates/updates a job (with role/depth) even when
  `SubagentStart` was not emitted for a parallel worker.

## 6. Write + verification session (c1f3a1b9)

Session: `c1f3a1b9-406a-435d-98a6-1766e2cd92ae`, cwd
`D:\project\github\my-harness-enhance`, model `qfmodel`.

Observed:

- Auto-registered conductor; dispatched two native `Explore` workers,
  `mhe-reasoner` for the assertion design, `general-purpose` for the write, and
  a second `general-purpose` for independent verification.
- The conductor did not write or execute anything itself; it used
  `enhance_plan`/`enhance_job` and compact envelopes.
- `mhe-reasoner` returned a valid envelope after ~5.5 minutes.
- The write worker added only `test/global.test.mjs` (67 lines, 10 tests);
  full suite 83/83, new file 10/10, old seven files 73/73.
- `src/` was untouched: newest mtime was `src/core/contract.mjs` 19:27:40,
  before the new test file at 19:38:15.
- The conductor's final answer at 11:43 cited `file:line` evidence and flagged
  two caveats itself (docs baseline 72 vs actual 73; `process.cwd()` portability).

Non-blocking issues exposed:

- First `enhance_plan` call omitted `title` and was rejected by the MCP schema;
  the conductor retried with titles and succeeded. The schema now requires only
  `id` and falls back to `task`/`id` for the title.
- Docs still said 72 tests; now updated.
- The new test used `process.cwd()`; changed to a temp path.

## 7. Review-driven hardening (696968ee)

A separate Qoder review session inspected the layer. Confirmed and fixed:

- **Concurrent read-modify-write:** `goal`, `plan`, `jobs`, `session`, and
  `sessions` writes were outside the lock; `jobs.json` is the critical path for
  concurrent `SubagentStop`. All now go through `withLock` (10s timeout, 30s
  stale), and a 6-process upsert test asserts no lost jobs.
- **Invalid envelope recovery:** `SubagentStop` now records a synthetic failure
  envelope in the job, plus `retryable: true` and `next`; the conductor no
  longer has to infer a retry from an empty envelope. `PostToolUse` invalid
  output includes the raw artifact handle.
- **Silent truncation:** normalized envelopes carry `warnings`; compact output
  records every trim. Oversized evidence/artifacts/questions/data are still
  truncated, but the conductor can see that it happened.
- **Fake knobs:** `maxDepth`/`maxFanout` were removed. Workers are enforced as
  leaves at `PreToolUse` (Agent/Task denied even for `general-purpose`); the
  worker contract no longer advertises a depth guardrail.
- **Task graph split:** native `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`
  are denied; `enhance_plan` is the only durable task graph.
- **Workspace bleed:** MCP `contextFor` no longer falls back to global
  `active.json`; it uses `project`, then env, then the server cwd.
- **Budget mismatch:** hook injection and MCP `enhance_state` now use the same
  `maxCapsuleTokens`; `maxStateTokens` was removed.
- **Artifact summary bug:** summaries are whitespace-collapsed and cut at a word
  boundary instead of a raw 240-char slice.

Two review claims were narrowed:

- The conductor's `PostToolUse` path already rendered `invalidResultEnvelope`
  with a "re-delegate" instruction; the missing closure was the job-level
  record, now fixed.
- The review's 72/72 count was stale; the baseline at review time was 73.

## 8. Remaining validation

- Long-horizon tasks and `PreCompact` state fidelity.
- Qoder context-panel detailed categories (the live snapshot had empty details).
- Free `qfmodel` rate limits/quality under larger workloads.
- Old `bash-delegate` hook interaction when the conductor model is qwen 3.5
  9b/7b (warning is printed; use a non-9B model or remove the old hook).
- ZCode adapter and macOS/Linux real-machine runs.
- The repository still has no `.git`; only mtime is available for change
  history. Initialize version control before public release.
