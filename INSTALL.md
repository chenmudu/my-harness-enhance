# INSTALL — my-harness-enhance

> Chinese version: [INSTALL.zh-CN.md](INSTALL.zh-CN.md).

**Audience: an agent/LLM installing this on a machine.** Follow the relevant
platform/harness section, run the verification commands, and report exactly what
was reused, what was installed, and what was skipped.

Core rule: **reuse first**. Official harness agents > already-installed user
agents > our `mhe-*` fallback. Never delete official agents. Only install a
fallback when the policy table proves a gap. State lives in the user profile,
never in the project repository.

---

## 1. Preflight

1. Node.js `^22.19.0 || >=24.0.0`:
   ```bash
   node -v
   ```
2. Harness installed. This repo implements **Qoder** (first adapter) and
   **ZCode** (second adapter). Install each harness separately; do not use one
   adapter's commands for the other.
3. Choose the **project** to enhance. Use a dedicated project: in auto mode every
   main session in that project becomes the conductor. Do not enable it in a
   workspace that still runs the old ad-hoc workflow.
4. Find the harness config dir:
   - Qoder: `QODER_CONFIG_DIR` if set; Windows `%USERPROFILE%\.qoder-cn` (CN)
     or `%USERPROFILE%\.qoder` (INTL); macOS/Linux `~/.qoder-cn` or `~/.qoder`.
   - ZCode: `ZCODE_CONFIG_DIR` if set; otherwise `~/.zcode/cli`.
5. Inventory agents (do not modify official ones):
   ```bash
   ls "<qoder-config-dir>/agents"
   ```
   Official built-ins are not files: `general-purpose`, `Explore`.
   The no-tools reasoning role uses the `mhe-reasoner` fallback on Qoder; the
   old user `reasoner` is kept on disk but is **not selected** anymore.
   `env-runner` is the old custom executor and is **not selected** either.
   On ZCode, custom agents are plugin-provided; `<zcode-config-dir>/agents` is
   runtime subagent storage, not an agent-definition directory. Do not put
   `.md` definitions there.
6. Never delete `general-purpose` or `Explore`; only remove a user agent when
   the user explicitly asks.

State home (all platforms): `~/.my-harness-enhance` (Windows:
`%USERPROFILE%\.my-harness-enhance`). Nothing is written into the repo.

---

## 2. Hardcoded capability policy

This is not an LLM scoring step. The installer applies this table in order.

| Role | Reuse first | Then | Fallback only if none |
|---|---|---|---|
| investigate | `Explore` (official) | `general-purpose` | `mhe-investigator` |
| plan | `Explore` | `general-purpose` | `mhe-planner` |
| execute | `general-purpose` (official) | — | `mhe-executor` |
| verify_read | `Explore` | `general-purpose` | `mhe-verifier` |
| verify_run | `general-purpose` | — | `mhe-verifier` |
| write | `general-purpose` | — | `mhe-writer` |
| reason | — | — | `mhe-reasoner` |
| lead | `general-purpose` | — | `mhe-lead` |

Tool policy by agent type:

- `Explore`: read-only; allows its native Bash for read-only checks; no
  Write/Edit/Agent/Task.
- `general-purpose`: official executor/lead; filesystem tools open; as a worker
  it may not use Agent/Task (one-level delegation only).
- `env-runner`: old user custom executor; not selected anymore.
- `reasoner`: old no-tools agent; kept on disk but not selected.
- `mhe-reasoner`: no tools; analysis only.
- `mhe-*`: same policy as its role; all workers are leaves.

Runtime rule: if the chosen worker fails or returns an invalid envelope, the
conductor tries the next candidate listed for that role. Only a missing
capability causes a fallback agent to be installed.

Adapter-specific reason handling:

- **Qoder** installs the `mhe-reasoner` no-tools fallback when the role is
  otherwise unfilled.
- **ZCode** has no no-tools built-in and no writable custom-agent definition
  directory. The adapter resolves `reason` to the built-in read-only `Explore`
  with `compatibility: readonly`. The conductor must instruct it to reason
  from the provided material and not use tools; Explore's own read-only policy
  is the enforced bound. Strict no-tools would require a separately installed
  ZCode plugin agent.

On this machine the expected Qoder result is **1 fallback agent** (`mhe-reasoner`):

```text
investigate -> Explore
plan        -> Explore
execute     -> general-purpose
verify_read -> Explore
verify_run  -> general-purpose
write       -> general-purpose
reason      -> mhe-reasoner
lead        -> general-purpose
```

---

## 3. Install on Qoder

From the repo root:

**Global mode is the recommended default: install once per machine, then any
workspace works.**

```bash
# 1) inspect: no writes
node bin/mhe.mjs install qoder --global --dry-run

# 2) real install: backs up settings.json, merges hooks/MCP, writes global.json
node bin/mhe.mjs install qoder --global

# 3) restart Qoder ONCE so the harness-enhance MCP server reloads in global mode

# 4) open ANY workspace and start a NEW session. No agent/model selection.
#    SessionStart (startup/new/clear) auto-registers that workspace.

# 5) verify (after the first session, or before it in global mode)
node bin/mhe.mjs doctor --root "<any-workspace>"
node bin/mhe.mjs capabilities --root "<workspace>"
```

What global install does:

- writes `~/.my-harness-enhance/global.json` with `autoRegister: true`;
- merges 7 Qoder hooks and the `harness-enhance` MCP server (global env; no
  fixed project);
- does **not** register a project and does **not** write into any workspace;
- removes legacy `hr-*` agents (ours), keeps official/user agents;
- preserves an old `bash-delegate` hook but warns if present.

On the first **new** session in a workspace, the hook:

- registers the workspace in `~/.my-harness-enhance/projects.json`;
- resolves capabilities from official/user agents for that workspace;
- creates `config.json` + `capabilities.json` under
  `~/.my-harness-enhance/projects/<hash>/`;
- injects the conductor policy and capsule; the native main session becomes the
  conductor.

Already-running sessions are **not retrofitted**; only new sessions auto-register.
MCP `enhance_*` tools take `project: <PROJECT>` from the capsule; if omitted they
fall back to `MY_HARNESS_ENHANCE_PROJECT` or the MCP process cwd. The global
`active.json` is not used for routing, so parallel workspaces stay isolated.

Project-scoped install is still available for a single project:

```bash
node bin/mhe.mjs install qoder --root "<absolute-project-path>"
```

It registers that project immediately and can install `mhe-*` fallback agents for
capability gaps. Use it if you want strict per-project control or fallbacks.

---

## 3b. Install on ZCode

ZCode is the second adapter. It uses ZCode's native hooks and MCP support and
never writes into the target workspace.

```bash
# 1) inspect: no writes
node bin/mhe.mjs install zcode --global --dry-run

# 2) real install: backs up the ZCode config, merges hooks/MCP
node bin/mhe.mjs install zcode --global

# 3) restart ZCode ONCE so hooks and the MCP server reload

# 4) open a NEW session in any workspace; SessionStart auto-registers it

# 5) verify
node bin/mhe.mjs doctor zcode --root "<workspace>"
node bin/mhe.mjs capabilities --root "<workspace>"
```

What ZCode global install does:

- merges `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and
  `Stop` hooks into `<zcode-config-dir>/config.json`;
- enables `hooks.enabled` and adds the `harness-enhance` MCP server;
- writes the `zcode` auto-register marker in
  `~/.my-harness-enhance/global.json`; Qoder's global settings are preserved;
- does not write agent definitions, does not write into the project repo, and
  does not install a no-tools agent (see the reason compatibility note above).

Project scope is also available:

```bash
node bin/mhe.mjs install zcode --root "<project>"
node bin/mhe.mjs doctor zcode --root "<project>"
```

ZCode-specific contract:

- There is no SubagentStart/SubagentStop. The hook requires the
  `enhance_worker_contract` text in every conductor `Agent`/`Task` prompt and
  records a synthetic job at dispatch, completed at PostToolUse.
- There is no result rewrite. Worker results must stay compact via the required
  contract; the raw result still reaches the conductor.
- There is no PreCompact. The capsule is written at `Stop` and re-injected when
  `SessionStart` reports `source=compact`.
- In a code brief, dispatch also requires `task_id: <plan id>`; dependencies
  must be completed.

---

## 4. Platform notes

| Platform | Qoder config | State home | Notes |
|---|---|---|---|
| Windows | `%USERPROFILE%\.qoder-cn` / `.qoder` | `%USERPROFILE%\.my-harness-enhance` | hook commands quote `node.exe` and forward-slash paths; no admin needed |
| macOS | `~/.qoder-cn` / `~/.qoder` | `~/.my-harness-enhance` | same hooks; `process.execPath` |
| Linux | `~/.qoder-cn` / `~/.qoder` | `~/.my-harness-enhance` | same hooks; `process.execPath` |

There is no hardcoded `C:\` path in the code. The installer uses
`os.homedir()` and `process.execPath`; the hook command is generated for the
current platform.

For multiple machines: run this runbook on each machine. The project source is
portable; the state/registry is per machine and local. Do not copy another
machine's `~/.my-harness-enhance` state.

---

## 5. State files and repository pollution

```
~/.my-harness-enhance/
  projects.json                         # project path -> state dir
  projects/<hash>/
    config.json                         # conductor mode, capability config, logging
    capabilities.json                   # resolved role -> native agent mapping
    decisions.jsonl                     # append-only decisions
    sessions.json                       # host session -> id, host_pid, cwd, last_seen
    artifacts/                          # evidence (local; may contain secrets)
    logs/                               # errors-only by default
    metrics.jsonl
    sessions/<sid>/
      goal.json                         # canonical goal/acceptance/constraints
      brief.json                        # shared brief for this session
      plan.json                         # task graph
      jobs.json                         # worker routing/status
      session.json                      # current session role/model/source
      last-check.json                   # durable deterministic check result
      capsule.md                        # compact state injected into the conductor
      journal.md                        # follow-up prompts
      worktrees.json                    # task id -> path, head, status
  worktrees/<projectKey>/<sessionKey>/<task_id>
  legacy/                               # migrated old .router dirs
```

- Working state is per session under `sessions/<sid>/`; config, capabilities,
  decisions, artifacts, metrics, `sessions.json`, and logs are shared.
- No `.router` in the project repository.
- `logs/` defaults to **errors-only**; set `logging: "decisions"` in
  `config.json` for a full decision audit, or `"off"` to disable.
- `capsule.md` is working state, not a chat transcript.
- `jobs.json` is the routing table.
- `artifacts/` can contain sensitive material; keep it local and redact before
  sharing.

---

## 6. Verification

```bash
node --test                 # 235 tests
node bin/mhe.mjs bench      # main-context simulation
node bin/mhe.mjs demo       # state/contract/artifact demo
node bin/mhe.mjs doctor --root "<project>"
```

Real-session checklist:

1. Start a new Qoder session in the project; no agent/model selection.
2. The conductor should only call `Agent`/`Task` and `enhance_*`; if it tries
   Bash/Read/Write/Edit, the hook denies and tells it to delegate.
3. Workers should be `Explore` for investigate/plan/verify_read,
   `general-purpose` for execute/write/verify_run, `mhe-reasoner` for pure
   reasoning, and `general-purpose` for lead/complex.
4. The conductor uses `enhance_plan` as the only task graph; native
   `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` are denied.
5. `capsule.md`, `jobs.json`, and `logs/` should appear only for conductor/worker
   activity; unrelated sessions remain silent.
6. Invalid worker results are replaced by a valid failure envelope before they
   reach the conductor; the job also records `retryable: true` and `next`.
7. Compare Qoder's context panel: the conductor's `messages` share should stay
   flat instead of growing with raw tool output.

Do not claim a real Qoder session passed unless one was actually run; the
installer/hook simulation is not a real model session.

---

## 7. Cleanup, migration, rollback

```bash
node bin/mhe.mjs disable --root "<project>"   # hooks no-op, installation stays
node bin/mhe.mjs enable --root "<project>"
node bin/mhe.mjs uninstall qoder --root "<project>"  # remove hooks/MCP/our agents
node bin/mhe.mjs reset --root "<project>"           # archive goal/jobs/artifacts, keep config/capabilities
```

- `uninstall` removes `harness-enhance` hooks/MCP and `mhe-*`/`hr-*` agents;
  it keeps `general-purpose`/`Explore` (official) and user-owned agents, and
  keeps the user-level state for inspection.
- Settings backups are written next to `settings.json` before every write.
- Legacy `hr-*` removal is expected; they were ours. Official agents are never
  removed.
- `mhe-reasoner` is the installed no-tools fallback. Keep the old `reasoner`
  file if an old session references it, but do not put it back in the capability
  table.

---

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| hooks do not fire | `mhe doctor`; config dir; start a **new** session; settings backup |
| conductor not recognized | project registered? cwd inside the project? `programs.json` entry; auto mode |
| MCP `enhance_*` tools missing | settings `mcpServers.harness-enhance`; `MY_HARNESS_ENHANCE_PROJECT`; new session |
| worker not used | `mhe capabilities`; the conductor may pick a later candidate |
| no capsule/jobs/logs | logs are errors-only by default; check state dir; normal ops do not write audit logs |
| 9B conductor fails to delegate | old `bash-delegate` hook may block native workers; use a non-9B model or remove that old hook |
| Qoder CN vs INTL | `QODER_CONFIG_DIR`, `~/.qoder-cn`, `~/.qoder` |
| legacy `.router` still in repo | run install again; it migrates/removes; do not commit it |

---

## 9. ZCode adapter status and limits

The ZCode adapter is implemented for project and global modes. It installs
hooks and the shared MCP server only; it never writes agent definitions into
`<zcode-config-dir>/agents` (that directory is runtime subagent storage).

What is compensated rather than native:

- **No SubagentStart**: every conductor `Agent`/`Task` prompt must carry the
  `enhance_worker_contract` text; otherwise PreToolUse denies the dispatch.
- **No SubagentStop**: a synthetic running job is recorded at dispatch and
  completed at PostToolUse (FIFO matching for parallel same-type workers).
- **No result rewrite**: the contract keeps worker output compact, but the raw
  tool result still reaches the conductor. Do not claim rewritten output.
- **No PreCompact**: capsule checkpoints happen at `Stop`; a compact-source
  `SessionStart` re-injects the capsule.
- **No no-tools agent**: `reason` resolves to built-in `Explore` with
  `compatibility: readonly`. The conductor instructs it not to use tools and
  Explore's read-only policy is enforced. Strict no-tools requires a separately
  installed ZCode plugin agent.

The MCP server is shared with Qoder; both adapters use the same user-level
state and brief/check/worktree features. ZCode must be restarted after install
for the hooks/MCP changes to load. Verify with
`mhe doctor zcode --root "<project>"` and
`mhe capabilities --root "<project>"`; `reason` should show the
read-only compatibility, not a missing fallback.
