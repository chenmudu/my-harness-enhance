// ZCode adapter tests. Everything runs against temp dirs: a temp
// MY_HARNESS_ENHANCE_HOME (never the real ~/.my-harness-enhance), temp
// config dirs passed explicitly (never the real ~/.zcode/cli), and temp
// project roots. No test writes a real ZCode config file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeAdapter } from '../src/adapters/spec.mjs';
import {
  HARNESS_ENV_VAR,
  detectAdapter,
  getAdapter,
  listAdapters,
} from '../src/adapters/registry.mjs';
import {
  ZCODE_EVENTS,
  detectZCodeConfigDir,
  doctorZCode,
  installZCode,
  isOurHookEntry,
  mergeHooks,
  refreshZCode,
  resolveConfigDir,
  uninstallZCode,
} from '../src/adapters/zcode/install.mjs';
import { capabilitiesPath, loadConfig, saveConfig, stateDirFor } from '../src/core/config.mjs';
import { canonicalPath, enhanceHome, readRegistry } from '../src/core/state-root.mjs';
import { resolveCapabilities } from '../src/core/capabilities.mjs';
import { readArtifactIndex } from '../src/core/artifacts.mjs';
import {
  initStore,
  readGoal,
  readJobs,
  readPlan,
  readSessions,
  storePaths,
  updatePlanTask,
  upsertJob,
  upsertWorktree,
  writeBrief,
  writeGoal,
  writeLastCheck,
  writePlan,
} from '../src/core/store.mjs';
import { readGlobalConfig, writeGlobalConfig } from '../src/core/global.mjs';
import { resolveProject } from '../src/core/state-root.mjs';
import { createWorktree, removeWorktree } from '../src/core/worktree.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-zcode-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'src', 'adapters', 'zcode', 'hook.mjs');
const BUILTINS = ['Explore', 'general-purpose'];

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mhe-${name}-`));
}

// A seeded ZCode config.json exercising everything the installer must keep:
// a user-owned hook entry under the same event we use, a disabled global
// hooks flag, an unrelated MCP server, and an unrelated top-level section.
function setup({ seed = null } = {}) {
  const root = tmp('zcode-project');
  const configDir = tmp('zcode-config');
  const seeded = seed ?? {
    hooks: {
      enabled: false,
      timeoutMs: 20000,
      events: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'process', command: 'node', args: ['user-guard.mjs'], timeoutMs: 5000 }],
          },
        ],
      },
    },
    mcp: { servers: { ComfyUI: { type: 'stdio', command: 'comfy', args: [], enabled: false } } },
    plugins: { enabledPlugins: { 'some@market': true } },
  };
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    typeof seeded === 'string' ? seeded : JSON.stringify(seeded, null, 2),
  );
  return { root, configDir };
}

function readConfig(configDir) {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
}

function ourEntriesFor(config, event) {
  const entries = Array.isArray(config.hooks?.events?.[event]) ? config.hooks.events[event] : [];
  return entries.filter(isOurHookEntry);
}

function runHook(root, event, payload = {}) {
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ cwd: root, ...payload }),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function parseJson(stdout) {
  assert.ok(stdout.trim(), 'expected JSON output');
  return JSON.parse(stdout);
}

function denyOf(stdout) {
  const json = parseJson(stdout);
  return json.hookSpecificOutput?.hookEventName === 'PreToolUse'
    && json.hookSpecificOutput?.permissionDecision === 'deny';
}

function setupHookRoot() {
  const root = tmp('zcode-hook-project');
  initStore(root, {
    harness: 'zcode',
    capabilities: resolveCapabilities({ availableAgents: BUILTINS, allowFallbacks: false }),
    logging: 'errors',
  });
  return root;
}

function setupGitHookRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-zcode-repo-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'zcode@example.invalid');
  git('config', 'user.name', 'zcode test');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.js'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"zcode-fixture"}\n');
  git('add', '-A');
  git('commit', '-m', 'initial', '--quiet');
  initStore(root, {
    harness: 'zcode',
    capabilities: resolveCapabilities({ availableAgents: BUILTINS, allowFallbacks: false }),
    logging: 'errors',
  });
  return root;
}

const validEnvelope = {
  status: 'ok',
  summary: 'Task complete.',
  evidence: [{ handle: 'abc123def456', note: 'proof' }],
  artifacts: [],
  open_questions: [],
  next: 'Continue',
};

// The compensation marker every conductor Agent/Task dispatch must embed in
// its prompt (first line of the enhance_worker_contract output).
const CONTRACT = '[MY-HARNESS-ENHANCE WORKER CONTRACT]';

// --- adapter definition and registry --------------------------------------

test('zcode adapter is registered with an honest capability set', () => {
  const zcode = getAdapter('zcode');
  assert.ok(zcode);
  const description = describeAdapter(zcode);
  assert.deepEqual(description, {
    id: 'zcode',
    label: 'ZCode',
    capabilities: ['hooks', 'installer', 'mcp', 'sessionMap', 'subagents'],
    lifecycle: ['detect', 'doctor', 'install', 'refresh', 'uninstall'],
  });
  // ZCode has no SubagentStart/SubagentStop, no PreCompact event and no
  // result rewrite; this adapter writes no agent files at all (<configDir>/agents
  // is ZCode runtime session storage), and reason uses read-only compatibility.
  for (const notClaimed of [
    'resultRewrite', 'preCompact', 'overlay', 'skills',
    'modelSelection', 'statusLine', 'crossSession',
  ]) {
    assert.ok(!description.capabilities.includes(notClaimed), notClaimed);
  }
  assert.deepEqual(listAdapters().map((adapter) => adapter.id), ['qoder', 'zcode']);
});

test('zcode detection answers only on a real, existing config dir', () => {
  const { configDir } = setup();
  assert.equal(detectZCodeConfigDir({ env: { ZCODE_CONFIG_DIR: configDir } }), configDir);
  assert.equal(
    detectZCodeConfigDir({ env: {}, configDir }),
    configDir,
    'explicit argument matches',
  );

  const missing = path.join(configDir, 'nope');
  assert.equal(detectZCodeConfigDir({ env: { ZCODE_CONFIG_DIR: missing } }), false);
  assert.equal(fs.existsSync(missing), false, 'detect must not create paths');

  const fakeHome = tmp('zcode-empty-home');
  assert.equal(detectZCodeConfigDir({ env: { HOME: fakeHome, USERPROFILE: fakeHome } }), false);
  fs.mkdirSync(path.join(fakeHome, '.zcode', 'cli'), { recursive: true });
  assert.equal(
    detectZCodeConfigDir({ env: { HOME: fakeHome, USERPROFILE: fakeHome } }),
    path.join(fakeHome, '.zcode', 'cli'),
    'existing default dir is a real signal',
  );
});

test('registry routes zcode without hardcoded qoder', () => {
  const { configDir } = setup();
  assert.equal(detectAdapter({ env: { ZCODE_CONFIG_DIR: configDir } }).id, 'zcode');
  assert.equal(detectAdapter({ env: { [HARNESS_ENV_VAR]: 'ZCODE' } }).id, 'zcode');
  assert.equal(detectAdapter({ env: {}, explicit: 'zcode' }).id, 'zcode');
});

// --- installer -------------------------------------------------------------

test('install merges hooks and MCP into config.json, keeps user entries', () => {
  const { root, configDir } = setup();
  const report = installZCode({ root, configDir });

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, false);
  assert.equal(report.global, false);
  assert.ok(Array.isArray(report.changes));
  assert.ok(Array.isArray(report.warnings));
  assert.deepEqual(report.fallbackReports, [], 'no agent files installed');
  assert.equal(report.overlay, null);
  assert.ok(report.capabilities.roles.investigate.agent, 'capability plan present');
  assert.equal(report.capabilities.roles.reason.agent, 'Explore');
  assert.equal(report.capabilities.roles.reason.compatibility, 'readonly');
  assert.equal(report.stateDir, stateDirFor(root));
  assert.ok(report.stateDir.startsWith(enhanceHome()), 'state is user-level');

  const config = readConfig(configDir);
  assert.equal(config.hooks.enabled, true);
  assert.equal(config.hooks.timeoutMs, 20000, 'user timeoutMs preserved');
  for (const event of ZCODE_EVENTS) {
    const ours = ourEntriesFor(config, event);
    assert.equal(ours.length, 1, event);
    const hook = ours[0].hooks[0];
    assert.equal(hook.type, 'process');
    assert.equal(hook.command, process.execPath);
    assert.equal(hook.args[0], HOOK, 'absolute hook script path');
    assert.equal(hook.args[1], event);
    assert.equal(typeof hook.timeoutMs, 'number');
  }
  // The user's own PreToolUse guard survives alongside ours.
  const userGuard = config.hooks.events.PreToolUse.find(
    (entry) => !isOurHookEntry(entry),
  );
  assert.ok(userGuard);
  assert.equal(userGuard.hooks[0].args[0], 'user-guard.mjs');

  assert.ok(config.mcp.servers.ComfyUI, 'existing MCP server preserved');
  assert.equal(config.mcp.servers['harness-enhance'].type, 'stdio');
  assert.ok(
    config.mcp.servers['harness-enhance'].args[0].endsWith(path.join('mcp', 'recall-server.mjs')),
    'harness-neutral MCP server referenced by absolute path',
  );
  assert.equal(config.mcp.servers['harness-enhance'].env.MY_HARNESS_ENHANCE_HARNESS, 'zcode');
  assert.equal(config.mcp.servers['harness-enhance'].env.MY_HARNESS_ENHANCE_PROJECT, canonicalPath(root));
  assert.deepEqual(config.plugins, { enabledPlugins: { 'some@market': true } });

  // Core state registration, zero repo writes.
  const registry = readRegistry();
  const record = Object.values(registry.projects).find((p) => p.projectRoot === canonicalPath(root));
  assert.ok(record, 'project registered');
  const { config: state } = loadConfig(root);
  assert.equal(state.harness, 'zcode');
  assert.equal(state.capabilities.roles.investigate.agent, 'Explore');
  assert.equal(fs.existsSync(capabilitiesPath(root)), true);
  assert.deepEqual(fs.readdirSync(root), [], 'no target repo files');

  // config.json was backed up before being rewritten.
  const backups = fs.readdirSync(configDir).filter(
    (file) => file.includes('harness-enhance') && file.endsWith('.bak'),
  );
  assert.ok(backups.length >= 1, 'backup created');

  // The seed had hooks.enabled=false: uninstall must hand that back.
  assert.equal(state.zcode.hooksEnabledBefore, false);
});

test('install is idempotent', () => {
  const { root, configDir } = setup();
  installZCode({ root, configDir });
  installZCode({ root, configDir });
  const config = readConfig(configDir);
  for (const event of ZCODE_EVENTS) {
    assert.equal(ourEntriesFor(config, event).length, 1, event);
  }
  const kept = config.hooks.events.PreToolUse.filter((entry) => !isOurHookEntry(entry));
  assert.equal(kept.length, 1, 'user entry not duplicated');
  assert.deepEqual(Object.keys(config.mcp.servers).sort(), ['ComfyUI', 'harness-enhance']);

  const doctor = doctorZCode({ root, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
});

test('dry run reports the merge and writes nothing', () => {
  const { root, configDir } = setup();
  const file = path.join(configDir, 'config.json');
  const before = fs.readFileSync(file, 'utf8');
  const report = installZCode({ root, configDir, dryRun: true });

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'config untouched');
  assert.equal(report.backup, null);
  assert.equal(fs.existsSync(stateDirFor(root)), false, 'no state dir created');
  assert.equal(fs.readdirSync(root).length, 0);
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false, 'agents dir untouched');
  assert.deepEqual(report.fallbackReports, []);
  assert.ok(report.nextConfig.hooks.events.SessionStart, 'dry run shows intended config');
  assert.match(report.changes.join('\n'), /DRY RUN/);

  // And a following real install still lands cleanly.
  installZCode({ root, configDir });
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);
});

test('global install pins no workspace, leaves cwd state untouched, preserves Qoder global keys', () => {
  const { root, configDir } = setup();
  // Pretend a Qoder global install exists; zcode must not clobber it.
  writeGlobalConfig({ autoRegister: true, harness: 'qoder', configDir: 'Q:\\qoder-dir', logging: 'errors' });

  const report = installZCode({ root, configDir, global: true });
  assert.equal(report.global, true);
  assert.equal(report.mode, 'global');
  assert.equal(report.capabilities, null);
  assert.match(report.changes.join('\n'), /mode: global/);
  assert.match(report.changes.join('\n'), /global marker/);

  const config = readConfig(configDir);
  const mcp = config.mcp.servers['harness-enhance'];
  assert.equal(mcp.env.MY_HARNESS_ENHANCE_HARNESS, 'zcode');
  assert.equal(mcp.env.MY_HARNESS_ENHANCE_GLOBAL, '1');
  assert.equal(mcp.env.MY_HARNESS_ENHANCE_PROJECT, undefined, 'no fixed project in global mode');
  for (const event of ZCODE_EVENTS) {
    assert.equal(ourEntriesFor(config, event).length, 1, event);
  }
  // The cwd is NOT registered: workspaces activate on their first session.
  assert.equal(fs.existsSync(stateDirFor(root)), false);
  assert.equal(resolveProject(root), null);

  const global = readGlobalConfig();
  assert.equal(global.autoRegister, true, 'Qoder top-level keys preserved');
  assert.equal(global.harness, 'qoder');
  assert.equal(global.configDir, 'Q:\\qoder-dir');
  assert.equal(global.zcode.autoRegister, true);
  assert.equal(global.zcode.configDir, configDir);
  assert.equal(global.zcode.hooksEnabledBefore, false, 'enabled baseline recorded in the marker');
  assert.equal(global.zcode.installedAgents, undefined, 'no agent-file bookkeeping');
  // Nothing is placed under the config dir: `<configDir>/agents` is runtime
  // session storage; each workspace's plan resolves reason from the built-in
  // Explore agent with read-only compatibility at first auto-register.
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false);
});

test('global install dry run writes nothing at all', () => {
  const { root, configDir } = setup();
  const file = path.join(configDir, 'config.json');
  const before = fs.readFileSync(file, 'utf8');
  const globalFile = path.join(enhanceHome(), 'global.json');
  const beforeGlobal = fs.existsSync(globalFile) ? fs.readFileSync(globalFile, 'utf8') : null;
  const report = installZCode({ root, configDir, global: true, dryRun: true });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(report.nextConfig.mcp.servers['harness-enhance'].env.MY_HARNESS_ENHANCE_GLOBAL, '1');
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false, 'agents dir untouched');
  const afterGlobal = fs.existsSync(globalFile) ? fs.readFileSync(globalFile, 'utf8') : null;
  assert.equal(afterGlobal, beforeGlobal, 'marker not written on dry run');
});

test('uninstall removes only our hooks and MCP entries', () => {
  const { root, configDir } = setup();
  installZCode({ root, configDir });
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false, 'install wrote no agent dir');
  const report = uninstallZCode({ root, configDir });
  assert.equal(report.ok, true);
  assert.ok(report.changes.some((line) => /removed hook entry/.test(line)));
  assert.ok(report.changes.some((line) => /removed mcp server: harness-enhance/.test(line)));
  assert.ok(!report.changes.some((line) => /fallback agent/.test(line)), 'no agent-file bookkeeping');

  const config = readConfig(configDir);
  for (const event of ZCODE_EVENTS) {
    assert.equal(ourEntriesFor(config, event).length, 0, event);
  }
  const guard = config.hooks.events.PreToolUse?.find((entry) => !isOurHookEntry(entry));
  assert.ok(guard, 'user guard kept');
  assert.ok(config.mcp.servers.ComfyUI, 'user MCP server kept');
  assert.equal(config.mcp.servers['harness-enhance'], undefined);
  assert.equal(config.hooks.enabled, false, 'pre-install hooks.enabled restored');

  const registry = readRegistry();
  assert.equal(
    Object.values(registry.projects).some((p) => p.projectRoot === canonicalPath(root)),
    false,
    'project unregistered',
  );
  assert.deepEqual(fs.readdirSync(root), [], 'no target repo files');
});

test('uninstall on a machine that never had our entries is a safe no-op', () => {
  const { root, configDir } = setup();
  const before = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
  const report = uninstallZCode({ root, configDir });
  assert.equal(report.ok, true);
  assert.equal(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), before);
});

test('corrupt config.json is refused, never overwritten', () => {
  const { root, configDir } = setup({ seed: '{not json' });
  assert.throws(() => installZCode({ root, configDir }), /not valid JSON, refusing/);
  assert.equal(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'), '{not json');
});

test('mergeHooks on an empty config creates the documented shape', () => {
  const config = mergeHooks({});
  assert.equal(config.hooks.enabled, true);
  for (const event of ZCODE_EVENTS) {
    assert.equal(config.hooks.events[event].length, 1);
    assert.equal(config.hooks.events[event][0].hooks[0].type, 'process');
  }
  assert.equal(resolveConfigDir(null, { HOME: '/x' }), path.resolve('/x', '.zcode', 'cli'));
});

test('reason resolves to Explore with read-only compatibility; no agent files written', () => {
  const { root, configDir } = setup();
  const report = installZCode({ root, configDir });

  const role = report.capabilities.roles.reason;
  assert.equal(role.agent, 'Explore');
  assert.equal(role.compatibility, 'readonly', 'labeled substitution, not a claim of no-tools');
  assert.equal(role.policy, 'readonly');
  assert.equal(role.output, 'analysis');
  assert.equal(role.unresolved, false);
  assert.ok(report.capabilities.allowedSubagents.includes('Explore'));
  assert.equal(report.capabilities.agents.Explore.kind, 'readonly');
  assert.match(
    report.changes.join('\n'),
    /capability compatibility: reason -> Explore \(read-only compatibility; ZCode has no no-tools agent\)/,
  );
  assert.ok(!report.warnings.join('\n').includes('capability gaps'), 'reason is resolved');

  // The compatibility role is persisted in the plan file the hook reads.
  assert.match(fs.readFileSync(capabilitiesPath(root), 'utf8'), /"compatibility": "readonly"/);

  // ZCode config dir gains ONLY config.json (plus backups): `<configDir>/agents`
  // is runtime subagent session storage and never receives adapter files.
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false);
  const extras = fs.readdirSync(configDir).filter((name) => !name.startsWith('config.json'));
  assert.deepEqual(extras, []);

  const doctor = doctorZCode({ root, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
  assert.ok(!doctor.checks.some((check) => check.name === 'fallback agents'));
  const roles = doctor.checks.find((check) => check.name === 'capability roles');
  assert.match(roles.detail, /compatibility: reason -> Explore/);
});

test('install/uninstall/refresh never create or delete agent files and never scan runtime storage', () => {
  const { root, configDir } = setup();
  installZCode({ root, configDir });
  // Simulate ZCode's own runtime content in agents/: lifecycle operations
  // must leave it exactly as found.
  const runtimeDir = path.join(configDir, 'agents', 'sess_runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeFile = path.join(runtimeDir, 'state.json');
  fs.writeFileSync(runtimeFile, '{"keep":true}');

  uninstallZCode({ root, configDir });
  assert.equal(fs.readFileSync(runtimeFile, 'utf8'), '{"keep":true}', 'runtime storage untouched');
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), false);

  const refreshed = refreshZCode({ root, configDir });
  assert.equal(refreshed.projectRoot, canonicalPath(root));
  assert.equal(refreshed.stateDir, stateDirFor(root));
  assert.ok(refreshed.capabilities, 'report shape matches bin/refresh');
  // agents/ is not a definitions dir: nothing under it is detected as an agent.
  assert.deepEqual(refreshed.detection.user, []);
  assert.equal(refreshed.capabilities.roles.reason.agent, 'Explore');
  assert.equal(refreshed.capabilities.roles.reason.compatibility, 'readonly');
  assert.equal(loadConfig(root).config.capabilities.roles.reason.agent, 'Explore');
  assert.equal(fs.readFileSync(runtimeFile, 'utf8'), '{"keep":true}', 'refresh untouched it too');
});

test('doctor reports the expected shape', () => {
  const { root, configDir } = setup();
  installZCode({ root, configDir });
  const doctor = doctorZCode({ root, configDir });
  assert.equal(doctor.ok, true);
  assert.equal(typeof doctor.configDir, 'string');
  assert.equal(typeof doctor.stateDir, 'string');
  assert.ok(Array.isArray(doctor.checks));
  for (const check of doctor.checks) {
    assert.equal(typeof check.ok, 'boolean', check.name);
    assert.equal(typeof check.name, 'string');
    assert.equal(typeof check.detail, 'string');
  }
  const names = doctor.checks.map((check) => check.name);
  for (const required of ['zcode config', 'hooks enabled', 'mcp server', 'project registered']) {
    assert.ok(names.includes(required), required);
  }
});

// --- hook behaviour ---------------------------------------------------------

// The global marker lives in the shared temp MY_HARNESS_ENHANCE_HOME and
// persists across tests in this file; tests that require project-scoped
// dormancy must neutralize it first.
function disableGlobalMarker() {
  const marker = readGlobalConfig().zcode || {};
  if (marker.autoRegister === true) {
    writeGlobalConfig({ zcode: { ...marker, autoRegister: false } });
  }
}

test('hook is dormant for unregistered projects', () => {
  disableGlobalMarker();
  const root = tmp('zcode-unregistered');
  const started = runHook(root, 'SessionStart', { source: 'startup' });
  assert.equal(started.stdout.trim(), '');
  assert.equal(started.status, 0);
  assert.equal(fs.existsSync(storePaths(root).dir), false, 'no state created');
});

test('SessionStart marks the conductor session and injects policy as JSON', () => {
  const root = setupHookRoot();
  const result = runHook(root, 'SessionStart', {
    session_id: 'sess-1',
    source: 'startup',
    model: 'zcode-model',
  });
  assert.equal(result.status, 0);
  const json = parseJson(result.stdout);
  assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(json.hookSpecificOutput.additionalContext, /MY-HARNESS-ENHANCE CONDUCTOR/);
  assert.match(json.hookSpecificOutput.additionalContext, /WORKERS/);
  assert.equal(readSessions(root).sessions['sess-1'].role, 'conductor');

  // resume also marks; compact re-injects the capsule WITHOUT the policy
  // (no PreCompact event exists in ZCode; this is capsule injection only).
  runHook(root, 'SessionStart', { session_id: 'sess-2', source: 'resume' });
  assert.equal(readSessions(root).sessions['sess-2'].role, 'conductor');
  assert.equal(readSessions(root).sessions['sess-2'].source, 'resume');

  const compact = runHook(root, 'SessionStart', { session_id: 'sess-1', source: 'compact' });
  const compactJson = parseJson(compact.stdout);
  assert.match(compactJson.hookSpecificOutput.additionalContext, /MY-HARNESS-ENHANCE CAPSULE/);
  assert.ok(
    !compactJson.hookSpecificOutput.additionalContext.includes('[MY-HARNESS-ENHANCE CONDUCTOR]'),
    'compact injection carries the capsule, not a compaction-hook claim',
  );
});

test('subagent SessionStart stays silent and never marks the main role', () => {
  const root = setupHookRoot();
  const result = runHook(root, 'SessionStart', { agent_type: 'Explore', source: 'startup' });
  assert.equal(result.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(root).session), false);
});

test('UserPromptSubmit sets the goal and injects the capsule as JSON', () => {
  const root = setupHookRoot();
  const result = runHook(root, 'UserPromptSubmit', { prompt: 'Add a health endpoint.' });
  const json = parseJson(result.stdout);
  assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(json.hookSpecificOutput.additionalContext, /CAPSULE/);
  assert.equal(readGoal(root).text, 'Add a health endpoint.');
});

test('conductor PreToolUse enforces the allowlist', () => {
  const root = setupHookRoot();
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'TodoWrite', 'Skill']) {
    const denied = runHook(root, 'PreToolUse', { tool_name: tool, tool_input: {} });
    assert.equal(denyOf(denied.stdout), true, tool);
  }
  writeBrief(root, { profile: 'general', checks: [] });
  for (const agent of BUILTINS) {
    const allowed = runHook(root, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: { subagent_type: agent, prompt: `look around. ${CONTRACT}` },
    });
    assert.equal(allowed.stdout.trim(), '', agent);
  }
  const unlisted = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Plan' },
  });
  assert.equal(denyOf(unlisted.stdout), true);

  // A registered agent without the embedded contract is denied.
  const noContract = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'just look around' },
  });
  assert.equal(denyOf(noContract.stdout), true);
  assert.match(noContract.stdout, /enhance_worker_contract/);

  const ask = runHook(root, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
  assert.equal(ask.stdout.trim(), '');
  const mcp = runHook(root, 'PreToolUse', {
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: {},
  });
  assert.equal(mcp.stdout.trim(), '');

  // Only marked sessions are enforced: another session id is left alone.
  runHook(root, 'SessionStart', { session_id: 'sess-main', source: 'startup' });
  const other = runHook(root, 'PreToolUse', {
    session_id: 'sess-other',
    tool_name: 'Bash',
    tool_input: {},
  });
  assert.equal(other.stdout.trim(), '');
});

test('worker PreToolUse enforces native agent policies', () => {
  const root = setupHookRoot();

  const exploreWrite = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Write',
    tool_input: { file_path: 'x' },
  });
  assert.equal(denyOf(exploreWrite.stdout), true, 'Explore is read-only');
  const exploreRead = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Read',
    tool_input: {},
  });
  assert.equal(exploreRead.stdout.trim(), '');

  for (const agent of BUILTINS) {
    const nested = runHook(root, 'PreToolUse', {
      agent_type: agent,
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' },
    });
    assert.equal(denyOf(nested.stdout), true, `${agent} may not spawn agents`);
  }

  const gpBash = runHook(root, 'PreToolUse', {
    agent_type: 'general-purpose',
    tool_name: 'Bash',
    tool_input: {},
  });
  assert.equal(gpBash.stdout.trim(), '');

  const unknown = runHook(root, 'PreToolUse', {
    agent_type: 'some-other-agent',
    tool_name: 'Bash',
    tool_input: {},
  });
  assert.equal(unknown.stdout.trim(), '');
});

test('conductor PostToolUse records the agent job without rewriting the result', () => {
  const root = setupHookRoot();
  writePlan(root, [{ id: 'T1', title: 'translate', status: 'in_progress' }]);
  const result = runHook(root, 'PostToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: `Prose before.\n${JSON.stringify({
      ...validEnvelope,
      task_id: 'T1',
      check_result: { ok: true, checker: 'docs', findings: 0 },
    })}\nProse after.`,
  });
  // No result rewrite exists in ZCode: the hook must emit nothing at all.
  assert.equal(result.stdout.trim(), '');

  const jobs = readJobs(root).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'Explore');
  assert.equal(jobs[0].status, 'ok');
  assert.equal(jobs[0].recorded_by, 'zcode-post-tool-use');
  assert.ok(jobs[0].result_handle);
  assert.ok(readArtifactIndex(root).artifacts[jobs[0].result_handle]);
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'in_progress');

  const bad = runHook(root, 'PostToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose' },
    tool_response: 'long prose without JSON '.repeat(200),
  });
  assert.equal(bad.stdout.trim(), '');
  const invalid = readJobs(root).jobs.find((job) => job.status === 'invalid_result');
  assert.ok(invalid);
  assert.equal(invalid.retryable, true);
  assert.match(invalid.envelope.summary, /INVALID_WORKER_RESULT/);
});

test('large worker tool output is captured as an artifact, output untouched', () => {
  const root = setupHookRoot();
  const result = runHook(root, 'PostToolUse', {
    agent_type: 'general-purpose',
    tool_name: 'Read',
    tool_response: 'x'.repeat(20000),
  });
  assert.equal(result.stdout.trim(), '', 'no rewrite channel in ZCode');
  const artifacts = Object.values(readArtifactIndex(root).artifacts);
  assert.ok(artifacts.some((artifact) => artifact.kind === 'tool-output'));
});

test('conductor cannot dispatch a verification worker before the deterministic check', () => {
  const root = setupHookRoot();
  upsertJob(root, 'job_done', {
    status: 'ok',
    task_id: 'T1',
    type: 'general-purpose',
    updated_at: new Date().toISOString(),
  });
  const before = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Verify translation parity',
      prompt: 'verify the translation',
    },
  });
  assert.equal(denyOf(before.stdout), true);
  assert.match(parseJson(before.stdout).hookSpecificOutput.permissionDecisionReason, /enhance_check/);

  writeLastCheck(root, {
    ok: false,
    checked: ['docs'],
    findings: [{ level: 'blocker', rule: 'checker.unknown', message: 'unknown checker: docs_parity' }],
    summary: { blockers: 1, warnings: 0, infos: 0 },
    at: new Date(Date.now() + 1000).toISOString(),
  });
  const misconfigured = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Verify translation parity',
      prompt: 'verify the translation again',
    },
  });
  assert.equal(denyOf(misconfigured.stdout), true);
  assert.match(
    parseJson(misconfigured.stdout).hookSpecificOutput.permissionDecisionReason,
    /misconfigured/,
  );

  writeLastCheck(root, {
    ok: true,
    checked: ['docs', 'inputs'],
    findings: [],
    summary: { blockers: 0, warnings: 0, infos: 0 },
    at: new Date(Date.now() + 2000).toISOString(),
  });
  const after = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Independent review',
      prompt: `verify the translation one more time\n${CONTRACT}`,
    },
  });
  assert.equal(after.stdout.trim(), '', 'an intentional audit after a passing check is allowed');
});

test('harness MCP project arguments are locked to the session root', () => {
  const root = setupHookRoot();
  const sessionRoot = canonicalPath(root);
  const outside = tmp('zcode-outside');

  const denied = runHook(root, 'PreToolUse', {
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: outside },
  });
  assert.equal(denyOf(denied.stdout), true);
  const reason = parseJson(denied.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /project mismatch/);
  assert.match(reason, /never copy a workspace path from GOAL\/notes/);
  assert.ok(reason.includes(sessionRoot), reason);

  const gateway = runHook(root, 'PreToolUse', {
    tool_name: 'mcp_get',
    tool_input: {
      toolName: 'mcp__harness_enhance__enhance_state',
      arguments: { project: outside },
    },
  });
  assert.equal(denyOf(gateway.stdout), true);
  assert.match(
    parseJson(gateway.stdout).hookSpecificOutput.permissionDecisionReason,
    /project mismatch/,
  );

  const exact = runHook(root, 'PreToolUse', {
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: sessionRoot },
  });
  assert.equal(exact.stdout.trim(), '', 'the session root itself is allowed');

  const nested = runHook(root, 'PreToolUse', {
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: path.join(sessionRoot, 'packages', 'core') },
  });
  assert.equal(nested.stdout.trim(), '', 'a path inside the session root is allowed');
});

test('verification gate only fires on explicit verify intent, not audit/investigate', () => {
  const root = setupHookRoot();
  upsertJob(root, 'job_done', {
    status: 'ok',
    task_id: 'T1',
    type: 'general-purpose',
    updated_at: new Date().toISOString(),
  });
  // A pasted worker contract and ordinary follow-up work mention "audit"
  // or "self-review"; they must not trip the verification-worker gate.
  for (const prompt of [
    `audit the changed files. ${CONTRACT}`,
    `investigate the flaky test. ${CONTRACT}`,
  ]) {
    const allowed = runHook(root, 'PreToolUse', {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt },
    });
    assert.equal(allowed.stdout.trim(), '', prompt);
  }
});

test('Stop writes the capsule for the conductor session', () => {
  const root = setupHookRoot();
  writeGoal(root, { text: 'Ship the endpoint' });
  const result = runHook(root, 'Stop', {});
  assert.equal(result.stdout.trim(), '');
  const file = storePaths(root).capsule;
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /Ship the endpoint/);
});

test('Stop requests continuation while a code worktree is unlanded', () => {
  const root = setupGitHookRoot();
  writeBrief(root, { profile: 'code', checks: ['scope'] });
  writePlan(root, [{ id: 'T1', title: 'change app', status: 'in_progress' }], { replace: true });
  const created = createWorktree(root, 'T1');
  assert.equal(created.ok, true, created.blocker);
  fs.writeFileSync(path.join(created.path, 'src/app.js'), 'export const v = 2;\n');

  const blocked = parseJson(runHook(root, 'Stop', {}).stdout);
  assert.equal(blocked.continue, true);
  assert.match(blocked.additionalContext, /not landed/);
  assert.match(blocked.additionalContext, /T1/);

  execFileSync('git', ['-C', created.path, 'reset', '--hard'], { stdio: 'ignore' });
  const removed = removeWorktree(root, 'T1');
  assert.equal(removed.ok, true, removed.blocker);
  assert.equal(runHook(root, 'Stop', {}).stdout.trim(), '');
});

test('disabled layer is a no-op', () => {
  const root = setupHookRoot();
  saveConfig(root, { enabled: false });
  const started = runHook(root, 'SessionStart', { source: 'startup' });
  assert.equal(started.stdout.trim(), '');
  const bash = runHook(root, 'PreToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(bash.stdout.trim(), '');
});

// --- dispatch dependency gate (Task 1, mirrors Qoder semantics) ------------

test('dispatch gate enforces task_id and dependencies for code briefs', () => {
  const root = setupHookRoot();
  writeBrief(root, { profile: 'code' });
  writePlan(root, [
    { id: 'T1', title: 'api', status: 'completed' },
    { id: 'T2', title: 'ui', status: 'pending', depends_on: ['T1', 'T9'] },
    { id: 'T3', title: 'tests', status: 'pending', depends_on: ['T1'] },
  ]);

  const noId = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'do the ui work' },
  });
  assert.equal(denyOf(noId.stdout), true, 'missing task_id denied');
  assert.match(noId.stdout, /must include task_id/);

  const unknown = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'task_id: T42' },
  });
  assert.equal(denyOf(unknown.stdout), true, 'unknown task denied');
  assert.match(unknown.stdout, /not in the plan/);

  const blocked = runHook(root, 'PreToolUse', {
    tool_name: 'Task',
    tool_input: { agent: 'Explore', description: 'ui. task_id = T2' },
  });
  assert.equal(denyOf(blocked.stdout), true, 'unmet deps denied');
  assert.match(blocked.stdout, /dependencies not completed: T9\(missing\)/);

  upsertWorktree(root, 'T3', {
    task_id: 'T3',
    path: 'C:\\mhe-worktrees\\T3',
    status: 'active',
  });
  const allowed = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      prompt: `tests first. task_id: T3\nworktree: C:\\mhe-worktrees\\T3\n${CONTRACT}`,
    },
  });
  assert.equal(allowed.stdout.trim(), '', 'deps satisfied + exact worktree + contract -> allow');

  const wrongWorktree = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      prompt: `tests first. task_id: T3\nworktree: C:\\mhe-worktrees\\T9\n${CONTRACT}`,
    },
  });
  assert.equal(denyOf(wrongWorktree.stdout), true, 'wrong worktree path denied');
  assert.match(wrongWorktree.stdout, /worktree path mismatch/);

  updatePlanTask(root, 'T3', { status: 'completed' });
  writeLastCheck(root, {
    ok: true,
    task_ids: ['T3'],
    worktree: 'C:\\mhe-worktrees\\T3',
    checked: ['scope'],
    summary: { blockers: 0, warnings: 0, infos: 0 },
  });
  const verified = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      prompt: `review it. task_id: T3\nworktree: C:\\mhe-worktrees\\T3\n${CONTRACT}`,
    },
  });
  assert.equal(denyOf(verified.stdout), true, 'verified task cannot dispatch another worker');
  assert.match(verified.stdout, /already verified/);
});

test('dispatch gate ignores non-code briefs, absent briefs, workers and other tools', () => {
  const root = setupHookRoot();

  const noBrief = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `no task id here. ${CONTRACT}` },
  });
  assert.equal(noBrief.stdout.trim(), '', 'no brief: dispatch gate off');

  writeBrief(root, { profile: 'docs' });
  const docs = runHook(root, 'PreToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `no task id here. ${CONTRACT}` },
  });
  assert.equal(docs.stdout.trim(), '', 'non-code profile: dispatch gate off');

  writeBrief(root, { profile: 'code' });
  const worker = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Read',
    tool_input: {},
  });
  assert.equal(worker.stdout.trim(), '', 'worker events unaffected');

  const state = runHook(root, 'PreToolUse', {
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: {},
  });
  assert.equal(state.stdout.trim(), '', 'enhance MCP unaffected');

  const bash = runHook(root, 'PreToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(denyOf(bash.stdout), true);
  assert.match(bash.stdout, /must not execute/, 'base deny, not gate deny');
});

// --- SubagentStart/Stop compensation ----------------------------------------

test('contract gate records a synthetic running job; PostToolUse completes it', () => {
  const root = setupHookRoot();
  runHook(root, 'SessionStart', { session_id: 's9', source: 'startup' });

  const denied = runHook(root, 'PreToolUse', {
    session_id: 's9',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'look around' },
  });
  assert.equal(denyOf(denied.stdout), true);
  assert.match(denied.stdout, /enhance_worker_contract/);
  assert.equal(readJobs(root).jobs.length, 0, 'a denied dispatch records no job');

  const allowed = runHook(root, 'PreToolUse', {
    session_id: 's9',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `task_id: T1\n${CONTRACT}` },
  });
  assert.equal(allowed.stdout.trim(), '');
  const running = readJobs(root).jobs;
  assert.equal(running.length, 1);
  assert.equal(running[0].status, 'running');
  assert.equal(running[0].type, 'Explore');
  assert.equal(running[0].task_id, 'T1');
  assert.equal(running[0].session_id, 's9');
  assert.equal(running[0].agent_id, '', 'synthetic: ZCode exposes no real agent id');
  assert.equal(running[0].recorded_by, 'zcode-pre-tool-use');
  assert.match(running[0].role, /investigate/);

  writePlan(root, [{ id: 'T1', title: 'scan', status: 'in_progress' }]);
  const done = runHook(root, 'PostToolUse', {
    session_id: 's9',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: JSON.stringify({
      ...validEnvelope,
      task_id: 'T1',
      check_result: { ok: true, checker: 'docs', findings: 0 },
    }),
  });
  assert.equal(done.stdout.trim(), '', 'no result rewrite exists in ZCode');
  const jobs = readJobs(root).jobs;
  assert.equal(jobs.length, 1, 'the running job was completed, not duplicated');
  assert.equal(jobs[0].id, running[0].id);
  assert.equal(jobs[0].status, 'ok');
  assert.equal(jobs[0].recorded_by, 'zcode-pre-tool-use', 'original provenance kept');
  assert.equal(jobs[0].finished_by, 'zcode-post-tool-use');
  assert.ok(jobs[0].result_handle);
  assert.ok(readArtifactIndex(root).artifacts[jobs[0].result_handle]);
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'in_progress');
});

test('an invalid Agent result marks the matched job invalid_result and retryable', () => {
  const root = setupHookRoot();
  runHook(root, 'SessionStart', { session_id: 's8', source: 'startup' });
  runHook(root, 'PreToolUse', {
    session_id: 's8',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `probe. ${CONTRACT}` },
  });
  const bad = runHook(root, 'PostToolUse', {
    session_id: 's8',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: 'prose only, no envelope',
  });
  assert.equal(bad.stdout.trim(), '');
  const job = readJobs(root).jobs[0];
  assert.equal(job.status, 'invalid_result');
  assert.equal(job.retryable, true);
  assert.match(job.envelope.summary, /INVALID_WORKER_RESULT/);
  assert.ok(job.result_handle, 'raw result still stored as an artifact');
});

test('parallel same-type dispatches complete FIFO without losing either result', () => {
  const root = setupHookRoot();
  runHook(root, 'SessionStart', { session_id: 's7', source: 'startup' });
  writePlan(root, [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }]);
  for (const id of ['A', 'B']) {
    const call = runHook(root, 'PreToolUse', {
      session_id: 's7',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: `task_id: ${id} ${CONTRACT}` },
    });
    assert.equal(call.stdout.trim(), '', id);
  }
  assert.equal(readJobs(root).jobs.filter((job) => job.status === 'running').length, 2);

  for (const id of ['A', 'B']) {
    const done = runHook(root, 'PostToolUse', {
      session_id: 's7',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore' },
      tool_response: JSON.stringify({ ...validEnvelope, task_id: id }),
    });
    assert.equal(done.stdout.trim(), '');
  }

  const jobs = readJobs(root).jobs;
  assert.equal(jobs.length, 2, 'both dispatches bookkept');
  assert.ok(jobs.every((job) => job.status !== 'running'));
  assert.equal(jobs[0].task_id, 'A', 'FIFO: the oldest running job matched first');
  assert.equal(jobs[1].task_id, 'B');
});

test('session scoping: a dispatch result from another session does not hijack the job', () => {
  const root = setupHookRoot();
  runHook(root, 'SessionStart', { session_id: 'mine', source: 'startup' });
  runHook(root, 'SessionStart', { session_id: 'other', source: 'startup' });
  runHook(root, 'PreToolUse', {
    session_id: 'mine',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: `work. ${CONTRACT}` },
  });
  runHook(root, 'PostToolUse', {
    session_id: 'other',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: JSON.stringify(validEnvelope),
  });
  const jobs = readJobs(root).jobs;
  assert.equal(jobs.length, 2, 'unmatched session created its own completed job');
  assert.equal(jobs[0].status, 'running', 'the other session stays untouched');
});

// --- global mode (Task 2) ---------------------------------------------------

test('global mode auto-registers new workspaces, never retrofit or compact, restores on uninstall', () => {
  const { root, configDir } = setup();
  installZCode({ root, configDir, global: true });

  const ws = tmp('zcode-global-ws');
  // PreToolUse in an unregistered workspace: no retrofit, no registration.
  const pre = runHook(ws, 'PreToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(pre.stdout.trim(), '', 'existing/other events never register');
  assert.equal(fs.existsSync(storePaths(ws).dir), false);

  // Doctor tolerates the unregistered cwd while the marker is on.
  const doctor = doctorZCode({ root: ws, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
  assert.ok(doctor.checks.some(
    (check) => check.name === 'zcode global mode' && /auto-register on/.test(check.detail),
  ));

  // A new SessionStart activates the workspace.
  const started = runHook(ws, 'SessionStart', { source: 'startup', session_id: 'g1' });
  assert.match(started.stdout, /MY-HARNESS-ENHANCE CONDUCTOR/);
  const registered = resolveProject(ws);
  assert.ok(registered, 'workspace auto-registered');
  const { config } = loadConfig(ws);
  assert.equal(config.harness, 'zcode');
  assert.equal(config.capabilities.roles.investigate.agent, 'Explore');
  // The shared capability plan applies to auto-registered workspaces too:
  // reason -> Explore under read-only compatibility.
  assert.equal(config.capabilities.roles.reason.agent, 'Explore');
  assert.equal(config.capabilities.roles.reason.compatibility, 'readonly');
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false, 'auto-register wrote no agent files');
  assert.equal(readSessions(ws).sessions.g1.role, 'conductor');
  assert.equal(fs.readdirSync(ws).length, 0, 'no repo writes');

  // The conductor policy now applies inside the workspace.
  const bash = runHook(ws, 'PreToolUse', { session_id: 'g1', tool_name: 'Bash', tool_input: {} });
  assert.equal(denyOf(bash.stdout), true);

  // Compact source in an unregistered workspace does NOT auto-register.
  const ws2 = tmp('zcode-global-ws2');
  const compact = runHook(ws2, 'SessionStart', { source: 'compact' });
  assert.equal(compact.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(ws2).dir), false);

  // System/home dirs stay excluded even in global mode.
  const home = runHook(os.homedir(), 'SessionStart', { source: 'startup', cwd: os.homedir() });
  assert.equal(home.stdout.trim(), '', 'home dir excluded');

  // Uninstall clears only the zcode marker; Qoder global keys survive.
  writeGlobalConfig({ autoRegister: true, harness: 'qoder', configDir: 'Q:\\qoder-dir' });
  const report = uninstallZCode({ root, configDir, global: true });
  assert.match(report.changes.join('\n'), /disabled zcode global auto-register marker/);
  assert.equal(readGlobalConfig().autoRegister, true, 'Qoder auto-register preserved');
  assert.equal(readGlobalConfig().harness, 'qoder');
  assert.equal(readGlobalConfig().zcode.autoRegister, false);

  const finalConfig = readConfig(configDir);
  for (const event of ZCODE_EVENTS) {
    assert.equal(ourEntriesFor(finalConfig, event).length, 0, event);
  }
  assert.equal(finalConfig.hooks.enabled, false, 'enabled baseline restored from the marker');
  assert.equal(fs.existsSync(path.join(configDir, 'agents')), false, 'no agent files ever existed to remove');

  // With the marker off, new workspaces are dormant again.
  const ws3 = tmp('zcode-global-ws3');
  const after = runHook(ws3, 'SessionStart', { source: 'startup' });
  assert.equal(after.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(ws3).dir), false);
});

test('project-scoped install stays dormant outside its project even when a global marker exists', () => {
  // A pinned project install must not leak activation into other workspaces:
  // dormancy depends on the marker, which a prior global install owns.
  disableGlobalMarker();
  const { root, configDir } = setup();
  installZCode({ root, configDir });
  const other = tmp('zcode-outside-ws');
  const started = runHook(other, 'SessionStart', { source: 'startup' });
  assert.equal(started.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(other).dir), false);
});
