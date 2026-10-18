#!/usr/bin/env node
// The ZCode lifecycle hook. Registered for the five events ZCode actually
// fires that this layer uses: SessionStart, UserPromptSubmit, PreToolUse,
// PostToolUse, Stop. ZCode has no SubagentStart/SubagentStop and no result
// rewrite. Compensations (explicit workarounds, NOT claimed as native
// capabilities):
//   - the SubagentStart injection slot is enforced from the outside: every
//     conductor Agent/Task dispatch must embed the worker contract text
//     (enhance_worker_contract output, marker below) in its prompt, or
//     PreToolUse denies;
//   - PreToolUse records a SYNTHETIC running job (ZCode gives hooks no real
//     agent id, so agent_id is empty and correlation is best-effort);
//   - PostToolUse completes the oldest matching running job for that worker
//     type (FIFO; parallel same-type dispatches can only be matched in
//     dispatch order), parses the envelope, stores the raw result as an
//     artifact, and syncs the plan;
//   - PostToolUse never emits updatedToolOutput; it only stores and logs.
// All emitted output is valid ZCode hook JSON.
import path from 'node:path';
import { ensureState, loadConfig } from '../../core/config.mjs';
import { conductorInjection, writeCapsule } from '../../core/capsule.mjs';
import { extractText, invalidResultEnvelope, parseEnvelope } from '../../core/contract.mjs';
import { byteLength } from '../../core/metrics.mjs';
import { putArtifact } from '../../core/artifacts.mjs';
import { checkTaskDependencies, diffWorktree } from '../../core/worktree.mjs';
import { canonicalPath } from '../../core/state-root.mjs';
import { isExcludedProject, readGlobalConfig } from '../../core/global.mjs';
import { resolveConfigDir, resolveZcodePlan } from './install.mjs';
import {
  appendDecision,
  appendJournal,
  markSession,
  newJobId,
  readBrief,
  readGoal,
  readJobs,
  readLastCheck,
  readSession,
  readWorktrees,
  updatePlanTask,
  upsertJob,
  writeGoal,
  writeSession,
} from '../../core/store.mjs';
import {
  agentTypeOf,
  conductorDenyReason,
  denyTool,
  hookJson,
  isAllowedConductorTool,
  isConductorSession,
  log,
  logError,
  modelOf,
  projectContext,
  readStdin,
  roleFor,
  sessionIsConductor,
  toolInputOf,
  toolNameOf,
  workerPolicy,
  workerToolDecision,
  writeJson,
} from './lib.mjs';

const EVENT = process.argv[2] || 'Unknown';
const FRESH_SOURCES = ['startup', 'new', 'clear'];
const MARKED_SOURCES = ['startup', 'new', 'resume', 'clear'];

const HARNESS_MCP_PREFIXES = ['mcp__harness-enhance__', 'mcp__harness_enhance__'];

/**
 * Deterministic project-argument gate, identical semantics to the Qoder
 * hook: a conductor passing a `project` outside its session root writes
 * state into the wrong workspace. Extract the project argument for
 * harness MCP calls: direct tool names and the mcp_call/mcp_get gateway.
 */
function harnessProjectArg(tool, toolInput) {
  if (
    HARNESS_MCP_PREFIXES.some((prefix) => tool.startsWith(prefix))
    || tool.startsWith('enhance_')
  ) {
    return typeof toolInput?.project === 'string' ? toolInput.project.trim() : '';
  }
  if (tool === 'mcp_call' || tool === 'mcp_get') {
    const target = String(toolInput?.toolName || toolInput?.name || '');
    if (!HARNESS_MCP_PREFIXES.some((prefix) => target.startsWith(prefix))) return '';
    const args = toolInput?.arguments;
    return args && typeof args.project === 'string' ? args.project.trim() : '';
  }
  return '';
}

function projectGateReason(root, projectArg) {
  if (!projectArg) return '';
  const sessionRoot = canonicalPath(root);
  const project = canonicalPath(projectArg);
  if (project === sessionRoot) return '';
  const rel = path.relative(sessionRoot, project);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '';
  return `project mismatch: ${project} is not this session root ${sessionRoot} or a path inside it. `
    + `Use project: ${sessionRoot}; never copy a workspace path from GOAL/notes.`;
}

// The conductor must name the plan task it dispatches so dependencies can be
// enforced at dispatch time: "task_id: T2" (or task_id=T2) in the Agent/Task
// prompt or description. Case-insensitive, first match wins.
const DISPATCH_TASK_ID_RE = /task_id\s*[:=]\s*([A-Za-z0-9._-]{1,64})/i;
const DISPATCH_WORKTREE_RE = /(?:^|\n)\s*worktree(?:\s+path)?\s*(?:\([^)\r\n]*\))?\s*[:=]\s*([^\r\n]+)/i;

function normalizeWorktreeRef(value) {
  return String(value || '').trim().replace(/^[`"']+|[`"']+$/g, '').trim();
}

function dispatchWorktreeReason(root, taskId, text) {
  const matched = text.match(DISPATCH_WORKTREE_RE);
  if (!matched) {
    return `code tasks must include worktree: <path> in the dispatch prompt (the exact path returned by enhance_worktree create for ${taskId}). Add the line and retry.`;
  }
  const ref = normalizeWorktreeRef(matched[1]);
  const entry = readWorktrees(root).worktrees?.[taskId];
  if (!entry?.path) {
    return `no worktree is registered for task ${taskId}; call enhance_worktree create task_id=${taskId} and copy its exact path.`;
  }
  if (canonicalPath(ref) !== canonicalPath(entry.path)) {
    return `worktree path mismatch for task ${taskId}: got ${ref}, expected ${entry.path}. Use the exact path returned by enhance_worktree create.`;
  }
  return '';
}

function verificationGateReason(root, text) {
  if (!/(verify|verification|parity|recheck|复核|校对|验收)/i.test(text)) return '';
  const completed = (readJobs(root).jobs || []).filter((job) => job.status === 'ok');
  if (completed.length === 0) return '';
  const at = (job) => Date.parse(job.updated_at || job.finished_at || job.created_at || 0) || 0;
  const latest = completed.reduce((a, b) => (at(b) > at(a) ? b : a));
  const jobAt = at(latest);
  const last = readLastCheck(root);
  const checkAt = Date.parse(last?.at || 0) || 0;
  if (!last || checkAt < jobAt) {
    return `worker ${latest.id} completed task ${latest.task_id || '(unassigned)'} but no deterministic check ran after it. Run enhance_check now; do not dispatch a verification worker.`;
  }
  const blockers = (last.findings || []).filter((item) => item.level === 'blocker');
  const configRules = new Set(['checker.unknown', 'command.unknown', 'brief.missing', 'brief.empty']);
  if (!last.ok && blockers.length > 0 && blockers.every((item) => configRules.has(item.rule))) {
    return `the deterministic check is misconfigured (${blockers.map((item) => item.rule).join(', ')}). Fix the brief with enhance_brief using allowed checker ids, then rerun enhance_check; do not dispatch a verification worker.`;
  }
  return '';
}

/**
 * Dependency gate for conductor dispatch, code profile only. Returns a deny
 * reason, or '' when the dispatch may proceed (including non-code briefs and
 * dispatches that carry no plan task, which are left to the base policy).
 * Same semantics as the Qoder gate; shared through core, not by import.
 */
function dispatchGateReason(root, toolInput) {
  const brief = readBrief(root);
  if (!brief || String(brief.profile || '') !== 'code') return '';
  const text = [toolInput?.prompt, toolInput?.description]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join('\n');
  const matched = text.match(DISPATCH_TASK_ID_RE);
  if (!matched) {
    const hints = Object.entries(readWorktrees(root).worktrees || {})
      .filter(([, entry]) => entry?.path && String(entry.status || 'active') !== 'landed')
      .slice(0, 3)
      .map(([id, entry]) => `task_id: ${id}\nworktree: ${entry.path}`)
      .join('\n\n');
    return 'code tasks must include task_id: <plan id> and worktree: <exact path> in the dispatch prompt. '
      + (hints
        ? `Use one of these exact prefixes:\n${hints}`
        : 'Call enhance_worktree create first; it returns the exact prompt_prefix to copy.');
  }
  const gate = checkTaskDependencies(root, matched[1]);
  if (!gate.ok) return `dispatch blocked for task ${matched[1]}: ${gate.blocker}`;
  const worktreeReason = dispatchWorktreeReason(root, matched[1], text);
  if (worktreeReason) return worktreeReason;
  const landedEntry = readWorktrees(root).worktrees?.[matched[1]];
  if (String(landedEntry?.status || '') === 'landed') {
    return `task ${matched[1]} is already landed; do not dispatch another worker. Remove the worktree with enhance_worktree remove and report the result.`;
  }
  const lastCheck = readLastCheck(root);
  const checkedIds = Array.isArray(lastCheck?.task_ids) ? lastCheck.task_ids.map(String) : [];
  const verified = Boolean(
    lastCheck?.ok
    && (
      checkedIds.includes(matched[1])
      || (checkedIds.length === 0 && String(gate.task?.status) === 'completed')
    )
  );
  if (verified) {
    const landId = String(lastCheck?.worktree_task_id || matched[1]);
    return `task ${matched[1]} is already verified by enhance_check; do not dispatch another worker. Call enhance_worktree land task_id=${landId} instead.`;
  }
  return '';
}

// --- SubagentStart/Stop compensation ---------------------------------------
// ZCode never fires SubagentStart, so the worker contract cannot be injected
// at launch from the harness side. Instead the conductor must paste the
// enhance_worker_contract output into the dispatch prompt; the canonical
// marker is the first line of core/capsule.mjs workerContract(), so any
// genuine contract text passes.
const WORKER_CONTRACT_MARKER = '[MY-HARNESS-ENHANCE WORKER CONTRACT]';

function dispatchText(toolInput) {
  return [toolInput?.prompt, toolInput?.description]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join('\n');
}

function workerNameOf(toolInput) {
  return String(
    toolInput?.subagent_type || toolInput?.agent || toolInput?.name || '',
  ).trim();
}

function contractGateReason() {
  return 'ZCode fires no SubagentStart, so the worker contract must travel inside the ' +
    'dispatch prompt. Call the enhance_worker_contract MCP tool and paste its full output ' +
    `(including the marker "${WORKER_CONTRACT_MARKER}") into the Agent/Task prompt, then retry.`;
}

/**
 * Synthetic running job standing in for SubagentStart. ZCode exposes no real
 * agent id to hooks, so agent_id stays empty: the job exists to make ACTIVE
 * JOBS and completion bookkeeping real, not to claim a correlation ZCode
 * does not provide.
 */
function recordDispatchJob(root, config, toolInput, text, payload) {
  const worker = workerNameOf(toolInput);
  const matched = text.match(DISPATCH_TASK_ID_RE);
  const sessionId = String(payload.session_id || payload.sessionId || '').trim();
  return upsertJob(root, newJobId('job'), {
    agent_id: '',
    type: worker,
    role: worker ? roleFor(config, worker) : 'worker',
    task_id: matched ? matched[1] : '',
    status: 'running',
    depth: 1,
    session_id: sessionId,
    recorded_by: 'zcode-pre-tool-use',
  });
}

/**
 * FIFO matching is the best available correlation: oldest running dispatch
 * job of the same worker type within the same session (when the payload
 * carries a session id). Two parallel same-type dispatches complete in
 * dispatch order by assumption — ambiguous by construction, documented in
 * docs/adapters.md, and never crashing or dropping a result.
 */
function findRunningDispatchJob(root, worker, sessionId) {
  const running = readJobs(root).jobs.filter((job) =>
    job.status === 'running'
    && job.recorded_by === 'zcode-pre-tool-use'
    && String(job.type || '') === worker
    && (sessionId ? String(job.session_id || '') === sessionId : true));
  return running[0] || null;
}

function artifactSummary(text, fallback = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return fallback;
  if (value.length <= 240) return value;
  const cut = value.slice(0, 236);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 160 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function syncPlanFromEnvelope(root, envelope) {
  const taskId = String(envelope?.task_id || '').trim();
  if (!taskId) return null;
  const check = envelope.check_result;
  let status = '';
  if (envelope.status === 'failed' || envelope.status === 'blocked' || check?.ok === false) {
    status = 'blocked';
  } else if (envelope.status === 'ok' && check?.ok === true) {
    // Advisory only: enhance_check or land owns completion. A worker cannot
    // mark its own task complete.
    status = 'in_progress';
  } else if (envelope.status === 'partial') {
    status = 'in_progress';
  }
  if (!status) return null;
  return updatePlanTask(root, taskId, { status });
}

async function onSessionStart(payload, root, config) {
  if (!config.enabled || !config.conductor?.auto) return;
  // Subagent sessions must never overwrite the main session role marker.
  if (agentTypeOf(payload)) return;

  const source = String(payload.source || '');
  if (source === 'compact') {
    // ZCode has no PreCompact event. The most an adapter may honestly do at
    // compaction time is re-inject the durable capsule, so SessionStart with
    // source=compact writes and injects the capsule alone — no policy claim.
    const capsule = writeCapsule(root);
    log(root, { event: EVENT, role: 'conductor', source: 'compact', capsule_chars: capsule.length }, config);
    writeJson(hookJson('SessionStart', { additionalContext: capsule }));
    return;
  }

  const sessionId = String(payload.session_id || payload.sessionId || '').trim();
  if (MARKED_SOURCES.includes(source)) {
    writeSession(root, {
      role: 'conductor',
      model: modelOf(payload),
      source,
      fresh: FRESH_SOURCES.includes(source),
    });
    if (sessionId) {
      markSession(root, sessionId, {
        role: 'conductor',
        model: modelOf(payload),
        source,
      });
    }
    log(root, { event: EVENT, role: 'conductor', source, model: modelOf(payload) }, config);
  }
  writeCapsule(root);
  writeJson(hookJson('SessionStart', { additionalContext: conductorInjection(root) }));
}

async function onUserPromptSubmit(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;

  const prompt = String(payload.prompt || '').trim();
  if (prompt) {
    const goal = readGoal(root);
    const session = readSession(root);
    const continuation = /^(继续|接着|continue|go on|retry|再试|继续吧)/i.test(prompt)
      && prompt.length < 60;
    if (!goal.text) {
      writeGoal(root, { text: prompt });
      appendDecision(root, 'goal set from first user prompt');
    } else if (session.fresh && !continuation) {
      // A new session with a substantive new task replaces the old goal.
      // A short "continue" keeps the goal and is journaled instead.
      writeGoal(root, { text: prompt, replace: true });
      appendDecision(root, 'goal replaced on new session');
    } else {
      appendJournal(root, prompt);
    }
    writeSession(root, { fresh: false });
  }
  writeCapsule(root);
  writeJson(hookJson('UserPromptSubmit', { additionalContext: conductorInjection(root) }));
}

async function onPreToolUse(payload, root, config) {
  if (!config.enabled) return;

  const tool = toolNameOf(payload);
  if (!tool) return;
  const toolInput = toolInputOf(payload);
  const agentType = agentTypeOf(payload);

  if (agentType) {
    const decision = workerToolDecision(agentType, tool, config);
    if (!decision) return; // unknown agent: not ours, stay silent
    log(root, {
      event: EVENT,
      role: 'worker',
      agent_type: agentType,
      tool,
      allow: decision.allow,
    }, config);
    if (!decision.allow) denyTool(decision.reason);
    return;
  }

  if (!isConductorSession(root, config, payload)) return;
  const projectReason = projectGateReason(root, harnessProjectArg(tool, toolInput));
  if (projectReason) {
    log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'project' }, config);
    denyTool(projectReason);
    return;
  }
  const allow = isAllowedConductorTool(tool, toolInput, config);
  if (allow && (tool === 'Agent' || tool === 'Task')) {
    const text = dispatchText(toolInput);
    const verificationReason = verificationGateReason(root, text);
    if (verificationReason) {
      log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'verification' }, config);
      denyTool(verificationReason);
      return;
    }
    const gateReason = dispatchGateReason(root, toolInput);
    if (gateReason) {
      log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'dispatch' }, config);
      denyTool(gateReason);
      return;
    }
    // Contract gate: profile-independent, because ZCode has no SubagentStart
    // for any brief type. Without the embedded contract the worker has no
    // envelope requirement and its raw result would flood the conductor.
    if (!text.includes(WORKER_CONTRACT_MARKER)) {
      log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'contract' }, config);
      denyTool(contractGateReason());
      return;
    }
    recordDispatchJob(root, config, toolInput, text, payload);
  }
  log(root, { event: EVENT, role: 'conductor', tool, allow }, config);
  if (!allow) denyTool(conductorDenyReason(tool, config));
}

async function onPostToolUse(payload, root, config) {
  if (!config.enabled) return;

  const tool = toolNameOf(payload);
  const agentType = agentTypeOf(payload);
  const policy = agentType ? workerPolicy(config, agentType) : null;
  const conductor = !agentType && isConductorSession(root, config, payload);
  const response = payload.tool_response
    ?? payload.toolResponse
    ?? payload.response
    ?? payload.result;

  if ((tool === 'Agent' || tool === 'Task') && conductor) {
    // SubagentStop compensation: complete the oldest matching running
    // dispatch job created by PreToolUse (FIFO, best-effort correlation).
    // If no running job matches — the dispatch bypassed the layer or the
    // job was already reaped — record a completed job instead of losing
    // the result. Either way this payload is the completed result of
    // exactly one conductor Agent call with the worker type in tool_input.
    const worker = workerNameOf(toolInputOf(payload));
    const sessionId = String(payload.session_id || payload.sessionId || '').trim();
    const raw = extractText(response);
    const parsed = parseEnvelope(raw, config.envelope);
    const artifact = putArtifact(root, {
      content: raw || '(empty agent result)',
      kind: 'conductor-agent-result',
      source: `conductor:${tool}`,
      summary: parsed.ok
        ? artifactSummary(parsed.value.summary, 'agent result')
        : artifactSummary(`invalid agent result: ${parsed.errors.join('; ')}`),
    });
    const existing = findRunningDispatchJob(root, worker, sessionId);
    const jobId = existing?.id || newJobId('agent');
    const invalid = parsed.ok ? null : invalidResultEnvelope(parsed.errors.join('; '), raw);

    upsertJob(root, jobId, {
      agent_id: existing?.agent_id || '',
      type: worker,
      role: existing?.role || (worker ? roleFor(config, worker) : 'worker'),
      depth: existing?.depth || 1,
      session_id: existing?.session_id ?? sessionId,
      task_id: parsed.ok ? parsed.value.task_id : (existing?.task_id || ''),
      status: parsed.ok ? parsed.value.status : 'invalid_result',
      result_handle: artifact.handle,
      envelope: parsed.ok ? parsed.value : invalid,
      error: parsed.ok ? '' : parsed.errors.join('; ').slice(0, 500),
      retryable: !parsed.ok,
      next: parsed.ok ? '' : (invalid?.next ?? ''),
      recorded_by: existing?.recorded_by || 'zcode-post-tool-use',
      finished_by: 'zcode-post-tool-use',
    });
    if (parsed.ok) syncPlanFromEnvelope(root, parsed.value);

    log(root, {
      event: EVENT,
      role: 'conductor',
      tool,
      valid: parsed.ok,
      status: parsed.ok ? parsed.value.status : 'invalid_result',
      artifact: artifact.handle,
      job_id: jobId,
      job_matched: Boolean(existing),
    }, config);
    // ZCode provides no PostToolUse result rewrite. Emit nothing; the model
    // sees the raw tool output, and `resultRewrite` stays undeclared. The
    // contract gate above (embedded envelope limits) is what keeps that raw
    // output bounded in practice.
    return;
  }

  if (policy && response != null && sessionIsConductor(root, config, payload)) {
    const text = extractText(response);
    const bytes = byteLength(text);
    if (bytes > config.context.captureToolOutputBytes) {
      const artifact = putArtifact(root, {
        content: text,
        kind: 'tool-output',
        source: `${agentType}:${tool}`,
        summary: `${tool} output, ${bytes} bytes`,
      });
      // Capture only. Truncating what the model sees would require the
      // updatedToolOutput channel ZCode does not have.
      log(root, {
        event: EVENT,
        role: 'worker',
        agent_type: agentType,
        tool,
        captured: true,
        bytes,
        artifact: artifact.handle,
      }, config);
    }
  }
}

async function onStop(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;
  // ZCode has no PreCompact event. Stop is the natural capsule checkpoint: the
  // next SessionStart/compact injection reads exactly this file.
  const capsule = writeCapsule(root);
  const brief = readBrief(root);
  if (String(brief?.profile || '') !== 'code') {
    log(root, { event: EVENT, role: 'conductor', capsule_chars: capsule.length }, config);
    return;
  }
  const unlanded = [];
  for (const [id, entry] of Object.entries(readWorktrees(root).worktrees || {})) {
    if (!entry?.path || String(entry.status || 'active') === 'landed') continue;
    const diff = diffWorktree(root, id, { includePatch: false });
    if (diff.ok && diff.changed_count > 0) unlanded.push(id);
  }
  if (unlanded.length > 0) {
    const reason = `code worktree(s) not landed: ${unlanded.join(', ')}. `
      + 'Call enhance_worktree land for each (commit=true only when a commit is requested), '
      + 'then remove the landed worktree before reporting completion.';
    writeJson({ continue: true, additionalContext: reason });
    log(root, { event: EVENT, role: 'conductor', blocked: true, unlanded }, config);
    return;
  }
  log(root, { event: EVENT, role: 'conductor', capsule_chars: capsule.length }, config);
}

/**
 * Global-mode registration: only with the `zcode` marker in global.json set
 * (install zcode --global) and only for a NEW SessionStart source. Never
 * retrofit an already-running session mid-task, and never treat source=compact
 * (a continuation of context) as a new workspace. System and home dirs are
 * excluded. Mirrors the Qoder auto-register semantics through the same core
 * primitives, and resolves the identical built-in-only capability plan with
 * the read-only `reason` compatibility (install/refresh/auto-register share
 * resolveZcodePlan), so every auto-registered workspace gets the same roles.
 */
function autoRegister(payload, event) {
  const global = readGlobalConfig();
  if (global.zcode?.autoRegister !== true) return null;
  const cwd = payload.cwd || process.env.MY_HARNESS_ENHANCE_PROJECT || process.cwd();
  if (isExcludedProject(cwd, global)) return null;
  try {
    const configDir = global.zcode.configDir || resolveConfigDir(null);
    const { capabilities } = resolveZcodePlan();
    const { root } = ensureState(cwd, {
      harness: 'zcode',
      zcode: { configDir, autoRegistered: true },
      logging: global.logging || 'errors',
      capabilities,
    });
    // Re-resolve so the returned project carries the registry state dir.
    return projectContext({ cwd: root });
  } catch (error) {
    try {
      logError(cwd, event, error);
    } catch {
      // ignore
    }
    return null;
  }
}

async function main() {
  const payload = await readStdin();
  const event = EVENT !== 'Unknown' ? EVENT : String(payload.hook_event_name || 'Unknown');
  let project = projectContext(payload);
  // Project-scoped installs keep unregistered workspaces completely dormant;
  // global mode activates them on their first new session.
  const newSession = event === 'SessionStart'
    && MARKED_SOURCES.includes(String(payload.source || ''));
  if (!project && newSession) project = autoRegister(payload, event);
  if (!project) {
    process.exitCode = 0;
    return;
  }
  const root = project.projectRoot;
  const { config } = loadConfig(root);
  if (!config.enabled) {
    process.exitCode = 0;
    return;
  }

  try {
    switch (event) {
      case 'SessionStart':
        await onSessionStart(payload, root, config);
        break;
      case 'UserPromptSubmit':
        await onUserPromptSubmit(payload, root, config);
        break;
      case 'PreToolUse':
        await onPreToolUse(payload, root, config);
        break;
      case 'PostToolUse':
        await onPostToolUse(payload, root, config);
        break;
      case 'Stop':
        await onStop(payload, root, config);
        break;
      default:
        log(root, { event, ignored: true }, config);
    }
  } catch (error) {
    try {
      logError(root, event, error);
    } catch {
      // ignore
    }
  }
  process.exitCode = 0;
}

main();
