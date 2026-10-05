// Routing through the real server (SPEC "Multi-machine", E7, E8): a turn sent to another device runs
// on that device's runner, in its folder, with the server's tailnet MCP URL, and its log entries
// say where; a turn sent to an offline device ends at once with a notice. Fake claude, no model.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deviceLayer } from "../device/runner.ts";
import { serverLayer } from "../server/app.ts";
import { CompactError } from "../src/compactor.ts";
import type { Settings } from "../src/config.ts";
import { freePort } from "./ports.ts";

const FAKE = new URL("fake-claude.ts", import.meta.url).pathname;
const home = realpathSync(mkdtempSync(`${tmpdir()}/or-`));
afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const Event = Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String), value: Schema.optional(Schema.Json), message: Schema.optional(Schema.String) });
type Event = typeof Event.Type;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const Start = Schema.Struct({ type: Schema.Literal("start"), role: Schema.String, argv: Schema.Array(Schema.String), cwd: Schema.String });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const Entry = Schema.Struct({ kind: Schema.String, text: Schema.String, device: Schema.optional(Schema.String) });
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));

// one turn over /ws: the events from sending it until it ends
const turn = async (url: string, text: string, device: string) => {
  const ws = new WebSocket(url);
  const events: Event[] = [];
  const ended = Promise.withResolvers<string>();
  ws.addEventListener("message", (m) => {
    const e = decodeEvent(String(m.data));
    events.push(e);
    if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") ended.resolve(e.type);
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve, { once: true });
  });
  ws.send(JSON.stringify({ forwardedProps: { device }, messages: [{ content: text, role: "user" }] }));
  await ended.promise;
  ws.close();
  return events;
};

test("a turn on another device runs there, and a turn on an offline device fails at once", async () => {
  const mini = `${home}/mini`, macbook = `${home}/macbook`, log = `${home}/fake.jsonl`;
  mkdirSync(mini);
  mkdirSync(macbook);
  Bun.env.OPTCHAT_CLAUDE = FAKE;
  Bun.env.FAKE_CLAUDE_LOG = log; // the device's claude inherits it: the runner passes on no such env itself
  const port = freePort(), devicePort = freePort();
  const settings: Settings = {
    allowedLogins: [],
    cache: { apiKeyTtls: [], claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: {
      macbook: { folders: [macbook], url: `http://127.0.0.1:${devicePort}` },
      mini: { folders: [mini], url: "http://127.0.0.1:9" },
      offline: { folders: [macbook], url: `http://127.0.0.1:${freePort()}` },
    },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port, publicUrl: `http://localhost:${port}` },
  };
  const trust = { loopback: true, nodes: [], whois: () => Effect.succeed(Option.none<string>()) };
  const both = Layer.mergeAll(
    deviceLayer({ claude: FAKE, folders: [macbook], host: "127.0.0.1", name: "macbook", port: devicePort, trust }),
    serverLayer({
      device: "mini",
      home,
      host: "127.0.0.1",
      port,
      settings,
      summarize: () => Effect.fail(new CompactError({ message: "no compactor in this test" })),
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(both);
        const ws = `ws://127.0.0.1:${port}/ws`;

        const done = yield* Effect.promise(async () => turn(ws, "edit the macbook repo", "macbook"));
        expect(done.at(-1)?.type).toBe("RUN_FINISHED");
        const starts = readFileSync(log, "utf8").split("\n").flatMap((l) => Option.toArray(decodeStart(l)));
        const there = starts.find((s) => s.role === "turn");
        expect(there?.cwd).toBe(macbook);
        const argv = there?.argv ?? [];
        expect(argv[argv.indexOf("--mcp-config") + 1]).toContain(`"url":"http://localhost:${port}/mcp?key=`);
        expect(argv).toContain("--system-prompt"); // the server's file, inlined
        expect(argv).not.toContain("--system-prompt-file");

        const day = readdirSync(`${home}/streams/mini/chat/main`)[0];
        const entries = readFileSync(`${home}/streams/mini/chat/main/${day}`, "utf8").trim().split("\n").map((l) => decodeEntry(l));
        expect(entries.map((e) => [e.kind, e.device])).toEqual([
          ["user", "macbook"],
          ["talk", "macbook"],
        ]);

        const t0 = Date.now();
        const failed = yield* Effect.promise(async () => turn(ws, "and now offline", "offline"));
        expect(Date.now() - t0).toBeLessThan(3000);
        expect(failed.at(-1)?.type).toBe("RUN_ERROR");
        const notices = failed.flatMap((e) => (e.name === "info" && Schema.is(Schema.String)(e.value) ? [e.value] : []));
        expect(notices.some((n) => n.startsWith("device offline: offline: no device runner"))).toBe(true);

        const devices = yield* Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/devices`);
          return response.text();
        });
        expect(devices).toContain('"name":"macbook","online":true');
        expect(devices).toContain('"name":"offline","online":false');
      }),
    ),
  );
}, 20_000);
