// The openai-plan engine against fake OAuth and Responses servers (test/fake-openai.ts): no network
// beyond 127.0.0.1, no model calls.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { readFileSync } from "node:fs";
import { type Settings, NODE, TRIES } from "../src/config.ts";
import { type Spawn, Runner, makeClaude } from "../src/claude/process.ts";
import type { Job } from "../src/compactor.ts";
import { Credentials, type Endpoints, SECRET, login } from "../src/openai/auth.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { COMPACT_FILE } from "../src/prompts.ts";
import { Secrets, memorySecrets } from "../src/secrets.ts";
import { newMsg } from "../src/store.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { openAiPlanCompactor } from "../src/summarize/openai-plan.ts";
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

const leaf = (text: string): Job => ({ ctx: ["user: we are moving the blog to Bun", "talk: ok, starting with the build"], i: 2, l: 0, msg: newMsg(2, "user", text) });
const line = (n: number) => `user: ${"x".repeat(n - 6)}`;
// what reached the API, read back with the same shape the client wrote
const Body = Schema.Struct({
  instructions: Schema.String,
  store: Schema.Boolean,
  stream: Schema.Boolean,
  model: Schema.String,
  input: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.String }))]) })),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));
const bodies = () => fake.state.seen.map((s) => decodeBody(s.body));
const decodeCredentials = Schema.decodeUnknownSync(Schema.fromJsonString(Credentials));

test("login: PKCE with the fake issuer, the issued client id saved, never dynamic_agent_client", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const p = fake.state.authorizeParams!;
  expect(p.get("client_id")).toBe("dynamic_agent_client");
  expect(p.get("code_challenge_method")).toBe("S256");
  expect(p.get("redirect_uri")).toBe(`http://127.0.0.1:${e.port}/auth/callback`);
  expect(p.get("scope")).toContain("chatgpt.tokens.use.direct");
  expect(p.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  const read = Effect.gen(function* () {
    const store = yield* Secrets;
    return yield* store.get(SECRET);
  });
  const saved = await Effect.runPromise(read.pipe(Effect.provide(secrets)));
  const c = decodeCredentials(Option.getOrThrow(saved));
  expect(c).toMatchObject({ accessToken: fake.state.access, clientId: fake.issued, email: "me@example.com", subject: "user-1" });

  // signing in again reuses the issued client and this machine's host id
  await Effect.runPromise(login({ endpoints: { ...e, port: freePort() }, open: browser }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  expect(fake.state.authorizeParams!.get("client_id")).toBe(fake.issued);
  expect(fake.state.authorizeParams!.get("ext_agent_host_id")).toBe(c.hostId);
  expect(fake.state.authorizeParams!.get("id_token_hint")).toBe(c.idToken);
});

test("a compactor call streams its line; a long one is retried in the same conversation and the shortest try kept", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const records: UsageRecord[] = [];
  const compact = await Effect.runPromise(
    openAiPlanCompactor({ effort: "medium", log: (r) => Effect.sync(() => void records.push(r)), model: "gpt-6-luna" }).pipe(Effect.provide(plan(e, secrets))),
  );

  fake.state.seen.length = 0;
  fake.state.script = [{ cached: 900, text: "user: move the blog to Bun; talk: starting" }];
  expect(await Effect.runPromise(compact(leaf("move the blog to Bun"), null))).toBe("user: move the blog to Bun; talk: starting");
  const [one] = bodies();
  expect(one).toMatchObject({ instructions: readFileSync(COMPACT_FILE, "utf8"), model: "gpt-6-luna", store: false, stream: true });
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
  expect(JSON.stringify(last.input[2]!.content)).toContain(`That line is 600 bytes; the limit is ${NODE}. It must end where it is cut here:`);
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
  });

const settings = (byLevel: Settings["compactor"]["byLevel"]): Settings => ({
  allowedLogins: [],
  cache: { apiKeyTtls: [], claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel, effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://x" } },
  master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
});

test("429 subscription_sharing_usage_limit_exceeded moves the node to the next engine, which logs failoverFrom; levels pick their chain", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const records: UsageRecord[] = [], reports: string[] = [], spawned: Spawn[] = [];
  const summarize = await Effect.runPromise(
    makeSummarize({
      log: (r) => Effect.sync(() => void records.push(r)),
      report: (m) => Effect.sync(() => void reports.push(m)),
      settings: settings([
        { chain: ["openai-plan:gpt-6-luna", "claude-code:sonnet"], from: 0 },
        { chain: ["openai-plan:gpt-6.1-sol", "claude-code:sonnet"], from: 3 },
      ]),
    }).pipe(Effect.provide([plan(e, secrets), fakeRunner(spawned)])),
  );

  fake.state.seen.length = 0;
  fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
  expect(await Effect.runPromise(summarize(leaf("hi")))).toBe("user: written by sonnet");
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("openai-plan:gpt-6-luna → claude-code:sonnet");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ engine: "claude-code", failoverFrom: "openai-plan:gpt-6-luna", level: 0 });
  expect(spawned).toHaveLength(1);

  // the limit can also come mid-stream; a level-3 merge goes to Sol first
  fake.state.seen.length = 0;
  fake.state.script = [{ failed: "subscription_sharing_usage_limit_exceeded" }];
  expect(await Effect.runPromise(summarize({ a: "user: a", b: "user: b", ctx: [], i: 0, l: 3 }))).toBe("user: written by sonnet");
  expect(bodies()[0]!.model).toBe("gpt-6.1-sol");
  expect(spawned).toHaveLength(2);

  // a model error is the answer, not a reason to move on
  fake.state.script = [{ code: "server_error", status: 500 }];
  const error = await Effect.runPromise(Effect.flip(summarize(leaf("hi"))));
  expect(error.message).toContain("500");
  expect(spawned).toHaveLength(2);
});

test("a 401 refreshes the token once; a second 401 is a sign-out the chain moves past, not a refresh loop", async () => {
  const secrets = memorySecrets();
  const e = await signedIn(secrets);
  const respond = (text: string) =>
    Effect.gen(function* () {
      const p = yield* OpenAiPlan;
      return yield* p.respond({ input: [{ parts: [text], role: "user" }], instructions: "x", model: "m" });
    }).pipe(Effect.provide(plan(e, secrets)));

  fake.state.access = "revoked-on-the-server";
  const before = fake.state.refreshes;
  fake.state.script = [{ text: "user: fine" }];
  const reply = await Effect.runPromise(respond("one"));
  expect(reply.text).toBe("user: fine");
  expect(fake.state.refreshes).toBe(before + 1);

  fake.state.reject = true;
  const error = await Effect.runPromise(Effect.flip(respond("two")));
  fake.state.reject = false;
  expect(error._tag).toBe("UsageLimit");
  expect(fake.state.refreshes).toBe(before + 2);
});
