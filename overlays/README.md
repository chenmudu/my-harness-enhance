# Personal overlays

This directory holds the personal defaults for your own harness. They live in
this repo so they are versionable, and they install into your user-level Qoder
config directory. They never write into a target workspace or project repo.

## The active overlay starts empty

`overlays/qoder/agents/` ships with no `.md` agents. The active personal
overlay is empty by default and every personal agent is added explicitly.

Abandoned legacy artifacts — for example the old `env-runner` and `reasoner`
that may still sit in `~/.qoder-cn/agents` — are NOT personal defaults. They
are not copied here, not installed, and are left untouched and unmanaged by this
tool.

## Layers

There are two layers, merged by filename:

1. **Repo overlay** (`overlays/qoder/agents/*.md`) — your personal defaults,
   tracked in git. Edit here to change the defaults for every machine. Empty
   until you add files.
2. **User-level overlay** (`~/.my-harness-enhance/overlays/qoder/agents/*.md`) —
   machine-local overrides. Use this for a tweak that only applies to one box and
   should not be committed.

### Precedence

A user-level file wins over a repo file with the same filename. Files present
only in the repo are used as-is; files present only in the user-level directory
are added on top.

## Install target

Sync copies the merged result into `<Qoder configDir>/agents`, where
`configDir` is the user-level Qoder directory (`~/.qoder-cn` or `~/.qoder`, or
whatever `--config-dir` / `QODER_CONFIG_DIR` selects). The target workspace
repo is never touched — nothing is written under the project directory you pass
with `--root`.

## Manifest and safety

Installed files are tracked in `~/.my-harness-enhance/overlays/qoder/manifest.json`,
keyed by the target agents directory, recording the SHA256 that was written and
an `origin` (`installed` | `updated` | `adopted`). This is what makes the layer
safe:

- **Idempotent.** A file whose source hash already matches the target is left
  unchanged.
- **Never clobbers a hand edit.** If you modify an installed agent file by hand,
  the next sync detects the target hash differs from the recorded hash, skips
  the file, and reports a conflict instead of overwriting it.
- **Never overwrites an unmanaged file.** If a target already exists with
  different content and this tool did not install it, the difference is reported
  as a conflict and left alone.
- **Adopt, never delete.** If a target already exists and is byte-for-byte
  identical to the overlay source, it is *adopted* (`origin: adopted`) without a
  rewrite. A file that already existed before the overlay managed it is **never
  deleted on uninstall** — uninstall drops the manifest entry but leaves the
  file in place and reports `kept adopted overlay agent`.
- **Uninstall removes only what it created.** Files installed/updated by this
  tool are removed on uninstall only while still unmodified; modified files are
  left in place. Official and unrelated agents are never considered.

## Platform constraints

`overlays/qoder/agents.platforms.json` maps filenames to the platforms they may
install on, e.g.:

```json
{
  "env-runner.md": ["win32"],
  "portable-tool.md": ["win32", "darwin", "linux"]
}
```

A repo-sourced file with a platform constraint is skipped on an incompatible
platform and reported as `skipped-platform`; nothing is written and nothing is
recorded. User-level override files are machine-local and are **not** filtered
by this repo metadata — the override always wins and always installs. There is
no shipped constraint by default (`{}`).

This is how you keep a machine-specific agent (say, a Windows-only shim) in the
portable repo without installing it onto macOS/Linux.

## Commands

Overlay sync runs as part of `mhe install qoder` (both `--global` and
project-scoped), and cleanup runs as part of `mhe uninstall qoder`. With the
default empty overlay these are no-ops until you add personal agents:

```
node bin/mhe.mjs install qoder --global --dry-run   # preview, writes nothing
node bin/mhe.mjs install qoder --global             # merge + copy into configDir/agents
node bin/mhe.mjs doctor                              # shows managed/adopted/conflict/skipped counts
node bin/mhe.mjs uninstall qoder --global            # removes only clean installed files
```

## Relationship to product fallback agents

`mhe-*` fallback agents (for example `mhe-reasoner`) are a separate product
concern and live in `src/adapters/qoder/templates/agents`. They are NOT part of
this personal overlay and are not copied here. Overlay sync runs after
capability resolution so it never changes which `mhe-*` fallback gets installed.

## Adding an active personal agent

1. Create `overlays/qoder/agents/<name>.md` with a frontmatter block (`name`,
   `description`, `model`, `tools`). The filename is the key.
2. If the agent is platform-specific, add its filename to
   `overlays/qoder/agents.platforms.json`.
3. Run `mhe install qoder` (add `--dry-run` first to preview). The file is copied
   into `<configDir>/agents/<name>.md` and recorded as `origin: installed`.
4. To override it per-machine without committing, drop a file with the same name
   into `~/.my-harness-enhance/overlays/qoder/agents/`. It wins on the next sync
   and is not platform-filtered.
5. To back out only your own hand edit, edit the installed file directly; sync
   reports a conflict and leaves it. To fully reset, delete the installed file
   and re-run sync.
