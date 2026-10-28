import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, resolveProject } from './state-root.mjs';
import { readBrief, readJobs, readLastCheck, readSessions, readWorktrees, storePaths } from './store.mjs';
import { roleHintForAgent } from './capabilities.mjs';
import { checkTaskDependencies } from './worktree.mjs';
import { isHandle, readArtifactIndex } from './artifacts.mjs';

export const NATIVE_TASK_TOOLS = new Set(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
export const DELEGATION_TOOLS = new Set(['Agent', 'Task']);
export const HARNESS_MCP_PREFIXES = ['mcp__harness-enhance__', 'mcp__harness_enhance__'];
export const GATEWAY_TOOLS = new Set(['mcp_get', 'mcp_call']);

export function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(input || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Resolve the registered project for a hook payload. Returns null when the
 * project is not installed; hooks then stay completely dormant.
 */
export function projectContext(payload = {}) {
  return resolveProject(
    payload.cwd
    || process.env.MY_HARNESS_ENHANCE_PROJECT
    || process.cwd(),
  );
}

export function agentTypeOf(payload = {}) {
  return String(payload.agent_type || payload.agentType || '').trim();
}

export function toolNameOf(payload = {}) {
  return String(payload.tool_name || payload.toolName || '').trim();
}

export function toolInputOf(payload = {}) {
  return payload.tool_input || payload.toolInput || {};
}

export function modelOf(payload = {}) {
  const raw = payload.model || payload.model_id || payload.modelId;
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    return String(
      raw.display_name || raw.displayName || raw.name || raw.id || raw.model || '',
    );
  }
  return String(raw);
}

export function sessionIsConductor(root, config, payload = {}) {
  const sessionId = String(payload.session_id || payload.sessionId || '').trim();
  if (sessionId) {
    const entry = readSessions(root).sessions[sessionId];
    return entry?.role === 'conductor';
  }
  // Events without a session id (and unit tests) fall back to auto mode.
  return config.conductor?.auto === true;
}

export function isConductorSession(root, config, payload = {}) {
  if (agentTypeOf(payload)) return false;
  return sessionIsConductor(root, config, payload);
}

export function workerPolicy(config, agentType) {
  return config.capabilities?.agents?.[agentType] || null;
}

export function roleFor(config, agentType) {
  return roleHintForAgent(agentType, config.capabilities);
}

function isHarnessMcp(tool) {
  return HARNESS_MCP_PREFIXES.some((prefix) => tool.startsWith(prefix));
}

/**
 * The worker role a dispatch names. Qoder and ZCode spell the field
 * differently, and both accept a bare `name`.
 */
export function subagentOf(toolInput = {}) {
  return String(
    toolInput?.subagent_type || toolInput?.agent || toolInput?.name || '',
  ).trim();
}

const READ_ONLY_KINDS = new Set(['readonly', 'notools', 'verify']);

/**
 * Can this worker write into the repository? Unknown agents are assumed to be
 * able to write: the gate must fail closed.
 */
export function writesRepository(config, agentType) {
  const policy = workerPolicy(config, agentType);
  if (!policy) return true;
  if (READ_ONLY_KINDS.has(String(policy.kind || ''))) return false;
  const allow = policy.allow;
  if (allow === '*') return true;
  if (Array.isArray(allow)) return allow.includes('Write') || allow.includes('Edit');
  return true;
}

/**
 * The conductor may use the harness state tools and delegate to registered
 * workers. Everything else is repository work and belongs to a worker.
 */
export function isAllowedConductorTool(tool, toolInput, config) {
  if (!tool) return false;
  if (isHarnessMcp(tool)) return true;
  if (tool.startsWith('enhance_')) return true;
  // Native task tools are a second, session-local task graph. The durable
  // enhance_plan is the only task source of truth.
  if (NATIVE_TASK_TOOLS.has(tool)) return false;
  if (GATEWAY_TOOLS.has(tool)) {
    const target = String(toolInput?.toolName || toolInput?.name || '');
    return isHarnessMcp(target);
  }

  if (DELEGATION_TOOLS.has(tool)) {
    const subagent = subagentOf(toolInput);
    if (!subagent) return false;
    return (config.capabilities?.allowedSubagents || []).includes(subagent);
  }

  return (config.conductor?.allowedTools || []).includes(tool);
}

export function workerToolDecision(agentType, tool, config) {
  const policy = workerPolicy(config, agentType);
  if (!policy) return null; // unknown agent: stay silent
  // The conductor is the only router. Keep the delegation tree at one level
  // regardless of what a persisted old capability policy says.
  if (DELEGATION_TOOLS.has(tool)) {
    return {
      allow: false,
      reason: `${agentType} is a leaf worker and may not spawn agents. `
        + 'Return status=needs_split so the conductor can split the task.',
    };
  }
  const deny = policy.deny;
  if (deny === '*' || (Array.isArray(deny) && deny.includes(tool))) {
    return {
      allow: false,
      reason: `${agentType} (${policy.kind || 'worker'}) may not use ${tool}.`,
    };
  }
  const allow = policy.allow;
  if (allow === '*' || (Array.isArray(allow) && allow.includes(tool))) {
    return { allow: true, reason: '' };
  }
  return {
    allow: false,
    reason: `${agentType} (${policy.kind || 'worker'}) may not use ${tool}. `
      + `Allowed: ${allow === '*' ? 'all' : (allow || []).join(', ') || '(none)'}.`,
  };
}

export function conductorDenyReason(tool, config) {
  if (NATIVE_TASK_TOOLS.has(tool)) {
    return 'Native task tools are disabled for the conductor. Use enhance_plan as the '
      + 'single durable task graph; worker jobs are tracked through enhance_job.';
  }
  if (DELEGATION_TOOLS.has(tool)) {
    const allowed = config.capabilities?.allowedSubagents || [];
    if (allowed.length === 0) {
      return 'No worker capabilities are resolved for this project. Run `mhe refresh` '
        + '(or reinstall) so the available subagents can be detected.';
    }
    return `Conductor may only delegate to: ${allowed.join(', ')}. `
      + 'Use a registered worker role from the WORKERS mapping.';
  }
  return 'Conductor must not execute repository work. Delegate to a native worker via Agent, '
    + 'or use the enhance_* state tools (enhance_recall for one bounded read). '
    + 'Do not use native Read/Glob/Grep, run commands, fetch the web, or call non-enhance MCP/skills directly.';
}

export function log(root, event, config = null) {
  try {
    const mode = config?.logging || 'errors';
    if (mode === 'off') return;
    if (mode === 'errors') {
      const isError = event.allow === false
        || event.valid === false
        || Boolean(event.error)
        || event.injected === false;
      if (!isError) return;
    }
    const dir = storePaths(root).logs;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'hooks.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      'utf8',
    );
  } catch {
    // never let logging break a hook
  }
}

export function logError(root, event, error) {
  try {
    const dir = storePaths(root).logs;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'hook-errors.log'),
      `${new Date().toISOString()} ${event} ${error?.stack || error}\n`,
      'utf8',
    );
  } catch {
    // ignore
  }
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Provenance stamp for a worker envelope: a worker's own `check_result` is a
 * claim, never a harness verification, and an artifact handle it cites has to
 * exist. Missing handles are recorded, not rejected, so the conductor can see
 * which evidence it cannot open.
 */
export function stampWorkerProvenance(root, envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const next = { ...envelope };
  if (next.check_result && typeof next.check_result === 'object') {
    next.check_result = { ...next.check_result, source: 'worker' };
  }
  const artifacts = Array.isArray(next.artifacts) ? next.artifacts : [];
  if (artifacts.length) {
    const index = readArtifactIndex(root);
    const handles = index.artifacts || {};
    const missing = artifacts
      .map((entry) => String(entry?.handle || ''))
      .filter((handle) => isHandle(handle) && !handles[handle])
      .slice(0, 5);
    next.provenance = {
      ...(next.provenance || {}),
      artifacts_checked: artifacts.length,
      artifacts_missing: missing,
    };
  }
  return next;
}

export function writeText(value) {
  process.stdout.write(String(value ?? ''));
}

export function hookJson(event, fields) {
  return { hookSpecificOutput: { hookEventName: event, ...fields } };
}

export function denyTool(reason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// --- Dispatch gates ---------------------------------------------------------

// The conductor must name the plan task it dispatches so dependencies can be
// enforced at dispatch time: "task_id: T2" (or task_id=T2) in the Agent/Task
// prompt or description. Case-insensitive, first match wins.
export const DISPATCH_TASK_ID_RE = /task_id\s*[:=]\s*([A-Za-z0-9._-]{1,64})/i;
export const DISPATCH_WORKTREE_RE = /(?:^|\n)\s*worktree(?:\s+path)?\s*(?:\([^)\r\n]*\))?\s*[:=]\s*([^\r\n]+)/i;

export function normalizeWorktreeRef(value) {
  return String(value || '').trim().replace(/^[`"']+|[`"']+$/g, '').trim();
}

/**
 * The prompt text of a dispatch. Both harnesses spell the field differently
 * (`prompt` vs `description`), so both are read.
 */
export function dispatchText(toolInput = {}) {
  return [toolInput?.prompt, toolInput?.description]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join('\n');
}

/**
 * A code dispatch must name the exact worktree registered for its plan task.
 * A stale or wrong path is a hard denial, not a worker editing a directory
 * that does not exist.
 */
export function dispatchWorktreeReason(root, taskId, text, session = '') {
  const matched = text.match(DISPATCH_WORKTREE_RE);
  if (!matched) {
    return `code tasks must include worktree: <path> in the dispatch prompt (the exact path returned by enhance_worktree create for ${taskId}). Add the line and retry.`;
  }
  const ref = normalizeWorktreeRef(matched[1]);
  const entry = readWorktrees(root, session).worktrees?.[taskId];
  if (!entry?.path) {
    return `no worktree is registered for task ${taskId}; call enhance_worktree create task_id=${taskId} and copy its exact path.`;
  }
  if (canonicalPath(ref) !== canonicalPath(entry.path)) {
    return `worktree path mismatch for task ${taskId}: got ${ref}, expected ${entry.path}. Use the exact path returned by enhance_worktree create.`;
  }
  return '';
}

/**
 * Deterministic project-argument gate. A conductor that passes a `project`
 * resolving outside its own session root silently writes state into the wrong
 * workspace. Extract the project argument for harness MCP calls: direct tool
 * names and the mcp_call/mcp_get gateway.
 */
export function harnessProjectArg(tool, toolInput) {
  if (isHarnessMcp(tool) || tool.startsWith('enhance_')) {
    return typeof toolInput?.project === 'string' ? toolInput.project.trim() : '';
  }
  if (GATEWAY_TOOLS.has(tool)) {
    const target = String(toolInput?.toolName || toolInput?.name || '');
    if (!isHarnessMcp(target)) return '';
    const args = toolInput?.arguments;
    return args && typeof args.project === 'string' ? args.project.trim() : '';
  }
  return '';
}

export function projectGateReason(root, projectArg) {
  if (!projectArg) return '';
  const sessionRoot = canonicalPath(root);
  const project = canonicalPath(projectArg);
  if (project === sessionRoot) return '';
  const rel = path.relative(sessionRoot, project);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '';
  return `project mismatch: ${project} is not this session root ${sessionRoot} or a path inside it. `
    + `Use project: ${sessionRoot}; never copy a workspace path from GOAL/notes.`;
}

/**
 * Dependency gate for conductor dispatch, code profile only. Returns a deny
 * reason, or '' when the dispatch may proceed (including non-code briefs and
 * dispatches that carry no plan task, which are left to the base policy).
 *
 * A session without a brief has not declared its profile yet. A worker that
 * can write would then edit the shared checkout; if the session turns into a
 * code session afterwards, that dirty base blocks worktree creation for good.
 * So a write-capable dispatch waits for the profile to be declared.
 */
export function dispatchGateReason(root, toolInput, session = '', config = null) {
  const brief = readBrief(root, session);
  const text = dispatchText(toolInput);
  if (!brief) {
    if (!writesRepository(config, subagentOf(toolInput))) return '';
    return 'declare the session profile before dispatching a worker that writes: '
      + 'call enhance_brief profile=code (with the ownership globs) first, then enhance_plan, '
      + 'enhance_worktree create task_id=<id>, and dispatch with the returned task_id/worktree prefix. '
      + 'A worker dispatched before the brief edits the shared checkout, which later blocks worktree creation. '
      + 'A non-code profile (general, docs, research, ops) also declares the profile and keeps this dispatch ungated.';
  }
  if (String(brief.profile || '') !== 'code') return '';
  const matched = text.match(DISPATCH_TASK_ID_RE);
  if (!matched) {
    const hints = Object.entries(readWorktrees(root, session).worktrees || {})
      .filter(([, entry]) => entry?.path && String(entry.status || 'active') !== 'landed')
      .slice(0, 3)
      .map(([id, entry]) => `task_id: ${id}\nworktree: ${entry.path}`)
      .join('\n\n');
    return 'code tasks must include task_id: <plan id> and worktree: <exact path> in the dispatch prompt. '
      + (hints
        ? `Use one of these exact prefixes:\n${hints}`
        : 'Call enhance_worktree create first; it returns the exact prompt_prefix to copy.');
  }
  const gate = checkTaskDependencies(root, matched[1], session);
  if (!gate.ok) return `dispatch blocked for task ${matched[1]}: ${gate.blocker}`;
  const worktreeReason = dispatchWorktreeReason(root, matched[1], text, session);
  if (worktreeReason) return worktreeReason;
  const landedEntry = readWorktrees(root, session).worktrees?.[matched[1]];
  if (String(landedEntry?.status || '') === 'landed') {
    return `task ${matched[1]} is already landed; do not dispatch another worker. Remove the worktree with enhance_worktree remove and report the result.`;
  }
  const lastCheck = readLastCheck(root, session);
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

/**
 * A verification worker is only worth dispatching when the deterministic check
 * has not run since the last worker finished.
 */
export function verificationGateReason(root, toolInput, session = '') {
  const text = dispatchText(toolInput);
  if (!/(verify|verification|parity|recheck|复核|校对|验收)/i.test(text)) return '';
  const completed = (readJobs(root, session).jobs || []).filter((job) => job.status === 'ok');
  if (completed.length === 0) return '';
  const at = (job) => Date.parse(job.updated_at || job.finished_at || job.created_at || 0) || 0;
  const latest = completed.reduce((a, b) => (at(b) > at(a) ? b : a));
  const jobAt = at(latest);
  const last = readLastCheck(root, session);
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
