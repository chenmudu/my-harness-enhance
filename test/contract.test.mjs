import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactEnvelope,
  invalidResultEnvelope,
  parseEnvelope,
  validateEnvelope,
} from '../src/core/contract.mjs';

const valid = {
  status: 'ok',
  summary: 'Done.',
  evidence: [{ handle: 'abc123def456', note: 'test output' }],
  artifacts: [{ handle: 'abc123def456', kind: 'log', summary: 'test log' }],
  open_questions: [],
  next: 'Continue',
  confidence: 0.9,
};

test('valid envelope passes and is normalized', () => {
  const result = validateEnvelope(valid);
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'ok');
  assert.equal(result.value.v, 1);
  assert.equal(result.value.evidence.length, 1);
});

test('status aliases are normalized to the contract statuses', () => {
  for (const [raw, expected] of [
    ['done', 'ok'],
    ['complete', 'ok'],
    ['completed', 'ok'],
    ['success', 'ok'],
    ['error', 'failed'],
  ]) {
    const result = validateEnvelope({ ...valid, status: raw });
    assert.equal(result.ok, true, raw);
    assert.equal(result.value.status, expected, raw);
  }
});

test('invalid status fails', () => {
  const result = validateEnvelope({ ...valid, status: 'stopped' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /status/);
});

test('missing summary fails', () => {
  const result = validateEnvelope({ ...valid, summary: '' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /summary/);
});

test('evidence may be a path, URL, or file:line reference', () => {
  const result = validateEnvelope({
    ...valid,
    evidence: [
      { handle: '../secret/notes.md', note: 'path' },
      { handle: 'https://example.com/doc', note: 'url' },
      { handle: 'src/core/contract.mjs:42', note: 'file:line' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.evidence.length, 3);
});

test('artifacts may be a path, URL, or internal handle', () => {
  const result = validateEnvelope({
    ...valid,
    artifacts: [
      { handle: '../notes/out.md', kind: 'file', summary: 'path' },
      { handle: 'https://example.com/diff', kind: 'url', summary: 'url' },
      { handle: 'abc123def456', kind: 'log', summary: 'internal' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.artifacts.length, 3);
});

test('an artifact with an empty handle fails', () => {
  const result = validateEnvelope({
    ...valid,
    artifacts: [{ handle: '', kind: 'file', summary: 'bad' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /handle/);
});

test('needs_split requires a proposal', () => {
  const result = validateEnvelope({
    ...valid,
    status: 'needs_split',
    needs_split: { reason: 'too big', proposed: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /proposed/);
});

test('parseEnvelope accepts fenced JSON', () => {
  const text = `Here is the result:\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`;
  const result = parseEnvelope(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.summary, 'Done.');
});

test('parseEnvelope finds JSON after prose', () => {
  const text = `I inspected the repo. Result follows.\n${JSON.stringify(valid)}\nThanks.`;
  const result = parseEnvelope(text);
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'ok');
});

test('parseEnvelope accepts an object response', () => {
  const result = parseEnvelope({ content: [{ type: 'text', text: JSON.stringify(valid) }] });
  assert.equal(result.ok, true);
});

test('parseEnvelope rejects prose without envelope', () => {
  const result = parseEnvelope('All done, everything passed.');
  assert.equal(result.ok, false);
});

test('oversized summary, evidence, and questions are truncated, not rejected', () => {
  const result = validateEnvelope({
    ...valid,
    summary: 'x'.repeat(2000),
    evidence: Array.from({ length: 12 }, (_, i) => ({
      handle: `abc123def45${i}`,
      note: 'note',
    })),
    open_questions: Array.from({ length: 10 }, (_, i) => `question ${i}`),
  });
  assert.equal(result.ok, true);
  assert.ok(result.value.summary.length <= 1200);
  assert.equal(result.value.evidence.length, 8);
  assert.equal(result.value.open_questions.length, 6);
  assert.ok(result.warnings.some((warning) => /summary truncated/.test(warning)));
  assert.ok(result.warnings.some((warning) => /evidence truncated/.test(warning)));
  assert.ok(result.value.warnings.length >= 2);
});

test('oversized data is truncated instead of rejecting the envelope', () => {
  const result = validateEnvelope({
    ...valid,
    data: { payload: 'y'.repeat(5000) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.data.truncated, true);
  assert.match(result.value.data.note, /data exceeded 4000 chars/);
  assert.ok(result.warnings.some((warning) => /data exceeded 4000/.test(warning)));
});

test('parseEnvelope prefers last_assistant_message from a hook payload', () => {
  const result = parseEnvelope({
    hook_event_name: 'SubagentStop',
    agent_type: 'Explore',
    last_assistant_message: `worker says:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.summary, 'Done.');
});

test('compactEnvelope stays within the budget', () => {
  const big = {
    ...valid,
    summary: 'x'.repeat(5000),
    data: { payload: 'y'.repeat(4000) },
    evidence: Array.from({ length: 8 }, (_, i) => ({
      handle: `abc123def45${i}`,
      note: 'n'.repeat(300),
    })),
  };
  const text = compactEnvelope(big, 2000);
  assert.ok(text.length <= 2000, `length ${text.length}`);
  const parsed = JSON.parse(text);
  assert.equal(parsed.status, 'ok');
  assert.ok(parsed.warnings.some((warning) => /compactEnvelope trimmed/.test(warning)));
});

test('invalidResultEnvelope is a valid failure envelope', () => {
  const invalid = invalidResultEnvelope('no JSON found', 'raw output');
  const result = validateEnvelope(invalid);
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'failed');
  assert.match(result.value.summary, /INVALID_WORKER_RESULT/);
});
