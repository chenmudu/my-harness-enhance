# my-harness-enhance

> Chinese version: [README.zh-CN.md](README.zh-CN.md).

**A harness-agnostic personal enhancement layer for long-horizon agent work.**

It keeps one main session as the conductor: the main model judges, routes, accepts, and synthesizes; investigation, execution, verification, and drafting go to isolated native workers. Durable state lives outside the workspace, and a shared brief plus deterministic checks replace the expensive "execute everything, then run a second LLM audit" loop.

It is not a harness replacement or a multi-agent framework. It adds a control plane, a personal agent overlay, and deterministic verification on top of the native harness. The goal is to make long-horizon work faster and more reliable than doing everything in one long session.

## What It Is Not

- Not a new agent framework or an agent society.
- Not a Qoder-only tool: Qoder is the first validated adapter; ZCode is the second; Codex, DSH, and other common agent harnesses are adapter targets.
- Not a target-repo template: it never writes its state or personal agents into a working project repository.

## Core Model

- **One conductor**: one decision-maker; workers are isolated, stateless, and do not negotiate.
- **Brief before fan-out**: glossary, format, input hashes, ownership, and checks are shared with every worker.
- **Checks before acceptance**: structural, numeric, hash, scope, and test checks are code; full semantic audits are only for failures or ambiguity.
- **State outside the workspace**: runtime state in `~/.my-harness-enhance/`; personal agents in repo/user-level overlays, installed into user-level harness config.

## Adapters

- **Qoder**: first validated adapter (hooks, MCP, native subagents).
- **ZCode**: second adapter; native subagents, hooks, MCP, conductor injection. Project or global mode; `reason` uses built-in `Explore` under read-only compatibility because ZCode has no no-tools agent; worker contract is required in dispatch and synthetic jobs compensate for the missing SubagentStop. Raw result rewrite is not native.
- **Codex, DSH, and other common agent harnesses**: adapter targets. The core contract, brief, checks, and state are harness-agnostic.
- Adapter contract and feature matrix: [docs/adapters.md](docs/adapters.md). Qoder-specific details live in [docs/qoder-adapter.md](docs/qoder-adapter.md); they describe the first adapter, not the repo boundary.

## Status

- **221/221 tests pass (Windows)**.
- Qoder validated end-to-end for read-only, write, and verification sessions.
- ZCode adapter implemented in project and global modes; `reason` uses read-only Explore compatibility, worker contract is mandatory, and synthetic jobs stand in for SubagentStop. Raw result rewrite/SubagentStop/PreCompact are still native absences.
- Still to validate: real wall-clock comparison against a single long session, concurrent code integration conflicts, long-running compaction, and Codex/DSH adapters.

## Docs

- [docs/README.md](docs/README.md) — documentation map and authority order.
- [INSTALL.md](INSTALL.md) — Qoder and ZCode installation and rollback runbook.
- [docs/architecture.md](docs/architecture.md) — architecture and invariants.
- [docs/adapters.md](docs/adapters.md) — adapter contract and feature matrix.
- [docs/worktrees.md](docs/worktrees.md) — isolated git worktrees for code tasks.
- [docs/brief-checks.md](docs/brief-checks.md) — shared brief and deterministic checks.
- [overlays/README.md](overlays/README.md) — personal agent overlay and safe install/uninstall.
- [docs/roadmap.md](docs/roadmap.md) — adapter and runtime roadmap.
- [docs/validation.md](docs/validation.md) — local validation record.

## License

MIT
