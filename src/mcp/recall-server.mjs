#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig } from '../core/config.mjs';
import { resolveProject } from '../core/state-root.mjs';
import { buildCapsule, workerContract } from '../core/capsule.mjs';
import { buildBrief } from '../core/brief.mjs';
import { runBriefChecks, validateBriefChecks } from '../core/checks.mjs';
import { getArtifact, searchArtifacts, isHandle } from '../core/artifacts.mjs';
import {
  appendDecision,
  readBrief,
  readJobs,
  readPlan,
  readWorktrees,
  resolveSessionId,
  updatePlanTask,
  upsertJob,
  writeBrief,
  writeGoal,
  writeLastCheck,
  writePlan,
} from '../core/store.mjs';
import { scheduleNext } from '../core/attention.mjs';
import {
  checkTaskDependencies,
  createWorktree,
  diffWorktree,
  landWorktree,
  listWorktrees,
  removeWorktree,
  validateWorktree,
} from '../core/worktree.mjs';

const PROJECT_PROP = {
  type: 'string',
  description: 'Workspace root or any path inside it. Use the PROJECT value from the capsule.',
};

const SESSION_PROP = {
  type: 'string',
  description: 'Session shard id. Use the SESSION value from the capsule when the workspace has multiple sessions.',
};

const SERVER_STARTED_AT = new Date().toISOString();

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text ?? '') }],
    isError,
  };
}

function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function contextFor(args = {}, { tolerateAmbiguity = false } = {}) {
  // Resolve from the call, the server env, or the server's cwd. Do not use the
  // global active.json here: two workspaces can be open at the same time and
  // the active file would make one session read another's state.
  const candidate = args.project
    || process.env.MY_HARNESS_ENHANCE_PROJECT
    || process.cwd();
  if (!candidate) {
    throw new Error('no workspace selected: pass project=<workspace root> from the capsule');
  }
  const project = resolveProject(candidate);
  if (!project) {
    throw new Error(
      `workspace is not registered: ${candidate}. Open a Qoder session in it first.`,
    );
  }
  const { config, exists } = loadConfig(project.projectRoot);
  if (!exists) {
    throw new Error(`workspace has no enhancement state: ${candidate}`);
  }
  // Session resolution order: explicit argument, server env, the most recent
  // sessions.json entry for this host process, then a unique session dir.
  // No session (legacy single-session install) keeps project-level state.
  let session = '';
  try {
    session = resolveSessionId(project.projectRoot, {
      explicit: args.session || process.env.MY_HARNESS_ENHANCE_SESSION || '',
      hostPid: process.ppid,
    });
  } catch (error) {
    // Project-level tools (decide/capabilities/artifact/contract) stay usable
    // even when no single shard can be inferred; session state tools surface
    // the ambiguity so the conductor passes the SESSION value.
    if (!tolerateAmbiguity) throw error;
  }
  return { root: project.projectRoot, config, session };
}

const TOOLS = [
  {
    name: 'enhance_state',
    description: 'Return the compact conductor capsule for a workspace: goal, acceptance, constraints, plan, active jobs, worker mapping, decisions, artifacts.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROP, session: SESSION_PROP },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_goal',
    description: 'Set or replace the canonical goal, acceptance criteria, and hard constraints.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        text: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        replace: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_brief',
    description: 'Create or read the shared task brief: profile, input hashes, source/target pairs, glossary, ownership, and deterministic checks. Checks are ids only: inputs, docs, scope, command:test/lint/typecheck/build, or a registered command; never shell strings. Defaults: docs=inputs+docs, code=scope+command:test. Call this before fan-out.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        profile: { type: 'string', enum: ['general', 'docs', 'code', 'research', 'ops'] },
        inputs: { type: 'array', items: { type: 'string' } },
        pairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
            },
            required: ['source', 'target'],
          },
        },
        glossary: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
              mode: { type: 'string', enum: ['translate', 'keep'] },
            },
          },
        },
        ownership: { type: 'array', items: { type: 'string' } },
        checks: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        replace: { type: 'boolean' },
        full: { type: 'boolean', description: 'Return the whole brief instead of a receipt.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_plan',
    description: 'Read or update the task graph. Each task requires id; title is optional and falls back to task or id. Workspace cwd is used when project is omitted. A task is a delivery unit: merge small independent files into one task; never create verify/cleanup/commit tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              task: { type: 'string', description: 'Alias for title.' },
              status: { type: 'string' },
              worker: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'string' },
              next_action: { type: 'string', description: 'The single next action for this task (<=200 chars).' },
              blockers: { type: 'array', items: { type: 'string' }, description: 'Why this task cannot proceed (<=5 entries).' },
              priority: { type: 'integer', description: '1 (do first) to 9 (do last); default 3.' },
              cost_of_miss: { type: 'string', description: 'What breaks if this task slips (<=200 chars).' },
              authority: { type: 'string', description: 'Who says the task is real: user, brief, worker, conductor.' },
              confidence: { type: 'number', description: '0..1 confidence that the task as written is right.' },
            },
            required: ['id'],
            additionalProperties: true,
          },
        },
        replace: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_decide',
    description: 'Append a decision with rationale to the durable decision log.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        decision: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_job',
    description: 'List, inspect, update, or cancel worker jobs. Results are summaries, never transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        action: { type: 'string', enum: ['list', 'get', 'update', 'cancel'] },
        job_id: { type: 'string' },
        status: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_check',
    description: 'Run registered deterministic checks for the current brief. Checker ids: inputs, docs, scope, command:test/lint/typecheck/build, or a registered command. Returns bounded findings; never raw files. For a code task with an active worktree, pass that worktree so the check audits the isolated work; on pass, code tasks stay in_progress until enhance_worktree land succeeds. Docs and non-worktree checks mark task ids completed on pass.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        checkers: { type: 'array', items: { type: 'string' } },
        task_ids: { type: 'array', items: { type: 'string' } },
        worktree: {
          type: 'string',
          description: 'Optional worktree path created by enhance_worktree for this project. Must be a managed worktree of the same repository.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_worktree',
    description: 'Isolated git worktrees per code task: create (requires a planned task_id whose depends_on tasks are all completed and a clean repo; returns prompt_prefix with the exact task_id/worktree lines), list, diff (bounded patch; committed work included), land (apply committed, staged, unstaged and untracked work onto a clean base checkout; runs the brief checks against the base by default and reverts the base on failure, keeping the worktree for a re-land; commit=true creates one "harness: land <task_id>" commit, opt-in; on success marks the task completed and resets the worktree for removal), remove (discard=true only after landing). Worktrees live under ~/.my-harness-enhance/worktrees/<projectKey>/<sessionKey>/<taskId>.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session: SESSION_PROP,
        action: { type: 'string', enum: ['create', 'list', 'diff', 'land', 'remove'] },
        task_id: { type: 'string', description: 'Plan task id. Required for create, diff, land, and remove.' },
        carry_base: {
          type: 'boolean',
          description: 'Create action only: carry the uncommitted state of the base checkout into the new worktree instead of refusing a dirty base (default false). The base keeps its uncommitted work untouched; landing adds the task work on top of it.',
        },
        run_checks: {
          type: 'boolean',
          description: 'Land action only: run the current brief checks against the base checkout after applying (default true). On failure the base is fully reverted and the worktree kept. No brief: checks skipped with a warning.',
        },
        commit: {
          type: 'boolean',
          description: 'Land action only: after passing checks, git add -A and create one commit "harness: land <task_id>" (default false). Never amends or resets existing history; on success the worktree is reset and can be removed.',
        },
        discard: {
          type: 'boolean',
          description: 'Remove action only: discard uncommitted changes in a worktree whose status is landed (default false). Refused for unlanded worktrees.',
        },
        include_patch: {
          type: 'boolean',
          description: 'Land action only: include the applied patch text in the response (default false). The patch otherwise stays on disk and is summarized by counts and file paths.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_recall',
    description: 'Bounded retrieval: search artifacts by query or read a specific artifact handle. Never returns a full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        query: { type: 'string' },
        handle: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_artifact',
    description: 'Read a bounded slice of one artifact by handle.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        handle: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
  },
  {
    name: 'enhance_capabilities',
    description: 'Return the resolved worker capabilities for a workspace: role -> native agent, fallbacks, policies, gaps.',
    inputSchema: { type: 'object', properties: { project: PROJECT_PROP }, additionalProperties: false },
  },
  {
    name: 'enhance_worker_contract',
    description: 'Return the worker envelope contract for a delegation prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        agent_type: { type: 'string' },
        role: { type: 'string' },
        job_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

function toolEnhanceState(args = {}) {
  const { root, config, session } = contextFor(args);
  const capsule = buildCapsule(root, { maxTokens: config.context.maxCapsuleTokens, session });
  return textResult(capsule || '(empty state)');
}

function toolEnhanceGoal(args = {}) {
  const { root, session } = contextFor(args);
  const goal = writeGoal(root, {
    text: args.text || args.goal || '',
    acceptance: args.acceptance || [],
    constraints: args.constraints || [],
    replace: Boolean(args.replace),
  }, session);
  return jsonResult(goal);
}

function briefReceipt(brief, previous) {
  const keys = ['profile', 'inputs', 'pairs', 'glossary', 'ownership', 'checks', 'notes'];
  const changed = keys.filter((key) => (
    JSON.stringify(brief?.[key] ?? null) !== JSON.stringify(previous?.[key] ?? null)
  ));
  return {
    ok: true,
    profile: brief?.profile || '',
    checks: brief?.checks || [],
    inputs: (brief?.inputs || []).length,
    pairs: (brief?.pairs || []).length,
    changed,
    hint: 'pass full=true to read the whole brief',
  };
}

function toolEnhanceBrief(args = {}) {
  const { root, config, session } = contextFor(args);
  const hasPatch = ['profile', 'inputs', 'pairs', 'glossary', 'ownership', 'checks', 'notes']
    .some((key) => key in args);
  const current = readBrief(root, session);
  if (!hasPatch) {
    if (!current) return textResult('(no brief)');
    return jsonResult(args.full === true ? current : briefReceipt(current, null));
  }
  const brief = buildBrief(root, args, current);
  validateBriefChecks(brief.checks, config, brief.profile);
  const saved = writeBrief(root, brief, session);
  // The brief is injected into every worker; echoing it back cost ~425 tokens
  // per call for information the conductor had just supplied.
  return jsonResult(args.full === true ? saved : briefReceipt(saved, current));
}

/**
 * A plan task is a delivery unit, never a step. The harness itself runs checks,
 * commit/land and cleanup, so a task titled with only that duty is a splitting
 * error with no work of its own; exact-match keeps real titles ("verify webhook
 * signatures") out of the gate.
 */
const STEP_TITLES = new Set([
  'verify', 'verification', 'check', 'checks', 'checking', 'run tests', 'test',
  'tests', 'commit', 'land', 'merge', 'cleanup', 'clean up', 're-test', 'retest',
]);

function stepTasks(tasks = []) {
  return tasks
    .filter((task) => {
      const title = String(task?.title || task?.task || '').trim().toLowerCase();
      return STEP_TITLES.has(title);
    })
    .map((task) => String(task?.id || '(no id)'));
}

function planSummary(plan) {
  const tasks = plan.tasks || [];
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const schedule = scheduleNext(plan);
  const top = schedule.candidates[0];
  return {
    ok: true,
    tasks: tasks.length,
    counts,
    gate: schedule.gate,
    debt: schedule.debt,
    next: top ? { id: top.id, title: top.title, status: top.status, reason: top.reason } : null,
    ids: tasks.map((task) => task.id),
  };
}

function toolEnhancePlan(args = {}) {
  const { root, session } = contextFor(args);
  if (!Array.isArray(args.tasks)) {
    const plan = readPlan(root, session);
    return jsonResult({ ...plan, schedule: scheduleNext(plan) });
  }
  const tooSmall = stepTasks(args.tasks);
  if (tooSmall.length) {
    return textResult(
      `plan rejected: ${tooSmall.join(', ')} name a harness duty (verify/check/commit/land/cleanup), not a delivery unit. `
      + 'Merge it into the task it belongs to; the harness runs checks and land itself.',
      true,
    );
  }
  const plan = writePlan(root, args.tasks, { replace: Boolean(args.replace) }, session);
  // A write acknowledges the change instead of echoing every task back: the
  // capsule already carries the plan, and the echo was the conductor's largest
  // single MCP cost.
  return jsonResult(planSummary(plan));
}

function toolEnhanceDecide(args = {}) {
  const { root, session } = contextFor(args, { tolerateAmbiguity: true });
  // Decisions stay project-level; the entry carries the session when known.
  const entry = appendDecision(root, args.decision, args.rationale, session);
  return entry ? jsonResult(entry) : textResult('decision is required', true);
}

function jobSummary(job) {
  return {
    id: job.id,
    agent_id: job.agent_id,
    type: job.type,
    role: job.role,
    status: job.status,
    depth: job.depth,
    task_id: job.task_id || job.envelope?.task_id || '',
    created_at: job.created_at,
    updated_at: job.updated_at,
    result_handle: job.result_handle || null,
    summary: job.envelope?.summary || '',
    error: job.error || '',
    retryable: Boolean(job.retryable),
    error_class: job.error_class || '',
    attempts: Number(job.attempts || 0),
    dead_letter: Boolean(job.dead_letter),
    next: job.next || '',
    check_ok: job.envelope?.check_result?.ok ?? null,
  };
}

function toolEnhanceJob(args = {}) {
  const { root, session } = contextFor(args);
  const action = String(args.action || 'list');
  const jobs = readJobs(root, session).jobs || [];
  if (action === 'list') return jsonResult(jobs.slice(-30).map(jobSummary));
  const job = jobs.find((item) => item.id === args.job_id || item.agent_id === args.job_id);
  if (!job) return textResult(`job not found: ${args.job_id || '(missing)'}`, true);
  if (action === 'get') return jsonResult(jobSummary(job));
  if (action === 'cancel') {
    const next = upsertJob(root, job.id, { status: 'cancelled', note: args.note || '' }, session);
    return jsonResult(jobSummary(next));
  }
  if (action === 'update') {
    const next = upsertJob(root, job.id, {
      status: args.status || job.status,
      note: args.note || job.note || '',
    }, session);
    return jsonResult(jobSummary(next));
  }
  return textResult(`unsupported action: ${action}`, true);
}

function toolEnhanceCheck(args = {}) {
  const { root, config, session } = contextFor(args);
  const brief = readBrief(root, session);
  if (!brief) return textResult('no brief: call enhance_brief before enhance_check', true);
  const checkers = Array.isArray(args.checkers) && args.checkers.length ? args.checkers : null;
  const taskIds = Array.isArray(args.task_ids) ? args.task_ids.map(String) : [];
  const registry = readWorktrees(root, session).worktrees || {};
  const code = String(brief.profile || '') === 'code';
  let worktree = '';
  if (args.worktree) {
    const located = validateWorktree(root, String(args.worktree), session);
    if (!located.ok) {
      return jsonResult({ ok: false, blocker: located.blocker || 'invalid worktree path' }, true);
    }
    worktree = located.path;
  }
  const activeForTask = taskIds
    .map((id) => ({ id, entry: registry[id] }))
    .find(({ entry }) => entry?.path && String(entry.status || 'active') !== 'landed');
  const anyActive = Object.entries(registry).find(
    ([, entry]) => entry?.path && String(entry.status || 'active') !== 'landed',
  );
  const blocking = activeForTask || (taskIds.length === 0 ? anyActive : null);
  if (code && !worktree && blocking) {
    const id = activeForTask?.id || anyActive?.[0] || '';
    const path = activeForTask?.entry?.path || anyActive?.[1]?.path || '';
    return jsonResult({
      ok: false,
      rule: 'worktree.check_required',
      blocker: `task ${id || '(unassigned)'} has an active worktree; run enhance_check with worktree: ${path} so the check audits the isolated work, not the clean base`,
      task_id: id,
      worktree: path,
    }, true);
  }
  if (code && !worktree && taskIds.length > 0) {
    const missing = taskIds.find((id) => String(registry[id]?.status || '') !== 'landed');
    if (missing) {
      return jsonResult({
        ok: false,
        rule: 'worktree.required',
        blocker: `code task ${missing} must be isolated: call enhance_worktree create task_id=${missing}, dispatch there, then run enhance_check with that worktree (or land it first)`,
        task_id: missing,
      }, true);
    }
  }
  const result = runBriefChecks(root, brief, config, checkers, { worktree, session });
  result.task_ids = taskIds;
  result.worktree = worktree;
  const planIds = new Set((readPlan(root, session).tasks || []).map((task) => String(task.id)));
  const unknownIds = taskIds.filter((id) => !planIds.has(id));
  if (unknownIds.length > 0) {
    result.findings = [
      ...(result.findings || []),
      {
        level: 'warning',
        rule: 'plan.task_missing',
        message: `task id(s) not in the plan: ${unknownIds.join(', ')}; create them with enhance_plan if they should be tracked`,
      },
    ];
    result.summary = {
      ...(result.summary || {}),
      warnings: Number(result.summary?.warnings || 0) + unknownIds.length,
    };
  }
  const matching = worktree
    ? Object.entries(registry).find(([, entry]) => entry?.path === worktree)
    : null;
  const ownerId = matching ? matching[0] : (activeForTask?.id || '');
  const worktreeLanded = matching ? String(matching[1]?.status || 'active') === 'landed' : false;
  result.worktree_task_id = ownerId;
  result.land_required = Boolean(
    code
    && (
      (worktree && (ownerId ? !worktreeLanded : true))
      || taskIds.some((id) => registry[id]?.path && String(registry[id]?.status || 'active') !== 'landed')
    )
  );
  const saved = writeLastCheck(root, result, session);
  const completed = [];
  const pendingLand = [];
  const blockedByLand = [];
  if (saved.ok && taskIds.length > 0) {
    for (const id of taskIds) {
      if (saved.land_required) {
        if (id === ownerId) {
          if (updatePlanTask(root, id, { status: 'in_progress' }, session)) pendingLand.push(id);
        } else {
          // A dependent/verification task cannot complete before the worktree
          // owner lands; that would make the plan claim verification happened
          // before the implementation was delivered.
          blockedByLand.push(id);
        }
      } else if (updatePlanTask(root, id, { status: 'completed' }, session)) {
        completed.push(id);
      }
    }
    if (saved.land_required && ownerId && !taskIds.includes(ownerId)) {
      if (updatePlanTask(root, ownerId, { status: 'in_progress' }, session)) pendingLand.push(ownerId);
    }
  }
  return jsonResult({
    ...saved,
    task_ids_completed: completed,
    task_ids_pending_land: pendingLand,
    task_ids_blocked_by_land: blockedByLand,
  });
}

function trimWorktreeResult(result, { includePatch = false } = {}) {
  if (!result || typeof result !== 'object') return result;
  const {
    patch, carry, created_at, updated_at, base, ...rest
  } = result;
  if (!includePatch) rest.patch_omitted = typeof patch === 'string' && patch.length > 0;
  else rest.patch = patch;
  if (rest.commit && typeof rest.commit === 'object' && !rest.commit.created) {
    rest.commit = { created: false };
  }
  return rest;
}

function toolEnhanceWorktree(args = {}) {
  const { root, session } = contextFor(args);
  const action = String(args.action || '');
  const taskId = String(args.task_id || '').trim();
  if (action === 'list') return jsonResult(listWorktrees(root, { session }));
  if (action !== 'create' && action !== 'diff' && action !== 'land' && action !== 'remove') {
    return textResult(`unsupported action: ${action || '(missing)'}; use create, list, diff, land, or remove`, true);
  }
  if (!taskId) return textResult(`task_id is required for action: ${action}`, true);
  const includePatch = Boolean(args.include_patch);
  if (action === 'create') {
    const gate = checkTaskDependencies(root, taskId, session);
    if (!gate.ok) return jsonResult(gate, true);
    const created = createWorktree(root, taskId, { session, carryBase: Boolean(args.carry_base) });
    return jsonResult(trimWorktreeResult(created), !created.ok);
  }
  if (action === 'diff') return jsonResult(diffWorktree(root, taskId, { session }));
  if (action === 'land') {
    const landed = landWorktree(root, taskId, {
      runChecks: args.run_checks !== false,
      commit: Boolean(args.commit),
      session,
    });
    return jsonResult(trimWorktreeResult(landed, { includePatch }), !landed.ok);
  }
  return jsonResult(removeWorktree(root, taskId, { discard: Boolean(args.discard), session }));
}

function toolEnhanceRecall(args = {}) {
  const { root, config } = contextFor(args, { tolerateAmbiguity: true });
  if (args.handle) {
    if (!isHandle(args.handle)) return textResult(`invalid artifact handle: ${args.handle}`, true);
    const maxChars = Math.max(200, Math.min(8000, Number(args.max_tokens || config.context.maxRecallTokens) * 4));
    return jsonResult(getArtifact(root, args.handle, { maxChars }));
  }
  const query = String(args.query || '').trim();
  const results = searchArtifacts(root, query, {
    limit: 5,
    maxChars: Math.max(300, Number(args.max_tokens || config.context.maxRecallTokens) * 4),
  });
  return jsonResult(results);
}

function toolEnhanceArtifact(args = {}) {
  const { root, config } = contextFor(args, { tolerateAmbiguity: true });
  const handle = String(args.handle || '');
  if (!isHandle(handle)) return textResult(`invalid artifact handle: ${handle}`, true);
  const limit = Math.max(200, Math.min(12000, Number(args.limit || config.context.maxArtifactChars)));
  return jsonResult(getArtifact(root, handle, {
    maxChars: limit,
    offset: Number(args.offset) || 0,
  }));
}

function toolEnhanceCapabilities(args = {}) {
  const { config } = contextFor(args, { tolerateAmbiguity: true });
  return jsonResult({
    ...(config.capabilities || {}),
    server: {
      pid: process.pid,
      ppid: process.ppid,
      started_at: SERVER_STARTED_AT,
      global: process.env.MY_HARNESS_ENHANCE_GLOBAL === '1',
      project_env: process.env.MY_HARNESS_ENHANCE_PROJECT || '',
    },
  });
}

function toolEnhanceWorkerContract(args = {}) {
  contextFor(args, { tolerateAmbiguity: true });
  const contract = workerContract(String(args.agent_type || 'worker'), {
    role: String(args.role || ''),
    jobId: String(args.job_id || ''),
  });
  return textResult(contract);
}

const HANDLERS = {
  enhance_state: toolEnhanceState,
  enhance_goal: toolEnhanceGoal,
  enhance_brief: toolEnhanceBrief,
  enhance_plan: toolEnhancePlan,
  enhance_decide: toolEnhanceDecide,
  enhance_job: toolEnhanceJob,
  enhance_check: toolEnhanceCheck,
  enhance_worktree: toolEnhanceWorktree,
  enhance_recall: toolEnhanceRecall,
  enhance_artifact: toolEnhanceArtifact,
  enhance_capabilities: toolEnhanceCapabilities,
  enhance_worker_contract: toolEnhanceWorkerContract,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'harness-enhance', version: '0.2.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const handler = HANDLERS[name];
    if (!handler) {
      error(id, -32602, `unknown tool: ${name}`);
      return;
    }
    try {
      send({ jsonrpc: '2.0', id, result: handler(args) });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        result: textResult(`tool error: ${err.message}`, true),
      });
    }
    return;
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }
  error(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const message = JSON.parse(trimmed);
    if (Array.isArray(message)) {
      for (const item of message) handleRequest(item);
    } else {
      handleRequest(message);
    }
  } catch {
    // ignore malformed lines
  }
});
rl.on('close', () => {
  process.exitCode = 0;
});
