// The vendored /impeccable skill (.claude/skills/impeccable) and the `impeccable` devDependency
// that `bun run lint:design` runs must be the same release: the skill's launcher pins the engine in
// scripts/VERSION, and the npm CLI ships its engine as the @impeccable/cli-<os>-<arch> packages.
// PROVENANCE.md there has the update steps.
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");
const skillDir = [".claude", "skills", "impeccable"];
const Versions = Schema.Record(Schema.String, Schema.String);
const cli = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ optionalDependencies: Versions, version: Schema.String })),
)(read("node_modules", "impeccable", "package.json"));

test("the skill's pinned engine is the one the impeccable CLI ships", () => {
  const engine = read(...skillDir, "scripts", "VERSION").trim();
  const platforms = Object.entries(cli.optionalDependencies).filter(([name]) => name.startsWith("@impeccable/cli-"));
  expect(platforms.length).toBeGreaterThan(0);
  for (const [name, version] of platforms) expect(`${name}@${version}`).toBe(`${name}@${engine}`);
});

test("the skill's version is the impeccable CLI's, and the one package.json pins", () => {
  const skill = /^version:\s*(\S+)\s*$/m.exec(read(...skillDir, "SKILL.md"))?.[1];
  expect(skill).toBe(cli.version);
  const root = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ devDependencies: Versions })))(read("package.json"));
  expect(root.devDependencies.impeccable).toBe(cli.version);
});
