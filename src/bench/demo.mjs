import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureState } from '../core/config.mjs';
import { putArtifact } from '../core/artifacts.mjs';
import { buildCapsule, writeCapsule } from '../core/capsule.mjs';
import { compactEnvelope, parseEnvelope } from '../core/contract.mjs';
import { estimateTokens, simulateScenario } from '../core/metrics.mjs';
import {
  appendDecision,
  initStore,
  upsertJob,
  writeGoal,
  writePlan,
} from '../core/store.mjs';

function makeEnvelope(value) {
  const parsed = parseEnvelope(JSON.stringify(value));
  if (!parsed.ok) {
    throw new Error(`demo envelope invalid: ${parsed.errors.join('; ')}`);
  }
  return parsed.value;
}

export function runDemo({ keep = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'my-harness-enhance-demo-'));
  const previousHome = process.env.MY_HARNESS_ENHANCE_HOME;
  process.env.MY_HARNESS_ENHANCE_HOME = path.join(root, '.mhe-home');
  try {
    return runDemoIn(root, keep);
  } finally {
    if (previousHome === undefined) delete process.env.MY_HARNESS_ENHANCE_HOME;
    else process.env.MY_HARNESS_ENHANCE_HOME = previousHome;
  }
}

function runDemoIn(root, keep) {
  initStore(root);
  const { stateDir: dir } = ensureState(root);

  writeGoal(root, {
    text: 'Add a /health endpoint to the API, with one integration test and a short README note.',
    acceptance: [
      'GET /health returns 200 and {"status":"ok"}',
      'An integration test covers the endpoint',
      'README documents the endpoint',
    ],
    constraints: [
      'Do not change existing routes',
      'Do not add new runtime dependencies',
    ],
  });
  appendDecision(root, 'Use the existing HTTP test harness', 'Avoids new dependencies');

  const planner = makeEnvelope({
    status: 'ok',
    summary: 'Three tasks: inspect routes, implement endpoint + test, verify and document.',
    evidence: [],
    artifacts: [],
    open_questions: [],
    next: 'Approve the plan and dispatch t1',
    needs_split: null,
    data: {
      plan: {
        summary: 'Inspect, implement, verify',
        tasks: [
          {
            id: 't1',
            title: 'Inspect the HTTP route registration and test harness',
            worker: 'Explore',
            depends_on: [],
            acceptance: 'Files and line references for route registration and tests',
          },
          {
            id: 't2',
            title: 'Implement /health and its integration test',
            worker: 'general-purpose',
            depends_on: ['t1'],
            acceptance: 'Endpoint returns 200 with {"status":"ok"}; test passes',
          },
          {
            id: 't3',
            title: 'Verify acceptance criteria and update README',
            worker: 'Explore',
            depends_on: ['t2'],
            acceptance: 'All acceptance criteria checked with evidence',
          },
        ],
      },
    },
    cost: { tokens_in: 12000, tokens_out: 900, ms: 4200, model: 'qfmodel' },
    confidence: 0.82,
  });
  writePlan(root, planner.data.plan.tasks);

  const investigation = putArtifact(root, {
    content: 'routes are registered in src/http/routes.ts:42; tests use supertest in test/http.test.ts',
    kind: 'findings',
    source: 'demo',
    summary: 'Route registration and test harness locations',
  });

  const investigator = makeEnvelope({
    status: 'ok',
    summary: 'Route registration at src/http/routes.ts:42; tests use supertest.',
    evidence: [{ handle: investigation.handle, note: 'route and test locations' }],
    artifacts: [],
    open_questions: [],
    next: 'Dispatch t2',
    data: {
      findings: [
        {
          finding: 'Routes are registered in a single router',
          evidence: 'src/http/routes.ts:42',
          confidence: 0.9,
        },
      ],
    },
  });

  const diff = putArtifact(root, {
    content: 'diff --git a/src/http/routes.ts ...\n+ router.get("/health", ...)\ndiff --git a/test/http.test.ts ...\n+ it("returns ok", ...)',
    kind: 'diff',
    source: 'demo',
    summary: 'Adds GET /health and one integration test',
  });

  const executor = makeEnvelope({
    status: 'ok',
    summary: 'Added GET /health returning {"status":"ok"} and one integration test; test suite passes.',
    evidence: [
      { handle: investigation.handle, note: 'route location' },
      { handle: diff.handle, note: 'actual change' },
    ],
    artifacts: [{ handle: diff.handle, kind: 'diff', summary: 'endpoint + test' }],
    open_questions: [],
    next: 'Dispatch t3 verification',
    data: {
      changes: ['src/http/routes.ts', 'test/http.test.ts'],
      commands: ['npm test -- --runInBand'],
    },
  });

  const verifier = makeEnvelope({
    status: 'ok',
    summary: 'All three acceptance criteria pass; README is the remaining task.',
    evidence: [{ handle: diff.handle, note: 'endpoint and test diff' }],
    artifacts: [],
    open_questions: [],
    next: 'Write the README note',
    data: {
      checks: [
        { criterion: 'GET /health returns 200', pass: true, evidence: diff.handle, note: 'route added' },
        { criterion: 'Integration test exists', pass: true, evidence: diff.handle, note: 'one test added' },
        { criterion: 'README documents the endpoint', pass: false, evidence: '', note: 'not yet written' },
      ],
    },
  });

  for (const [agentId, type, envelope] of [
    ['agent_demo_investigator', 'Explore', investigator],
    ['agent_demo_executor', 'general-purpose', executor],
    ['agent_demo_verifier', 'Explore', verifier],
  ]) {
    upsertJob(root, agentId, {
      agent_id: agentId,
      type,
      status: envelope.status,
      envelope,
      result_handle: putArtifact(root, {
        content: compactEnvelope(envelope),
        kind: 'worker-envelope',
        source: type,
        summary: envelope.summary.slice(0, 200),
      }).handle,
    });
  }

  writePlan(root, [
    {
      id: 't1',
      title: 'Inspect the HTTP route registration and test harness',
      worker: 'Explore',
      status: 'completed',
    },
    {
      id: 't2',
      title: 'Implement /health and its integration test',
      worker: 'general-purpose',
      status: 'completed',
      depends_on: ['t1'],
    },
    {
      id: 't3',
      title: 'Verify acceptance criteria and update README',
      worker: 'Explore',
      status: 'in_progress',
      depends_on: ['t2'],
    },
  ]);

  const capsule = writeCapsule(root);
  const envelopes = [planner, investigator, executor, verifier];
  const envelopeTokens = envelopes.reduce(
    (sum, envelope) => sum + estimateTokens(compactEnvelope(envelope)),
    0,
  );
  const scenario = simulateScenario({
    name: 'demo-3-tasks',
    steps: envelopes.length,
    toolKB: 18,
    reasoningKB: 9,
    envelopeKB: Math.max(1, envelopeTokens / 1024 / envelopes.length),
  });

  const lines = [];
  lines.push('# my-harness-enhance demo');
  lines.push('');
  lines.push(`state dir: ${dir}`);
  lines.push(`goal: ${path.join(dir, 'goal.json')}`);
  lines.push(`plan tasks: ${planner.data.plan.tasks.length}`);
  lines.push(`worker envelopes: ${envelopes.length} (${envelopeTokens} estimated tokens)`);
  lines.push(`capsule: ${estimateTokens(capsule)} estimated tokens`);
  lines.push(`verifier checks: ${verifier.data.checks.length} (${verifier.data.checks.filter((c) => c.pass).length} pass)`);
  lines.push('');
  lines.push('## capsule');
  lines.push('');
  lines.push(capsule);
  lines.push('');
  lines.push('## simulated main-context effect');
  lines.push('');
  lines.push(`- baseline main: ${scenario.baseline.mainTokens} tokens`);
  lines.push(`- conductor main: ${scenario.router.mainTokens} tokens`);
  lines.push(`- reduction: ${(scenario.reduction * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('The demo validates the state store, envelope contract, artifact store, capsule,');
  lines.push('and the accounting model without calling a model or touching Qoder.');

  const report = lines.join('\n');
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  return { root, dir, report, capsule, scenario, envelopes };
}
