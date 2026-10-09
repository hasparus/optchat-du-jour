#!/usr/bin/env bun
// Impeccable's design detector (`impeccable detect`, the rule-based anti-pattern scan behind the
// /impeccable skill, .claude/skills/impeccable) over the web UI's sources: index.html and src/. The
// rest of web/ is tests and build output. Fails on any primary finding; advisory ones are listed but
// never fail, as in `impeccable detect` itself. `bun run lint:design -- --format github-actions` in
// CI also writes each finding as an annotation, which the detector has no output format for.
import { Schema } from "effect";
import path from "node:path";

const TARGETS = ["web/index.html", "web/src"];

// the fields of a finding in `impeccable detect --json` that this script reads
const Finding = Schema.Struct({
  antipattern: Schema.String,
  name: Schema.String,
  description: Schema.String,
  severity: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  snippet: Schema.String,
  advisory: Schema.optional(Schema.Boolean),
});
type Finding = typeof Finding.Type;
const decodeFindings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Finding)));

const args = process.argv.slice(2);
const formatAt = args.indexOf("--format");
const format = formatAt === -1 ? undefined : args[formatAt + 1];
if (formatAt !== -1 && format !== "github-actions") {
  process.stderr.write(`lint:design: unknown --format ${format ?? "(none)"}; the one format is github-actions\n`);
  process.exit(1);
}

// exit 0: no primary findings, 2: some, 1: a target could not be scanned (impeccable detect --help)
const run = Bun.spawnSync(["impeccable", "detect", "--json", ...TARGETS], { stderr: "inherit", stdout: "pipe" });
if (run.exitCode !== 0 && run.exitCode !== 2) {
  process.stderr.write(`lint:design: impeccable detect exited with ${run.exitCode}\n`);
  process.exit(1);
}

const findings = decodeFindings(run.stdout.toString());
const isAdvisory = (finding: Finding) => finding.advisory === true || finding.severity === "advisory";
const primary = findings.filter((finding) => !isAdvisory(finding));

// workflow commands: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

for (const finding of findings) {
  const file = path.relative(process.cwd(), finding.file);
  const advisory = isAdvisory(finding);
  process.stdout.write(
    `${file}:${finding.line} ${advisory ? "advisory" : finding.severity} ${finding.antipattern}: ${finding.name} (${finding.snippet})\n  ${finding.description}\n`,
  );
  if (format === "github-actions") {
    const title = escapeProperty(`impeccable ${finding.antipattern}: ${finding.name}`);
    process.stdout.write(
      `::${advisory ? "notice" : "error"} file=${escapeProperty(file)},line=${finding.line},title=${title}::${escapeData(`${finding.snippet}: ${finding.description}`)}\n`,
    );
  }
}

const advisories = findings.length - primary.length;
process.stdout.write(
  `impeccable detect: ${primary.length} finding${primary.length === 1 ? "" : "s"}${advisories > 0 ? `, ${advisories} advisory` : ""} in ${TARGETS.join(", ")}\n`,
);
process.exitCode = primary.length > 0 ? 1 : 0;
