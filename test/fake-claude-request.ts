// What a `claude -p` process is, as our fakes read it from its argv and environment (`roleOf`),
// and the Messages request Claude Code builds from the stream-json it is sent (`claudeBody`), for
// the cache replay's fake vendor (test/fake-vendors.ts). The request's shape is an assumption,
// from SPEC's citations of the reference's probes (ref D2, D6, §14 F2; SPEC E6, E26, "Priming");
// when a real-account check says otherwise, this file is the one to change, and
// test/fake-claude-request.test.ts pins what it says now:
//   C1  It sends the tools (`--tools`, then the MCP servers' tools), then two system blocks (its
//       own first line, then `--system-prompt`), then the conversation; `--effort` as effort.
//   C2  Its own marks: both system blocks, and the last block of each of the last two messages,
//       all 4 slots (D2), with CLAUDE_CODE_PROMPT_CACHE_TTL's TTL, an hour when it is unset (SPEC
//       E6: "Claude Code's default 1-hour marks" on a subscription). So a 1-hour layout whose
//       variable went missing would look the same here: the variable itself is
//       test/claude.test.ts's and
//       test/claude-compactor.test.ts's to check.
//   C3  With DISABLE_PROMPT_CACHING=1 it places none, and the marks we send on a message's blocks
//       go to the API as they are (D6, priming).
//   C4  Its tools' definitions are the sizes below (stand-ins: the real ones differ per version).
//   C5  A message that arrives while it works joins the conversation after the current tool
//       results (ref §5.2), replayed with --replay-user-messages, as the opening is (the fake
//       vendor plays this one).
import type { Schema } from "effect";
import { TOOLS } from "../src/mcp.ts";
import { CAPTION } from "../src/prompts.ts";
import type { MessagesBody } from "./fake-cache.ts";

type Json = Schema.Json;

// Claude Code's aliases as Anthropic's model ids (SPEC "Haiku and effort": `haiku` is Haiku 5.5)
export const modelOf = (alias: string) => ({ haiku: "claude-haiku-5-5", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" })[alias] ?? alias;

const argOf = (args: readonly string[], flag: string) => {
  const k = args.indexOf(flag);
  return k === -1 ? undefined : args[k + 1];
};

// Which call a `claude` is, the way optchat starts them (test/fake-claude.ts's header): a caption
// by its system prompt, the compactor and priming by DISABLE_PROMPT_CACHING=1 (priming with the
// turn's --replay-user-messages), a subagent by its name or --allowedTools, else a turn
export type ClaudeRole = "caption" | "compact" | "prime" | "subagent" | "turn";
export const roleOf = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ClaudeRole => {
  if (argOf(argv, "--system-prompt") === CAPTION) return "caption";
  if (env.DISABLE_PROMPT_CACHING === "1") return argv.includes("--replay-user-messages") ? "prime" : "compact";
  return argv.includes("--allowedTools") || (env.OPTCHAT_SUBAGENT ?? "") !== "" ? "subagent" : "turn";
};

export type Proc = {
  readonly model: string;
  readonly effort: string | undefined;
  readonly system: string;
  readonly tools: readonly string[];
  readonly ttl: "5m" | "1h";
  readonly ours: boolean; // DISABLE_PROMPT_CACHING=1: only the marks we send (C3)
  readonly role: ClaudeRole;
  readonly replays: boolean;
};
export const procOf = (args: readonly string[], env: Readonly<Record<string, string>>): Proc => ({
  effort: argOf(args, "--effort"),
  model: modelOf(argOf(args, "--model") ?? ""),
  ours: env.DISABLE_PROMPT_CACHING === "1",
  replays: args.includes("--replay-user-messages"),
  role: roleOf(args, env),
  system: argOf(args, "--system-prompt") ?? "",
  tools: (argOf(args, "--tools") ?? "").split(",").filter((t) => t !== ""),
  ttl: env.CLAUDE_CODE_PROMPT_CACHE_TTL === "5m" ? "5m" : "1h", // C2
});

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TOOL_SIZES = new Map([["Bash", 9000], ["Edit", 2000], ["Glob", 800], ["Grep", 2500], ["Read", 2500], ["TodoWrite", 9000], ["WebFetch", 1500], ["WebSearch", 1200], ["Write", 1500]]);
const toolDef = (name: string) => ({ description: `${name}: `.padEnd(TOOL_SIZES.get(name) ?? 1000, "d"), input_schema: { type: "object" }, name });
const mcpTools = TOOLS.map((t) => ({ description: t.description, input_schema: t.inputSchema, name: `mcp__optchat__${t.name}` }));

export type Message = { readonly role: "user" | "assistant"; readonly content: Readonly<Record<string, Json>>[] };

// the Messages request Claude Code sends for the conversation so far (C1-C3)
export const claudeBody = (p: Proc, convo: readonly Message[]): MessagesBody => {
  const mark = p.ours ? undefined : { ttl: p.ttl, type: "ephemeral" as const };
  const marked = (b: Readonly<Record<string, Json>>) => (mark === undefined ? b : { ...b, cache_control: mark });
  return {
    messages: convo.map((m, k) => ({ content: k >= convo.length - 2 ? m.content.map((b, j) => (j === m.content.length - 1 ? marked(b) : b)) : m.content, role: m.role })),
    model: p.model,
    output_config: p.effort === undefined ? undefined : { effort: p.effort },
    system: [marked({ text: IDENTITY, type: "text" }), marked({ text: p.system, type: "text" })],
    tools: [...p.tools.map(toolDef), ...mcpTools],
  };
};
