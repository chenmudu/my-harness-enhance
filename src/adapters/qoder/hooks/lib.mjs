import fs from 'node:fs';
import path from 'node:path';
import { resolveProject } from '../../../core/state-root.mjs';
import { readSessions, storePaths } from '../../../core/store.mjs';
import { roleHintForAgent } from '../../../core/capabilities.mjs';

const NATIVE_TASK_TOOLS = new Set(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

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
    payload.cwd ||
    process.env.MY_HARNESS_ENHANCE_PROJECT ||
    process.cwd(),
  );
}

export function agentTypeOf(payload = {}) {
  return String(payload.agent_type || payload.agentType || '').trim();
}

export function toolNameOf(payload = {}) {
  return String(payload.tool_name || payload.toolName || '').trim();
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

export function isAllowedConductorTool(tool, toolInput, config) {
  if (!tool) return false;
  const MCP_PREFIXES = [
    'mcp__harness-enhance__',
    'mcp__harness_enhance__',
  ];
  if (MCP_PREFIXES.some((prefix) => tool.startsWith(prefix))) return true;
  if (tool.startsWith('enhance_')) return true;
  // Native task tools are a second, session-local task graph. The durable
  // enhance_plan is the only task source of truth.
  if (NATIVE_TASK_TOOLS.has(tool)) return false;
  if (tool === 'mcp_get' || tool === 'mcp_call') {
    const target = String(toolInput?.toolName || toolInput?.name || '');
    return MCP_PREFIXES.some((prefix) => target.startsWith(prefix));
  }

  if (tool === 'Agent' || tool === 'Task') {
    const subagent = String(
      toolInput?.subagent_type || toolInput?.agent || toolInput?.name || '',
    ).trim();
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
      reason: `${agentType} is a leaf worker and may not spawn agents. ` +
        'Return status=needs_split so the conductor can split the task.',
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
    reason: `${agentType} (${policy.kind || 'worker'}) may not use ${tool}. ` +
      `Allowed: ${allow === '*' ? 'all' : (allow || []).join(', ') || '(none)'}.`,
  };
}

export function conductorDenyReason(tool, config) {
  if (NATIVE_TASK_TOOLS.has(tool)) {
    return 'Native task tools are disabled for the conductor. Use enhance_plan as the ' +
      'single durable task graph; worker jobs are tracked through enhance_job.';
  }
  if (tool === 'Agent' || tool === 'Task') {
    const allowed = config.capabilities?.allowedSubagents || [];
    if (allowed.length === 0) {
      return 'No worker capabilities are resolved for this project. Run `mhe refresh` ' +
        '(or reinstall) so the available subagents can be detected.';
    }
    return `Conductor may only delegate to: ${allowed.join(', ')}. ` +
      'Use a registered worker role from the WORKERS mapping.';
  }
  return 'Conductor must not execute repository work. Delegate to a native worker via Agent, or use the enhance_* state tools. ' +
    'Do not read files, run commands, fetch the web, or call non-enhance MCP/skills directly.';
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
