import { DEFAULT_CONFIG } from './config.mjs';
import { clipText } from './text.mjs';

export const ENVELOPE_VERSION = 1;

export const STATUSES = ['ok', 'partial', 'blocked', 'failed', 'needs_split'];

const STATUS_ALIASES = new Map([
  ['done', 'ok'],
  ['complete', 'ok'],
  ['completed', 'ok'],
  ['success', 'ok'],
  ['succeeded', 'ok'],
  ['error', 'failed'],
]);

const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;

function clip(value, max) {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return clipText(value, max - 8, '…[truncated]');
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Qoder tool responses can be strings, arrays of content blocks, or objects
 * with text/content/result fields. Find the most useful text representation.
 */
export function extractText(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return String(value);
  if (value.status && value.summary) return JSON.stringify(value);
  for (const key of [
    'last_assistant_message',
    'lastAssistantMessage',
    'text',
    'content',
    'result',
    'message',
    'final_message',
    'finalMessage',
    'output',
    'response',
    'messages',
    'parts',
    'data',
  ]) {
    if (key in value) {
      const text = extractText(value[key], depth + 1);
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function parseJsonCandidates(text) {
  const out = [];
  try {
    out.push(JSON.parse(text));
  } catch {
    // ignore
  }

  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fenced.exec(text)) !== null) {
    try {
      out.push(JSON.parse(match[1].trim()));
    } catch {
      // ignore
    }
  }

  // Scan balanced objects, last valid one wins. This tolerates prose before/after.
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
          } catch {
            // ignore
          }
          break;
        }
      }
    }
  }
  return out;
}

function normalizeEntry(entry, kind) {
  if (entry == null) return null;
  if (kind === 'evidence') {
    // Evidence is a reference the conductor may inspect: a file path, URL,
    // artifact handle, file:line, etc. It is not required to be an internal
    // content-addressed artifact handle.
    const ref = typeof entry === 'string'
      ? entry
      : String(entry.handle || entry.ref || entry.id || '');
    if (!ref.trim()) return null;
    return {
      handle: clip(ref.trim(), 500),
      note: clip(String(typeof entry === 'object' ? (entry.note || entry.summary || '') : ''), 300),
    };
  }
  if (typeof entry === 'string') {
    const ref = entry.trim();
    if (!ref) return null;
    return { handle: clip(ref, 500), kind: '', summary: '' };
  }
  if (typeof entry !== 'object') return null;
  const handle = String(entry.handle || entry.id || entry.ref || '').trim();
  if (!handle) return null;
  // Artifact refs may be file paths, URLs, or internal content-addressed
  // handles. enhance_artifact still validates internal handles separately.
  return {
    handle: clip(handle, 500),
    kind: clip(String(entry.kind || ''), 40),
    summary: clip(String(entry.summary || entry.note || ''), 300),
  };
}

export function validateEnvelope(value, limits = DEFAULT_CONFIG.envelope) {
  const errors = [];
  const warnings = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['envelope must be a JSON object'], warnings, value: null };
  }

  const rawStatus = String(value.status || '').trim();
  const status = STATUS_ALIASES.get(rawStatus.toLowerCase()) || rawStatus;
  if (!STATUSES.includes(status)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  }

  const rawSummary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!rawSummary) errors.push('summary is required');
  if (rawSummary.length > limits.maxSummaryChars) {
    warnings.push(`summary truncated from ${rawSummary.length} to ${limits.maxSummaryChars} chars`);
  }
  const summary = clip(rawSummary, limits.maxSummaryChars);

  const evidence = [];
  const rawEvidence = Array.isArray(value.evidence) ? value.evidence : [];
  // Workers often overproduce evidence; keep the first N instead of rejecting.
  if (rawEvidence.length > limits.maxEvidence) {
    warnings.push(`evidence truncated from ${rawEvidence.length} to ${limits.maxEvidence} entries`);
  }
  for (const item of rawEvidence.slice(0, limits.maxEvidence)) {
    const normalized = normalizeEntry(item, 'evidence');
    if (!normalized) errors.push('evidence entry has an invalid handle');
    else evidence.push(normalized);
  }

  const artifacts = [];
  const rawArtifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  if (rawArtifacts.length > limits.maxArtifacts) {
    warnings.push(`artifacts truncated from ${rawArtifacts.length} to ${limits.maxArtifacts} entries`);
  }
  for (const item of rawArtifacts.slice(0, limits.maxArtifacts)) {
    const normalized = normalizeEntry(item, 'artifact');
    if (!normalized) errors.push('artifact entry has an invalid handle');
    else artifacts.push(normalized);
  }

  const rawQuestions = Array.isArray(value.open_questions) ? value.open_questions : [];
  if (rawQuestions.length > limits.maxOpenQuestions) {
    warnings.push(`open_questions truncated from ${rawQuestions.length} to ${limits.maxOpenQuestions} entries`);
  }
  const openQuestions = rawQuestions
    .slice(0, limits.maxOpenQuestions)
    .map((item) => clip(asString(item), 300));

  const next = clip(asString(value.next || ''), 500);

  // Decision-ready fields. All optional, so an older worker keeps working; when
  // present they are what the conductor needs to accept, reject, or unblock
  // without reading the whole summary.
  const decision = clip(asString(value.decision || ''), 240);
  const impact = clip(asString(value.impact || ''), 240);
  const blocking = clip(asString(value.blocking || ''), 240);
  const whatChanged = clip(asString(value.what_changed || value.whatChanged || ''), 400);

  let needsSplit = null;
  if (status === 'needs_split') {
    const raw = value.needs_split;
    if (!raw || typeof raw !== 'object') {
      errors.push('needs_split is required when status=needs_split');
    } else {
      const proposed = Array.isArray(raw.proposed) ? raw.proposed.slice(0, 8) : [];
      if (proposed.length === 0) errors.push('needs_split.proposed must not be empty');
      needsSplit = {
        reason: clip(asString(raw.reason), 500),
        proposed: proposed.map((item) => ({
          title: clip(asString(item?.title || item?.task), 200),
          why: clip(asString(item?.why), 300),
        })),
      };
    }
  }

  let data = null;
  if (value.data !== undefined) {
    try {
      const serialized = JSON.stringify(value.data);
      if (serialized.length <= 4000) {
        data = value.data;
      } else {
        // A valid envelope can carry an oversized data payload. Keep the
        // envelope (summary/evidence matter) and drop the bulky data; the
        // conductor can retrieve details from artifacts or re-delegate.
        warnings.push(`data exceeded 4000 chars (${serialized.length}) and was dropped`);
        data = {
          truncated: true,
          note: `data exceeded 4000 chars (${serialized.length}) and was dropped`,
          keys: value.data && typeof value.data === 'object'
            ? Object.keys(value.data).slice(0, 12)
            : [],
        };
      }
    } catch {
      errors.push('data must be JSON-serializable');
    }
  }

  const cost = value.cost && typeof value.cost === 'object' ? {
    tokens_in: Number(value.cost.tokens_in) || 0,
    tokens_out: Number(value.cost.tokens_out) || 0,
    ms: Number(value.cost.ms) || 0,
    model: clip(asString(value.cost.model), 80),
  } : null;

  const confidence = Number.isFinite(Number(value.confidence))
    ? Math.max(0, Math.min(1, Number(value.confidence)))
    : null;

  const taskId = clip(asString(value.task_id || ''), 80);
  const rawCheck = value.check_result;
  const checkResult = rawCheck && typeof rawCheck === 'object' && !Array.isArray(rawCheck)
    ? {
      ok: rawCheck.ok === true,
      checker: clip(asString(rawCheck.checker || ''), 80),
      findings: Array.isArray(rawCheck.findings)
        ? Math.min(rawCheck.findings.length, 999)
        : Math.max(0, Math.min(999, Number(rawCheck.findings) || 0)),
    }
    : null;

  if (errors.length > 0) {
    return { ok: false, errors, warnings, value: null };
  }

  const normalized = {
    v: ENVELOPE_VERSION,
    status,
    summary: summary.trim(),
    evidence,
    artifacts,
    open_questions: openQuestions,
    next,
    decision,
    impact,
    blocking,
    what_changed: whatChanged,
    needs_split: needsSplit,
    data,
    cost,
    confidence,
    task_id: taskId,
    brief_hash: clip(asString(value.brief_hash || ''), 80),
    task_hash: clip(asString(value.task_hash || ''), 80),
    check_result: checkResult,
    warnings: warnings.slice(0, 8),
  };

  let total = JSON.stringify(normalized).length;
  if (total > limits.maxTotalChars) {
    // Trim optional fields deterministically; the conductor needs status,
    // summary, evidence and next more than an exhaustive payload.
    warnings.push('envelope trimmed to fit maxTotalChars');
    normalized.warnings = warnings.slice(0, 8);
    normalized.data = normalized.data ? { truncated: true } : null;
    normalized.open_questions = normalized.open_questions.slice(0, 3);
    normalized.evidence = normalized.evidence.slice(0, 4);
    normalized.artifacts = normalized.artifacts.slice(0, 4);
    normalized.summary = clip(normalized.summary, Math.max(300, Math.floor(limits.maxSummaryChars / 2)));
    total = JSON.stringify(normalized).length;
  }
  if (total > limits.maxTotalChars) {
    normalized.evidence = [];
    normalized.artifacts = [];
    normalized.open_questions = [];
    normalized.needs_split = null;
    normalized.data = null;
    total = JSON.stringify(normalized).length;
  }
  if (total > limits.maxTotalChars) {
    return {
      ok: false,
      errors: [`envelope exceeds ${limits.maxTotalChars} chars (${total})`],
      warnings,
      value: null,
    };
  }

  return { ok: true, errors: [], warnings, value: normalized };
}

function looksLikeTemplate(value) {
  if (!value || typeof value !== 'object') return false;
  const status = typeof value.status === 'string' ? value.status.trim() : '';
  if (status.includes('|')) return true;
  const summary = String(value.summary || '').trim();
  if (/^<=?\s*\d+\s*chars?/i.test(summary)) return true;
  if (/^factual,\s*no transcript/i.test(summary)) return true;
  return false;
}

export function parseEnvelope(input, limits = DEFAULT_CONFIG.envelope) {
  if (input == null) {
    return { ok: false, errors: ['empty worker result'], value: null, raw: '' };
  }

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (input.status && input.summary && !looksLikeTemplate(input)) {
      const result = validateEnvelope(input, limits);
      return { ...result, raw: JSON.stringify(input) };
    }
  }

  const raw = extractText(input);
  if (!raw.trim()) {
    return { ok: false, errors: ['empty worker result'], value: null, raw };
  }

  const candidates = parseJsonCandidates(raw);
  let lastError = null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    if (!('status' in candidate) || !('summary' in candidate)) continue;
    if (looksLikeTemplate(candidate)) continue;
    const result = validateEnvelope(candidate, limits);
    if (result.ok) return { ...result, raw };
    lastError = result.errors;
  }

  return {
    ok: false,
    errors: lastError || ['no JSON envelope with status and summary found'],
    value: null,
    raw,
  };
}

export function compactEnvelope(envelope, maxChars = DEFAULT_CONFIG.envelope.maxTotalChars) {
  const out = {
    v: ENVELOPE_VERSION,
    status: envelope.status,
    summary: envelope.summary,
    evidence: envelope.evidence || [],
    artifacts: envelope.artifacts || [],
    open_questions: envelope.open_questions || [],
    next: envelope.next || '',
    decision: envelope.decision || '',
    impact: envelope.impact || '',
    blocking: envelope.blocking || '',
    what_changed: envelope.what_changed || '',
    needs_split: envelope.needs_split || null,
    data: envelope.data ?? null,
    cost: envelope.cost || null,
    confidence: envelope.confidence ?? null,
    task_id: envelope.task_id || '',
    brief_hash: envelope.brief_hash || '',
    task_hash: envelope.task_hash || '',
    check_result: envelope.check_result || null,
    warnings: Array.isArray(envelope.warnings) ? [...envelope.warnings] : [],
  };
  const note = (text) => {
    if (!out.warnings.includes(text)) out.warnings.push(text);
  };
  let text = JSON.stringify(out);
  if (text.length <= maxChars) return text;

  // Trim the least important fields first. Every trim is recorded so the
  // conductor does not mistake a reduced result for a complete one.
  note('compactEnvelope trimmed fields to fit maxChars');
  out.data = out.data ? { truncated: true } : null;
  out.open_questions = out.open_questions.slice(0, 3);
  out.evidence = out.evidence.slice(0, 4);
  out.artifacts = out.artifacts.slice(0, 4);
  out.summary = clip(out.summary, Math.max(200, Math.floor(maxChars / 2)));
  out.warnings = out.warnings.slice(0, 8);
  text = JSON.stringify(out);
  if (text.length <= maxChars) return text;

  const fullEvidence = out.evidence;
  const fullArtifacts = out.artifacts;
  const fullQuestions = out.open_questions;
  const fullNeedsSplit = out.needs_split;
  out.evidence = [];
  out.artifacts = [];
  out.open_questions = [];
  out.needs_split = null;
  out.next = clip(out.next, 200);
  const refill = (key, items) => {
    for (const item of items) {
      const candidate = { ...out, [key]: [...out[key], item] };
      if (JSON.stringify(candidate).length <= maxChars) out[key] = candidate[key];
    }
  };
  refill('evidence', fullEvidence);
  refill('artifacts', fullArtifacts);
  refill('open_questions', fullQuestions);
  if (fullNeedsSplit) {
    const candidate = { ...out, needs_split: fullNeedsSplit };
    if (JSON.stringify(candidate).length <= maxChars) out.needs_split = fullNeedsSplit;
  }
  text = JSON.stringify(out);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function invalidResultEnvelope(reason, raw = '') {
  return {
    v: ENVELOPE_VERSION,
    status: 'failed',
    summary: `INVALID_WORKER_RESULT: ${clip(reason, 400)}`,
    evidence: [],
    artifacts: [],
    open_questions: [],
    next: 'Re-delegate with the exact JSON envelope contract.',
    needs_split: null,
    data: raw ? { raw_excerpt: clip(raw, 800) } : null,
    cost: null,
    confidence: null,
    task_id: '',
    check_result: null,
    warnings: [],
  };
}
