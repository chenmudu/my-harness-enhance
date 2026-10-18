// The Qoder adapter: the first implementation of the adapter contract in
// src/adapters/spec.mjs. It wraps the existing Qoder install/overlay
// functions without changing their behaviour — no refactor, no new hook or
// MCP logic. Qoder is one harness, not the repo boundary; anything not
// genuinely provided by this adapter is not declared.

import { defineAdapter } from '../spec.mjs';
import {
  detectConfigDir,
  doctorQoder,
  installQoder,
  refreshCapabilities,
  uninstallQoder,
} from './install.mjs';
import {
  doctorOverlay,
  syncOverlayAgents,
  uninstallOverlayAgents,
} from './overlay.mjs';

export const qoderAdapter = defineAdapter({
  id: 'qoder',
  label: 'Qoder',
  capabilities: {
    // Lifecycle hooks: SessionStart/UserPromptSubmit/PreToolUse/SubagentStart/
    // SubagentStop/PostToolUse/PreCompact are merged into settings.json.
    hooks: true,
    // Native task/worker delegation, resolved via the capability plan.
    subagents: true,
    // PostToolUse hooks emit updatedToolOutput (see hooks/hook.mjs).
    resultRewrite: true,
    // PreCompact event is registered and handled (see hooks/hook.mjs).
    preCompact: true,
    // stdio MCP server harness-enhance -> mcp/recall-server.mjs.
    mcp: true,
    // install/uninstall/doctor lifecycle below.
    installer: true,
    // Personal overlay agents (see overlay.mjs; run inside install/uninstall/doctor).
    overlay: true,
    // Per-session conductor map (core/store.mjs sessions + hooks sessionIsConductor).
    sessionMap: true,
    // Honest absences: no skill-package installer, no model steering, no
    // status line, no coordination across concurrent sessions.
    skills: false,
    modelSelection: false,
    statusLine: false,
    crossSession: false,
  },
  lifecycle: {
    // Detection signal is QODER_CONFIG_DIR (or an explicitly passed config
    // dir). Without a signal we do NOT probe well-known home directories:
    // the candidate path may exist by accident and detection must not lie.
    // Returns the resolved config dir (truthy) when detected, false otherwise.
    detect: ({ env = process.env, configDir = null } = {}) => {
      const explicit = configDir || env?.QODER_CONFIG_DIR || null;
      if (!explicit) return false;
      return detectConfigDir(explicit);
    },
    // install/uninstall/doctor internally sync|uninstall|check the personal
    // overlay too; their results include an `overlay` report.
    install: (options = {}) => installQoder(options),
    uninstall: (options = {}) => uninstallQoder(options),
    doctor: (options = {}) => doctorQoder(options),
    refresh: (options = {}) => refreshCapabilities(options),
  },
});

// Overlay functions wrapped for callers that need overlay-only operations.
// They are NOT part of the portable lifecycle contract — install/uninstall/
// doctor already own the overlay path for normal use.
export const qoderOverlay = Object.freeze({
  sync: syncOverlayAgents,
  uninstall: uninstallOverlayAgents,
  doctor: doctorOverlay,
});

export default qoderAdapter;
