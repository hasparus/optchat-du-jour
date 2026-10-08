// The claude-code turn engine (ref §4-§6, docs/optchat.md §6, E6/E7): one `claude -p` per turn on the
// turn's device, the view in blocks of BLOCK lines without cache marks then the new texts, the
// stream mapped to the log, and the process killed at the first result. Priming writes the same
// view blocks to the cache while the session is idle, with our own marks (see primeBlocks); that
// call ends at message_start, once the API has taken the request. A turn never waits for it (E17). `warm` tells a device's Runner which
// two spawns come next, so it can start them ahead (E18). What each claude shows of the MCP server
// optchat goes to the device's transport, which may fall back from ws to http (E8).
import { Clock, Effect, Option, Semaphore } from "effect";
import { baseArgs } from "../claude/args.ts";
import { type Assistant, type Block, type Event, type Init, type Result, type StreamEvent, SYNTHETIC, type TextBlock as TextInput, type Usage, type User } from "../claude/events.ts";
import type { Claude, Runner, Spawn } from "../claude/process.ts";
import { cap } from "../cap.ts";
import { isPicture, type Part } from "../media/part.ts";
import { PRIME_TIMEOUT } from "../config.ts";
import { type DeviceOffline, fromResult, ModelError } from "../engines/errors.ts";
import type { McpSeen } from "../mcp.ts";
import type { StoreError } from "../store.ts";
import { isCold, tokensOf, type UsageRecord } from "../usage.ts";
import { viewBlocks } from "../view.ts";
import { type Mid, openingText, type TurnEngine, type TurnEvents } from "./engine.ts";

type Ttl = "1h" | "5m";

// where a device's claude runs (E7): its Runner, the folder it starts in (unexpanded for another
// machine, whose `~` is its own), and the --mcp-config that reaches the server from there (E8)
export type Placement = {
  readonly runner: Runner["Service"];
  readonly cwd: string | undefined;
  readonly mcpConfig: string;
  // what a claude there showed of optchat, for the transport to act on; true when that moved the
  // device to another transport, so mcpConfig is a new one from now on
  readonly mcpSeen: (seen: McpSeen) => Effect.Effect<boolean>;
};

export type ClaudeCodeTurnOptions = {
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly ttl: Ttl; // the TTL of Claude Code's own marks on a turn (E6)
  readonly primeTtl: Ttl; // the TTL of the marks priming writes
  readonly instructions: string; // the one system prompt (docs/optchat.md §5), sent inline on every device
  // DeviceOffline when the device can't be reached or can't be used
  readonly runnerFor: (device: string) => Effect.Effect<Placement, DeviceOffline>;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly logUsage: TurnEvents["usage"];
  // whether the warm processes follow this engine (it ran the most recent turn, or heads the chain
  // before any, E18): the session has only its spawns started ahead, so only it starts them again
  // when a device moves to another MCP transport. Asked each time, since each turn can change it.
  readonly warms: () => boolean;
};

// One argv for the turn and its priming call: any difference between the two would cost the
// whole view in cache writes (ref §13).
export const masterArgs = (o: Pick<ClaudeCodeTurnOptions, "effort" | "instructions" | "model" | "permissionMode" | "tools"> & { readonly mcpConfig: string }) => [
  ...baseArgs({ effort: o.effort, model: o.model, system: o.instructions, tools: o.tools.join(",") }),
  "--mcp-config",
  o.mcpConfig,
  "--permission-mode",
  o.permissionMode,
  "--replay-user-messages",
];

const text = (t: string): Block => ({ text: t, type: "text" });
// a part of a message as a stream-json block: text, or an image with its bytes inline (SPEC "Media")
const block = (p: Part): Block => (isPicture(p) ? { source: { data: p.data, media_type: p.mime, type: "base64" }, type: "image" } : text(p));

type Assistant = typeof Assistant.Type;
type User = typeof User.Type;
type AssistantBlock = Assistant["message"]["content"][number];
type TextBlock = Extract<AssistantBlock, { readonly type: "text" }>;
type ToolUseBlock = Extract<AssistantBlock, { readonly type: "tool_use" }>;
type UserContent = User["message"]["content"];
type ResultContent = Extract<Exclude<UserContent, string>[number], { readonly type: "tool_result" }>["content"];

// the schemas let any other block through as {type}; these tell the ones we log apart
const isText = (b: AssistantBlock): b is TextBlock => b.type === "text" && "text" in b && typeof b.text === "string";
const isToolUse = (b: AssistantBlock): b is ToolUseBlock => b.type === "tool_use" && "name" in b && typeof b.name === "string";
const isPlainUser = (c: UserContent): c is string => typeof c === "string";
const isPlainResult = (c: NonNullable<ResultContent>): c is string => typeof c === "string";

// the text of a tool result: its text parts, one per line; anything else by its type, e.g. [image]
const resultText = (content: ResultContent) => {
  if (content === undefined) return "";
  if (isPlainResult(content)) return content;
  const parts = content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`));
  return parts.join("\n");
};

// what claude's init says of the MCP server named optchat
export const mcpStatus = (e: typeof Init.Type) => e.mcp_servers?.find(({ name }) => name === "optchat")?.status ?? "not listed";

// Stream events to log entries, in stream order (ref §5.3). Live text goes out as it streams;
// a thought only by its size. Replays: see onReplay; `passed` is what went to stdin after the
// opening message, oldest first. `mcp` hears optchat's status from init. A message Claude Code
// wrote itself (an API error, model "<synthetic>") is never logged as the model's: its text is
// kept in `errors`, for the failure the error result after it becomes.
export function makeMapper(out: TurnEvents, passed: Mid[], mcp: (status: string) => Effect.Effect<void>) {
  const errors: string[] = [];
  let openingSeen = false;
  let thoughtChars = 0;

  // without the server named optchat the model has no memory tools; say so, and let the turn run
  const onInit = (e: typeof Init.Type) => {
    const status = mcpStatus(e);
    return Effect.andThen(mcp(status), status === "connected" ? Effect.void : out.info(`no zoom or date in this turn: MCP server optchat is ${status}`));
  };

  const onStream = (e: typeof StreamEvent.Type) => {
    if (e.event.type !== "content_block_delta") return Effect.void;
    const d = e.event.delta;
    if (d.type === "text_delta") return out.text(d.text);
    // thinking text is not streamed today (ref §14 T1); if it ever is, only its size goes out
    thoughtChars += d.thinking?.length ?? 0;
    const tokens = d.estimated_tokens ?? Math.ceil(thoughtChars / 4);
    return tokens > 0 ? out.thinking(tokens) : Effect.void;
  };

  const onAssistant = (e: Assistant) => {
    if (e.message.model === SYNTHETIC) {
      for (const block of e.message.content) if (isText(block) && block.text.trim()) errors.push(block.text);
      return Effect.void;
    }
    return Effect.forEach(
      e.message.content,
      (block) => {
        if (isText(block)) return block.text.trim() ? out.log("talk", block.text) : Effect.void;
        if (isToolUse(block)) return out.log("tool", `${block.name} ${JSON.stringify(block.input)}`);
        if (block.type === "thinking") thoughtChars = 0; // a thought ended; never logged (docs/optchat.md §1)
        return Effect.void;
      },
      { discard: true },
    );
  };

  // Claude Code echoes each user message as it takes it. The opening message comes back first and
  // the session logged it before the call. Mid-run messages come back in the order they went to
  // stdin, so each later echo is the oldest one passed and not echoed yet: taken now.
  const onReplay = () => {
    if (!openingSeen) {
      openingSeen = true;
      return Effect.void;
    }
    const taken = passed.shift();
    return taken ? out.took(taken) : Effect.void; // an echo of something we never sent: nothing to log
  };

  const onUser = (e: User) => {
    if (e.isReplay) return onReplay();
    const { content } = e.message;
    if (isPlainUser(content)) return Effect.void;
    return Effect.forEach(
      content,
      (block) => (block.type === "tool_result" ? out.log("echo", cap(resultText("content" in block ? block.content : undefined))) : Effect.void),
      { discard: true },
    );
  };

  const map = (e: Event): Effect.Effect<void, StoreError> => {
    switch (e.type) {
      case "system":
        return onInit(e);
      case "stream_event":
        return onStream(e);
      case "assistant":
        return onAssistant(e);
      case "user":
        return onUser(e);
      case "result":
        break; // the caller's to act on
    }
    return Effect.void;
  };
  const kept: readonly string[] = errors; // the caller reads them; only onAssistant adds
  return { errors: kept, map };
}

// The output of one call, read to the first event `stop` picks; None when the process ended.
const readUntil = <A>(claude: Claude, stop: (e: Event) => Option.Option<A>, each: (e: Event) => Effect.Effect<void, StoreError>) =>
  Effect.gen(function* () {
    for (;;) {
      const next = yield* claude.next;
      if (Option.isNone(next)) return Option.none<A>();
      yield* each(next.value);
      const found = stop(next.value);
      if (Option.isSome(found)) return found;
    }
  });

// the output ended before the event we waited for: why, from the exit code and stderr
const died = (claude: Claude) =>
  claude.result.pipe(
    Effect.matchEffect({
      onFailure: (e) => Effect.fail(new ModelError({ message: e.message })),
      onSuccess: () => Effect.fail(new ModelError({ message: "the process ended" })),
    }),
  );

// `usage` is what the call cost in all; `opening`, the usage of its first request, decides `cold`:
// only that request reads the view, the later steps of a turn read the turn's own tail
const usageRecord = (o: {
  readonly role: "turn" | "prime";
  readonly usage: Usage | undefined;
  readonly opening?: Usage | undefined;
  readonly model: string | undefined;
  readonly device: string;
  readonly failoverFrom: string | null;
  readonly started: number;
  readonly now: number;
}): UsageRecord => {
  const usage = tokensOf(o.usage);
  return {
    attempt: 1,
    auth: "claude-max",
    cold: isCold(o.opening === undefined ? usage : tokensOf(o.opening)),
    date: new Date(o.now).toISOString(),
    device: o.device,
    engine: "claude-code",
    failoverFrom: o.failoverFrom,
    level: null,
    model: o.model ?? null,
    ms: o.now - o.started,
    role: o.role,
    usage,
  };
};

// Why a call failed: its result's text, and what Claude Code's own error messages said when the
// result does not say it already (a usage limit may show only there)
const failedWith = (r: Result, errors: readonly string[]) => {
  const said = [...new Set([r.result ?? "", ...errors].filter((t) => t.trim() !== ""))];
  return said.length > 0 ? said.join(": ") : `the turn ended with ${r.subtype ?? "an error"}`;
};

// What priming sends of the view: the turn's blocks, marked on the last whole block and on the
// view's end, the only marks in the request (DISABLE_PROMPT_CACHING=1). The turn right after reads
// the whole view at the end mark (its own end mark looks back to it); a later priming, the view
// grown at its end, finds the whole-block mark by the lookback and writes only the lines after it.
// The "ok" after them is priming's own and never read, so it gets none.
export const primeBlocks = (view: string, ttl: Ttl): TextInput[] => {
  const { blocks, whole } = viewBlocks(view);
  const marked = new Set([whole - 1, blocks.length - 1]);
  return blocks.map((piece, k): TextInput => (marked.has(k) ? { cache_control: { ttl, type: "ephemeral" }, text: piece, type: "text" } : { text: piece, type: "text" }));
};

// a priming of this view older than this is redone: the TTL minus a margin (ref §2, E6)
export const primeMaxAge = (ttl: Ttl) => (ttl === "1h" ? 3_300_000 : 270_000);

export const claudeCodeTurn = (o: ClaudeCodeTurnOptions) =>
  Effect.gen(function* () {
    // The same argv for a device's turns and primings; only the MCP URL may differ between
    // devices, and priming adds DISABLE_PROMPT_CACHING=1. A warm process is handed out only for
    // the very same spawn, so both are built here and nowhere else.
    const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl };
    const turnSpawn = (p: Placement): Spawn => ({ args: masterArgs({ ...o, mcpConfig: p.mcpConfig }), cwd: p.cwd, env });
    const primeSpawn = (p: Placement): Spawn => ({ ...turnSpawn(p), env: { ...env, DISABLE_PROMPT_CACHING: "1" } });

    // the next turn and priming on `device`, for a Runner that starts processes ahead (E18)
    const warm = (device: string) =>
      o.runnerFor(device).pipe(
        Effect.flatMap((p) => p.runner.warm([turnSpawn(p), primeSpawn(p)])),
        Effect.ignore,
      );

    // What one claude shows of optchat goes to its device's transport (E8): init's status, or why
    // it ended before any init. A device moved to another transport is warmed again by the engine
    // the warm processes follow (the most recent turn's), so its next spawns, with the new
    // --mcp-config, find processes started ahead and the stale ones close. Another engine's move
    // leaves them to the session's next warm, when it goes idle: started now, its own spawns would
    // take that engine's place.
    const mcpWatch = (device: string, p: Placement) => {
      let init = false;
      const tell = (seen: McpSeen) => p.mcpSeen(seen).pipe(Effect.flatMap((moved) => (moved && o.warms() ? warm(device) : Effect.void)));
      return {
        ended: (e: ModelError) => Effect.suspend(() => (init ? Effect.void : tell({ ended: e.message }))),
        init: (status: string) =>
          Effect.suspend(() => {
            init = true;
            return tell({ status });
          }),
      };
    };

    const run: TurnEngine["run"] = (input, out, failoverFrom) =>
      Effect.gen(function* () {
        const placement = yield* o.runnerFor(input.device);
        const claude = yield* placement.runner
          .spawn(turnSpawn(placement))
          .pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(new ModelError({ message: e.message }))));
        const started = yield* Clock.currentTimeMillis;
        // the view in the blocks priming sent, with no marks: Claude Code's own take all 4 slots
        // (D2), and its mark at the request's end finds priming's within the 20-block lookback;
        // the new messages' pictures; the new messages, a blank line apart (ref §5.1), and after a
        // failover what came before
        yield* claude.send([...viewBlocks(input.view).blocks.map(text), ...input.media.map(block), text(openingText(input))]);

        // Mid-run messages go to stdin as they are offered (after a failover, first the ones the
        // engine before never took), each noted as passed before it is written, so its echo can
        // name it. One never echoed stays the session's: it gets it back when the call ends.
        const passed: Mid[] = [];
        yield* input.mid.next.pipe(
          Effect.flatMap((m) => Effect.suspend(() => (passed.push(m), claude.send([...m.media.map(block), text(m.text)])))),
          Effect.forever,
          Effect.forkScoped,
        );

        const mcp = mcpWatch(input.device, placement);
        const { errors, map } = makeMapper(out, passed, mcp.init);
        let opening: Usage | undefined;
        const each = (e: Event) => {
          if (opening === undefined && e.type === "stream_event" && e.event.type === "message_start") opening = e.event.message.usage;
          return map(e);
        };
        const found = yield* readUntil(claude, (e) => (e.type === "result" ? Option.some(e) : Option.none()), each);
        const r = yield* Option.match(found, { onNone: () => Effect.tapError(died(claude), mcp.ended), onSome: Effect.succeed });
        const now = yield* Clock.currentTimeMillis;
        yield* out.usage(usageRecord({ device: input.device, failoverFrom, model: claude.model(), now, opening, role: "turn", started, usage: r.usage }));
        yield* r.is_error || r.stop_reason === "refusal"
          ? Effect.fail(fromResult(failedWith(r, errors), r.stop_reason))
          : Effect.void;
      }).pipe(Effect.scoped); // the first result ends the call: closing the scope kills the process (D3)

    // Priming (ref §6). One at a time, a view primed recently is skipped, and a failure is reported
    // once per streak: priming saves money, the turn never depends on it.
    const one = yield* Semaphore.make(1);
    let last: { readonly view: string; readonly at: number } | null = null;
    let failing = false;

    const primeOnce = (view: string, device: string) =>
      Effect.gen(function* () {
        const placement = yield* o.runnerFor(device);
        const claude = yield* placement.runner
          .spawn(primeSpawn(placement))
          .pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(new ModelError({ message: e.message })))); // DeviceOffline: priming skips quietly
        const started = yield* Clock.currentTimeMillis;
        yield* claude.send([...primeBlocks(view, o.primeTtl), text("ok")]);
        // priming is often the first call after the server starts: a transport that fails shows here first
        const mcp = mcpWatch(device, placement);
        const first = yield* readUntil(
          claude,
          (e) => (e.type === "result" || (e.type === "stream_event" && e.event.type === "message_start") ? Option.some(e) : Option.none()),
          (e) => (e.type === "system" ? mcp.init(mcpStatus(e)) : Effect.void),
        ).pipe(
          Effect.timeoutOrElse({
            duration: PRIME_TIMEOUT,
            orElse: () => Effect.fail(new ModelError({ message: "the API did not accept the request in time" })),
          }),
        );
        const e = yield* Option.match(first, { onNone: () => Effect.tapError(died(claude), mcp.ended), onSome: Effect.succeed });
        const start = e.type === "stream_event" && e.event.type === "message_start" ? e.event.message : null;
        if (!start) {
          const said = e.type === "result" && e.result ? `: ${e.result}` : "";
          return yield* new ModelError({ message: `it answered before the request was accepted${said}` });
        }
        const now = yield* Clock.currentTimeMillis;
        yield* o.logUsage(usageRecord({ device, failoverFrom: null, model: start.model ?? claude.model(), now, role: "prime", started, usage: start.usage }));
        return start;
      }).pipe(Effect.scoped); // killed at message_start: the cache entry is written by then (ref §14 F2)

    const prime = (view: string, device: string): Effect.Effect<void> =>
      one.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (last?.view === view && now - last.at < primeMaxAge(o.primeTtl)) return;
          const outcome = yield* Effect.result(primeOnce(view, device));
          if (outcome._tag === "Success") {
            last = { at: yield* Clock.currentTimeMillis, view };
            failing = false;
            return;
          }
          // an offline device is the turn's to report: it fails at once, since the runner remembers
          if (outcome.failure._tag === "DeviceOffline") return;
          if (!failing) yield* o.report(`priming failed, the turn goes on without it: ${outcome.failure.message}`);
          failing = true;
        }),
      );

    return { prime, ref: `claude-code:${o.model}`, run, vision: true, warm } satisfies TurnEngine;
  });
