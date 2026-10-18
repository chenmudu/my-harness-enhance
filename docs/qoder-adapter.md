# Qoder adapter (v0.2)

> Chinese version: [qoder-adapter.zh-CN.md](qoder-adapter.zh-CN.md).

The primary installation runbook is [INSTALL.md](../INSTALL.md). This file is the
adapter-level detail.

## Paths

| Path | Use |
|---|---|
| `~/.qoder-cn/` | Qoder CN |
| `~/.qoder/` | Qoder international |
| `QODER_CONFIG_DIR` | explicit override |

State is user-level: `~/.my-harness-enhance/projects/<hash>/`. No `.router` in the
project repository.

## Install

Global mode (recommended; one install per machine):

```bash
node bin/mhe.mjs install qoder --global --dry-run
node bin/mhe.mjs install qoder --global
# restart Qoder once for the MCP server to reload in global mode
# then open ANY workspace and start a NEW session; it auto-registers
node bin/mhe.mjs doctor --root "<any-workspace>"
```

Project-scoped mode is still available:

```bash
node bin/mhe.mjs install qoder --root "<project>"
node bin/mhe.mjs capabilities --root "<project>"
```

Global install:

- writes `~/.my-harness-enhance/global.json` with `autoRegister: true`;
- merges 8 hooks and a global `harness-enhance` MCP server (no fixed project);
- does not write into any workspace;
- removes legacy `hr-*` agents (ours), keeps official/user agents;
- preserves and warns about an old `bash-delegate` hook.

On the first **new** session (`SessionStart` source startup/new/clear) in any
workspace, the hook registers it, resolves capabilities, creates user-level
state, and injects the conductor policy. Existing sessions are not retrofitted.
MCP tools take `project: <PROJECT>` from the capsule; if omitted, the server
falls back to `MY_HARNESS_ENHANCE_PROJECT` or its own cwd. It does not use the
global `active.json`, so two open workspaces cannot read each other's state.

Project install additionally writes the project's `config.json` /
`capabilities.json` immediately and can install `mhe-*` fallback agents for gaps.

## Capability reuse

| Role | Reuse first | Then | Fallback only if none |
|---|---|---|---|
| investigate | `Explore` | `general-purpose` | `mhe-investigator` |
| plan | `Explore` | `general-purpose` | `mhe-planner` |
| execute | `general-purpose` | — | `mhe-executor` |
| verify_read | `Explore` | `general-purpose` | `mhe-verifier` |
| verify_run | `general-purpose` | — | `mhe-verifier` |
| write | `general-purpose` | — | `mhe-writer` |
| reason | — | — | `mhe-reasoner` |
| lead | `general-purpose` | — | `mhe-lead` |

Tool policy:

- `Explore`: read-only; native Bash allowed for read-only checks; deny
  Write/Edit/Agent/Task.
- `general-purpose`: official executor/lead; filesystem tools open; as a worker
  deny Agent/Task.
- `env-runner`: old user executor; no longer selected.
- `reasoner`: old no-tools agent; kept on disk, not selected.
- `mhe-reasoner`: no tools.
- `mhe-*`: role policy; all workers are leaves.

Runtime escalation: the conductor tries the next candidate for the role if the
preferred worker fails or returns an invalid envelope. Invalid worker jobs carry
`retryable: true` and a `next` instruction.

## Hooks

| Event | Behavior |
|---|---|
| `SessionStart` | auto conductor; write role marker; inject policy + capsule |
| `UserPromptSubmit` | first prompt becomes goal; inject capsule |
| `PreToolUse` | conductor tool allowlist; native worker policy by agent type; native TaskCreate/Get/Update/List denied |
| `SubagentStart` | create job; inject role + envelope contract; workers are leaves |
| `SubagentStop` | parse/store envelope; update job; invalid results get retryable + next |
| `PostToolUse` | normalize conductor `Agent` results; capture large worker output; invalid results include the raw artifact handle |
| `PreCompact` | rebuild capsule from state |
| `Stop` | write capsule; block completion while a code worktree is unlanded |

Unknown agents (not in `capabilities.agents`) are silent: no contract, no tool
policy, no log. Unrelated main sessions outside registered projects are dormant.

## MCP tools

Server: `harness-enhance` (stdio). Tools:

`enhance_state`, `enhance_goal`, `enhance_plan`, `enhance_decide`,
`enhance_job`, `enhance_recall`, `enhance_artifact`, `enhance_capabilities`,
`enhance_worker_contract`.

The conductor sees these; existing MCP/connectors remain worker tools.

## State

```
~/.my-harness-enhance/projects/<hash>/
  config.json
  capabilities.json
  goal.json
  plan.json
  decisions.jsonl
  jobs.json
  capsule.md
  artifacts/
  logs/            # errors-only by default
  metrics.jsonl
```

`logs/` is errors-only unless `logging: "decisions"` is set in `config.json`.
`capsule.md` is compact working state, not a transcript.

## Validation

See [INSTALL.md](../INSTALL.md) section 6 and [validation.md](validation.md).

Real-session checklist: start a new session in the project (no selection); the
conductor should only call `Agent`/`enhance_*`; workers should be the native
agents above; invalid worker results must be replaced by a failure envelope;
state files should appear only for conductor/worker activity.

## Rollback

```bash
node bin/mhe.mjs disable --root "<project>"
node bin/mhe.mjs enable --root "<project>"
node bin/mhe.mjs uninstall qoder --root "<project>"
```

`uninstall` removes our hooks/MCP/`mhe-*`/`hr-*` agents, keeps official and user
agents, and keeps the user-level state for inspection.
