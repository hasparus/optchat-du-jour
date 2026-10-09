// @hasparus/oxlint-config is vendored until 0.4.0 is published (#1). oxlint resolves the config's
// jsPlugins from this root, so they are root devDependencies too, at the versions in
// vendor/oxlint-config/package.json. The lint script passes --disable-nested-config: oxlint would
// otherwise load the vendored package's own oxlint.config.ts as a nested config, and refuse it.
import base, { ignorePatterns, overrides } from "@hasparus/oxlint-config";
import { existsSync } from "node:fs";
import { defineConfig } from "oxlint";

// mobile/ (the iOS app) has its own dependencies, which the root install doesn't fetch, and its
// type-aware rules need Expo's types. With them installed (`cd mobile && bun install`; CI's mobile
// job) it is linted like the rest; without them it is left out rather than failed.
const mobile = existsSync(new URL("mobile/node_modules/expo/package.json", import.meta.url)) ? [] : ["mobile"];

// Sorting imports, keys and unions is churn, not review: every perfectionist rule is off.
const unsorted = Object.fromEntries(
  Object.keys(base.rules)
    .filter((id) => id.startsWith("perfectionist/"))
    .map((id) => [id, "off" as const]),
);

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns, "vendor", "kernel/kernel.mjs", ...mobile],
  overrides: [
    ...overrides,
    // a script whose output is its report
    { files: ["test/parity/**"], rules: { "no-console": "off" } },
    // shadcn's registry components import React as a namespace, which this rule reads as importing
    // PropsWithChildren; none of them use it
    { files: ["web/src/components/ui/**"], rules: { "no-restricted-imports": "off" } },
  ],
  // the web UI's Tailwind theme, for better-tailwindcss's class checks
  settings: { "better-tailwindcss": { entryPoint: "web/src/index.css" } },
  rules: {
    ...unsorted,
    // An exhaustive switch over a union returns on every path; this rule can't see that, and the
    // fall-through it asks for trips switch-exhaustiveness-check and no-useless-switch-case instead.
    "typescript/consistent-return": "off",
    // Effect.forEach(items, f, options) reads to it as Array#forEach with a thisArg.
    "unicorn/no-array-method-this-argument": "off",
  },
});
