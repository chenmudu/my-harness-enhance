import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getArtifact,
  handleFor,
  putArtifact,
  searchArtifacts,
} from '../src/core/artifacts.mjs';
import { initStore } from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-artifacts-home-'),
);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-artifacts-project-'));
}

test('artifacts are content-addressed and deduplicated', () => {
  const root = tmpRoot();
  initStore(root);
  const first = putArtifact(root, {
    content: 'hello world',
    kind: 'log',
    source: 'test',
    summary: 'greeting',
  });
  const second = putArtifact(root, {
    content: 'hello world',
    kind: 'log',
    source: 'test-2',
    summary: 'duplicate',
  });
  assert.equal(first.handle, second.handle);
  assert.equal(first.handle, handleFor('hello world'));
  const read = getArtifact(root, first.handle);
  assert.equal(read.content, 'hello world');
});

test('artifact read is bounded', () => {
  const root = tmpRoot();
  initStore(root);
  const artifact = putArtifact(root, { content: 'abcdefghij', summary: 'letters' });
  const read = getArtifact(root, artifact.handle, { maxChars: 4, offset: 2 });
  assert.equal(read.content, 'cdef');
  assert.equal(read.truncated, true);
});

test('invalid handle is rejected', () => {
  const root = tmpRoot();
  initStore(root);
  assert.throws(() => getArtifact(root, '../etc/passwd'), /invalid artifact handle/);
});

test('search finds English keywords', () => {
  const root = tmpRoot();
  initStore(root);
  putArtifact(root, {
    content: 'the auth middleware validates JWT tokens in src/auth.ts',
    kind: 'findings',
    summary: 'auth middleware',
  });
  putArtifact(root, {
    content: 'the billing worker retries failed invoices',
    kind: 'findings',
    summary: 'billing retry',
  });
  const results = searchArtifacts(root, 'JWT auth', { limit: 3 });
  assert.ok(results.length >= 1);
  assert.match(JSON.stringify(results[0]), /auth|JWT/i);
});

test('search finds Chinese keywords', () => {
  const root = tmpRoot();
  initStore(root);
  putArtifact(root, {
    content: '登录接口在 src/login.ts，使用 bcrypt 校验密码',
    kind: 'findings',
    summary: '登录实现',
  });
  const results = searchArtifacts(root, '登录 bcrypt', { limit: 3 });
  assert.ok(results.length >= 1);
  assert.match(JSON.stringify(results[0]), /登录|bcrypt/);
});

test('large artifact is truncated for storage but deduped by full content', () => {
  const root = tmpRoot();
  initStore(root);
  const content = 'x'.repeat(2000);
  const artifact = putArtifact(root, {
    content,
    summary: 'large',
    maxStoredBytes: 500,
  });
  assert.equal(artifact.truncated, true);
  assert.equal(artifact.bytes, 2000);
  const read = getArtifact(root, artifact.handle, { maxChars: 10000 });
  assert.ok(read.total_chars < 2000);
  assert.match(read.content, /artifact truncated/);
});
