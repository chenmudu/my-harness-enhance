import { sessionKey } from './store.mjs';

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Rough, dependency-free token estimate.
 * CJK code points count ~0.6 token each: 1.0 overstates Chinese payloads by
 * roughly 1.7x, and the A/B tables are read as ratios against English content.
 * Other non-space characters are ~0.28 token.
 * Use the same estimator on both sides of an A/B comparison so the ratio is
 * meaningful even if the absolute number is approximate.
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else if (!/\s/.test(ch)) {
      other += 1;
    }
  }
  return Math.ceil(cjk * 0.6 + other * 0.28);
}

export function composition(items) {
  const out = {};
  let total = 0;
  for (const item of items) {
    const kind = item.kind || 'other';
    const tokens = estimateTokens(item.text);
    out[kind] = out[kind] || { tokens: 0, bytes: 0 };
    out[kind].tokens += tokens;
    out[kind].bytes += byteLength(item.text);
    total += tokens;
  }
  return { total, kinds: out };
}

function kb(text) {
  return text * 1024;
}

export function simulateScenario({
  name = 'scenario',
  steps = 8,
  toolKB = 24,
  reasoningKB = 12,
  envelopeKB = 1.2,
  systemKB = 8,
  toolsKB = 75,
  routerToolsKB = 11,
  stateKB = 3,
  windowTokens = 180000,
} = {}) {
  const stepToolTokens = estimateTokens('x'.repeat(kb(toolKB)));
  const stepReasoningTokens = estimateTokens('x'.repeat(kb(reasoningKB)));
  const envelopeTokens = estimateTokens('x'.repeat(kb(envelopeKB)));
  const systemTokens = estimateTokens('x'.repeat(kb(systemKB)));
  const toolsTokens = estimateTokens('x'.repeat(kb(toolsKB)));
  const routerToolsTokens = estimateTokens('x'.repeat(kb(routerToolsKB)));
  const stateTokens = estimateTokens('x'.repeat(kb(stateKB)));

  const baselineMain = systemTokens + toolsTokens + steps * (stepToolTokens + stepReasoningTokens);
  const routerMain = systemTokens + routerToolsTokens + stateTokens + steps * envelopeTokens;
  const workerTokens = steps * (stepToolTokens + stepReasoningTokens);
  const reduction = baselineMain === 0 ? 0 : 1 - routerMain / baselineMain;

  return {
    name,
    steps,
    windowTokens,
    baseline: {
      mainTokens: baselineMain,
      composition: {
        system: systemTokens,
        tools: toolsTokens,
        tool_results: steps * stepToolTokens,
        reasoning: steps * stepReasoningTokens,
      },
      // Fixed = what every request pays again; artifacts = the layer's own
      // state; assembly = task content the baseline keeps in the main context.
      breakdown: {
        fixed: systemTokens + toolsTokens,
        artifacts: 0,
        assembly: steps * (stepToolTokens + stepReasoningTokens),
      },
      fitsWindow: baselineMain <= windowTokens,
    },
    router: {
      mainTokens: routerMain,
      composition: {
        system: systemTokens,
        conductor_tools: routerToolsTokens,
        state: stateTokens,
        envelopes: steps * envelopeTokens,
      },
      breakdown: {
        fixed: systemTokens + routerToolsTokens,
        artifacts: stateTokens + steps * envelopeTokens,
        assembly: 0,
      },
      workerTokens,
      fitsWindow: routerMain <= windowTokens,
    },
    reduction,
    toolSchemaReduction: toolsTokens === 0 ? 0 : 1 - routerToolsTokens / toolsTokens,
  };
}

export function defaultScenarios() {
  return [
    simulateScenario({
      name: 'light',
      steps: 3,
      toolKB: 8,
      reasoningKB: 4,
      envelopeKB: 1.0,
    }),
    simulateScenario({
      name: 'medium',
      steps: 8,
      toolKB: 20,
      reasoningKB: 10,
      envelopeKB: 1.2,
    }),
    simulateScenario({
      name: 'heavy',
      steps: 16,
      toolKB: 32,
      reasoningKB: 16,
      envelopeKB: 1.4,
    }),
  ];
}

export function formatNumber(value) {
  return Math.round(value).toLocaleString('en-US');
}

export function formatScenarioTable(scenarios) {
  const lines = [];
  lines.push('scenario | fixed | artifacts | assembly | conductor total | baseline total | reduction');
  lines.push('--- | ---: | ---: | ---: | ---: | ---: | ---:');
  for (const scenario of scenarios) {
    const b = scenario.router.breakdown;
    lines.push(
      `${scenario.name} | ${formatNumber(b.fixed)} | ${formatNumber(b.artifacts)} | ` +
      `${formatNumber(b.assembly)} | ${formatNumber(scenario.router.mainTokens)} | ` +
      `${formatNumber(scenario.baseline.mainTokens)} | ${(scenario.reduction * 100).toFixed(1)}%`,
    );
  }
  return lines.join('\n');
}

export function formatScenarioDetail(scenario) {
  const lines = [];
  lines.push(`## ${scenario.name} (${scenario.steps} steps)`);
  lines.push('');
  lines.push(`- baseline main: ${formatNumber(scenario.baseline.mainTokens)} tokens`);
  lines.push(`- conductor main: ${formatNumber(scenario.router.mainTokens)} tokens`);
  lines.push(`- reduction: ${(scenario.reduction * 100).toFixed(1)}%`);
  lines.push(`- conductor tool-schema reduction: ${(scenario.toolSchemaReduction * 100).toFixed(1)}%`);
  lines.push(`- worker-context tokens (outside main): ${formatNumber(scenario.router.workerTokens)}`);
  lines.push('');
  lines.push('baseline composition:');
  for (const [kind, tokens] of Object.entries(scenario.baseline.composition)) {
    lines.push(`- ${kind}: ${formatNumber(tokens)}`);
  }
  lines.push('');
  lines.push('conductor composition:');
  for (const [kind, tokens] of Object.entries(scenario.router.composition)) {
    lines.push(`- ${kind}: ${formatNumber(tokens)}`);
  }
  lines.push('');
  lines.push('breakdown (fixed / artifacts / assembly):');
  const b = scenario.router.breakdown;
  lines.push(`- conductor: ${formatNumber(b.fixed)} / ${formatNumber(b.artifacts)} / ${formatNumber(b.assembly)}`);
  const base = scenario.baseline.breakdown;
  lines.push(`- baseline: ${formatNumber(base.fixed)} / ${formatNumber(base.artifacts)} / ${formatNumber(base.assembly)}`);
  return lines.join('\n');
}

export function benchmarkReport(scenarios = defaultScenarios()) {
  const lines = [];
  lines.push('# my-harness-enhance benchmark');
  lines.push('');
  lines.push('The simulation compares a conventional single-context long task with');
  lines.push('the conductor topology. It counts only what enters the main model context.');
  lines.push('Worker reasoning and raw tool outputs stay in worker contexts.');
  lines.push('');
  lines.push(formatScenarioTable(scenarios));
  lines.push('');
  for (const scenario of scenarios) {
    lines.push(formatScenarioDetail(scenario));
    lines.push('');
  }
  lines.push('Token counts use the same rough estimator for both sides; treat the');
  lines.push('reduction ratio as the signal, not the absolute number.');
  return lines.join('\n');
}

function metricNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricStats(values) {
  const numbers = values.map(metricNumber).filter((value) => value !== null);
  if (numbers.length === 0) return { count: 0, avg: 0, max: 0, latest: 0 };
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return {
    count: numbers.length,
    avg: Math.round((total / numbers.length) * 10) / 10,
    max: Math.max(...numbers),
    latest: numbers[numbers.length - 1],
  };
}

/**
 * Aggregate hook-written metric entries. Only counts and sizes are summarized;
 * prompts, summaries, and raw tool output are never recorded by the hooks.
 * Passing session filters to one shard; without it every entry is counted and
 * the per-session totals are reported under `sessions`.
 */
export function summarizeMetrics(metrics = [], { session = '' } = {}) {
  const filter = String(session || '').trim();
  const key = filter ? sessionKey(filter) : '';
  const entries = (Array.isArray(metrics) ? metrics : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => !key || entry.session === key);
  const sessions = {};
  if (!key) {
    for (const entry of entries) {
      const id = String(entry.session || '');
      if (id) sessions[id] = (sessions[id] || 0) + 1;
    }
  }
  const events = {};
  const denials = {};
  const statuses = {};
  const workers = {};
  const envelopeTokens = [];
  const agentResultTokens = [];
  const capsuleTokens = [];
  const injection = [];
  const labels = [];
  let currentInjection = null;
  let firstAt = '';
  let lastAt = '';
  let started = 0;
  let stopped = 0;
  let valid = 0;
  let invalid = 0;
  let retryable = 0;
  let capturedBytes = 0;
  let agentValid = 0;
  let agentInvalid = 0;

  for (const entry of entries) {
    const event = String(entry.event || 'unknown');
    events[event] = (events[event] || 0) + 1;
    const at = String(entry.at || '');
    if (at) {
      if (!firstAt) firstAt = at;
      lastAt = at;
    }
    if (event === 'behavior_label') {
      labels.push(entry);
      continue;
    }
    const agent = String(entry.agent_type || '');
    if (agent) workers[agent] = workers[agent] || { starts: 0, stops: 0, invalid: 0 };

    if (event === 'job_start') {
      started += 1;
      if (agent) workers[agent].starts += 1;
    } else if (event === 'job_stop') {
      stopped += 1;
      if (agent) workers[agent].stops += 1;
      if (entry.valid === true) {
        valid += 1;
      } else {
        invalid += 1;
        if (agent) workers[agent].invalid += 1;
      }
      if (entry.retryable === true) retryable += 1;
      const status = String(entry.status || 'unknown');
      statuses[status] = (statuses[status] || 0) + 1;
      envelopeTokens.push(entry.result_tokens);
    } else if (event === 'agent_result') {
      if (entry.valid === true) agentValid += 1;
      else agentInvalid += 1;
      agentResultTokens.push(entry.compact_tokens);
    } else if (event === 'tool_output_captured') {
      capturedBytes += metricNumber(entry.bytes) || 0;
    }

    if (event === 'tool_denied' || event === 'worker_tool_denied') {
      const gate = String(entry.gate || (event === 'worker_tool_denied' ? 'worker' : 'other'));
      denials[gate] = (denials[gate] || 0) + 1;
    }
    const capsule = metricNumber(entry.capsule_tokens);
    if (capsule !== null) capsuleTokens.push(capsule);
    if (event === 'prompt_submitted' && metricNumber(entry.packet_tokens) !== null) {
      currentInjection = {
        packet: metricNumber(entry.packet_tokens),
        relevant: metricNumber(entry.relevant_tokens),
        injected: metricNumber(entry.injected_tokens),
        changed: String(entry.changed_sections || ''),
        mode: String(entry.mode || ''),
        action: '',
        outcome: '',
      };
      injection.push(currentInjection);
    } else if (event === 'prompt_submitted') {
      currentInjection = null;
    } else if (currentInjection) {
      // What the conductor did with the last injection: the first dispatched
      // tool and the first worker status that came back.
      if (!currentInjection.action && event === 'dispatch') {
        currentInjection.action = String(entry.tool || 'dispatch');
      }
      if (!currentInjection.outcome && event === 'job_stop') {
        currentInjection.outcome = String(entry.status || 'unknown');
      }
    }
  }

  return {
    session: key || null,
    sessions,
    entries: entries.length,
    firstAt,
    lastAt,
    events,
    denials,
    jobs: {
      started,
      stopped,
      valid,
      invalid,
      retryable,
      invalidRate: stopped ? Math.round((invalid / stopped) * 1000) / 1000 : 0,
      statuses,
    },
    envelopeTokens: metricStats(envelopeTokens),
    agentResults: {
      count: agentValid + agentInvalid,
      valid: agentValid,
      invalid: agentInvalid,
      compactTokens: metricStats(agentResultTokens),
    },
    capsuleTokens: metricStats(capsuleTokens),
    injection: summarizeInjection(injection),
    behavior: summarizeBehaviorLabels(labels),
    capturedBytes,
    workers,
  };
}

/**
 * Deterministic behavior labels written by the A/B runner. They live next to
 * the injection rows so density and behavior can be read from one report.
 */
function summarizeBehaviorLabels(rows) {
  if (!rows.length) return null;
  const totals = { turns: rows.length, next_action_hit: 0, wrong_task_actions: 0, re_reads: 0, failed_turns: 0, recoveries: 0 };
  for (const row of rows) {
    if (row.next_action_hit === true) totals.next_action_hit += 1;
    totals.wrong_task_actions += Number(row.wrong_task) || 0;
    totals.re_reads += Number(row.re_read) || 0;
    if (row.failed === true) totals.failed_turns += 1;
    if (row.recovered === true) totals.recoveries += 1;
  }
  return totals;
}

/**
 * Injection telemetry. `density` is the packet's share that is about the current
 * decision (everything outside PARKED and MORE); it is a composition ratio, not
 * a behavior result, so it is only meaningful next to the behavior labels.
 */
function summarizeInjection(rows) {
  const turns = rows.length;
  if (!turns) {
    return {
      turns: 0, packetAvg: null, relevantAvg: null, injectedAvg: null, injectedSum: 0, ratio: null,
      density: null, anchorOnly: 0, modes: {}, withAction: 0, withOutcome: 0,
    };
  }
  const sum = (pick) => rows.reduce((total, row) => total + (typeof row[pick] === 'number' ? row[pick] : 0), 0);
  const packetAvg = Math.round(sum('packet') / turns);
  const relevantAvg = Math.round(sum('relevant') / turns);
  const injectedSum = sum('injected');
  const injectedAvg = Math.round(injectedSum / turns);
  const anchorOnly = rows.filter((row) => !String(row.changed || '').trim()).length;
  const modes = {};
  for (const row of rows) {
    const mode = String(row.mode || 'unknown');
    modes[mode] = (modes[mode] || 0) + 1;
  }
  return {
    turns,
    packetAvg,
    relevantAvg,
    injectedAvg,
    injectedSum,
    ratio: packetAvg ? Math.round((injectedAvg / packetAvg) * 1000) / 1000 : null,
    density: packetAvg ? Math.round((relevantAvg / packetAvg) * 1000) / 1000 : null,
    anchorOnly,
    modes,
    withAction: rows.filter((row) => row.action).length,
    withOutcome: rows.filter((row) => row.outcome).length,
  };
}
