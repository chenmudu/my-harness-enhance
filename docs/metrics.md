# Metrics and validation

> Chinese version: [metrics.zh-CN.md](metrics.zh-CN.md).

## Primary metric

Attention density — the share of the injected tokens that the current decision
actually needs — is what this layer is for. Everything else is a constraint or a
proxy:

| Quantity | Role | Status |
| --- | --- | --- |
| attention density | primary metric | packet share collected; payload share collected for the treatment arm |
| `b` (growth per turn) | budget | collected per turn as `context_usage_ratio` × session window |
| `M_T` (final main context) | window check | simulated only |
| `B` (cumulative input) | cost | not collected |
| `C` (billed cost) | economics | collected per run as `credits` |

The order is attention density > context structure > growth rate > token cost. A
projection that shows only the current task scores close to 100% on the ratio
while hiding the rest of the ledger, so the ratio only means something next to
task success, cost, and behavior signals. Do not headline the simulated `M_T`
reduction.

## Token estimator

`estimateTokens` is dependency-free and deliberately rough:

- CJK code points: ~0.6 token each (1.0 overstates Chinese payloads by ~1.7x);
- other non-space characters: ~0.28 token each (about 3.6 chars/token);
- whitespace: 0.

Use the same estimator on both sides of an A/B comparison. The absolute number
is approximate, so only compare numbers produced by the same estimator.

## Simulated scenarios

`node bin/mhe.mjs bench` compares:

- **baseline**: system + full tool schemas + every tool result + every reasoning
  trace in the main context;
- **conductor**: system + conductor tool schemas + compact state + one envelope per
  worker result. Raw tool output and worker reasoning stay outside the main
  context.

Current output on this machine:

| scenario | fixed | artifacts | assembly | conductor total | baseline total | reduction |
|---|---:|---:|---:|---:|---:|---:|
| light (3 steps) | 5,448 | 1,722 | 0 | 7,170 | 34,122 | 79.0% |
| medium (8 steps) | 5,448 | 3,613 | 0 | 9,061 | 92,623 | 90.2% |
| heavy (16 steps) | 5,448 | 7,293 | 0 | 12,741 | 244,023 | 94.8% |

`fixed` is system plus tool schemas (paid on every request), `artifacts` is the
layer's own state and envelopes, `assembly` is task content the baseline keeps
in the main context. The layer moves assembly out and pays a small fixed and
artifact cost instead.

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
| `prompt_submitted` | prompt chars, goal chars, capsule tokens, injected chars/tokens, mode (anchor/delta), changed sections |
| `dispatch` / `tool_denied` | tool, allow, gate |
| `job_start` / `job_stop` | agent type, job id, status, valid, retryable, error class, result tokens |
| `agent_result` | valid, status, raw and compact envelope tokens |
| `behavior_label` | turn, next-action hit, wrong-task count, re-reads, failed, recovered (written by `mhe ab`) |
| `now_after_tool` | tool, chars (frontier reminder appended to a tool result) |
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
| `b` (growth per turn) | collected per turn | `context_usage_ratio` × window in `mhe ab` |
| `B` (cumulative input) | not collected | needs per-turn context accounting |
| `C` (billed cost) | collected per run | conductor plus `subagents/agent-*.jsonl` credits in `mhe ab` |
| Composition | measured from the transcript | assistant text / thinking / tool input / tool results / worker results |
| Envelope / capsule tokens | collected | hook telemetry |
| Behavior labels | collected per run | `behavior_label` rows written by `mhe ab` |
| Attention density | packet share and payload share collected | `prompt_submitted` packet/relevant/injected tokens and per-turn `context_tokens` |

`density` is `relevant_tokens / packet_tokens`, where relevant means everything
outside the PARKED and MORE sections. It says how much of the packet is about the
current decision; it does not say the model acted on it, which is what the
behavior labels are for.

The packet share covers only the injected delta; a request's payload is the whole
conversation. The A/B report prints both numbers: `density` (packet composition)
and that turn's injected tokens over `context_tokens` (payload share). The baseline
has no layer, so its share is not applicable, not zero. Provider input/output splits stay
unavailable when the CLI zeroes those usage fields, and the report says so
instead of inventing them.

The hook cannot see the full main context, so `agent_result.compact_tokens` is
the best per-dispatch proxy for what enters it, and composition needs the CLI
transcript. Do not present the simulated `M_T` reduction as a growth-rate
measurement.

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
(treatment). One CLI process per run receives every prompt as a `stream-json`
user message and a turn boundary is a `result` event, so `SessionStart` fires
once per run the way it does in a real session.

Runs recorded before this change started a new CLI process per turn. That fired
`SessionStart` again for every turn and inflated the treatment side: on a
15-turn run the conductor policy plus capsule reached the transcript 29 times
(60.6k tokens), and 29.1k of that was restart overhead a real session never
pays. Those numbers overstate injection cost; the runner no longer produces
them.

To attribute what actually enters the conductor, read the CLI session transcript
at `<config-dir>/projects/<workspace-key>/<session>.jsonl` and sum its entries by
type (`user` tool results, `attachment` hook injections, `assistant` text and
thinking).

Behavior labels come from the same transcript. They cover the main session
only: the transcript records the conductor's tool calls, not the workers'.

| label | definition |
| --- | --- |
The oracle for each turn is the script table plus every path the prompt itself
names, so a reworded prompt widens the expectation instead of breaking the
label. The same transcript always produces the same numbers.

| next-action hit | the first action of a turn names a path the prompt expects |
| wrong-task write | a write lands outside the expected paths for that turn |
| re-read | a read of a file the same session already read |
| recovery | a turn after a failed one still starts on an expected path |

```
mhe ab --baseline-config <dir> --treatment-config <dir> --treatment-home <dir> \
  --arm both --turns 15 --repeats 2 --model GLM-5.3-Flash
```

Rules the runner enforces:

- both arms must point at isolated config dirs; the normal `~/.qoder-cn` and
  `~/.zcode` are rejected, and the baseline arm must not contain harness hooks;
- the treatment state home is a separate `MY_HARNESS_ENHANCE_HOME`;
- the model is pinned; `Auto` is rejected;
- both arms get the same explicit `--context-window` (default 200,000); when the
  arms still report different windows the run is invalid and its ratios withdrawn;
- `--repeats` is reported as median [min-max]; under three runs is a smoke test;
- credits sum the conductor session and every `subagents/agent-*.jsonl`; a run
  without worker usage is labelled `conductor-only`;
- results are written outside the repository (default
  `~/.my-harness-enhance/ab-results/<stamp>`);
- a turn that returns `is_error` is recorded with the CLI's own error text; the
  free model tier has a daily usage cap, so a long run can end with `error_code`
  110 rather than a result.

Per turn the runner records the model-reported `context_usage_ratio`, the CLI
duration, the fixture test result, and the hook counters of the treatment arm.
The run writes `summary.json` and `summary.md` next to the raw per-run files.

Each run also leaves a per-arm `workspace/` under the output directory. Keep
`summary.json`, `summary.md` and `runs/*/result.json`, then delete the
workspaces; `npm test` uses one disposable temp root instead of the real one.

The ratio is `input_tokens / max_input_tokens` for the last request, clamped to
0..1, with the token fields themselves zeroed by the CLI. The denominator is per
session rather than per model: 200,000 when the CLI resolves the model, 1,048,576
when it falls back, so the same payload can read 5x apart across two arms. The
runner therefore also reads the session's `runtime-config.contextWindow` and
stores `context_tokens = ratio × window` per turn. When the arms reported
different windows, `summary.json` sets `context.comparable` to `false` and
`summary.md` warns that the ratios are relative only and must not be compared.

`--fixture-kind` picks the task shape:

- `library` (default): a dependency-free library that grows by one function per
  turn, with one test file; the deterministic check is `node --test`.
- `review`: 15 patches, each adding a small module with exactly one planted
  defect from a fixed vocabulary; the answer is the rule id, and the check
  compares it with the planted value. The work is judgment over the whole hunk,
  so a keyword search cannot shortcut it. `--patch-size small|medium|large`
  scales a patch to about 500, 2,000, and 8,000 lines.

### Task-shape crossover (one repeat, GLM-5.3-Flash)

Three turns, three patch sizes:

| patch lines | baseline credits (conductor) | treatment credits (conductor) | ratio | wall (min) | baseline tool tokens | treatment tool + worker |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 491 | 1.80 | 3.11 | 1.73x | 1.0 / 4.5 | 7,881 | 3,050 |
| 1,931 | 3.37 | 4.84 | 1.44x | 1.0 / 6.4 | 31,401 | 3,198 |
| 7,691 | 4.03 | 3.28 | 0.81x | 2.9 / 7.6 | 15,634 | 3,484 |

Fifteen turns at 1,931 lines, same configuration, only the horizon changed:

| turns | baseline credits (conductor) | treatment credits (conductor) | ratio | wall (min) | baseline tool tokens | treatment tool + worker |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 3.37 | 4.84 | 1.44x | 1.0 / 6.4 | 31,401 | 3,198 |
| 15 | 23.66 | 19.59 | 0.83x | 6.7 / 21.8 | 98,535 | 13,280 |

The mechanism is in the content columns. `Read` is a normal tool, so whatever
the baseline reads stays in the conductor and is re-sent on every later
request; the layer reads inside workers and only the result comes back. Over
fifteen turns that is 98.5k tokens of accumulated patch against 13.3k.

Those tables count conductor credits only. Adding the worker transcripts turns
every measured shape into a loss: 2.91x, 2.22x and 2.49x at three turns, and
1.43x at fifteen. The horizon narrows the gap but has not crossed 1.0x.

Two caveats. At 7,691 lines the host refuses a whole `Read` above 25k tokens, so
both arms sample with `limit` reads and Grep; that row measures where sampling
happens, not who read more. And re-reads are not a stable signal: 14 at 491
lines, 2 at 1,931 lines / 3 turns, 0 at 1,931 lines / 15 turns.

### Task-card policy (three repeats, Qwen3.8-Flash)

Three turns of the `review` fixture at 1,931 lines. This cell adds the worker
task card, per-section injection budgets, and the brief/task hash handshake;
the tables above use the earlier policy and cannot be mixed with it.

| arm | final checks | next-action hit | main context (tokens) | credits, worker included | wall (min) |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 3/3 | 8/9 | 79,829 | 3.84 | 1.3 |
| treatment | 3/3 | 9/9 | 38,043 | 6.68 | 4.4 |

Density held at 0.924 of the packet (0.918 under the earlier policy), and all
nine dispatches carried a matching `task_id` and hash handshake. The extra cost
is the worker session itself: 12-15 of 27-33 requests and 3.6-4.1 of 5.9-6.9
credits per run. Removing all conductor overhead would still leave the worker
loop, so the 2x wall and 1.25x billed-credit gates stay open as a property of
delegation, not of conductor context. The layer's payload share was 0.0079-0.0084
per turn, 2.1-2.3% of the final context: the packet is dense, but most of the
conversation is not the layer.

## Acceptance metrics

| Metric | What it proves | Target |
|---|---|---|
| Attention density | the conductor sees what the decision needs | packet share per turn plus payload share; behavior labels per run |
| Main context growth (`b`) | execution detail stays out of the main context | below baseline on the same task shape; not demonstrated yet |
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
