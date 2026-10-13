import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Job } from "../src/compactor.ts";
import type { Contender } from "../dev/bakeoff-options.ts";
import { bytes } from "../src/tree.ts";
import { RequestAdmission, admitRequest } from "../src/engines/request-admission.ts";
import type { UsageRecord } from "../src/usage.ts";
import {
  type CompleteReplay,
  type Message,
  type Replayed,
  lexicalAnswerer,
  measure,
  modelBuiltNodes,
  overLimit,
  replay,
} from "../dev/bakeoff.ts";
import { parseContender } from "../dev/bakeoff-options.ts";
import { makeRunControl } from "../dev/bakeoff-run.ts";

const TOPICS = ["cartography", "metallurgy", "photosynthesis", "glassblowing", "beekeeping", "astronomy", "calligraphy", "orthodontics"];
const pad = "-".repeat(600);
const messages: Message[] = Array.from({ length: 32 }, (_, index) =>
  index % 2 === 0
    ? { kind: "user", text: `Please file ticket ${index} under the ${TOPICS[(index / 2) % TOPICS.length] ?? ""} queue before review. ${pad}` }
    : { kind: "echo", text: `exit 0 ${pad}` },
);
const triesFor = (job: Job) => 1 + (job.i % 3);
const fakeCompactor = (keep: boolean) => (_contender: Contender, log: (record: UsageRecord) => Effect.Effect<void>) =>
  Effect.succeed((job: Job) =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= triesFor(job); attempt++)
        yield* log({
          attempt,
          auth: "chatgpt-pro",
          cold: attempt === 1,
          date: new Date().toISOString(),
          device: null,
          engine: "openai-plan",
          failoverFrom: null,
          level: job.l,
          model: "fake",
          ms: 1,
          role: "compact",
          usage: { cacheRead: 900, cacheWrite: 0, input: 100, output: 40 },
        });
      if ("msg" in job) return keep ? `${job.msg.kind}: ${job.msg.text.split(" -")[0] ?? ""}` : `${job.msg.kind}: a message of ${bytes(job.msg.text)} bytes`;
      return keep ? `${job.a.slice(0, 200)}; ${job.b.slice(0, 200)}` : "two parts of the work";
    }),
  );

const complete = (value: Replayed): CompleteReplay => {
  if (value.type !== "complete") throw new Error("expected complete replay");
  return value;
};

test("replay metrics distinguish retained wording and count retries from usage", async () => {
  const run = async (name: string, keep: boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const replayed = complete(yield* replay({ budget: 600, contender: parseContender(`${name}=openai-plan:fake`), messages, poll: "5 millis", summarizeFor: fakeCompactor(keep) }));
        return yield* measure(replayed, messages, { answerer: lexicalAnswerer, questions: 8 });
      }),
    );
  const keeper = await run("keeper", true);
  const paraphraser = await run("paraphraser", false);
  expect(keeper.tries.p95).toBe(3);
  expect(keeper.tries.nodes).toBeGreaterThan(messages.length);
  expect(keeper.wordsKept.find((level) => level.level === 0)?.quoted).toBe(1);
  expect(paraphraser.wordsKept.find((level) => level.level === 0)?.quoted).toBe(0);
  expect(keeper.findability.share).toBeGreaterThan(paraphraser.findability.share);
});

test("over-limit output fails before the summary is committed", async () => {
  const run = makeRunControl(10, false);
  const contender = parseContender("wide=openai-plan:fake");
  let calls = 0;
  const replayed = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender,
      control: run.begin(contender.name),
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () => Effect.succeed(() => Effect.sync(() => (calls++, "y".repeat(513)))),
    }),
  );
  expect(calls).toBe(1);
  expect(replayed.type).toBe("failed");
  if (replayed.type === "failed" && replayed.failure.type === "diagnostic") expect(replayed.failure.reason.type).toBe("over-limit");
  expect(overLimit(replayed.mem)).toBe(0);
  expect(replayed.mem.tree.size).toBe(0);
});

test("the global authorization cap interrupts replay authoritatively", async () => {
  const run = makeRunControl(1, false);
  const contender = parseContender("capped=openai-plan:fake");
  let boundary = 0;
  const replayed = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender,
      control: run.begin(contender.name),
      messages: [
        { kind: "user", text: "x".repeat(600) },
        { kind: "user", text: "y".repeat(600) },
      ],
      poll: "1 millis",
      summarizeFor: () =>
        Effect.succeed(() =>
          admitRequest({ model: "fake", transport: "openai-responses" }).pipe(
            Effect.andThen(Effect.sync(() => (boundary++, "talk: short"))),
          ),
        ),
    }).pipe(Effect.provideService(RequestAdmission, run.admission)),
  );
  expect(boundary).toBe(1);
  expect(replayed.type).toBe("failed");
  if (replayed.type === "failed") expect(replayed.failure.type).toBe("global");
  expect(run.globalAbort()?.type).toBe("max-authorized-requests");
});

test("deadline cancellation awaits the active finalizer", async () => {
  const run = makeRunControl(10, false);
  const contender = parseContender("hanging=openai-plan:fake");
  let finalized = false;
  const replayed = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender,
      control: run.begin(contender.name),
      deadline: "30 millis",
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () =>
        Effect.succeed(() => Effect.acquireUseRelease(Effect.void, () => Effect.never, () => Effect.sync(() => void (finalized = true)))),
    }),
  );
  expect(finalized).toBe(true);
  expect(replayed.type).toBe("failed");
  if (replayed.type === "failed" && replayed.failure.type === "diagnostic") expect(replayed.failure.reason.type).toBe("deadline");
});

test("the preflight lower bound counts the complete requested tree", () => {
  expect(modelBuiltNodes(20)).toBe(38);
});
