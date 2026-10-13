import { Schema } from "effect";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Name = Schema.String.check(Schema.isMaxLength(100));
const Detail = Schema.String.check(Schema.isMaxLength(300));
const Node = Schema.String.check(Schema.isMaxLength(40));
const Coord = Schema.Struct({ l: Count, i: Count });
const DiagnosticReason = Schema.Union([
  Schema.Struct({ type: Schema.Literal("usage-limit"), contender: Name, engine: Name, coord: Coord }),
  Schema.Struct({ type: Schema.Literal("over-limit"), contender: Name, coord: Coord, bytes: Count, limit: Count }),
  Schema.Struct({ type: Schema.Literal("unbuilt"), contender: Name, coord: Coord }),
  Schema.Struct({ type: Schema.Literal("deadline"), contender: Name, duration: Detail }),
]);
const Progress = Schema.Struct({
  loggedMessages: Count,
  requestedMessages: Count,
  unbuiltNodes: Schema.Array(Node).check(Schema.isMaxLength(100_000)),
  usageRecords: Count,
});
const CompleteContender = Schema.Struct({
  type: Schema.Literal("complete"),
  name: Name,
  metrics: Schema.Json,
  usageRecords: Count,
});
const FailedContender = Schema.Struct({
  type: Schema.Literal("failed"),
  name: Name,
  reason: DiagnosticReason,
  progress: Progress,
});
const Contender = Schema.Union([CompleteContender, FailedContender]);
const GlobalAbort = Schema.Union([
  Schema.Struct({ type: Schema.Literal("max-authorized-requests"), authorized: Count, max: Count }),
  Schema.Struct({ type: Schema.Literal("fail-fast"), contender: Name, reason: DiagnosticReason }),
  Schema.Struct({ type: Schema.Literal("unexpected"), contender: Schema.optional(Name) }),
]);
const Active = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("interrupted"), name: Name, progress: Progress }),
]);
const RunOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("complete"), contenders: Schema.Array(CompleteContender) }),
  Schema.Struct({ type: Schema.Literal("completed-with-failures"), contenders: Schema.Array(Contender) }),
  Schema.Struct({ type: Schema.Literal("aborted"), abort: GlobalAbort, contenders: Schema.Array(Contender), active: Active }),
]);

export const BakeoffArtifactSchema = Schema.Struct({
  version: Schema.Literal(2),
  requestedNames: Schema.Array(Name).check(Schema.isMaxLength(10_000)),
  requests: Schema.Struct({ authorized: Count, max: Count }),
  outcome: RunOutcome,
}).check(
  Schema.makeFilter((artifact) => {
    if (artifact.requests.max < 1 || artifact.requests.authorized > artifact.requests.max) return "invalid request counts";
    if (new Set(artifact.requestedNames).size !== artifact.requestedNames.length) return "duplicate requested name";
    const names = artifact.outcome.contenders.map((contender) => contender.name);
    if (!names.every((name, index) => name === artifact.requestedNames[index])) return "contenders are not a requested prefix";
    if (artifact.outcome.type === "complete" && names.length !== artifact.requestedNames.length) return "incomplete complete outcome";
    if (artifact.outcome.type === "completed-with-failures") {
      if (names.length !== artifact.requestedNames.length) return "incomplete completed outcome";
      if (!artifact.outcome.contenders.some((contender) => contender.type === "failed")) return "failure outcome has no failure";
    }
    if (
      artifact.outcome.type === "aborted" &&
      artifact.outcome.active.type === "interrupted" &&
      artifact.outcome.active.name !== artifact.requestedNames[names.length]
    )
      return "active contender is out of order";
  }),
);
export type BakeoffArtifact = typeof BakeoffArtifactSchema.Type;

export const encodeArtifact = (artifact: BakeoffArtifact): string => {
  const encoded = Schema.encodeSync(BakeoffArtifactSchema)(artifact);
  return `${JSON.stringify(encoded, null, 2)}\n`;
};

export const decodeArtifact = Schema.decodeUnknownSync(BakeoffArtifactSchema);

export function createArtifact(path: string, artifact: BakeoffArtifact): void {
  const encoded = encodeArtifact(artifact);
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, encoded);
  } finally {
    closeSync(fd);
  }
}

export function writeArtifact(path: string, artifact: BakeoffArtifact): void {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(temporary, encodeArtifact(artifact), { flag: "wx" });
  renameSync(temporary, path);
}
