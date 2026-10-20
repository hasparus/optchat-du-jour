// The /ws heartbeat (HEARTBEAT, docs/uniichat.md): a connection that has been told nothing for a
// while is sent the state as it is now, a STATE_DELTA that every client decodes, the REPL's and
// the web app's of today alike, so a client can tell a quiet socket from a dead one
// (web/src/lib/connection.ts SILENT_MS). No model, no claude.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseInbound } from "../cli/repl.ts";
import { serverLayer } from "../server/app.ts";
import { HEARTBEAT, parseSettings } from "../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { freePort } from "./ports.ts";

const home = realpathSync(mkdtempSync(`${tmpdir()}/oh-`));
afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const Frame = Schema.fromJsonString(Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.Array(Schema.Struct({ op: Schema.String, path: Schema.String }))) }));
const decodeFrame = Schema.decodeUnknownSync(Frame);

// every frame a /ws client gets in its first `ms`, sending nothing
const listen = async (url: string, ms: number) => {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  ws.addEventListener("message", (m) => {
    frames.push(String(m.data));
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve, { once: true });
  });
  await Bun.sleep(ms);
  ws.close();
  return frames;
};

test("a quiet /ws connection gets the state as a STATE_DELTA every heartbeat, which an old client decodes", async () => {
  expect(HEARTBEAT).toBe("5 seconds");
  const port = freePort();
  const settings = parseSettings({
    openai: DEFAULT_ENDPOINTS,
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [home], url: "http://127.0.0.1:9" } },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port },
  });
  const server = serverLayer({ device: "mini", heartbeat: "60 millis", home, host: "127.0.0.1", port, settings, summarize: () => Effect.succeed("a line") });
  const frames = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(server);
        return yield* Effect.promise(async () => listen(`ws://127.0.0.1:${port}/ws`, 500));
      }),
    ),
  );
  const types = frames.map((f) => decodeFrame(f).type);
  // the greeting, then beats: nothing happened but the priming a connection starts, which fails
  // here (no claude in tests) and is said once
  expect(types.slice(0, 2)).toEqual(["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT"]);
  const beats = frames.slice(2).filter((f) => decodeFrame(f).type !== "CUSTOM");
  expect(frames.length - 2 - beats.length).toBeLessThanOrEqual(1);
  expect(beats.length).toBeGreaterThanOrEqual(4);
  for (const beat of beats) {
    const frame = decodeFrame(beat);
    expect(frame.type).toBe("STATE_DELTA");
    // only what drifts on its own: the phase's elapsed time (a subagent's, when one runs)
    expect((frame.delta ?? []).map((op) => op.path).filter((p) => p !== "/elapsed")).toEqual([]);
    // the REPL as shipped before the heartbeat reads it (the web app's own test: web/src/lib/lib.test.ts)
    expect(Option.isSome(parseInbound(beat))).toBe(true);
  }
});

// A beat is a take that timed out. Events that come just as a beat is due must still all arrive,
// once each and in order: each take-back of a message the server doesn't hold is answered to every
// client with one `taken-back`, so 120 of them sent around the beat's edge must make 120 answers.
test("events that come around a heartbeat's edge all arrive, once each, in order", async () => {
  const port = freePort();
  const settings = parseSettings({
    openai: DEFAULT_ENDPOINTS,
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [home], url: "http://127.0.0.1:9" } },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port },
  });
  const server = serverLayer({ device: "mini", heartbeat: "15 millis", home: `${home}/edge`, host: "127.0.0.1", port, settings, summarize: () => Effect.succeed("a line") });
  const Answer = Schema.fromJsonString(Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String), value: Schema.optional(Schema.Unknown) }));
  const Taken = Schema.Struct({ clientId: Schema.String });
  const answered = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(server);
        return yield* Effect.promise(async () => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          const ids: string[] = [];
          let beats = 0;
          ws.addEventListener("message", (m) => {
            const e = Schema.decodeUnknownSync(Answer)(String(m.data));
            if (e.name === "taken-back") ids.push(Schema.decodeUnknownSync(Taken)(e.value).clientId);
            if (e.type === "STATE_DELTA") beats++;
          });
          await new Promise((resolve) => {
            ws.addEventListener("open", resolve, { once: true });
          });
          for (let k = 0; k < 120; k++) {
            ws.send(JSON.stringify({ clientId: `c${k}`, type: "take-back" }));
            await Bun.sleep(k % 7 === 0 ? 16 : k % 3); // now and then right as a beat is due
          }
          await Bun.sleep(200);
          ws.close();
          return { beats, ids };
        });
      }),
    ),
  );
  expect(answered.ids).toEqual(Array.from({ length: 120 }, (_, k) => `c${k}`));
  expect(answered.beats).toBeGreaterThan(0); // the beats did come in between
});
