import fs from 'node:fs';
import path from 'node:path';

/**
 * A review fixture: each patch adds one small module with exactly one planted
 * defect. The answer is the rule id, so the task needs judgment over the whole
 * hunk instead of a keyword search.
 */

export const REVIEW_RULES = [
  { id: 'off-by-one', hint: 'a loop or slice bound excludes or repeats the last element' },
  { id: 'wrong-comparison', hint: 'a filter or guard uses the wrong operator' },
  { id: 'unhandled-empty', hint: 'an empty input reaches a path that cannot handle it' },
  { id: 'mutated-input', hint: 'a caller-owned array or object is changed in place' },
  { id: 'wrong-error-type', hint: 'the thrown error type does not match the contract' },
  { id: 'lost-precision', hint: 'a division or rounding step silently drops information' },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADER = `/**
 * Generated module used by the review fixture.
 * Every function is small on purpose; one of them is wrong.
 */
`;

function sumTemplate(seed, defect) {
  const limit = 2 + (seed % 4);
  const body = defect === 'off-by-one'
    ? `  let total = 0;\n  for (let i = 0; i <= values.length; i += 1) {\n    total += values[i];\n  }\n  return total;`
    : `  let total = 0;\n  for (let i = 0; i < values.length; i += 1) {\n    total += values[i];\n  }\n  return total;`;
  return {
    name: 'sum',
    doc: `/**\n * Add up every number in the list.\n *\n * @param {number[]} values\n * @returns {number}\n */`,
    body,
    extra: `\n\n/**\n * Average of the list; a guard keeps an empty list from producing NaN.\n *\n * @param {number[]} values\n * @returns {number}\n */\nexport function average(values) {\n  if (values.length === 0) return 0;\n  return sum(values) / values.length;\n}\n\nexport const LIMIT = ${limit};\n`,
  };
}

function filterTemplate(seed, defect) {
  const threshold = 3 + (seed % 9);
  const body = defect === 'wrong-comparison'
    ? `  return values.filter((value) => value !== ${threshold});`
    : `  return values.filter((value) => value > ${threshold});`;
  return {
    name: 'aboveThreshold',
    doc: `/**\n * Keep only the values above the threshold.\n *\n * @param {number[]} values\n * @returns {number[]}\n */`,
    body,
    extra: `\n\nexport const THRESHOLD = ${threshold};\n`,
  };
}

function sortTemplate(seed, defect) {
  const pick = 1 + (seed % 3);
  const body = defect === 'mutated-input'
    ? `  return values.sort((a, b) => b - a).slice(0, ${pick});`
    : `  return [...values].sort((a, b) => b - a).slice(0, ${pick});`;
  return {
    name: 'largest',
    doc: `/**\n * Return the ${pick} largest values without disturbing the caller's array.\n *\n * @param {number[]} values\n * @returns {number[]}\n */`,
    body,
    extra: `\n\nexport const PICK = ${pick};\n`,
  };
}

function emptyTemplate(seed, defect) {
  const fallback = 10 + (seed % 20);
  const body = defect === 'unhandled-empty'
    ? `  return values[0] + ${fallback};`
    : `  if (values.length === 0) return ${fallback};\n  return values[0] + ${fallback};`;
  return {
    name: 'firstPlus',
    doc: `/**\n * Add the fallback to the first value; an empty list returns the fallback.\n *\n * @param {number[]} values\n * @returns {number}\n */`,
    body,
    extra: `\n\nexport const FALLBACK = ${fallback};\n`,
  };
}

function errorTemplate(seed, defect) {
  const bound = 5 + (seed % 10);
  const body = defect === 'wrong-error-type'
    ? `  if (value < 0) throw new RangeError('value must be non-negative');\n  if (value > ${bound}) throw new RangeError('value too large');\n  return value * 2;`
    : `  if (value < 0) throw new TypeError('value must be non-negative');\n  if (value > ${bound}) throw new RangeError('value too large');\n  return value * 2;`;
  return {
    name: 'double',
    doc: `/**\n * Double a bounded non-negative value.\n *\n * @param {number} value\n * @returns {number}\n */`,
    body,
    extra: `\n\nexport const BOUND = ${bound};\n`,
  };
}

function precisionTemplate(seed, defect) {
  const divisor = 3 + (seed % 4);
  const body = defect === 'lost-precision'
    ? `  return Math.floor(value / ${divisor});`
    : `  return value / ${divisor};`;
  return {
    name: 'share',
    doc: `/**\n * Divide a value by a fixed divisor, keeping the fraction.\n *\n * @param {number} value\n * @returns {number}\n */`,
    body,
    extra: `\n\nexport const DIVISOR = ${divisor};\n`,
  };
}

const TEMPLATES = [
  { make: sumTemplate, defect: 'off-by-one' },
  { make: filterTemplate, defect: 'wrong-comparison' },
  { make: sortTemplate, defect: 'mutated-input' },
  { make: emptyTemplate, defect: 'unhandled-empty' },
  { make: errorTemplate, defect: 'wrong-error-type' },
  { make: precisionTemplate, defect: 'lost-precision' },
];

/** Rotate the defect so 15 patches cover all six rules unevenly but repeatably. */
export function reviewPlan(count = 15, seed = 7) {
  const plan = [];
  for (let index = 0; index < count; index += 1) {
    const template = TEMPLATES[(index + seed) % TEMPLATES.length];
    plan.push({ index: index + 1, template, seed: seed + index * 13 });
  }
  return plan;
}

export const MODULE_SLOTS = 30;

/** Patch sizes the crossover probe uses: ~500, ~2,000 and ~8,000 lines. */
export const PATCH_SIZES = { small: 30, medium: 120, large: 480 };

/**
 * A module is `slots` functions: one carries the planted defect, the rest are
 * sound. A review needs something worth reading; a 20-line module makes the
 * baseline's per-turn input trivial and the comparison meaningless.
 */
export function renderModule(entry, slots = MODULE_SLOTS) {
  const parts = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const template = TEMPLATES[(entry.index + slot) % TEMPLATES.length];
    const defect = slot === 0 ? entry.template.defect : null;
    const seed = entry.seed + slot * 7;
    const { name, doc, body, extra } = template.make(seed, defect);
    const suffix = slot === 0 ? '' : String(slot);
    parts.push(`${doc}\nexport function ${name}${suffix}(values) {\n${body}\n}\n${extra}`);
  }
  return `${HEADER}\n${parts.join('\n')}`;
}

export function renderPatch(entry, slots = MODULE_SLOTS) {
  const file = `src/mod${String(entry.index).padStart(2, '0')}.mjs`;
  const lines = renderModule(entry, slots).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n');
}

const REVIEW_README = `# Review fixture

Each patch under \`patches/\` adds one small module. Every patch contains exactly
one functional defect.

The defect vocabulary is fixed; see \`RULES.md\`.

For patch \`NN.patch\`, write the rule id on the first line of \`answers/NN.txt\`.
Nothing else is required; extra lines are ignored.
`;

function rulesMarkdown() {
  const rows = REVIEW_RULES.map((rule) => `| \`${rule.id}\` | ${rule.hint} |`).join('\n');
  return `# Defect vocabulary

| rule id | what it looks like |
| --- | --- |
${rows}

Exactly one rule applies to each patch. If a patch looks like it breaks two
rules, the defect is the one that changes a result a caller depends on.
`;
}

/**
 * Write the review fixture into `dir` and return the planted answers so the
 * runner can check them without exposing the ground truth in the workspace.
 */
export function buildReviewFixture(dir, { count = 15, seed = 7, slots = MODULE_SLOTS } = {}) {
  fs.mkdirSync(path.join(dir, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), REVIEW_README, 'utf8');
  fs.writeFileSync(path.join(dir, 'RULES.md'), rulesMarkdown(), 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'mhe-review-fixture',
    private: true,
    type: 'module',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  const planted = [];
  for (const entry of reviewPlan(count, seed)) {
    const name = String(entry.index).padStart(2, '0');
    fs.writeFileSync(path.join(dir, 'patches', `${name}.patch`), renderPatch(entry, slots), 'utf8');
    planted.push({ index: entry.index, rule: entry.template.defect });
  }
  return planted;
}

export function reviewPrompts(count = 15) {
  return Array.from({ length: count }, (_, offset) => {
    const name = String(offset + 1).padStart(2, '0');
    return `Read patches/${name}.patch and RULES.md. The patch adds one module with exactly one functional defect. Write the matching rule id on the first line of answers/${name}.txt. Do not guess from the file name; read the code.`;
  });
}

/** Compare each answer file's first token with the planted rule. */
export function checkReviewAnswers(workspace, planted) {
  const started = Date.now();
  const findings = [];
  for (const { index, rule } of planted) {
    const name = String(index).padStart(2, '0');
    let answer = '';
    try {
      answer = fs.readFileSync(path.join(workspace, 'answers', `${name}.txt`), 'utf8').trim();
    } catch {
      findings.push({ index, expected: rule, actual: '', ok: false, reason: 'missing' });
      continue;
    }
    const actual = answer.split(/\s+/)[0].replace(/[^a-z-]/gi, '').toLowerCase();
    findings.push({ index, expected: rule, actual, ok: actual === rule, reason: actual === rule ? '' : 'mismatch' });
  }
  const passed = findings.filter((item) => item.ok).length;
  return {
    ok: passed === planted.length,
    code: passed === planted.length ? 0 : 1,
    timed_out: false,
    duration_ms: Date.now() - started,
    passed,
    failed: findings.length - passed,
    findings: findings.filter((item) => !item.ok).slice(0, 5),
  };
}