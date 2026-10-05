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
import { Console, type Duration, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { openChat } from "../src/chat.ts";
import { LocalRunner } from "../src/claude/process.ts";
import type { Summarize } from "../src/compactor.ts";
import { NODE, type Settings, loadSettings } from "../src/config.ts";
import { parseOptmem } from "../src/import.ts";
import { zoom } from "../src/mcp.ts";
import { openAiPlanLayer } from "../src/openai/responses.ts";
import type { Kind } from "../src/records.ts";
import { SecretsLive } from "../src/secrets.ts";
import { loadChat } from "../src/store.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { built, getNode, type Mem, nodes } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { render, settle } from "../src/view.ts";

export type Message = { readonly kind: Kind; readonly text: string };
export type Contender = { readonly name: string; readonly byLevel: Settings["compactor"]["byLevel"] };

const EngineRef = Schema.String.check(Schema.isPattern(/^(claude-code|openai-plan|api-key):.+$/));
const decodeRef = Schema.decodeUnknownSync(EngineRef);

// "name=ref,ref" for one chain at every level, or "name=0:ref,ref;3:ref,ref" per level
export function parseContender(spec: string): Contender {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`--chain ${spec}: expected name=chain`);
  const byLevel = spec
    .slice(eq + 1)
    .split(";")
    .map((part) => {
      const m = /^(\d+):(?=[a-z])/.exec(part);
      const refs = (m ? part.slice(m[0].length) : part).split(",").map((r) => decodeRef(r.trim()));
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

export type Replayed = { readonly contender: Contender; readonly dir: string; readonly mem: Mem; readonly records: readonly UsageRecord[]; readonly reports: readonly string[] };

const complete = (mem: Mem) => {
  for (const c of nodes(mem.root.length)) if (!built(mem, c.l, c.i)) return false;
  return true;
};

// One contender: log each message as a live chat would, wait until the view is summarized (a
// turn waits for that too, gist §6), then let the pump finish every node.
export const replay = <R>(o: {
  readonly contender: Contender;
  readonly messages: readonly Message[];
  readonly summarizeFor: (contender: Contender, log: (r: UsageRecord) => Effect.Effect<void>, report: (m: string) => Effect.Effect<void>) => Effect.Effect<Summarize, never, R>;
  readonly poll?: Duration.Input;
  readonly budget?: number; // a smaller view than VIEW, to make a short replay fold
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = mkdtempSync(`${tmpdir()}/bake-`);
      const records: UsageRecord[] = [], reports: string[] = [];
      const report = (m: string) => Effect.sync(() => void reports.push(m));
      const log = (r: UsageRecord) =>
        Effect.gen(function* () {
          records.push(r);
          const failed = yield* logUsage(`${dir}/usage.jsonl`, r);
          if (failed) yield* report(failed);
        });
      const summarize = yield* o.summarizeFor(o.contender, log, report);
      const chat = yield* openChat(dir, { budget: o.budget, report, summarize });
      for (const m of o.messages) {
        yield* chat.log(m.kind, m.text);
        yield* settle(chat.mem);
      }
      while (!complete(chat.mem)) yield* Effect.sleep(o.poll ?? "200 millis");
      return { contender: o.contender, dir, mem: chat.mem, records, reports } satisfies Replayed;
    }),
  );

// ---------------------------------------------------------------------------------------------
// Measures

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

// Tries per model-built node, from the usage records alone: a call that took k tries logged
// attempts 1..k, so the calls with at least k tries are the records with attempt k.
export function retries(records: readonly UsageRecord[]) {
  const atLeast = new Map<number, number>();
  for (const r of records) if (r.role === "compact") atLeast.set(r.attempt, (atLeast.get(r.attempt) ?? 0) + 1);
  const tries: number[] = [];
  for (const [k, count] of atLeast) for (let j = 0; j < count - (atLeast.get(k + 1) ?? 0); j++) tries.push(k);
  tries.sort((a, b) => a - b);
  let sum = 0;
  for (const t of tries) sum += t;
  return { calls: tries.length, mean: tries.length > 0 ? sum / tries.length : 0, p95: quantile(tries, 0.95) };
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
      const n = getNode(mem, l, m.i >> l);
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

export const measure = <R>(r: Replayed, messages: readonly Message[], o: { readonly questions: number; readonly answerer: Answerer<R>; readonly kinds?: readonly Kind[] }) =>
  Effect.gen(function* () {
    const kinds: readonly Kind[] = o.kinds ?? ["user"];
    return {
      contender: r.contender.name,
      cost: cost(r.records, messages.length),
      dir: r.dir,
      findability: yield* findability(r.mem, questions(messages, o.questions, kinds), o.answerer),
      messages: messages.length,
      nodes: r.mem.tree.size,
      overLimit: overLimit(r.mem),
      reports: r.reports.length,
      retries: retries(r.records),
      wordsKept: wordsKept(r.mem, [0, 2, 3], kinds),
    };
  });
export type Measured = Effect.Success<ReturnType<typeof measure>>;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const table = (rows: readonly Measured[]) =>
  [
    "contender | tries mean / p95 | over 512 | calls/msg | in / cached / out tokens per msg | failovers | words kept L0 / L2 / L3 (quoted) | findable",
    ...rows.map((m) => {
      const t = m.cost.tokensPerMessage;
      const kept = m.wordsKept.map((w) => pct(w.quoted)).join(" / ");
      return `${m.contender} | ${m.retries.mean.toFixed(2)} / ${m.retries.p95} | ${m.overLimit} | ${m.cost.callsPerMessage.toFixed(2)} | ${Math.round(t.input)} / ${Math.round(t.cacheRead)} / ${Math.round(t.output)} | ${m.cost.failovers} | ${kept} | ${pct(m.findability.share)} of ${m.findability.asked}`;
    }),
  ].join("\n");

// ---------------------------------------------------------------------------------------------
// The command: real engines, from this repo's optchat.config.ts

const main = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      chain: { multiple: true, type: "string" },
      from: { type: "string" },
      kinds: { default: "user", type: "string" },
      n: { default: "500", type: "string" },
      out: { type: "string" },
      questions: { default: "50", type: "string" },
      skip: { default: "0", type: "string" },
    },
  });
  if (values.from === undefined || !existsSync(values.from) || !values.chain?.length)
    return yield* Console.error("usage: bun dev/bakeoff.ts --from <data dir | LOG.txt> --chain name=chain [--chain …] [--n 500] [--skip 0] [--kinds user] [--questions 50] [--out file.json]");
  const root = new URL("..", import.meta.url).pathname;
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const messages = yield* readSource(values.from, Number(values.n), Number(values.skip));
  const kinds = values.kinds.split(",").map((k) => Schema.decodeUnknownSync(Schema.Literals(["user", "talk", "tool", "echo", "note"]))(k));
  const engines = Layer.mergeAll(LocalRunner, openAiPlanLayer(settings.openai).pipe(Layer.provide([SecretsLive, FetchHttpClient.layer]))).pipe(
    Layer.provide(BunServices.layer),
  );
  const rows: Measured[] = [];
  for (const contender of values.chain.map(parseContender)) {
    yield* Console.error(`${contender.name}: replaying ${messages.length} messages`);
    const replayed = yield* replay({
      contender,
      messages,
      summarizeFor: (c, log, report) => makeSummarize({ log, report, settings: { ...settings, compactor: { ...settings.compactor, byLevel: c.byLevel } } }),
    }).pipe(Effect.provide(engines));
    rows.push(yield* measure(replayed, messages, { answerer: lexicalAnswerer, kinds, questions: Number(values.questions) }));
  }
  yield* Console.log(table(rows));
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(rows, null, 2)}\n`);
});

if (import.meta.main) BunRuntime.runMain(main);
