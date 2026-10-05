// M5's done-criterion through the real server (SPEC "Engines", Failover): the Claude plan is spent,
// so the turn falls over to openai-plan, which answers with our own tool loop and reads a file on
// another device through its runner's POST /tool. The message is answered exactly once, the
// failover is in usage.jsonl and on every client. Then a message sent while openai-plan works is
// taken after the tool results, before the next request. Fake claude, fake Responses API.
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
const Queued = Schema.Struct({ queued: Schema.Array(Schema.String) });
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
  return { ended, events, infos, send, ws };
};

test("a spent Claude plan moves the turn to openai-plan, which reads a file on the device and answers once; a mid-run message joins before its next request", async () => {
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
    cache: { apiKeyTtls: ["1h"], claudeCodeTtl: "1h", primeTtl: "1h" },
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
  const queued = async () => Schema.decodeUnknownSync(Schema.fromJsonString(Queued))(await get("/api/state")).queued;
  const log = async () => Schema.decodeUnknownSync(Schema.fromJsonString(Entries))(await get("/api/messages")).entries.map((e) => [e.kind, e.text]);

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(both);
        const c = yield* Effect.promise(async () => client(`ws://127.0.0.1:${port}/ws`));
        const read = JSON.stringify({ file_path: "notes.txt" });
        fake.state.script = [{ calls: [{ arguments: read, name: "Read" }], text: "Let me look." }, { text: "The note says: buy milk." }];
        c.send("what does my note say?");
        yield* Effect.promise(async () => until("the first turn", () => c.ended().length === 1));
        expect(c.ended()[0]?.type).toBe("RUN_FINISHED");

        const echo = "     1\tbuy milk\n     2\tfix the boiler";
        expect(yield* Effect.promise(log)).toEqual([
          ["user", "what does my note say?"],
          ["talk", "Let me look."],
          ["tool", `Read ${read}`],
          ["echo", echo],
          ["talk", "The note says: buy milk."],
        ]);
        expect(c.infos().filter((m) => m.startsWith("claude-code:opus → openai-plan:gpt-sol: Claude AI usage limit reached"))).toHaveLength(1);
        expect(c.events.flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" && Schema.is(Schema.String)(e.delta) ? [e.delta] : [])).join("")).toContain("The note says: buy milk.");

        const usage = readUsage(`${home}/usage.jsonl`).filter((r) => r.role === "turn");
        expect(usage.map((r) => [r.engine, r.auth, r.failoverFrom, r.device])).toEqual([
          ["claude-code", "claude-max", null, "macbook"],
          ["openai-plan", "chatgpt-pro", "claude-code:opus", "macbook"],
          ["openai-plan", "chatgpt-pro", "claude-code:opus", "macbook"],
        ]);

        // what reached the Responses API: claude's exact system prompt, the view then the text, read-only tools
        const [first, second] = fake.state.seen.map((s) => decodeBody(s.body));
        const turn = readFileSync(`${home}/fake.jsonl`, "utf8").split("\n").flatMap((l) => Option.toArray(decodeStart(l))).find((s) => s.role === "turn" && s.argv.includes("--system-prompt")); // macbook's, not mini's warm one
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
        yield* Effect.promise(async () => until("the second turn", () => c.ended().length === 2));
        expect(c.ended()[1]?.type).toBe("RUN_FINISHED");
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

        // a limit after partial output: what claude logged stays, once, and openai-plan is told to carry on from it
        writeFileSync(`${home}/script.json`, JSON.stringify({ turn: [[{ text: "Starting on it." }, { result: { is_error: true, text: "Claude AI usage limit reached" } }]] }));
        fake.state.seen.length = 0;
        fake.state.script = [{ text: "Done." }];
        c.send("tidy up");
        yield* Effect.promise(async () => until("the third turn", () => c.ended().length === 3));
        expect((yield* Effect.promise(log)).slice(10)).toEqual([
          ["user", "tidy up"],
          ["talk", "Starting on it."],
          ["talk", "Done."],
        ]);
        expect(c.infos().at(-1)).toContain("(after 1 logged entries; openai-plan:gpt-sol carries on from them)");
        const resumed = decodeBody(fake.state.seen[0]?.body ?? "").input[0]?.content ?? "";
        const said = Schema.is(Schema.String)(resumed) ? resumed : (resumed.at(-1)?.text ?? "");
        expect(said).toStartWith("tidy up\n\n[optchat: another engine began this turn");
        expect(said).toEndWith("\ntalk: Starting on it.");
        c.ws.close();
      }),
    ),
  );
}, 30_000);
