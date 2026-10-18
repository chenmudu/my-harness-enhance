import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultChecks, resolveInside, sha256File } from './brief.mjs';
import { validateWorktree } from './worktree.mjs';

function finding(level, rule, message, extra = {}) {
  return { level, rule, message, ...extra };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(text, term) {
  if (!term) return 0;
  return (String(text).match(new RegExp(escapeRegex(term), 'giu')) || []).length;
}

function parseDoc(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const prose = [];
  const fences = [];
  let current = null;
  for (const line of lines) {
    const start = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (current) {
      const close = line.match(/^(\s*)(`{3,}|~{3,})/);
      if (close && close[2][0] === current.marker[0] && close[2].length >= current.marker.length) {
        fences.push({ marker: current.marker, lines: current.lines });
        current = null;
      } else {
        current.lines.push(line);
      }
      continue;
    }
    if (start) {
      current = { marker: start[2], lines: [] };
      continue;
    }
    prose.push(line);
  }
  if (current) fences.push({ marker: current.marker, lines: current.lines, unclosed: true });
  const proseText = prose.join('\n');
  return {
    lines: lines.length,
    proseText,
    breaks: text.includes('\r\n') ? 'CRLF' : 'LF',
    fences,
    headings: prose
      .map((line) => line.match(/^(#{1,6})\s+/))
      .filter(Boolean)
      .map((match) => match[1].length),
    tables: prose
      .filter((line) => line.includes('|'))
      .map((line) => line.split('|').length),
    inlineCodes: [...proseText.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]).sort(),
    numbers: [...proseText.matchAll(/\b\d+(?:[.,:]\d+)*\b/g)].map((match) => match[0]).sort(),
    links: [...proseText.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
  };
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isCommentLine(line) {
  return /^\s*(?:#|\/\/|--|;|<!--|\/\*|\*)\s?/.test(String(line));
}

function stripInlineComment(line) {
  const text = String(line);
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    const atBoundary = i === 0 || /\s/.test(text[i - 1]);
    if (atBoundary && ch === '#') return text.slice(0, i).trimEnd();
    if (atBoundary && ch === '/' && text[i + 1] === '/') return text.slice(0, i).trimEnd();
  }
  return text;
}

function fenceCode(lines) {
  return lines
    .filter((line) => !isCommentLine(line))
    .map((line) => stripInlineComment(line));
}

function docsChecker(root, brief) {
  const findings = [];
  const pairs = Array.isArray(brief.pairs) ? brief.pairs : [];
  if (pairs.length === 0) {
    return { findings: [finding('blocker', 'docs.pairs', 'brief has no source/target pairs')] };
  }
  for (const pair of pairs) {
    const sourceFile = resolveInside(root, pair.source);
    const targetFile = resolveInside(root, pair.target);
    if (!sourceFile || !targetFile) {
      findings.push(finding('blocker', 'docs.path', `pair escapes the workspace: ${pair.source} -> ${pair.target}`));
      continue;
    }
    const source = readText(sourceFile);
    const target = readText(targetFile);
    if (source == null) {
      findings.push(finding('blocker', 'docs.source', `source missing: ${pair.source}`));
      continue;
    }
    if (target == null) {
      findings.push(finding('blocker', 'docs.target', `target missing: ${pair.target}`));
      continue;
    }
    const a = parseDoc(source);
    const b = parseDoc(target);
    const label = `${pair.source} -> ${pair.target}`;
    if (!sameArray(a.headings, b.headings)) {
      findings.push(finding('blocker', 'docs.headings', `heading levels differ: ${label}`, {
        expected: a.headings,
        actual: b.headings,
      }));
    }
    if (a.fences.length !== b.fences.length) {
      findings.push(finding('blocker', 'docs.fences', `fenced block count differs: ${label}`, {
        expected: a.fences.length,
        actual: b.fences.length,
      }));
    } else {
      for (let i = 0; i < a.fences.length; i += 1) {
        const leftRaw = a.fences[i].lines.join('\n');
        const rightRaw = b.fences[i].lines.join('\n');
        if (leftRaw === rightRaw) continue;
        const leftCode = fenceCode(a.fences[i].lines).join('\n');
        const rightCode = fenceCode(b.fences[i].lines).join('\n');
        if (leftCode !== rightCode) {
          findings.push(finding('blocker', 'docs.fence-code', `fenced code differs: ${label}`));
          break;
        }
        // Bilingual docs often translate comments inside examples while keeping
        // executable code identical. That is a warning, not a blocker.
        findings.push(finding('warning', 'docs.fence-comments', `fenced comments differ: ${label}`));
      }
    }
    if (a.fences.some((fence) => fence.unclosed) || b.fences.some((fence) => fence.unclosed)) {
      findings.push(finding('blocker', 'docs.fence-unclosed', `unclosed fenced block: ${label}`));
    }
    if (!sameArray(a.tables, b.tables)) {
      findings.push(finding('blocker', 'docs.tables', `table row/column shape differs: ${label}`, {
        expected: a.tables,
        actual: b.tables,
      }));
    }
    if (!sameArray(a.inlineCodes, b.inlineCodes)) {
      findings.push(finding('blocker', 'docs.inline-code', `inline code multiset differs: ${label}`));
    }
    if (!sameArray(a.numbers, b.numbers)) {
      findings.push(finding('blocker', 'docs.numbers', `numeric multiset differs: ${label}`));
    }
    if (a.breaks !== b.breaks) {
      findings.push(finding('warning', 'docs.line-endings', `line endings differ: ${label}`, {
        expected: a.breaks,
        actual: b.breaks,
      }));
    }
    const targetLinks = new Set(b.links);
    for (const link of targetLinks) {
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
      const clean = link.split('#')[0];
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(targetFile), clean);
      if (!fs.existsSync(resolved)) {
        findings.push(finding('blocker', 'docs.link', `unresolved link in ${pair.target}: ${link}`));
      }
    }
  }

  for (const entry of brief.glossary || []) {
    const sourceTerm = String(entry.source || '');
    const targetTerm = String(entry.target || entry.source || '');
    if (!sourceTerm) continue;
    for (const pair of pairs) {
      const sourceFile = resolveInside(root, pair.source);
      const targetFile = resolveInside(root, pair.target);
      if (!sourceFile || !targetFile) continue;
      const source = readText(sourceFile);
      const target = readText(targetFile);
      if (source == null || target == null) continue;
      const sourceProse = parseDoc(source).proseText;
      const targetProse = parseDoc(target).proseText;
      if (countOccurrences(sourceProse, sourceTerm) > 0 && countOccurrences(targetProse, targetTerm) === 0) {
        findings.push(finding('blocker', 'docs.glossary', `glossary term missing in ${pair.target}: ${sourceTerm} -> ${targetTerm}`));
      }
    }
  }
  return { findings };
}

function inputsChecker(root, brief) {
  const findings = [];
  const inputs = Array.isArray(brief.inputs) ? brief.inputs : [];
  if (inputs.length === 0) {
    return { findings: [finding('warning', 'inputs.empty', 'brief has no input hashes; stale-input protection is off')] };
  }
  for (const item of inputs) {
    const file = resolveInside(root, item.path);
    if (!file) {
      findings.push(finding('blocker', 'inputs.path', `input escapes the workspace: ${item.path}`));
      continue;
    }
    const actual = sha256File(file);
    if (!actual) {
      findings.push(finding('blocker', 'inputs.missing', `input missing: ${item.path}`));
    } else if (item.sha256 && actual !== item.sha256) {
      findings.push(finding('blocker', 'inputs.changed', `input changed since brief: ${item.path}`, {
        expected: item.sha256,
        actual,
      }));
    }
  }
  return { findings };
}

function globToRegExp(glob) {
  const value = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '*') {
      if (value[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  if (!value.includes('/')) out = `(?:.*/)?${out}`;
  return new RegExp(`^${out}$`);
}

function scopeChecker(root, brief, options = {}) {
  const ownership = Array.isArray(brief.ownership) ? brief.ownership : [];
  if (ownership.length === 0) {
    return {
      findings: [finding(
        brief.profile === 'code' ? 'blocker' : 'warning',
        'scope.ownership',
        'brief has no ownership globs; changed files cannot be bounded',
      )],
    };
  }
  // When a validated worktree is provided, ownership paths are relative to
  // that worktree; otherwise the check runs in the project root unchanged.
  const target = options.worktree || root;
  const result = spawnSync('git', ['-C', target, 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.error || result.status !== 0) {
    return {
      findings: [finding(
        brief.profile === 'code' ? 'blocker' : 'warning',
        'scope.git',
        options.worktree ? `scope check requires a git worktree at ${target}` : 'scope check requires a git worktree',
        { actual: String(result.stderr || result.error?.message || '').slice(0, 300) },
      )],
    };
  }
  const patterns = ownership.map(globToRegExp);
  const findings = [];
  for (const line of String(result.stdout || '').split('\n').filter(Boolean)) {
    const raw = line.slice(3).trim();
    const changed = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
    const rel = changed.replace(/\\/g, '/').replace(/^"|"$/g, '');
    if (!rel || rel === '.git' || rel.startsWith('.git/')) continue;
    if (!patterns.some((pattern) => pattern.test(rel))) {
      findings.push(finding('blocker', 'scope.outside', `changed file outside ownership: ${rel}`));
    }
  }
  return { findings };
}

const DISCOVERABLE_COMMANDS = new Set(['test', 'lint', 'typecheck', 'build']);

/**
 * Fallback when a verification command is not registered: if the project has
 * an npm script with the checker's name, run it. Registered commands still
 * win, and only these four well-known ids are ever discovered.
 */
function hasNodeTestFiles(root) {
  const skip = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage',
    '.next', '.cache', '.turbo', 'out', 'target',
  ]);
  const testFile = /(^test[-_.].*|\.(test|spec)\.[cm]?[jt]sx?)$/i;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < 4 && !skip.has(entry.name)) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && testFile.test(entry.name)) return true;
    }
  }
  return false;
}

function discoverCommand(runRoot, id) {
  if (!DISCOVERABLE_COMMANDS.has(id)) return '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runRoot, 'package.json'), 'utf8'));
    const script = pkg?.scripts?.[id];
    if (typeof script === 'string' && script.trim()) {
      return id === 'test' ? 'npm test' : `npm run ${id}`;
    }
  } catch {
    // no package.json or unreadable: fall through to the built-in runner
  }
  // A package without scripts is common in small ESM repos. When Node test
  // files exist, `node --test` is the deterministic equivalent of `npm test`
  // and avoids forcing a package.json edit just to satisfy the harness.
  if (id === 'test' && hasNodeTestFiles(runRoot)) return ['node', '--test'];
  return '';
}

function commandChecker(root, id, config, options = {}) {
  const runRoot = options.worktree || root;
  const commands = config?.verification?.commands || {};
  let command = commands[id];
  let discovered = '';
  if (!command) {
    discovered = discoverCommand(runRoot, id);
    if (!discovered) {
      return {
        findings: [finding(
          'blocker',
          'command.unknown',
          `checker command is not registered and no npm script or Node test files were found for "${id}"`,
        )],
      };
    }
    command = discovered;
  }
  const timeout = Number(command?.timeoutMs) || 120000;
  const run = Array.isArray(command)
    ? { file: command[0], args: command.slice(1) }
    : { file: String(command), args: [] };
  // NODE_TEST_CONTEXT is set by an outer `node --test`. If the harness itself
  // runs under a test (unit tests, CI), a spawned `node --test` would see it
  // and silently skip every file; strip it so the project's tests really run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(run.file, run.args, {
    cwd: runRoot,
    shell: !Array.isArray(command),
    encoding: 'utf8',
    timeout,
    env,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.error || result.status !== 0) {
    return {
      findings: [finding('blocker', 'command.failed', `checker failed: ${id}`, {
        expected: 'exit 0',
        actual: `exit ${result.status ?? 'error'}${output ? `: ${output.slice(0, 1200)}` : ''}`,
      })],
    };
  }
  return {
    findings: output
      ? [finding('info', 'command.output', `${id}: ${output.slice(0, 1200)}`)]
      : [],
  };
}

function checkerFor(id) {
  if (id === 'docs') return docsChecker;
  if (id === 'inputs') return inputsChecker;
  if (id === 'scope') return scopeChecker;
  if (id.startsWith('command:')) return commandChecker;
  return null;
}

const BUILTIN_CHECKERS = new Set(['inputs', 'docs', 'scope']);
const AUTO_COMMAND_CHECKERS = new Set(['test', 'lint', 'typecheck', 'build']);

function allowedCheckerIds(config) {
  const configured = Object.keys(config?.verification?.commands || {})
    .map((id) => `command:${id}`);
  return new Set([
    ...BUILTIN_CHECKERS,
    ...[...AUTO_COMMAND_CHECKERS].map((id) => `command:${id}`),
    ...configured,
  ]);
}

function allowedCheckerText(config) {
  return [...allowedCheckerIds(config)].join(', ');
}

/**
 * Reject invented checker names and shell strings at brief-creation time.
 * The conductor must use the built-ins, a registered command:id, or one of
 * the four auto-discovered package scripts; arbitrary command text is not a
 * checker.
 */
export function validateBriefChecks(checks, config, profile = 'general') {
  const ids = (Array.isArray(checks) ? checks : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const configured = new Set(
    Object.keys(config?.verification?.commands || {}).map((id) => `command:${id}`),
  );
  const allowed = allowedCheckerIds(config);
  const invalid = ids.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `unknown checker(s): ${invalid.join(', ')}. ` +
      'Allowed: inputs, docs, scope, command:test/lint/typecheck/build, ' +
      `or a registered command (${[...configured].join(', ') || 'none'}). ` +
      'Pass checker ids, not shell commands; use docs for document parity and command:test for tests.',
    );
  }
  if (profile === 'code' && !ids.includes('command:test')) {
    throw new Error(
      'code profile requires command:test so the test suite actually runs; a scope/lint/build check cannot replace it, and shell strings are not checkers.',
    );
  }
  return ids;
}

export function runBriefChecks(root, brief, config, checkerIds = null, options = {}) {
  const started = Date.now();
  if (!brief) {
    return {
      version: 1,
      ok: false,
      checked: [],
      findings: [finding('blocker', 'brief.missing', 'no brief exists; call enhance_brief first')],
      summary: { blockers: 1, warnings: 0, infos: 0 },
      elapsed_ms: 0,
    };
  }
  // A worktree argument is validated here once; every worktree-sensitive
  // checker (scope, command:*) then runs against the verified path. An
  // invalid path is a hard blocker: checks must never silently fall back
  // to the main checkout and green-light unreviewed work.
  let worktree = '';
  if (options.worktree) {
    const located = validateWorktree(root, options.worktree);
    if (!located.ok) {
      return {
        version: 1,
        ok: false,
        checked: [],
        findings: [finding('blocker', 'worktree.invalid', String(located.blocker || 'invalid worktree path'))],
        summary: { blockers: 1, warnings: 0, infos: 0 },
        elapsed_ms: Date.now() - started,
        at: new Date().toISOString(),
      };
    }
    worktree = located.path;
  }
  const ids = (Array.isArray(checkerIds) && checkerIds.length
    ? checkerIds
    : (brief.checks?.length ? brief.checks : defaultChecks(brief.profile, brief.pairs || [])))
    .map((id) => String(id));
  const findings = [];
  const checked = [];
  const checkerOptions = { worktree };
  for (const id of ids) {
    const fn = checkerFor(id);
    if (!fn) {
      findings.push(finding(
        'blocker',
        'checker.unknown',
        `unknown checker: ${id}. Allowed checker ids: ${allowedCheckerText(config)}. Use docs for documents and command:test for tests; do not rename checkers.`,
      ));
      continue;
    }
    checked.push(id);
    const result = id.startsWith('command:')
      ? fn(root, id.slice('command:'.length), config, checkerOptions)
      : fn(root, brief, checkerOptions);
    findings.push(...(result.findings || []));
  }
  const blockers = findings.filter((item) => item.level === 'blocker').length;
  const warnings = findings.filter((item) => item.level === 'warning').length;
  const infos = findings.filter((item) => item.level === 'info').length;
  return {
    version: 1,
    ok: blockers === 0,
    checked,
    findings: findings.slice(0, 50),
    summary: { blockers, warnings, infos },
    elapsed_ms: Date.now() - started,
    at: new Date().toISOString(),
  };
}
