import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROFILES = ['general', 'docs', 'code', 'research', 'ops'];

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const file = path.resolve(base, String(rel || ''));
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return file;
}

function displayPath(root, file) {
  return path.relative(path.resolve(root), file).split(path.sep).join('/');
}

function normalizePairs(root, pairs) {
  const out = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const source = resolveInside(root, pair?.source);
    const target = resolveInside(root, pair?.target);
    if (!source || !target) continue;
    out.push({
      source: displayPath(root, source),
      target: displayPath(root, target),
    });
  }
  return out;
}

function discoverPairs(root) {
  const pairs = [];
  const roots = [
    path.join(root, 'docs'),
    root,
  ];
  for (const dir of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zh-CN.md')) continue;
      const target = path.join(dir, entry.name);
      const source = path.join(dir, entry.name.replace(/\.zh-CN\.md$/, '.md'));
      if (fs.existsSync(source)) {
        pairs.push({
          source: displayPath(root, source),
          target: displayPath(root, target),
        });
      }
    }
  }
  return pairs;
}

function normalizeInputs(root, inputs, pairs) {
  const paths = new Set();
  for (const item of Array.isArray(inputs) ? inputs : []) {
    const file = resolveInside(root, item);
    if (file) paths.add(displayPath(root, file));
  }
  for (const pair of pairs) paths.add(pair.source);
  return [...paths].map((rel) => {
    const file = resolveInside(root, rel);
    return {
      path: rel,
      sha256: file ? sha256File(file) : '',
    };
  });
}

function normalizeGlossary(glossary) {
  const entries = Array.isArray(glossary)
    ? glossary
    : Object.entries(glossary || {}).map(([source, target]) => ({ source, target }));
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return { source: entry, target: entry, mode: 'keep' };
      const source = String(entry?.source || entry?.term || '').trim();
      const target = String(entry?.target || entry?.translation || '').trim();
      const mode = String(entry?.mode || (target && target !== source ? 'translate' : 'keep'));
      return {
        source,
        target: target || source,
        mode: mode === 'keep' ? 'keep' : 'translate',
      };
    })
    .filter((entry) => entry.source);
}

function defaultChecks(profile, pairs) {
  if (profile === 'docs') return ['inputs', 'docs'];
  // Code inputs are usually the files being edited, so a post-land input hash
  // would fail by design. Scope plus the test command are the delivery gate;
  // add inputs explicitly only for read-only reference files.
  if (profile === 'code') return ['scope', 'command:test'];
  return ['inputs'];
}

export { defaultChecks };

/**
 * A wrong target path in free-text notes is a known conductor failure: the
 * worker then has to reconcile notes against pairs. Reject a .zh-CN.md path
 * in notes that is not an actual pair target before any worker sees it.
 */
export function validateBriefNotes(brief) {
  const targets = new Set((brief?.pairs || []).map((pair) => pair.target));
  if (targets.size === 0) return;
  const notes = String(brief?.notes || '');
  const found = notes.match(/(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]*\.zh-CN\.md\b/gi) || [];
  for (const raw of found) {
    const normalized = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (normalized.startsWith('//')) continue; // URL, not a workspace path
    if (targets.has(normalized)) continue;
    throw new Error(
      `brief notes mention ${normalized}, which is not a pair target. `
      + `Targets: ${[...targets].join(', ')}. Fix notes or pairs; never point a worker at an unlisted target.`,
    );
  }
}

export function buildBrief(root, input = {}, current = null) {
  const patch = input && typeof input === 'object' ? input : {};
  const base = patch.replace === false && current ? current : {};
  const profile = PROFILES.includes(String(patch.profile || base.profile || 'general'))
    ? String(patch.profile || base.profile || 'general')
    : 'general';
  const pairs = normalizePairs(root, patch.pairs ?? base.pairs ?? (profile === 'docs' ? discoverPairs(root) : []));
  const inputs = normalizeInputs(root, patch.inputs ?? base.inputs ?? [], pairs);
  const glossary = normalizeGlossary(patch.glossary ?? base.glossary ?? []);
  const ownership = [...new Set(
    (Array.isArray(patch.ownership ?? base.ownership) ? (patch.ownership ?? base.ownership) : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )];
  const checks = (Array.isArray(patch.checks ?? base.checks)
    ? (patch.checks ?? base.checks)
    : defaultChecks(profile, pairs))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const brief = {
    version: 1,
    profile,
    pairs,
    inputs,
    glossary,
    ownership,
    checks,
    notes: String(patch.notes ?? base.notes ?? '').slice(0, 2000),
    updated_at: new Date().toISOString(),
  };
  validateBriefNotes(brief);
  return brief;
}

export function briefForInjection(brief, maxChars = 1400) {
  if (!brief) return '';
  const lines = [
    `[BRIEF profile=${brief.profile || 'general'}]`,
    brief.checks?.length ? `CHECKS: ${brief.checks.join(', ')}` : '',
    brief.pairs?.length
      ? `PAIRS:\n${brief.pairs.map((pair) => `- ${pair.source} -> ${pair.target}`).join('\n')}`
      : '',
    brief.inputs?.length
      ? `INPUTS:\n${brief.inputs.map((item) => `- ${item.path} sha256=${item.sha256 || 'missing'}`).join('\n')}`
      : '',
    brief.glossary?.length
      ? `GLOSSARY:\n${brief.glossary.map((item) => `- ${item.source} => ${item.target} (${item.mode})`).join('\n')}`
      : '',
    brief.ownership?.length ? `OWNERSHIP: ${brief.ownership.join(', ')}` : '',
    brief.notes ? `NOTES: ${brief.notes}` : '',
  ].filter(Boolean).join('\n');
  if (lines.length <= maxChars) return lines;
  return `${lines.slice(0, Math.max(0, maxChars - 20))}\n…[brief truncated]`;
}

export function briefSummary(brief) {
  if (!brief) return '';
  const parts = [
    `profile=${brief.profile || 'general'}`,
    `checks=${(brief.checks || []).join(',') || '(none)'}`,
    `pairs=${(brief.pairs || []).length}`,
    `inputs=${(brief.inputs || []).length}`,
    `ownership=${(brief.ownership || []).length}`,
  ];
  return parts.join(' ');
}

export function briefForCapsule(brief, maxChars = 700) {
  if (!brief) return '';
  const text = [
    `profile=${brief.profile || 'general'}`,
    `checks=${(brief.checks || []).join(',') || '(none)'}`,
    brief.pairs?.length ? `pairs=${brief.pairs.length}` : '',
    brief.glossary?.length ? `glossary=${brief.glossary.length}` : '',
    brief.ownership?.length ? `ownership=${brief.ownership.join(',')}` : '',
    brief.notes || '',
  ].filter(Boolean).join(' | ');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 20)}…[truncated]`;
}
