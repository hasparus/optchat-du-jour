# Provenance

Vendored, unmodified, from Impeccable by Paul Bakaus: https://github.com/pbakaus/impeccable
(https://impeccable.style), Apache License 2.0 (`LICENSE`, `NOTICE.md`).

- Version: skill 4.3.1, tag `skill-v4.3.1`, commit `cd12f8660e2dde57b9615c8a6b8ea674101f9cfc`
  (2026-09-08). The same files are in the release's `universal.zip` under `.claude/`.
- Taken: `.claude/skills/impeccable/` (this folder) and the subagents it spawns,
  `.claude/agents/impeccable-*.md`. `LICENSE` and `NOTICE.md` come from the repository root.
- Left out: the bundle's `.claude/settings.json`, which adds PostToolUse and Stop hooks that run
  the detector on every edit. Install them with `npx impeccable install` if wanted.
- Engine: `scripts/impeccable` runs engine 0.1.5 (`scripts/VERSION`). It looks for the binary on
  PATH and in `~/.impeccable/bin/`, or downloads it from the `engine-v0.1.5` release and checks its
  sha256. The `impeccable@4.1.0` devDependency, which `bun run lint:design` uses, ships the same
  engine version.

To update: copy `.claude/skills/impeccable/` and `.claude/agents/impeccable-*.md` from a newer
`skill-v*` tag, bump the `impeccable` devDependency to the CLI release with the same engine
version, and update this file.
