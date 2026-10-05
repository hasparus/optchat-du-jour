# anti-slop, vendored

Copied from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at
`446268e5d15baa968eaec669ff65358d36ae6259` (2026-08-14), MIT. The upstream
project publishes nothing to npm and says so on purpose: the rules are meant to
be read and changed, not pinned to a range.

This copy is `src/` with the `*.test.ts` files left behind. The rules are
exercised instead from `../anti-slop.test.ts`, which runs the oxlint binary over
one violation apiece — the thing that can break in a config a consumer loads out
of `node_modules` is the plugin never loading, and a unit test of the rules
would not notice.

`../oxlint.config.ts` registers `index.js` and turns all fifteen rules on as
warnings. The `.js` beside each `.ts` is build output, git-ignored; `bun run
build` writes it.

## Local deltas

One, in `shared/dictionary-types.ts`: `unsafeMembers[0] ?? null`, where upstream
writes `unsafeMembers[0]`. This package type-checks with
`noUncheckedIndexedAccess`, which does not narrow an index access through a
`length > 0` guard. Same value at runtime either way.

## Updating

```
git clone --depth 1 https://github.com/dmmulroy/anti-slop
cp -R anti-slop/src/{index.ts,rules,shared} packages/hasparus-oxlint-config/anti-slop/
rm packages/hasparus-oxlint-config/anti-slop/rules/*.test.ts
```

Then record the new commit above, re-apply the delta, and run `bun run build &&
bun test` — the tests fail if upstream adds a rule the config does not name, or
renames one it does, and `tsc -p tsconfig.json` fails if the delta went missing.
