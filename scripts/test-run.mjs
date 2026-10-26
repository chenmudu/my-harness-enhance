#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Every test fixture calls `os.tmpdir()`, so pointing TEMP/TMP/TMPDIR at one
 * run-scoped directory keeps all of them under a single root. The root is
 * removed when the run ends; without this the suite leaves ~50 directories per
 * run in the user's real temp folder, and on Windows those leftovers get
 * scanned at login until boot slows to a crawl.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-suite-'));
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

function cleanup() {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`temporary files left in ${root}: ${error.message}\n`);
  }
}

child.on('error', (error) => {
  cleanup();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
});