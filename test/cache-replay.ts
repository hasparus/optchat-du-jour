// The cache replay (docs/uniichat.md, "A cache-replay test"; after UniiChat's cache.test.ts, whose
// idea it takes, not its code). A real session (src/session.ts) over a real chat and compactor,
// its engines the real ones from src/engines/registry.ts, talks to fake vendors
// (./fake-vendors.ts) whose prompt caches follow the rules in ./fake-cache.ts, on a test clock
// that runs days of chat in a second or two (./sim-clock.ts). The script is a long chat: gaps from
// 20 seconds to 2 hours, turns that call tools, messages sent mid-run, a client connecting (which
// primes), compactions merging batches, an outage of the compactor's first engine (it fails over)
// and a turn stopped by a usage limit and resumed. Every request the engines build goes to the
// fake cache, which says what it read, wrote and sent uncached; this file adds them up per
// engine and role, with the cold turns and what it would cost at optchat.config.ts's prices.
//
// What it proves is that our requests are cache-shaped under those rules; what a real vendor
// does with them stays a check with a real account (TODO.md).
import { Effect, Fiber } from "effect";
import { HttpClient } from "effect/http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { apiKeyPrices } from "../optchat.config.ts";
import { dollarsOf } from "../src/apikey/budget.ts";
import { makeMessages } from "../src/apikey/anthropic.ts";
import { openChat } from "../src/chat.ts";
import { parseSettings, type Price, WAIT_RETRY } from "../src/config.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { masterPolicy, turnEngine } from "../src/engines/registry.ts";
import { makeMaster } from "../src/master.ts";
import { makeResponses } from "../src/openai/responses.ts";
import { systemPrompt } from "../src/prompts.ts";
import { makeSession, noMedia } from "../src/session.ts";
import { viewSize } from "../src/view.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { toolDefs } from "../src/tools/box.ts";
import { toolOk } from "../src/tools/files.ts";
import type { Placement } from "../src/turn/claude-code.ts";
import type { Marks } from "../src/tree.ts";
import type { UsageRecord } from "../src/usage.ts";
import { TTL_MS, type Ttl } from "./fake-cache.ts";
import { hash, makeVendors, modelOf, readText, type Role, type Sent } from "./fake-vendors.ts";
import { makeSimClock } from "./sim-clock.ts";

// ---------------------------------------------------------------------------------------------
// the layouts

// `outage`: the vendor engine the compactor's outage takes down (its chain moves on); `limit`:
// the master engine whose one turn hits a usage limit, and `resume`, the ref it is resumed on
type Chain = readonly [string, ...string[]];
type Level = { readonly from: number; readonly chain: Chain };
export type Layout = {
  readonly name: string;
  readonly what: string;
  readonly master: Chain;
  readonly compactor: readonly [Level, ...Level[]];
  readonly ttl: Ttl;
  readonly outage: string;
  readonly limit: string;
  readonly resume: string;
};

export const LAYOUTS: readonly Layout[] = [
  {
    compactor: [{ chain: ["api-key:anthropic/claude-haiku-5-5@xhigh", "api-key:anthropic/claude-opus-5-5@high"], from: 0 }],
    limit: "api-key:anthropic/claude-opus-5-5",
    master: ["api-key:anthropic/claude-opus-5-5"],
    name: "api-key",
    outage: "api-key:anthropic/claude-haiku-5-5",
    resume: "api-key:anthropic/claude-opus-5-5",
    ttl: "5m",
    what: "Anthropic on an API key: Opus turns, Haiku compactions falling over to Opus at the turns' effort",
  },
  {
    compactor: [{ chain: ["claude-code:haiku@xhigh", "claude-code:opus@high"], from: 0 }],
    limit: "claude-code:claude-opus-5-5",
    master: ["claude-code:opus"],
    name: "claude-code",
    outage: "claude-code:claude-haiku-5-5",
    resume: "claude-code:opus",
    ttl: "1h",
    what: "The Claude plan only, 1-hour marks (E6): Opus turns with priming, Haiku compactions falling over to Opus",
  },
  {
    compactor: [{ chain: ["claude-code:haiku@xhigh", "claude-code:opus@high"], from: 0 }],
    limit: "claude-code:claude-opus-5-5",
    master: ["claude-code:opus"],
    name: "claude-code-5m",
    outage: "claude-code:claude-haiku-5-5",
    resume: "claude-code:opus",
    ttl: "5m",
    what: "The same with the reference's 5-minute marks",
  },
  {
    compactor: [
      { chain: ["openai-plan:gpt-6-luna", "claude-code:haiku@xhigh"], from: 0 },
      { chain: ["openai-plan:gpt-6.1-sol", "claude-code:haiku@xhigh"], from: 3 },
    ],
    limit: "claude-code:claude-opus-5-5",
    master: ["claude-code:opus", "openai-plan:gpt-6.1-sol"],
    name: "shipped",
    outage: "openai-plan:gpt-6-luna",
    resume: "openai-plan:gpt-6.1-sol",
    ttl: "1h",
    what: "optchat.config.ts: Opus turns on the Claude plan, Luna and Sol compactions on the ChatGPT plan falling over to Haiku; the stopped turn goes on on Sol",
  },
];

// ---------------------------------------------------------------------------------------------
// the script

export type Step =
  | { readonly at: number; readonly type: "say"; readonly text: string }
  | { readonly at: number; readonly type: "connect" } // a client connects: the session primes
  | { readonly at: number; readonly type: "outage"; readonly on: boolean }
  | { readonly at: number; readonly type: "limit" } // the master's next turn hits a usage limit
  | { readonly at: number; readonly type: "resume" };

const MINUTE = 60_000;
export const START = Date.UTC(2026, 9, 1, 8);

// a chat of `turns` messages, the same every time for a seed
export const script = (turns: number, seed = 1): Step[] => {
  let s = seed;
  const rand = () => {
    s = Math.imul(1, s + 0x6D_2B_79_F5); // a 32-bit integer
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const span = (a: number, b: number) => a * (b / a) ** rand();
  const steps: Step[] = [];
  let at = START;
  for (let k = 0; k < turns; k++) {
    const r = rand();
    // most messages follow quickly, many after a break, some after hours: two hours at most
    const gap = k === 0 ? 0 : k % 25 === 12 ? 120 * MINUTE : r < 0.45 ? span(20_000, 4 * MINUTE) : r < 0.8 ? span(5 * MINUTE, 50 * MINUTE) : span(55 * MINUTE, 120 * MINUTE);
    at += Math.round(gap);
    if (gap >= 5 * MINUTE && rand() < 0.5) steps.push({ at: at - 20_000, type: "connect" });
    if (k === Math.floor(turns * 0.3)) steps.push({ at: at - 1000, on: true, type: "outage" });
    if (k === Math.floor(turns * 0.45)) steps.push({ at: at - 1000, on: false, type: "outage" });
    const stopped = k === Math.floor(turns * 0.6);
    if (stopped) steps.push({ at: at - 1000, type: "limit" });
    const toolCalls = Math.floor(rand() * 5);
    const words = Math.round(span(8, 300));
    steps.push({ at, text: `message ${k} [steps ${toolCalls}] ${Array.from({ length: words }, (_, w) => `w${(hash(`${seed}:${k}:${w}`) % 5000).toString(36)}`).join(" ")}`, type: "say" });
    if (stopped) steps.push({ at: at + 30_000, type: "resume" });
    // sent while the turn runs: taken after its first tool results
    else if (k % 6 === 5 && toolCalls > 0) steps.push({ at: at + 1500, text: `and also ${k} [steps 0] look at the other one too`, type: "say" });
  }
  return steps;
};

// ---------------------------------------------------------------------------------------------
// one replay

export type Replay = {
  readonly layout: Layout;
  readonly sent: readonly Sent[];
  readonly usage: readonly UsageRecord[];
  readonly reports: readonly string[];
  readonly messages: number;
  readonly batches: number; // times the view merged a batch, as seen before each message
  readonly refused: readonly string[]; // requests the cache rules say the API would refuse (A2, O1)
};

const FOLDERS = ["~/repos"];
const DEVICE = "mini";

// `marks`: the view's and the compaction view's sawtooths, smaller in the test so a short chat
// still merges batches; none: docs/optchat.md's
export const replay = async (layout: Layout, steps: readonly Step[], marks?: { readonly view: Marks; readonly compaction: Marks }): Promise<Replay> => {
  const dir = mkdtempSync(`${tmpdir()}/oc-replay-`);
  const clock = makeSimClock(START);
  const vendors = makeVendors();
  const usage: UsageRecord[] = [];
  const reports: string[] = [];
  const settings = parseSettings({
    allowedLogins: [],
    apiKey: { monthlyBudget: 1_000_000, prices: apiKeyPrices },
    cache: { claudeCodeTtl: layout.ttl, primeTtl: layout.ttl },
    compactor: { byLevel: layout.compactor, effort: "medium" },
    defaultDevice: DEVICE,
    devices: { [DEVICE]: { folders: FOLDERS, url: "http://mini:7710" } },
    master: { chain: layout.master, effort: "high", permissionMode: "bypassPermissions" },
  });
  type Handles = { readonly session: Effect.Success<ReturnType<typeof makeSession>>; readonly messages: () => number; readonly size: () => number };
  const { promise: handles, resolve: ready } = Promise.withResolvers<Handles>();
  const log = (r: UsageRecord) => Effect.sync(() => void usage.push(r));
  const report = (m: string) => Effect.sync(() => void reports.push(m));
  const program = Effect.gen(function* () {
    const bearer = { current: Effect.succeed("token"), renew: () => Effect.succeed("token") };
    const plan = { respond: yield* makeResponses({ api: "http://plan/v1", bearer, label: "openai-plan" }) };
    const apiKeys = {
      anthropic: yield* makeMessages({ base: "http://anthropic", key: Effect.succeed("key") }),
      openai: yield* makeResponses({ api: "http://openai/v1", bearer, label: "api-key: openai" }),
    };
    const budget = { check: Effect.void, note: () => Effect.void, spent: () => 0 };
    const needs = { apiKeys: Effect.succeed(apiKeys), budget, log, plan: Effect.succeed(plan), report, settings };
    const instructions = systemPrompt(dir);
    const placement: Placement = { cwd: dir, mcpConfig: '{"mcpServers":{}}', mcpSeen: () => Effect.succeed(false), runner: vendors.claude };
    const defs = toolDefs({ device: DEVICE, folders: FOLDERS });
    const box = { defs, run: (_name: string, input: string) => Effect.succeed(toolOk(readText(/"file_path":"([^"]*)"/.exec(input)?.[1] ?? input))) };
    const compactor = yield* makeSummarize({ ...needs, device: DEVICE, gate: makeGate(), instructions, placement: Effect.succeed(placement), tools: defs });
    const chat = yield* openChat(dir, { compactionMarks: marks?.compaction, marks: marks?.view, report, rest: WAIT_RETRY, summarize: compactor.summarize });
    const master = yield* makeMaster(settings.master.chain.map((r) => ({ label: r.ref, ref: r.ref })), settings.master.effort);
    const engines = yield* Effect.forEach(settings.master.chain, (ref) =>
      turnEngine(ref, { ...needs, instructions, runnerFor: () => Effect.succeed(placement), toolsFor: () => box }, masterPolicy(() => master.latest() === ref.ref)),
    );
    const session = yield* makeSession({
      chat,
      commit: Effect.succeed(null),
      compactorDown: compactor.down,
      defaultDevice: DEVICE,
      devices: [DEVICE],
      engines,
      logUsage: log,
      master,
      media: noMedia,
    });
    yield* Effect.sync(() => {
      ready({ messages: () => chat.mem.root.length, session, size: () => viewSize(chat.mem) });
    });
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, vendors.http));
  const fiber = clock.fork(program);
  // a session that could not start fails the replay rather than leaving it waiting
  const ended = clock.run(Fiber.await(fiber)).then((exit): never => {
    throw new Error(`the session ended before the script did: ${String(exit)}`);
  });
  ended.catch(() => null);
  try {
    const { messages, session, size } = await Promise.race([handles, ended]);
    let batches = 0, last = 0;
    for (const step of steps) {
      await clock.advanceTo(step.at);
      if (size() < last) batches++;
      last = size();
      switch (step.type) {
        case "say":
          await clock.run(session.input(step.text, { clientId: `m${step.at}` }));
          break;
        case "connect":
          await clock.run(session.primeSoon);
          break;
        case "outage":
          if (step.on) vendors.out.add(layout.outage);
          else vendors.out.delete(layout.outage);
          break;
        case "limit":
          vendors.limitOnce.add(layout.limit);
          break;
        case "resume":
          if (session.state().phase === "needs-model") await clock.run(session.resume(layout.resume));
          break;
      }
    }
    // the last turn ends, its lines are built, the view is primed
    await clock.advanceTo((steps.at(-1)?.at ?? START) + 3 * 60 * MINUTE);
    return { batches, layout, messages: messages(), refused: vendors.refused, reports, sent: vendors.sent, usage };
  } finally {
    await clock.run(Fiber.interrupt(fiber));
    rmSync(dir, { force: true, recursive: true });
  }
};

// ---------------------------------------------------------------------------------------------
// the numbers

// what a vendor engine's model costs per million tokens: Anthropic's from the price table, the
// Claude plan's priced as on a key; none for OpenAI's
const priceOf = (engine: string): Price | undefined => {
  const model = /^(?:api-key:anthropic\/|claude-code:)(.+)$/.exec(engine)?.[1];
  const prices: Readonly<Record<string, Price>> = apiKeyPrices;
  return model === undefined ? undefined : prices[`anthropic/${modelOf(model)}`];
};

export type Row = {
  readonly layout: string;
  readonly engine: string;
  readonly role: Role;
  readonly requests: number;
  readonly read: number;
  readonly write5m: number;
  readonly write1h: number;
  readonly input: number;
  readonly output: number;
  readonly cold: number; // turns whose first request read less than half its input (usage.ts isCold)
  readonly dollars: number | null;
};

// whether a request opens its call: no request before it sent a prompt it starts with (a turn's
// first request, a compaction's first try)
export const openings = (sent: readonly Sent[]) => {
  const ends = new Set<string>();
  const first = new Set<Sent>();
  for (const s of sent) {
    if (!s.use.keys.some((key) => ends.has(key))) first.add(s);
    if (s.role !== "prime") ends.add(s.use.keys.at(-1) ?? "");
  }
  return (s: Sent) => first.has(s);
};

export const rows = (r: Replay): Row[] => {
  const opens = openings(r.sent);
  const groups = new Map<string, Sent[]>();
  for (const s of r.sent) groups.set(`${s.engine}\u0000${s.role}`, [...(groups.get(`${s.engine}\u0000${s.role}`) ?? []), s]);
  return [...groups].map(([key, sent]) => {
    const [engine = "", role = "turn"] = key.split("\u0000");
    const sum = (f: (s: Sent) => number) => sent.reduce((n, s) => n + f(s), 0);
    const price = priceOf(engine);
    const tokens = { cacheRead: sum((s) => s.use.read), cacheWrite: sum((s) => s.use.write5m + s.use.write1h), input: sum((s) => s.use.input), output: sum((s) => s.output) };
    const cold = role === "turn" ? sent.filter((s) => opens(s) && s.use.read * 2 < s.use.total).length : 0;
    return {
      cold,
      dollars: price === undefined ? null : dollarsOf(price, tokens, { h1: sum((s) => s.use.write1h), m5: sum((s) => s.use.write5m) }),
      engine,
      input: tokens.input,
      layout: r.layout.name,
      output: tokens.output,
      read: tokens.cacheRead,
      requests: sent.length,
      role: role === "prime" || role === "compact" ? role : "turn",
      write1h: sum((s) => s.use.write1h),
      write5m: sum((s) => s.use.write5m),
    };
  });
};

// the share of a set of requests' input read from the cache
export const readShare = (rs: readonly Row[]) => {
  const read = rs.reduce((n, r) => n + r.read, 0);
  const all = rs.reduce((n, r) => n + r.read + r.write5m + r.write1h + r.input, 0);
  return all === 0 ? 0 : read / all;
};

const k = (n: number) => (n >= 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
export const table = (rs: readonly Row[]) => {
  const head = ["layout", "engine", "role", "requests", "read", "written 5m", "written 1h", "uncached", "read %", "cold turns", "$"];
  const body = rs.map((r) => [
    r.layout,
    r.engine,
    r.role,
    String(r.requests),
    k(r.read),
    k(r.write5m),
    k(r.write1h),
    k(r.input),
    (100 * readShare([r])).toFixed(1),
    r.role === "turn" ? String(r.cold) : "",
    r.dollars === null ? "—" : r.dollars.toFixed(2),
  ]);
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((b) => `| ${b.join(" | ")} |`)].join("\n");
};

// ---------------------------------------------------------------------------------------------
// the invariants SPEC claims, as lists of what breaks them (empty: they hold)

// Each request reads everything the request before it in the same call sent: a turn's next tool
// round, a size retry (docs/optchat.md §3.3; SPEC M5 "each request reads everything the one before
// sent"). The one before is the latest whose whole prompt this one starts with.
export const unreadContinuations = (sent: readonly Sent[]) => {
  const byEnd = new Map<string, Sent>();
  const broken: string[] = [];
  let checked = 0;
  for (const s of sent) {
    const before = s.use.keys.flatMap((key) => byEnd.get(key) ?? []).at(-1);
    if (before && before.begun && s.at - before.at < TTL_MS["5m"]) {
      checked++;
      if (s.use.read < before.use.total) broken.push(`${s.engine} ${s.role} at ${s.at - START} read ${s.use.read} of the ${before.use.total} the request before sent`);
    }
    if (s.role !== "prime") byEnd.set(s.use.keys.at(-1) ?? "", s);
  }
  return { broken, checked };
};

// A turn right after a priming of its view reads the whole primed view (SPEC "Priming"): the
// priming's marked part, everything but its "ok". Returns the turns it held for, and those it broke.
export const primedTurns = (sent: readonly Sent[], ttl: Ttl) => {
  const primes = sent.filter((s) => s.role === "prime" && s.begun);
  let warm = 0;
  const broken: string[] = [];
  const continuing = new Set(sent.flatMap((s) => s.use.keys.slice(0, -1)));
  for (const t of sent) {
    if (t.role !== "turn" || !t.engine.startsWith("claude-code:") || continuing.has(t.use.keys.at(-1) ?? "")) continue;
    const keys = new Set(t.use.keys);
    const p = primes.findLast((x) => x.at < t.at && t.at - x.at < TTL_MS[ttl] && x.engine === t.engine && keys.has(x.use.keys.at(-2) ?? ""));
    if (p === undefined) continue;
    if (t.use.read >= p.use.total - p.use.input) warm++;
    else broken.push(`the turn at ${t.at - START} read ${t.use.read} of the ${p.use.total - p.use.input} its priming wrote`);
  }
  return { broken, warm };
};

// No compaction writes a prefix of its context another compaction is writing or has written within
// its TTL: single flight (E50) makes the second one wait and read it. Only the context's marks: a
// mark on the system prompt is not in a compaction's prefix key (E26).
export const doubleWrites = (sent: readonly Sent[]) => {
  const written = new Map<string, Sent>();
  const broken: string[] = [];
  let checked = 0;
  for (const s of sent) {
    if (s.role !== "compact") continue;
    for (const w of s.use.wrote) {
      if (w.tier !== "message") continue;
      checked++;
      const before = written.get(w.key);
      if (before && before.begun && s.at < before.at + TTL_MS[w.ttl] && s !== before)
        broken.push(`${s.engine} at ${s.at - START} wrote a prefix ${before.engine} wrote at ${before.at - START}`);
      written.set(w.key, s);
    }
  }
  return { broken, checked };
};

// Compactions that read an entry a turn wrote (E26): on an API key's Anthropic, through the mark on
// the system prompt, when the compactor runs on the turns' model; on claude-code never, since its
// DISABLE_PROMPT_CACHING=1 drops Claude Code's own marks there. With the tokens they read so.
export const turnEntriesRead = (sent: readonly Sent[]) => {
  const byTurn = new Set(sent.flatMap((s) => (s.role === "turn" ? s.use.wrote.map((w) => w.key) : [])));
  const reads = sent.filter((s) => s.role === "compact" && s.use.readKey !== null && byTurn.has(s.use.readKey));
  return { requests: reads.length, tokens: reads.reduce((n, s) => n + s.use.read, 0) };
};

// whether a vendor engine is Anthropic's, whose usage reports what it wrote
const anthropic = (engine: string) => !engine.startsWith("openai-plan:") && !engine.startsWith("api-key:openai/");

// What the engines logged to usage.jsonl against what the vendors said: the tokens read, and on
// Anthropic the tokens written (the Responses API reports no writes). The two must agree (SPEC
// "Usage and cost tracking").
export const accounting = (r: Replay) => {
  const begun = r.sent.filter((s) => s.begun);
  return {
    logged: { read: r.usage.reduce((n, u) => n + u.usage.cacheRead, 0), written: r.usage.reduce((n, u) => n + u.usage.cacheWrite, 0) },
    vendor: { read: begun.reduce((n, s) => n + s.use.read, 0), written: begun.filter((s) => anthropic(s.engine)).reduce((n, s) => n + s.use.write5m + s.use.write1h, 0) },
  };
};

// one layout in a few numbers: the share of turns' and compactions' input read from the cache, the
// cold turns, every token written, and the dollars at the price table (Anthropic's engines only)
export const summary = (r: Replay) => {
  const rs = rows(r);
  return {
    cold: rs.reduce((n, x) => n + x.cold, 0),
    compactRead: readShare(rs.filter((x) => x.role === "compact")),
    dollars: rs.reduce((n, x) => n + (x.dollars ?? 0), 0),
    turnRead: readShare(rs.filter((x) => x.role === "turn")),
    written: rs.reduce((n, x) => n + x.write5m + x.write1h, 0),
  };
};

// the test's chat: 36 messages (about 200 log entries with their tool calls and replies) on
// sawtooths a quarter of docs/optchat.md's, so it merges two batches of the view in a few seconds
export const TEST_TURNS = 36;
export const TEST_MARKS = { compaction: { high: 6000, low: 3000 }, view: { high: 24_000, low: 12_000 } } as const;

// every check above, for one replay
export const checks = (r: Replay) => ({
  accounting: accounting(r),
  continuations: unreadContinuations(r.sent),
  doubleWrites: doubleWrites(r.sent),
  primed: primedTurns(r.sent, r.layout.ttl),
  turnEntries: turnEntriesRead(r.sent),
});
