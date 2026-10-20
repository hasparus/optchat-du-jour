// Subagents (SPEC "Subagents") with scripted engines: spawn from a turn, the cap (subagents.max),
// the models (the turn's by default, the master's pick, the user's), tell, stop and Stop all, the
// report in the chat as "[Name] …", the side log on disk and committed, zoom("Name"), the usage
// records, a restart that cut a run short (it goes on), nested subagents (their reports go to the
// one that spawned them), where each works (a folder, or an isolated one's git worktree, made and
// merged back in temporary repositories only), and the chat's own log and tree, which see nothing
// of a subagent's work but its report.
import { afterAll, expect, test } from "bun:test";
import { Deferred, type Duration, Effect, PubSub, Result, Schema, type Scope } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { entryLabel, parseSettings, type Ref, SUBAGENTS_MAX } from "../src/config.ts";
import { ModelError, UsageLimit } from "../src/engines/errors.ts";
import { makeMaster } from "../src/master.ts";
import type { AgentTools, Caller } from "../src/mcp.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { type AgentPlace, makeSubagents, RESUMES_MAX, SIDE_PAGE, type SubagentHost } from "../src/subagents.ts";
import type { TurnEngine, TurnEvents, TurnInput } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";
import { localWorktrees } from "../src/worktree.ts";

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

// What a subagent's engine does in one call: `call` counts its calls, `input` is the call's input,
// `at` where it runs (its device, its folder or worktree, its /mcp key)
type Child = (input: TurnInput, out: TurnEvents, call: number, at: AgentPlace) => Effect.Effect<void, UsageLimit | ModelError>;
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
const decodeMeta = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ state: Schema.String, ref: Schema.String, pending: Schema.NullOr(Schema.Struct({ run: Schema.Number, text: Schema.String })), why: Schema.NullOr(Schema.String), entries: Schema.Number })));

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
type Args = Record<string, string | boolean>;
const rig = (o: {
  readonly scope: Scope.Scope;
  readonly dir?: string;
  readonly master?: (call: (tool: "spawn" | "tell", args: Args) => Effect.Effect<{ readonly text: string; readonly error: boolean }>, turn: number) => Effect.Effect<void>;
  readonly child?: Record<string, Child>;
  // what each commit does besides being counted (a slow git, say)
  readonly commit?: Effect.Effect<void>;
  readonly max?: number; // subagents.max (SUBAGENTS_MAX)
  readonly wake?: Duration.Input; // reports wake an idle master after this (E39); none: M7a's waiting
  readonly wakeLimit?: number; // woken turns in a row before waking pauses (WAKE_LIMIT; 0: none)
  readonly folders?: readonly string[]; // the device mini's folders
  readonly worktrees?: string; // where isolated ones' worktrees go: a temporary directory
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
    const commit = (o.commit ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => ((counts.commits += 1), null))));
    // every call of a subagent's engine: on which ref, at which effort, with what input, where
    const calls: { readonly ref: string; readonly effort: string | undefined; readonly name: string; readonly input: TurnInput; readonly at: AgentPlace }[] = [];
    // every master turn's input
    const turns: TurnInput[] = [];
    const host = yield* Deferred.make<SubagentHost>();
    const engineOf = (ref: Ref, at: AgentPlace): TurnEngine => ({
      ref: ref.ref,
      run: (input, out) =>
        Effect.suspend(() => {
          const name = /subagent "([^"]+)"/.exec(input.texts[0] ?? "")?.[1] ?? "?";
          calls.push({ at, effort: ref.effort, input, name, ref: ref.ref });
          const mine = calls.filter((c) => c.name === name).length;
          return (o.child?.[name] ?? answers(`${name} found it`))(input, out, mine, at);
        }),
      vision: false,
      warm: () => Effect.void,
    });
    const folders = o.folders ?? ["/tmp"];
    const trees = localWorktrees(o.worktrees ?? `${dir}-worktrees`, folders);
    const subagents = yield* makeSubagents({
      chain: CHAIN,
      commit,
      device: "mini",
      devices: { mac: { folders: ["~/repos"] }, mini: { folders } },
      dir,
      effort: "high",
      engine: (ref, at) => Effect.succeed(engineOf(ref, at)),
      folderFor: (device, path) => (device === "mini" && !folders.some((f) => path === f || path.startsWith(`${f}/`)) ? Result.fail(`${path} is outside mini's folders`) : Result.succeed(path)),
      host,
      logUsage: (r) => Effect.sync(() => usage.push(r)),
      max: o.max ?? SUBAGENTS_MAX,
      mem: chat.mem,
      linkWait: "10 millis",
      publish: (e) => PubSub.publish(events, e).pipe(Effect.asVoid),
      worktrees: (device) => (device === "mini" ? trees : undefined),
    });
    const masterEngine = (ref: string): TurnEngine => ({
      ref,
      run: (input, out) =>
        Effect.gen(function* () {
          turns.push(input);
          if (o.master) yield* o.master((tool, args) => subagents.tools("master").call(tool, args), turns.length);
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
      wake: o.wake ?? null,
      wakeLimit: o.wakeLimit ?? 0,
    });
    yield* Deferred.succeed(host, { lastView: session.lastView, report: session.report, turnNow: session.turnNow });
    yield* subagents.restore;
    const log = () => chat.mem.root.map((m) => `${m.kind}: ${m.text}`);
    const idle = () => session.state().phase === "idle";
    const stateOf = (name: string) => session.state().subagents?.find((s) => s.name === name);
    const tools = (caller: Caller) => subagents.tools(caller);
    return { calls, chat, counts, dir, idle, log, said, session, stateOf, subagents, tools, turns, usage };
  });

const scoped = async <A, E>(f: (scope: Scope.Scope) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      return yield* f(scope);
    }).pipe(Effect.scoped),
  );

test("spawn starts a run in the turn's folder that outlives the turn; its report reaches the chat as [Name] …, and nothing else of it does", async () => {
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
      const meta = () => decodeMeta(readFileSync(`${r.dir}/agents/scout/agent.json`, "utf8"));
      yield* until("its report delivered", () => meta().pending === null);
      expect(meta()).toMatchObject({ entries: 4, pending: null, ref: "claude-code:opus", state: "done" });
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
      // where it works: the device's first folder, directly, with a /mcp key of its own
      expect(first?.at).toMatchObject({ cwd: "/tmp", device: "mini", name: "scout" });
      expect(first?.input.texts[0]).toContain("You work directly in /tmp on mini");
      expect(r.subagents.callerOf(first?.at.key ?? "")).toEqual({ agent: "scout" });
      expect(r.subagents.callerOf("not a key")).toBeNull();
      expect(r.stateOf("scout")).toMatchObject({ device: "mini", folder: "/tmp" });
      expect(r.stateOf("scout")?.isolated).toBeUndefined();
      // its usage, as a subagent's: its name, ref and effort
      expect(r.usage.map((u) => [u.role, u.subagent, u.ref, u.effort])).toEqual([["subagent", "scout", "claude-code:opus", "high"]]);
      // AG-UI's subagent events went out: started, then finished with the report
      const kinds = () => r.said.flatMap((e) => (e.type.startsWith("subagent-") ? [e.type] : []));
      yield* until("its events", () => kinds().length === 2);
      expect(kinds()).toEqual(["subagent-started", "subagent-finished"]);
    }),
  );
});

test("at most subagents.max run at once: one more spawn is refused, naming them; a name is taken once, in any case", async () => {
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
        max: 2,
        scope,
      });
      yield* r.session.input("three at once", { clientId: "c1" });
      yield* until("the turn", () => answers.length === 4);
      expect(answers.map((a) => a.error)).toEqual([false, false, true, true]);
      expect(answers[2]?.text).toContain("2 subagents run already (a, b), at most 2 at once");
      expect(answers[3]?.text).toContain("there is a subagent called a already (running)");
      expect(existsSync(`${r.dir}/agents/c`)).toBe(false);
      yield* Deferred.succeed(hold, true);
      yield* until("both reports", () => r.log().filter((l) => l.startsWith("user: [")).length === 2);
      // the default is SUBAGENTS_MAX, 4: four start, the fifth is refused
      const more: { text: string; error: boolean }[] = [];
      const wait = yield* Deferred.make<true>();
      const held: Child = () => Effect.asVoid(Deferred.await(wait));
      const four = yield* rig({
        child: { p: held, q: held, r: held, s: held },
        master: (call) =>
          Effect.gen(function* () {
            for (const name of ["p", "q", "r", "s", "t"]) more.push(yield* call("spawn", { name, task: `task ${name}` }));
          }),
        scope,
      });
      yield* four.session.input("five at once", { clientId: "c1" });
      yield* until("the turn", () => more.length === 5);
      expect(SUBAGENTS_MAX).toBe(4);
      expect(more.map((a) => a.error)).toEqual([false, false, false, false, true]);
      expect(more[4]?.text).toContain("4 subagents run already (p, q, r, s), at most 4 at once");
      yield* Deferred.succeed(wait, true);
      yield* until("four reports", () => four.log().filter((l) => l.startsWith("user: [")).length === 4);
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

test("a restart finds a run it cut short: it goes on from its side log, and its report is delivered once", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  // the first server: a run going on when it shuts down (its scope closes)
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: { slow: (_input, out) => out.log("tool", 'Bash {"command":"make"}').pipe(Effect.orDie, Effect.andThen(Effect.never)) },
        dir,
        master: (call) => Effect.asVoid(call("spawn", { name: "slow", task: "build it" })),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("running", () => r.stateOf("slow")?.entries === 2 && r.idle());
    }),
  );
  const meta = () => decodeMeta(readFileSync(`${dir}/agents/slow/agent.json`, "utf8"));
  expect(meta().state).toBe("running");
  // the next one: it goes on, told why, from its side log, and reports once it ends
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ child: { slow: (_input, out) => out.log("talk", "built after the restart").pipe(Effect.orDie) }, dir, scope });
      yield* until("the report", () => r.log().includes("user: [slow] built after the restart"));
      expect(r.calls).toHaveLength(1);
      const opening = r.calls[0]?.input.texts[0] ?? "";
      expect(opening).toContain("You worked on this before");
      expect(opening).toContain('1|tool: Bash {"command":"make"}');
      expect(opening).toContain("The server restarted while you worked");
      yield* until("delivered", () => meta().pending === null);
      expect(meta()).toMatchObject({ entries: 4, state: "done" });
      const runs = r.said.flatMap((e) => (e.type === "subagent-started" ? [e.runId] : []));
      expect(runs).toEqual(["slow+2"]);
    }),
  );
  // and the one after that says nothing more, and runs nothing
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* Effect.sleep("50 millis");
      expect(r.log().filter((l) => l.startsWith("user: [slow]"))).toHaveLength(1);
      expect(r.calls).toEqual([]);
    }),
  );
});

test("a restart past subagents.max goes on with as many as fit; the others are stopped and reported", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: { a: () => Effect.never, b: () => Effect.never },
        dir,
        master: (call) => Effect.asVoid(call("spawn", { name: "a", task: "t" }).pipe(Effect.andThen(Effect.sleep("20 millis")), Effect.andThen(call("spawn", { name: "b", task: "t" })))),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("both running", () => r.stateOf("b")?.state === "running" && r.idle());
    }),
  );
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ child: { a: () => Effect.never }, dir, max: 1, scope });
      yield* until("b's report", () => r.log().some((l) => l.startsWith("user: [b] stopped")));
      expect(r.log().find((l) => l.startsWith("user: [b]"))).toContain("the server restarted while it ran, and it could not go on: 1 subagents run already (a), at most 1 at once");
      expect(r.stateOf("a")?.state).toBe("running"); // the older one goes on
    }),
  );
});

test("zoom(\"Name\") reads a side log a page at a time", async () => {
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
      expect(r.tools({ agent: "reader" }).zoom("reader", 5)).toContain("5|talk: read it all");
      // a subagent that has ended can't spawn
      expect(yield* r.tools({ agent: "reader" }).call("spawn", { name: "late", task: "t" })).toEqual({ error: true, text: "spawn: only a running subagent can start one" });
    }),
  );
});

test("with wake off (M7a), a report waits for the running turn and never starts one", async () => {
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

test("a report is made as its run ends: a tell that starts it again during the commit doesn't change it", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const committing = yield* Deferred.make<true>();
      let slow = false;
      const r = yield* rig({
        child: {
          scout: (_input, out, call) => (call === 1 ? out.log("talk", "THE ANSWER").pipe(Effect.orDie, Effect.andThen(Effect.sync(() => (slow = true)))) : Effect.never),
        },
        // the commit as its run ends takes a while, as a git commit does
        commit: Effect.suspend(() => (slow ? Deferred.succeed(committing, true).pipe(Effect.andThen(Effect.sleep("150 millis"))) : Effect.void)),
        master: (call) => Effect.asVoid(call("spawn", { name: "scout", task: "find it" })),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* Deferred.await(committing); // its run is over; the commit runs
      expect(yield* r.subagents.tell("scout", "one more thing")).toBeNull(); // the user's tell, from the card
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [scout]")));
      expect(r.log().filter((l) => l.startsWith("user: [scout]"))).toEqual(["user: [scout] THE ANSWER"]);
      expect(r.stateOf("scout")?.state).toBe("running"); // its second run goes on
    }),
  );
});

test("after a restart a pending report is sent word for word, unless the chat holds it already", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  const path = `${dir}/agents/scout/agent.json`;
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, master: (call) => Effect.asVoid(call("spawn", { name: "scout", task: "find it" })), scope });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("delivered", () => r.log().includes("user: [scout] scout found it") && decodeMeta(readFileSync(path, "utf8")).pending === null);
    }),
  );
  // a crash between the chat's line and agent.json's: the report is still pending on disk
  const pendingAs = (text: string) => {
    const meta = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({ ...meta, pending: { run: 1, text } })}\n`);
  };
  pendingAs("[scout] scout found it");
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* until("no longer pending", () => decodeMeta(readFileSync(path, "utf8")).pending === null);
      expect(r.log().filter((l) => l.startsWith("user: [scout]"))).toEqual(["user: [scout] scout found it"]);
      // listed from agent.json alone, its side log read only when asked for
      expect(r.stateOf("scout")).toMatchObject({ entries: 4, lastLine: "talk: scout found it", state: "done" });
      expect(r.subagents.tools("master").zoom("scout", 3)).toContain("3|talk: scout found it");
    }),
  );
  // one the chat never got is sent as it was made
  pendingAs("[scout] the words it had");
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* until("sent", () => r.log().includes("user: [scout] the words it had"));
      yield* until("no longer pending", () => decodeMeta(readFileSync(path, "utf8")).pending === null);
    }),
  );
});

test("an agent.json that names another folder than its own is left alone, and said so", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  mkdirSync(`${dir}/agents/scout`, { recursive: true });
  const meta = { effort: "high", ended: null, name: "other", pending: null, ref: "claude-code:opus", runs: 1, started: "2026-10-16T10:00:00.000Z", state: "running", task: "t", why: null };
  writeFileSync(`${dir}/agents/scout/agent.json`, `${JSON.stringify(meta)}\n`);
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      yield* until("said", () => r.said.some((e) => e.type === "info" && e.message === "subagent scout: agent.json names other, not its folder; left alone"));
      expect(r.session.state().subagents).toEqual([]);
      expect(r.log()).toEqual([]); // no report for it
    }),
  );
});

test("two runs that report the same words are two reports, each delivered once", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: { echo: (_input, out) => out.log("talk", "nothing new").pipe(Effect.orDie) },
        master: (call) => Effect.asVoid(call("spawn", { name: "echo", task: "look" })),
        scope,
      });
      const path = `${r.dir}/agents/echo/agent.json`;
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the first report", () => r.log().includes("user: [echo] nothing new"));
      expect(yield* r.subagents.tell("echo", "again")).toBeNull();
      yield* until("the second report", () => r.log().filter((l) => l === "user: [echo] nothing new").length === 2);
      yield* until("none pending", () => decodeMeta(readFileSync(path, "utf8")).pending === null);
      yield* Effect.sleep("50 millis");
      expect(r.log().filter((l) => l.startsWith("user: [echo]"))).toEqual(["user: [echo] nothing new", "user: [echo] nothing new"]);
    }),
  );
});

test("a subagent spawns one of its own: the cap counts it, its report goes to the one that spawned it, which reports to the chat", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const answers: { text: string; error: boolean }[] = [];
      let tools: ((caller: Caller) => AgentTools) | null = null;
      const r = yield* rig({
        child: {
          // its first call spawns worker and ends; worker's report starts it again
          boss: (input, out, call) =>
            Effect.gen(function* () {
              if (call === 1) {
                const theirs = tools?.({ agent: "boss" });
                if (theirs === undefined) return yield* Effect.die(new Error("no tools"));
                const worker = yield* theirs.call("spawn", { name: "worker", task: "count the files" });
                answers.push(worker, yield* theirs.call("spawn", { name: "extra", task: "t" }));
                yield* out.log("talk", "worker is on it");
                return;
              }
              yield* out.log("talk", `worker said: ${input.texts[0]?.includes("[worker] 12 files") ? "12 files" : "?"}`);
            }).pipe(Effect.orDie),
          worker: (_input, out) => out.log("talk", "12 files").pipe(Effect.orDie),
        },
        master: (call) => Effect.asVoid(call("spawn", { name: "boss", task: "delegate the count" })),
        max: 2,
        scope,
      });
      tools = r.tools;
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("boss's second report", () => r.log().includes("user: [boss] worker said: 12 files"));
      expect(answers[0]).toMatchObject({ error: false });
      expect(answers[0]?.text).toContain('its report will reach you as a message starting "[worker] "');
      // two running (boss and worker): the cap of 2 counts every level
      expect(answers[1]?.text).toContain("2 subagents run already (boss, worker), at most 2 at once");
      // worker's report is in boss's side log, not the chat; the chat has boss's two reports
      expect(r.log().filter((l) => l.startsWith("user: ["))).toEqual(["user: [boss] worker is on it", "user: [boss] worker said: 12 files"]);
      const side = r.subagents.log("boss")?.entries.map((e) => `${e.kind}: ${e.text}`);
      expect(side).toContain("user: [worker] 12 files");
      expect(r.stateOf("worker")).toMatchObject({ parent: "boss", state: "done" });
      // worker started from boss's opening: started by the subagent "boss"
      expect(r.calls.find((c) => c.name === "worker")?.input.texts[0]).toContain('started by the subagent "boss"');
      expect(decodeMeta(readFileSync(`${r.dir}/agents/worker/agent.json`, "utf8")).pending).toBeNull();
      // a key of a subagent that has ended tells no one, as it spawns no one (E38)
      expect(yield* r.tools({ agent: "boss" }).call("tell", { name: "worker", text: "hi" })).toEqual({ error: true, text: "tell: only a running subagent can tell one" });
    }),
  );
});

test("Stop all stops every running subagent; each reports it was stopped", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: { a: () => Effect.never, b: () => Effect.never },
        master: (call) => Effect.asVoid(call("spawn", { name: "a", task: "t" }).pipe(Effect.andThen(call("spawn", { name: "b", task: "t" })))),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("both running", () => r.calls.length === 2);
      expect([...(yield* r.subagents.stopAll)].toSorted()).toEqual(["a", "b"]);
      yield* until("both reports", () => r.log().filter((l) => l.includes("stopped after")).length === 2);
      expect(r.stateOf("a")).toMatchObject({ state: "stopped", why: "stopped by the user" });
      expect(r.stateOf("b")).toMatchObject({ state: "stopped", why: "stopped by the user" });
      expect(yield* r.subagents.stopAll).toEqual([]);
    }),
  );
});

test("a report wakes the idle master: its next turn starts with the report", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<true>();
      const r = yield* rig({
        child: { scout: (_input, out) => Deferred.await(go).pipe(Effect.andThen(out.log("talk", "the notes say Oct 3")), Effect.orDie) },
        master: (call, turn) => (turn === 1 ? Effect.asVoid(call("spawn", { name: "scout", task: "find the date" })) : Effect.void),
        scope,
        wake: "50 millis",
      });
      yield* r.session.input("find the date, with a subagent", { clientId: "c1" });
      yield* until("idle", () => r.turns.length === 1 && r.idle());
      yield* Deferred.succeed(go, true);
      yield* until("woken", () => r.turns.length === 2 && r.idle());
      expect(r.turns[1]?.texts).toEqual(["[scout] the notes say Oct 3"]);
      expect(r.log()).toEqual(["user: find the date, with a subagent", "talk: the master answers", "user: [scout] the notes say Oct 3", "talk: the master answers"]);
    }),
  );
});

test("where it works: the folder asked for, or relative to the caller's, on the device asked for; others in the same folder are named in its opening", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const answers: { text: string; error: boolean }[] = [];
      const hold = yield* Deferred.make<true>();
      const held: Child = (_input, out) => Deferred.await(hold).pipe(Effect.andThen(out.log("talk", "done")), Effect.orDie);
      const r = yield* rig({
        child: { first: held, second: held, sub: held, far: held },
        folders: ["/tmp", "/srv"],
        master: (call) =>
          Effect.gen(function* () {
            answers.push(
              yield* call("spawn", { name: "first", task: "fix the parser" }),
              yield* call("spawn", { name: "second", task: "fix the lexer" }),
              yield* call("spawn", { folder: "/etc", name: "outside", task: "t" }),
              yield* call("spawn", { folder: "sub", name: "sub", task: "t" }),
              yield* call("spawn", { device: "nowhere", name: "lost", task: "t" }),
            );
          }),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("three calls", () => r.calls.length === 3);
      expect(answers.map((a) => a.error)).toEqual([false, false, true, false, true]);
      expect(answers[1]?.text).toContain("directly in /tmp on mini");
      expect(answers[2]?.text).toContain("/etc is outside mini's folders");
      expect(answers[4]?.text).toContain("nowhere is not a device (mac, mini)");
      // the second is told the first works in /tmp too; and the one in /tmp/sub, both of them
      const opening = (name: string) => r.calls.find((c) => c.name === name)?.input.texts[0] ?? "";
      expect(opening("second")).toContain("first (fix the parser)");
      expect(opening("second")).toContain("there now too");
      expect(opening("sub")).toContain("You work directly in /tmp/sub on mini");
      expect(opening("sub")).toContain("first (fix the parser), second (fix the lexer) work there now too");
      expect(r.calls.find((c) => c.name === "sub")?.at.cwd).toBe("/tmp/sub");
      // a subagent's own spawn defaults to its folder and device; another device's first folder there
      answers.push(yield* r.tools({ agent: "first" }).call("spawn", { device: "mac", name: "far", task: "t" }));
      yield* until("far's call", () => r.calls.some((c) => c.name === "far"));
      expect(r.calls.find((c) => c.name === "far")?.at).toMatchObject({ cwd: "~/repos", device: "mac" });
      expect(r.calls.find((c) => c.name === "far")?.input.device).toBe("mac");
      yield* Deferred.succeed(hold, true);
      yield* until("all done", () => ["first", "second", "sub", "far"].every((n) => r.stateOf(n)?.state === "done"));
    }),
  );
});

// ---- isolated subagents: git worktrees, in temporary directories only ----

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// a fresh repository with one commit, in a temporary folder that is mini's only folder; its worktrees beside it
const repo = () => {
  const top = realpathSync(mkdtempSync(`${tmpdir()}/oc-wt-`));
  dirs.push(top);
  const folder = `${top}/repo`;
  mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(`${folder}/notes.md`, "one\ntwo\nthree\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "start");
  return { folder, top, worktrees: `${top}/worktrees` };
};
// what a test saw of a worktree from inside the subagent's call
type Seen = { readonly exists: boolean; readonly branch: string };
type Watch = { seen: Seen | null };
// a child that edits a file in its worktree and commits it, after `before`
const editing =
  (file: string, text: string, o: { readonly commit?: boolean; readonly before?: Effect.Effect<void> } = {}): Child =>
  (_input, out, _call, at) =>
    Effect.gen(function* () {
      yield* o.before ?? Effect.void;
      writeFileSync(`${at.cwd}/${file}`, text);
      if (o.commit !== false) {
        git(at.cwd, "add", "-A");
        git(at.cwd, "commit", "-q", "-m", `edit ${file}`);
      }
      yield* out.log("talk", `edited ${file}`);
    }).pipe(Effect.orDie);

test("isolate: a worktree on optchat/<Name>; a clean end fast-forwards the folder's branch, then the worktree and branch go", async () => {
  const { folder, top, worktrees } = repo();
  await scoped((scope) =>
    Effect.gen(function* () {
      // what its worktree looked like while it ran
      const during: Watch = { seen: null };
      const answers: { text: string; error: boolean }[] = [];
      const r = yield* rig({
        child: {
          iso: (input, out, call, at) =>
            Effect.suspend(() => {
              during.seen = { branch: git(at.cwd, "branch", "--show-current"), exists: existsSync(`${worktrees}/iso`) };
              return editing("added.md", "from the worktree\n")(input, out, call, at);
            }),
        },
        folders: [top],
        master: (call) => Effect.asVoid(call("spawn", { folder, isolate: true, name: "iso", task: "add a file" }).pipe(Effect.tap((a) => Effect.sync(() => answers.push(a))))),
        scope,
        worktrees,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [iso] ")));
      expect(answers[0]?.text).toContain(`in its own worktree ${worktrees}/iso on mini, branch optchat/iso from ${folder}`);
      expect(during.seen).toEqual({ branch: "optchat/iso", exists: true });
      const call = r.calls[0];
      expect(call?.at.cwd).toBe(`${worktrees}/iso`);
      expect(call?.input.texts[0]).toContain(`You work in a git worktree of your own, ${worktrees}/iso on mini, on branch optchat/iso, made from ${folder}`);
      // merged into main by a fast-forward; the worktree and the branch are gone
      expect(readFileSync(`${folder}/added.md`, "utf8")).toBe("from the worktree\n");
      expect(git(folder, "log", "--format=%s", "-1")).toBe("edit added.md");
      expect(existsSync(`${worktrees}/iso`)).toBe(false);
      expect(git(folder, "branch", "--list", "optchat/iso")).toBe("");
      const report = r.log().find((l) => l.startsWith("user: [iso] ")) ?? "";
      expect(report).toContain("edited added.md\n[main fast-forwarded to optchat/iso; its worktree and branch are removed; 1 files changed, +1 -0]");
      expect(r.stateOf("iso")).toMatchObject({ isolated: true, merge: { deletions: 0, files: 1, insertions: 1, into: "main", outcome: "fast-forward" } });
      expect(r.stateOf("iso")?.worktree).toBeUndefined();
    }),
  );
});

test("isolate: the folder moved on meanwhile; a clean merge makes a merge commit, and what it left uncommitted is committed first", async () => {
  const { folder, top, worktrees } = repo();
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: {
          // the master (or the user) commits another file in the folder while it works; it leaves its own edit uncommitted
          iso: editing("theirs.md", "mine\n", {
            before: Effect.sync(() => {
              writeFileSync(`${folder}/master.md`, "the master's\n");
              git(folder, "add", "-A");
              git(folder, "commit", "-q", "-m", "the master's commit");
            }),
            commit: false,
          }),
        },
        folders: [top],
        master: (call) => Effect.asVoid(call("spawn", { folder, isolate: true, name: "iso", task: "add a file" })),
        scope,
        worktrees,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [iso] ")));
      // a merge commit, its two parents the master's commit and the subagent's
      expect(git(folder, "log", "--format=%s", "-1")).toBe("Merge optchat/iso (subagent iso)");
      expect(git(folder, "log", "--format=%s", "HEAD^1", "-1")).toBe("the master's commit");
      expect(git(folder, "log", "--format=%s", "HEAD^2", "-1")).toBe("iso: work left uncommitted when it ended");
      expect(readFileSync(`${folder}/theirs.md`, "utf8")).toBe("mine\n");
      expect(r.stateOf("iso")?.merge).toMatchObject({ files: 1, into: "main", outcome: "merged" });
      expect(r.log().find((l) => l.startsWith("user: [iso] "))).toContain("its uncommitted changes (1 paths) were committed on optchat/iso first");
      expect(existsSync(`${worktrees}/iso`)).toBe(false);
    }),
  );
});

test("isolate: a conflict keeps the branch and the worktree and says so; a tell goes on there", async () => {
  const { folder, top, worktrees } = repo();
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        child: {
          iso: (input, out, call, at) =>
            call === 1
              ? editing("notes.md", "one\nTWO from the subagent\nthree\n", {
                  before: Effect.sync(() => {
                    writeFileSync(`${folder}/notes.md`, "one\ntwo from the master\nthree\n");
                    git(folder, "commit", "-q", "-am", "the master's edit");
                  }),
                })(input, out, call, at)
              : out.log("talk", `still in ${at.cwd}`).pipe(Effect.orDie),
        },
        folders: [top],
        master: (call) => Effect.asVoid(call("spawn", { folder, isolate: true, name: "iso", task: "edit the notes" })),
        scope,
        worktrees,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the report", () => r.log().some((l) => l.startsWith("user: [iso] ")));
      const report = r.log().find((l) => l.startsWith("user: [iso] ")) ?? "";
      expect(report).toContain(`optchat/iso conflicts with main in notes.md; optchat/iso is kept with its worktree at ${worktrees}/iso`);
      // the folder is as the master left it, with no merge half done
      expect(readFileSync(`${folder}/notes.md`, "utf8")).toBe("one\ntwo from the master\nthree\n");
      expect(git(folder, "status", "--porcelain")).toBe("");
      expect(existsSync(`${worktrees}/iso`)).toBe(true);
      expect(git(folder, "branch", "--list", "optchat/iso")).toContain("optchat/iso");
      expect(r.stateOf("iso")).toMatchObject({ merge: { conflicts: ["notes.md"], into: "main", outcome: "conflict" }, worktree: { branch: "optchat/iso", path: `${worktrees}/iso` } });
      // told again, it goes on in the same worktree
      expect(yield* r.subagents.tell("iso", "merge main into your branch")).toBeNull();
      yield* until("its second report", () => r.log().some((l) => l.startsWith("user: [iso] still in")));
      expect(r.log().find((l) => l.startsWith("user: [iso] still in"))).toContain(`still in ${worktrees}/iso`);
    }),
  );
});

test("isolate needs a git repository: a folder that isn't one is a tool error, and nothing starts", async () => {
  const top = realpathSync(mkdtempSync(`${tmpdir()}/oc-wt-`));
  dirs.push(top);
  await scoped((scope) =>
    Effect.gen(function* () {
      const answers: { text: string; error: boolean }[] = [];
      const r = yield* rig({
        folders: [top],
        master: (call) => Effect.asVoid(call("spawn", { folder: top, isolate: true, name: "iso", task: "t" }).pipe(Effect.tap((a) => Effect.sync(() => answers.push(a))))),
        scope,
        worktrees: `${top}/worktrees`,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the answer", () => answers.length === 1);
      expect(answers[0]).toEqual({ error: true, text: `spawn: ${top} is not in a git repository, so it can't be isolated: spawn without isolate to work there directly` });
      expect(r.calls).toEqual([]);
      expect(existsSync(`${r.dir}/agents/iso`)).toBe(false);
      expect(r.stateOf("iso")).toBeUndefined();
    }),
  );
});

test("a call cut short by a dropped device link goes on from its side log; a link that keeps dropping fails it", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const lost = new ModelError({ message: "lost the connection to mac: socket closed" });
      const r = yield* rig({
        child: {
          flaky: (_input, out, call) => (call === 1 ? out.log("tool", 'Bash {"command":"make"}').pipe(Effect.orDie, Effect.andThen(Effect.fail(lost))) : out.log("talk", "built").pipe(Effect.orDie)),
          gone: () => Effect.fail(lost),
        },
        master: (call) => Effect.asVoid(call("spawn", { device: "mac", name: "flaky", task: "build" }).pipe(Effect.andThen(call("spawn", { device: "mac", name: "gone", task: "build" })))),
        scope,
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("flaky's report", () => r.log().includes("user: [flaky] built"));
      const second = r.calls.filter((c) => c.name === "flaky")[1]?.input.texts[0] ?? "";
      expect(second).toContain("The connection to mac dropped while you worked");
      expect(second).toContain('1|tool: Bash {"command":"make"}');
      // the other: its first call and LINK_TRIES more, then it fails and says why
      yield* until("gone's report", () => r.log().some((l) => l.startsWith("user: [gone] failed")));
      expect(r.calls.filter((c) => c.name === "gone")).toHaveLength(4);
      expect(r.stateOf("gone")?.why).toBe("error: lost the connection to mac: socket closed");
    }),
  );
});

// ---- review of #42: a user's stop is a decision; bounds on unattended work ----

// Stop all as server/routes/ws.ts does it: hush the reports, cancel the turn, stop every subagent
const stopAllAsWs = (r: { readonly session: { readonly hush: Effect.Effect<void>; readonly cancel: Effect.Effect<void> }; readonly subagents: { readonly stopAll: Effect.Effect<unknown> } }) =>
  r.session.hush.pipe(Effect.andThen(r.session.cancel), Effect.andThen(r.subagents.stopAll));

test("Stop all wakes no master turn: the stopped runs' reports are logged, and nothing else wakes it until the user's next message", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const later = yield* Deferred.make<true>();
      const r = yield* rig({
        child: { a: () => Effect.never, b: () => Effect.never, c: (_input, out) => Deferred.await(later).pipe(Effect.andThen(out.log("talk", "c is done")), Effect.orDie) },
        master: (call, turn) => (turn === 1 ? Effect.asVoid(call("spawn", { name: "a", task: "t" }).pipe(Effect.andThen(call("spawn", { name: "b", task: "t" })))) : Effect.void),
        scope,
        wake: "30 millis",
      });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("both running", () => r.calls.length === 2 && r.idle());
      yield* stopAllAsWs(r);
      yield* until("both reports", () => r.log().filter((l) => l.includes("stopped by the user")).length === 2);
      yield* Effect.sleep("200 millis");
      expect(r.turns).toHaveLength(1);
      // the user's next message wakes it again: a report after it starts a turn
      yield* r.session.input("and c?", { clientId: "c2" });
      yield* until("turn 2", () => r.turns.length === 2 && r.idle());
      expect(yield* r.tools("master").call("spawn", { name: "c", task: "t" })).toMatchObject({ error: true }); // no turn runs
    }),
  );
});

test("a parent the user stopped is never started again by its child's report, with Stop all or its own Stop", async () => {
  for (const how of ["all", "parent", "all", "parent", "all"] as const)
    await scoped((scope) =>
      Effect.gen(function* () {
        let tools: ((caller: Caller) => AgentTools) | null = null;
        const r = yield* rig({
          child: {
            boss: (_input, _out, call) =>
              call === 1
                ? Effect.gen(function* () {
                    const theirs = tools?.({ agent: "boss" });
                    if (theirs === undefined) return yield* Effect.die(new Error("no tools"));
                    yield* theirs.call("spawn", { name: "worker", task: "count" });
                    return yield* Effect.never;
                  })
                : Effect.never,
            worker: (_input, out) => (how === "parent" ? Effect.sleep("40 millis").pipe(Effect.andThen(out.log("talk", "12 files")), Effect.orDie) : Effect.never),
          },
          master: (call, turn) => (turn === 1 ? Effect.asVoid(call("spawn", { name: "boss", task: "delegate" })) : Effect.void),
          scope,
          wake: "30 millis",
        });
        tools = r.tools;
        yield* r.session.input("go", { clientId: "c1" });
        yield* until("both running", () => r.stateOf("worker")?.state === "running" && r.idle());
        if (how === "all") yield* stopAllAsWs(r);
        else expect(yield* r.subagents.stop("boss")).toBeNull();
        yield* until("worker's report in the chat", () => r.log().some((l) => l.startsWith("user: [worker] ")));
        yield* Effect.sleep("100 millis");
        expect(r.stateOf("boss")).toMatchObject({ state: "stopped", why: "stopped by the user" });
        expect(r.log().find((l) => l.startsWith("user: [worker] "))).toContain("[for boss, which the user stopped]");
        expect(r.calls.filter((c) => c.name === "boss")).toHaveLength(1);
      }),
    );
});

test("waking pauses after subagents.wakeLimit woken turns in a row; the user's next message resumes it", async () => {
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({
        // every turn, the master (told to keep checking CI until it's green) spawns another checker
        child: new Proxy<Record<string, Child>>({}, { get: () => (_input: TurnInput, out: TurnEvents) => out.log("talk", "not yet").pipe(Effect.orDie) }),
        master: (call, turn) => Effect.asVoid(call("spawn", { name: `check${turn}`, task: "is CI green yet?" })),
        scope,
        wake: "10 millis",
        wakeLimit: 3,
      });
      yield* r.session.input("keep checking CI with a subagent until it's green", { clientId: "c1" });
      yield* until("paused", () => r.session.state().wakePaused === 3 && r.idle());
      yield* Effect.sleep("300 millis");
      // the user's turn and three woken ones; the fourth checker's report waits in the chat
      expect(r.turns).toHaveLength(4);
      expect(r.log().at(-1)).toBe("user: [check4] not yet");
      expect(r.said.some((e) => e.type === "info" && e.message.includes("waking is paused until your next message"))).toBe(true);
      yield* r.session.input("still?", { clientId: "c2" });
      yield* until("woken again", () => r.turns.length >= 6);
      expect(r.session.state().wakePaused).toBeUndefined();
    }),
  );
});

test("a run cut short goes on after at most RESUMES_MAX restarts in a row with no call completing; then it stops and says why", async () => {
  const dir = mkdtempSync(`${tmpdir()}/oc-sub-`);
  dirs.push(dir);
  let calls = 0;
  const hang: Child = (_input, out) => Effect.sync(() => (calls += 1)).pipe(Effect.andThen(out.log("tool", 'Bash {"command":"make"}')), Effect.orDie, Effect.andThen(Effect.never));
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ child: { slow: hang }, dir, master: (call) => Effect.asVoid(call("spawn", { name: "slow", task: "build it" })), scope });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("running", () => calls === 1 && r.idle());
    }),
  );
  for (let restart = 1; restart <= 6; restart++)
    await scoped((scope) =>
      Effect.gen(function* () {
        const r = yield* rig({ child: { slow: hang }, dir, scope });
        yield* until("resumed or stopped", () => calls === Math.min(restart, RESUMES_MAX) + 1 && (restart <= RESUMES_MAX || r.stateOf("slow")?.state === "stopped"));
      }),
    );
  expect(RESUMES_MAX).toBe(2);
  expect(calls).toBe(3);
  await scoped((scope) =>
    Effect.gen(function* () {
      const r = yield* rig({ dir, scope });
      expect(r.stateOf("slow")?.why).toBe("the server restarted 3 times while it ran, with no call of it completing since");
      yield* until("its report, once", () => r.log().some((l) => l.startsWith("user: [slow] stopped")));
      yield* Effect.sleep("50 millis");
      expect(r.log().filter((l) => l.startsWith("user: [slow] stopped"))).toHaveLength(1);
    }),
  );
});
