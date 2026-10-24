import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStore, readGoal, readPlan, writeGoal } from '../src/core/store.mjs';
import { putArtifact } from '../src/core/artifacts.mjs';
import { resolveCapabilities } from '../src/core/capabilities.mjs';

process.env.MY_HARNESS_ENHANCE_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mhe-mcp-home-'),
);
// Keep the suite hermetic when an ambient hook/MCP parent leaks these vars.
delete process.env.MY_HARNESS_ENHANCE_PROJECT;
delete process.env.MY_HARNESS_ENHANCE_SESSION;
delete process.env.MY_HARNESS_ENHANCE_GLOBAL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'src', 'adapters', 'qoder', 'mcp', 'recall-server.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-mcp-project-'));
  initStore(root, {
    harness: 'qoder',
    capabilities: resolveCapabilities({
      availableAgents: ['general-purpose', 'Explore', 'env-runner', 'reasoner'],
    }),
  });
  return root;
}

function runRpc(root, messages, { projectEnv = true } = {}) {
  const input = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  const env = { ...process.env };
  delete env.MY_HARNESS_ENHANCE_SESSION;
  delete env.MY_HARNESS_ENHANCE_GLOBAL;
  if (projectEnv) env.MY_HARNESS_ENHANCE_PROJECT = root;
  else delete env.MY_HARNESS_ENHANCE_PROJECT;
  const result = spawnSync(process.execPath, [SERVER], {
    input,
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('MCP server initializes and lists enhance tools', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const init = responses.find((item) => item.id === 1);
  assert.equal(init.result.serverInfo.name, 'harness-enhance');
  const list = responses.find((item) => item.id === 2);
  assert.ok(list.result.tools.some((tool) => tool.name === 'enhance_state'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'enhance_capabilities'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'enhance_recall'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'enhance_brief'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'enhance_check'));
  const planTool = list.result.tools.find((tool) => tool.name === 'enhance_plan');
  assert.deepEqual(planTool.inputSchema.properties.tasks.items.required, ['id']);
  assert.ok(planTool.inputSchema.properties.tasks.items.properties.task);
});

test('MCP enhance_goal writes state and enhance_state returns it', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'enhance_goal',
        arguments: {
          text: 'Ship the health endpoint',
          acceptance: ['GET /health returns 200'],
          constraints: ['No new dependencies'],
          replace: true,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'enhance_state', arguments: {} },
    },
  ]);
  const goal = responses.find((item) => item.id === 2);
  assert.match(goal.result.content[0].text, /Ship the health endpoint/);
  const state = responses.find((item) => item.id === 3);
  assert.match(state.result.content[0].text, /Ship the health endpoint/);
  assert.match(state.result.content[0].text, /GET \/health returns 200/);
  assert.match(state.result.content[0].text, /WORKERS/);
});

test('MCP enhance_capabilities returns the native agent mapping', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'enhance_capabilities', arguments: {} },
    },
  ]);
  const capabilities = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.equal(capabilities.roles.execute.agent, 'general-purpose');
  assert.equal(capabilities.roles.reason.agent, 'mhe-reasoner');
  assert.equal(capabilities.roles.investigate.agent, 'Explore');
});

test('MCP tools can target a specific workspace via project', () => {
  const root1 = makeRoot();
  const root2 = makeRoot();
  const responses = runRpc(root1, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'enhance_goal',
        arguments: { project: root2, text: 'second workspace goal', replace: true },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'enhance_state', arguments: { project: root2 } },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'enhance_state', arguments: {} },
    },
  ]);
  assert.match(responses.find((item) => item.id === 3).result.content[0].text, /second workspace goal/);
  assert.doesNotMatch(responses.find((item) => item.id === 4).result.content[0].text, /second workspace goal/);
});

test('MCP enhance_plan accepts id-only tasks and falls back to id as title', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'enhance_plan',
        arguments: { tasks: [{ id: 't-only', status: 'pending' }] },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'enhance_plan', arguments: {} },
    },
  ]);
  const plan = JSON.parse(responses.find((item) => item.id === 3).result.content[0].text);
  assert.equal(plan.tasks[0].id, 't-only');
  assert.equal(plan.tasks[0].title, 't-only');
});

test('MCP capabilities include process diagnostics', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'enhance_capabilities', arguments: {} },
    },
  ]);
  const capabilities = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.ok(capabilities.server.pid > 0);
  assert.ok(capabilities.server.ppid > 0);
  assert.match(capabilities.server.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(capabilities.server.global, false);
  assert.equal(capabilities.server.project_env, root);
});

test('MCP resolves project from cwd, not a sibling workspace', () => {
  const root1 = makeRoot();
  const root2 = makeRoot();
  const responses = runRpc(root1, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'enhance_goal',
        arguments: { text: 'cwd workspace goal', replace: true },
      },
    },
  ], { projectEnv: false });
  assert.match(responses.find((item) => item.id === 2).result.content[0].text, /cwd workspace goal/);
  assert.equal(readGoal(root1).text, 'cwd workspace goal');
  assert.equal(readGoal(root2).text, '');
});

test('MCP brief and check validate docs and mark plan tasks', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs/example.md'),
    '# Title\n\nUse `code` and 42.\n\n```js\nconst x = 1;\n```\n',
  );
  fs.writeFileSync(
    path.join(root, 'docs/example.zh-CN.md'),
    '# 标题\n\n使用 `code` 和 42。\n\n```js\nconst x = 1;\n```\n',
  );
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'enhance_brief', arguments: { profile: 'docs' } },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'enhance_plan',
        arguments: {
          tasks: [
            { id: 'T1', title: 'translate', status: 'in_progress' },
            { id: 'T2', title: 'review', status: 'pending' },
          ],
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'enhance_check',
        arguments: { task_ids: ['T1'] },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'enhance_state', arguments: {} },
    },
  ]);
  const brief = JSON.parse(responses.find((item) => item.id === 2).result.content[0].text);
  assert.deepEqual(brief.pairs, [{ source: 'docs/example.md', target: 'docs/example.zh-CN.md' }]);
  const check = JSON.parse(responses.find((item) => item.id === 4).result.content[0].text);
  assert.equal(check.ok, true, JSON.stringify(check.findings));
  assert.deepEqual(check.task_ids_completed, ['T1']);
  assert.equal(readPlan(root).tasks.find((task) => task.id === 'T1').status, 'completed');
  const state = responses.find((item) => item.id === 5).result.content[0].text;
  assert.match(state, /BRIEF/);
  assert.match(state, /LAST CHECK/);
});

test('MCP enhance_recall returns bounded search results', () => {
  const root = makeRoot();
  writeGoal(root, { text: 'Investigate auth' });
  putArtifact(root, {
    content: 'auth middleware validates JWT in src/auth.ts:42',
    kind: 'findings',
    summary: 'auth middleware location',
  });
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'enhance_recall',
        arguments: { query: 'JWT auth', max_tokens: 200 },
      },
    },
  ]);
  const recall = responses.find((item) => item.id === 2);
  assert.match(recall.result.content[0].text, /JWT/);
});

test('MCP enhance_artifact rejects an invalid handle', () => {
  const root = makeRoot();
  const responses = runRpc(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'enhance_artifact', arguments: { handle: '../secret' } },
    },
  ]);
  const artifact = responses.find((item) => item.id === 2);
  assert.equal(artifact.result.isError, true);
});
