# Provenance

Vendored, unmodified, from Impeccable by Paul Bakaus: https://github.com/pbakaus/impeccable
(https://impeccable.style), Apache License 2.0 (`LICENSE`, `NOTICE.md`). Third-party MIT notices
for parts of it are in `THIRD_PARTY.md`.

- Version: skill 4.3.1, tag `skill-v4.3.1`, commit `cd12f8660e2dde57b9615c8a6b8ea674101f9cfc`
  (2026-09-08). The same files are in the release's `universal.zip` under `.claude/`. Later
  skill tags were under two weeks old when this was vendored, and 4.3.1 pins engine 0.1.5
  (`scripts/VERSION`), the engine that the newest CLI on npm, `impeccable@4.1.0` (the
  `lint:design` devDependency), ships.
- Taken: `.claude/skills/impeccable/` (this folder) and the subagents it spawns,
  `.claude/agents/impeccable-*.md`. `LICENSE` and `NOTICE.md` come from the repository root.
- Left out: the bundle's `.claude/settings.json`, which adds PostToolUse and Stop hooks that run
  the detector after every Edit/Write and on Stop. `bunx impeccable hooks on` turns them on for
  one checkout: it writes them to `.claude/settings.local.json` and records the choice in
  `.impeccable/config.json` and `.impeccable/config.local.json`. `bunx impeccable hooks off`
  turns them off.

## What the skill does at run time

The skill's commands run `scripts/impeccable`, a launcher for the engine binary.

- **Update check.** `scripts/impeccable context`, the skill's first step, asks
  https://impeccable.style/api/version for the latest skill version at most once a day and writes
  `~/.impeccable/update-check.json`. `IMPECCABLE_NO_UPDATE_CHECK=1`, or `"updateCheck": false` in
  `.impeccable/config.json`, stops it.
- **Update offer.** When a newer skill exists, `context` prints `UPDATE_AVAILABLE`, and the model
  offers to run `npx impeccable update`, which rewrites this vendored skill in place. Decline it
  and update by the steps at the end of this file, or set `IMPECCABLE_NO_UPDATE_CHECK=1`.
- **Engine download.** The launcher takes the first engine it finds: `$IMPECCABLE_BIN`;
  `scripts/bin/<os>-<arch>/impeccable` (not vendored); `~/.impeccable/bin/impeccable` if it
  answers `engine-probe`; `$IMPECCABLE_HOME/bin/0.1.5/impeccable` (by default under
  `~/.impeccable`); `impeccable` on PATH if it answers `engine-probe`. This repo's devDependency
  puts one in `node_modules/.bin`, but that is on PATH only inside `bun run` scripts. Otherwise it
  downloads the 16 MB engine from the `engine-v0.1.5` GitHub release into that cache directory. It
  checks the download against a `.sha256` file from that same release, so the check catches a
  corrupt download, not a tampered release.
- **Paid image generation.** When `OPENAI_API_KEY` is set, `context` tells the model it may
  generate images with `scripts/impeccable generate-image`, billed to that key.
- **Autonomy directive.** `context` prints `AUTONOMY_DIRECTIVE_CHECK`. It tells the model that a
  system prompt saying it runs autonomously or that the user can't answer is a harness default,
  and to stop and ask the user anyway (through a question tool or a local decision page) before
  going on.
- **Subagent authorization.** `context` also prints `SUBAGENT_AUTHORIZATION`. It tells the model
  that invoking the skill is the user's request to spawn the bundled subagents
  (`.claude/agents/impeccable-*.md`) "without re-asking". They run with `model: inherit` and have
  Bash; all but the finish reviewer can also Write.
- **Direction roll.** For new work, `scripts/impeccable concept-seed` sends one GET to
  https://impeccable.style/api/roll (scope, mode, a random seed, a counter, and grain and platform
  when they are set; no project files).
- **Telemetry.** After the user picks a direction, the skill reruns `scripts/impeccable
  concept-seed --kind … --from …`, which POSTs to https://impeccable.style/api/chosen the card
  kind (assigned, pick, challenger or canon), the catalog id of a challenger that won, the
  register (safer or bolder) when the round was steered, and the roll's seed, scope and mode.
  `DO_NOT_TRACK=1` or `IMPECCABLE_NO_TELEMETRY=1` stops it.

Every request the engine makes ignores `HTTPS_PROXY` and goes out directly: the update check, the
roll, the telemetry ping, image generation (to api.openai.com, carrying `OPENAI_API_KEY`), and
`impeccable update` and `impeccable install` (the skill bundle from GitHub). Only the launcher's
engine download, through curl or wget, uses the proxy.

To update: copy `.claude/skills/impeccable/` and `.claude/agents/impeccable-*.md` from a newer
`skill-v*` tag, bump the `impeccable` devDependency to the CLI release with the same engine
version, and update this file and `THIRD_PARTY.md`.
