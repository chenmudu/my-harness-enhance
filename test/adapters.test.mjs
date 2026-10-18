import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADAPTER_CAPABILITIES,
  LIFECYCLE_STAGES,
  defineAdapter,
  describeAdapter,
  isAdapter,
} from '../src/adapters/spec.mjs';
import {
  HARNESS_ENV_VAR,
  detectAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  registerDefaultAdapters,
  unregisterAdapter,
} from '../src/adapters/registry.mjs';

registerDefaultAdapters();

test('capability schema covers the planned harness features', () => {
  for (const name of [
    'subagents', 'hooks', 'resultRewrite', 'preCompact', 'mcp', 'installer',
    'overlay', 'sessionMap', 'skills', 'modelSelection', 'statusLine', 'crossSession',
  ]) {
    assert.ok(name in ADAPTER_CAPABILITIES, `missing capability ${name}`);
  }
  assert.deepEqual(LIFECYCLE_STAGES, ['detect', 'install', 'uninstall', 'doctor', 'refresh']);
});

test('built-in adapters are registered and listable', () => {
  for (const [id, label] of [['qoder', 'Qoder'], ['zcode', 'ZCode']]) {
    const adapter = getAdapter(id);
    assert.ok(adapter, `${id} adapter missing`);
    assert.equal(adapter.id, id);
    assert.equal(adapter.label, label);
    assert.ok(isAdapter(adapter));
    assert.ok(Object.isFrozen(adapter));
    assert.throws(() => { adapter.id = 'other'; }, TypeError, 'adapter must be frozen');
  }
  assert.deepEqual(listAdapters().map((adapter) => adapter.id), ['qoder', 'zcode']);
});

test('describeAdapter is serializable and hides functions', () => {
  const description = describeAdapter(getAdapter('qoder'));
  assert.deepEqual(description, {
    id: 'qoder',
    label: 'Qoder',
    capabilities: ['hooks', 'installer', 'mcp', 'overlay', 'preCompact', 'resultRewrite', 'sessionMap', 'subagents'],
    lifecycle: ['detect', 'doctor', 'install', 'refresh', 'uninstall'],
  });
  // Only what Qoder actually provides; honest absences stay absent.
  for (const notClaimed of ['skills', 'modelSelection', 'statusLine', 'crossSession']) {
    assert.ok(!description.capabilities.includes(notClaimed));
  }
  // Survives a JSON round-trip with nothing lost and no functions leaking.
  const revived = JSON.parse(JSON.stringify(description));
  assert.deepEqual(revived, description);
  for (const value of Object.values(revived)) {
    assert.ok(!['function'].includes(typeof value));
    for (const item of Array.isArray(value) ? value : [value]) {
      assert.equal(typeof item, 'string');
    }
  }
});

test('detect prefers explicit, then env, then adapter detect()', () => {
  assert.equal(detectAdapter({ env: {}, explicit: ' Qoder ' }).id, 'qoder');
  assert.equal(detectAdapter({ env: { [HARNESS_ENV_VAR]: 'QODER' } }).id, 'qoder');

  // Qoder's own detect wraps detectConfigDir and only answers with a
  // resolved config dir when QODER_CONFIG_DIR gives a real signal.
  const resolved = detectAdapter({ env: { QODER_CONFIG_DIR: os.tmpdir() } });
  assert.equal(resolved.id, 'qoder');
  assert.equal(getAdapter('qoder').lifecycle.detect({ env: {} }), false);

  const fake = defineAdapter({
    id: 'zz-fake',
    label: 'ZZ Fake Harness',
    capabilities: {},
    lifecycle: { detect: ({ payload }) => payload?.kind === 'zz' },
  });
  // Probe order is alphabetical: qoder, zcode, zz-fake. ZCode counts the
  // well-known ~/.zcode/cli directory as a real signal when it exists, so
  // payload-probing tests must neutralize the home dir or zcode would
  // legitimately match first on machines that actually run ZCode.
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-probe-home-'));
  const probeEnv = { HOME: probeHome, USERPROFILE: probeHome };
  registerAdapter(fake);
  try {
    assert.equal(detectAdapter({ env: probeEnv, payload: { kind: 'zz' } }).id, 'zz-fake');
    // explicit beats env beats probing
    assert.equal(
      detectAdapter({
        env: { [HARNESS_ENV_VAR]: 'qoder' },
        explicit: 'zz-fake',
        payload: undefined,
      }).id,
      'zz-fake',
    );
  } finally {
    unregisterAdapter('zz-fake');
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
});

test('unknown or unmatched detection fails clearly', () => {
  assert.throws(
    () => detectAdapter({ env: {}, explicit: 'codex' }),
    /Unknown harness "codex"[\s\S]*Registered adapters:.*qoder/,
  );
  assert.throws(
    () => detectAdapter({ env: { [HARNESS_ENV_VAR]: 'nope' } }),
    /Unknown harness "nope"/,
  );
  // A fake empty home dir makes the probe machine-independent: the well-known
  // ~/.zcode/cli only counts when it exists, and no harness signal here exists.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-no-harness-home-'));
  const noSignal = { HOME: fakeHome, USERPROFILE: fakeHome };
  assert.throws(
    () => detectAdapter({ env: noSignal, payload: null }),
    /No harness adapter matched/,
  );
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('defineAdapter rejects dishonest or malformed specs', () => {
  assert.throws(() => defineAdapter({ label: 'No Id', capabilities: {} }), /id must be/);
  assert.throws(() => defineAdapter({ id: 'no-label', capabilities: {} }), /label must be/);
  assert.throws(() => defineAdapter({ id: 'no-caps', label: 'No Caps' }), /capabilities must be/);
  assert.throws(() => defineAdapter('nope'), /spec must be a plain object/);
  assert.throws(
    () => defineAdapter({ id: 'ghost', label: 'Ghost', capabilities: {}, teleport: true }),
    /unexpected field\(s\) teleport/,
  );
  assert.throws(
    () => defineAdapter({ id: 'liar', label: 'Liar', capabilities: { timeTravel: true } }),
    /unknown capability "timeTravel"/,
  );
  assert.throws(
    () => defineAdapter({ id: 'lazy', label: 'Lazy', capabilities: { hooks: 'yes' } }),
    /capability "hooks" must be a boolean/,
  );
  assert.throws(
    () => defineAdapter({ id: 'badfn', label: 'BadFn', capabilities: {}, lifecycle: { install: 'npm i' } }),
    /lifecycle\.install must be a function/,
  );
  assert.throws(
    () => defineAdapter({ id: 'badstage', label: 'Bad', capabilities: {}, lifecycle: { deploy() {} } }),
    /unknown lifecycle stage "deploy"/,
  );
});

test('defineAdapter normalizes identity and drops false capabilities', () => {
  const adapter = defineAdapter({
    id: ' My-Adapter ',
    label: ' My Adapter ',
    capabilities: { hooks: true, mcp: false },
  });
  assert.equal(adapter.id, 'my-adapter');
  // Ids with interior spaces are a spec-writing error, not silent rewriting.
  assert.throws(
    () => defineAdapter({ id: 'my adapter', label: 'X', capabilities: {} }),
    /id must be/,
  );
  assert.equal(adapter.label, 'My Adapter');
  assert.deepEqual(Object.keys(adapter.capabilities), ['hooks']);
  assert.deepEqual(adapter.lifecycle, {});
});

test('registry is generic: a fake adapter registers, resolves, and unregisters', () => {
  const fake = defineAdapter({
    id: 'fake-test',
    label: 'Fake Test Harness',
    capabilities: { installer: true },
    lifecycle: { install: () => 'installed', doctor: () => ({ ok: true }) },
  });
  registerAdapter(fake);
  try {
    assert.equal(getAdapter('fake-test'), fake);
    assert.ok(listAdapters().some((adapter) => adapter.id === 'fake-test'));
    assert.deepEqual(describeAdapter(fake), {
      id: 'fake-test',
      label: 'Fake Test Harness',
      capabilities: ['installer'],
      lifecycle: ['doctor', 'install'],
    });
    assert.equal(fake.lifecycle.install(), 'installed');
  } finally {
    assert.equal(unregisterAdapter('fake-test'), true);
  }
  assert.equal(getAdapter('fake-test'), null);
  assert.throws(() => registerAdapter({ id: 'raw', label: 'Raw' }), /defineAdapter/);
  assert.throws(() => describeAdapter({ id: 'raw' }), /defineAdapter/);
});
