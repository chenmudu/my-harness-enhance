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
import {
  canonicalPath,
  enhanceHome,
  projectKey,
  resolveProject,
  unregisterProject,
} from '../../core/state-root.mjs';
import { globalConfigPath, readGlobalConfig, writeGlobalConfig } from '../../core/global.mjs';
import {
  detectAvailableAgents,
  resolveCapabilities,
  summarizeWorkers,
} from '../../core/capabilities.mjs';
import {
  doctorOverlay,
  syncOverlayAgents,
  uninstallOverlayAgents,
} from './overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, 'templates', 'agents');
const HOOK = path.join(HERE, 'hooks', 'hook.mjs');
const MCP = path.join(HERE, 'mcp', 'recall-server.mjs');

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'SubagentStart',
  'SubagentStop',
  'PostToolUse',
  'PreCompact',
  'Stop',
];

const LEGACY_AGENT_FILES = new Set([
  'hr-executor.md',
  'hr-investigator.md',
  'hr-lead.md',
  'hr-planner.md',
  'hr-reasoner.md',
  'hr-router.md',
  'hr-verifier.md',
  'hr-writer.md',
]);

function slash(file) {
  return file.replaceAll('\\', '/');
}

function quoted(value) {
  return `"${slash(value).replaceAll('"', '\\"')}"`;
}

export function hookCommand(event, nodePath = process.execPath) {
  return `${quoted(nodePath)} ${quoted(HOOK)} ${event}`;
}

export function templateFiles() {
  return fs.readdirSync(TEMPLATES)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

export function detectConfigDir(explicit = null) {
  if (explicit) return path.resolve(explicit);
  if (process.env.QODER_CONFIG_DIR) return path.resolve(process.env.QODER_CONFIG_DIR);
  const home = os.homedir();
  const candidates = [
    path.join(home, '.qoder-cn'),
    path.join(home, '.qoder'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'agents'))) {
      return dir;
    }
  }
  return candidates[0];
}

export function readSettings(configDir) {
  const file = path.join(configDir, 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function backup(file, suffix = 'harness-enhance') {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.${suffix}-${timestamp()}.bak`;
  fs.copyFileSync(file, target);
  return target;
}

function isOurHookEntry(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((hook) => {
    const command = String(hook?.command || '');
    return command.includes('hook.mjs') && (
      command.includes('harness-enhance') ||
      command.includes('my-harness-enhance') ||
      command.includes('harness-router')
    );
  });
}

export function mergeHooks(settings, { nodePath = process.execPath, timeout = 15 } = {}) {
  const hooks = { ...(settings.hooks || {}) };
  for (const event of EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = entries.filter((entry) => !isOurHookEntry(entry));
    kept.push({
      hooks: [
        {
          type: 'command',
          command: hookCommand(event, nodePath),
          timeout,
        },
      ],
    });
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  return settings;
}

export function mergeMcp(settings, {
  root = null,
  global = false,
  nodePath = process.execPath,
  serverName = 'harness-enhance',
} = {}) {
  const servers = { ...(settings.mcpServers || {}) };
  delete servers['harness-router']; // legacy name
  servers[serverName] = {
    type: 'stdio',
    command: nodePath,
    args: [MCP],
    env: global
      ? { MY_HARNESS_ENHANCE_GLOBAL: '1' }
      : { MY_HARNESS_ENHANCE_PROJECT: canonicalPath(root) },
  };
  settings.mcpServers = servers;
  return settings;
}

function removeLegacyAgents(configDir) {
  const agentsDir = path.join(configDir, 'agents');
  const removed = [];
  if (!fs.existsSync(agentsDir)) return removed;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!LEGACY_AGENT_FILES.has(file)) continue;
    fs.rmSync(path.join(agentsDir, file), { force: true });
    removed.push(file);
  }
  return removed;
}

function migrateLegacyState(projectRoot) {
  const legacyDir = path.join(projectRoot, '.router');
  if (!fs.existsSync(legacyDir)) return null;
  const target = path.join(
    enhanceHome(),
    'legacy',
    `${projectKey(projectRoot)}-${timestamp()}`,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(legacyDir, target, { recursive: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
  return target;
}

function copyFallbackAgents(configDir, fallbacks, dryRun, force) {
  const agentsDir = path.join(configDir, 'agents');
  const reports = [];
  const warnings = [];
  for (const name of fallbacks) {
    const file = `${name}.md`;
    const source = path.join(TEMPLATES, file);
    const target = path.join(agentsDir, file);
    if (!fs.existsSync(source)) {
      warnings.push(`missing fallback template: ${file}`);
      continue;
    }
    const content = fs.readFileSync(source, 'utf8');
    let agentBackup = null;
    if (!dryRun) {
      fs.mkdirSync(agentsDir, { recursive: true });
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content) {
        agentBackup = backup(target, 'harness-enhance-agent');
      }
      if (!fs.existsSync(target) || force || fs.readFileSync(target, 'utf8') !== content) {
        atomicWrite(target, content);
      }
    }
    reports.push({ file, target, changed: true, backup: agentBackup });
  }
  return { reports, warnings };
}

export function installQoder({
  root = process.cwd(),
  configDir = null,
  global = false,
  dryRun = false,
  force = false,
  serverName = 'harness-enhance',
  platform = process.platform,
  repoOverlayDir = null,
} = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = detectConfigDir(configDir);
  const settingsFile = path.join(targetDir, 'settings.json');
  const settings = readSettings(targetDir);
  const detection = detectAvailableAgents({ configDir: targetDir });
  const capabilities = global
    ? null
    : resolveCapabilities({ availableAgents: detection.available });
  const stateDir = stateDirFor(projectRoot);

  const previous = loadConfig(projectRoot).config;
  const config = (global || dryRun)
    ? previous
    : ensureState(projectRoot, {
      harness: 'qoder',
      qoder: { configDir: targetDir, mcpServerName: serverName },
      logging: previous.logging || 'errors',
      capabilities,
    }).config;

  if (!dryRun && !global) {
    atomicWrite(
      capabilitiesPath(projectRoot),
      `${JSON.stringify(capabilities, null, 2)}\n`,
    );
    saveConfig(projectRoot, { capabilities });
  }
  if (!dryRun && global) {
    writeGlobalConfig({
      autoRegister: true,
      harness: 'qoder',
      configDir: targetDir,
      logging: previous.logging || 'errors',
    });
  }

  const globalPlan = global
    ? resolveCapabilities({ availableAgents: detection.available })
    : null;
  const planForFallbacks = global ? globalPlan : capabilities;
  const { reports: fallbackReports, warnings } = copyFallbackAgents(
    targetDir,
    planForFallbacks.fallbacksToInstall,
    dryRun,
    force,
  );

  const legacyAgents = dryRun ? [] : removeLegacyAgents(targetDir);
  const legacyState = dryRun ? null : migrateLegacyState(projectRoot);

  if (JSON.stringify(settings.hooks || {}).includes('bash-delegate')) {
    warnings.push(
      'existing bash-delegate hook preserved: it may deny native workers when the ' +
      'main model is a qwen 3.5 9b/7b. Use a non-9B conductor model or remove that old hook.',
    );
  }
  if (capabilities && capabilities.gaps.length > 0) {
    warnings.push(
      `capability gaps: ${capabilities.gaps.map((gap) => `${gap.role}->${gap.fallback}`).join(', ')}`,
    );
  }

  let backupPath = null;
  if (!dryRun && fs.existsSync(settingsFile)) backupPath = backup(settingsFile);

  const nextSettings = mergeMcp(
    mergeHooks(JSON.parse(JSON.stringify(settings)), {
      nodePath: process.execPath,
      timeout: config.qoder?.hookTimeoutSec || 15,
    }),
    { root: projectRoot, global, nodePath: process.execPath, serverName },
  );

  if (!dryRun) {
    atomicWrite(settingsFile, `${JSON.stringify(nextSettings, null, 2)}\n`);
  }

  // Personal overlay sync runs last so it can never perturb capability
  // resolution or the product mhe-* fallback decision above. It writes only to
  // configDir/agents (the user's Qoder dir), never into the project repo. The
  // shipped repo overlay is empty by default, so this is a no-op until the user
  // adds personal agents.
  const overlay = syncOverlayAgents({
    configDir: targetDir,
    dryRun,
    platform,
    repoRoot: repoOverlayDir ?? undefined,
  });

  const changes = [
    `config dir: ${targetDir}`,
    `project root: ${projectRoot}`,
    `state dir (user-level): ${stateDir}`,
    global ? 'mode: global (auto-register any workspace; per-workspace state)' : `capability policy: ${summarizeWorkers(capabilities) || '(unresolved)'}`,
    global ? `fallback agents installed globally: ${planForFallbacks.fallbacksToInstall.length === 0 ? 'none' : planForFallbacks.fallbacksToInstall.join(', ')}` : `fallback agents installed: ${capabilities.fallbacksToInstall.length === 0 ? 'none (native agents cover all roles)' : capabilities.fallbacksToInstall.join(', ')}`,
    `hooks installed: ${EVENTS.join(', ')}`,
    `mcp server: ${serverName} -> ${MCP}`,
  ];
  if (legacyAgents.length) changes.push(`removed legacy agents: ${legacyAgents.join(', ')}`);
  if (legacyState) changes.push(`legacy .router migrated to: ${legacyState}`);
  changes.push(
    `personal overlay agents: ${overlay.installed.length} installed, ` +
    `${overlay.updated.length} updated, ${overlay.adopted.length} adopted, ` +
    `${overlay.unchanged.length} unchanged, ${overlay.skippedPlatform.length} skipped-platform, ` +
    `${overlay.conflicts.length} conflict(s)`,
  );
  if (backupPath) changes.push(`settings backup: ${backupPath}`);
  if (dryRun) changes.push('DRY RUN: no files were written');

  for (const conflict of overlay.conflicts) {
    warnings.push(`overlay agent skipped: ${conflict.file} — ${conflict.reason}`);
  }

  return {
    ok: true,
    dryRun,
    global,
    mode: global ? 'global' : 'auto',
    projectRoot,
    configDir: targetDir,
    stateDir,
    settingsFile,
    capabilities,
    detection,
    fallbackReports,
    overlay,
    legacyAgents,
    legacyState,
    hookScript: HOOK,
    mcpServer: MCP,
    events: EVENTS,
    backup: backupPath,
    changes,
    warnings,
    nextSettings: dryRun ? nextSettings : undefined,
  };
}

export function syncCapabilities({
  root = process.cwd(),
  configDir = null,
  allowFallbacks = false,
} = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = detectConfigDir(configDir);
  const detection = detectAvailableAgents({ configDir: targetDir });
  const capabilities = resolveCapabilities({
    availableAgents: detection.available,
    allowFallbacks,
  });
  const previous = loadConfig(projectRoot).config;
  ensureState(projectRoot, {
    harness: 'qoder',
    qoder: {
      configDir: targetDir,
      mcpServerName: previous.qoder?.mcpServerName || 'harness-enhance',
    },
    logging: previous.logging || 'errors',
    capabilities,
  });
  atomicWrite(capabilitiesPath(projectRoot), `${JSON.stringify(capabilities, null, 2)}
`);
  saveConfig(projectRoot, { capabilities });
  return {
    projectRoot,
    configDir: targetDir,
    stateDir: stateDirFor(projectRoot),
    capabilities,
    detection,
  };
}

export function refreshCapabilities({ root = process.cwd(), configDir = null } = {}) {
  const report = syncCapabilities({ root, configDir, allowFallbacks: true });
  const { reports, warnings } = copyFallbackAgents(
    report.configDir,
    report.capabilities.fallbacksToInstall,
    false,
    false,
  );
  return { ...report, fallbackReports: reports, warnings };
}

export function uninstallQoder({
  root = process.cwd(),
  configDir = null,
  global = false,
  serverName = 'harness-enhance',
  dryRun = false,
} = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = detectConfigDir(configDir);
  const settingsFile = path.join(targetDir, 'settings.json');
  const settings = readSettings(targetDir);
  const changes = [];
  let backupPath = null;

  if (!dryRun && fs.existsSync(settingsFile)) backupPath = backup(settingsFile);

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter((entry) => !isOurHookEntry(entry));
      if (settings.hooks[event].length !== before) changes.push(`removed hook entry: ${event}`);
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  }
  for (const name of [serverName, 'harness-router']) {
    if (settings.mcpServers?.[name]) {
      delete settings.mcpServers[name];
      changes.push(`removed mcp server: ${name}`);
    }
  }

  const agentsDir = path.join(targetDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const ours = file.startsWith('mhe-') || LEGACY_AGENT_FILES.has(file);
      if (!ours) continue;
      if (!dryRun) fs.rmSync(path.join(agentsDir, file), { force: true });
      changes.push(`removed agent: ${file}`);
    }
  }

  // Overlay agents: remove only files this tool created (installed/updated)
  // that are still unmodified; keep adopted (pre-existing) and modified files in
  // place, and never touch official/unrelated agents.
  const overlay = uninstallOverlayAgents({ configDir: targetDir, dryRun });
  for (const file of overlay.removed) changes.push(`removed overlay agent: ${file}`);
  for (const file of overlay.keptAdopted) changes.push(`kept adopted overlay agent: ${file}`);
  for (const file of overlay.keptModified) changes.push(`kept modified overlay agent: ${file}`);
  for (const file of overlay.droppedStale) changes.push(`forgot stale overlay agent: ${file}`);

  if (!dryRun) atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (!dryRun && global) {
    fs.rmSync(globalConfigPath(), { force: true });
    changes.push('removed global auto-register config');
  }
  if (!dryRun && !global) unregisterProject(projectRoot);
  return {
    ok: true,
    dryRun,
    projectRoot,
    configDir: targetDir,
    stateDir: stateDirFor(projectRoot),
    backup: backupPath,
    overlay,
    changes,
  };
}

export function doctorQoder({ root = process.cwd(), configDir = null, platform = process.platform, repoOverlayDir = null } = {}) {
  const projectRoot = canonicalPath(root);
  const targetDir = detectConfigDir(configDir);
  const settingsFile = path.join(targetDir, 'settings.json');
  const settings = readSettings(targetDir);
  const project = resolveProject(projectRoot);
  const global = readGlobalConfig();
  const globalMode = global.autoRegister === true;
  const { config, exists } = loadConfig(projectRoot);
  const detection = detectAvailableAgents({ configDir: targetDir });
  const checks = [];

  checks.push({
    name: 'project registered',
    ok: Boolean(project) || globalMode,
    detail: project ? project.stateDir : (globalMode ? '(auto on first session)' : '(not registered)'),
  });
  checks.push({
    name: 'project config',
    ok: exists || globalMode,
    detail: exists ? path.join(stateDirFor(projectRoot), 'config.json') : '(auto on first session)',
  });
  checks.push({
    name: 'global mode',
    ok: true,
    detail: globalMode ? `auto-register (${global.configDir || 'config dir auto'})` : 'project-scoped',
  });
  checks.push({
    name: 'layer enabled',
    ok: config.enabled !== false,
    detail: config.enabled === false ? 'disabled (mhe enable)' : 'enabled',
  });
  checks.push({
    name: 'qoder settings',
    ok: fs.existsSync(settingsFile),
    detail: settingsFile,
  });

  for (const event of EVENTS) {
    const entries = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
    checks.push({
      name: `hook ${event}`,
      ok: entries.some(isOurHookEntry),
      detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    });
  }

  checks.push({
    name: 'mcp server',
    ok: Boolean(settings.mcpServers?.[config.qoder?.mcpServerName || 'harness-enhance']),
    detail: config.qoder?.mcpServerName || 'harness-enhance',
  });
  checks.push({
    name: 'official agents',
    ok: detection.official.every((name) => detection.available.includes(name)),
    detail: detection.official.join(', '),
  });
  checks.push({
    name: 'user agents',
    ok: true,
    detail: detection.user.join(', ') || '(none)',
  });

  const roles = config.capabilities?.roles || {};
  const unresolved = Object.entries(roles).filter(([, role]) => !role.agent).map(([name]) => name);
  checks.push({
    name: 'capability roles',
    ok: (Object.keys(roles).length > 0 && unresolved.length === 0) || globalMode,
    detail: Object.keys(roles).length === 0
      ? (globalMode ? '(resolved on first workspace session)' : 'no capabilities resolved; run `mhe refresh`')
      : (unresolved.length ? `unresolved: ${unresolved.join(', ')}` : summarizeWorkers(config.capabilities)),
  });
  checks.push({
    name: 'capabilities file',
    ok: fs.existsSync(capabilitiesPath(projectRoot)) || globalMode,
    detail: fs.existsSync(capabilitiesPath(projectRoot)) ? capabilitiesPath(projectRoot) : '(auto on first session)',
  });
  const legacyRouter = path.join(projectRoot, '.router');
  checks.push({
    name: 'legacy .router',
    ok: !fs.existsSync(legacyRouter),
    detail: fs.existsSync(legacyRouter) ? legacyRouter : '(none)',
  });
  const legacyAgents = fs.existsSync(path.join(targetDir, 'agents'))
    ? fs.readdirSync(path.join(targetDir, 'agents')).filter((file) => file.startsWith('hr-'))
    : [];
  checks.push({
    name: 'legacy agents',
    ok: legacyAgents.length === 0,
    detail: legacyAgents.join(', ') || '(none)',
  });

  // Informational: conflicts (targets edited by hand, or unmanaged files that
  // collide by name) and platform-skips are surfaced but do not mark the
  // harness unhealthy, so a personal tweak never reads as a broken install.
  const overlay = doctorOverlay({
    configDir: targetDir,
    platform,
    repoRoot: repoOverlayDir ?? undefined,
  });
  checks.push({
    name: 'personal overlay agents',
    ok: true,
    detail: `managed ${overlay.managed.length}`
      + ` (adopted ${overlay.managed.filter((m) => m.origin === 'adopted').length}),`
      + ` sources repo=${overlay.repoCount}/user=${overlay.userCount},`
      + ` conflicts ${overlay.conflicts.length},`
      + ` skipped-platform ${overlay.skippedPlatform.length}`
      + (overlay.conflicts.length ? ` [${overlay.conflicts.map((c) => c.file).join(', ')}]` : ''),
  });

  return {
    ok: checks.every((check) => check.ok),
    projectRoot,
    configDir: targetDir,
    stateDir: project?.stateDir || stateDirFor(projectRoot),
    detection,
    capabilities: config.capabilities,
    overlay,
    checks,
  };
}
