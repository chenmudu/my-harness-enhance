import fs from 'node:fs';
import { atomicWrite, loadConfig } from './config.mjs';
import { scheduleNext } from './attention.mjs';
import { estimateTokens } from './metrics.mjs';
import { fitToTokens } from './text.mjs';
import {
  readBrief,
  readGoal,
  readJobs,
  readLastCheck,
  readPlan,
  storePaths,
} from './store.mjs';

/**
 * The packet is the view the conductor sees: the working set for the decision
 * in front of it, not a restatement of the ledger. The capsule stays on disk as
 * the full ledger; this is what gets injected.
 */

const CAPS = { decide: 3, blockers: 5, changed: 5, must: 6, trust: 3, parked: 5 };
const DEFAULT_BUDGET = 600;

const ORDER = ['ROLE', 'SESSION', 'NOW', 'GOAL', 'BLOCKERS', 'DECIDE', 'CHANGED', 'MUST', 'TRUST', 'PARKED', 'MORE'];
const ALWAYS = new Set(['ROLE', 'SESSION', 'NOW', 'GOAL']);

function oneLine(value, limit = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function previousState(root, session) {
  try {
    return JSON.parse(fs.readFileSync(storePaths(root, session).packet, 'utf8'));
  } catch {
    return null;
  }
}

function snapshot(plan, lastCheck) {
  const statuses = {};
  for (const task of plan.tasks || []) statuses[task.id] = String(task.status);
  return {
    statuses,
    check: lastCheck
      ? `${lastCheck.ok === false ? 'FAIL' : 'ok'}:${(lastCheck.checked || []).join(',')}`
      : '',
  };
}

function changedLines(previous, current, plan) {
  if (!previous) return [];
  const titles = new Map((plan.tasks || []).map((task) => [task.id, task.title]));
  const lines = [];
  for (const [id, status] of Object.entries(current.statuses)) {
    const before = previous.statuses?.[id];
    if (before === undefined) lines.push(`+ ${id} ${oneLine(titles.get(id) || '', 80)}`.trim());
    else if (before !== status) lines.push(`${id}: ${before} -> ${status}`);
  }
  for (const id of Object.keys(previous.statuses || {})) {
    if (!(id in current.statuses)) lines.push(`- ${id} removed`);
  }
  if (previous.check !== current.check) lines.push(`check: ${current.check || 'none'}`);
  return lines;
}

function scheduleLine(schedule) {
  const top = schedule.candidates[0] || null;
  if (top) {
    return `[${top.status}] ${top.id} ${oneLine(top.title, 100)}`
      + `${top.next_action ? ` — next: ${oneLine(top.next_action, 120)}` : ''} (${top.reason})`;
  }
  return schedule.gate === 'drain'
    ? `drain first: ${schedule.reason}`
    : 'no ready task: plan one, or clear a blocker';
}

function rememberNow(root, session, line) {
  try {
    atomicWrite(
      storePaths(root, session).now,
      `${JSON.stringify({ at: new Date().toISOString(), line })}\n`,
    );
  } catch {
    // Remembering the reminder must never break the packet.
  }
}

function previousNow(root, session) {
  try {
    return String(JSON.parse(fs.readFileSync(storePaths(root, session).now, 'utf8')).line || '');
  } catch {
    return '';
  }
}

/**
 * A one-line frontier reminder for the moment after a tool result, when the
 * conductor is deciding again but no user prompt has fired. It stays silent
 * unless the frontier actually moved since the last packet or reminder, so the
 * repeated line never becomes noise.
 */
export function nowReminder(root, { session = '' } = {}) {
  const plan = readPlan(root, session);
  if (!(plan.tasks || []).length) return null;
  const line = scheduleLine(scheduleNext(plan));
  if (line === previousNow(root, session)) return null;
  rememberNow(root, session, line);
  return `[NOW] ${line}`;
}

export function buildPacket(root, { session = '', maxTokens = null } = {}) {
  const { config } = loadConfig(root);
  const budget = maxTokens ?? config.context.maxPacketTokens ?? DEFAULT_BUDGET;
  const goal = readGoal(root, session);
  const brief = readBrief(root, session);
  const plan = readPlan(root, session);
  const lastCheck = readLastCheck(root, session);
  const jobs = readJobs(root, session).jobs || [];
  const schedule = scheduleNext(plan);
  const current = snapshot(plan, lastCheck);
  const previous = previousState(root, session);
  const changed = changedLines(previous, current, plan);

  const top = schedule.candidates[0] || null;
  const nowLine = scheduleLine(schedule);

  const decide = schedule.candidates.slice(1, 1 + CAPS.decide)
    .map((task) => `- ${task.id} ${oneLine(task.title, 100)} (${task.reason})`);

  const blockers = schedule.blocked
    .slice(0, CAPS.blockers)
    .map((item) => `- ${item.id}: ${oneLine((item.by || []).join('; '), 140)}`);

  const must = [
    ...(goal.acceptance || []).slice(0, 3).map((item) => `- done when: ${oneLine(item, 140)}`),
    ...(goal.constraints || []).slice(0, CAPS.must).map((item) => `- ${oneLine(item, 140)}`),
    ...(Array.isArray(brief?.checks) && brief.checks.length
      ? [`- checks: ${brief.checks.join(', ')}`]
      : []),
  ];

  const trust = [];
  if (lastCheck) {
    trust.push(
      `- ${lastCheck.ok === false ? 'FAIL' : 'ok'} ${(lastCheck.checked || []).join(',') || 'no checker'}`
      + `${lastCheck.worktree ? ' (worktree)' : ' (base)'}`
      + ` by ${lastCheck.source || 'harness'}`,
    );
  }
  trust.push('- worker summaries are claims until a check or a land passes');

  const shown = new Set([top?.id, ...schedule.candidates.slice(1, 1 + CAPS.decide).map((task) => task.id)].filter(Boolean));
  const blockedIds = new Set(schedule.blocked.map((item) => item.id));
  const parked = (plan.tasks || [])
    .filter((task) => ['pending', 'in_progress'].includes(String(task.status)))
    .filter((task) => !shown.has(task.id) && !blockedIds.has(task.id))
    .slice(0, CAPS.parked)
    .map((task) => task.id);

  const sections = {
    ROLE: [`conductor | project: ${root}${session ? ` | session: ${session}` : ''}`],
    SESSION: session
      ? [`${session} (tools that accept a session must be passed this value; it identifies this session's state shard)`]
      : [],
    NOW: [nowLine],
    GOAL: goal.text ? [`- ${oneLine(goal.text, 300)}`] : [],
    BLOCKERS: blockers,
    DECIDE: decide,
    CHANGED: changed.slice(0, CAPS.changed).map((item) => `- ${item}`),
    MUST: must,
    TRUST: trust.slice(0, CAPS.trust),
    PARKED: parked.length
      ? [`- ${parked.join(', ')}${plan.tasks.length > shown.size + blockedIds.size + parked.length ? ' (and more)' : ''}`]
      : [],
    MORE: [`- ${plan.tasks.length} tasks, ${jobs.length} jobs: enhance_plan / enhance_state for the rest`],
  };

  const render = (name) => (
    sections[name]?.length ? `## ${name}\n${sections[name].join('\n')}\n\n` : ''
  );

  let text = '';
  for (const name of ORDER) {
    if (ALWAYS.has(name)) {
      text += render(name);
      continue;
    }
    const candidate = `${text}${render(name)}`;
    if (estimateTokens(candidate) <= budget) text += render(name);
  }
  const finalText = fitToTokens(`[MY-HARNESS-ENHANCE PACKET v1]\n\n${text}`, budget, estimateTokens);
  const parts = ORDER
    .map((name) => ({
      name,
      tokens: sections[name]?.length
        ? estimateTokens(`## ${name}\n${sections[name].join('\n')}\n\n`)
        : 0,
    }))
    .filter((part) => part.tokens > 0);
  const parkedTokens = parts
    .filter((part) => part.name === 'PARKED' || part.name === 'MORE')
    .reduce((total, part) => total + part.tokens, 0);
  const totalTokens = parts.reduce((total, part) => total + part.tokens, 0);
  atomicWrite(
    storePaths(root, session).packet,
    `${JSON.stringify({ at: new Date().toISOString(), ...current }, null, 2)}\n`,
  );
  if ((plan.tasks || []).length) rememberNow(root, session, nowLine);
  return {
    text: finalText,
    tokens: estimateTokens(finalText),
    changed: changed.slice(0, CAPS.changed),
    gate: schedule.gate,
    debt: schedule.debt,
    sections: parts,
    relevantTokens: Math.max(0, totalTokens - parkedTokens),
    parkedTokens,
    packetTokens: totalTokens,
  };
}