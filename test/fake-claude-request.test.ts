// What the cache replay assumes Claude Code sends (test/fake-claude-request.ts, C1-C3), pinned:
// when a real-account check says otherwise, this is the test to change with it.
import { expect, test } from "bun:test";
import { baseArgs } from "../src/claude/args.ts";
import { MASTER_TOOLS } from "../src/config.ts";
import { compactSpawn } from "../src/summarize/claude-code.ts";
import { masterArgs } from "../src/turn/claude-code.ts";
import { messagesRequest } from "./fake-cache.ts";
import { claudeBody, type Message, procOf, roleOf } from "./fake-claude-request.ts";

const turn = masterArgs({ effort: "high", instructions: "SYSTEM", mcpConfig: "{}", model: "opus", permissionMode: "bypassPermissions", tools: MASTER_TOOLS });
const text = (t: string, mark?: "1h"): Message["content"][number] => (mark === undefined ? { text: t, type: "text" } : { cache_control: { ttl: mark, type: "ephemeral" }, text: t, type: "text" });
const convo = (n: number): Message[] => Array.from({ length: n }, (_, k) => ({ content: [text(`a${k}`), text(`b${k}`)], role: k % 2 === 0 ? "user" : "assistant" }));
// each block's mark, in prompt order: tools, system, messages
const marks = (p: Parameters<typeof claudeBody>[0], c: readonly Message[]) => {
  const body = claudeBody(p, c);
  return [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap((m) => m.content)].map((b) => JSON.stringify(b.cache_control ?? null));
};

test("a turn: Claude Code marks both system blocks and the last block of the last two messages, all 4 slots, at its TTL", () => {
  const p = procOf(turn, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
  expect(p.role).toBe("turn");
  const one = marks(p, convo(1)).filter((m) => m !== "null");
  expect(one).toEqual(Array.from({ length: 3 }, () => '{"ttl":"1h","type":"ephemeral"}'));
  const three = marks(p, convo(3));
  expect(three.filter((m) => m !== "null")).toHaveLength(4);
  // tools unmarked; the system blocks; then of six message blocks the 4th and the 6th
  expect(three.slice(-8).map((m) => m !== "null")).toEqual([true, true, false, false, false, true, false, true]);
  expect(() => messagesRequest(claudeBody(p, convo(3)))).not.toThrow();
  // with the variable unset, Claude Code's own 1-hour default (C2); 5m when it says so
  expect(procOf(turn, {}).ttl).toBe("1h");
  expect(procOf(turn, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }).ttl).toBe("5m");
});

test("priming and a compaction: DISABLE_PROMPT_CACHING=1 leaves only the marks we send", () => {
  const prime = procOf(turn, { DISABLE_PROMPT_CACHING: "1" });
  expect(prime.role).toBe("prime");
  const ours: Message[] = [{ content: [text("view", "1h"), text("end", "1h"), text("ok")], role: "user" }];
  expect(marks(prime, ours).filter((m) => m !== "null")).toEqual(['{"ttl":"1h","type":"ephemeral"}', '{"ttl":"1h","type":"ephemeral"}']);
  const compact = compactSpawn({ effort: "xhigh", instructions: "SYSTEM", model: "haiku", tools: MASTER_TOOLS, ttl: "1h" }, { cwd: undefined, mcpConfig: "{}", mcpSeen: () => { throw new Error("unused"); }, runner: { spawn: () => { throw new Error("unused"); }, warm: () => { throw new Error("unused"); } } });
  expect(roleOf(compact.args, compact.env)).toBe("compact");
  expect(procOf(compact.args, compact.env).model).toBe("claude-haiku-5-5");
});

test("the roles the fake claude tells apart", () => {
  expect(roleOf(baseArgs({ model: "haiku", system: "x", tools: "" }), {})).toBe("turn");
  expect(roleOf(turn, { OPTCHAT_SUBAGENT: "scout" })).toBe("subagent");
  expect(roleOf([...turn, "--allowedTools", "Bash"], {})).toBe("subagent");
});
