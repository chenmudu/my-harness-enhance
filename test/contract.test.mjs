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

test('handshake fields survive normalization and compaction', () => {
  const result = validateEnvelope({
    ...valid,
    brief_hash: 'a'.repeat(16),
    task_hash: 'b'.repeat(16),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.brief_hash, 'a'.repeat(16));
  assert.equal(result.value.task_hash, 'b'.repeat(16));
  const compact = JSON.parse(compactEnvelope(result.value, 6000));
  assert.equal(compact.brief_hash, 'a'.repeat(16));
  assert.equal(compact.task_hash, 'b'.repeat(16));
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

test('parseEnvelope ignores schema template echoes', () => {
  const schema = {
    status: 'ok | partial | blocked | failed | needs_split',
    summary: '<=1200 chars, factual, no transcript',
  };
  const literal = `Answer:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nSchema:\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``;
  assert.equal(parseEnvelope(literal).value.summary, valid.summary);
  const filled = `Answer:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nTemplate:\n\`\`\`json\n${JSON.stringify({ ...schema, status: 'ok' })}\n\`\`\``;
  assert.equal(parseEnvelope(filled).value.summary, valid.summary);
});

test('compactEnvelope uses the remaining budget instead of discarding fields', () => {
  const big = {
    ...valid,
    summary: 's'.repeat(3000),
    evidence: Array.from({ length: 8 }, (_, i) => ({
      handle: `artifact:evidence-${i}`,
      note: 'n'.repeat(300),
    })),
    artifacts: Array.from({ length: 8 }, (_, i) => ({
      handle: `artifact:a-${i}`,
      kind: 'file',
      summary: 'y'.repeat(300),
    })),
    open_questions: Array.from({ length: 6 }, (_, i) => 'q'.repeat(300)),
    next: 'n'.repeat(500),
    data: { big: 'd'.repeat(4000) },
  };
  const text = compactEnvelope(big, 6000);
  const parsed = JSON.parse(text);
  assert.ok(text.length <= 6000, `length ${text.length}`);
  assert.ok(parsed.evidence.length > 0, `evidence ${parsed.evidence.length}`);
});

test('clip never leaves a lone surrogate', () => {
  const summary = 'a'.repeat(1179) + '🔥' + 'b'.repeat(20);
  const result = validateEnvelope({ status: 'ok', summary });
  assert.equal(result.ok, true);
  const units = [...result.value.summary].map((char) => char.codePointAt(0));
  assert.equal(units.filter((code) => code >= 0xd800 && code <= 0xdfff).length, 0);
});

test('decision-ready fields are optional, clipped, and survive compaction', () => {
  const without = validateEnvelope(valid);
  assert.equal(without.value.decision, '');
  assert.equal(without.value.blocking, '');

  const withFields = validateEnvelope({
    ...valid,
    decision: 'Accept the migration as-is',
    impact: 'Unblocks the schema task',
    blocking: 'Needs a yes/no on dropping the legacy column',
    what_changed: ['src/a.js', 'test/a.test.mjs'],
  });
  assert.equal(withFields.ok, true);
  assert.equal(withFields.value.decision, 'Accept the migration as-is');
  assert.equal(withFields.value.impact, 'Unblocks the schema task');
  assert.match(withFields.value.blocking, /^Needs a yes\/no/);
  assert.equal(withFields.value.what_changed, '["src/a.js","test/a.test.mjs"]');

  const compact = JSON.parse(compactEnvelope(withFields.value));
  assert.equal(compact.decision, 'Accept the migration as-is');
  assert.equal(compact.blocking, 'Needs a yes/no on dropping the legacy column');
  assert.equal(compact.what_changed, '["src/a.js","test/a.test.mjs"]');

  const long = validateEnvelope({ ...valid, decision: 'd'.repeat(500) });
  assert.ok(long.value.decision.length <= 240);
});
