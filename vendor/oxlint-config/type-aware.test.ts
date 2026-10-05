import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, lint, OXLINT, SENTINEL, SENTINEL_RULE, TSGOLINT } from "./fixture.js";

/**
 * A type-aware rule that never reaches tsgolint reports nothing, which reads
 * exactly like a clean file. These prove the rules arrive, that dropping
 * `options` is what takes them away, and that a missing binary says so out
 * loud.
 */

/** One unused type parameter, one unawaited promise. Neither is visible to the parser alone. */
const UNTYPED = `${SENTINEL}export const id = <T,>(x: unknown): unknown => x;
export async function go() {}
go();
`;

const TYPE_AWARE_RULES = [
  "typescript/no-unnecessary-type-parameters",
  "typescript/no-floating-promises",
];

test("type-aware rules run under plain oxlint, with no --type-aware flag", () => {
  const found = lint([["src/a.ts", UNTYPED]]);

  expect(found["src/a.ts"], "src/a.ts was never linted").toContain(SENTINEL_RULE);
  for (const rule of TYPE_AWARE_RULES) expect(found["src/a.ts"]).toContain(rule);
});

test("without `options.typeAware` the same rules report nothing at all", () => {
  const { options: _dropped, ...withoutOptions } = config;
  const found = lint([["src/a.ts", UNTYPED]], withoutOptions);

  expect(found["src/a.ts"], "src/a.ts was never linted").toContain(SENTINEL_RULE);
  for (const rule of TYPE_AWARE_RULES) expect(found["src/a.ts"]).not.toContain(rule);
});

/**
 * Whatever oxlint writes to stderr while loading a config that imports this
 * one. The fixture imports it for the side effect alone and exports rules of
 * its own, so no JS plugin has to resolve from a temp dir. The temp dir is the
 * other half of the setup: nothing above it holds a `node_modules/.bin/
 * tsgolint`, which is the state a consumer who has not installed it is in.
 */
function complaint(env: Readonly<Record<string, string | undefined>>) {
  const root = mkdtempSync(join(tmpdir(), "oxlint-tsgolint-"));

  writeFileSync(join(root, "src.ts"), SENTINEL);
  writeFileSync(
    join(root, "oxlint.config.mjs"),
    `import ${JSON.stringify(import.meta.resolve("./oxlint.config.js"))};
export default { rules: { "no-debugger": "error" } };
`,
  );

  return Bun.spawnSync({ cmd: [OXLINT, "-c", "oxlint.config.mjs", "."], cwd: root, env })
    .stderr.toString();
}

test("a missing tsgolint is announced, not swallowed", () => {
  const { OXLINT_TSGOLINT_PATH: _unset, ...env } = process.env;
  const said = complaint(env);

  expect(said).toContain("@hasparus/oxlint-config");
  expect(said).toContain("npm install --save-dev oxlint-tsgolint");
  // Silent once oxlint has been told where to find it.
  expect(complaint({ ...env, OXLINT_TSGOLINT_PATH: TSGOLINT })).not.toContain(
    "@hasparus/oxlint-config",
  );
});

/**
 * The exemption is spelled with the deprecated bare-string specifier because
 * the `{ from: "package" }` form matches none of these. If that changes
 * upstream this test is what says so: the runner call comes back reported.
 */
test("a test runner's calls are exempt from no-floating-promises, real ones are not", () => {
  const source = `${SENTINEL}declare function test(name: string, fn: () => void): Promise<void>;
declare function work(): Promise<void>;
test("x", () => {});
work();
`;
  const found = lint([["src/a.test.ts", source]]);

  expect(found["src/a.test.ts"], "src/a.test.ts was never linted").toContain(SENTINEL_RULE);
  expect(found["src/a.test.ts"]).toContain("typescript/no-floating-promises");
  expect(
    found["src/a.test.ts"]?.filter((id) => id === "typescript/no-floating-promises"),
    "only `work()` should report, not `test()`",
  ).toHaveLength(1);
});
