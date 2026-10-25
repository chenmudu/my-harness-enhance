# Architecture

> Chinese version: [architecture.zh-CN.md](architecture.zh-CN.md).

## 1. Problem

A single agent session in a long-horizon task spends most of its attention on
execution details: raw tool output, its own reasoning traces, tool/MCP schemas,
stale plans, repeated reads, and failed attempts. The model's context grows, but
the useful signal does not. The failure modes are goal drift, repetition, lost
constraints, and "context rot" long before the window is full.

The fix is not a bigger window and not a smarter summary of the same transcript.
The fix is to change what the main model sees each turn:

- keep a small control plane in the main context;
- move execution and investigation into isolated worker contexts;
- return only a bounded, structured result;
- keep the durable state outside the transcript.

### 1.1 Scope: control plane, not runtime

The host harness owns the model loop, tool execution, session storage,
compaction, and permissions. This repository owns only the control plane:
policy, the envelope contract, bounded state/capsule, deterministic checks,
metrics, and adapter mappings. Using a native mechanism is the default;
reimplementing a host capability is a defect, not a feature.

## 2. Five control-plane layers

### 2.1 Economic layer: who pays, who works

The structural invariant is **one decision-maker + many execution contexts**.
Cost is a policy on top of that structure, not part of it.

Default policy:

- paid, strong model = conductor (judgment, routing, acceptance, synthesis);
- free/cheap, capable model = worker (investigation, execution, verification,
  drafting); on Qoder, `qfmodel` (Qwen3.8-Flash) is the default worker;
- critical verification or hard subtasks may escalate to a paid worker;
- privacy-sensitive tasks may run on a local model.

Every worker profile declares a cost/capability profile: cost tier, model,
context limit, tool set, latency, reliability. The conductor picks the cheapest
worker that meets the task's capability bar. Do not hardcode "model A always
does X".

Status (v0.2): this is a policy target, not a runtime router.
`src/core/capabilities.mjs` hardcodes a static role -> candidate list, and the
only model field is the `model: qfmodel` line in the fallback agent templates;
cost/capability routing and per-task budgets are v0.3 work (see `roadmap.md`).

Free workers have risks: rate limits, weaker tool reliability, context limits,
and hidden policy filters. The layer must have fallback (paid/local worker) and
result validation. Final judgment never belongs to a free worker.

### 2.2 Topology layer: where context lives

Four topologies, one contract:

| Topology | Use when | Main cost | Notes |
|---|---|---|---|
| Same-session subagent | default | lowest | isolated context; parent sees result only |
| Nested subagents (tree/DAG) | future; not enabled in v0.2 | depth x latency | requires explicit depth/fan-out enforcement; every level returns a bounded result |
| Same-harness, multi-model/multi-session | long-running, different model/permission/sandbox, survive main session | transport + sync | Qoder cross-session is Windows-unsupported; ZCode has no arbitrary bus; fall back to subagents |
| Cross-harness multi-agent | another harness has a unique capability/model/tool | highest | last resort; uniform transport contract; not in v0.1 |

The uniform primitive is:

```
delegate(task, refs, schema, mode) -> job_id
status(job_id) -> state
result(job_id) -> envelope
send(job_id, message) -> ack        (if bidirectional)
cancel(job_id)
```

The main model sees `delegate`, never the worker's transcript.

**Depth is a tool, not a goal.** Every extra level adds latency, cost, and error
propagation. v0.2 enforces one level: workers may not use `Agent`/`Task`; a
worker that needs a split returns `needs_split` with a proposed child graph, and
the conductor decides. Nested workers are a future topology, not a currently
advertised guardrail; if introduced, depth/fan-out must be enforced in code.

### 2.3 Harness layer: use native primitives

Do not reimplement what the harness already provides. The adapter maps the
contract to native mechanisms.

| Capability | Qoder | ZCode | Codex | DSH |
|---|---|---|---|---|
| Restrict main tools | `PreToolUse` deny (auto; native main keeps full schema) | `--disallowed-tools` | agent role/tool policy (partial) | `ctx.tools.restrict` |
| Isolated workers | subagents, separate transcript/compression | `Agent` subagents | `spawn_agent` + threads | subagent plugin |
| Worker result only | parent sees result, not transcript | `Agent` final message | parent final message | delegate result |
| Rewrite tool output | `PostToolUse.updatedToolOutput` | `additionalContext` only | hooks (partial) | tool pipeline |
| Validate worker stop | `SubagentStop` | no `SubagentStop` | subagent stop hooks | `outputSchema` |
| Inject at compaction | `PreCompact`/`PostCompact` + `SessionStart(compact)` | `SessionStart(compact)` | pre/post compact hooks | compaction seam |
| Headless / SDK | `qoder -p`, Agent SDK | `-p`, app-server | `codex exec`, SDK | `dsh --profile headless`, SDK/ACP |
| Free worker model | `qfmodel` (Qwen3.8-Flash) | provider-dependent | paid/Responses | model-agnostic |

Rules:

- Prefer deterministic enforcement (hook/flag/schema) over prompt compliance.
- Respect the harness's sandbox, permissions, and platform limits.
- If a capability is missing, degrade gracefully:
  - no output rewrite -> conductor-side normalization/truncation;
  - no `SubagentStop` validation -> conductor parses and re-delegates;
  - no cross-session -> use subagents.
- Write a capability descriptor per adapter. The conductor policy can then choose
  topology from capabilities, not from harness names.

#### Activation (Qoder v0.2)

- Global auto mode: install once per machine; the first **new** session in any
  workspace auto-registers it (SessionStart startup/new/clear). Already-running
  sessions are not retrofitted. Every main session in a registered workspace is
  the conductor; no per-session agent/model selection (worker roles resolve
  through the static candidate list in §2.1).
- Project-scoped auto mode: install a single project explicitly; it registers
  immediately. Useful for strict control or per-project fallback agents.
- Hooks inject the policy and deny non-conductor tools. The native main agent
  keeps its full tool schema; the saving is in messages/tool results and worker
  context, not static schema.
- Reuse-first: official `general-purpose`/`Explore`; `mhe-reasoner` is the only
  no-tools fallback. The old `reasoner` and `env-runner` are not selected.
  Only a missing capability installs an `mhe-*` fallback.
- Workers are leaves: `PreToolUse` denies `Agent`/`Task` for every worker,
  including `general-purpose`. The conductor is the only router.
- Only conductor sessions and mapped native workers write capsule/jobs/audit
  logs. Unrelated sessions outside registered projects are dormant.

### 2.4 Contract layer: invariants vs implementation details

**Invariants (all harnesses):**

1. One decision-maker; workers are stateless, goal-less, and do not negotiate.
2. Main context = goal/constraints + task graph/routing table + result
   summaries + decisions. No raw tool output, worker reasoning, or transcript.
3. Worker result = bounded envelope with status, summary, evidence, artifacts,
   open questions, next step, needs_split, data, cost, confidence.
4. Progress = status + milestones; failures = structured errors;
   `enhance_recall(handle)` for bounded drill-down.
5. Coarse decomposition in the conductor; fine task graph proposed by a planner
   worker and approved by the conductor.
6. Cost/capability routing; cheapest qualified worker.
7. Deterministic enforcement before prompt guidance.

**Implementation details (per harness):**

skills, AGENTS.md, MCP servers, hook scripts, agent definitions, workflows,
goal/plan primitives, session storage. They are just *how* an invariant is
implemented. Do not mistake a mechanism for the architecture.

### 2.5 Operations layer: stability, efficiency, fit, proof

**Stability:**

- hooks/flags/schema for critical boundaries;
- per-project lock around read-modify-write state; atomic writes;
- leaf-worker enforcement in v0.2 (Agent/Task denied);
- if nested workers are introduced, max depth, max fan-out, per-node
  token/time/tool budget;
- failure fallback (paid/local worker);
- observability: job id/tree, hook log, costs.

**Efficiency:**

- conductor calls few and small; workers free/parallel;
- tool schema pruning (conductor exposes ~13 tools, not 36+);
- stable prefix / KV cache;
- artifact reuse, content-addressed dedupe;
- choose topology by task complexity: simple task -> one worker; no tree.

**Fit:**

- use native primitives; respect platform limits;
- degrade instead of fighting the harness;
- keep the state format harness-independent (JSON/Markdown).

**Proof:**

- baseline vs conductor: main context tokens, composition, worker calls, task
  success, acceptance failures, human interventions, cost/latency;
- needle tests for goal/constraint retention;
- compaction fidelity A/B;
- if the conductor becomes a rubber stamp, validation/evidence design failed;
- if the tree is too deep or calls explode, granularity/routing failed.

## 3. State model

User-level state (nothing in the project repo):

```
~/.my-harness-enhance/
  projects.json                    project path -> state dir
  projects/<hash>/
    config.json                    conductor mode, capabilities, logging
    capabilities.json              resolved role -> native agent mapping
    decisions.jsonl                append-only decisions (optional session)
    sessions.json                  host session -> id, host_pid, cwd, last_seen
    artifacts/                     content-addressed raw evidence
    metrics.jsonl                  hook/routing metrics (each event has session)
    logs/                          errors-only by default
    .lock                          project-level write lock
    sessions/<sid>/
      goal.json                    canonical goal, acceptance, constraints
      brief.json                   shared brief for this session
      plan.json                    task graph
      jobs.json                    job status, agent id/type/role, envelope summary
      session.json                 current session role/model/source
      last-check.json              durable deterministic check result
      capsule.md                   compact state injected into the conductor
      journal.md                   follow-up prompts
      worktrees.json               task id -> path, head, status
  worktrees/<projectKey>/<sessionKey>/<task_id>
  legacy/                          migrated old .router dirs
```

The state store is the source of truth. The transcript is not.

Working state is per session under `sessions/<sid>/`; config, capabilities,
decisions, artifacts, metrics, `sessions.json`, logs, and the lock are shared.
Two sessions may run concurrently: they contend only on shared append/write
paths, while goal, plan, jobs, capsule, and worktrees stay isolated.

`capsule.md` is the compact state injected into the conductor; `jobs.json` is the
routing table; `logs/hooks.jsonl` is optional (errors-only by default) and
contains no prompts or raw outputs; `artifacts/` holds raw evidence. These are
created only for conductor sessions and mapped native workers, not for unrelated
sessions.

Pre-sharding working files at the project level stay readable; the first
session write copies them into that session's directory and never deletes them.
Git worktrees live at `worktrees/<projectKey>/<sessionKey>/<task_id>`.

### 3.1 Capsule projection

`capsule.md` is rebuilt from state, never summarized from the transcript. Its
budget is `config.context.maxCapsuleTokens` (default 1800 tokens).

- **Pinned:** PROJECT (the exact path passed to every `enhance_*` call),
  SESSION (the shard id; tools that accept `session` must receive it), NEXT
  (first in-progress task, else the first pending task, else the oldest active
  job), and LAST CHECK.
- **Ordered by priority:** GOAL, ACCEPTANCE, CONSTRAINTS, WORKERS, BRIEF, PLAN,
  ACTIVE JOBS, WORKTREES, RECENT DECISIONS, ARTIFACTS.
- **Bounded inputs:** PLAN 30 tasks, ACTIVE JOBS 12, WORKTREES 10, RECENT
  DECISIONS 8, ARTIFACTS 10.
- **Visibility:** the header names the degradation level (`mode=full`,
  `compact`, or `core-only`), and every section that shows only part of its
  content says `(shown X of Y)`. Nothing is dropped silently.
- **Degradation:** PLAN is truncated inside the budget and appends
  `(N more tasks omitted)`; skipped sections are named in `OMITTED`; the final
  hard cap counts its own marker, so the capsule never exceeds the budget.

Pinned sections are inserted first, so the conductor keeps its working set even
when the rest does not fit.

The capsule is a state projection, not an attention packet: it re-states the
ledger in priority order instead of selecting the subset the current decision
needs, and nothing measures whether an injected block was relevant. The
attention-density target in `docs/metrics.md` is therefore not met by this
design yet.

Injection is not re-sent in full on every turn: session start and compaction
inject the whole policy and capsule, while a normal turn receives a short
anchor plus only the sections whose content changed (measured on a 14-task
plan: 1,358 tokens full, 73 unchanged, 153 after one task moved).

## 4. Hooks (Qoder adapter)

| Event | Role |
|---|---|
| `SessionStart` | detect conductor session; inject policy + capsule; on compact/resume re-inject |
| `UserPromptSubmit` | set first goal; journal follow-ups; inject a short anchor plus only the state sections that changed |
| `PreToolUse` | conductor tool allowlist; native worker policy by agent type (readonly/leaf/notools/lead); subagent allowlist |
| `SubagentStart` | create job; inject role + worker contract + goal/acceptance |
| `SubagentStop` | parse/store envelope; update job |
| `PostToolUse` | normalize `Agent` result to compact envelope; capture large worker tool output |
| `PreCompact` | regenerate capsule from state (not from transcript) |
| `Stop` | write capsule; block completion while a code worktree is unlanded |

The key design choice: **compaction is deterministic and state-based**. It does
not ask the already-degraded main model to summarize its own transcript.

## 5. What this is not

- It is not a runtime: it does not own the model loop, tool execution, session
  storage, compaction, or permissions.
- It is not a multi-agent society. There is one decision-maker.
- It is not a cross-harness orchestrator in v0.2. One harness, one adapter.
- It is not a prompt-only convention. Hooks enforce the boundary.
- It is not a replacement for the harness's native subagents. It is a policy
  and contract layer on top of them.
