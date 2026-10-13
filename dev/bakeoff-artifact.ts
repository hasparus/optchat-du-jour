import { Data, Schema } from "effect";
import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const Detail = Schema.String.check(Schema.isMaxLength(300));
const FiniteNonnegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Share = FiniteNonnegative.check(Schema.isLessThanOrEqualTo(1));
const Coord = Schema.Struct({ l: Count, i: Count });

export const DiagnosticReasonSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("usage-limit"), engine: Name, coord: Coord }),
  Schema.Struct({ type: Schema.Literal("over-limit"), coord: Coord, bytes: Count, limit: Count }),
  Schema.Struct({ type: Schema.Literal("unbuilt"), coord: Coord }),
  Schema.Struct({ type: Schema.Literal("deadline"), duration: Detail }),
]);
export type DiagnosticReason = typeof DiagnosticReasonSchema.Type;

export const ProgressSchema = Schema.Struct({
  loggedMessages: Count,
  requestedMessages: Count,
  unbuiltNodeCount: Count,
  usageRecords: Count,
}).check(
  Schema.makeFilter((progress) => progress.loggedMessages <= progress.requestedMessages || "logged messages exceed requested messages"),
);
export type Progress = typeof ProgressSchema.Type;

const TokensPerMessageSchema = Schema.Struct({
  cacheRead: FiniteNonnegative,
  cacheWrite: FiniteNonnegative,
  input: FiniteNonnegative,
  output: FiniteNonnegative,
});
const CostMetricsSchema = Schema.Struct({
  callsPerMessage: FiniteNonnegative,
  cold: Count,
  dollarsPerMessage: FiniteNonnegative,
  failovers: Count,
  tokensPerMessage: TokensPerMessageSchema,
});
const FindabilityMetricsSchema = Schema.Struct({ asked: Count, found: Count, share: Share }).check(
  Schema.makeFilter((value) => value.found <= value.asked || "found answers exceed asked answers"),
);
const TryMetricsSchema = Schema.Struct({ max: Count, mean: FiniteNonnegative, nodes: Count, p95: Count });
const WordMetricsSchema = Schema.Struct({ level: Count, quoted: Share, recall: Share, sentences: Count });

/** The complete, bounded privacy boundary for data allowed into a bake-off artifact. */
export const MetricsSchema = Schema.Struct({
  cost: CostMetricsSchema,
  findability: FindabilityMetricsSchema,
  messages: Count,
  nodes: Count,
  overLimit: Count,
  reportCount: Count,
  tries: TryMetricsSchema,
  wordsKept: Schema.Array(WordMetricsSchema).check(Schema.isMaxLength(32)),
});
export type Metrics = typeof MetricsSchema.Type;

export const CompleteContenderSchema = Schema.Struct({
  type: Schema.Literal("complete"),
  name: Name,
  metrics: MetricsSchema,
  usageRecords: Count,
});
export type CompleteContender = typeof CompleteContenderSchema.Type;
export const FailedContenderSchema = Schema.Struct({
  type: Schema.Literal("failed"),
  name: Name,
  reason: DiagnosticReasonSchema,
  progress: ProgressSchema,
});
export type FailedContender = typeof FailedContenderSchema.Type;
export const ContenderOutcomeSchema = Schema.Union([CompleteContenderSchema, FailedContenderSchema]);
export type ContenderOutcome = typeof ContenderOutcomeSchema.Type;

export const GlobalAbortSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("max-authorized-requests") }),
  Schema.Struct({ type: Schema.Literal("fail-fast"), contender: Name }),
  Schema.Struct({ type: Schema.Literal("unexpected"), contender: Schema.optional(Name) }),
]);
export type GlobalAbort = typeof GlobalAbortSchema.Type;

const RunningActiveSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("active"), name: Name }),
]);
const AbortedActiveSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("interrupted"), name: Name, progress: ProgressSchema }),
  Schema.Struct({ type: Schema.Literal("unavailable"), name: Schema.optional(Name) }),
]);
const RunOutcomeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("running"), contenders: Schema.Array(ContenderOutcomeSchema), active: RunningActiveSchema }),
  Schema.Struct({ type: Schema.Literal("complete"), contenders: Schema.Array(CompleteContenderSchema) }),
  Schema.Struct({ type: Schema.Literal("completed-with-failures"), contenders: Schema.Array(ContenderOutcomeSchema) }),
  Schema.Struct({ type: Schema.Literal("aborted"), abort: GlobalAbortSchema, contenders: Schema.Array(ContenderOutcomeSchema), active: AbortedActiveSchema }),
]);
export type RunOutcome = typeof RunOutcomeSchema.Type;

const usageOf = (contender: ContenderOutcome) => contender.type === "complete" ? contender.usageRecords : contender.progress.usageRecords;

export const BakeoffArtifactSchema = Schema.Struct({
  version: Schema.Literal(2),
  requestedNames: Schema.Array(Name).check(Schema.isMaxLength(10_000)),
  requests: Schema.Struct({ authorized: Count, max: PositiveCount }),
  outcome: RunOutcomeSchema,
}).check(
  Schema.makeFilter((artifact) => {
    if (artifact.requests.authorized > artifact.requests.max) return "invalid request counts";
    if (new Set(artifact.requestedNames).size !== artifact.requestedNames.length) return "duplicate requested name";
    const { outcome } = artifact;
    const names = outcome.contenders.map((contender) => contender.name);
    if (!names.every((name, index) => name === artifact.requestedNames[index])) return "contenders are not the requested prefix";
    const completedUsage = outcome.contenders.reduce((sum, contender) => sum + usageOf(contender), 0);
    const activeUsage = outcome.type === "aborted" && outcome.active.type === "interrupted" ? outcome.active.progress.usageRecords : 0;
    if (completedUsage + activeUsage > artifact.requests.authorized) return "usage records exceed authorized requests";
    if (outcome.type === "running" && outcome.active.type === "active" && outcome.active.name !== artifact.requestedNames[names.length]) return "active contender is out of order";
    if (outcome.type === "complete" && names.length !== artifact.requestedNames.length) return "incomplete complete outcome";
    if (outcome.type === "completed-with-failures") {
      if (names.length !== artifact.requestedNames.length) return "incomplete completed outcome";
      if (!outcome.contenders.some((contender) => contender.type === "failed")) return "failure outcome has no failure";
    }
    if (outcome.type === "aborted") {
      if (outcome.abort.type === "max-authorized-requests" && artifact.requests.authorized !== artifact.requests.max) return "request cap abort is inconsistent";
      if (outcome.abort.type === "unexpected" && outcome.active.type === "interrupted") return "unexpected progress must be unavailable";
      if (outcome.abort.type !== "unexpected" && outcome.active.type === "unavailable") return "expected abort requires known progress";
      if (outcome.abort.type === "fail-fast") {
        const failed = outcome.contenders.at(-1);
        if (failed?.type !== "failed" || failed.name !== outcome.abort.contender || outcome.active.type !== "none") return "fail-fast does not reference its failed contender";
      }
      if (outcome.active.type === "interrupted" && outcome.active.name !== artifact.requestedNames[names.length]) return "active contender is out of order";
      if (outcome.active.type === "unavailable" && outcome.active.name !== undefined && outcome.active.name !== artifact.requestedNames[names.length]) return "unavailable contender is out of order";
    }
  }),
);
export type BakeoffArtifact = typeof BakeoffArtifactSchema.Type;

export const encodeArtifact = (artifact: BakeoffArtifact): string => {
  const encoded = Schema.encodeSync(BakeoffArtifactSchema)(artifact);
  return `${JSON.stringify(encoded, null, 2)}\n`;
};

export const decodeArtifact = Schema.decodeUnknownSync(BakeoffArtifactSchema);

const temporaryPath = (path: string) => `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
const syncDirectory = (path: string) => {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const cleanup = (run: () => void) => {
  try { run(); } catch { return; }
};
const writeSyncedTemporary = (path: string, encoded: string) => {
  const temporary = temporaryPath(path);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, encoded);
    fsyncSync(fd);
    closeSync(fd);
    return temporary;
  } catch (error) {
    cleanup(() => { closeSync(fd); });
    cleanup(() => { unlinkSync(temporary); });
    throw error;
  }
};

export class ArtifactWriteError extends Data.TaggedError("ArtifactWriteError")<{ readonly published: boolean }> {}

const publishArtifact = (path: string, artifact: BakeoffArtifact, replace: boolean): void => {
  let temporary: string | undefined;
  let published = false;
  try {
    temporary = writeSyncedTemporary(path, encodeArtifact(artifact));
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
    published = true;
    syncDirectory(path);
  } catch {
    throw new ArtifactWriteError({ published });
  } finally {
    if (temporary !== undefined) {
      const pathToRemove = temporary;
      cleanup(() => { unlinkSync(pathToRemove); });
    }
  }
};

/** Atomically publishes a complete file and never replaces an existing destination. */
export const createArtifact = (path: string, artifact: BakeoffArtifact): void => { publishArtifact(path, artifact, false); };

/** Atomically replaces an artifact after its complete temporary file is durable. */
export const writeArtifact = (path: string, artifact: BakeoffArtifact): void => { publishArtifact(path, artifact, true); };
