import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REVIEW_RULES,
  buildReviewFixture,
  checkReviewAnswers,
  renderModule,
  renderPatch,
  reviewPlan,
  reviewPrompts,
} from '../src/bench/review-fixture.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('every patch carries exactly one planted rule from the vocabulary', () => {
  const planted = reviewPlan(15, 7);
  assert.equal(planted.length, 15);
  const ids = new Set(REVIEW_RULES.map((rule) => rule.id));
  for (const entry of planted) {
    assert.ok(ids.has(entry.template.defect), entry.template.defect);
  }
  assert.equal(new Set(planted.map((entry) => entry.template.defect)).size, REVIEW_RULES.length);
});

test('a patch is a new-file diff of the generated module', () => {
  const [entry] = reviewPlan(1, 7);
  const module = renderModule(entry);
  const patch = renderPatch(entry);
  assert.match(patch, /^diff --git a\/src\/mod01\.mjs b\/src\/mod01\.mjs/);
  assert.match(patch, /^\+\+\+ b\/src\/mod01\.mjs$/m);
  assert.match(patch, /^--- \/dev\/null$/m);
  const added = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  assert.deepEqual(added.map((line) => line.slice(1)), module.split('\n').slice(0, -1));
});

test('the planted defect is visible in the rendered module', () => {
  const planted = reviewPlan(15, 7);
  const offByOne = planted.find((entry) => entry.template.defect === 'off-by-one');
  if (offByOne) {
    assert.match(renderModule(offByOne), /i <= values\.length/);
  }
  const mutated = planted.find((entry) => entry.template.defect === 'mutated-input');
  if (mutated) {
    assert.match(renderModule(mutated), /return values\.sort\(/);
  }
});

test('the fixture writes patches, rules and prompts that line up', () => {
  const dir = tempDir('mhe-review-');
  const planted = buildReviewFixture(dir, { count: 3 });
  assert.equal(planted.length, 3);
  for (const entry of planted) {
    const name = String(entry.index).padStart(2, '0');
    assert.ok(fs.existsSync(path.join(dir, 'patches', `${name}.patch`)));
  }
  assert.match(fs.readFileSync(path.join(dir, 'RULES.md'), 'utf8'), /off-by-one/);
  const prompts = reviewPrompts(3);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /patches\/01\.patch/);
});

test('the check reads the first token of each answer file', () => {
  const dir = tempDir('mhe-review-check-');
  const planted = buildReviewFixture(dir, { count: 2 });
  let result = checkReviewAnswers(dir, planted);
  assert.equal(result.ok, false);
  assert.equal(result.failed, 2);

  fs.writeFileSync(path.join(dir, 'answers', '01.txt'), `${planted[0].rule}\nextra notes\n`);
  fs.writeFileSync(path.join(dir, 'answers', '02.txt'), 'OFF-BY-ONE\n');
  result = checkReviewAnswers(dir, planted);
  assert.equal(result.passed, 1);
  assert.equal(result.findings[0].index, planted[1].index);

  fs.writeFileSync(path.join(dir, 'answers', '02.txt'), planted[1].rule);
  result = checkReviewAnswers(dir, planted);
  assert.equal(result.ok, true);
  assert.equal(result.passed, 2);
});