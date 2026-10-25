import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { atomicWrite, readJson } from '../core/fs-util.mjs';
import { canonicalPath, projectKey } from '../core/state-root.mjs';
import { sessionKey } from '../core/store.mjs';
import { summarizeMetrics } from '../core/metrics.mjs';
import { buildReviewFixture, checkReviewAnswers, reviewPrompts } from './review-fixture.mjs';
import { readTranscript, summarizeBehavior, transcriptPath } from './behavior.mjs';

export const DEFAULT_MODEL = 'GLM-5.3-Flash';
export const DEFAULT_TURNS = 15;
export const DEFAULT_REPEATS = 2;
export const ARMS = ['baseline', 'treatment'];

const STRIPPED_ENV = [
  'QODER_AGENT_SDK_ENTRYPOINT',
  'QODER_AGENT_SDK_DAEMON',
  'QODER_AGENT_SDK_VERSION',
  'QODER_SDK_AUTH_PAYLOAD_FILE',
  'QODERCN_SESSION_TYPE',
  'QODERCN_CLI',
  'QODER_CONFIG_DIR',
  'MY_HARNESS_ENHANCE_PROJECT',
  'MY_HARNESS_ENHANCE_SESSION',
  'MY_HARNESS_ENHANCE_GLOBAL',
  'NODE_TEST_CONTEXT',
];

const STEPS = [
  'Read README.md, TASKS.md, src/lib.mjs and the tests. Reply with a 3-line plan; do not edit files.',
  'Add `multiply(a, b)` to src/lib.mjs, export it, add tests for positive, zero, and negative inputs. Run `node --test` and report the pass/fail counts.',
  'Add `divide(a, b)` that throws RangeError when b is 0. Add tests for a normal division and for the zero case. Run `node --test`.',
  'Add `clamp(value, min, max)` that throws RangeError when min > max. Add tests. Run `node --test`.',
  'Add `sum(values)` for an array, returning 0 for an empty array. Add tests. Run `node --test`.',
  'Add `unique(values)` that preserves first-occurrence order. Add tests. Run `node --test`.',
  'Add `chunk(values, size)` that throws RangeError when size < 1. Add tests. Run `node --test`.',
  'Add `range(start, end, step = 1)` that throws RangeError when step is 0. Add tests. Run `node --test`.',
  'Add `slugify(text)`: lowercase, trim, and replace runs of non-alphanumerics with a single dash. Add tests. Run `node --test`.',
  'Add `titleCase(text)` that preserves internal apostrophes. Add tests. Run `node --test`.',
  'Add `parseBool(value)` accepting true/false/yes/no/1/0 case-insensitively and throwing otherwise. Add tests. Run `node --test`.',
  'Add `formatBytes(n)` using base 1024 with B/KB/MB/GB and one decimal for values of KB or larger. Add tests. Run `node --test`.',
  'Add `median(values)` that throws on an empty array and does not mutate its input. Add tests. Run `node --test`.',
  'Create src/index.mjs that re-exports every public function; add a test that imports from src/index.mjs. Run `node --test`.',
  'Update the API list in README.md to match the exported functions, add a Development section with the test command, run the full tests, and report the final pass/fail counts.',
];

const README = `# mhe-ab-fixture

Tiny utility library used for long-horizon runs.

## API

- add(a, b)
- subtract(a, b)

## Development

Run \`node --test\`.
`;

const TASKS = `# Task

Grow this library one request at a time. Each request adds one function, its
tests, and a passing test run. Keep every existing export working.

The API must stay small and dependency-free.
`;

const LIB = `export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}
`;

const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract } from '../src/lib.mjs';

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 2), 0);
});

test('subtract returns the difference', () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(0, 4), -4);
});
`;

function isUnder(target, base) {
  const a = target.toLowerCase();
  const b = base.toLowerCase();
  return a === b || a.startsWith(`${b}${path.sep}`);
}

function forbiddenRoots() {
  const home = canonicalPath(os.homedir());
  return [
    path.join(home, '.qoder-cn'),
    path.join(home, '.zcode'),
    path.join(home, '.claude'),
    path.join(home, '.my-harness-enhance'),
  ];
}

export function assertIsolatedDir(dir, label) {
  if (!dir) throw new Error(`${label} is required`);
  const target = canonicalPath(dir);
  const home = canonicalPath(os.homedir());
  if (target === path.parse(target).root || target === home) {
    throw new Error(`${label} must be a dedicated subdirectory, not home or a drive root`);
  }
  for (const base of forbiddenRoots()) {
    if (isUnder(target, base)) {
      throw new Error(
        `${label} points at the normal harness location (${target}); ` +
        'use an isolated copy for tests',
      );
    }
  }
  if (isUnder(home, target)) {
    throw new Error(`${label} must not be a parent of the home directory`);
  }
  return target;
}

export function configHasHarness(configDir) {
  const settings = readJson(path.join(configDir, 'settings.json'), null);
  if (!settings) return false;
  const text = `${JSON.stringify(settings.hooks || {})}\n${JSON.stringify(settings.mcpServers || {})}`;
  return /my-harness-enhance|harness-enhance|harness_enhance/.test(text);
}

export function longHorizonPrompts(turns = DEFAULT_TURNS) {
  const requested = Number.parseInt(turns, 10) || DEFAULT_TURNS;
  const count = Math.min(Math.max(requested, 1), STEPS.length);
  return STEPS.slice(0, count).map((step, index) => `Step ${index + 1}/${count}: ${step}`);
}

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

export function createFixture(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'mhe-ab-fixture',
    private: true,
    type: 'module',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), README, 'utf8');
  fs.writeFileSync(path.join(dir, 'TASKS.md'), TASKS, 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'lib.mjs'), LIB, 'utf8');
  fs.writeFileSync(path.join(dir, 'test', 'lib.test.mjs'), TEST, 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'mhe-ab']);
  git(dir, ['config', 'user.email', 'mhe-ab@localhost']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture baseline']);
  return dir;
}

export function prepareWorkspace(fixture, workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  if (fixture) {
    fs.cpSync(fixture, workspace, { recursive: true });
    if (!fs.existsSync(path.join(workspace, '.git'))) createFixture(workspace);
  } else {
    createFixture(workspace);
  }
  return workspace;
}

function cleanEnv({ arm, sessionId, treatmentHome, base = process.env }) {
  const env = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  if (arm === 'treatment') {
    env.MY_HARNESS_ENHANCE_HOME = treatmentHome;
    env.MY_HARNESS_ENHANCE_SESSION = sessionId;
  } else {
    delete env.MY_HARNESS_ENHANCE_HOME;
    delete env.MY_HARNESS_ENHANCE_SESSION;
  }
  return env;
}

export function turnEnv(options) {
  return cleanEnv(options);
}

export function runProcess(command, args, { cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), durationMs: 0, timedOut: false, spawnError: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs)
      : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error}`, durationMs: Date.now() - started, timedOut, spawnError: String(error) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

export function parseCliResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const value = JSON.parse(lines[index]);
      if (value && value.type === 'result') return value;
    } catch {
      // keep scanning: wrapper logs may share stdout
    }
  }
  return null;
}

export function parseTestCounts(text) {
  const source = String(text || '');
  const read = (name) => {
    const matches = [...source.matchAll(new RegExp(`(?:#|ℹ)\\s*${name}\\s+(\\d+)`, 'gi'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  return { passed: read('pass'), failed: read('fail') };
}

function countTestFiles(dir) {
  let count = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.[cm]?js$/.test(entry.name)) count += 1;
    }
  };
  walk(dir);
  return count;
}

export async function runFixtureCheck(workspace, timeoutMs = 120000) {
  const env = cleanEnv({ arm: 'baseline', sessionId: '' });
  const proc = await runProcess(process.execPath, ['--test'], { cwd: workspace, env, timeoutMs });
  const counts = parseTestCounts(`${proc.stdout}\n${proc.stderr}`);
  return {
    ok: proc.code === 0 && !proc.timedOut,
    code: proc.code,
    timed_out: proc.timedOut,
    duration_ms: proc.durationMs,
    passed: counts.passed,
    failed: counts.failed,
    test_files: countTestFiles(workspace),
  };
}

export function readSessionMetricEntries(treatmentHome, workspace, sessionId) {
  const file = path.join(treatmentHome, 'projects', projectKey(workspace), 'metrics.jsonl');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const key = sessionKey(sessionId);
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.session === key) entries.push(entry);
    } catch {
      // ignore a torn tail line
    }
  }
  return entries;
}

export function sessionInputLine(prompt) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] },
  })}\n`;
}

function cliSessionArgs({ configDir, model, sessionId }) {
  return [
    '--config-dir', configDir,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--print',
    '--model', model,
    '--permission-mode', 'bypass_permissions',
    '--session-id', sessionId,
  ];
}

/**
 * One CLI process for a whole run. A turn boundary is a `result` event on
 * stdout, not a new process, so `SessionStart` fires once per run the way it
 * does in a real session. `send` resolves with the next result event.
 */
export function createSessionProcess({ command, args, cwd, env, onStderr = null }) {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = [];
  let buffer = '';
  let stderr = '';
  let closed = false;
  let exitCode = null;
  let timer = null;

  const settle = (value) => {
    const waiter = waiters.shift();
    if (!waiter) return false;
    waiter(value);
    return true;
  };

  const handleLine = (line) => {
    const event = parseCliResult(line);
    if (event) settle({ event, timedOut: false, error: '' });
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (onStderr) onStderr(chunk);
  });
  child.stdin.on('error', () => {});
  child.on('error', (error) => {
    closed = true;
    while (waiters.length) settle({ event: null, timedOut: false, error: String(error) });
  });
  child.on('close', (code) => {
    closed = true;
    exitCode = code ?? -1;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (waiters.length) {
      settle({
        event: null,
        timedOut: false,
        error: stderr ? firstLine(stderr) : `cli exited with code ${exitCode}`,
      });
    }
  });

  return {
    send(prompt, timeoutMs = 0) {
      if (closed) {
        return Promise.resolve({
          event: null,
          timedOut: false,
          error: `cli is not running (code ${exitCode})`,
        });
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          resolve(value);
        };
        waiters.push(finish);
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timer = null;
            child.kill('SIGKILL');
            finish({ event: null, timedOut: true, error: `one turn exceeded ${timeoutMs}ms` });
          }, timeoutMs);
        }
        child.stdin.write(sessionInputLine(prompt));
      });
    },
    close() {
      if (closed) return;
      try {
        child.stdin.end();
      } catch {
        // the process is already gone
      }
    },
    kill() {
      if (closed) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // the process is already gone
      }
    },
    get closed() {
      return closed;
    },
    get stderr() {
      return stderr;
    },
  };
}

function openCliSession({ cli, workspace, arm, sessionId, treatmentHome, args, env }) {
  return createSessionProcess({ command: cli, args, cwd: workspace, env });
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

export function summarizeTurns(turns = []) {
  const context = turns.map((turn) => turn.context_usage_ratio).filter((value) => value !== null);
  const sum = turns.reduce((total, turn) => total + (turn.duration_ms || 0), 0);
  const lastHooks = [...turns].reverse().find((turn) => turn.hooks)?.hooks || null;
  const first = context.length ? context[0] : null;
  const last = context.length ? context[context.length - 1] : null;
  return {
    turns: turns.length,
    cli_ok: turns.filter((turn) => turn.cli_ok).length,
    cli_failed: turns.filter((turn) => !turn.cli_ok).length,
    turn_timeouts: turns.filter((turn) => turn.timed_out).length,
    duration_ms: sum,
    context: {
      first,
      last,
      max: context.length ? Math.max(...context) : null,
      delta: first !== null && last !== null ? Math.round((last - first) * 10000) / 10000 : null,
      avg: context.length
        ? Math.round((context.reduce((total, value) => total + value, 0) / context.length) * 10000) / 10000
        : null,
    },
    checks_ok: turns.filter((turn) => turn.check?.ok).length,
    final_check: turns.length ? turns[turns.length - 1].check : null,
    hooks: lastHooks
      ? { entries: lastHooks.entries, events: lastHooks.events, denials: lastHooks.denials, jobs: lastHooks.jobs, injection: lastHooks.injection }
      : null,
  };
}

async function runArm({
  arm,
  repeat,
  prompts,
  cli,
  configDir,
  treatmentHome,
  workspace,
  model,
  timeoutMs,
  checkTimeoutMs,
  runSession,
  check,
}) {
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const turns = [];
  const session = runSession({
    cli,
    sessionId,
    workspace,
    arm,
    treatmentHome,
    args: cliSessionArgs({ configDir, model, sessionId }),
    env: turnEnv({ arm, sessionId, treatmentHome }),
  });
  let stopped = '';
  try {
    for (let index = 0; index < prompts.length; index += 1) {
      const started = new Date().toISOString();
      const result = await session.send(prompts[index], timeoutMs);
      const checked = await check(workspace, checkTimeoutMs);
      const hooks = arm === 'treatment'
        ? summarizeMetrics(readSessionMetricEntries(treatmentHome, workspace, sessionId))
        : null;
      const payload = result.event;
      const ok = Boolean(payload) && payload.is_error !== true && !result.timedOut;
      const refusal = Array.isArray(payload?.errors) && payload.errors.length
        ? String(payload.errors[0])
        : '';
      turns.push({
        index: index + 1,
        started_at: started,
        prompt_chars: prompts[index].length,
        duration_ms: Number(payload?.duration_ms) || 0,
        cli_ok: ok,
        exit_code: payload ? 0 : -1,
        timed_out: Boolean(result.timedOut),
        session_id: payload?.session_id || sessionId,
        context_usage_ratio: numberOrNull(
          payload?.usage?.context_usage_ratio ?? payload?.context_usage_ratio,
        ),
        result_chars: String(payload?.result || '').length,
        permission_denials: Array.isArray(payload?.permission_denials)
          ? payload.permission_denials.length
          : null,
        check: checked,
        hooks: hooks
          ? { entries: hooks.entries, events: hooks.events, denials: hooks.denials, jobs: hooks.jobs, injection: hooks.injection }
          : null,
        error: ok ? '' : (refusal || payload?.result || result.error || 'no result payload'),
      });
      if (result.timedOut) {
        stopped = 'turn timeout';
        break;
      }
      if (session.closed) {
        stopped = result.error || 'cli closed';
        break;
      }
    }
  } finally {
    session.close();
  }
  return {
    arm,
    repeat,
    session_id: sessionId,
    workspace,
    model,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stopped,
    turns,
    summary: summarizeTurns(turns),
  };
}

function average(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Math.round((numbers.reduce((total, value) => total + value, 0) / numbers.length) * 10000) / 10000 : null;
}

export function summarizeAb(runs, meta = {}) {
  const byArm = {};
  for (const run of runs) {
    const bucket = byArm[run.arm] || {
      runs: 0,
      turns: 0,
      cli_failures: 0,
      turn_timeouts: 0,
      final_tests_ok: 0,
      context_delta: [],
      context_last: [],
      duration_ms: 0,
      denials: 0,
      behavior: null,
    };
    bucket.runs += 1;
    bucket.turns += run.summary.turns;
    bucket.cli_failures += run.summary.cli_failed;
    bucket.turn_timeouts += run.summary.turn_timeouts || 0;
    bucket.final_tests_ok += run.summary.final_check?.ok ? 1 : 0;
    bucket.context_delta.push(run.summary.context.delta);
    bucket.context_last.push(run.summary.context.last);
    bucket.duration_ms += run.summary.duration_ms;
    bucket.denials += Object.values(run.summary.hooks?.denials || {}).reduce((total, value) => total + value, 0);
    if (run.behavior?.totals) {
      bucket.behavior = bucket.behavior || {};
      for (const [name, value] of Object.entries(run.behavior.totals)) {
        bucket.behavior[name] = (bucket.behavior[name] || 0) + value;
      }
    }
    byArm[run.arm] = bucket;
  }
  const arms = {};
  for (const [arm, bucket] of Object.entries(byArm)) {
    arms[arm] = {
      runs: bucket.runs,
      turns: bucket.turns,
      cli_failures: bucket.cli_failures,
      turn_timeouts: bucket.turn_timeouts,
      final_tests_ok: bucket.final_tests_ok,
      context: {
        delta_avg: average(bucket.context_delta),
        last_avg: average(bucket.context_last),
      },
      duration_ms: bucket.duration_ms,
      denials: bucket.denials,
      behavior: bucket.behavior,
    };
  }
  return {
    generated_at: new Date().toISOString(),
    model: meta.model || DEFAULT_MODEL,
    turns: meta.turns || DEFAULT_TURNS,
    repeats: meta.repeats || DEFAULT_REPEATS,
    arms,
    runs: runs.map((run) => ({
      arm: run.arm,
      repeat: run.repeat,
      session_id: run.session_id,
      summary: run.summary,
    })),
  };
}

export function renderSummaryMarkdown(summary) {
  const lines = [];
  lines.push('# Long-horizon A/B');
  lines.push('');
  lines.push(`- model: ${summary.model}`);
  lines.push(`- turns per run: ${summary.turns}`);
  lines.push(`- repeats: ${summary.repeats}`);
  lines.push('');
  lines.push('| arm | runs | turns | cli failures | timeouts | final tests | ctx delta avg | ctx last avg | minutes | denials |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(
      `| ${arm} | ${value.runs} | ${value.turns} | ${value.cli_failures} | ${value.turn_timeouts || 0} | ` +
      `${value.final_tests_ok}/${value.runs} | ${value.context.delta_avg ?? 'n/a'} | ` +
      `${value.context.last_avg ?? 'n/a'} | ${(value.duration_ms / 60000).toFixed(1)} | ${value.denials} |`,
    );
  }
  lines.push('');
  lines.push('Context values are the model-reported `context_usage_ratio` after each turn.');
  lines.push('Denials are hook-reported conductor or worker tool denials.');
  lines.push('Timeouts are turns the runner cut at the per-turn limit; they are counted in cli failures too.');
  const behaviorRows = Object.entries(summary.arms).filter(([, value]) => value.behavior);
  if (behaviorRows.length) {
    lines.push('');
    lines.push('Behavior labels come from the session transcript and cover the main session only.');
    lines.push('');
    lines.push('| arm | labeled turns | next-action hit | wrong-task writes | re-reads | failed turns | recoveries |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [arm, value] of behaviorRows) {
      const b = value.behavior;
      lines.push(`| ${arm} | ${b.turns || 0} | ${b.next_action_hit || 0} | ${b.wrong_task_actions || 0} | ${b.re_reads || 0} | ${b.failed_turns || 0} | ${b.recoveries || 0} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function validateOptions(options) {
  const arms = options.arms || ARMS;
  for (const arm of arms) {
    if (!ARMS.includes(arm)) throw new Error(`unknown arm: ${arm}`);
  }
  if (arms.includes('baseline')) {
    assertIsolatedDir(options.baselineConfig, '--baseline-config');
    if (configHasHarness(options.baselineConfig)) {
      throw new Error('baseline config already has harness hooks; use a clean isolated copy');
    }
  }
  if (arms.includes('treatment')) {
    assertIsolatedDir(options.treatmentConfig, '--treatment-config');
    if (!configHasHarness(options.treatmentConfig)) {
      throw new Error('treatment config has no harness hooks; install into the isolated config dir first');
    }
    assertIsolatedDir(options.treatmentHome, '--treatment-home');
    if (canonicalPath(options.treatmentConfig) === canonicalPath(options.baselineConfig || options.treatmentConfig)) {
      throw new Error('baseline and treatment must use different config dirs');
    }
  }
  if (!options.model) throw new Error('--model is required');
  if (String(options.model).toLowerCase() === 'auto') {
    throw new Error('pin a concrete model; Auto is not a valid A/B model');
  }
  if (options.fixture && !fs.existsSync(options.fixture)) {
    throw new Error(`fixture does not exist: ${options.fixture}`);
  }
}

function defaultOutDir() {
  const stamp = new Date().toISOString().replace(/\..+$/, '').replace(/[-:]/g, '').replace('T', '-');
  return path.join(os.homedir(), '.mhe-test', 'ab-results', stamp);
}

export async function runAb(options = {}) {
  const arms = options.arms || ARMS;
  const turns = Math.min(Math.max(Number.parseInt(options.turns, 10) || DEFAULT_TURNS, 1), STEPS.length);
  const repeats = Math.max(Number.parseInt(options.repeats, 10) || DEFAULT_REPEATS, 1);
  const model = options.model || DEFAULT_MODEL;
  const fixtureKind = options.fixtureKind === 'review' ? 'review' : 'library';
  const prompts = fixtureKind === 'review' ? reviewPrompts(turns) : longHorizonPrompts(turns);
  const outDir = path.resolve(options.outDir || defaultOutDir());
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));

  if (options.dryRun) {
    return { dryRun: true, arms, turns, repeats, model, outDir, prompts };
  }
  validateOptions({ ...options, arms, model });
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`output dir is not empty: ${outDir}; choose a new --out`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const runSession = options.runSession || openCliSession;
  const check = options.check || runFixtureCheck;
  const cli = options.cli || process.env.QODER_CLI || 'qoderclicn';
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const order = repeat % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      const workspace = path.join(outDir, 'runs', `${arm}-r${repeat + 1}`, 'workspace');
      let planted = null;
      if (fixtureKind === 'review') {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.mkdirSync(workspace, { recursive: true });
        planted = buildReviewFixture(workspace, { count: turns });
      } else {
        prepareWorkspace(options.fixture, workspace);
      }
      log(`[ab] ${arm} repeat ${repeat + 1}/${repeats}: starting in ${workspace}`);
      let answered = 0;
      const runCheck = fixtureKind === 'review'
        ? async (target) => {
          answered += 1;
          return checkReviewAnswers(target, planted.slice(0, answered));
        }
        : check;
      const run = await runArm({
        arm,
        repeat: repeat + 1,
        prompts,
        cli,
        configDir: arm === 'treatment' ? options.treatmentConfig : options.baselineConfig,
        treatmentHome: options.treatmentHome,
        workspace,
        model,
        timeoutMs: Number.parseInt(options.timeoutMs, 10) || 300000,
        checkTimeoutMs: Number.parseInt(options.checkTimeoutMs, 10) || 120000,
        runSession,
        check: runCheck,
      });
      run.behavior = summarizeBehavior(
        readTranscript(transcriptPath(
          arm === 'treatment' ? options.treatmentConfig : options.baselineConfig,
          workspace,
          run.session_id,
        )),
        { fixtureKind, turns },
      );
      atomicWrite(
        path.join(outDir, 'runs', `${arm}-r${repeat + 1}`, 'result.json'),
        `${JSON.stringify(run, null, 2)}\n`,
      );
      runs.push(run);
      log(
        `[ab] ${arm} repeat ${repeat + 1}/${repeats}: ` +
        `${run.summary.turns - run.summary.cli_failed}/${run.summary.turns} turns, ` +
        `final tests ${run.summary.final_check?.ok ? 'ok' : 'failed'}, ` +
        `ctx ${run.summary.context.first ?? 'n/a'} -> ${run.summary.context.last ?? 'n/a'}`,
      );
    }
  }

  const summary = summarizeAb(runs, { model, turns, repeats });
  atomicWrite(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(path.join(outDir, 'summary.md'), renderSummaryMarkdown(summary));
  log(`[ab] results: ${outDir}`);
  return { outDir, summary };
}
