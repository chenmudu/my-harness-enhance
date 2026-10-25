/**
 * Frontier and scheduler.
 *
 * The frontier is what can be worked on right now; the scheduler ranks it so the
 * conductor does not have to re-derive "what next" every turn. Nothing here
 * reads or writes state: it is a pure view over a plan.
 */

const OPEN = new Set(['pending', 'in_progress']);
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEBT_GATE = 5;

function isStaleTask(task, now, staleMs) {
  if (!OPEN.has(String(task.status))) return false;
  const asOf = Date.parse(task.as_of);
  return Number.isFinite(asOf) && now - asOf > staleMs;
}

export function computeFrontier(plan, {
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  const ready = [];
  const blocked = [];
  let stale = 0;
  for (const task of tasks) {
    if (!OPEN.has(String(task.status))) continue;
    const isStale = isStaleTask(task, now, staleMs);
    if (isStale) stale += 1;
    const missing = (task.depends_on || []).filter((id) => !completed.has(id));
    if (missing.length > 0) {
      blocked.push({ id: task.id, by: missing });
      continue;
    }
    const declared = (task.blockers || []).filter(Boolean);
    if (declared.length > 0) {
      blocked.push({ id: task.id, by: declared });
      continue;
    }
    ready.push({ ...task, stale: isStale });
  }
  return {
    ready,
    blocked,
    debt: blocked.length + stale,
    open: ready.length + blocked.length,
    total: tasks.length,
  };
}

function dependentCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const id of task.depends_on || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function rankOf(task, dependents) {
  return [
    task.status === 'in_progress' ? 0 : 1,
    task.stale ? 0 : 1,
    Number(task.priority) || 3,
    -(dependents.get(task.id) || 0),
  ];
}

function compareRank(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function reasonFor(task, dependents) {
  if (task.status === 'in_progress') return task.stale ? 'in progress but stale: confirm or drop it' : 'already in progress';
  const unblocks = dependents.get(task.id) || 0;
  if (unblocks > 0) return `unblocks ${unblocks} task${unblocks === 1 ? '' : 's'}`;
  if (task.stale) return 'stale: re-check before spending a turn';
  return `priority ${Number(task.priority) || 3}`;
}

/**
 * Rank the frontier. A stale or blocked backlog past the gate returns
 * `gate: 'drain'` with no candidates: clear open loops before opening new work.
 */
export function scheduleNext(plan, {
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  limit = 3,
  debtGate = DEFAULT_DEBT_GATE,
} = {}) {
  const frontier = computeFrontier(plan, { now, staleMs });
  const dependents = dependentCounts(Array.isArray(plan?.tasks) ? plan.tasks : []);
  if (frontier.debt >= debtGate) {
    return {
      gate: 'drain',
      debt: frontier.debt,
      reason: `${frontier.debt} open loops (blocked or stale): clear them before starting new work`,
      candidates: [],
      blocked: frontier.blocked.slice(0, 10),
    };
  }
  const candidates = [...frontier.ready]
    .sort((a, b) => compareRank(rankOf(a, dependents), rankOf(b, dependents)))
    .slice(0, limit)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: Number(task.priority) || 3,
      stale: Boolean(task.stale),
      next_action: task.next_action || '',
      reason: reasonFor(task, dependents),
    }));
  return {
    gate: 'open',
    debt: frontier.debt,
    reason: candidates.length ? '' : 'no ready task',
    candidates,
    blocked: frontier.blocked.slice(0, 10),
  };
}