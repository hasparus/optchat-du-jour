import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type BakeoffArtifact, createArtifact, decodeArtifact, encodeArtifact, writeArtifact } from "../dev/bakeoff-artifact.ts";

const progress = { loggedMessages: 1, requestedMessages: 2, unbuiltNodes: ["0.0"], usageRecords: 1 } as const;
const failed = {
  name: "broken",
  progress,
  reason: { contender: "broken", coord: { i: 0, l: 0 }, type: "unbuilt" as const },
  type: "failed" as const,
};
const complete = { metrics: { score: 1 }, name: "good", type: "complete" as const, usageRecords: 2 };
const artifact = (outcome: BakeoffArtifact["outcome"], requestedNames: readonly string[] = ["good", "broken"]): BakeoffArtifact => ({
  outcome,
  requestedNames,
  requests: { authorized: 2, max: 4 },
  version: 2,
});

test("V2 artifact schema round-trips every run outcome variant", () => {
  const variants: BakeoffArtifact["outcome"][] = [
    { contenders: [complete, { ...complete, name: "broken" }], type: "complete" },
    { contenders: [complete, failed], type: "completed-with-failures" },
    {
      abort: { authorized: 2, max: 2, type: "max-authorized-requests" },
      active: { name: "broken", progress, type: "interrupted" },
      contenders: [complete],
      type: "aborted",
    },
    {
      abort: { contender: "broken", reason: failed.reason, type: "fail-fast" },
      active: { type: "none" },
      contenders: [failed],
      type: "aborted",
    },
    { abort: { type: "unexpected" }, active: { type: "none" }, contenders: [], type: "aborted" },
  ];
  for (const outcome of variants) {
    const requested = outcome.type === "aborted" && outcome.abort.type === "fail-fast" ? ["broken"] : undefined;
    const value = artifact(outcome, requested);
    expect(decodeArtifact(JSON.parse(encodeArtifact(value)))).toEqual(value);
  }
});

test("artifacts contain no raw errors, duplicate statuses, or null states", () => {
  const input = {
    ...artifact({ contenders: [complete, failed], type: "completed-with-failures" }),
    rawError: "PRIVATE-RAW-SENTINEL",
  };
  const text = encodeArtifact(decodeArtifact(input));
  expect(text).not.toContain("PRIVATE-RAW-SENTINEL");
  expect(text).not.toContain("null");
  expect(text).not.toContain("completedContenders");
  expect(text).not.toContain('"status"');
  expect(text).not.toContain('"stop"');
});

test("artifact creation is exclusive and later writes are atomic", () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-artifact-`);
  const path = `${dir}/result.json`;
  const initial = artifact({ abort: { type: "unexpected" }, active: { type: "none" }, contenders: [], type: "aborted" });
  createArtifact(path, initial);
  expect(() => {
    createArtifact(path, initial);
  }).toThrow();
  const final = artifact({ contenders: [complete], type: "complete" }, ["good"]);
  writeArtifact(path, final);
  expect(decodeArtifact(JSON.parse(readFileSync(path, "utf8")))).toEqual(final);
});
