#!/usr/bin/env bun
// Impeccable's design detector (`impeccable detect`, the rule-based anti-pattern scan behind the
// /impeccable skill, .claude/skills/impeccable) over web/index.html and web/src: the UI's markup,
// components and styles, and the unit tests beside them. The rest of web/ is config files, public
// assets, the e2e tests, and build and test output. Fails on any primary finding; advisory ones are
// listed but never fail, as in `impeccable detect` itself. `bun run lint:design -- --format
// github-actions` in CI writes each finding as an annotation instead, a format the detector lacks.
//
// The detector also reads .impeccable/config.json (committed, so CI sees it too) and
// .impeccable/config.local.json (per developer, gitignored). Detector settings in the local file
// (detector.ignoreRules, ignoreFiles, ignoreValues, designSystem.enabled, advisoryRules) change
// what a local run reports but not what CI does, so this script warns when that file sets any.
import { Option, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TARGETS = ["web/index.html", "web/src"];

const fail = (message: string): never => {
  process.stderr.write(`lint:design: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const github =
  args.length === 0
    ? false
    : (args.length === 2 && args[0] === "--format" && args[1] === "github-actions") ||
      (args.length === 1 && args[0] === "--format=github-actions") ||
      fail(`unknown arguments: ${args.join(" ")}; the one option is --format github-actions`);

// The fields of a finding in `impeccable detect --json` that this script reads. A finding with no
// line has line 0.
const Finding = Schema.Struct({
  antipattern: Schema.String,
  name: Schema.String,
  description: Schema.String,
  severity: Schema.Literals(["error", "warning", "advisory"]),
  file: Schema.String,
  line: Schema.Int,
  snippet: Schema.String,
  advisory: Schema.optional(Schema.Boolean),
});
type Finding = typeof Finding.Type;
const decodeFindings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Finding)));

// the detector settings .impeccable/config.local.json sets, if any
const LocalConfig = Schema.Struct({
  detector: Schema.optional(
    Schema.Struct({
      ignoreRules: Schema.optional(Schema.Array(Schema.Unknown)),
      ignoreFiles: Schema.optional(Schema.Array(Schema.Unknown)),
      ignoreValues: Schema.optional(Schema.Array(Schema.Unknown)),
      designSystem: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      advisoryRules: Schema.optional(Schema.Unknown),
    }),
  ),
});
type LocalConfig = typeof LocalConfig.Type;
const detectorSettings = ({ detector = {} }: LocalConfig) =>
  [
    (detector.ignoreRules?.length ?? 0) > 0 && "ignoreRules",
    (detector.ignoreFiles?.length ?? 0) > 0 && "ignoreFiles",
    (detector.ignoreValues?.length ?? 0) > 0 && "ignoreValues",
    detector.designSystem?.enabled !== undefined && "designSystem.enabled",
    detector.advisoryRules !== undefined && detector.advisoryRules !== null && "advisoryRules",
  ].filter((key) => key !== false);
const decodeLocalConfig = Schema.decodeUnknownOption(Schema.fromJsonString(LocalConfig));
const localConfigPath = path.join(ROOT, ".impeccable", "config.local.json");
let localConfigText: string | undefined;
try {
  localConfigText = readFileSync(localConfigPath, "utf8");
} catch {
  // no local config
}
const localDetectorKeys = Option.match(Option.fromUndefinedOr(localConfigText).pipe(Option.flatMap(decodeLocalConfig)), {
  onNone: () => [],
  onSome: detectorSettings,
});
if (localDetectorKeys.length > 0) {
  process.stderr.write(
    `lint:design: warning: ${path.relative(ROOT, localConfigPath)} sets detector.${localDetectorKeys.join(", detector.")}; this run applies them, CI does not\n`,
  );
}

// The engine is the one the impeccable devDependency pins (@impeccable/cli-<os>-<arch>), run by
// that package's shim in node_modules/.bin, never an `impeccable` elsewhere on PATH. The shim's
// other ways to an engine are shut: IMPECCABLE_BIN is dropped, IMPECCABLE_HOME is a directory that
// doesn't exist (no engine cached under ~/.impeccable is used), and its fallback download points at
// an unreachable address, so a missing platform package fails loudly.
const shim = path.join(ROOT, "node_modules", ".bin", "impeccable");
if (!existsSync(shim)) fail(`${path.relative(ROOT, shim)} is missing; run bun install`);
const { IMPECCABLE_BIN: _bin, IMPECCABLE_HOME: _home, ...env } = process.env;
const run = Bun.spawnSync([shim, "detect", "--json", ...TARGETS], {
  cwd: ROOT,
  env: { ...env, IMPECCABLE_DOWNLOAD_BASE: "http://127.0.0.1:9", IMPECCABLE_HOME: path.join(ROOT, "node_modules", ".impeccable-none") },
  stderr: "inherit",
  stdout: "pipe",
});
const ended = run.signalCode === undefined ? `exited with ${run.exitCode}` : `was killed by ${run.signalCode}`;
// exit 0: no primary findings, 2: some, 1: a target could not be scanned (impeccable detect --help),
// or the engine crashed
const scanned = run.exitCode === 0 || run.exitCode === 2;
const stdout = run.stdout.toString();

let findings: readonly Finding[] = [];
try {
  findings = stdout.trim() === "" && !scanned ? [] : decodeFindings(stdout);
} catch (error) {
  fail(`cannot read the findings of impeccable detect, which ${ended}: ${String(error).replaceAll(/\s+/g, " ")}`);
}
const isAdvisory = (finding: Finding) => finding.advisory === true || finding.severity === "advisory";
const primary = findings.filter((finding) => !isAdvisory(finding));

// workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

for (const finding of findings) {
  const file = path.relative(ROOT, finding.file);
  const severity = isAdvisory(finding) ? "advisory" : finding.severity;
  if (github) {
    const line = finding.line >= 1 ? `,line=${finding.line}` : "";
    const title = escapeProperty(`impeccable ${finding.antipattern}: ${finding.name}`);
    const message = escapeData(`${finding.snippet}: ${finding.description}`);
    // a primary finding fails the step, whatever its severity
    process.stdout.write(`::${severity === "advisory" ? "notice" : "error"} file=${escapeProperty(file)}${line},title=${title}::${message}\n`);
  } else {
    const at = finding.line >= 1 ? `${file}:${finding.line}` : file;
    process.stdout.write(
      oneLine(`${at} ${severity} ${finding.antipattern}: ${finding.name} (${finding.snippet}) ${finding.description}`) + "\n",
    );
  }
}

const advisories = findings.length - primary.length;
if (scanned || findings.length > 0) {
  process.stdout.write(
    `impeccable detect: ${primary.length} finding${primary.length === 1 ? "" : "s"}${advisories > 0 ? `, ${advisories} advisory` : ""} in ${TARGETS.join(", ")}\n`,
  );
}
if (!scanned) {
  fail(`impeccable detect ${ended}${run.exitCode === 1 ? ": a target could not be scanned, or the engine crashed" : ""}`);
}
process.exitCode = primary.length > 0 ? 1 : 0;
