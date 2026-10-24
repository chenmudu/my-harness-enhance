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

export function storePaths(root) {
  const dir = stateDirFor(root);
  return {
    dir,
    config: path.join(dir, 'config.json'),
    goal: path.join(dir, 'goal.json'),
    brief: path.join(dir, 'brief.json'),
    lastCheck: path.join(dir, 'last-check.json'),
    journal: path.join(dir, 'journal.md'),
    plan: path.join(dir, 'plan.json'),
    decisions: path.join(dir, 'decisions.jsonl'),
    jobs: path.join(dir, 'jobs.json'),
    session: path.join(dir, 'session.json'),
    sessions: path.join(dir, 'sessions.json'),
    capsule: path.join(dir, 'capsule.md'),
    worktrees: path.join(dir, 'worktrees.json'),
    artifacts: path.join(dir, 'artifacts'),
    artifactIndex: path.join(dir, 'artifacts', 'index.json'),
    metrics: path.join(dir, 'metrics.jsonl'),
    logs: path.join(dir, 'logs'),
    lock: path.join(dir, '.lock'),
  };
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

export function readGoal(root) {
  return readJson(storePaths(root).goal, {
    text: '',
    acceptance: [],
    constraints: [],
    version: 0,
    updated_at: null,
  });
}

export function writeGoal(root, { text = '', acceptance = [], constraints = [], replace = false } = {}) {
  return withLock(root, () => {
    const file = storePaths(root).goal;
    const previous = readGoal(root);
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
    atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    if (replace || !hasPrevious) {
      fs.rmSync(storePaths(root).brief, { force: true });
      fs.rmSync(storePaths(root).lastCheck, { force: true });
    }
    return next;
  });
}

export function appendJournal(root, text) {
  if (!text) return;
  const file = storePaths(root).journal;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n## ${new Date().toISOString()}\n\n${text}\n`, 'utf8');
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
}

export function readPlan(root) {
  return readJson(storePaths(root).plan, { tasks: [], updated_at: null });
}

export function readBrief(root) {
  return readJson(storePaths(root).brief, null);
}

export function writeBrief(root, brief = {}) {
  return withLock(root, () => {
    const goal = readGoal(root);
    const next = {
      version: 1,
      ...brief,
      goal_version: Number(goal.version) || 0,
      updated_at: new Date().toISOString(),
    };
    atomicWrite(storePaths(root).brief, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function readLastCheck(root) {
  return readJson(storePaths(root).lastCheck, null);
}

export function writeLastCheck(root, result) {
  atomicWrite(storePaths(root).lastCheck, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function updatePlanTask(root, id, patch = {}) {
  return withLock(root, () => {
    const plan = readPlan(root);
    const index = (plan.tasks || []).findIndex((task) => task.id === id);
    if (index === -1) return null;
    plan.tasks[index] = {
      ...plan.tasks[index],
      ...patch,
      updated_at: new Date().toISOString(),
    };
    plan.updated_at = new Date().toISOString();
    atomicWrite(storePaths(root).plan, `${JSON.stringify(plan, null, 2)}\n`);
    return plan.tasks[index];
  });
}

export function writePlan(root, tasks = [], { replace = false } = {}) {
  return withLock(root, () => {
    const previous = readPlan(root);
    const normalized = (Array.isArray(tasks) ? tasks : [])
      .slice(0, 50)
      .map((task, index) => ({
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
      }))
      .filter((task) => task.title);
    const next = {
      tasks: replace ? normalized : mergePlan(previous.tasks, normalized),
      updated_at: new Date().toISOString(),
    };
    atomicWrite(storePaths(root).plan, `${JSON.stringify(next, null, 2)}\n`);
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

export function readWorktrees(root) {
  return readJson(storePaths(root).worktrees, { version: 1, worktrees: {} });
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

function writeWorktreesUnlocked(root, worktrees) {
  const next = {
    version: 1,
    worktrees: normalizeWorktreeMap(worktrees),
    updated_at: new Date().toISOString(),
  };
  atomicWrite(storePaths(root).worktrees, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function writeWorktrees(root, worktrees) {
  return withLock(root, () => writeWorktreesUnlocked(root, worktrees));
}

export function upsertWorktree(root, taskId, patch = {}) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  return withLock(root, () => {
    const data = readWorktrees(root);
    const entry = {
      ...(data.worktrees[id] || {}),
      ...patch,
      task_id: id,
      updated_at: new Date().toISOString(),
    };
    data.worktrees[id] = entry;
    writeWorktreesUnlocked(root, data.worktrees);
    return entry;
  });
}

export function removeWorktreeEntry(root, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return false;
  return withLock(root, () => {
    const data = readWorktrees(root);
    if (!(id in data.worktrees)) return false;
    delete data.worktrees[id];
    writeWorktreesUnlocked(root, data.worktrees);
    return true;
  });
}

export function appendDecision(root, decision, rationale = '') {
  const text = String(decision || '').trim();
  if (!text) return null;
  const entry = {
    at: new Date().toISOString(),
    decision: text.slice(0, 600),
    rationale: String(rationale || '').slice(0, 1000),
  };
  return withLock(root, () => {
    const file = storePaths(root).decisions;
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  });
}

export function readDecisions(root, limit = 10) {
  const file = storePaths(root).decisions;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readJobs(root) {
  return readJson(storePaths(root).jobs, { jobs: [] });
}

function writeJobsUnlocked(root, jobs) {
  const next = { jobs: (Array.isArray(jobs) ? jobs : []).slice(-100) };
  atomicWrite(storePaths(root).jobs, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function writeJobs(root, jobs) {
  return withLock(root, () => writeJobsUnlocked(root, jobs));
}

export function upsertJob(root, id, patch = {}) {
  return withLock(root, () => {
    const data = readJobs(root);
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
      writeJobsUnlocked(root, data.jobs);
      return job;
    }
    data.jobs[index] = { ...data.jobs[index], ...patch, updated_at: now };
    writeJobsUnlocked(root, data.jobs);
    return data.jobs[index];
  });
}

export function findJobByAgent(root, agentId) {
  if (!agentId) return null;
  return readJobs(root).jobs.find((job) => job.agent_id === agentId) || null;
}

export function updateJob(root, id, patch = {}) {
  return upsertJob(root, id, patch);
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
    data.sessions[id] = {
      ...(data.sessions[id] || {}),
      ...patch,
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

export function readSession(root) {
  return readJson(storePaths(root).session, {});
}

export function writeSession(root, patch = {}) {
  return withLock(root, () => {
    const previous = readSession(root);
    const next = { ...previous, ...patch, updated_at: new Date().toISOString() };
    atomicWrite(storePaths(root).session, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function appendMetric(root, event) {
  const entry = { at: new Date().toISOString(), ...event };
  const file = storePaths(root).metrics;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function readMetrics(root, limit = 200) {
  const file = storePaths(root).metrics;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function snapshot(root) {
  return {
    goal: readGoal(root),
    plan: readPlan(root),
    jobs: readJobs(root).jobs,
    decisions: readDecisions(root, 10),
    session: readSession(root),
  };
}
