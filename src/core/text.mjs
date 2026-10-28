export function safeEnd(text, end) {
  let cut = Math.max(0, Math.min(end, text.length));
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  return cut;
}

export function clipText(value, maxChars, suffix = '…[truncated]') {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, safeEnd(text, keep))}${suffix}`;
}

/** Hard budget on an estimated-token count; the marker is counted too. */
export function fitToTokens(text, maxTokens, estimate, marker = '\n…[capsule truncated]') {
  if (maxTokens <= 0) return '';
  if (estimate(text) <= maxTokens) return text;
  const suffix = marker;
  const room = maxTokens - estimate(suffix);
  if (room <= 0) return suffix.trim();
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimate(text.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, safeEnd(text, low))}${suffix}`;
}
