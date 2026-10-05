// The turn on Claude Code (ref §5, §6): one `claude -p` per turn, the view as its input with no
// cache marks, everything it does logged as it happens, killed at its first `result`. Priming
// writes the same view blocks into the cache first, with marks of its own.
import { Clock, Effect, Option, Queue, Semaphore } from "effect";
import { CAP, PRIME_TIMEOUT } from "../config.ts";
import { baseArgs } from "../claude/args.ts";
import type { Block, Event } from "../claude/events.ts";
import { type Claude, ClaudeError, type Runner } from "../claude/process.ts";
import { type DeviceOffline, ModelError, fromResult } from "../engines/errors.ts";
import type { StoreError } from "../store.ts";
import { isCold, tokensOf } from "../usage.ts";
import { cutBlocks } from "../view.ts";
import type { Sent, TurnEngine, TurnEvents } from "./engine.ts";

export type ClaudeCodeTurnOptions = {
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly ttl: "1h" | "5m"; // E6: Claude Code's own marks on turns
  readonly primeTtl: "1h" | "5m"; // E6: our marks when priming
  readonly systemFile: string;
  readonly mcpConfig: string;
  // where a device's `claude` runs, and in which folder; DeviceOffline when it can't be reached
  readonly runnerFor: (device: string) => Effect.Effect<{ readonly runner: Runner["Service"]; readonly cwd?: string }, DeviceOffline>;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly logUsage: TurnEvents["usage"];
};

// one argv for the master and the priming call, so they can't drift apart (ref §6)
export const masterArgs = (o: ClaudeCodeTurnOptions) => [
  ...baseArgs({ effort: o.effort, model: o.model, systemFile: o.systemFile, tools: o.tools.join(",") }),
  "--mcp-config",
  o.mcpConfig,
  "--permission-mode",
  o.permissionMode,
  "--replay-user-messages",
];

// what a tool result is worth in the log: its head and its tail (gist §7)
export const cap = (s: string) =>
  s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n[… ${s.length - CAP} characters cut …]\n${s.slice(-CAP / 2)}`;

type ResultContent = string | readonly { readonly type: string; readonly text?: string }[] | undefined;
const resultText = (c: ResultContent) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`)).join("\n");

// ref §5.3: replies, tool calls and results go to the log as they arrive; thoughts never do
export function makeMapper(out: TurnEvents, sent: Sent[]) {
  let replays = 0, thought = 0;
  return (event: Event): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      switch (event.type) {
        case "system": {
          if (!event.mcp_servers?.some((s) => s.name === "optchat" && s.status === "connected"))
            yield* out.info("warning: the optchat MCP server is not connected, zoom and date are unavailable");
          return;
        }
        case "stream_event": {
          if (event.event.type !== "content_block_delta") return;
          const d = event.event.delta;
          if (d.type === "text_delta") yield* out.text(d.text);
          else if (typeof d.estimated_tokens === "number") thought = d.estimated_tokens;
          return;
        }
        case "assistant": {
          for (const block of event.message.content) {
            if ("name" in block) yield* out.log("tool", `${block.name} ${JSON.stringify(block.input)}`);
            else if ("text" in block) {
              if (block.text.trim()) yield* out.log("talk", block.text);
            } else if (block.type === "thinking") {
              yield* out.thinking(thought);
              thought = 0;
            }
          }
          return;
        }
        case "user": {
          if (event.isReplay) {
            if (replays++ === 0) return; // the turn's own opening message, already logged
            const s = sent.find((m) => !m.taken); // a mid-run message, taken at a tool boundary
            if (!s) return;
            s.taken = true;
            yield* out.log("user", s.text);
            return;
          }
          if (typeof event.message.content === "string") return;
          for (const block of event.message.content)
            if ("content" in block || block.type === "tool_result")
              yield* out.log("echo", cap(resultText("content" in block ? block.content : undefined)));
          return;
        }
        case "result":
          return;
      }
    });
}

const view = (text: string, ttl?: "1h" | "5m"): Block[] =>
  cutBlocks(text).map((t): Block => (ttl ? { cache_control: { ttl, type: "ephemeral" }, text: t, type: "text" } : { text: t, type: "text" }));

// the next event, or the reason the process ended
const nextOrExit = (claude: Claude) =>
  Effect.flatMap(claude.next, (e) =>
    Option.isSome(e) ? Effect.succeed(e.value) : claude.result.pipe(Effect.flatMap(() => Effect.fail(new ClaudeError({ message: "claude ended" })))),
  );

export const claudeCodeTurn = (o: ClaudeCodeTurnOptions) =>
  Effect.gen(function* () {
    const args = masterArgs(o);
    const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl };
    const ref = `claude-code:${o.model}`;

    const run: TurnEngine["run"] = (input, out, failoverFrom) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runner, cwd } = yield* o.runnerFor(input.device);
          const claude = yield* runner.spawn({ args, cwd, env });
          const t0 = yield* Clock.currentTimeMillis;
          yield* claude.send([...view(input.view), { text: input.texts.join("\n\n"), type: "text" }]);
          // a message sent while the call runs goes to its stdin; Claude Code takes it at the next tool boundary
          yield* Queue.take(input.steer).pipe(
            Effect.tap((text) => Effect.sync(() => input.sent.push({ taken: false, text }))),
            Effect.flatMap((text) => claude.send([{ text, type: "text" }])),
            Effect.forever,
            Effect.forkScoped,
          );
          const map = makeMapper(out, input.sent);
          for (;;) {
            const event = yield* nextOrExit(claude);
            yield* map(event);
            if (event.type !== "result") continue;
            const usage = tokensOf(event.usage);
            yield* o.logUsage({
              attempt: 1,
              auth: "claude-max",
              cold: isCold(usage),
              date: new Date().toISOString(),
              device: input.device,
              engine: "claude-code",
              failoverFrom,
              level: null,
              model: claude.model() ?? o.model,
              ms: (yield* Clock.currentTimeMillis) - t0,
              role: "turn",
              usage,
            });
            if (event.is_error || event.stop_reason === "refusal")
              return yield* fromResult(String(event.result ?? event.subtype), event.stop_reason);
            return; // the first result ends the turn: closing the scope kills the process (ref D3)
          }
        }),
      ).pipe(Effect.catchTag("ClaudeError", (e) => Effect.fail(new ModelError({ message: e.message }))));

    // ref §6: a call with the master's argv and our own marks, killed once the API accepts it
    const lock = yield* Semaphore.make(1);
    let last: { view: string; at: number } | undefined;
    let failing = false;
    const maxAge = o.primeTtl === "1h" ? 3_300_000 : 270_000; // PRIME_MAX_AGE
    const primeOnce = (text: string, device: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (last?.view === text && now - last.at < maxAge) return;
          const { runner, cwd } = yield* o.runnerFor(device);
          const claude = yield* runner.spawn({ args, cwd, env: { ...env, DISABLE_PROMPT_CACHING: "1" } });
          yield* claude.send([...view(text, o.primeTtl), { text: "ok", type: "text" }]);
          for (;;) {
            const event = yield* nextOrExit(claude);
            if (event.type === "result") return yield* new ModelError({ message: String(event.result ?? event.subtype) });
            if (event.type !== "stream_event" || event.event.type !== "message_start") continue;
            last = { at: now, view: text };
            failing = false;
            const usage = tokensOf(event.event.message.usage);
            yield* o.logUsage({
              attempt: 1,
              auth: "claude-max",
              cold: isCold(usage),
              date: new Date().toISOString(),
              device,
              engine: "claude-code",
              failoverFrom: null,
              level: null,
              model: claude.model() ?? o.model,
              ms: (yield* Clock.currentTimeMillis) - now,
              role: "prime",
              usage,
            });
            return; // the view is in the cache; the rest is not needed
          }
        }),
      ).pipe(
        Effect.timeoutOrElse({ duration: PRIME_TIMEOUT, orElse: () => Effect.fail(new ModelError({ message: "no response after 30 seconds" })) }),
        Effect.catch((e) => {
          if (failing) return Effect.void;
          failing = true;
          return o.report(`priming failed, the turn goes on without it: ${e.message}`);
        }),
      );

    const engine: TurnEngine = { prime: (text, device) => lock.withPermits(1)(primeOnce(text, device)), ref, run };
    return engine;
  });
