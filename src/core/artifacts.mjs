import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, loadConfig, readJson } from './config.mjs';
import { storePaths, withLock } from './store.mjs';

const HANDLE_RE = /^[a-f0-9]{16}$/;
const MAX_STORED_BYTES = 5 * 1024 * 1024;

function asText(content) {
  if (typeof content === 'string') return content;
  if (Buffer.isBuffer(content)) return content.toString('utf8');
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function isHandle(value) {
  return typeof value === 'string' && HANDLE_RE.test(value);
}

export function handleFor(content) {
  return crypto.createHash('sha256').update(asText(content)).digest('hex').slice(0, 16);
}

export function readArtifactIndex(root) {
  return readJson(storePaths(root).artifactIndex, { version: 1, artifacts: {} });
}

function writeArtifactIndex(root, index) {
  atomicWrite(
    storePaths(root).artifactIndex,
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

export function putArtifact(root, {
  content,
  kind = 'text',
  source = '',
  summary = '',
  maxStoredBytes = MAX_STORED_BYTES,
} = {}) {
  const text = asText(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  const handle = handleFor(text);
  const paths = storePaths(root);
  fs.mkdirSync(paths.artifacts, { recursive: true });

  return withLock(root, () => {
    const file = path.join(paths.artifacts, `${handle}.txt`);
    const truncated = bytes > maxStoredBytes;
    if (!fs.existsSync(file)) {
      const stored = truncated
        ? `${text.slice(0, maxStoredBytes)}\n\n[artifact truncated at ${maxStoredBytes} bytes; original ${bytes} bytes]`
        : text;
      atomicWrite(file, stored);
    }
    const index = readArtifactIndex(root);
    if (!index.artifacts[handle]) {
      index.artifacts[handle] = {
        handle,
        kind: String(kind || 'text').slice(0, 40),
        source: String(source || '').slice(0, 300),
        summary: String(summary || '').slice(0, 300),
        bytes,
        stored_bytes: Math.min(bytes, maxStoredBytes),
        truncated,
        created_at: new Date().toISOString(),
      };
      writeArtifactIndex(root, index);
    }
    return { ...index.artifacts[handle], file };
  });
}

export function getArtifact(root, handle, { maxChars = 4000, offset = 0 } = {}) {
  if (!isHandle(handle)) throw new Error(`invalid artifact handle: ${handle}`);
  const paths = storePaths(root);
  const file = path.join(paths.artifacts, `${handle}.txt`);
  if (!fs.existsSync(file)) throw new Error(`artifact not found: ${handle}`);
  const text = fs.readFileSync(file, 'utf8');
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(1, Number(maxChars) || 4000);
  return {
    handle,
    content: text.slice(start, end),
    offset: start,
    total_chars: text.length,
    truncated: end < text.length,
  };
}

export function listArtifacts(root, limit = 20) {
  const index = readArtifactIndex(root);
  return Object.values(index.artifacts)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

function queryTerms(query) {
  const text = String(query || '').toLowerCase();
  const terms = new Set();
  for (const word of text.split(/[^a-z0-9\u3400-\u9fff]+/g)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 2) terms.add(word);
    } else {
      if (word.length === 1) terms.add(word);
      for (let size = 2; size <= Math.min(4, word.length); size += 1) {
        for (let i = 0; i + size <= word.length; i += 1) {
          terms.add(word.slice(i, i + size));
        }
      }
    }
  }
  return [...terms].slice(0, 24);
}

function snippetAround(text, term, radius = 280) {
  const index = text.toLowerCase().indexOf(term);
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + term.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchArtifacts(root, query, {
  limit = 5,
  maxChars = 800,
  perArtifactChars = 1200,
} = {}) {
  const index = readArtifactIndex(root);
  const entries = Object.values(index.artifacts);
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return entries
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((entry) => ({
        handle: entry.handle,
        summary: entry.summary,
        kind: entry.kind,
        score: 0,
        snippet: entry.summary,
      }));
  }

  const scored = [];
  for (const entry of entries) {
    const file = path.join(storePaths(root).artifacts, `${entry.handle}.txt`);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 200_000);
    } catch {
      continue;
    }
    const haystack = `${entry.summary}\n${entry.source}\n${text}`.toLowerCase();
    let score = 0;
    let firstTerm = '';
    for (const term of terms) {
      const occurrences = haystack.split(term).length - 1;
      if (occurrences > 0) {
        score += Math.min(occurrences, 20);
        if (!firstTerm) firstTerm = term;
      }
    }
    if (score > 0) {
      scored.push({
        handle: entry.handle,
        summary: entry.summary,
        kind: entry.kind,
        score,
        snippet: firstTerm ? snippetAround(text, firstTerm) : entry.summary,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, limit);
  let budget = Math.max(200, maxChars);
  return selected.map((item) => {
    const content = item.snippet.slice(0, Math.min(perArtifactChars, budget));
    budget -= content.length;
    return { ...item, snippet: content };
  }).filter((item) => budget > 0 || item === selected[0]);
}

export function formatArtifactReference(entry) {
  return `artifact ${entry.handle} (${entry.kind}, ${entry.bytes} bytes): ${entry.summary}`;
}
