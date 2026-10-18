import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, readJson } from './fs-util.mjs';

/**
 * User-level state home. Nothing is written into the project repository.
 * Override for tests: MY_HARNESS_ENHANCE_HOME.
 */
export function enhanceHome() {
  return path.resolve(
    process.env.MY_HARNESS_ENHANCE_HOME ||
    path.join(os.homedir(), '.my-harness-enhance'),
  );
}

export function registryPath() {
  return path.join(enhanceHome(), 'projects.json');
}

export function canonicalPath(value) {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // path may not exist yet; use the resolved form
  }
  return resolved;
}

export function compareKey(value) {
  const canonical = canonicalPath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function projectKey(value) {
  return crypto
    .createHash('sha256')
    .update(compareKey(value))
    .digest('hex')
    .slice(0, 16);
}

export function projectStateDir(value) {
  return path.join(enhanceHome(), 'projects', projectKey(value));
}

export function readRegistry() {
  return readJson(registryPath(), { version: 1, projects: {} });
}

export function writeRegistry(registry) {
  atomicWrite(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

export function registerProject(projectRoot, entry = {}) {
  const canonical = canonicalPath(projectRoot);
  const key = projectKey(canonical);
  const registry = readRegistry();
  const previous = registry.projects[key] || {};
  const now = new Date().toISOString();
  const record = {
    ...previous,
    projectRoot: canonical,
    stateDir: previous.stateDir || projectStateDir(canonical),
    harness: entry.harness || previous.harness || '',
    configDir: entry.configDir || previous.configDir || '',
    enabled: entry.enabled ?? previous.enabled ?? true,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  registry.projects[key] = record;
  writeRegistry(registry);
  fs.mkdirSync(record.stateDir, { recursive: true });
  return record;
}

export function unregisterProject(projectRoot) {
  const key = projectKey(projectRoot);
  const registry = readRegistry();
  const removed = registry.projects[key] || null;
  if (removed) {
    delete registry.projects[key];
    writeRegistry(registry);
  }
  return removed;
}

export function resolveProject(start = process.cwd()) {
  const target = compareKey(start);
  const registry = readRegistry();
  const separator = process.platform === 'win32' ? '\\' : path.sep;
  let best = null;

  for (const [key, entry] of Object.entries(registry.projects || {})) {
    if (!entry?.projectRoot) continue;
    const rootKey = compareKey(entry.projectRoot);
    if (target !== rootKey && !target.startsWith(`${rootKey}${separator}`)) continue;
    if (!best || rootKey.length > best.rootKey.length) {
      best = { key, entry, rootKey };
    }
  }

  if (!best) return null;
  return {
    key: best.key,
    projectRoot: best.entry.projectRoot,
    stateDir: best.entry.stateDir || projectStateDir(best.entry.projectRoot),
    entry: best.entry,
  };
}

export function setProjectEnabled(projectRoot, enabled) {
  return registerProject(projectRoot, { enabled });
}
