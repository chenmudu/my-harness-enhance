import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExcludedProject } from '../src/core/global.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-global-home-'),
);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-global-exclude-'));

// Child segments stay nonexistent on purpose, so canonicalPath falls back to path.resolve
// and keeps the exact casing and separators the case under test feeds in.
test('exclude matching ignores windows path case differences', () => {
  const entry = path.join(base, 'Case-Alpha');
  const target = path.join(base, 'case-alPHA');
  assert.equal(isExcludedProject(target, { exclude: [entry] }), true);
});

test('exclude matching normalizes an existing directory through canonical path', () => {
  assert.equal(isExcludedProject(base.toUpperCase(), { exclude: [base] }), true);
});

test('trailing separator in exclude entry still matches nested children', () => {
  const entry = `${path.join(base, 'ent-mhe')}${path.sep}`;
  const target = path.join(base, 'ent-mhe', 'nested');
  assert.equal(isExcludedProject(target, { exclude: [entry] }), true);
});

test('trailing separator in exclude entry matches the entry itself', () => {
  const entry = `${path.join(base, 'ent-mhe')}${path.sep}`;
  assert.equal(isExcludedProject(path.join(base, 'ent-mhe'), { exclude: [entry] }), true);
});

test('home directory is excluded even with a trailing separator', () => {
  assert.equal(isExcludedProject(`${os.homedir()}${path.sep}`, {}), true);
});

test('exclude entry does not match a sibling directory sharing its prefix', () => {
  const entry = path.join(base, 'project');
  const target = path.join(base, 'project-mhe-backup');
  assert.equal(isExcludedProject(target, { exclude: [entry] }), false);
});

test('exclude entry matches deeply nested child directories', () => {
  const entry = path.join(base, 'proj');
  const target = path.join(base, 'proj', 'a', 'leaf');
  assert.equal(isExcludedProject(target, { exclude: [entry] }), true);
});

test('empty exclude entries are skipped without excluding the target', () => {
  const global = { exclude: ['', null, undefined, 0, false] };
  // Keep the target under the temp base, not under process.cwd(): a repo
  // checked out under Program Files would otherwise be excluded by platform
  // defaults and flip this negative assertion.
  const target = path.join(base, 'plain', 'leaf-9d17');
  assert.equal(isExcludedProject(target, global), false);
});

test('missing exclude field leaves the target unexcluded', () => {
  assert.equal(isExcludedProject(path.join(base, 'plain'), {}), false);
});

test('exclude list matches when a later entry covers the target', () => {
  const global = { exclude: [path.join(base, 'nope'), path.join(base, 'yes'), ''] };
  const target = path.join(base, 'yes', 'leaf');
  assert.equal(isExcludedProject(target, global), true);
});
