export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Rough, dependency-free token estimate.
 * CJK code points count ~1 token each; other non-space characters ~0.28 token.
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
  return Math.ceil(cjk + other * 0.28);
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
  lines.push('scenario | baseline main | conductor main | reduction | baseline fits 180k | conductor fits 180k');
  lines.push('--- | ---: | ---: | ---: | --- | ---');
  for (const scenario of scenarios) {
    lines.push(
      `${scenario.name} | ${formatNumber(scenario.baseline.mainTokens)} | ` +
      `${formatNumber(scenario.router.mainTokens)} | ` +
      `${(scenario.reduction * 100).toFixed(1)}% | ` +
      `${scenario.baseline.fitsWindow ? 'yes' : 'no'} | ` +
      `${scenario.router.fitsWindow ? 'yes' : 'no'}`,
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
 */
export function summarizeMetrics(metrics = []) {
  const entries = Array.isArray(metrics)
    ? metrics.filter((entry) => entry && typeof entry === 'object')
    : [];
  const events = {};
  const denials = {};
  const statuses = {};
  const workers = {};
  const envelopeTokens = [];
  const agentResultTokens = [];
  const capsuleTokens = [];
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
  }

  return {
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
    capturedBytes,
    workers,
  };
}
