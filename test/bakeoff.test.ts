// dev/bakeoff.ts with fake compactors only: one that keeps the user's words, one that paraphrases
// them away. The measures must tell the two apart, and the retry count must come out of the
// usage records alone.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Job } from "../src/compactor.ts";
import { bytes } from "../src/tree.ts";
import type { UsageRecord } from "../src/usage.ts";
import { type Contender, type Message, lexicalAnswerer, measure, parseContender, replay } from "../dev/bakeoff.ts";

const TOPICS = ["cartography", "metallurgy", "photosynthesis", "glassblowing", "beekeeping", "astronomy", "calligraphy", "orthodontics"];
const pad = "-".repeat(600); // no words: long enough that every message needs a model call
const messages: Message[] = Array.from({ length: 32 }, (_, i) =>
  i % 2 === 0
    ? { kind: "user", text: `Please file ticket ${i} under the ${TOPICS[(i / 2) % TOPICS.length] ?? ""} queue before review. ${pad}` }
    : { kind: "echo", text: `exit 0 ${pad}` },
);

// how many tries a fake call takes: 1, 2 or 3 by the node's index
const triesFor = (job: Job) => 1 + (job.i % 3);

const fakeCompactor = (keep: boolean) => (_c: Contender, log: (r: UsageRecord) => Effect.Effect<void>) =>
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

test("the bake-off tells a compactor that keeps the user's words from one that paraphrases them", async () => {
  const run = async (name: string, keep: boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* replay({ budget: 600, contender: parseContender(`${name}=openai-plan:fake`), messages, poll: "5 millis", summarizeFor: fakeCompactor(keep) });
        return yield* measure(r, messages, { answerer: lexicalAnswerer, questions: 8 });
      }),
    );
  const keeper = await run("keeper", true);
  const paraphraser = await run("paraphraser", false);

  // every model-built node logged attempts 1..k: mean and p95 come back from the records
  expect(keeper.retries.calls).toBeGreaterThan(messages.length);
  expect(keeper.retries.p95).toBe(3);
  expect(keeper.retries.mean).toBeGreaterThan(1.5);
  expect(keeper.cost.tokensPerMessage.cacheRead).toBeCloseTo(keeper.cost.callsPerMessage * 900, 5);

  const level = (m: typeof keeper, l: number) => m.wordsKept.find((w) => w.level === l);
  expect(level(keeper, 0)?.quoted).toBe(1);
  expect(level(keeper, 2)?.quoted).toBeGreaterThan(0.5);
  expect(level(paraphraser, 0)?.quoted).toBe(0);
  expect(level(paraphraser, 3)?.quoted).toBe(0);

  // the view is folded small (budget 600), so finding an answer takes zooming down the tree
  expect(keeper.findability.asked).toBe(8);
  expect(keeper.findability.share).toBeGreaterThan(paraphraser.findability.share);
});

test("a chain spec names its levels, and the first starts at 0", () => {
  expect(parseContender("split=0:openai-plan:gpt-6-luna,claude-code:sonnet;3:openai-plan:gpt-6.1-sol")).toEqual({
    byLevel: [
      { chain: ["openai-plan:gpt-6-luna", "claude-code:sonnet"], from: 0 },
      { chain: ["openai-plan:gpt-6.1-sol"], from: 3 },
    ],
    name: "split",
  });
  expect(() => parseContender("x=2:claude-code:sonnet")).toThrow();
  expect(() => parseContender("x=gpt-6")).toThrow();
});
