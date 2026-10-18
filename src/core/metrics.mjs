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
