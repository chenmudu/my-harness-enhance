import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatGcReport, runGc } from '../src/core/gc.mjs';
import { projectKey, registerProject } from '../src/core/state-root.mjs';

delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS);
}

function writeFile(file, content, ageDays = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  if (ageDays) {
    const when = new Date(Date.now() - ageDays * DAY_MS);
    fs.utimesSync(file, when, when);
  }
}

function setupHome() {
  const home = tempDir('mhe-gc-home-');
  const workspace = tempDir('mhe-gc-workspace-');
  const previous = process.env.MY_HARNESS_ENHANCE_HOME;
  process.env.MY_HARNESS_ENHANCE_HOME = home;
  const record = registerProject(workspace);
  const stateDir = record.stateDir;
  const session = 'sessionone';
  const key = projectKey(workspace);
  return {
    home,
    workspace,
    stateDir,
    key,
    session,
    restore() {
      if (previous === undefined) delete process.env.MY_HARNESS_ENHANCE_HOME;
      else process.env.MY_HARNESS_ENHANCE_HOME = previous;
    },
  };
}

test('gc trims expired metrics lines and keeps recent ones', () => {
  const env = setupHome();
  try {
    const metrics = path.join(env.stateDir, 'metrics.jsonl');
    writeFile(
      metrics,
      `${JSON.stringify({ at: daysAgo(90).toISOString(), event: 'old' })}\n`
      + `${JSON.stringify({ at: daysAgo(2).toISOString(), event: 'new' })}\n`,
      90,
    );

    const dry = runGc({});
    const trim = dry.actions.find((action) => action.type === 'trim');
    assert.ok(trim, JSON.stringify(dry.actions));
    assert.equal(trim.removed_lines, 1);
    assert.equal(trim.kept_lines, 1);
    assert.equal(dry.freed_bytes, 0, 'dry run must not free anything');
    assert.equal(fs.readFileSync(metrics, 'utf8').split('\n').filter(Boolean).length, 2);

    const applied = runGc({ apply: true });
    assert.ok(applied.freed_bytes > 0);
    const lines = fs.readFileSync(metrics, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, 'new');
  } finally {
    env.restore();
  }
});

test('gc deletes only old unreferenced artifacts', () => {
  const env = setupHome();
  try {
    const referenced = 'a'.repeat(16);
    const expired = 'b'.repeat(16);
    const fresh = 'c'.repeat(16);
    const artifacts = path.join(env.stateDir, 'artifacts');
    writeFile(path.join(artifacts, 'index.json'), JSON.stringify({
      version: 1,
      artifacts: {
        [referenced]: { handle: referenced, created_at: daysAgo(90).toISOString() },
        [expired]: { handle: expired, created_at: daysAgo(90).toISOString() },
        [fresh]: { handle: fresh, created_at: daysAgo(90).toISOString() },
      },
    }, null, 2));
    writeFile(path.join(artifacts, `${referenced}.txt`), 'referenced body', 90);
    writeFile(path.join(artifacts, `${expired}.txt`), 'expired body', 90);
    writeFile(path.join(artifacts, `${fresh}.txt`), 'fresh body');
    writeFile(
      path.join(env.stateDir, 'sessions', env.session, 'jobs.json'),
      JSON.stringify({ version: 1, jobs: [{ id: 'job1', result_handle: referenced }] }, null, 2),
      90,
    );

    const report = runGc({});
    const deletes = report.actions.filter((action) => action.type === 'delete-artifact');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].handle, expired);
    const reasons = report.skipped.map((item) => item.reason);
    assert.ok(reasons.includes('referenced'));
    assert.ok(reasons.includes('modified recently'));

    runGc({ apply: true });
    assert.equal(fs.existsSync(path.join(artifacts, `${expired}.txt`)), false);
    assert.equal(fs.existsSync(path.join(artifacts, `${referenced}.txt`)), true);
    const index = JSON.parse(fs.readFileSync(path.join(artifacts, 'index.json'), 'utf8'));
    assert.equal(index.artifacts[expired], undefined);
    assert.ok(index.artifacts[referenced]);
  } finally {
    env.restore();
  }
});

test('gc keeps decisions and journals unless they are explicitly enabled', () => {
  const env = setupHome();
  try {
    const decisions = path.join(env.stateDir, 'decisions.jsonl');
    writeFile(decisions, `${JSON.stringify({ at: daysAgo(200).toISOString(), decision: 'old' })}\n`, 200);
    const journal = path.join(env.stateDir, 'sessions', env.session, 'journal.md');
    writeFile(journal, `## ${daysAgo(200).toISOString()}\n\nold note\n`, 200);

    const disabled = runGc({});
    assert.equal(disabled.actions.filter((action) => action.type === 'trim-journal').length, 0);
    assert.equal(
      disabled.actions.filter((action) => action.type === 'trim' && action.path === decisions).length,
      0,
    );

    const enabled = runGc({
      includeDecisions: true,
      retention: { decisions: { enabled: true } },
    });
    assert.equal(enabled.actions.filter((action) => action.type === 'trim-journal').length, 1);
    assert.equal(
      enabled.actions.filter((action) => action.type === 'trim' && action.path === decisions).length,
      1,
    );
  } finally {
    env.restore();
  }
});

test('gc removes only landed, clean, expired worktrees', () => {
  const env = setupHome();
  try {
    const repo = env.workspace;
    const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.name', 'mhe-gc']);
    git(['config', 'user.email', 'mhe-gc@localhost']);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);

    const worktree = path.join(env.home, 'worktrees', env.key, env.session, 't1');
    const added = git(['worktree', 'add', '-b', 'task/one', worktree]);
    assert.equal(added.status, 0, added.stderr);
    writeFile(
      path.join(env.stateDir, 'sessions', env.session, 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: { t1: { path: worktree, status: 'landed' } } }, null, 2),
      30,
    );
    const when = daysAgo(30);
    fs.utimesSync(worktree, when, when);

    const report = runGc({});
    const removals = report.actions.filter((action) => action.type === 'remove-worktree');
    assert.equal(removals.length, 1);
    assert.equal(removals[0].task_id, 't1');

    runGc({ apply: true });
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    env.restore();
  }
});

test('gc report is a dry run by default', () => {
  const env = setupHome();
  try {
    const report = runGc({});
    const text = formatGcReport(report);
    assert.match(text, /gc \(dry run\)/);
    assert.match(text, /dry run: nothing was deleted/);
    assert.ok(!text.includes(env.home), 'report must not print the absolute home path');
    assert.match(text, /home: ~\//);
  } finally {
    env.restore();
  }
});
