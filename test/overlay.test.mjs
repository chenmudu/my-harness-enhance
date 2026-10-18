import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  doctorOverlay,
  overlayDirs,
  syncOverlayAgents,
  uninstallOverlayAgents,
} from '../src/adapters/qoder/overlay.mjs';
import { installQoder, uninstallQoder } from '../src/adapters/qoder/install.mjs';

// The shipped repo overlay is empty by default (legacy env-runner/reasoner are
// abandoned artifacts, not personal defaults). These tests exercise the general
// overlay mechanism through an injected temporary repo overlay root, so they
// never reintroduce legacy files as shipped defaults and never depend on the
// host platform.

const ENV_CONTENT = '---\nname: env-runner\ndescription: fixture 测试 ⚙\nmodel: qfmodel\ntools: "*"\n---\nbody\n';
const REASONER_CONTENT = '---\nname: reasoner\ndescription: fixture 测试\nmodel: qfmodel\ntools: []\n---\nbody\n';
const TWO_FILES = { 'env-runner.md': ENV_CONTENT, 'reasoner.md': REASONER_CONTENT };

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mhe-${name}-`));
}

function freshEnv() {
  const home = tmp('ovh');
  process.env.MY_HARNESS_ENHANCE_HOME = home;
  const configDir = tmp('ovcfg');
  return { home, configDir };
}

// Build a temporary repo overlay root: <root>/agents/*.md (+ optional platform file).
function makeRepo(files, platforms = null) {
  const repoRoot = tmp('ovrepo');
  const dir = path.join(repoRoot, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  if (platforms) {
    fs.writeFileSync(path.join(repoRoot, 'agents.platforms.json'), `${JSON.stringify(platforms)}\n`);
  }
  return repoRoot;
}

function agentsOf(configDir) {
  return path.join(configDir, 'agents');
}

function writeAgent(configDir, name, content) {
  const dir = agentsOf(configDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function manifestFiles() {
  const manifest = JSON.parse(fs.readFileSync(overlayDirs().manifestPath, 'utf8'));
  const key = Object.keys(manifest.targets)[0];
  return key ? manifest.targets[key].files : {};
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('shipped active overlay is empty by default', () => {
  const { configDir } = freshEnv();
  const report = syncOverlayAgents({ configDir });
  assert.equal(report.sources.merged, 0);
  assert.equal(report.installed.length, 0);
  assert.deepEqual(report.skippedPlatform, []);
  assert.equal(fs.existsSync(agentsOf(configDir)), false);
  assert.equal(fs.existsSync(overlayDirs().manifestPath), false);
});

test('repo overlay files are copied into configDir/agents byte-for-byte', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES);
  const report = syncOverlayAgents({ configDir, repoRoot });
  assert.deepEqual(report.installed.slice().sort(), ['env-runner.md', 'reasoner.md']);

  const dir = agentsOf(configDir);
  for (const name of ['env-runner.md', 'reasoner.md']) {
    const src = fs.readFileSync(path.join(repoRoot, 'agents', name));
    const dst = fs.readFileSync(path.join(dir, name));
    assert.ok(Buffer.compare(src, dst) === 0, `${name} differs from source`);
  }

  const files = manifestFiles();
  assert.deepEqual(Object.keys(files).sort(), ['env-runner.md', 'reasoner.md']);
  for (const name of ['env-runner.md', 'reasoner.md']) {
    assert.equal(files[name].origin, 'installed');
    assert.equal(files[name].sourceKind, 'repo');
    assert.equal(files[name].installedHash, sha256(path.join(dir, name)));
  }
});

test('user-level overlay wins over repo overlay by filename', () => {
  const { home, configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES);
  const userDir = path.join(home, 'overlays', 'qoder', 'agents');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'env-runner.md'), '# custom env-runner\n');

  const report = syncOverlayAgents({ configDir, repoRoot });
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'env-runner.md'), 'utf8'), '# custom env-runner\n');
  assert.equal(report.sources.repo, 2);
  assert.equal(report.sources.user, 1);
  assert.equal(report.sources.merged, 2);

  const files = manifestFiles();
  assert.equal(files['env-runner.md'].sourceKind, 'user');
  assert.equal(files['reasoner.md'].sourceKind, 'repo');
});

test('sync is idempotent', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES);
  const first = syncOverlayAgents({ configDir, repoRoot });
  assert.equal(first.installed.length, 2);
  const second = syncOverlayAgents({ configDir, repoRoot });
  assert.equal(second.installed.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.adopted.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.deepEqual(second.conflicts, []);
});

test('dry-run writes no files and no manifest', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES);
  const report = syncOverlayAgents({ configDir, repoRoot, dryRun: true });
  assert.equal(report.installed.length, 2);
  assert.equal(fs.existsSync(agentsOf(configDir)), false);
  assert.equal(fs.existsSync(overlayDirs().manifestPath), false);
});

test('pre-existing unmanaged target with different content is skipped as a conflict', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT });
  writeAgent(configDir, 'env-runner.md', 'NOT THE OVERLAY\n');

  const report = syncOverlayAgents({ configDir, repoRoot });
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].file, 'env-runner.md');
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'env-runner.md'), 'utf8'), 'NOT THE OVERLAY\n');
  assert.equal(report.installed.length, 0);
});

test('identical pre-existing target is adopted without rewrite', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT });
  writeAgent(configDir, 'env-runner.md', ENV_CONTENT);

  const report = syncOverlayAgents({ configDir, repoRoot });
  assert.ok(report.adopted.includes('env-runner.md'));
  assert.equal(report.installed.length, 0);
  assert.equal(manifestFiles()['env-runner.md'].origin, 'adopted');
});

test('adopted pre-existing file is kept by uninstall, not deleted', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT });
  writeAgent(configDir, 'env-runner.md', ENV_CONTENT);
  syncOverlayAgents({ configDir, repoRoot });

  const report = uninstallOverlayAgents({ configDir });
  assert.deepEqual(report.removed, []);
  assert.ok(report.keptAdopted.includes('env-runner.md'));
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'env-runner.md'), 'utf8'), ENV_CONTENT);
  assert.equal(manifestFiles()['env-runner.md'], undefined);
});

test('adopted file changed then uninstall keeps the changed file', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT });
  writeAgent(configDir, 'env-runner.md', ENV_CONTENT);
  syncOverlayAgents({ configDir, repoRoot });

  // Hand-edit the adopted file: sync reports a conflict, uninstall keeps it.
  writeAgent(configDir, 'env-runner.md', 'hand edited\n');
  const sync = syncOverlayAgents({ configDir, repoRoot });
  assert.equal(sync.conflicts.length, 1);
  const report = uninstallOverlayAgents({ configDir });
  assert.ok(report.keptModified.includes('env-runner.md'));
  assert.deepEqual(report.removed, []);
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'env-runner.md'), 'utf8'), 'hand edited\n');
});

test('installed (non-adopted) file is removed by uninstall', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT });
  syncOverlayAgents({ configDir, repoRoot });

  const report = uninstallOverlayAgents({ configDir });
  assert.ok(report.removed.includes('env-runner.md'));
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')), false);
});

test('changed source updates a clean managed target', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo({ 'reasoner.md': REASONER_CONTENT });
  syncOverlayAgents({ configDir, repoRoot });

  fs.writeFileSync(path.join(repoRoot, 'agents', 'reasoner.md'), 'v2 content\n');
  const report = syncOverlayAgents({ configDir, repoRoot });
  assert.ok(report.updated.includes('reasoner.md'));
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'reasoner.md'), 'utf8'), 'v2 content\n');
  assert.equal(manifestFiles()['reasoner.md'].origin, 'updated');
});

test('platform guard: darwin skips a win32-only file and installs the rest', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES, { 'env-runner.md': ['win32'] });
  const report = syncOverlayAgents({ configDir, repoRoot, platform: 'darwin' });

  assert.deepEqual(report.skippedPlatform, ['env-runner.md']);
  assert.deepEqual(report.installed, ['reasoner.md']);
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')), false);
  assert.ok(fs.existsSync(path.join(agentsOf(configDir), 'reasoner.md')));
  assert.equal(manifestFiles()['env-runner.md'], undefined);
});

test('platform guard: win32 installs both', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES, { 'env-runner.md': ['win32'] });
  const report = syncOverlayAgents({ configDir, repoRoot, platform: 'win32' });

  assert.deepEqual(report.skippedPlatform, []);
  assert.deepEqual(report.installed.slice().sort(), ['env-runner.md', 'reasoner.md']);
});

test('user override is not filtered by repo platform metadata', () => {
  const { home, configDir } = freshEnv();
  const repoRoot = makeRepo({ 'env-runner.md': ENV_CONTENT }, { 'env-runner.md': ['win32'] });
  const userDir = path.join(home, 'overlays', 'qoder', 'agents');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'env-runner.md'), '# darwin override\n');

  const report = syncOverlayAgents({ configDir, repoRoot, platform: 'darwin' });
  assert.deepEqual(report.skippedPlatform, []);
  assert.equal(fs.readFileSync(path.join(agentsOf(configDir), 'env-runner.md'), 'utf8'), '# darwin override\n');
  assert.equal(manifestFiles()['env-runner.md'].sourceKind, 'user');
  assert.equal(manifestFiles()['env-runner.md'].origin, 'installed');
});

test('doctor reports managed agents, origin, conflicts, and source counts', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES);
  syncOverlayAgents({ configDir, repoRoot });
  writeAgent(configDir, 'reasoner.md', 'edited\n');

  const info = doctorOverlay({ configDir, repoRoot, platform: 'win32' });
  assert.equal(info.repoCount, 2);
  assert.equal(info.userCount, 0);
  assert.equal(info.mergedCount, 2);
  assert.equal(info.managed.length, 2);
  assert.ok(info.managed.every((m) => m.origin === 'installed'));
  assert.equal(info.conflicts.length, 1);
  assert.equal(info.conflicts[0].file, 'reasoner.md');
  assert.deepEqual(info.skippedPlatform, []);
});

test('doctor reports platform-skipped files', () => {
  const { configDir } = freshEnv();
  const repoRoot = makeRepo(TWO_FILES, { 'env-runner.md': ['win32'] });
  const info = doctorOverlay({ configDir, repoRoot, platform: 'darwin' });
  assert.deepEqual(info.skippedPlatform.map((s) => s.file), ['env-runner.md']);
  assert.equal(info.repoCount, 2);
  assert.equal(info.mergedCount, 2);
});

test('install with the empty default overlay installs no agents and never writes the repo', () => {
  const { configDir } = freshEnv();
  const root = tmp('ovroot-empty');
  const report = installQoder({ root, configDir });
  assert.equal(report.overlay.sources.merged, 0);
  assert.equal(report.overlay.installed.length, 0);
  // Product fallback path is unaffected by the empty overlay.
  assert.ok(fs.existsSync(path.join(agentsOf(configDir), 'mhe-reasoner.md')));
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('install with an injected personal overlay copies into configDir and never writes the repo', () => {
  const { configDir } = freshEnv();
  const root = tmp('ovroot');
  const repoRoot = makeRepo(TWO_FILES);
  const report = installQoder({ root, configDir, repoOverlayDir: repoRoot, platform: 'win32' });
  assert.ok(report.overlay.installed.includes('env-runner.md'));
  assert.ok(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')));
  // Product fallback and personal overlay coexist.
  assert.ok(fs.existsSync(path.join(agentsOf(configDir), 'mhe-reasoner.md')));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('global install with an injected overlay also syncs into configDir/agents', () => {
  const { configDir } = freshEnv();
  const root = tmp('ovroot-g');
  const repoRoot = makeRepo(TWO_FILES);
  const report = installQoder({ root, configDir, global: true, repoOverlayDir: repoRoot, platform: 'win32' });
  assert.ok(report.overlay.installed.includes('env-runner.md'));
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')), true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('uninstall removes installed overlay agents alongside mhe-* handling', () => {
  const { configDir } = freshEnv();
  const root = tmp('ovroot-u');
  const repoRoot = makeRepo(TWO_FILES);
  installQoder({ root, configDir, repoOverlayDir: repoRoot, platform: 'win32' });
  const report = uninstallQoder({ root, configDir });
  assert.ok(report.overlay.removed.includes('env-runner.md'));
  assert.ok(report.overlay.removed.includes('reasoner.md'));
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'env-runner.md')), false);
  assert.equal(fs.existsSync(path.join(agentsOf(configDir), 'mhe-reasoner.md')), false);
});
