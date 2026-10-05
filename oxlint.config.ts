import base, { overrides } from "@hasparus/oxlint-config";
import { defineConfig } from "oxlint";

// 0.3.1 keeps ignorePatterns inside the base; oxlint reads them from the root
// config only, so they are spelled out again here.
export default defineConfig({
  extends: [base],
  ignorePatterns: [...base.ignorePatterns, ".claude"],
  overrides: [...overrides],
});
