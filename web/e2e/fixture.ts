// One real optchat-server per test (e2e/server.ts), each on its own data dir and port, so no test
// leans on what another one logged. A test can seed the log before the server starts, and restart
// the server with more logged while it was down (a phone that slept through it).
import { MessagesPage } from "@wire";
import { type Page, expect, test as base } from "@playwright/test";
import { Schema } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPLY = "Streamed reply from the fake claude.";

type LogEntry = MessagesPage["entries"][number];
const decodePage = Schema.decodeUnknownSync(MessagesPage);
const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

export type Server = {
  readonly url: string;
  // the log as the server holds it
  readonly log: () => Promise<LogEntry[]>;
  // stop the server, log `more` user messages behind its back, start it again on the same port
  readonly restart: (more: number) => Promise<void>;
};

const web = fileURLToPath(new URL("..", import.meta.url));

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

async function waitUp(url: string, child: ChildProcess) {
  for (let tries = 0; tries < 300; tries++) {
    if (child.exitCode !== null) throw new Error(`the e2e server exited with ${child.exitCode}`);
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

async function startServer(seeded: number): Promise<Server & { readonly stop: () => Promise<void> }> {
  const home = mkdtempSync(`${tmpdir()}/oc-e2e-`); // short: socket paths stop at ~107 characters
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let total = seeded;
  if (seeded > 0) seed(home, 0, seeded);
  const launch = async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_HOME: home, E2E_PORT: String(port) };
    if (seeded > 0) env.E2E_QUICK_SUMMARIES = "1";
    const child = spawn("bun", ["e2e/server.ts"], { cwd: web, env, stdio: ["ignore", "ignore", "inherit"] });
    await waitUp(url, child);
    return child;
  };
  let child = await launch();
  return {
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

export const test = base.extend<{ seeded: number; server: Server }>({
  seeded: [0, { option: true }], // user messages in the log before the server starts
  server: async ({ seeded }, provide) => {
    const server = await startServer(seeded);
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
