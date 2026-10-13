#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Data, Duration, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import { Runner, LocalRunner } from "../src/claude/process.ts";
import type { Summarize } from "../src/compactor.ts";
import { NODE, WAIT_RETRY, loadSettings } from "../src/config.ts";
import type { EngineFailure } from "../src/engines/registry.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { RequestAdmission } from "../src/engines/request-admission.ts";
import { parseOptmem } from "../src/import.ts";
import { zoom } from "../src/mcp.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { HOME } from "../src/paths.ts";
import type { Kind } from "../src/records.ts";
import { SecretsLive } from "../src/secrets.ts";
import { loadChat } from "../src/store.ts";
import { systemPrompt } from "../src/prompts.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { toolDefs } from "../src/tools/box.ts";
import { built, bytes, getNode, type Mem, nodes } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { render, settle } from "../src/view.ts";
import { type BakeoffArtifact, createArtifact, writeArtifact } from "./bakeoff-artifact.ts";
import { type Contender, parseBakeoffOptions, USAGE } from "./bakeoff-options.ts";
import {
  type ContenderControl,
  type ContenderOutcome,
  type DiagnosticReason,
  type FailedContender,
  type GlobalAbort,
  type Progress,
  type RunOutcome,
  makeRunControl,
  runContenders,
} from "./bakeoff-run.ts";

export { parseContender } from "./bakeoff-options.ts";
export type { Contender } from "./bakeoff-options.ts";
export class BakeoffCliError extends Data.TaggedError("BakeoffCliError")<{ readonly phase: "run" | "setup" }> {}

export type Message = { readonly kind: Kind; readonly text: string };
export type Logged = UsageRecord & { readonly node: string | null };

type ReplayBase = {
  readonly contender: Contender;
  readonly dir: string;
  readonly mem: Mem;
  readonly records: readonly Logged[];
  readonly reports: readonly string[];
};
export type CompleteReplay = ReplayBase & { readonly type: "complete"; readonly logged: number };
export type FailedReplay = ReplayBase & {
  readonly type: "failed";
  readonly failure: { readonly type: "diagnostic"; readonly reason: DiagnosticReason } | { readonly type: "global"; readonly abort: GlobalAbort };
  readonly progress: Progress;
};
export type Replayed = CompleteReplay | FailedReplay;

export const readSource = (path: string, n: number, skip = 0) =>
  Effect.gen(function* () {
    if (statSync(path).isDirectory()) {
      const { mem } = yield* loadChat(path, { view: false, writer: false });
      return mem.root.slice(skip, skip + n).map((message): Message => ({ kind: message.kind, text: message.text }));
    }
    return parseOptmem(readFileSync(path, "utf8"))
      .slice(skip, skip + n)
      .map((note): Message => ({ kind: "note", text: note.text }));
  });

const CurrentNode = Context.Reference<string | null>("bakeoff/CurrentNode", { defaultValue: () => null });
const unbuiltOf = (mem: Mem) => [...nodes(mem.root.length)].filter((coord) => !built(mem, coord)).map((coord) => `${coord.l}.${coord.i}`);
const coordOf = (node: string) => {
  const [l = "0", i = "0"] = node.split(".");
  return { i: Number(i), l: Number(l) };
};

export const replay = <R>(o: {
  readonly contender: Contender;
  readonly messages: readonly Message[];
  readonly summarizeFor: (
    contender: Contender,
    log: (record: UsageRecord) => Effect.Effect<void>,
    report: (message: string) => Effect.Effect<void>,
    onEngineFailure: (failure: EngineFailure) => Effect.Effect<void>,
  ) => Effect.Effect<Summarize, never, R>;
  readonly control?: ContenderControl;
  readonly poll?: Duration.Input;
  readonly budget?: number;
  readonly deadline?: Duration.Input;
  readonly retry?: Duration.Input;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fallback = makeRunControl(Number.MAX_SAFE_INTEGER, false).begin(o.contender.name);
      const control = o.control ?? fallback;
      const dir = mkdtempSync(`${tmpdir()}/bake-`);
      const records: Logged[] = [];
      const reports: string[] = [];
      const report = (message: string) => Effect.sync(() => void reports.push(message.slice(0, 300)));
      const log = (record: UsageRecord) =>
        Effect.gen(function* () {
          records.push({ ...record, node: yield* CurrentNode });
          const failed = yield* logUsage(`${dir}/usage.jsonl`, record);
          if (failed) yield* report(failed);
        });
      const onEngineFailure = (failure: EngineFailure) =>
        failure.error._tag === "UsageLimit"
          ? control
              .fail({ contender: o.contender.name, coord: failure.coord, engine: failure.ref.slice(0, 100), type: "usage-limit" })
              .pipe(Effect.andThen(Effect.interrupt))
          : Effect.void;
      const raw = yield* o.summarizeFor(o.contender, log, report, onEngineFailure);
      const summarize: Summarize = (job) =>
        raw(job).pipe(
          Effect.flatMap((line) =>
            bytes(line) > NODE
              ? control
                  .fail({ bytes: bytes(line), contender: o.contender.name, coord: { i: job.i, l: job.l }, limit: NODE, type: "over-limit" })
                  .pipe(Effect.andThen(Effect.interrupt))
              : Effect.succeed(line),
          ),
          Effect.tapError(() =>
            control.reason() === undefined
              ? control
                  .fail({ contender: o.contender.name, coord: { i: job.i, l: job.l }, type: "unbuilt" })
                  .pipe(Effect.andThen(Effect.interrupt))
              : Effect.void,
          ),
        );
      const chat = yield* openChat(dir, {
        marks: o.budget === undefined ? undefined : { high: o.budget, low: Math.floor(o.budget / 2) },
        report,
        summarize: (job) => summarize(job).pipe(Effect.provideService(CurrentNode, `${job.l}.${job.i}`)),
      });
      let logged = 0;
      const retrying = chat.retry.pipe(Effect.delay(o.retry ?? WAIT_RETRY), Effect.forever);
      const work = Effect.gen(function* () {
        for (const message of o.messages) {
          yield* chat.log(message.kind, message.text);
          logged++;
          yield* settle(chat.mem);
        }
        while (unbuiltOf(chat.mem).length > 0) yield* Effect.sleep(o.poll ?? "200 millis");
      }).pipe(Effect.raceFirst(retrying));
      const deadline = o.deadline ?? "2 hours";
      const timed = work.pipe(Effect.timeoutOption(deadline));
      const terminal = yield* Effect.race(
        timed.pipe(
          Effect.map((result) => (Option.isSome(result) ? ({ type: "complete" } as const) : ({ type: "deadline" } as const))),
        ),
        control.awaitTerminal,
      );
      if (terminal.type === "deadline")
        yield* control.fail({ contender: o.contender.name, duration: Duration.format(Duration.fromInputUnsafe(deadline)).slice(0, 100), type: "deadline" });
      const unbuilt = unbuiltOf(chat.mem);
      const progress: Progress = { loggedMessages: logged, requestedMessages: o.messages.length, unbuiltNodes: unbuilt, usageRecords: records.length };
      if (terminal.type === "global") return { contender: o.contender, dir, failure: { abort: terminal.abort, type: "global" }, mem: chat.mem, progress, records, reports, type: "failed" } satisfies FailedReplay;
      const reason = control.reason();
      if (terminal.type !== "complete" || reason !== undefined || unbuilt.length > 0) {
        const fallbackReason: DiagnosticReason = reason ?? {
          contender: o.contender.name,
          coord: coordOf(unbuilt[0] ?? "0.0"),
          type: "unbuilt",
        };
        return { contender: o.contender, dir, failure: { reason: fallbackReason, type: "diagnostic" }, mem: chat.mem, progress, records, reports, type: "failed" } satisfies FailedReplay;
      }
      return { contender: o.contender, dir, logged, mem: chat.mem, records, reports, type: "complete" } satisfies CompleteReplay;
    }),
  );

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
export function triesPerNode(records: readonly Logged[]) {
  const per = new Map<string, number>();
  for (const record of records) if (record.role === "compact" && record.node !== null) per.set(record.node, (per.get(record.node) ?? 0) + 1);
  const tries = [...per.values()].sort((a, b) => a - b);
  const sum = tries.reduce((total, value) => total + value, 0);
  return { max: tries.at(-1) ?? 0, mean: tries.length > 0 ? sum / tries.length : 0, nodes: tries.length, p95: quantile(tries, 0.95) };
}

export function cost(records: readonly UsageRecord[], messages: number) {
  const per = (value: number) => (messages ? value / messages : 0);
  const total = { cacheRead: 0, cacheWrite: 0, dollars: 0, input: 0, output: 0 };
  for (const record of records) {
    total.input += record.usage.input;
    total.cacheRead += record.usage.cacheRead;
    total.cacheWrite += record.usage.cacheWrite;
    total.output += record.usage.output;
    total.dollars += record.dollars ?? 0;
  }
  return {
    callsPerMessage: per(records.length),
    cold: records.filter((record) => record.cold).length,
    dollarsPerMessage: per(total.dollars),
    failovers: records.filter((record) => record.failoverFrom !== null && record.attempt === 1).length,
    tokensPerMessage: { cacheRead: per(total.cacheRead), cacheWrite: per(total.cacheWrite), input: per(total.input), output: per(total.output) },
  };
}

export const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
const SPAN = 4;
export const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(words)
    .filter((sentence) => sentence.length >= SPAN);
const runs = (values: readonly string[]) => {
  const out = new Set<string>();
  for (let index = 0; index + SPAN <= values.length; index++) out.add(values.slice(index, index + SPAN).join(" "));
  return out;
};
const best = <A>(items: readonly A[], score: (item: A) => number): A | null => {
  let selected: A | null = null;
  let high = -1;
  for (const item of items) if (score(item) > high) [selected, high] = [item, score(item)];
  return selected;
};
export function wordsKept(mem: Mem, levels: readonly number[] = [0, 2, 3], kinds: readonly Kind[] = ["user"]) {
  return levels.map((level) => {
    let total = 0;
    let quoted = 0;
    let recall = 0;
    for (const message of mem.root) {
      if (!kinds.includes(message.kind)) continue;
      const node = getNode(mem, { i: message.i >> level, l: level });
      if (!node) continue;
      const have = runs(words(node.text));
      for (const sentence of sentences(message.text)) {
        const source = [...runs(sentence)];
        const kept = source.filter((value) => have.has(value)).length;
        total++;
        if (kept > 0) quoted++;
        recall += kept / source.length;
      }
    }
    return { level, quoted: total ? quoted / total : 0, recall: total ? recall / total : 0, sentences: total };
  });
}
export const overLimit = (mem: Mem) => [...mem.tree.values()].filter((node) => node.size > NODE).length;

export type Question = { readonly source: number; readonly question: string; readonly answer: string };
export type Tools = { readonly view: string; readonly zoom: (id: number, n: number) => string };
export type Answerer<R> = (question: Question, tools: Tools) => Effect.Effect<string, never, R>;
export function questions(messages: readonly Message[], count: number, kinds: readonly Kind[] = ["user"]): Question[] {
  const pool: Question[] = [];
  for (const [index, message] of messages.entries()) {
    if (!kinds.includes(message.kind)) continue;
    for (const sentence of sentences(message.text)) {
      const answer = best(sentence, (word) => word.length) ?? "";
      if (answer.length < 5) continue;
      pool.push({ answer, question: `Which word did the user write in: "${sentence.map((word) => (word === answer ? "___" : word)).join(" ")}"?`, source: index });
      break;
    }
  }
  const step = Math.max(1, pool.length / Math.max(1, count));
  const out: Question[] = [];
  for (let index = 0; out.length < count && Math.floor(index) < pool.length; index += step) {
    const question = pool[Math.floor(index)];
    if (question) out.push(question);
  }
  return out;
}
const LINE = /^(\d+)\+(\d+)\|(.*)$/;
const lines = (text: string) =>
  text.split("\n").flatMap((line) => {
    const match = LINE.exec(line);
    return match ? [{ id: Number(match[1]), n: Number(match[2]), text: match[3] ?? "" }] : [];
  });
export const lexicalAnswerer: Answerer<never> = (question, tools) =>
  Effect.sync(() => {
    const wanted = new Set(words(question.question));
    const score = (text: string) => words(text).filter((word) => wanted.has(word)).length;
    let options = lines(tools.view);
    for (;;) {
      const picked = best(options, (option) => score(option.text));
      if (picked === null) return "";
      if (picked.n <= 1) return tools.zoom(picked.id, 1);
      options = lines(tools.zoom(picked.id, picked.n));
    }
  });
export const findability = <R>(mem: Mem, asked: readonly Question[], answer: Answerer<R>) =>
  Effect.gen(function* () {
    const tools: Tools = { view: render(mem), zoom: (id, n) => zoom(mem, id, n) };
    let found = 0;
    for (const question of asked) if (words(yield* answer(question, tools)).includes(question.answer)) found++;
    return { asked: asked.length, found, share: asked.length > 0 ? found / asked.length : 0 };
  });
export const measure = <R>(replayed: CompleteReplay, all: readonly Message[], options: { readonly questions: number; readonly answerer: Answerer<R>; readonly kinds?: readonly Kind[] }) =>
  Effect.gen(function* () {
    const kinds = options.kinds ?? ["user"];
    const messages = all.slice(0, replayed.logged);
    return {
      contender: replayed.contender.name,
      cost: cost(replayed.records, messages.length),
      dir: replayed.dir,
      findability: yield* findability(replayed.mem, questions(messages, options.questions, kinds), options.answerer),
      messages: messages.length,
      nodes: replayed.mem.tree.size,
      overLimit: overLimit(replayed.mem),
      reports: replayed.reports.length,
      tries: triesPerNode(replayed.records),
      unbuilt: 0,
      wordsKept: wordsKept(replayed.mem, [0, 2, 3], kinds),
    };
  });
export type Measured = Effect.Success<ReturnType<typeof measure>>;

export const modelBuiltNodes = (messages: number): number => {
  let total = 0;
  for (let level = messages; level > 0; level = Math.floor(level / 2)) total += level;
  return total;
};
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
export const table = (rows: readonly Measured[]) =>
  [
    "contender | tries per node mean / p95 | over 512 | unbuilt | calls/msg | in / cached / out tokens per msg | failovers | words kept L0 / L2 / L3 (quoted) | findable",
    ...rows.map((row) => {
      const tokens = row.cost.tokensPerMessage;
      return `${row.contender} | ${row.tries.mean.toFixed(2)} / ${row.tries.p95} | ${row.overLimit} | ${row.unbuilt} | ${row.cost.callsPerMessage.toFixed(2)} | ${Math.round(tokens.input)} / ${Math.round(tokens.cacheRead)} / ${Math.round(tokens.output)} | ${row.cost.failovers} | ${row.wordsKept.map((kept) => pct(kept.quoted)).join(" / ")} | ${pct(row.findability.share)} of ${row.findability.asked}`;
    }),
  ].join("\n");

const artifactOf = (requestedNames: readonly string[], snapshot: { readonly authorizedRequests: number; readonly maxRequests: number }, outcome: RunOutcome<Measured>): BakeoffArtifact => ({
  outcome,
  requestedNames,
  requests: { authorized: snapshot.authorizedRequests, max: snapshot.maxRequests },
  version: 2,
});

export const runBakeoffCli = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const root = new URL("..", import.meta.url).pathname;
    const loaded = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`).pipe(
      Effect.catchCause(() => Effect.fail(new BakeoffCliError({ phase: "setup" }))),
    );
    const options = yield* Effect.try({
      catch: () => new BakeoffCliError({ phase: "setup" }),
      try: () => parseBakeoffOptions(argv, loaded, { outputExists: existsSync, sourceExists: existsSync }),
    });
    const messages = yield* readSource(options.from, options.messageCount, options.skip).pipe(
      Effect.catchCause(() => Effect.fail(new BakeoffCliError({ phase: "setup" }))),
    );
    const control = makeRunControl(options.maxRequests, options.failFast);
    const requestedNames = options.contenders.map((contender) => contender.name);
    const initial: RunOutcome<Measured> = {
      abort: { type: "unexpected" },
      active: { type: "none" },
      contenders: [],
      type: "aborted",
    };
    yield* Effect.try({
      catch: () => new BakeoffCliError({ phase: "setup" }),
      try: () => {
        const artifact = artifactOf(requestedNames, control.snapshot(), initial);
        if (options.overwrite) writeArtifact(options.out, artifact);
        else createArtifact(options.out, artifact);
      },
    });

    const nodesPerContender = modelBuiltNodes(messages.length);
    yield* Console.error(`bake-off setup: ${options.contenders.length} contenders, ${nodesPerContender} model-built nodes each`);
    yield* Console.error(`bake-off limits: ${nodesPerContender * options.contenders.length} one-call lower bound, ${options.maxRequests} max authorized requests`);

    const execute = Effect.scoped(
      Effect.gen(function* () {
        const outside = Layer.mergeAll(SecretsLive, FetchHttpClient.layer);
        const scope = yield* Effect.scope;
        const plan = yield* Effect.cached(
          Layer.buildWithScope(openAiPlanLayer(options.settings.openai, { report: () => Effect.void }).pipe(Layer.provide(outside)), scope).pipe(
            Effect.map((context) => Context.get(context, OpenAiPlan)),
          ),
        );
        const apiKeys = yield* Effect.cached(
          Layer.buildWithScope(apiKeysLayer(options.settings.apiKey).pipe(Layer.provide(outside)), scope).pipe(Effect.map((context) => Context.get(context, ApiKeys))),
        );
        const runner = Context.get(yield* Layer.build(LocalRunner.pipe(Layer.provide(BunServices.layer))), Runner);
        const usagePath = `${HOME}/usage.jsonl`;
        const budget = makeBudget({ monthly: options.settings.apiKey?.monthlyBudget ?? 0, report: () => Effect.void, usagePath });
        const spend = (record: UsageRecord) => (record.auth === "api-key" ? logUsage(usagePath, record).pipe(Effect.asVoid) : Effect.void);
        const outcome: RunOutcome<Measured> = yield* runContenders<Contender, Measured, unknown, never>({
          contenders: options.contenders,
          control,
          interruptedProgress: () => ({ loggedMessages: 0, requestedMessages: messages.length, unbuiltNodes: [], usageRecords: 0 }),
          persist: (current) =>
            Effect.sync(() => {
              writeArtifact(options.out, artifactOf(requestedNames, control.snapshot(), current));
            }),
          run: (contender, local): Effect.Effect<ContenderOutcome<Measured>, unknown> =>
            Effect.gen(function* () {
              const replayed = yield* replay({
                contender,
                control: local,
                deadline: Duration.minutes(options.deadlineMinutes),
                messages,
                summarizeFor: (current, log, report, onEngineFailure) =>
                  makeSummarize({
                    apiKeys,
                    budget,
                    gate: makeGate(),
                    instructions: systemPrompt(HOME),
                    log: (record) => budget.note(record).pipe(Effect.andThen(log(record)), Effect.andThen(spend(record))),
                    onEngineFailure,
                    placement: Effect.succeed({ cwd: undefined, mcpConfig: JSON.stringify({ mcpServers: {} }), mcpSeen: () => Effect.succeed(false), runner }),
                    plan,
                    report,
                    settings: { ...options.settings, compactor: { ...options.settings.compactor, byLevel: current.byLevel } },
                    tools: toolDefs({ device: options.settings.defaultDevice, folders: options.settings.devices[options.settings.defaultDevice]?.folders ?? [] }),
                  }).pipe(Effect.map((made) => made.summarize)),
              });
              if (replayed.type === "failed") {
                if (replayed.failure.type === "global") return yield* Effect.interrupt;
                return { name: contender.name, progress: replayed.progress, reason: replayed.failure.reason, type: "failed" } satisfies FailedContender;
              }
              const metrics = yield* measure(replayed, messages, { answerer: lexicalAnswerer, kinds: options.kinds, questions: options.questionCount });
              return { metrics, name: contender.name, type: "complete", usageRecords: replayed.records.length } as const;
            }),
        });
        yield* Console.log(table(outcome.contenders.flatMap((contender) => (contender.type === "complete" ? [contender.metrics] : []))));
        if (outcome.type === "aborted") return yield* new BakeoffCliError({ phase: "run" });
      }).pipe(Effect.provideService(RequestAdmission, control.admission)),
    );
    return yield* execute.pipe(Effect.catchCause(() => Effect.fail(new BakeoffCliError({ phase: "run" }))));
  }).pipe(
    Effect.catchTag("BakeoffCliError", (error) =>
      error.phase === "setup" ? Console.error(USAGE).pipe(Effect.andThen(Effect.fail(error))) : Effect.fail(error),
    ),
  );

if (import.meta.main) BunRuntime.runMain(Effect.scoped(runBakeoffCli(Bun.argv.slice(2))));
