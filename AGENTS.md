# Working on optchat

Use Bun 1.4.2: `mise exec bun@1.4.2 -- <command>`. Run `bun install --frozen-lockfile`,
`bun run build`, `bun run lint`, `bun run lint:effect`,
`bun run lint:effect -- --format github-actions`, `bun run lint:design`, `bun run test`,
and `git diff --check`. Tests use fake models and isolated secrets; never read private history
or call real models to verify a change. Mobile has a separate toolchain.

Build, web typecheck and root postinstall explicitly invoke TypeScript 5.9.3's JS compiler.
Bare `tsc` is ambiguous because the pinned native TS7 companion also exports that binary.
Use package scripts, not `tsc` shorthand. Native Effect diagnostics run separately; do not
patch compiler or vendored lint binaries. See [diagnostics policy](agent-patterns/effect-diagnostics.md).

## Effect: source before guesses

Before writing Effect code, read [repos/effect/LLMS.md](repos/effect/LLMS.md) in full.
Follow relevant ai-docs, source definitions and tests at the pinned version, not V3 examples
or unreleased main APIs. [repos/README.md](repos/README.md) records provenance and updates.

`repos/**` is read-only reference material, not app code. Do not edit, install dependencies,
run upstream suites, add workspaces, or import files there unless explicitly authorized.
Use normal npm imports (`effect`, `effect/http`, `@effect/platform-bun`). Keep the upstream
license and tree intact. App gates and editor indexing exclude this subtree.

Focused notes: [scopes and cancellation](agent-patterns/effect-scopes.md),
[typed failures and retry](agent-patterns/effect-errors.md),
[Schema boundaries](agent-patterns/effect-schema.md).
Diagnostics complement, not replace, manual lifecycle and type-boundary review. Do not
mechanically convert native collections: check semantics and the relevant tests first.
