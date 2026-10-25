import fs from 'node:fs';
import path from 'node:path';

/**
 * Behavior labels derived from the CLI session transcript.
 *
 * Coverage note: the transcript records the main session's tool calls. Worker
 * tool calls are not in it, so these labels describe what the conductor (or the
 * baseline agent) did, not what the workers did.
 */

const FILE_RE = /[A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|json|md|patch|txt)/g;

export function transcriptPath(configDir, workspace, sessionId) {
  const key = String(workspace || '').replace(/[^A-Za-z0-9]/g, '-');
  return path.join(configDir, 'projects', key, `${sessionId}.jsonl`);
}

export function readTranscript(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalize(target) {
  return String(target || '').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsIn(value, found = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(FILE_RE)) {
      found.push(normalize(match[0]));
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => pathsIn(item, found));
    return found;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => pathsIn(item, found));
    return found;
  }
  return found;
}

function matches(target, expected) {
  const value = normalize(target);
  return expected.some((candidate) => {
    const want = normalize(candidate);
    return value === want || value.endsWith(`/${want}`);
  });
}

/** Paths a turn is expected to work on, mirrored from the prompt script. */
export function expectedPaths(fixtureKind, turn, total) {
  if (fixtureKind === 'review') {
    const name = String(turn).padStart(2, '0');
    return [`patches/${name}.patch`, `answers/${name}.txt`, 'RULES.md'];
  }
  if (turn === 1) return ['README.md', 'TASKS.md', 'src/lib.mjs', 'test/lib.test.mjs'];
  if (turn === total) return ['README.md', 'src/lib.mjs', 'src/index.mjs'];
  if (turn === total - 1) return ['src/index.mjs', 'test/lib.test.mjs'];
  return ['src/lib.mjs', 'test/lib.test.mjs'];
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function actionsOf(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && block.type === 'tool_use' && !String(block.name).startsWith('mcp__'))
    .map((block) => ({
      name: block.name,
      read: READ_TOOLS.has(block.name),
      write: WRITE_TOOLS.has(block.name),
      paths: pathsIn(block.input || {}),
    }));
}

/** The scripted prompt carries its own turn number; fall back to position. */
export function turnNumberOf(text) {
  const source = String(text || '');
  const step = source.match(/Step\s+(\d+)\s*\//i);
  if (step) return Number(step[1]);
  const patch = source.match(/patches[\\/](\d+)\.patch/i);
  if (patch) return Number(patch[1]);
  return null;
}

/**
 * Split the transcript at human prompts and label each turn:
 * - `hit`: the first action names a path the turn is expected to touch;
 * - `offTask`: actions naming paths outside the expected set;
 * - `reRead`: a (tool, path) pair repeated later in the session;
 * - `recovered`: a turn whose previous turn ended with an error still starts on
 *   an expected path.
 */
export function summarizeBehavior(entries, { fixtureKind = 'library', turns = 15 } = {}) {
  const events = Array.isArray(entries) ? entries : [];
  const turnStarts = [];
  events.forEach((entry, index) => {
    if (entry.type === 'user' && entry.origin && entry.origin.kind === 'human') {
      turnStarts.push(index);
    }
  });

  const seen = new Map();
  const rows = [];
  let carrier = { error: false };
  for (let offset = 0; offset < turnStarts.length; offset += 1) {
    const from = turnStarts[offset];
    const to = turnStarts[offset + 1] ?? events.length;
    const declared = turnNumberOf(events[from].message?.content);
    if (!declared) continue;
    const turn = declared;
    const expected = expectedPaths(fixtureKind, turn, turns);
    const actions = [];
    let failed = false;
    for (let index = from; index < to; index += 1) {
      const entry = events[index];
      actions.push(...actionsOf(entry));
      if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block && block.type === 'tool_result' && block.is_error === true) failed = true;
        }
      }
      if (entry.type === 'result' && entry.is_error === true) failed = true;
    }

    const first = actions[0] || null;
    const hit = Boolean(first && first.paths.some((item) => matches(item, expected)));
    const wrongTask = actions.filter(
      (action) => action.write
        && action.paths.length > 0
        && !action.paths.some((item) => matches(item, expected)),
    ).length;

    let reRead = 0;
    for (const action of actions) {
      if (!action.read) continue;
      for (const target of new Set(action.paths)) {
        const key = `read|${target}`;
        if (seen.has(key)) reRead += 1;
        else seen.set(key, turn);
      }
    }

    rows.push({
      turn,
      firstAction: first ? first.name : '',
      hit,
      wrongTask,
      reRead,
      failed,
      recovered: carrier.error ? hit : null,
    });
    carrier = { error: failed };
  }

  const totals = rows.reduce((acc, row) => ({
    turns: acc.turns + 1,
    next_action_hit: acc.next_action_hit + (row.hit ? 1 : 0),
    wrong_task_actions: acc.wrong_task_actions + row.wrongTask,
    re_reads: acc.re_reads + row.reRead,
    failed_turns: acc.failed_turns + (row.failed ? 1 : 0),
    recoveries: acc.recoveries + (row.recovered ? 1 : 0),
  }), {
    turns: 0,
    next_action_hit: 0,
    wrong_task_actions: 0,
    re_reads: 0,
    failed_turns: 0,
    recoveries: 0,
  });

  return { coverage: 'main session only', totals, turns: rows };
}