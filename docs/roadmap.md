# Roadmap

> Chinese version: [roadmap.zh-CN.md](roadmap.zh-CN.md).

## v0.2 (current)

- Core contract, user-level state registry, artifact store, capsule, metrics.
- Qoder adapter: reuse official `general-purpose`/`Explore`; install
  `mhe-reasoner` only for the no official no-tools gap.
- Auto conductor: no agent/model selection; every main session in a registered
  project is the conductor.
- User-level state: `~/.my-harness-enhance/projects/<hash>/`; no repo `.router`.
- Global mode: install once per machine; new sessions in any workspace
  auto-register; MCP tools route by `project`/env/cwd; existing sessions are not
  retrofitted.
- 221 tests; demo; benchmark; Qoder install with 1 fallback agent; Qoder read-only,
  write+verify sessions; installed hook simulation.
- One conductor + native workers; workers are leaves (Agent/Task denied), so
  there is no silent nested fan-out.

## v0.3

### Qoder real-session hardening

- Verify actual hook payload/output schemas for `SessionStart`,
  `SubagentStart`, `SubagentStop`, `PostToolUse`.
- Confirm the conductor's native main agent follows the injected policy and
  measure real context composition before/after.
- Tune capsule size, envelope limits, and errors-only logging from real runs.
- Validate the `mhe-reasoner` fallback contract; keep the old `reasoner` file
  only for old sessions.

### ZCode adapter (implemented; project and global)

- Hooks: SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop; no native
  SubagentStop/PreCompact/result rewrite.
- Workers: official `general-purpose`/`Explore`, user agents if present, and a
  shipped `mhe-reasoner` fallback for the no-tools reason role.
- Current compensations: `reason` -> built-in `Explore` read-only compatibility,
  required worker-contract text at dispatch, synthetic FIFO job lifecycle,
  Stop/compact-source capsule injection.
- Remaining: exact per-agent job correlation, result rewrite if ZCode adds it,
  and overlay/skill installation.

### Capability policy and routing

- Probe-based capability checks (small standardized tasks) cached per
  agent/harness version.
- Runtime escalation: next candidate per role on failure/invalid envelope.
- Cost/capability routing; per-task budgets and fan-out limits.
- If nested workers are introduced, implement and enforce explicit depth/fan-out
  caps; current workers are leaves.

## v0.4

- Cross-harness workers with a uniform delegate/status/result/send/cancel
  contract; one conductor remains on one harness.
- Observability: context composition, job tree, invalid-envelope rate, recall
  hit rate, cost per task.
- Multi-machine install runbook validation (Windows/macOS/Linux).

## Non-goals

- A multi-agent society with peer negotiation. There is one decision-maker.
- A prompt-only convention. Enforcement is deterministic where possible.
- Installing a new agent fleet when official/user agents already fit.
