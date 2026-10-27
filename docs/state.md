# State and injection

> Chinese version: [state.zh-CN.md](state.zh-CN.md).

This page describes what the harness stores on disk, which data structure backs each file, and what the hooks inject into the conductor and the worker. It complements [architecture.md](architecture.md) (why the layers exist) and [qoder-adapter.md](qoder-adapter.md) (Qoder-specific paths).

## 1. Where state lives

The default state home is `~/.my-harness-enhance`; `MY_HARNESS_ENHANCE_HOME` overrides it (the A/B runner uses `~/.mhe-test/state-treatment`). Nothing is written into the project repository.

`projects.json` maps a canonical project root to a 16-character SHA-256 project key. Shared state lives in `projects/<key>/`; per-session working state lives in `projects/<key>/sessions/<sessionKey>/`.

`sessionKey` lowercases the host session id, removes everything outside `[a-z0-9-]`, and truncates to 64 characters; an empty id falls back to the legacy project-level files in `projects/<key>/`.

### 1.1 Project-level files

| File | Purpose | Content | Source |
|---|---|---|---|
| `config.json` | Project config | Defaults merged with overrides: enabled, conductor, envelope, context budgets, capabilities, GC | `loadConfig` / `saveConfig` in `src/core/config.mjs` |
| `capabilities.json` | Detected host capabilities | Allowed subagents, hook events, tool names | `src/core/capabilities.mjs` |
| `decisions.jsonl` | Append-only decision log | One JSON record per decision | `appendDecision` / `readDecisions` in `src/core/store.mjs` |
| `sessions.json` | Session index | id, role, model, `host_pid`, cwd, `last_seen` | `markSession` / `readSessions` in `src/core/store.mjs` |
| `artifacts/` | Content-addressed evidence | Worker results, files, diffs, logs | `putArtifact` / `listArtifacts` in `src/core/artifacts.mjs` |
| `metrics.jsonl` | Append-only metrics stream | Event, role, tokens, credits, timings | `appendMetric` in `src/core/store.mjs`; the adapter records events |
| `logs/` | Hook and runtime logs | One JSON line per event | Adapter `log` helper |
| `.lock` | Cross-process write lock | Lock file used by state writers | `withLock` in `src/core/store.mjs` |

### 1.2 Session shard

| File | Purpose | Content | Source |
|---|---|---|---|
| `goal.json` | The user goal | `text`, `acceptance[]`, `constraints[]`, `version`, `updated_at` | `writeGoal` / `readGoal` |
| `brief.json` | Durable task contract | `profile`, `inputs[]`, `pairs[]`, `checks[]`, `glossary[]`, `ownership[]`, `notes`, `goal_version` | `writeBrief` / `readBrief`; `src/core/brief.mjs` |
| `plan.json` | Tasks and attention metadata | `version: 2`, `tasks[]`, `updated_at` | `writePlan` / `readPlan` / `updatePlanTask` |
| `jobs.json` | Dispatch ledger | `jobs[]`: agent, type, role, status, `task_id`, envelope, result handle | `upsertJob` / `readJobs` |
| `journal.md` | User prompts | Append-only Markdown, one timestamped section per prompt | `appendJournal` |
| `last-check.json` | Authoritative check result | `ok`, `checked[]`, `findings[]`, `source`, `worktree` | `writeLastCheck` / `readLastCheck` |
| `session.json` | Session role marker | `role`, `model`, `source`, `fresh`, `host_pid`, `cwd` | `writeSession` / `readSession` |
| `worktrees.json` | Code worktree registry | `worktrees`: id to path, status, timestamps | `writeWorktrees` / `readWorktrees` |
| `capsule.md` | Derived full ledger | PROJECT, SESSION, NEXT, LAST CHECK, GOAL, ACCEPTANCE, CONSTRAINTS, WORKERS, BRIEF, PLAN, ACTIVE JOBS, WORKTREES, RECENT DECISIONS, ARTIFACTS | `buildCapsule` / `writeCapsule`; `src/core/capsule.mjs` |
| `injection.json` | Delta bookkeeping | Section title to content hash from the last injection | `recordInjection` |
| `packet.json` | Delta bookkeeping | Previous plan statuses and check label | `buildPacket` |
| `now.json` | Reminder deduplication | Last `[NOW]` line | `nowReminder` |

The last three files are bookkeeping, not content. `capsule.md` is the full ledger; the conductor normally sees only the packet projection built from it.

## 2. Data structures

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

`writeGoal` replaces the goal only when `replace` is true or no goal exists; otherwise it keeps the text and appends the prompt to `journal.md`. Replacing a goal deletes `brief.json` and `last-check.json` so stale acceptance cannot survive.

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

The brief is the durable contract shared by the conductor, the worker, and the checker. `goal_version` ties it to the goal that produced it.

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

`readPlan` derives `stale` (more than 24 hours since `as_of` while pending or in progress) and never stores it. The plan is capped at 50 tasks; jobs at 100.

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

`upsertJob` creates the job at `SubagentStart` and updates it at `SubagentStop` with the parsed envelope and the artifact handle. A job without a valid `task_id` cannot synchronize the plan.

### 2.5 Session and check

```json
{ "role": "conductor", "model": "qfmodel", "source": "startup", "fresh": false, "host_pid": 1234, "cwd": "D:\\project" }
```

```json
{ "ok": true, "checked": ["inputs"], "findings": [], "source": "harness", "worktree": "" }
```

`last-check.json` is written only by the harness (`enhance_check` or a successful `land`) or an explicit caller; a worker's self-report never becomes authoritative.

## 3. What the hooks inject

| Event | Target | Payload | Budget | Source |
|---|---|---|---|---|
| `SessionStart` | conductor | Conductor policy plus the full packet | Packet at most 1,800 tokens | `conductorInjection` |
| `UserPromptSubmit` | conductor | Turn anchor plus only the packet sections that changed | Packet at most 1,800 tokens; measured about 216 tokens per turn | `conductorTurnInjection` |
| `SubagentStart` | worker | Worker contract, goal, acceptance, constraints, brief | Fitted to 900 tokens | `workerInjection` |
| `PreToolUse` | conductor and worker | No context; allow or deny the tool call | None | `hook-policy.mjs` |
| `SubagentStop` | none | Parses the envelope, stores an artifact, updates the job and plan | None | `onSubagentStop` |
| `PostToolUse` | conductor | Compacted worker envelope plus a `[NOW]` frontier reminder | Envelope cap plus one line | `compactEnvelope` / `nowReminder` |
| `PreCompact` | none | Writes the capsule and a compaction metric; the next `SessionStart` re-injects | None | `onPreCompact` |
| `Stop` | conductor | Denies stop when code worktrees are unlanded; otherwise writes metrics | None | `onStop` |

The worker never receives `plan.json`, `jobs.json`, `journal.md`, or another task's state. Task-specific content (exact paths, method, output format) comes from the conductor's `Agent`/`Task` prompt, which is not truncated by the `SubagentStart` hook.

Qoder truncates `SubagentStart` additional context at roughly 5,000 to 6,000 tokens, so the 900-token worker fit is deliberate. Increasing it does not guarantee delivery.

## 4. Task lifecycle

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

1. `UserPromptSubmit` sets the goal on the first prompt, replaces it on a fresh substantive prompt, or appends to the journal; it then builds the packet and injects the anchor plus changed sections.
2. The conductor reads the anchor, creates the brief and plan when they are missing, and chooses a delivery unit.
3. The conductor writes the dispatch prompt with the exact `task_id`, input paths, method, output path, and forbidden actions.
4. `SubagentStart` creates the job and injects the worker contract, goal, and brief. The worker does not see the plan.
5. The worker reads the inputs, produces the artifact, and returns one JSON envelope.
6. `SubagentStop` parses the envelope, stores the raw result as an artifact, updates the job, and synchronizes the plan status. `PostToolUse` compacts the envelope and appends the `[NOW]` reminder.
7. The conductor runs the deterministic check (`enhance_check`) or `land` for code. Only that result can complete a task.
8. The conductor records a decision when it must survive the session, and the next prompt starts at step 1 with a delta anchor.

The current conductor policy makes step 2 a delegation by default. The proposed decision is whether to work inline, delegate one delivery unit, or merge several units into one worker; see the limitations below.

## 5. Current limitations

| ID | Limitation | Impact | Intended fix |
|---|---|---|---|
| D-1 | The conductor policy forbids repository work, so even a small read becomes a worker dispatch | Paid workers double the cost; free workers add wall clock and envelopes | Add an inline-versus-delegate-versus-merge decision rule based on artifact size, reuse, and isolation |
| D-2 | `SubagentStart` does not pass `task_id`, so the injected contract says `task_id: unassigned` | Job and plan linkage relies on the conductor's prompt and the envelope | Parse `task_id` from the dispatch and inject a structured task card |
| D-3 | `fit(contract + goal + brief, 900)` truncates from the tail | A long goal can cut the brief and its checks; the worker misses acceptance | Give each section a budget and mark truncation explicitly |
| D-4 | The turn anchor says not to call `enhance_state`, even when the packet is compact | The conductor cannot fetch sections the packet omitted | Allow one state call when the packet mode is not `full` |
| D-5 | No `brief_hash` or `plan_version` is carried into the worker | A result can be based on a stale brief, especially with a reused worker | Put the version in the worker injection and require it in the envelope |
| D-6 | Reuse and merge are not adapter capabilities | Qoder always cold-starts; ZCode reuse cannot be selected by policy | Add `worker_resume` and `agent_messaging` to the capability matrix and branch on them |