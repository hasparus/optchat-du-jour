#!/usr/bin/env bun
// optchat-server for the end-to-end tests: the real server on its own data dir, serving the built
// web/dist, with test/fake-claude.ts as `claude` and an empty secrets store (no model, no key, no network). Every turn runs a tool,
// then streams its reply slowly enough for a second page to watch it and for a cancel to land.
// e2e/fixture.ts starts one per test:
//   E2E_PORT  the port
//   E2E_HOME  the data dir (a restart keeps it); a fresh one when unset
//   E2E_QUICK_SUMMARIES=1  summaries without a `claude` call each, for a test that seeds a long log
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import type { Summarize } from "../../src/compactor.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { serverLayer } from "../../server/app.ts";
import { parseSettings } from "../../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../../src/openai/endpoints.ts";
import { memorySecrets } from "../../src/secrets.ts";

const root = new URL("../..", import.meta.url).pathname;
const home = Bun.env.E2E_HOME ?? mkdtempSync(`${tmpdir()}/oc-e2e-`); // short: socket paths stop at ~107 characters
const port = Number(Bun.env.E2E_PORT ?? 7791);

const delta = (text: string) => ({ emit: { event: { delta: { text, type: "text_delta" }, index: 0, type: "content_block_delta" }, type: "stream_event" } });
const words = ["Streamed ", "reply ", "from ", "the ", "fake ", "claude."];
const reply = [
  { tool: { input: { command: "ls" }, name: "Bash" } },
  { toolResult: "notes.md\nrepo" },
  ...words.flatMap((w) => [delta(w), { sleep: 600 }]),
  { emit: { message: { content: [{ text: words.join(""), type: "text" }], role: "assistant" }, type: "assistant" } },
  { result: { text: words.join("") } },
];
writeFileSync(`${home}/script.json`, JSON.stringify({ turn: [[reply]] }));
writeFileSync(`${home}/fake.jsonl`, "");
Object.assign(process.env, {
  FAKE_CLAUDE_LOG: `${home}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${home}/script.json`,
  OPTCHAT_CLAUDE: `${root}test/fake-claude.ts`,
});

const settings = parseSettings({
  openai: DEFAULT_ENDPOINTS,
  allowedLogins: [],
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { macbook: { folders: ["~/repos"], url: "http://optchat-macbook:7710" }, mini: { folders: [home], url: "http://optchat-mini:7710" } },
  master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
});

BunRuntime.runMain(
  Effect.gen(function* () {
    yield* Effect.logInfo(`e2e optchat-server on http://127.0.0.1:${port}, home ${home}`);
    const summarize: Summarize | undefined = Bun.env.E2E_QUICK_SUMMARIES ? (job) => Effect.succeed(`summary of ${job.l}:${job.i}`) : undefined;
    return yield* Layer.launch(serverLayer({ device: "mini", home, host: "127.0.0.1", port, secrets: memorySecrets(), settings, summarize, web: `${root}web/dist` }));
  }),
);
