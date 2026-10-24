import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const LINE_COUNT_EXCEPTIONS = new Set(['INSTALL.md', 'docs/roadmap.md']);

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function lineCount(text) {
  return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
}

function headings(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.match(/^#+/)[0].length);
}

function fences(text) {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function tableShape(text) {
  let inFence = false;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^\|.*\|$/.test(line)) {
      rows.push((line.match(/\|/g) || []).length);
    }
  }
  return rows;
}

function relativeLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split('#')[0])
    .filter(Boolean);
}

function pairFor(english) {
  return english.replace(/\.md$/, '.zh-CN.md');
}

function englishPages() {
  const pages = ['README.md', 'INSTALL.md'];
  for (const name of fs.readdirSync(path.join(root, 'docs'))) {
    if (name.endsWith('.md') && !name.endsWith('.zh-CN.md')) {
      pages.push(`docs/${name}`);
    }
  }
  return pages.sort();
}

const pairs = englishPages().map((english) => ({ english, chinese: pairFor(english) }));

test('every repository page except overlays has a Chinese twin', () => {
  for (const { english, chinese } of pairs) {
    assert.ok(fs.existsSync(path.join(root, chinese)), `${english} is missing ${chinese}`);
  }
  assert.ok(pairs.some(({ english }) => english === 'docs/qoder-adapter.md'));
  assert.ok(!pairs.some(({ english }) => english.startsWith('docs/others/')));
});

test('line 3 links each twin back to its original', () => {
  for (const { english, chinese } of pairs) {
    const original = path.basename(english);
    const twin = path.basename(chinese);
    const englishLines = read(english).split(/\r?\n/);
    const chineseLines = read(chinese).split(/\r?\n/);
    assert.match(englishLines[2], new RegExp(`\\(${twin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), `${english}:3`);
    assert.match(chineseLines[2], new RegExp(`\\(${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), `${chinese}:3`);
  }
});

test('heading levels match in every pair', () => {
  for (const { english, chinese } of pairs) {
    assert.deepEqual(headings(read(english)), headings(read(chinese)), `${english} vs ${chinese}`);
  }
});

test('fenced blocks are byte-identical in every pair', () => {
  for (const { english, chinese } of pairs) {
    const original = fences(read(english));
    const translated = fences(read(chinese));
    assert.equal(translated.length, original.length, `${english}: fence count`);
    original.forEach((block, index) => {
      assert.equal(translated[index], block, `${english}: fence ${index + 1}`);
    });
  }
});

test('table row and column counts match in every pair', () => {
  for (const { english, chinese } of pairs) {
    assert.deepEqual(tableShape(read(english)), tableShape(read(chinese)), `${english} vs ${chinese}`);
  }
});

test('every relative link resolves', () => {
  const files = [
    'overlays/README.md',
    ...pairs.flatMap(({ english, chinese }) => [english, chinese]),
  ];
  for (const file of files) {
    for (const target of relativeLinks(read(file))) {
      const resolved = path.resolve(path.dirname(path.join(root, file)), target);
      assert.ok(fs.existsSync(resolved), `${file} -> ${target}`);
    }
  }
});

test('paired pages have the same line count except documented exceptions', () => {
  for (const { english, chinese } of pairs) {
    if (LINE_COUNT_EXCEPTIONS.has(english)) continue;
    assert.equal(lineCount(read(english)), lineCount(read(chinese)), `${english} vs ${chinese}`);
  }
});
