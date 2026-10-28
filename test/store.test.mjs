import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendDecision,
  appendMetric,
  findJobByAgent,
  initStore,
  newJobId,
  readDecisions,
  readGoal,
  readJobs,
  readLastCheck,
  readMetrics,
  readPlan,
  readSession,
  storePaths,
  updatePlanTask,
  upsertJob,
  withLock,
  writeLastCheck,
  writeGoal,
  writePlan,
  writeSession,
} from '../src/core/store.mjs';
import { loadConfig } from '../src/core/config.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.resolve(HERE, '..', 'src', 'core', 'store.mjs');

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-store-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-store-project-'));
}

test('goal is set once and can be replaced', () => {
  const root = tmpRoot();
  initStore(root);
  const first = writeGoal(root, {
    text: 'Build a health endpoint',
    acceptance: ['200 ok'],
    constraints: ['no new deps'],
  });
  assert.equal(first.version, 1);
  assert.equal(readGoal(root).text, 'Build a health endpoint');

  const second = writeGoal(root, { text: 'Different goal' });
  assert.equal(second.version, 1);
  assert.equal(readGoal(root).text, 'Build a health endpoint');

  const replaced = writeGoal(root, {
    text: 'Different goal',
    acceptance: ['x'],
    replace: true,
  });
  assert.equal(replaced.version, 2);
  assert.equal(readGoal(root).text, 'Different goal');
  assert.deepEqual(readGoal(root).acceptance, ['x']);
});

test('plan merges by task id and replace works', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [
    { id: 't1', title: 'one', worker: 'general-purpose' },
    { id: 't2', title: 'two', worker: 'general-purpose' },
  ]);
  writePlan(root, [{ id: 't1', title: 'one', status: 'done' }]);
  const plan = readPlan(root);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks.find((task) => task.id === 't1').status, 'done');

  writePlan(root, [{ id: 't9', title: 'nine' }], { replace: true });
  assert.equal(readPlan(root).tasks.length, 1);
});

test('plan accepts id-only tasks and falls back to id as title', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{ id: 't-only', status: 'pending' }]);
  const task = readPlan(root).tasks.find((item) => item.id === 't-only');
  assert.equal(task.title, 't-only');
});

test('decisions are append-only', () => {
  const root = tmpRoot();
  initStore(root);
  appendDecision(root, 'Use supertest', 'existing harness');
  appendDecision(root, 'No new deps', 'constraint');
  const decisions = readDecisions(root, 10);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].decision, 'Use supertest');
});

test('decision and metric readers use the tail across chunk boundaries', () => {
  const root = tmpRoot();
  initStore(root);
  const decisions = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    at: '2026-10-24T00:00:00.000Z',
    decision: `d${index} ${'x'.repeat(180)}`,
    rationale: 'r'.repeat(50),
  }));
  fs.writeFileSync(storePaths(root).decisions, `${decisions.join('\n')}\n`);

  const lastThree = readDecisions(root, 3);
  assert.equal(lastThree.length, 3);
  assert.match(lastThree[0].decision, /^d597 /);
  assert.match(lastThree[2].decision, /^d599 /);

  const many = readDecisions(root, 500);
  assert.equal(many.length, 500);
  assert.match(many[0].decision, /^d100 /);
  assert.deepEqual(readDecisions(root, 0), []);

  fs.appendFileSync(storePaths(root).decisions, 'not-json\n');
  assert.deepEqual(readDecisions(root, 1), []);

  const metrics = Array.from({ length: 400 }, (_, index) => JSON.stringify({
    at: '2026-10-24T00:00:00.000Z',
    event: 'job_stop',
    seq: index,
    pad: 'y'.repeat(180),
  }));
  fs.writeFileSync(storePaths(root).metrics, `${metrics.join('\n')}\n`);
  const tail = readMetrics(root, 2);
  assert.equal(tail.length, 2);
  assert.equal(tail[0].seq, 398);
  assert.equal(tail[1].seq, 399);
});

test('jobs upsert and lookup by agent id', () => {
  const root = tmpRoot();
  initStore(root);
  const id = newJobId('job');
  upsertJob(root, id, {
    agent_id: 'agent_1',
    type: 'general-purpose',
    status: 'running',
    depth: 1,
  });
  assert.equal(findJobByAgent(root, 'agent_1').id, id);
  upsertJob(root, id, { status: 'ok', result_handle: 'abc123def456' });
  assert.equal(readJobs(root).jobs[0].status, 'ok');
});

test('concurrent upserts from separate processes do not lose jobs', async () => {
  const root = tmpRoot();
  initStore(root);
  const storeUrl = pathToFileURL(STORE).href;
  const script = [
    `import { upsertJob } from ${JSON.stringify(storeUrl)};`,
    'upsertJob(process.env.MHE_TEST_ROOT, process.env.MHE_TEST_JOB, {',
    "  agent_id: process.env.MHE_TEST_JOB,",
    "  type: 'Explore',",
    "  status: 'running',",
    '});',
  ].join('\n');
  const count = 6;
  const childEnv = { ...process.env };
  delete childEnv.MY_HARNESS_ENHANCE_PROJECT;
  delete childEnv.MY_HARNESS_ENHANCE_SESSION;
  delete childEnv.MY_HARNESS_ENHANCE_GLOBAL;
  await Promise.all(Array.from({ length: count }, (_, index) => execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: path.resolve(HERE, '..'),
      env: {
        ...childEnv,
        MHE_TEST_ROOT: root,
        MHE_TEST_JOB: `agent_${index}`,
      },
      timeout: 20000,
    },
  )));
  const ids = readJobs(root).jobs.map((job) => job.agent_id).sort();
  assert.deepEqual(ids, Array.from({ length: count }, (_, index) => `agent_${index}`));
});

test('session and metrics persist', () => {
  const root = tmpRoot();
  initStore(root);
  writeSession(root, { role: 'router', model: 'dfmodel' });
  assert.equal(readSession(root).role, 'router');
  appendMetric(root, { event: 'PreToolUse', role: 'router', tool: 'Bash' });
  assert.equal(readMetrics(root).length, 1);
});

test('state lock is released after use', () => {
  const root = tmpRoot();
  initStore(root);
  const value = withLock(root, () => 42);
  assert.equal(value, 42);
  assert.equal(fs.existsSync(storePaths(root).lock), false);
});

test('withLock recovers a lock left by a dead process', () => {
  const root = tmpRoot();
  initStore(root);
  fs.writeFileSync(
    storePaths(root).lock,
    JSON.stringify({ pid: 999999, at: Date.now() - 60000 }),
  );
  const value = withLock(root, () => 7, { timeoutMs: 1000, staleMs: 60000 });
  assert.equal(value, 7);
  assert.equal(fs.existsSync(storePaths(root).lock), false);
});

test('config is created with user-level defaults', () => {
  const root = tmpRoot();
  initStore(root);
  const { config, exists, registered } = loadConfig(root);
  assert.equal(exists, true);
  assert.equal(registered, true);
  assert.equal(config.conductor.auto, true);
  assert.equal(config.conductor.allowedTools.includes('Agent'), true);
  assert.equal(config.capabilities.roles && typeof config.capabilities.roles, 'object');
  assert.equal(fs.existsSync(path.join(root, '.router')), false);
});

test('loadConfig migrates removed fake controls from persisted config', () => {
  const root = tmpRoot();
  initStore(root);
  const file = path.join(storePaths(root).dir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.conductor.maxDepth = 2;
  raw.conductor.maxFanout = 4;
  raw.conductor.allowedTools.push('TaskCreate');
  raw.context.maxStateTokens = 1500;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const { config } = loadConfig(root);
  assert.equal(config.conductor.maxDepth, undefined);
  assert.equal(config.conductor.maxFanout, undefined);
  assert.equal(config.conductor.allowedTools.includes('TaskCreate'), false);
  assert.equal(config.context.maxStateTokens, undefined);
});

test('plan tasks carry attention metadata with sane defaults', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{ id: 't1', title: 'ship it', next_action: 'write the test' }], { replace: true });
  const plan = readPlan(root);
  assert.equal(plan.version, 2);
  const task = plan.tasks[0];
  assert.equal(task.next_action, 'write the test');
  assert.deepEqual(task.blockers, []);
  assert.equal(task.priority, 3);
  assert.equal(task.authority, '');
  assert.equal(task.confidence, null);
  assert.match(task.as_of, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(task.stale, false);
});

test('attention values are bounded and unknown fields survive a write', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{
    id: 't1',
    title: 'ship it',
    priority: 42,
    confidence: 1.7,
    blockers: Array.from({ length: 9 }, (_, index) => `blocker ${index} ${'x'.repeat(200)}`),
    cost_of_miss: 'c'.repeat(400),
    authority: 'a'.repeat(80),
    custom_field: 'kept',
  }], { replace: true });
  const task = readPlan(root).tasks[0];
  assert.equal(task.priority, 9);
  assert.equal(task.confidence, 1);
  assert.equal(task.blockers.length, 5);
  assert.ok(task.blockers[0].length <= 120);
  assert.ok(task.cost_of_miss.length <= 200);
  assert.ok(task.authority.length <= 40);
  assert.equal(task.custom_field, 'kept');
});

test('plan tasks carry bounded checks and outputs', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{
    id: 't1',
    title: 'ship it',
    checks: Array.from({ length: 8 }, (_, index) => `check ${index} ${'c'.repeat(200)}`),
    outputs: Array.from({ length: 12 }, (_, index) => `out ${index} ${'o'.repeat(240)}`),
  }], { replace: true });
  const task = readPlan(root).tasks[0];
  assert.equal(task.checks.length, 5);
  assert.ok(task.checks[0].length <= 160);
  assert.equal(task.outputs.length, 10);
  assert.ok(task.outputs[0].length <= 200);

  updatePlanTask(root, 't1', { checks: ['command:test'] });
  const updated = readPlan(root).tasks[0];
  assert.deepEqual(updated.checks, ['command:test']);
  assert.equal(updated.outputs.length, 10);
});

test('a legacy plan without metadata migrates on read', () => {
  const root = tmpRoot();
  initStore(root);
  const file = storePaths(root).plan;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    tasks: [
      { id: 'a', title: 'old one', status: 'in_progress' },
      { id: 'b', title: 'old two', status: 'pending' },
    ],
    updated_at: '2026-10-01T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
  const plan = readPlan(root);
  assert.equal(plan.version, 2);
  assert.deepEqual(plan.tasks.map((task) => task.id), ['a', 'b']);
  assert.deepEqual(plan.tasks.map((task) => task.title), ['old one', 'old two']);
  assert.deepEqual(plan.tasks.map((task) => task.status), ['in_progress', 'pending']);
  assert.equal(plan.tasks[0].priority, 3);
  assert.equal(plan.tasks[0].stale, false);
});

test('an unfinished task goes stale after a day', () => {
  const root = tmpRoot();
  initStore(root);
  const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  writePlan(root, [
    { id: 'a', title: 'slow', status: 'in_progress', as_of: old },
    { id: 'b', title: 'done', status: 'completed', as_of: old },
  ], { replace: true });
  const plan = readPlan(root);
  assert.equal(plan.tasks[0].stale, true);
  assert.equal(plan.tasks[1].stale, false);
});

test('updating a task refreshes as_of and keeps attention fields', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{ id: 't1', title: 'ship', next_action: 'one', authority: 'user' }], { replace: true });
  const before = readPlan(root).tasks[0];
  const updated = updatePlanTask(root, 't1', { status: 'in_progress', next_action: 'two' });
  assert.equal(updated.next_action, 'two');
  assert.equal(updated.authority, 'user');
  assert.equal(updated.stale, false);
  assert.ok(Date.parse(updated.as_of) >= Date.parse(before.as_of));
  const persisted = readPlan(root).tasks[0];
  assert.equal(persisted.stale, false);
  assert.equal(persisted.next_action, 'two');
});

test('a last check records who produced it', () => {
  const root = tmpRoot();
  initStore(root);
  assert.equal(writeLastCheck(root, { ok: true, checked: ['docs'] }).source, 'harness');
  assert.equal(writeLastCheck(root, { ok: false, source: 'manual' }).source, 'manual');
  assert.equal(readLastCheck(root).source, 'manual');
});

test('a corrupt state file is quarantined instead of silently replaced', () => {
  const root = tmpRoot();
  initStore(root);
  writePlan(root, [{ id: 't1', title: 'Ship the endpoint' }]);
  const file = storePaths(root).plan;
  fs.writeFileSync(file, '{ not json', 'utf8');

  const plan = readPlan(root);
  assert.deepEqual(plan.tasks, []);

  const dir = path.dirname(file);
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('plan.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{ not json');

  // The bad bytes are gone from the live path, so a second read is a plain miss
  // and must not produce a second quarantine file.
  readPlan(root);
  const again = fs.readdirSync(dir).filter((name) => name.startsWith('plan.json.corrupt-'));
  assert.equal(again.length, 1);
});

test('a missing state file is a first run, not corruption', () => {
  const root = tmpRoot();
  initStore(root);
  const plan = readPlan(root);
  assert.deepEqual(plan.tasks, []);
  const dir = path.dirname(storePaths(root).plan);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 0);
});
