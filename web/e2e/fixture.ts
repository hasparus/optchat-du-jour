// One real optchat-server per test (e2e/server.ts), each on its own data dir and port, so no test
// leans on what another one logged. A test can seed the log before the server starts, and restart
// the server with more logged while it was down (a phone that slept through it).
import { MessagesPage } from "@wire";
import { type Locator, type Page, expect, test as base } from "@playwright/test";
import { Schema } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export { ARTIFACT, EDITED, EDITED_HEADING, LANDING, LANDING_HEADING, MEMORY_SUMMARY, OUTSIDE, PUBLISHED } from "./replies.ts";
export { EDIT_INPUT, WRITE_INPUT } from "./replies.ts";
export { FETCHED, FIXER_REPORT, FIXER_TASK, NOTES_REPORT, NOTES_TASK, PLAN_DONE, PLAN_START, REPLY, SCOUT_REPORT, SCOUT_TASK, SEARCH_LINKS, SOL_REPLY, SPAWNED, SPAWNED_ISOLATED, THOUGHT, TOOL_ERROR, WOKEN } from "./replies.ts";

type LogEntry = MessagesPage["entries"][number];
const decodePage = Schema.decodeUnknownSync(MessagesPage);
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, pid: Schema.Number, role: Schema.optional(Schema.String), content: Schema.optional(Schema.Json) })),
);

export type Server = {
  readonly url: string;
  // every user message the fake claude read, by the role of the call that read it (test/fake-claude.ts)
  readonly fakeInputs: (role: string) => unknown[];
  // the log as the server holds it
  readonly log: () => Promise<LogEntry[]>;
  // stop the server, log `more` user messages behind its back, start it again on the same port
  readonly restart: (more: number) => Promise<void>;
};

const web = fileURLToPath(new URL("..", import.meta.url));

// user messages m<i> appended to the log, as store.ts writes it: one file of lines per day
const seed = (home: string, from: number, count: number) => {
  const dir = `${home}/streams/mini/chat/main`;
  mkdirSync(dir, { recursive: true });
  let lines = "";
  for (let i = from; i < from + count; i++) lines += `${JSON.stringify({ date: "2026-01-01T10:00:00.000Z", i, kind: "user", text: `m${i}` })}\n`;
  appendFileSync(`${dir}/2026-01-01.jsonl`, lines);
};

// The server ended before it answered, with what it said on both streams (its logger writes to
// stdout, Bun's bind error comes there).
class Exited extends Error {
  readonly taken: boolean;
  constructor(code: number, said: string) {
    super(`the e2e server exited with ${code}: ${said.trim() || "(nothing on stdout or stderr)"}`);
    this.taken = /EADDRINUSE|address already in use|port \d+ in use/i.test(said);
  }
}

// The port the server chose (it writes it to $E2E_HOME/port when it starts), then until it answers.
async function waitUp(home: string, child: ChildProcess, said: () => string) {
  for (let tries = 0; tries < 300; tries++) {
    if (child.exitCode !== null) throw new Exited(child.exitCode, said());
    if (existsSync(`${home}/port`)) {
      const port = Number(readFileSync(`${home}/port`, "utf8"));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`);
        if (res.ok) return port;
      } catch {
        // not listening yet
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`the e2e server didn't start: ${said().trim() || "(nothing on stdout or stderr)"}`);
}

// SIGKILL, as a crash or a power cut would: a server with a page still connected takes ~20 s to
// end on SIGTERM, and the store's lock and fsynced log are made to survive this anyway
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  child.kill("SIGKILL");
  await exited;
}

type Options = {
  readonly seeded: number;
  readonly spent: boolean;
  readonly toolError: boolean;
  readonly patterns: boolean;
  readonly thinking: boolean;
  readonly edits: boolean;
  readonly subagents: boolean;
  readonly isolated: boolean;
  readonly artifacts: "" | "ui" | "hostile";
  readonly memory: boolean;
};

async function startServer({ artifacts, edits, isolated, memory, patterns, seeded, spent, subagents, thinking, toolError }: Options, listeners: Pick<Listeners, "tcp" | "udp">): Promise<Server & { readonly stop: () => Promise<void> }> {
  const home = mkdtempSync(`${tmpdir()}/oc-e2e-`); // short: socket paths stop at ~107 characters
  let port = 0; // the server picks it on the first start; a restart asks for the one the page knows
  let total = seeded;
  if (seeded > 0) seed(home, 0, seeded);
  const launch = async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_HOME: home, E2E_PORT: String(port) };
    if (seeded > 0) env.E2E_QUICK_SUMMARIES = "1";
    if (spent) env.E2E_SPENT = "1";
    if (toolError) env.E2E_TOOL_ERROR = "1";
    if (patterns) env.E2E_PATTERNS = "1";
    if (thinking) env.E2E_THINKING = "1";
    if (edits) env.E2E_EDITS = "1";
    if (subagents) env.E2E_SUBAGENTS = "1";
    if (isolated) env.E2E_ISOLATED = "1";
    if (artifacts !== "") env.E2E_ARTIFACTS = artifacts;
    if (memory) env.E2E_MEMORY = "1";
    env.E2E_STUN_PORT = String(listeners.udp);
    env.E2E_TCP_PORT = String(listeners.tcp);
    const child = spawn("bun", ["e2e/server.ts"], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        said += chunk.toString();
      });
    }
    try {
      port = await waitUp(home, child, () => said);
    } catch (error) {
      await stop(child);
      throw error;
    }
    return child;
  };
  // The port is picked in the server (e2e/server.ts), a moment before it binds it, but another
  // worker's server can still take it in between: the bind then fails with "port in use", and the
  // first start goes again on a new one.
  const first = async () => {
    for (let attempt = 1; ; attempt++) {
      rmSync(`${home}/port`, { force: true });
      try {
        return await launch();
      } catch (error) {
        if (!(error instanceof Exited && error.taken) || attempt === 5) throw error;
      }
    }
  };
  let child = await first();
  const url = `http://127.0.0.1:${port}`;
  return {
    fakeInputs: (role) => {
      const records = readFileSync(`${home}/fake.jsonl`, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeRecord(line));
      const pids = new Set(records.filter((r) => r.type === "start" && r.role === role).map((r) => r.pid));
      return records.filter((r) => r.type === "in" && pids.has(r.pid)).map((r) => r.content);
    },
    log: async () => {
      const res = await fetch(`${url}/api/messages?limit=100000`);
      return [...decodePage(await res.json()).entries];
    },
    restart: async (more) => {
      await stop(child);
      seed(home, total, more);
      total += more;
      child = await launch();
    },
    stop: async () => stop(child),
    url,
  };
}

// What a hostile artifact (E2E_ARTIFACTS=hostile) would reach if it got out, on 127.0.0.1: a UDP
// listener for its WebRTC's STUN requests, and a TCP one for its preconnect hints. `datagrams` and
// `connections` count what arrived.
export type Listeners = { readonly udp: number; readonly tcp: number; readonly datagrams: () => number; readonly connections: () => number };

export const test = base.extend<Options & { server: Server; listeners: Listeners }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern, and this one has none
  listeners: async ({}, provide) => {
    const socket = createSocket("udp4");
    let datagrams = 0;
    socket.on("message", () => {
      datagrams++;
    });
    await new Promise<void>((resolve) => {
      socket.bind(0, "127.0.0.1", resolve);
    });
    let connections = 0;
    const tcp = createServer((connection) => {
      connections++;
      connection.destroy();
    });
    await new Promise<void>((resolve) => {
      tcp.listen(0, "127.0.0.1", resolve);
    });
    const { port: tcpPort } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(tcp.address());
    await provide({ connections: () => connections, datagrams: () => datagrams, tcp: tcpPort, udp: socket.address().port });
    socket.close();
    tcp.close();
  },
  seeded: [0, { option: true }], // user messages in the log before the server starts
  spent: [false, { option: true }], // every Claude turn ends on a usage limit
  toolError: [false, { option: true }], // every Claude turn's tool call fails (TOOL_ERROR)
  patterns: [false, { option: true }], // every Claude turn plans, searches and fetches (E2E_PATTERNS)
  thinking: [false, { option: true }], // every Claude turn thinks before its tool call (E2E_THINKING)
  edits: [false, { option: true }], // every Claude turn edits a file and writes one (E2E_EDITS)
  subagents: [false, { option: true }], // every Claude turn spawns two subagents (E2E_SUBAGENTS)
  isolated: [false, { option: true }], // the first Claude turn spawns an isolated subagent (E2E_ISOLATED)
  artifacts: ["", { option: true }], // the turns publish and edit artifacts (E2E_ARTIFACTS)
  memory: [false, { option: true }], // tiny view marks and a slow compactor (E2E_MEMORY)
  server: async ({ artifacts, edits, isolated, memory, seeded, spent, toolError, patterns, thinking, subagents, listeners }, provide) => {
    const server = await startServer({ artifacts, edits, isolated, memory, patterns, seeded, spent, subagents, thinking, toolError }, listeners);
    await provide(server);
    await server.stop();
  },
  baseURL: async ({ server }, provide) => {
    await provide(server.url);
  },
});
export { expect } from "@playwright/test";

export async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
}

// how far above the floating dock's top edge an element's bottom is (negative: under the dock); a
// row can be "in the viewport" and still sit under the composer, so the e2e checks this instead
export async function clearOfDock(page: Page, element: Locator): Promise<number> {
  const [box, dock] = await Promise.all([element.boundingBox(), page.getByTestId("dock").boundingBox()]);
  return box && dock ? dock.y - (box.y + box.height) : Number.NEGATIVE_INFINITY;
}

// a file attached the way a person does it: the composer's +, then the browser's file chooser. These
// tests run with a mouse, where the + opens its one picker itself; on a touch screen it opens the
// Add context sheet (app.test.tsx covers that)
export async function attach(page: Page, file: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add context" }).click();
  const picker = await chooser;
  await picker.setFiles(file);
}

export async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

// A message sent from `page` has had its turn: it is in the log (its bubble shows), then the status
// line goes. The status line alone would race: it is hidden before the server has read the message.
export async function answered(page: Page, text: string) {
  await expect(page.getByTestId("user-message").filter({ hasText: text })).toBeVisible();
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
}

// the chat's rows by log index: a tool entry and the echo answering it are one row (rows.ts)
const rowIndexes = (entries: readonly LogEntry[]) => {
  const out: number[] = [];
  let open = false;
  for (const e of entries) {
    if (e.kind === "echo" && open) {
      open = false;
      continue;
    }
    out.push(e.i);
    if (e.kind === "tool" || e.kind === "echo") open = e.kind === "tool";
  }
  return out;
};

// the page shows the log as the server holds it: a row per entry at its index, and (unless only
// the indexes are checked) user messages in their own bubble with exactly their text, replies
// with all of theirs
export async function expectShowsLog(page: Page, server: Server, check: "texts" | "indexes" = "texts") {
  const entries = await server.log();
  const shown = async () => page.locator("[data-log-index]").evaluateAll((rows) => rows.map((r) => (r instanceof HTMLElement ? Number(r.dataset.logIndex) : -1)));
  await expect.poll(shown).toEqual(rowIndexes(entries));
  if (check === "indexes") return;
  for (const e of entries) {
    const row = page.locator(`[data-log-index="${e.i}"]`);
    if (e.kind === "user") await expect(row.getByTestId("user-message")).toHaveText(e.text);
    if (e.kind === "talk") await expect(row).toContainText(e.text);
  }
}
