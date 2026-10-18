import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readJson } from '../../core/fs-util.mjs';
import { enhanceHome } from '../../core/state-root.mjs';

// Personal overlay for Qoder agent .md content. The repo holds the versionable
// personal defaults; a machine-local directory can override them file-by-file.
// Sync copies the merged result into the user's Qoder config dir (agents/).
//
// The shipped repo overlay is intentionally EMPTY: personal agents are added
// explicitly by the user, and abandoned legacy artifacts (the old env-runner /
// reasoner) are not defaults and are never installed. This layer NEVER writes
// into a target workspace/project repo and never deletes official or unrelated
// agents.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '../../../overlays/qoder');

function slashKey(file) {
  // Stable, comparable manifest key across sync/uninstall/doctor within a run.
  return path.resolve(file);
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// `repoRoot` is overridable so tests can exercise the mechanism against a
// temporary overlay instead of the (empty) shipped one. Manifest and user-level
// overlay always live under the user home, independent of repoRoot.
export function overlayDirs({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const root = path.resolve(repoRoot);
  const base = path.join(enhanceHome(), 'overlays', 'qoder');
  return {
    repoRoot: root,
    repoAgentsDir: path.join(root, 'agents'),
    repoPlatformsPath: path.join(root, 'agents.platforms.json'),
    userAgentsDir: path.join(base, 'agents'),
    manifestPath: path.join(base, 'manifest.json'),
  };
}

function loadManifest() {
  const { manifestPath } = overlayDirs();
  const data = readJson(manifestPath, null);
  if (!data || typeof data !== 'object' || !data.targets || typeof data.targets !== 'object') {
    return { version: 1, targets: {} };
  }
  return { version: 1, targets: data.targets };
}

function saveManifest(manifest) {
  const { manifestPath } = overlayDirs();
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Platform constraints for repo-sourced files, from a repo-level sidecar keyed
// by filename to an array of allowed process.platform values (e.g. ["win32"]).
// A file not listed has no constraint.
function loadPlatformConstraints(platformsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(platformsPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const map = {};
    for (const [file, value] of Object.entries(data)) {
      if (Array.isArray(value)) map[file] = value.map(String);
    }
    return map;
  } catch {
    return {};
  }
}

// Merge repo overlay with the machine-local user overlay by filename. The user
// file wins, which keeps personal overrides out of the versionable repo.
function mergeSources(repoDir, userDir) {
  const map = new Map();
  for (const name of listMd(repoDir)) {
    map.set(name, { path: path.join(repoDir, name), kind: 'repo' });
  }
  for (const name of listMd(userDir)) {
    map.set(name, { path: path.join(userDir, name), kind: 'user' });
  }
  return map;
}

/**
 * Read-only classification of what a sync would do. Used by both the sync
 * writer and doctor, so reporting and applying can never disagree.
 *
 * `platform` defaults to process.platform; `repoRoot` defaults to the shipped
 * repo overlay. Both are overridable for tests.
 */
export function planOverlaySync({ configDir, platform = process.platform, repoRoot } = {}) {
  const dirs = overlayDirs({ repoRoot });
  const agentsDir = path.join(slashKey(configDir), 'agents');
  const targetKey = agentsDir;
  const manifest = loadManifest();
  const recorded = manifest.targets[targetKey]?.files || {};
  const sources = mergeSources(dirs.repoAgentsDir, dirs.userAgentsDir);
  const constraints = loadPlatformConstraints(dirs.repoPlatformsPath);

  const plan = [];
  const conflicts = [];
  const skippedPlatform = [];
  for (const [file, src] of sources) {
    const content = fs.readFileSync(src.path);
    const sourceHash = sha256(content);
    const target = path.join(agentsDir, file);
    const entry = recorded[file];

    // Platform filtering applies only to repo-sourced files. A user-level
    // override is machine-local and explicit, so it always installs.
    if (src.kind === 'repo' && Array.isArray(constraints[file]) && !constraints[file].includes(platform)) {
      const item = {
        file,
        kind: src.kind,
        sourcePath: src.path,
        content,
        sourceHash,
        target,
        action: 'skip-platform',
        reason: `repo overlay is constrained to ${constraints[file].join(', ')}; current platform is ${platform}`,
      };
      plan.push(item);
      skippedPlatform.push({ file, kind: src.kind, allowed: constraints[file], platform });
      continue;
    }

    let action;
    let reason;
    if (!fs.existsSync(target)) {
      action = 'install';
    } else {
      const currentHash = sha256(fs.readFileSync(target));
      if (entry) {
        if (currentHash !== entry.installedHash) {
          action = 'conflict';
          reason = 'target was modified since this tool installed it';
        } else if (currentHash === sourceHash) {
          action = 'unchanged';
        } else {
          action = 'update';
        }
      } else if (currentHash === sourceHash) {
        // Identical unmanaged target: adopt it so future runs track it without
        // a rewrite. Adoption is not ownership — uninstall leaves it in place.
        action = 'adopt';
      } else {
        action = 'conflict';
        reason = 'target already exists and is not managed by this tool';
      }
    }
    const item = {
      file,
      kind: src.kind,
      sourcePath: src.path,
      content,
      sourceHash,
      target,
      action,
      reason,
      installedHash: entry ? entry.installedHash : null,
    };
    plan.push(item);
    if (action === 'conflict') {
      conflicts.push({
        file,
        reason,
        target,
        kind: src.kind,
        installedHash: entry?.installedHash ?? null,
      });
    }
  }

  return {
    agentsDir,
    targetKey,
    plan,
    conflicts,
    skippedPlatform,
    sources: {
      repo: listMd(dirs.repoAgentsDir).length,
      user: listMd(dirs.userAgentsDir).length,
      merged: sources.size,
    },
  };
}

// origin records why a file is managed, which drives uninstall safety:
//   installed/updated -> this tool owns it and may remove it while clean;
//   adopted           -> it pre-existed this tool, never deleted on uninstall.
function entryFor(item, origin) {
  return {
    installedHash: item.sourceHash,
    origin,
    sourceKind: item.kind,
    sourcePath: item.sourcePath,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Copy merged overlay agents into configDir/agents. Idempotent; supports
 * dry-run; skips platform-constrained repo files on incompatible platforms;
 * never deletes official or unrelated agents; never clobbers a target that
 * changed since we installed it or that we did not install.
 */
export function syncOverlayAgents({ configDir, dryRun = false, platform = process.platform, repoRoot } = {}) {
  const result = planOverlaySync({ configDir, platform, repoRoot });
  const summary = {
    ok: true,
    dryRun,
    agentsDir: result.agentsDir,
    sources: result.sources,
    installed: [],
    updated: [],
    adopted: [],
    unchanged: [],
    skippedPlatform: result.skippedPlatform.map((s) => s.file),
    conflicts: result.conflicts.map((c) => ({ file: c.file, reason: c.reason })),
  };

  if (dryRun) {
    for (const item of result.plan) {
      if (item.action === 'install') summary.installed.push(item.file);
      else if (item.action === 'update') summary.updated.push(item.file);
      else if (item.action === 'adopt') summary.adopted.push(item.file);
      else if (item.action === 'unchanged') summary.unchanged.push(item.file);
    }
    return summary;
  }

  const manifest = loadManifest();
  const bucket = manifest.targets[result.targetKey] || { files: {} };
  bucket.files = bucket.files || {};
  let dirty = false;
  for (const item of result.plan) {
    if (item.action === 'install') {
      fs.mkdirSync(result.agentsDir, { recursive: true });
      atomicWrite(item.target, item.content);
      bucket.files[item.file] = entryFor(item, 'installed');
      summary.installed.push(item.file);
      dirty = true;
    } else if (item.action === 'update') {
      atomicWrite(item.target, item.content);
      bucket.files[item.file] = entryFor(item, 'updated');
      summary.updated.push(item.file);
      dirty = true;
    } else if (item.action === 'adopt') {
      bucket.files[item.file] = entryFor(item, 'adopted');
      summary.adopted.push(item.file);
      dirty = true;
    } else if (item.action === 'unchanged') {
      summary.unchanged.push(item.file);
    }
    // skip-platform and conflict: leave target and manifest entry untouched.
  }
  if (dirty) {
    manifest.targets[result.targetKey] = bucket;
    saveManifest(manifest);
  }
  return summary;
}

/**
 * Remove only the files this tool installed (origin installed/updated) that are
 * still unmodified. A file that merely pre-existed and was adopted is kept and
 * its manifest entry dropped; a modified file is left in place. Official and
 * unrelated agents are never considered.
 */
export function uninstallOverlayAgents({ configDir, dryRun = false } = {}) {
  const agentsDir = path.join(slashKey(configDir), 'agents');
  const targetKey = agentsDir;
  const manifest = loadManifest();
  const files = manifest.targets[targetKey]?.files || {};
  const summary = {
    ok: true,
    dryRun,
    agentsDir,
    removed: [],
    keptAdopted: [],
    keptModified: [],
    droppedStale: [],
  };

  let dirty = false;
  for (const [file, entry] of Object.entries(files)) {
    const target = path.join(agentsDir, file);
    if (!fs.existsSync(target)) {
      // The managed file is already gone; forget it so uninstall converges.
      if (!dryRun) {
        delete files[file];
        dirty = true;
      }
      summary.droppedStale.push(file);
      continue;
    }
    const currentHash = sha256(fs.readFileSync(target));
    if (currentHash !== entry.installedHash) {
      // Modified since install: leave the file and its manifest entry intact so
      // a later sync still reports a conflict rather than silently reclaiming it.
      summary.keptModified.push(file);
      continue;
    }
    // Clean (hash matches). Adopted files pre-existed this tool and must never
    // be deleted: drop only the manifest record. Installed/updated are ours to
    // remove.
    if (entry.origin === 'adopted') {
      if (!dryRun) {
        delete files[file];
        dirty = true;
      }
      summary.keptAdopted.push(file);
      continue;
    }
    if (!dryRun) {
      fs.rmSync(target, { force: true });
      delete files[file];
      dirty = true;
    }
    summary.removed.push(file);
  }

  if (!dryRun && dirty) {
    if (Object.keys(files).length === 0) delete manifest.targets[targetKey];
    else manifest.targets[targetKey] = { files };
    saveManifest(manifest);
  }
  return summary;
}

/**
 * Read-only view for `mhe doctor`: what is currently managed (with origin),
 * what conflicts and platform skips exist, and how many sources are in play.
 * Never writes anything.
 */
export function doctorOverlay({ configDir, platform = process.platform, repoRoot } = {}) {
  const plan = planOverlaySync({ configDir, platform, repoRoot });
  const manifest = loadManifest();
  const managed = manifest.targets[plan.targetKey]?.files || {};
  const pending = {};
  for (const item of plan.plan) {
    if (item.action !== 'conflict' && item.action !== 'skip-platform') {
      pending[item.action] = (pending[item.action] || 0) + 1;
    }
  }
  return {
    agentsDir: plan.agentsDir,
    repoCount: plan.sources.repo,
    userCount: plan.sources.user,
    mergedCount: plan.sources.merged,
    managed: Object.entries(managed).map(([file, entry]) => ({
      file,
      origin: entry.origin ?? 'installed', // pre-origin manifests read as owned
      sourceKind: entry.sourceKind,
      installedHash: entry.installedHash,
    })),
    conflicts: plan.conflicts,
    skippedPlatform: plan.skippedPlatform,
    pending,
  };
}
