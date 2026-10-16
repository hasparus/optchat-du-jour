// Subagents (SPEC M7a) with scripted engines: spawn from a turn, the cap, the models (the turn's
// by default, the master's pick, the user's), tell, stop, the report in the chat as "[Name] …",
// the side log on disk and committed, zoom("Name"), the usage records, a restart that cut a run
// short, and the chat's own log and tree, which see nothing of a subagent's work but its report.
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, PubSub, Schema, type Scope } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { entryLabel, parseSettings, type Ref } from "../src/config.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { makeMaster } from "../src/master.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { makeSubagents, SIDE_PAGE, type SubagentHost, SUBAGENTS_AT_ONCE } from "../src/subagents.ts";
import type { TurnEngine, TurnEvents, TurnInput } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

const SETTINGS = parseSettings({
  allowedLogins: [],
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["claude-code:haiku"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: ["/tmp"], url: "http://127.0.0.1:1" } },
  master: { chain: ["claude-code:opus", "claude-code:claude-opus-4-5", "claude-code:haiku@low"], effort: "high", permissionMode: "bypassPermissions" },
});
const CHAIN = SETTINGS.master.chain;

// What a subagent's engine does in one call: `calls` counts its calls, `input` is the call's input
type Child = (input: TurnInput, out: TurnEvents, call: number) => Effect.Effect<void, UsageLimit>;
// a call that reads, then answers `reply`
const answers =
  (reply: string): Child =>
  (_input, out) =>
    Effect.gen(function* () {
      yield* out.log("tool", 'Read {"file_path":"/tmp/notes.md"}');
      yield* out.log("echo", "the notes");
      yield* out.log("talk", reply);
      yield* out.usage(usageOf());
    }).pipe(Effect.orDie);

// a side log's line, and agent.json, as a test reads them
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ i: Schema.Number, kind: Schema.String, text: Schema.String })));
const decodeMeta = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ state: Schema.String, ref: Schema.String, reported: Schema.Boolean, why: Schema.NullOr(Schema.String) })));

const usageOf = (): UsageRecord => ({
  attempt: 1,
  auth: "claude-max",
  cold: false,
  date: new Date().toISOString(),
  device: "mini",
  effort: "high",
  engine: "claude-code",
  failoverFrom: null,
  level: null,
  model: "opus",
  ms: 1,
  role: "turn",
  usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 },
});

// A session over a fresh chat (or `dir`'s), with the subagents beside it as the server wires them.
// The master's engine runs `master(tools)` in its turn: what the model would call there.
const rig = (o: {
  readonly scope: Scope.Scope;
  readonly dir?: string;
  readonly master?: (call: (tool: "spawn" | "tell", args: Record<string, string>) => Effect.Effect<{ readonly text: string; readonly error: boolean }>) => Effect.Effect<void>;
  readonly child?: Record<string, Child>;
}) =>
  Effect.gen(function* () {
    const dir = o.dir ?? mkdtempSync(`${tmpdir()}/oc-sub-`);
    if (!o.dir) dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const events = yield* PubSub.unbounded<SessionEvent>();
    const said: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => said.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const usage: UsageRecord[] = [];
    const counts = { commits: 0 };
    const commit = Effect.sync(() => ((counts.commits += 1), null));
    // every call of a subagent's engine: on which ref, at which effort, with what input
    const calls: { readonly ref: string; readonly effort: string | undefined; readonly name: string; readonly input: TurnInput }[] = [];
    const host = yield* Deferred.make<SubagentHost>();
    const engineOf = (ref: Ref): TurnEngine => ({
      ref: ref.ref,
      run: (input, out) =>
        Effect.suspend(() => {
          const name = /subagent "([^"]+)"/.exec(input.texts[0] ?? "")?.[1] ?? "?";
          calls.push({ effort: ref.effort, input, name, ref: ref.ref });
          const mine = calls.filter((c) => c.name === name).length;
          return (o.child?.[name] ?? answers(`${name} found it`))(input, out, mine);
        }),
      vision: false,
      warm: () => Effect.void,
    });
    const subagents = yield* makeSubagents({
      chain: CHAIN,
      commit,
      device: "mini",
      dir,
      effort: "high",
      engine: (ref) => Effect.succeed(engineOf(ref)),
      host,
      logUsage: (r) => Effect.sync(() => usage.push(r)),
      mem: chat.mem,
      publish: (e) => PubSub.publish(events, e).pipe(Effect.asVoid),
    });
    const masterEngine = (ref: string): TurnEngine => ({
      ref,
      run: (_input, out) =>
        Effect.gen(function* () {
          if (o.master) yield* o.master((tool, args) => subagents.tools("master").call(tool, args));
          yield* out.log("talk", "the master answers");
        }),
      vision: false,
      warm: () => Effect.void,
    });
    const master = yield* makeMaster(
      CHAIN.map((r) => ({ label: entryLabel(r, "high"), ref: r.ref })),
      "high",
    );
    const session = yield* makeSession({
      chat,
      commit,
      defaultDevice: "mini",
      devices: ["mini"],
      engines: CHAIN.map((r) => masterEngine(r.ref)),
      events,
      idle: "1 hour",
      logUsage: () => Effect.void,
      master,
      media: noMedia,
      subagents,
      waitRetry: "1 hour",
    });
    yield* Deferred.succeed(host, { lastView: session.lastView, report: session.report, turnNow: session.turnNow });
    yield* subagents.restore;
    const log = () => chat.mem.root.map((m) => `${m.kind}: ${m.text}`);
    const idle = () => session.state().phase === "idle";
    const stateOf = (name: string) => session.state().subagents?.find((s) => s.name === name);
    return { calls, chat, counts, dir, idle, log, said, session, stateOf, subagents, usage };
  });

const scoped = async <A, E>(f: (scope: Scope.Scope) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      return yield* f(scope);
    }).pipe(Effect.scoped),
  );

test("spawn starts a read-only run that outlives the turn; its report reaches the chat as [Name] …, and nothing else of it does", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const answers: string[] = [];
      const r = yield* rig({
        master: (call) =>
          Effect.gen(function* () {
            const a = yield* call("spawn", { name: "scout", task: "Find the notes about the trip." });
            answers.push(a.text);
          }),
        scope,
      });
      yield* r.session.input("find my trip notes, with a subagent", { clientId: "c1" });
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [scout] ")));
      expect(answers[0]).toContain('Started scout on Claude Opus (Claude Code)');
      // the chat: the user's message, the master's reply, then the report; the side log's read and echo are not in it
      expect(r.log()).toEqual(["user: find my trip notes, with a subagent", "talk: the master answers", "user: [scout] scout found it"]);
      // nor in its tree: every node is a summary of the chat's own entries
      expect(r.chat.mem.root.some((m) => m.text.includes("the notes"))).toBe(false);
      // the side log, on disk beside chat/: the task, then its steps, each line a log record
      const lines = readFileSync(`${r.dir}/agents/scout/log.jsonl`, "utf8").trim().split("\n").map((l) => decodeLine(l));
      expect(lines.map((l) => `${l.i} ${l.kind}: ${l.text}`)).toEqual([
        "0 user: Find the notes about the trip.",
        '1 tool: Read {"file_path":"/tmp/notes.md"}',
        "2 echo: the notes",
        "3 talk: scout found it",
      ]);
      const meta = decodeMeta(readFileSync(`${r.dir}/agents/scout/agent.json`, "utf8"));
      expect(meta).toMatchObject({ ref: "claude-code:opus", reported: true, state: "done" });
      // committed when its run ended, as the main log is after a turn
      expect(r.counts.commits).toBeGreaterThanOrEqual(2);
      // the state lists it, done, with its model
      yield* until("listed done", () => r.stateOf("scout")?.state === "done");
      expect(r.stateOf("scout")).toMatchObject({ effort: "high", entries: 4, label: "Claude Opus (Claude Code)", lastLine: "talk: scout found it", ref: "claude-code:opus", task: "Find the notes about the trip." });
      // its call started from the turn's view, its opening naming it and its task
      const first = r.calls[0];
      expect(first?.input.view).toStartWith("<chat>");
      expect(first?.input.texts[0]).toContain('You are the subagent "scout"');
      expect(first?.input.texts[0]).toContain("Task: Find the notes about the trip.");
      expect(first?.input.device).toBe("mini");
      // its usage, as a subagent's: its name, ref and effort
      expect(r.usage.map((u) => [u.role, u.subagent, u.ref, u.effort])).toEqual([["subagent", "scout", "claude-code:opus", "high"]]);
      // AG-UI's subagent events went out: started, then finished with the report
      const kinds = () => r.said.flatMap((e) => (e.type.startsWith("subagent-") ? [e.type] : []));
      yield* until("its events", () => kinds().length === 2);
      expect(kinds()).toEqual(["subagent-started", "subagent-finished"]);
    }),
  );
});

test("at most two run at once: a third spawn is refused, naming them; a name is taken once, in any case", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<true>();
      const answers: { text: string; error: boolean }[] = [];
      const blocked: Child = () => Effect.asVoid(Deferred.await(hold));
      const r = yield* rig({
        child: { a: blocked, b: blocked },
        master: (call) =>
          Effect.gen(function* () {
            for (const name of ["a", "b", "c", "A"]) answers.push(yield* call("spawn", { name, task: `task ${name}` }));
          }),
        scope,
      });
      yield* r.session.input("three at once", { clientId: "c1" });
      yield* until("the turn", () => answers.length === 4);
      expect(SUBAGENTS_AT_ONCE).toBe(2);
      expect(answers.map((a) => a.error)).toEqual([false, false, true, true]);
      expect(answers[2]?.text).toContain("2 subagents run already (a, b), at most 2 at once");
      expect(answers[3]?.text).toContain("there is a subagent called a already (running)");
      expect(existsSync(`${r.dir}/agents/c`)).toBe(false);
      yield* Deferred.succeed(hold, true);
      yield* until("both reports", () => r.log().filter((l) => l.startsWith("user: [")).length === 2);
    }),
  );
});

test("the model: the turn's by default, the master's pick (clamped as the master's), an unknown one refused with the allowed list", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const answers: { text: string; error: boolean }[] = [];
      const r = yield* rig({
        master: (call) =>
          Effect.gen(function* () {
            answers.push(
              yield* call("spawn", { model: "claude-code:sonnet", name: "nope", task: "t" }),
              yield* call("spawn", { model: "claude-code:opus@turbo", name: "nope2", task: "t" }),
              yield* call("spawn", { name: "dflt", task: "t" }),
              yield* call("spawn", { model: "claude-code:opus@medium", name: "picked", task: "t" }),
            );
          }),
        scope,
      });
      // the turn runs on Haiku at low, the message's engine: a subagent spawned without a model runs there too
      yield* r.session.input("go", { clientId: "c1", engine: "claude-code:haiku@low" });
      yield* until("two reports", () => r.log().filter((l) => l.startsWith("user: [")).length === 2);
      expect(answers.map((a) => a.error)).toEqual([true, true, false, false]);
      expect(answers[0]?.text).toContain("claude-code:sonnet is not a model of the master's chain (allowed: claude-code:opus, claude-code:claude-opus-4-5, claude-code:haiku@low");
      expect(answers[1]?.text).toContain("turbo is not an effort");
      const by = (name: string) => r.calls.find((c) => c.name === name);
      expect([by("dflt")?.ref, by("dflt")?.effort]).toEqual(["claude-code:haiku@low", "low"]);
      expect([by("picked")?.ref, by("picked")?.effort]).toEqual(["claude-code:opus@medium", "medium"]);
      expect(r.usage.map((u) => [u.subagent, u.ref])).toEqual([
        ["dflt", "claude-code:haiku@low"],
        ["picked", "claude-code:opus@medium"],
      ]);
      // the master's effort is the bare ref; an effort past what the model takes is clamped to its highest (Opus 4.5 stops at high)
      const more: { text: string; error: boolean }[] = [];
      const again = yield* rig({
        master: (call) =>
          Effect.gen(function* () {
            more.push(yield* call("spawn", { model: "claude-code:opus@high", name: "bare", task: "t" }), yield* call("spawn", { model: "claude-code:claude-opus-4-5@max", name: "clamped", task: "t" }));
          }),
        scope,
      });
      yield* again.session.input("go", { clientId: "c1" });
      yield* until("two reports", () => again.log().filter((l) => l.startsWith("user: [")).length === 2);
      expect(more.map((a) => a.error)).toEqual([false, false]);
      expect(again.stateOf("bare")).toMatchObject({ effort: "high", ref: "claude-code:opus" });
      expect(again.stateOf("clamped")).toMatchObject({ effort: "high", ref: "claude-code:claude-opus-4-5" });
    }),
  );
});

test("tell reaches a running subagent between its calls; the user's model pick is its next call's; a tell to one that ended starts it again", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<true>();
      const answers: { text: string; error: boolean }[] = [];
      const r = yield* rig({
        child: {
          scout: (input, out, call) =>
            Effect.gen(function* () {
              if (call === 1) {
                // the first call takes one message mid-run and leaves the second for the next call
                const first = yield* input.mid.next;
                yield* out.took(first);
                yield* Deferred.await(offered);
                yield* out.log("talk", "first pass");
                return;
              }
              yield* out.log("talk", call === 2 ? "second pass" : "third pass");
            }).pipe(Effect.orDie),
        },
        master: (call) => Effect.asVoid(call("spawn", { name: "scout", task: "look around" })),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      // once its first call runs, the master tells it something (a tell before that joins the call's opening)
      yield* until("its call", () => r.calls.length === 1);
      answers.push(yield* r.subagents.tools("master").call("tell", { name: "scout", text: "also check ~/notes" }));
      expect(answers[0]).toEqual({ error: false, text: "Sent to scout; it reads it between its tool calls." });
      // the user's own message from the card, and a new model, while the first call runs
      expect(yield* r.subagents.tell("scout", "and the trip dates")).toBeNull();
      expect(yield* r.subagents.pick("scout", "claude-code:haiku@low")).toBeNull();
      expect(yield* r.subagents.pick("scout", "gpt-9")).toContain("gpt-9 is not a model of the master's chain");
      yield* Deferred.succeed(offered, true);
      yield* until("done", () => r.stateOf("scout")?.state === "done");
      // two calls: the first on Opus, the second (for the message it never took) on the user's pick
      expect(r.calls.map((c) => c.ref)).toEqual(["claude-code:opus", "claude-code:haiku@low"]);
      expect(r.calls[1]?.input.texts[0]).toContain("You worked on this before");
      expect(r.calls[1]?.input.texts[0]).toContain("[from the user] and the trip dates");
      const side = r.subagents.log("scout")?.entries.map((e) => `${e.kind}: ${e.text}`);
      expect(side).toEqual(["user: look around", "user: [from OptChat] also check ~/notes", "talk: first pass", "user: [from the user] and the trip dates", "talk: second pass"]);
      yield* until("the report", () => r.log().includes("user: [scout] second pass"));
      // it has ended: a tell starts it again, and a second report follows
      expect(yield* r.subagents.tell("scout", "one more thing")).toBeNull();
      yield* until("the second report", () => r.log().includes("user: [scout] third pass"));
      const runs = () => r.said.flatMap((e) => (e.type === "subagent-started" ? [e.runId] : []));
      yield* until("its runs", () => runs().length === 2);
      expect(runs()).toEqual(["scout+1", "scout+2"]);
      expect(yield* r.subagents.tell("nobody", "hi")).toContain("no subagent called nobody");
    }),
  );
});

test("the user stops a running subagent: it is reported stopped; one that hits a limit fails and reports, with no failover", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: {
          limited: (_input, out) =>
            Effect.gen(function* () {
              yield* out.log("talk", "half way");
              return yield* new UsageLimit({ message: "Claude AI usage limit reached" });
            }).pipe(Effect.catchTag("StoreError", Effect.die)),
          slow: () => Effect.never,
        },
        master: (call) =>
          Effect.gen(function* () {
            yield* call("spawn", { name: "slow", task: "wait" });
            yield* call("spawn", { name: "limited", task: "spend" });
          }),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("limited fails", () => r.stateOf("limited")?.state === "failed");
      expect(r.stateOf("limited")?.why).toBe("usage limit: Claude AI usage limit reached");
      expect(r.calls.filter((c) => c.name === "limited")).toHaveLength(1); // no other engine was tried
      yield* until("its report", () => r.log().some((l) => l.startsWith("user: [limited] failed after")));
      expect(r.log().find((l) => l.startsWith("user: [limited]"))).toContain("(usage limit: Claude AI usage limit reached) on claude-code:opus");
      expect(yield* r.subagents.stop("slow")).toBeNull();
      expect(r.stateOf("slow")).toMatchObject({ state: "stopped", why: "stopped by the user" });
      yield* until("its report", () => r.log().some((l) => l.startsWith("user: [slow] stopped after")));
      expect(yield* r.subagents.stop("slow")).toBe("stop: slow is not running (stopped)");
      const errors = () => r.said.flatMap((e) => (e.type === "subagent-error" ? [[e.name, e.code]] : []));
      yield* until("its events", () => errors().length === 2);
      expect(errors()).toEqual([
        ["limited", "failed"],
        ["slow", "stopped"],
      ]);
    }),
  );
});

test("a restart finds a run it cut short: stopped, reported once, never resumed", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  // the first server: a run going on when it shuts down (its scope closes)
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ child: { slow: () => Effect.never }, dir, master: (call) => Effect.asVoid(call("spawn", { name: "slow", task: "wait" })), scope });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("running", () => r.stateOf("slow")?.state === "running" && r.idle());
    }),
  );
  const meta = () => decodeMeta(readFileSync(`${dir}/agents/slow/agent.json`, "utf8"));
  expect(meta().state).toBe("running");
  // the next one: stopped and reported, and nothing runs it
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [slow] stopped")));
      expect(r.log().at(-1)).toContain("the server restarted while it ran; nothing resumes it");
      expect(r.calls).toEqual([]);
      expect(meta()).toMatchObject({ reported: true, state: "stopped" });
      expect(r.stateOf("slow")?.state).toBe("stopped");
    }),
  );
  // and the one after that says nothing more
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* Effect.sleep("50 millis");
      expect(r.log().filter((l) => l.startsWith("user: [slow]"))).toHaveLength(1);
    }),
  );
});

test("zoom(\"Name\") reads a side log a page at a time; a subagent's own spawn and tell are refused", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const big = "x".repeat(SIDE_PAGE / 2);
      const r = yield* rig({
        child: {
          reader: (_input, out) =>
            Effect.gen(function* () {
              for (let k = 0; k < 4; k++) yield* out.log("echo", `${k} ${big}`);
              yield* out.log("talk", "read it all");
            }).pipe(Effect.orDie),
        },
        master: (call) => Effect.asVoid(call("spawn", { name: "reader", task: "read" })),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("done", () => r.stateOf("reader")?.state === "done");
      const { zoom } = r.subagents.tools("master");
      const first = zoom("READER", 0); // any case finds it
      expect(first.split("\n")[0]).toBe("reader: done, on claude-code:opus, 6 entries; its task is entry 0.");
      expect(first).toContain("0|user: read");
      expect(first).toContain("1|echo: 0 x");
      expect(first).toContain('[more: zoom("reader", 2)]');
      const rest = zoom("reader", 4);
      expect(rest).toContain("4|echo: 3 x");
      expect(rest).toContain("5|talk: read it all");
      expect(rest).not.toContain("[more");
      expect(zoom("ghost", 0)).toBe("No subagent ghost. Subagents: reader.");
      const theirs = r.subagents.tools("subagent");
      expect(yield* theirs.call("spawn", { name: "nested", task: "t" })).toEqual({ error: true, text: "spawn: a subagent can't start or tell subagents" });
      expect(yield* theirs.call("tell", { name: "reader", text: "t" })).toEqual({ error: true, text: "tell: a subagent can't start or tell subagents" });
      expect(theirs.zoom("reader", 5)).toContain("5|talk: read it all");
    }),
  );
});

test("a report waits for the running turn and never starts one", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<true>();
      const fast = yield* Deferred.make<true>();
      let turns = 0;
      const r = yield* rig({
        child: { quick: (_i, out) => out.log("talk", "quick answer").pipe(Effect.orDie, Effect.andThen(Deferred.succeed(fast, true))) },
        master: (call) =>
          Effect.gen(function* () {
            turns += 1;
            if (turns > 1) return;
            yield* call("spawn", { name: "quick", task: "t" });
            yield* Deferred.await(fast);
            yield* Effect.sleep("30 millis");
            // the subagent has finished; its report is not in the chat while this turn runs
            yield* Deferred.await(release);
          }),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* Deferred.await(fast);
      yield* Effect.sleep("60 millis");
      expect(r.log().some((l) => l.startsWith("user: [quick]"))).toBe(false);
      yield* Deferred.succeed(release, true);
      yield* until("the report, after the turn", () => r.log().at(-1) === "user: [quick] quick answer");
      yield* until("idle", r.idle);
      expect(turns).toBe(1); // the report started no turn
      expect(r.log()).toEqual(["user: go", "talk: the master answers", "user: [quick] quick answer"]);
    }),
  );
});

test("spawn outside a turn is refused", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ scope });
      expect(yield* r.subagents.tools("master").call("spawn", { name: "a", task: "t" })).toEqual({ error: true, text: "spawn: only a turn can start a subagent" });
      expect(r.session.state().subagents).toEqual([]);
    }),
  );
});

test("a turn's spawns are listed: running first, then the newest others", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: { c: () => Effect.never },
        master: (call) =>
          Effect.gen(function* () {
            yield* call("spawn", { name: "a", task: "t" });
            yield* Effect.sleep("20 millis");
            yield* call("spawn", { name: "b", task: "t" });
            yield* Effect.sleep("20 millis");
            yield* call("spawn", { name: "c", task: "t" });
          }),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("a and b done", () => r.stateOf("a")?.state === "done" && r.stateOf("b")?.state === "done" && r.stateOf("c")?.state === "running");
      expect(r.session.state().subagents?.map((x) => x.name)).toEqual(["c", "b", "a"]);
    }),
  );
});
