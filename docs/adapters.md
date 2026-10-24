# Harness adapter contract

> Chinese version: [adapters.zh-CN.md](adapters.zh-CN.md).

This repository is a harness-agnostic enhancement layer. The adapter
boundary is the contract that makes that claim true at the code level, not
just in the README. **Qoder is the first adapter implementation, ZCode the
second, and neither is the target scope**: the contract exists for Codex and
any other harness to implement against. An adapter is allowed to claim less
than Qoder — the ZCode adapter genuinely does — and it is not allowed to
claim what it does not do.

An adapter does not run the agent. It maps the control plane onto the host's
native mechanisms; the host keeps the model loop, tools, sessions, compaction,
and permissions.

Modules:

| File | Responsibility |
|---|---|
| `src/adapters/spec.mjs` | Capability schema, `defineAdapter()`, `describeAdapter()`. Pure contract, zero dependencies. |
| `src/adapters/registry.mjs` | In-memory register/get/list/unregister/detect by id. No process side effects; importing does nothing. |
| `src/adapters/qoder/adapter.mjs` | The Qoder adapter: existing `install.mjs`/`overlay.mjs` functions wrapped to the contract. No behavior changes. |
| `src/adapters/zcode/adapter.mjs` | The ZCode adapter: hooks merged into `config.json`, shared MCP server, conductor policy over ZCode's native Agent subagents. |
| `src/adapters/zcode/install.mjs` | ZCode detect/install/uninstall/doctor/refresh: config.json merging with backups, idempotent entries, user-owned entries preserved. |
| `src/adapters/zcode/hook.mjs` | ZCode hook script for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. All output is ZCode hook JSON. |
| `src/adapters/zcode/lib.mjs` | ZCode-local payload accessors and tool policy decisions (the adapters stay independent; only `src/core/*` is shared). |

Tests: `node --test test/adapters.test.mjs test/zcode.test.mjs`.

## The contract shape

`defineAdapter(spec)` accepts exactly four fields and rejects anything else
with a `TypeError`:

- `id` — lower identifier (`a-z`, digits, dot, dash, underscore). Trimmed
  and lowercased; interior spaces are an error, not silently rewritten.
- `label` — human name, non-empty.
- `capabilities` — object of `ADAPTER_CAPABILITIES` names to booleans.
  Unknown names are rejected (that is how a false claim becomes a loud
  failure). `false` is normalized away: absence means absence.
- `lifecycle` — optional object whose keys must come from
  `LIFECYCLE_STAGES` and whose values must be functions.

The result is frozen and branded with `Symbol.for('my-harness-enhance.adapter')`.
`isAdapter()` checks the brand; the registry only accepts branded objects,
so raw lookalikes cannot enter the system.

`describeAdapter(adapter)` returns a JSON-serializable description —
`{ id, label, capabilities: [names], lifecycle: [stage names] }` — with no
functions in it. Use it for logging, doctor output, and docs; never leak
closures.

## Lifecycle stages and their responsibilities

| Stage | Contract |
|---|---|
| `detect({ env, payload, ... })` | Answer whether this adapter matches the current machine/session. Truthy = matched (Qoder returns its resolved config dir). Must be cheap and side-effect-free; must not probe by guessing — no signal, return falsy. |
| `install(options)` | Wire the enhancement layer into the harness (hooks, MCP server, agents, overlays) and produce state. Idempotent; supports dry-run where the harness allows. |
| `uninstall(options)` | Remove exactly what `install` added; keep user-owned files. |
| `doctor(options)` | Self-check the installation and report `{ ok, checks[] }`. Never mutates. |
| `refresh(options)` | Re-probe harness capabilities (available agents, models) and update persisted capability plans without touching harness settings. |

## Capability schema

`ADAPTER_CAPABILITIES` is the only vocabulary adapters may claim:

| Capability | Meaning |
|---|---|
| `subagents` | Harness can launch delegated worker/subagent runs. |
| `hooks` | Harness supports lifecycle hooks (session, prompt, tool, subagent events). |
| `resultRewrite` | A hook can rewrite a tool result before the model sees it. |
| `preCompact` | Harness fires a pre-compaction event the adapter can act on. |
| `mcp` | Harness can run MCP servers. |
| `installer` | Adapter can install/uninstall its integration and self-check. |
| `overlay` | Adapter syncs user-level agent/content overlays on top of core roles. |
| `sessionMap` | Adapter keeps per-session role state (e.g. conductor session map). |
| `skills` | Harness supports reusable skill packages the adapter can install. |
| `modelSelection` | Adapter can select/steer conductor or worker models through a harness mechanism. |
| `statusLine` | Harness exposes a status line the adapter renders into. |
| `crossSession` | Adapter coordinates across concurrent sessions beyond shared state files. |

The core layer may branch on declared capabilities, but it must tolerate an
adapter that declares none of the optional ones. Capabilities the schema
does not cover stay unrepresentable until a real adapter needs them — no
speculative entries.

## Registry and detection

`detectAdapter({ env, payload, explicit })` resolves in strict order:

1. `explicit` id (case-insensitive). Unknown id is a hard error listing
   registered adapters.
2. `MY_HARNESS_ENHANCE_HARNESS` env var (`HARNESS_ENV_VAR`). Unknown value
   is the same hard error.
3. Each registered adapter's `detect()` in id order; first truthy match
   wins. A `detect()` that throws counts as no match — probing must not
   crash routing.
4. No match: a clear error telling you to set the env var or register an
   adapter. Silent null hides misconfiguration, so the default is loud.

Registration is explicit. `registry.mjs` holds only a `Map` and functions;
the built-in default set (Qoder and ZCode) is wired by
`registerDefaultAdapters()`, which every query (`get`/`list`/`detect`) also
runs once as a idempotent lazy bootstrap. Import-time magic is avoided:
importing the registry never touches the filesystem, the environment, or
harness config. The registry is generic — `registerAdapter()` accepts any
branded adapter (see the fake-adapter test), so nothing about either built-in
harness is hardcoded in routing.

## Qoder status (first implementation)

`src/adapters/qoder/adapter.mjs` declares, honestly:

| Claimed | Evidence in existing code |
|---|---|
| `hooks` | `install.mjs` merges hook entries for SessionStart, UserPromptSubmit, PreToolUse, SubagentStart, SubagentStop, PostToolUse, PreCompact, Stop. |
| `subagents` | native worker delegation resolved by `core/capabilities.mjs`. |
| `resultRewrite` | `hooks/hook.mjs` PostToolUse emits `updatedToolOutput`. |
| `preCompact` | `hooks/hook.mjs` `onPreCompact`. |
| `mcp` | stdio server `mcp/recall-server.mjs` registered via `mergeMcp`. |
| `installer` | wrapped `installQoder` / `uninstallQoder` / `doctorQoder`. |
| `overlay` | `overlay.mjs` sync/uninstall/doctor, run inside install/uninstall/doctor (results include an `overlay` report); exposed overlay-only via `qoderOverlay` for callers that need it. |
| `sessionMap` | per-session conductor map: `core/store.mjs` `readSessions`/`markSession` + `hooks/lib.mjs` `sessionIsConductor`. |

Not declared (and not faked): `skills`, `modelSelection`, `statusLine`,
`crossSession`.

Lifecycle mapping: `detect` wraps `detectConfigDir` but only answers when a
real signal exists (`QODER_CONFIG_DIR` or an explicitly passed config dir);
it never guesses from well-known home directories. `install` / `uninstall` /
`doctor` / `refresh` are thin wrappers over `installQoder` / `uninstallQoder`
/ `doctorQoder` / `refreshCapabilities`. No Qoder hook, MCP, or install
behavior changed — the adapter is a boundary, not a refactor.

## ZCode status (second implementation)

`src/adapters/zcode/adapter.mjs` declares, honestly:

| Claimed | Evidence in the adapter |
|---|---|
| `hooks` | `install.mjs` merges entries into `<configDir>/config.json` under `hooks.events`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop. Entries are `{ type: 'process', command: <node>, args: [<absolute hook.mjs>, <Event>], timeoutMs }` and `hooks.enabled` is turned on. |
| `subagents` | ZCode's native Agent delegation; capability resolution uses the built-in agents (`general-purpose`, `Explore`). ZCode custom agents are plugin-provided behind a manual UI step, so they are not part of automated detection; `<configDir>/agents` is runtime subagent session storage and is never scanned for definitions. |
| `mcp` | stdio server `harness-enhance` merged into `mcp.servers`, pointing at the harness-neutral `src/adapters/qoder/mcp/recall-server.mjs` with `MY_HARNESS_ENHANCE_HARNESS=zcode`; project-scoped installs also pin `MY_HARNESS_ENHANCE_PROJECT`, global installs set `MY_HARNESS_ENHANCE_GLOBAL=1` and pin no workspace. |
| `installer` | `installZCode` / `uninstallZCode` / `doctorZCode` / `refreshZCode`: config.json backup, idempotent merge, dry-run writes nothing, corrupt config refused instead of clobbered, `hooks.enabled` handed back to its pre-install value on uninstall. Project-scoped and `--global` modes. config.json is the ONLY file the installer writes under the config dir — no agent files, ever. |
| `sessionMap` | `hook.mjs` marks conductor sessions in `sessions.json` (SessionStart with source startup/new/resume/clear) and gates enforcement on that map. |

Not declared, because ZCode does not offer the mechanism:

| Absent | Why |
|---|---|
| `resultRewrite` | ZCode PostToolUse has no updated-tool-output channel. The hook stores the artifact, records the job, logs — and emits nothing. |
| `preCompact` | No PreCompact event. Capsule checkpoints happen at `Stop`; a `SessionStart` with `source=compact` re-injects the capsule — that is injection, not a compaction hook, and is not claimed as one. |
| worker events | No SubagentStart/SubagentStop. The adapter does not claim them; it *compensates* with the contract gate and synthetic job lifecycle below. A compensation is enforced behavior around the events ZCode does fire, not a native capability. |
| `overlay`, `skills`, `modelSelection`, `statusLine`, `crossSession` | Nothing wired: no personal-overlay sync, no skill installer, no model steering, no status line, no cross-session coordination. The installer never places any file under the ZCode config dir except config.json itself; `reason` needs no file because it resolves through the read-only compatibility below. |

### Compensations (workarounds, not claimed capabilities)

ZCode's five events are fewer than Qoder's eight, so two behaviors are
reconstructed around them. Both stay inside the declared capability set:
`resultRewrite` remains false, SubagentStart/Stop and PreCompact remain
absent.

**Reason role via read-only compatibility.** ZCode has no no-tools agent, and
it has no writable custom-agent directory: `<configDir>/agents` is runtime
subagent session storage (`sess_…` / `agent_…` directories), so an automated
install that dropped an `mhe-reasoner.md` there would pollute harness state.
Custom agents come from plugins through a manual UI step, which breaks
zero-context automated installs — so no agent file is installed, scanned, or
removed anywhere in the config dir. Instead, capability resolution performs
one explicit, labeled substitution: when `reason` has no dedicated agent, it
resolves to the built-in `Explore` with `compatibility: 'readonly'` and
`policy: 'readonly'` on the role. The plan therefore reads
`reason -> Explore (read-only compatibility)`. The conductor dispatches a
normal Explore worker with an instruction to reason from the material in the
task and not to use tools; Explore's own read-only policy is what bounds it —
this is a compatibility substitution, never advertised as a no-tools agent.
The substitution is identical across project installs, refreshes, and global
first-session auto-registers (`resolveZcodePlan` is the single source), and
doctor reports the compatibility line rather than a missing fallback. Strict
no-tools would require a separately installed plugin-provided agent; if that
ever lands as a scriptable mechanism, resolution can prefer it before
falling back to the Explore substitution.

**Subagent dispatch lifecycle.** No SubagentStart means no injection slot;
no SubagentStop means no completion event. The hook compensates on the
conductor's `Agent`/`Task` tool calls:

- PreToolUse, after the allowlist and the code-profile dependency gate,
  requires the worker contract text — the `enhance_worker_contract` output,
  recognized by its marker `[MY-HARNESS-ENHANCE WORKER CONTRACT]` — inside
  the prompt or description. Missing → deny with instructions to embed it.
  This is what keeps raw worker results bounded, since no result rewrite
  exists to fix them up afterwards.
- An accepted dispatch records a **synthetic** running job (generated id,
  worker type from `subagent_type`, role, task id if the prompt named one,
  session id). `agent_id` is deliberately empty: ZCode gives hooks no real
  subagent id, and pretending otherwise would be a false correlation.
- PostToolUse completes the oldest matching running job for that worker type
  and session — **FIFO, best-effort**. Parallel same-type dispatches can
  only be matched in dispatch order; that ambiguity is inherent to the
  missing event and is never hidden. A result with no matching running job
  (dispatch bypassed the layer) is still recorded as a completed job, so no
  result is lost. Either path: envelope parsed, raw result stored as an
  artifact, plan synced via `task_id`, job set to the envelope status or
  `invalid_result` + `retryable`, and **no output is emitted** — the model
  sees the raw tool response.

Hook I/O follows ZCode's documented shapes: payloads carry
`hook_event_name` / `session_id` / `cwd` / `model` / `tool_name` /
`tool_input` / `agent_type`; output is always valid hook JSON —
`hookSpecificOutput.additionalContext` for SessionStart/UserPromptSubmit,
`permissionDecision: deny` for PreToolUse, silence elsewhere. PreToolUse
enforcement is identical in policy to Qoder's: conductor allowlist (Agent
with a registered subagent type, AskUserQuestion, `enhance_*` MCP tools;
deny Bash/Read/Write/Edit and friends), Explore read-only, workers are
leaves (no nested Agent/Task). The code-profile dispatch dependency gate
mirrors Qoder exactly (shared core, no shared hook code): when the current
brief profile is `code`, a conductor `Agent`/`Task` call must name its plan
task in the prompt or description (`task_id: T2` / `task_id=T2`) — a missing
id, a task that is not in the plan, or any `depends_on` task that is not
`completed` (the deny lists the ids and statuses) blocks the dispatch; valid
dispatches pass and non-code briefs, absent briefs, worker events and other
tools are untouched.

Detection answers only on real signals: `ZCODE_CONFIG_DIR`, an explicit
config dir argument, or an existing `~/.zcode/cli`; nothing is ever created
or written by probing. Install refuses a missing config dir and a corrupt
`config.json` (never overwrite it). Two install modes:

- **Project-scoped** (default): `mhe install zcode --root <workspace>` pins
  `MY_HARNESS_ENHANCE_PROJECT` into the MCP entry and registers the workspace
  in core state; the hook stays completely dormant in any other directory.
- **Global**: `mhe install zcode --global` wires the user-level hooks/MCP with
  no fixed project and sets the ZCode marker `{ zcode: { autoRegister: true,
  configDir, hooksEnabledBefore } }` inside `~/.my-harness-enhance/global.json`
  — a nested key, so a Qoder global install's top-level keys are preserved and
  `uninstall zcode --global` only flips `zcode.autoRegister` back. The hook
  then auto-registers an unregistered workspace on a **new** SessionStart
  source (`startup`/`new`/`resume`/`clear`) using the same core capability
  resolution as install; `source=compact` only injects the capsule and never
  registers, PreToolUse and all other events never retrofit a running
  session, and system/home dirs stay excluded via `isExcludedProject`.

## What a Codex (or any further) adapter must provide

Minimum honest shape (see `src/adapters/zcode/adapter.mjs` for the working
reference of a harness that offers fewer events than Qoder):

```js
export const codexAdapter = defineAdapter({
  id: 'codex',
  label: 'Codex',
  capabilities: { /* only what is truly wired */ },
  lifecycle: {
    detect: ({ env, payload }) => /* match on a real signal */,
    install: (options) => /* wire hooks/servers, write state, idempotent */,
    uninstall: (options) => /* remove exactly what install added */,
    doctor: (options) => /* non-mutating self-check */,
    refresh: (options) => /* re-probe harness capabilities */,
  },
});
registerAdapter(codexAdapter); // or extend registerDefaultAdapters()
```

Per-capability expectations for a harness that wants to claim them:

- `hooks` / `resultRewrite` / `preCompact`: the adapter must prove the
  harness fires those events and honors the rewrite output, then route them
  to the existing core hook logic.
- `subagents`: a delegation mechanism plus capability detection so
  `refresh` can produce a role plan.
- `mcp`: a way to register an MCP server in harness settings.
- `installer`: install/uninstall/doctor against that harness's config
  layout, with backups, dry-run, and idempotency like Qoder's.
- `sessionMap`: store per-session role state under the shared user-level
  state root so core behavior sees it.
- `skills` / `modelSelection` / `statusLine` / `crossSession`: only after
  the harness mechanism exists; implement or omit, no placeholders.

Until such an adapter is registered, `MY_HARNESS_ENHANCE_HARNESS=codex` is a
clear "Unknown harness" error by design — the contract is ready, the
implementation is not, and the repo does not pretend otherwise. Both built-in
values (`qoder`, `zcode`) resolve because their adapters exist, each with
exactly its own capability set: ZCode claiming less than Qoder is the
contract working as intended, not a deficiency to hide.
