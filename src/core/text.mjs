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
