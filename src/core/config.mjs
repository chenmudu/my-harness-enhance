import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, readJson } from './fs-util.mjs';
import {
  canonicalPath,
  projectStateDir,
  registerProject,
  resolveProject,
  setProjectEnabled,
} from './state-root.mjs';

export { atomicWrite, readJson };

const ENHANCE_MCP_TOOLS = [
  'mcp__harness-enhance__enhance_state',
  'mcp__harness-enhance__enhance_goal',
  'mcp__harness-enhance__enhance_brief',
  'mcp__harness-enhance__enhance_plan',
  'mcp__harness-enhance__enhance_decide',
  'mcp__harness-enhance__enhance_job',
  'mcp__harness-enhance__enhance_check',
  'mcp__harness-enhance__enhance_worktree',
  'mcp__harness-enhance__enhance_recall',
  'mcp__harness-enhance__enhance_artifact',
  'mcp__harness-enhance__enhance_capabilities',
  'mcp__harness-enhance__enhance_worker_contract',
];

export const DEFAULT_CONFIG = Object.freeze({  version: 2,
  enabled: true,
  conductor: {
    // Auto mode: every main session in a registered project is the conductor.
    // No agent or model selection is required.
    auto: true,
    allowedTools: [
      'Agent',
      'Task',
      'AskUserQuestion',
      ...ENHANCE_MCP_TOOLS,
    ],
    allowFallbacks: true,
  },
  // Resolved by src/core/capabilities.mjs at install/doctor time.
  capabilities: {
    version: 1,
    roles: {},
    agents: {},
    allowedSubagents: [],
    gaps: [],
    available: [],
  },
  envelope: {
    maxSummaryChars: 1200,
    maxEvidence: 8,
    maxArtifacts: 12,
    maxOpenQuestions: 6,
    maxTotalChars: 6000,
  },
  context: {
    maxCapsuleTokens: 1800,
    maxRecallTokens: 800,
    maxArtifactChars: 4000,
    captureToolOutputBytes: 12000,
    workerOutputMode: 'capture',
  },
  verification: {
    // Only commands registered here can be run by enhance_check. The
    // deterministic-first policy itself lives in the conductor contract.
    commands: {},
  },
  logging: 'errors', // off | errors | decisions
  qoder: {
    configDir: null,
    hookTimeoutSec: 15,
    mcpServerName: 'harness-enhance',
    mcpServerType: 'stdio',
  },
  bench: {
    windowTokens: 180000,
  },
});

const REMOVED_CONDUCTOR_KEYS = ['maxDepth', 'maxFanout'];
const REMOVED_CONTEXT_KEYS = ['maxStateTokens'];
const REMOVED_CONDUCTOR_TOOLS = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
]);

/**
 * Strip controls that were advertised but never enforced. Existing installs
 * keep their config.json, so migration has to happen at read/write time rather
 * than only in the defaults.
 */
export function sanitizeConfig(config) {
  if (config?.conductor) {
    for (const key of REMOVED_CONDUCTOR_KEYS) delete config.conductor[key];
    if (Array.isArray(config.conductor.allowedTools)) {
      config.conductor.allowedTools = config.conductor.allowedTools
        .filter((tool) => !REMOVED_CONDUCTOR_TOOLS.has(tool));
    }
  }
  if (config?.context) {
    for (const key of REMOVED_CONTEXT_KEYS) delete config.context[key];
  }
  return config;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isObject(base)) return override;
  if (!isObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * User-level state directory for a project. Nothing is stored in the repo.
 */
export function stateDirFor(root) {
  return projectStateDir(root);
}

export function configPath(root) {
  return path.join(stateDirFor(root), 'config.json');
}

export function capabilitiesPath(root) {
  return path.join(stateDirFor(root), 'capabilities.json');
}

export function loadConfig(root = process.cwd()) {
  const projectRoot = canonicalPath(root);
  const file = configPath(projectRoot);
  const defaults = cloneDefaultConfig();
  const registered = Boolean(resolveProject(projectRoot));
  if (!fs.existsSync(file)) {
    return { config: defaults, root: projectRoot, exists: false, registered };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      config: sanitizeConfig(deepMerge(defaults, raw)),
      root: projectRoot,
      exists: true,
      registered,
    };
  } catch (error) {
    return {
      config: defaults,
      root: projectRoot,
      exists: true,
      registered,
      error: `invalid config: ${error.message}`,
    };
  }
}

export function saveConfig(root, patch) {
  const projectRoot = canonicalPath(root);
  const file = configPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
  const next = sanitizeConfig(deepMerge(deepMerge(cloneDefaultConfig(), existing), patch));
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function ensureState(root = process.cwd(), patch = {}) {
  const projectRoot = canonicalPath(root);
  const record = registerProject(projectRoot, {
    harness: patch.harness,
    configDir: patch.qoder?.configDir,
  });
  const dir = record.stateDir || stateDirFor(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const cfgFile = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    const initial = sanitizeConfig(deepMerge(cloneDefaultConfig(), patch));
    atomicWrite(cfgFile, `${JSON.stringify(initial, null, 2)}\n`);
  } else if (Object.keys(patch).length > 0) {
    saveConfig(projectRoot, patch);
  }
  return {
    root: projectRoot,
    stateDir: dir,
    config: loadConfig(projectRoot).config,
  };
}

export function enableProject(root) {
  return setProjectEnabled(root, true);
}

export function disableProject(root) {
  return setProjectEnabled(root, false);
}
