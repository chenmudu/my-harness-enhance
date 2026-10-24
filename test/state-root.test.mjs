import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, projectKey } from '../src/core/state-root.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-canon-'));
}

test('canonicalPath is idempotent for existing and missing paths', () => {
  const dir = tmp();
  const missing = path.join(dir, 'a', 'b');
  assert.equal(canonicalPath(canonicalPath(dir)), canonicalPath(dir));
  assert.equal(canonicalPath(canonicalPath(missing)), canonicalPath(missing));
});

test('canonicalPath keeps a missing child under the resolved parent', () => {
  const base = tmp();
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  const link = path.join(base, 'link');
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) return;
    throw error;
  }
  const child = path.join(link, 'not-created', 'task-1');
  assert.equal(canonicalPath(child), path.join(canonicalPath(link), 'not-created', 'task-1'));
  assert.equal(projectKey(child), projectKey(path.join(target, 'not-created', 'task-1')));
});
