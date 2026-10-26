#!/usr/bin/env node
import { ensureState, loadConfig } from '../../../core/config.mjs';
import { detectAvailableAgents, resolveCapabilities } from '../../../core/capabilities.mjs';
import {
  isExcludedProject,
  readGlobalConfig,
} from '../../../core/global.mjs';
import { detectConfigDir, syncCapabilities } from '../install.mjs';
import { conductorInjection, conductorTurnInjection, workerInjection, writeCapsule } from '../../../core/capsule.mjs';
import { nowReminder } from '../../../core/packet.mjs';
import { failureVerdict } from '../../../core/errors.mjs';
import {
  compactEnvelope,
  extractText,
  invalidResultEnvelope,
  parseEnvelope,
} from '../../../core/contract.mjs';
import { byteLength, estimateTokens } from '../../../core/metrics.mjs';
import { putArtifact } from '../../../core/artifacts.mjs';
import {
  appendDecision,
  appendJournal,
  appendMetric,
  ensureSession,
  findJobByAgent,
  markSession,
  newJobId,
  readBrief,
  readGoal,
  readJobs,
  readSession,
  readWorktrees,
  sessionKey,
  updatePlanTask,
  upsertJob,
  writeGoal,
  writeSession,
} from '../../../core/store.mjs';
import { diffWorktree } from '../../../core/worktree.mjs';
import { canonicalPath } from '../../../core/state-root.mjs';
import {
  agentTypeOf,
  conductorDenyReason,
  denyTool,
  dispatchGateReason,
  harnessProjectArg,
  hookJson,
  isAllowedConductorTool,
  isConductorSession,
  log,
  logError,
  modelOf,
  projectContext,
  projectGateReason,
  readStdin,
  roleFor,
  sessionIsConductor,
  stampWorkerProvenance,
  toolNameOf,
  verificationGateReason,
  workerPolicy,
  workerToolDecision,
  writeJson,
  writeText,
} from '../../../core/hook-policy.mjs';

const EVENT = process.argv[2] || 'Unknown';
const HARNESS_MCP_TOOL = /^mcp__harness-enhance__enhance_/;

function sessionIdOf(payload = {}) {
  return String(payload.session_id || payload.sessionId || '').trim();
}

function sessionOf(payload = {}) {
  const id = sessionIdOf(payload);
  return id ? sessionKey(id) : '';
}

function recordMetric(root, event, session = '') {
  try {
    appendMetric(root, event, session);
  } catch {
    // Metrics must never break a hook.
  }
}

function landReminder(root, envelope, agentType = '', session = '') {
  if (agentType === 'Explore') return '';
  const brief = readBrief(root, session);
  if (!brief || String(brief.profile || '') !== 'code') return '';
  const taskId = String(envelope?.task_id || '').trim();
  const worktrees = readWorktrees(root, session).worktrees || {};
  const ids = taskId && worktrees[taskId] ? [taskId] : Object.keys(worktrees);
  for (const id of ids) {
    const entry = worktrees[id];
    if (!entry?.path || String(entry.status || 'active') === 'landed') continue;
    const diff = diffWorktree(root, id, { includePatch: false, session });
    if (!diff.ok || diff.changed_count <= 0) continue;
    return `task ${id}: worktree ${entry.path} has ${diff.changed_count} changed file(s) that are not landed. `
      + `Call enhance_worktree land task_id=${id} directly (it runs the brief checks, marks the task completed, and resets the worktree); do not dispatch a verification worker.`;
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

/** Classify a failed attempt and decide whether another dispatch is worth it. */
function verdictFor(root, { agentType, taskId, error, session }) {
  const attempts = (readJobs(root, session).jobs || []).filter((job) => (
    (taskId && job.task_id === taskId) || (!taskId && job.type === agentType)
  ) && ['invalid_result', 'failed', 'blocked'].includes(String(job.status))).length;
  return failureVerdict({ error, attempts });
}

function syncPlanFromEnvelope(root, envelope, session = '') {
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
  return updatePlanTask(root, taskId, { status }, session);
}

async function onSessionStart(payload, root, config) {
  const agentType = agentTypeOf(payload);
  // Subagent sessions must never overwrite the main session role marker.
  if (agentType) return;
  if (!config.enabled || !config.conductor?.auto) return;

  const source = String(payload.source || '');
  const sessionId = sessionIdOf(payload);
  const session = sessionOf(payload);
  if (session) ensureSession(root, session);
  writeSession(root, {
    role: 'conductor',
    model: modelOf(payload),
    source,
    fresh: ['startup', 'new', 'clear'].includes(source),
  }, session);
  if (sessionId) {
    markSession(root, sessionId, {
      role: 'conductor',
      model: modelOf(payload),
      source,
      host_pid: process.ppid,
      cwd: canonicalPath(String(payload.cwd || process.cwd())),
    });
  }
  log(root, { event: EVENT, role: 'conductor', model: modelOf(payload) }, config);
  const capsule = writeCapsule(root, { session });
  recordMetric(root, {
    event: 'session_start',
    role: 'conductor',
    model: modelOf(payload),
    source,
    session_id: sessionId || undefined,
    capsule_chars: capsule.length,
    capsule_tokens: estimateTokens(capsule),
  }, session);
  writeText(conductorInjection(root, { contractMode: 'injected', session }));
}

async function onUserPromptSubmit(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;

  const prompt = String(payload.prompt || '').trim();
  const session = sessionOf(payload);
  if (prompt) {
    const goal = readGoal(root, session);
    const state = readSession(root, session);
    const continuation = /^(继续|接着|continue|go on|retry|再试|继续吧)/i.test(prompt)
      && prompt.length < 60;
    if (!goal.text) {
      writeGoal(root, { text: prompt }, session);
      appendDecision(root, 'goal set from first user prompt', '', session);
    } else if (state.fresh && !continuation) {
      // A new session with a substantive new task replaces the old goal.
      // A short "continue" keeps the goal and is journaled instead.
      writeGoal(root, { text: prompt, replace: true }, session);
      appendDecision(root, 'goal replaced on new session', '', session);
    } else {
      appendJournal(root, prompt, session);
    }
    writeSession(root, { fresh: false }, session);
  }
  const capsule = writeCapsule(root, { session });
  const injected = conductorTurnInjection(root, { session });
  recordMetric(root, {
    event: 'prompt_submitted',
    role: 'conductor',
    prompt_chars: prompt.length,
    goal_chars: String(readGoal(root, session).text || '').length,
    capsule_tokens: estimateTokens(capsule),
    injected_chars: injected.text.length,
    injected_tokens: injected.tokens,
    packet_tokens: injected.packetTokens,
    relevant_tokens: injected.relevantTokens,
    packet_hash: injected.hash,
    changed_sections: injected.changed.join(','),
  }, session);
  writeText(injected.text);
  log(root, { event: EVENT, role: 'conductor', prompt_chars: prompt.length }, config);
}

async function onPreToolUse(payload, root, config) {
  if (!config.enabled) return;

  const tool = toolNameOf(payload);
  if (!tool) return;
  const toolInput = payload.tool_input || payload.toolInput || {};
  const agentType = agentTypeOf(payload);
  const session = sessionOf(payload);

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
    if (!decision.allow) {
      recordMetric(root, {
        event: 'worker_tool_denied',
        role: 'worker',
        agent_type: agentType,
        tool,
        gate: 'worker',
      }, session);
      denyTool(decision.reason);
    }
    return;
  }

  if (!isConductorSession(root, config, payload)) return;
  const projectReason = projectGateReason(root, harnessProjectArg(tool, toolInput));
  if (projectReason) {
    log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'project' }, config);
    recordMetric(root, { event: 'tool_denied', role: 'conductor', tool, gate: 'project' }, session);
    denyTool(projectReason);
    return;
  }
  const allow = isAllowedConductorTool(tool, toolInput, config);
  if (allow && (tool === 'Agent' || tool === 'Task')) {
    const verificationReason = verificationGateReason(root, toolInput, session);
    if (verificationReason) {
      log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'verification' }, config);
      recordMetric(root, { event: 'tool_denied', role: 'conductor', tool, gate: 'verification' }, session);
      denyTool(verificationReason);
      return;
    }
    const gateReason = dispatchGateReason(root, toolInput, session, config);
    if (gateReason) {
      log(root, { event: EVENT, role: 'conductor', tool, allow: false, gate: 'dispatch' }, config);
      recordMetric(root, { event: 'tool_denied', role: 'conductor', tool, gate: 'dispatch' }, session);
      denyTool(gateReason);
      return;
    }
  }
  log(root, { event: EVENT, role: 'conductor', tool, allow }, config);
  if (tool === 'Agent' || tool === 'Task') {
    recordMetric(root, { event: 'dispatch', role: 'conductor', tool, allow }, session);
  } else if (!allow) {
    recordMetric(root, { event: 'tool_denied', role: 'conductor', tool, gate: 'allowlist' }, session);
  }
  if (!allow) denyTool(conductorDenyReason(tool, config));
}

async function onSubagentStart(payload, root, config) {
  if (!config.enabled) return;

  const agentType = agentTypeOf(payload);
  const policy = workerPolicy(config, agentType);
  if (!policy) return;
  if (!sessionIsConductor(root, config, payload)) return;

  const session = sessionOf(payload);
  const agentId = String(payload.agent_id || payload.agentId || '');
  const jobId = agentId || newJobId('job');
  const role = roleFor(config, agentType);
  upsertJob(root, jobId, {
    agent_id: agentId,
    type: agentType,
    role,
    status: 'running',
    depth: 1,
  }, session);

  const injection = workerInjection(root, {
    agentType,
    role,
    jobId,
    session,
  });
  writeJson(hookJson('SubagentStart', { additionalContext: injection }));
  log(root, {
    event: EVENT,
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    injected: true,
  }, config);
  recordMetric(root, {
    event: 'job_start',
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    model: modelOf(payload),
  }, session);
}

async function onSubagentStop(payload, root, config) {
  if (!config.enabled) return;

  const agentType = agentTypeOf(payload);
  if (!workerPolicy(config, agentType)) return;
  if (!sessionIsConductor(root, config, payload)) return;

  const session = sessionOf(payload);
  const agentId = String(payload.agent_id || payload.agentId || '');
  const rawValue = payload.result
    ?? payload.final_message
    ?? payload.finalMessage
    ?? payload.message
    ?? payload.response
    ?? payload;
  const raw = extractText(rawValue);
  const parsed = parseEnvelope(raw, config.envelope);
  const existing = findJobByAgent(root, agentId, session);
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
  const envelope = parsed.ok
    ? stampWorkerProvenance(root, parsed.value)
    : invalid;

  upsertJob(root, jobId, {
    agent_id: agentId,
    type: agentType,
    role: existing?.role || roleFor(config, agentType),
    depth: existing?.depth || 1,
    task_id: parsed.ok ? parsed.value.task_id : '',
    status: parsed.ok ? parsed.value.status : 'invalid_result',
    result_handle: artifact.handle,
    envelope,
    error: parsed.ok ? '' : parsed.errors.join('; ').slice(0, 500),
    ...(parsed.ok ? { retryable: false, error_class: '', dead_letter: false } : verdictFor(root, {
      agentType,
      taskId: parsed.value?.task_id || existing?.task_id || '',
      error: parsed.errors.join('; '),
      session,
    })),
    next: parsed.ok ? '' : invalid.next,
  }, session);
  if (parsed.ok) syncPlanFromEnvelope(root, parsed.value, session);

  log(root, {
    event: EVENT,
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    valid: parsed.ok,
    status: parsed.ok ? parsed.value.status : 'invalid_result',
    result_handle: artifact.handle,
  }, config);
  recordMetric(root, {
    event: 'job_stop',
    role: 'worker',
    agent_type: agentType,
    job_id: jobId,
    valid: parsed.ok,
    status: parsed.ok ? parsed.value.status : 'invalid_result',
    retryable: !parsed.ok,
    result_chars: raw.length,
    result_tokens: estimateTokens(raw),
  }, session);
}

async function onPostToolUse(payload, root, config) {
  if (!config.enabled) return;

  const tool = toolNameOf(payload);
  const session = sessionOf(payload);
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
      const reminder = landReminder(root, parsed.value, dispatchedAgent, session);
      if (reminder) {
        parsed.value.next = [parsed.value.next, reminder].filter(Boolean).join(' ');
        parsed.value.warnings = [...(parsed.value.warnings || []), reminder];
      }
      const compact = compactEnvelope(parsed.value, config.envelope.maxTotalChars);
      syncPlanFromEnvelope(root, parsed.value, session);
      // The frontier usually moved because this worker finished. Say where the
      // conductor is now instead of letting it re-derive the next step.
      const now = nowReminder(root, { session });
      writeJson(hookJson('PostToolUse', {
        updatedToolOutput: now ? `${compact}\n\n${now}` : compact,
      }));
      if (now) {
        recordMetric(root, {
          event: 'now_after_tool',
          role: 'conductor',
          tool,
          chars: now.length,
        }, session);
      }
      log(root, {
        event: EVENT,
        role: 'conductor',
        tool,
        valid: true,
        status: parsed.value.status,
        artifact: artifact.handle,
      }, config);
      recordMetric(root, {
        event: 'agent_result',
        role: 'conductor',
        tool,
        valid: true,
        status: parsed.value.status,
        result_chars: raw.length,
        result_tokens: estimateTokens(raw),
        compact_chars: compact.length,
        compact_tokens: estimateTokens(compact),
      }, session);
    } else {
      const invalid = invalidResultEnvelope(parsed.errors.join('; '), raw);
      invalid.data = {
        ...(invalid.data || {}),
        artifact_handle: artifact.handle,
        artifact_hint: 'Raw result is externalized; read it only if the bounded excerpt is insufficient.',
      };
      const compactInvalid = JSON.stringify(invalid);
      writeJson(hookJson('PostToolUse', {
        updatedToolOutput: compactInvalid,
      }));
      log(root, {
        event: EVENT,
        role: 'conductor',
        tool,
        valid: false,
        artifact: artifact.handle,
        error: parsed.errors.join('; ').slice(0, 300),
      }, config);
      recordMetric(root, {
        event: 'agent_result',
        role: 'conductor',
        tool,
        valid: false,
        status: 'invalid_result',
        result_chars: raw.length,
        result_tokens: estimateTokens(raw),
        compact_chars: compactInvalid.length,
        compact_tokens: estimateTokens(compactInvalid),
      }, session);
    }
    return;
  }

  // Our own MCP results are ours to shape: append the frontier reminder when it
  // moved, so the conductor sees the next action on the same message that
  // carries the tool result.
  if (conductor && response != null && HARNESS_MCP_TOOL.test(tool)) {
    const now = nowReminder(root, { session });
    const text = now ? extractText(response) : '';
    if (now && text) {
      writeJson(hookJson('PostToolUse', { updatedToolOutput: `${text}\n\n${now}` }));
      recordMetric(root, {
        event: 'now_after_tool',
        role: 'conductor',
        tool,
        chars: now.length,
      }, session);
      log(root, { event: EVENT, role: 'conductor', tool, now_chars: now.length }, config);
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
      recordMetric(root, {
        event: 'tool_output_captured',
        role: 'worker',
        agent_type: agentType,
        tool,
        bytes,
        mode: config.context.workerOutputMode,
      }, session);
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
  const session = sessionOf(payload);
  const capsule = writeCapsule(root, { session });
  log(root, { event: EVENT, trigger: payload.trigger || '', capsule_chars: capsule.length }, config);
  recordMetric(root, {
    event: 'compaction',
    role: 'conductor',
    trigger: String(payload.trigger || ''),
    capsule_chars: capsule.length,
    capsule_tokens: estimateTokens(capsule),
  }, session);
}

async function onStop(payload, root, config) {
  if (!config.enabled) return;
  if (agentTypeOf(payload)) return;
  if (!isConductorSession(root, config, payload)) return;
  const session = sessionOf(payload);
  const capsule = writeCapsule(root, { session });
  if (payload.stop_hook_active) {
    log(root, { event: EVENT, role: 'conductor', stop_hook_active: true, capsule_chars: capsule.length }, config);
    recordMetric(root, {
      event: 'session_stop',
      role: 'conductor',
      stop_hook_active: true,
      capsule_tokens: estimateTokens(capsule),
    }, session);
    return;
  }
  const brief = readBrief(root, session);
  if (String(brief?.profile || '') !== 'code') {
    log(root, { event: EVENT, role: 'conductor', capsule_chars: capsule.length }, config);
    recordMetric(root, {
      event: 'session_stop',
      role: 'conductor',
      capsule_tokens: estimateTokens(capsule),
    }, session);
    return;
  }
  const unlanded = [];
  for (const [id, entry] of Object.entries(readWorktrees(root, session).worktrees || {})) {
    if (!entry?.path || String(entry.status || 'active') === 'landed') continue;
    const diff = diffWorktree(root, id, { includePatch: false, session });
    if (diff.ok && diff.changed_count > 0) unlanded.push(id);
  }
  if (unlanded.length > 0) {
    const reason = `code worktree(s) not landed: ${unlanded.join(', ')}. `
      + 'Call enhance_worktree land for each (it runs the checks and marks the task completed), '
      + 'then remove the landed worktree before reporting completion.';
    writeJson({ decision: 'deny', reason });
    log(root, { event: EVENT, role: 'conductor', blocked: true, unlanded }, config);
    recordMetric(root, {
      event: 'session_stop',
      role: 'conductor',
      blocked: true,
      unlanded: unlanded.length,
      capsule_tokens: estimateTokens(capsule),
    }, session);
    return;
  }
  log(root, { event: EVENT, role: 'conductor', capsule_chars: capsule.length }, config);
  recordMetric(root, {
    event: 'session_stop',
    role: 'conductor',
    blocked: false,
    capsule_tokens: estimateTokens(capsule),
  }, session);
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
  const root = project.projectRoot;
  let { config } = loadConfig(root);
  if (!config.enabled) {
    process.exitCode = 0;
    return;
  }
  if (EVENT === 'SessionStart' && !(config.capabilities?.allowedSubagents || []).length) {
    try {
      syncCapabilities({
        root,
        configDir: config.qoder?.configDir || null,
        allowFallbacks: false,
      });
      config = loadConfig(root).config;
    } catch {
      // never let capability repair break the hook
    }
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
    // A failed injection used to look exactly like a disabled layer: exit 0 and
    // no output. Say it out loud on the events that are supposed to inject.
    if (EVENT === 'SessionStart' || EVENT === 'UserPromptSubmit') {
      process.stdout.write(
        `[MY-HARNESS-ENHANCE] ${EVENT} injection failed: ${String(error?.message || error).slice(0, 200)}\n`,
      );
    }
  }
  process.exitCode = 0;
}

main();
