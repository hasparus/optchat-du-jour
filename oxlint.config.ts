// @hasparus/oxlint-config is vendored until 0.4.0 is published (#1). oxlint resolves the config's
// jsPlugins from this root, so they are root devDependencies too, at the versions in
// vendor/oxlint-config/package.json. The lint script passes --disable-nested-config: oxlint would
// otherwise load the vendored package's own oxlint.config.ts as a nested config, and refuse it.
import base, { ignorePatterns, overrides } from "@hasparus/oxlint-config";
import { defineConfig } from "oxlint";

// Sorting imports, keys and unions is churn, not review: every perfectionist rule is off.
const unsorted = Object.fromEntries(
  Object.keys(base.rules)
    .filter((id) => id.startsWith("perfectionist/"))
    .map((id) => [id, "off" as const]),
);

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns, "vendor", "kernel/kernel.mjs"],
  overrides: [
    ...overrides,
    // scripts whose output is their report
    { files: ["test/parity/**"], rules: { "no-console": "off" } },
  ],
  rules: unsorted,
});
