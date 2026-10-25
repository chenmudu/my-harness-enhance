import test from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_BUDGET, classifyError, failureVerdict, isRetryable } from '../src/core/errors.mjs';

test('errors land in one of the known classes', () => {
  assert.equal(classifyError("You've reached your daily usage limit for Chat"), 'quota');
  assert.equal(classifyError('error_code: 110'), 'quota');
  assert.equal(classifyError('EACCES: permission denied'), 'permission');
  assert.equal(classifyError('Network attempt failed at timeout'), 'timeout');
  assert.equal(classifyError('transport closed'), 'transient');
  assert.equal(classifyError('no result payload'), 'no-data');
  assert.equal(classifyError('Unexpected token in JSON'), 'invalid');
  assert.equal(classifyError(''), 'unknown');
});

test('transient, timeout, no-data and contract breaks are worth a retry', () => {
  assert.equal(isRetryable('transient'), true);
  assert.equal(isRetryable('timeout'), true);
  assert.equal(isRetryable('no-data'), true);
  assert.equal(isRetryable('invalid'), true);
  assert.equal(isRetryable('quota'), false);
  assert.equal(isRetryable('permission'), false);
  assert.equal(isRetryable('unknown'), false);
});

test('a retryable class dies once the budget is spent', () => {
  const first = failureVerdict({ error: 'transport closed', attempts: 0 });
  assert.equal(first.error_class, 'transient');
  assert.equal(first.retryable, true);
  assert.equal(first.dead_letter, false);
  assert.match(first.reason, /2 attempt/);

  const spent = failureVerdict({ error: 'transport closed', attempts: RETRY_BUDGET });
  assert.equal(spent.retryable, false);
  assert.equal(spent.dead_letter, true);
  assert.match(spent.reason, /persisted/);
});

test('a class that cannot succeed is dead on arrival', () => {
  const verdict = failureVerdict({ error: 'permission denied', attempts: 0 });
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.dead_letter, true);
  assert.match(verdict.reason, /not fixed by retrying/);
});
