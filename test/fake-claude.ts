#!/usr/bin/env bun
// Our fake `claude`: it speaks the stream-json of `claude -p` on stdin and stdout (ref §10,
// §16.4). The code under test runs it when OPTCHAT_CLAUDE names this file. No model, no network.
//
// It tells the five kinds of call apart the way optchat starts them:
//   caption   --system-prompt is the caption prompt (an attachment's caption, SPEC "Media")
//   compact   DISABLE_PROMPT_CACHING=1 without --replay-user-messages (the compactor)
//   prime     DISABLE_PROMPT_CACHING=1 with --replay-user-messages (a priming call, the turn's argv)
//   subagent  OPTCHAT_SUBAGENT is set (a subagent's call names it, SPEC "Subagents"), or
//             --allowedTools (M7a's subagents had it)
//   turn      anything else
//
// Permissions, as `claude -p` with `--setting-sources ""` has them: under --permission-mode
// default a tool call is refused (an error tool_result saying so, in place of any the script
// gives) unless the tool needs no permission (Read, Glob, Grep, TodoWrite) or --allowedTools
// names it; bypassPermissions lets everything run.
//
// FAKE_CLAUDE_LOG: a JSONL file it appends to, one record per thing that happened, each with its
// time `t` (ms since the epoch):
//   {type: "start", pid, role, call, argv, cwd, env}   call = how many of this role started before it
//   {type: "in", pid, content}                          every user message read from stdin
//   {type: "exit", pid, code}                           a normal end (not after SIGKILL)
//
// FAKE_CLAUDE_SCRIPT: a JSON file {turn?, prime?, compact?, caption?, subagent?}. `subagent` may
// instead be an object by the subagent's name, {scout: call, …}: a subagent's call is then picked by
// the name its opening message gives it (`You are the subagent "scout"`), not by the order processes
// started in, which two subagents spawned at once can't be relied on for. `turn` may likewise be an
// object by a word of the new message, {"weekend": call, "*": call}: the first key the opening's
// last text block contains, else "*" (warm processes start ahead, so the order processes started in
// is not the order of the turns). Each role holds a list of calls: the
// k-th process of that role plays call k, and the last call repeats. A call is a list of replies,
// reply k answering the k-th message the call starts work on (the last reply repeats); a call
// may also be written as one reply, a plain list of actions. Actions:
//   {text: "..."}                 a streamed text delta, then the assistant text block
//   {synthetic: "..."}            an assistant text block of model "<synthetic>", unstreamed: how
//                                 Claude Code reports an API error before its error result
//   {thinking: N}                 a thinking delta of ~N tokens and an empty thinking block
//   {thought: "...", streamed?}   a thought with its text: thinking deltas carrying it (unless
//                                 streamed is false), then the thinking block holding it whole
//   {tool: {name, input}, pace?}  a tool_use block: its content_block_start, its input as
//                                 input_json_delta pieces of 64 characters (`pace` ms apart when
//                                 given), its content_block_stop, then the assistant block (and the
//                                 refusal, when the permission mode refuses it)
//   {mcp: {name, input}, pace?}   a call of the MCP server optchat's tool `name` (zoom, date, spawn,
//                                 tell, the artifact tools): its tool_use block as
//                                 mcp__optchat__<name>, streamed as a tool's is, then, unless
//                                 the permission mode refuses it, a real POST to the URL its
//                                 --mcp-config names (ws:// read as http://), whose answer is the
//                                 tool_result
//   {run: {name, input}}          a tool_use block like `tool`, then, when the permission mode lets it
//                                 run, the tool really runs, as Claude Code's would: Bash runs
//                                 input.command with `sh -c` in this process's cwd (its output and
//                                 exit code are the result, is_error when the code isn't 0), Write
//                                 writes input.content to input.file_path (relative to the cwd)
//   {toolResult: "...", is_error?}  the user event carrying that tool's result; is_error: true
//                                 marks it failed, as Claude Code does (a Bash exit code, a
//                                 <tool_use_error>); any other JSON value goes out as given, to
//                                 test a malformed one; left out of the block when unset
//   {waitInput: true}             wait until a message arrives that no reply or take used yet
//   {take: true}                  wait for such a message and take it now: its replay event
//   {gate: "path"}                wait until a file is at that path: the test lets the reply go on
//                                 by writing it, once it has seen what it waits for (a gate once
//                                 opened stays open)
//   {result: {text?, is_error?, stop_reason?, subtype?, usage?}}
//   {emit: {...}}                 one raw stdout line
//   {sleep: ms}  {hang: true}  {exit: code, stderr?: "..."}
// A reply that ends without result, hang or exit gets a result with its text. message_start
// goes out before the first text, thinking, tool or result of each reply. With
// --replay-user-messages, the message a reply answers is replayed first, as Claude Code does.
// Roles the script leaves out: a turn answers "ok", a priming call is accepted (message_start)
// and waits, a compactor call answers a short line.
//
// FAKE_CLAUDE_BOOT: milliseconds it takes to start, before it reads any message (claude's own
// boot is ~1.3 s; dev/latency.ts uses this).
//
// Its init event lists each server --mcp-config names as connected, without dialling it. For one
// of type "ws" (E8):
//   FAKE_CLAUDE_NO_WS=1          the config is rejected: it exits 1 as it starts, before reading
//                                stdin or any init, saying "Error: Invalid MCP configuration:" on
//                                stderr, as Claude Code does with a config its schema refuses
//   FAKE_CLAUDE_WS_STATUS=s      init lists it with status s (e.g. failed, pending), or leaves it
//                                out with s = absent, as a claude that skips an unknown type does
//
// It exits when stdin closes, also while it hangs or waits, and on SIGTERM.
import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CAPTION } from "../src/prompts.ts";

const Usage = Schema.Struct({
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
});
const Action = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ synthetic: Schema.String }),
  Schema.Struct({ thinking: Schema.Number }),
  Schema.Struct({ thought: Schema.String, streamed: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ tool: Schema.Struct({ input: Schema.Json, name: Schema.String }), pace: Schema.optional(Schema.Number) }),
  Schema.Struct({ mcp: Schema.Struct({ input: Schema.Json, name: Schema.String }), pace: Schema.optional(Schema.Number) }),
  Schema.Struct({ run: Schema.Struct({ input: Schema.Json, name: Schema.String }) }),
  Schema.Struct({ toolResult: Schema.String, is_error: Schema.optional(Schema.Json) }),
  Schema.Struct({ waitInput: Schema.Literal(true) }),
  Schema.Struct({ take: Schema.Literal(true) }),
  Schema.Struct({ gate: Schema.String }),
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
  caption: Schema.optional(Schema.Array(Call)),
  compact: Schema.optional(Schema.Array(Call)),
  prime: Schema.optional(Schema.Array(Call)),
  subagent: Schema.optional(Schema.Union([Schema.Array(Call), Schema.Record(Schema.String, Call)])),
  turn: Schema.optional(Schema.Union([Schema.Array(Call), Schema.Record(Schema.String, Call)])),
});
const Input = Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.Json) })) }));
const McpConfig = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ type: Schema.optional(Schema.String), url: Schema.optional(Schema.String) }))) }),
);
const McpAnswer = Schema.Struct({
  result: Schema.optional(Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String })), isError: Schema.optional(Schema.Boolean) })),
});

type Role = "caption" | "compact" | "prime" | "subagent" | "turn";
type Json = Schema.Json;
type LogRecord =
  | { readonly type: "start"; readonly role: Role; readonly call: number; readonly argv: readonly string[]; readonly cwd: string; readonly env: Json }
  | { readonly type: "in"; readonly content: Json }
  | { readonly type: "exit"; readonly code: number };

const argv = process.argv.slice(2);
// `claude --version` (a device's /health, the Devices screen): answered at once and never logged,
// so it isn't counted as a call of any role
if (argv.includes("--version")) {
  writeSync(1, "0.0.0 (Claude Code)\n");
  process.exit(0);
}
const { env } = process;
const system = argv[argv.indexOf("--system-prompt") + 1] ?? "";
const role: Role = system === CAPTION
  ? "caption"
  : env.DISABLE_PROMPT_CACHING === "1" && !argv.includes("--replay-user-messages")
    ? "compact"
    : env.DISABLE_PROMPT_CACHING === "1"
      ? "prime"
      : argv.includes("--allowedTools") || (env.OPTCHAT_SUBAGENT ?? "") !== ""
        ? "subagent"
        : "turn";
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
// what runs without asking: everything under bypassPermissions; else the tools that need no
// permission, and those --allowedTools names
const FREE = new Set(["Read", "Glob", "Grep", "TodoWrite"]);
const allowed = new Set((flag("--allowedTools") ?? "").split(",").filter((t) => t !== ""));
const permitted = (tool: string) => flag("--permission-mode") === "bypassPermissions" || FREE.has(tool) || allowed.has(tool);
const model = flag("--model") ?? "fake";
const replaying = argv.includes("--replay-user-messages");

const logPath = env.FAKE_CLAUDE_LOG;
const record = (r: LogRecord) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), ...r })}\n`);
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
  caption: [{ text: "a picture from the fake claude" }],
  compact: [{ text: "talk: a short summary line" }],
  prime: [{ emit: messageStart({ cache_creation_input_tokens: 100, input_tokens: 3 }) }, { hang: true }],
  subagent: [{ text: "done: nothing to report" }],
  turn: [{ text: "ok" }],
} satisfies Record<Role, Reply>;

const script = env.FAKE_CLAUDE_SCRIPT ? Schema.decodeUnknownSync(Schema.fromJsonString(Script))(readFileSync(env.FAKE_CLAUDE_SCRIPT, "utf8")) : {};
const callIndex = earlier();
// the environment it was given that tests look at; a subagent's name only when it has one
type Shown = { CLAUDE_CODE_PROMPT_CACHE_TTL: string | null; DISABLE_PROMPT_CACHING: string | null; OPTCHAT_SUBAGENT?: string };
const shown: Shown = { CLAUDE_CODE_PROMPT_CACHE_TTL: env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null, DISABLE_PROMPT_CACHING: env.DISABLE_PROMPT_CACHING ?? null };
if (env.OPTCHAT_SUBAGENT !== undefined) shown.OPTCHAT_SUBAGENT = env.OPTCHAT_SUBAGENT;
record({ argv, call: callIndex, cwd: process.cwd(), env: shown, role, type: "start" });

const servers = Object.entries(Schema.decodeUnknownSync(McpConfig)(flag("--mcp-config") ?? "{}").mcpServers ?? {});
const mcpUrl = servers.find(([name]) => name === "optchat")?.[1].url?.replace(/^ws/, "http");
const overWs = servers.filter(([, c]) => c.type === "ws").map(([name]) => name);

const isReply = Schema.is(Reply);
const repliesOf = (call: typeof Call.Type): readonly Reply[] => (isReply(call) ? [call] : call);
const scripted = script[role] ?? [];
// by name: a subagent's picked once the opening says who this is; a turn's by the first key its
// opening's last text block (the new message, after the view) contains, else the key "*"
const ByName = Schema.Record(Schema.String, Call);
const byName = !Array.isArray(scripted) && Schema.is(ByName)(scripted) ? scripted : null;
const isCalls = Schema.is(Schema.Array(Call));
const calls: readonly (typeof Call.Type)[] = isCalls(scripted) ? scripted : [];
let replies: readonly Reply[] = repliesOf(calls[Math.min(callIndex, calls.length - 1)] ?? DEFAULTS[role]);
const nameIn = (content: Json) => /You are the subagent \\?"([^"\\]+)\\?"/.exec(JSON.stringify(content))?.[1];
const decodeBlocks = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })));
const keyIn = (content: Json, keys: readonly string[]) => {
  const blocks = decodeBlocks(content);
  const said = blocks._tag === "Some" ? (blocks.value.at(-1)?.text ?? "") : "";
  return keys.find((key) => key !== "*" && said.includes(key)) ?? "*";
};
const replyFor = (k: number): Reply => replies[Math.min(k, replies.length - 1)] ?? DEFAULTS[role];

const quit = (code: number) => {
  record({ code, type: "exit" });
  process.exit(code);
};
process.on("SIGTERM", () => {
  quit(143);
});

if (env.FAKE_CLAUDE_NO_WS === "1" && overWs.length > 0) {
  writeSync(2, `Error: Invalid MCP configuration:\n${overWs.map((name) => `mcpServers.${name}: Does not adhere to MCP server configuration schema`).join("\n")}\n`);
  quit(1);
}

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

// one tools/call of the MCP server optchat, over HTTP, as claude would make it
const callMcp = async (name: string, args: Json): Promise<{ readonly text: string; readonly error: boolean }> => {
  if (mcpUrl === undefined) return { error: true, text: "no MCP server optchat" };
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } });
  const res = await fetch(mcpUrl, { body, headers: { "content-type": "application/json" }, method: "POST" });
  const answer = Schema.decodeUnknownSync(McpAnswer)(await res.json());
  const text = (answer.result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n");
  return { error: answer.result?.isError === true || !res.ok, text: res.ok ? text : `HTTP ${res.status}` };
};

// A tool run for real (`run`), as Claude Code would run it here: Bash through sh in this cwd,
// Write to a file. Its result, as the tool_result's content and error flag.
const RunInput = Schema.Struct({ command: Schema.optional(Schema.String), content: Schema.optional(Schema.String), file_path: Schema.optional(Schema.String) });
type Ran = { readonly content: string; readonly is_error: boolean };
const runTool = (name: string, input: Json): Ran => {
  const i = Schema.decodeUnknownSync(RunInput)(input);
  if (name === "Bash") {
    const r = spawnSync("sh", ["-c", i.command ?? ""], { encoding: "utf8" });
    return { content: `${r.stdout}${r.stderr}`.trim() || `(exit ${r.status ?? "?"})`, is_error: r.status !== 0 };
  }
  if (name === "Write") {
    const path = resolve(i.file_path ?? "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, i.content ?? "");
    return { content: `File created successfully at: ${path}`, is_error: false };
  }
  return { content: `the fake can't run ${name}`, is_error: true };
};

// the last tool call was refused for want of a permission: the refusal is its result
let refused = false;

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
    } else if ("synthetic" in a) {
      emit({ message: { content: [{ text: a.synthetic, type: "text" }], model: "<synthetic>", role: "assistant" }, type: "assistant" });
    } else if ("thinking" in a) {
      start();
      emit({ event: { delta: { estimated_tokens: a.thinking, thinking: "", type: "thinking_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" });
      emit({ message: { content: [{ signature: "sig", thinking: "", type: "thinking" }], model, role: "assistant" }, type: "assistant" });
    } else if ("thought" in a) {
      start();
      if (a.streamed !== false)
        for (const piece of a.thought.match(/[\s\S]{1,24}/gu) ?? [])
          emit({ event: { delta: { thinking: piece, type: "thinking_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" });
      emit({ message: { content: [{ signature: "sig", thinking: a.thought, type: "thinking" }], model, role: "assistant" }, type: "assistant" });
    } else if ("tool" in a || "mcp" in a) {
      start();
      const name = "tool" in a ? a.tool.name : `mcp__optchat__${a.mcp.name}`;
      const input = "tool" in a ? a.tool.input : a.mcp.input;
      emit({ event: { content_block: { id: "toolu_1", input: {}, name, type: "tool_use" }, index: 0, type: "content_block_start" }, type: "stream_event" });
      // its input as Claude Code streams it with --include-partial-messages: input_json_delta
      // pieces, `pace` ms apart when the script says, then the block's stop
      for (const piece of JSON.stringify(input).match(/[\s\S]{1,64}/gu) ?? []) {
        if (a.pace !== undefined) await Bun.sleep(a.pace);
        emit({ event: { delta: { partial_json: piece, type: "input_json_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" });
      }
      emit({ event: { index: 0, type: "content_block_stop" }, type: "stream_event" });
      emit({ message: { content: [{ id: "toolu_1", input, name, type: "tool_use" }], model, role: "assistant" }, type: "assistant" });
      refused = !permitted(name);
      if (refused) {
        const said = `Claude requested permissions to use ${name}, but you haven't granted it yet.`;
        emit({ message: { content: [{ content: said, is_error: true, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" }, type: "user" });
      } else if ("mcp" in a) {
        const answer = await callMcp(a.mcp.name, input);
        emit({ message: { content: [{ content: answer.text, is_error: answer.error, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" }, type: "user" });
      }
    } else if ("run" in a) {
      start();
      const { input, name } = a.run;
      emit({ event: { content_block: { id: "toolu_1", input: {}, name, type: "tool_use" }, index: 0, type: "content_block_start" }, type: "stream_event" });
      emit({ message: { content: [{ id: "toolu_1", input, name, type: "tool_use" }], model, role: "assistant" }, type: "assistant" });
      const result = permitted(name) ? runTool(name, input) : { content: `Claude requested permissions to use ${name}, but you haven't granted it yet.`, is_error: true };
      emit({ message: { content: [{ ...result, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" }, type: "user" });
    } else if ("toolResult" in a) {
      if (refused) {
        refused = false; // its refusal answered the call already
        continue;
      }
      const result = { content: a.toolResult, tool_use_id: "toolu_1", type: "tool_result" };
      const block: Json = a.is_error === undefined ? result : { ...result, is_error: a.is_error };
      emit({ message: { content: [block], role: "user" }, type: "user" });
    } else if ("waitInput" in a) {
      await unused();
    } else if ("take" in a) {
      await unused();
      replay(inbox[used++] ?? null);
    } else if ("gate" in a) {
      while (!existsSync(a.gate)) await Bun.sleep(50);
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

if (env.FAKE_CLAUDE_BOOT) await Bun.sleep(Number(env.FAKE_CLAUDE_BOOT)); // messages wait in `inbox`

let initSent = false;
for (let k = 0; ; k++) {
  await unused();
  const content = inbox[used++] ?? null;
  if (k === 0 && byName) {
    const own = byName[role === "turn" ? keyIn(content, Object.keys(byName)) : (nameIn(content) ?? "")];
    replies = own === undefined ? [DEFAULTS[role]] : repliesOf(own);
  }
  if (!initSent) {
    initSent = true;
    const wsStatus = env.FAKE_CLAUDE_WS_STATUS ?? "connected";
    const mcp = servers.flatMap(([name, c]) => (c.type === "ws" ? (wsStatus === "absent" ? [] : [{ name, status: wsStatus }]) : [{ name, status: "connected" }]));
    emit({ mcp_servers: mcp, model, subtype: "init", tools: [], type: "system" });
  }
  if (replaying) replay(content);
  if (!(await play(replyFor(k))))
    await new Promise<never>(() => {
      // hangs: stdin's close or a signal ends the process
    });
}
