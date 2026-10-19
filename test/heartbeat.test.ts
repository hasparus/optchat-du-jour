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
