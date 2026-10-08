// The claude-code compactor engine (docs/optchat.md §4, E5/E6/E11): one `claude -p` per node, with a
// turn's system prompt, tools and MCP servers (never called: a call to one ends the try), so its
// requests share the turns' prefix (docs/optchat.md §7 mistake 6); our own cache marks (the
// context's last whole block, the task); and the size retries in the same conversation until the
// line fits in NODE bytes or TRIES are spent.
import { Duration, Effect, Option } from "effect";
import { markAt, type TextBlock } from "../claude/events.ts";
import type { Spawn } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type DeviceOffline, type EngineError, fromResult, ModelError } from "../engines/errors.ts";
import { type Gate, prefixKey } from "../engines/inflight.ts";
import { masterArgs, type Placement } from "../turn/claude-code.ts";
import { tokensOf, type UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, task } from "./step.ts";

export type CompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly ttl: "1h" | "5m";
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
  // what a turn on this machine gets (docs/optchat.md §5): the one system prompt, the master's tools,
  // and where its claude runs, with the --mcp-config that reaches zoom and date from there
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly placement: Effect.Effect<Placement, DeviceOffline>;
  readonly gate: Gate; // waits on a call writing the same marked prefix (docs/optchat.md §3.3)
};

// The user message of a call (layout A): the context pieces (step.ts), then the task. Two marks
// (docs/optchat.md §3.3): the last whole context piece, which the next call finds by the lookback,
// and the task, the request's end, which a size retry reads. The pieces stay byte-stable from one
// call to the next.
export function blocks(job: Job, ttl: "1h" | "5m"): TextBlock[] {
  const context = contextBlocks(job);
  return markAt([...context.blocks, task(job)], [context.mark, context.blocks.length], ttl);
}

// the blocks up to the last mark before the request's end: what another call may be writing
export const markedPrefix = (sent: readonly TextBlock[]): string[] | null => {
  const last = sent.slice(0, -1).findLastIndex((b) => b.cache_control !== undefined);
  return last === -1 ? null : sent.slice(0, last + 1).map((b) => b.text);
};

// The spawn of a compactor call: a turn's argv but for the model, its effort and the permission
// mode (`default`, so a tool the model calls anyway is refused rather than run; nothing of these
// reaches the request's prefix), and DISABLE_PROMPT_CACHING=1 for our own marks (D6), every one with
// the same TTL (E6). OPTCHAT_CALL keeps it from ever taking a turn's or a priming's warm process
// (E18: those go only to a byte-identical spawn); claude ignores it.
export const compactSpawn = (o: Pick<CompactorOptions, "effort" | "instructions" | "model" | "tools" | "ttl">, p: Placement): Spawn => ({
  args: masterArgs({ effort: o.effort, instructions: o.instructions, mcpConfig: p.mcpConfig, model: o.model, permissionMode: "default", tools: o.tools }),
  cwd: p.cwd,
  env: { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl, DISABLE_PROMPT_CACHING: "1", OPTCHAT_CALL: "compact" },
});

const failed = (e: { readonly message: string }) => new ModelError({ message: e.message });

export const claudeCodeCompactor = (o: CompactorOptions) => {
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one process per node, each try a message into it, its result the answer
  const call = (job: Job, failoverFrom: string | null) =>
    Effect.gen(function* () {
      const p = yield* o.placement;
      const claude = yield* p.runner.spawn(compactSpawn(o, p)).pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(failed(e))));
      const first = blocks(job, o.ttl);
      const prefix = markedPrefix(first);
      const key = prefix && prefixKey(["claude-code", o.model, o.instructions, o.tools.join(","), ...prefix]);
      return yield* o.gate.through(key, (started) => {
        // a try's events up to its result: the first stream event means the request was taken;
        // a tool call ends the try, since the tools are there for the prefix only
        const answer = Effect.gen(function* () {
          for (;;) {
            const next = yield* claude.next;
            if (Option.isNone(next)) return yield* claude.result.pipe(Effect.mapError(failed));
            const e = next.value;
            if (e.type === "stream_event") yield* started;
            if (e.type === "assistant" && e.message.content.some((b) => b.type === "tool_use"))
              return yield* new ModelError({ message: "the compactor called a tool" });
            if (e.type === "result") return e;
          }
        });
        const ask = (t: Try) =>
          Effect.gen(function* () {
            yield* claude.send(t.retry === null ? first : [{ text: t.retry.text, type: "text" }]);
            const result = yield* answer;
            const usage = tokensOf(result.usage), model = claude.model() ?? null;
            if (result.is_error || result.stop_reason === "refusal")
              return yield* fromResult(result.result ?? `the call ended with ${result.subtype ?? "an error"}`, result.stop_reason, { model, usage });
            return { model, text: result.result ?? "", usage };
          });
        return sizeRetries({ ask, auth: "claude-max", device: o.device, engine: "claude-code", failoverFrom, job, log: o.log });
      });
    }).pipe(
      Effect.scoped, // the process ends with the node
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `no answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> => call(job, failoverFrom);
};
