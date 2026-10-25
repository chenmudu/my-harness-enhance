import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPacket } from '../src/core/packet.mjs';
import {
  initStore,
  updatePlanTask,
  writeBrief,
  writeGoal,
  writeLastCheck,
  writePlan,
} from '../src/core/store.mjs';
import { estimateTokens } from '../src/core/metrics.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-packet-home-'));

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-packet-project-'));
  initStore(root);
  writeGoal(root, {
    text: 'Ship the health endpoint',
    acceptance: ['tests pass'],
    constraints: ['never edit package.json'],
  });
  writeBrief(root, { profile: 'code', checks: ['command:test'] });
  return root;
}

test('the packet carries role, goal, now and the must list', () => {
  const root = makeRoot();
  writePlan(root, [{ id: 't1', title: 'wire it', status: 'in_progress', next_action: 'add the route' }], { replace: true });
  const packet = buildPacket(root, { session: 'sess-1' });
  assert.match(packet.text, /MY-HARNESS-ENHANCE PACKET v1/);
  assert.match(packet.text, /## ROLE\nconductor \| project:/);
  assert.match(packet.text, /## SESSION\nsess-1/);
  assert.match(packet.text, /## NOW\n\[in_progress\] t1 wire it — next: add the route/);
  assert.match(packet.text, /## GOAL\n- Ship the health endpoint/);
  assert.match(packet.text, /## MUST\n- done when: tests pass/);
  assert.match(packet.text, /- never edit package\.json/);
  assert.match(packet.text, /- checks: command:test/);
  assert.equal(packet.gate, 'open');
});

test('trust says what was actually verified', () => {
  const root = makeRoot();
  writeLastCheck(root, { ok: true, checked: ['command:test'] });
  const packet = buildPacket(root);
  assert.match(packet.text, /## TRUST/);
  assert.match(packet.text, /- ok command:test \(base\)/);
  assert.match(packet.text, /worker summaries are claims/);
  assert.doesNotMatch(packet.text, /## SESSION/);
});

test('blockers and decide give the next choice without repeating NOW', () => {
  const root = makeRoot();
  writePlan(root, [
    { id: 't1', title: 'first', status: 'pending', priority: 1 },
    { id: 't2', title: 'second', status: 'pending', priority: 2 },
    { id: 't3', title: 'blocked one', status: 'pending', blockers: ['needs a key'] },
  ], { replace: true });
  const packet = buildPacket(root);
  assert.match(packet.text, /## NOW\n\[pending\] t1 first/);
  assert.match(packet.text, /## DECIDE\n- t2 second/);
  assert.match(packet.text, /## BLOCKERS\n- t3: needs a key/);
  assert.doesNotMatch(packet.text, /## DECIDE[\s\S]*- t1 /);
});

test('the packet stays inside its budget and keeps the working set', () => {
  const root = makeRoot();
  writePlan(root, Array.from({ length: 40 }, (_, index) => ({
    id: `t${index + 1}`,
    title: `task ${index + 1} ${'detail '.repeat(20)}`,
    status: index === 0 ? 'in_progress' : 'pending',
  })), { replace: true });
  const packet = buildPacket(root, { maxTokens: 200 });
  assert.ok(estimateTokens(packet.text) <= 200, `tokens ${estimateTokens(packet.text)}`);
  assert.match(packet.text, /## NOW/);
  assert.match(packet.text, /## GOAL/);
});

test('changed names what moved since the previous packet', () => {
  const root = makeRoot();
  writePlan(root, [
    { id: 't1', title: 'one', status: 'in_progress' },
    { id: 't2', title: 'two', status: 'pending' },
  ], { replace: true });
  const first = buildPacket(root);
  assert.equal(first.changed.length, 0);
  updatePlanTask(root, 't1', { status: 'completed' });
  const second = buildPacket(root);
  assert.ok(second.changed.some((line) => line.includes('t1: in_progress -> completed')), second.changed.join(' | '));
  assert.match(second.text, /## CHANGED/);
});

test('too many open loops closes the gate in the packet', () => {
  const root = makeRoot();
  writePlan(root, Array.from({ length: 6 }, (_, index) => ({
    id: `t${index}`,
    title: `t${index}`,
    status: 'pending',
    blockers: ['waiting'],
  })), { replace: true });
  const packet = buildPacket(root);
  assert.equal(packet.gate, 'drain');
  assert.match(packet.text, /## NOW\ndrain first:/);
  assert.equal(packet.debt, 6);
});