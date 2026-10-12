# Provenance

Vendored, unmodified, from Impeccable by Paul Bakaus: https://github.com/pbakaus/impeccable
(https://impeccable.style), Apache License 2.0 (`LICENSE`, `NOTICE.md`). Third-party MIT notices
for parts of it are in `THIRD_PARTY.md`.

- Version: skill 4.5.2, tag `skill-v4.5.2`, commit `d631a8827f99414d2b6daba4ef08b7f8701751d7`
  (2026-10-08), the newest skill tag when this was vendored. The same files are in the release's
  `universal.zip` (sha256 `8b445a7529581a36626b328c3077e3d3dd7fbf247521e20ec8759ca939f77470`)
  under `.claude/`. 4.5.2 pins engine 0.1.14 (`scripts/VERSION`), the engine that the newest CLI
  on npm, `impeccable@4.5.2` (the `lint:design` devDependency), ships in its
  `@impeccable/cli-<os>-<arch>@0.1.14` packages. Each of those five binaries matches the `.sha256`
  file of the same name in the `engine-v0.1.14` release (commit `866f3557`).
- Release age: this repo takes a release once it is about two weeks old. That rule was waived for
  this bump only, because the user explicitly asked for the latest version on 2026-10-12, three
  days after 4.5.2 shipped. 4.5.2 followed 4.5.1 quickly: their release commits are about 9 hours
  apart, and npm got both on 2026-10-09, two minutes apart. The next update follows the rule again.
- Taken: `.claude/skills/impeccable/` (this folder) and the subagents it spawns,
  `.claude/agents/impeccable-*.md`. `LICENSE` and `NOTICE.md` come from the repository root.
- Left out: the bundle's `.claude/settings.json`, which adds three hooks: PostToolUse and Stop
  run the detector after every Edit/Write and on Stop, and SessionStart appends
  `export IMPECCABLE_SESSION_ID=<session id>` to Claude Code's `CLAUDE_ENV_FILE`. `bunx impeccable
  hooks on` turns on the two detector hooks, PostToolUse and Stop, but not SessionStart, for one
  checkout: it writes them to `.claude/settings.local.json` and records the choice in
  `.impeccable/config.json` and `.impeccable/config.local.json`. `bunx impeccable hooks off` turns
  them off.

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
  answers `engine-probe`; `$IMPECCABLE_HOME/bin/0.1.14/impeccable` (by default under
  `~/.impeccable`); `impeccable` on PATH if it answers `engine-probe`. This repo's devDependency
  puts one in `node_modules/.bin`, but that is on PATH only inside `bun run` scripts. Otherwise it
  downloads the 16 MB engine from the `engine-v0.1.14` GitHub release into that cache directory.
  It checks the download against a `.sha256` file from that same release, so the check catches a
  corrupt download, not a tampered release.
- **Paid image generation.** When `OPENAI_API_KEY` is set, `context` tells the model it may
  generate images with `scripts/impeccable generate-image`, billed to that key. Its `--ref`
  reference images may now be URLs. The engine downloads any `http` or `https` URL, private and
  loopback hosts included, follows up to five redirects, takes up to 30 MB, and uploads the image
  to OpenAI.
- **Card images.** When a direction roll deals catalog worlds, `scripts/impeccable serve-question`
  downloads each world's board and hero images into `.impeccable/mocks/worlds/` (gitignored here),
  for use as image-generation references. It fetches a URL under
  https://impeccable.style/worlds/cards, or an `https` URL whose hostname looks public: no IP
  address, userinfo, single-label name, `localhost`, or `.local`/`.internal`/`.lan`/`.home.arpa`
  suffix. The check looks only at the hostname and does no DNS lookup, so a public name that
  resolves to a private address passes. Card fetches follow no redirects. Setting
  `IMPECCABLE_CARD_BASE` replaces the default base, and any URL under it is fetched, `http`
  included. A card URL that fails the check is not fetched but handed to the agent to judge, and
  the agent can pass it back as a `generate-image --ref`, which has none of these limits.
- **`generate`.** The `generate` command (`scripts/impeccable live-generate --boot`) starts the
  skill's local live-mode helper server, injects its overlay into the page your dev server serves,
  and swaps the variants it writes into source through the dev server's hot reload; the variant you
  accept is written back into the source file.
- **`component-review`.** The `component-review` command writes `.impeccable/review/components.json`,
  keeps its review sessions in `~/.impeccable/component-reviews/`, and serves a review page on
  `127.0.0.1` where the user approves or sends back each image plate and the plan for what code
  draws, on comp-led builds.
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

Every HTTPS request the engine makes goes through a proxy when one is set in the environment: the
update check, the roll, the telemetry ping, the card images, image generation (to api.openai.com,
carrying `OPENAI_API_KEY`) and its `--ref` downloads, and `impeccable update` and `impeccable
install` (the skill bundle from GitHub). It takes the first of `ALL_PROXY`, `all_proxy`,
`HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` and `http_proxy` that is set and parses, and ignores
`NO_PROXY`.
It trusts the OS certificate store (or `SSL_CERT_FILE` / `SSL_CERT_DIR`) as well as its bundled
Mozilla roots. Its plain-HTTP calls to its own live-mode server on localhost bypass the proxy. The
launcher's engine download goes through curl or wget, which use the proxy too. None of this
covers the headless Chrome the engine launches for captures, URL scans and `font-match`: its own
requests, such as web font loads from fonts.googleapis.com, follow Chrome's proxy settings, not
these variables.

To update: copy `.claude/skills/impeccable/` and `.claude/agents/impeccable-*.md` from a newer
`skill-v*` tag, bump the `impeccable` devDependency to the CLI release with the same engine
version, and update this file and `THIRD_PARTY.md`.
