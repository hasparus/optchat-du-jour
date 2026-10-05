import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DummyRule, ExternalPluginEntry } from "oxlint";

/**
 * Runs the shipped config over files laid out on disk and reads the rule ids
 * back. A glob one star too wide, or a rule that never reaches the linter,
 * silences itself in every consumer repo and says nothing; only the binary
 * knows.
 */

/** As a consumer assembles it: the base, with the shared overrides spread in. */
const imported = await import("./oxlint.config.js");
export const config = { ...imported.default, overrides: imported.overrides };

/**
 * Every fixture carries a `debugger`, which no override touches. Without it a
 * typo in an `off()` path passes: nothing reported reads the same as a rule
 * correctly disabled.
 */
export const SENTINEL = "debugger;\n";
export const SENTINEL_RULE = "eslint/no-debugger";

/** The pinned binary, not whatever `bunx` would fetch if resolution missed. */
export const OXLINT = join(
  dirname(Bun.fileURLToPath(import.meta.resolve("oxlint/package.json"))),
  "bin/oxlint",
);

/**
 * The config asks for type-aware linting, and oxlint hunts for tsgolint by
 * walking up from the working directory — which here is a temp dir with no
 * `node_modules` above it. Hand it the path instead, or the run dies before it
 * reports a thing.
 */
export const TSGOLINT = join(
  dirname(Bun.fileURLToPath(import.meta.resolve("oxlint-tsgolint/package.json"))),
  "bin/tsgolint.js",
);

/**
 * A plugin named by package resolves from the fixture tree, which has no
 * `node_modules` anywhere above it, so those have to go — and their rules with
 * them, since oxlint refuses a config naming a plugin it has not loaded. None
 * of them owns a rule under test.
 *
 * anti-slop stays. Its specifier is an absolute `file:` URL, which resolves
 * from anywhere, and that it does is half of what these tests are for. Globs
 * and options are untouched.
 */
type Rules = Readonly<Record<string, DummyRule | undefined>>;
export type Config = {
  readonly jsPlugins?: readonly ExternalPluginEntry[];
  readonly overrides?: readonly { readonly rules?: Rules }[];
  readonly rules?: Rules;
};

/** An entry is a package name or `{ name, specifier }`. Name the half that is not a name. */
const isAliased = (entry: ExternalPluginEntry): entry is Exclude<ExternalPluginEntry, string> =>
  typeof entry !== "string";

/** `eslint-plugin-perfectionist` owns `perfectionist/…`; an alias owns its own name. */
const prefix = (entry: ExternalPluginEntry) =>
  (isAliased(entry) ? entry.name : entry.replace("eslint-plugin-", "")) + "/";

/** Absolute, so it resolves from the fixture tree as readily as from here. */
const survives = (entry: ExternalPluginEntry) => isAliased(entry) && URL.canParse(entry.specifier);

export function withoutJsPlugins({
  jsPlugins = [],
  overrides = [],
  rules = {},
  ...rest
}: Config) {
  const owned = jsPlugins.filter((entry) => !survives(entry)).map(prefix);
  const keep = (by: Rules) =>
    Object.fromEntries(Object.entries(by).filter(([id]) => !owned.some((p) => id.startsWith(p))));

  return {
    ...rest,
    jsPlugins: jsPlugins.filter(survives),
    overrides: overrides.map((o) => ({ ...o, rules: keep(o.rules ?? {}) })),
    rules: keep(rules),
  };
}

/** `JSON.parse` returns `any`; name the shape once, at the boundary. */
const parseReport: (json: string) => { diagnostics: { code: string; filename: string }[] } =
  JSON.parse;

/**
 * Rule ids oxlint reports for each file, laid out at that exact path. Pairs
 * rather than an object, so each case keeps the comment explaining it.
 */
export function lint(
  files: readonly (readonly [path: string, source: string])[],
  from: Config = config,
) {
  const root = mkdtempSync(join(tmpdir(), "oxlint-fixture-"));

  for (const [path, source] of files) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }

  writeFileSync(join(root, ".oxlintrc.json"), JSON.stringify(withoutJsPlugins(from)));

  const { stdout } = Bun.spawnSync({
    cmd: [OXLINT, "-c", ".oxlintrc.json", "--format", "json", "."],
    cwd: root,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: TSGOLINT },
  });

  const report = parseReport(stdout.toString());

  const byFile: Record<string, string[]> = {};
  for (const [path] of files) byFile[path] = [];
  for (const { code, filename } of report.diagnostics) {
    // oxlint reports `plugin(rule)`; say it the way the config spells it.
    byFile[filename.replace(/^\.\//, "")]?.push(code.replace(/^(.+)\((.+)\)$/, "$1/$2"));
  }

  return byFile;
}
