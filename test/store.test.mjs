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
  readMetrics,
  readPlan,
  readSession,
  storePaths,
  upsertJob,
  withLock,
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
  await Promise.all(Array.from({ length: count }, (_, index) => execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: path.resolve(HERE, '..'),
      env: {
        ...process.env,
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
