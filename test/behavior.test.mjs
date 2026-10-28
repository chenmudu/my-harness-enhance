import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expectedPaths,
  expectedPathsFor,
  readTranscript,
  summarizeBehavior,
  summarizeComposition,
  summarizeCost,
  transcriptPath,
  workerTranscriptPaths,
} from '../src/bench/behavior.mjs';

function human(text) {
  return { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } };
}

function toolUse(name, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  };
}

function toolError() {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'boom' }] },
  };
}

test('transcript paths mirror the CLI workspace key', () => {
  const file = transcriptPath('C:/cfg', 'D:\\repo\\sample\\workspace', 'sid-1');
  assert.match(file, /projects[\\/]D--repo-sample-workspace[\\/]sid-1\.jsonl$/);
});

test('expected paths follow the prompt script for both fixtures', () => {
  assert.deepEqual(expectedPaths('library', 1, 15), ['README.md', 'TASKS.md', 'src/lib.mjs', 'test/lib.test.mjs']);
  assert.deepEqual(expectedPaths('library', 5, 15), ['src/lib.mjs', 'test/lib.test.mjs']);
  assert.deepEqual(expectedPaths('library', 15, 15), ['README.md', 'src/lib.mjs', 'src/index.mjs']);
  assert.deepEqual(expectedPaths('review', 3, 15), ['patches/03.patch', 'answers/03.txt', 'RULES.md']);
});

test('labels count a hit, an off-task action, a re-read and a recovery', () => {
  const entries = [
    human('Step 1/15: inspect'),
    toolUse('Read', { file_path: 'C:\\ws\\src\\lib.mjs' }),
    toolUse('Read', { file_path: 'C:\\ws\\src\\lib.mjs' }),
    toolUse('Write', { file_path: 'C:\\ws\\docs\\other.md' }),
    toolError(),
    human('Step 2/15: edit'),
    toolUse('Edit', { file_path: 'C:\\ws\\test\\lib.test.mjs' }),
  ];
  const summary = summarizeBehavior(entries, { fixtureKind: 'library', turns: 15 });
  assert.equal(summary.coverage, 'main session only');
  assert.equal(summary.turns.length, 2);
  assert.equal(summary.turns[0].turn, 1);
  assert.equal(summary.turns[0].hit, true);
  assert.equal(summary.turns[0].reRead, 1);
  assert.equal(summary.turns[0].wrongTask, 1);
  assert.equal(summary.turns[0].failed, true);
  assert.equal(summary.turns[1].turn, 2);
  assert.equal(summary.turns[1].hit, true);
  assert.equal(summary.turns[1].recovered, true);
  assert.equal(summary.totals.next_action_hit, 2);
  assert.equal(summary.totals.re_reads, 1);
  assert.equal(summary.totals.wrong_task_actions, 1);
  assert.equal(summary.totals.failed_turns, 1);
  assert.equal(summary.totals.recoveries, 1);
});

test('a turn that starts on the wrong file is not a hit', () => {
  const entries = [
    human('Step 1/15: inspect'),
    toolUse('Read', { file_path: 'C:\\ws\\README.md' }),
    human('Step 3/15: edit'),
    toolUse('Write', { file_path: 'C:\\ws\\src\\other.mjs' }),
  ];
  const summary = summarizeBehavior(entries, { fixtureKind: 'library', turns: 15 });
  assert.equal(summary.turns[1].turn, 3);
  assert.equal(summary.turns[1].hit, false);
  assert.equal(summary.turns[1].wrongTask, 1);
  assert.equal(summary.turns[0].hit, true);
  assert.equal(summary.totals.next_action_hit, 1);
});

test('the review fixture reads its turn number from the patch path', () => {
  const entries = [
    human('Read patches/04.patch and RULES.md.'),
    toolUse('Read', { file_path: 'C:\\ws\\patches\\04.patch' }),
  ];
  const summary = summarizeBehavior(entries, { fixtureKind: 'review', turns: 15 });
  assert.equal(summary.turns[0].turn, 4);
  assert.equal(summary.turns[0].hit, true);
});

test('a stream-json prompt arrives as a content array and still labels', () => {
  const prompt = {
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text: 'Read patches/02.patch and RULES.md.' }] },
  };
  const summary = summarizeBehavior(
    [prompt, toolUse('Read', { file_path: 'C:\\ws\\patches\\02.patch' })],
    { fixtureKind: 'review', turns: 15 },
  );
  assert.equal(summary.turns[0].turn, 2);
  assert.equal(summary.totals.next_action_hit, 1);
});
test('the oracle takes paths the prompt names, not only the script table', () => {
  const prompt = 'Step 2/15: add the helper to src/helpers.mjs and cover it in test/lib.test.mjs.';
  const expected = expectedPathsFor(prompt, 'library', 2, 15);
  assert.ok(expected.includes('src/helpers.mjs'));
  assert.ok(expected.includes('src/lib.mjs'), 'script paths stay in the oracle');
  assert.ok(expected.includes('test/lib.test.mjs'));

  const entries = [
    human(prompt),
    toolUse('Write', { file_path: 'C:/ws/src/helpers.mjs' }),
  ];
  const summary = summarizeBehavior(entries, { fixtureKind: 'library', turns: 15 });
  assert.equal(summary.turns[0].hit, true);
  assert.equal(summary.turns[0].wrongTask, 0);
});

test('labels are reproducible: the same transcript yields the same numbers', () => {
  const entries = [
    human('Step 1/15: inspect'),
    toolUse('Read', { file_path: 'C:\ws\src\lib.mjs' }),
    toolUse('Read', { file_path: 'C:\ws\src\lib.mjs' }),
    human('Step 2/15: edit'),
    toolError(),
    toolUse('Edit', { file_path: 'C:\ws\test\lib.test.mjs' }),
  ];
  const first = summarizeBehavior(entries, { fixtureKind: 'library', turns: 15 });
  const second = summarizeBehavior(entries, { fixtureKind: 'library', turns: 15 });
  assert.deepEqual(first, second);
});

test('composition splits assistant, tool and worker tokens', () => {
  const entries = [
    human('patch 01'),
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing the options'.repeat(10) },
          { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'patches/01.patch' } },
          { type: 'tool_use', id: 'u2', name: 'Agent', input: { prompt: 'worker prompt '.repeat(20) } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'u1', content: 'file body '.repeat(400) },
          { type: 'tool_result', tool_use_id: 'u2', content: '{"status":"ok"}'.repeat(10) },
        ],
      },
    },
    { type: 'attachment', content: 'attached notes' },
  ];
  const out = summarizeComposition(entries);
  assert.ok(out.assistant > 0);
  assert.ok(out.tool_results > out.worker_results, 'the file body dwarfs the envelope');
  assert.ok(out.worker_results > 0);
  assert.ok(out.attachments > 0);
  assert.ok(out.by_tool.Read > out.by_tool.Agent);
  assert.equal(out.total, out.assistant + out.tool_results + out.worker_results + out.attachments);
  assert.equal(summarizeComposition(null).total, 0);
});

test('assistant output splits into text, thinking, and tool input', () => {
  const out = summarizeComposition([{
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'thinking', thinking: 'let me think about it' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } },
      ],
    },
  }]);
  assert.ok(out.assistant_text > 0);
  assert.ok(out.assistant_thinking > 0);
  assert.ok(out.assistant_tool_use > 0);
  assert.equal(out.assistant, out.assistant_text + out.assistant_thinking + out.assistant_tool_use);
});

test('cost sums the credits the CLI reports', () => {
  const entries = [
    { type: 'assistant', message: { model: 'gfmodel', usage: { credits: 0.25 } } },
    { type: 'assistant', message: { model: 'gfmodel', usage: { credits: 0.5 } } },
    { type: 'runtime-config', contextWindow: 200000 },
  ];
  const cost = summarizeCost(entries);
  assert.equal(cost.credits, 0.75);
  assert.equal(cost.requests, 2);
  assert.equal(cost.model, 'gfmodel');
  assert.equal(summarizeCost([]).credits, 0);
});

test('worker subagent transcripts are discovered beside the main session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-worker-transcripts-'));
  const configDir = path.join(home, 'config');
  const workspace = path.join(home, 'workspace');
  const key = workspace.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(configDir, 'projects', key, 'session-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent-a.jsonl'),
    '{"type":"assistant","message":{"model":"gfmodel","usage":{"credits":0.5}}}\n',
    'utf8',
  );
  const files = workerTranscriptPaths(configDir, workspace, 'session-1');
  assert.equal(files.length, 1);
  const workerEntries = readTranscript(files[0]);
  const cost = summarizeCost(
    [{ type: 'assistant', message: { model: 'gfmodel', usage: { credits: 0.25 } } }],
    { workerEntries },
  );
  // `credits` keeps its old conductor-only meaning; `total` is what was billed.
  assert.equal(cost.credits, 0.25);
  assert.equal(cost.worker.credits, 0.5);
  assert.equal(cost.worker.requests, 1);
  assert.equal(cost.total.credits, 0.75);
  assert.equal(cost.total.requests, 2);
  assert.equal(workerTranscriptPaths(configDir, workspace, 'missing').length, 0);
});

test('the provider token split is marked unavailable when the CLI zeroes it', () => {
  const reported = summarizeCost([
    { type: 'assistant', message: { usage: { credits: 1, input_tokens: 10, output_tokens: 5 } } },
  ]);
  assert.equal(reported.provider.available, true);
  assert.equal(reported.provider.input, 10);
  assert.equal(reported.provider.output, 5);

  const zeroed = summarizeCost([
    { type: 'assistant', message: { usage: { credits: 1, input_tokens: 0, output_tokens: 0 } } },
  ]);
  assert.equal(zeroed.provider.available, false);
  assert.equal(summarizeCost([]).provider.available, false);
});
