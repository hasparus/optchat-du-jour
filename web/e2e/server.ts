#!/usr/bin/env bun
// optchat-server for the end-to-end tests: the real server on its own data dir, serving the built
// web/dist, with test/fake-claude.ts as `claude` and test/fake-openai.ts as the ChatGPT plan, signed
// in to in a secrets store of its own (no model, no key, no network). The master's chain is Claude
// Opus, then GPT-6.1 Sol on the plan, to pick between. Every Claude turn runs a tool, then streams
// its reply slowly enough for a second page to watch it and for a cancel to land; every plan turn
// answers SOL_REPLY. e2e/fixture.ts starts one per test:
//   E2E_PORT  the port; unset or 0, the server picks a free one itself, just before it binds. Either
//             way it writes the port to $E2E_HOME/port once it is listening, so the file means this
//             server holds the port (e2e/fixture.ts reads it, and starts again on another port when
//             the bind found it taken). The port can't be left to the OS (`port: 0`): the
//             Host guard, the MCP URL of the local claude and the device routes all need it up front.
//   E2E_HOME  the data dir (a restart keeps it); a fresh one when unset
//   E2E_QUICK_SUMMARIES=1  summaries without a `claude` call each, for a test that seeds a long log
//   E2E_SPENT=1  every Claude turn ends on a usage limit
//   E2E_TOOL_ERROR=1  every Claude turn's tool fails: Claude Code's is_error on its result (E28)
//   E2E_PATTERNS=1  every Claude turn plans (TodoWrite), searches the web and fetches a page before
//             its reply, as Claude Code logs them (e2e/replies.ts PLAN, SEARCH_RESULT)
//   E2E_THINKING=1  every Claude turn thinks (THOUGHT, streamed slowly) before its tool call
//   E2E_EDITS=1  every Claude turn edits a file (EDIT_INPUT, its input streamed slowly) and writes
//             one (WRITE_INPUT) before its reply, as Claude Code logs them (E45)
//   E2E_SUBAGENTS=1  every Claude turn spawns two subagents (SPEC M7a): "notes", which reads and
//             reports NOTES_REPORT, then "scout", which waits for a message from its card, reads
//             and reports SCOUT_REPORT (e2e/replies.ts), when the message says "with subagents";
//             every other turn (a report wakes the master) answers as a plain turn does
//   E2E_ISOLATED=1  a Claude turn whose message says "on a branch" spawns "fixer" isolated in a demo
//             git repository of its own (a temporary one, not the data dir), which commits a file in
//             its worktree and reports FIXER_REPORT; its branch is merged back, and the report wakes
//             the master, whose turn (any other message) answers WOKEN
//   E2E_MEMORY=1  the view's marks are tiny (400 / 200 bytes; the compaction view's 200 / 100), so a few
//             messages merge it into summaries, and every compactor call takes MEMORY_WAIT before it
//             answers MEMORY_SUMMARY, so a page can watch a line wait for its summary (E46, E47)
//   E2E_ARTIFACTS=ui  a Claude turn publishes LANDING, its input streamed slowly, unless its
//             message says "long weekend": that one edits it (LANDING_EDIT). =hostile: every turn
//             publishes hostile(E2E_STUN_PORT, E2E_TCP_PORT), whose WebRTC aims at that UDP port and whose
//             preconnect hints at that TCP one (SPEC "Artifacts")
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import type { Summarize } from "../../src/compactor.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { serverLayer } from "../../server/app.ts";
import { parseSettings } from "../../src/config.ts";
import { login } from "../../src/openai/auth.ts";
import { memorySecrets } from "../../src/secrets.ts";
import { fakeOpenAi } from "../../test/fake-openai.ts";
import { freePort } from "../../test/ports.ts";
import {
  ARTIFACT,
  EDITED,
  FETCHED,
  FIXER_REPORT,
  FIXER_TASK,
  hostile as hostilePage,
  LANDING,
  LANDING_EDIT,
  MEMORY_SUMMARY,
  MEMORY_WAIT,
  NOTES_REPORT,
  NOTES_TASK,
  PLAN_DONE,
  PLAN_START,
  PUBLISHED,
  SCOUT_REPORT,
  SCOUT_TASK,
  SEARCH_RESULT,
  SOL_REPLY,
  SPAWNED,
  SPAWNED_ISOLATED,
  THOUGHT,
  TOOL_ERROR,
  WOKEN,
  EDIT_INPUT,
  WRITE_INPUT,
} from "./replies.ts";

const root = new URL("../..", import.meta.url).pathname;
const home = Bun.env.E2E_HOME ?? mkdtempSync(`${tmpdir()}/oc-e2e-`); // short: socket paths stop at ~107 characters

const delta = (text: string) => ({ emit: { event: { delta: { text, type: "text_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" } });
const words = ["Streamed ", "reply ", "from ", "the ", "fake ", "claude."];
const reply = [
  { tool: { input: { command: "ls" }, name: "Bash" } },
  Bun.env.E2E_TOOL_ERROR ? { is_error: true, toolResult: TOOL_ERROR } : { toolResult: "notes.md\nrepo" },
  ...words.flatMap((w) => [delta(w), { sleep: 600 }]),
  { emit: { message: { content: [{ text: words.join(""), type: "text" }], role: "assistant" }, type: "assistant" } },
  { result: { text: words.join("") } },
];
const todos = { result: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress." };
const patterns = [
  { tool: { input: PLAN_START, name: "TodoWrite" } },
  { toolResult: todos.result },
  { sleep: 1500 },
  { tool: { input: { query: "fake claude streaming" }, name: "WebSearch" } },
  { toolResult: SEARCH_RESULT },
  { tool: { input: { prompt: "What does it say about streaming?", url: FETCHED }, name: "WebFetch" } },
  { toolResult: "The page says replies stream token by token." },
  { tool: { input: PLAN_DONE, name: "TodoWrite" } },
  { toolResult: todos.result },
  ...words.flatMap((w) => [delta(w), { sleep: 300 }]),
  { emit: { message: { content: [{ text: words.join(""), type: "text" }], role: "assistant" }, type: "assistant" } },
  { result: { text: words.join("") } },
];
const spent = [{ result: { is_error: true, text: "Claude AI usage limit reached" } }];
// a thought streamed a few words at a time, then its whole block, as Claude Code sends one
const thinkingDelta = (thinking: string) => ({ emit: { event: { delta: { thinking, type: "thinking_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" } });
const thoughtWords = THOUGHT.match(/\S+\s*/g) ?? [];
const thinks = [
  ...thoughtWords.flatMap((w) => [thinkingDelta(w), { sleep: 150 }]),
  { emit: { message: { content: [{ signature: "sig", thinking: THOUGHT, type: "thinking" }], role: "assistant" }, type: "assistant" } },
  ...reply,
];
// spawned one after the other, so their cards list in that order; each one's script is by its name
const spawns = [
  { mcp: { input: { model: "claude-code:opus@low", name: "notes", task: NOTES_TASK }, name: "spawn" } },
  { sleep: 1500 },
  { mcp: { input: { name: "scout", task: SCOUT_TASK }, name: "spawn" } },
  { text: SPAWNED },
];
const notes = [{ tool: { input: { pattern: "trip", path: home }, name: "Grep" } }, { toolResult: "notes/oct.md:4: trip dates" }, { text: NOTES_REPORT }];
const scout = [{ take: true }, { tool: { input: { file_path: `${home}/notes/oct.md` }, name: "Read" } }, { toolResult: "trip: Oct 3 to Oct 9" }, { sleep: 500 }, { text: SCOUT_REPORT }];
// E2E_ISOLATED: a demo repository outside the data dir (which is a git repository itself), and
// where its worktrees go, both temporary
const demo = Bun.env.E2E_ISOLATED ? mkdtempSync(`${tmpdir()}/oc-e2e-repo-`) : null;
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { cwd: dir });
if (demo !== null) {
  mkdirSync(`${demo}/repo`);
  git(`${demo}/repo`, "init", "-q", "-b", "main");
  writeFileSync(`${demo}/repo/CHANGELOG.md`, "# Changelog\n");
  git(`${demo}/repo`, "add", "-A");
  git(`${demo}/repo`, "commit", "-q", "-m", "start");
}
const isolated = [{ mcp: { input: { folder: `${demo}/repo`, isolate: true, name: "fixer", task: FIXER_TASK }, name: "spawn" } }, { text: SPAWNED_ISOLATED }];
const fixer = [
  { sleep: 3000 },
  { run: { input: { command: "printf -- '- a demo entry\\n' >> CHANGELOG.md && git -c user.name=Demo -c user.email=demo@example.com commit -qam 'changelog: a demo entry'" }, name: "Bash" } },
  { text: FIXER_REPORT },
];
// an edit whose input streams in 64-character pieces 300 ms apart, then a new file
const fileEdits = [
  { pace: 300, tool: { input: EDIT_INPUT, name: "Edit" } },
  { toolResult: `The file ${EDIT_INPUT.file_path} has been updated.` },
  { tool: { input: WRITE_INPUT, name: "Write" } },
  { toolResult: `File created successfully at: ${WRITE_INPUT.file_path}` },
  ...words.flatMap((w) => [delta(w), { sleep: 100 }]),
  { emit: { message: { content: [{ text: words.join(""), type: "text" }], role: "assistant" }, type: "assistant" } },
  { result: { text: words.join("") } },
];
const turn = Bun.env.E2E_SPENT ? spent : Bun.env.E2E_PATTERNS ? patterns : Bun.env.E2E_THINKING ? thinks : Bun.env.E2E_EDITS ? fileEdits : reply;
// the artifacts. turns: a publish streamed in 64-character pieces 300 ms apart (about 5 s), an edit
const publishes = [{ mcp: { input: { name: ARTIFACT, html: LANDING }, name: "publish_artifact" }, pace: 300 }, { text: PUBLISHED }];
const edits = [{ mcp: { input: LANDING_EDIT, name: "edit_artifact" } }, { text: EDITED }];
const hostile = [{ mcp: { input: { name: "hostile", html: hostilePage(Number(Bun.env.E2E_STUN_PORT ?? 9), Number(Bun.env.E2E_TCP_PORT ?? 9)) }, name: "publish_artifact" } }, { text: PUBLISHED }];
// by a word of the message: a warm process starts ahead of its turn, so not by the order they start
// (a report that wakes the master says none of these words, so it gets "*")
const turnsOf = () => {
  if (Bun.env.E2E_SUBAGENTS) return { "*": [reply], "with subagents": [spawns] };
  if (demo !== null) return { "*": [[{ text: WOKEN }]], "on a branch": [isolated] };
  if (Bun.env.E2E_ARTIFACTS === "ui") return { "*": [publishes], "long weekend": [edits] };
  return Bun.env.E2E_ARTIFACTS === "hostile" ? [[hostile]] : [[turn]];
};
const turns = turnsOf();
const compact = Bun.env.E2E_MEMORY ? { compact: [[{ sleep: MEMORY_WAIT }, { text: MEMORY_SUMMARY }]] } : {};
writeFileSync(`${home}/script.json`, JSON.stringify({ ...compact, subagent: { fixer: [fixer], notes: [notes], scout: [scout] }, turn: turns }));
writeFileSync(`${home}/fake.jsonl`, "");
Object.assign(process.env, {
  FAKE_CLAUDE_LOG: `${home}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${home}/script.json`,
  OPTCHAT_CLAUDE: `${root}test/fake-claude.ts`,
});

// the ChatGPT plan: a fake one, signed in to as `optchat login openai` does
const plan = fakeOpenAi();
plan.state.script = Array.from({ length: 200 }, () => ({ text: SOL_REPLY }));
const endpoints = { agentName: "optchat-e2e", api: `${plan.base}/v1`, issuer: plan.base, port: freePort(), registerClientId: "dynamic_agent_client" };
const secrets = memorySecrets();
await Effect.runPromise(login({ endpoints, open: (url) => Effect.promise(async () => void (await fetch(url))) }).pipe(Effect.provide([secrets, FetchHttpClient.layer])));

const settings = parseSettings({
  openai: endpoints,
  allowedLogins: [],
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { macbook: { folders: ["~/repos"], url: "http://optchat-macbook:7710" }, mini: { folders: demo === null ? [home] : [home, demo], url: "http://optchat-mini:7710" } },
  master: { chain: ["claude-code:opus", "openai-plan:gpt-6.1-sol"], effort: "high", permissionMode: "bypassPermissions" },
  subagents: { worktrees: `${demo ?? home}-worktrees` },
});

// written whole (a rename), and only when `serverLayer` has bound its port: a layer provided with
// it is built after it
const announce = (port: number) =>
  Layer.effectDiscard(
    Effect.sync(() => {
      writeFileSync(`${home}/port.tmp`, String(port));
      renameSync(`${home}/port.tmp`, `${home}/port`);
    }),
  );

BunRuntime.runMain(
  Effect.gen(function* () {
    const port = Number(Bun.env.E2E_PORT ?? 0) || freePort(); // as late as possible: the bind is next
    yield* Effect.logInfo(`e2e optchat-server on http://127.0.0.1:${port}, home ${home}`);
    const summarize: Summarize | undefined = Bun.env.E2E_QUICK_SUMMARIES ? (job) => Effect.succeed(`summary of ${job.l}:${job.i}`) : undefined;
    const marks = Bun.env.E2E_MEMORY ? { compaction: { high: 200, low: 100 }, view: { high: 400, low: 200 } } : undefined;
    const serve = serverLayer({ device: "mini", home, host: "127.0.0.1", marks, port, secrets, settings, summarize, web: `${root}web/dist` });
    return yield* Layer.launch(announce(port).pipe(Layer.provide(serve)));
  }),
);
