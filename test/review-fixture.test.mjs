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
  MODULE_SLOTS,
  PATCH_SIZES,
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
  const wrong = planted[1].rule === 'off-by-one' ? 'wrong-comparison' : 'off-by-one';
  fs.writeFileSync(path.join(dir, 'answers', '02.txt'), `${wrong.toUpperCase()}\n`);
  result = checkReviewAnswers(dir, planted);
  assert.equal(result.passed, 1);
  assert.equal(result.findings[0].index, planted[1].index);

  fs.writeFileSync(path.join(dir, 'answers', '02.txt'), planted[1].rule);
  result = checkReviewAnswers(dir, planted);
  assert.equal(result.ok, true);
  assert.equal(result.passed, 2);
});
test('the defect slot is seeded, in range, and not always first', () => {
  const slots = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const entry of reviewPlan(15, seed, 60)) {
      assert.ok(Number.isInteger(entry.defectSlot), `seed ${seed}`);
      assert.ok(entry.defectSlot >= 0 && entry.defectSlot < 60, `seed ${seed}: ${entry.defectSlot}`);
      slots.add(entry.defectSlot);
    }
  }
  assert.ok(slots.size > 20, `only ${slots.size} distinct slots`);
  assert.ok(slots.has(0));
  assert.ok([...slots].some((slot) => slot >= 45), 'no defect in the last quarter');
});

test('every replica is suffixed, so position and name do not identify the defect', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const [entry] = reviewPlan(1, seed, 60);
    const { name } = entry.template.make(entry.seed, null);
    const module = renderModule(entry, 60);
    for (const family of ['sum', 'aboveThreshold', 'largest', 'firstPlus', 'double', 'share']) {
      assert.doesNotMatch(module, new RegExp(`export function ${family}\\(`), `${family} without suffix, seed ${seed}`);
    }
    assert.match(module, new RegExp(`export function ${name}${entry.defectSlot}\\(`));
  }
});

test('rule order is seeded and reproducible', () => {
  const rules = (seed) => reviewPlan(15, seed, 60).map((entry) => entry.template.defect);
  assert.deepEqual(rules(11), rules(11));
  assert.notDeepEqual(rules(11), rules(12));
  assert.equal(new Set(rules(11)).size, REVIEW_RULES.length);
});

test('the fixture reports the defect slot it actually rendered', () => {
  const dir = tempDir('mhe-review-slot-');
  const planted = buildReviewFixture(dir, { count: 1, seed: 21, slots: 60 });
  const [entry] = reviewPlan(1, 21, 60);
  const { name } = entry.template.make(entry.seed, null);
  assert.equal(planted[0].defect_slot, entry.defectSlot);
  const patch = fs.readFileSync(path.join(dir, 'patches', '01.patch'), 'utf8');
  assert.match(patch, new RegExp(`\\+export function ${name}${entry.defectSlot}\\(`));
  assert.doesNotMatch(patch, new RegExp(`\\+export function ${name}\\(`));
});

test('the three patch sizes are about 500, 2,000 and 8,000 lines', () => {
  for (const [name, target] of [['small', 500], ['medium', 2000], ['large', 8000]]) {
    const [entry] = reviewPlan(1, 7, PATCH_SIZES[name]);
    const lines = renderPatch(entry, PATCH_SIZES[name]).split('\n').length;
    assert.ok(Math.abs(lines - target) < target * 0.1, `${name}: ${lines} lines`);
  }
  assert.equal(PATCH_SIZES.small, MODULE_SLOTS);
});
