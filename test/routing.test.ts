// Routing through the real server (SPEC "Multi-machine", E7, E8): a turn sent to another device runs
// on that device's runner, in its folder, with the server's tailnet MCP URL, and its log entries
// say where; that claude's /mcp calls come through tailscale serve; a turn sent to an offline
// device ends at once with one notice; without server.publicUrl no turn leaves this machine.
// Fake claude, no model.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Trust } from "../device/auth.ts";
import { deviceLayer } from "../device/runner.ts";
import { serverLayer } from "../server/app.ts";
import { CompactError } from "../src/compactor.ts";
import type { Settings } from "../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { freePort } from "./ports.ts";

const FAKE = new URL("fake-claude.ts", import.meta.url).pathname;
const home = realpathSync(mkdtempSync(`${tmpdir()}/or-`));
const ME = "me@example.com";
afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const Event = Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String), value: Schema.optional(Schema.Json), message: Schema.optional(Schema.String) });
type Event = typeof Event.Type;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const Start = Schema.Struct({ type: Schema.Literal("start"), pid: Schema.Number, role: Schema.String, argv: Schema.Array(Schema.String), cwd: Schema.String });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const In = Schema.Struct({ type: Schema.Literal("in"), pid: Schema.Number });
const decodeIn = Schema.decodeUnknownOption(Schema.fromJsonString(In));
// the turn processes the fake's log shows a message reached; the server's warm ones wait unused (E18)
const servedTurns = (log: string) => {
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
  const fed = new Set(lines.flatMap((l) => Option.toArray(decodeIn(l))).map((r) => r.pid));
  return lines.flatMap((l) => Option.toArray(decodeStart(l))).filter((s) => s.role === "turn" && fed.has(s.pid));
};
const Entry = Schema.Struct({ kind: Schema.String, text: Schema.String, device: Schema.optional(Schema.String) });
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));
const decodeDevices = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String }))));

const infos = (events: readonly Event[]) => events.flatMap((e) => (e.name === "info" && Schema.is(Schema.String)(e.value) ? [e.value] : []));

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
  ws.send(JSON.stringify({ forwardedProps: { device }, messages: [{ content: text, id: crypto.randomUUID(), role: "user" }] }));
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
  const strangerPort = freePort();
  const settings: Settings = {
    openai: DEFAULT_ENDPOINTS,
    allowedLogins: [ME],
    cache: { apiKeyTtls: [], claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: {
      macbook: { folders: [macbook], url: `http://127.0.0.1:${devicePort}` },
      mini: { folders: [mini], url: "http://127.0.0.1:9" },
      offline: { folders: [macbook], url: `http://127.0.0.1:${freePort()}` },
      stranger: { folders: [macbook], url: `http://127.0.0.1:${strangerPort}` },
    },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port, publicUrl: `http://localhost:${port}` },
  };
  const trust: Trust = { _tag: "loopback" };
  // a runner that doesn't know the server's node: up, but it answers 403
  const strict: Trust = { _tag: "tailnet", names: ["optchat-mini.tail1234.ts.net"], whois: () => Effect.succeed(Option.none()) };
  const both = Layer.mergeAll(
    deviceLayer({ claude: FAKE, folders: [macbook], host: "127.0.0.1", name: "macbook", port: devicePort, trust }),
    deviceLayer({ claude: FAKE, folders: [macbook], host: "127.0.0.1", name: "stranger", port: strangerPort, trust: strict }),
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
        const [there] = servedTurns(log);
        expect(there?.cwd).toBe(macbook);
        const argv = there?.argv ?? [];
        expect(argv[argv.indexOf("--mcp-config") + 1]).toContain(`"type":"ws","url":"ws://localhost:${port}/mcp?key=`);
        expect(argv).toContain("--system-prompt"); // the server's file, inlined
        expect(argv).not.toContain("--system-prompt-file");

        // that claude calls /mcp at publicUrl, i.e. through tailscale serve, which adds the caller's
        // login: the key in the URL and allowedLogins let it in, not WhoIs
        const key = /key=([^"&]+)/.exec(argv[argv.indexOf("--mcp-config") + 1] ?? "")?.[1] ?? "";
        const mcp = (k: string, login: string) =>
          Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/mcp?key=${k}`, {
              body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
              headers: { "Content-Type": "application/json", "Tailscale-User-Login": login, "Tailscale-User-Name": "Me", "X-Forwarded-For": "100.64.0.2" },
              method: "POST",
            });
            return response.status;
          });
        expect(yield* mcp(key, ME)).toBe(200);
        expect(yield* mcp(key, "eve@example.com")).toBe(403);
        expect(yield* mcp("guess", ME)).toBe(403);

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
        // priming found it offline first; the turn fails on that verdict, and says so once
        const notices = infos(failed).filter((n) => n.includes("offline: no device runner"));
        expect(notices).toHaveLength(1);
        expect(notices[0]).toStartWith("device offline: offline: no device runner");
        expect(infos(failed).filter((n) => n.startsWith("priming failed"))).toEqual([]);

        const devices = yield* Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/devices`);
          return response.text();
        });
        const statuses = Object.fromEntries(decodeDevices(devices).map((d) => [d.name, d.status]));
        expect(statuses).toEqual({ macbook: "online", mini: "online", offline: "offline", stranger: "refused" });
      }),
    ),
  );
}, 20_000);

test("without server.publicUrl a turn on another device is refused at once, and its claude never starts", async () => {
  const dir = `${home}/private`, log = `${home}/private.jsonl`;
  mkdirSync(dir);
  Bun.env.OPTCHAT_CLAUDE = FAKE;
  Bun.env.FAKE_CLAUDE_LOG = log;
  const port = freePort(), devicePort = freePort();
  const settings: Settings = {
    openai: DEFAULT_ENDPOINTS,
    allowedLogins: [],
    cache: { apiKeyTtls: [], claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: {
      macbook: { folders: [dir], url: `http://127.0.0.1:${devicePort}` },
      mini: { folders: [dir], url: "http://127.0.0.1:9" },
    },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port },
  };
  const both = Layer.mergeAll(
    deviceLayer({ claude: FAKE, folders: [dir], host: "127.0.0.1", name: "macbook", port: devicePort, trust: { _tag: "loopback" } }),
    serverLayer({ device: "mini", home: dir, host: "127.0.0.1", port, settings, summarize: () => Effect.fail(new CompactError({ message: "none" })) }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(both);
        const failed = yield* Effect.promise(async () => turn(`ws://127.0.0.1:${port}/ws`, "edit the macbook repo", "macbook"));
        expect(failed.at(-1)?.type).toBe("RUN_ERROR");
        expect(infos(failed)).toContain("device offline: macbook: server.publicUrl is not set, so claude there could not reach zoom and date");
        expect(servedTurns(log)).toEqual([]);
      }),
    ),
  );
}, 20_000);
