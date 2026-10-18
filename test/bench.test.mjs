import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runDemo } from '../src/bench/demo.mjs';
import {
  benchmarkReport,
  defaultScenarios,
  estimateTokens,
  simulateScenario,
} from '../src/core/metrics.mjs';

test('token estimator handles English and Chinese', () => {
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('你好世界') > 0);
  assert.ok(estimateTokens('你好世界') > estimateTokens('abcd'));
});

test('heavy scenario shows a large main-context reduction', () => {
  const scenario = simulateScenario({
    name: 'heavy',
    steps: 16,
    toolKB: 32,
    reasoningKB: 16,
    envelopeKB: 1.4,
  });
  assert.ok(scenario.reduction > 0.85, `reduction ${scenario.reduction}`);
  assert.equal(scenario.baseline.fitsWindow, false);
  assert.equal(scenario.router.fitsWindow, true);
});

test('medium scenario keeps the router under the window', () => {
  const scenario = defaultScenarios().find((item) => item.name === 'medium');
  assert.ok(scenario);
  assert.ok(scenario.reduction > 0.8);
  assert.equal(scenario.router.fitsWindow, true);
});

test('benchmark report includes all scenarios and the reduction column', () => {
  const report = benchmarkReport();
  assert.match(report, /light/);
  assert.match(report, /medium/);
  assert.match(report, /heavy/);
  assert.match(report, /reduction/);
});

test('demo exercises state, contract, artifacts, and capsule end to end', () => {
  const result = runDemo({ keep: true });
  assert.ok(fs.existsSync(result.root));
  assert.match(result.report, /MY-HARNESS-ENHANCE CAPSULE/);
  assert.match(result.report, /reduction:/);
  assert.match(result.report, /verifier checks: 3 \(2 pass\)/);
  assert.ok(result.scenario.reduction > 0.8);
});

test('demo can clean up its temp state', () => {
  const result = runDemo({ keep: false });
  assert.equal(fs.existsSync(result.root), false);
});
