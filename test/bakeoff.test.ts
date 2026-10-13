// dev/bakeoff.ts with fake compactors only: one that keeps the user's words, one that paraphrases
// them away. The measures must tell the two apart, and the retry count must come out of the
// usage records alone.
import { expect, spyOn, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CompactError, type Job } from "../src/compactor.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { sizeRetries } from "../src/summarize/step.ts";
import { bytes } from "../src/tree.ts";
import type { UsageRecord } from "../src/usage.ts";
import {
  type ArtifactContender,
  BakeoffStopped,
  bakeoffArtifact,
  type Contender,
  controlledStopText,
  diagnosticCountText,
  type Message,
  lexicalAnswerer,
  makeBakeoffController,
  measure,
  modelBuiltNodes,
  overLimit,
  parseContender,
  replay,
  runBakeoffCli,
  runContenders,
  writeArtifact,
} from "../dev/bakeoff.ts";

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

  // every model-built node logged attempts 1..k, keyed by node: mean and p95 come back from the records
  expect(keeper.tries.nodes).toBeGreaterThan(messages.length);
  expect(keeper.tries.p95).toBe(3);
  expect(keeper.tries.max).toBe(3);
  expect(keeper.tries.mean).toBeGreaterThan(1.5);
  expect(keeper.unbuilt).toBe(0);
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
  const split = parseContender("split=0:openai-plan:gpt-6-luna,claude-code:sonnet;3:openai-plan:gpt-6.1-sol");
  expect(split.name).toBe("split");
  expect(split.byLevel.map((b) => [b.from, b.chain.map((r) => [r.engine, r.model])])).toEqual([
    [
      0,
      [
        ["openai-plan", "gpt-6-luna"],
        ["claude-code", "sonnet"],
      ],
    ],
    [3, [["openai-plan", "gpt-6.1-sol"]]],
  ]);
  expect(() => parseContender("x=2:claude-code:sonnet")).toThrow();
  expect(() => parseContender("x=0:claude-code:sonnet;0:openai-plan:gpt-6")).toThrow("levels must strictly increase");
  expect(() => parseContender("x=0:claude-code:sonnet;3:openai-plan:gpt-6;2:claude-code:opus")).toThrow("levels must strictly increase");
  expect(() => parseContender("x=0:claude-code:sonnet;9007199254740992:openai-plan:gpt-6")).toThrow("levels must be nonnegative safe integers");
  expect(() => parseContender("x=gpt-6")).toThrow();
  expect(() => parseContender("x=api-key:claude-sonnet")).toThrow("must be api-key:anthropic/<model> or api-key:openai/<model>"); // api-key names its provider
  expect(parseContender("k=api-key:anthropic/claude-sonnet").byLevel[0].chain).toEqual([{ engine: "api-key", model: "claude-sonnet", provider: "anthropic", ref: "api-key:anthropic/claude-sonnet" }]);
});

test("tries are counted per node across failed calls and failovers; a replay that can't finish stops at its deadline and says what is left", async () => {
  const seen = new Map<string, number>();
  // the first call of each level-0 node fails after one logged try, the pump retries it, the second
  // call takes two tries; nothing above level 0 is ever built
  const stubborn = (_c: Contender, log: (r: UsageRecord) => Effect.Effect<void>) =>
    Effect.succeed((job: Job) =>
      Effect.gen(function* () {
        if (job.l > 0) return yield* Effect.never;
        const key = `${job.l}.${job.i}`;
        const call = (seen.get(key) ?? 0) + 1;
        seen.set(key, call);
        const record = (attempt: number) =>
          log({ attempt, auth: "chatgpt-pro", cold: true, date: "", device: null, engine: "openai-plan", failoverFrom: null, level: job.l, model: "fake", ms: 1, role: "compact", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 } });
        yield* record(1);
        if (call === 1) return yield* new CompactError({ message: "boom" });
        yield* record(2);
        return `${"msg" in job ? job.msg.kind : "user"}: ${"z".repeat(300)}`; // two of them make no free merge
      }),
    );
  const few = messages.slice(0, 4);
  const r = await Effect.runPromise(
    Effect.gen(function* () {
      const replayed = yield* replay({ budget: 100_000, contender: parseContender("s=openai-plan:fake"), deadline: "1500 millis", messages: few, poll: "5 millis", retry: "10 millis", summarizeFor: stubborn });
      return { measured: yield* measure(replayed, few, { answerer: lexicalAnswerer, questions: 2 }), replayed };
    }),
  );
  expect(r.measured.tries).toEqual({ max: 3, mean: 3, nodes: 4, p95: 3 });
  expect(r.replayed.logged).toBe(4);
  expect(r.replayed.unbuilt).toEqual(["1.0", "1.1", "2.0"]);
  expect(r.replayed.reports.at(-1)).toMatch(/^deadline .*4 of 4 messages logged, 3 nodes unbuilt$/);
}, 10_000);

const oneJob: Job = { ctx: [], i: 0, l: 0, msg: { date: "", i: 0, kind: "user", size: 600, text: "x".repeat(600) } };
const fakeAttempt = { attempt: 1, auth: "chatgpt-pro", engine: "openai-plan", failoverFrom: null, job: oneJob } as const;

test("the process-wide controller permits exactly N concurrent attempts", async () => {
  const control = makeBakeoffController(7);
  const hooks = control.hooks("first");
  let invoked = 0;
  const outcomes = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 24 }, () =>
        hooks.beforeRequest(fakeAttempt).pipe(
          Effect.andThen(Effect.sync(() => void invoked++)),
          Effect.result,
        ),
      ),
      { concurrency: "unbounded" },
    ),
  );
  expect(invoked).toBe(7);
  expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(7);
  expect(control.snapshot()).toEqual({
    attempts: 7,
    maxAttempts: 7,
    stop: { attempted: 7, contender: "first", max: 7, type: "max-attempts" },
  });
});

test("a UsageLimit without spent usage is observed after its attempt is counted", async () => {
  const control = makeBakeoffController(4);
  const records: UsageRecord[] = [];
  let invoked = 0;
  const error = await Effect.runPromise(
    Effect.flip(
      sizeRetries({
        ask: (attempt) => attempt.beforeRequest.pipe(Effect.andThen(Effect.sync(() => void invoked++)), Effect.andThen(Effect.fail(new UsageLimit({ message: "PRIVATE-USAGE-SENTINEL" })))),
        auth: "chatgpt-pro",
        effort: undefined,
        engine: "openai-plan",
        failoverFrom: null,
        hooks: control.hooks("limited"),
        job: oneJob,
        log: (record) => Effect.sync(() => void records.push(record)),
      }),
    ),
  );
  expect(error._tag).toBe("UsageLimit");
  expect(invoked).toBe(1);
  expect(records).toEqual([]);
  expect(control.snapshot()).toEqual({
    attempts: 1,
    maxAttempts: 4,
    stop: { contender: "limited", engine: "openai-plan", node: "0.0", type: "usage-limit" },
  });
  const artifact = bakeoffArtifact([], [], control);
  expect(JSON.stringify(artifact)).not.toContain("PRIVATE-USAGE-SENTINEL");
  expect(controlledStopText(artifact.stop!)).not.toContain("PRIVATE-USAGE-SENTINEL");
});

test("an over-limit summary stops replay before more work is scheduled", async () => {
  const control = makeBakeoffController(10);
  let calls = 0;
  const r = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender: parseContender("wide=openai-plan:fake"),
      control,
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () => Effect.succeed(() => Effect.sync(() => (calls++, "y".repeat(513)))),
    }),
  );
  expect(calls).toBe(1);
  expect(r.stop).toEqual({ bytes: 513, contender: "wide", limit: 512, node: "0.0", type: "over-limit" });
  expect(r.reports.at(-1)).toMatch(/^stopped \(over-limit\):/);
});

test("a deadline interrupts hanging work and awaits its finalizer", async () => {
  const control = makeBakeoffController(10);
  let finalized = false;
  const r = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender: parseContender("hanging=openai-plan:fake"),
      control,
      deadline: "40 millis",
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () =>
        Effect.succeed(() =>
          Effect.acquireUseRelease(Effect.void, () => Effect.never, () => Effect.sync(() => void (finalized = true))),
        ),
    }),
  );
  expect(finalized).toBe(true);
  expect(r.stop?.type).toBe("deadline");
  expect(r.unbuilt).toEqual(["0.0"]);
});

test("a stopped contender is persisted as partial and gates later factories", async () => {
  const contenders = [parseContender("first=openai-plan:fake"), parseContender("second=openai-plan:fake")];
  const control = makeBakeoffController(10);
  const started: string[] = [];
  const persisted: string[][] = [];
  const results = await Effect.runPromise(
    runContenders({
      contenders,
      control,
      initial: (contender) => contender.name,
      persist: (current) => Effect.sync(() => void persisted.push(current.map((result) => result.name))),
      run: (contender) =>
        Effect.gen(function* () {
          started.push(contender.name);
          yield* control.stop({ contender: contender.name, node: "0.0", type: "unbuilt" });
          return { complete: false, value: contender.name };
        }),
    }),
  );
  expect(started).toEqual(["first"]);
  expect(results).toEqual([{ name: "first", status: "partial", value: "first" }]);
  expect(persisted).toEqual([["first"], ["first"]]);
});

test("a controlled stop writes an atomic, parseable versioned partial artifact", async () => {
  const control = makeBakeoffController(1);
  const contender = parseContender("only=openai-plan:fake");
  const hooks = control.hooks(contender.name);
  await Effect.runPromise(hooks.beforeRequest(fakeAttempt));
  await Effect.runPromise(Effect.result(hooks.beforeRequest(fakeAttempt)));
  const results: ArtifactContender[] = [{ name: contender.name, status: "partial", value: { metrics: null, usageRecords: null } }];
  const artifact = bakeoffArtifact([contender], results, control);
  const dir = mkdtempSync(`${tmpdir()}/bake-artifact-`);
  const path = `${dir}/result.json`;
  writeArtifact(path, artifact);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(artifact);
  expect(artifact).toMatchObject({
    attempts: { attempted: 1, max: 1 },
    completedContenders: [],
    requestedContenders: ["only"],
    status: "stopped",
    version: 1,
  });
  expect(readdirSync(dir)).toEqual(["result.json"]);
});

test("explicit non-fail-fast mode retains legacy over-limit replay behavior", async () => {
  const control = makeBakeoffController(10, false);
  const r = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender: parseContender("diagnostic=openai-plan:fake"),
      control,
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () => Effect.succeed(() => Effect.succeed("y".repeat(513))),
    }),
  );
  expect(control.snapshot().stop).toBeNull();
  expect(control.isStopped()).toBe(false);
  expect(r.diagnostic).toEqual({ bytes: 513, contender: "diagnostic", limit: 512, node: "0.0", type: "over-limit" });
  expect(r.unbuilt).toEqual([]);
  expect(overLimit(r.mem)).toBe(1);
});

test("a defect replaces a stale artifact with one stopped partial contender", async () => {
  const contender = parseContender("defect=openai-plan:fake");
  const control = makeBakeoffController(10);
  const dir = mkdtempSync(`${tmpdir()}/bake-defect-`);
  const path = `${dir}/result.json`;
  writeFileSync(path, '{"stale":"PRIVATE-STALE-SENTINEL"}\n');
  const exit = await Effect.runPromiseExit(
    runContenders({
      contenders: [contender],
      control,
      initial: () => ({ metrics: null, usageRecords: null }),
      persist: (results: readonly ArtifactContender[]) =>
        Effect.sync(() => {
          writeArtifact(path, bakeoffArtifact([contender], results, control));
        }),
      run: () => Effect.die("PRIVATE-DEFECT-SENTINEL"),
    }),
  );
  expect(exit._tag).toBe("Failure");
  const artifact: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(artifact).toMatchObject({
    contenders: [{ name: "defect", status: "partial", value: { metrics: null } }],
    status: "stopped",
    stop: { contender: "defect", type: "unexpected" },
    version: 1,
  });
  expect(JSON.stringify(artifact)).not.toContain("PRIVATE-STALE-SENTINEL");
  expect(JSON.stringify(artifact)).not.toContain("PRIVATE-DEFECT-SENTINEL");
});

test("interrupting a contender finalizes its current partial artifact", async () => {
  const path = `${tmpdir()}/optchat-bakeoff-interrupt-${crypto.randomUUID()}.json`;
  const contender = parseContender("interrupt=claude-code:sonnet:medium");
  const control = makeBakeoffController(10);
  const started = await Effect.runPromise(Deferred.make<null>());
  const fiber = Effect.runFork(
    runContenders({
      contenders: [contender],
      control,
      initial: () => ({ metrics: null, usageRecords: null }),
      persist: (results: readonly ArtifactContender[]) =>
        Effect.sync(() => {
          writeArtifact(path, bakeoffArtifact([contender], results, control));
        }),
      run: () =>
        control.hooks(contender.name).beforeRequest(fakeAttempt).pipe(
          Effect.andThen(Deferred.succeed(started, null)),
          Effect.andThen(Effect.never),
        ),
    }),
  );
  await Effect.runPromise(Deferred.await(started));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const artifact: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(artifact).toMatchObject({
    attempts: { attempted: 1, max: 10 },
    contenders: [{ name: "interrupt", status: "partial", value: { metrics: null, usageRecords: null } }],
    status: "stopped",
    stop: { contender: "interrupt", type: "unexpected" },
    version: 1,
  });
});

test("unbuilt stop artifacts and controlled output never expose compactor errors", async () => {
  const sentinel = "PRIVATE-UNBUILT-SENTINEL";
  const contender = parseContender("broken=openai-plan:fake");
  const control = makeBakeoffController(10);
  const replayed = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender,
      control,
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: () => Effect.succeed(() => Effect.fail(new CompactError({ message: sentinel }))),
    }),
  );
  const reason = replayed.stop;
  expect(reason).toEqual({ contender: "broken", node: "0.0", type: "unbuilt" });
  const artifact = bakeoffArtifact([contender], [{ name: contender.name, status: "partial", value: { metrics: null, usageRecords: null } }], control);
  expect(JSON.stringify(artifact)).not.toContain(sentinel);
  expect(reason === null ? "" : controlledStopText(reason)).not.toContain(sentinel);
  expect(reason === null ? "" : String(new BakeoffStopped({ reason }))).not.toContain(sentinel);
});

test("non-fail-fast diagnostics do not replace a later authoritative cap", async () => {
  const control = makeBakeoffController(1, false);
  await Effect.runPromise(control.stop({ bytes: 513, contender: "diagnostic", limit: 512, node: "0.0", type: "over-limit" }));
  expect(control.snapshot().stop).toBeNull();
  const hooks = control.hooks("diagnostic");
  await Effect.runPromise(hooks.beforeRequest(fakeAttempt));
  await Effect.runPromise(Effect.result(hooks.beforeRequest(fakeAttempt)));
  expect(control.isStopped()).toBe(true);
  expect(control.snapshot()).toEqual({
    attempts: 1,
    maxAttempts: 1,
    stop: { attempted: 1, contender: "diagnostic", max: 1, type: "max-attempts" },
  });
});

test("non-fail-fast runs later contenders, then promotes the first diagnostic and fails", async () => {
  const contenders = [parseContender("deadline=openai-plan:fake"), parseContender("later=openai-plan:fake")];
  const control = makeBakeoffController(10, false);
  const dir = mkdtempSync(`${tmpdir()}/bake-diagnostic-`);
  const path = `${dir}/result.json`;
  const started: string[] = [];
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const results = yield* runContenders({
        contenders,
        control,
        initial: () => ({ metrics: null, usageRecords: null }),
        persist: (current: readonly ArtifactContender[]) =>
          Effect.sync(() => {
            writeArtifact(path, bakeoffArtifact(contenders, current, control));
          }),
        run: (contender) =>
          Effect.gen(function* () {
            started.push(contender.name);
            if (contender.name === "deadline") {
              yield* control.stop({ contender: contender.name, duration: "1 ms", type: "deadline" });
              return { complete: false, value: { metrics: null, usageRecords: null } };
            }
            return { complete: true, value: { metrics: null, usageRecords: 0 } };
          }),
      });
      const stopped = control.snapshot().stop;
      if (stopped !== null) return yield* new BakeoffStopped({ reason: stopped });
      return results;
    }),
  );
  expect(started).toEqual(["deadline", "later"]);
  expect(exit._tag).toBe("Failure");
  const artifact: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(artifact).toMatchObject({
    completedContenders: ["later"],
    contenders: [{ name: "deadline", status: "partial" }, { name: "later", status: "complete" }],
    status: "stopped",
    stop: { contender: "deadline", duration: "1 ms", type: "deadline" },
  });
});

test("a parse error replaces a stale discovered output for both accepted out forms and fails", async () => {
  const output: string[] = [];
  const diagnostic = spyOn(console, "error").mockImplementation((...parts) => void output.push(parts.join(" ")));
  try {
    for (const form of ["separate", "equals"] as const) {
      const dir = mkdtempSync(`${tmpdir()}/bake-parse-`);
      const path = `${dir}/result.json`;
      writeFileSync(path, '{"stale":"PRIVATE-STALE-SENTINEL"}\n');
      const argv = form === "separate" ? ["--out", path, "--bogus"] : [`--out=${path}`, "--bogus"];
      const exit = await Effect.runPromiseExit(runBakeoffCli(argv));
      expect(exit._tag).toBe("Failure");
      const artifact: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(artifact).toMatchObject({
        attempts: { attempted: 0, max: 0 },
        requestedContenders: [],
        status: "stopped",
        stop: { contender: null, type: "unexpected" },
        version: 1,
      });
      expect(JSON.stringify(artifact)).not.toContain("PRIVATE-STALE-SENTINEL");
    }
    expect(output.join("\n")).not.toContain("bogus");
  } finally {
    diagnostic.mockRestore();
  }
});

test("setup rejection paths fail instead of returning successful console effects", async () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-setup-`);
  const source = `${dir}/source.txt`;
  const out = `${dir}/result.json`;
  writeFileSync(source, "");
  const base = ["--out", out, "--max-attempts", "2", "--from", source, "--chain", "one=openai-plan:fake"];
  const cases: readonly (readonly string[])[] = [
    [],
    ["--out", out],
    ["--out", out, "--max-attempts", "2"],
    ["--out", out, "--max-attempts", "2", "--from", `${dir}/missing`, "--chain", "one=openai-plan:fake"],
    [...base.slice(0, -1), "invalid"],
    [...base.slice(0, -1), "one=0:openai-plan:fake;0:claude-code:sonnet"],
    [...base.slice(0, -1), "one=0:openai-plan:fake;9007199254740992:claude-code:sonnet"],
    [...base, "--effort", "PRIVATE-INVALID-EFFORT"],
    [...base.slice(0, -1), "one=openai-plan:fake,openai-plan:fake"],
    [...base, "--chain", "one=claude-code:sonnet"],
    [...base, "--kinds", "user,user"],
    [...base, "--kinds", "PRIVATE-INVALID-KIND"],
    [...base, "--n", "0"],
    [...base, "--questions", "-1"],
  ];
  const output: string[] = [];
  const diagnostic = spyOn(console, "error").mockImplementation((...parts) => void output.push(parts.join(" ")));
  try {
    for (const argv of cases) {
      const exit = await Effect.runPromiseExit(runBakeoffCli(argv));
      expect(exit._tag).toBe("Failure");
    }
    expect(output.join("\n")).not.toContain("PRIVATE-INVALID");
  } finally {
    diagnostic.mockRestore();
  }
});

test("provider refusal reports stay out of artifacts and controlled diagnostics", async () => {
  const sentinel = "PRIVATE-PROVIDER-REFUSAL-SENTINEL";
  const contender = parseContender("refusal=openai-plan:fake");
  const control = makeBakeoffController(4);
  await Effect.runPromise(control.hooks(contender.name).beforeRequest(fakeAttempt));
  const replayed = await Effect.runPromise(
    replay({
      budget: 100_000,
      contender,
      control,
      messages: [{ kind: "user", text: "x".repeat(600) }],
      poll: "1 millis",
      summarizeFor: (_current, _log, report) =>
        Effect.succeed(() => report(sentinel).pipe(Effect.andThen(Effect.fail(new CompactError({ message: sentinel }))))),
    }),
  );
  const artifact = bakeoffArtifact(
    [contender],
    [{ name: contender.name, status: "partial", value: { metrics: null, usageRecords: null } }],
    control,
  );
  const controlled = `${diagnosticCountText(replayed.reports.length)}\n${controlledStopText(replayed.stop!)}`;
  expect(control.snapshot().attempts).toBe(1);
  expect(JSON.stringify(artifact)).not.toContain(sentinel);
  expect(controlled).not.toContain(sentinel);
});

test("an unfinished artifact without a stop is running, never complete", () => {
  const contender = parseContender("pending=openai-plan:fake");
  const artifact = bakeoffArtifact(
    [contender],
    [{ name: contender.name, status: "partial", value: { metrics: null, usageRecords: null } }],
    makeBakeoffController(2),
  );
  expect(artifact.status).toBe("running");
  expect(artifact.completedContenders).toEqual([]);
});

test("the preflight lower bound counts the complete requested tree", () => {
  expect(modelBuiltNodes(20)).toBe(38);
});
