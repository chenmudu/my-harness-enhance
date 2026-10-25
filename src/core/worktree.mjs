import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  canonicalPath,
  enhanceHome,
  projectKey,
} from './state-root.mjs';
import { loadConfig } from './config.mjs';
import { runBriefChecks } from './checks.mjs';
import { defaultChecks } from './brief.mjs';
import {
  readBrief,
  readPlan,
  readWorktrees,
  removeWorktreeEntry,
  sessionKey,
  updatePlanTask,
  upsertWorktree,
  writeLastCheck,
} from './store.mjs';

/**
 * Isolated git worktrees per code task. Worktrees live outside the target
 * repository, under the user-level state home:
 *
 *   ~/.my-harness-enhance/worktrees/<projectKey>/<sessionKey>/<task_id>
 *
 * The pre-sharding path `worktrees/<projectKey>/<task_id>` stays readable for
 * existing worktrees (list/remove); new worktrees always use the session
 * directory. Git metadata for the linked worktree still lives in the repo's
 * .git/worktrees directory; that is git's own bookkeeping and no source
 * files are written into the target working tree.
 */

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GIT_TIMEOUT_MS = 30000;
const WORKTREE_COMMAND_TIMEOUT_MS = 120000;
const MAX_BLOCKER_CHARS = 1200;

function blocker(message, extra = {}) {
  return { ok: false, blocker: String(message || '').slice(0, MAX_BLOCKER_CHARS), ...extra };
}

function isValidTaskId(value) {
  const id = String(value || '');
  return TASK_ID_RE.test(id) && !id.includes('..');
}

function git(root, args, { timeout = GIT_TIMEOUT_MS, env = null } = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

function gitOk(result) {
  return Boolean(result) && !result.error && result.status === 0;
}

function gitError(result) {
  if (!result) return 'git command did not run';
  return String(result.stderr || result.error?.message || '').trim().slice(0, MAX_BLOCKER_CHARS);
}

/** The checkout's own identity, or a deterministic harness one when it has none. */
function identityArgs(root) {
  const email = git(root, ['config', '--get', 'user.email']);
  const name = git(root, ['config', '--get', 'user.name']);
  const has = gitOk(email) && Boolean(email.stdout.trim())
    && gitOk(name) && Boolean(name.stdout.trim());
  return has ? [] : ['-c', 'user.name=my-harness-enhance', '-c', 'user.email=harness@local'];
}

function isWithin(parent, child) {
  const rel = path.relative(canonicalPath(parent), canonicalPath(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function worktreesRoot() {
  return path.join(enhanceHome(), 'worktrees');
}

export function projectWorktreesDir(root, session = '') {
  const base = path.join(worktreesRoot(), projectKey(root));
  return String(session || '').trim() ? path.join(base, sessionKey(session)) : base;
}

export function worktreePathFor(root, taskId, session = '') {
  return path.join(projectWorktreesDir(root, session), String(taskId || ''));
}

function managedWorktreeDirs(root, session = '') {
  const legacy = canonicalPath(projectWorktreesDir(root));
  if (!String(session || '').trim()) return [legacy];
  return [...new Set([canonicalPath(projectWorktreesDir(root, session)), legacy])];
}

function managedTaskId(root, candidate, session = '') {
  const target = canonicalPath(candidate);
  for (const dir of managedWorktreeDirs(root, session)) {
    if (path.dirname(target) === dir) return path.basename(target);
  }
  return '';
}

function commonDir(target) {
  const absolute = git(target, ['rev-parse', '--absolute-git-common-dir']);
  if (gitOk(absolute) && absolute.stdout.trim()) {
    return canonicalPath(absolute.stdout.trim());
  }
  const relative = git(target, ['rev-parse', '--git-common-dir']);
  if (gitOk(relative) && relative.stdout.trim()) {
    const value = relative.stdout.trim();
    return canonicalPath(path.isAbsolute(value) ? value : path.join(target, value));
  }
  return '';
}

/** Require a git worktree with an empty porcelain status before baselining. */
function assertCleanRepo(root, context = 'before creating a worktree') {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!gitOk(inside) || inside.stdout.trim() !== 'true') {
    return blocker(
      `project is not a git worktree: ${root}${gitError(inside) ? ` (${gitError(inside)})` : ''}`,
      { rule: 'worktree.not_git' },
    );
  }
  const status = git(root, ['status', '--porcelain']);
  if (!gitOk(status)) {
    return blocker(`cannot read git status: ${gitError(status)}`, { rule: 'worktree.status' });
  }
  const dirty = String(status.stdout || '').split('\n').filter(Boolean);
  if (dirty.length > 0) {
    return blocker(
      `working tree is not clean (${dirty.length} change(s)); commit or revert ${context}: ${dirty.slice(0, 8).join(' | ')}`,
      { rule: 'worktree.dirty' },
    );
  }
  return { ok: true };
}

/**
 * Snapshot the uncommitted state of a base checkout as commit objects, without
 * touching the working tree, the index, or the ref namespace: nothing on the
 * user's checkout is committed, staged, or reverted.
 *
 * A temporary index does the work. `read-tree HEAD` plus `add -A` plus
 * `write-tree` yields the tree of the current working tree, tracked changes
 * and untracked files alike, and `commit-tree` wraps it in a commit that the
 * worktree can be created from. The original index state is captured in a
 * second commit so a failed landing can restore the exact staged/unstaged
 * split.
 */
function snapshotBase(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!gitOk(head)) return null;
  const headRef = head.stdout.trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-carry-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    if (!gitOk(git(root, ['read-tree', headRef], { env }))) return null;
    if (!gitOk(git(root, ['add', '-A'], { env }))) return null;
    const tree = git(root, ['write-tree'], { env });
    if (!gitOk(tree)) return null;
    const indexTree = git(root, ['write-tree']);
    const identity = identityArgs(root);
    const carry = git(root, [
      ...identity, 'commit-tree', tree.stdout.trim(), '-p', headRef, '-m', 'mhe carry base',
    ]);
    if (!gitOk(carry)) return null;
    let indexCommit = '';
    if (gitOk(indexTree) && indexTree.stdout.trim()) {
      const made = git(root, [
        ...identity, 'commit-tree', indexTree.stdout.trim(), '-p', headRef, '-m', 'mhe carry index',
      ]);
      if (gitOk(made)) indexCommit = made.stdout.trim();
    }
    return {
      commit: carry.stdout.trim(),
      index_commit: indexCommit,
      tree: tree.stdout.trim(),
      head: headRef,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The files the carried snapshot contains. */
function carriedFiles(root, commit) {
  const list = git(root, ['ls-tree', '-r', '--name-only', commit]);
  if (!gitOk(list)) return [];
  return String(list.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Does the base still hold the carried state? A fresh snapshot of the same
 * state has the same content-addressed tree and the same HEAD, even though
 * the snapshot commits themselves are new objects.
 */
function baseHoldsCarry(root, carry) {
  const current = snapshotBase(root);
  if (!current) return false;
  return current.tree === carry.tree && current.head === carry.head;
}

/**
 * Undo a landing on the base checkout.
 *
 * Without a carry the base was required to be clean, so reset+clean can only
 * ever remove the applied patch. With a carry the base holds the user's
 * uncommitted work, so only the paths the patch touched are restored: the
 * carried content from the carry commit, and the carried index state from the
 * index commit. Files the patch created are removed.
 */
function revertLanding(base, carry, appliedFiles = []) {
  if (!carry) {
    revertBase(base);
    return;
  }
  const carried = new Set(carriedFiles(base, carry.commit));
  const created = appliedFiles.filter((file) => !carried.has(file));
  const touched = appliedFiles.filter((file) => carried.has(file));
  for (const file of created) {
    const tracked = git(base, ['ls-files', '--', file]);
    if (gitOk(tracked) && tracked.stdout.trim()) {
      git(base, ['rm', '--cached', '--force', '--', file]);
    }
    try {
      fs.rmSync(path.join(base, file), { force: true });
    } catch {
      // best effort
    }
  }
  if (touched.length > 0) {
    git(base, ['restore', '--source', carry.commit, '--staged', '--worktree', '--', ...touched], {
      timeout: WORKTREE_COMMAND_TIMEOUT_MS,
    });
    if (carry.index_commit) {
      git(base, ['restore', '--source', carry.index_commit, '--staged', '--', ...touched], {
        timeout: WORKTREE_COMMAND_TIMEOUT_MS,
      });
    }
  }
}

/**
 * Code-level enforcement of plan ordering for worktree creation: the task
 * must exist in the plan and every depends_on task must be completed.
 */
export function checkTaskDependencies(root, taskId, session = '') {
  const id = String(taskId || '').trim();
  if (!id) return blocker('task_id is required', { rule: 'worktree.task_id' });
  const tasks = readPlan(root, session).tasks || [];
  const byId = new Map(tasks.map((task) => [String(task.id), task]));
  const task = byId.get(id);
  if (!task) {
    return blocker(
      `task is not in the plan: ${id}; call enhance_plan first`,
      { rule: 'worktree.unknown_task' },
    );
  }
  const missing = [];
  for (const dep of Array.isArray(task.depends_on) ? task.depends_on : []) {
    const dependency = byId.get(String(dep));
    if (!dependency) missing.push({ id: String(dep), status: 'missing' });
    else if (String(dependency.status) !== 'completed') {
      missing.push({ id: String(dep), status: String(dependency.status || 'pending') });
    }
  }
  if (missing.length > 0) {
    return blocker(
      `dependencies not completed: ${missing.map((item) => `${item.id}(${item.status})`).join(', ')}`,
      { rule: 'worktree.dependencies', missing },
    );
  }
  return { ok: true, task };
}

export function createWorktree(root, taskId, { session = '', carryBase = false } = {}) {
  const id = String(taskId || '').trim();
  if (!isValidTaskId(id)) {
    return blocker(
      `invalid task_id: ${id || '(empty)'}; use 1-64 chars of letters, digits, dot, dash, underscore`,
      { rule: 'worktree.task_id' },
    );
  }
  const plan = readPlan(root, session);
  const task = (plan.tasks || []).find((item) => item.id === id);
  if (task && String(task.status || '') === 'completed') {
    return blocker(`task ${id} is already completed; create a new task for follow-up work`, { rule: 'worktree.task_completed' });
  }
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!gitOk(inside) || inside.stdout.trim() !== 'true') {
    return blocker(
      `project is not a git worktree: ${root}${gitError(inside) ? ` (${gitError(inside)})` : ''}`,
      { rule: 'worktree.not_git' },
    );
  }
  const status = git(root, ['status', '--porcelain']);
  if (!gitOk(status)) {
    return blocker(`cannot read git status: ${gitError(status)}`, { rule: 'worktree.status' });
  }
  const dirty = String(status.stdout || '').split('\n').filter(Boolean);
  let carry = null;
  if (dirty.length > 0) {
    if (!carryBase) {
      return blocker(
        `working tree is not clean (${dirty.length} change(s)); commit or revert before creating a worktree: ${dirty.slice(0, 8).join(' | ')}. `
        + 'Pass carry_base=true to carry the uncommitted state into the worktree instead.',
        { rule: 'worktree.dirty' },
      );
    }
    carry = snapshotBase(root);
    if (!carry) {
      return blocker(
        `cannot snapshot the uncommitted state of ${root}; commit or revert it before creating a worktree`,
        { rule: 'worktree.carry_failed' },
      );
    }
  }

  const managed = canonicalPath(projectWorktreesDir(root, session));
  const target = canonicalPath(worktreePathFor(root, id, session));
  const repoRoot = canonicalPath(root);
  // The worktree must sit inside its managed directory and outside the
  // repository working tree, in both containment directions.
  if (!isWithin(managed, target)) {
    return blocker(`worktree path escapes the managed directory: ${target}`, { rule: 'worktree.path' });
  }
  if (isWithin(repoRoot, target) || isWithin(target, repoRoot) || repoRoot === target) {
    return blocker(
      `worktree would nest inside the project; state home must be outside the repo: ${target}`,
      { rule: 'worktree.path' },
    );
  }
  if (fs.existsSync(target)) {
    return blocker(`worktree path already exists: ${target}`, { rule: 'worktree.exists' });
  }

  fs.mkdirSync(managed, { recursive: true });
  // A carried base starts the worktree from the snapshot commit, so the worker
  // sees the uncommitted state it has to build on, and the diff against it
  // contains only the work the worker did.
  const add = git(root, ['worktree', 'add', '--detach', target, carry ? carry.commit : 'HEAD'], {
    timeout: WORKTREE_COMMAND_TIMEOUT_MS,
  });
  if (!gitOk(add)) {
    // Remove a half-created directory so retries start clean.
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return blocker(`git worktree add failed: ${gitError(add)}`, { rule: 'worktree.add_failed' });
  }
  const head = git(target, ['rev-parse', 'HEAD']);
  const entry = {
    task_id: id,
    path: target,
    head: gitOk(head) ? head.stdout.trim() : '',
    created_at: new Date().toISOString(),
    status: 'active',
  };
  if (carry) entry.carry = carry;
  upsertWorktree(root, id, entry, session);
  const planTask = updatePlanTask(root, id, { status: 'in_progress' }, session);
  return {
    ok: true,
    ...entry,
    task_status: planTask ? planTask.status : '',
    prompt_prefix: `task_id: ${id}\nworktree: ${target}\n`,
  };
}

export function listWorktrees(root, { limit = 50, session = '' } = {}) {
  const result = git(root, ['worktree', 'list', '--porcelain']);
  if (!gitOk(result)) {
    return blocker(`cannot list worktrees: ${gitError(result)}`, { rule: 'worktree.list_failed', worktrees: [] });
  }
  const registry = readWorktrees(root, session).worktrees || {};
  const entries = [];
  let current = null;
  for (const line of String(result.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      entries.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.trim() === 'detached') {
      current.detached = true;
    } else if (current && line.trim() === 'bare') {
      current.bare = true;
    } else if (line.trim() === '') {
      current = null;
    }
  }
  const mapped = entries.map((entry) => {
    const managedTask = managedTaskId(root, entry.path, session);
    const record = managedTask && registry[managedTask] ? registry[managedTask] : null;
    return {
      path: entry.path,
      head: entry.head || '',
      detached: Boolean(entry.detached),
      bare: Boolean(entry.bare),
      managed: Boolean(managedTask),
      task_id: record ? managedTask : '',
      status: record ? String(record.status || 'active') : '',
    };
  });
  const bounded = mapped.slice(0, limit);
  return { ok: true, worktrees: bounded, truncated: mapped.length > bounded.length };
}

function resolveWorktree(root, taskId, session = '') {
  const id = String(taskId || '').trim();
  if (!isValidTaskId(id)) {
    return blocker(`invalid task_id: ${id || '(empty)'}`, { rule: 'worktree.task_id' });
  }
  const registry = readWorktrees(root, session).worktrees || {};
  const entry = registry[id] || null;
  const target = canonicalPath(entry?.path || worktreePathFor(root, id, session));
  if (!managedTaskId(root, target, session)) {
    return blocker(
      `registered worktree is outside the managed directory: ${target}`,
      { rule: 'worktree.path' },
    );
  }
  return { ok: true, taskId: id, path: target, entry };
}

export function diffWorktree(
  root,
  taskId,
  { maxPatchChars = 40000, maxFiles = 200, includePatch = true, session = '' } = {},
) {
  const located = resolveWorktree(root, taskId, session);
  if (!located.ok) return located;
  if (!fs.existsSync(located.path)) {
    return blocker(`worktree does not exist on disk: ${located.path}`, { rule: 'worktree.missing' });
  }
  const status = git(located.path, ['status', '--porcelain', '--untracked-files=all']);
  if (!gitOk(status)) {
    return blocker(`cannot read worktree status: ${gitError(status)}`, { rule: 'worktree.status' });
  }
  // Mark untracked files intent-to-add so one diff against the creation base
  // covers committed, staged, unstaged, and untracked work. Workers may commit
  // inside the worktree; a diff against HEAD would then look empty. The
  // intent-to-add entries are removed again before returning so diff stays
  // observational.
  const untrackedResult = git(located.path, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ]);
  const untracked = gitOk(untrackedResult)
    ? String(untrackedResult.stdout || '').split('\0').filter(Boolean).slice(0, 100)
    : [];
  const intent = git(located.path, ['add', '-N', '--all']);
  if (!gitOk(intent)) {
    return blocker(`cannot mark untracked files for diff: ${gitError(intent)}`, { rule: 'worktree.diff_failed' });
  }
  const diffRef = String(located.entry?.head || '').trim() || 'HEAD';
  const namesResult = git(located.path, ['diff', '--name-only', diffRef]);
  if (!gitOk(namesResult)) {
    return blocker(`cannot list changed files: ${gitError(namesResult)}`, { rule: 'worktree.diff_failed' });
  }
  const files = String(namesResult.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let patch = '';
  if (includePatch) {
    const diff = git(located.path, ['diff', '--no-color', diffRef], {
      timeout: WORKTREE_COMMAND_TIMEOUT_MS,
    });
    if (!gitOk(diff)) {
      return blocker(`git diff failed: ${gitError(diff)}`, { rule: 'worktree.diff_failed' });
    }
    patch = String(diff.stdout || '');
  }
  if (untracked.length > 0) {
    git(located.path, ['reset', '--quiet', '--', ...untracked]);
  }
  const patchCap = Math.max(0, Number(maxPatchChars) || 0);
  const fileCap = Math.max(0, Number(maxFiles) || 0);
  const boundedPatch = patch.slice(0, patchCap);
  const boundedFiles = files.slice(0, fileCap);
  return {
    ok: true,
    task_id: located.taskId,
    path: located.path,
    head: diffRef,
    changed_files: boundedFiles,
    changed_count: files.length,
    patch: boundedPatch,
    truncated: patch.length > boundedPatch.length || files.length > boundedFiles.length,
  };
}

/** Undo a landing on the base checkout. Used only after the patch made it
 * onto disk (or a commit attempt failed): because a clean base is required
 * before applying, reset+clean can only ever remove the applied patch, never
 * pre-existing work, and HEAD stays at its pre-land commit. */
function revertBase(base) {
  git(base, ['reset', '--hard', 'HEAD'], { timeout: WORKTREE_COMMAND_TIMEOUT_MS });
  git(base, ['clean', '-fd'], { timeout: WORKTREE_COMMAND_TIMEOUT_MS });
}

function briefFindingSummary(item) {
  return {
    level: String(item?.level || ''),
    rule: String(item?.rule || ''),
    message: String(item?.message || '').slice(0, 300),
  };
}

/**
 * Land a task worktree's work back onto the main checkout as a patch, with a
 * safe integration flow:
 *
 * - resolve like diff/remove, require a clean base, stage everything inside
 *   the isolated worktree (`git add -A`, never committed) so the patch covers
 *   BOTH tracked and untracked files, then apply only after
 *   `git apply --check` succeeds.
 * - A worktree created with `carry_base=true` is the exception to the clean
 *   base rule: its base holds the carried uncommitted state, so the land
 *   checks that the base still holds it (`worktree.base_changed` otherwise),
 *   and a failure restores only the patched paths, not the whole checkout.
 * - run_checks (default true): `inputs` is a pre-apply preflight on the
 *   clean base; the remaining brief checks run against the BASE checkout
 *   after applying. A post-apply `inputs` run would hash the worker's own
 *   edits and fail by design, so it is excluded from the post-apply set.
 *   No brief skips the gate with a warning; invented check sets are never
 *   assumed.
 * - A failed preflight is a blocker with `inputs_preflight`; nothing is
 *   applied or reverted. Whatever ran post-apply is recorded as the
 *   durable last-check, on success (landed) and on failure (land_required).
 * - On any failure after applying (checks, staging, commit), the base is
 *   reverted to its pre-land HEAD state and the worktree is kept intact, so
 *   the worker can fix and re-land. Landing is all-or-nothing.
 * - commit (default false): with checks passing, `git add -A` plus one new
 *   commit `harness: land <task_id>`. A deterministic harness identity is used
 *   only when the checkout cannot author a commit itself. Existing history is
 *   never amended or reset; removal of the worktree stays explicit.
 */
export function landWorktree(
  root,
  taskId,
  { maxPatchChars = 40000, maxFiles = 200, runChecks = true, commit = false, session = '' } = {},
) {
  const located = resolveWorktree(root, taskId, session);
  if (!located.ok) return located;
  if (!fs.existsSync(located.path)) {
    return blocker(`worktree does not exist on disk: ${located.path}`, { rule: 'worktree.missing' });
  }
  const base = canonicalPath(root);
  const carry = located.entry?.carry || null;
  if (carry) {
    // The base holds the user's uncommitted work. It must still be exactly
    // the state the worktree was carried from, otherwise landing would
    // overwrite newer work and a revert could not restore what it replaced.
    if (!baseHoldsCarry(base, carry)) {
      return {
        ...blocker(
          'the base checkout changed after the worktree was carried; landing it now would overwrite newer work. '
          + 'Recreate the worktree from the current base and run the task again.',
          { rule: 'worktree.base_changed' },
        ),
        task_id: located.taskId,
        worktree: located.path,
        base,
      };
    }
  } else {
    const clean = assertCleanRepo(base, 'before landing a patch');
    if (!clean.ok) return clean;
  }

  // Read the brief before touching anything: when the checks include
  // `inputs`, that hash comparison must run against the clean base, before
  // the patch lands. The worker's own edits to input files would otherwise
  // guarantee a false inputs.changed on the applied base.
  let brief = null;
  let config = null;
  if (runChecks) {
    brief = readBrief(base, session);
    if (brief) ({ config } = loadConfig(base));
  }
  const effectiveChecks = brief
    ? (Array.isArray(brief.checks) && brief.checks.length
      ? brief.checks
      : defaultChecks(brief.profile, brief.pairs || [])).map((id) => String(id))
    : [];
  let inputsPreflight = 'skipped';
  if (brief && effectiveChecks.includes('inputs')) {
    const preflight = runBriefChecks(base, brief, config, ['inputs'], { session });
    if (!preflight.ok) {
      inputsPreflight = 'failed';
      return {
        ...blocker(
          `inputs preflight failed on the clean base; nothing was applied: ${(preflight.findings || [])
            .filter((item) => item.level === 'blocker')
            .map((item) => item.rule)
            .join(', ') || 'see findings'}`,
          { rule: 'worktree.inputs_preflight' },
        ),
        task_id: located.taskId,
        worktree: located.path,
        base,
        inputs_preflight: inputsPreflight,
        findings: (preflight.findings || []).slice(0, 20).map(briefFindingSummary),
      };
    }
    inputsPreflight = 'passed';
  }

  // The worktree belongs to one task and is isolated, so staging everything
  // here is safe; it is how untracked files make it into the patch.
  const stage = git(located.path, ['add', '-A'], { timeout: WORKTREE_COMMAND_TIMEOUT_MS });
  if (!gitOk(stage)) {
    return blocker(`cannot stage worktree changes: ${gitError(stage)}`, { rule: 'worktree.stage_failed' });
  }
  const diffRef = String(located.entry?.head || '').trim() || 'HEAD';
  const diff = git(located.path, ['diff', diffRef, '--binary'], {
    timeout: WORKTREE_COMMAND_TIMEOUT_MS,
  });
  if (!gitOk(diff)) {
    return blocker(`git diff failed: ${gitError(diff)}`, { rule: 'worktree.diff_failed' });
  }
  const patch = String(diff.stdout || '');
  if (!patch.trim()) {
    return blocker('worktree has no changes to land', { rule: 'worktree.empty' });
  }
  const names = git(located.path, ['diff', '--name-only', diffRef]);
  if (!gitOk(names)) {
    return blocker(`cannot list changed files: ${gitError(names)}`, { rule: 'worktree.diff_failed' });
  }
  const appliedFiles = String(names.stdout || '').split('\n').filter(Boolean);

  // git apply is all-or-nothing, and --check runs first, so a rejected patch
  // never leaves a partial landing behind.
  const applyOptions = {
    input: patch,
    encoding: 'utf8',
    timeout: WORKTREE_COMMAND_TIMEOUT_MS,
  };
  const check = spawnSync('git', ['-C', base, 'apply', '--check', '-'], applyOptions);
  if (!gitOk(check)) {
    return blocker(
      `patch does not apply cleanly to the base checkout: ${gitError(check)}`,
      { rule: 'worktree.apply_check' },
    );
  }
  const apply = spawnSync('git', ['-C', base, 'apply', '-'], applyOptions);
  if (!gitOk(apply)) {
    // git apply is atomic, so this should not trigger; revert defensively and
    // never leave a partial landing behind.
    revertLanding(base, carry, appliedFiles);
    return {
      ...blocker(
        `git apply failed after a successful check; base reverted: ${gitError(apply)}`,
        { rule: 'worktree.apply_failed' },
      ),
      task_id: located.taskId,
      worktree: located.path,
      base,
      reverted: true,
    };
  }

  const warnings = [];
  let checks = { ran: false, skipped: true, ok: true, checked: [], findings: [], summary: null };
  let postResult = null;
  if (runChecks) {
    if (!brief) {
      warnings.push('no brief: deterministic checks were skipped; call enhance_brief to gate landings');
    } else {
      // `inputs` already ran as the pre-apply preflight; re-running it on
      // the applied base would fail on the worker's own edits by design.
      const postIds = effectiveChecks.filter((id) => id !== 'inputs');
      if (postIds.length === 0) {
        postResult = {
          version: 1,
          ok: true,
          checked: [],
          findings: [],
          summary: { blockers: 0, warnings: 0, infos: 0 },
          elapsed_ms: 0,
          at: new Date().toISOString(),
        };
        checks = {
          ran: true,
          skipped: false,
          ok: true,
          checked: [],
          findings: [],
          summary: postResult.summary,
        };
        warnings.push('inputs ran as a pre-apply preflight; no post-apply checks remain');
      } else {
        const result = runBriefChecks(base, brief, config, postIds, { session });
        postResult = result;
        const findings = (result.findings || []).slice(0, 20);
        checks = {
          ran: true,
          skipped: false,
          ok: Boolean(result.ok),
          checked: result.checked || [],
          findings: findings.map(briefFindingSummary),
          truncated: (result.findings || []).length > 20,
          summary: result.summary || null,
        };
        if (!result.ok) {
          // The landed patch does not pass the gate on the base checkout:
          // record the failed check, roll the base back, and keep the
          // worktree for a fix and re-land.
          writeLastCheck(base, {
            ...result,
            task_ids: [located.taskId],
            worktree: located.path,
            worktree_task_id: located.taskId,
            land_required: true,
            landed: false,
            inputs_preflight: inputsPreflight,
          }, session);
          revertLanding(base, carry, appliedFiles);
          const blockers = checks.findings
            .filter((item) => item.level === 'blocker')
            .map((item) => item.rule)
            .join(', ');
          return {
            ...blocker(
              `landed patch failed brief checks on the base checkout (${blockers || 'see findings'}); base reverted to its pre-land state, worktree kept for a fix and re-land`,
              { rule: 'worktree.checks_failed' },
            ),
            task_id: located.taskId,
            checks,
            worktree: located.path,
            base,
            reverted: true,
            inputs_preflight: inputsPreflight,
          };
        }
      }
    }
  } else {
    warnings.push('run_checks=false: deterministic checks skipped by request');
  }

  let commitInfo = { created: false, hash: '', subject: '', identity: '' };
  if (commit) {
    const subject = `harness: land ${located.taskId}`;
    // A carried base keeps the user's uncommitted work out of the landing
    // commit: only the landed paths are staged and committed, so the carried
    // work stays exactly as uncommitted as it was.
    const add = carry
      ? git(base, ['add', '--', ...appliedFiles])
      : git(base, ['add', '-A']);
    if (!gitOk(add)) {
      revertLanding(base, carry, appliedFiles);
      return {
        ...blocker(`cannot stage the landed patch on the base: ${gitError(add)}`, { rule: 'worktree.stage_failed' }),
        task_id: located.taskId,
        checks,
        worktree: located.path,
        base,
        reverted: true,
      };
    }
    // Use the checkout's own identity when it can author a commit; fall back
    // to a deterministic harness identity otherwise. Never amend or reset.
    const identity = identityArgs(base);
    const made = carry
      ? git(base, [...identity, 'commit', '--quiet', '-m', subject, '--', ...appliedFiles])
      : git(base, [...identity, 'commit', '--quiet', '-m', subject]);
    if (!gitOk(made)) {
      revertLanding(base, carry, appliedFiles);
      return {
        ...blocker(`landing commit failed; base reverted: ${gitError(made)}`, { rule: 'worktree.commit_failed' }),
        task_id: located.taskId,
        checks,
        worktree: located.path,
        base,
        reverted: true,
      };
    }
    const head = git(base, ['rev-parse', 'HEAD']);
    commitInfo = {
      created: true,
      hash: gitOk(head) ? head.stdout.trim() : '',
      subject,
      identity: identity.length === 0 ? 'repo' : 'harness',
    };
    warnings.push('commit created on the base; the worktree is reset and can be removed');
  }

  // The patch is now on the base and checks passed, so the worktree has done
  // its job. Reset it to the creation base to discard the duplicate copy and
  // make an explicit remove clean. A reset failure never invalidates the
  // landing; it only leaves cleanup to the caller.
  const cleanup = git(located.path, ['reset', '--hard', diffRef], {
    timeout: WORKTREE_COMMAND_TIMEOUT_MS,
  });
  if (gitOk(cleanup)) {
    git(located.path, ['clean', '-fd'], { timeout: WORKTREE_COMMAND_TIMEOUT_MS });
    upsertWorktree(root, located.taskId, {
      status: 'landed',
      landed_at: new Date().toISOString(),
      landed_files: appliedFiles,
    }, session);
  } else {
    upsertWorktree(root, located.taskId, {
      status: 'landed',
      landed_at: new Date().toISOString(),
      landed_files: appliedFiles,
      cleanup_error: gitError(cleanup),
    }, session);
    warnings.push(`worktree could not be reset after landing: ${gitError(cleanup)}; remove may require discard=true`);
  }
  const planTask = updatePlanTask(root, located.taskId, { status: 'completed' }, session);

  // The landed patch is the authoritative last-check for a code task:
  // record it so the capsule, the verification gate, and the dispatch gate
  // all see "verified and landed" without another enhance_check round.
  if (postResult) {
    writeLastCheck(base, {
      ...postResult,
      task_ids: [located.taskId],
      worktree: located.path,
      worktree_task_id: located.taskId,
      land_required: false,
      landed: true,
      inputs_preflight: inputsPreflight,
    }, session);
  }

  const patchCap = Math.max(0, Number(maxPatchChars) || 0);
  const fileCap = Math.max(0, Number(maxFiles) || 0);
  const boundedPatch = patch.slice(0, patchCap);
  const boundedFiles = appliedFiles.slice(0, fileCap);
  return {
    ok: true,
    task_id: located.taskId,
    applied_files: boundedFiles,
    applied_count: appliedFiles.length,
    patch_bytes: Buffer.byteLength(patch, 'utf8'),
    patch: boundedPatch,
    truncated: patch.length > boundedPatch.length || appliedFiles.length > boundedFiles.length,
    worktree: located.path,
    base,
    checks,
    inputs_preflight: inputsPreflight,
    commit: commitInfo,
    warnings,
    task_status: planTask ? planTask.status : '',
    note: commitInfo.created
      ? 'checks passed and the landed patch was committed on the base; the worktree is clean and can be removed'
      : 'patch applied to the base checkout and checks passed; the base is dirty by design, so commit from the conductor if needed; the worktree is clean and can be removed',
  };
}

export function removeWorktree(root, taskId, { discard = false, session = '' } = {}) {
  const located = resolveWorktree(root, taskId, session);
  if (!located.ok) return located;
  if (!fs.existsSync(located.path)) {
    // Directory is gone (deleted outside git): prune metadata and registry.
    git(root, ['worktree', 'prune']);
    removeWorktreeEntry(root, located.taskId, session);
    return {
      ok: true,
      task_id: located.taskId,
      path: located.path,
      removed: false,
      note: 'worktree directory was already gone; metadata pruned',
    };
  }
  const status = git(located.path, ['status', '--porcelain']);
  if (!gitOk(status)) {
    return blocker(`cannot read worktree status: ${gitError(status)}`, { rule: 'worktree.status' });
  }
  const dirty = String(status.stdout || '').split('\n').filter(Boolean);
  const landed = String(located.entry?.status || '') === 'landed';
  if (dirty.length > 0 && !(discard && landed)) {
    return blocker(
      landed
        ? `worktree has uncommitted changes after landing; pass discard=true to remove the landed copy: ${dirty.slice(0, 8).join(' | ')}`
        : `worktree has uncommitted changes; refusing to remove: ${dirty.slice(0, 8).join(' | ')}`,
      { rule: landed ? 'worktree.discard_required' : 'worktree.dirty' },
    );
  }
  const args = ['worktree', 'remove'];
  if (dirty.length > 0) args.push('--force');
  args.push(located.path);
  const remove = git(root, args, {
    timeout: WORKTREE_COMMAND_TIMEOUT_MS,
  });
  if (!gitOk(remove)) {
    return blocker(`git worktree remove failed: ${gitError(remove)}`, { rule: 'worktree.remove_failed' });
  }
  removeWorktreeEntry(root, located.taskId, session);
  return { ok: true, task_id: located.taskId, path: located.path, removed: true };
}

/**
 * Validate a caller-supplied worktree path for a project. The path must be
 * managed for this project (inside the managed directory or present in the
 * worktree registry) and must belong to the same git repository. This is the
 * single choke point against path traversal via worktree arguments.
 */
export function validateWorktree(root, candidate, session = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return blocker('worktree path is empty', { rule: 'worktree.path' });
  const target = canonicalPath(raw);
  if (!fs.existsSync(target)) {
    return blocker(`worktree path does not exist: ${target}`, { rule: 'worktree.missing' });
  }
  const managed = Boolean(managedTaskId(root, target, session));
  const registry = readWorktrees(root, session).worktrees || {};
  const known = Object.values(registry).some(
    (entry) => entry?.path && canonicalPath(entry.path) === target,
  );
  if (!managed && !known) {
    return blocker(
      `worktree is not managed for this project: ${target}`,
      { rule: 'worktree.foreign' },
    );
  }
  const inside = git(target, ['rev-parse', '--is-inside-work-tree']);
  if (!gitOk(inside) || inside.stdout.trim() !== 'true') {
    return blocker(
      `worktree path is not a git worktree: ${target}`,
      { rule: 'worktree.not_git' },
    );
  }
  const mine = commonDir(root);
  const theirs = commonDir(target);
  if (!mine || !theirs) {
    return blocker('cannot verify worktree ownership with git', { rule: 'worktree.verify' });
  }
  if (mine !== theirs) {
    return blocker(
      `worktree belongs to a different repository: ${target}`,
      { rule: 'worktree.foreign_repo' },
    );
  }
  return { ok: true, path: target };
}
