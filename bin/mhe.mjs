#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { enableProject, disableProject, ensureState, loadConfig, saveConfig, stateDirFor } from '../src/core/config.mjs';
import { buildCapsule, writeCapsule } from '../src/core/capsule.mjs';
import { putArtifact } from '../src/core/artifacts.mjs';
import { benchmarkReport, defaultScenarios, summarizeMetrics } from '../src/core/metrics.mjs';
import {
  legacyStateFiles,
  readJobs,
  readMetrics,
  sessionKey,
  storePaths,
} from '../src/core/store.mjs';
import { summarizeWorkers } from '../src/core/capabilities.mjs';
import { enhanceHome, projectKey } from '../src/core/state-root.mjs';
import { runDemo } from '../src/bench/demo.mjs';
import { describeAdapter } from '../src/adapters/spec.mjs';
import { getAdapter, listAdapters } from '../src/adapters/registry.mjs';
import { detectConfigDir, syncCapabilities } from '../src/adapters/qoder/install.mjs';

const VERSION = '0.2.0';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (['dry-run', 'force', 'json', 'keep', 'help', 'global'].includes(key)) {
        out[key] = true;
      } else {
        out[key] = argv[i + 1];
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function rootFrom(args) {
  return path.resolve(args.root || process.cwd());
}

function usage() {
  return `my-harness-enhance ${VERSION}

Usage:
  mhe install <adapter> [--global] [--root <project>] [--config-dir <dir>] [--dry-run] [--force]
  mhe uninstall <adapter> [--global] [--root <project>] [--config-dir <dir>] [--dry-run]
  mhe doctor [adapter] [--root <project>] [--config-dir <dir>]
  mhe refresh [<adapter>] [--root <workspace>]
  mhe adapters [--json]
  mhe capabilities [--root <project>]
  mhe init [--root <project>]
  mhe state [--root <project>] [--session <id>]
  mhe reset [--root <project>]
  mhe capsule [--root <project>] [--session <id>]
  mhe artifact <file> [--kind <kind>] [--summary <text>]
  mhe metrics [--root <project>]
  mhe report [--root <project>] [--session <id>] [--json] [--limit <n>]
  mhe enable|disable [--root <project>]
  mhe bench [--json]
  mhe demo
  mhe version | help

What it does:
  A harness-agnostic personal enhancement layer. One conductor routes to
  isolated native workers; a shared brief and deterministic checks replace
  full LLM re-audits. State lives in:
    ~/.my-harness-enhance/
  Nothing is written into the target project repository. Qoder is the first
  adapter; other adapters implement the same contract.

Examples:
  node bin/mhe.mjs adapters
  node bin/mhe.mjs install qoder --global --dry-run
  node bin/mhe.mjs install qoder --global
  node bin/mhe.mjs install qoder --root "D:/path/to/project"
  node bin/mhe.mjs doctor qoder --root "D:/path/to/project"
  node bin/mhe.mjs capabilities --root "D:/path/to/project"
  node bin/mhe.mjs bench
  node bin/mhe.mjs demo
`;
}

function printInstallReport(report, adapter) {
  const lines = [];
  lines.push(`${adapter.label} install${report.dryRun ? ' (dry run)' : ''}`);
  lines.push('');
  for (const change of report.changes) lines.push(`- ${change}`);
  if (report.warnings.length) {
    lines.push('');
    lines.push('warnings:');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  if (!report.global && report.capabilities) {
    lines.push('capability mapping:');
    for (const line of summarizeWorkers(report.capabilities).split('\n').filter(Boolean)) {
      lines.push(line);
    }
  }
  if (report.fallbackReports?.length) {
    lines.push('');
    lines.push('fallback agents:');
    for (const agent of report.fallbackReports) lines.push(`- ${agent.file}`);
  }
  if (report.overlay) {
    const o = report.overlay;
    lines.push('');
    lines.push('personal overlay agents:');
    lines.push(`- sources: repo=${o.sources.repo} user=${o.sources.user} merged=${o.sources.merged}`);
    lines.push(`- target: ${o.agentsDir}`);
    for (const file of o.installed) lines.push(`- install: ${file}`);
    for (const file of o.updated) lines.push(`- update: ${file}`);
    for (const file of o.adopted) lines.push(`- adopt: ${file} (pre-existing, kept on uninstall)`);
    for (const file of o.unchanged) lines.push(`- unchanged: ${file}`);
    for (const file of o.skippedPlatform) lines.push(`- skip-platform: ${file}`);
    for (const conflict of o.conflicts) lines.push(`- conflict: ${conflict.file} (${conflict.reason})`);
  }
  if (!report.dryRun) {
    lines.push('');
    lines.push('next:');
    if (adapter.id === 'qoder') {
      if (report.global) {
        lines.push('1. Restart Qoder once so the harness-enhance MCP server reloads in global mode.');
        lines.push('2. Open ANY workspace and start a new session; hooks auto-register it. No agent/model selection.');
        lines.push('3. State lives under ~/.my-harness-enhance/projects/<hash>/ (not in the repo).');
        lines.push('4. Run `mhe doctor --root <workspace>` after the first session.');
        lines.push('5. Roll back with `mhe uninstall qoder --global` (settings backup is kept).');
      } else {
        lines.push('1. Start a NEW Qoder session in this project. No agent/model selection is needed.');
        lines.push('2. Ask for a real task; the conductor delegates to the native workers.');
        lines.push(`3. State lives in ${report.stateDir} (not in the repo).`);
        lines.push('4. Run `mhe doctor` if a hook does not fire.');
        lines.push('5. Roll back with `mhe uninstall qoder` (settings backup is kept).');
      }
    } else {
      lines.push('1. Restart the target harness so the adapter/MCP changes reload.');
      lines.push('2. Open a new session in a workspace; run the adapter doctor command.');
      lines.push('3. State lives under ~/.my-harness-enhance/ (not in the repo).');
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdInit(args) {
  const root = rootFrom(args);
  const { stateDir } = ensureState(root, { harness: 'qoder' });
  try {
    syncCapabilities({ root });
  } catch {
    // init must stay usable when the harness config dir is absent
  }
  const { config } = loadConfig(root);
  process.stdout.write(
    `initialized ${root}\n` +
    `state dir: ${stateDir}\n` +
    `conductor mode: ${config.conductor?.auto ? 'auto' : 'manual'}\n`,
  );
}

function adapterFromArgs(args, fallback = 'qoder') {
  const id = args.harness || args._[0] || fallback;
  const adapter = getAdapter(id);
  if (!adapter) {
    process.stderr.write(`unknown adapter: ${id}; run \`mhe adapters\` to list implementations\n`);
    process.exitCode = 1;
    return null;
  }
  return adapter;
}

function cmdInstall(args) {
  const id = args._[0];
  if (!id) {
    process.stderr.write('install requires an adapter id; run `mhe adapters`\n');
    process.exitCode = 1;
    return;
  }
  const adapter = getAdapter(id);
  if (!adapter) {
    process.stderr.write(`unknown adapter: ${id}; run \`mhe adapters\`\n`);
    process.exitCode = 1;
    return;
  }
  if (typeof adapter.lifecycle.install !== 'function') {
    process.stderr.write(`${adapter.label} does not implement install\n`);
    process.exitCode = 1;
    return;
  }
  const report = adapter.lifecycle.install({
    root: rootFrom(args),
    configDir: args['config-dir'] || null,
    global: Boolean(args.global),
    dryRun: Boolean(args['dry-run']),
    force: Boolean(args.force),
  });
  printInstallReport(report, adapter);
}

function cmdUninstall(args) {
  const id = args._[0];
  if (!id) {
    process.stderr.write('uninstall requires an adapter id; run `mhe adapters`\n');
    process.exitCode = 1;
    return;
  }
  const adapter = getAdapter(id);
  if (!adapter || typeof adapter.lifecycle.uninstall !== 'function') {
    process.stderr.write(`adapter does not implement uninstall: ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const report = adapter.lifecycle.uninstall({
    root: rootFrom(args),
    configDir: args['config-dir'] || null,
    global: Boolean(args.global),
    dryRun: Boolean(args['dry-run']),
  });
  process.stdout.write(
    `${adapter.label} uninstall${report.dryRun ? ' (dry run)' : ''}\n` +
    report.changes.map((item) => `- ${item}\n`).join('') +
    (report.backup ? `- settings backup: ${report.backup}\n` : '') +
    `- state kept at: ${report.stateDir}\n`,
  );
}

function cmdDoctor(args) {
  const adapter = adapterFromArgs(args);
  if (!adapter) return;
  if (typeof adapter.lifecycle.doctor !== 'function') {
    process.stderr.write(`${adapter.label} does not implement doctor\n`);
    process.exitCode = 1;
    return;
  }
  const report = adapter.lifecycle.doctor({
    root: rootFrom(args),
    configDir: args['config-dir'] || null,
  });
  process.stdout.write(`doctor ${adapter.label}${report.ok ? ' (ok)' : ' (problems)'}\n`);
  process.stdout.write(`config dir: ${report.configDir}\n`);
  process.stdout.write(`state dir: ${report.stateDir}\n`);
  for (const check of report.checks) {
    process.stdout.write(`[${check.ok ? 'ok' : 'missing'}] ${check.name} — ${check.detail}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

function cmdCapabilities(args) {
  const root = rootFrom(args);
  const { config, exists } = loadConfig(root);
  if (!exists) {
    process.stderr.write(`project is not registered: ${root}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(config.capabilities, null, 2)}\n`);
}

function cmdRefresh(args) {
  const adapter = adapterFromArgs(args);
  if (!adapter) return;
  if (typeof adapter.lifecycle.refresh !== 'function') {
    process.stderr.write(`${adapter.label} does not implement refresh\n`);
    process.exitCode = 1;
    return;
  }
  const root = rootFrom(args);
  const report = adapter.lifecycle.refresh({ root, configDir: args['config-dir'] || null });
  process.stdout.write(
    `refreshed ${adapter.label} ${report.projectRoot}\n` +
    `state dir: ${report.stateDir}\n` +
    `capability policy:\n${summarizeWorkers(report.capabilities)}\n`,
  );
}

function cmdAdapters(args) {
  const adapters = listAdapters().map(describeAdapter);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(adapters, null, 2)}\n`);
    return;
  }
  if (adapters.length === 0) {
    process.stdout.write('(no adapters)\n');
    return;
  }
  for (const adapter of adapters) {
    process.stdout.write(`${adapter.id} (${adapter.label})\n`);
    process.stdout.write(`  capabilities: ${adapter.capabilities.join(', ') || '(none)'}\n`);
    process.stdout.write(`  lifecycle: ${adapter.lifecycle.join(', ') || '(none)'}\n`);
  }
}

function cmdToggle(args, enabled) {
  const root = rootFrom(args);
  ensureState(root, { enabled });
  saveConfig(root, { enabled });
  if (enabled) {
    enableProject(root);
    const { config } = loadConfig(root);
    if (!config.capabilities?.allowedSubagents?.length) {
      try {
        syncCapabilities({ root });
      } catch {
        // enable must stay usable when the harness config dir is absent
      }
    }
  } else {
    disableProject(root);
  }
  process.stdout.write(
    `my-harness-enhance ${enabled ? 'enabled' : 'disabled'} for ${root}\n` +
    (enabled ? '' : 'Hooks will be a no-op until you run `mhe enable`.\n'),
  );
}

function cmdState(args) {
  const root = rootFrom(args);
  const session = args.session ? sessionKey(args.session) : '';
  const paths = storePaths(root, session);
  const capsule = buildCapsule(root, { session });
  const jobs = readJobs(root, session).jobs;
  process.stdout.write(`state dir: ${paths.dir}\n`);
  if (session) process.stdout.write(`session: ${session}\n`);
  const legacy = legacyStateFiles(root);
  if (legacy.length) {
    process.stdout.write(`legacy unsharded state: ${legacy.join(', ')} (kept; sessions copy it on start)\n`);
  }
  process.stdout.write(`\n${capsule}\n\n`);
  process.stdout.write('jobs:\n');
  if (jobs.length === 0) process.stdout.write('(none)\n');
  for (const job of jobs.slice(-20)) {
    process.stdout.write(`- ${job.id} ${job.type || ''} ${job.role || ''} ${job.status}\n`);
  }
}

function cmdReset(args) {
  const root = rootFrom(args);
  const stateDir = stateDirFor(root);
  if (!fs.existsSync(stateDir)) {
    process.stderr.write(`project is not registered: ${root}
`);
    process.exitCode = 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const target = path.join(enhanceHome(), 'legacy', `${projectKey(root)}-${stamp}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(stateDir, target, { recursive: true });
  const keep = new Set(['config.json', 'capabilities.json']);
  for (const entry of fs.readdirSync(stateDir)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(stateDir, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(stateDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  process.stdout.write(
    `archived ${stateDir}\n-> ${target}\n` +
    'live state reset; config.json/capabilities.json kept\n',
  );
}

function cmdCapsule(args) {
  const root = rootFrom(args);
  const session = args.session ? sessionKey(args.session) : '';
  const capsule = writeCapsule(root, { session });
  process.stdout.write(`${capsule}\n`);
}

function cmdArtifact(args) {
  const file = args._[0];
  if (!file) {
    process.stderr.write('artifact requires a file path\n');
    process.exitCode = 1;
    return;
  }
  const root = rootFrom(args);
  const content = fs.readFileSync(path.resolve(file), 'utf8');
  const artifact = putArtifact(root, {
    content,
    kind: args.kind || 'file',
    source: path.resolve(file),
    summary: args.summary || path.basename(file),
  });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

function cmdMetrics(args) {
  const root = rootFrom(args);
  const metrics = readMetrics(root, 500);
  const events = {};
  for (const metric of metrics) {
    const key = `${metric.event || 'unknown'}:${metric.role || metric.agent_type || ''}`;
    events[key] = (events[key] || 0) + 1;
  }
  process.stdout.write(`metrics entries: ${metrics.length}\n`);
  for (const [key, count] of Object.entries(events).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`- ${key}: ${count}\n`);
  }
  const last = metrics.slice(-5);
  if (last.length) {
    process.stdout.write('\nrecent:\n');
    for (const metric of last) process.stdout.write(`- ${JSON.stringify(metric)}\n`);
  }
}

function cmdReport(args) {
  const root = rootFrom(args);
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 2000;
  const session = args.session ? sessionKey(args.session) : '';
  const metrics = readMetrics(root, limit);
  const summary = summarizeMetrics(metrics, { session });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ root, session: session || null, summary }, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`report: ${root}`);
  if (session) lines.push(`session: ${session}`);
  lines.push(`entries: ${summary.entries}${summary.firstAt ? ` (${summary.firstAt} -> ${summary.lastAt})` : ''}`);
  if (summary.entries === 0) {
    lines.push('');
    lines.push('No hook metrics recorded yet; the next conductor session writes them.');
  }

  const shards = Object.entries(summary.sessions || {}).sort((a, b) => b[1] - a[1]);
  if (shards.length) {
    lines.push(`sessions: ${shards.map(([id, count]) => `${id}=${count}`).join(', ')}`);
  }

  lines.push('');
  lines.push('events:');
  const eventEntries = Object.entries(summary.events).sort((a, b) => b[1] - a[1]);
  if (eventEntries.length === 0) lines.push('- (none)');
  for (const [event, count] of eventEntries) lines.push(`- ${event}: ${count}`);

  lines.push('');
  lines.push(
    `jobs: started=${summary.jobs.started} stopped=${summary.jobs.stopped} `
    + `valid=${summary.jobs.valid} invalid=${summary.jobs.invalid} `
    + `retryable=${summary.jobs.retryable} invalid_rate=${(summary.jobs.invalidRate * 100).toFixed(1)}%`,
  );
  const statuses = Object.entries(summary.jobs.statuses).sort((a, b) => b[1] - a[1]);
  if (statuses.length) lines.push(`statuses: ${statuses.map(([name, count]) => `${name}=${count}`).join(', ')}`);
  lines.push(
    `envelope tokens: avg=${summary.envelopeTokens.avg} max=${summary.envelopeTokens.max} `
    + `n=${summary.envelopeTokens.count}`,
  );
  lines.push(
    `agent results: valid=${summary.agentResults.valid} invalid=${summary.agentResults.invalid} `
    + `compact_avg=${summary.agentResults.compactTokens.avg} compact_max=${summary.agentResults.compactTokens.max}`,
  );
  lines.push(
    `capsule tokens: latest=${summary.capsuleTokens.latest} max=${summary.capsuleTokens.max} `
    + `n=${summary.capsuleTokens.count}`,
  );
  lines.push(`tool output captured: ${summary.capturedBytes} bytes`);
  const denials = Object.entries(summary.denials).sort((a, b) => b[1] - a[1]);
  lines.push(`denials: ${denials.length ? denials.map(([gate, count]) => `${gate}=${count}`).join(', ') : '(none)'}`);

  const workers = Object.entries(summary.workers).sort((a, b) => a[0].localeCompare(b[0]));
  if (workers.length) {
    lines.push('');
    lines.push('workers:');
    for (const [agent, counts] of workers) {
      lines.push(`- ${agent}: start=${counts.starts} stop=${counts.stops} invalid=${counts.invalid}`);
    }
  }

  lines.push('');
  lines.push('not measured by hooks: M_T, b, B, C, attention density (host usage data is required).');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdBench(args) {
  const scenarios = defaultScenarios();
  if (args.json) process.stdout.write(`${JSON.stringify(scenarios, null, 2)}\n`);
  else process.stdout.write(`${benchmarkReport(scenarios)}\n`);
}

function cmdDemo() {
  const result = runDemo();
  process.stdout.write(`${result.report}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._.shift();

  switch (command) {
    case 'install':
      cmdInstall(args);
      break;
    case 'uninstall':
      cmdUninstall(args);
      break;
    case 'doctor':
      cmdDoctor(args);
      break;
    case 'adapters':
      cmdAdapters(args);
      break;
    case 'capabilities':
      cmdCapabilities(args);
      break;
    case 'refresh':
      cmdRefresh(args);
      break;
    case 'init':
      cmdInit(args);
      break;
    case 'state':
      cmdState(args);
      break;
    case 'enable':
      cmdToggle(args, true);
      break;
    case 'disable':
      cmdToggle(args, false);
      break;
    case 'reset':
      cmdReset(args);
      break;
    case 'capsule':
      cmdCapsule(args);
      break;
    case 'artifact':
      cmdArtifact(args);
      break;
    case 'metrics':
      cmdMetrics(args);
      break;
    case 'report':
      cmdReport(args);
      break;
    case 'bench':
      cmdBench(args);
      break;
    case 'demo':
      cmdDemo();
      break;
    case 'detect':
      process.stdout.write(`${detectConfigDir(args['config-dir'] || null)}\n`);
      break;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      break;
    case 'help':
    case undefined:
      process.stdout.write(usage());
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${usage()}`);
      process.exitCode = 1;
  }
}

main();
