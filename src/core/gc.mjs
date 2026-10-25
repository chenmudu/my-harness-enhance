import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, readJson } from './fs-util.mjs';
import { enhanceHome, readRegistry } from './state-root.mjs';
import { withLock } from './store.mjs';

export const DEFAULT_RETENTION = {
  metrics: { maxBytes: 5 * 1024 * 1024, maxAgeDays: 30 },
  logs: { maxBytes: 5 * 1024 * 1024, maxAgeDays: 30 },
  artifacts: { maxAgeDays: 30, graceDays: 7 },
  decisions: { maxAgeDays: 180, enabled: false },
  worktrees: { maxAgeDays: 7 },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_SKIP_MINUTES = 10;
const HANDLE_RE = /\b[a-f0-9]{16}\b/g;
const MAX_REFERENCE_SCAN_BYTES = 2 * 1024 * 1024;
const LANDED_STATUSES = new Set(['landed', 'completed', 'merged']);

function tildify(file) {
  if (!file) return '';
  const relative = path.relative(os.homedir(), file);
  if (!relative || relative.startsWith('..')) return file;
  return `~/${relative.split(path.sep).join('/')}`;
}

function ageDays(timestamp, now) {
  const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp || '');
  if (!Number.isFinite(value)) return null;
  return (now.getTime() - value) / DAY_MS;
}

function lineTimestamp(line) {
  try {
    const entry = JSON.parse(line);
    const at = Date.parse(entry?.at || '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function collectReferencedHandles(stateDir) {
  const handles = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'artifacts' || entry.name === 'logs') continue;
        walk(full, depth + 1);
        continue;
      }
      if (entry.name === 'metrics.jsonl') continue;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_REFERENCE_SCAN_BYTES) continue;
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(HANDLE_RE)) handles.add(match[0]);
    }
  };
  walk(stateDir, 0);
  return handles;
}

function trimJsonlFile(file, { maxAgeDays, maxBytes, now, recentSkipMs }) {
  const mtime = mtimeOf(file);
  if (mtime === null) return null;
  if (now.getTime() - mtime < recentSkipMs) {
    return { skipped: { path: file, reason: 'modified recently' } };
  }
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim());
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    const at = lineTimestamp(line);
    if (at !== null && at < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  let droppedForSize = 0;
  let body = kept.length ? `${kept.join('\n')}\n` : '';
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    while (kept.length && Buffer.byteLength(body, 'utf8') > maxBytes) {
      kept.shift();
      droppedForSize += 1;
      body = kept.length ? `${kept.join('\n')}\n` : '';
    }
  }
  if (!removed && !droppedForSize) return null;
  return {
    action: {
      type: 'trim',
      path: file,
      removed_lines: removed + droppedForSize,
      kept_lines: kept.length,
      bytes_before: Buffer.byteLength(text, 'utf8'),
      bytes_after: Buffer.byteLength(body, 'utf8'),
    },
    body,
  };
}

function trimJournalFile(file, { maxAgeDays, now, recentSkipMs }) {
  const mtime = mtimeOf(file);
  if (mtime === null) return null;
  if (now.getTime() - mtime < recentSkipMs) {
    return { skipped: { path: file, reason: 'modified recently' } };
  }
  const text = fs.readFileSync(file, 'utf8');
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const parts = text.split(/(?=^## )/m);
  const kept = [];
  let removed = 0;
  for (const part of parts) {
    if (!part.trim()) continue;
    const heading = part.match(/^##\s+(.+)$/m);
    const at = heading ? Date.parse(heading[1].trim()) : NaN;
    if (Number.isFinite(at) && at < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(part.trim());
  }
  if (!removed) return null;
  const body = kept.length ? `${kept.join('\n\n')}\n` : '';
  return {
    action: {
      type: 'trim-journal',
      path: file,
      removed_lines: removed,
      kept_lines: kept.length,
      bytes_before: Buffer.byteLength(text, 'utf8'),
      bytes_after: Buffer.byteLength(body, 'utf8'),
    },
    body,
  };
}

function artifactPlan(stateDir, { now, retention, referenced, recentSkipMs }) {
  const dir = path.join(stateDir, 'artifacts');
  const indexFile = path.join(dir, 'index.json');
  const index = readJson(indexFile, { version: 1, artifacts: {} });
  const actions = [];
  const skipped = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { actions, skipped, index, indexFile };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
    const file = path.join(dir, entry.name);
    const handle = entry.name.replace(/\.txt$/, '');
    const mtime = mtimeOf(file);
    if (mtime === null) continue;
    if (now.getTime() - mtime < recentSkipMs) {
      skipped.push({ path: file, handle, reason: 'modified recently' });
      continue;
    }
    if (referenced.has(handle)) {
      skipped.push({ path: file, handle, reason: 'referenced' });
      continue;
    }
    const created = index.artifacts?.[handle]?.created_at || mtime;
    const age = ageDays(created, now);
    if (age === null) {
      skipped.push({ path: file, handle, reason: 'unknown age' });
      continue;
    }
    if (age <= retention.artifacts.maxAgeDays) {
      skipped.push({ path: file, handle, reason: 'within retention' });
      continue;
    }
    if (age <= retention.artifacts.maxAgeDays + retention.artifacts.graceDays) {
      skipped.push({ path: file, handle, reason: 'unreferenced grace' });
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    actions.push({ type: 'delete-artifact', path: file, handle, bytes: size });
  }
  return { actions, skipped, index, indexFile };
}

function git(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30000 });
}

function worktreeIsClean(dir) {
  const result = git(dir, ['status', '--porcelain']);
  return result.status === 0 && !String(result.stdout || '').trim();
}

function worktreeIsMerged(repo, dir) {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) return false;
  const name = String(branch.stdout || '').trim();
  if (!name || name === 'HEAD') return false;
  const merged = git(repo, ['branch', '--merged', 'HEAD', '--format=%(refname:short)']);
  if (merged.status !== 0) return false;
  return String(merged.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .includes(name);
}

function worktreePlan({ home, registry, now, retention, recentSkipMs }) {
  const actions = [];
  const skipped = [];
  const base = path.join(home, 'worktrees');
  let projects = [];
  try {
    projects = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { actions, skipped };
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectKey = project.name;
    const repo = registry.projects?.[projectKey]?.projectRoot || '';
    const projectDir = path.join(base, projectKey);
    let sessions = [];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const registryFile = path.join(
        home,
        'projects',
        projectKey,
        'sessions',
        session.name,
        'worktrees.json',
      );
      const worktreeRegistry = readJson(registryFile, { worktrees: {} });
      const sessionDir = path.join(projectDir, session.name);
      let tasks = [];
      try {
        tasks = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const task of tasks) {
        if (!task.isDirectory()) continue;
        const dir = path.join(sessionDir, task.name);
        const mtime = mtimeOf(dir);
        if (mtime === null) continue;
        if (now.getTime() - mtime < recentSkipMs) {
          skipped.push({ path: dir, task_id: task.name, reason: 'modified recently' });
          continue;
        }
        const entry = worktreeRegistry.worktrees?.[task.name];
        const status = String(entry?.status || '');
        const landed = LANDED_STATUSES.has(status)
          || (!entry && repo && worktreeIsMerged(repo, dir));
        if (!landed) {
          skipped.push({ path: dir, task_id: task.name, reason: 'not landed' });
          continue;
        }
        if (!worktreeIsClean(dir)) {
          skipped.push({ path: dir, task_id: task.name, reason: 'has uncommitted changes' });
          continue;
        }
        const age = ageDays(mtime, now);
        if (age === null || age <= retention.worktrees.maxAgeDays) {
          skipped.push({ path: dir, task_id: task.name, reason: 'within retention' });
          continue;
        }
        actions.push({
          type: 'remove-worktree',
          path: dir,
          task_id: task.name,
          project_key: projectKey,
          session_key: session.name,
          repo,
        });
      }
    }
  }
  return { actions, skipped };
}

function applyActions(prepared, { index, indexFile, apply }) {
  const results = [];
  for (const item of prepared) {
    const action = item.action;
    if (!apply) {
      results.push({ ...action, applied: false });
      continue;
    }
    try {
      if (action.type === 'trim' || action.type === 'trim-journal') {
        atomicWrite(action.path, item.body);
      } else if (action.type === 'delete-artifact') {
        fs.rmSync(action.path, { force: true });
        if (index && indexFile && index.artifacts?.[action.handle]) {
          delete index.artifacts[action.handle];
          atomicWrite(indexFile, `${JSON.stringify(index, null, 2)}\n`);
        }
      } else if (action.type === 'remove-worktree') {
        if (action.repo && fs.existsSync(action.repo)) {
          const removed = git(action.repo, ['worktree', 'remove', action.path]);
          if (removed.status !== 0) {
            // Never force-delete a tree git refused to remove: it may hold
            // state the plan could not see. `git worktree prune` clears the
            // stale metadata instead.
            results.push({
              ...action,
              applied: false,
              error: String(removed.stderr || '').trim() || 'git worktree remove failed',
            });
            continue;
          }
          git(action.repo, ['worktree', 'prune']);
        } else {
          fs.rmSync(action.path, { recursive: true, force: true });
        }
      }
      results.push({ ...action, applied: true });
    } catch (error) {
      results.push({ ...action, applied: false, error: String(error?.message || error) });
    }
  }
  return results;
}

function projectStateDirs(home) {
  const dir = path.join(home, 'projects');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function runGc({
  root = '',
  now = new Date(),
  retention = {},
  includeDecisions = false,
  apply = false,
} = {}) {
  const home = enhanceHome();
  const limits = {
    metrics: { ...DEFAULT_RETENTION.metrics, ...(retention.metrics || {}) },
    logs: { ...DEFAULT_RETENTION.logs, ...(retention.logs || {}) },
    artifacts: { ...DEFAULT_RETENTION.artifacts, ...(retention.artifacts || {}) },
    decisions: { ...DEFAULT_RETENTION.decisions, ...(retention.decisions || {}) },
    worktrees: { ...DEFAULT_RETENTION.worktrees, ...(retention.worktrees || {}) },
  };
  const recentSkipMs = RECENT_SKIP_MINUTES * 60 * 1000;
  const registry = readRegistry();
  const keys = projectStateDirs(home);
  const scoped = root
    ? keys.filter((key) => registry.projects?.[key]?.projectRoot
      && path.resolve(registry.projects[key].projectRoot).toLowerCase() === path.resolve(root).toLowerCase())
    : keys;

  const projects = [];
  const allActions = [];
  const allSkipped = [];

  for (const key of scoped) {
    const stateDir = path.join(home, 'projects', key);
    const entry = registry.projects?.[key];
    const workspace = entry?.projectRoot || '';
    const collect = () => {
      const prepared = [];
      const skipped = [];
      const referenced = collectReferencedHandles(stateDir);

      const metrics = trimJsonlFile(path.join(stateDir, 'metrics.jsonl'), {
        maxAgeDays: limits.metrics.maxAgeDays,
        maxBytes: limits.metrics.maxBytes,
        now,
        recentSkipMs,
      });
      if (metrics?.skipped) skipped.push(metrics.skipped);
      if (metrics?.action) prepared.push({ action: metrics.action, body: metrics.body });

      const logsDir = path.join(stateDir, 'logs');
      let logFiles = [];
      try {
        logFiles = fs.readdirSync(logsDir).filter((name) => /\.(jsonl|log)$/.test(name));
      } catch {
        logFiles = [];
      }
      for (const name of logFiles) {
        const trimmed = trimJsonlFile(path.join(logsDir, name), {
          maxAgeDays: limits.logs.maxAgeDays,
          maxBytes: limits.logs.maxBytes,
          now,
          recentSkipMs,
        });
        if (trimmed?.skipped) skipped.push(trimmed.skipped);
        if (trimmed?.action) prepared.push({ action: trimmed.action, body: trimmed.body });
      }

      const artifacts = artifactPlan(stateDir, {
        now,
        retention: limits,
        referenced,
        recentSkipMs,
      });
      for (const action of artifacts.actions) prepared.push({ action });
      skipped.push(...artifacts.skipped);

      if (includeDecisions && limits.decisions.enabled) {
        const decisions = trimJsonlFile(path.join(stateDir, 'decisions.jsonl'), {
          maxAgeDays: limits.decisions.maxAgeDays,
          maxBytes: Number.MAX_SAFE_INTEGER,
          now,
          recentSkipMs,
        });
        if (decisions?.skipped) skipped.push(decisions.skipped);
        if (decisions?.action) prepared.push({ action: decisions.action, body: decisions.body });

        let sessions = [];
        try {
          sessions = fs.readdirSync(path.join(stateDir, 'sessions'), { withFileTypes: true });
        } catch {
          sessions = [];
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          const journal = trimJournalFile(
            path.join(stateDir, 'sessions', session.name, 'journal.md'),
            { maxAgeDays: limits.decisions.maxAgeDays, now, recentSkipMs },
          );
          if (journal?.skipped) skipped.push(journal.skipped);
          if (journal?.action) prepared.push({ action: journal.action, body: journal.body });
        }
      }

      return { prepared, skipped, artifacts };
    };

    // The lock must cover the apply as well: a hook that appends to
    // metrics.jsonl between collect and apply would lose those lines when the
    // collected body is written back.
    const run = () => {
      const collected = collect();
      const applied = applyActions(collected.prepared, {
        index: collected.artifacts.index,
        indexFile: collected.artifacts.indexFile,
        apply,
      });
      return { collected, applied };
    };
    const { collected, applied } = workspace ? withLock(workspace, run) : run();
    for (const action of applied) allActions.push({ project: key, ...action });
    for (const skip of collected.skipped) allSkipped.push({ project: key, ...skip });
    projects.push({
      key,
      stateDir,
      workspace,
      actions: applied,
      skipped: collected.skipped,
    });
  }

  const worktrees = worktreePlan({
    home,
    registry,
    now,
    retention: limits,
    recentSkipMs,
  });
  const appliedWorktrees = applyActions(worktrees.actions.map((action) => ({ action })), { apply });
  for (const action of appliedWorktrees) allActions.push({ ...action });
  for (const skip of worktrees.skipped) allSkipped.push(skip);

  const freed = allActions
    .filter((action) => action.applied)
    .reduce((total, action) => {
      if (action.type === 'trim' || action.type === 'trim-journal') {
        return total + Math.max(0, (action.bytes_before || 0) - (action.bytes_after || 0));
      }
      if (action.type === 'delete-artifact') return total + (action.bytes || 0);
      return total;
    }, 0);

  return {
    home,
    apply,
    now: now.toISOString(),
    retention: limits,
    projects,
    actions: allActions,
    skipped: allSkipped,
    freed_bytes: freed,
  };
}

export function formatGcReport(report) {
  const lines = [];
  const display = (file) => {
    if (!file) return '';
    const relative = path.relative(report.home, file);
    if (relative && !relative.startsWith('..')) return relative;
    return tildify(file);
  };
  lines.push(`gc ${report.apply ? '(applied)' : '(dry run)'}`);
  lines.push(`home: ${tildify(report.home)}`);
  lines.push('');
  if (report.actions.length === 0 && report.skipped.length === 0) {
    lines.push('nothing to collect');
    lines.push('');
    lines.push(
      report.apply
        ? 'freed: 0 bytes'
        : 'freed: 0 bytes would be freed (dry run: nothing was deleted)',
    );
    return `${lines.join('\n')}\n`;
  }
  for (const project of report.projects) {
    const actions = report.actions.filter((action) => action.project === project.key);
    const skipped = report.skipped.filter((action) => action.project === project.key);
    if (!actions.length && !skipped.length) continue;
    lines.push(`project ${project.key}`);
    for (const action of actions) {
      if (action.type === 'trim' || action.type === 'trim-journal') {
        lines.push(
          `- ${action.type === 'trim' ? 'trim' : 'trim journal'} ${display(action.path)}: `
          + `${action.removed_lines} line(s) removed, ${action.kept_lines} kept, `
          + `${action.bytes_before} -> ${action.bytes_after} bytes`,
        );
      } else if (action.type === 'delete-artifact') {
        lines.push(`- delete artifact ${action.handle} (${action.bytes} bytes)`);
      } else if (action.type === 'remove-worktree') {
        lines.push(`- remove worktree ${action.task_id} (${display(action.path)})`);
      }
      if (action.error) lines.push(`  error: ${action.error}`);
    }
    for (const skip of skipped) {
      lines.push(`- skip ${display(skip.path)}: ${skip.reason}`);
    }
    lines.push('');
  }
  const worktreeActions = report.actions.filter((action) => action.type === 'remove-worktree');
  for (const action of worktreeActions) {
    lines.push(`- remove worktree ${action.task_id} (${display(action.path)})`);
    if (action.error) lines.push(`  error: ${action.error}`);
  }
  for (const skip of report.skipped.filter((item) => item.task_id)) {
    lines.push(`- skip ${display(skip.path)}: ${skip.reason}`);
  }
  lines.push('');
  lines.push(
    report.apply
      ? `freed: ${report.freed_bytes} bytes`
      : `freed: ${report.freed_bytes} bytes would be freed (dry run: nothing was deleted)`,
  );
  return `${lines.join('\n')}\n`;
}
