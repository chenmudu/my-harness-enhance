import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrief } from '../src/core/brief.mjs';
import { resolveCapabilities } from '../src/core/capabilities.mjs';
import { runBriefChecks } from '../src/core/checks.mjs';
import { loadConfig, saveConfig } from '../src/core/config.mjs';
import { canonicalPath } from '../src/core/state-root.mjs';
import {
  initStore,
  readLastCheck,
  readPlan,
  readWorktrees,
  updatePlanTask,
  upsertWorktree,
  writeBrief,
  writeLastCheck,
  writePlan,
} from '../src/core/store.mjs';
import {
  checkTaskDependencies,
  createWorktree,
  diffWorktree,
  landWorktree,
  listWorktrees,
  projectWorktreesDir,
  removeWorktree,
  validateWorktree,
} from '../src/core/worktree.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-wt-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'src', 'mcp', 'recall-server.mjs');
const HOOK = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'hook.mjs');

function gitAt(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function makeRepo(extraScripts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-wt-project-')));
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  gitAt(root, 'config', 'user.email', 'mhe@example.invalid');
  gitAt(root, 'config', 'user.name', 'mhe test');
  gitAt(root, 'config', 'commit.gpgsign', 'false');
  gitAt(root, 'config', 'core.autocrlf', 'false');
  write(root, 'src/app.js', 'export const v = 1;\n');
  const scripts = { test: 'node ok.js', ...extraScripts };
  write(root, 'package.json', `${JSON.stringify({ name: 'wt-fixture', scripts }, null, 2)}\n`);
  write(root, 'ok.js', 'process.exit(0);\n');
  write(root, 'bad.js', 'process.exit(3);\n');
  gitAt(root, 'add', '-A');
  gitAt(root, 'commit', '-m', 'initial', '--quiet');
  initStore(root);
  return root;
}

/** Deterministic content hash of every working-tree file outside .git. */
function snapshotWorkingTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, relPath);
      else {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        out.push(`${relPath}=${hash}`);
      }
    }
  };
  walk(root, '');
  return out;
}

function npmAvailable() {
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: true, timeout: 30000 });
  return !probe.error && probe.status === 0;
}

function runRpc(root, messages) {
  const input = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  env.MY_HARNESS_ENHANCE_PROJECT = root;
  const result = spawnSync(process.execPath, [SERVER], {
    input,
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rpcInit(id = 1) {
  return { jsonrpc: '2.0', id, method: 'initialize', params: {} };
}

function rpcCall(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function payload(response) {
  return JSON.parse(response.result.content[0].text);
}

/** Run the Qoder hook against a registered project root (see hooks.test.mjs). */
function runHook(root, event, payloadValue) {
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payloadValue),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout || '';
}

function denyReasonOf(stdout) {
  assert.ok(stdout.trim(), 'expected hook JSON output');
  const json = JSON.parse(stdout);
  assert.equal(json.hookSpecificOutput?.permissionDecision, 'deny', stdout);
  return json.hookSpecificOutput.permissionDecisionReason || '';
}

/** Project with capabilities wired so Agent dispatch passes the base policy. */
function dispatchRoot(briefProfile = 'code') {
  const root = makeRepo();
  saveConfig(root, {
    capabilities: resolveCapabilities({ availableAgents: ['general-purpose', 'Explore'] }),
  });
  writeBrief(root, buildBrief(root, { profile: briefProfile }));
  writePlan(root, [
    { id: 'T1', title: 'first', status: 'pending' },
    { id: 'T2', title: 'second', status: 'pending', depends_on: ['T1'] },
  ], { replace: true });
  return root;
}

function dispatchPayload(tool, input = {}) {
  return {
    model: 'qfmodel',
    tool_name: tool,
    tool_input: { subagent_type: 'general-purpose', ...input },
  };
}

test('createWorktree builds an isolated detached worktree outside the repo', () => {
  const root = makeRepo();
  const before = snapshotWorkingTree(root);
  const head = gitAt(root, 'rev-parse', 'HEAD').trim();

  const created = createWorktree(root, 'task-a');
  assert.equal(created.ok, true, created.blocker);
  assert.equal(created.task_id, 'task-a');
  assert.equal(created.head, head);
  assert.ok(fs.existsSync(path.join(created.path, 'src', 'app.js')));

  const relative = path.relative(path.resolve(root), path.resolve(created.path));
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'worktree must sit outside the repo');
  assert.equal(readWorktrees(root).worktrees['task-a'].path, created.path);

  // The target repo working tree is untouched by create.
  assert.deepEqual(snapshotWorkingTree(root), before);
  assert.equal(gitAt(root, 'status', '--porcelain').trim(), '');

  const listed = listWorktrees(root);
  assert.equal(listed.ok, true);
  const managed = listed.worktrees.find((entry) => entry.task_id === 'task-a');
  assert.ok(managed, `managed worktree missing from ${JSON.stringify(listed.worktrees)}`);
  assert.equal(managed.detached, true);

  const removed = removeWorktree(root, 'task-a');
  assert.equal(removed.ok, true, removed.blocker);
  assert.ok(!fs.existsSync(created.path));
  assert.equal(readWorktrees(root).worktrees['task-a'], undefined);
  assert.deepEqual(snapshotWorkingTree(root), before);
});

test('create refuses a dirty repo, bogus task ids, and re-creating an existing path', () => {
  const root = makeRepo();
  write(root, 'untracked.txt', 'dirty\n');
  const dirty = createWorktree(root, 'task-dirty');
  assert.equal(dirty.ok, false);
  assert.equal(dirty.rule, 'worktree.dirty');
  assert.match(dirty.blocker, /not clean/);
  assert.ok(!fs.existsSync(path.join(projectWorktreesDir(root), 'task-dirty')));

  fs.rmSync(path.join(root, 'untracked.txt'));
  for (const bad of ['', '../evil', 'evil/../../x', 'has space', 'a'.repeat(65)]) {
    const rejected = createWorktree(root, bad);
    assert.equal(rejected.ok, false, `must reject task_id "${bad}"`);
    assert.equal(rejected.rule, 'worktree.task_id');
  }

  const created = createWorktree(root, 'task-twice');
  assert.equal(created.ok, true, created.blocker);
  const again = createWorktree(root, 'task-twice');
  assert.equal(again.ok, false);
  assert.equal(again.rule, 'worktree.exists');
  assert.equal(removeWorktree(root, 'task-twice').ok, true);
});

test('dependency gate blocks create until depends_on tasks are completed', () => {
  const root = makeRepo();
  writePlan(root, [
    { id: 'dep-a', title: 'a', status: 'pending' },
    { id: 'dep-b', title: 'b', status: 'in_progress' },
    { id: 'main', title: 'main', status: 'pending', depends_on: ['dep-a', 'dep-b', 'dep-z'] },
  ], { replace: true });

  const blocked = checkTaskDependencies(root, 'main');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rule, 'worktree.dependencies');
  assert.deepEqual(
    blocked.missing.map((item) => `${item.id}:${item.status}`),
    ['dep-a:pending', 'dep-b:in_progress', 'dep-z:missing'],
  );
  assert.match(blocked.blocker, /dep-a\(pending\)/);
  assert.match(blocked.blocker, /dep-z\(missing\)/);

  const unknown = checkTaskDependencies(root, 'ghost');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.rule, 'worktree.unknown_task');

  updatePlanTask(root, 'dep-a', { status: 'completed' });
  updatePlanTask(root, 'dep-b', { status: 'completed' });
  writePlan(root, [{ id: 'dep-z', title: 'z', status: 'completed' }]);
  assert.equal(checkTaskDependencies(root, 'main').ok, true);
});

test('MCP enhance_worktree: create is gated, then create/diff/remove over RPC', () => {
  const root = makeRepo();
  writePlan(root, [
    { id: 'dep', title: 'dep', status: 'pending' },
    { id: 'task', title: 'task', status: 'pending', depends_on: ['dep'] },
  ], { replace: true });

  const blockedResponses = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'create', task_id: 'task' }),
    rpcCall(3, 'enhance_worktree', { action: 'create' }),
    rpcCall(4, 'enhance_worktree', { action: 'explode', task_id: 'task' }),
    rpcCall(5, 'enhance_worktree', { action: 'list' }),
  ]);
  const blocked = blockedResponses.find((item) => item.id === 2);
  assert.equal(blocked.result.isError, true);
  assert.equal(payload(blocked).ok, false);
  assert.match(payload(blocked).blocker, /dep\(pending\)/);
  assert.equal(blockedResponses.find((item) => item.id === 3).result.isError, true);
  assert.equal(blockedResponses.find((item) => item.id === 4).result.isError, true);
  const listed = payload(blockedResponses.find((item) => item.id === 5));
  assert.equal(listed.ok, true);

  updatePlanTask(root, 'dep', { status: 'completed' });
  const createdRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'create', task_id: 'task' }),
    rpcCall(3, 'enhance_worktree', { action: 'list' }),
  ]);
  const created = createdRpc.find((item) => item.id === 2);
  assert.equal(created.result.isError, false);
  const createdValue = payload(created);
  assert.equal(createdValue.ok, true);
  assert.equal(createdValue.task_id, 'task');
  assert.match(createdValue.head, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(createdValue.path));

  const afterList = payload(createdRpc.find((item) => item.id === 3));
  assert.ok(afterList.worktrees.some((entry) => entry.task_id === 'task'));

  // Land the task over RPC: tracked edit plus a new untracked file.
  write(createdValue.path, 'src/app.js', 'export const v = 9;\n');
  write(createdValue.path, 'landed.txt', 'new file\n');
  const landRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'land', task_id: 'task' }),
    rpcCall(3, 'enhance_worktree', { action: 'land' }),
  ]);
  const landResp = landRpc.find((item) => item.id === 2);
  assert.equal(landResp.result.isError, false);
  const landedValue = payload(landResp);
  assert.equal(landedValue.ok, true, landedValue.blocker);
  assert.deepEqual([...landedValue.applied_files].sort(), ['landed.txt', 'src/app.js']);
  // The patch text stays off the conductor's wire: counts and paths are enough
  // to decide, and the patch itself is still on disk.
  assert.equal(landedValue.patch, undefined);
  assert.equal(landedValue.patch_omitted, true);
  assert.equal(landedValue.base, undefined);
  assert.equal(landedValue.carry, undefined);
  assert.ok(fs.existsSync(path.join(root, 'landed.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 9;\n');
  assert.equal(landRpc.find((item) => item.id === 3).result.isError, true);

  // A successful land resets the worktree to its creation base and marks it
  // landed, so explicit removal is clean and does not need a manual reset.
  const removedRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'remove', task_id: 'task' }),
  ]);
  const removedValue = payload(removedRpc.find((item) => item.id === 2));
  assert.equal(removedValue.ok, true, removedValue.blocker);
  assert.ok(!fs.existsSync(createdValue.path));
});

test('diffWorktree reports bounded patches and changed files; remove refuses dirty worktrees', () => {
  const root = makeRepo();
  const created = createWorktree(root, 'task-diff');
  assert.equal(created.ok, true, created.blocker);

  write(created.path, 'src/app.js', 'export const v = 2;\n');
  write(created.path, 'notes/extra.txt', 'untracked\n');

  const diff = diffWorktree(root, 'task-diff');
  assert.equal(diff.ok, true, diff.blocker);
  assert.deepEqual(
    [...diff.changed_files].sort(),
    ['notes/extra.txt', 'src/app.js'],
  );
  assert.equal(diff.changed_count, 2);
  assert.match(diff.patch, /\+export const v = 2;/);
  assert.equal(diff.truncated, false);

  const tight = diffWorktree(root, 'task-diff', { maxPatchChars: 20 });
  assert.equal(tight.ok, true);
  assert.equal(tight.truncated, true);
  assert.ok(tight.patch.length <= 20);

  const dirtyRemove = removeWorktree(root, 'task-diff');
  assert.equal(dirtyRemove.ok, false);
  assert.equal(dirtyRemove.rule, 'worktree.dirty');
  assert.ok(fs.existsSync(created.path));

  gitAt(created.path, 'checkout', '--', 'src/app.js');
  fs.rmSync(path.join(created.path, 'notes'), { recursive: true, force: true });
  const removed = removeWorktree(root, 'task-diff');
  assert.equal(removed.ok, true, removed.blocker);
  assert.ok(!fs.existsSync(created.path));

  const missing = diffWorktree(root, 'task-diff');
  assert.equal(missing.ok, false);
});

test('scope checker audits the worktree, not the clean main checkout', () => {
  const root = makeRepo();
  const brief = buildBrief(root, { profile: 'code', ownership: ['src/**', 'package.json'] });
  const created = createWorktree(root, 'task-scope');
  assert.equal(created.ok, true, created.blocker);

  write(created.path, 'src/app.js', 'export const v = 2;\n');
  write(created.path, 'outside.txt', 'not owned\n');
  const config = loadConfig(root).config;

  const main = runBriefChecks(root, brief, config, ['scope']);
  assert.equal(main.ok, true, JSON.stringify(main.findings));

  const inWorktree = runBriefChecks(root, brief, config, ['scope'], { worktree: created.path });
  assert.equal(inWorktree.ok, false);
  const outside = inWorktree.findings.find((item) => item.rule === 'scope.outside');
  assert.ok(outside);
  assert.match(outside.message, /outside\.txt/);

  // Arbitrary paths are refused, never used as a check root.
  const escaped = runBriefChecks(root, brief, config, ['scope'], { worktree: os.tmpdir() });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.findings[0].rule, 'worktree.invalid');

  removeWorktree(root, 'task-scope');
});

test('MCP enhance_check accepts a worktree and rejects foreign paths', () => {
  const root = makeRepo();
  const brief = buildBrief(root, { profile: 'code', ownership: ['src/**', 'package.json'] });
  writeBrief(root, brief);
  const created = createWorktree(root, 'task-mcp');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'outside.txt', 'not owned\n');

  const responses = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_check', { checkers: ['scope'], worktree: created.path }),
    rpcCall(3, 'enhance_check', { worktree: path.join(root, 'src') }),
  ]);
  const scoped = responses.find((item) => item.id === 2);
  assert.equal(scoped.result.isError, false);
  const scopedValue = payload(scoped);
  assert.equal(scopedValue.ok, false);
  assert.ok(scopedValue.findings.some((item) => item.rule === 'scope.outside'));

  const foreign = responses.find((item) => item.id === 3);
  assert.equal(foreign.result.isError, true);
  assert.match(foreign.result.content[0].text, /worktree/);

  fs.rmSync(path.join(created.path, 'outside.txt'));
  const clean = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_check', { checkers: ['scope'], worktree: created.path }),
  ]);
  assert.equal(payload(clean.find((item) => item.id === 2)).ok, true);
  removeWorktree(root, 'task-mcp');
});

test('command checkers auto-discover npm scripts; registered commands still win', (t) => {
  if (!npmAvailable()) {
    t.skip('npm is not available on this machine');
    return;
  }
  const root = makeRepo();
  const brief = buildBrief(root, { profile: 'code', ownership: ['src/**'], checks: ['command:test'] });
  const config = loadConfig(root).config;

  const discovered = runBriefChecks(root, brief, config, ['command:test']);
  assert.equal(discovered.ok, true, JSON.stringify(discovered.findings));

  const unbuildable = runBriefChecks(root, brief, config, ['command:build']);
  assert.equal(unbuildable.ok, false);
  assert.equal(unbuildable.findings[0].rule, 'command.unknown');

  const failing = makeRepo({ test: 'node bad.js' });
  const failingBrief = buildBrief(failing, { profile: 'code', checks: ['command:test'] });
  const failingConfig = loadConfig(failing).config;
  const blocked = runBriefChecks(failing, failingBrief, failingConfig, ['command:test']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.findings[0].rule, 'command.failed');

  failingConfig.verification.commands = { test: [process.execPath, '--version'] };
  const registeredWins = runBriefChecks(failing, failingBrief, failingConfig, ['command:test']);
  assert.equal(registeredWins.ok, true, JSON.stringify(registeredWins.findings));
});

test('command checkers run inside the worktree when one is provided', (t) => {
  if (!npmAvailable()) {
    t.skip('npm is not available on this machine');
    return;
  }
  const root = makeRepo();
  const brief = buildBrief(root, { profile: 'code', checks: ['command:test'] });
  const config = loadConfig(root).config;
  const created = createWorktree(root, 'task-cmd');
  assert.equal(created.ok, true, created.blocker);

  // The task switches the test script to the failing one, uncommitted.
  write(created.path, 'package.json', `${JSON.stringify({
    name: 'wt-fixture',
    scripts: { test: 'node bad.js' },
  }, null, 2)}\n`);

  const onRoot = runBriefChecks(root, brief, config, ['command:test']);
  assert.equal(onRoot.ok, true, JSON.stringify(onRoot.findings));

  const onWorktree = runBriefChecks(root, brief, config, ['command:test'], { worktree: created.path });
  assert.equal(onWorktree.ok, false);
  assert.equal(onWorktree.findings[0].rule, 'command.failed');

  gitAt(created.path, 'checkout', '--', 'package.json');
  const removed = removeWorktree(root, 'task-cmd');
  assert.equal(removed.ok, true, removed.blocker);
});

test('MCP lists enhance_worktree and enhance_check gains the worktree argument', () => {
  const root = makeRepo();
  const responses = runRpc(root, [
    rpcInit(),
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const tools = responses.find((item) => item.id === 2).result.tools;
  const worktreeTool = tools.find((tool) => tool.name === 'enhance_worktree');
  assert.ok(worktreeTool, 'enhance_worktree must be listed');
  assert.deepEqual(worktreeTool.inputSchema.properties.action.enum, ['create', 'list', 'diff', 'land', 'remove']);
  assert.deepEqual(worktreeTool.inputSchema.required, ['action']);
  assert.equal(worktreeTool.inputSchema.additionalProperties, false);
  const checkTool = tools.find((tool) => tool.name === 'enhance_check');
  assert.ok(checkTool.inputSchema.properties.worktree);
  const landProps = worktreeTool.inputSchema.properties;
  assert.equal(landProps.run_checks.type, 'boolean');
  assert.equal(landProps.commit.type, 'boolean');
});

test('land runs brief checks against the base: passing keeps the dirty landing', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['src/**'], checks: ['scope'] }));
  const created = createWorktree(root, 'task-land-checks');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 11;\n');
  write(created.path, 'src/extra.js', 'export const extra = 1;\n');

  const landed = landWorktree(root, 'task-land-checks');
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ran, true);
  assert.equal(landed.checks.skipped, false);
  assert.equal(landed.checks.ok, true, JSON.stringify(landed.checks.findings));
  assert.deepEqual(landed.checks.checked, ['scope']);
  assert.equal(landed.commit.created, false);
  assert.equal(landed.warnings.length, 0);
  // Base dirty by design, nothing committed.
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('failed checks revert the base completely and keep the worktree for a re-land', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['docs/**'], checks: ['scope'] }));
  const created = createWorktree(root, 'task-land-fail');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 12;\n');
  write(created.path, 'src/rogue.js', 'nope\n');

  const failed = landWorktree(root, 'task-land-fail');
  assert.equal(failed.ok, false);
  assert.equal(failed.rule, 'worktree.checks_failed');
  assert.equal(failed.reverted, true);
  assert.ok(
    failed.checks.findings.some((item) => item.rule === 'scope.outside'),
    JSON.stringify(failed.checks.findings),
  );

  // Base fully restored: no tracked edit, no untracked residue, same history.
  assert.equal(gitAt(root, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 1;\n');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'rogue.js')));
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '1');

  // Worktree intact with its work, ready for a fix and re-land.
  assert.equal(fs.readFileSync(path.join(created.path, 'src', 'app.js'), 'utf8'), 'export const v = 12;\n');
  assert.ok(fs.existsSync(path.join(created.path, 'src', 'rogue.js')));

  // Fix the ownership brief, then re-land succeeds onto the restored base.
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['src/**'], checks: ['scope'] }));
  const relanded = landWorktree(root, 'task-land-fail');
  assert.equal(relanded.ok, true, relanded.blocker);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'rogue.js'), 'utf8'), 'nope\n');
});

test('run_checks=false skips the gate even with a failing brief', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['docs/**'], checks: ['scope'] }));
  const created = createWorktree(root, 'task-land-skipchecks');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'outside-owned.txt', 'x\n');

  const landed = landWorktree(root, 'task-land-skipchecks', { runChecks: false });
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ran, false);
  assert.equal(landed.checks.skipped, true);
  assert.ok(landed.warnings.some((item) => /run_checks=false/.test(item)), JSON.stringify(landed.warnings));
  assert.ok(fs.existsSync(path.join(root, 'outside-owned.txt')));
});

test('land runs inputs as a pre-apply preflight and excludes it from post-apply checks', () => {
  const root = makeRepo();
  write(root, 'src/spec.txt', 'input v1\n');
  gitAt(root, 'add', '-A');
  gitAt(root, 'commit', '-m', 'add input', '--quiet');
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    inputs: ['src/spec.txt'],
    ownership: ['src/**'],
    checks: ['inputs', 'scope'],
  }));
  const created = createWorktree(root, 'task-inputs');
  assert.equal(created.ok, true, created.blocker);

  // The worker edits one of the hashed inputs: exactly the real-session case
  // that produced a false inputs.changed when inputs ran after the apply.
  write(created.path, 'src/spec.txt', 'input v2\n');

  const landed = landWorktree(root, 'task-inputs');
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.inputs_preflight, 'passed');
  assert.deepEqual(landed.checks.checked, ['scope']);

  const lastCheck = readLastCheck(root);
  assert.ok(lastCheck, 'land records the authoritative last-check');
  assert.equal(lastCheck.ok, true, JSON.stringify(lastCheck.findings));
  assert.equal(lastCheck.landed, true);
  assert.equal(lastCheck.land_required, false);
  assert.deepEqual(lastCheck.task_ids, ['task-inputs']);
  assert.equal(lastCheck.worktree_task_id, 'task-inputs');
  assert.ok(!lastCheck.checked.includes('inputs'), JSON.stringify(lastCheck.checked));

  const removed = removeWorktree(root, 'task-inputs');
  assert.equal(removed.ok, true, removed.blocker);
});

test('inputs preflight failure aborts land before anything is applied', () => {
  const root = makeRepo();
  write(root, 'src/spec.txt', 'input v1\n');
  gitAt(root, 'add', '-A');
  gitAt(root, 'commit', '-m', 'add input', '--quiet');
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    inputs: ['src/spec.txt'],
    ownership: ['src/**'],
    checks: ['inputs', 'scope'],
  }));
  const created = createWorktree(root, 'task-drift');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 30;\n');

  // Someone moves the input on the base and commits: the brief hash is stale
  // before the patch would ever land.
  write(root, 'src/spec.txt', 'input v9\n');
  gitAt(root, 'commit', '-am', 'base moved the input', '--quiet');

  const aborted = landWorktree(root, 'task-drift');
  assert.equal(aborted.ok, false);
  assert.equal(aborted.rule, 'worktree.inputs_preflight');
  assert.equal(aborted.inputs_preflight, 'failed');
  assert.ok(
    aborted.findings.some((item) => item.rule === 'inputs.changed'),
    JSON.stringify(aborted.findings),
  );

  // Nothing applied or reverted: base keeps its committed input, no residue,
  // history untouched beyond the base's own commit, and no last-check written.
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 1;\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'spec.txt'), 'utf8'), 'input v9\n');
  assert.equal(gitAt(root, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '3');
  assert.equal(readLastCheck(root), null);
  assert.equal(fs.readFileSync(path.join(created.path, 'src', 'app.js'), 'utf8'), 'export const v = 30;\n');

  gitAt(created.path, 'checkout', '--', 'src/app.js');
  const removed = removeWorktree(root, 'task-drift');
  assert.equal(removed.ok, true, removed.blocker);
});

test('land without a brief warns and skips checks instead of failing', () => {
  const root = makeRepo();
  const created = createWorktree(root, 'task-land-nobrief');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 14;\n');

  const landed = landWorktree(root, 'task-land-nobrief');
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ran, false);
  assert.equal(landed.checks.skipped, true);
  assert.ok(landed.warnings.some((item) => /no brief/.test(item)), JSON.stringify(landed.warnings));
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
});

test('land with commit=true creates exactly one commit with the expected subject', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['src/**'], checks: ['scope'] }));
  const created = createWorktree(root, 'task-land-commit');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 13;\n');
  write(created.path, 'src/history.js', 'export const landed = true;\n');

  const landed = landWorktree(root, 'task-land-commit', { commit: true });
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ok, true);
  assert.equal(landed.commit.created, true);
  assert.match(landed.commit.hash, /^[0-9a-f]{40}$/);
  assert.equal(landed.commit.subject, 'harness: land task-land-commit');
  assert.equal(landed.commit.identity, 'repo'); // the fixture can author commits
  assert.equal(gitAt(root, 'log', '-1', '--format=%s').trim(), 'harness: land task-land-commit');
  // Exactly one new commit, base fully clean, worktree preserved.
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(gitAt(root, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.ok(fs.existsSync(created.path));
  assert.ok(readWorktrees(root).worktrees['task-land-commit']);
});

test('land falls back to the harness identity when the checkout cannot author a commit', (t) => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-gitcfg-'));
  const emptyConfig = path.join(cfgDir, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyConfig;
  try {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-wt-noid-')));
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    gitAt(root, 'config', 'user.email', 'setup@example.invalid');
    gitAt(root, 'config', 'user.name', 'setup');
    gitAt(root, 'config', 'commit.gpgsign', 'false');
    gitAt(root, 'config', 'core.autocrlf', 'false');
    write(root, 'src/app.js', 'export const v = 1;\n');
    write(root, 'package.json', `${JSON.stringify({ name: 'wt-fixture', scripts: { test: 'node ok.js' } }, null, 2)}\n`);
    write(root, 'ok.js', 'process.exit(0);\n');
    gitAt(root, 'add', '-A');
    gitAt(root, 'commit', '-m', 'initial', '--quiet');
    // Drop the local identity so only the harness fallback can author the land.
    gitAt(root, 'config', '--unset', 'user.email');
    gitAt(root, 'config', '--unset', 'user.name');
    const probe = spawnSync('git', ['-C', root, 'config', '--get', 'user.email'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && probe.stdout.trim()) {
      t.skip('GIT_CONFIG_GLOBAL isolation not effective on this git');
      return;
    }
    initStore(root);
    const created = createWorktree(root, 'task-noid');
    assert.equal(created.ok, true, created.blocker);
    write(created.path, 'src/app.js', 'export const v = 15;\n');
    const landed = landWorktree(root, 'task-noid', { commit: true, runChecks: false });
    assert.equal(landed.ok, true, landed.blocker);
    assert.equal(landed.commit.created, true);
    assert.equal(landed.commit.identity, 'harness');
    assert.equal(landed.commit.subject, 'harness: land task-noid');
    assert.equal(gitAt(root, 'log', '-1', '--format=%an <%ae>').trim(), 'my-harness-enhance <harness@local>');
    assert.equal(gitAt(root, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  }
});

test('MCP enhance_worktree land honors run_checks and commit over RPC', () => {
  const root = makeRepo();
  writePlan(root, [{ id: 'tk', title: 'k', status: 'pending' }], { replace: true });
  const createdRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'create', task_id: 'tk' }),
  ]);
  const createdValue = payload(createdRpc.find((item) => item.id === 2));
  assert.equal(createdValue.ok, true, createdValue.blocker);
  write(createdValue.path, 'src/app.js', 'export const v = 21;\n');

  const responses = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'land', task_id: 'tk', run_checks: false, commit: true }),
  ]);
  const response = responses.find((item) => item.id === 2);
  assert.equal(response.result.isError, false, JSON.stringify(response));
  const landed = payload(response);
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ran, false);
  assert.equal(landed.commit.created, true);
  assert.equal(landed.commit.subject, 'harness: land tk');
  assert.equal(gitAt(root, 'log', '-1', '--format=%s').trim(), 'harness: land tk');
  assert.equal(gitAt(root, 'status', '--porcelain').trim(), '');
});

test('full lifecycle leaves the target repo working tree byte-identical', () => {
  const root = makeRepo();
  const before = snapshotWorkingTree(root);
  const created = createWorktree(root, 'task-life');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 3;\n');
  listWorktrees(root);
  const diff = diffWorktree(root, 'task-life');
  assert.equal(diff.ok, true);
  gitAt(created.path, 'checkout', '--', 'src/app.js');
  const removed = removeWorktree(root, 'task-life');
  assert.equal(removed.ok, true, removed.blocker);
  assert.deepEqual(snapshotWorkingTree(root), before);
  assert.equal(gitAt(root, 'status', '--porcelain').trim(), '');
});

test('land applies tracked and untracked work to a clean base without committing', () => {
  const root = makeRepo();
  const created = createWorktree(root, 'task-land');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 5;\n');
  write(created.path, 'src/new-module.js', 'export const fresh = true;\n');

  const landed = landWorktree(root, 'task-land');
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.task_id, 'task-land');
  assert.deepEqual([...landed.applied_files].sort(), ['src/app.js', 'src/new-module.js']);
  assert.equal(landed.applied_count, 2);
  assert.ok(landed.patch_bytes > 0);
  assert.equal(landed.truncated, false);
  assert.ok(landed.patch.includes('+export const v = 5;'), landed.patch);
  assert.ok(landed.patch.includes('new-module.js'), landed.patch);
  assert.equal(landed.worktree, created.path);
  assert.equal(landed.base, canonicalPath(root));

  // Both the edit and the new file are now in the main checkout.
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 5;\n');
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'new-module.js'), 'utf8'),
    'export const fresh = true;\n',
  );
  // History untouched: land stages nothing in the base and never commits.
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(gitAt(root, 'diff', '--cached').trim(), '');
  // The base is dirty by design, which also blocks a second land.
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
  const again = landWorktree(root, 'task-land');
  assert.equal(again.ok, false);
  assert.equal(again.rule, 'worktree.dirty');
  // The worktree survives landing and stays registered; removal is explicit.
  assert.ok(fs.existsSync(created.path));
  assert.ok(readWorktrees(root).worktrees['task-land']);
});

test('land refuses a dirty base, a conflicting patch, an empty worktree, and a missing worktree', () => {
  // Dirty base: refused before staging or applying anything.
  const dirty = makeRepo();
  const dirtyWt = createWorktree(dirty, 'task-land-dirty');
  assert.equal(dirtyWt.ok, true, dirtyWt.blocker);
  write(dirtyWt.path, 'src/app.js', 'export const v = 6;\n');
  write(dirty, 'stray.txt', 'base has its own edits\n');
  const refused = landWorktree(dirty, 'task-land-dirty');
  assert.equal(refused.ok, false);
  assert.equal(refused.rule, 'worktree.dirty');
  assert.match(refused.blocker, /not clean/);
  assert.equal(fs.readFileSync(path.join(dirty, 'src', 'app.js'), 'utf8'), 'export const v = 1;\n');

  // Base advanced with a conflicting commit: --check rejects, nothing lands.
  const root = makeRepo();
  const created = createWorktree(root, 'task-land-conflict');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 7;\n');
  write(root, 'src/app.js', 'export const v = 8;\n');
  gitAt(root, 'commit', '-am', 'base moved', '--quiet');
  const blocked = landWorktree(root, 'task-land-conflict');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rule, 'worktree.apply_check');
  assert.match(blocked.blocker, /does not apply/);
  assert.equal(gitAt(root, 'status', '--porcelain').trim(), '');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 8;\n');

  // Worktree without changes: nothing to land.
  const idle = makeRepo();
  const idleWt = createWorktree(idle, 'task-land-empty');
  assert.equal(idleWt.ok, true, idleWt.blocker);
  const empty = landWorktree(idle, 'task-land-empty');
  assert.equal(empty.ok, false);
  assert.equal(empty.rule, 'worktree.empty');
  assert.equal(gitAt(idle, 'status', '--porcelain').trim(), '');

  // Unknown or already-removed worktree ids are refused like diff/remove.
  const ghost = landWorktree(root, 'ghost-task');
  assert.equal(ghost.ok, false);
  assert.equal(ghost.rule, 'worktree.missing');
});

test('land caps the returned patch but reports the full byte size', () => {
  const root = makeRepo();
  const created = createWorktree(root, 'task-land-bound');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/big.js', `${'x'.repeat(5000)}\n`);

  const landed = landWorktree(root, 'task-land-bound', { maxPatchChars: 100 });
  assert.equal(landed.ok, true, landed.blocker);
  assert.ok(landed.patch.length <= 100, `patch must stay bounded, got ${landed.patch.length}`);
  assert.equal(landed.truncated, true);
  assert.ok(landed.patch_bytes > 100);
  assert.ok(fs.existsSync(path.join(root, 'src', 'big.js')));
});

test('dispatch gate: code briefs require a resolvable task_id with completed deps', () => {
  const root = dispatchRoot();

  // No task_id in the dispatch: denied with the required prompt line.
  const noId = runHook(root, 'PreToolUse', dispatchPayload('Agent', { prompt: 'implement the feature' }));
  assert.match(denyReasonOf(noId), /task_id: <plan id>/);

  // task_id present but not in the plan: denied.
  const unknown = runHook(root, 'PreToolUse', dispatchPayload('Agent', { prompt: 'task_id: T9\nimplement' }));
  assert.match(denyReasonOf(unknown), /not in the plan/);

  // Dependency pending: denied with the missing id and status (= form too).
  const blocked = runHook(root, 'PreToolUse', dispatchPayload('Task', { description: 'TASK_ID = T2' }));
  assert.match(denyReasonOf(blocked), /T1\(pending\)/);

  // All dependencies completed: the exact registered worktree is required.
  updatePlanTask(root, 'T1', { status: 'completed' });
  upsertWorktree(root, 'T2', {
    task_id: 'T2',
    path: 'C:\\mhe-worktrees\\T2',
    status: 'active',
  });
  const noWorktree = runHook(root, 'PreToolUse', dispatchPayload('Agent', { prompt: 'task_id: T2\nimplement' }));
  assert.match(denyReasonOf(noWorktree), /must include worktree/);
  const wrongWorktree = runHook(root, 'PreToolUse', dispatchPayload('Agent', {
    prompt: 'task_id: T2\nworktree: C:\\mhe-worktrees\\T9\nimplement',
  }));
  assert.match(denyReasonOf(wrongWorktree), /worktree path mismatch/);
  const allowed = runHook(root, 'PreToolUse', dispatchPayload('Agent', {
    prompt: 'task_id: T2\nworktree: C:\\mhe-worktrees\\T2\nimplement',
  }));
  assert.equal(allowed.trim(), '');

  // A completed + deterministic-checked task cannot dispatch another worker;
  // it must be landed.
  updatePlanTask(root, 'T2', { status: 'completed' });
  writeLastCheck(root, {
    ok: true,
    task_ids: ['T2'],
    worktree: 'C:\\mhe-worktrees\\T2',
    checked: ['scope'],
    summary: { blockers: 0, warnings: 0, infos: 0 },
  });
  const verified = runHook(root, 'PreToolUse', dispatchPayload('Agent', {
    prompt: 'task_id: T2\nworktree: C:\\mhe-worktrees\\T2\nreview it',
  }));
  assert.match(denyReasonOf(verified), /already verified/);

  upsertWorktree(root, 'T2', {
    task_id: 'T2',
    path: 'C:\\mhe-worktrees\\T2',
    status: 'landed',
  });
  const landed = runHook(root, 'PreToolUse', dispatchPayload('Agent', {
    prompt: 'task_id: T2\nworktree: C:\\mhe-worktrees\\T2\nreview it again',
  }));
  assert.match(denyReasonOf(landed), /already landed/);

  // The base subagent policy still wins over the gate for unregistered roles.
  const foreign = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Plan', prompt: 'task_id: T2' },
  });
  assert.match(denyReasonOf(foreign), /only delegate/);
});

test('dispatch gate is inert for non-code briefs and worker events', () => {
  for (const profile of ['docs', 'general']) {
    const root = dispatchRoot(profile);
    const unbothered = runHook(root, 'PreToolUse', dispatchPayload('Agent', { prompt: 'translate the guide' }));
    assert.equal(unbothered.trim(), '', profile);
  }

  // No brief at all: the profile is undeclared, so only read-only workers
  // stay dispatchable.
  const bare = makeRepo();
  saveConfig(bare, {
    capabilities: resolveCapabilities({ availableAgents: ['general-purpose', 'Explore'] }),
  });
  const noBrief = runHook(bare, 'PreToolUse', dispatchPayload('Agent', { prompt: 'no plan needed' }));
  assert.match(denyReasonOf(noBrief), /enhance_brief/);
  const bareReadOnly = runHook(bare, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'look around' },
  });
  assert.equal(bareReadOnly.trim(), '');

  // Worker events keep their own policy, untouched by the dispatch gate.
  const root = dispatchRoot();
  updatePlanTask(root, 'T1', { status: 'completed' });
  const worker = runHook(root, 'PreToolUse', {
    agent_type: 'general-purpose',
    tool_name: 'Task',
    tool_input: { subagent_type: 'general-purpose', prompt: 'task_id: T2' },
  });
  assert.match(denyReasonOf(worker), /leaf worker/);

  // Non-dispatch conductor tools are unaffected even under a code brief.
  const mcp = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness-enhance__enhance_worktree',
    tool_input: {},
  });
  assert.equal(mcp.trim(), '');
});

test('command:test falls back to node --test when package.json has no scripts', () => {
  const root = makeRepo();
  write(root, 'package.json', `${JSON.stringify({ name: 'no-scripts' }, null, 2)}\n`);
  write(
    root,
    'test/example.test.mjs',
    'import test from "node:test";\nimport assert from "node:assert/strict";\n'
      + 'test("one", () => assert.equal(1, 1));\n',
  );
  const brief = buildBrief(root, { profile: 'code', checks: ['command:test'] });
  const config = loadConfig(root).config;
  const result = runBriefChecks(root, brief, config, ['command:test']);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(
    result.findings.some((item) => /tests 1|pass 1/.test(item.message)),
    JSON.stringify(result.findings),
  );
});

test('land includes committed worktree work, marks the task completed, and resets for removal', () => {
  const root = makeRepo();
  writePlan(root, [{ id: 'T1', title: 'change app', status: 'in_progress' }], { replace: true });
  const created = createWorktree(root, 'T1');
  assert.equal(created.ok, true, created.blocker);
  assert.match(created.prompt_prefix, /task_id: T1/);
  assert.match(created.prompt_prefix, /worktree: /);

  write(created.path, 'src/app.js', 'export const v = 2;\n');
  gitAt(created.path, 'add', '-A');
  gitAt(created.path, 'commit', '-m', 'worker commit', '--quiet');

  // A committed worktree still diffs against the creation base.
  const diff = diffWorktree(root, 'T1');
  assert.equal(diff.ok, true, diff.blocker);
  assert.equal(diff.changed_count, 1);
  assert.match(diff.patch, /\+export const v = 2;/);

  const landed = landWorktree(root, 'T1', { runChecks: false, commit: true });
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.task_status, 'completed');
  assert.equal(landed.commit.created, true);
  assert.equal(readPlan(root).tasks[0].status, 'completed');
  assert.equal(readWorktrees(root).worktrees.T1.status, 'landed');
  const recreate = createWorktree(root, 'T1');
  assert.equal(recreate.ok, false);
  assert.equal(recreate.rule, 'worktree.task_completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'export const v = 2;\n');
  assert.equal(diffWorktree(root, 'T1').changed_count, 0, 'worktree reset after landing');

  const removed = removeWorktree(root, 'T1');
  assert.equal(removed.ok, true, removed.blocker);
});

test('MCP code check requires the worktree and defers completion until landing', () => {
  const root = makeRepo();
  writePlan(root, [
    { id: 'T1', title: 'change app', status: 'pending' },
    { id: 'T2', title: 'verify app', status: 'pending', depends_on: ['T1'] },
  ], { replace: true });
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    ownership: ['src/**'],
    checks: ['scope'],
  }));
  const created = createWorktree(root, 'T1');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 3;\n');

  const responses = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_check', { task_ids: ['T2'], worktree: created.path }),
    rpcCall(3, 'enhance_check', { task_ids: ['T2'] }),
  ]);
  const checked = payload(responses.find((item) => item.id === 2));
  assert.equal(checked.ok, true, JSON.stringify(checked.findings));
  assert.equal(checked.land_required, true);
  assert.equal(checked.worktree_task_id, 'T1');
  assert.deepEqual(checked.task_ids_completed, []);
  assert.deepEqual(checked.task_ids_pending_land, ['T1']);
  assert.deepEqual(checked.task_ids_blocked_by_land, ['T2']);
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'in_progress');
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T2').status, 'pending');
  assert.equal(readWorktrees(root).worktrees.T1.status, 'active');

  const bypass = responses.find((item) => item.id === 3);
  assert.equal(bypass.result.isError, true);
  assert.match(bypass.result.content[0].text, /worktree\.check_required|worktree\.required|active worktree/);

  const landed = landWorktree(root, 'T1', { runChecks: false });
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'completed');
  removeWorktree(root, 'T1');
});

test('Qoder Stop blocks completion while a code worktree is unlanded', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    ownership: ['src/**'],
    checks: ['scope', 'command:test'],
  }));
  writePlan(root, [{ id: 'T1', title: 'change app', status: 'in_progress' }], { replace: true });
  const created = createWorktree(root, 'T1');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 5;\n');

  const blocked = JSON.parse(runHook(root, 'Stop', {}));
  assert.equal(blocked.decision, 'deny');
  assert.match(blocked.reason, /not landed/);
  assert.match(blocked.reason, /T1/);

  // stop_hook_active prevents an endless block loop: one enforcement attempt.
  assert.equal(runHook(root, 'Stop', { stop_hook_active: true }).trim(), '');

  execFileSync('git', ['-C', created.path, 'reset', '--hard'], { stdio: 'ignore' });
  const removed = removeWorktree(root, 'T1');
  assert.equal(removed.ok, true, removed.blocker);
  assert.equal(runHook(root, 'Stop', {}).trim(), '');
});

test('Qoder PostToolUse tells the conductor to land a changed code worktree', () => {
  const root = makeRepo();
  writePlan(root, [{ id: 'T1', title: 'change app', status: 'in_progress' }], { replace: true });
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    ownership: ['src/**'],
    checks: ['scope'],
  }));
  const created = createWorktree(root, 'T1');
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 4;\n');

  const output = runHook(root, 'PostToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'task_id: T1' },
    tool_response: JSON.stringify({
      status: 'ok',
      summary: 'Edited the app.',
      evidence: [],
      artifacts: [],
      open_questions: [],
      next: '',
      task_id: 'T1',
    }),
  });
  assert.ok(output.trim(), 'expected hook JSON output');
  const raw = JSON.parse(output).hookSpecificOutput.updatedToolOutput;
  const [envelopeJson, ...reminders] = raw.split('\n\n[NOW] ');
  const envelope = JSON.parse(envelopeJson);
  assert.match(envelope.next, /not landed/);
  assert.match(envelope.next, /enhance_worktree land/);
  assert.equal(reminders.length, 1, 'the frontier reminder follows the envelope');
  assert.match(reminders[0], /T1|no ready task/);

  execFileSync('git', ['-C', created.path, 'reset', '--hard'], { stdio: 'ignore' });
  removeWorktree(root, 'T1');
});

test('a dirty base is refused by default and names the carry escape hatch', () => {
  const root = makeRepo();
  write(root, 'src/app.js', 'export const v = 2;\n');
  const refused = createWorktree(root, 'task-dirty');
  assert.equal(refused.ok, false);
  assert.equal(refused.rule, 'worktree.dirty');
  assert.match(refused.blocker, /carry_base/);
});

test('carry_base=true starts the worktree from the base uncommitted state', () => {
  const root = makeRepo();
  write(root, 'src/app.js', 'export const v = 2;\n');
  const created = createWorktree(root, 'task-carry', { carryBase: true });
  assert.equal(created.ok, true, created.blocker);
  assert.equal(
    fs.readFileSync(path.join(created.path, 'src', 'app.js'), 'utf8'),
    'export const v = 2;\n',
  );
  assert.equal(gitAt(created.path, 'status', '--porcelain').trim(), '');
  // The base keeps its own uncommitted state, untouched.
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 2;\n');
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
});

test('land adds the task work on top of the carried state', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['src/**'], checks: ['scope'] }));
  write(root, 'src/app.js', 'export const v = 2;\n');
  const created = createWorktree(root, 'task-carry-land', { carryBase: true });
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 3;\n');
  write(created.path, 'src/extra.js', 'export const extra = 1;\n');

  const landed = landWorktree(root, 'task-carry-land');
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 3;\n');
  assert.ok(fs.existsSync(path.join(root, 'src', 'extra.js')));
  // The base is still uncommitted: carrying never commits for the user.
  assert.equal(gitAt(root, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
});

test('a failed land restores the carried base exactly', () => {
  const root = makeRepo();
  writeBrief(root, buildBrief(root, { profile: 'code', ownership: ['docs/**'], checks: ['scope'] }));
  write(root, 'src/app.js', 'export const v = 2;\n');
  const before = gitAt(root, 'status', '--porcelain', '--untracked-files=all');
  const created = createWorktree(root, 'task-carry-fail', { carryBase: true });
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 3;\n');
  write(created.path, 'src/rogue.js', 'nope\n');

  const failed = landWorktree(root, 'task-carry-fail');
  assert.equal(failed.ok, false);
  assert.equal(failed.rule, 'worktree.checks_failed');
  assert.equal(failed.reverted, true);
  assert.equal(gitAt(root, 'status', '--porcelain', '--untracked-files=all'), before);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 2;\n');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'rogue.js')));
});

test('land refuses a base that moved on after the carry', () => {
  const root = makeRepo();
  write(root, 'src/app.js', 'export const v = 2;\n');
  const created = createWorktree(root, 'task-carry-moved', { carryBase: true });
  assert.equal(created.ok, true, created.blocker);
  write(created.path, 'src/app.js', 'export const v = 3;\n');
  write(root, 'src/app.js', 'export const v = 99;\n');

  const landed = landWorktree(root, 'task-carry-moved');
  assert.equal(landed.ok, false);
  assert.equal(landed.rule, 'worktree.base_changed');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'export const v = 99;\n');
});

test('MCP enhance_worktree carries a dirty base only when asked', () => {
  const root = makeRepo();
  writePlan(root, [{ id: 'task-carry-rpc', title: 'task', status: 'pending' }], { replace: true });
  write(root, 'src/app.js', 'export const v = 2;\n');

  const refusedRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'create', task_id: 'task-carry-rpc' }),
  ]);
  const refused = payload(refusedRpc.find((item) => item.id === 2));
  assert.equal(refused.ok, false);
  assert.equal(refused.rule, 'worktree.dirty');
  assert.match(refused.blocker, /carry_base/);

  const carriedRpc = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_worktree', { action: 'create', task_id: 'task-carry-rpc', carry_base: true }),
  ]);
  const carried = payload(carriedRpc.find((item) => item.id === 2));
  assert.equal(carried.ok, true, carried.blocker);
  assert.equal(
    fs.readFileSync(path.join(carried.path, 'src', 'app.js'), 'utf8'),
    'export const v = 2;\n',
  );
  assert.equal(gitAt(carried.path, 'status', '--porcelain').trim(), '');
  assert.match(gitAt(root, 'status', '--porcelain'), /src\/app\.js/);
});
