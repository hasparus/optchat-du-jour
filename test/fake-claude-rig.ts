// The fake `claude` for tests (./fake-claude.ts): a Runner that starts it with a script and a log
// of its own, what it logged, and the checks every file that uses it shares (withFakeClaude).
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema, type Scope } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Block } from "../src/claude/events.ts";
import { LocalRunner, Runner } from "../src/claude/process.ts";

const FAKE_BIN = `${import.meta.dir}/fake-claude.ts`;

const dirs: string[] = [];
export const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-`); // short: socket paths stop at ~107 characters
  dirs.push(d);
  return d;
};


// what the fake writes to its log (see its header)
const SentBlock = Schema.Struct({
  cache_control: Schema.optional(Schema.Struct({ ttl: Schema.optional(Schema.Literals(["1h", "5m"])), type: Schema.Literal("ephemeral") })),
  text: Schema.String,
  type: Schema.Literal("text"),
});
const Rec = Schema.Struct({
  argv: Schema.optional(Schema.Array(Schema.String)),
  call: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.Number),
  content: Schema.optional(Schema.Array(SentBlock)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  pid: Schema.Number,
  t: Schema.Number,
  role: Schema.optional(Schema.Literals(["compact", "prime", "turn"])),
  type: Schema.Literals(["start", "in", "exit"]),
});
type Rec = typeof Rec.Type;
const decodeRec = Schema.decodeUnknownSync(Schema.fromJsonString(Rec));

const fakes: { log: string }[] = [];
export const records = (log: string): Rec[] => {
  if (!existsSync(log)) return [];
  const text = readFileSync(log, "utf8");
  return text.split("\n").flatMap((line) => (line === "" ? [] : [decodeRec(line)]));
};

// a process is running: it exists, and it is not a zombie (/proc/PID/stat, state after the name)
export const alive = (pid: number) => {
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return false;
  try {
    return readFileSync(stat, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false; // gone between the two calls
  }
};


export type Script = { turn?: unknown[]; prime?: unknown[]; compact?: unknown[] };

// a fake with its script, and a Runner that starts it with that script and its own log
export function scripted(script: Script = {}, extraEnv: Record<string, string> = {}) {
  const dir = tmp();
  const f = { log: `${dir}/fake.jsonl`, script: `${dir}/plan.json` };
  writeFileSync(f.script, JSON.stringify(script));
  fakes.push(f);
  const layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const base = yield* Runner;
      return {
        // the variables optchat sets are passed even when empty, so this shell's own can't leak in
        spawn: (o: Parameters<typeof base.spawn>[0]) =>
          base.spawn({ ...o, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "", DISABLE_PROMPT_CACHING: "", ...o.env, ...extraEnv, FAKE_CLAUDE_LOG: f.log, FAKE_CLAUDE_SCRIPT: f.script } }),
        warm: () => Effect.void,
      };
    }),
  ).pipe(Layer.provide(LocalRunner), Layer.provide(BunServices.layer));
  const of = (role: "compact" | "prime" | "turn") => {
    const all = records(f.log);
    return all
      .filter((r) => r.type === "start" && r.role === role)
      .map((s) => {
        const ins = all.filter((r) => r.type === "in" && r.pid === s.pid);
        return { ...s, asked: ins[0]?.t, ins: ins.map((r) => r.content ?? []) };
      });
  };
  return { ...f, layer, of };
}

export const run = async <A, E>(f: { layer: Layer.Layer<Runner> }, effect: Effect.Effect<A, E, Runner | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(f.layer)));

// polls a condition on the real clock
export const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

export const textOf = (b: Block | undefined) => (b?.type === "text" ? b.text : "");
export const long = (n: number) => "w".repeat(n);

// For a test file: each test that could spawn `claude` spawns the fake, and between tests a stray
// spawn runs /bin/false; every fake a test started has exited when it ends (one still running is
// killed and fails the test); the scratch directories go at the end.
export const withFakeClaude = () => {
  beforeEach(() => {
    Bun.env.OPTCHAT_CLAUDE = FAKE_BIN;
  });
  afterEach(async () => {
    Bun.env.OPTCHAT_CLAUDE = "/bin/false";
    const pids = fakes.splice(0).flatMap((f) => records(f.log).filter((r) => r.type === "start").map((r) => r.pid));
    const deadline = Date.now() + 3000;
    while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(10);
    const left = pids.filter(alive);
    for (const pid of left) process.kill(pid, "SIGKILL");
    expect(left).toEqual([]);
  });
  afterAll(() => {
    for (const d of dirs) rmSync(d, { force: true, recursive: true });
  });
};
