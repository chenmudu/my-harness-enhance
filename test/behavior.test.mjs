import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedPaths,
  expectedPathsFor,
  summarizeBehavior,
  transcriptPath,
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
  const file = transcriptPath('C:/cfg', 'C:\\Users\\Administrator\\.mhe-test\\run\\workspace', 'sid-1');
  assert.match(file, /projects[\\/]C--Users-Administrator--mhe-test-run-workspace[\\/]sid-1\.jsonl$/);
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
