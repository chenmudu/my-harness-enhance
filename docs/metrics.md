# Metrics and validation

> Chinese version: [metrics.zh-CN.md](metrics.zh-CN.md).

## Token estimator

`estimateTokens` is dependency-free and deliberately rough:

- CJK code points: ~1 token each;
- other non-space characters: ~0.28 token each (about 3.6 chars/token);
- whitespace: 0.

Use the same estimator on both sides of an A/B comparison. The absolute number
is approximate; the reduction ratio is the signal.

## Simulated scenarios

`node bin/mhe.mjs bench` compares:

- **baseline**: system + full tool schemas + every tool result + every reasoning
  trace in the main context;
- **conductor**: system + conductor tool schemas + compact state + one envelope per
  worker result. Raw tool output and worker reasoning stay outside the main
  context.

Current output on this machine:

| scenario | baseline main | conductor main | reduction | baseline fits 180k | conductor fits 180k |
|---|---:|---:|---:|---|---|
| light (3 steps) | 34,122 | 7,170 | 79.0% | yes | yes |
| medium (8 steps) | 92,623 | 9,061 | 90.2% | yes | yes |
| heavy (16 steps) | 244,023 | 12,741 | 94.8% | no | yes |

Assumptions per scenario: system 8KB, full tools 75KB, conductor tools 11KB,
state 3KB, per-step tool output and reasoning as set in `src/core/metrics.mjs`.
Change the numbers if your task profile differs.

`node bin/mhe.mjs demo` exercises the real state/contract/artifact path:

- 3 plan tasks, 4 envelopes, verifier checks 3 (2 pass);
- worker envelopes: ~715 estimated tokens;
- capsule: ~389 estimated tokens;
- simulated baseline 54,767 -> conductor 7,457 (86.4% reduction).

The demo does **not** call a model; it proves the plumbing, not model quality.

## Hook telemetry (Qoder v0.2)

Hooks append counts and sizes to `metrics.jsonl`; they never record prompts,
summaries, or raw tool output. Read them with `mhe report` (add `--json` for the
raw summary):

| Event | Recorded fields |
|---|---|
| `session_start` | model, source, session id, `session`, capsule chars/tokens |
| `prompt_submitted` | prompt chars, goal chars, capsule tokens |
| `dispatch` / `tool_denied` | tool, allow, gate |
| `job_start` / `job_stop` | agent type, job id, status, valid, retryable, result tokens |
| `agent_result` | valid, status, raw and compact envelope tokens |
| `tool_output_captured` | bytes, mode |
| `compaction` / `session_stop` | trigger, capsule tokens, blocked, unlanded count |

`mhe report` summarizes job counts, invalid rate, envelope sizes, capsule
tokens, denials, captured bytes, and per-agent counts. It also prints what is
**not** measured.

`mhe report --session <id>` filters to one session shard and prints the
resolved session; every hook event carries `session`. Without the flag the
report aggregates all entries and lists per-session counts.

### Collected vs not collected

| Quantity | Status | Source |
|---|---|---|
| `M_T` (final main context) | simulated only | `bench`, `demo` |
| `b` (growth per turn) | not collected | needs host context snapshots |
| `B` (cumulative input) | not collected | needs per-turn context accounting |
| `C` (billed cost) | not collected | needs provider billing data |
| Composition | simulated; per-dispatch sizes collected | `bench`, `agent_result` |
| Envelope / capsule tokens | collected | hook telemetry |

The hook cannot see the full main context, so `agent_result.compact_tokens` is
the best per-dispatch proxy for what enters it. Do not present the simulated
`M_T` reduction as a growth-rate measurement.

## Real-session measurement (Qoder)

Qoder exposes a context-usage panel with categories such as `system_prompt`,
`system_tools`, `skills`, `messages`, `other`, `free_space`, `auto_compact`.
Record a snapshot at step 1, step 5, and step 10.

Baseline (no layer):

1. Run a real long task with the normal agent.
2. At each snapshot, record total percentage and the `messages` /
   `system_tools` shares.
3. Count: tool calls, repeated reads of the same file, repeated commands,
   goal restatements, constraint violations, and manual interventions.

Treatment (auto conductor):

1. Run the same task with the auto conductor.
2. Record the same snapshots. The main `messages` share should stay roughly flat
   instead of growing with raw tool output; `system_tools` should drop if the
   conductor allowlist works.
3. Count worker calls, envelope sizes, invalid envelopes, `needs_split`, and
   verifier failures.
4. Compare task success, wall-clock, and cost.

The expected shape is not "main context is always tiny"; it is **main context
grows with decisions and result summaries, not with execution details**.

## Long-horizon A/B runner

`mhe ab` runs one scripted multi-turn task twice: once against a plain Qoder
config (baseline) and once against a config with the harness installed
(treatment). Each turn is a separate CLI process that resumes the same session,
so the context grows the way a real long session grows.

```
mhe ab --baseline-config <dir> --treatment-config <dir> --treatment-home <dir> \
  --arm both --turns 15 --repeats 2 --model Qwen3.8-Flash
```

Rules the runner enforces:

- both arms must point at isolated config dirs; the normal `~/.qoder-cn` and
  `~/.zcode` are rejected, and the baseline arm must not contain harness hooks;
- the treatment state home is a separate `MY_HARNESS_ENHANCE_HOME`;
- the model is pinned; `Auto` is rejected;
- results are written outside the repository (default
  `~/.mhe-test/ab-results/<stamp>`).

Per turn the runner records the model-reported `context_usage_ratio`, the CLI
duration, the fixture test result, and the hook counters of the treatment arm.
The run writes `summary.json` and `summary.md` next to the raw per-run files.

The fixture is a dependency-free library that grows by one function per turn,
with one test file; the deterministic check is `node --test`.

## Acceptance metrics

| Metric | What it proves | Target |
|---|---|---|
| Main context reduction | attention is offloaded | >80% in simulation; flat growth in real runs |
| Tool-schema share | conductor tool surface is small | <25% of main context |
| Invalid envelope leak rate | contract enforcement works | 0 raw invalid blobs in main context |
| Goal retention | conductor keeps the goal | correct restatement after compaction |
| Decision consistency | decisions are durable | no contradiction with `decisions.jsonl` |
| Redundant action rate | workers do not repeat work | lower than baseline |
| Compaction fidelity | capsule preserves critical facts | critical constraints present after compact |
| Human interventions | automation is real | not higher than baseline |
| Task success | the layer solves the problem | not lower than baseline |
| Cost/latency | efficiency | within an agreed budget |

## Needle test

Place a unique constraint early in the goal (e.g. "never modify file X" or a
secret code), run N steps, then ask the conductor to restate it. Repeat at
different context depths (10%, 30%, 50%, 70% of the window) to find the model's
attention knee. Set the compaction threshold below that knee.

## What would falsify the design

- The conductor accepts every envelope without evidence (rubber stamp).
- The main context still grows with raw tool output (normalization failed).
- Workers return invalid JSON most of the time (prompt/contract mismatch).
- The task tree is deeper than needed, and latency/cost explode.
- The verifier passes work that a human reviewer rejects.
- The free worker's rate limits make the task slower than doing it directly.

If any of these happen, fix the layer or the policy before adding more
topologies.
