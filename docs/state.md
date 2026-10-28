# State and injection

> Chinese version: [state.zh-CN.md](state.zh-CN.md).

This page describes what the harness stores on disk, which data structure backs each file, and what the hooks inject into the conductor and the worker. It complements [architecture.md](architecture.md) (why the layers exist) and [qoder-adapter.md](qoder-adapter.md) (Qoder-specific paths).

## 1. Where state lives

The default state home is `~/.my-harness-enhance`; `MY_HARNESS_ENHANCE_HOME` overrides it (the A/B runner uses `~/.mhe-test/state-treatment`). Nothing is written into the project repository.

`projects.json` sits at the state-home root and maps a canonical project root to a 16-character SHA-256 project key. Shared state lives in `projects/<key>/`; per-session working state lives in `projects/<key>/sessions/<sessionKey>/`.

`sessionKey` lowercases the host session id, removes everything outside `[a-z0-9-]`, and truncates to 64 characters (`default` when the id is empty). `storePaths` uses the legacy project-level files only when no session is passed at all.

The layout:

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

Writers: hooks own `goal`, `journal`, `jobs`, `capsule`, `injection`, `packet`, and `now`; the conductor's MCP tools write `brief.json`, `plan.json`, `last-check.json`, `worktrees.json`, and `decisions.jsonl`; the adapter writes `session.json`.
Workers never write state files: they return one JSON envelope, and `SubagentStop` stores it.
`last-check.json` has one authority: a harness check or a successful `land`, never a worker's self-report.

The last three files are bookkeeping, not content. `capsule.md` is a derived full ledger rebuilt at `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop`; it is not injected every turn.
The injected context is the packet, built directly from `goal.json`, `brief.json`, `plan.json`, `jobs.json`, and `last-check.json`.

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
| `SessionStart` | conductor | Conductor policy plus the complete packet | Packet at most 1,800 tokens, plus the policy | `conductorInjection` |
| `UserPromptSubmit` | conductor | Turn anchor plus only the packet sections that changed | Source packet at most 1,800 tokens; injected about 216 tokens per turn | `conductorTurnInjection` |
| `SubagentStart` | worker | Worker contract, goal, acceptance, constraints, brief | 900 tokens in total; brief pre-clipped to 1,000 characters | `workerInjection` |
| `PreToolUse` | conductor and worker | No context; allow or deny the tool call | None | `hook-policy.mjs` |
| `SubagentStop` | none | Parses the envelope, stores an artifact, updates the job and plan | None | `onSubagentStop` |
| `PostToolUse` | conductor | Compacted worker envelope plus a `[NOW]` frontier reminder | Envelope cap plus one line | `compactEnvelope` / `nowReminder` |
| `PreCompact` | none | Rebuilds the capsule and writes a compaction metric; the next `SessionStart` re-injects the policy and packet | None | `onPreCompact` |
| `Stop` | conductor | Denies stop when code worktrees are unlanded; otherwise writes metrics | None | `onStop` |

At `SessionStart` the hook records a hash per packet section in `injection.json`. On each later turn it rebuilds the packet, compares hashes, and injects only changed sections plus the anchor; removed sections are listed by title.
`packet.json` remembers the previous plan statuses and check label, which is how the packet renders `CHANGED`.

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
2. The conductor reads the anchor, creates the brief and plan when they are missing, and chooses a delivery unit: one plan task with one owner, one brief/check set, and one land boundary.
3. The conductor writes the dispatch prompt with the exact `task_id`, input paths, method, output path, and forbidden actions.
4. `SubagentStart` creates the job and injects the worker contract, goal, and brief. The worker does not see the plan.
5. The worker reads the inputs, produces the artifact, and returns one JSON envelope.
6. `SubagentStop` parses the envelope, stores the raw result as an artifact, updates the job, and synchronizes the plan status. `PostToolUse` compacts the envelope and appends the `[NOW]` reminder.
7. The conductor runs the deterministic check (`enhance_check`) or `land` for code. Only that result can complete a task.
8. The conductor records a decision when it must survive the session, and the next prompt starts at step 1 with a delta anchor.

The current policy allows one bounded inline read through `enhance_recall`; native `Read`/`Glob`/`Grep`, writes, and shell work remain delegated. Inline is a single bounded read plus a short answer; any write, multiple files, a test/land, or another tool is a worker dispatch; small items with the same owner, checks, and context merge into one task. See D-1 below.

## 5. Current limitations

| ID | Limitation | Impact | Intended fix |
|---|---|---|---|
| D-1 | Native `Read` remains denied; inline reads must use `enhance_recall` (8,000-char cap) | A large file cannot be read inline; the conductor must delegate or narrow the query | Keep the inline path bounded; do not add native Read without a path/size gate |
| D-2 | Qoder matches a pending dispatch by session and worker type (oldest first, 10-minute TTL); ZCode parses `task_id` from the prompt | Parallel same-type dispatches still match FIFO, so the envelope `task_id` remains the plan-sync authority | Narrow correlation further only if a probe shows a real mispair |
| D-3 | The injection is a pinned contract plus per-section budgets (task card, brief, goal, acceptance, constraints) with explicit truncation markers | The contract uses about 490 of the 900-token cap; the rest is shared by the sections | Keep the contract pinned and lower section caps rather than raising 900 |
| D-4 | The turn anchor says not to call `enhance_state`, even when the packet is compact | The conductor cannot fetch sections the packet omitted | Allow one state call when the packet mode is not `full` |
| D-5 | `brief_hash` and `task_hash` are injected and required in the envelope; a mismatch is rejected as `stale_contract` and not synced | Results without hashes are accepted as legacy with a warning, so older workers still run | Keep the hash scope stable (no status/updated_at) and revisit a global version only if needed |
| D-6 | Reuse and merge are not adapter capabilities | Qoder always cold-starts; ZCode reuse cannot be selected by policy | Add `worker_resume` and `agent_messaging` to the capability matrix and branch on them |