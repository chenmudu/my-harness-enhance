import fs from 'node:fs';
import path from 'node:path';

export function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse to replace an existing file; fall back to copy.
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${file}.corrupt-${stamp}`;
  for (let index = 2; fs.existsSync(target); index += 1) {
    target = `${file}.corrupt-${stamp}-${index}`;
  }
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return '';
  }
}

/**
 * A missing file is normal (first run). A file that exists but does not parse is
 * corruption: with `quarantine` the bad bytes are moved aside so the next write
 * starts from a clean slate instead of silently overwriting the evidence.
 */
export function readJson(file, fallback, { quarantine: moveAside = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (moveAside) quarantine(file);
    return fallback;
  }
}
