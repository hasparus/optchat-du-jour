// The claude-code compactor engine (docs/optchat.md §4, E5/E6/E11): one `claude -p` per node, with a
// turn's system prompt, tools and MCP servers (never called: a call to one ends the try), so its
// requests share the turns' prefix (docs/optchat.md §7 mistake 6); our own cache marks (the
// context's last whole block, the task); and the size retries in the same conversation until the
// line fits in NODE bytes or TRIES are spent.
import { Duration, Effect, Option } from "effect";
import { baseArgs } from "../claude/args.ts";
import { type Event, markAt, type TextBlock } from "../claude/events.ts";
import type { Spawn } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type DeviceOffline, type EngineError, fromResult, ModelError, stoppedShort } from "../engines/errors.ts";
import type { Gate } from "../engines/inflight.ts";
import { admitRequest } from "../engines/request-admission.ts";
import { claudePrefix, type Placement } from "../turn/claude-code.ts";
import { tokensOf, type UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, task } from "./step.ts";

export type CompactorOptions = {
  readonly model: string;
  readonly effort: string | undefined; // none: its model takes none
  readonly ttl: "1h" | "5m";
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
  // what a turn on this machine gets (docs/optchat.md §5): the one system prompt, the master's tools,
  // and where its claude runs, with the --mcp-config that reaches zoom and date from there
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly placement: Effect.Effect<Placement, DeviceOffline>;
  readonly gate: Gate; // waits on a call writing a marked prefix of its own (docs/optchat.md §3.3, E50)
};

// The user message of a call (layout A): the context pieces (step.ts), then the task. Two marks
// (docs/optchat.md §3.3): the last whole context piece, which the next call finds by the lookback,
// and the task, the request's end, which a size retry reads. The pieces stay byte-stable from one
// call to the next.
export function blocks(job: Job, ttl: "1h" | "5m"): TextBlock[] {
  const context = contextBlocks(job);
  return markAt([...context.blocks, task(job)], [context.mark, context.blocks.length], ttl);
}

// A compactor uses a turn's baseArgs (system prompt and master's tools, plus --mcp-config for
// zoom/date) but its own model, effort and permission mode. No --replay-user-messages: that
// shapes Claude's output, not the request. With `default`, `-p` and --setting-sources "", Bash,
// writing tools and MCP tools need permission and are refused. Read, Glob, Grep and TodoWrite
// need none and would run, so a try is killed as soon as a tool call starts streaming (`answer`).
// DISABLE_PROMPT_CACHING=1 leaves our own marks only (D6), all with the same TTL (E6).
// Never pooled: no warm process is started or handed to it (E18).
export const compactSpawn = (o: Pick<CompactorOptions, "effort" | "instructions" | "model" | "tools" | "ttl">, p: Placement): Spawn => ({
  args: [...baseArgs({ effort: o.effort, model: o.model, system: o.instructions, tools: o.tools.join(",") }), "--mcp-config", p.mcpConfig, "--permission-mode", "default"],
  cwd: p.cwd,
  env: { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl, DISABLE_PROMPT_CACHING: "1" },
  pooled: false,
});

const failed = (e: { readonly message: string }) => new ModelError({ message: e.message });

// a tool call begins: its block starts streaming, before claude can have run it
const callsTool = (e: Event) =>
  (e.type === "stream_event" && e.event.type === "content_block_start" && e.event.content_block.type === "tool_use") ||
  (e.type === "assistant" && e.message.content.some((b) => b.type === "tool_use"));

export const claudeCodeCompactor = (o: CompactorOptions) => {
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one process per node, each try a message into it, its result the answer. A call
  // that waits on another writing a prefix of its own waits before its process starts.
  const call = (job: Job, failoverFrom: string | null) =>
    Effect.gen(function* () {
      const p = yield* o.placement;
      const first = blocks(job, o.ttl);
      return yield* o.gate.through(claudePrefix(o, first, o.ttl), (started) =>
        Effect.gen(function* () {
          const claude = yield* p.runner.spawn(compactSpawn(o, p)).pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(failed(e))));
          // a try's events up to its result: the first stream event means the request was taken;
          // a tool call ends the try (the scope kills the process), since the tools are there for
          // the prefix only
          const answer = Effect.gen(function* () {
            for (;;) {
              const next = yield* claude.next;
              if (Option.isNone(next)) return yield* claude.result.pipe(Effect.mapError(failed));
              const e = next.value;
              if (e.type === "stream_event") yield* started;
              if (callsTool(e)) return yield* new ModelError({ message: "the compactor called a tool" });
              if (e.type === "result") return e;
            }
          });
          const ask = (t: Try) =>
            Effect.gen(function* () {
              yield* admitRequest();
              yield* claude.send(t.retry === null ? first : [{ text: t.retry.text, type: "text" }]);
              const result = yield* answer;
              const usage = tokensOf(result.usage), model = claude.model() ?? null;
              if (result.is_error || result.stop_reason === "refusal")
                return yield* fromResult(result.result ?? `the call ended with ${result.subtype ?? "an error"}`, result.stop_reason, { model, usage });
              return { cut: stoppedShort(result.stop_reason), model, text: result.result ?? "", usage };
            });
          return yield* sizeRetries({ ask, auth: "claude-max", device: o.device, effort: o.effort, engine: "claude-code", failoverFrom, job, log: o.log });
        }).pipe(Effect.scoped), // the process ends with the node
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `no answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> => call(job, failoverFrom);
};
