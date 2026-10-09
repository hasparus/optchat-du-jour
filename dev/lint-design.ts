#!/usr/bin/env bun
// Impeccable's design detector (`impeccable detect`, the rule-based anti-pattern scan behind the
// /impeccable skill, .claude/skills/impeccable) over web/index.html and web/src: the UI's markup,
// components and styles, and the unit tests beside them. The rest of web/ is config files, public
// assets, the e2e tests, and build and test output. Fails on any primary finding; advisory ones are
// listed but never fail, as in `impeccable detect` itself. `bun run lint:design -- --format
// github-actions` in CI writes each finding as an annotation instead, a format the detector lacks.
import { Schema } from "effect";
import path from "node:path";

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

// The engine is the one the impeccable devDependency pins (@impeccable/cli-<os>-<arch>): no
// IMPECCABLE_BIN override, and no fallback download, which would fail loudly here if the platform
// package is missing. No update check either.
const { IMPECCABLE_BIN: _override, ...env } = process.env;
const run = Bun.spawnSync(["impeccable", "detect", "--json", ...TARGETS], {
  env: { ...env, IMPECCABLE_DOWNLOAD_BASE: "http://127.0.0.1:9", IMPECCABLE_NO_UPDATE_CHECK: "1" },
  stderr: "inherit",
  stdout: "pipe",
});
// exit 0: no primary findings, 2: some, 1: a target could not be scanned (impeccable detect --help)
const scanned = run.exitCode === 0 || run.exitCode === 2;
const stdout = run.stdout.toString();

let findings: readonly Finding[] = [];
try {
  findings = stdout.trim() === "" && !scanned ? [] : decodeFindings(stdout);
} catch (error) {
  fail(`cannot read the findings of impeccable detect (exit ${run.exitCode}): ${String(error).replaceAll(/\s+/g, " ")}`);
}
const isAdvisory = (finding: Finding) => finding.advisory === true || finding.severity === "advisory";
const primary = findings.filter((finding) => !isAdvisory(finding));

// workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
const level = { advisory: "notice", error: "error", warning: "warning" } as const;
const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

for (const finding of findings) {
  const file = path.relative(process.cwd(), finding.file);
  const severity = isAdvisory(finding) ? "advisory" : finding.severity;
  if (github) {
    const line = finding.line >= 1 ? `,line=${finding.line}` : "";
    const title = escapeProperty(`impeccable ${finding.antipattern}: ${finding.name}`);
    const message = escapeData(`${finding.snippet}: ${finding.description}`);
    process.stdout.write(`::${level[severity]} file=${escapeProperty(file)}${line},title=${title}::${message}\n`);
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
  fail(`impeccable detect exited with ${run.exitCode}${run.exitCode === 1 ? ": a target could not be scanned" : ""}`);
}
process.exitCode = primary.length > 0 ? 1 : 0;
