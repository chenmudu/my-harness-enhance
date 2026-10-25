import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentTypeOf,
  conductorDenyReason,
  dispatchGateReason,
  harnessProjectArg,
  hookJson,
  isAllowedConductorTool,
  modelOf,
  projectGateReason,
  toolInputOf,
  toolNameOf,
  verificationGateReason,
  workerToolDecision,
  writesRepository,
} from '../src/core/hook-policy.mjs';
import {
  initStore,
  upsertJob,
  upsertWorktree,
  writeBrief,
  writeLastCheck,
  writePlan,
} from '../src/core/store.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-policy-home-'),
);
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

function config(overrides = {}) {
  return {
    conductor: { auto: true, allowedTools: ['Read'] },
    capabilities: {
      allowedSubagents: ['general-purpose', 'Explore'],
      agents: {
        'general-purpose': { kind: 'write', allow: ['Read', 'Write'], deny: ['Bash'] },
        Explore: { kind: 'readonly', allow: ['Read', 'Glob'], deny: [] },
      },
    },
    ...overrides,
  };
}

function stateRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-policy-project-')));
  initStore(root);
  return root;
}

test('conductor tool policy allows harness state tools and registered workers only', () => {
  const cfg = config();
  assert.equal(isAllowedConductorTool('mcp__harness-enhance__enhance_plan', {}, cfg), true);
  assert.equal(isAllowedConductorTool('enhance_job', {}, cfg), true);
  assert.equal(isAllowedConductorTool('Read', {}, cfg), true);
  assert.equal(isAllowedConductorTool('Bash', {}, cfg), false);
});

test('conductor tool policy rejects native task tools', () => {
  const cfg = config();
  for (const tool of ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
    assert.equal(isAllowedConductorTool(tool, {}, cfg), false, tool);
  }
});

test('conductor tool policy gates delegation to the registered subagents', () => {
  const cfg = config();
  assert.equal(isAllowedConductorTool('Agent', { subagent_type: 'general-purpose' }, cfg), true);
  assert.equal(isAllowedConductorTool('Task', { agent: 'general-purpose' }, cfg), true);
  assert.equal(isAllowedConductorTool('Agent', { subagent_type: 'other' }, cfg), false);
  assert.equal(isAllowedConductorTool('Agent', {}, cfg), false);
});

test('conductor tool policy follows the gateway tool to its target', () => {
  const cfg = config();
  assert.equal(
    isAllowedConductorTool('mcp_call', { toolName: 'mcp__harness-enhance__enhance_plan' }, cfg),
    true,
  );
  assert.equal(isAllowedConductorTool('mcp_call', { toolName: 'mcp__github__list_issues' }, cfg), false);
  assert.equal(isAllowedConductorTool('mcp_get', {}, cfg), false);
});

test('worker policy keeps unknown agents silent', () => {
  assert.equal(workerToolDecision('unknown', 'Read', config()), null);
});

test('worker policy forbids workers from spawning agents', () => {
  const decision = workerToolDecision('general-purpose', 'Agent', config());
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /needs_split/);
});

test('worker policy honours deny lists, wildcard deny and allow lists', () => {
  const cfg = config();
  const denied = workerToolDecision('general-purpose', 'Bash', cfg);
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /may not use Bash/);

  const allowed = workerToolDecision('general-purpose', 'Write', cfg);
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, '');

  const wildcard = config({
    capabilities: {
      allowedSubagents: ['general-purpose'],
      agents: { 'general-purpose': { kind: 'write', allow: '*', deny: '*' } },
    },
  });
  assert.equal(workerToolDecision('general-purpose', 'Bash', wildcard).allow, false);

  const noTools = config({
    capabilities: {
      allowedSubagents: ['general-purpose'],
      agents: { 'general-purpose': { kind: 'readonly', allow: [], deny: [] } },
    },
  });
  const fallback = workerToolDecision('general-purpose', 'Read', noTools);
  assert.equal(fallback.allow, false);
  assert.match(fallback.reason, /Allowed: \(none\)/);
});

test('conductor deny reasons name the failure mode', () => {
  const cfg = config();
  assert.match(conductorDenyReason('TaskCreate', cfg), /enhance_plan/);
  assert.match(conductorDenyReason('Agent', cfg), /general-purpose/);
  assert.match(conductorDenyReason('Read', cfg), /must not execute repository work/);

  const empty = config({ capabilities: { allowedSubagents: [], agents: {} } });
  assert.match(conductorDenyReason('Agent', empty), /No worker capabilities are resolved/);
});

test('payload accessors accept both harness spellings', () => {
  assert.equal(agentTypeOf({ agent_type: 'general-purpose' }), 'general-purpose');
  assert.equal(agentTypeOf({ agentType: 'Explore' }), 'Explore');
  assert.equal(toolNameOf({ tool_name: 'Read' }), 'Read');
  assert.equal(toolNameOf({ toolName: 'Write' }), 'Write');
  assert.deepEqual(toolInputOf({ tool_input: { a: 1 } }), { a: 1 });
  assert.deepEqual(toolInputOf({ toolInput: { b: 2 } }), { b: 2 });
  assert.deepEqual(toolInputOf({}), {});
  assert.equal(modelOf({ model: 'Qwen3.8-Flash' }), 'Qwen3.8-Flash');
  assert.equal(modelOf({ model: { display_name: 'Flash' } }), 'Flash');
  assert.equal(modelOf({}), '');
});

test('hook output helpers build the shared hook envelope', () => {
  assert.deepEqual(hookJson('SessionStart', { additionalContext: 'x' }), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' },
  });
});

test('a worker is write-capable unless its policy says otherwise', () => {
  const cfg = config();
  assert.equal(writesRepository(cfg, 'general-purpose'), true);
  assert.equal(writesRepository(cfg, 'Explore'), false);
  assert.equal(writesRepository(cfg, 'not-registered'), true);
});

test('the project argument is read from direct and gateway harness calls', () => {
  const root = stateRoot();
  assert.equal(harnessProjectArg('enhance_plan', { project: root }), root);
  assert.equal(
    harnessProjectArg('mcp_call', { toolName: 'mcp__harness-enhance__enhance_plan', arguments: { project: root } }),
    root,
  );
  assert.equal(harnessProjectArg('mcp_call', { toolName: 'mcp__other__x', arguments: { project: root } }), '');
  assert.equal(harnessProjectArg('Bash', { project: root }), '');

  assert.equal(projectGateReason(root, root), '');
  assert.equal(projectGateReason(root, ''), '');
  assert.match(projectGateReason(root, path.dirname(root)), /project mismatch/);
});

test('dispatch gate waits for the profile before a write-capable worker runs', () => {
  const root = stateRoot();
  const cfg = config();
  const reason = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: 'do the work' },
    '',
    cfg,
  );
  assert.match(reason, /enhance_brief/);
  assert.match(reason, /enhance_worktree create/);
  assert.match(reason, /non-code profile/);

  const readOnly = dispatchGateReason(
    root,
    { subagent_type: 'Explore', prompt: 'look around' },
    '',
    cfg,
  );
  assert.equal(readOnly, '');

  // A non-code profile declares the profile without arming the worktree gate.
  writeBrief(root, { profile: 'docs', checks: [] });
  const declared = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: 'do the work' },
    '',
    cfg,
  );
  assert.equal(declared, '');
});

test('dispatch gate enforces the plan task and the registered worktree', () => {
  const root = stateRoot();
  const cfg = config();
  writeBrief(root, { profile: 'code', checks: [] });
  writePlan(root, [{ id: 'T1', title: 'first' }, { id: 'T2', title: 'second', depends_on: ['T1'] }]);
  const worktree = path.join(root, '..', 'wt-T2');

  const missing = dispatchGateReason(root, { subagent_type: 'general-purpose', prompt: 'go' }, '', cfg);
  assert.match(missing, /task_id/);

  const blocked = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: 'task_id: T2\nworktree: /tmp/x' },
    '',
    cfg,
  );
  assert.match(blocked, /dependencies not completed/);

  writePlan(root, [{ id: 'T1', title: 'first', status: 'completed' }]);
  upsertWorktree(root, 'T2', { path: worktree, head: 'abc', status: 'active' });
  const noPath = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: 'task_id: T2' },
    '',
    cfg,
  );
  assert.match(noPath, /worktree:/);

  const wrongPath = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: 'task_id: T2\nworktree: /tmp/other' },
    '',
    cfg,
  );
  assert.match(wrongPath, /path mismatch/);

  const ok = dispatchGateReason(
    root,
    { subagent_type: 'general-purpose', prompt: `task_id: T2\nworktree: ${worktree}` },
    '',
    cfg,
  );
  assert.equal(ok, '');
});

test('verification gate blocks a verification worker until a check ran', () => {
  const root = stateRoot();
  const input = { subagent_type: 'general-purpose', prompt: 'verify the result' };
  assert.equal(verificationGateReason(root, input, ''), '');

  upsertJob(root, 'job-1', { status: 'ok', task_id: 'T1' });
  const stale = verificationGateReason(root, input, '');
  assert.match(stale, /enhance_check/);

  writeLastCheck(root, { ok: true, at: new Date(Date.now() + 1000).toISOString(), findings: [] });
  assert.equal(verificationGateReason(root, input, ''), '');
});
