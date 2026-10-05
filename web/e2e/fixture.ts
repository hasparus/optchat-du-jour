// One real optchat-server per test (e2e/server.ts), each on its own data dir and port, so no test
// leans on what another one logged. A test can seed the log before the server starts, and restart
// the server with more logged while it was down (a phone that slept through it).
import { MessagesPage } from "@wire";
import { type Page, expect, test as base } from "@playwright/test";
import { Schema } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export { REPLY, SOL_REPLY } from "./replies.ts";

type LogEntry = MessagesPage["entries"][number];
const decodePage = Schema.decodeUnknownSync(MessagesPage);
const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));
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

// A port is picked here, released, and bound a moment later by a server that takes a while to
// boot, and the other workers' servers bind ports of their own meanwhile (each one's fake plan
// binds port 0, and its sign-in callback port is picked and released the same way, in
// e2e/server.ts). So another process can take this port in between, and the server exits with
// EADDRINUSE: that was the "the e2e server exited with 1" at startup. The port can't be handed
// over, so a start that finds it taken is retried on a new one (`startServer`).
const freePort = async () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = decodeAddress(probe.address());
      probe.close(() => {
        resolve(port);
      });
    });
  });

// user messages m<i> appended to the log, as store.ts writes it: one file of lines per day
const seed = (home: string, from: number, count: number) => {
  const dir = `${home}/streams/mini/chat/main`;
  mkdirSync(dir, { recursive: true });
  let lines = "";
  for (let i = from; i < from + count; i++) lines += `${JSON.stringify({ date: "2026-01-01T10:00:00.000Z", i, kind: "user", text: `m${i}` })}\n`;
  appendFileSync(`${dir}/2026-01-01.jsonl`, lines);
};

// the server ended before it answered, with what it said on stderr
class Exited extends Error {
  readonly inUse: boolean;
  constructor(code: number, said: string) {
    super(`the e2e server exited with ${code}: ${said.trim() || "(nothing on stderr)"}`);
    this.inUse = /EADDRINUSE|address already in use|in use/i.test(said);
  }
}

async function waitUp(url: string, child: ChildProcess, said: () => string) {
  for (let tries = 0; tries < 300; tries++) {
    if (child.exitCode !== null) throw new Exited(child.exitCode, said());
    try {
      const res = await fetch(`${url}/api/state`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("the e2e server didn't start");
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

async function startServer(seeded: number, spent: boolean): Promise<Server & { readonly stop: () => Promise<void> }> {
  const home = mkdtempSync(`${tmpdir()}/oc-e2e-`); // short: socket paths stop at ~107 characters
  let port = 0;
  let url = "";
  let total = seeded;
  if (seeded > 0) seed(home, 0, seeded);
  const launch = async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_HOME: home, E2E_PORT: String(port) };
    if (seeded > 0) env.E2E_QUICK_SUMMARIES = "1";
    if (spent) env.E2E_SPENT = "1";
    const child = spawn("bun", ["e2e/server.ts"], { cwd: web, env, stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString();
      process.stderr.write(chunk);
    });
    try {
      await waitUp(url, child, () => said);
    } catch (error) {
      await stop(child);
      throw error;
    }
    return child;
  };
  // the first start looks for a port that stays free; a restart keeps the one the page knows
  const first = async () => {
    for (let attempt = 1; ; attempt++) {
      port = await freePort();
      url = `http://127.0.0.1:${port}`;
      try {
        return await launch();
      } catch (error) {
        if (!(error instanceof Exited && error.inUse) || attempt === 5) throw error;
      }
    }
  };
  let child = await first();
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

export const test = base.extend<{ seeded: number; spent: boolean; server: Server }>({
  seeded: [0, { option: true }], // user messages in the log before the server starts
  spent: [false, { option: true }], // every Claude turn ends on a usage limit
  server: async ({ seeded, spent }, provide) => {
    const server = await startServer(seeded, spent);
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

export async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
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
