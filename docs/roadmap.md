# Roadmap

> Chinese version: [roadmap.zh-CN.md](roadmap.zh-CN.md).

The primary metric is attention density; growth rate is the budget and token
cost is the economic constraint. The order below follows that priority: v0.2 is
the machinery, v0.3 is the metric and the injection it needs, v0.4 is the
evidence and the surrounding tooling.

## v0.2 (done)

- Core contract, user-level state registry, artifact store, capsule, metrics.
- Qoder adapter: reuse official `general-purpose`/`Explore`; install
  `mhe-reasoner` only for the no-official-no-tools gap.
- Auto conductor: no agent/model selection; every main session in a registered
  project is the conductor.
- User-level state: `~/.my-harness-enhance/projects/<hash>/`; no repo `.router`.
- Global mode: install once per machine; new sessions in any workspace
  auto-register; MCP tools route by `project`/env/cwd; existing sessions are not
  retrofitted.
- Session-level state sharding: goal, brief, plan, jobs, capsule and worktrees
  per session; config, artifacts, metrics and logs shared per project. Two
  concurrent sessions in one workspace were verified.
- Isolated git worktrees for code tasks, including carrying a dirty base into
  the worktree and a path-scoped revert when a landing fails.
- One shared hook-policy core for the Qoder and ZCode adapters, with a
  conformance test.
- Retention and garbage collection: `mhe gc` plans by default; metrics and logs
  30 days and 5 MiB, artifacts 30 days with a 7-day grace, decisions 180 days
  (off by default), worktrees 7 days.
- The full test suite; demo; benchmark; Qoder install with one fallback agent; installed
  hook simulation; two real sessions plus a two-session run.
- One conductor + native workers; workers are leaves (Agent/Task denied), so
  there is no silent nested fan-out.

## v0.3 (next): the attention metric

This is the version that makes the claim measurable. Until it lands, the project
can show token growth but not attention density.

### Injection: stop paying twice

- One full injection per session start and per compaction; a normal turn gets a
  short anchor plus a state delta. Today every user turn re-injects the full
  policy and the whole capsule.
- MCP tools return the changed task or handle instead of echoing the whole plan
  and state.
- `shown X of Y` on every truncated section, so the conductor knows what it is
  not seeing.
- Three-level capsule degradation instead of all-or-nothing.

### Measurement: make the goal falsifiable

- Attention telemetry per turn: what was injected, which part was relevant, and
  what the conductor did next.
- Behavior labels, produced deterministically where possible: next action on the
  active task, wrong task, re-read, recovery after a failure.
- Derive `b` (growth per turn) and report it next to `M_T`, `B` and `C`; report
  all four and never `M_T` alone.
- A long-horizon comparison that does not restart the CLI per turn, so the
  numbers match a real session.

### Projection: the packet and the scheduler

- Attention state per task: next action, blockers, priority, cost of missing it,
  freshness, authority.
- A frontier and a scheduler that decide which task is ready and which one
  deserves the next turn.
- A packet compiler that emits the current decision's working set (ROLE, NOW,
  DECIDE, BLOCKERS, CHANGED, MUST, TRUST, PARKED, MORE) instead of re-stating the
  ledger.
- Attention debt: count open loops and block new work above a threshold.

### Guardrails

- Provenance for acceptance: the harness runs the checks and marks whether a
  result was verified or merely claimed.
- Error classification with a retry budget, dead letters, and a circuit breaker.
- State file versions and migration; a CI matrix for Windows, macOS and Linux.

## v0.4 (later)

- Attention regression suite: needle, distractor, ordering, truncation,
  recovery, conflict, with rollback when a change makes attention worse.
- A human situation report from the same packet: what is blocked, what changed,
  what to trust.
- Model profiles and a platform capability matrix (turn start, tool anchor,
  compaction, status line, packet, telemetry).
- Cross-harness workers with one conductor on one harness; additional adapters
  such as Codex and DSH.
- Multi-machine install runbook validation.

## Non-goals

- A multi-agent society with peer negotiation. There is one decision-maker.
- A prompt-only convention. Enforcement is deterministic where possible.
- Installing a new agent fleet when official/user agents already fit.
- A token optimizer that trades answer quality for a smaller context. Token cost
  is the lowest-priority term.
- Long-term memory. This layer governs what the current session's model sees;
  what it remembers tomorrow belongs to a separate system.