import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCapabilities } from '../src/core/capabilities.mjs';
import { initStore } from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-conformance-home-'),
);
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QODER_HOOK = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'hook.mjs');
const ZCODE_HOOK = path.resolve(HERE, '..', 'src', 'adapters', 'zcode', 'hook.mjs');
const QODER_LIB = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'lib.mjs');
const ZCODE_LIB = path.resolve(HERE, '..', 'src', 'adapters', 'zcode', 'lib.mjs');

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-conformance-project-')));
  initStore(root, {
    capabilities: resolveCapabilities({ availableAgents: ['general-purpose', 'Explore'] }),
  });
  return root;
}

function runHook(hook, root, event, payload = {}) {
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [hook, event], {
    input: JSON.stringify({ cwd: root, ...payload }),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const text = String(result.stdout || '').trim();
  if (!text) return { decision: 'allow', reason: '' };
  const json = JSON.parse(text);
  const specific = json.hookSpecificOutput || {};
  return {
    decision: specific.permissionDecision || 'allow',
    reason: specific.permissionDecisionReason || '',
  };
}

test('both adapters share one policy implementation', () => {
  assert.equal(fs.existsSync(QODER_LIB), false, 'the Qoder adapter keeps no private policy copy');
  assert.equal(fs.existsSync(ZCODE_LIB), false, 'the ZCode adapter keeps no private policy copy');
  for (const hook of [QODER_HOOK, ZCODE_HOOK]) {
    const source = fs.readFileSync(hook, 'utf8');
    assert.match(source, /core\/hook-policy\.mjs/, `${hook} must import the shared policy`);
    for (const local of [
      'function dispatchGateReason',
      'function verificationGateReason',
      'function isAllowedConductorTool',
      'function workerToolDecision',
      'function conductorDenyReason',
    ]) {
      assert.ok(!source.includes(local), `${hook} must not define ${local}`);
    }
  }
});

test('the adapters reach the same decision for the same payload', () => {
  const root = project();
  const payloads = [
    { name: 'native task tool', value: { tool_name: 'TaskCreate', tool_input: {} } },
    { name: 'repository work', value: { tool_name: 'Bash', tool_input: {} } },
    { name: 'worker tool', value: { agent_type: 'general-purpose', tool_name: 'Bash', tool_input: {} } },
    { name: 'harness state tool', value: { tool_name: 'enhance_plan', tool_input: {} } },
  ];
  for (const { name, value } of payloads) {
    const qoder = runHook(QODER_HOOK, root, 'PreToolUse', value);
    const zcode = runHook(ZCODE_HOOK, root, 'PreToolUse', value);
    assert.equal(zcode.decision, qoder.decision, `${name}: decision`);
    assert.equal(zcode.reason, qoder.reason, `${name}: reason`);
  }
});

test('both adapters refuse a project argument outside the session root', () => {
  const root = project();
  const payload = {
    tool_name: 'enhance_plan',
    tool_input: { project: path.dirname(root) },
  };
  const qoder = runHook(QODER_HOOK, root, 'PreToolUse', payload);
  const zcode = runHook(ZCODE_HOOK, root, 'PreToolUse', payload);
  assert.equal(qoder.decision, 'deny');
  assert.equal(zcode.decision, 'deny');
  assert.match(qoder.reason, /project mismatch/);
  assert.equal(zcode.reason, qoder.reason);
});
