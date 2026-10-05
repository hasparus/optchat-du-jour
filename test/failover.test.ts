// M5's done-criterion through the real server (SPEC "Engines", Failover): the Claude plan is spent,
// so the turn stops until the user picks openai-plan (the master never fails over by itself, E4),
// which answers with our own tool loop and reads a file on another device through its runner's
// POST /tool. The message is answered exactly once, the move is in usage.jsonl and on every
// client. Then a message sent while openai-plan works is taken after the tool results, before the
// next request; Claude Code's own error message is never logged. And a compactor's failover
// reaches every client as the state's down list. Fake claude, fake Responses API.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deviceLayer } from "../device/runner.ts";
import { serverLayer } from "../server/app.ts";
import { CompactError } from "../src/compactor.ts";
import { parseSettings } from "../src/config.ts";
import { login } from "../src/openai/auth.ts";
import { memorySecrets } from "../src/secrets.ts";
import { readUsage } from "../src/usage.ts";
import { fakeOpenAi } from "./fake-openai.ts";
import { freePort } from "./ports.ts";

const FAKE = new URL("fake-claude.ts", import.meta.url).pathname;
const home = realpathSync(mkdtempSync(`${tmpdir()}/of-`));
const fake = fakeOpenAi();
const saved = { claude: Bun.env.OPTCHAT_CLAUDE, log: Bun.env.FAKE_CLAUDE_LOG, script: Bun.env.FAKE_CLAUDE_SCRIPT };
afterAll(async () => {
  // the device's claude inherits this process's env; leave it as the other suites expect it
  for (const [k, v] of [["OPTCHAT_CLAUDE", saved.claude], ["FAKE_CLAUDE_LOG", saved.log], ["FAKE_CLAUDE_SCRIPT", saved.script]] as const)
    if (v === undefined) Reflect.deleteProperty(Bun.env, k);
    else Bun.env[k] = v;
  await fake.server.stop(true);
  rmSync(home, { force: true, recursive: true });
});

const Event = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Json),
  delta: Schema.optional(Schema.Json),
  snapshot: Schema.optional(Schema.Json),
});
type Event = typeof Event.Type;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const Entries = Schema.Struct({ entries: Schema.Array(Schema.Struct({ kind: Schema.String, text: Schema.String, device: Schema.optional(Schema.String) })) });
const Item = Schema.Struct({
  role: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.String }))])),
  output: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const Body = Schema.Struct({ instructions: Schema.String, input: Schema.Array(Item), tools: Schema.Array(Schema.Struct({ name: Schema.String })), tool_choice: Schema.String });
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));
const Pending = Schema.Struct({ pending: Schema.Array(Schema.Struct({ text: Schema.String })) });
const Down = Schema.Array(Schema.Struct({ ref: Schema.String, reason: Schema.String }));
const DownOp = Schema.Struct({ path: Schema.Literal("/down"), value: Down });
const Snapshot = Schema.Struct({ down: Down });
// the refs of each `down` a STATE_DELTA sets
const downOf = (e: Event) => {
  const ops: readonly unknown[] = e.type === "STATE_DELTA" && Array.isArray(e.delta) ? e.delta : [];
  return ops.flatMap((op) => (Schema.is(DownOp)(op) ? [op.value.map((d) => d.ref)] : []));
};
const Start = Schema.Struct({ type: Schema.Literal("start"), role: Schema.String, argv: Schema.Array(Schema.String) });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));

const until = async (what: string, done: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

// one /ws client for the whole test
const client = async (url: string) => {
  const ws = new WebSocket(url);
  const events: Event[] = [];
  ws.addEventListener("message", (m) => {
    events.push(decodeEvent(String(m.data)));
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve, { once: true });
  });
  const send = (text: string, device = "macbook") => {
    ws.send(JSON.stringify({ forwardedProps: { device }, messages: [{ content: text, id: crypto.randomUUID(), role: "user" }] }));
  };
  const ended = () => events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
  const infos = () => events.flatMap((e) => (e.name === "info" && Schema.is(Schema.String)(e.value) ? [e.value] : []));
  // the user picks the engine turns run on (a turn stopped on a usage limit goes on, on it)
  const pick = (lead: string) => {
    ws.send(JSON.stringify({ lead, type: "settings" }));
  };
  return { ended, events, infos, pick, send, ws };
};

test("a spent Claude plan stops the turn until the user picks openai-plan, which reads a file on the device and answers once; a mid-run message joins before its next request", async () => {
  const mini = `${home}/mini`, macbook = `${home}/macbook`;
  mkdirSync(mini);
  mkdirSync(macbook);
  writeFileSync(`${macbook}/notes.txt`, "buy milk\nfix the boiler\n");
  Bun.env.OPTCHAT_CLAUDE = FAKE;
  Bun.env.FAKE_CLAUDE_LOG = `${home}/fake.jsonl`;
  Bun.env.FAKE_CLAUDE_SCRIPT = `${home}/script.json`;
  writeFileSync(Bun.env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ turn: [[{ result: { is_error: true, text: "Claude AI usage limit reached|1760000000" } }]] }));

  // signed in to the fake ChatGPT, as `optchat login openai` does
  const secrets = memorySecrets({});
  const endpoints = { agentName: "optchat-test", api: `${fake.base}/v1`, issuer: fake.base, port: freePort(), registerClientId: "dynamic_agent_client" };
  await Effect.runPromise(login({ endpoints, open: (url) => Effect.promise(async () => void (await fetch(url))) }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  const port = freePort(), devicePort = freePort();
  const settings = parseSettings({
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: {
      macbook: { folders: [macbook], url: `http://127.0.0.1:${devicePort}` },
      mini: { folders: [mini], url: "http://127.0.0.1:9" },
    },
    master: { chain: ["claude-code:opus", "openai-plan:gpt-sol"], effort: "high", permissionMode: "bypassPermissions" },
    openai: endpoints,
    server: { host: "127.0.0.1", port, publicUrl: `http://localhost:${port}` },
  });
  const trust = { _tag: "loopback" } as const;
  const both = Layer.mergeAll(
    deviceLayer({ claude: FAKE, folders: [macbook], host: "127.0.0.1", name: "macbook", port: devicePort, trust }),
    serverLayer({
      device: "mini",
      home,
      host: "127.0.0.1",
      port,
      secrets,
      settings,
      summarize: () => Effect.fail(new CompactError({ message: "no compactor in this test" })),
    }),
  );
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return response.text();
  };
  const queued = async () => Schema.decodeUnknownSync(Schema.fromJsonString(Pending))(await get("/api/state")).pending.map((m) => m.text);
  const log = async () => Schema.decodeUnknownSync(Schema.fromJsonString(Entries))(await get("/api/messages")).entries.map((e) => [e.kind, e.text]);

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(both);
        const c = yield* Effect.promise(async () => client(`ws://127.0.0.1:${port}/ws`));
        const read = JSON.stringify({ file_path: "notes.txt" });
        fake.state.script = [{ calls: [{ arguments: read, name: "Read" }], text: "Let me look." }, { text: "The note says: buy milk." }];
        c.send("what does my note say?");
        // no failover (E4): the turn stops, says why, and waits; the pick carries it on
        yield* Effect.promise(async () => until("the stop", () => c.ended().length === 1));
        expect(c.ended()[0]?.type).toBe("RUN_ERROR");
        expect(fake.state.seen).toHaveLength(0);
        c.pick("openai-plan:gpt-sol");
        yield* Effect.promise(async () => until("the first turn", () => c.ended().length === 2));
        expect(c.ended()[1]?.type).toBe("RUN_FINISHED");

        const echo = "     1\tbuy milk\n     2\tfix the boiler";
        expect(yield* Effect.promise(log)).toEqual([
          ["user", "what does my note say?"],
          ["talk", "Let me look."],
          ["tool", `Read ${read}`],
          ["echo", echo],
          ["talk", "The note says: buy milk."],
        ]);
        // said once while it waited (the run's end, and `stopped` in the state), and once as the record
        expect(c.infos().filter((m) => m.includes("Claude AI usage limit reached"))).toEqual(["Claude Opus (Claude Code) stopped (usage limit: Claude AI usage limit reached|1760000000); GPT Sol (ChatGPT plan) carries on"]);
        expect(c.events.flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" && Schema.is(Schema.String)(e.delta) ? [e.delta] : [])).join("")).toContain("The note says: buy milk.");

        const usage = readUsage(`${home}/usage.jsonl`).filter((r) => r.role === "turn");
        expect(usage.map((r) => [r.engine, r.auth, r.failoverFrom, r.device])).toEqual([
          ["claude-code", "claude-max", null, "macbook"],
          ["openai-plan", "chatgpt-pro", "claude-code:opus", "macbook"],
          ["openai-plan", "chatgpt-pro", "claude-code:opus", "macbook"],
        ]);
        // the pick is the session's now, and outlives a restart (session.json in the data dir)
        expect(readFileSync(`${home}/session.json`, "utf8")).toBe('{"followUp":"steer","lead":"openai-plan:gpt-sol"}\n');

        // what reached the Responses API: claude's exact system prompt, the view then the text, read-only tools
        const [first, second] = fake.state.seen.map((s) => decodeBody(s.body));
        const turn = readFileSync(`${home}/fake.jsonl`, "utf8").split("\n").flatMap((l) => Option.toArray(decodeStart(l))).find((s) => s.role === "turn"); // any device's: all carry the same --system-prompt
        const argv = turn?.argv ?? [];
        expect(first?.instructions).toBe(argv[argv.indexOf("--system-prompt") + 1] ?? "");
        expect(first?.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "zoom", "date"]);
        const opening = first?.input[0]?.content ?? "";
        expect(Schema.is(Schema.String)(opening) ? [opening] : opening.map((p) => p.text)).toEqual(["<chat>\n</chat>", "what does my note say?"]);
        expect(second?.input.map((i) => i.type ?? i.role)).toEqual(["user", "assistant", "function_call", "function_call_output"]);
        expect(second?.input.at(-1)?.output).toBe(echo);

        // a message sent while openai-plan's request is in flight: after the tool results, before the next request
        fake.state.seen.length = 0;
        const gate = Promise.withResolvers<null>();
        fake.state.script = [{ calls: [{ arguments: JSON.stringify({ pattern: "*.txt" }), name: "Glob" }], gate: gate.promise }, { text: "Both answered." }];
        c.send("list my notes");
        yield* Effect.promise(async () => until("openai-plan's first request", () => fake.state.seen.length === 1));
        c.send("and say hi");
        for (let k = 0; k < 100 && !(yield* Effect.promise(queued)).includes("and say hi"); k++) yield* Effect.sleep("20 millis");
        gate.resolve(null);
        yield* Effect.promise(async () => until("the second turn", () => c.ended().length === 3));
        expect(c.ended()[2]?.type).toBe("RUN_FINISHED");
        expect((yield* Effect.promise(log)).slice(5)).toEqual([
          ["user", "list my notes"],
          ["tool", 'Glob {"pattern":"*.txt"}'],
          ["echo", `${macbook}/notes.txt`],
          ["user", "and say hi"],
          ["talk", "Both answered."],
        ]);
        expect(fake.state.seen).toHaveLength(2);
        const next = decodeBody(fake.state.seen[1]?.body ?? "");
        expect(next.input.slice(-3).map((i) => i.type ?? i.role)).toEqual(["function_call", "function_call_output", "user"]);

        // back on Claude, a limit after partial output: what claude logged stays, once, and
        // openai-plan, picked, is told to carry on from it
        writeFileSync(`${home}/script.json`, JSON.stringify({ turn: [[{ text: "Starting on it." }, { result: { is_error: true, text: "Claude AI usage limit reached" } }]] }));
        fake.state.seen.length = 0;
        fake.state.script = [{ text: "Done." }];
        c.pick("claude-code:opus");
        c.send("tidy up");
        yield* Effect.promise(async () => until("the second stop", () => c.ended().length === 4));
        c.pick("openai-plan:gpt-sol");
        yield* Effect.promise(async () => until("the third turn", () => c.ended().length === 5));
        expect((yield* Effect.promise(log)).slice(10)).toEqual([
          ["user", "tidy up"],
          ["talk", "Starting on it."],
          ["talk", "Done."],
        ]);
        expect(c.infos().at(-1)).toBe("Claude Opus (Claude Code) stopped (usage limit: Claude AI usage limit reached); GPT Sol (ChatGPT plan) carries on from the 1 logged entries");
        const resumed = decodeBody(fake.state.seen[0]?.body ?? "").input[0]?.content ?? "";
        const said = Schema.is(Schema.String)(resumed) ? resumed : (resumed.at(-1)?.text ?? "");
        expect(said).toStartWith("tidy up\n\n[optchat: Another engine began this turn");
        expect(said).toEndWith("\ntalk: Starting on it.");

        // Claude Code reports the spent plan as its own assistant message (model "<synthetic>")
        // before an error result that here says nothing: that message is never logged as the
        // model's reply nor handed on, yet it is why the turn stops for a pick
        writeFileSync(`${home}/script.json`, JSON.stringify({ turn: [[{ text: "Looking." }, { synthetic: "Claude AI usage limit reached|1760000000" }, { result: { is_error: true, text: "" } }]] }));
        fake.state.seen.length = 0;
        fake.state.script = [{ text: "Here." }];
        c.pick("claude-code:opus");
        c.send("one more");
        yield* Effect.promise(async () => until("the third stop", () => c.ended().length === 6));
        c.pick("openai-plan:gpt-sol");
        yield* Effect.promise(async () => until("the fourth turn", () => c.ended().length === 7));
        expect(c.ended()[6]?.type).toBe("RUN_FINISHED");
        expect((yield* Effect.promise(log)).slice(13)).toEqual([
          ["user", "one more"],
          ["talk", "Looking."],
          ["talk", "Here."],
        ]);
        expect(c.infos().at(-1)).toBe("Claude Opus (Claude Code) stopped (usage limit: Claude AI usage limit reached|1760000000); GPT Sol (ChatGPT plan) carries on from the 1 logged entries");
        const handed = decodeBody(fake.state.seen[0]?.body ?? "").input[0]?.content ?? "";
        const carried = Schema.is(Schema.String)(handed) ? handed : (handed.at(-1)?.text ?? "");
        expect(carried).toEndWith("\ntalk: Looking.");
        expect(carried).not.toContain("1760000000");
        c.ws.close();
      }),
    ),
  );
}, 30_000);

// SPEC "Policy" (M3): compaction never moves onto another engine unseen. Through the real server:
// a 429 from the ChatGPT plan moves a node to claude-code, every connected client gets the state's
// `down` list in a STATE_DELTA, and a client that connects later finds it in its STATE_SNAPSHOT.
test("a compactor failover reaches every socket as the state's down list, and a late joiner's snapshot", async () => {
  const data = `${home}/down`;
  mkdirSync(data);
  Bun.env.OPTCHAT_CLAUDE = FAKE;
  Bun.env.FAKE_CLAUDE_LOG = `${data}/fake.jsonl`;
  Bun.env.FAKE_CLAUDE_SCRIPT = `${data}/script.json`;
  writeFileSync(Bun.env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ turn: [[{ text: "noted" }]] })); // compactor calls answer a short line
  const secrets = memorySecrets({});
  const endpoints = { agentName: "optchat-test", api: `${fake.base}/v1`, issuer: fake.base, port: freePort(), registerClientId: "dynamic_agent_client" };
  await Effect.runPromise(login({ endpoints, open: (url) => Effect.promise(async () => void (await fetch(url))) }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));
  const port = freePort();
  const settings = parseSettings({
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["openai-plan:gpt-6-luna", "claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [data], url: "http://127.0.0.1:9" } },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    openai: endpoints,
    server: { host: "127.0.0.1", port },
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(serverLayer({ device: "mini", home: data, host: "127.0.0.1", port, secrets, settings }));
        const early = yield* Effect.promise(async () => client(`ws://127.0.0.1:${port}/ws`));
        fake.state.script = [{ code: "subscription_sharing_usage_limit_exceeded", status: 429 }];
        early.send(`a message long enough to need a summary: ${"x".repeat(600)}`, "mini");
        yield* Effect.promise(async () => until("the turn", () => early.ended().length === 1));
        expect(early.infos().filter((m) => m.startsWith("openai-plan:gpt-6-luna unavailable: "))).toHaveLength(1);
        expect(early.events.flatMap(downOf)).toEqual([["openai-plan:gpt-6-luna"]]);

        const late = yield* Effect.promise(async () => client(`ws://127.0.0.1:${port}/ws`));
        yield* Effect.promise(async () => until("the late joiner's snapshot", () => late.events.some((e) => e.type === "STATE_SNAPSHOT")));
        const snapshot = Schema.decodeUnknownSync(Snapshot)(late.events.find((e) => e.type === "STATE_SNAPSHOT")?.snapshot);
        expect(snapshot.down.map((d) => d.ref)).toEqual(["openai-plan:gpt-6-luna"]);
        expect(snapshot.down[0]?.reason).toContain("429");
        early.ws.close();
        late.ws.close();
      }),
    ),
  );
}, 30_000);
