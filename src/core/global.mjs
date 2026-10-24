import os from 'node:os';
import path from 'node:path';
import { atomicWrite, readJson } from './fs-util.mjs';
import { canonicalPath, enhanceHome } from './state-root.mjs';

export function globalConfigPath() {
  return path.join(enhanceHome(), 'global.json');
}

export function readGlobalConfig() {
  return readJson(globalConfigPath(), {
    version: 1,
    autoRegister: false,
    harness: 'qoder',
    configDir: '',
    logging: 'errors',
    exclude: [],
  });
}

export function writeGlobalConfig(patch = {}) {
  const current = readGlobalConfig();
  const next = { ...current, ...patch, version: 1, updatedAt: new Date().toISOString() };
  atomicWrite(globalConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function isUnder(target, base) {
  const a = target.toLowerCase();
  const b = base.toLowerCase();
  return a === b || a.startsWith(`${b}${path.sep}`);
}

/**
 * Do not auto-register the user's home, filesystem roots, or OS install dirs.
 * A real workspace is anything else the user opens in Qoder.
 */
export function isExcludedProject(projectRoot, global = readGlobalConfig()) {
  const target = canonicalPath(projectRoot);
  const home = canonicalPath(os.homedir());
  const root = path.parse(target).root;
  if (target === home || target === root) return true;

  const defaults = process.platform === 'win32'
    ? [
      path.join(root, 'Windows'),
      path.join(root, 'Program Files'),
      path.join(root, 'Program Files (x86)'),
      path.join(root, 'ProgramData'),
    ]
    : ['/System', '/Library', '/Applications', '/usr', '/etc', '/bin', '/sbin', '/lib'];
  for (const base of defaults) {
    if (isUnder(target, base)) return true;
  }
  for (const entry of global.exclude || []) {
    if (entry && isUnder(target, canonicalPath(entry))) return true;
  }
  return false;
}
