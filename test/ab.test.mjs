import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertIsolatedDir,
  configHasHarness,
  createFixture,
  createSessionProcess,
  longHorizonPrompts,
  parseCliResult,
  parseTestCounts,
  prepareWorkspace,
  runAb,
  runFixtureCheck,
  sessionInputLine,
  summarizeAb,
  summarizeTurns,
  turnEnv,
} from '../src/bench/ab.mjs';

delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('long-horizon prompts are ordered, numbered, and clamped to the script', () => {
  const prompts = longHorizonPrompts(3);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /^Step 1\/3:/);
  assert.match(prompts[2], /^Step 3\/3:/);
  assert.equal(longHorizonPrompts(99).length, 15);
  assert.equal(longHorizonPrompts(0).length, 15);
});

test('cli result parsing ignores wrapper noise and non-result json', () => {
  const stdout = [
    'loading config',
    '{"type":"system","subtype":"init"}',
    '{"type":"result","subtype":"success","result":"OK","context_usage_ratio":0.25}',
  ].join('\n');
  const parsed = parseCliResult(stdout);
  assert.equal(parsed.result, 'OK');
  assert.equal(parsed.context_usage_ratio, 0.25);
  assert.equal(parseCliResult('not json'), null);
  assert.equal(parseCliResult(''), null);
});

test('test counts are read from the node test reporter summary', () => {
  assert.deepEqual(parseTestCounts('# pass 4\n# fail 0\n'), { passed: 4, failed: 0 });
  assert.deepEqual(parseTestCounts('ℹ pass 2\nℹ fail 1\n'), { passed: 2, failed: 1 });
  assert.deepEqual(parseTestCounts('no summary here'), { passed: null, failed: null });
});

test('isolation guard rejects the normal harness locations', () => {
  const home = os.homedir();
  assert.throws(() => assertIsolatedDir(path.join(home, '.qoder-cn'), '--baseline-config'));
  assert.throws(() => assertIsolatedDir(path.join(home, '.zcode'), '--baseline-config'));
  assert.throws(() => assertIsolatedDir(path.join(home, '.my-harness-enhance'), '--treatment-home'));
  assert.throws(() => assertIsolatedDir('', '--baseline-config'));
  const isolated = tempDir('mhe-ab-isolated-');
  assert.equal(assertIsolatedDir(isolated, '--baseline-config'), fs.realpathSync.native(isolated));
});

test('harness detection reads the qoder settings file', () => {
  const dir = tempDir('mhe-ab-config-');
  assert.equal(configHasHarness(dir), false);
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node D:/repo/src/adapters/qoder/hooks/hook.mjs PreToolUse' }] }] },
      mcpServers: { 'harness-enhance': { command: 'node' } },
    }),
    'utf8',
  );
  assert.equal(configHasHarness(dir), true);
});

test('turn env removes sdk variables and points treatment at the isolated home', () => {
  const base = {
    QODER_AGENT_SDK_ENTRYPOINT: 'x',
    QODER_CONFIG_DIR: 'y',
    MY_HARNESS_ENHANCE_HOME: 'leaked',
    MY_HARNESS_ENHANCE_SESSION: 'leaked',
  };
  const treatment = turnEnv({ arm: 'treatment', sessionId: 'abc', treatmentHome: 'C:/state', base });
  assert.equal(treatment.QODER_AGENT_SDK_ENTRYPOINT, undefined);
  assert.equal(treatment.QODER_CONFIG_DIR, undefined);
  assert.equal(treatment.MY_HARNESS_ENHANCE_HOME, 'C:/state');
  assert.equal(treatment.MY_HARNESS_ENHANCE_SESSION, 'abc');

  const baseline = turnEnv({ arm: 'baseline', sessionId: 'abc', treatmentHome: 'C:/state', base });
  assert.equal(baseline.MY_HARNESS_ENHANCE_HOME, undefined);
  assert.equal(baseline.MY_HARNESS_ENHANCE_SESSION, undefined);
});

test('fixture is a git repo whose tests pass', async () => {
  const dir = tempDir('mhe-ab-fixture-');
  createFixture(dir);
  assert.ok(fs.existsSync(path.join(dir, 'src', 'lib.mjs')));
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  const check = await runFixtureCheck(dir, 60000);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.failed, 0);
  assert.equal(check.test_files, 1);
});

test('a copied fixture workspace keeps its git history', () => {
  const source = tempDir('mhe-ab-source-');
  createFixture(source);
  const target = path.join(tempDir('mhe-ab-target-'), 'workspace');
  prepareWorkspace(source, target);
  assert.ok(fs.existsSync(path.join(target, '.git')));
  assert.ok(fs.existsSync(path.join(target, 'test', 'lib.test.mjs')));
});

test('turn summary tracks context growth and hook denials', () => {
  const summary = summarizeTurns([
    { cli_ok: true, duration_ms: 10, context_usage_ratio: 0.1, check: { ok: true } },
    {
      cli_ok: true,
      duration_ms: 20,
      context_usage_ratio: 0.4,
      check: { ok: false },
      hooks: { entries: 3, events: { tool_denied: 1 }, denials: { allowlist: 1 }, jobs: { started: 1 } },
    },
  ]);
  assert.equal(summary.turns, 2);
  assert.equal(summary.cli_failed, 0);
  assert.equal(summary.context.delta, 0.3);
  assert.equal(summary.context.max, 0.4);
  assert.equal(summary.checks_ok, 1);
  assert.equal(summary.hooks.denials.allowlist, 1);
});

test('a turn the runner cut at its limit is counted as a timeout, not a CLI crash', () => {
  const turns = summarizeTurns([
    { cli_ok: true, duration_ms: 10, context_usage_ratio: 0.1, check: { ok: true } },
    { cli_ok: false, timed_out: true, duration_ms: 300000, check: { ok: true } },
    { cli_ok: false, timed_out: false, duration_ms: 12, check: { ok: true } },
  ]);
  assert.equal(turns.cli_failed, 2);
  assert.equal(turns.turn_timeouts, 1);

  const summary = summarizeAb(
    [{
      arm: 'treatment',
      repeat: 1,
      session_id: 's1',
      summary: turns,
    }],
    { model: 'Qwen3.8-Flash', turns: 3, repeats: 1 },
  );
  assert.equal(summary.arms.treatment.turn_timeouts, 1);
  assert.equal(summary.arms.treatment.cli_failures, 2);
});

const FAKE_CLI = [
  "let buf = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buf += chunk;",
  "  let i;",
  "  while ((i = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, i).trim();",
  "    buf = buf.slice(i + 1);",
  "    if (!line) continue;",
  "    const text = JSON.parse(line).message.content[0].text;",
  "    if (text === 'HANG') continue;",
  "    process.stdout.write(JSON.stringify({",
  "      type: 'result', result: text, duration_ms: 1,",
  "      session_id: 'fixed', context_usage_ratio: 0.1,",
  "    }) + '\\n');",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');

function fakeSession() {
  const dir = tempDir('mhe-ab-fakecli-');
  const file = path.join(dir, 'cli.mjs');
  fs.writeFileSync(file, FAKE_CLI, 'utf8');
  return createSessionProcess({
    command: process.execPath,
    args: [file],
    cwd: dir,
    env: process.env,
  });
}

test('a session input line is one user message in NDJSON', () => {
  const line = sessionInputLine('do the thing');
  assert.ok(line.endsWith('\n'));
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.equal(parsed.message.content[0].text, 'do the thing');
});

test('one session process turns N messages into N results', async () => {
  const session = fakeSession();
  const first = await session.send('one', 5000);
  const second = await session.send('two', 5000);
  assert.equal(first.event.result, 'one');
  assert.equal(second.event.result, 'two');
  assert.equal(first.event.session_id, second.event.session_id);
  assert.equal(first.timedOut, false);
  session.close();
});

test('a turn that stops answering is a timeout, not a silent hang', async () => {
  const session = fakeSession();
  const first = await session.send('one', 5000);
  assert.equal(first.event.result, 'one');
  const stuck = await session.send('HANG', 150);
  assert.equal(stuck.timedOut, true);
  assert.equal(stuck.event, null);
  assert.match(stuck.error, /150ms/);
});

test('the review fixture drives a run and its answers are checked', async () => {
  const outDir = path.join(tempDir('mhe-ab-review-'), 'run');
  const baselineConfig = tempDir('mhe-ab-review-cfg-');
  const result = await runAb({
    arms: ['baseline'],
    turns: 2,
    repeats: 1,
    model: 'Qwen3.8-Flash',
    baselineConfig,
    outDir,
    fixtureKind: 'review',
    runSession: ({ workspace }) => {
      let sent = 0;
      return {
        send: async () => {
          sent += 1;
          const name = String(sent).padStart(2, '0');
          // Deliberately wrong: the first rule always exists in the vocabulary.
          fs.writeFileSync(path.join(workspace, 'answers', `${name}.txt`), 'off-by-one\n');
          return {
            event: { type: 'result', result: 'ok', duration_ms: 1, context_usage_ratio: sent * 0.1 },
            timedOut: false,
            error: '',
          };
        },
        close: () => {},
      };
    },
    log: () => {},
  });
  const workspace = path.join(outDir, 'runs', 'baseline-r1', 'workspace');
  assert.ok(fs.existsSync(path.join(workspace, 'patches', '01.patch')));
  assert.ok(!fs.existsSync(path.join(workspace, 'src', 'lib.mjs')));
  assert.equal(result.summary.arms.baseline.turns, 2);
  assert.equal(result.summary.arms.baseline.final_tests_ok, 0);
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 'baseline-r1', 'result.json'), 'utf8'));
  assert.ok(written.summary.final_check.failed >= 1);
});

test('ab run writes a summary and refuses a non-empty output dir', async () => {
  const outDir = path.join(tempDir('mhe-ab-out-'), 'run');
  const baselineConfig = tempDir('mhe-ab-baseline-');
  const calls = [];
  const result = await runAb({
    arms: ['baseline'],
    turns: 2,
    repeats: 1,
    model: 'Qwen3.8-Flash',
    baselineConfig,
    outDir,
    runSession: ({ sessionId }) => {
      const sent = [];
      return {
        send: async (prompt) => {
          sent.push(prompt);
          return {
            event: {
              type: 'result',
              result: 'ok',
              duration_ms: 5,
              context_usage_ratio: sent.length * 0.1,
              session_id: sessionId,
            },
            timedOut: false,
            error: '',
          };
        },
        close: () => { calls.push({ closed: true, sent: sent.length, sessionId }); },
      };
    },
    check: async () => ({ ok: true, code: 0, passed: 2, failed: 0, test_files: 1, duration_ms: 3 }),
    log: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].closed, true);
  assert.equal(calls[0].sent, 2);
  assert.equal(result.summary.arms.baseline.runs, 1);
  assert.equal(result.summary.arms.baseline.turns, 2);
  assert.ok(fs.existsSync(path.join(outDir, 'summary.json')));
  assert.match(fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'), /\| baseline \|/);

  await assert.rejects(
    runAb({
      arms: ['baseline'],
      turns: 1,
      repeats: 1,
      model: 'Qwen3.8-Flash',
      baselineConfig,
      outDir,
      runSession: () => ({
        send: async () => ({ event: { type: 'result' }, timedOut: false, error: '' }),
        close: () => {},
      }),
      check: async () => ({ ok: true }),
      log: () => {},
    }),
    /not empty/,
  );
});

test('ab run refuses Auto as a model and a treatment arm without harness hooks', async () => {
  const baselineConfig = tempDir('mhe-ab-baseline-auto-');
  await assert.rejects(
    runAb({
      arms: ['baseline'],
      model: 'auto',
      baselineConfig,
      outDir: path.join(tempDir('mhe-ab-out-auto-'), 'run'),
      log: () => {},
    }),
    /Auto is not a valid A\/B model/,
  );

  const treatmentConfig = tempDir('mhe-ab-treatment-empty-');
  await assert.rejects(
    runAb({
      arms: ['treatment'],
      model: 'Qwen3.8-Flash',
      treatmentConfig,
      treatmentHome: tempDir('mhe-ab-home-'),
      outDir: path.join(tempDir('mhe-ab-out-treatment-'), 'run'),
      log: () => {},
    }),
    /no harness hooks/,
  );
});
