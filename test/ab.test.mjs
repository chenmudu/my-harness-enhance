import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendBehaviorLabels,
  assertIsolatedDir,
  cliSessionArgs,
  configHasHarness,
  contextWindowOf,
  createFixture,
  createSessionProcess,
  longHorizonPrompts,
  parseCliResult,
  parseTestCounts,
  prepareWorkspace,
  renderSummaryMarkdown,
  runAb,
  runFixtureCheck,
  sessionInputLine,
  summarizeAb,
  summarizeTurns,
  turnEnv,
} from '../src/bench/ab.mjs';
import { projectKey } from '../src/core/state-root.mjs';

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

test('the session runtime-config supplies the ratio denominator', () => {
  assert.equal(contextWindowOf(null), null);
  assert.equal(contextWindowOf([]), null);
  assert.equal(
    contextWindowOf([
      { type: 'runtime-config', contextWindow: null },
      { type: 'assistant', message: {} },
      { type: 'runtime-config', contextWindow: 200000 },
      { type: 'runtime-config', contextWindow: null },
    ]),
    200000,
  );
  assert.equal(
    contextWindowOf([{ type: 'runtime-config', contextWindow: 0 }, { type: 'runtime-config', contextWindow: 'x' }]),
    null,
  );
});

test('a reported window turns ratios into comparable token counts', () => {
  const summary = summarizeTurns([
    { cli_ok: true, duration_ms: 1, context_usage_ratio: 0.1, context_window: 200000, context_tokens: 20000 },
    { cli_ok: true, duration_ms: 1, context_usage_ratio: 0.25, context_window: 200000, context_tokens: 50000 },
  ]);
  assert.equal(summary.context.window, 200000);
  assert.deepEqual(summary.context.tokens, { first: 20000, last: 50000, delta: 30000 });

  const unknown = summarizeTurns([{ cli_ok: true, duration_ms: 1, context_usage_ratio: 0.25 }]);
  assert.equal(unknown.context.window, null);
  assert.equal(unknown.context.tokens, null);
  assert.equal(unknown.context.last, 0.25);
});

test('summaries refuse a ratio comparison when the arms used different denominators', () => {
  const run = (arm, window) => ({
    arm,
    repeat: 1,
    session_id: `${arm}-1`,
    summary: summarizeTurns([
      {
        cli_ok: true,
        duration_ms: 1,
        context_usage_ratio: 0.1,
        context_window: window,
        context_tokens: window ? Math.round(0.1 * window) : null,
      },
    ]),
  });

  const missing = summarizeAb([run('baseline', null), run('treatment', 200000)], { turns: 1, repeats: 1 });
  assert.equal(missing.context.comparable, null);
  assert.match(missing.context.warning, /baseline did not report a context window/);

  const mismatch = summarizeAb([run('baseline', 1048576), run('treatment', 200000)], { turns: 1, repeats: 1 });
  assert.equal(mismatch.context.comparable, false);
  assert.match(mismatch.context.warning, /different context windows/);
  const markdown = renderSummaryMarkdown(mismatch);
  assert.match(markdown, /ctx tokens last/);
  assert.match(markdown, /different context windows/);

  const same = summarizeAb([run('baseline', 200000), run('treatment', 200000)], { turns: 1, repeats: 1 });
  assert.equal(same.context.comparable, true);
  assert.equal(same.context.warning, null);
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

test('the summary carries composition and billed credits per arm', () => {
  const run = (arm) => ({
    arm,
    repeat: 1,
    session_id: `${arm}-1`,
    summary: summarizeTurns([
      { cli_ok: true, duration_ms: 1, context_usage_ratio: 0.1, context_window: 200000, context_tokens: 20000 },
    ]),
    composition: { assistant: 100, tool_results: 500, worker_results: 50, attachments: 5, total: 655, by_tool: { Read: 500 } },
    cost: { credits: 1.25, requests: 3, model: 'gfmodel' },
  });
  const summary = summarizeAb([run('baseline'), run('treatment')], { turns: 1, repeats: 1 });
  assert.equal(summary.arms.baseline.credits, 1.25);
  assert.equal(summary.arms.treatment.composition.tool_results, 500);
  const markdown = renderSummaryMarkdown(summary);
  assert.match(markdown, /credits/);
  assert.match(markdown, /\| baseline \|.*\| 100 \| 500 \| 50 \|/);
  assert.match(markdown, /estimated tokens from the transcript/);
});

test('both arms are pinned to the same explicit context window', () => {
  const args = cliSessionArgs({
    configDir: 'C:/tmp/config',
    model: 'GLM-5.3-Flash',
    sessionId: 's1',
    contextWindow: 200000,
  });
  const index = args.indexOf('--context-window');
  assert.ok(index > 0, 'the window flag must be present');
  assert.equal(args[index + 1], '200000');
  assert.ok(!cliSessionArgs({ configDir: 'c', model: 'm', sessionId: 's' }).includes('--context-window'));
});

test('the summary splits conductor and worker credits and reports the spread', () => {
  const run = (arm, repeat, conductor, worker) => ({
    arm,
    repeat,
    session_id: `${arm}-${repeat}`,
    summary: summarizeTurns([
      { cli_ok: true, duration_ms: 60000, context_usage_ratio: 0.1, context_window: 200000, context_tokens: 20000 },
    ]),
    composition: null,
    cost: {
      credits: conductor,
      requests: 2,
      model: 'gfmodel',
      conductor: { credits: conductor, requests: 2 },
      worker: { credits: worker, requests: 1 },
      total: { credits: conductor + worker, requests: 3 },
      provider: { available: false },
    },
  });
  const summary = summarizeAb(
    [
      run('baseline', 1, 1, 0),
      run('treatment', 1, 2, 1),
      run('treatment', 2, 3, 1),
      run('treatment', 3, 2, 2),
    ],
    { turns: 1, repeats: 3, contextWindow: 200000 },
  );
  assert.equal(summary.arms.treatment.conductor_credits, 7);
  assert.equal(summary.arms.treatment.worker_credits, 4);
  assert.equal(summary.arms.treatment.credits, 11);
  assert.equal(summary.arms.treatment.credits_median, 4);
  assert.equal(summary.arms.treatment.credits_min, 3);
  assert.equal(summary.arms.treatment.credits_max, 4);
  assert.equal(summary.arms.treatment.cost_source, 'conductor+worker');
  assert.equal(summary.arms.treatment.provider.available, false);
  assert.equal(summary.reliable, true);
  assert.equal(summary.context.valid, true);
  const markdown = renderSummaryMarkdown(summary);
  assert.match(markdown, /credits med \[min-max\]/);
  assert.match(markdown, /Credits sum the conductor session and every `subagents\/agent-\*\.jsonl`/);
});

test('a stored run without worker usage is labelled conductor-only', () => {
  const run = {
    arm: 'treatment',
    repeat: 1,
    session_id: 'old',
    summary: summarizeTurns([{ cli_ok: true, duration_ms: 1000, context_usage_ratio: 0.1 }]),
    composition: null,
    cost: { credits: 2, requests: 3, model: 'gfmodel' },
  };
  const summary = summarizeAb([run], { turns: 1, repeats: 1 });
  assert.equal(summary.arms.treatment.cost_source, 'conductor-only');
  assert.equal(summary.reliable, false);
  assert.match(renderSummaryMarkdown(summary), /a single run cannot support a cost ratio/);
});

test('a mismatched window marks the run invalid, not merely warned', () => {
  const run = (arm, window) => ({
    arm,
    repeat: 1,
    session_id: arm,
    summary: summarizeTurns([
      { cli_ok: true, duration_ms: 1000, context_usage_ratio: 0.1, context_window: window },
    ]),
    composition: null,
  });
  const summary = summarizeAb([run('baseline', 1048576), run('treatment', 200000)], { turns: 1, repeats: 1 });
  assert.equal(summary.context.comparable, false);
  assert.equal(summary.context.valid, false);
  assert.match(renderSummaryMarkdown(summary), /INVALID RUN/);
});

test('behavior labels are written to the metrics file deterministically', () => {
  const home = tempDir('mhe-labels-');
  const workspace = path.join(home, 'workspace');
  const behavior = {
    turns: [
      { turn: 1, hit: true, wrongTask: 0, reRead: 0, failed: false, recovered: null },
      { turn: 2, hit: false, wrongTask: 1, reRead: 2, failed: true, recovered: false },
    ],
  };
  appendBehaviorLabels(home, workspace, 'session-1', behavior);
  appendBehaviorLabels(home, workspace, 'session-1', behavior);
  const file = path.join(home, 'projects', projectKey(workspace), 'metrics.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].event, 'behavior_label');
  assert.equal(rows[0].session, 'session-1');
  assert.equal(rows[0].next_action_hit, true);
  assert.equal(rows[1].wrong_task, 1);
  assert.equal(rows[1].re_read, 2);
  assert.equal(rows[1].failed, true);
  assert.deepEqual(
    rows.slice(0, 2).map(({ at, ...rest }) => rest),
    rows.slice(2).map(({ at, ...rest }) => rest),
  );
});
