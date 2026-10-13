import { Effect } from "effect";
import { zoom } from "../src/mcp.ts";
import type { Kind } from "../src/records.ts";
import { NODE } from "../src/config.ts";
import { getNode, type Mem } from "../src/tree.ts";
import type { UsageRecord } from "../src/usage.ts";
import { render } from "../src/view.ts";
import type { CompleteContender, Metrics } from "./bakeoff-artifact.ts";
import type { CompleteReplay, Logged, Message } from "./bakeoff-replay.ts";

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
export function triesPerNode(records: readonly Logged[]) {
  const per = new Map<string, number>();
  for (const record of records) if (record.role === "compact" && record.node !== null) per.set(record.node, (per.get(record.node) ?? 0) + 1);
  const tries = [...per.values()].sort((a, b) => a - b);
  const sum = tries.reduce((total, value) => total + value, 0);
  return { max: tries.at(-1) ?? 0, mean: tries.length > 0 ? sum / tries.length : 0, nodes: tries.length, p95: quantile(tries, 0.95) };
}

export function cost(records: readonly UsageRecord[], messages: number) {
  const per = (value: number) => messages ? value / messages : 0;
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
      pool.push({ answer, question: `Which word did the user write in: "${sentence.map((word) => word === answer ? "___" : word).join(" ")}"?`, source: index });
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
      cost: cost(replayed.records, messages.length),
      findability: yield* findability(replayed.mem, questions(messages, options.questions, kinds), options.answerer),
      messages: messages.length,
      nodes: replayed.mem.tree.size,
      overLimit: overLimit(replayed.mem),
      reportCount: replayed.reportCount,
      tries: triesPerNode(replayed.records),
      wordsKept: wordsKept(replayed.mem, [0, 2, 3], kinds),
    } satisfies Metrics;
  });
export type Measured = Metrics;

export const modelBuiltNodes = (messages: number): number => {
  let total = 0;
  for (let level = messages; level > 0; level = Math.floor(level / 2)) total += level;
  return total;
};
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
export const table = (rows: readonly CompleteContender[]) =>
  [
    "contender | tries per node mean / p95 | over 512 | calls/msg | in / cached / out tokens per msg | failovers | words kept L0 / L2 / L3 (quoted) | findable",
    ...rows.map((row) => {
      const { metrics } = row;
      const tokens = metrics.cost.tokensPerMessage;
      return `${row.name} | ${metrics.tries.mean.toFixed(2)} / ${metrics.tries.p95} | ${metrics.overLimit} | ${metrics.cost.callsPerMessage.toFixed(2)} | ${Math.round(tokens.input)} / ${Math.round(tokens.cacheRead)} / ${Math.round(tokens.output)} | ${metrics.cost.failovers} | ${metrics.wordsKept.map((kept) => pct(kept.quoted)).join(" / ")} | ${pct(metrics.findability.share)} of ${metrics.findability.asked}`;
    }),
  ].join("\n");
