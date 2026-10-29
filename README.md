# my-harness-enhance

> Chinese version: [README.zh-CN.md](README.zh-CN.md).

**Archived 2026-10-29. Read-only.** The record of a question, an implementation,
and the measurement that answered it. Nothing here is maintained, and no issue
or pull request will be handled.

## What It Was

`mhe` was a harness-agnostic control plane for long-horizon coding-agent work.
One main session acted as the conductor; isolated native workers did the
reading, editing, and checking; deterministic checks replaced a second LLM
audit; durable state lived outside the workspace. The host harness kept its
model loop, tools, sessions, compaction, and permissions. This layer only
decided what the conductor saw, what was delegated, and what counted as done.

The premise was narrow and testable. An agent session's context only grows, and
every token added is still there when the next decision is made, so a token's
cost is paid again on every later turn. If execution detail could be kept out of
the conductor's context while the decisions stayed in, long work would grow
more slowly instead of just longer. That was the whole hypothesis.

## The Question

The metric was named attention density: the share of what enters the context
that the current decision actually needs. It was chosen over "fewer tokens"
because fewer tokens is not a goal. A summary that drops the constraint the task
must not violate is smaller and worse. Growth rate was treated as a budget and
billed cost as a constraint, because both can be improved by deleting things the
model needed.

## How Context Was Observed

This is where the work actually was, and it is the part worth carrying forward.
Context is not observable directly. What exists is a sequence of model requests:
the harness re-renders the whole request on every step, so the unit of growth is
one request, not one user turn, and the UI transcript is a different object from
the payload that reaches the model.

Three sources were used, none of them complete:

- Hook telemetry, appending counts and sizes only — never prompts, summaries, or
  raw tool output — to `metrics.jsonl`: model, injected tokens, packet density,
  dispatch and job outcomes, compaction events, captured bytes.
- The CLI session transcript, summed by entry type, to attribute the payload:
  user tool results, hook attachments, assistant text, thinking.
- The provider's per-run credits, summed over the conductor session and every
  `subagents/agent-*.jsonl`. A run without worker usage is labelled
  `conductor-only`, because that is a different claim.

Three things made earlier numbers wrong, which is why the method is written down
and not just the results:

- The ratio the model reports (`context_usage_ratio`) is divided by a window the
  CLI resolves per session: 200,000 when it recognises the model, 1,048,576 when
  it falls back. The same payload can read five times apart. Both arms were
  therefore pinned to one explicit window and per-turn context stored as
  `context_tokens = ratio * window`; when the arms still disagreed, the run was
  marked not comparable and its ratios withdrawn.
- Runs that restarted the CLI every turn re-fired `SessionStart`, and the
  conductor policy plus capsule reached the transcript 29 times on a 15-turn
  run — 29.1k tokens of restart overhead that a real session never pays.
- The token estimator is deliberately rough (CJK about 0.6 token per character,
  other non-space about 0.28) and is only comparable against itself.

What the observation still cannot see: the full main context from a hook, so
`agent_result.compact_tokens` is only a proxy for what enters it; cumulative
input `B`, which was never collected; provider input/output splits, which the CLI
sometimes zeroes; and worker behavior, because the transcript records the
conductor's tool calls and not the workers'.

## What Was Measured

One task shape, both arms pinned to the same window, three runs per cell, worker
transcripts counted on the treatment side.

| Metric | Baseline | Treatment |
| --- | --- | --- |
| Conductor context at task end | 79,829 | 38,043 |
| Deterministic checks passed | 3/3 | 3/3 |
| Correct next action | 9/9 | 8/9 |
| Credits, workers included | 3.84 | 6.68 |
| Wall clock, minutes | 1.3 | 4.4 |

The same mechanism, measured at three patch sizes and two horizons, moves the
other way depending on how much content would have stayed resident:

| Patch lines | Turns | Credits, baseline | Credits, treatment | Ratio |
| ---: | ---: | ---: | ---: | ---: |
| 491 | 3 | 1.80 | 3.11 | 1.73x |
| 1,931 | 3 | 3.37 | 4.84 | 1.44x |
| 7,691 | 3 | 4.03 | 3.28 | 0.81x |
| 1,931 | 15 | 23.66 | 19.59 | 0.83x |

Those cells were measured under an earlier policy and count conductor credits
only; adding the worker transcripts turns each of them into a loss. Method
and caveats: [docs/metrics.md](docs/metrics.md).

## What The Numbers Support

The mechanism holds. The conductor's context halves and it still names the right
next step; no check regressed. It is not compression: the conductor never held
the file contents, because it was never allowed to read them. The saving is
permission narrowing plus result compaction, and it is real — 98.5k tokens of
accumulated patch against 13.3k over fifteen turns.

The saving does not pay for itself. Every worker cold-starts with about 23.8k
tokens of system and tool prefix and then runs its own loop; worker sessions
were 12-15 of 27-33 requests and 3.6-4.1 of 5.9-6.9 credits per run. Removing
all conductor overhead would still leave a cost above the baseline.

The trade is a condition, not a constant. Delegating a step that would put `C`
tokens into the main context and leave them there for `k` turns, against an
envelope of `e` and a worker prefix of `W`, breaks even only when
`C * (k - 1) > e * k + W`. Small or late steps lose by an order of magnitude.
The crossover table above is that inequality at work, not a contradiction of it.

## Why It Is Archived

The mechanism layer turned out to be commoditized. Harnesses ship subagents,
worktrees, compaction, permission modes, and plan state natively, and the
orchestration patterns are published in repositories with far more adoption. A
thin layer restating them adds risk, not capability.

The design's own boundary forced the expensive answer. It refused to modify the
host loop and only injected context, so delegation was the single lever for
slower conductor growth — and delegation is precisely the lever that does not
pay.

And the gap that remains is truth, not capacity. Models keep absorbing the
context-management problems; they will not absorb whether the work is actually
done, because that needs evidence fetched from the world. That is a benchmark
and a verification discipline, and a control plane is the wrong place to build
it.

## What Remains: Measuring And Observing Context

If anything here is still worth doing, it is the observation problem, not the
layer. The archive makes that concrete: these numbers needed a dedicated runner,
three sources, one pinned window, and a hand-written list of what the
measurement could not see. That apparatus is the asset; the control plane was
one consumer of it.

What is missing, in the order that matters:

- No unit of context growth survives across harnesses. Requests, turns,
  sessions, and windows are four different denominators, and comparing two arms
  across a different one produces the fivefold error described above. A portable
  measure needs the request as its unit and the resolved window as an explicit
  field, or it is not a measurement.
- Observation is entangled with what it observes. A hook cannot see the rendered
  request, a transcript is a lossy projection of it, and provider usage fields
  are sometimes zeroed. Anything claiming per-turn context must say which source
  it read and which it could not.
- Density has no consumer-side signal. A packet can be dense and still ignored;
  only behavior and outcome show whether it was used, and the labels used here
  cover the conductor alone.
- There is no benchmark for degradation over a horizon. Existing ones score
  endpoints, so a layer that holds quality for forty turns and collapses at
  sixty looks identical to one that never helped. Until that exists, every claim
  about long-horizon agents is an inference from short runs.

## What Is Still Worth Reading

- [docs/metrics.md](docs/metrics.md) — the whole method: what is collected, how
  the arms are pinned, when a run is only a smoke test, and why credits must be
  summed over the conductor and every worker transcript.
- [docs/architecture.md](docs/architecture.md) — the layer model and the
  invariants that made running a control plane safe.
- [src/core/checks.mjs](src/core/checks.mjs) — deterministic acceptance: input
  hashes, scope, allowlisted commands, all-or-nothing landing.
- [docs/roadmap.md](docs/roadmap.md) — what was planned and never built.

## What To Use Instead

| Need | Use |
| --- | --- |
| Spec-first planning from a vague idea | [spec-kit](https://github.com/github/spec-kit) or [OpenSpec](https://github.com/Fission-AI/OpenSpec) |
| Work that survives context loss | [planning-with-files](https://github.com/OthmanAdi/planning-with-files) |
| An enforced plan and check loop | [superpowers](https://github.com/obra/superpowers) |
| Knowing whether the work is done | executable checks in the repo, run at the stop gate |

## License

MIT