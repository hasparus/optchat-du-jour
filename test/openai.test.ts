// The openai-plan engine against fake OAuth and Responses servers (test/fake-openai.ts): no network
// beyond 127.0.0.1, no model calls.
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Queue, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { type Settings, NODE, TRIES, parseSettings } from "../src/config.ts";
import { makeBudget } from "../src/apikey/budget.ts";
import { type Spawn, Runner, makeClaude } from "../src/claude/process.ts";
import type { Job } from "../src/compactor.ts";
import { failover, watchChain } from "../src/engines/chain.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { Credentials, SECRET, encodeCredentials, login } from "../src/openai/auth.ts";
import { type Endpoints, DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { OpenAiPlan, openAiPlanLayer, readStream } from "../src/openai/responses.ts";
import { responsesProvider } from "../src/providers/responses.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { SECURITY_LINE_MAX, Secrets, SecretsError, keychainLine, memorySecrets } from "../src/secrets.ts";
import { makeSession, noMedia } from "../src/session.ts";
import { newMsg } from "../src/store.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { blocks } from "../src/summarize/claude-code.ts";
import { openAiPlanCompactor } from "../src/summarize/openai-plan.ts";
import type { Mid, TurnEvents, TurnInput } from "../src/turn/engine.ts";
import { toolLoop } from "../src/turn/loop.ts";
import { bytes } from "../src/tree.ts";
import type { UsageRecord } from "../src/usage.ts";
import { fakeOpenAi } from "./fake-openai.ts";

const fake = fakeOpenAi();
afterAll(async () => {
  await fake.server.stop(true);
});

const freePort = () => {
  const s = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
  const port = s.port ?? 0;
  void s.stop(true);
  return port;
};
const endpoints = (): Endpoints => ({ agentName: "optchat-test", api: `${fake.base}/v1`, issuer: fake.base, port: freePort(), registerClientId: "dynamic_agent_client" });

// the browser: follows the authorize page's redirect to our callback
const browser = (url: string) => Effect.promise(async () => void (await fetch(url)));

const signedIn = async (secrets: Layer.Layer<Secrets>) => {
  const e = endpoints();
  await Effect.runPromise(login({ endpoints: e, open: browser }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  return e;
};
const plan = (e: Endpoints, secrets: Layer.Layer<Secrets>) => openAiPlanLayer(e).pipe(Layer.provide([secrets, FetchHttpClient.layer]));

// what a turn sends before its view, which compactions send too (docs/optchat.md §4, §5)
const READ = { description: "Read a file", name: "Read", parameters: { properties: { file_path: { type: "string" } }, type: "object" } };
const compactorBase = { gate: makeGate(), instructions: "SYSTEM", tools: [READ] };
const leaf = (text: string): Job => ({ ctx: ["user: we are moving the blog to Bun", "talk: ok, starting with the build"], i: 2, l: 0, msg: newMsg(2, "user", text) });
const line = (n: number) => `user: ${"x".repeat(n - 6)}`;
// what reached the API, read back with the same shape the client wrote
const Body = Schema.Struct({
  instructions: Schema.String,
  store: Schema.Boolean,
  stream: Schema.Boolean,
  model: Schema.String,
  reasoning: Schema.optional(Schema.Struct({ context: Schema.String, effort: Schema.String })),
  input: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.String }))]) })),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));
const bodies = () => fake.state.seen.map((s) => decodeBody(s.body));
const decodeCredentials = Schema.decodeUnknownSync(Schema.fromJsonString(Credentials));

const stored = async (secrets: Layer.Layer<Secrets>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Secrets;
      return Option.getOrThrow(yield* store.get(SECRET));
    }).pipe(Effect.provide(secrets)),
  );

test("login: PKCE with the fake issuer, the issued client id saved, never dynamic_agent_client; no token kept but the refresh token", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const p = fake.state.authorizeParams!;
  expect(p.get("client_id")).toBe("dynamic_agent_client");
  expect(p.get("code_challenge_method")).toBe("S256");
  expect(p.get("redirect_uri")).toBe(`http://127.0.0.1:${e.port}/auth/callback`);
  expect(p.get("scope")).toContain("chatgpt.tokens.use.direct");
  expect(p.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  const raw = await stored(secrets);
  const c = decodeCredentials(raw);
  expect(c).toEqual({ clientId: fake.issued, email: "me@example.com", hostId: c.hostId, refreshToken: fake.state.refresh, subject: "user-1" });
  expect(raw).not.toContain(fake.state.access);

  // signing in again reuses the issued client and this machine's host id, and sends no ID token
  await Effect.runPromise(login({ endpoints: { ...e, port: freePort() }, open: browser }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  expect(fake.state.authorizeParams!.get("client_id")).toBe(fake.issued);
  expect(fake.state.authorizeParams!.get("ext_agent_host_id")).toBe(c.hostId);
  expect(fake.state.authorizeParams!.has("id_token_hint")).toBe(false);
});

test("what the Keychain gets stays well under security -i's 4096-byte line, with 2 KB JWTs from the issuer", async () => {
  const secrets = memorySecrets();
  await signedIn(secrets);
  expect(fake.state.access.length).toBeGreaterThan(2000);
  const line = await Effect.runPromise(keychainLine(SECRET, await stored(secrets)));
  expect(Buffer.byteLength(line)).toBeLessThan(SECURITY_LINE_MAX / 2);
  // what the old format kept (two JWTs on top) would not fit
  const error = await Effect.runPromise(Effect.flip(keychainLine(SECRET, JSON.stringify({ accessToken: fake.state.access, idToken: fake.state.access, refreshToken: fake.state.refresh }))));
  expect(error.message).toContain("4095");
});

test("the callback: a request with another state gets a 400 and the sign-in goes on", async () => {
  const secrets = memorySecrets();
  const statuses: number[] = [];
  const meddler = (url: string) =>
    Effect.promise(async () => {
      const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
      const guess = await fetch(`${redirect}?state=guess&code=stolen&client_id=evil`);
      statuses.push(guess.status);
      await fetch(url);
    });
  const c = await Effect.runPromise(login({ endpoints: endpoints(), open: meddler }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  expect(statuses).toEqual([400]);
  expect(c.clientId).toBe(fake.issued);
});

test("login surfaces a store it can't read instead of registering afresh", async () => {
  const error = await Effect.runPromise(
    Effect.flip(login({ endpoints: endpoints(), open: browser }).pipe(Effect.provide([memorySecrets({ [SECRET]: "{not json" }), FetchHttpClient.layer]))),
  );
  expect(error._tag).toBe("BadCredentials");
});

test("a compactor call streams its line; a long one is retried in the same conversation and the shortest try kept", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const records: UsageRecord[] = [];
  const compact = await Effect.runPromise(
    Effect.gen(function* () {
      return openAiPlanCompactor({ ...compactorBase, effort: "medium", log: (r) => Effect.sync(() => void records.push(r)), model: "gpt-6-luna", plan: yield* OpenAiPlan });
    }).pipe(Effect.provide(plan(e, secrets))),
  );

  fake.state.seen.length = 0;
  fake.state.script = [{ cached: 900, text: "user: move the blog to Bun; talk: starting" }];
  expect(await Effect.runPromise(compact(leaf("move the blog to Bun"), null))).toBe("user: move the blog to Bun; talk: starting");
  const [one] = bodies();
  expect(one).toMatchObject({ instructions: "SYSTEM", model: "gpt-6-luna", store: false, stream: true });
  expect(one!.input.map((m) => m.role)).toEqual(["user"]); // the route rejects system messages
  expect(records[0]).toMatchObject({ attempt: 1, auth: "chatgpt-pro", cold: false, engine: "openai-plan", level: 0, role: "compact", usage: { cacheRead: 900, input: 100 } });

  fake.state.seen.length = 0;
  records.length = 0;
  const sizes = [600, 540, 560, 530, 545];
  fake.state.script = sizes.map((n) => ({ text: line(n) }));
  const kept = await Effect.runPromise(compact(leaf("a long paste"), null));
  expect(bytes(kept)).toBe(530);
  expect(fake.state.seen).toHaveLength(TRIES);
  const last = bodies().at(-1)!;
  // the whole first message again, byte for byte, then each try and its retry text
  expect(JSON.stringify(last.input[0])).toBe(JSON.stringify(bodies()[0]!.input[0]));
  expect(last.input.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  expect(last.input[1]!.content).toBe(line(600));
  expect(JSON.stringify(last.input[2]!.content)).toContain(`Too long: your line is 600 bytes, over the ${NODE}-byte limit. Write\\nthe whole line again`);
  expect(JSON.stringify(last.input[2]!.content)).toContain("| ← LIMIT");
  expect(records.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
  expect(records.every((r) => r.cold)).toBe(true);
});

// claude -p stand-in: every message in gets a result line out
const fakeRunner = (spawned: Spawn[]) =>
  Layer.succeed(Runner)({
    spawn: (o) =>
      Effect.gen(function* () {
        spawned.push(o);
        const stdin = yield* Queue.unbounded<string>();
        const result = JSON.stringify({ is_error: false, result: "user: written by sonnet", subtype: "success", type: "result", usage: { input_tokens: 10, output_tokens: 5 } });
        return yield* makeClaude({ exit: Effect.succeed("ended"), lines: Stream.fromQueue(stdin).pipe(Stream.map(() => result)), stdin });
      }),
    warm: () => Effect.void,
  });

const settings = (byLevel: (typeof Settings.Encoded)["compactor"]["byLevel"]) =>
  parseSettings({
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel, effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [], url: "http://x" } },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    openai: DEFAULT_ENDPOINTS,
  });

const compactors = async (secrets: Layer.Layer<Secrets>, e: Endpoints) => {
  const records: UsageRecord[] = [], reports: string[] = [], spawned: Spawn[] = [];
  const { down, summarize } = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* OpenAiPlan;
      return yield* makeSummarize({
        apiKeys: Effect.die(new Error("no api-key engine in these chains")),
        budget: makeBudget({ monthly: 0, report: () => Effect.void, usagePath: "/nonexistent/usage.jsonl" }),
        device: "mini",
        log: (r) => Effect.sync(() => void records.push(r)),
        plan: Effect.succeed(client),
        report: (m) => Effect.sync(() => void reports.push(m)),
        gate: makeGate(),
        instructions: "SYSTEM",
        placement: Effect.succeed({ cwd: undefined, mcpConfig: "{}", mcpSeen: () => Effect.succeed(false), runner: yield* Runner }),
        tools: [READ],
        settings: settings([
          { chain: ["openai-plan:gpt-6-luna", "claude-code:sonnet"], from: 0 },
          { chain: ["openai-plan:gpt-6.1-sol", "claude-code:sonnet"], from: 3 },
        ]),
      });
    }).pipe(Effect.provide([plan(e, secrets), fakeRunner(spawned)])),
  );
  return { down, records, reports, spawned, summarize };
};

test("429 subscription_sharing_usage_limit_exceeded moves the node to the next engine, which logs failoverFrom; levels pick their chain", async () => {
  const secrets = memorySecrets();
  const { down, records, reports, spawned, summarize } = await compactors(secrets, await signedIn(secrets));
  expect(down.now()).toEqual([]);

  fake.state.seen.length = 0;
  fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
  expect(await Effect.runPromise(summarize(leaf("hi")))).toBe("user: written by sonnet");
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^openai-plan:gpt-6-luna unavailable: .*429.*; compacting on claude-code:sonnet$/);
  expect(down.now().map((d) => d.ref)).toEqual(["openai-plan:gpt-6-luna"]);
  expect(down.now()[0]?.reason).toContain("429");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ device: "mini", engine: "claude-code", failoverFrom: "openai-plan:gpt-6-luna", level: 0 });
  expect(spawned).toHaveLength(1);

  // still spent: no second notice
  fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
  await Effect.runPromise(summarize(leaf("again")));
  expect(reports).toHaveLength(1);

  // the limit can also come mid-stream, its usage logged; a level-3 merge goes to Sol first
  fake.state.seen.length = 0;
  records.length = 0;
  fake.state.script = [{ failed: "subscription_sharing_usage_limit_exceeded" }];
  expect(await Effect.runPromise(summarize({ a: "user: a", b: "user: b", ctx: [], i: 0, l: 3 }))).toBe("user: written by sonnet");
  expect(bodies()[0]!.model).toBe("gpt-6.1-sol");
  expect(spawned).toHaveLength(3);
  expect(records.map((r) => [r.engine, r.usage.output])).toEqual([
    ["openai-plan", 7],
    ["claude-code", 5],
  ]);
  expect(reports[1]).toMatch(/^openai-plan:gpt-6.1-sol unavailable: .*; compacting on claude-code:sonnet$/);

  // Luna answers again: said once
  fake.state.script = [{ text: "user: luna again" }];
  expect(await Effect.runPromise(summarize(leaf("hi")))).toBe("user: luna again");
  expect(reports[2]).toBe("openai-plan:gpt-6-luna back: compacting on it again");
  expect(down.now().map((d) => d.ref)).toEqual(["openai-plan:gpt-6.1-sol"]);
  expect(reports).toHaveLength(3);
  // and a later failover is told again
  fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
  await Effect.runPromise(summarize(leaf("hi")));
  expect(reports[3]).toMatch(/^openai-plan:gpt-6-luna unavailable: /);

  // a model error is the answer, not a reason to move on; an incomplete response still logs its usage
  records.length = 0;
  fake.state.script = [{ code: "server_error", status: 500 }];
  const error = await Effect.runPromise(Effect.flip(summarize(leaf("hi"))));
  expect(error.message).toContain("500");
  fake.state.script = [{ incomplete: "max_output_tokens" }];
  const cut = await Effect.runPromise(Effect.flip(summarize(leaf("hi"))));
  expect(cut.message).toContain("incomplete response (max_output_tokens)");
  expect(spawned).toHaveLength(4);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ attempt: 1, engine: "openai-plan", model: "fake-luna", usage: { cacheRead: 0, cacheWrite: 0, input: 1000, output: 7 } });
});

test("a client connecting after a 429 failover sees the engine down in the session's state, and those connected get a state update", async () => {
  const secrets = memorySecrets();
  const { down, records, summarize } = await compactors(secrets, await signedIn(secrets));
  const dir = mkdtempSync(`${tmpdir()}/oc-down-`);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* openChat(dir, { summarize: () => Effect.succeed("unused") });
        const session = yield* makeSession({ chat, commit: Effect.succeed(null), compactorDown: down, defaultDevice: "mini", devices: ["mini"], engines: [], logUsage: () => Effect.void, media: noMedia });
        const sub = yield* PubSub.subscribe(session.events);
        expect(session.state().down).toEqual([]);

        fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
        expect(yield* summarize(leaf("hi"))).toBe("user: written by sonnet");
        expect(session.state().down.map((d) => d.ref)).toEqual(["openai-plan:gpt-6-luna"]);
        expect(session.state().down[0]?.reason).toContain("429");
        // the session hears the change and publishes its state again
        const told = yield* PubSub.take(sub).pipe(Effect.repeat({ until: (e) => e.type === "state" }));
        expect(told.state.down.map((d) => d.ref)).toEqual(["openai-plan:gpt-6-luna"]);
        expect(records.map((r) => [r.engine, r.device])).toEqual([["claude-code", "mini"]]);

        fake.state.script = [{ text: "user: luna again" }];
        yield* summarize(leaf("hi"));
        expect(session.state().down).toEqual([]);
        const back = yield* PubSub.take(sub).pipe(Effect.repeat({ until: (e) => e.type === "state" }));
        expect(back.state.down).toEqual([]);
      }).pipe(Effect.scoped),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("with calls in flight, an engine is back only when a call started after it went down answers on it", async () => {
  const reports: string[] = [];
  const watch = watchChain((m) => Effect.sync(() => void reports.push(m)), "compacting");
  const started: Deferred.Deferred<string, UsageLimit>[] = [];
  // each call's plan answer waits for the test to settle it
  const call = () =>
    failover(
      [
        {
          ref: "plan",
          run: () =>
            Effect.gen(function* () {
              const answer = yield* Deferred.make<string, UsageLimit>();
              started.push(answer);
              return yield* Deferred.await(answer);
            }),
        },
        { ref: "claude", run: () => Effect.succeed("claude") },
      ],
      watch,
    );
  const capped = new UsageLimit({ message: "429 cap" });
  // the nth call, once it is waiting on the plan
  const begin = (n: number) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(call());
      while (started.length < n) yield* Effect.yieldNow;
      return fiber;
    });
  const settle = (n: number, answer: Effect.Effect<string, UsageLimit>) => Deferred.complete(started[n]!, answer);
  await Effect.runPromise(
    Effect.gen(function* () {
      // two calls in flight on the plan; the first hits the cap
      const a = yield* begin(1), b = yield* begin(2);
      yield* settle(0, Effect.fail(capped));
      expect(yield* Fiber.join(a)).toBe("claude");
      expect(watch.down()).toEqual([{ reason: "429 cap", ref: "plan" }]);
      // the other was already under way: its answer is no sign the plan is back
      yield* settle(1, Effect.succeed("plan"));
      expect(yield* Fiber.join(b)).toBe("plan");
      expect(watch.down()).toEqual([{ reason: "429 cap", ref: "plan" }]);
      // a call started while it was down, and one started after it, both in flight
      const c = yield* begin(3), d = yield* begin(4);
      yield* settle(3, Effect.succeed("plan"));
      expect(yield* Fiber.join(d)).toBe("plan");
      expect(watch.down()).toEqual([]);
      // c began before the plan came back: its cap is not news either
      yield* settle(2, Effect.fail(capped));
      expect(yield* Fiber.join(c)).toBe("claude");
      expect(watch.down()).toEqual([]);
      // a call started now that fails takes it down again
      const e = yield* begin(5);
      yield* settle(4, Effect.fail(capped));
      expect(yield* Fiber.join(e)).toBe("claude");
    }),
  );
  expect(reports).toEqual(["plan unavailable: 429 cap; compacting on claude", "plan back: compacting on it again", "plan unavailable: 429 cap; compacting on claude"]);
});

test("not signed in, the compactor runs on the next engine and says so; a token endpoint down is an error, not a failover", async () => {
  const signedOut = await compactors(memorySecrets(), endpoints());
  expect(await Effect.runPromise(signedOut.summarize(leaf("hi")))).toBe("user: written by sonnet");
  expect(signedOut.spawned).toHaveLength(1);
  expect(signedOut.reports).toHaveLength(1);
  expect(signedOut.reports[0]).toMatch(/^openai-plan:gpt-6-luna unavailable: .*not signed in.*; compacting on claude-code:sonnet$/);

  const secrets = memorySecrets();
  const down = await compactors(secrets, await signedIn(secrets));
  fake.state.tokenStatus = 500;
  const error = await Effect.runPromise(Effect.flip(down.summarize(leaf("hi"))));
  fake.state.tokenStatus = null;
  expect(error.message).toContain("token endpoint 500");
  expect(down.spawned).toHaveLength(0);
  expect(down.reports).toHaveLength(0);
});

test("both compactor engines send the same input: openai-plan's parts are claude-code's blocks of 4 lines", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const compact = await Effect.runPromise(
    Effect.gen(function* () {
      return openAiPlanCompactor({ ...compactorBase, effort: "low", log: () => Effect.void, model: "gpt-6-luna", plan: yield* OpenAiPlan });
    }).pipe(Effect.provide(plan(e, secrets))),
  );
  const job: Job = { ctx: Array.from({ length: 3000 }, (_, k) => `user: line ${k} ${"y".repeat(40)}`), i: 3000, l: 0, msg: newMsg(3000, "user", "hi\nthere") };
  fake.state.seen.length = 0;
  await Effect.runPromise(compact(job, null));
  const [sent] = bodies();
  const parts = sent!.input[0]!.content;
  const texts = blocks(job, "1h").map((b) => b.text);
  expect(texts).toHaveLength(752); // <chat>, 3000 lines, </chat>: 750 whole pieces and a partial one, then the step
  expect(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(parts).map((p) => p.text)).toEqual(texts);
  expect(sent!.reasoning).toEqual({ context: "all_turns", effort: "low" });
});

// what E26 asks of a Responses request, read back from the wire
const Cached = Schema.Struct({
  include: Schema.Array(Schema.String),
  reasoning: Schema.Struct({ context: Schema.String, effort: Schema.optional(Schema.String) }),
  store: Schema.Boolean,
  input: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
});
const decodeCached = Schema.decodeUnknownSync(Schema.fromJsonString(Cached));
const Content = Schema.Array(Schema.Struct({ type: Schema.String, prompt_cache_breakpoint: Schema.optional(Schema.Struct({ mode: Schema.String })) }));
// each part of a user message: its breakpoint's mode, or null
const breakpointsOf = (item: Readonly<Record<string, Schema.Json>> | undefined) =>
  Schema.decodeUnknownSync(Content)(item?.content).map((p) => p.prompt_cache_breakpoint?.mode ?? null);
// `length` parts with an explicit breakpoint on part `at` only
const only = (length: number, at: number) => Array.from({ length }, (_, k) => (k === at ? "explicit" : null));
const Kind = Schema.Struct({ type: Schema.optional(Schema.String), role: Schema.optional(Schema.String) });
const encryptedOf = (i: Readonly<Record<string, Schema.Json>> | undefined) => Schema.decodeUnknownSync(Schema.Struct({ encrypted_content: Schema.String }))(i).encrypted_content;
const kindsOf = (input: readonly Readonly<Record<string, Schema.Json>>[]) => input.map((i) => Schema.decodeUnknownSync(Kind)(i)).map((k) => k.type ?? k.role);
// <chat>, 110 lines, </chat>: 27 whole blocks of 4 lines, then the partial one with </chat>
const LONG_VIEW = `<chat>\n${Array.from({ length: 110 }, (_, k) => `${k}+1|user: line ${k} ${"v".repeat(1000)}`).join("\n")}\n</chat>`;

test("a tool loop on the Responses API keeps its reasoning: sent back encrypted between rounds and after a mid-run message, the view's breakpoints the same in every request", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const respond = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* OpenAiPlan).respond;
    }).pipe(Effect.provide(plan(e, secrets))),
  );
  const provider = responsesProvider({ auth: "chatgpt-pro", effort: "high", engine: "openai-plan", model: "gpt-6.1-sol", respond });
  const tools = { defs: [{ description: "Read a file", name: "Read", parameters: { properties: { file_path: { type: "string" } }, type: "object" } }], run: () => Effect.succeed("file text") };
  const engine = toolLoop({ instructions: "MASTER", provider, ref: "openai-plan:gpt-6.1-sol", toolsFor: () => tools, vision: false });
  // a message sent while the first request runs: offered from the second round on
  let rounds = 0;
  const later: Mid = { media: [], seq: 1, text: "and the tests too" };
  const input: TurnInput = {
    device: "mini",
    earlier: [],
    media: [],
    mid: { next: Effect.never, ready: Effect.sync(() => (++rounds === 2 ? [later] : [])) },
    texts: ["fix the build"],
    view: LONG_VIEW,
  };
  const logged: string[] = [];
  const out: TurnEvents = {
    info: () => Effect.void,
    log: (kind, text) => Effect.sync(() => void logged.push(`${kind}: ${text}`)),
    text: () => Effect.void,
    thinking: () => Effect.void,
    took: (m) => Effect.sync(() => void logged.push(`user: ${m.text}`)),
    usage: () => Effect.void,
  };
  fake.state.seen.length = 0;
  fake.state.script = [{ calls: [{ arguments: '{"file_path":"a.ts"}', name: "Read" }], reasoning: "read a.ts first" }, { calls: [{ arguments: '{"file_path":"b.ts"}', name: "Read" }], reasoning: "now b.ts" }, { reasoning: "done", text: "fixed" }];
  await Effect.runPromise(engine.run(input, out, null));
  expect(logged).toEqual(['tool: Read {"file_path":"a.ts"}', "echo: file text", "user: and the tests too", 'tool: Read {"file_path":"b.ts"}', "echo: file text", "talk: fixed"]); // thought never logged

  const sent = fake.state.seen.map((x) => decodeCached(x.body));
  expect(sent).toHaveLength(3);
  for (const b of sent) {
    expect(b.store).toBe(false);
    expect(b.include).toEqual(["reasoning.encrypted_content"]);
    expect(b.reasoning).toEqual({ context: "all_turns", effort: "high" });
    // one breakpoint, on the view's last whole block; none on the partial one or the new text
    expect(breakpointsOf(b.input[0])).toEqual(only(29, 26));
    expect(JSON.stringify(b.input[0])).toBe(JSON.stringify(sent[0]!.input[0]));
  }
  expect(fake.state.seen.map((x) => x.body.split('"prompt_cache_breakpoint"').length - 1)).toEqual([1, 1, 1]);
  // each request is the one before plus what came since: the reasoning item, verbatim, ahead of its call
  const [, second, third] = sent;
  // the mid-run message joins after the first round's tool results; the reasoning before it stays
  expect(kindsOf(second!.input)).toEqual(["user", "reasoning", "function_call", "function_call_output", "user"]);
  expect(kindsOf(third!.input)).toEqual(["user", "reasoning", "function_call", "function_call_output", "user", "reasoning", "function_call", "function_call_output"]);
  expect(JSON.stringify(third!.input.slice(0, 5))).toBe(JSON.stringify(second!.input));
  const replayed = third!.input.filter((i) => i.type === "reasoning");
  expect(replayed.map((i) => i.id)).toEqual(["rs_1", "rs_2"]);
  for (const i of replayed) expect([...fake.state.issued]).toContain(encryptedOf(i));
});

test("openai-plan: a turn of our tool loop and a compaction send the same instructions and tools, byte for byte; the compaction may call none", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const respond = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* OpenAiPlan).respond;
    }).pipe(Effect.provide(plan(e, secrets))),
  );
  const provider = responsesProvider({ auth: "chatgpt-pro", effort: "high", engine: "openai-plan", model: "gpt-6.1-sol", respond });
  const engine = toolLoop({ instructions: "SYSTEM", provider, ref: "openai-plan:gpt-6.1-sol", toolsFor: () => ({ defs: [READ], run: () => Effect.succeed("") }), vision: false });
  const compact = openAiPlanCompactor({ ...compactorBase, effort: "medium", log: () => Effect.void, model: "gpt-6.1-sol", plan: { respond } });
  const out: TurnEvents = { info: () => Effect.void, log: () => Effect.void, text: () => Effect.void, thinking: () => Effect.void, took: () => Effect.void, usage: () => Effect.void };
  fake.state.seen.length = 0;
  fake.state.script = [{ text: "hi" }, { text: line(300) }];
  await Effect.runPromise(engine.run({ device: "mini", earlier: [], media: [], mid: { next: Effect.never, ready: Effect.succeed([]) }, texts: ["hi"], view: LONG_VIEW }, out, null));
  await Effect.runPromise(compact(leaf("hello"), null));
  const Raw = Schema.fromJsonString(Schema.Struct({ instructions: Schema.Json, tool_choice: Schema.optional(Schema.String), tools: Schema.Json }));
  const [turn, compaction] = fake.state.seen.map((x) => Schema.decodeUnknownSync(Raw)(x.body));
  expect(JSON.stringify(compaction!.instructions)).toBe(JSON.stringify(turn!.instructions));
  expect(JSON.stringify(compaction!.tools)).toBe(JSON.stringify(turn!.tools));
  expect([turn!.tool_choice, compaction!.tool_choice]).toEqual(["auto", "none"]);
});

test("the compactor on the plan replays its reasoning on a size retry, and a model that refuses breakpoints is asked again without them, said once", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const reports: string[] = [];
  const layer = openAiPlanLayer(e, { report: (m) => Effect.sync(() => void reports.push(m)) }).pipe(Layer.provide([secrets, FetchHttpClient.layer]));
  const compact = await Effect.runPromise(
    Effect.gen(function* () {
      return openAiPlanCompactor({ ...compactorBase, effort: "medium", log: () => Effect.void, model: "gpt-6.1-sol", plan: yield* OpenAiPlan });
    }).pipe(Effect.provide(layer)),
  );
  const job: Job = { ctx: Array.from({ length: 110 }, (_, k) => `user: line ${k} ${"z".repeat(1000)}`), i: 110, l: 0, msg: newMsg(110, "user", "squeeze me") };

  // marks accepted: the context's last whole block carries one, and the retry sends back the first try's reasoning
  fake.state.refuseBreakpoints = false;
  fake.state.seen.length = 0;
  fake.state.script = [{ reasoning: "too much detail", text: line(600) }, { text: line(500) }];
  expect(await Effect.runPromise(compact(job, null))).toBe(line(500));
  const [first, retry] = fake.state.seen.map((x) => decodeCached(x.body));
  expect(breakpointsOf(first!.input[0])).toEqual(only(29, 26)); // 28 pieces, then the step
  expect(kindsOf(retry!.input)).toEqual(["user", "reasoning", "assistant", "user"]);
  expect([...fake.state.issued]).toContain(encryptedOf(retry!.input[1]));

  // a model that refuses the field: the same request again without it, then none from the start
  fake.state.refuseBreakpoints = true;
  fake.state.seen.length = 0;
  fake.state.script = [{ text: line(400) }, { text: line(300) }];
  expect(await Effect.runPromise(compact(job, null))).toBe(line(400));
  expect(await Effect.runPromise(compact(job, null))).toBe(line(300));
  expect(fake.state.seen.map((x) => x.body.includes("prompt_cache_breakpoint"))).toEqual([true, false, false]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("gpt-6.1-sol refuses prompt_cache_breakpoint");
  fake.state.refuseBreakpoints = false;
});

const respondWith = (layer: Layer.Layer<OpenAiPlan>) => (text: string) =>
  Effect.gen(function* () {
    const p = yield* OpenAiPlan;
    return yield* p.respond({ input: [{ parts: [text], role: "user" }], instructions: "x", model: "m" });
  }).pipe(Effect.provide(layer));

test("a 401 refreshes the token once; a second 401 is a sign-out the chain moves past, not a refresh loop", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const layer = await Effect.runPromise(Layer.build(plan(e, secrets)).pipe(Effect.map((ctx) => Layer.succeedContext(ctx)), Effect.scoped));
  const respond = respondWith(layer);

  // a new process starts with no access token: the first call refreshes
  const before = fake.state.refreshes;
  const zero = await Effect.runPromise(respond("zero"));
  expect(zero.text).toBe("user: ok");
  expect(fake.state.refreshes).toBe(before + 1);
  expect(decodeCredentials(await stored(secrets)).refreshToken).toBe(fake.state.refresh); // the rotated one, saved

  fake.state.access = "revoked-on-the-server";
  fake.state.script = [{ text: "user: fine" }];
  const one = await Effect.runPromise(respond("one"));
  expect(one.text).toBe("user: fine");
  expect(fake.state.refreshes).toBe(before + 2);

  fake.state.reject = true;
  const error = await Effect.runPromise(Effect.flip(respond("two")));
  fake.state.reject = false;
  expect(error._tag).toBe("UsageLimit");
  expect(fake.state.refreshes).toBe(before + 3);
});

// how a call ends, as "Tag: message"
const ending = async (effect: Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>) => {
  const r = await Effect.runPromise(Effect.result(effect));
  return r._tag === "Success" ? "Success" : `${r.failure._tag}: ${r.failure.message}`;
};
const tokenFailure = async (secrets: Layer.Layer<Secrets>, e: Endpoints) => ending(respondWith(plan(e, secrets))("x"));

test("signed out is a failover; a token endpoint that fails, a bad secret or someone else's ID token is a model error", async () => {
  const e = endpoints();
  expect(await tokenFailure(memorySecrets(), e)).toMatch(/^UsageLimit: .*not signed in/);
  expect(await tokenFailure(memorySecrets({ [SECRET]: "{\"clientId\": tru" }), e)).toMatch(/^ModelError: .*does not decode/);

  const secrets = memorySecrets();
  await signedIn(secrets);
  fake.state.tokenStatus = 500;
  const down = await tokenFailure(secrets, e);
  fake.state.tokenStatus = 400; // no invalid_grant in the body: not a rejected grant
  const odd = await tokenFailure(secrets, e);
  fake.state.tokenStatus = null;
  expect(down).toMatch(/^ModelError: .*token endpoint 500/);
  expect(odd).toMatch(/^ModelError: .*token endpoint 400/);

  fake.state.refreshSub = "someone-else";
  const other = await tokenFailure(secrets, e);
  fake.state.refreshSub = null;
  expect(other).toMatch(/^ModelError: .*different account/);

  // a refresh token the issuer refuses: signed out
  const spent = memorySecrets({ [SECRET]: encodeCredentials({ ...decodeCredentials(await stored(secrets)), refreshToken: "rt_spent" }) });
  expect(await tokenFailure(spent, e)).toMatch(/^UsageLimit: .*invalid_grant/);
});

test("a rotated refresh token that can't be saved stays in memory, loudly", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const saved = await stored(secrets);
  const locked = Layer.succeed(Secrets)({
    get: () => Effect.succeed(Option.some(saved)),
    remove: () => Effect.void,
    set: () => Effect.fail(new SecretsError({ message: "keychain: locked" })),
  });
  const reports: string[] = [];
  const layer = await Effect.runPromise(
    Layer.build(openAiPlanLayer(e, { report: (m) => Effect.sync(() => void reports.push(m)) }).pipe(Layer.provide([locked, FetchHttpClient.layer]))).pipe(
      Effect.map((ctx) => Layer.succeedContext(ctx)),
      Effect.scoped,
    ),
  );
  const respond = respondWith(layer);
  expect(await ending(respond("one"))).toBe("Success");
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("keychain: locked");
  // the saved refresh token is spent now; the next refresh uses the one in memory
  fake.state.access = "revoked-on-the-server";
  expect(await ending(respond("two"))).toBe("Success");
  expect(reports).toHaveLength(2);
});

// SSE as it comes off the wire, in chunks of any size
type Json = string | number | null | readonly Json[] | { readonly [key: string]: Json };
const sse = (e: { readonly type: string; readonly [k: string]: Json }) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const chunked = (s: string, size: number) => {
  const b = new TextEncoder().encode(s);
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size));
  return Stream.fromIterable(out);
};
const read = async (s: string, size = 3) => ending(readStream(chunked(s, size), "m"));
const ok = [
  sse({ type: "response.created" }),
  sse({ type: "response.something.new" }),
  sse({ delta: "zażółć ", type: "response.output_text.delta" }),
  sse({ delta: "gęślą", type: "response.output_text.delta" }),
  sse({ response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 } }, type: "response.completed" }),
].join("");

test("the stream reader: frames split anywhere, CRLF, [DONE] after completed; mid-stream errors, refusals and cut streams fail", async () => {
  for (const size of [1, 2, 3, 7, 100]) {
    const reply = await Effect.runPromise(readStream(chunked(ok, size), "m"));
    expect(reply).toEqual({ model: "m", output: [{ text: "zażółć gęślą", type: "text" }], text: "zażółć gęślą", usage: { cacheRead: 4, cacheWrite: 0, input: 6, output: 2 } });
  }
  expect(await read(ok.replaceAll("\n", "\r\n"))).toBe("Success");
  expect(await read(`${ok}data: [DONE]\n\n`)).toBe("Success");
  expect(await read(`${ok}data: not json at all\n\n`)).toBe("Success"); // never read: the call ended at completed

  expect(await read(sse({ delta: "x", type: "response.output_text.delta" }) + sse({ code: "server_error", message: "boom", type: "error" }))).toMatch(/^ModelError: .*boom/);
  expect(await read(sse({ delta: "no", type: "response.refusal.delta" }) + sse({ response: {}, type: "response.completed" }))).toMatch(/^Refusal: /);
  expect(await read(ok.slice(0, -40))).toMatch(/^ModelError: .*without response.completed/);
  expect(await read(sse({ response: { error: { code: "subscription_sharing_usage_limit_exceeded" } }, type: "response.failed" }))).toMatch(/^UsageLimit: /);
});
