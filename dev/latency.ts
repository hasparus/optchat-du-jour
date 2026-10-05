#!/usr/bin/env bun
// Turn latency (SPEC "Turn and priming", E17, E18): N short turns over /ws, a pause between them
// so the session goes idle (priming, warm processes), and per turn the time from send to
// RUN_STARTED, to the first assistant text and to RUN_FINISHED, and whether it waited for a
// priming (a "priming" phase between send and RUN_STARTED, which servers before E17 show).
//
//   bun dev/latency.ts --fake                                    the fake claude, ~claude's timings
//   bun dev/latency.ts --config path/optchat.config.ts [--root <checkout>]   real claude, fresh home
//   bun dev/latency.ts --url ws://127.0.0.1:7700/ws              a server that is already running
//
// --turns N (3), --pause ms (8000; 3000 with --fake), --text "...". With --config or --fake it
// starts the server (from --root, default this checkout) in a fresh temp home and stops it at the end.
import { Effect, Option } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { type Inbound, parseInbound } from "../cli/repl.ts";
import { loadSettings } from "../src/config.ts";
import { freePort } from "../test/ports.ts"; // a dev tool on the tests' helpers, as with their fake claude

const HERE = `${import.meta.dir}/..`;

// the fake's timings, close to claude 2.1.289 with Sonnet: ~1.3 s to boot, ~1.2 s to the first token
const FAKE_BOOT = 1300, FAKE_TTFT = 1200;
const fakeScript = {
  prime: [[{ sleep: FAKE_TTFT }, { emit: { event: { message: { model: "fake", usage: { input_tokens: 3 } }, type: "message_start" }, type: "stream_event" } }, { hang: true }]],
  turn: [[{ sleep: FAKE_TTFT }, { text: "hi there" }, { sleep: 300 }]],
};

type Turn = { readonly started: number; readonly text: number; readonly finished: number; readonly waited: boolean; readonly error: string | null };

const median = (xs: readonly number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? Number.NaN : s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

// the session's phase, when an event says it
const phase = (e: Inbound) =>
  e.type === "STATE_SNAPSHOT" ? e.snapshot.phase : e.type === "STATE_DELTA" ? e.delta.find((d) => d.path === "/phase")?.value : undefined;

// one client on /ws for every turn, as a page left open would be
async function measure(url: string, o: { readonly turns: number; readonly pause: number; readonly text: string }) {
  const events: { readonly at: number; readonly e: Inbound }[] = [];
  const ws = new WebSocket(url);
  ws.addEventListener("message", (m) => {
    for (const e of Option.toArray(parseInbound(String(m.data)))) events.push({ at: performance.now(), e });
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const until = async (from: number, done: (e: Inbound) => boolean, ms = 120_000) => {
    const end = performance.now() + ms;
    for (;;) {
      const hit = events.slice(from).find((x) => done(x.e));
      if (hit) return hit.at;
      if (performance.now() > end) throw new Error("timed out");
      await Bun.sleep(5);
    }
  };

  const turns: Turn[] = [];
  for (let k = 0; k < o.turns; k++) {
    await Bun.sleep(o.pause); // idle: the view settles, priming and warm processes get ready
    const from = events.length;
    const sent = performance.now();
    ws.send(JSON.stringify({ messages: [{ content: o.text, id: crypto.randomUUID(), role: "user" }], runId: crypto.randomUUID(), threadId: "latency" }));
    const started = await until(from, (e) => e.type === "RUN_STARTED");
    const end = await until(from, (e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
    const window = events.slice(from).filter((x) => x.at <= end);
    const text = window.find((x) => x.e.type === "TEXT_MESSAGE_START" && x.e.role === "assistant")?.at ?? Number.NaN;
    const failed = window.find((x) => x.e.type === "RUN_ERROR")?.e;
    turns.push({
      error: failed?.type === "RUN_ERROR" ? failed.message : null,
      finished: end - sent,
      started: started - sent,
      text: text - sent,
      waited: window.some((x) => x.at <= started && phase(x.e) === "priming"),
    });
    // idle again before the next pause starts
    await until(from, (e) => phase(e) === "idle");
  }
  ws.close();
  return turns;
}

const say = (line: string) => process.stdout.write(`${line}\n`);
const ms = (n: number) => (Number.isNaN(n) ? "—" : `${Math.round(n)}`.padStart(6));
function print(turns: readonly Turn[]) {
  say("turn  →RUN_STARTED  →first text  →RUN_FINISHED  waited for priming");
  for (const [k, t] of turns.entries())
    say(`${String(k + 1).padStart(4)}  ${ms(t.started)} ms    ${ms(t.text)} ms   ${ms(t.finished)} ms     ${t.waited ? "yes" : "no"}${t.error ? `  (${t.error})` : ""}`);
  say(`  md  ${ms(median(turns.map((t) => t.started)))} ms    ${ms(median(turns.map((t) => t.text)))} ms   ${ms(median(turns.map((t) => t.finished)))} ms`);
}

// a server from `root` on `port`, in a fresh home; its PID is ours to stop
async function startServer(o: { readonly root: string; readonly config: string; readonly port: number; readonly env: Record<string, string> }) {
  const home = mkdtempSync(`${tmpdir()}/odj-latency-`);
  const server = Bun.spawn(["bun", `${o.root}/server/main.ts`], {
    env: { ...Bun.env, ...o.env, OPTCHAT_CONFIG: o.config, OPTCHAT_HOME: home },
    stderr: "ignore",
    stdout: "ignore",
  });
  const base = `http://127.0.0.1:${o.port}`;
  for (let k = 0; ; k++) {
    const up = await fetch(`${base}/api/state`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (k > 200 || server.exitCode !== null) throw new Error(`the server did not start (pid ${server.pid})`);
    await Bun.sleep(50);
  }
  const stop = async () => {
    server.kill("SIGTERM");
    await server.exited;
    rmSync(home, { force: true, recursive: true });
  };
  return { stop, url: `ws://127.0.0.1:${o.port}/ws` };
}

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    fake: { type: "boolean" },
    pause: { type: "string" },
    root: { type: "string" },
    text: { type: "string" },
    turns: { type: "string" },
    url: { type: "string" },
  },
});
const turns = Number(values.turns ?? 3);
const pause = Number(values.pause ?? (values.fake ? 3000 : 8000));
const text = values.text ?? "Say hi in two words.";
const root = values.root ?? HERE;

if (values.url) print(await measure(values.url, { pause, text, turns }));
else if (values.fake) {
  const dir = mkdtempSync(`${tmpdir()}/odj-latency-fake-`);
  const port = freePort();
  mkdirSync(`${dir}/work`);
  const settings = {
    allowedLogins: [],
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: ["claude-code:haiku"], from: 0 }], effort: "low" },
    defaultDevice: "mini",
    devices: { mini: { folders: [`${dir}/work`], url: "http://127.0.0.1:1" } },
    master: { chain: ["claude-code:sonnet"], effort: "low", permissionMode: "bypassPermissions" },
    server: { host: "127.0.0.1", port },
  };
  writeFileSync(`${dir}/optchat.config.ts`, `export default ${JSON.stringify(settings)};\n`);
  writeFileSync(`${dir}/plan.json`, JSON.stringify(fakeScript));
  const env = { FAKE_CLAUDE_BOOT: String(FAKE_BOOT), FAKE_CLAUDE_SCRIPT: `${dir}/plan.json`, OPTCHAT_CLAUDE: `${HERE}/test/fake-claude.ts` };
  const server = await startServer({ config: `${dir}/optchat.config.ts`, env, port, root });
  try {
    print(await measure(server.url, { pause, text, turns }));
  } finally {
    await server.stop();
    rmSync(dir, { force: true, recursive: true });
  }
} else if (values.config) {
  const config = values.config.startsWith("/") ? values.config : `${process.cwd()}/${values.config}`;
  const settings = await Effect.runPromise(loadSettings(config));
  const server = await startServer({ config, env: {}, port: settings.server?.port ?? 7700, root });
  try {
    print(await measure(server.url, { pause, text, turns }));
  } finally {
    await server.stop();
  }
} else {
  process.stderr.write("one of --fake, --config <path> or --url <ws url>\n");
  process.exit(2);
}
