import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '../core/metrics.mjs';

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

/**
 * Subagent transcripts sit beside the main session file. The CLI bills each
 * worker request separately, so a cost reading that only sums the main file
 * undercounts the treatment arm by everything the workers spent.
 */
export function workerTranscriptPaths(configDir, workspace, sessionId) {
  const key = String(workspace || '').replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(configDir, 'projects', key, String(sessionId || ''), 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  return names.map((name) => path.join(dir, name));
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

/**
 * The oracle for one turn: the script table plus every path the prompt itself
 * names. The prompt wins when it is more specific; the table keeps the label
 * meaningful when the prompt only implies a file.
 */
export function expectedPathsFor(text, fixtureKind, turn, total) {
  const scripted = expectedPaths(fixtureKind, turn, total);
  const promptText = typeof text === 'string' ? text : textOf(text);
  const named = pathsIn(promptText);
  const extra = fixtureKind === 'review' ? [`answers/${String(turn).padStart(2, '0')}.txt`] : [];
  return [...new Set([...scripted, ...named, ...extra])];
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

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join(' ');
  }
  return '';
}

/** The scripted prompt carries its own turn number; fall back to position. */
export function turnNumberOf(text) {
  const source = typeof text === 'string' ? text : textOf(text);
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
    const expected = expectedPathsFor(events[from].message?.content, fixtureKind, turn, turns);
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
const WORKER_TOOLS = new Set(['Agent', 'Task']);

function blockText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(blockText).join(' ');
  try {
    return JSON.stringify(block.content ?? block);
  } catch {
    return '';
  }
}

/**
 * Where the tokens actually went, measured on the transcript rather than on the
 * CLI's ratio: assistant output, ordinary tool results, and worker results are
 * the three terms the conductor pays for. `context_usage_ratio` cannot answer
 * this because its denominator is per session.
 */
export function summarizeComposition(entries) {
  const events = Array.isArray(entries) ? entries : [];
  const toolNames = new Map();
  const out = {
    assistant: 0,
    assistant_text: 0,
    assistant_thinking: 0,
    assistant_tool_use: 0,
    tool_results: 0,
    worker_results: 0,
    attachments: 0,
    by_tool: {},
  };
  for (const entry of events) {
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (!block) continue;
        if (block.type === 'tool_use') {
          toolNames.set(block.id, String(block.name || ''));
          const tokens = estimateTokens(JSON.stringify(block.input ?? {}));
          out.assistant_tool_use += tokens;
          out.assistant += tokens;
        } else if (block.type === 'thinking') {
          const tokens = estimateTokens(blockText(block));
          out.assistant_thinking += tokens;
          out.assistant += tokens;
        } else {
          const tokens = estimateTokens(blockText(block));
          out.assistant_text += tokens;
          out.assistant += tokens;
        }
      }
      continue;
    }
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type !== 'tool_result') continue;
        const name = toolNames.get(block.tool_use_id) || 'unknown';
        const tokens = estimateTokens(blockText(block));
        out.by_tool[name] = (out.by_tool[name] || 0) + tokens;
        if (WORKER_TOOLS.has(name)) out.worker_results += tokens;
        else out.tool_results += tokens;
      }
      continue;
    }
    if (entry.type === 'attachment') {
      out.attachments += estimateTokens(JSON.stringify(entry));
    }
  }
  out.total = out.assistant + out.tool_results + out.worker_results + out.attachments;
  return out;
}

function creditsOf(events) {
  const rows = Array.isArray(events) ? events : [];
  let credits = 0;
  let requests = 0;
  let model = '';
  const provider = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reported: 0 };
  for (const entry of rows) {
    const usage = entry.usage || entry.message?.usage;
    if (!usage) continue;
    requests += 1;
    const value = Number(usage.credits);
    if (Number.isFinite(value) && value > 0) credits += value;
    if (!model && entry.message?.model) model = entry.message.model;
    for (const [field, key] of [
      ['input_tokens', 'input'],
      ['output_tokens', 'output'],
      ['cache_creation_input_tokens', 'cacheCreation'],
      ['cache_read_input_tokens', 'cacheRead'],
    ]) {
      const count = Number(usage[field]);
      if (Number.isFinite(count) && count > 0) {
        provider[key] += count;
        provider.reported += 1;
      }
    }
  }
  return { credits, requests, model, provider };
}

/**
 * Billed cost as the CLI reports it. `entries` is the main session; pass
 * `workerEntries` (the flattened subagent transcripts) to get the total the
 * account was actually charged. `credits` keeps its old meaning (conductor
 * only) so stored runs stay readable; use `total` for any comparison.
 */
export function summarizeCost(entries, { workerEntries = [] } = {}) {
  const conductor = creditsOf(entries);
  const worker = creditsOf(workerEntries);
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    credits: round(conductor.credits),
    requests: conductor.requests,
    model: conductor.model || worker.model,
    conductor: { credits: round(conductor.credits), requests: conductor.requests },
    worker: { credits: round(worker.credits), requests: worker.requests },
    total: {
      credits: round(conductor.credits + worker.credits),
      requests: conductor.requests + worker.requests,
    },
    // The CLI zeroes these fields today; `available: false` means the split is
    // unknown, not that the model spent nothing on input or output.
    provider: {
      available: conductor.provider.reported > 0 || worker.provider.reported > 0,
      input: conductor.provider.input + worker.provider.input,
      output: conductor.provider.output + worker.provider.output,
      cacheCreation: conductor.provider.cacheCreation + worker.provider.cacheCreation,
      cacheRead: conductor.provider.cacheRead + worker.provider.cacheRead,
    },
  };
}
