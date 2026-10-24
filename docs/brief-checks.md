# Brief and deterministic checks

> Chinese version: [brief-checks.zh-CN.md](brief-checks.zh-CN.md).

The conductor should create a shared **brief** before fan-out, and run
**deterministic checks** before accepting the result. This replaces the
expensive pattern:

```text
translate all files -> full LLM audit -> harmonize -> final audit
```

with:

```text
brief + parallel workers -> deterministic check -> accept (or targeted fix)
```

## 1. Brief

`enhance_brief` stores `~/.my-harness-enhance/projects/<hash>/sessions/<sid>/brief.json` and
injects a compact form into every worker.

Fields:

| Field | Meaning |
|---|---|
| `profile` | `general`, `docs`, `code`, `research`, `ops` |
| `inputs` | source paths + SHA256 captured at brief time |
| `pairs` | for docs: source -> Chinese target |
| `glossary` | source term, target term, `translate` or `keep` |
| `ownership` | allowed changed-file globs for code |
| `checks` | checker ids: `inputs`, `docs`, `scope`, `command:test/lint/typecheck/build`, or a registered command |
| `notes` | profile-specific rules (format, line endings, code fences) |

For a docs task:

```json
{
  "profile": "docs",
  "glossary": [
    { "source": "tool", "target": "工具", "mode": "translate" },
    { "source": "worker", "target": "worker", "mode": "keep" }
  ]
}
```

Pairs are auto-discovered from `*.zh-CN.md` files when omitted.

For a code task:

```json
{
  "profile": "code",
  "ownership": ["src/**", "test/**", "package.json"],
  "checks": ["scope", "command:test"]
}
```

The defaults for `profile: code` are `scope` and `command:test`. `command:test`
is mandatory for code: a scope/lint/build check cannot replace it. `inputs`
is a **preflight guard for `land`**, not a post-land check: land hashes the
inputs against the clean base *before* applying the patch (failure is the
`worktree.inputs_preflight` blocker) and excludes `inputs` from the
post-apply checks, because the landed patch may legitimately edit files the
brief hashed. Use `inputs` to pin reference files that must not drift
between the brief and the delivery.

`command:test` is discovered automatically:
`config.verification.commands.test` wins; otherwise `npm test` when
`package.json` has a `test` script; otherwise `node --test` when Node test
files exist. `lint`, `typecheck`, and `build` use the matching npm script.
Registered commands still win and are the only way to run arbitrary command
ids.

Invalid checker ids and shell strings are rejected by `enhance_brief`; use
checker ids, not commands. For document parity use `docs`, not shell tests.

## 2. Checks

`enhance_check` returns bounded JSON:

```json
{
  "ok": false,
  "checked": ["inputs", "docs"],
  "findings": [
    { "level": "blocker", "rule": "docs.fence-content", "message": "..." }
  ],
  "summary": { "blockers": 1, "warnings": 0, "infos": 0 },
  "task_ids_completed": [],
  "task_ids_pending_land": [],
  "task_ids_blocked_by_land": []
}
```

Built-in checkers:

- `inputs`: every input hash still matches the brief; stale source is a
  blocker. `land` runs this before applying, never after.
- `docs`: headings, fenced blocks (content), tables, inline code, numeric
  multisets, unresolved links, line endings, and glossary terms.
- `scope`: uses `git status --porcelain` and `ownership`; code tasks need a git
  worktree. Files outside ownership are blockers.
- `command:<id>`: a registered command; non-zero exit is a blocker.

`enhance_check` writes `last-check.json` and the capsule shows its status. For
docs and non-worktree checks, passing `task_ids` marks those plan tasks
completed. For a code task with an active worktree, the check must run with
that worktree, sets `land_required: true`, and keeps the owner `in_progress`
with `task_ids_pending_land`; other dependent/verification task ids stay
pending and are reported in `task_ids_blocked_by_land`. Only
`enhance_worktree land` marks the owner completed.

## 3. Policy

- Deterministic checks run first.
- A full semantic audit is only for a failed check, an ambiguous requirement, or
  a sampled review. It is not the default.
- A failed check routes to the owning task/file; do not launch a global
  harmonization pass.
- Workers are leaves. The conductor is the only router.
- `check_result` in the worker envelope is advisory; `enhance_check` / `land` is
  the authoritative result. A worker can never mark its own plan task complete.
- Do not dispatch a verification worker before a deterministic check, and do
  not replace a misconfigured check with a worker; fix the brief and rerun.

## 4. Code-specific rules

- Code workers must have disjoint ownership; otherwise serialize.
- Prefer a git worktree or an isolated checkout per worker. The code profile
  uses `enhance_worktree`; a code worker must run inside the exact registered
  worktree, and delivery is not complete until `land` succeeds.
- Run targeted tests in the worker; `land` reruns the brief checks against the
  base once, so do not add a separate verification worker.
- Keep worker prompts lean: do not ask for hashes, parity scripts, a full
  self-audit, commits, branches, or merges. Workers leave changes in the
  worktree; `land` owns integration.
- Do not let a worker weaken tests; test files are owned/frozen or separately
  reviewed.
- A code task without git is a blocker for `scope` by design.

## 5. Task granularity

A task is a **delivery unit**: one owner, one brief/check set, one
worktree/land boundary. It is not a step.

- **Merge defaults.** Small independent files or work items go into one task
  when they share ownership and checks and fit one worker context: docs up to
  3 small files or ~500 lines total; code one coherent change, usually <=3
  files, including its tests.
- **Split only** when ownership or checks differ, dependencies require
  serialization, the work is large enough to parallelize, or a worker returns
  `needs_split`.
- **Never tasks.** Verification/checking, commit/land, cleanup, and
  plan/reason are harness duties (`enhance_check`, `land`, the capsule), not
  plan tasks.
- **Single-small-file floor.** There is nothing to merge: one execute worker
  is the floor and no verify/cleanup workers are added. If this is still
  slower than a direct session, that is a fast-path decision, not a splitting
  decision.

The four e2e sessions each ran one execute worker; the extra time came from
worker startup and conductor turns — and, before this fix, from
verify/cleanup tasks — not from the number of files.

## 6. Restart after an upgrade

`enhance_brief` and `enhance_check` are MCP tools. Restart Qoder or ZCode once
after installing this version so the running `harness-enhance` MCP server
reloads the new tool list and descriptions. Hooks (brief injection, plan sync,
dispatch gates) use fresh hook processes and take effect immediately.
