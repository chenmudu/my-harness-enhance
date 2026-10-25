# Retention and garbage collection

> Chinese version: [retention.zh-CN.md](retention.zh-CN.md).

`mhe gc` collects the user-level state under `~/.my-harness-enhance/`. It plans
first and acts only with `--apply`.

```
mhe gc [--root <project>] [--apply] [--json] [--include-decisions]
```

## Defaults

| Data | Limit | Action |
|---|---|---|
| `metrics.jsonl` | 30 days, 5 MB | drop expired lines, then the oldest lines above the cap |
| `logs/*.jsonl`, `logs/*.log` | 30 days, 5 MB | same trim |
| `artifacts/*.txt` | 30 days, plus 7 unreferenced days | delete the file and its index entry |
| `decisions.jsonl`, session journals | 180 days | off by default; enable with `--include-decisions` |
| worktrees | 7 days | only when the task is landed and the tree is clean |

## Safety rules

- a file changed in the last 10 minutes is skipped;
- an artifact referenced by a job, decision, brief, capsule, or session file is kept;
- a worktree with uncommitted changes is kept;
- the project state lock is held while the plan is collected and applied;
- artifact age comes from the index entry, and the unreferenced grace is added
  to the retention window, so a freshly unreferenced artifact survives one full
  grace period.

## What is not collected

Session shards under `sessions/<id>/` keep the goal, plan, jobs, and capsule.
They are small and hold the durable task graph, so `mhe gc` leaves them alone.
Delete a session by hand when it is no longer needed.
