import { Cause, Context, Duration, Effect, Option } from "effect";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Summarize } from "../src/compactor.ts";
import { NODE, WAIT_RETRY } from "../src/config.ts";
import { EngineExecutionPolicy } from "../src/engines/request-admission.ts";
import { parseOptmem } from "../src/import.ts";
import type { Kind } from "../src/records.ts";
import { openChat } from "../src/chat.ts";
import { loadChat } from "../src/store.ts";
import { built, bytes, type Mem, nodes } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { settle } from "../src/view.ts";
import type { Contender } from "./bakeoff-options.ts";
import type { DiagnosticReason, GlobalAbort, Progress } from "./bakeoff-artifact.ts";
import type { ContenderControl } from "./bakeoff-run.ts";
import { makeRunControl } from "./bakeoff-run.ts";

export type Message = { readonly kind: Kind; readonly text: string };
export type Logged = UsageRecord & { readonly node: string | null };

type ReplayBase = {
  readonly contender: Contender;
  readonly mem: Mem;
  readonly records: readonly Logged[];
  readonly reportCount: number;
};
export type CompleteReplay = ReplayBase & { readonly type: "complete"; readonly logged: number };
export type FailedReplay = ReplayBase & {
  readonly type: "failed";
  readonly failure: { readonly type: "diagnostic"; readonly reason: DiagnosticReason } | { readonly type: "global"; readonly abort: Extract<GlobalAbort, { readonly type: "max-authorized-requests" }> };
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
const unbuiltCount = (mem: Mem) => [...nodes(mem.root.length)].filter((coord) => !built(mem, coord)).length;
const firstUnbuilt = (mem: Mem) => [...nodes(mem.root.length)].find((coord) => !built(mem, coord));

export const replay = <R>(o: {
  readonly contender: Contender;
  readonly messages: readonly Message[];
  readonly summarizeFor: (
    contender: Contender,
    log: (record: UsageRecord) => Effect.Effect<void>,
    report: (message: string) => Effect.Effect<void>,
  ) => Effect.Effect<Summarize, never, R>;
  readonly control?: ContenderControl;
  readonly poll?: Duration.Input;
  readonly budget?: number;
  readonly deadline?: Duration.Input;
  readonly retry?: Duration.Input;
}) => {
  const control = o.control ?? makeRunControl(Number.MAX_SAFE_INTEGER, false).begin(o.contender.name);
  return Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(`${tmpdir()}/bake-`)),
        (path) => Effect.sync(() => { rmSync(path, { force: true, recursive: true }); }),
      );
      const records: Logged[] = [];
      let reportCount = 0;
      const report = (_message: string) => Effect.sync(() => { reportCount++; });
      const log = (record: UsageRecord) =>
        Effect.gen(function* () {
          records.push({ ...record, node: yield* CurrentNode });
          const failed = yield* logUsage(`${dir}/usage.jsonl`, record);
          if (failed) yield* report(failed);
        });
      const raw = yield* o.summarizeFor(o.contender, log, report);
      const summarize: Summarize = (job) =>
        Effect.suspend(() => raw(job)).pipe(
          Effect.tapCause((cause) => Cause.hasDies(cause) ? control.abortUnexpected : Effect.void),
          Effect.flatMap((line) =>
            bytes(line) > NODE
              ? control.fail({ bytes: bytes(line), coord: { i: job.i, l: job.l }, limit: NODE, type: "over-limit" }).pipe(Effect.andThen(Effect.interrupt))
              : Effect.succeed(line),
          ),
          Effect.tapError(() =>
            control.reason() === undefined
              ? control.fail({ coord: { i: job.i, l: job.l }, type: "unbuilt" }).pipe(Effect.andThen(Effect.interrupt))
              : Effect.void,
          ),
        );
      const { chat, logged, terminal } = yield* Effect.scoped(Effect.gen(function* () {
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
          while (unbuiltCount(chat.mem) > 0) yield* Effect.sleep(o.poll ?? "200 millis");
        }).pipe(Effect.raceFirst(retrying));
        const deadline = o.deadline ?? "2 hours";
        const terminal = yield* Effect.race(
          work.pipe(
            Effect.timeoutOption(deadline),
            Effect.map((result) => Option.isSome(result) ? ({ type: "complete" } as const) : ({ type: "deadline" } as const)),
          ),
          control.awaitTerminal,
        );
        if (terminal.type === "deadline")
          yield* control.fail({ duration: Duration.format(Duration.fromInputUnsafe(deadline)).slice(0, 100), type: "deadline" });
        return { chat, logged, terminal };
      }));
      if (terminal.type === "global" && terminal.abort.type === "unexpected") return yield* Effect.die("bake-off replay failed");
      const unbuiltNodeCount = unbuiltCount(chat.mem);
      const progress: Progress = { loggedMessages: logged, requestedMessages: o.messages.length, unbuiltNodeCount, usageRecords: records.length };
      if (terminal.type === "global" && terminal.abort.type === "max-authorized-requests")
        return { contender: o.contender, failure: { abort: terminal.abort, type: "global" }, mem: chat.mem, progress, records, reportCount, type: "failed" } satisfies FailedReplay;
      const reason = control.reason();
      if (terminal.type !== "complete" || reason !== undefined || unbuiltNodeCount > 0) {
        const coord = firstUnbuilt(chat.mem) ?? { i: 0, l: 0 };
        const fallbackReason: DiagnosticReason = reason ?? { coord, type: "unbuilt" };
        return { contender: o.contender, failure: { reason: fallbackReason, type: "diagnostic" }, mem: chat.mem, progress, records, reportCount, type: "failed" } satisfies FailedReplay;
      }
      return { contender: o.contender, logged, mem: chat.mem, records, reportCount, type: "complete" } satisfies CompleteReplay;
    }),
  ).pipe(Effect.provideService(EngineExecutionPolicy, control.policy));
};
