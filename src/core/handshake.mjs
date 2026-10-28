import crypto from 'node:crypto';
import { readBrief, readPlan } from './store.mjs';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sorted(value));
}

export function hashValue(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function briefPayload(brief) {
  if (!brief || typeof brief !== 'object') return null;
  const { updated_at: _ignored, ...rest } = brief;
  return rest;
}

function taskPayload(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    id: String(task.id || ''),
    title: String(task.title || ''),
    worker: String(task.worker || ''),
    depends_on: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [],
    acceptance: String(task.acceptance || ''),
    checks: Array.isArray(task.checks) ? task.checks.map(String) : [],
    outputs: Array.isArray(task.outputs) ? task.outputs.map(String) : [],
  };
}

/**
 * Snapshot the inputs a worker is about to rely on. The brief hash excludes
 * its write timestamp so a no-op save does not invalidate an in-flight result;
 * the task hash covers only the delivery definition, so an unrelated task's
 * status or timestamp change does not reject it.
 */
export function workerHandshake(root, { taskId = '', session = '' } = {}) {
  const brief = readBrief(root, session);
  const plan = readPlan(root, session);
  const id = String(taskId || '').trim();
  const task = id ? (plan.tasks || []).find((item) => item.id === id) : null;
  return {
    brief_hash: brief ? hashValue(briefPayload(brief)) : '',
    task_hash: task ? hashValue(taskPayload(task)) : '',
  };
}

/**
 * Compare what the worker was given with what it echoed and what the ledger
 * says now. A missing hash is legacy: accept it, but say so. A hash that
 * disagrees is a stale result: reject it and do not sync the plan.
 */
export function handshakeReason(job, envelope, live = {}) {
  const expectedBrief = String(job?.expected_brief_hash || '');
  const expectedTask = String(job?.expected_task_hash || '');
  const envBrief = String(envelope?.brief_hash || '');
  const envTask = String(envelope?.task_hash || '');
  const liveBrief = String(live?.brief_hash || '');
  const liveTask = String(live?.task_hash || '');
  const hasExpected = Boolean(expectedBrief || expectedTask);
  const hasEnvelope = Boolean(envBrief || envTask);

  if (!hasExpected && !hasEnvelope) return { ok: true, legacy: true, reason: '' };

  if (expectedBrief && envBrief && envBrief !== expectedBrief) {
    return {
      ok: false,
      legacy: false,
      reason: `brief_hash mismatch: expected ${expectedBrief}, got ${envBrief}`,
    };
  }
  if (expectedTask && envTask && envTask !== expectedTask) {
    return {
      ok: false,
      legacy: false,
      reason: `task_hash mismatch: expected ${expectedTask}, got ${envTask}`,
    };
  }
  if (!job && envBrief && liveBrief && envBrief !== liveBrief) {
    return {
      ok: false,
      legacy: false,
      reason: `brief changed since dispatch: expected ${envBrief}, now ${liveBrief}`,
    };
  }
  if (!job && envTask && liveTask && envTask !== liveTask) {
    return {
      ok: false,
      legacy: false,
      reason: `task changed since dispatch: expected ${envTask}, now ${liveTask}`,
    };
  }
  if (expectedBrief && liveBrief && expectedBrief !== liveBrief) {
    return {
      ok: false,
      legacy: false,
      reason: `brief changed after dispatch: expected ${expectedBrief}, now ${liveBrief}`,
    };
  }
  if (expectedTask && liveTask && expectedTask !== liveTask) {
    return {
      ok: false,
      legacy: false,
      reason: `task changed after dispatch: expected ${expectedTask}, now ${liveTask}`,
    };
  }
  if (!hasEnvelope || (expectedBrief && !envBrief) || (expectedTask && !envTask)) {
    return { ok: true, legacy: true, reason: 'worker did not echo brief_hash/task_hash' };
  }
  return { ok: true, legacy: false, reason: '' };
}