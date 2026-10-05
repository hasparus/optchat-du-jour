#!/usr/bin/env bun
// The compactor bake-off (SPEC "Compactor calls", Bake-off (M3)): replay the same real messages
// through each compactor chain, each into its own temp data dir, and compare retries per node,
// usage per message, how much of the user's own wording survives up the tree, and whether the
// tree leads back to what was said. Run by hand; it calls real models.
//
//   bun dev/bakeoff.ts --from ~/.optchat/streams/mini --n 500 \
//     --chain "luna=openai-plan:gpt-6-luna" --chain "split=0:openai-plan:gpt-6-luna;3:openai-plan:gpt-6.1-sol" \
//     --chain "sonnet=claude-code:sonnet" --out bakeoff.json
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import { LocalRunner } from "../src/claude/process.ts";
import type { Summarize } from "../src/compactor.ts";
import { NODE, type Settings, loadSettings, parseRef } from "../src/config.ts";
import { parseOptmem } from "../src/import.ts";
import { zoom } from "../src/mcp.ts";
import { openAiPlanLayer } from "../src/openai/responses.ts";
import { HOME } from "../src/paths.ts";
import type { Kind } from "../src/records.ts";
import { SecretsLive } from "../src/secrets.ts";
import { loadChat } from "../src/store.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { built, getNode, type Mem, nodes } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { render, settle } from "../src/view.ts";

export type Message = { readonly kind: Kind; readonly text: string };
export type Contender = { readonly name: string; readonly byLevel: Settings["compactor"]["byLevel"] };

// "name=ref,ref" for one chain at every level, or "name=0:ref,ref;3:ref,ref" per level; each ref
// one this build runs as a compactor
export function parseContender(spec: string): Contender {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`--chain ${spec}: expected name=chain`);
  const byLevel = spec
    .slice(eq + 1)
    .split(";")
    .map((part) => {
      const m = /^(\d+):(?=[a-z])/.exec(part);
      const refs = (m ? part.slice(m[0].length) : part).split(",").map((r) => {
        const parsed = parseRef("compactor", r.trim());
        if (Result.isFailure(parsed)) throw new Error(`--chain ${spec}: ${parsed.failure}`);
        return r.trim();
      });
      const [first, ...rest] = refs;
      if (first === undefined) throw new Error(`--chain ${spec}: an empty chain`);
      return { chain: [first, ...rest] as const, from: m ? Number(m[1]) : 0 };
    });
  const [head, ...tail] = byLevel;
  if (head?.from !== 0) throw new Error(`--chain ${spec}: the first chain must start at level 0`);
  return { byLevel: [head, ...tail], name: spec.slice(0, eq) };
}

// the messages to replay: a data dir's log, or an OptMem LOG.txt (every record a `note`)
export const readSource = (path: string, n: number, skip = 0) =>
  Effect.gen(function* () {
    if (statSync(path).isDirectory()) {
      const { mem } = yield* loadChat(path, { repair: false, view: false });
      return mem.root.slice(skip, skip + n).map((m): Message => ({ kind: m.kind, text: m.text }));
    }
    return parseOptmem(readFileSync(path, "utf8"))
      .slice(skip, skip + n)
      .map((note): Message => ({ kind: "note", text: note.text }));
  });

// A usage record with the node whose call it was ("l.i"): the pump's retries, the chain's
// failovers and every size retry of one node all land on the same key.
export type Logged = UsageRecord & { readonly node: string | null };
export type Replayed = {
  readonly contender: Contender;
  readonly dir: string;
  readonly mem: Mem;
  readonly records: readonly Logged[];
  readonly reports: readonly string[];
  readonly logged: number; // messages logged before the deadline
  readonly unbuilt: readonly string[]; // nodes ("l.i") still unbuilt when the replay ended
};

// the node the current compactor call is for, read where its usage is logged
const CurrentNode = Context.Reference<string | null>("bakeoff/CurrentNode", { defaultValue: () => null });

const unbuiltOf = (mem: Mem) => [...nodes(mem.root.length)].filter((c) => !built(mem, c)).map((c) => `${c.l}.${c.i}`);

// One contender: log each message as a live chat would, wait until the view is summarized (a
// turn waits for that too, gist §6), then let the pump finish every node. At the deadline it
// stops where it is and says what is left: a failing engine retries forever (gist rule 3).
export const replay = <R>(o: {
  readonly contender: Contender;
  readonly messages: readonly Message[];
  readonly summarizeFor: (contender: Contender, log: (r: UsageRecord) => Effect.Effect<void>, report: (m: string) => Effect.Effect<void>) => Effect.Effect<Summarize, never, R>;
  readonly poll?: Duration.Input;
  readonly budget?: number; // a smaller view than VIEW, to make a short replay fold
  readonly deadline?: Duration.Input; // 2 hours
  readonly retry?: Duration.Input; // the pump's, RETRY
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = mkdtempSync(`${tmpdir()}/bake-`);
      const records: Logged[] = [], reports: string[] = [];
      const report = (m: string) => Effect.sync(() => void reports.push(m));
      const log = (r: UsageRecord) =>
        Effect.gen(function* () {
          records.push({ ...r, node: yield* CurrentNode });
          const failed = yield* logUsage(`${dir}/usage.jsonl`, r);
          if (failed) yield* report(failed);
        });
      const summarize = yield* o.summarizeFor(o.contender, log, report);
      const chat = yield* openChat(dir, {
        budget: o.budget,
        report,
        retry: o.retry,
        summarize: (job) => summarize(job).pipe(Effect.provideService(CurrentNode, `${job.l}.${job.i}`)),
      });
      let logged = 0;
      const deadline = o.deadline ?? "2 hours";
      const finished = yield* Effect.gen(function* () {
        for (const m of o.messages) {
          yield* chat.log(m.kind, m.text);
          logged++;
          yield* settle(chat.mem);
        }
        while (unbuiltOf(chat.mem).length > 0) yield* Effect.sleep(o.poll ?? "200 millis");
      }).pipe(Effect.timeoutOption(deadline));
      const unbuilt = unbuiltOf(chat.mem);
      if (Option.isNone(finished))
        yield* report(`deadline (${Duration.format(Duration.fromInputUnsafe(deadline))}): ${logged} of ${o.messages.length} messages logged, ${unbuilt.length} nodes unbuilt`);
      return { contender: o.contender, dir, logged, mem: chat.mem, records, reports, unbuilt } satisfies Replayed;
    }),
  );

// ---------------------------------------------------------------------------------------------
// Measures

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

// Model calls per node that needed any: every logged try for the node, whichever engine made it,
// size retries, failed tries, the pump's retries and the calls after a failover alike.
export function triesPerNode(records: readonly Logged[]) {
  const per = new Map<string, number>();
  for (const r of records) if (r.role === "compact" && r.node !== null) per.set(r.node, (per.get(r.node) ?? 0) + 1);
  const tries = [...per.values()].sort((a, b) => a - b);
  let sum = 0;
  for (const t of tries) sum += t;
  return { max: tries.at(-1) ?? 0, mean: tries.length > 0 ? sum / tries.length : 0, nodes: tries.length, p95: quantile(tries, 0.95) };
}

// model calls and tokens per replayed message, failovers, and dollars where a record has them
export function cost(records: readonly UsageRecord[], messages: number) {
  const per = (x: number) => (messages ? x / messages : 0);
  const total = { cacheRead: 0, cacheWrite: 0, dollars: 0, input: 0, output: 0 };
  for (const r of records) {
    total.input += r.usage.input;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.output += r.usage.output;
    total.dollars += r.dollars ?? 0;
  }
  return {
    callsPerMessage: per(records.length),
    cold: records.filter((r) => r.cold).length,
    dollarsPerMessage: per(total.dollars),
    failovers: records.filter((r) => r.failoverFrom !== null && r.attempt === 1).length,
    tokensPerMessage: { cacheRead: per(total.cacheRead), cacheWrite: per(total.cacheWrite), input: per(total.input), output: per(total.output) },
  };
}

// words of a text, lowercased, letters and digits only
export const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
const SPAN = 4; // a run of 4 of the user's words in a row counts as quoting them

// the user's sentences worth quoting: at least SPAN words
export const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(words)
    .filter((w) => w.length >= SPAN);

// the item with the highest score, the first of equals
function best<A>(items: readonly A[], score: (a: A) => number): A | null {
  let top: A | null = null, high = -1;
  for (const a of items) {
    const s = score(a);
    if (s > high) [top, high] = [a, s];
  }
  return top;
}

const runs = (w: readonly string[]) => {
  const out = new Set<string>();
  for (let k = 0; k + SPAN <= w.length; k++) out.add(w.slice(k, k + SPAN).join(" "));
  return out;
};

// User's words kept, at each level: of the user's sentences whose node at that level is built,
// how many still have a run of SPAN words verbatim (`quoted`), and the mean share of their runs
// that do (`recall`). Level 0 is the baseline the levels above can only lose from.
export function wordsKept(mem: Mem, levels: readonly number[] = [0, 2, 3], kinds: readonly Kind[] = ["user"]) {
  return levels.map((l) => {
    let total = 0, quoted = 0, recall = 0;
    for (const m of mem.root) {
      if (!kinds.includes(m.kind)) continue;
      const n = getNode(mem, { i: m.i >> l, l });
      if (!n) continue;
      const have = runs(words(n.text));
      for (const s of sentences(m.text)) {
        const mine = [...runs(s)];
        const kept = mine.filter((r) => have.has(r)).length;
        total++;
        if (kept > 0) quoted++;
        recall += kept / mine.length;
      }
    }
    return { level: l, quoted: total ? quoted / total : 0, recall: total ? recall / total : 0, sentences: total };
  });
}

// over NODE after every try: kept anyway (gist §4.3), but worth counting
export const overLimit = (mem: Mem) => [...mem.tree.values()].filter((n) => n.size > NODE).length;

// ---------------------------------------------------------------------------------------------
// Findability: questions from the raw messages, answered with only the view and zoom. The
// question generator and the lexical answerer below need no model; a model-backed answerer (an
// agent given the view and a zoom tool) plugs into the same type when the real runs happen.

export type Question = { readonly source: number; readonly question: string; readonly answer: string };
export type Tools = { readonly view: string; readonly zoom: (id: number, n: number) => string };
export type Answerer<R> = (q: Question, tools: Tools) => Effect.Effect<string, never, R>;

// Fill-in-the-blank from the user's own sentences, spread evenly over the log: the longest word
// of a sentence is the answer, the rest of the sentence is the question.
export function questions(messages: readonly Message[], count: number, kinds: readonly Kind[] = ["user"]): Question[] {
  const pool: Question[] = [];
  for (const [i, m] of messages.entries()) {
    if (!kinds.includes(m.kind)) continue;
    for (const s of sentences(m.text)) {
      const answer = best(s, (w) => w.length) ?? "";
      if (answer.length < 5) continue;
      pool.push({ answer, question: `Which word did the user write in: "${s.map((w) => (w === answer ? "___" : w)).join(" ")}"?`, source: i });
      break; // one per message
    }
  }
  const step = Math.max(1, pool.length / Math.max(1, count));
  const out: Question[] = [];
  for (let k = 0; out.length < count && Math.floor(k) < pool.length; k += step) {
    const q = pool[Math.floor(k)];
    if (q) out.push(q);
  }
  return out;
}

const LINE = /^(\d+)\+(\d+)\|(.*)$/;
const lines = (text: string) =>
  text.split("\n").flatMap((l) => {
    const m = LINE.exec(l);
    return m ? [{ id: Number(m[1]), n: Number(m[2]), text: m[3] ?? "" }] : [];
  });

// The lexical baseline: open the line that shares the most words with the question, down to a
// message, and answer with that message. It finds only what the tree's words point to.
export const lexicalAnswerer: Answerer<never> = (q, tools) =>
  Effect.sync(() => {
    const want = new Set(words(q.question));
    const score = (text: string) => words(text).filter((w) => want.has(w)).length;
    let options = lines(tools.view);
    for (;;) {
      const pick = best(options, (o) => score(o.text));
      if (pick === null) return "";
      if (pick.n <= 1) return tools.zoom(pick.id, 1);
      options = lines(tools.zoom(pick.id, pick.n));
    }
  });

export const findability = <R>(mem: Mem, qs: readonly Question[], answer: Answerer<R>) =>
  Effect.gen(function* () {
    const tools: Tools = { view: render(mem), zoom: (id, n) => zoom(mem, id, n) };
    let found = 0;
    for (const q of qs) if (words(yield* answer(q, tools)).includes(q.answer)) found++;
    return { asked: qs.length, found, share: qs.length > 0 ? found / qs.length : 0 };
  });

export const measure = <R>(r: Replayed, all: readonly Message[], o: { readonly questions: number; readonly answerer: Answerer<R>; readonly kinds?: readonly Kind[] }) =>
  Effect.gen(function* () {
    const kinds: readonly Kind[] = o.kinds ?? ["user"];
    const messages = all.slice(0, r.logged);
    return {
      contender: r.contender.name,
      cost: cost(r.records, messages.length),
      dir: r.dir,
      findability: yield* findability(r.mem, questions(messages, o.questions, kinds), o.answerer),
      messages: messages.length,
      nodes: r.mem.tree.size,
      overLimit: overLimit(r.mem),
      reports: r.reports.length,
      tries: triesPerNode(r.records),
      unbuilt: r.unbuilt.length,
      wordsKept: wordsKept(r.mem, [0, 2, 3], kinds),
    };
  });
export type Measured = Effect.Success<ReturnType<typeof measure>>;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const table = (rows: readonly Measured[]) =>
  [
    "contender | tries per node mean / p95 | over 512 | unbuilt | calls/msg | in / cached / out tokens per msg | failovers | words kept L0 / L2 / L3 (quoted) | findable",
    ...rows.map((m) => {
      const t = m.cost.tokensPerMessage;
      const kept = m.wordsKept.map((w) => pct(w.quoted)).join(" / ");
      return `${m.contender} | ${m.tries.mean.toFixed(2)} / ${m.tries.p95} | ${m.overLimit} | ${m.unbuilt} | ${m.cost.callsPerMessage.toFixed(2)} | ${Math.round(t.input)} / ${Math.round(t.cacheRead)} / ${Math.round(t.output)} | ${m.cost.failovers} | ${kept} | ${pct(m.findability.share)} of ${m.findability.asked}`;
    }),
  ].join("\n");

// ---------------------------------------------------------------------------------------------
// The command: real engines, from this repo's optchat.config.ts

// a whole number of at least `min`, or null
const count = (raw: string, min: number) => (/^\d+$/.test(raw) && Number(raw) >= min ? Number(raw) : null);
const USAGE =
  "usage: bun dev/bakeoff.ts --from <data dir | LOG.txt> --chain name=chain [--chain …] [--n 500] [--skip 0] [--kinds user] [--questions 50] [--deadline 120 (minutes)] [--out file.json]";

const main = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      chain: { multiple: true, type: "string" },
      deadline: { default: "120", type: "string" }, // minutes per contender
      from: { type: "string" },
      kinds: { default: "user", type: "string" },
      n: { default: "500", type: "string" },
      out: { type: "string" },
      questions: { default: "50", type: "string" },
      skip: { default: "0", type: "string" },
    },
  });
  const n = count(values.n, 1), skip = count(values.skip, 0), questionCount = count(values.questions, 0), deadline = count(values.deadline, 1);
  if (values.from === undefined || !existsSync(values.from) || !values.chain?.length || n === null || skip === null || questionCount === null || deadline === null)
    return yield* Console.error(USAGE);
  const { chain } = values;
  const contenders = Result.try({ catch: (e) => (e instanceof Error ? e.message : String(e)), try: () => chain.map(parseContender) });
  if (Result.isFailure(contenders)) return yield* Console.error(`${contenders.failure}\n${USAGE}`);
  const root = new URL("..", import.meta.url).pathname;
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const messages = yield* readSource(values.from, n, skip);
  const kinds = values.kinds.split(",").map((k) => Schema.decodeUnknownSync(Schema.Literals(["user", "talk", "tool", "echo", "note"]))(k));
  const engines = Layer.mergeAll(LocalRunner, openAiPlanLayer(settings.openai, { report: (m) => Console.error(m) }).pipe(Layer.provide([SecretsLive, FetchHttpClient.layer]))).pipe(
    Layer.provide(BunServices.layer),
  );
  // api-key contenders: the real keys, and every call counted against the month's budget like the server's
  const clients = Context.get(yield* Layer.build(apiKeysLayer(settings.apiKey).pipe(Layer.provide([SecretsLive, FetchHttpClient.layer]))), ApiKeys);
  const budget = makeBudget({ monthly: settings.apiKey?.monthlyBudget ?? 0, report: (m) => Console.error(m), usagePath: `${HOME}/usage.jsonl` });
  const rows: Measured[] = [];
  for (const contender of contenders.success) {
    yield* Console.error(`${contender.name}: replaying ${messages.length} messages`);
    const replayed = yield* replay({
      contender,
      deadline: Duration.minutes(deadline),
      messages,
      summarizeFor: (c, log, report) => makeSummarize({ apiKey: { budget, clients }, log: (r) => budget.note(r).pipe(Effect.andThen(log(r))), report, settings: { ...settings, compactor: { ...settings.compactor, byLevel: c.byLevel } } }).pipe(
          Effect.map((m) => m.summarize),
        ),
    }).pipe(Effect.provide(engines));
    for (const r of replayed.reports) yield* Console.error(`${contender.name}: ${r}`);
    rows.push(yield* measure(replayed, messages, { answerer: lexicalAnswerer, kinds, questions: questionCount }));
  }
  yield* Console.log(table(rows));
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(rows, null, 2)}\n`);
});

if (import.meta.main) BunRuntime.runMain(Effect.scoped(main));
