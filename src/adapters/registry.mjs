// Adapter registry: id -> adapter. Pure in-memory registration with no
// process side effects; importing this module does nothing. The built-in
// default set (Qoder, ZCode) is wired explicitly via
// registerDefaultAdapters(), which every query call also runs once as a
// lazy bootstrap so the registry "includes the built-in adapters by
// default" without import-time magic. Nothing in routing is specific to any
// one harness.

import { normalizeAdapterId, isAdapter } from './spec.mjs';
import { qoderAdapter } from './qoder/adapter.mjs';
import { zcodeAdapter } from './zcode/adapter.mjs';

export const HARNESS_ENV_VAR = 'MY_HARNESS_ENHANCE_HARNESS';

const adapters = new Map();
let defaultsApplied = false;

export function registerAdapter(adapter) {
  if (!isAdapter(adapter)) {
    throw new TypeError('registerAdapter expects an adapter created by defineAdapter()');
  }
  adapters.set(adapter.id, adapter);
  return adapter;
}

export function unregisterAdapter(id) {
  return adapters.delete(normalizeAdapterId(id));
}

// Idempotent, explicit wiring of the built-in adapters.
export function registerDefaultAdapters() {
  if (defaultsApplied) return;
  defaultsApplied = true;
  registerAdapter(qoderAdapter);
  registerAdapter(zcodeAdapter);
}

export function getAdapter(id) {
  registerDefaultAdapters();
  return adapters.get(normalizeAdapterId(id)) || null;
}

export function listAdapters() {
  registerDefaultAdapters();
  return Object.freeze(
    [...adapters.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function knownIds() {
  const ids = [...adapters.keys()].sort();
  return ids.length > 0 ? ids.join(', ') : '(none)';
}

// Resolution order: explicit id > HARNESS_ENV_VAR > each registered
// adapter's detect() probe (first truthy match wins) > clear error.
// A detect() that throws counts as no match: probing must not crash
// routing. Callers that want null instead of a throw can catch it; the
// default is loud, because silently returning null hides misconfiguration.
export function detectAdapter({
  env = process.env,
  payload = undefined,
  explicit = undefined,
} = {}) {
  registerDefaultAdapters();

  const wanted = normalizeAdapterId(explicit) || normalizeAdapterId(env?.[HARNESS_ENV_VAR]);
  if (wanted) {
    const adapter = adapters.get(wanted);
    if (!adapter) {
      throw new Error(
        `Unknown harness "${wanted}". Registered adapters: ${knownIds()}. ` +
        `Register it first or fix ${HARNESS_ENV_VAR}/explicit.`,
      );
    }
    return adapter;
  }

  for (const adapter of listAdapters()) {
    const detect = adapter.lifecycle.detect;
    if (!detect) continue;
    let matched;
    try {
      matched = detect({ env, payload });
    } catch {
      continue;
    }
    if (matched) return adapter;
  }

  throw new Error(
    `No harness adapter matched. Set ${HARNESS_ENV_VAR} to one of: ${knownIds()}, ` +
    'or pass an explicit id. Adapters without a detect() stage are never probed.',
  );
}
