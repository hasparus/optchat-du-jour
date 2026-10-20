// Every client action is done once (E41): a message by the id its client sent it with, known to the
// session from its inbox, the log's `client` keys and the ids taken back, also after a restart;
// every other action by its id, in a server-wide memory of the newest ACTS. A Stop and a resume
// name the run of the turn loop they were for. Through the session, then the real server's /ws and
// POST /api/messages, with no model (the stub claude refuses every turn; the messages are logged
// before it is asked).
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, Layer, PubSub, Schema } from "effect";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { serverLayer } from "../server/app.ts";
import { takeMessage } from "../server/messages.ts";
import { STOP_ALL_LATE, stopEverything } from "../server/routes/ws.ts";
import { openChat } from "../src/chat.ts";
import { ACTS, parseSettings } from "../src/config.ts";
import { makeSeen, receiptOf } from "../src/once.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { makeSession, noMedia } from "../src/session.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { logEntry, newMem } from "../src/tree.ts";
import { newMsg } from "../src/store.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import { MessagesPage, Received, SessionState } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});
const fresh = () => {
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/oo-`));
  dirs.push(dir);
  return dir;
};

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

test("the seen ids are bounded: past the bound the oldest is forgotten, and an id seen again keeps its place", () => {
  const seen = makeSeen(3);
  expect(["a", "b", "c"].map((id) => seen.add(id))).toEqual([true, true, true]);
  expect(seen.add("a")).toBe(false); // a repeat, kept where it was: still the oldest
  expect(seen.add("d")).toBe(true);
  expect(seen.size()).toBe(3);
  expect(["a", "b", "c", "d"].map((id) => seen.has(id))).toEqual([false, true, true, true]);
  expect(seen.add("a")).toBe(true); // forgotten: new again
});

test("a message id names what the session holds: held in the inbox, logged at its index (the log's own index of its ids), taken back", () => {
  const mem = newMem();
  for (let i = 0; i < 1000; i++) logEntry(mem, i === 3 ? { ...newMsg(3, "user", "early"), client: "early" } : i === 998 ? { ...newMsg(998, "user", "late"), client: "late" } : newMsg(i, "talk", `m${i}`));
  logEntry(mem, { ...newMsg(1000, "talk", "not a message"), client: "talk" }); // only a user entry is a client's message
  expect([...mem.clients]).toEqual([
    ["early", 3],
    ["late", 998],
  ]);
  const taken = makeSeen(ACTS);
  taken.add("gone");
  const inbox = [{ clientId: "waiting", described: null, device: null, engine: "x", media: [], seq: 1, state: "held" as const, steer: true, text: "w" }];
  const of = (id: string) => receiptOf(id, { inbox, logged: mem.clients, taken });
  expect(["waiting", "early", "late", "gone", "talk", "never"].map(of)).toEqual([{ type: "held" }, { at: 3, type: "logged" }, { at: 998, type: "logged" }, { type: "taken-back" }, null, null]);
});

// a session over a chat in `dir` whose turns wait on `gate` (none: they end at once), or run as
// `run` says; what it tells its clients is kept
const rig = (dir: string, gate?: Deferred.Deferred<true>, run?: TurnEngine["run"]) =>
  Effect.gen(function* () {
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const engine: TurnEngine = { ref: "fake:x", run: run ?? (() => (gate ? Deferred.await(gate) : Effect.void)), vision: false, warm: () => Effect.void };
    const session = yield* makeSession({ chat, commit: Effect.succeed(null), defaultDevice: "mini", devices: ["mini"], engines: [engine], idle: "1 hour", logUsage: () => Effect.void, media: noMedia });
    const infos: string[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => (e.type === "info" ? infos.push(e.message) : 0))),
      Effect.forever,
      Effect.forkScoped,
    );
    return { chat, infos, session };
  });

test("a message sent again is answered and never taken twice: while held, once logged, once taken back, and after a restart", async () => {
  const dir = fresh();
  const at = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<true>();
      const { chat, session } = yield* rig(dir, gate);
      expect(yield* session.input("first", { clientId: "c1" })).toEqual({ type: "new" });
      yield* until("the run", () => session.state().phase === "running" && chat.mem.root.length === 1);
      // a second message waits for the turn; sent again (another socket, another tab), it is one
      expect(yield* session.input("second", { clientId: "c2", followUp: "queue" })).toEqual({ type: "new" });
      expect(yield* session.input("second", { clientId: "c2", followUp: "queue" })).toEqual({ type: "held" });
      expect(session.state().pending.map((p) => p.clientId)).toEqual(["c2"]);
      expect(yield* session.input("first", { clientId: "c1" })).toEqual({ at: 0, type: "logged" });
      // taken back, it is not taken again either
      expect(yield* session.input("third", { clientId: "c3", followUp: "queue" })).toEqual({ type: "new" });
      yield* session.takeBack("c3");
      expect(yield* session.input("third", { clientId: "c3", followUp: "queue" })).toEqual({ type: "taken-back" });
      yield* Deferred.succeed(gate, true);
      yield* until("the second turn", () => chat.mem.root.length === 2 && session.state().phase === "idle");
      expect(chat.mem.root.map((e) => [e.text, e.client])).toEqual([
        ["first", "c1"],
        ["second", "c2"],
      ]);
      return (yield* session.input("second", { clientId: "c2" })).type === "logged" ? 1 : -1;
    }).pipe(Effect.scoped),
  );
  expect(at).toBe(1);
  // the log line keeps the id after the reference's keys
  const day = readdirSync(`${dir}/chat/main`)[0] ?? "";
  expect(readFileSync(`${dir}/chat/main/${day}`, "utf8")).toContain('"text":"second","size":12,"date":');
  expect(readFileSync(`${dir}/chat/main/${day}`, "utf8")).toContain('Z","device":"mini","client":"c2"}\n');
  // a restart: the ids are read from the log, not from memory
  await Effect.runPromise(
    Effect.gen(function* () {
      const { chat, session } = yield* rig(dir);
      expect(yield* session.input("first", { clientId: "c1" })).toEqual({ at: 0, type: "logged" });
      expect(yield* session.input("second", { clientId: "c2" })).toEqual({ at: 1, type: "logged" });
      expect(yield* session.input("fourth", { clientId: "c4" })).toEqual({ type: "new" });
      yield* until("logged", () => chat.mem.root.length === 3);
      expect(chat.mem.root.map((e) => e.text)).toEqual(["first", "second", "fourth"]);
    }).pipe(Effect.scoped),
  );
});

test("a Stop names the run of the turn loop it was for: one for a run that ended does nothing while a later one runs, and says so", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // each turn waits for its own gate
      const gate = yield* Deferred.make<true>();
      const next = yield* Deferred.make<true>();
      let turns = 0;
      const { chat, session } = yield* rig(fresh(), undefined, () => Deferred.await(turns++ === 0 ? gate : next));
      expect(yield* session.stop(session.state().loop)).toBe("not stopped: the turn it was for has ended"); // nothing ever ran
      yield* session.input("one", { clientId: "a" });
      yield* until("the first turn", () => session.state().phase === "running" && chat.mem.root.length === 1);
      const first = session.state().loop ?? -1;
      expect(first).toBeGreaterThan(0);
      yield* Deferred.succeed(gate, true);
      yield* until("idle", () => session.state().phase === "idle");
      // the user pressed Stop on the first turn; it arrives after a reconnect, as the next one runs
      yield* session.input("two", { clientId: "b" });
      yield* until("the next turn", () => session.state().phase === "running" && chat.mem.root.length === 2);
      const now = session.state().loop;
      expect(now).toBe(first + 1);
      expect(yield* session.stop(first)).toBe("not stopped: the turn it was for has ended");
      yield* Effect.sleep("30 millis");
      expect(session.state().phase).toBe("running");
      expect(yield* session.stop(now)).toBeNull();
      yield* until("stopped", () => session.state().phase === "idle");
      yield* Deferred.succeed(next, true);
    }).pipe(Effect.scoped),
  );
});

test("Stop all names the run of the turn loop it was for: once a newer one began it does nothing at all, subagents included; for the newest, running or ended, it stops them", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { chat, session } = yield* rig(fresh());
      let stops = 0;
      const subagents = { stopAll: Effect.sync(() => ((stops += 1), [])) };
      yield* session.input("one", { clientId: "a" });
      yield* until("idle", () => session.state().phase === "idle" && chat.mem.root.length === 1);
      const first = session.state().loop;
      expect(yield* stopEverything(session, subagents, first)).toBeNull(); // the turn has ended; its subagents still stop
      expect(stops).toBe(1);
      yield* session.input("two", { clientId: "b" });
      yield* until("idle again", () => session.state().phase === "idle" && chat.mem.root.length === 2);
      expect(yield* stopEverything(session, subagents, first)).toBe(STOP_ALL_LATE);
      expect(stops).toBe(1);
    }).pipe(Effect.scoped),
  );
});

test("a resume names the run of the turn loop whose stop it settles: one for an earlier run is not resumed, and says so", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { chat, infos, session } = yield* rig(fresh(), undefined, () => Effect.fail(new UsageLimit({ message: "spent" })));
      yield* session.input("one", { clientId: "a" });
      yield* until("stopped for a model", () => session.state().phase === "needs-model");
      const stale = (session.state().loop ?? 0) - 1;
      yield* session.resume("fake:x", stale);
      yield* until("said", () => infos.some((i) => i.startsWith("not resumed")));
      expect(session.state().phase).toBe("needs-model");
      yield* session.resume("fake:x", session.state().loop);
      yield* until("tried again", () => infos.some((i) => i.includes("tried again")));
      expect(chat.mem.root).toHaveLength(1);
      yield* session.stop();
    }).pipe(Effect.scoped),
  );
});

test("a Stop resent after a restart never names a run of the new server's loop", async () => {
  const dir = fresh();
  const before = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<true>();
      const { chat, session } = yield* rig(dir, gate);
      yield* session.input("one", { clientId: "a" });
      yield* until("its turn", () => session.state().phase === "running" && chat.mem.root.length === 1);
      return session.state().loop;
    }).pipe(Effect.scoped),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<true>();
      const { chat, session } = yield* rig(dir, gate);
      yield* session.input("after the restart", { clientId: "b" });
      yield* until("its turn", () => session.state().phase === "running" && chat.mem.root.length === 2);
      expect(session.state().loop).not.toBe(before);
      expect(yield* session.stop(before)).toBe("not stopped: the turn it was for has ended");
      expect(session.state().phase).toBe("running");
    }).pipe(Effect.scoped),
  );
});

test("a Stop that comes before the loop's fiber has started still ends the loop", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<true>();
      const { session } = yield* rig(fresh(), gate);
      yield* session.input("one", { clientId: "a" });
      expect(yield* session.stop(session.state().loop)).toBeNull(); // no yield since the fork
      yield* until("idle", () => session.state().phase === "idle");
    }).pipe(Effect.scoped),
  );
});

test("the session closes while a turn runs and a message is held: the held one is logged, and nothing hangs", async () => {
  const dir = fresh();
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<true>();
      const { chat, session } = yield* rig(dir, gate);
      yield* session.input("one", { clientId: "a" });
      yield* until("its turn", () => session.state().phase === "running" && chat.mem.root.length === 1);
      yield* session.input("two", { clientId: "b", followUp: "queue" });
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")),
  );
  const reopened = await Effect.runPromise(Effect.scoped(openChat(dir, { summarize: () => Effect.succeed("s") })));
  expect(reopened.mem.root.map((e) => [e.text, e.client])).toEqual([
    ["one", "a"],
    ["two", "b"],
  ]);
});

test("a message left with nothing to send (a photo the server doesn't hold, no text) is refused with why: not held, not logged, and looked at again when sent again", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { chat, infos, session } = yield* rig(fresh());
      const photoOnly = { attachments: [{ kind: "image", sha: "f".repeat(64) }], id: "p-1", text: "" };
      const refused: Received = { error: "nothing to send: image ffffffffffff is not on the server", id: "p-1", messageId: null, outcome: "refused" };
      expect(yield* takeMessage(session, { find: () => null }, photoOnly)).toEqual(refused);
      expect(yield* takeMessage(session, { find: () => null }, photoOnly)).toEqual(refused);
      expect(yield* takeMessage(session, { find: () => null }, { attachments: [], id: "p-2", text: " " })).toEqual({ error: "nothing to send", id: "p-2", messageId: null, outcome: "refused" });
      yield* Effect.sleep("20 millis");
      expect(session.state().pending).toEqual([]);
      expect(session.state().phase).toBe("idle");
      expect(chat.mem.root).toEqual([]);
      expect(infos).toEqual([]); // the refusal is its sender's alone
      // with text beside it, the photo is left out and said, and the text is taken
      expect(yield* takeMessage(session, { find: () => null }, { ...photoOnly, id: "p-3", text: "and this" })).toEqual({ id: "p-3", messageId: null, outcome: "taken" });
      yield* until("logged", () => chat.mem.root.length === 1);
      expect(infos).toEqual(["image ffffffffffff is not on the server: left out of the message"]);
    }).pipe(Effect.scoped),
  );
});

test("Stop all after a loop that only logged a subagent's report does nothing, and says the session moved on, not that a turn began", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let turns = 0;
      const { chat, session } = yield* rig(fresh(), undefined, () => Effect.sync(() => void (turns += 1)));
      let stops = 0;
      const subagents = { stopAll: Effect.sync(() => ((stops += 1), [])) };
      yield* session.input("one", { clientId: "a" });
      yield* until("idle", () => session.state().phase === "idle" && chat.mem.root.length === 1);
      const seen = session.state().loop;
      yield* session.report("[Scout] found it"); // M7a: logged by a loop of its own, which runs no turn
      yield* until("idle again", () => session.state().phase === "idle" && chat.mem.root.length === 2);
      expect(turns).toBe(1);
      expect(session.state().loop).not.toBe(seen);
      expect(yield* stopEverything(session, subagents, seen)).toBe("not stopped: the session moved on since; look again");
      expect(STOP_ALL_LATE).not.toContain("turn");
      expect(stops).toBe(0);
    }).pipe(Effect.scoped),
  );
});

// ---------------------------------------------------------------------------------------------
// the real server: /ws and POST /api/messages

const settingsFor = (home: string, port: number) =>
  parseSettings({
    openai: DEFAULT_ENDPOINTS,
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [home], url: "http://127.0.0.1:9" } },
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port },
  });

// the server on `home` for as long as `body` runs
const serving = async <A>(home: string, body: (host: string) => Promise<A>) => {
  const port = freePort();
  const layer = serverLayer({ device: "mini", home, host: "127.0.0.1", port, settings: settingsFor(home, port), summarize: () => Effect.succeed("a line") });
  return Effect.runPromise(Effect.scoped(Layer.build(layer).pipe(Effect.andThen(Effect.promise(async () => body(`127.0.0.1:${port}`))))));
};

const Frame = Schema.fromJsonString(Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String), value: Schema.optional(Schema.Unknown) }));
const decodeFrame = Schema.decodeUnknownSync(Frame);
const decodeReceived = Schema.decodeUnknownSync(Received);
const decodePage = Schema.decodeUnknownSync(MessagesPage);

// a /ws client that keeps every CUSTOM event it gets, by name
const socket = async (host: string) => {
  const ws = new WebSocket(`ws://${host}/ws`);
  const custom: { readonly name: string; readonly value: unknown }[] = [];
  ws.addEventListener("message", (m) => {
    const e = decodeFrame(String(m.data));
    if (e.type === "CUSTOM" && e.name !== undefined) custom.push({ name: e.name, value: e.value });
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve, { once: true });
  });
  const received = () => custom.flatMap((e) => (e.name === "received" ? [decodeReceived(e.value)] : []));
  const named = (name: string) => custom.filter((e) => e.name === name);
  const wait = async (ok: () => boolean) => {
    for (let k = 0; k < 400 && !ok(); k++) await Bun.sleep(10);
    if (!ok()) throw new Error(`timed out; got ${JSON.stringify(custom)}`);
  };
  return { named, received, wait, ws };
};
// a take-back of a message the server doesn't hold: every client is told it couldn't be, once per take-back done
const takeBack = (id: string) => JSON.stringify({ clientId: "nobody", id, type: "take-back" });
// a RunAgentInput with one user message, and with `photo` an image part naming that upload
const message = (id: string, text: string, photo?: string) => {
  const content = photo === undefined ? text : [{ text, type: "text" }, { source: { type: "url", value: `asset:${photo}` }, type: "image" }];
  return JSON.stringify({ messages: [{ content, id, role: "user" }], runId: crypto.randomUUID(), threadId: "t" });
};
const logOf = async (host: string) => {
  const res = await fetch(`http://${host}/api/messages?limit=1000`);
  return decodePage(await res.json()).entries;
};

test("over /ws a message sent again on another socket, and after a restart, is answered as logged and logged once", async () => {
  const home = fresh();
  await serving(home, async (host) => {
    const a = await socket(host);
    const b = await socket(host);
    const missing = "f".repeat(64); // a photo the server doesn't hold: left out, and said
    a.ws.send(message("m-1", "hello once", missing));
    await a.wait(() => a.named("ack").length > 0);
    expect(a.received()).toEqual([{ id: "m-1", messageId: null, outcome: "taken" }]);
    // the socket that sent it dropped before the receipt, say: the page sends it again on its next
    b.ws.send(message("m-1", "hello once", missing));
    await b.wait(() => b.received().length > 0);
    expect(b.received()).toEqual([{ id: "m-1", messageId: "0", outcome: "logged" }]);
    // a repeat is answered and nothing more: what was said of its photo is said once
    expect(b.named("info").filter((e) => String(e.value).includes("is not on the server"))).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });
  await serving(home, async (host) => {
    const c = await socket(host);
    c.ws.send(message("m-1", "hello once"));
    await c.wait(() => c.received().length > 0);
    expect(c.received()).toEqual([{ id: "m-1", messageId: "0", outcome: "logged" }]);
    const log = await logOf(host);
    expect(log.map((e) => [e.text, e.client])).toEqual([["hello once", "m-1"]]);
    c.ws.close();
  });
}, 20_000);

test("over /ws any other action is done once by its id, whichever socket sends it again, within the newest ACTS ids", async () => {
  await serving(fresh(), async (host) => {
    const a = await socket(host);
    const b = await socket(host);
    a.ws.send(takeBack("t-1"));
    b.ws.send(takeBack("t-1"));
    a.ws.send(takeBack("t-1"));
    await a.wait(() => a.received().length === 2);
    await b.wait(() => b.received().length === 1);
    expect(a.received().map((r) => r.outcome)).toEqual(["taken", "done"]);
    expect(b.received().map((r) => r.outcome)).toEqual(["done"]);
    expect(a.named("taken-back")).toHaveLength(1);
    // past ACTS newer ids, it is forgotten: done again
    for (let k = 0; k < ACTS; k++) a.ws.send(takeBack(`n-${k}`));
    a.ws.send(takeBack("t-1"));
    await a.wait(() => a.received().length === ACTS + 3);
    expect(a.received().at(-1)).toEqual({ id: "t-1", messageId: null, outcome: "taken" });
    // a frame that doesn't decode is answered by its id, so its client stops sending it
    a.ws.send(JSON.stringify({ id: "odd-1", type: "from-the-future" }));
    await a.wait(() => a.received().some((r) => r.id === "odd-1"));
    expect(a.received().find((r) => r.id === "odd-1")?.outcome).toBe("refused"); // dropped undone, and said so
    a.ws.close();
    b.ws.close();
  });
}, 30_000);

test("over /ws and POST /api/messages a photo-only message whose photo the server doesn't hold is refused with why, held nowhere and logged nowhere", async () => {
  await serving(fresh(), async (host) => {
    const missing = "f".repeat(64);
    const why = "nothing to send: image ffffffffffff is not on the server";
    const a = await socket(host);
    a.ws.send(message("e-1", "", missing));
    await a.wait(() => a.received().length > 0);
    expect(a.received()).toEqual([{ error: why, id: "e-1", messageId: null, outcome: "refused" }]);
    const res = await fetch(`http://${host}/api/messages`, {
      body: JSON.stringify({ attachments: [{ kind: "image", sha: missing }], id: "e-2", text: "" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect(decodeReceived(await res.json())).toEqual({ error: why, id: "e-2", messageId: null, outcome: "refused" });
    const state = await fetch(`http://${host}/api/state`);
    expect(Schema.decodeUnknownSync(SessionState)(await state.json()).pending).toEqual([]);
    expect(await logOf(host)).toEqual([]);
    expect(a.named("ack")).toEqual([]);
    a.ws.close();
  });
}, 20_000);

test("POST /api/messages takes a message once by its id: a retry is told what became of it; a bad body or nothing to send is a 400, a foreign Origin a 403", async () => {
  await serving(fresh(), async (host) => {
    // what a shortcut posts: a JSON body, some of them wrong on purpose
    const post = async (body: Readonly<Record<string, string>>, headers: Readonly<Record<string, string>> = {}) =>
      fetch(`http://${host}/api/messages`, { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers }, method: "POST" });
    const answer = async (body: Readonly<Record<string, string>>) => {
      const res = await post(body);
      return { body: decodeReceived(await res.json()), status: res.status };
    };
    const shortcut = { id: "sc-1", text: "from a shortcut" };
    expect(await answer(shortcut)).toEqual({ body: { id: "sc-1", messageId: null, outcome: "taken" }, status: 200 });
    let retry = await answer(shortcut);
    for (let k = 0; k < 200 && retry.body.outcome !== "logged"; k++) {
      await Bun.sleep(10);
      retry = await answer(shortcut);
    }
    expect(retry).toEqual({ body: { id: "sc-1", messageId: "0", outcome: "logged" }, status: 200 });
    const statuses = await Promise.all(
      [post({ text: "no id" }), post({ id: "sc-2", text: "  " }), post({ followUp: "sideways", id: "sc-3", text: "x" }), post({ id: "sc-4", text: "x" }, { origin: "https://evil.example" })].map(async (r) => {
        const res = await r;
        return res.status;
      }),
    );
    expect(statuses).toEqual([400, 400, 400, 403]);
    const log = await logOf(host);
    expect(log.map((e) => [e.text, e.client])).toEqual([["from a shortcut", "sc-1"]]);
  });
}, 20_000);
