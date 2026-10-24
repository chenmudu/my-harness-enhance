# Documentation map

> Chinese version: [README.zh-CN.md](README.zh-CN.md).

This page is the index and authority order for the repository documentation. When two pages disagree, the page named as authoritative for that question wins.

| Page | Question it answers | Authority |
|---|---|---|
| [../README.md](../README.md) | What this project is, status, and the doc list | Entry point |
| [../INSTALL.md](../INSTALL.md) | Install, upgrade, rollback, doctor | Commands and install steps |
| [architecture.md](architecture.md) | Invariants, state model, hook lifecycle | Runtime design |
| [adapters.md](adapters.md) | Adapter contract and per-harness capability matrix | Harness support |
| [qoder-adapter.md](qoder-adapter.md) | Qoder paths, install layout, hook payloads | Qoder-specific setup |
| [worktrees.md](worktrees.md) | Code worktrees, dispatch gate, land | Code delivery |
| [brief-checks.md](brief-checks.md) | Brief fields, checker ids, acceptance | Acceptance |
| [metrics.md](metrics.md) | What is measured and what the numbers mean | Measurements |
| [roadmap.md](roadmap.md) | Planned work | Plans, not current behavior |
| [validation.md](validation.md) | Local validation record | Historical evidence |
| [../overlays/README.md](../overlays/README.md) | Personal agent overlay | Overlay install |

## Conventions

- English is the default; every page under `docs/` and the two root pages has a `.zh-CN.md` twin with a back-link on line 3. `overlays/README.md` is an operational README and intentionally has no twin. If twins diverge, the English page wins.
- Fenced code, commands, JSON, and identifiers are verbatim in both languages. Do not translate them.
- A page describes the current commit. `validation.md` is a dated record, not a specification.
- Personal notes live in `docs/others/` and are gitignored. They are not repository documentation.
- Line endings are not enforced by the repository; `core.autocrlf` may rewrite worktree files on checkout.

## Verify

```bash
npm test
node --test test/docs.test.mjs
node --test test/state-root.test.mjs
```

`test/docs.test.mjs` enforces heading levels, verbatim fences, table shape, back-links, relative links, and line-count parity (with documented exceptions).
