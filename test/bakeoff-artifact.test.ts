import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { type BakeoffArtifact, createArtifact, decodeArtifact, encodeArtifact, writeArtifact } from "../dev/bakeoff-artifact.ts";
import { metrics } from "./bakeoff-fixture.ts";

const progress = { loggedMessages: 1, requestedMessages: 2, unbuiltNodeCount: 1, usageRecords: 1 } as const;
const failed = { name: "broken", progress, reason: { coord: { i: 0, l: 0 }, type: "unbuilt" as const }, type: "failed" as const };
const complete = { metrics, name: "good", type: "complete" as const, usageRecords: 1 };
const artifact = (outcome: BakeoffArtifact["outcome"], requestedNames: readonly string[] = ["good", "broken"]): BakeoffArtifact => ({
  outcome,
  requestedNames,
  requests: { authorized: 2, max: 2 },
  version: 2,
});

test("V2 artifact schema round-trips every running and terminal variant", () => {
  const variants: BakeoffArtifact["outcome"][] = [
    { active: { type: "none" }, contenders: [], type: "running" },
    { active: { name: "broken", type: "active" }, contenders: [complete], type: "running" },
    { contenders: [complete, { ...complete, name: "broken" }], type: "complete" },
    { contenders: [complete, failed], type: "completed-with-failures" },
    { abort: { type: "max-authorized-requests" }, active: { name: "broken", progress, type: "interrupted" }, contenders: [complete], type: "aborted" },
    { abort: { contender: "broken", type: "fail-fast" }, active: { type: "none" }, contenders: [complete, failed], type: "aborted" },
    { abort: { type: "unexpected" }, active: { type: "none" }, contenders: [], type: "aborted" },
    { abort: { type: "unexpected" }, active: { name: "good", type: "unavailable" }, contenders: [], type: "aborted" },
  ];
  for (const outcome of variants) {
    const value = artifact(outcome);
    expect(decodeArtifact(JSON.parse(encodeArtifact(value)))).toEqual(value);
  }
});

test("schema rejects impossible progress, request counts, order and terminal states", () => {
  const invalid: BakeoffArtifact[] = [
    artifact({ contenders: [], type: "complete" }),
    artifact({ abort: { type: "unexpected" }, active: { name: "good", progress, type: "interrupted" }, contenders: [], type: "aborted" }),
    artifact({ abort: { type: "max-authorized-requests" }, active: { name: "good", type: "unavailable" }, contenders: [], type: "aborted" }),
    artifact({ abort: { contender: "broken", type: "fail-fast" }, active: { name: "broken", progress, type: "interrupted" }, contenders: [complete], type: "aborted" }),
    artifact({ contenders: [complete, { ...complete, name: "broken" }], type: "completed-with-failures" }),
    artifact({ contenders: [failed, complete], type: "completed-with-failures" }),
    artifact({ abort: { contender: "broken", type: "fail-fast" }, active: { type: "none" }, contenders: [], type: "aborted" }),
    artifact({ active: { name: "broken", type: "active" }, contenders: [], type: "running" }),
    artifact({ contenders: [complete, { ...failed, progress: { ...progress, loggedMessages: 3 } }], type: "completed-with-failures" }),
    artifact({ contenders: [complete, { ...failed, progress: { ...progress, usageRecords: 3 } }], type: "completed-with-failures" }),
    { ...artifact({ contenders: [], active: { type: "none" }, type: "running" }), requests: { authorized: 3, max: 2 } },
    { ...artifact({ abort: { type: "max-authorized-requests" }, active: { type: "none" }, contenders: [], type: "aborted" }), requests: { authorized: 1, max: 2 } },
  ];
  for (const value of invalid) expect(() => encodeArtifact(value)).toThrow();
});

test("explicit nested metrics schema strips raw/private/path sentinels on both encode and decode", () => {
  const privateMetrics = { ...metrics, dir: "PRIVATE", raw: { text: "PRIVATE" }, cost: { ...metrics.cost, rawError: "PRIVATE" }, wordsKept: [{ level: 0, quoted: 0, recall: 0, sentences: 0, text: "PRIVATE" }] };
  const input = {
    ...artifact({ contenders: [{ ...complete, metrics: privateMetrics }, failed], type: "completed-with-failures" }),
    rawError: "PRIVATE",
  };
  for (const value of [input, decodeArtifact(input)]) {
    const text = encodeArtifact(value);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain('"dir"');
    expect(text).not.toContain('"status"');
  }
});

test("two processes racing initial publication produce exactly one exclusive winner", async () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-exclusive-`);
  try {
    const path = `${dir}/result.json`;
    const initial = artifact({ active: { type: "none" }, contenders: [], type: "running" });
    const module = new URL("../dev/bakeoff-artifact.ts", import.meta.url).pathname;
    const code = `import { createArtifact } from ${JSON.stringify(module)}; try { createArtifact(${JSON.stringify(path)}, ${JSON.stringify(initial)}); } catch { process.exitCode = 3; }`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" }));
    const exits = await Promise.all(children.map(async (child) => child.exited));
    expect(exits.sort((a, b) => a - b)).toEqual([0, 3]);
    expect(decodeArtifact(JSON.parse(readFileSync(path, "utf8")))).toEqual(initial);
    expect(readdirSync(dir)).toEqual(["result.json"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("exclusive create and fsynced replacement clean temporary files on success and failure", () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-artifact-`);
  try {
    const path = `${dir}/result.json`;
    const initial = artifact({ active: { type: "none" }, contenders: [], type: "running" });
    createArtifact(path, initial);
    const before = readFileSync(path, "utf8");
    expect(() => { createArtifact(path, initial); }).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    const final = artifact({ contenders: [complete], type: "complete" }, ["good"]);
    writeArtifact(path, final);
    expect(decodeArtifact(JSON.parse(readFileSync(path, "utf8")))).toEqual(final);
    mkdirSync(`${dir}/blocked`);
    expect(() => { writeArtifact(`${dir}/blocked`, final); }).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["blocked", "result.json"]);
    expect(() => { createArtifact(`${dir}/invalid`, artifact({ contenders: [], type: "complete" })); }).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["blocked", "result.json"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
