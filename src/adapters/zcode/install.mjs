// ZCode installer: merges this layer into <configDir>/config.json without
// touching anything the user owns. ZCode stores hooks under
// `hooks.events.<Event>` with `{ type: 'process', command, args, timeoutMs }`
// entries, and MCP servers under `mcp.servers`. The install path only adds
// (or replaces) our own entries; everything else is copied through.
//
// Modes: project-scoped (default; the MCP entry pins MY_HARNESS_ENHANCE_PROJECT
// to one workspace and the hook stays dormant everywhere else) and `--global`
// (user-level hooks/MCP with no fixed project; a `zcode` marker in
// ~/.my-harness-enhance/global.json lets the hook auto-register any workspace
// on a new SessionStart). The marker lives under the global config's `zcode`
// key, so a Qoder global install's top-level keys are preserved untouched.
// Capability resolution uses ZCode's built-in agents only. Custom ZCode
// agents are plugin-provided through a manual UI step (not scriptable from
// an automated install), and `<configDir>/agents` is RUNTIME subagent
// session storage (sess_*/agent_* directories), not a definition directory:
// this adapter never writes into it, and never scans it for definitions.
// The `reason` role (which wants a no-tools agent ZCode does not provide) is
// filled by an explicit, labeled substitution: Explore under
// `compatibility: 'readonly'`. Strict no-tools would require a separately
// installed plugin agent; until then the conductor sends Explore a
// reason-from-material instruction and Explore's own read-only policy holds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  capabilitiesPath,
  ensureState,
  loadConfig,
  saveConfig,
  stateDirFor,
} from '../../core/config.mjs';
import { canonicalPath, enhanceHome, resolveProject, unregisterProject } from '../../core/state-root.mjs';
import { readGlobalConfig, writeGlobalConfig } from '../../core/global.mjs';
import {
  AGENT_POLICY,
  detectAvailableAgents,
  resolveCapabilities,
  summarizeWorkers,
} from '../../core/capabilities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The hook script lives in this adapter; the MCP server is harness-neutral
// and lives outside both adapters. Referencing it by absolute path is
// deliberate: one server for every adapter.
export const ZCODE_HOOK = path.join(HERE, 'hook.mjs');
export const RECALL_MCP = path.join(HERE, '..', '..', 'mcp', 'recall-server.mjs');

// ZCode fires exactly these lifecycle events; there is no SubagentStart,
// SubagentStop or PreCompact. PermissionRequest/PostToolUseFailure exist but
// this adapter has nothing to contribute there, so it registers nothing.
export const ZCODE_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);

export const ZCODE_SERVER_NAME = 'harness-enhance';
const LEGACY_SERVER_NAMES = ['harness-router'];

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function backup(file, suffix = 'harness-enhance') {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.${suffix}-${timestamp()}.bak`;
  fs.copyFileSync(file, target);
  return target;
}

function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * Default ZCode config dir: `~/.zcode/cli`. Overridable per-process with the
 * ZCODE_CONFIG_DIR env var or an explicit argument. `env` is honored for the
 * home lookup so detection can be tested without touching a real home dir.
 */
export function defaultConfigDir(env = process.env) {
  return path.join(homeDir(env), '.zcode', 'cli');
}

export function resolveConfigDir(explicit = null, env = process.env) {
  return path.resolve(explicit || env.ZCODE_CONFIG_DIR || defaultConfigDir(env));
}

/**
 * Adapter detect stage. Truthy = the resolved config dir. Matches only on a
 * real signal: an explicit dir, the ZCODE_CONFIG_DIR env var, or the default
 * dir actually existing on disk. Never creates or writes anything — probing
 * a well-known path that exists by accident would lie, so existence is the
 * bare minimum.
 */
export function detectZCodeConfigDir({ env = process.env, configDir = null } = {}) {
  const provided = configDir || env.ZCODE_CONFIG_DIR || null;
  if (provided) {
    const resolved = path.resolve(provided);
    return fs.existsSync(resolved) ? resolved : false;
  }
  const fallback = defaultConfigDir(env);
  return fs.existsSync(fallback) ? fallback : false;
}

export function configFilePath(configDir) {
  return path.join(configDir, 'config.json');
}

export function readHarnessConfig(configDir) {
  const file = configFilePath(configDir);
  if (!fs.existsSync(file)) return { config: {}, file, exists: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // A corrupt harness config must never be silently replaced: that would
    // destroy the user's file. Refuse and let them fix the JSON.
    throw new Error(`ZCode config is not valid JSON, refusing to overwrite: ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ZCode config must contain a JSON object: ${file}`);
  }
  return { config: parsed, file, exists: true };
}

/**
 * True when a hook entry was written by this installer: a process hook whose
 * args reference this adapter's hook script (`.../zcode/hook.mjs`).
 */
export function isOurHookEntry(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((hook) => {
    if (hook?.type && hook.type !== 'process') return false;
    const args = Array.isArray(hook?.args) ? hook.args : [];
    return args.some((arg) => /[/\\]zcode[/\\]hook\.mjs$/i.test(String(arg)));
  });
}

export function mergeHooks(config, {
  nodePath = process.execPath,
  hookPath = ZCODE_HOOK,
  timeoutMs = 15000,
} = {}) {
  const hooks = { ...(config.hooks || {}) };
  hooks.enabled = true;
  const events = { ...(hooks.events || {}) };
  for (const event of ZCODE_EVENTS) {
    const entries = Array.isArray(events[event]) ? events[event] : [];
    const kept = entries.filter((entry) => !isOurHookEntry(entry));
    kept.push({
      hooks: [
        {
          type: 'process',
          command: nodePath,
          args: [hookPath, event],
          timeoutMs,
        },
      ],
    });
    events[event] = kept;
  }
  hooks.events = events;
  config.hooks = hooks;
  return config;
}

export function mergeMcp(config, {
  root = null,
  global = false,
  nodePath = process.execPath,
  serverName = ZCODE_SERVER_NAME,
} = {}) {
  const mcp = { ...(config.mcp || {}) };
  const servers = { ...(mcp.servers || {}) };
  for (const legacy of LEGACY_SERVER_NAMES) delete servers[legacy];
  servers[serverName] = {
    type: 'stdio',
    command: nodePath,
    args: [RECALL_MCP],
    // Global mode pins no workspace: the shared server resolves the project
    // per call (enhance_* args.project) or from a session-registered state.
    env: global
      ? {
        MY_HARNESS_ENHANCE_HARNESS: 'zcode',
        MY_HARNESS_ENHANCE_GLOBAL: '1',
      }
      : {
        MY_HARNESS_ENHANCE_HARNESS: 'zcode',
        MY_HARNESS_ENHANCE_PROJECT: canonicalPath(root),
      },
    enabled: true,
  };
  mcp.servers = servers;
  config.mcp = mcp;
  return config;
}

/**
 * Pre-install value of hooks.enabled: true = already enabled, false = user
 * disabled, null = flag absent. A repeated install keeps the first record:
 * the second run sees our own enabled:true and would otherwise overwrite the
 * user's real baseline.
 */
function enabledSnapshot(harnessConfig) {
  return harnessConfig.hooks && Object.prototype.hasOwnProperty.call(harnessConfig.hooks, 'enabled')
    ? harnessConfig.hooks.enabled === true
    : null;
}

function hasOwnKey(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function requireTargetDir(targetDir) {
  if (!fs.existsSync(targetDir)) {
    throw new Error(
      `ZCode config dir not found: ${targetDir}. ` +
      'Start ZCode once, or pass --config-dir / set ZCODE_CONFIG_DIR.',
    );
  }
}

function unresolvedRoles(capabilities) {
  return Object.entries(capabilities?.roles || {})
    .filter(([, role]) => !role.agent)
    .map(([name]) => name);
}

/**
 * ZCode has no no-tools agent. The `reason` role is filled by an explicit,
 * labeled substitution — the read-only built-in `Explore` under
 * `compatibility: 'readonly'`. This is NOT presented as a no-tools agent:
 * the conductor sends Explore a reason-from-provided-material instruction,
 * and Explore's own read-only policy is what bounds the worker. Strict
 * no-tools would require a separately installed plugin-provided agent
 * (manual UI step; intentionally not part of this automated install).
 */
export function applyReadonlyReasonCompatibility(capabilities) {
  const role = capabilities?.roles?.reason;
  if (!role || role.agent) return capabilities;
  const compat = capabilities.available.includes('Explore') ? 'Explore' : 'general-purpose';
  role.agent = compat;
  role.candidates = [compat];
  role.unresolved = false;
  // The ideal policy ('notools') is replaced by the effective one; the
  // compatibility label is what records the difference for humans and plans.
  role.policy = 'readonly';
  role.compatibility = 'readonly';
  if (!capabilities.allowedSubagents.includes(compat)) {
    capabilities.allowedSubagents.push(compat);
    capabilities.allowedSubagents.sort();
  }
  if (!capabilities.agents[compat]) {
    capabilities.agents[compat] = AGENT_POLICY[compat] || { kind: 'unknown', allow: '*', deny: [] };
  }
  return capabilities;
}

export function compatibilityNotes(capabilities) {
  return Object.entries(capabilities?.roles || {})
    .filter(([, role]) => role.compatibility)
    .map(([name, role]) => `${name} -> ${role.agent} (read-only compatibility; ZCode has no no-tools agent)`);
}

/**
 * The single capability-resolution entry point for every ZCode path
 * (project install, refresh, global first-session auto-register). Built-in
 * agents only: ZCode custom agents are plugin-provided behind a manual UI
 * step, and `<configDir>/agents` is RUNTIME subagent session storage
 * (sess_xxx / agent_xxx directories), not a definition directory — it is
 * never scanned for agents and never written.
 */
export function resolveZcodePlan() {
  const detection = detectAvailableAgents();
  // allowFallbacks=false: roles resolve only to agents that genuinely exist.
  // The one deliberate deviation is the labeled substitution applied next.
  const capabilities = resolveCapabilities({
    availableAgents: detection.available,
    allowFallbacks: false,
  });
  applyReadonlyReasonCompatibility(capabilities);
  return { detection, capabilities };
}

export function installZCode({
  root = process.cwd(),
  configDir = null,
  global = false,
  dryRun = false,
  force = false, // accepted for contract symmetry; this installer never overwrites user files
  serverName = ZCODE_SERVER_NAME,
  timeoutMs = 15000,
  env = process.env,
} = {}) {
  void force;
  const projectRoot = canonicalPath(root);
  const targetDir = resolveConfigDir(configDir, env);
  requireTargetDir(targetDir);
  const { config: current, file: configFile } = readHarnessConfig(targetDir);

  // Capability plan from built-in agents only, with the labeled read-only
  // compatibility for `reason`. Nothing is written under configDir except
  // config.json (plus its backup): `<configDir>/agents` is ZCode runtime
  // session storage and off-limits. Global mode pins no plan — workspaces
  // resolve the same way on their first auto-registered session.
  const { detection, capabilities: planCapabilities } = resolveZcodePlan();
  const capabilities = global ? null : planCapabilities;
  const stateDir = stateDirFor(projectRoot);

  // Remember the pre-install value of hooks.enabled. Installing turns hooks
  // on; uninstalling must hand that switch back exactly as it found it, or a
  // user who had their own hooks disabled would get them silently re-enabled.
  // Project installs record it in the workspace state config; global installs
  // in global.json's zcode marker. A repeated install keeps the first record.
  const previous = loadConfig(projectRoot).config;
  const previousMarker = readGlobalConfig().zcode;
  const enabledBefore = (global
    ? hasOwnKey(previousMarker, 'hooksEnabledBefore')
      ? previousMarker.hooksEnabledBefore
      : null
    : hasOwnKey(previous.zcode, 'hooksEnabledBefore')
      ? previous.zcode.hooksEnabledBefore
      : null) ?? enabledSnapshot(current);
  if (!dryRun && global) {
    writeGlobalConfig({
      zcode: { autoRegister: true, configDir: targetDir, hooksEnabledBefore: enabledBefore },
    });
  }
  if (!dryRun && !global) {
    ensureState(projectRoot, {
      harness: 'zcode',
      zcode: {
        configDir: targetDir,
        mcpServerName: serverName,
        hookTimeoutMs: timeoutMs,
        hooksEnabledBefore: enabledBefore,
      },
      logging: previous.logging || 'errors',
      capabilities,
    });
    atomicWrite(capabilitiesPath(projectRoot), `${JSON.stringify(capabilities, null, 2)}\n`);
    saveConfig(projectRoot, { capabilities });
  }

  const warnings = [];
  if (global) {
    warnings.push(
      'global mode is ZCode-specific (global.json zcode.autoRegister); it does not change Qoder global settings. ' +
      'Workspaces auto-register on their first new SessionStart; system/home dirs are excluded. ' +
      'Existing sessions are never retrofitted mid-task. ' +
      'The reason role resolves to the built-in Explore agent with read-only compatibility in every workspace plan.',
    );
  }
  if (capabilities) {
    const pending = unresolvedRoles(capabilities);
    if (pending.length) {
      warnings.push(
        `capability gaps (unresolved): ${pending.join(', ')} — ZCode custom agents are ` +
        'plugin-provided (manual install); run `mhe refresh zcode` after adding one.',
      );
    }
  }

  let backupPath = null;
  if (!dryRun && fs.existsSync(configFile)) backupPath = backup(configFile);

  const nextConfig = mergeMcp(
    mergeHooks(JSON.parse(JSON.stringify(current)), {
      nodePath: process.execPath,
      hookPath: ZCODE_HOOK,
      timeoutMs,
    }),
    { root: projectRoot, global, nodePath: process.execPath, serverName },
  );

  if (!dryRun) {
    atomicWrite(configFile, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  const changes = [
    `config dir: ${targetDir}`,
    global
      ? 'mode: global (auto-register any workspace on its first new session; per-workspace state)'
      : `project root: ${projectRoot}`,
    global ? `global marker: ${path.join(enhanceHome(), 'global.json')} (zcode.autoRegister)` : `state dir (user-level): ${stateDir}`,
    global ? 'capability policy: (resolved per workspace on first session)' : `capability policy: ${summarizeWorkers(capabilities) || '(unresolved)'}`,
    `hooks installed: ${ZCODE_EVENTS.join(', ')} (no SubagentStart/SubagentStop/PreCompact events exist in ZCode)`,
    `mcp server: ${serverName} -> ${RECALL_MCP}`,
  ];
  for (const note of global ? compatibilityNotes(planCapabilities) : compatibilityNotes(capabilities)) {
    changes.push(`capability compatibility: ${note}`);
  }
  if (backupPath) changes.push(`config backup: ${backupPath}`);
  if (dryRun) changes.push('DRY RUN: no files were written');

  return {
    ok: true,
    dryRun,
    global,
    mode: global ? 'global' : 'auto',
    projectRoot,
    configDir: targetDir,
    stateDir,
    configFile,
    capabilities,
    detection,
    fallbackReports: [],
    overlay: null,
    hookScript: ZCODE_HOOK,
    mcpServer: RECALL_MCP,
    events: ZCODE_EVENTS,
    backup: backupPath,
    changes,
    warnings,
    nextConfig: dryRun ? nextConfig : undefined,
  };
}

export function uninstallZCode({
  root = process.cwd(),
  configDir = null,
  global = false,
  serverName = ZCODE_SERVER_NAME,
  dryRun = false,
  env = process.env,
} = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = resolveConfigDir(configDir, env);
  const file = configFilePath(targetDir);
  const changes = [];
  let backupPath = null;
  let config = null;
  let exists = false;
  if (fs.existsSync(file)) {
    try {
      ({ config, exists } = readHarnessConfig(targetDir));
    } catch (error) {
      // An unreadable config file is not ours to edit or delete: leave it,
      // still drop the project registration so state hygiene works.
      changes.push(`config left untouched (unreadable): ${error.message}`);
    }
  }

  const previous = loadConfig(projectRoot).config;
  const ourServerNames = new Set(
    [serverName, previous.zcode?.mcpServerName, ...LEGACY_SERVER_NAMES].filter(Boolean),
  );
  // The enabled-baseline record lives with the install mode that captured it:
  // global installs in global.json's zcode marker, project installs in the
  // workspace state config.
  const enabledBefore = global
    ? readGlobalConfig().zcode?.hooksEnabledBefore
    : previous.zcode?.hooksEnabledBefore;

  let configDirty = false;
  if (exists && config) {
    const events = config.hooks?.events;
    if (events && typeof events === 'object') {
      for (const event of Object.keys(events)) {
        if (!Array.isArray(events[event])) continue;
        const before = events[event].length;
        events[event] = events[event].filter((entry) => !isOurHookEntry(entry));
        if (events[event].length !== before) {
          changes.push(`removed hook entry: ${event}`);
          configDirty = true;
        }
        if (events[event].length === 0) delete events[event];
      }
    }
    const servers = config.mcp?.servers;
    if (servers && typeof servers === 'object') {
      for (const name of Object.keys(servers)) {
        if (!ourServerNames.has(name)) continue;
        delete servers[name];
        changes.push(`removed mcp server: ${name}`);
        configDirty = true;
      }
    }

    // Hand hooks.enabled back to its pre-install state (see installZCode).
    if (config.hooks?.enabled === true && (enabledBefore === false || enabledBefore === null)) {
      if (enabledBefore === false) {
        config.hooks.enabled = false;
        changes.push('restored hooks.enabled: false');
      } else {
        delete config.hooks.enabled;
        changes.push('removed hooks.enabled flag added by install');
      }
      configDirty = true;
    }

    if (!dryRun && configDirty) {
      backupPath = backup(file);
      atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
    }
  }

  // No agent files are ever installed or removed: `<configDir>/agents` is
  // ZCode runtime session storage, not a definitions directory.

  if (!dryRun && global) {
    // Disable only our marker; Qoder's top-level global keys stay intact.
    const marker = readGlobalConfig().zcode || {};
    writeGlobalConfig({ zcode: { ...marker, autoRegister: false } });
  } else if (!dryRun) {
    unregisterProject(projectRoot);
  }
  changes.push(
    global
      ? `${dryRun ? 'would disable' : 'disabled'} zcode global auto-register marker: ` +
        `${path.join(enhanceHome(), 'global.json')}`
      : `${dryRun ? 'would unregister' : 'unregistered'} project state: ${stateDirFor(projectRoot)}`,
  );

  return {
    ok: true,
    dryRun,
    global,
    projectRoot,
    configDir: targetDir,
    stateDir: stateDirFor(projectRoot),
    backup: backupPath,
    changes,
  };
}

export function doctorZCode({ root = process.cwd(), configDir = null, env = process.env } = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = resolveConfigDir(configDir, env);
  const file = configFilePath(targetDir);
  let stored = {};
  let parseError = '';
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      parseError = error.message;
    }
  }

  const project = resolveProject(projectRoot);
  const { config, exists } = loadConfig(projectRoot);
  const serverName = config.zcode?.mcpServerName || ZCODE_SERVER_NAME;
  // Built-ins only: <configDir>/agents is runtime session storage, never a
// definition source.
const detection = detectAvailableAgents();
  const globalMarker = readGlobalConfig().zcode;
  const globalMode = globalMarker?.autoRegister === true;
  const checks = [];

  checks.push({
    name: 'zcode global mode',
    ok: true, // informational: the mode itself is never a fault
    detail: globalMode
      ? `auto-register on (${globalMarker.configDir || 'config dir auto'}); workspaces register at first new session`
      : 'project-scoped',
  });
  checks.push({
    name: 'project registered',
    ok: Boolean(project) || globalMode,
    detail: project ? project.stateDir : (globalMode ? '(auto on first session)' : '(not registered; run mhe install zcode)'),
  });
  checks.push({
    name: 'project state config',
    ok: exists || globalMode,
    detail: exists
      ? path.join(stateDirFor(projectRoot), 'config.json')
      : (globalMode ? '(auto on first session)' : '(missing)'),
  });
  checks.push({
    name: 'harness',
    ok: !exists || config.harness === 'zcode',
    detail: config.harness || '(unknown)',
  });
  checks.push({
    name: 'zcode config',
    ok: fs.existsSync(file) && !parseError,
    detail: parseError || file,
  });
  checks.push({
    name: 'hooks enabled',
    ok: stored.hooks?.enabled === true,
    detail: stored.hooks?.enabled === true ? 'true' : '(not enabled)',
  });

  const events = stored.hooks?.events && typeof stored.hooks.events === 'object'
    ? stored.hooks.events
    : {};
  for (const event of ZCODE_EVENTS) {
    const entries = Array.isArray(events[event]) ? events[event] : [];
    checks.push({
      name: `hook ${event}`,
      ok: entries.some(isOurHookEntry),
      detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    });
  }

  const servers = stored.mcp?.servers && typeof stored.mcp.servers === 'object'
    ? stored.mcp.servers
    : {};
  const mcpEntry = servers[serverName];
  checks.push({
    name: 'mcp server',
    ok: Boolean(mcpEntry),
    detail: mcpEntry ? `${serverName} -> ${RECALL_MCP}` : serverName,
  });
  checks.push({
    name: 'native agents',
    ok: detection.official.every((name) => detection.available.includes(name)),
    detail: detection.available.join(', ') || '(none)',
  });

  const roles = config.capabilities?.roles || {};
  const unresolved = unresolvedRoles(config.capabilities);
  checks.push({
    name: 'capability roles',
    // A missing plan at all is the real fault. The reason role is reported
    // with its compatibility label, not as a missing fallback: ZCode has no
    // no-tools agent, and reason -> Explore (read-only) is the resolved plan.
    ok: Object.keys(roles).length > 0 || globalMode,
    detail: Object.keys(roles).length === 0
      ? (globalMode ? '(resolved on first workspace session)' : '(no capability plan; run mhe refresh zcode)')
      : [summarizeWorkers(config.capabilities).replace(/\n+/g, ' ') || '(none)',
        compatibilityNotes(config.capabilities).join(', ') && `compatibility: ${compatibilityNotes(config.capabilities).join('; ')}`,
        unresolved.length ? `unresolved: ${unresolved.join(', ')}` : '']
        .filter(Boolean).join(' | '),
  });
  checks.push({
    name: 'capabilities file',
    ok: fs.existsSync(capabilitiesPath(projectRoot)) || globalMode,
    detail: fs.existsSync(capabilitiesPath(projectRoot))
      ? capabilitiesPath(projectRoot)
      : (globalMode ? '(written on first workspace session)' : capabilitiesPath(projectRoot)),
  });

  return {
    ok: checks.every((check) => check.ok),
    projectRoot,
    configDir: targetDir,
    stateDir: project?.stateDir || stateDirFor(projectRoot),
    detection,
    capabilities: config.capabilities,
    checks,
  };
}

export function refreshZCode({ root = process.cwd(), configDir = null, env = process.env } = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = resolveConfigDir(configDir, env);
  const { detection, capabilities } = resolveZcodePlan();
  const previous = loadConfig(projectRoot).config;
  ensureState(projectRoot, {
    harness: 'zcode',
    zcode: {
      configDir: targetDir,
      mcpServerName: previous.zcode?.mcpServerName || ZCODE_SERVER_NAME,
    },
    logging: previous.logging || 'errors',
    capabilities,
  });
  atomicWrite(capabilitiesPath(projectRoot), `${JSON.stringify(capabilities, null, 2)}\n`);
  saveConfig(projectRoot, { capabilities });
  return {
    projectRoot,
    configDir: targetDir,
    stateDir: stateDirFor(projectRoot),
    capabilities,
    detection,
  };
}
