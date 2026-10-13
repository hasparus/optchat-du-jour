#!/usr/bin/env bun
// The compactor bake-off (SPEC "Compactor calls", Bake-off (M3)): replay the same real messages
// through each compactor chain, each into its own temp data dir, and compare retries per node,
// usage per message, how much of the user's own wording survives up the tree, and whether the
// tree leads back to what was said. Run by hand; it calls real models.
// An entry may carry its own effort ("ref@effort"; --effort sets the default of the rest, else the
// config's compactor.effort). The spec's choice (docs/optchat.md §4), Haiku at xhigh, on the Claude
// plan and over an API key, against Sonnet at medium and high:
// An api-key contender needs the `apiKey` block of optchat.config.ts uncommented (a price for the
// model, a budget) and a stored key (`optchat key anthropic`); what it spends counts against the
// month's budget.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Console, Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import { LocalRunner, Runner } from "../src/claude/process.ts";
import type { Summarize } from "../src/compactor.ts";
import { NODE, type Settings, WAIT_RETRY, atRoleEffort, duplicateRefs, isEffort, loadSettings, parseRef } from "../src/config.ts";
import { parseOptmem } from "../src/import.ts";
import { zoom } from "../src/mcp.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { HOME } from "../src/paths.ts";
import type { Kind } from "../src/records.ts";
import { SecretsLive } from "../src/secrets.ts";
import { loadChat } from "../src/store.ts";
import { ModelError } from "../src/engines/errors.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { systemPrompt } from "../src/prompts.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import type { CompactAttemptHooks } from "../src/summarize/step.ts";
import { toolDefs } from "../src/tools/box.ts";
import { built, bytes, getNode, type Mem, nodes } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { render, settle } from "../src/view.ts";

export type Message = { readonly kind: Kind; readonly text: string };
export type Contender = { readonly name: string; readonly byLevel: Settings["compactor"]["byLevel"] };

export type StopReason =
  | { readonly type: "max-attempts"; readonly contender: string; readonly attempted: number; readonly max: number }
  | { readonly type: "usage-limit"; readonly contender: string; readonly engine: string; readonly node: string }
  | { readonly type: "deadline"; readonly contender: string; readonly duration: string }
  | { readonly type: "unbuilt"; readonly contender: string; readonly node: string }
  | { readonly type: "over-limit"; readonly contender: string; readonly node: string; readonly bytes: number; readonly limit: number }
  | { readonly type: "unexpected"; readonly contender: string | null };

export class BakeoffStopped extends Data.TaggedError("BakeoffStopped")<{ readonly reason: StopReason }> {}
export class BakeoffCliError extends Data.TaggedError("BakeoffCliError")<{ readonly phase: "run" | "setup" }> {}

export const controlledStopText = (reason: StopReason): string => `bake-off stopped: ${reason.type}`;
export const diagnosticCountText = (count: number): string => `bake-off diagnostics: ${count}`;

export type BakeoffController = {
  readonly maxAttempts: number;
  readonly failFast: boolean;
  readonly awaitStop: Effect.Effect<StopReason>;
  readonly hooks: (contender: string) => CompactAttemptHooks;
  readonly isStopped: () => boolean;
  readonly snapshot: () => { readonly attempts: number; readonly maxAttempts: number; readonly stop: StopReason | null };
  readonly stop: (reason: StopReason) => Effect.Effect<boolean>;
};

export function makeBakeoffController(maxAttempts: number, failFast = true): BakeoffController {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");
  const stopped = Deferred.makeUnsafe<StopReason>();
  let attempts = 0;
  let first: StopReason | null = null;
  let halted = false;
  const stop = (reason: StopReason): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      if ((!failFast && reason.type !== "max-attempts") || halted) return Effect.succeed(false);
      first ??= reason;
      halted = true;
      return Deferred.succeed(stopped, first);
    });
  const hooks = (contender: string): CompactAttemptHooks => ({
    beforeRequest: (_attempt) =>
      Effect.suspend(() => {
        if (halted) return Effect.fail(new ModelError({ message: `bake-off stopped: ${first?.type ?? "unknown"}` }));
        if (attempts >= maxAttempts) {
          const reason: StopReason = { attempted: attempts, contender, max: maxAttempts, type: "max-attempts" };
          return stop(reason).pipe(Effect.andThen(Effect.fail(new ModelError({ message: `bake-off attempt cap ${maxAttempts} reached` }))));
        }
        attempts++;
        return Effect.void;
      }),
    onFailure: (attempt, error) =>
      error._tag === "UsageLimit"
        ? stop({ contender, engine: attempt.engine, node: `${attempt.job.l}.${attempt.job.i}`, type: "usage-limit" }).pipe(Effect.asVoid)
        : Effect.void,
  });
  return { awaitStop: Deferred.await(stopped), failFast, hooks, isStopped: () => halted, maxAttempts, snapshot: () => ({ attempts, maxAttempts, stop: first }), stop };
}

// "name=ref,ref" for one chain at every level, or "name=0:ref,ref;3:ref,ref" per level; each ref
// decoded as the config decodes it
export function parseContender(spec: string): Contender {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`--chain ${spec}: expected name=chain`);
  const byLevel = spec
    .slice(eq + 1)
    .split(";")
    .map((part) => {
      const m = /^(\d+):(?=[a-z])/.exec(part);
      const refs = (m ? part.slice(m[0].length) : part).split(",").map((r) => {
        const parsed = parseRef(r.trim());
        if (Result.isFailure(parsed)) throw new Error(`--chain ${spec}: ${parsed.failure}`);
        return parsed.success;
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
      const { mem } = yield* loadChat(path, { view: false, writer: false });
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
  readonly stop: StopReason | null;
};

// the node the current compactor call is for, read where its usage is logged
const CurrentNode = Context.Reference<string | null>("bakeoff/CurrentNode", { defaultValue: () => null });

const unbuiltOf = (mem: Mem) => [...nodes(mem.root.length)].filter((c) => !built(mem, c)).map((c) => `${c.l}.${c.i}`);

// One contender: log each message as a live chat would, wait until the view is summarized (a
// turn waits for that too, docs/optchat.md §6), then let the pump finish every node. At the deadline it
// stops where it is and says what is left: a failing engine is tried again every `retry`, forever.
export const replay = <R>(o: {
  readonly contender: Contender;
  readonly messages: readonly Message[];
  readonly summarizeFor: (
    contender: Contender,
    log: (r: UsageRecord) => Effect.Effect<void>,
    report: (m: string) => Effect.Effect<void>,
    hooks?: CompactAttemptHooks,
  ) => Effect.Effect<Summarize, never, R>;
  readonly control?: BakeoffController;
  readonly poll?: Duration.Input;
  readonly budget?: number; // a smaller view than VIEW_HIGH (folded to half of it), to make a short replay fold
  readonly deadline?: Duration.Input; // 2 hours
  // how often a failed call is tried again: in a chat, at the next message (docs/optchat.md §4);
  // here, where no message comes while the replay waits, every `retry`
  readonly retry?: Duration.Input; // WAIT_RETRY
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
      const { control } = o;
      const rawSummarize = yield* o.summarizeFor(o.contender, log, report, control?.hooks(o.contender.name));
      const summarize: Summarize =
        control === undefined
          ? rawSummarize
          : (job) =>
              rawSummarize(job).pipe(
                Effect.tap((line) =>
                  bytes(line) > NODE
                    ? control.stop({ bytes: bytes(line), contender: o.contender.name, limit: NODE, node: `${job.l}.${job.i}`, type: "over-limit" }).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.tapError(() => control.stop({ contender: o.contender.name, node: `${job.l}.${job.i}`, type: "unbuilt" }).pipe(Effect.asVoid)),
              );
      const chat = yield* openChat(dir, {
        marks: o.budget === undefined ? undefined : { high: o.budget, low: Math.floor(o.budget / 2) },
        report,
        summarize: (job) => summarize(job).pipe(Effect.provideService(CurrentNode, `${job.l}.${job.i}`)),
      });
      let logged = 0;
      const deadline = o.deadline ?? "2 hours";
      // no session here, and the end waits on every node, not just the view's: tried again as a
      // waiting turn does (src/session.ts), every WAIT_RETRY
      const retrying = chat.retry.pipe(Effect.delay(o.retry ?? WAIT_RETRY), Effect.forever);
      const work = Effect.gen(function* () {
        for (const m of o.messages) {
          yield* chat.log(m.kind, m.text);
          logged++;
          yield* settle(chat.mem);
        }
        while (unbuiltOf(chat.mem).length > 0) yield* Effect.sleep(o.poll ?? "200 millis");
      }).pipe(Effect.raceFirst(retrying));
      const timed = work.pipe(
        Effect.timeoutOption(deadline),
        Effect.map((result) => (Option.isSome(result) ? ({ type: "complete" } as const) : ({ type: "deadline" } as const))),
      );
      const outcome =
        control === undefined
          ? yield* timed
          : yield* timed.pipe(Effect.raceFirst(control.awaitStop.pipe(Effect.map((reason) => ({ reason, type: "stopped" }) as const))));
      if (outcome.type === "deadline" && control !== undefined)
        yield* control.stop({ contender: o.contender.name, duration: Duration.format(Duration.fromInputUnsafe(deadline)), type: "deadline" });
      const unbuilt = unbuiltOf(chat.mem);
      if (outcome.type === "deadline")
        yield* report(`deadline (${Duration.format(Duration.fromInputUnsafe(deadline))}): ${logged} of ${o.messages.length} messages logged, ${unbuilt.length} nodes unbuilt`);
      else if (outcome.type === "stopped") yield* report(`stopped (${outcome.reason.type}): ${logged} of ${o.messages.length} messages logged, ${unbuilt.length} nodes unbuilt`);
      return { contender: o.contender, dir, logged, mem: chat.mem, records, reports, stop: control?.snapshot().stop ?? null, unbuilt } satisfies Replayed;
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

// over NODE after every try: kept anyway (docs/optchat.md §4 "The size"), but worth counting
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

export type ContenderResult<A> = {
  readonly name: string;
  readonly status: "complete" | "partial";
  readonly value: A;
};

export const runContenders = <A, E, R>(o: {
  readonly contenders: readonly Contender[];
  readonly control: BakeoffController;
  readonly initial: (contender: Contender) => A;
  readonly run: (contender: Contender) => Effect.Effect<{ readonly complete: boolean; readonly value: A }, E, R>;
  readonly persist: (results: readonly ContenderResult<A>[]) => Effect.Effect<void>;
}): Effect.Effect<readonly ContenderResult<A>[], E, R> => {
  const results: ContenderResult<A>[] = [];
  let current: string | null = null;
  const persist = Effect.suspend(() => o.persist(results));
  return Effect.gen(function* () {
    for (const contender of o.contenders) {
      if (o.control.isStopped()) break;
      current = contender.name;
      const at = results.push({ name: contender.name, status: "partial", value: o.initial(contender) }) - 1;
      yield* persist;
      const result = yield* o.run(contender);
      results[at] = {
        name: contender.name,
        status: result.complete && o.control.snapshot().stop === null ? "complete" : "partial",
        value: result.value,
      };
      current = null;
      yield* persist;
      if (o.control.isStopped()) break;
    }
    return results;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : o.control.stop({ contender: current, type: "unexpected" }).pipe(
            Effect.andThen(persist),
            Effect.asVoid,
          ),
    ),
  );
};

export type ArtifactContender = ContenderResult<{ readonly metrics: Measured | null; readonly usageRecords: number | null }>;
export type BakeoffArtifact = {
  readonly version: 1;
  readonly status: "complete" | "running" | "stopped";
  readonly attempts: { readonly attempted: number; readonly max: number };
  readonly stop: StopReason | null;
  readonly requestedContenders: readonly string[];
  readonly completedContenders: readonly string[];
  readonly contenders: readonly ArtifactContender[];
};

export const initialArtifact = (requested: readonly string[], maxAttempts: number): BakeoffArtifact => ({
  attempts: { attempted: 0, max: maxAttempts },
  completedContenders: [],
  contenders: [],
  requestedContenders: requested,
  status: "stopped",
  stop: { contender: null, type: "unexpected" },
  version: 1,
});

export function bakeoffArtifact(requested: readonly Contender[], results: readonly ArtifactContender[], control: BakeoffController): BakeoffArtifact {
  const snapshot = control.snapshot();
  return {
    attempts: { attempted: snapshot.attempts, max: snapshot.maxAttempts },
    completedContenders: results.filter((r) => r.status === "complete").map((r) => r.name),
    contenders: results,
    requestedContenders: requested.map((c) => c.name),
    status:
      snapshot.stop === null
        ? results.length === requested.length && results.every((result) => result.status === "complete")
          ? "complete"
          : "running"
        : "stopped",
    stop: snapshot.stop,
    version: 1,
  };
}

export function writeArtifact(path: string, artifact: BakeoffArtifact): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
  renameSync(temporary, path);
}

export const modelBuiltNodes = (messages: number): number => {
  let total = 0;
  for (let level = messages; level > 0; level = Math.floor(level / 2)) total += level;
  return total;
};

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

const count = (raw: string, min: number) => {
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= min ? value : null;
};
export const USAGE =
  "usage: bun dev/bakeoff.ts --from <data dir | LOG.txt> --chain name=chain [--chain …] --out file.json --max-attempts N [--no-fail-fast] [--effort medium] [--n 500] [--skip 0] [--kinds user] [--questions 50] [--deadline 120 (minutes)]";

export function outputPathFromArgv(argv: readonly string[]): string | null {
  let discovered: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--out") continue;
    const candidate = argv[index + 1];
    if (candidate !== undefined && candidate.length > 0 && !candidate.startsWith("--")) discovered = candidate;
  }
  return discovered;
}

const maxAttemptsFromArgv = (argv: readonly string[]) => {
  for (let index = 0; index < argv.length; index++) if (argv[index] === "--max-attempts") return count(argv[index + 1] ?? "", 1) ?? 0;
  return 0;
};

const setupArtifact = (maxAttempts: number): BakeoffArtifact => initialArtifact([], maxAttempts);

export const runBakeoffCli = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const discoveredOut = outputPathFromArgv(argv);
    const discoveredMax = maxAttemptsFromArgv(argv);
    if (discoveredOut !== null)
      yield* Effect.try({
        catch: () => new BakeoffCliError({ phase: "setup" }),
        try: () => {
          writeArtifact(discoveredOut, setupArtifact(discoveredMax));
        },
      });

    const rejectSetup = () =>
      Effect.gen(function* () {
        if (discoveredOut !== null)
          yield* Effect.try(() => {
            writeArtifact(discoveredOut, setupArtifact(discoveredMax));
          }).pipe(Effect.catch(() => Effect.void));
        yield* Console.error(USAGE);
        return yield* new BakeoffCliError({ phase: "setup" });
      });

    const parsed = yield* Effect.try({
      catch: () => new BakeoffCliError({ phase: "setup" }),
      try: () =>
        parseArgs({
          args: [...argv],
          options: {
            chain: { multiple: true, type: "string" },
            deadline: { default: "120", type: "string" },
            effort: { type: "string" },
            from: { type: "string" },
            kinds: { default: "user", type: "string" },
            n: { default: "500", type: "string" },
            "no-fail-fast": { default: false, type: "boolean" },
            "max-attempts": { type: "string" },
            out: { type: "string" },
            questions: { default: "50", type: "string" },
            skip: { default: "0", type: "string" },
          },
          strict: true,
        }),
    }).pipe(Effect.catch(() => rejectSetup()));
    const { values } = parsed;
    const n = count(values.n, 1), skip = count(values.skip, 0), questionCount = count(values.questions, 0), deadline = count(values.deadline, 1);
    const maxAttempts = values["max-attempts"] === undefined ? null : count(values["max-attempts"], 1);
    if (
      values.out === undefined ||
      values.out !== discoveredOut ||
      values.from === undefined ||
      !existsSync(values.from) ||
      !values.chain?.length ||
      maxAttempts === null ||
      n === null ||
      skip === null ||
      questionCount === null ||
      deadline === null
    )
      return yield* rejectSetup();

    const { chain, out } = values;
    const parsedContenders = Result.try({ catch: () => null, try: () => chain.map(parseContender) });
    if (Result.isFailure(parsedContenders)) return yield* rejectSetup();
    if (new Set(parsedContenders.success.map((contender) => contender.name)).size !== parsedContenders.success.length) return yield* rejectSetup();

    const root = new URL("..", import.meta.url).pathname;
    const loaded = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`).pipe(Effect.catchCause(() => rejectSetup()));
    const effort = values.effort ?? loaded.compactor.effort;
    if (!isEffort(effort)) return yield* rejectSetup();
    const settings = { ...loaded, compactor: { ...loaded.compactor, effort } };
    const canonicalResult = Result.try({
      catch: () => null,
      try: () => parsedContenders.success.map((contender) => ({ ...contender, byLevel: Arr.map(contender.byLevel, (level) => ({ ...level, chain: atRoleEffort(level.chain, effort) })) })),
    });
    if (Result.isFailure(canonicalResult)) return yield* rejectSetup();
    const canonical = canonicalResult.success;
    const refused = canonical.flatMap((contender) => contender.byLevel.flatMap((level) => duplicateRefs(`${contender.name}, from level ${level.from}`, level.chain, effort)));
    if (refused.length > 0) return yield* rejectSetup();

    const kindsResult = Result.try({
      catch: () => null,
      try: () => values.kinds.split(",").map((kind) => Schema.decodeUnknownSync(Schema.Literals(["user", "talk", "tool", "echo", "note"]))(kind)),
    });
    if (Result.isFailure(kindsResult) || new Set(kindsResult.success).size !== kindsResult.success.length) return yield* rejectSetup();
    const kinds = kindsResult.success;
    const messages = yield* readSource(values.from, n, skip).pipe(Effect.catchCause(() => rejectSetup()));
    const control = makeBakeoffController(maxAttempts, !values["no-fail-fast"]);
    yield* Effect.try(() => {
      writeArtifact(out, bakeoffArtifact(canonical, [], control));
    }).pipe(Effect.catch(() => rejectSetup()));

    const nodesPerContender = modelBuiltNodes(messages.length);
    const lowerBound = nodesPerContender * canonical.length;
    yield* Console.error(`bake-off setup: ${canonical.length} contenders, ${nodesPerContender} model-built nodes each`);
    yield* Console.error(`bake-off limits: ${lowerBound} one-call lower bound, ${maxAttempts} max attempts`);
    if (maxAttempts < lowerBound) yield* Console.error("bake-off warning: max attempts are below the one-call lower bound");

    let latest: readonly ArtifactContender[] = [];
    const execute = Effect.scoped(
      Effect.gen(function* () {
        const outside = Layer.mergeAll(SecretsLive, FetchHttpClient.layer);
        const scope = yield* Effect.scope;
        const plan = yield* Effect.cached(Layer.buildWithScope(openAiPlanLayer(settings.openai, { report: () => Effect.void }).pipe(Layer.provide(outside)), scope).pipe(Effect.map((context) => Context.get(context, OpenAiPlan))));
        const apiKeys = yield* Effect.cached(Layer.buildWithScope(apiKeysLayer(settings.apiKey).pipe(Layer.provide(outside)), scope).pipe(Effect.map((context) => Context.get(context, ApiKeys))));
        const runner = Context.get(yield* Layer.build(LocalRunner.pipe(Layer.provide(BunServices.layer))), Runner);
        const usagePath = `${HOME}/usage.jsonl`;
        const budget = makeBudget({ monthly: settings.apiKey?.monthlyBudget ?? 0, report: () => Effect.void, usagePath });
        const spend = (record: UsageRecord) =>
          record.auth === "api-key" ? logUsage(usagePath, record).pipe(Effect.asVoid) : Effect.void;
        const results = yield* runContenders({
          contenders: canonical,
          control,
          initial: () => ({ metrics: null, usageRecords: null }),
          persist: (current: readonly ArtifactContender[]) =>
            Effect.sync(() => {
              latest = [...current];
              writeArtifact(out, bakeoffArtifact(canonical, latest, control));
            }),
          run: (contender) =>
            Effect.gen(function* () {
              yield* Console.error(`bake-off: replaying ${messages.length} messages`);
              const replayed = yield* replay({
                contender,
                control,
                deadline: Duration.minutes(deadline),
                messages,
                summarizeFor: (current, log, report, attemptHooks) =>
                  makeSummarize({
                    apiKeys,
                    attemptHooks,
                    budget,
                    gate: makeGate(),
                    instructions: systemPrompt(HOME),
                    log: (record) => budget.note(record).pipe(Effect.andThen(log(record)), Effect.andThen(spend(record))),
                    placement: Effect.succeed({ cwd: undefined, mcpConfig: JSON.stringify({ mcpServers: {} }), mcpSeen: () => Effect.succeed(false), runner }),
                    plan,
                    report,
                    settings: { ...settings, compactor: { ...settings.compactor, byLevel: current.byLevel } },
                    tools: toolDefs({ device: settings.defaultDevice, folders: settings.devices[settings.defaultDevice]?.folders ?? [] }),
                  }).pipe(Effect.map((made) => made.summarize)),
              });
              if (replayed.stop === null && replayed.reports.length > 0) yield* Console.error(diagnosticCountText(replayed.reports.length));
              else if (replayed.stop !== null) yield* Console.error(controlledStopText(replayed.stop));
              const complete = replayed.stop === null && replayed.unbuilt.length === 0;
              if (!complete) return { complete, value: { metrics: null, usageRecords: null } };
              const metrics = yield* measure(replayed, messages, { answerer: lexicalAnswerer, kinds, questions: questionCount });
              return { complete, value: { metrics, usageRecords: replayed.records.length } };
            }),
        });
        writeArtifact(out, bakeoffArtifact(canonical, results, control));
        yield* Console.log(table(results.flatMap((result) => (result.value.metrics === null ? [] : [result.value.metrics]))));
        const stopped = control.snapshot().stop;
        if (stopped !== null) {
          yield* Console.error(controlledStopText(stopped));
          return yield* new BakeoffStopped({ reason: stopped });
        }
      }),
    );
    return yield* execute.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : control.stop({ contender: null, type: "unexpected" }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  writeArtifact(out, bakeoffArtifact(canonical, latest, control));
                }),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.catchCause(() => Effect.fail(new BakeoffCliError({ phase: "run" }))),
    );
  });

if (import.meta.main) BunRuntime.runMain(Effect.scoped(runBakeoffCli(Bun.argv.slice(2))));
