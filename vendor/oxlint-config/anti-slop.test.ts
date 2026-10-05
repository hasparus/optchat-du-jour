import { expect, test } from "bun:test";

import antiSlop from "./anti-slop/index.js";
import { config, lint, SENTINEL, SENTINEL_RULE } from "./fixture.js";

/**
 * The vendored plugin is registered by absolute `file:` URL, which is the one
 * thing that has to hold for a config a consumer loads out of their
 * `node_modules`: a relative specifier would be resolved beside *their* config
 * and found nowhere, and fifteen rules that never load report nothing, which
 * reads exactly like clean code. So these run the binary from a temp directory
 * with no `node_modules` above it and read the rule ids back.
 */

/** One violation apiece, taken from anti-slop's README. */
const VIOLATIONS = [
  ["no-chained-type-assertions", `const user = input as object as User;`],
  ["no-conditional-empty-object-spread", `const o = { ...(t !== undefined ? { t } : {}) };`],
  ["no-known-value-widening", `const hs: Record<string, Handler> = { start: startHandler };`],
  ["no-module-mocking", `vi.mock("./user-store");`],
  ["no-object-parameters", `export function save(value: object) {}`],
  ["no-reflect-apply", `const v = Reflect.apply(operation, owner, args);`],
  ["no-reflect-get", `const v = Reflect.get(owner, key);`],
  ["no-runtime-typeof", `if (typeof input === "string") useName(input);`],
  ["no-shape-in-symbol-names", `interface UserShape { id: string }`],
  ["no-unknown-parameters", `export function handle(input: unknown) {}`],
  ["no-unknown-returns", `export function loadUser(): unknown { return input; }`],
  ["no-unknown-type-aliases", `type ExternalValue = unknown;`],
  ["no-unsafe-dictionary-type", `type Metadata = Record<string, unknown>;`],
  ["no-widen-then-assert", `const l: User = loadUser();\nconst s: unknown = l;\nconst u = s as User;`],
  ["require-safety-comment-for-type-assertion", `const userId = value as UserId;`],
] as const satisfies readonly (readonly [rule: string, source: string])[];

const path = (rule: string) => `src/${rule}.ts`;

test("every anti-slop rule reports through the config as a consumer loads it", () => {
  const found = lint(VIOLATIONS.map(([rule, source]) => [path(rule), SENTINEL + source]));

  for (const [rule] of VIOLATIONS) {
    expect(found[path(rule)], `${path(rule)} was never linted`).toContain(SENTINEL_RULE);
    expect(found[path(rule)]).toContain(`anti-slop/${rule}`);
  }
});

/**
 * Upstream is vendored, so a rule it adds or renames arrives as a silent
 * no-op — either a rule nothing turns on, or a config naming one that no
 * longer exists. Both are invisible in a lint run. Neither survives this.
 */
test("the config names every rule the plugin defines, and no rule it does not", () => {
  const named = Object.keys(config.rules).filter((id) => id.startsWith("anti-slop/"));
  const defined = Object.keys(antiSlop.rules).map((rule) => `anti-slop/${rule}`);

  expect(named.toSorted()).toEqual(defined.toSorted());
  expect(VIOLATIONS.map(([rule]) => `anti-slop/${rule}`).toSorted()).toEqual(defined.toSorted());
});
