// A chain entry's own effort (src/config.ts "engine:model@effort" or { ref, effort }), else its
// role's: decoded from both spellings, refused when bad, handed to each engine in its request or
// argv, and shown in the picker's label only when it differs from the master's.
import { expect, test } from "bun:test";
import { Effect, Queue, Result, Schema, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import type { ApiKeys } from "../src/apikey/clients.ts";
import { type Spawn, type Runner, makeClaude } from "../src/claude/process.ts";
import { openChat } from "../src/chat.ts";
import type { Job } from "../src/compactor.ts";
import { type Effort, entryLabel, loadSettings, parseRef, parseSettings, Settings } from "../src/config.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { type Gate, makeGate } from "../src/engines/inflight.ts";
import { type CompactorNeeds, compactorEngine, type TurnNeeds, turnEngine } from "../src/engines/registry.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { makeMaster } from "../src/master.ts";
import { makeCaptioner } from "../src/media/caption.ts";
import type { OpenAiPlan } from "../src/openai/responses.ts";
import { makeSession, noMedia } from "../src/session.ts";
import { newMsg } from "../src/store.ts";
import type { TurnEvents, TurnInput } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";
import { engineLabel } from "../src/wire.ts";

const price = { cacheRead: 0.01, cacheWrite5m: 0.125, input: 0.1, output: 0.5 };

type Chain = (typeof Settings.Encoded)["master"]["chain"];
type Options = { master?: Chain; byLevel?: Chain; masterEffort?: Effort; compactorEffort?: Effort; caption?: Chain };
// the config as written
const written = (o: Options = {}): typeof Settings.Encoded => ({
  allowedLogins: [],
  apiKey: { monthlyBudget: 5, prices: { "anthropic/claude-haiku-4-5": price, "anthropic/claude-haiku-5-5": price, "anthropic/claude-opus-4-5": price, "openai/gpt-6": price } },
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: o.byLevel ?? ["claude-code:sonnet"], from: 0 }], effort: o.compactorEffort ?? "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://x" } },
  master: { chain: o.master ?? ["claude-code:opus"], effort: o.masterEffort ?? "high", permissionMode: "bypassPermissions" },
  openai: DEFAULT_ENDPOINTS,
  media: o.caption === undefined ? undefined : { caption: o.caption },
});
const settings = (o: Options = {}) => parseSettings(written(o));

test("a chain entry decodes from \"ref@effort\" and from { ref, effort } alike; a plain ref is as it was", () => {
  const s = settings({ master: ["claude-code:opus", "claude-code:haiku@xhigh", { effort: "max", ref: "openai-plan:gpt-6.1-sol" }, "api-key:anthropic/claude-haiku-5-5@low", { effort: "xhigh", ref: "api-key:openai/gpt-6" }] });
  expect(s.master.chain).toEqual([
    { engine: "claude-code", model: "opus", ref: "claude-code:opus" },
    { effort: "xhigh", engine: "claude-code", model: "haiku", ref: "claude-code:haiku@xhigh" },
    { effort: "max", engine: "openai-plan", model: "gpt-6.1-sol", ref: "openai-plan:gpt-6.1-sol@max" },
    { effort: "low", engine: "api-key", model: "claude-haiku-5-5", provider: "anthropic", ref: "api-key:anthropic/claude-haiku-5-5@low" },
    { effort: "xhigh", engine: "api-key", model: "gpt-6", provider: "openai", ref: "api-key:openai/gpt-6@xhigh" },
  ]);
  // the compactor's chains take them too, and the two spellings are one engine
  const c = settings({ byLevel: ["claude-code:haiku@xhigh", "openai-plan:gpt-6-luna"] });
  const d = settings({ byLevel: [{ effort: "xhigh", ref: "claude-code:haiku" }, "openai-plan:gpt-6-luna"] });
  expect(d.compactor.byLevel).toEqual(c.compactor.byLevel);
});

test("an entry at its role's effort is the bare ref, so a chain names each engine once, in any spelling", () => {
  // "@high" in a master at high, { effort: "medium" } in a compactor at medium: the bare refs
  const s = settings({ byLevel: [{ effort: "medium", ref: "claude-code:sonnet" }, "claude-code:haiku@xhigh"], master: ["claude-code:opus@high", "claude-code:opus@xhigh"] });
  expect(s.master.chain).toEqual([
    { engine: "claude-code", model: "opus", ref: "claude-code:opus" },
    { effort: "xhigh", engine: "claude-code", model: "opus", ref: "claude-code:opus@xhigh" },
  ]);
  expect(s.compactor.byLevel[0].chain.map((r) => [r.ref, r.effort])).toEqual([["claude-code:sonnet", undefined], ["claude-code:haiku@xhigh", "xhigh"]]);
  // the media captions have no role's effort: an entry keeps its own
  expect(settings({ caption: ["claude-code:haiku@medium"] }).media?.caption?.map((r) => r.ref)).toEqual(["claude-code:haiku@medium"]);
  // the same engine twice in a chain is refused, with where and which
  const twice = "master.chain: claude-code:opus@xhigh is in the chain more than once";
  expect(() => settings({ master: ["claude-code:opus@xhigh", { effort: "xhigh", ref: "claude-code:opus" }] })).toThrow(twice);
  expect(() => settings({ master: ["claude-code:opus@xhigh", "claude-code:opus@xhigh"] })).toThrow(twice);
  expect(() => settings({ master: ["claude-code:opus", "claude-code:opus@high"] })).toThrow("master.chain: claude-code:opus is in the chain more than once");
  expect(() => settings({ byLevel: ["openai-plan:gpt-6-luna", { effort: "medium", ref: "openai-plan:gpt-6-luna" }] })).toThrow("compactor.byLevel[0].chain: openai-plan:gpt-6-luna is in the chain more than once");
  expect(() => settings({ caption: ["claude-code:haiku", "claude-code:haiku"] })).toThrow("media.caption: claude-code:haiku is in the chain more than once");
  // one engine in two chains, or one model at two efforts, is no duplicate
  expect(() => settings({ byLevel: ["claude-code:opus"], master: ["claude-code:opus", "claude-code:opus@max"] })).not.toThrow();
});

test("a model id with a date after an \"@\" (Vertex's) keeps it: the effort is what follows the last \"@\" that isn't a date", () => {
  const vertex = parseRef("claude-code:claude-sonnet-4-5@20250929");
  expect(Result.isSuccess(vertex) && vertex.success).toEqual({ engine: "claude-code", model: "claude-sonnet-4-5@20250929", ref: "claude-code:claude-sonnet-4-5@20250929" });
  const withEffort = parseRef("api-key:anthropic/claude-opus-5-5@20260101@xhigh");
  expect(Result.isSuccess(withEffort) && withEffort.success).toEqual({ effort: "xhigh", engine: "api-key", model: "claude-opus-5-5@20260101", provider: "anthropic", ref: "api-key:anthropic/claude-opus-5-5@20260101@xhigh" });
  const object = settings({ master: [{ effort: "xhigh", ref: "claude-code:claude-opus-5-5@20260101" }] });
  expect(object.master.chain[0]).toEqual({ effort: "xhigh", engine: "claude-code", model: "claude-opus-5-5@20260101", ref: "claude-code:claude-opus-5-5@20260101@xhigh" });
  // not a date: an effort, and a bad one
  expect(Result.isFailure(parseRef("claude-code:claude-sonnet-4-5@2025"))).toBe(true);
  // the picker reads them the same way
  expect(engineLabel("claude-code:claude-sonnet-4-5@20250929")).toBe("claude-sonnet-4-5@20250929 (Claude Code)");
  expect(engineLabel("claude-code:claude-opus-5-5@20260101@xhigh")).toBe("claude-opus-5-5@20260101 (Claude Code, xhigh)");
  // and the effort check sees the model behind the date: Sonnet 4.5 takes none
  expect(() => settings({ master: ["claude-code:claude-sonnet-4-5@20250929@low"] })).toThrow("claude-sonnet-4-5@20250929 takes no effort");
  // one effort at most: what is left of the model after the split has no "@" but a date's
  const twice = parseRef("claude-code:opus@high@xhigh");
  expect(Result.isFailure(twice) && twice.failure).toBe('engine claude-code:opus@high@xhigh: one "@effort" at most, after the model');
  expect(Result.isFailure(parseRef("claude-code:claude-sonnet-4-5@x@20250929"))).toBe(true);
});

test("a bad effort is a configuration error, in either spelling, and so is one given twice", () => {
  const decode = Schema.decodeUnknownSync(Settings);
  const base = written();
  for (const bad of ["claude-code:haiku@turbo", "claude-code:haiku@", "claude-code:haiku@XHIGH", { effort: "turbo", ref: "claude-code:haiku" }, { effort: "low", ref: "claude-code:haiku@high" }])
    expect(() => decode({ ...base, master: { ...base.master, chain: [bad] } })).toThrow();
  expect(() => settings({ byLevel: ["openai-plan:gpt-6-luna@fast"] })).toThrow();
  const turbo = parseRef("claude-code:haiku@turbo");
  expect(Result.isFailure(turbo) && turbo.failure).toBe("engine claude-code:haiku@turbo: effort turbo is not one of low, medium, high, xhigh, max");
  const empty = parseRef("claude-code:haiku@");
  expect(Result.isFailure(empty) && empty.failure).toBe("engine claude-code:haiku@: an empty effort is not one of low, medium, high, xhigh, max");
  expect(Result.isFailure(parseRef("api-key:anthropic/@high"))).toBe(true);
  expect(Result.isSuccess(parseRef("claude-code:haiku"))).toBe(true);
});

// the effort each engine was asked for: every fake refuses the call after noting it
const stop = new UsageLimit({ message: "stop here" });
const argvEffort = (args: readonly string[]) => (args.includes("--effort") ? args[args.indexOf("--effort") + 1] : undefined);
const rig = () => {
  const argv: (string | undefined)[] = [], anthropic: (string | undefined)[] = [], openai: (string | undefined)[] = [], viaPlan: (string | undefined)[] = [];
  const runner: Runner["Service"] = {
    spawn: (o: Spawn) =>
      Effect.gen(function* () {
        argv.push(argvEffort(o.args));
        const stdin = yield* Queue.unbounded<string>();
        const result = JSON.stringify({ is_error: true, result: "usage limit reached", subtype: "error", type: "result", usage: { input_tokens: 1, output_tokens: 1 } });
        return yield* makeClaude({ exit: Effect.succeed("ended"), lines: Stream.fromQueue(stdin).pipe(Stream.map(() => result)), stdin });
      }),
    warm: () => Effect.void,
  };
  const apiKeys: ApiKeys["Service"] = {
    anthropic: (ask) => Effect.sync(() => void anthropic.push(ask.effort)).pipe(Effect.andThen(Effect.fail(stop))),
    openai: (ask) => Effect.sync(() => void openai.push(ask.effort)).pipe(Effect.andThen(Effect.fail(stop))),
  };
  const plan: OpenAiPlan["Service"] = { respond: (ask) => Effect.sync(() => void viaPlan.push(ask.effort)).pipe(Effect.andThen(Effect.fail(stop))) };
  const needs = (s: Settings) => ({
    apiKeys: Effect.succeed(apiKeys),
    budget: makeBudget({ monthly: 5, report: () => Effect.void, usagePath: "/nonexistent/usage.jsonl" }),
    log: () => Effect.void,
    plan: Effect.succeed(plan),
    report: () => Effect.void,
    settings: s,
  });
  const compactor = (s: Settings): CompactorNeeds => ({
    ...needs(s),
    device: "mini",
    gate: makeGate(),
    instructions: "SYSTEM",
    placement: Effect.succeed({ cwd: undefined, mcpConfig: "{}", mcpSeen: () => Effect.succeed(false), runner }),
    tools: [],
  });
  const turn = (s: Settings): TurnNeeds => ({
    ...needs(s),
    instructions: "SYSTEM",
    runnerFor: () => Effect.succeed({ cwd: undefined, mcpConfig: "{}", mcpSeen: () => Effect.succeed(false), runner }),
    toolsFor: () => ({ defs: [], run: () => Effect.succeed("") }),
    warms: () => false,
  });
  return { compactor, efforts: { anthropic, argv, openai, plan: viaPlan }, runner, turn };
};

const job: Job = { ctx: ["user: a"], i: 1, l: 0, msg: newMsg(1, "user", "squeeze me") };
const input: TurnInput = { device: "mini", earlier: [], media: [], mid: { next: Effect.never, ready: Effect.succeed([]) }, texts: ["hi"], view: "<chat>\n</chat>" };
const out: TurnEvents = {
  info: () => Effect.void,
  log: () => Effect.void,
  text: () => Effect.void,
  thinking: () => Effect.void,
  took: () => Effect.void,
  usage: () => Effect.void,
};

test("an effort a Claude model can't take is refused at load when the entry asks for it, said as written", () => {
  expect(() => settings({ byLevel: ["api-key:anthropic/claude-haiku-4-5@xhigh"] })).toThrow("engine api-key:anthropic/claude-haiku-4-5@xhigh: claude-haiku-4-5 takes no effort");
  expect(() => settings({ master: ["claude-code:claude-haiku-4-5@high"] })).toThrow("engine claude-code:claude-haiku-4-5@high: claude-haiku-4-5 takes no effort"); // the master's own effort, written
  expect(() => settings({ byLevel: [{ effort: "low", ref: "claude-code:claude-haiku-4-5" }] })).toThrow("engine claude-code:claude-haiku-4-5@low: claude-haiku-4-5 takes no effort");
  expect(() => settings({ master: ["claude-code:claude-haiku-4-5-20251001@low"] })).toThrow("takes no effort"); // its dated snapshot too
  expect(() => settings({ master: ["claude-code:claude-opus-4-6@xhigh"] })).toThrow("claude-opus-4-6 has no xhigh effort (it takes low, medium, high, max)");
  expect(() => settings({ master: ["api-key:anthropic/claude-opus-4-5@max"] })).toThrow("claude-opus-4-5 has no max effort");
  // Opus 4.0 and Sonnet 4.0 by their dated ids, a 1M-context variant, any case, Bedrock ids and profiles
  expect(() => settings({ master: ["claude-code:claude-opus-4-20250514@high"] })).toThrow("claude-opus-4-20250514 takes no effort");
  expect(() => settings({ master: ["api-key:anthropic/claude-sonnet-4-20250514@low"] })).toThrow("claude-sonnet-4-20250514 takes no effort");
  expect(() => settings({ master: ["claude-code:claude-sonnet-4-5[1m]@low"] })).toThrow("claude-sonnet-4-5[1m] takes no effort");
  expect(() => settings({ master: ["claude-code:claude-opus-4-6[1m]@xhigh"] })).toThrow("claude-opus-4-6[1m] has no xhigh effort");
  expect(() => settings({ master: ["claude-code:Claude-Haiku-4-5@low"] })).toThrow("Claude-Haiku-4-5 takes no effort");
  expect(() => settings({ master: ["claude-code:us.anthropic.claude-haiku-4-5-20251001-v1:0@low"] })).toThrow("takes no effort");
  expect(() => settings({ master: ["claude-code:anthropic.claude-opus-4-6-v1:0@xhigh"] })).toThrow("has no xhigh effort");
  expect(() => settings({ master: ["claude-code:opus[1m]@xhigh"] })).not.toThrow();
  // the media captions take an entry's own the same way
  expect(() => settings({ caption: ["claude-code:claude-haiku-4-5@low"] })).toThrow("takes no effort");
  // without an effort of their own, they run: a role's effort their model lacks is not asked of it (`runEffort`)
  expect(() => settings({ byLevel: ["claude-code:claude-haiku-4-5", "api-key:anthropic/claude-haiku-4-5"], master: ["claude-code:claude-sonnet-4-5", "claude-code:claude-opus-4-1"] })).not.toThrow();
  // what takes them: the aliases, Haiku 5.5, Opus 5.5, and another provider's models
  expect(() => settings({ master: ["claude-code:opus@max", "claude-code:haiku@xhigh", "api-key:anthropic/claude-haiku-5-5@xhigh", "api-key:anthropic/claude-opus-5-5@xhigh", "openai-plan:gpt-6.1-sol@max"] })).not.toThrow();
  expect(() => settings({ byLevel: ["claude-code:haiku@xhigh"], compactorEffort: "xhigh" })).not.toThrow();
});

test("an entry with no effort of its own runs at its role's as its model takes it: the highest it takes up to that, else none", async () => {
  const r = rig();
  const s = settings({
    byLevel: ["claude-code:claude-haiku-4-5", "api-key:anthropic/claude-haiku-4-5", "openai-plan:gpt-6-luna"],
    compactorEffort: "xhigh",
    master: ["claude-code:claude-haiku-4-5", "claude-code:claude-opus-4-5", "claude-code:claude-opus-4-6", "api-key:anthropic/claude-opus-4-5", "claude-code:opus"],
    masterEffort: "max",
  });
  for (const ref of s.master.chain) {
    const engine = await Effect.runPromise(Effect.scoped(turnEngine(ref, r.turn(s))));
    await Effect.runPromiseExit(Effect.scoped(engine.run(input, out, null)));
  }
  for (const ref of s.compactor.byLevel[0].chain) {
    const compact = await Effect.runPromise(compactorEngine(ref, r.compactor(s)));
    await Effect.runPromiseExit(Effect.scoped(compact(job, null)));
  }
  // Haiku 4.5 gets no --effort and no output_config.effort; Opus 4.5 stops at high, 4.6 skips xhigh for max; others as asked
  expect(r.efforts.argv).toEqual([undefined, "high", "max", "max", undefined]);
  expect(r.efforts.anthropic).toEqual(["high", undefined]);
  expect(r.efforts.plan).toEqual(["xhigh"]);
  // and the picker says what runs
  expect(s.master.chain.map((ref) => entryLabel(ref, s.master.effort))).toEqual([
    "Claude Haiku 4.5 (Claude Code, no effort)",
    "Claude Opus 4.5 (Claude Code, high)",
    "Claude Opus 4.6 (Claude Code)",
    "Claude Opus 4.5 (Anthropic API key, high)",
    "Claude Opus (Claude Code)",
  ]);
});

test("each compactor engine gets its entry's effort, else the compactor's", async () => {
  const chain: Chain = ["claude-code:haiku@xhigh", "claude-code:sonnet", "openai-plan:gpt-6-luna@low", "openai-plan:gpt-6.1-sol", "api-key:anthropic/claude-haiku-5-5@max", "api-key:anthropic/claude-haiku-5-5", "api-key:openai/gpt-6@high"];
  const r = rig();
  const s = settings({ byLevel: chain });
  for (const ref of s.compactor.byLevel[0].chain) {
    const compact = await Effect.runPromise(compactorEngine(ref, r.compactor(s)));
    await Effect.runPromiseExit(Effect.scoped(compact(job, null)));
  }
  // claude-code retries nothing here: a spawn each; the others record their one request
  expect(r.efforts.argv).toEqual(["xhigh", "medium"]);
  expect(r.efforts.plan).toEqual(["low", "medium"]);
  expect(r.efforts.anthropic).toEqual(["max", "medium"]);
  expect(r.efforts.openai).toEqual(["high"]);
});

test("each turn engine gets its entry's effort, else the master's", async () => {
  const chain: Chain = ["claude-code:opus@xhigh", "claude-code:opus", "openai-plan:gpt-6.1-sol@low", "openai-plan:gpt-6.1-sol", "api-key:anthropic/claude-haiku-5-5@max", "api-key:anthropic/claude-haiku-5-5", "api-key:openai/gpt-6@medium"];
  const r = rig();
  const s = settings({ master: chain });
  for (const ref of s.master.chain) {
    const engine = await Effect.runPromise(Effect.scoped(turnEngine(ref, r.turn(s))));
    await Effect.runPromiseExit(Effect.scoped(engine.run(input, out, null)));
  }
  expect(r.efforts.argv).toEqual(["xhigh", "high"]);
  expect(r.efforts.plan).toEqual(["low", "high"]);
  expect(r.efforts.anthropic).toEqual(["max", "high"]);
  expect(r.efforts.openai).toEqual(["medium"]);
});

test("a caption gets its entry's own effort: claude's --effort, a provider's ask, and the record says it", async () => {
  const r = rig();
  const s = settings({ caption: ["claude-code:haiku@low", "openai-plan:gpt-6-luna@high", "api-key:anthropic/claude-haiku-5-5@max", "api-key:openai/gpt-6"] });
  const usage: UsageRecord[] = [];
  const caption = makeCaptioner(s.media?.caption ?? [], {
    ...r.compactor(s),
    device: "mini",
    log: (record) => Effect.sync(() => void usage.push(record)),
    planImages: true,
    runner: r.runner,
  });
  await Effect.runPromiseExit(caption({ heard: null, picture: { data: "", mime: "image/png", type: "image" } }));
  expect(r.efforts.argv).toEqual(["low"]);
  expect(r.efforts.plan).toEqual(["high"]);
  expect(r.efforts.anthropic).toEqual(["max"]);
  expect(r.efforts.openai).toEqual([undefined]); // the captions have no role's effort
  expect(usage.map((u) => [u.engine, u.effort])).toEqual([["claude-code", "low"]]); // the one fake that says what it cost
});

test("the in-flight wait keys on the effort: one marked prefix at two efforts never waits, at one it does", async () => {
  const ctx = Array.from({ length: 8 }, (_, k) => `${k}+1|user: line ${k}`); // two whole blocks: the second carries the mark
  const marked: Job = { ctx, i: 8, l: 0, msg: newMsg(8, "user", "squeeze me") };
  const keys: (string | null)[] = [];
  const gate: Gate = { through: (key, call) => Effect.sync(() => void keys.push(key)).pipe(Effect.andThen(call(Effect.void))) };
  const r = rig();
  const keyAt = async (entry: string, effort: Effort) => {
    const s = settings({ byLevel: [entry], compactorEffort: effort });
    const [ref] = s.compactor.byLevel[0].chain;
    const compact = await Effect.runPromise(compactorEngine(ref, { ...r.compactor(s), gate }));
    await Effect.runPromiseExit(Effect.scoped(compact(marked, null)));
    return keys.at(-1);
  };
  for (const entry of ["claude-code:sonnet", "openai-plan:gpt-6-luna", "api-key:anthropic/claude-haiku-5-5"]) {
    const low = await keyAt(entry, "low"), high = await keyAt(entry, "high"), again = await keyAt(entry, "high");
    expect([low === null || low === undefined, low === high, again === high]).toEqual([false, false, true]);
  }
});

test("through the session, a message for an entry with its own effort runs on that entry, and its limit marks that entry down, not the bare ref", async () => {
  const r = rig();
  const s = settings({ master: ["claude-code:opus", "claude-code:opus@xhigh"] });
  const dir = mkdtempSync(`${tmpdir()}/oe-`);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const master = yield* makeMaster(s.master.chain.map((ref) => ({ label: entryLabel(ref, s.master.effort), ref: ref.ref })), s.master.effort);
          const built = yield* Effect.forEach(s.master.chain, (ref) => turnEngine(ref, r.turn(s)));
          // no priming: only turns spawn claude
          const engines = built.map((e) => ({ ref: e.ref, run: e.run, vision: e.vision, warm: e.warm }));
          const chat = yield* openChat(dir, { summarize: () => Effect.succeed("") });
          const usage: UsageRecord[] = [];
          const logUsage = (record: UsageRecord) => Effect.sync(() => void usage.push(record));
          const session = yield* makeSession({ chat, commit: Effect.succeed(null), defaultDevice: "mini", devices: ["mini"], engines, idle: "1 hour", logUsage, master, media: noMedia });
          yield* session.input("hi", { engine: "claude-code:opus@xhigh" });
          for (let k = 0; k < 500 && session.state().phase !== "needs-model"; k++) yield* Effect.sleep("10 millis");
          expect(r.efforts.argv).toEqual(["xhigh"]);
          // usage.jsonl tells it from the bare ref by the effort it asked for
          expect(usage.map((u) => [u.role, u.effort])).toEqual([["turn", "xhigh"]]);
          expect(session.state().stopped).toMatchObject({ label: "Claude Opus (Claude Code, xhigh)", ref: "claude-code:opus@xhigh" });
          expect(session.state().engines.map((e) => [e.ref, e.down !== null])).toEqual([
            ["claude-code:opus", false],
            ["claude-code:opus@xhigh", true],
          ]);
        }),
      ),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a message for a ref spelled with the master's own effort finds the bare entry: a pick kept from before the effort changed still runs", async () => {
  const r = rig();
  // the master was at high with "claude-code:opus@xhigh" in its chain; now it runs at xhigh
  const s = settings({ master: ["claude-code:opus", "claude-code:sonnet"], masterEffort: "xhigh" });
  const dir = mkdtempSync(`${tmpdir()}/oe-`);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const master = yield* makeMaster(s.master.chain.map((ref) => ({ label: entryLabel(ref, s.master.effort), ref: ref.ref })), s.master.effort);
          const engines = yield* Effect.forEach(s.master.chain, (ref) => turnEngine(ref, r.turn(s)).pipe(Effect.map((e) => ({ ref: e.ref, run: e.run, vision: e.vision, warm: e.warm }))));
          const chat = yield* openChat(dir, { summarize: () => Effect.succeed("") });
          const session = yield* makeSession({ chat, commit: Effect.succeed(null), defaultDevice: "mini", devices: ["mini"], engines, idle: "1 hour", logUsage: () => Effect.void, master, media: noMedia });
          expect(session.state().effort).toBe("xhigh");
          yield* session.input("hi", { engine: "claude-code:opus@xhigh" });
          expect(session.state().pending.map((p) => p.engine)).toEqual(["claude-code:opus"]);
          for (let k = 0; k < 500 && session.state().phase !== "needs-model"; k++) yield* Effect.sleep("10 millis");
          expect(session.state().stopped?.ref).toBe("claude-code:opus");
          expect(r.efforts.argv).toEqual(["xhigh"]);
          // a resume spelled the same way finds it too
          yield* session.resume("claude-code:sonnet@xhigh");
          for (let k = 0; k < 500 && r.efforts.argv.length < 2; k++) yield* Effect.sleep("10 millis");
          expect(r.efforts.argv).toEqual(["xhigh", "xhigh"]);
        }),
      ),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the picker's label shows the effort a ref names, and what runs when a bare ref doesn't run at its role's", async () => {
  expect(engineLabel("claude-code:haiku@xhigh")).toBe("Claude Haiku (Claude Code, xhigh)");
  expect(engineLabel("claude-code:opus")).toBe("Claude Opus (Claude Code)");
  expect(engineLabel("claude-code:claude-opus-4-5", "high")).toBe("Claude Opus 4.5 (Claude Code, high)");
  expect(engineLabel("claude-code:claude-haiku-4-5", null)).toBe("Claude Haiku 4.5 (Claude Code, no effort)");
  expect(engineLabel("openai-plan:gpt-6.1-sol@max")).toBe("GPT-6.1 Sol (ChatGPT plan, max)");
  expect(engineLabel("api-key:anthropic/claude-haiku-5-5@low")).toBe("Claude Haiku 5.5 (Anthropic API key, low)");
  const s = settings({ master: ["claude-code:opus", "claude-code:haiku@xhigh", "claude-code:sonnet@high"] });
  const master = await Effect.runPromise(Effect.scoped(makeMaster(s.master.chain.map((ref) => ({ label: entryLabel(ref, s.master.effort), ref: ref.ref })), s.master.effort)));
  expect(master.engines().map((e) => [e.ref, e.label])).toEqual([
    ["claude-code:opus", "Claude Opus (Claude Code)"],
    ["claude-code:haiku@xhigh", "Claude Haiku (Claude Code, xhigh)"],
    ["claude-code:sonnet", "Claude Sonnet (Claude Code)"],
  ]);
});

test("the shipped optchat.config.ts runs on subscriptions only: Haiku at xhigh behind the ChatGPT plan, no API key", async () => {
  const s = await Effect.runPromise(loadSettings(new URL("../optchat.config.ts", import.meta.url).pathname));
  const refs = [...s.master.chain, ...s.compactor.byLevel.flatMap((b) => b.chain)];
  expect(refs.map((r) => r.engine).filter((e) => e === "api-key")).toEqual([]);
  expect(s.apiKey).toBeUndefined();
  expect(s.compactor.byLevel.map((b) => b.chain.map((r) => r.ref))).toEqual([
    ["openai-plan:gpt-6-luna", "claude-code:haiku@xhigh"],
    ["openai-plan:gpt-6.1-sol", "claude-code:haiku@xhigh"],
  ]);
});
