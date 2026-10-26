import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  atomicWrite,
  ensureState,
  loadConfig,
  readJson,
  stateDirFor,
} from './config.mjs';

// Host session ids are UUIDs, so the normalized key stays readable while
// refusing separators that could escape the sessions directory.
const SESSION_KEY_RE = /[^a-z0-9-]/g;

export function sessionKey(raw) {
  const value = String(raw ?? '')
    .toLowerCase()
    .replace(SESSION_KEY_RE, '')
    .slice(0, 64);
  return value || 'default';
}

export const SESSION_STATE_FILES = [
  'goal.json',
  'brief.json',
  'plan.json',
  'capsule.md',
  'jobs.json',
  'last-check.json',
  'session.json',
  'journal.md',
  'worktrees.json',
];

/**
 * Backward compatible: without a session every working-state path is the
 * project-level file that existing installs already use. With a session the
 * working state lives under projects/<projectKey>/sessions/<sid>/ while the
 * shared state (config, artifacts, metrics, decisions, sessions.json, logs,
 * lock) stays project-level.
 */
export function storePaths(root, session = '') {
  const dir = stateDirFor(root);
  const shared = {
    dir,
    sessionDir: '',
    sessionId: '',
    config: path.join(dir, 'config.json'),
    capabilities: path.join(dir, 'capabilities.json'),
    decisions: path.join(dir, 'decisions.jsonl'),
    sessions: path.join(dir, 'sessions.json'),
    artifacts: path.join(dir, 'artifacts'),
    artifactIndex: path.join(dir, 'artifacts', 'index.json'),
    metrics: path.join(dir, 'metrics.jsonl'),
    logs: path.join(dir, 'logs'),
    lock: path.join(dir, '.lock'),
  };
  const key = String(session || '').trim() ? sessionKey(session) : '';
  const base = key ? path.join(dir, 'sessions', key) : dir;
  return {
    ...shared,
    sessionDir: key ? base : '',
    sessionId: key,
    goal: path.join(base, 'goal.json'),
    brief: path.join(base, 'brief.json'),
    lastCheck: path.join(base, 'last-check.json'),
    journal: path.join(base, 'journal.md'),
    plan: path.join(base, 'plan.json'),
    jobs: path.join(base, 'jobs.json'),
    session: path.join(base, 'session.json'),
    capsule: path.join(base, 'capsule.md'),
    injection: path.join(base, 'injection.json'),
    packet: path.join(base, 'packet.json'),
    now: path.join(base, 'now.json'),
    worktrees: path.join(base, 'worktrees.json'),
  };
}

export function sessionDirFor(root, session) {
  if (!String(session || '').trim()) return '';
  return storePaths(root, session).sessionDir;
}

export function sessionsDir(root) {
  return path.join(stateDirFor(root), 'sessions');
}

export function listSessionDirs(root) {
  try {
    return fs.readdirSync(sessionsDir(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function legacyStateFiles(root) {
  const base = storePaths(root);
  return SESSION_STATE_FILES.filter((name) => fs.existsSync(path.join(base.dir, name)));
}

/**
 * Create the session shard and adopt legacy working state by COPY, never by
 * move/delete, so an old single-session install keeps working. Existing
 * session copies always win, which makes repeated adoption idempotent.
 */
export function ensureSession(root, session) {
  const key = String(session || '').trim() ? sessionKey(session) : '';
  if (!key) return '';
  const base = storePaths(root);
  const dir = path.join(base.dir, 'sessions', key);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of SESSION_STATE_FILES) {
    const target = path.join(dir, name);
    const legacy = path.join(base.dir, name);
    if (fs.existsSync(target) || !fs.existsSync(legacy)) continue;
    fs.copyFileSync(legacy, target);
  }
  return dir;
}

// Reads prefer the session copy and fall back to the legacy project-level
// file, so state written before sharding remains visible.
function readPath(root, session, key) {
  const paths = storePaths(root, session);
  if (!paths.sessionDir || fs.existsSync(paths[key])) return paths[key];
  return storePaths(root)[key];
}

export function initStore(root, patch = {}) {
  return ensureState(root, patch);
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function withLock(root, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  const { dir, lock } = storePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover immediately if the owner died; do not make every later hook
      // wait for staleMs after a crashed process left a lock behind.
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (owner?.pid && !processAlive(owner.pid)) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // lock is empty or being written; fall through to the mtime check
      }
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // lock disappeared
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`state lock timeout: ${lock}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fs.rmSync(lock, { force: true });
    }
  }
}

export function newJobId(prefix = 'job') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function readGoal(root, session = '') {
  return readJson(readPath(root, session, 'goal'), {
    text: '',
    acceptance: [],
    constraints: [],
    version: 0,
    updated_at: null,
  });
}

export function writeGoal(
  root,
  { text = '', acceptance = [], constraints = [], replace = false } = {},
  session = '',
) {
  return withLock(root, () => {
    ensureSession(root, session);
    const paths = storePaths(root, session);
    const previous = readGoal(root, session);
    const hasPrevious = Boolean(previous.text);
    const next = {
      text: replace || !hasPrevious ? String(text || '') : previous.text,
      acceptance: replace || !hasPrevious ? normalizeList(acceptance) : previous.acceptance,
      constraints: replace || !hasPrevious ? normalizeList(constraints) : previous.constraints,
      version: (previous.version || 0) + (replace || !hasPrevious ? 1 : 0),
      updated_at: new Date().toISOString(),
    };
    if (!hasPrevious && !next.text) {
      next.version = 0;
    }
    atomicWrite(paths.goal, `${JSON.stringify(next, null, 2)}\n`);
    if (replace || !hasPrevious) {
      fs.rmSync(paths.brief, { force: true });
      fs.rmSync(paths.lastCheck, { force: true });
    }
    return next;
  });
}

export function appendJournal(root, text, session = '') {
  if (!text) return;
  ensureSession(root, session);
  const file = storePaths(root, session).journal;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n## ${new Date().toISOString()}\n\n${text}\n`, 'utf8');
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
}

export const PLAN_VERSION = 2;
const STALE_MS = 24 * 60 * 60 * 1000;

function clampConfidence(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

/**
 * Attention metadata lives on the task itself: what to do next, what blocks it,
 * how much a miss costs, who says it is real, and when that was last known.
 * `stale` is derived on read, never stored.
 */
function withAttention(task, previous = null) {
  const { stale, ...rest } = { ...task };
  const blockers = Array.isArray(rest.blockers)
    ? rest.blockers.map((item) => String(item).slice(0, 120)).slice(0, 5)
    : (previous?.blockers || []);
  return {
    ...rest,
    next_action: String(rest.next_action ?? previous?.next_action ?? '').slice(0, 200),
    blockers,
    priority: Number.isFinite(Number(rest.priority))
      ? Math.min(9, Math.max(1, Math.round(Number(rest.priority))))
      : (previous?.priority ?? 3),
    cost_of_miss: String(rest.cost_of_miss ?? previous?.cost_of_miss ?? '').slice(0, 200),
    authority: String(rest.authority ?? previous?.authority ?? '').slice(0, 40),
    confidence: clampConfidence(rest.confidence, previous?.confidence ?? null),
    as_of: String(rest.as_of || previous?.as_of || new Date().toISOString()),
  };
}

function taskIsStale(task) {
  if (!['in_progress', 'pending'].includes(String(task.status))) return false;
  const asOf = Date.parse(task.as_of);
  return Number.isFinite(asOf) && (Date.now() - asOf) > STALE_MS;
}

export function readPlan(root, session = '') {
  const raw = readJson(readPath(root, session, 'plan'), { tasks: [], updated_at: null });
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((task) => withAttention(task)) : [];
  return {
    version: PLAN_VERSION,
    tasks: tasks.map((task) => ({ ...task, stale: taskIsStale(task) })),
    updated_at: raw.updated_at || null,
  };
}

export function readBrief(root, session = '') {
  return readJson(readPath(root, session, 'brief'), null);
}

export function writeBrief(root, brief = {}, session = '') {
  return withLock(root, () => {
    ensureSession(root, session);
    const goal = readGoal(root, session);
    const next = {
      version: 1,
      ...brief,
      goal_version: Number(goal.version) || 0,
      updated_at: new Date().toISOString(),
    };
    atomicWrite(storePaths(root, session).brief, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function readLastCheck(root, session = '') {
  return readJson(readPath(root, session, 'lastCheck'), null);
}

export function writeLastCheck(root, result, session = '') {
  ensureSession(root, session);
  // Provenance: a last check is written by the harness (enhance_check, land) or
  // by an explicit caller; a worker's self-report never lands here.
  const record = { ...result, source: String(result?.source || 'harness') };
  atomicWrite(storePaths(root, session).lastCheck, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function updatePlanTask(root, id, patch = {}, session = '') {
  return withLock(root, () => {
    ensureSession(root, session);
    const plan = readPlan(root, session);
    const index = (plan.tasks || []).findIndex((task) => task.id === id);
    if (index === -1) return null;
    plan.tasks[index] = withAttention(
      { ...plan.tasks[index], ...patch },
      plan.tasks[index],
    );
    plan.tasks = plan.tasks.map((task) => withAttention(task));
    plan.version = PLAN_VERSION;
    plan.updated_at = new Date().toISOString();
    atomicWrite(storePaths(root, session).plan, `${JSON.stringify(plan, null, 2)}\n`);
    return { ...plan.tasks[index], stale: taskIsStale(plan.tasks[index]) };
  });
}

export function writePlan(root, tasks = [], { replace = false } = {}, session = '') {
  return withLock(root, () => {
    ensureSession(root, session);
    const previous = readPlan(root, session);
    const previousById = new Map((previous.tasks || []).map((task) => [task.id, task]));
    const normalized = (Array.isArray(tasks) ? tasks : [])
      .slice(0, 50)
      .map((task, index) => withAttention({
        ...task,
        id: String(task.id || `t${index + 1}`),
        title: String(task.title || task.task || task.id || '').slice(0, 300),
        status: String(task.status || 'pending'),
        worker: String(task.worker || task.subagent || ''),
        depends_on: Array.isArray(task.depends_on)
          ? task.depends_on.map(String).slice(0, 10)
          : [],
        acceptance: String(task.acceptance || '').slice(0, 500),
        evidence: Array.isArray(task.evidence) ? task.evidence.map(String).slice(0, 10) : [],
        updated_at: new Date().toISOString(),
        as_of: task.as_of || new Date().toISOString(),
      }, previousById.get(String(task.id || `t${index + 1}`))))
      .filter((task) => task.title);
    const next = {
      version: PLAN_VERSION,
      tasks: replace ? normalized : mergePlan(previous.tasks, normalized),
      updated_at: new Date().toISOString(),
    };
    atomicWrite(storePaths(root, session).plan, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

function mergePlan(previousTasks, nextTasks) {
  const byId = new Map((previousTasks || []).map((task) => [task.id, task]));
  for (const task of nextTasks) {
    byId.set(task.id, { ...(byId.get(task.id) || {}), ...task });
  }
  return [...byId.values()];
}

export function readWorktrees(root, session = '') {
  return readJson(readPath(root, session, 'worktrees'), { version: 1, worktrees: {} });
}

function normalizeWorktreeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') continue;
    out[String(id)] = entry;
  }
  return out;
}

function writeWorktreesUnlocked(root, worktrees, session = '') {
  const next = {
    version: 1,
    worktrees: normalizeWorktreeMap(worktrees),
    updated_at: new Date().toISOString(),
  };
  ensureSession(root, session);
  atomicWrite(storePaths(root, session).worktrees, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function writeWorktrees(root, worktrees, session = '') {
  return withLock(root, () => writeWorktreesUnlocked(root, worktrees, session));
}

export function upsertWorktree(root, taskId, patch = {}, session = '') {
  const id = String(taskId || '').trim();
  if (!id) return null;
  return withLock(root, () => {
    ensureSession(root, session);
    const data = readWorktrees(root, session);
    const entry = {
      ...(data.worktrees[id] || {}),
      ...patch,
      task_id: id,
      updated_at: new Date().toISOString(),
    };
    data.worktrees[id] = entry;
    writeWorktreesUnlocked(root, data.worktrees, session);
    return entry;
  });
}

export function removeWorktreeEntry(root, taskId, session = '') {
  const id = String(taskId || '').trim();
  if (!id) return false;
  return withLock(root, () => {
    const data = readWorktrees(root, session);
    if (!(id in data.worktrees)) return false;
    delete data.worktrees[id];
    writeWorktreesUnlocked(root, data.worktrees, session);
    return true;
  });
}

export function appendDecision(root, decision, rationale = '', session = '') {
  const text = String(decision || '').trim();
  if (!text) return null;
  const entry = {
    at: new Date().toISOString(),
    decision: text.slice(0, 600),
    rationale: String(rationale || '').slice(0, 1000),
  };
  if (String(session || '').trim()) entry.session = sessionKey(session);
  return withLock(root, () => {
    const file = storePaths(root).decisions;
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  });
}

function readJsonlTail(file, limit) {
  const take = Math.max(0, Number(limit) || 0);
  if (take === 0 || !fs.existsSync(file)) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunkSize = 64 * 1024;
    let position = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;
    while (position > 0 && newlines <= take) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      const bytesRead = fs.readSync(fd, chunk, 0, readSize, position);
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);
      newlines = 0;
      for (const byte of buffer) {
        if (byte === 0x0a) newlines += 1;
      }
    }
    let text = buffer.toString('utf8');
    if (position > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-take);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readDecisions(root, limit = 10) {
  return readJsonlTail(storePaths(root).decisions, limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readJobs(root, session = '') {
  return readJson(readPath(root, session, 'jobs'), { jobs: [] });
}

function writeJobsUnlocked(root, jobs, session = '') {
  const next = { jobs: (Array.isArray(jobs) ? jobs : []).slice(-100) };
  ensureSession(root, session);
  atomicWrite(storePaths(root, session).jobs, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function writeJobs(root, jobs, session = '') {
  return withLock(root, () => writeJobsUnlocked(root, jobs, session));
}

export function upsertJob(root, id, patch = {}, session = '') {
  return withLock(root, () => {
    ensureSession(root, session);
    const data = readJobs(root, session);
    const index = data.jobs.findIndex((job) => job.id === id);
    const now = new Date().toISOString();
    if (index === -1) {
      const job = {
        id,
        agent_id: patch.agent_id || '',
        type: patch.type || '',
        task: patch.task || '',
        status: patch.status || 'running',
        depth: Number(patch.depth) || 1,
        created_at: now,
        updated_at: now,
        ...patch,
      };
      data.jobs.push(job);
      writeJobsUnlocked(root, data.jobs, session);
      return job;
    }
    data.jobs[index] = { ...data.jobs[index], ...patch, updated_at: now };
    writeJobsUnlocked(root, data.jobs, session);
    return data.jobs[index];
  });
}

export function findJobByAgent(root, agentId, session = '') {
  if (!agentId) return null;
  return readJobs(root, session).jobs.find((job) => job.agent_id === agentId) || null;
}

export function updateJob(root, id, patch = {}, session = '') {
  return upsertJob(root, id, patch, session);
}

export function readSessions(root) {
  return readJson(storePaths(root).sessions, { version: 1, sessions: {} });
}

export function markSession(root, sessionId, patch = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return withLock(root, () => {
    const data = readSessions(root);
    const now = new Date().toISOString();
    const previous = data.sessions[id] || {};
    data.sessions[id] = {
      ...previous,
      ...patch,
      id,
      created_at: previous.created_at || patch.created_at || now,
      last_seen: patch.last_seen || now,
      updated_at: now,
    };
    const ids = Object.keys(data.sessions);
    if (ids.length > 100) {
      for (const key of ids.slice(0, ids.length - 100)) delete data.sessions[key];
    }
    atomicWrite(storePaths(root).sessions, `${JSON.stringify(data, null, 2)}
`);
    return data.sessions[id];
  });
}

/**
 * Resolution for MCP calls. Explicit/env ids win; otherwise the most recent
 * sessions.json entry for this host process, then a unique session directory.
 * An empty result means legacy project-level state (single-session installs);
 * multiple candidates are ambiguous and must be disambiguated by the caller.
 */
export function resolveSessionId(root, { explicit = '', hostPid = null } = {}) {
  if (String(explicit || '').trim()) return sessionKey(explicit);
  const pid = Number(hostPid);
  if (Number.isInteger(pid) && pid > 0) {
    const matches = Object.values(readSessions(root).sessions || {})
      .filter((entry) => Number(entry?.host_pid) === pid)
      .sort((a, b) => String(b.last_seen || b.updated_at || '').localeCompare(String(a.last_seen || a.updated_at || '')));
    const ids = [...new Set(matches.map((entry) => sessionKey(entry.id)))];
    if (ids.length > 1) {
      throw new Error(
        `ambiguous session for this host process (${ids.join(', ')}); pass session=<id> from the capsule`,
      );
    }
    if (ids.length === 1) return ids[0];
  }
  const dirs = listSessionDirs(root);
  if (dirs.length === 1) return dirs[0];
  if (dirs.length > 1) {
    throw new Error(
      `multiple sessions exist (${dirs.slice(0, 5).join(', ')}${dirs.length > 5 ? ', ...' : ''}); pass session=<id> from the capsule`,
    );
  }
  return '';
}

export function readSession(root, session = '') {
  return readJson(readPath(root, session, 'session'), {});
}

export function writeSession(root, patch = {}, session = '') {
  return withLock(root, () => {
    ensureSession(root, session);
    const previous = readSession(root, session);
    const next = { ...previous, ...patch, updated_at: new Date().toISOString() };
    atomicWrite(storePaths(root, session).session, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function appendMetric(root, event, session = '') {
  const entry = { at: new Date().toISOString(), ...event };
  if (String(session || '').trim()) entry.session = sessionKey(session);
  const file = storePaths(root).metrics;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function readMetrics(root, limit = 200) {
  return readJsonlTail(storePaths(root).metrics, limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function snapshot(root, session = '') {
  return {
    session_id: storePaths(root, session).sessionId,
    goal: readGoal(root, session),
    plan: readPlan(root, session),
    jobs: readJobs(root, session).jobs,
    decisions: readDecisions(root, 10),
    session: readSession(root, session),
  };
}
