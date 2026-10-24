import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  doctorQoder,
  hookCommand,
  installQoder,
  mergeHooks,
  mergeMcp,
  refreshCapabilities,
  syncCapabilities,
  uninstallQoder,
} from '../src/adapters/qoder/install.mjs';
import { capabilitiesPath, loadConfig, stateDirFor } from '../src/core/config.mjs';
import { canonicalPath, enhanceHome, readRegistry } from '../src/core/state-root.mjs';
import { readGlobalConfig } from '../src/core/global.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-install-home-'),
);

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mhe-${name}-`));
}

function writeAgent(configDir, name, tools = '*') {
  const dir = path.join(configDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: test agent\nmodel: qfmodel\ntools: ${tools}\n---\n`,
  );
}

function setup({ withUsers = true, withLegacy = true } = {}) {
  const root = tmp('root');
  const configDir = tmp('qoder');
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '"node" "old-hook.mjs"', timeout: 10 }],
          },
        ],
      },
      mcpServers: {
        Existing: { command: 'existing', args: [] },
        'harness-router': { command: 'legacy', args: [] },
      },
    }, null, 2),
  );
  if (withUsers) {
    writeAgent(configDir, 'env-runner');
    writeAgent(configDir, 'reasoner', '[]');
  }
  if (withLegacy) writeAgent(configDir, 'hr-router');
  return { root, configDir };
}

test('hookCommand points at the new hook script with an event argument', () => {
  const command = hookCommand('PreToolUse', 'C:\\Program Files\\nodejs\\node.exe');
  assert.match(command, /hook\.mjs/);
  assert.match(command, /PreToolUse/);
  assert.match(command, /my-harness-enhance/);
});

test('mergeHooks preserves existing hooks and replaces ours idempotently', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: '"node" "old.mjs"' }] }],
    },
  };
  mergeHooks(settings, { timeout: 15 });
  mergeHooks(settings, { timeout: 15 });
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 2);
  assert.equal(
    entries.filter((entry) => entry.hooks?.some((hook) => hook.command.includes('hook.mjs') && hook.command.includes('harness-enhance'))).length,
    1,
  );
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.SubagentStop);
});

test('mergeMcp preserves existing servers, drops the legacy name, and adds ours', () => {
  const settings = {
    mcpServers: {
      Existing: { command: 'existing' },
      'harness-router': { command: 'legacy' },
    },
  };
  const projectRoot = path.join(os.tmpdir(), 'mhe-mcp-project');
  mergeMcp(settings, { root: projectRoot, serverName: 'harness-enhance' });
  assert.ok(settings.mcpServers.Existing);
  assert.equal(settings.mcpServers['harness-router'], undefined);
  assert.equal(settings.mcpServers['harness-enhance'].type, 'stdio');
  assert.ok(settings.mcpServers['harness-enhance'].args[0].endsWith('recall-server.mjs'));
  assert.equal(
    settings.mcpServers['harness-enhance'].env.MY_HARNESS_ENHANCE_PROJECT,
    canonicalPath(projectRoot),
  );
});

test('dry-run reports native reuse without writing settings, agents, or state', () => {
  const { root, configDir } = setup();
  const settingsFile = path.join(configDir, 'settings.json');
  const before = fs.readFileSync(settingsFile, 'utf8');
  const report = installQoder({ root, configDir, dryRun: true });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.capabilities.fallbacksToInstall, ['mhe-reasoner']);
  assert.equal(report.capabilities.roles.execute.agent, 'general-purpose');
  assert.equal(report.capabilities.roles.reason.agent, 'mhe-reasoner');
  assert.equal(report.capabilities.roles.investigate.agent, 'Explore');
  assert.ok(report.nextSettings.hooks.SessionStart);
  assert.ok(report.nextSettings.mcpServers['harness-enhance']);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), false);
  assert.equal(fs.existsSync(stateDirFor(root)), false);
});

test('auto install reuses native agents and never writes into the repo', () => {
  const { root, configDir } = setup();
  const report = installQoder({ root, configDir });
  assert.equal(report.mode, 'auto');
  assert.deepEqual(report.capabilities.fallbacksToInstall, ['mhe-reasoner']);
  assert.equal(report.capabilities.roles.execute.agent, 'general-purpose');
  assert.equal(report.capabilities.roles.write.agent, 'general-purpose');
  assert.equal(report.capabilities.roles.verify_run.agent, 'general-purpose');
  assert.equal(report.capabilities.roles.reason.agent, 'mhe-reasoner');
  assert.equal(report.capabilities.roles.lead.agent, 'general-purpose');
  assert.ok(report.legacyAgents.includes('hr-router.md'));
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'hr-router.md')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'env-runner.md')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'reasoner.md')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), true);

  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'PreCompact', 'Stop']) {
    assert.ok(Array.isArray(settings.hooks[event]), event);
    assert.ok(
      settings.hooks[event].some((entry) => entry.hooks?.some((hook) => hook.command.includes('hook.mjs') && hook.command.includes(event))),
      event,
    );
  }
  assert.ok(settings.hooks.PreToolUse.some((entry) => entry.hooks?.some((hook) => hook.command.includes('old-hook.mjs'))));
  assert.ok(settings.mcpServers.Existing);
  assert.equal(settings.mcpServers['harness-router'], undefined);
  assert.ok(settings.mcpServers['harness-enhance']);

  const { config } = loadConfig(root);
  assert.equal(config.conductor.auto, true);
  assert.equal(config.capabilities.roles.execute.agent, 'general-purpose');
  assert.equal(fs.existsSync(capabilitiesPath(root)), true);

  const stateDir = stateDirFor(root);
  assert.ok(stateDir.startsWith(enhanceHome()));
  assert.equal(fs.existsSync(path.join(root, '.router')), false);
  const registry = readRegistry();
  assert.ok(Object.values(registry.projects).some((project) => project.projectRoot === root));

  const doctor = doctorQoder({ root, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
});

test('missing reasoner installs only the mhe-reasoner fallback', () => {
  const { root, configDir } = setup({ withUsers: false });
  const report = installQoder({ root, configDir });
  assert.deepEqual(report.capabilities.fallbacksToInstall, ['mhe-reasoner']);
  assert.equal(report.capabilities.roles.reason.agent, 'mhe-reasoner');
  assert.equal(report.capabilities.roles.execute.agent, 'general-purpose');
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'env-runner.md')), false);
  const { config } = loadConfig(root);
  assert.equal(config.capabilities.roles.reason.agent, 'mhe-reasoner');
});

test('legacy .router is migrated out of the repo', () => {
  const { root, configDir } = setup();
  const legacy = path.join(root, '.router');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'goal.json'), JSON.stringify({ text: 'legacy goal' }));
  const report = installQoder({ root, configDir });
  assert.equal(fs.existsSync(legacy), false);
  assert.ok(report.legacyState);
  assert.ok(fs.existsSync(path.join(report.legacyState, 'goal.json')));
});

test('install is idempotent', () => {
  const { root, configDir } = setup();
  installQoder({ root, configDir });
  installQoder({ root, configDir });
  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'PreToolUse', 'SubagentStop']) {
    const ours = settings.hooks[event].filter((entry) =>
      entry.hooks?.some((hook) => hook.command.includes('hook.mjs') && hook.command.includes('harness-enhance')));
    assert.equal(ours.length, 1, event);
  }
  const doctor = doctorQoder({ root, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
});

test('global install enables auto-registration for any workspace', () => {
  const { root, configDir } = setup();
  const report = installQoder({ root, configDir, global: true });
  assert.equal(report.global, true);
  assert.equal(report.capabilities, null);
  assert.match(report.changes.join('\n'), /mode: global/);
  const global = readGlobalConfig();
  assert.equal(global.autoRegister, true);
  assert.equal(global.configDir, configDir);

  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  assert.equal(settings.mcpServers['harness-enhance'].env.MY_HARNESS_ENHANCE_GLOBAL, '1');
  assert.equal(settings.mcpServers['harness-enhance'].env.MY_HARNESS_ENHANCE_PROJECT, undefined);

  const doctor = doctorQoder({ root, configDir });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks, null, 2));
});

test('global uninstall removes the auto-register config', () => {
  const { root, configDir } = setup();
  installQoder({ root, configDir, global: true });
  const report = uninstallQoder({ root, configDir, global: true });
  assert.match(report.changes.join('\n'), /removed global auto-register config/);
  assert.equal(readGlobalConfig().autoRegister, false);
});

test('uninstall removes our hooks, MCP, and agents but keeps official/user agents', () => {
  const { root, configDir } = setup();
  installQoder({ root, configDir });
  const report = uninstallQoder({ root, configDir });
  assert.equal(report.ok, true);

  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  const remaining = Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks || []);
  assert.equal(
    remaining.some((hook) => hook.command.includes('hook.mjs') && hook.command.includes('harness-enhance')),
    false,
  );
  assert.equal(remaining.some((hook) => hook.command.includes('old-hook.mjs')), true);
  assert.equal(settings.mcpServers['harness-enhance'], undefined);
  assert.ok(settings.mcpServers.Existing);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'env-runner.md')), true);
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'reasoner.md')), true);
  assert.equal(
    Object.values(readRegistry().projects).some((project) => project.projectRoot === root),
    false,
  );
});

test('syncCapabilities resolves builtins without installing agents', () => {
  const root = tmp('sync-root');
  const configDir = tmp('sync-qoder');
  const report = syncCapabilities({ root, configDir });
  assert.ok(report.capabilities.allowedSubagents.includes('general-purpose'));
  assert.ok(report.capabilities.allowedSubagents.includes('Explore'));
  assert.equal(report.capabilities.roles.reason.unresolved, true);
  const { config } = loadConfig(root);
  assert.deepEqual(
    [...config.capabilities.allowedSubagents].sort(),
    [...report.capabilities.allowedSubagents].sort(),
  );
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), false);
});

test('refreshCapabilities installs the fallback it declares', () => {
  const root = tmp('refresh-root');
  const configDir = tmp('refresh-qoder');
  const report = refreshCapabilities({ root, configDir });
  assert.ok(report.capabilities.fallbacksToInstall.includes('mhe-reasoner'));
  assert.equal(fs.existsSync(path.join(configDir, 'agents', 'mhe-reasoner.md')), true);
});
