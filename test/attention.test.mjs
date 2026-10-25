import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFrontier, scheduleNext } from '../src/core/attention.mjs';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const fresh = new Date(NOW - 60 * 1000).toISOString();
const old = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();

function plan(tasks) {
  return { version: 2, tasks };
}

test('a task waits for its dependencies and becomes ready when they complete', () => {
  const value = plan([
    { id: 'a', title: 'a', status: 'pending', depends_on: [], as_of: fresh },
    { id: 'b', title: 'b', status: 'pending', depends_on: ['a'], as_of: fresh },
  ]);
  let frontier = computeFrontier(value, { now: NOW });
  assert.deepEqual(frontier.ready.map((task) => task.id), ['a']);
  assert.deepEqual(frontier.blocked, [{ id: 'b', by: ['a'] }]);

  value.tasks[0].status = 'completed';
  frontier = computeFrontier(value, { now: NOW });
  assert.deepEqual(frontier.ready.map((task) => task.id), ['b']);
  assert.equal(frontier.blocked.length, 0);
});

test('declared blockers keep a task out of the frontier and count as debt', () => {
  const value = plan([
    { id: 'a', title: 'a', status: 'in_progress', depends_on: [], blockers: ['needs a key'], as_of: fresh },
  ]);
  const frontier = computeFrontier(value, { now: NOW });
  assert.equal(frontier.ready.length, 0);
  assert.deepEqual(frontier.blocked, [{ id: 'a', by: ['needs a key'] }]);
  assert.equal(frontier.debt, 1);
});

test('an unfinished task older than a day is stale and adds debt', () => {
  const value = plan([
    { id: 'a', title: 'a', status: 'in_progress', depends_on: [], as_of: old },
    { id: 'b', title: 'b', status: 'completed', depends_on: [], as_of: old },
  ]);
  const frontier = computeFrontier(value, { now: NOW });
  assert.equal(frontier.ready[0].stale, true);
  assert.equal(frontier.debt, 1);
});

test('the scheduler continues the task in progress before opening a new one', () => {
  const value = plan([
    { id: 'a', title: 'a', status: 'in_progress', depends_on: [], priority: 9, as_of: fresh },
    { id: 'b', title: 'b', status: 'pending', depends_on: [], priority: 1, as_of: fresh },
  ]);
  const schedule = scheduleNext(value, { now: NOW });
  assert.equal(schedule.gate, 'open');
  assert.equal(schedule.candidates[0].id, 'a');
  assert.match(schedule.candidates[0].reason, /in progress/);
});

test('priority orders the rest and unblocking breaks ties', () => {
  const value = plan([
    { id: 'a', title: 'a', status: 'pending', depends_on: [], priority: 5, as_of: fresh },
    { id: 'b', title: 'b', status: 'pending', depends_on: [], priority: 2, as_of: fresh },
    { id: 'c', title: 'c', status: 'pending', depends_on: [], priority: 2, as_of: fresh },
    { id: 'd', title: 'd', status: 'pending', depends_on: ['c'], as_of: fresh },
  ]);
  const schedule = scheduleNext(value, { now: NOW });
  assert.deepEqual(schedule.candidates.map((task) => task.id), ['c', 'b', 'a']);
  assert.match(schedule.candidates[0].reason, /unblocks 1 task/);
});

test('a stale backlog closes the gate instead of picking new work', () => {
  const value = plan(Array.from({ length: 6 }, (_, index) => ({
    id: `t${index}`,
    title: `t${index}`,
    status: 'in_progress',
    depends_on: [],
    blockers: ['waiting'],
    as_of: fresh,
  })));
  const schedule = scheduleNext(value, { now: NOW });
  assert.equal(schedule.gate, 'drain');
  assert.equal(schedule.candidates.length, 0);
  assert.match(schedule.reason, /6 open loops/);
});

test('an empty plan has no candidates and nothing to drain', () => {
  const schedule = scheduleNext(plan([]), { now: NOW });
  assert.equal(schedule.gate, 'open');
  assert.equal(schedule.candidates.length, 0);
  assert.equal(schedule.debt, 0);
});