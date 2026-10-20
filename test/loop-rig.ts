// A session over a fresh chat whose one engine is our tool loop on a scripted provider (no model,
// no network), and every event it publishes, for tests of what a turn on our HTTP engines tells
// its clients: test/busy.test.ts (E43), test/live-input.test.ts (E45).
import { afterAll } from "bun:test";
import { Effect, PubSub } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import type { Provider } from "../src/providers/provider.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { toolLoop } from "../src/turn/loop.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

export const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

export const USAGE = { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 };

export const rig = (provider: Provider) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const engine = toolLoop({ instructions: "MASTER", provider, ref: "api-key:x", toolsFor: () => ({ defs: [], run: () => Effect.die(new Error("no tools here")) }), vision: false });
    const session = yield* makeSession({
      chat,
      commit: Effect.succeed(null),
      defaultDevice: "mini",
      devices: ["mini"],
      engines: [engine],
      choices: {},
      idle: "1 hour",
      logUsage: () => Effect.void,
      media: noMedia,
      waitRetry: "1 hour",
      wake: null,
    });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const states = () => events.flatMap((e) => (e.type === "state" ? [e.state] : []));
    const idleAfter = (n: number) => states().slice(n).some((s) => s.phase === "idle");
    return { events, idleAfter, session, states };
  });
