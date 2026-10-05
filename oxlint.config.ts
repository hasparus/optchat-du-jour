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
  ignorePatterns: [...ignorePatterns, "vendor"],
  overrides: [...overrides],
  rules: unsorted,
});
