#!/usr/bin/env bun
// A stand-in for `claude -p --input-format stream-json --output-format stream-json` (ref §10,
// §16.4). The code under test runs it when OPTCHAT_CLAUDE names this file. No model, no network.
//
// It tells the three kinds of call apart the way optchat starts them:
//   compact   --safe-mode in argv (the compactor)
//   prime     DISABLE_PROMPT_CACHING=1 without --safe-mode (a priming call)
//   turn      anything else
//
// FAKE_CLAUDE_LOG: a JSONL file it appends to, one record per thing that happened:
//   {type: "start", pid, role, call, argv, cwd, env}   call = how many of this role started before it
//   {type: "in", pid, content}                          every user message read from stdin
//   {type: "exit", pid, code}                           a normal end (not after SIGKILL)
//
// FAKE_CLAUDE_SCRIPT: a JSON file {turn?, prime?, compact?}. Each role holds a list of calls: the
// k-th process of that role plays call k, and the last call repeats. A call is a list of replies,
// reply k answering the k-th message the call starts work on (the last reply repeats); a call
// may also be written as one reply, a plain list of actions. Actions:
//   {text: "..."}                 a streamed text delta, then the assistant text block
//   {thinking: N}                 a thinking delta of ~N tokens and an empty thinking block
//   {tool: {name, input}}         an assistant tool_use block
//   {toolResult: "..."}           the user event carrying that tool's result
//   {waitInput: true}             wait until a message arrives that no reply or take used yet
//   {take: true}                  wait for such a message and take it now: its replay event
//   {result: {text?, is_error?, stop_reason?, subtype?, usage?}}
//   {emit: {...}}                 one raw stdout line
//   {sleep: ms}  {hang: true}  {exit: code, stderr?: "..."}
// A reply that ends without result, hang or exit gets a result with its text. message_start
// goes out before the first text, thinking, tool or result of each reply. With
// --replay-user-messages, the message a reply answers is replayed first, as Claude Code does.
// Roles the script leaves out: a turn answers "ok", a priming call is accepted (message_start)
// and waits, a compactor call answers a short line.
//
// It exits when stdin closes, also while it hangs or waits, and on SIGTERM.
import * as Schema from "effect/Schema";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const Usage = Schema.Struct({
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
});
const Action = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ thinking: Schema.Number }),
  Schema.Struct({ tool: Schema.Struct({ input: Schema.Json, name: Schema.String }) }),
  Schema.Struct({ toolResult: Schema.String }),
  Schema.Struct({ waitInput: Schema.Literal(true) }),
  Schema.Struct({ take: Schema.Literal(true) }),
  Schema.Struct({
    result: Schema.Struct({
      is_error: Schema.optional(Schema.Boolean),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
      subtype: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      usage: Schema.optional(Usage),
    }),
  }),
  Schema.Struct({ emit: Schema.Json }),
  Schema.Struct({ sleep: Schema.Number }),
  Schema.Struct({ hang: Schema.Literal(true) }),
  Schema.Struct({ exit: Schema.Number, stderr: Schema.optional(Schema.String) }),
]);
const Reply = Schema.Array(Action);
type Reply = typeof Reply.Type;
const Replies = Schema.Array(Reply);
const Call = Schema.Union([Replies, Reply]);
const Script = Schema.Struct({
  compact: Schema.optional(Schema.Array(Call)),
  prime: Schema.optional(Schema.Array(Call)),
  turn: Schema.optional(Schema.Array(Call)),
});
const Input = Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.Json) })) }));

type Role = "compact" | "prime" | "turn";
type Json = Schema.Json;
type LogRecord =
  | { readonly type: "start"; readonly role: Role; readonly call: number; readonly argv: readonly string[]; readonly cwd: string; readonly env: Json }
  | { readonly type: "in"; readonly content: Json }
  | { readonly type: "exit"; readonly code: number };

const argv = process.argv.slice(2);
const { env } = process;
const role: Role = argv.includes("--safe-mode") ? "compact" : env.DISABLE_PROMPT_CACHING === "1" ? "prime" : "turn";
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const model = flag("--model") ?? "fake";
const replaying = argv.includes("--replay-user-messages");

const logPath = env.FAKE_CLAUDE_LOG;
const record = (r: LogRecord) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...r })}\n`);
};
// how many calls of this role started before this one
const earlier = () =>
  logPath && existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"type":"start"') && line.includes(`"role":"${role}"`)).length
    : 0;

const usageOf = (u?: typeof Usage.Type) => ({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 3, output_tokens: 5, ...u });
const messageStart = (usage: typeof Usage.Type) => ({ event: { message: { model, usage }, type: "message_start" }, type: "stream_event" });

const DEFAULTS = {
  compact: [{ text: "talk: a short summary line" }],
  prime: [{ emit: messageStart({ cache_creation_input_tokens: 100, input_tokens: 3 }) }, { hang: true }],
  turn: [{ text: "ok" }],
} satisfies Record<Role, Reply>;

const script = env.FAKE_CLAUDE_SCRIPT ? Schema.decodeUnknownSync(Schema.fromJsonString(Script))(readFileSync(env.FAKE_CLAUDE_SCRIPT, "utf8")) : {};
const callIndex = earlier();
const shown = { CLAUDE_CODE_PROMPT_CACHE_TTL: env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null, DISABLE_PROMPT_CACHING: env.DISABLE_PROMPT_CACHING ?? null };
record({ argv, call: callIndex, cwd: process.cwd(), env: shown, role, type: "start" });

const calls = script[role] ?? [];
const call = calls[Math.min(callIndex, calls.length - 1)] ?? DEFAULTS[role];
const isReply = Schema.is(Reply);
const replies: readonly Reply[] = isReply(call) ? [call] : call;
const replyFor = (k: number): Reply => replies[Math.min(k, replies.length - 1)] ?? DEFAULTS[role];

const quit = (code: number) => {
  record({ code, type: "exit" });
  process.exit(code);
};
process.on("SIGTERM", () => {
  quit(143);
});

const emit = (event: Json) => {
  writeSync(1, `${JSON.stringify(event)}\n`);
};

// stdin: one stream-json user message per line
const inbox: Json[] = [];
let used = 0; // messages answered or taken so far
let wake: (() => void) | null = null;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const content = Schema.decodeUnknownSync(Input)(line).message?.content ?? null;
  record({ content, type: "in" });
  inbox.push(content);
  wake?.();
});
lines.on("close", () => {
  quit(0);
});

const unused = async () => {
  while (inbox.length <= used)
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  wake = null;
};
const replay = (content: Json) => {
  emit({ isReplay: true, message: { content, role: "user" }, type: "user" });
};

let started = false;
const start = () => {
  if (started) return;
  started = true;
  emit(messageStart(usageOf()));
};

// plays one reply; false when the process is to stop answering (it hangs or exits)
async function play(reply: Reply): Promise<boolean> {
  started = false;
  const said: string[] = [];
  for (const a of reply) {
    if ("text" in a) {
      start();
      said.push(a.text);
      emit({ event: { delta: { text: a.text, type: "text_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" });
      emit({ message: { content: [{ text: a.text, type: "text" }], model, role: "assistant" }, type: "assistant" });
    } else if ("thinking" in a) {
      start();
      emit({ event: { delta: { estimated_tokens: a.thinking, thinking: "", type: "thinking_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" });
      emit({ message: { content: [{ signature: "sig", thinking: "", type: "thinking" }], model, role: "assistant" }, type: "assistant" });
    } else if ("tool" in a) {
      start();
      emit({ message: { content: [{ id: "toolu_1", input: a.tool.input, name: a.tool.name, type: "tool_use" }], model, role: "assistant" }, type: "assistant" });
    } else if ("toolResult" in a) {
      emit({ message: { content: [{ content: a.toolResult, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" }, type: "user" });
    } else if ("waitInput" in a) {
      await unused();
    } else if ("take" in a) {
      await unused();
      replay(inbox[used++] ?? null);
    } else if ("result" in a) {
      start();
      const r = a.result;
      emit({
        duration_ms: 1,
        is_error: r.is_error ?? false,
        result: r.text ?? said.join("\n"),
        stop_reason: r.stop_reason === undefined ? "end_turn" : r.stop_reason,
        subtype: r.subtype ?? (r.is_error ? "error_during_execution" : "success"),
        type: "result",
        usage: usageOf(r.usage),
      });
      return true;
    } else if ("emit" in a) {
      emit(a.emit);
    } else if ("sleep" in a) {
      await Bun.sleep(a.sleep);
    } else if ("hang" in a) {
      return false;
    } else {
      if (a.stderr) writeSync(2, a.stderr);
      quit(a.exit);
    }
  }
  start();
  emit({ duration_ms: 1, is_error: false, result: said.join("\n"), stop_reason: "end_turn", subtype: "success", type: "result", usage: usageOf() });
  return true;
}

let initSent = false;
for (let k = 0; ; k++) {
  await unused();
  const content = inbox[used++] ?? null;
  if (!initSent) {
    initSent = true;
    const mcp = argv.includes("--mcp-config") ? [{ name: "optchat", status: "connected" }] : [];
    emit({ mcp_servers: mcp, model, subtype: "init", tools: [], type: "system" });
  }
  if (replaying) replay(content);
  if (!(await play(replyFor(k))))
    await new Promise<never>(() => {
      // hangs: stdin's close or a signal ends the process
    });
}
