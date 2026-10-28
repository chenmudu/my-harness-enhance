import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStore,
  readBrief,
  updatePlanTask,
  writeBrief,
  writePlan,
} from '../src/core/store.mjs';
import {
  handshakeReason,
  hashValue,
  workerHandshake,
} from '../src/core/handshake.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-handshake-home-'),
);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-handshake-project-'));
  initStore(root);
  return root;
}

test('the hash ignores volatile fields and changes with the contract', () => {
  const root = makeRoot();
  writeBrief(root, { profile: 'code', checks: ['command:test'] });
  writePlan(root, [{
    id: 't1',
    title: 'ship it',
    acceptance: 'tests pass',
    checks: ['command:test'],
    outputs: ['out.txt'],
  }], { replace: true });

  const first = workerHandshake(root, { taskId: 't1' });
  assert.match(first.brief_hash, /^[0-9a-f]{16}$/);
  assert.match(first.task_hash, /^[0-9a-f]{16}$/);

  writeBrief(root, { ...readBrief(root), checks: ['command:test'] });
  assert.equal(workerHandshake(root, { taskId: 't1' }).brief_hash, first.brief_hash);

  updatePlanTask(root, 't1', { status: 'in_progress' });
  assert.equal(workerHandshake(root, { taskId: 't1' }).task_hash, first.task_hash);

  writeBrief(root, { ...readBrief(root), checks: ['command:test', 'docs'] });
  assert.notEqual(workerHandshake(root, { taskId: 't1' }).brief_hash, first.brief_hash);

  updatePlanTask(root, 't1', { acceptance: 'different acceptance' });
  assert.notEqual(workerHandshake(root, { taskId: 't1' }).task_hash, first.task_hash);
});

test('hashValue is stable across object key order', () => {
  assert.equal(hashValue({ a: 1, b: { c: 2, d: 3 } }), hashValue({ b: { d: 3, c: 2 }, a: 1 }));
});

test('handshakeReason distinguishes matching, stale, and legacy results', () => {
  const job = { expected_brief_hash: 'aaaaaaaaaaaaaaaa', expected_task_hash: 'bbbbbbbbbbbbbbbb' };
  const good = { brief_hash: 'aaaaaaaaaaaaaaaa', task_hash: 'bbbbbbbbbbbbbbbb' };
  const live = { brief_hash: 'aaaaaaaaaaaaaaaa', task_hash: 'bbbbbbbbbbbbbbbb' };

  assert.deepEqual(handshakeReason(job, good, live), { ok: true, legacy: false, reason: '' });
  assert.equal(handshakeReason(job, { ...good, brief_hash: 'cccccccccccccccc' }, live).ok, false);
  assert.equal(handshakeReason(job, { ...good, task_hash: 'dddddddddddddddd' }, live).ok, false);
  assert.equal(handshakeReason(job, good, { ...live, brief_hash: 'eeeeeeeeeeeeeeee' }).ok, false);
  assert.equal(handshakeReason(job, good, { ...live, task_hash: 'ffffffffffffffff' }).ok, false);
  assert.equal(handshakeReason(job, {}, live).legacy, true);
  assert.equal(handshakeReason(null, good, live).ok, true);
  assert.equal(handshakeReason(null, good, { ...live, task_hash: 'eeeeeeeeeeeeeeee' }).ok, false);
  assert.equal(handshakeReason(null, {}, live).legacy, true);
});