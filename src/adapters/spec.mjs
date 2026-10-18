// Adapter contract: the boundary between this repo's core behaviour and one
// concrete harness (Qoder today; ZCode, Codex, etc. tomorrow implement the
// same shape). The contract is intentionally tiny: identity, a truthful
// capability set, and a fixed list of lifecycle stages.
//
// Honesty rule: an adapter declares ONLY capabilities it actually provides.
// Absence means absence — never a capability faked to make a matrix look
// complete. Unknown capability names and non-function lifecycle fields are
// rejected at definition time so false claims fail loudly, not silently.

export const ADAPTER_CAPABILITIES = Object.freeze({
  subagents: 'Harness can launch delegated worker/subagent runs.',
  hooks: 'Harness supports lifecycle hooks (session, prompt, tool, subagent events).',
  resultRewrite: 'A hook can rewrite a tool result before the model sees it.',
  preCompact: 'Harness fires a pre-compaction event the adapter can act on.',
  mcp: 'Harness can run MCP servers.',
  installer: 'Adapter can install/uninstall its integration and self-check (doctor).',
  overlay: 'Adapter syncs user-level agent/content overlays on top of core roles.',
  sessionMap: 'Adapter keeps per-session role state (for example a conductor session map).',
  skills: 'Harness supports reusable skill packages the adapter can install.',
  modelSelection: 'Adapter can select or steer conductor/worker models through a harness mechanism.',
  statusLine: 'Harness exposes a status line the adapter renders into.',
  crossSession: 'Adapter coordinates across concurrent sessions beyond shared state files.',
});

export const LIFECYCLE_STAGES = Object.freeze([
  'detect',
  'install',
  'uninstall',
  'doctor',
  'refresh',
]);

const BRAND = Symbol.for('my-harness-enhance.adapter');
const SPEC_FIELDS = Object.freeze(['id', 'label', 'capabilities', 'lifecycle']);

function invalid(message) {
  return new TypeError(`Invalid adapter: ${message}`);
}

export function normalizeAdapterId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isAdapter(value) {
  return Boolean(value && value[BRAND] === true);
}

// validate + freeze. Returns a branded adapter object usable by the registry;
// raw objects are not adapters.
export function defineAdapter(spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw invalid('spec must be a plain object');
  }
  const unexpected = Object.keys(spec).filter((key) => !SPEC_FIELDS.includes(key));
  if (unexpected.length > 0) {
    throw invalid(`unexpected field(s) ${unexpected.join(', ')}; the contract is ${SPEC_FIELDS.join('/')}`);
  }

  const id = normalizeAdapterId(spec.id);
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw invalid(`id must be a non-empty lower identifier (a-z, digits, dot, dash, underscore), got ${JSON.stringify(spec.id)}`);
  }
  const label = typeof spec.label === 'string' ? spec.label.trim() : '';
  if (!label) {
    throw invalid(`id "${id}": label must be a non-empty string`);
  }

  if (!spec.capabilities || typeof spec.capabilities !== 'object' || Array.isArray(spec.capabilities)) {
    throw invalid(`id "${id}": capabilities must be an object of declared feature names`);
  }
  const capabilities = {};
  for (const [name, value] of Object.entries(spec.capabilities)) {
    if (!(name in ADAPTER_CAPABILITIES)) {
      throw invalid(`id "${id}": unknown capability "${name}"; declare only names from ADAPTER_CAPABILITIES`);
    }
    if (typeof value !== 'boolean') {
      throw invalid(`id "${id}": capability "${name}" must be a boolean`);
    }
    if (value) capabilities[name] = true; // false is absence; normalise it away
  }

  const lifecycle = {};
  if (spec.lifecycle !== undefined) {
    if (!spec.lifecycle || typeof spec.lifecycle !== 'object' || Array.isArray(spec.lifecycle)) {
      throw invalid(`id "${id}": lifecycle must be an object of stage functions`);
    }
    for (const [stage, fn] of Object.entries(spec.lifecycle)) {
      if (!LIFECYCLE_STAGES.includes(stage)) {
        throw invalid(`id "${id}": unknown lifecycle stage "${stage}"; stages are ${LIFECYCLE_STAGES.join('/')}`);
      }
      if (typeof fn !== 'function') {
        throw invalid(`id "${id}": lifecycle.${stage} must be a function`);
      }
      lifecycle[stage] = fn;
    }
  }

  return Object.freeze({
    [BRAND]: true,
    id,
    label,
    capabilities: Object.freeze(capabilities),
    lifecycle: Object.freeze(lifecycle),
  });
}

// Plain, JSON-serialisable description: identity, declared capability names,
// implemented lifecycle stage names. Functions never leave the adapter.
export function describeAdapter(adapter) {
  if (!isAdapter(adapter)) {
    throw invalid('describeAdapter expects a defineAdapter() result');
  }
  return {
    id: adapter.id,
    label: adapter.label,
    capabilities: Object.keys(adapter.capabilities).sort(),
    lifecycle: Object.keys(adapter.lifecycle).sort(),
  };
}
