# @hasparus/oxlint-config

my shared [oxlint](https://oxc.rs) config

mostly warnings except definitive bugs, which get a red squiggly.

## Usage

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import base, { ignorePatterns, overrides } from "@hasparus/oxlint-config";

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns],
  overrides: [...overrides, { files: ["src/**/*.ts"], rules: { "no-console": "warn" } }],
});
```

`ignorePatterns` and `overrides` come along by hand because oxlint reads both
from the root config only — see [below](#what-it-turns-off-for-you).

`perfectionist`, `sonarjs`, `better-tailwindcss`, and `anti-slop` run through
oxlint's `jsPlugins` and travel with this package.

## anti-slop

[anti-slop](https://github.com/dmmulroy/anti-slop) is fifteen rules against the
shapes code takes when whoever wrote it could not see the type it needed —
`unknown` in a signature, `Record<string, unknown>` standing in for a shape, an
assertion claiming what nothing checked. A model writes them by the dozen and so
does a person in a hurry; the rules do not care which.

It publishes source to vendor rather than a package to depend on, so the copy
lives in [`anti-slop/`](./anti-slop) and ships inside this one. Nothing to
install, nothing to register — `extends` brings the plugin and all fifteen
rules, under `anti-slop/`.

Two departures from upstream:

- **Warnings, not errors.** None of the fifteen is a bug, and
  `require-safety-comment-for-type-assertion` asks for a sentence of prose no
  `--fix` can write. Over this repo they come to seventeen reports across twenty
  source files.
- **`no-runtime-typeof` runs with `allowInTypeGuards`.** The rule's answer to a
  `typeof` check is to parse at the I/O boundary instead, which presumes a
  parser. The checks it catches in practice are not reading I/O at all — they
  are discriminating a union TypeScript itself models with `typeof`. The option
  passes one inside a type predicate or assertion function and still reports one
  sitting in the middle of a function meant to be doing something else, so the
  narrowing keeps costing a name.

To decline the lot, spell them off:

```ts
export default defineConfig({
  extends: [base],
  rules: Object.fromEntries(
    Object.keys(base.rules)
      .filter((id) => id.startsWith("anti-slop/"))
      .map((id) => [id, "off"]),
  ),
});
```

## Type-aware linting

Every type-aware rule oxlint has is on, and `options.typeAware` comes with
them, so plain `oxlint` runs the lot — there is no `--type-aware` to remember
and no lint script to change. The option travels through `extends` and takes
effect from your root config; files covered by a nested config are linted with
it too.

The rules run in `oxlint-tsgolint`, a peer dependency, which most package
managers install for you. Without it oxlint lints nothing at all, so the config
says as much on stderr, with the one command that fixes it.

Severities match [`@hasparus/eslint-config`](../hasparus-eslint-config) where
it has an opinion, so a file that passes one linter passes the other. Only
`typescript/require-await` is off, because the ESLint rule of that name is off
here too.

To decline the whole thing:

```ts
export default defineConfig({ extends: [base], options: { typeAware: false } });
```

## What it turns off for you

Two rules are wrong often enough in a particular place that the config says so:

- **`import/no-default-export`** in Next's App Router conventions —
  `app/page.tsx`, `layout`, `sitemap`, `robots` and the rest. Next reads them
  by default export. `app/api/**/route.ts` keeps the rule, because route
  handlers export `GET`/`POST` by name.
- **`unicorn/prefer-dom-node-text-content`** in `e2e/**` and `playwright/**`
  spec files. A Playwright locator is not a DOM node: `innerText()` reads what
  the page renders and `textContent()` reads the source, so the rule's fix
  rewrites the assertion. Helpers beside the specs keep the rule, since a
  `page.evaluate` body really does hold DOM nodes.

They ship as a named export rather than inside the base, because `extends`
drops a base config's `overrides`. `ignorePatterns` is the same story — oxlint
reads those from the root config only — so it is a named export too, covering
build output and the directories coding agents install their own assets into
(`.claude`, `.cursor`, `.codex` and the rest; a repo that lints those is
reviewing somebody else's code). Spread both into your own:

```ts
import base, { ignorePatterns, overrides } from "@hasparus/oxlint-config";

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns],
  overrides: [...overrides],
});
```

Where each one looks:

|            | covers                                                             |
| ---------- | ------------------------------------------------------------------ |
| App Router | an `app/` directory at any depth, convention filenames only        |
| Playwright | an `e2e/` or `playwright/` directory at any depth, spec files only |

The Pages Router is not covered: every file under `pages` is a route, so there
is no filename left to narrow on, and the glob would swallow the
`components/pages/` folder plain React projects keep. That, or a Playwright
suite in `tests/`, wants a line of its own:

```ts
overrides: [{ files: ["tests/**/*.spec.ts"], rules: { "unicorn/prefer-dom-node-text-content": "off" } }],
```

## License

MIT
