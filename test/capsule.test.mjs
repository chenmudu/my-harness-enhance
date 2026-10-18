import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';
import { buildCapsule, conductorInjection, workerContract } from '../src/core/capsule.mjs';
import { initStore, writeGoal } from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-capsule-home-'),
);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-capsule-project-'));
  initStore(root);
  writeGoal(root, { text: 'Ship the endpoint', acceptance: ['tests pass'] });
  return root;
}

test('hook injection and MCP state share one capsule budget', () => {
  const root = makeRoot();
  const { config } = loadConfig(root);
  assert.equal(config.context.maxStateTokens, undefined);
  const capsule = buildCapsule(root, { maxTokens: config.context.maxCapsuleTokens });
  const injection = conductorInjection(root);
  assert.ok(injection.includes(capsule));
  assert.match(injection, /does not inject worker contracts/);
  const injected = conductorInjection(root, { contractMode: 'injected' });
  assert.match(injected, /injects the worker contract/);
});

test('capsule locks the PROJECT path and the policy covers it plus misconfigured checkers', () => {
  const root = makeRoot();
  const capsule = buildCapsule(root);
  assert.ok(
    capsule.includes(
      `## PROJECT\n${root} (pass this exact path as project to every enhance_* call; GOAL paths are not workspace overrides)`,
    ),
    capsule.slice(0, 400),
  );
  const injection = conductorInjection(root);
  assert.match(
    injection,
    /The PROJECT line is authoritative\. GOAL\/notes may name other paths; never pass them as project\./,
  );
  assert.match(
    injection,
    /A misconfigured checker is not a user decision; fix the brief and rerun it, do not ask the user\./,
  );
  assert.match(
    injection,
    /Use only the checker ids in the brief; do not add scope or other checks ad hoc\./,
  );
  // The contract text itself must never trip the hook's verification gate.
  const contract = workerContract('general-purpose');
  assert.match(contract, /Do not build content-comparison, hash, or self-review scripts/);
  assert.doesNotMatch(contract, /verify|verification|parity|recheck|复核|校对|验收/i);
});

test('worker contract is leaf-only and has no fake depth knobs', () => {
  const contract = workerContract('Explore', { jobId: 'job-1', role: 'investigate' });
  assert.match(contract, /leaf worker/);
  assert.match(contract, /Do not commit, branch, or merge/);
  assert.match(contract, /Do not read or write assistant memory/);
  assert.doesNotMatch(contract, /maxDepth|maxFanout/);
  assert.doesNotMatch(contract, /depth: \d+ \/ max/);
});
