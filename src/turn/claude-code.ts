// The claude-code turn engine (ref §4-§6, gist §7, E6/E7): one `claude -p` per turn on the
// turn's device, the view without cache marks then the new texts, the stream mapped to the log,
// and the process killed at the first result. Priming writes the same view blocks to the cache
// first, with our own marks; that call ends at message_start, once the API has taken the request.
import { Clock, Effect, Option, Queue, Semaphore } from "effect";
import { baseArgs } from "../claude/args.ts";
import type { Assistant, Block, Event, Init, StreamEvent, Usage, User } from "../claude/events.ts";
import type { Claude, Runner } from "../claude/process.ts";
import { CAP, PRIME_TIMEOUT } from "../config.ts";
import { type DeviceOffline, fromResult, ModelError } from "../engines/errors.ts";
import type { StoreError } from "../store.ts";
import { isCold, tokensOf, type UsageRecord } from "../usage.ts";
import { cutBlocks } from "../view.ts";
import { openingText, type Sent, type TurnEngine, type TurnEvents } from "./engine.ts";

type Ttl = "1h" | "5m";

// where a device's claude runs (E7): its Runner, the folder it starts in (unexpanded for another
// machine, whose `~` is its own), and the --mcp-config that reaches the server from there (E8)
export type Placement = {
  readonly runner: Runner["Service"];
  readonly cwd: string | undefined;
  readonly mcpConfig: string;
};

export type ClaudeCodeTurnOptions = {
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly ttl: Ttl; // the TTL of Claude Code's own marks on a turn (E6)
  readonly primeTtl: Ttl; // the TTL of the marks priming writes
  readonly systemFile: string;
  // DeviceOffline when the device can't be reached or can't be used
  readonly runnerFor: (device: string) => Effect.Effect<Placement, DeviceOffline>;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly logUsage: TurnEvents["usage"];
};

// One argv for the turn and its priming call: any difference between the two would cost the
// whole view in cache writes (ref §13).
export const masterArgs = (o: Pick<ClaudeCodeTurnOptions, "effort" | "model" | "permissionMode" | "systemFile" | "tools"> & { readonly mcpConfig: string }) => [
  ...baseArgs({ effort: o.effort, model: o.model, systemFile: o.systemFile, tools: o.tools.join(",") }),
  "--mcp-config",
  o.mcpConfig,
  "--permission-mode",
  o.permissionMode,
  "--replay-user-messages",
];

// A tool result as the log keeps it: at most CAP characters, the head and the tail, with what
// was cut in between (gist §7, ref §5.3).
export function cap(full: string): string {
  const over = full.length - CAP;
  if (over <= 0) return full;
  const keep = CAP / 2;
  const head = full.slice(0, keep), tail = full.slice(full.length - keep);
  return `${head}\n[… ${over} chars cut …]\n${tail}`;
}

const text = (t: string): Block => ({ text: t, type: "text" });

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

// Stream events to log entries, in stream order (ref §5.3). Live text goes out as it streams;
// a thought only by its size. Replays: see onReplay.
export function makeMapper(out: TurnEvents, sent: Sent[]) {
  let openingSeen = false;
  let thoughtChars = 0;

  // without the server named optchat the model has no memory tools; say so, and let the turn run
  const onInit = (e: typeof Init.Type) => {
    const status = e.mcp_servers?.find(({ name }) => name === "optchat")?.status ?? "not listed";
    return status === "connected" ? Effect.void : out.info(`no zoom or date in this turn: MCP server optchat is ${status}`);
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

  const onAssistant = (e: Assistant) =>
    Effect.forEach(
      e.message.content,
      (block) => {
        if (isText(block)) return block.text.trim() ? out.log("talk", block.text) : Effect.void;
        if (isToolUse(block)) return out.log("tool", `${block.name} ${JSON.stringify(block.input)}`);
        if (block.type === "thinking") thoughtChars = 0; // a thought ended; never logged (gist §2)
        return Effect.void;
      },
      { discard: true },
    );

  // Claude Code echoes each user message as it takes it. The opening message comes back first and
  // the session logged it before the call. Mid-run messages come back in the order they went to
  // stdin, so each later echo is the oldest one in `sent` still waiting.
  const onReplay = () => {
    if (!openingSeen) {
      openingSeen = true;
      return Effect.void;
    }
    for (const waiting of sent) {
      if (waiting.taken) continue;
      waiting.taken = true;
      return out.log("user", waiting.text);
    }
    return Effect.void; // an echo of something we never sent: nothing to log
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

  return (e: Event): Effect.Effect<void, StoreError> => {
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

// a priming of this view older than this is redone: the TTL minus a margin (ref §2, E6)
export const primeMaxAge = (ttl: Ttl) => (ttl === "1h" ? 3_300_000 : 270_000);

export const claudeCodeTurn = (o: ClaudeCodeTurnOptions) =>
  Effect.gen(function* () {
    // the same argv for a device's turns and primings; only the MCP URL may differ between devices
    const argsFor = (mcpConfig: string) => masterArgs({ ...o, mcpConfig });
    const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl };

    const run: TurnEngine["run"] = (input, out, failoverFrom) =>
      Effect.gen(function* () {
        const { cwd, mcpConfig, runner } = yield* o.runnerFor(input.device);
        const claude = yield* runner
          .spawn({ args: argsFor(mcpConfig), cwd, env })
          .pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(new ModelError({ message: e.message })))); // DeviceOffline: priming skips quietly
        const started = yield* Clock.currentTimeMillis;
        // the view exactly as priming cut it, with no marks: Claude Code's own marks are on (D2)
        // the new messages, a blank line apart (ref §5.1), and after a failover what came before
        yield* claude.send([...cutBlocks(input.view).map(text), text(openingText(input))]);
        // after a failover, the mid-run messages the engine before never took: replayed in order
        for (const s of input.sent) if (!s.taken) yield* claude.send([text(s.text)]);

        // Mid-run messages go to stdin as they come, each recorded in `sent` as it goes. Once
        // taken from the queue it is in `sent` before anything can interrupt, so the session
        // finds every message either in the queue or in `sent`.
        yield* Effect.uninterruptibleMask((restore) =>
          restore(Queue.take(input.steer)).pipe(
            Effect.tap((t) =>
              Effect.sync(() => {
                input.sent.push({ taken: false, text: t });
              }),
            ),
            Effect.flatMap((t) => claude.send([text(t)])),
          ),
        ).pipe(Effect.forever, Effect.forkScoped);

        const map = makeMapper(out, input.sent);
        let opening: Usage | undefined;
        const each = (e: Event) => {
          if (opening === undefined && e.type === "stream_event" && e.event.type === "message_start") opening = e.event.message.usage;
          return map(e);
        };
        const found = yield* readUntil(claude, (e) => (e.type === "result" ? Option.some(e) : Option.none()), each);
        const r = yield* Option.match(found, { onNone: () => died(claude), onSome: Effect.succeed });
        const now = yield* Clock.currentTimeMillis;
        yield* out.usage(usageRecord({ device: input.device, failoverFrom, model: claude.model(), now, opening, role: "turn", started, usage: r.usage }));
        yield* r.is_error || r.stop_reason === "refusal"
          ? Effect.fail(fromResult(r.result ?? `the turn ended with ${r.subtype ?? "an error"}`, r.stop_reason))
          : Effect.void;
      }).pipe(Effect.scoped); // the first result ends the call: closing the scope kills the process (D3)

    // Priming (ref §6). One at a time, a view primed recently is skipped, and a failure is reported
    // once per streak: priming saves money, the turn never depends on it.
    const one = yield* Semaphore.make(1);
    let last: { readonly view: string; readonly at: number } | null = null;
    let failing = false;

    const primeOnce = (view: string, device: string) =>
      Effect.gen(function* () {
        const { cwd, mcpConfig, runner } = yield* o.runnerFor(device);
        const claude = yield* runner
          .spawn({ args: argsFor(mcpConfig), cwd, env: { ...env, DISABLE_PROMPT_CACHING: "1" } })
          .pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(new ModelError({ message: e.message })))); // DeviceOffline: priming skips quietly
        const started = yield* Clock.currentTimeMillis;
        const mark = { ttl: o.primeTtl, type: "ephemeral" } as const;
        const marked = cutBlocks(view).map((piece): Block => ({ cache_control: mark, text: piece, type: "text" }));
        yield* claude.send([...marked, text("ok")]);
        const first = yield* readUntil(
          claude,
          (e) => (e.type === "result" || (e.type === "stream_event" && e.event.type === "message_start") ? Option.some(e) : Option.none()),
          () => Effect.void,
        ).pipe(
          Effect.timeoutOrElse({
            duration: PRIME_TIMEOUT,
            orElse: () => Effect.fail(new ModelError({ message: "the API did not accept the request in time" })),
          }),
        );
        const e = yield* Option.match(first, { onNone: () => died(claude), onSome: Effect.succeed });
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

    return { prime, ref: `claude-code:${o.model}`, run } satisfies TurnEngine;
  });
