import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeMetrics } from '../src/core/metrics.mjs';
import { appendMetric, initStore } from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-report-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'mhe.mjs');

test('summarizeMetrics aggregates counts, sizes, and denials', () => {
  const summary = summarizeMetrics([
    { at: '2026-10-24T10:00:00.000Z', event: 'session_start', capsule_tokens: 400 },
    { at: '2026-10-24T10:00:01.000Z', event: 'job_start', agent_type: 'Explore' },
    {
      at: '2026-10-24T10:00:02.000Z',
      event: 'job_stop',
      agent_type: 'Explore',
      valid: true,
      status: 'ok',
      result_tokens: 100,
    },
    {
      at: '2026-10-24T10:00:03.000Z',
      event: 'job_stop',
      agent_type: 'Explore',
      valid: false,
      status: 'invalid_result',
      retryable: true,
      result_tokens: 300,
    },
    { at: '2026-10-24T10:00:04.000Z', event: 'tool_denied', gate: 'dispatch' },
    { at: '2026-10-24T10:00:05.000Z', event: 'worker_tool_denied', gate: 'worker' },
    {
      at: '2026-10-24T10:00:06.000Z',
      event: 'tool_output_captured',
      agent_type: 'Explore',
      bytes: 1200,
    },
    {
      at: '2026-10-24T10:00:07.000Z',
      event: 'agent_result',
      valid: true,
      status: 'ok',
      compact_tokens: 80,
    },
    { at: '2026-10-24T10:00:08.000Z', event: 'session_stop', capsule_tokens: 420 },
  ]);

  assert.equal(summary.entries, 9);
  assert.equal(summary.firstAt, '2026-10-24T10:00:00.000Z');
  assert.equal(summary.lastAt, '2026-10-24T10:00:08.000Z');
  assert.equal(summary.events.job_stop, 2);
  assert.equal(summary.jobs.started, 1);
  assert.equal(summary.jobs.stopped, 2);
  assert.equal(summary.jobs.valid, 1);
  assert.equal(summary.jobs.invalid, 1);
  assert.equal(summary.jobs.retryable, 1);
  assert.equal(summary.jobs.invalidRate, 0.5);
  assert.equal(summary.jobs.statuses.ok, 1);
  assert.equal(summary.jobs.statuses.invalid_result, 1);
  assert.equal(summary.envelopeTokens.count, 2);
  assert.equal(summary.envelopeTokens.avg, 200);
  assert.equal(summary.envelopeTokens.max, 300);
  assert.equal(summary.agentResults.valid, 1);
  assert.equal(summary.agentResults.compactTokens.latest, 80);
  assert.equal(summary.capsuleTokens.latest, 420);
  assert.equal(summary.capsuleTokens.max, 420);
  assert.equal(summary.capturedBytes, 1200);
  assert.equal(summary.denials.dispatch, 1);
  assert.equal(summary.denials.worker, 1);
  assert.deepEqual(summary.workers.Explore, { starts: 1, stops: 2, invalid: 1 });
});

test('mhe report prints the summary and the unmeasured list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-report-project-'));
  initStore(root, { harness: 'qoder' });
  appendMetric(root, { event: 'job_start', agent_type: 'Explore' });
  appendMetric(root, {
    event: 'job_stop',
    agent_type: 'Explore',
    valid: true,
    status: 'ok',
    result_tokens: 120,
  });

  const cliEnv = { ...process.env };
  delete cliEnv.MY_HARNESS_ENHANCE_PROJECT;
  delete cliEnv.MY_HARNESS_ENHANCE_SESSION;
  delete cliEnv.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [CLI, 'report', '--root', root], {
    env: cliEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /entries: 2/);
  assert.match(result.stdout, /jobs: started=1 stopped=1 valid=1 invalid=0/);
  assert.match(result.stdout, /Explore: start=1 stop=1 invalid=0/);
  assert.match(result.stdout, /not measured by hooks: M_T, b, B, C/);

  const json = spawnSync(process.execPath, [CLI, 'report', '--root', root, '--json'], {
    env: cliEnv,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.root, root);
  assert.equal(parsed.summary.jobs.stopped, 1);
  assert.equal(parsed.summary.capsuleTokens.count, 0);
});

test('summarizeMetrics reports injection size, ratio and packet density', () => {
  const summary = summarizeMetrics([
    { at: '2026-10-24T10:00:00.000Z', event: 'prompt_submitted', packet_tokens: 120, relevant_tokens: 100, injected_tokens: 40, changed_sections: 'NOW,PLAN' },
    { at: '2026-10-24T10:00:01.000Z', event: 'prompt_submitted', packet_tokens: 120, relevant_tokens: 100, injected_tokens: 20, changed_sections: '' },
  ]);
  assert.equal(summary.injection.turns, 2);
  assert.equal(summary.injection.packetAvg, 120);
  assert.equal(summary.injection.relevantAvg, 100);
  assert.equal(summary.injection.injectedAvg, 30);
  assert.equal(summary.injection.ratio, 0.25);
  assert.equal(summary.injection.density, 0.833);
  assert.equal(summary.injection.anchorOnly, 1);
});

test('a session with no injection telemetry reports zero turns', () => {
  const summary = summarizeMetrics([{ at: '2026-10-24T10:00:00.000Z', event: 'session_start', capsule_tokens: 10 }]);
  assert.equal(summary.injection.turns, 0);
  assert.equal(summary.injection.density, null);
});
