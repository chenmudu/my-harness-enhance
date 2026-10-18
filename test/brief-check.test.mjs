import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildBrief, briefForInjection } from '../src/core/brief.mjs';
import { runBriefChecks, validateBriefChecks } from '../src/core/checks.mjs';
import { loadConfig } from '../src/core/config.mjs';
import { initStore, writeGoal } from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-brief-home-'),
);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-brief-project-'));
  initStore(root);
  writeGoal(root, { text: 'Translate docs', acceptance: ['checks pass'] });
  return root;
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function docsFixture(root) {
  write(root, 'docs/example.md', '# Title\n\nUse `code` and 42.\n\n```js\nconst x = 1;\n```\n');
  write(root, 'docs/example.zh-CN.md', '# 标题\n\n使用 `code` 和 42。\n\n```js\nconst x = 1;\n```\n');
}

test('brief checker ids are whitelisted and code requires a command check', () => {
  const root = makeRoot();
  const config = loadConfig(root).config;
  assert.deepEqual(
    validateBriefChecks(['inputs', 'docs', 'scope'], config, 'docs'),
    ['inputs', 'docs', 'scope'],
  );
  assert.throws(
    () => validateBriefChecks(['docs_parity', 'input_hash'], config, 'docs'),
    /unknown checker/,
  );
  assert.throws(
    () => validateBriefChecks(['scope'], config, 'code'),
    /requires command:test/,
  );
  assert.throws(
    () => validateBriefChecks(['scope', 'command:lint'], config, 'code'),
    /requires command:test/,
  );
  assert.deepEqual(
    validateBriefChecks(['scope', 'command:test'], config, 'code'),
    ['scope', 'command:test'],
  );
});

test('docs brief discovers pairs, hashes inputs, and injects context', () => {
  const root = makeRoot();
  docsFixture(root);
  const brief = buildBrief(root, { profile: 'docs' });
  assert.equal(brief.profile, 'docs');
  assert.deepEqual(brief.pairs, [{ source: 'docs/example.md', target: 'docs/example.zh-CN.md' }]);
  assert.equal(brief.inputs.length, 1);
  assert.match(brief.inputs[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(brief.checks, ['inputs', 'docs']);
  const injection = briefForInjection(brief);
  assert.match(injection, /profile=docs/);
  assert.match(injection, /docs\/example\.md/);
});

test('docs brief rejects a notes target that is not in pairs', () => {
  const root = makeRoot();
  docsFixture(root);
  assert.throws(
    () => buildBrief(root, {
      profile: 'docs',
      pairs: [{ source: 'docs/example.md', target: 'docs/example.zh-CN.md' }],
      notes: 'Write the result to docs/example.md.zh-CN.md.',
    }),
    /not a pair target/,
  );
  const brief = buildBrief(root, {
    profile: 'docs',
    pairs: [{ source: 'docs/example.md', target: 'docs/example.zh-CN.md' }],
    notes: 'Write the result to docs/example.zh-CN.md; do not touch the source.',
  });
  assert.equal(brief.pairs[0].target, 'docs/example.zh-CN.md');
});

test('docs checker passes parity and blocks structural drift', () => {
  const root = makeRoot();
  docsFixture(root);
  const brief = buildBrief(root, { profile: 'docs' });
  const config = loadConfig(root).config;
  const good = runBriefChecks(root, brief, config);
  assert.equal(good.ok, true, JSON.stringify(good.findings));

  write(root, 'docs/example.zh-CN.md', '# 标题\n\n使用 `code` 和 42。\n\n```js\nconst y = 1;\n```\n');
  const bad = runBriefChecks(root, brief, config);
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((item) => item.rule === 'docs.fence-code'));
});

test('docs checker allows comment-only differences inside fences', () => {
  const root = makeRoot();
  write(root, 'docs/example.md', '# Title\n\nText.\n\n```bash\n# English comment\nnpm test # run tests\n```\n');
  write(root, 'docs/example.zh-CN.md', '# 标题\n\n文本。\n\n```bash\n# 中文注释\nnpm test # 运行测试\n```\n');
  const brief = buildBrief(root, { profile: 'docs' });
  const result = runBriefChecks(root, brief, loadConfig(root).config, ['docs']);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.ok(result.findings.some((item) => item.rule === 'docs.fence-comments'));
});

test('inputs checker blocks source changes made after the brief', () => {
  const root = makeRoot();
  docsFixture(root);
  const brief = buildBrief(root, { profile: 'docs' });
  const config = loadConfig(root).config;
  write(root, 'docs/example.md', '# Changed\n\nUse `code` and 42.\n');
  const result = runBriefChecks(root, brief, config, ['inputs']);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.rule === 'inputs.changed'));
});

test('glossary check blocks a missing target term', () => {
  const root = makeRoot();
  write(root, 'docs/example.md', '# Title\n\nUse tool.\n');
  write(root, 'docs/example.zh-CN.md', '# 标题\n\n使用 x。\n');
  const brief = buildBrief(root, {
    profile: 'docs',
    glossary: [{ source: 'tool', target: '工具', mode: 'translate' }],
  });
  const result = runBriefChecks(root, brief, loadConfig(root).config, ['docs']);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.rule === 'docs.glossary'));
});

test('code scope check requires git and rejects files outside ownership', () => {
  const root = makeRoot();
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  write(root, 'src/allowed.js', 'export const ok = true;\n');
  write(root, 'outside.txt', 'not owned\n');
  const brief = buildBrief(root, {
    profile: 'code',
    ownership: ['src/**'],
  });
  const result = runBriefChecks(root, brief, loadConfig(root).config, ['scope']);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.rule === 'scope.outside' && /outside\.txt/.test(item.message)));
});

test('registered command checkers run and report failures', () => {
  const root = makeRoot();
  const config = loadConfig(root).config;
  config.verification.commands = {
    ok: [process.execPath, '--version'],
    bad: [process.execPath, '-e', 'process.exit(2)'],
  };
  const brief = buildBrief(root, {
    profile: 'code',
    checks: ['command:ok', 'command:bad'],
  });
  const result = runBriefChecks(root, brief, config);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.rule === 'command.failed'));
});
