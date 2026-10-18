import fs from 'node:fs';
import path from 'node:path';

/**
 * Hardcoded capability policy. No LLM scoring: official agents first, then
 * already-installed user agents, then our mhe-* fallback. The fallback is only
 * installed when none of the earlier candidates exist.
 */
export const ROLE_POLICY = Object.freeze({
  investigate: {
    policy: 'readonly',
    output: 'findings',
    candidates: ['Explore', 'general-purpose', 'mhe-investigator'],
  },
  plan: {
    policy: 'readonly',
    output: 'plan',
    candidates: ['Explore', 'general-purpose', 'mhe-planner'],
  },
  execute: {
    policy: 'leaf',
    output: 'result',
    // Official general-purpose is the executor. env-runner is the old
    // user-custom Windows shim and is intentionally not selected anymore.
    candidates: ['general-purpose', 'mhe-executor'],
  },
  verify_read: {
    policy: 'readonly',
    output: 'checks',
    candidates: ['Explore', 'general-purpose', 'mhe-verifier'],
  },
  verify_run: {
    policy: 'leaf',
    output: 'checks',
    candidates: ['general-purpose', 'mhe-verifier'],
  },
  write: {
    policy: 'leaf',
    output: 'draft',
    candidates: ['general-purpose', 'mhe-writer'],
  },
  reason: {
    policy: 'notools',
    output: 'analysis',
    // No official no-tools agent exists. Use the unified mhe-reasoner for this
    // single capability gap; the old user `reasoner` is not selected anymore.
    candidates: ['mhe-reasoner'],
  },
  lead: {
    policy: 'lead',
    output: 'result',
    candidates: ['general-purpose', 'mhe-lead'],
  },
});

export const AGENT_POLICY = Object.freeze({
  Explore: {
    kind: 'readonly',
    // Explore is the harness's read-only search agent. It ships Bash as one of
    // its native tools; deny only mutation/delegation tools, not Bash.
    allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS', 'Bash'],
    deny: ['Write', 'Edit', 'Agent', 'Task'],
  },
  'general-purpose': {
    kind: 'lead',
    allow: '*',
    // The main session is the only router. Even a general-purpose worker must
    // not spawn nested agents; it returns needs_split instead.
    deny: ['Agent', 'Task'],
  },
  'env-runner': {
    kind: 'leaf',
    allow: '*',
    deny: ['Agent', 'Task'],
  },
  reasoner: {
    kind: 'notools',
    allow: [],
    deny: '*',
  },
  'mhe-investigator': {
    kind: 'readonly',
    allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LS'],
    deny: ['Write', 'Edit', 'Bash', 'Agent', 'Task'],
  },
  'mhe-planner': {
    kind: 'readonly',
    allow: ['Read', 'Glob', 'Grep'],
    deny: ['Write', 'Edit', 'Bash', 'Agent', 'Task', 'WebSearch', 'WebFetch'],
  },
  'mhe-verifier': {
    kind: 'verify',
    allow: ['Read', 'Glob', 'Grep', 'Bash'],
    deny: ['Write', 'Edit', 'Agent', 'Task'],
  },
  'mhe-executor': {
    kind: 'leaf',
    allow: '*',
    deny: ['Agent', 'Task'],
  },
  'mhe-writer': {
    kind: 'leaf',
    allow: ['Read', 'Write', 'Edit'],
    deny: ['Bash', 'Agent', 'Task', 'WebSearch', 'WebFetch'],
  },
  'mhe-reasoner': {
    kind: 'notools',
    allow: [],
    deny: '*',
  },
  'mhe-lead': {
    kind: 'lead',
    allow: '*',
    deny: ['Agent', 'Task'],
  },
});

export const DEFAULT_BUILTINS = ['general-purpose', 'Explore'];

export function frontmatterName(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
    if (!match) return '';
    const name = match[1].match(/^\s*name\s*:\s*["']?([^"'\r\n]+)["']?/m);
    return name ? name[1].trim() : '';
  } catch {
    return '';
  }
}

export function detectAvailableAgents({ configDir = null, builtins = DEFAULT_BUILTINS } = {}) {
  const official = [...builtins];
  const user = [];
  if (configDir) {
    const agentsDir = path.join(configDir, 'agents');
    try {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = frontmatterName(path.join(agentsDir, file));
        if (!name) continue;
        if (name.startsWith('hr-')) continue; // legacy, removed by install
        user.push(name);
      }
    } catch {
      // no agents dir
    }
  }
  return {
    official,
    user: [...new Set(user)].sort(),
    available: [...new Set([...official, ...user])].sort(),
  };
}

export function resolveCapabilities({ availableAgents = [], allowFallbacks = true } = {}) {
  const available = new Set(availableAgents);
  const roles = {};
  const gaps = [];
  const fallbacksToInstall = new Set();

  for (const [role, definition] of Object.entries(ROLE_POLICY)) {
    let candidates = definition.candidates.filter((name) => available.has(name));
    let selected = candidates[0] || '';

    if (!selected && allowFallbacks) {
      const fallback = definition.candidates.find((name) => name.startsWith('mhe-'));
      if (fallback) {
        selected = fallback;
        candidates = [fallback];
        available.add(fallback);
        fallbacksToInstall.add(fallback);
        gaps.push({ role, fallback });
      }
    }

    roles[role] = {
      agent: selected || null,
      candidates,
      policy: definition.policy,
      output: definition.output,
      unresolved: !selected,
    };
  }

  const allowedSubagents = [...new Set(
    Object.values(roles).flatMap((role) => role.candidates),
  )].sort();

  const agents = {};
  for (const name of allowedSubagents) {
    agents[name] = AGENT_POLICY[name] || { kind: 'unknown', allow: '*', deny: [] };
  }

  return {
    version: 1,
    roles,
    agents,
    allowedSubagents,
    gaps,
    fallbacksToInstall: [...fallbacksToInstall].sort(),
    available: [...available].sort(),
  };
}

export function roleHintForAgent(agent, capabilities) {
  const order = [
    'investigate', 'plan', 'execute', 'verify_read', 'verify_run',
    'write', 'reason', 'lead',
  ];
  const roles = [];
  for (const role of order) {
    const entry = capabilities?.roles?.[role];
    if (!entry) continue;
    if (entry.agent === agent || entry.candidates?.includes(agent)) roles.push(role);
  }
  // An agent can cover several roles (Explore: investigate/plan/verify_read).
  // The conductor's task prompt carries the concrete role; this hint lists the
  // roles the agent is allowed to serve.
  return roles.join('|') || 'worker';
}

export function summarizeWorkers(capabilities) {
  const roles = capabilities?.roles || {};
  const lines = [];
  for (const role of [
    'investigate', 'plan', 'execute', 'verify_read', 'verify_run',
    'write', 'reason', 'lead',
  ]) {
    const entry = roles[role];
    if (!entry?.agent) continue;
    const extra = entry.candidates.length > 1 ? ` (fallback: ${entry.candidates.slice(1).join(', ')})` : '';
    lines.push(`- ${role} -> ${entry.agent}${extra}`);
  }
  return lines.join('\n');
}

export function workerMenu(capabilities) {
  return `WORKERS (native agents first; use the role mapping below):
${summarizeWorkers(capabilities) || '- (unresolved)'}
If a worker fails or returns an invalid envelope, try the next candidate listed for that role before creating a new task.`;
}
