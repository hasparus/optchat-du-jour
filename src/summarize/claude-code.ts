// The compactor on Claude Code (ref §7, layout A): one `claude -p` per node, no tools, the view as
// cached context with our own four marks (DISABLE_PROMPT_CACHING turns Claude Code's off), size
// retries in the same process (gist §4.3).
import { Duration, Effect } from "effect";
import { CALL_TIMEOUT, MARKS, NODE, TRIES } from "../config.ts";
import { baseArgs } from "../claude/args.ts";
import type { Block } from "../claude/events.ts";
import { type Claude, ClaudeError, Runner } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import { type EngineError, ModelError, fromResult } from "../engines/errors.ts";
import { COMPACT_FILE, SCALE } from "../prompts.ts";
import { bytes, msgText } from "../tree.ts";
import { type UsageRecord, isCold, tokensOf } from "../usage.ts";
import { cutBlocks, flat } from "../view.ts";

const step = (job: Job) =>
  `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n${
    "msg" in job
      ? `Compress this message into one line, in at most ${NODE} bytes:\n${msgText(job.msg)}`
      : `Merge these two lines into one, in at most ${NODE} bytes:\n${flat(job.a)}\n${flat(job.b)}`
  }`;

// <chat> and the bare view lines, cut at the marks, every piece marked; then the step, unmarked.
// No ids anywhere: the model would copy them (gist §4.2).
export function blocks(job: Job, ttl: "1h" | "5m"): Block[] {
  const chat = `<chat>\n${job.ctx.map((line) => `${line}\n`).join("")}</chat>`;
  const pieces = cutBlocks(chat, MARKS).map((text): Block => ({ cache_control: { ttl, type: "ephemeral" }, text, type: "text" }));
  return [...pieces, { text: step(job), type: "text" }];
}

// the line cut to its first NODE bytes, never inside a UTF-8 character
export const cut = (line: string) => Buffer.from(line).subarray(0, NODE).toString("utf8").replace(/�$/, "");

const retry = (line: string) =>
  `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cut(line)}| ← LIMIT`;

export type CompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly ttl: "1h" | "5m";
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly timeout?: Duration.Input;
};

const call = (claude: Claude, job: Job, o: CompactorOptions, failoverFrom: string | null) =>
  Effect.gen(function* () {
    const tries: string[] = [];
    yield* claude.send(blocks(job, o.ttl));
    for (;;) {
      const t0 = Date.now();
      const r = yield* claude.result;
      const usage = tokensOf(r.usage);
      yield* o.log({
        attempt: tries.length + 1,
        auth: "claude-max",
        cold: isCold(usage),
        date: new Date().toISOString(),
        device: null,
        engine: "claude-code",
        failoverFrom,
        level: job.l,
        model: claude.model() ?? o.model,
        ms: Date.now() - t0,
        role: "compact",
        usage,
      });
      if (r.is_error || r.stop_reason === "refusal") return yield* fromResult(String(r.result ?? r.subtype), r.stop_reason);
      const line = (r.result ?? "").trim();
      if (!line) return yield* new ModelError({ message: "empty reply" });
      tries.push(line);
      if (bytes(line) <= NODE || tries.length >= TRIES)
        return tries.reduce((best, t) => (bytes(t) < bytes(best) ? t : best)); // the shortest try
      yield* claude.send([{ text: retry(line), type: "text" }]);
    }
  });

export const claudeCodeCompactor = (o: CompactorOptions) =>
  Effect.gen(function* () {
    const runner = yield* Runner;
    const timeout = o.timeout ?? CALL_TIMEOUT;
    return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const claude = yield* runner.spawn({
            args: [...baseArgs({ effort: o.effort, model: o.model, systemFile: COMPACT_FILE, tools: "" }), "--safe-mode"],
            env: { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl, DISABLE_PROMPT_CACHING: "1" },
          });
          return yield* call(claude, job, o, failoverFrom);
        }),
      ).pipe(
        Effect.catchTag("ClaudeError", (e: ClaudeError) => Effect.fail(new ModelError({ message: e.message }))),
        // a hung call must free its slot (ref §7)
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ModelError({ message: `no result after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
      );
  });
