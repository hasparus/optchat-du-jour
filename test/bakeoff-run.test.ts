import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeBudget } from "../src/apikey/budget.ts";
import { Runner } from "../src/claude/process.ts";
import { parseSettings } from "../src/config.ts";
import { EngineExecutionPolicy, admitRequest } from "../src/engines/request-admission.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { makeResponses } from "../src/openai/responses.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { type BakeoffArtifact, type RunOutcome, decodeArtifact, encodeArtifact } from "../dev/bakeoff-artifact.ts";
import { lexicalAnswerer, measure } from "../dev/bakeoff-metrics.ts";
import { parseContender } from "../dev/bakeoff-options.ts";
import { replay } from "../dev/bakeoff-replay.ts";
import { makeRunControl, runContenders, type ContenderControl } from "../dev/bakeoff-run.ts";
import { fakeOpenAi, type Answer } from "./fake-openai.ts";
import { run, scripted, tmp, withFakeClaude } from "./fake-claude-rig.ts";

withFakeClaude();
const fake = fakeOpenAi();
afterAll(async () => fake.server.stop(true));
const messages = [{ kind: "user" as const, text: "PRIVATE-CORPUS ".repeat(60) }];
const reason = { coord: { i: 0, l: 0 }, type: "unbuilt" as const };

const composed = (o: { readonly failFast: boolean; readonly max: number; readonly script: Answer[]; readonly afterUsage?: Effect.Effect<void>; readonly finalize?: Effect.Effect<void>; readonly messageCount?: number; readonly refuseBreakpoints?: boolean; readonly transportReport?: (message: string) => Effect.Effect<void>; readonly onLocal?: (local: ContenderControl) => void }) => {
  fake.state.access = "fake";
  fake.state.requests = 0;
  fake.state.refuseBreakpoints = o.refuseBreakpoints ?? false;
  fake.state.seen.length = 0;
  fake.state.script = o.script;
  const f = scripted({ compact: [[[{ text: "user: fallback must not run" }]]] });
  const control = makeRunControl(o.max, o.failFast);
  const snapshots: BakeoffArtifact[] = [];
  const contenders = [parseContender("first=openai-plan:fake,claude-code:sonnet"), parseContender("second=openai-plan:fake")];
  const all = Array.from({ length: o.messageCount ?? 1 }, () => messages[0]!);
  const execute = Effect.gen(function* () {
    const runner = yield* Runner;
    const respond = yield* makeResponses({ api: `http://127.0.0.1:${fake.server.port}/v1`, bearer: { current: Effect.succeed("fake"), renew: () => Effect.succeed("fake") }, label: "offline", report: o.transportReport });
    const budget = makeBudget({ monthly: 0, report: () => Effect.void, usagePath: `${tmp()}/usage.jsonl` });
    const outcome = yield* runContenders({
      contenders,
      control,
      persist: (current) => Effect.sync(() => {
        const value = { outcome: current, requestedNames: contenders.map((c) => c.name), requests: { authorized: control.snapshot().authorizedRequests, max: o.max }, version: 2 } as const;
        snapshots.push(decodeArtifact(JSON.parse(encodeArtifact(value))));
      }),
      run: (contender, local) => Effect.gen(function* () {
        o.onLocal?.(local);
        const replayed = yield* replay({
          budget: 100_000,
          contender,
          control: local,
          deadline: "2 seconds",
          messages: all,
          poll: "1 millis",
          summarizeFor: (choice, log, report) => makeSummarize({
            apiKeys: Effect.die("api-key must not be loaded"),
            budget,
            gate: makeGate(),
            instructions: "offline",
            log: (record) => budget.note(record).pipe(Effect.andThen(log(record)), Effect.andThen(o.afterUsage ?? Effect.void)),
            placement: Effect.succeed({ cwd: undefined, mcpConfig: '{"mcpServers":{}}', mcpSeen: () => Effect.succeed(false), runner }),
            plan: Effect.succeed({ respond }),
            report,
            settings: { ...parseSettings({
              allowedLogins: [], cache: { claudeCodeTtl: "1h", primeTtl: "1h" }, compactor: { byLevel: [{ chain: ["openai-plan:fake"], from: 0 }], effort: "medium" },
              defaultDevice: "offline", devices: { offline: { folders: [], url: "http://127.0.0.1:9" } },
              master: { chain: ["openai-plan:fake"], effort: "medium", permissionMode: "bypassPermissions" }, openai: DEFAULT_ENDPOINTS,
            }), compactor: { byLevel: choice.byLevel, effort: "medium" } },
            tools: [],
          }).pipe(Effect.tap(() => Effect.addFinalizer(() => o.finalize ?? Effect.void)), Effect.map((made) => made.summarize)),
        });
        if (replayed.type === "failed") return replayed.failure.type === "global"
          ? { abort: replayed.failure.abort, progress: replayed.progress, type: "global-abort" as const }
          : { name: contender.name, progress: replayed.progress, reason: replayed.failure.reason, type: "failed" as const };
        return { metrics: yield* measure(replayed, all, { answerer: lexicalAnswerer, questions: 0 }), name: contender.name, type: "complete" as const, usageRecords: replayed.records.length };
      }),
    });
    return outcome;
  }).pipe(Effect.provide(FetchHttpClient.layer));
  return { control, f, snapshots, execute: async () => run(f, execute) };
};

const sequence = (snapshots: readonly BakeoffArtifact[]) => snapshots.map(({ outcome }) => [outcome.type, outcome.contenders.map((c) => c.name), "active" in outcome ? outcome.active : undefined]);

test("production policy defaults to allow-and-continue", async () => {
  expect(await Effect.runPromise(admitRequest().pipe(Effect.as(true)))).toBe(true);
});

test("concurrent authorization permits exactly N; local closure rejects without consuming; global dominates", async () => {
  const control = makeRunControl(7, false);
  const local = control.begin("first");
  let boundary = 0;
  const exits = await Effect.runPromise(Effect.all(Array.from({ length: 32 }, () => local.policy.authorize().pipe(
    Effect.andThen(Effect.sync(() => void boundary++)), Effect.exit,
  )), { concurrency: "unbounded" }));
  expect(boundary).toBe(7);
  expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(7);
  expect(control.globalAbort()).toEqual({ type: "max-authorized-requests" });
  const globalDenial = await Effect.runPromise(Effect.flip(local.policy.authorize()));
  expect(globalDenial.reason).toBe("global-abort");
  const fresh = makeRunControl(2, false);
  const closed = fresh.begin("closed");
  await Effect.runPromise(closed.fail(reason));
  const closedDenial = await Effect.runPromise(Effect.flip(closed.policy.authorize()));
  expect(closedDenial.reason).toBe("closed");
  expect(fresh.snapshot().authorizedRequests).toBe(0);
  expect(fresh.globalAbort()).toBeUndefined();
});

test("spent UsageLimit logging finishes before terminal; typed stop blocks Claude fallback; next contender uses remaining cap", async () => {
  const entered = Deferred.makeUnsafe<null>();
  const released = Deferred.makeUnsafe<null>();
  const done: string[] = [];
  const rig = composed({
    afterUsage: Deferred.succeed(entered, null).pipe(Effect.andThen(Deferred.await(released)), Effect.andThen(Effect.sync(() => void done.push("logged-and-budgeted")))),
    failFast: false, max: 2, script: [{ failed: "subscription_sharing_usage_limit_exceeded" }, { text: "user: short" }],
  });
  const result = rig.execute();
  await Effect.runPromise(Deferred.await(entered));
  expect(rig.snapshots.map((s) => s.outcome.type)).toEqual(["running", "running"]);
  await Effect.runPromise(Deferred.succeed(released, null));
  const outcome = await result;
  expect(outcome.type).toBe("completed-with-failures");
  expect(outcome.contenders[0]?.type).toBe("failed");
  expect(outcome.contenders[1]?.type).toBe("complete");
  expect(rig.f.of("compact")).toEqual([]);
  expect(done).toEqual(["logged-and-budgeted", "logged-and-budgeted"]);
  expect(rig.control.snapshot().authorizedRequests).toBe(2);
  expect(sequence(rig.snapshots)).toEqual([
    ["running", [], { type: "none" }], ["running", [], { name: "first", type: "active" }],
    ["running", ["first"], { type: "none" }], ["running", ["first"], { name: "second", type: "active" }],
    ["running", ["first", "second"], { type: "none" }], ["completed-with-failures", ["first", "second"], undefined],
  ]);
});

test("fail-fast race persists its failed contender before schema encoding and gates later engines", async () => {
  for (let i = 0; i < 8; i++) {
    const rig = composed({ failFast: true, max: 4, script: [{ failed: "subscription_sharing_usage_limit_exceeded" }] });
    const outcome = await rig.execute();
    expect(outcome.type).toBe("aborted");
    if (outcome.type === "aborted") {
      expect(outcome.abort).toEqual({ contender: "first", type: "fail-fast" });
      expect(outcome.active).toEqual({ type: "none" });
    }
    expect(outcome.contenders).toHaveLength(1);
    expect(outcome.contenders[0]?.type).toBe("failed");
    expect(fake.state.requests).toBe(1);
    expect(rig.f.of("compact")).toEqual([]);
    expect(rig.snapshots.map((s) => s.outcome.type)).toEqual(["running", "running", "running", "aborted"]);
  }
});

test("cap dominates; composed replay returns actual nonzero progress to decoded terminal artifact", async () => {
  const rig = composed({ failFast: false, max: 1, messageCount: 2, script: [{ text: "user: short" }] });
  const outcome = await rig.execute();
  expect(fake.state.requests).toBe(1);
  expect(outcome.type).toBe("aborted");
  if (outcome.type === "aborted") {
    expect(outcome.abort).toEqual({ type: "max-authorized-requests" });
    expect(outcome.active.type).toBe("interrupted");
    if (outcome.active.type === "interrupted") {
      expect(outcome.active.progress.loggedMessages).toBe(2);
      expect(outcome.active.progress.usageRecords).toBe(1);
      expect(outcome.active.progress.unbuiltNodeCount).toBeGreaterThan(0);
    }
  }
  expect(rig.snapshots.at(-1)?.outcome).toEqual(outcome);
  expect(rig.f.of("compact")).toEqual([]);
});

test("policy resolves in execution context, concurrent local closure prevents cached engine authorization", async () => {
  const rig = composed({ failFast: false, max: 3, script: [] });
  const control = rig.control.begin("first");
  const gate = Deferred.makeUnsafe<null>();
  let dispatched = 0;
  const work = Deferred.await(gate).pipe(Effect.andThen(admitRequest()), Effect.andThen(Effect.sync(() => void dispatched++)));
  const fiber = Effect.runFork(work.pipe(Effect.provideService(EngineExecutionPolicy, control.policy)));
  await Effect.runPromise(control.policy.onFailure({ coord: { i: 0, l: 0 }, error: new UsageLimit({ message: "PRIVATE" }), ref: "openai-plan:fake" }));
  await Effect.runPromise(Deferred.succeed(gate, null));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(exit._tag).toBe("Failure");
  expect(dispatched).toBe(0);
  expect(rig.control.snapshot().authorizedRequests).toBe(0);
});

test("composed concurrent local closure cancels a pending HTTP fallback without spending another authorization", async () => {
  const entered = Deferred.makeUnsafe<null>();
  const release = Deferred.makeUnsafe<null>();
  const locals: ContenderControl[] = [];
  const rig = composed({
    failFast: false, max: 10, messageCount: 4, refuseBreakpoints: true,
    script: [{ text: "user: short" }, { text: "user: short" }],
    onLocal: (local) => { locals.push(local); },
    transportReport: () => Deferred.succeed(entered, null).pipe(Effect.andThen(Deferred.await(release))),
  });
  const pending = rig.execute();
  await Effect.runPromise(Deferred.await(entered));
  const local = locals[0]!;
  const before = rig.control.snapshot().authorizedRequests;
  expect(before).toBe(4);
  expect(await Effect.runPromise(local.policy.onFailure({ coord: { i: 2, l: 0 }, error: new UsageLimit({ message: "PRIVATE" }), ref: "openai-plan:fake" }))).toBe("stop");
  const denial = await Effect.runPromise(Effect.flip(local.policy.authorize()));
  expect(denial.reason).toBe("closed");
  expect(rig.control.snapshot().authorizedRequests).toBe(before);
  await Effect.runPromise(Deferred.succeed(release, null));
  const outcome = await pending;
  expect(outcome.type).toBe("completed-with-failures");
  expect(fake.state.requests).toBe(8);
  expect(rig.control.snapshot().authorizedRequests).toBe(8);
  expect(rig.f.of("compact")).toEqual([]);
});

test("composed logging defects and replay finalizer defects persist unexpected/unavailable, never success", async () => {
  for (const defect of ["logging", "finalizer"]) {
    const rig = composed({
      failFast: true, max: 4, script: [{ text: "user: short" }],
      afterUsage: defect === "logging" ? Effect.die("PRIVATE-LOG-DEFECT") : Effect.void,
      finalize: defect === "finalizer" ? Effect.die("PRIVATE-FINALIZER-DEFECT") : Effect.void,
    });
    const exit = await rig.execute().then(() => "unexpected success", () => "failure");
    expect(exit).toBe("failure");
    const terminal = rig.snapshots.at(-1)?.outcome;
    expect(terminal?.type).toBe("aborted");
    if (terminal?.type === "aborted") {
      expect(terminal.abort.type).toBe("unexpected");
      expect(terminal.active).toEqual({ name: "first", type: "unavailable" });
    }
    expect(rig.snapshots.some((value) => value.outcome.type === "complete")).toBe(false);
    expect(JSON.stringify(rig.snapshots)).not.toContain("PRIVATE");
  }
});

test("unexpected defect and persistence failure retry aborted with explicitly unavailable progress", async () => {
  const snapshots: RunOutcome[] = [];
  const control = makeRunControl(2, true);
  const exit = await Effect.runPromise(Effect.exit(runContenders({
    contenders: [{ name: "broken" }], control,
    persist: (outcome) => Effect.sync(() => { snapshots.push(outcome); }),
    run: () => Effect.die("PRIVATE-STACK"),
  })));
  expect(exit._tag).toBe("Failure");
  expect(snapshots.at(-1)).toEqual({ abort: { contender: "broken", type: "unexpected" }, active: { name: "broken", type: "unavailable" }, contenders: [], type: "aborted" });
  let attempts = 0;
  await Effect.runPromise(Effect.exit(runContenders({ contenders: [], control: makeRunControl(1), run: () => Effect.die("unreachable"), persist: () => Effect.sync(() => { attempts++; }).pipe(Effect.andThen(Effect.die("PRIVATE"))) })));
  expect(attempts).toBe(2);
});
