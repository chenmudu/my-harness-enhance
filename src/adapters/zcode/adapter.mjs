// The ZCode adapter: the second implementation of the contract in
// src/adapters/spec.mjs. ZCode fires seven hook events (SessionStart,
// UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
// PostToolUseFailure, Stop) — no SubagentStart, no SubagentStop, no
// PreCompact — and offers no PostToolUse result rewrite. Everything this
// adapter does not genuinely provide stays undeclared; the honest absences
// below are the point of the file.

import { defineAdapter } from '../spec.mjs';
import {
  detectZCodeConfigDir,
  doctorZCode,
  installZCode,
  refreshZCode,
  uninstallZCode,
} from './install.mjs';

export const zcodeAdapter = defineAdapter({
  id: 'zcode',
  label: 'ZCode',
  capabilities: {
    // Native Agent subagents: the general-purpose / Explore built-ins. ZCode
    // custom agents are plugin-provided (manual UI install), and
    // <configDir>/agents is runtime session storage, not a definition dir —
    // so capability resolution uses built-ins only, with an explicit
    // read-only compatibility substitution for the reason role.
    subagents: true,
    // Lifecycle hooks merged into config.json: SessionStart,
    // UserPromptSubmit, PreToolUse, PostToolUse, Stop (type: 'process').
    hooks: true,
    // No result rewrite declared: ZCode PostToolUse offers no updated
    // tool-output channel, so the hook only stores artifacts and logs.
    resultRewrite: false,
    // No PreCompact event exists in ZCode. The capsule is written at Stop and
    // re-injected when SessionStart reports source=compact — that is capsule
    // injection, not a compaction hook, and is not claimed as one.
    preCompact: false,
    // stdio MCP server harness-enhance -> the shared harness-neutral
    // recall-server (physically under src/adapters/qoder/mcp, same server).
    mcp: true,
    // install/uninstall/doctor/refresh below, with backups and dry-run.
    installer: true,
    // No overlay sync: the installer writes only config.json under the ZCode
    // config dir. <configDir>/agents is runtime subagent session storage and
    // stays untouched.
    overlay: false,
    // Per-session conductor map in core state (sessions.json + hook marking).
    sessionMap: true,
    // Honest absences: no skill-package installer, no model steering, no
    // status line, no coordination across concurrent sessions.
    skills: false,
    modelSelection: false,
    statusLine: false,
    crossSession: false,
  },
  lifecycle: {
    // Detection signal is ZCODE_CONFIG_DIR (or an explicitly passed config
    // dir). The well-known default ~/.zcode/cli counts only when it actually
    // exists on disk; a provided path counts only when it exists. Probing
    // never writes and never answers from a guessed, absent path.
    detect: ({ env = process.env, configDir = null } = {}) => (
      detectZCodeConfigDir({ env, configDir })
    ),
    install: (options = {}) => installZCode(options),
    uninstall: (options = {}) => uninstallZCode(options),
    doctor: (options = {}) => doctorZCode(options),
    refresh: (options = {}) => refreshZCode(options),
  },
});

export default zcodeAdapter;
