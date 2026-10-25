/**
 * One vocabulary for worker failures, so the conductor can tell "try again"
 * from "this will never work".
 */

export const RETRY_BUDGET = 2;

const RULES = [
  { id: 'quota', pattern: /usage limit|rate limit|quota|error_code["\s:]*110|too many requests|429/i },
  { id: 'permission', pattern: /permission|denied|forbidden|EACCES|EPERM|not allowed/i },
  { id: 'timeout', pattern: /timeout|timed out|ETIMEDOUT|exceeded \d+ms/i },
  { id: 'transient', pattern: /ECONNRESET|ECONNREFUSED|socket hang up|transport closed|network|EPIPE|50[234]|unavailable/i },
  { id: 'no-data', pattern: /no result|empty (?:result|response)|not found|ENOENT/i },
  { id: 'invalid', pattern: /invalid|schema|parse|malformed|unexpected token|JSON/i },
];

export function classifyError(value) {
  const text = String(value || '');
  if (!text.trim()) return 'unknown';
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return 'unknown';
}

/**
 * Worth another dispatch. `invalid` belongs here because a contract violation is
 * answered by re-delegating with the contract, not by changing the task.
 */
export function isRetryable(className) {
  return className === 'transient' || className === 'timeout'
    || className === 'no-data' || className === 'invalid';
}

/**
 * Decide what a failed attempt means for the task it belongs to. A class that
 * cannot succeed on retry is dead on arrival; a retryable class is dead once
 * the budget is spent.
 */
export function failureVerdict({ error, attempts = 0, budget = RETRY_BUDGET }) {
  const className = classifyError(error);
  const retryable = isRetryable(className);
  const spent = attempts >= budget;
  return {
    error_class: className,
    attempts,
    retryable: retryable && !spent,
    dead_letter: !retryable || spent,
    reason: !retryable
      ? `${className} is not fixed by retrying`
      : spent
        ? `${className} persisted through ${attempts} attempts`
        : `${className}: retry, ${budget - attempts} attempt(s) left`,
  };
}