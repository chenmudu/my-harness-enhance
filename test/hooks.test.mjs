import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStore, readGoal, readJobs, readMetrics, readPlan, storePaths, upsertJob, writeBrief, writeGoal, writeLastCheck, writePlan } from '../src/core/store.mjs';
import { canonicalPath } from '../src/core/state-root.mjs';
import { saveConfig } from '../src/core/config.mjs';
import { resolveCapabilities } from '../src/core/capabilities.mjs';
import { readArtifactIndex } from '../src/core/artifacts.mjs';
import { writeGlobalConfig } from '../src/core/global.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-hooks-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'hooks', 'hook.mjs');
const AVAILABLE = ['general-purpose', 'Explore', 'mhe-reasoner'];

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-hooks-project-'));
  initStore(root, {
    harness: 'qoder',
    capabilities: resolveCapabilities({ availableAgents: AVAILABLE }),
    logging: 'errors',
  });
  return root;
}

function runHook(root, event, payload) {
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_PROJECT;
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  const result = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload),
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function parseJson(stdout) {
  assert.ok(stdout.trim(), 'expected JSON output');
  return JSON.parse(stdout);
}

function denyOf(stdout) {
  const json = parseJson(stdout);
  return json.hookSpecificOutput?.permissionDecision === 'deny';
}

const valid = {
  status: 'ok',
  summary: 'Task complete.',
  evidence: [{ handle: 'abc123def456', note: 'proof' }],
  artifacts: [],
  open_questions: [],
  next: 'Continue',
};

test('hooks are dormant outside registered projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-dormant-'));
  const started = runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  assert.equal(started.stdout.trim(), '');
  const bash = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(bash.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(root).dir), false);
});

test('auto mode makes any main session the conductor without selection', () => {
  const root = setupRoot();
  const started = runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  assert.equal(started.status, 0);
  assert.match(started.stdout, /MY-HARNESS-ENHANCE CONDUCTOR/);
  assert.match(started.stdout, /WORKERS/);
  const bash = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(denyOf(bash.stdout), true);
});

test('subagent SessionStart does not write the main session marker', () => {
  const root = setupRoot();
  const result = runHook(root, 'SessionStart', {
    agent_type: 'Explore',
    model: 'qfmodel',
    source: 'startup',
  });
  assert.equal(result.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(root).session), false);
});

test('UserPromptSubmit stores the first prompt as the goal', () => {
  const root = setupRoot();
  const result = runHook(root, 'UserPromptSubmit', {
    model: 'qfmodel',
    prompt: 'Add a health endpoint.',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /TURN ANCHOR/);
  assert.match(result.stdout, /## GOAL/);
  assert.equal(readGoal(root).text, 'Add a health endpoint.');
});

test('a later turn injects only the sections that changed', () => {
  const root = setupRoot();
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  const first = runHook(root, 'UserPromptSubmit', { model: 'qfmodel', prompt: 'Add a health endpoint.' });
  assert.match(first.stdout, /State changed since your last turn/);

  const second = runHook(root, 'UserPromptSubmit', { model: 'qfmodel', prompt: '继续' });
  assert.match(second.stdout, /State is unchanged since your last turn/);
  assert.doesNotMatch(second.stdout, /## PLAN/);
  assert.ok(second.stdout.length < first.stdout.length);
});

test('a new session replaces the old goal for a substantive new task', () => {
  const root = setupRoot();
  writeGoal(root, { text: 'old task' });
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  runHook(root, 'UserPromptSubmit', { model: 'qfmodel', prompt: '写一个新的功能' });
  assert.equal(readGoal(root).text, '写一个新的功能');
});

test('a short continuation keeps the old goal', () => {
  const root = setupRoot();
  writeGoal(root, { text: 'old task' });
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  runHook(root, 'UserPromptSubmit', { model: 'qfmodel', prompt: '继续' });
  assert.equal(readGoal(root).text, 'old task');
});

test('only the marked conductor session is enforced', () => {
  const root = setupRoot();
  runHook(root, 'SessionStart', {
    session_id: 'session_conductor',
    model: 'qfmodel',
    source: 'startup',
  });
  const other = runHook(root, 'PreToolUse', {
    session_id: 'session_other',
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(other.stdout.trim(), '');
  const conductor = runHook(root, 'PreToolUse', {
    session_id: 'session_conductor',
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(denyOf(conductor.stdout), true);

  const otherWorker = runHook(root, 'SubagentStart', {
    session_id: 'session_other',
    agent_id: 'agent_other',
    agent_type: 'Explore',
  });
  assert.equal(otherWorker.stdout.trim(), '');
  assert.equal(readJobs(root).jobs.length, 0);

  const conductorWorker = runHook(root, 'SubagentStart', {
    session_id: 'session_conductor',
    agent_id: 'agent_conductor',
    agent_type: 'Explore',
  });
  assert.match(conductorWorker.stdout, /WORKER CONTRACT/);
});

test('conductor PreToolUse denies execution and allows native workers', () => {
  const root = setupRoot();

  const bash = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(denyOf(bash.stdout), true);

  const read = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Read',
    tool_input: { file_path: 'x' },
  });
  assert.equal(denyOf(read.stdout), true);

  // A write-capable worker waits for the declared profile: dispatched before
  // the brief, it would edit the shared checkout.
  const undeclared = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose' },
  });
  assert.equal(denyOf(undeclared.stdout), true);
  assert.match(parseJson(undeclared.stdout).hookSpecificOutput.permissionDecisionReason, /enhance_brief/);

  writeBrief(root, { profile: 'general', checks: [] });
  for (const agent of ['Explore', 'mhe-reasoner', 'general-purpose']) {
    const allowed = runHook(root, 'PreToolUse', {
      model: 'qfmodel',
      tool_name: 'Agent',
      tool_input: { subagent_type: agent },
    });
    assert.equal(allowed.stdout.trim(), '', agent);
  }

  const plan = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Plan' },
  });
  assert.equal(denyOf(plan.stdout), true);

  const oldRunner = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'env-runner' },
  });
  assert.equal(denyOf(oldRunner.stdout), true);

  const oldReasoner = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'reasoner' },
  });
  assert.equal(denyOf(oldReasoner.stdout), true);

  const state = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: {},
  });
  assert.equal(state.stdout.trim(), '');

  const stateUnderscore = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness_enhance__enhance_state',
    tool_input: {},
  });
  assert.equal(stateUnderscore.stdout.trim(), '');

  const gateway = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp_get',
    tool_input: { toolName: 'mcp__harness_enhance__enhance_state' },
  });
  assert.equal(gateway.stdout.trim(), '');

  const otherGateway = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp_get',
    tool_input: { toolName: 'mcp__other__danger' },
  });
  assert.equal(denyOf(otherGateway.stdout), true);

  for (const tool of ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
    const nativeTask = runHook(root, 'PreToolUse', {
      model: 'qfmodel',
      tool_name: tool,
      tool_input: {},
    });
    assert.equal(denyOf(nativeTask.stdout), true, tool);
  }
});

test('worker PreToolUse enforces native agent policies', () => {
  const root = setupRoot();

  const exploreRead = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Read',
    tool_input: { file_path: 'x' },
  });
  assert.equal(exploreRead.stdout.trim(), '');

  for (const tool of ['Write', 'Edit']) {
    const denied = runHook(root, 'PreToolUse', {
      agent_type: 'Explore',
      tool_name: tool,
      tool_input: {},
    });
    assert.equal(denyOf(denied.stdout), true, tool);
  }

  const exploreBash = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(exploreBash.stdout.trim(), '');

  const exploreAgent = runHook(root, 'PreToolUse', {
    agent_type: 'Explore',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'env-runner' },
  });
  assert.equal(denyOf(exploreAgent.stdout), true);

  const reasonerBash = runHook(root, 'PreToolUse', {
    agent_type: 'mhe-reasoner',
    tool_name: 'Bash',
    tool_input: {},
  });
  assert.equal(denyOf(reasonerBash.stdout), true);

  const leadAgent = runHook(root, 'PreToolUse', {
    agent_type: 'general-purpose',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'env-runner' },
  });
  assert.equal(denyOf(leadAgent.stdout), true);

  const unknown = runHook(root, 'PreToolUse', {
    agent_type: 'some-other-agent',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(unknown.stdout.trim(), '');
});

test('SubagentStart creates a job and injects the worker contract', () => {
  const root = setupRoot();
  const result = runHook(root, 'SubagentStart', {
    agent_id: 'agent_1',
    agent_type: 'Explore',
  });
  const json = parseJson(result.stdout);
  assert.match(json.hookSpecificOutput.additionalContext, /WORKER CONTRACT/);
  assert.match(json.hookSpecificOutput.additionalContext, /role: .*investigate/);
  const job = readJobs(root).jobs.find((item) => item.agent_id === 'agent_1');
  assert.equal(job.status, 'running');
  assert.equal(job.type, 'Explore');
  assert.match(job.role, /investigate/);
  assert.match(job.role, /plan/);
  assert.match(job.role, /verify_read/);
});

test('SubagentStart is silent for agents outside the capability map', () => {
  const root = setupRoot();
  const result = runHook(root, 'SubagentStart', {
    agent_id: 'agent_plan',
    agent_type: 'Plan',
  });
  assert.equal(result.stdout.trim(), '');
  assert.equal(readJobs(root).jobs.length, 0);
});

test('SubagentStop records valid and invalid native worker results', () => {
  const root = setupRoot();
  runHook(root, 'SubagentStart', { agent_id: 'agent_1', agent_type: 'Explore' });
  runHook(root, 'SubagentStop', {
    agent_id: 'agent_1',
    agent_type: 'Explore',
    result: JSON.stringify(valid),
  });
  const job = readJobs(root).jobs.find((item) => item.agent_id === 'agent_1');
  assert.equal(job.status, 'ok');
  assert.ok(job.result_handle);
  assert.ok(readArtifactIndex(root).artifacts[job.result_handle]);

  runHook(root, 'SubagentStart', { agent_id: 'agent_2', agent_type: 'Explore' });
  runHook(root, 'SubagentStop', {
    agent_id: 'agent_2',
    agent_type: 'Explore',
    result: 'Done, no JSON here.',
  });
  const invalid = readJobs(root).jobs.find((item) => item.agent_id === 'agent_2');
  assert.equal(invalid.status, 'invalid_result');
  assert.equal(invalid.retryable, true);
  assert.match(invalid.envelope.summary, /INVALID_WORKER_RESULT/);
  assert.match(invalid.next, /Re-delegate/);
});

test('SubagentStop creates a job when SubagentStart was not emitted', () => {
  const root = setupRoot();
  runHook(root, 'SubagentStop', {
    agent_id: 'agent_no_start',
    agent_type: 'Explore',
    last_assistant_message: JSON.stringify(valid),
  });
  const job = readJobs(root).jobs.find((item) => item.agent_id === 'agent_no_start');
  assert.ok(job);
  assert.equal(job.status, 'ok');
  assert.match(job.role, /investigate/);
  assert.equal(job.depth, 1);
});

test('SubagentStop keeps a checked result in_progress until enhance_check', () => {
  const root = setupRoot();
  writePlan(root, [{ id: 'T1', title: 'translate', status: 'in_progress' }]);
  runHook(root, 'SubagentStop', {
    agent_id: 'agent_task',
    agent_type: 'Explore',
    result: JSON.stringify({
      ...valid,
      task_id: 'T1',
      check_result: { ok: true, checker: 'docs', findings: 0 },
    }),
  });
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'in_progress');
});

test('conductor cannot dispatch a verification worker before the deterministic check', () => {
  const root = setupRoot();
  upsertJob(root, 'job_done', {
    status: 'ok',
    task_id: 'T1',
    type: 'general-purpose',
    updated_at: new Date().toISOString(),
  });
  const before = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Verify translation parity',
      prompt: 'verify the translation',
    },
  });
  assert.equal(denyOf(before.stdout), true);
  assert.match(parseJson(before.stdout).hookSpecificOutput.permissionDecisionReason, /enhance_check/);

  writeLastCheck(root, {
    ok: false,
    checked: ['docs'],
    findings: [{ level: 'blocker', rule: 'checker.unknown', message: 'unknown checker: docs_parity' }],
    summary: { blockers: 1, warnings: 0, infos: 0 },
    at: new Date(Date.now() + 1000).toISOString(),
  });
  const misconfigured = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Verify translation parity',
      prompt: 'verify the translation again',
    },
  });
  assert.equal(denyOf(misconfigured.stdout), true);
  assert.match(
    parseJson(misconfigured.stdout).hookSpecificOutput.permissionDecisionReason,
    /misconfigured/,
  );

  writeLastCheck(root, {
    ok: true,
    checked: ['docs', 'inputs'],
    findings: [],
    summary: { blockers: 0, warnings: 0, infos: 0 },
    at: new Date(Date.now() + 2000).toISOString(),
  });
  const after = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      description: 'Independent review',
      prompt: 'verify the translation one more time',
    },
  });
  assert.equal(after.stdout.trim(), '', 'an intentional audit after a passing check is allowed');
});

test('harness MCP project arguments are locked to the session root', () => {
  const root = setupRoot();
  const sessionRoot = canonicalPath(root);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-outside-')));

  const denied = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: outside },
  });
  assert.equal(denyOf(denied.stdout), true);
  const reason = parseJson(denied.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /project mismatch/);
  assert.ok(reason.includes(outside), reason);
  assert.ok(reason.includes(sessionRoot), reason);
  assert.match(reason, /never copy a workspace path from GOAL\/notes/);

  const gateway = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp_call',
    tool_input: {
      toolName: 'mcp__harness_enhance__enhance_goal',
      arguments: { project: outside },
    },
  });
  assert.equal(denyOf(gateway.stdout), true);
  assert.match(
    parseJson(gateway.stdout).hookSpecificOutput.permissionDecisionReason,
    /project mismatch/,
  );

  const exact = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: sessionRoot },
  });
  assert.equal(exact.stdout.trim(), '', 'the session root itself is allowed');

  const nested = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'mcp__harness-enhance__enhance_state',
    tool_input: { project: path.join(sessionRoot, 'sub', 'dir') },
  });
  assert.equal(nested.stdout.trim(), '', 'a path inside the session root is allowed');
});

test('verification gate only fires on explicit verify intent, not audit/investigate', () => {
  const root = setupRoot();
  upsertJob(root, 'job_done', {
    status: 'ok',
    task_id: 'T1',
    type: 'general-purpose',
    updated_at: new Date().toISOString(),
  });
  // The worker contract and ordinary follow-up work mention "audit"; they
  // must not be mistaken for a verification-worker dispatch.
  for (const prompt of ['audit the changed files', 'investigate the flaky test']) {
    const allowed = runHook(root, 'PreToolUse', {
      model: 'qfmodel',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', description: prompt, prompt },
    });
    assert.equal(allowed.stdout.trim(), '', prompt);
  }
});

test('conductor PostToolUse normalizes Agent results', () => {
  const root = setupRoot();
  const good = runHook(root, 'PostToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: `Worker prose before JSON.\n${JSON.stringify(valid)}\nWorker prose after.`,
  });
  const envelope = JSON.parse(parseJson(good.stdout).hookSpecificOutput.updatedToolOutput);
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.summary, 'Task complete.');

  const bad = runHook(root, 'PostToolUse', {
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: 'long prose without JSON '.repeat(200),
  });
  const failure = JSON.parse(parseJson(bad.stdout).hookSpecificOutput.updatedToolOutput);
  assert.equal(failure.status, 'failed');
  assert.match(failure.summary, /INVALID_WORKER_RESULT/);
  assert.ok(failure.data.artifact_handle);
});

test('large native worker tool output is captured as an artifact', () => {
  const root = setupRoot();
  const result = runHook(root, 'PostToolUse', {
    agent_type: 'general-purpose',
    tool_name: 'Read',
    tool_response: 'x'.repeat(20000),
  });
  assert.equal(result.stdout.trim(), '');
  const artifacts = Object.values(readArtifactIndex(root).artifacts);
  assert.ok(artifacts.some((artifact) => artifact.kind === 'tool-output'));
});

test('unknown worker output is not captured', () => {
  const root = setupRoot();
  runHook(root, 'PostToolUse', {
    agent_type: 'some-other-agent',
    tool_name: 'Read',
    tool_response: 'x'.repeat(20000),
  });
  const artifacts = Object.values(readArtifactIndex(root).artifacts);
  assert.equal(artifacts.length, 0);
});

test('PreCompact writes the capsule for a conductor session', () => {
  const root = setupRoot();
  writeGoal(root, { text: 'Ship the endpoint' });
  runHook(root, 'PreCompact', { trigger: 'auto' });
  const file = storePaths(root).capsule;
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /Ship the endpoint/);
});

test('disabled layer is a no-op', () => {
  const root = setupRoot();
  saveConfig(root, { enabled: false });
  const started = runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  assert.equal(started.stdout.trim(), '');
  const bash = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  assert.equal(bash.stdout.trim(), '');
});

test('global mode auto-registers an unregistered workspace', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-auto-config-'));
  const agentsDir = path.join(configDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'env-runner.md'), '---\nname: env-runner\n---\n');
  fs.writeFileSync(path.join(agentsDir, 'reasoner.md'), '---\nname: reasoner\n---\n');
  writeGlobalConfig({ autoRegister: true, configDir, harness: 'qoder' });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-auto-project-'));
  const result = runHook(root, 'SessionStart', {
    model: 'qfmodel',
    source: 'startup',
    cwd: root,
  });
  assert.match(result.stdout, /MY-HARNESS-ENHANCE CONDUCTOR/);
  assert.equal(fs.existsSync(path.join(storePaths(root).dir, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.router')), false);
  const bash = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: root,
  });
  assert.equal(denyOf(bash.stdout), true);

  writeGlobalConfig({ autoRegister: false });
});

test('global mode does not retrofit an existing session on PreToolUse', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-auto-config-'));
  writeGlobalConfig({ autoRegister: true, configDir, harness: 'qoder' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-existing-project-'));
  const result = runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: root,
  });
  assert.equal(result.stdout.trim(), '');
  assert.equal(fs.existsSync(storePaths(root).dir), false);
  writeGlobalConfig({ autoRegister: false });
});

test('logging=errors writes only denials and invalid results', () => {
  const root = setupRoot();
  runHook(root, 'SessionStart', { model: 'qfmodel', source: 'startup' });
  assert.equal(fs.existsSync(path.join(storePaths(root).logs, 'hooks.jsonl')), false);

  runHook(root, 'PreToolUse', {
    model: 'qfmodel',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  const logFile = path.join(storePaths(root).logs, 'hooks.jsonl');
  assert.ok(fs.existsSync(logFile));
  const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(entries.some((entry) => entry.allow === false && entry.tool === 'Bash'));
});

test('hooks write counts and sizes to metrics without prompts or summaries', () => {
  const root = setupRoot();
  runHook(root, 'SessionStart', {
    model: 'qfmodel',
    source: 'startup',
    session_id: 'session_metrics',
  });
  runHook(root, 'UserPromptSubmit', {
    session_id: 'session_metrics',
    prompt: 'secret prompt text',
  });
  runHook(root, 'SubagentStart', {
    session_id: 'session_metrics',
    agent_id: 'agent_metrics',
    agent_type: 'Explore',
  });
  runHook(root, 'SubagentStop', {
    session_id: 'session_metrics',
    agent_id: 'agent_metrics',
    agent_type: 'Explore',
    result: JSON.stringify(valid),
  });
  runHook(root, 'PostToolUse', {
    session_id: 'session_metrics',
    model: 'qfmodel',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore' },
    tool_response: JSON.stringify(valid),
  });
  runHook(root, 'PreCompact', { trigger: 'auto', session_id: 'session_metrics' });
  runHook(root, 'Stop', { session_id: 'session_metrics' });

  const metrics = readMetrics(root, 100);
  assert.ok(
    metrics.every((entry) => entry.session === 'sessionmetrics'),
    JSON.stringify(metrics.map((entry) => [entry.event, entry.session])),
  );
  const events = metrics.map((entry) => entry.event);
  for (const event of ['session_start', 'prompt_submitted', 'job_start', 'job_stop', 'agent_result', 'compaction', 'session_stop']) {
    assert.ok(events.includes(event), `${event} missing`);
  }

  const started = metrics.find((entry) => entry.event === 'session_start');
  assert.equal(started.session_id, 'session_metrics');
  assert.equal(started.session, 'sessionmetrics');
  assert.equal(started.source, 'startup');
  assert.ok(started.capsule_tokens > 0);

  const prompt = metrics.find((entry) => entry.event === 'prompt_submitted');
  assert.equal(prompt.prompt_chars, 'secret prompt text'.length);
  assert.ok(prompt.capsule_tokens > 0);

  const stopped = metrics.find((entry) => entry.event === 'job_stop');
  assert.equal(stopped.valid, true);
  assert.equal(stopped.status, 'ok');
  assert.ok(stopped.result_tokens > 0);

  const result = metrics.find((entry) => entry.event === 'agent_result');
  assert.equal(result.valid, true);
  assert.ok(result.compact_tokens > 0);
  assert.ok(result.result_tokens > 0);

  const compaction = metrics.find((entry) => entry.event === 'compaction');
  assert.equal(compaction.trigger, 'auto');
  assert.ok(compaction.capsule_tokens > 0);

  const serialized = JSON.stringify(metrics);
  assert.doesNotMatch(serialized, /secret prompt text/);
  assert.doesNotMatch(serialized, /Task complete\./);
});
