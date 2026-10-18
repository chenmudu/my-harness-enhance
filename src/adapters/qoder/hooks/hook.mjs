#!/usr/bin/env node
import path from 'node:path';
import { ensureState, loadConfig } from '../../../core/config.mjs';
import { detectAvailableAgents, resolveCapabilities } from '../../../core/capabilities.mjs';
import {
  isExcludedProject,
  readGlobalConfig,
  writeActiveProject,
} from '../../../core/global.mjs';
import { detectConfigDir } from '../install.mjs';
import { conductorInjection, workerInjection, writeCapsule } from '../../../core/capsule.mjs';
import {
  compactEnvelope,
  extractText,
  invalidResultEnvelope,
  parseEnvelope,
} from '../../../core/contract.mjs';
import { byteLength } from '../../../core/metrics.mjs';
import { putArtifact } from '../../../core/artifacts.mjs';
import {
  appendDecision,
  appendJournal,
  findJobByAgent,
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
} from '../../../core/store.mjs';
import { checkTaskDependencies, diffWorktree } from '../../../core/worktree.mjs';
import { canonicalPath } from '../../../core/state-root.mjs';
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
  toolNameOf,
  workerPolicy,
  workerToolDecision,
  writeJson,
  writeText,
} from './lib.mjs';

const EVENT = process.argv[2] || 'Unknown';

const HARNESS_MCP_PREFIXES = ['mcp__harness-enhance__', 'mcp__harness_enhance__'];

/**
 * Deterministic project-argument gate. A conductor that passes a `project`
 * resolving outside its own session root silently writes state into the
 * wrong workspace (seen in a real Qoder session: the round-1 path copied
 * from GOAL/notes). Extract the project argument for harness MCP calls:
 * direct tool names and the mcp_call/mcp_get gateway.
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

/**
 * A code dispatch must name the exact worktree registered for its plan task.
 * A stale/wrong hash is a hard denial, not a worker editing a nonexistent
 * directory.
 */
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

/**
 * Dependency gate for conductor dispatch, code profile only. Returns a deny
 * reason, or '' when the dispatch may proceed (including non-code briefs and
 * dispatches that carry no plan task, which are left to the base policy).
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

function landReminder(root, envelope, agentType = '') {
  if (agentType === 'Explore') return '';
  const brief = readBrief(root);
  if (!brief || String(brief.profile || '') !== 'code') return '';
  const taskId = String(envelope?.task_id || '').trim();
  const worktrees = readWorktrees(root).worktrees || {};
  const ids = taskId && worktrees[taskId] ? [taskId] : Object.keys(worktrees);
  for (const id of ids) {
    const entry = worktrees[id];
    if (!entry?.path || String(entry.status || 'active') === 'landed') continue;
    const diff = diffWorktree(root, id, { includePatch: false });
    if (!diff.ok || diff.changed_count <= 0) continue;
    return `task ${id}: worktree ${entry.path} has ${diff.changed_count} changed file(s) that are not landed. `
      + `Call enhance_worktree land task_id=${id} directly (it runs the brief checks, marks the task completed, and resets the worktree); do not dispatch a verification worker.`;
  }
  return '';
}

function verificationGateReason(root, toolInput) {
  const text = [toolInput?.prompt, toolInput?.description]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join('\n');
  if (!/(verify|verification|parity|recheck|复核|校对|验收)/i.test(text)) return '';
  const completed = (readJobs(root).jobs || []).filter((job) => job.status === 'ok');
  if (completed.length === 0) return '';
  const latest = completed.reduce((a, b) => {
    const at = (job) => Date.parse(job.updated_at || job.finished_at || job.created_at || 0) || 0;
    return at(b) > at(a) ? b : a;
  });
  const jobAt = Date.parse(latest.updated_at || latest.finished_at || latest.created_at || 0) || 0;
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
    // A worker's check_result is advisory. Only enhance_check (docs/general)
    // or a successful land (code) may mark a task completed; accepting the
    // worker's self-report here caused false "completed" tasks while the
    // authoritative check was failing.
    status = 'in_progress';
  } else if (envelope.status === 'partial') {
    status = 'in_progress';
  }
  if (!status) return null;
  return updatePlanTask(root, taskId, { status });
}

async function onSessionStart(payload, root, config) {
  const agentType = agentTypeOf(payload);
  // Subagent sessions must never overwrite the main session role marker.
  if (agentType) return;
  if (!config.enabled || !config.conductor?.auto) return;

  const source = String(payload.source || '');
  writeSession(root, {
    role: 'conductor',
    model: modelOf(payload),
    source,
    fresh: ['startup', 'new', 'clear'].includes(source),
  });
  const sessionId = String(payload.session_id || payload.sessionId || '').trim();
  if (sessionId && ['startup', 'new', 'clear'].includes(source)) {
    markSession(root, sessionId, {
      role: 'conductor',
      model: modelOf(payload),
      source,
    });
  }
  log(root, { event: EVENT, role: 'conductor', model: modelOf(payload) }, config);
  writeCapsule(root);
  writeText(conductorInjection(root, { contractMode: 'injected' }));
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
  writeText(conductorInjection(root, { contractMode: 'injected' }));
  log(root, { event: EVENT, role: 'conductor', prompt_chars: prompt.length }, config);
}

async function onPreToolUse(payload, root, config) {
  if (!config.enabled) return;

  const tool = toolNameOf(payload);
  if (!tool) return;
  const toolInput = payload.tool_input || payload.toolInput || {};
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
    const verificationReason = verificationGateReason(root, toolInput);
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
  }
  log(root, { event: EVENT, role: 'conductor', tool, allow }, config);
  if (!allow) denyTool(conductorDenyReason(tool, config));
}

async function onSubagentStart(payload, root, config) {
  if (!config.enabled) return;

  const agentType = agentTypeOf(payload);
  const policy = workerPolicy(config, agentType);
  if (!policy) return;
  if (!sessionIsConductor(root, config, payload)) return;

  const agentId = String(payload.agent_id || payload.agentId || '');
  const jobId = agentId || newJobId('job');
  const role = roleFor(config, agentType);
  upsertJob(root, jobId, {
    agent_id: agentId,
    type: agentType,
    role,
    status: 'running',
    depth: 1,
  });

  const injection = workerInjection(root, {
    agentType,
    role,
    jobId,
  });
  writeJson(hookJson('SubagentStart', { additionalContext: injection }));
  log(root, {
    event: EVENT,
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    injected: true,
  }, config);
}

async function onSubagentStop(payload, root, config) {
  if (!config.enabled) return;

  const agentType = agentTypeOf(payload);
  if (!workerPolicy(config, agentType)) return;
  if (!sessionIsConductor(root, config, payload)) return;

  const agentId = String(payload.agent_id || payload.agentId || '');
  const rawValue = payload.result
    ?? payload.final_message
    ?? payload.finalMessage
    ?? payload.message
    ?? payload.response
    ?? payload;
  const raw = extractText(rawValue);
  const parsed = parseEnvelope(raw, config.envelope);
  const existing = findJobByAgent(root, agentId);
  const jobId = existing?.id || agentId || newJobId('job');

  const artifact = putArtifact(root, {
    content: raw || '(empty worker result)',
    kind: 'worker-result',
    source: `${agentType}:${agentId}`,
    summary: parsed.ok
      ? artifactSummary(parsed.value.summary, 'worker result')
      : artifactSummary(`invalid worker result: ${parsed.errors.join('; ')}`),
  });
  const invalid = parsed.ok ? null : invalidResultEnvelope(parsed.errors.join('; '));

  upsertJob(root, jobId, {
    agent_id: agentId,
    type: agentType,
    role: existing?.role || roleFor(config, agentType),
    depth: existing?.depth || 1,
    task_id: parsed.ok ? parsed.value.task_id : '',
    status: parsed.ok ? parsed.value.status : 'invalid_result',
    result_handle: artifact.handle,
    envelope: parsed.ok ? parsed.value : invalid,
    error: parsed.ok ? '' : parsed.errors.join('; ').slice(0, 500),
    retryable: !parsed.ok,
    next: parsed.ok ? '' : invalid.next,
  });
  if (parsed.ok) syncPlanFromEnvelope(root, parsed.value);

  log(root, {
    event: EVENT,
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    valid: parsed.ok,
    status: parsed.ok ? parsed.value.status : 'invalid_result',
    result_handle: artifact.handle,
  }, config);
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

    if (parsed.ok) {
      const input = payload.tool_input || payload.toolInput || {};
      const dispatchedAgent = String(
        input.subagent_type
        || input.agent
        || input.name
        || '',
      );
      const reminder = landReminder(root, parsed.value, dispatchedAgent);
      if (reminder) {
        parsed.value.next = [parsed.value.next, reminder].filter(Boolean).join(' ');
        parsed.value.warnings = [...(parsed.value.warnings || []), reminder];
      }
      const compact = compactEnvelope(parsed.value, config.envelope.maxTotalChars);
      writeJson(hookJson('PostToolUse', { updatedToolOutput: compact }));
      syncPlanFromEnvelope(root, parsed.value);
      log(root, {
        event: EVENT,
        role: 'conductor',
        tool,
        valid: true,
        status: parsed.value.status,
        artifact: artifact.handle,
      }, config);
    } else {
      const invalid = invalidResultEnvelope(parsed.errors.join('; '), raw);
      invalid.data = {
        ...(invalid.data || {}),
        artifact_handle: artifact.handle,
        artifact_hint: 'Raw result is externalized; read it only if the bounded excerpt is insufficient.',
      };
      writeJson(hookJson('PostToolUse', {
        updatedToolOutput: JSON.stringify(invalid),
      }));
      log(root, {
        event: EVENT,
        role: 'conductor',
        tool,
        valid: false,
        artifact: artifact.handle,
        error: parsed.errors.join('; ').slice(0, 300),
      }, config);
    }
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
      log(root, {
        event: EVENT,
        role: 'worker',
        agent_type: agentType,
        tool,
        captured: true,
        bytes,
        artifact: artifact.handle,
        mode: config.context.workerOutputMode,
      }, config);
      if (config.context.workerOutputMode === 'truncate') {
        writeJson(hookJson('PostToolUse', {
          updatedToolOutput:
            `[artifact ${artifact.handle}] ${tool} output was ${bytes} bytes and was externalized. ` +
            `Use the enhance_artifact MCP tool to read it if needed.\n` +
            `First 800 chars:\n${text.slice(0, 800)}`,
        }));
      }
    }
  }
}

async function onPreCompact(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;
  const capsule = writeCapsule(root);
  log(root, { event: EVENT, trigger: payload.trigger || '', capsule_chars: capsule.length }, config);
}

async function onStop(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;
  const capsule = writeCapsule(root);
  if (payload.stop_hook_active) {
    log(root, { event: EVENT, role: 'conductor', stop_hook_active: true, capsule_chars: capsule.length }, config);
    return;
  }
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
      + 'Call enhance_worktree land for each (it runs the checks and marks the task completed), '
      + 'then remove the landed worktree before reporting completion.';
    writeJson({ decision: 'deny', reason });
    log(root, { event: EVENT, role: 'conductor', blocked: true, unlanded }, config);
    return;
  }
  log(root, { event: EVENT, role: 'conductor', capsule_chars: capsule.length }, config);
}

function autoRegister(payload) {
  const global = readGlobalConfig();
  if (!global.autoRegister) return null;
  const cwd = payload.cwd || process.env.MY_HARNESS_ENHANCE_PROJECT || process.cwd();
  if (isExcludedProject(cwd, global)) return null;
  try {
    const configDir = global.configDir || detectConfigDir();
    const detection = detectAvailableAgents({ configDir });
    const capabilities = resolveCapabilities({ availableAgents: detection.available });
    const { root } = ensureState(cwd, {
      harness: global.harness || 'qoder',
      qoder: { configDir },
      logging: global.logging || 'errors',
      capabilities,
    });
    // Re-resolve so the returned project carries the registry state dir.
    return projectContext({ cwd: root });
  } catch (error) {
    try {
      logError(cwd, EVENT, error);
    } catch {
      // ignore
    }
    return null;
  }
}

async function main() {
  const payload = await readStdin();
  let project = projectContext(payload);
  // Global mode registers only a NEW session at SessionStart. Never retrofit
  // an already-running session mid-task.
  const newSession = EVENT === 'SessionStart'
    && ['startup', 'new', 'clear'].includes(String(payload.source || ''));
  if (!project && newSession) project = autoRegister(payload);
  if (!project) {
    process.exitCode = 0;
    return;
  }
  writeActiveProject(project.projectRoot, payload.session_id || payload.sessionId || '');
  const root = project.projectRoot;
  const { config } = loadConfig(root);
  if (!config.enabled) {
    process.exitCode = 0;
    return;
  }

  try {
    switch (EVENT) {
      case 'SessionStart':
        await onSessionStart(payload, root, config);
        break;
      case 'UserPromptSubmit':
        await onUserPromptSubmit(payload, root, config);
        break;
      case 'PreToolUse':
        await onPreToolUse(payload, root, config);
        break;
      case 'SubagentStart':
        await onSubagentStart(payload, root, config);
        break;
      case 'SubagentStop':
        await onSubagentStop(payload, root, config);
        break;
      case 'PostToolUse':
        await onPostToolUse(payload, root, config);
        break;
      case 'PreCompact':
        await onPreCompact(payload, root, config);
        break;
      case 'Stop':
        await onStop(payload, root, config);
        break;
      default:
        log(root, { event: EVENT, ignored: true }, config);
    }
  } catch (error) {
    try {
      logError(root, EVENT, error);
    } catch {
      // ignore
    }
  }
  process.exitCode = 0;
}

main();
