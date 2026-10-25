import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendDecision,
  appendJournal,
  appendMetric,
  ensureSession,
  initStore,
  legacyStateFiles,
  listSessionDirs,
  markSession,
  readDecisions,
  readGoal,
  readJobs,
  readLastCheck,
  readMetrics,
  readPlan,
  readWorktrees,
  sessionKey,
  storePaths,
  upsertJob,
  upsertWorktree,
  writeBrief,
  writeGoal,
  writePlan,
} from '../src/core/store.mjs';
import { buildCapsule, writeCapsule } from '../src/core/capsule.mjs';
import { canonicalPath } from '../src/core/state-root.mjs';
import { buildBrief } from '../src/core/brief.mjs';
import { summarizeMetrics } from '../src/core/metrics.mjs';
import { putArtifact } from '../src/core/artifacts.mjs';
import { resolveCapabilities } from '../src/core/capabilities.mjs';
import {
  createWorktree,
  landWorktree,
  listWorktrees,
  projectWorktreesDir,
  removeWorktree,
} from '../src/core/worktree.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-session-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'src', 'mcp', 'recall-server.mjs');
const CLI = path.resolve(HERE, '..', 'bin', 'mhe.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-session-project-'));
  initStore(root, {
    harness: 'qoder',
    capabilities: resolveCapabilities({ availableAgents: ['general-purpose', 'Explore'] }),
  });
  return root;
}

function runHook(root, event, payload) {
  const hook = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'hook.mjs');
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [hook, event], {
    input: JSON.stringify(payload),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout || '';
}

function runRpc(root, messages, envOverride = {}) {
  const input = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  env.MY_HARNESS_ENHANCE_PROJECT = root;
  Object.assign(env, envOverride);
  const result = spawnSync(process.execPath, [SERVER], {
    input,
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function rpcCall(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function rpcInit(id = 1) {
  return { jsonrpc: '2.0', id, method: 'initialize', params: {} };
}

function resultOf(responses, id) {
  return responses.find((item) => item.id === id).result;
}

test('sessionKey normalizes host ids but keeps ordinary UUIDs readable', () => {
  assert.equal(sessionKey('AEB-BAD_10/../X'), 'aeb-bad10x');
  assert.equal(
    sessionKey('aebbad10-e969-468e-bbfc-202aa5d9c5a2'),
    'aebbad10-e969-468e-bbfc-202aa5d9c5a2',
  );
  assert.equal(sessionKey(''), 'default');
  assert.equal(sessionKey('---'), '---');
  assert.equal(sessionKey('x'.repeat(100)).length, 64);
});

test('storePaths keeps legacy paths without a session and shards working state with one', () => {
  const root = makeRoot();
  const legacy = storePaths(root);
  assert.equal(legacy.sessionDir, '');
  assert.equal(legacy.goal, path.join(legacy.dir, 'goal.json'));
  assert.equal(legacy.metrics, path.join(legacy.dir, 'metrics.jsonl'));

  const sharded = storePaths(root, 'Session_A');
  assert.equal(sharded.dir, legacy.dir);
  assert.equal(sharded.sessionDir, path.join(legacy.dir, 'sessions', 'sessiona'));
  assert.equal(sharded.goal, path.join(sharded.sessionDir, 'goal.json'));
  assert.equal(sharded.jobs, path.join(sharded.sessionDir, 'jobs.json'));
  assert.equal(sharded.worktrees, path.join(sharded.sessionDir, 'worktrees.json'));
  assert.equal(sharded.metrics, legacy.metrics);
  assert.equal(sharded.decisions, legacy.decisions);
  assert.equal(sharded.sessions, legacy.sessions);
  assert.equal(sharded.artifacts, legacy.artifacts);
});

test('two sessions isolate goal, plan, jobs, capsule, and worktrees but share project state', () => {
  const root = makeRoot();
  writeGoal(root, { text: 'goal A' }, 's1');
  writeGoal(root, { text: 'goal B' }, 's2');
  writePlan(root, [{ id: 'T1', title: 'A task' }], { replace: true }, 's1');
  writePlan(root, [{ id: 'T2', title: 'B task' }], { replace: true }, 's2');
  upsertJob(root, 'job-a', { agent_id: 'a', status: 'running' }, 's1');
  upsertJob(root, 'job-b', { agent_id: 'b', status: 'running' }, 's2');
  upsertWorktree(root, 'T1', { path: path.join(root, 'wt-a'), status: 'active' }, 's1');
  upsertWorktree(root, 'T2', { path: path.join(root, 'wt-b'), status: 'active' }, 's2');
  writeCapsule(root, { session: 's1' });
  writeCapsule(root, { session: 's2' });
  appendJournal(root, 'journal A', 's1');
  appendJournal(root, 'journal B', 's2');

  assert.equal(readGoal(root, 's1').text, 'goal A');
  assert.equal(readGoal(root, 's2').text, 'goal B');
  assert.deepEqual(readPlan(root, 's1').tasks.map((task) => task.id), ['T1']);
  assert.deepEqual(readPlan(root, 's2').tasks.map((task) => task.id), ['T2']);
  assert.equal(readJobs(root, 's1').jobs[0].id, 'job-a');
  assert.equal(readJobs(root, 's2').jobs[0].id, 'job-b');
  assert.ok(readWorktrees(root, 's1').worktrees.T1);
  assert.ok(readWorktrees(root, 's2').worktrees.T2);
  assert.match(fs.readFileSync(storePaths(root, 's1').journal, 'utf8'), /journal A/);
  assert.doesNotMatch(fs.readFileSync(storePaths(root, 's1').journal, 'utf8'), /journal B/);
  assert.ok(!fs.existsSync(storePaths(root).journal));
  assert.equal(readGoal(root).text, '');

  const capsuleA = buildCapsule(root, { session: 's1' });
  assert.match(capsuleA, /goal A/);
  assert.doesNotMatch(capsuleA, /goal B/);
  assert.match(capsuleA, /## SESSION\ns1 \(/);

  // Project-level state is intentionally shared.
  appendDecision(root, 'shared decision', 'why', 's1');
  appendMetric(root, { event: 'shared_metric' }, 's1');
  putArtifact(root, { content: 'shared evidence', kind: 'note', summary: 'shared' });
  assert.equal(readDecisions(root, 5).length, 1);
  assert.equal(readDecisions(root, 5)[0].session, 's1');
  assert.equal(readMetrics(root, 5).length, 1);
  assert.ok(fs.existsSync(storePaths(root).metrics));
  assert.ok(fs.existsSync(storePaths(root).artifactIndex));
  assert.ok(!fs.existsSync(path.join(storePaths(root, 's1').sessionDir, 'metrics.jsonl')));
});

test('legacy adoption copies state, never moves it, and is idempotent', () => {
  const root = makeRoot();
  writeGoal(root, { text: 'legacy goal' });
  writePlan(root, [{ id: 'L1', title: 'legacy task' }], { replace: true });
  assert.deepEqual(legacyStateFiles(root).sort(), ['goal.json', 'plan.json']);

  ensureSession(root, 'newsession');
  const session = storePaths(root, 'newsession');
  assert.equal(readGoal(root, 'newsession').text, 'legacy goal');
  assert.deepEqual(readPlan(root, 'newsession').tasks.map((task) => task.id), ['L1']);
  assert.ok(fs.existsSync(storePaths(root).goal), 'legacy goal must stay in place');

  // A later legacy edit does not overwrite the adopted session copy.
  writeGoal(root, { text: 'legacy changed', replace: true });
  ensureSession(root, 'newsession');
  assert.equal(readGoal(root, 'newsession').text, 'legacy goal');
  assert.equal(readGoal(root).text, 'legacy changed');
});

test('session reads fall back to legacy project files when the shard lacks one', () => {
  const root = makeRoot();
  writeGoal(root, { text: 'fallback goal' });
  fs.mkdirSync(storePaths(root, 'bare').sessionDir, { recursive: true });
  assert.equal(readGoal(root, 'bare').text, 'fallback goal');
  assert.deepEqual(listSessionDirs(root), ['bare']);
});

test('hook SessionStart shards state, records the host session, and marks the capsule', () => {
  const root = makeRoot();
  const hook = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'hook.mjs');
  writeGoal(root, { text: 'legacy conductor goal' });
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const started = spawnSync(process.execPath, [hook, 'SessionStart'], {
    input: JSON.stringify({
      model: 'qfmodel',
      source: 'startup',
      session_id: 'Host-Session-1',
    }),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /## SESSION\nhost-session-1 \(/);

  const session = storePaths(root, 'host-session-1');
  assert.ok(fs.existsSync(session.capsule));
  assert.equal(readGoal(root, 'host-session-1').text, 'legacy conductor goal');
  assert.ok(fs.existsSync(storePaths(root).goal), 'legacy state is kept');
  const registry = JSON.parse(fs.readFileSync(storePaths(root).sessions, 'utf8'));
  assert.equal(registry.sessions['Host-Session-1'].host_pid, process.pid);
  assert.equal(registry.sessions['Host-Session-1'].cwd, root);
  assert.equal(registry.sessions['Host-Session-1'].created_at.length > 0, true);
});

test('two hook sessions keep goals, jobs, and capsules apart while metrics stay shared', () => {
  const root = makeRoot();
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup', session_id: 'Session-A' });
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup', session_id: 'Session-B' });
  runHook(root, 'UserPromptSubmit', { session_id: 'Session-A', prompt: 'parentheses, 37, restructure' });
  runHook(root, 'UserPromptSubmit', { session_id: 'Session-B', prompt: 'other task, 91, unrelated' });
  runHook(root, 'SubagentStart', {
    session_id: 'Session-A',
    agent_id: 'agent-a',
    agent_type: 'Explore',
  });
  runHook(root, 'SubagentStart', {
    session_id: 'Session-B',
    agent_id: 'agent-b',
    agent_type: 'general-purpose',
  });

  assert.equal(readGoal(root, 'session-a').text, 'parentheses, 37, restructure');
  assert.equal(readGoal(root, 'session-b').text, 'other task, 91, unrelated');
  assert.deepEqual(readJobs(root, 'session-a').jobs.map((job) => job.agent_id), ['agent-a']);
  assert.deepEqual(readJobs(root, 'session-b').jobs.map((job) => job.agent_id), ['agent-b']);
  assert.match(
    fs.readFileSync(storePaths(root, 'session-a').capsule, 'utf8'),
    /\[MY-HARNESS-ENHANCE CAPSULE[\s\S]*parentheses, 37/,
  );
  assert.match(
    fs.readFileSync(storePaths(root, 'session-b').capsule, 'utf8'),
    /\[MY-HARNESS-ENHANCE CAPSULE[\s\S]*other task, 91/,
  );

  const metrics = readMetrics(root, 50);
  assert.ok(metrics.every((entry) => ['session-a', 'session-b'].includes(entry.session)));
  assert.deepEqual(
    [...new Set(metrics.map((entry) => entry.session))].sort(),
    ['session-a', 'session-b'],
  );
});

test('every hook metric event for a session carries the normalized session id', () => {
  const root = makeRoot();
  appendMetric(root, { event: 'session_start' }, 'Host_Session');
  appendMetric(root, { event: 'job_start' });
  const metrics = readMetrics(root, 10);
  assert.equal(metrics[0].session, 'hostsession');
  assert.equal(metrics[1].session, undefined);

  const filtered = summarizeMetrics(metrics, { session: 'HOST_SESSION' });
  assert.equal(filtered.entries, 1);
  assert.equal(filtered.session, 'hostsession');
  const all = summarizeMetrics(metrics);
  assert.equal(all.entries, 2);
  assert.deepEqual(all.sessions, { hostsession: 1 });
});

test('MCP resolves session by argument, env, host process, then a unique shard', () => {
  const root = makeRoot();
  writeGoal(root, { text: 'arg goal' }, 'arg-session');
  writeGoal(root, { text: 'env goal' }, 'env-session');

  const byArg = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_state', { session: 'ARG-SESSION' }),
  ]);
  assert.match(resultOf(byArg, 2).content[0].text, /arg goal/);
  assert.match(resultOf(byArg, 2).content[0].text, /## SESSION\narg-session \(/);

  const byEnv = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_state', {}),
  ], { MY_HARNESS_ENHANCE_SESSION: 'env-session' });
  assert.match(resultOf(byEnv, 2).content[0].text, /env goal/);

  markSession(root, 'host-session', { host_pid: process.pid, cwd: root, source: 'startup' });
  const byHost = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_state', {}),
    rpcCall(3, 'enhance_decide', { decision: 'host decision' }),
  ]);
  assert.match(resultOf(byHost, 2).content[0].text, /## SESSION\nhost-session \(/);
  const decision = JSON.parse(resultOf(byHost, 3).content[0].text);
  assert.equal(decision.session, 'host-session');
  assert.ok(fs.existsSync(storePaths(root).decisions));

  const single = makeRoot();
  writeGoal(single, { text: 'only goal' }, 'only');
  const byDir = runRpc(single, [
    rpcInit(),
    rpcCall(2, 'enhance_state', {}),
  ]);
  assert.match(resultOf(byDir, 2).content[0].text, /only goal/);
});

test('MCP reports an ambiguous host session instead of guessing', () => {
  const root = makeRoot();
  markSession(root, 'host-a', { host_pid: process.pid, cwd: root });
  markSession(root, 'host-b', { host_pid: process.pid, cwd: root });
  const responses = runRpc(root, [
    rpcInit(),
    rpcCall(2, 'enhance_state', {}),
  ]);
  const result = resultOf(responses, 2);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ambiguous session/i);
  assert.match(result.content[0].text, /pass session=/i);
});

test('report --session filters metrics and prints the resolved shard', () => {
  const root = makeRoot();
  appendMetric(root, { event: 'session_start' }, 's1');
  appendMetric(root, { event: 'job_start' }, 's1');
  appendMetric(root, { event: 'session_start' }, 's2');

  const cliEnv = { ...process.env };
  delete cliEnv.MY_HARNESS_ENHANCE_PROJECT;
  delete cliEnv.MY_HARNESS_ENHANCE_SESSION;
  delete cliEnv.MY_HARNESS_ENHANCE_GLOBAL;
  const filtered = spawnSync(process.execPath, [CLI, 'report', '--root', root, '--session', 'S1'], {
    env: cliEnv,
    encoding: 'utf8',
  });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /session: s1/);
  assert.match(filtered.stdout, /entries: 2/);

  const aggregate = spawnSync(process.execPath, [CLI, 'report', '--root', root], {
    env: cliEnv,
    encoding: 'utf8',
  });
  assert.equal(aggregate.status, 0, aggregate.stderr);
  assert.match(aggregate.stdout, /entries: 3/);
  assert.match(aggregate.stdout, /sessions: s1=2, s2=1/);
});

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-session-repo-')));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.email', 'mhe@example.invalid');
  git('config', 'user.name', 'mhe test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'initial', '--quiet');
  initStore(root);
  return root;
}

test('worktrees live under the session key and legacy worktrees stay readable', () => {
  const root = makeRepo();
  const session = 'Session_A';
  const created = createWorktree(root, 'T1', { session });
  assert.equal(created.ok, true, created.blocker);
  assert.equal(
    created.path,
    canonicalPath(path.join(projectWorktreesDir(root, session), 'T1')),
  );
  assert.ok(created.path.includes(`${path.sep}${sessionKey(session)}${path.sep}`));
  assert.ok(readWorktrees(root, session).worktrees.T1);
  assert.ok(!fs.existsSync(storePaths(root).worktrees), 'legacy registry must stay untouched');
  const listed = listWorktrees(root, { session });
  assert.ok(listed.worktrees.some((item) => item.task_id === 'T1'));

  const legacy = createWorktree(root, 'T2');
  assert.equal(legacy.ok, true, legacy.blocker);
  assert.equal(legacy.path, canonicalPath(path.join(projectWorktreesDir(root), 'T2')));
  // The session registry is copied from legacy by adoption; both paths resolve.
  const fallback = storePaths(root, 'Session_B');
  fs.mkdirSync(fallback.sessionDir, { recursive: true });
  fs.copyFileSync(storePaths(root).worktrees, fallback.worktrees);
  const listedLegacy = listWorktrees(root, { session: 'Session_B' });
  assert.ok(listedLegacy.worktrees.some((item) => item.task_id === 'T2'));
  const removed = removeWorktree(root, 'T2', { session: 'Session_B' });
  assert.equal(removed.ok, true, removed.blocker);
});

test('land uses the session brief and plan, leaving legacy state untouched', () => {
  const root = makeRepo();
  const session = 'land-session';
  writePlan(root, [{ id: 'L1', title: 'edit app' }], { replace: true }, session);
  writeBrief(root, buildBrief(root, {
    profile: 'code',
    ownership: ['app.js'],
    checks: ['scope'],
  }), session);

  const created = createWorktree(root, 'L1', { session });
  assert.equal(created.ok, true, created.blocker);
  fs.writeFileSync(path.join(created.path, 'app.js'), 'export const v = 2;\n');

  const landed = landWorktree(root, 'L1', { session });
  assert.equal(landed.ok, true, landed.blocker);
  assert.equal(landed.checks.ok, true);
  assert.equal(readPlan(root, session).tasks.find((task) => task.id === 'L1').status, 'completed');
  assert.equal(readLastCheck(root, session).landed, true);
  assert.deepEqual(readPlan(root).tasks, []);
  assert.equal(readLastCheck(root), null);
});
