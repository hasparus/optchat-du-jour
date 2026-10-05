// The device runner and RemoteRunner (SPEC "Multi-machine"): a turn's round trip, the folder
// boundary, children that outlive their socket, and an offline device. A fake claude, no model.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, type Scope } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Trust } from "../device/auth.ts";
import { deviceLayer } from "../device/runner.ts";
import { deviceHealth, remoteRunner } from "../src/claude/remote.ts";

const ECHO = new URL("echo-claude.ts", import.meta.url).pathname;
const MAIN = new URL("../device/main.ts", import.meta.url).pathname;

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(`${tmpdir()}/od-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

export const freePort = () => {
  const s = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
  const port = s.port ?? 0;
  void s.stop(true);
  return port;
};

const loopback: Trust = { loopback: true, nodes: [], whois: () => Effect.succeed(Option.none()) };

// a device runner on 127.0.0.1 for the length of `body`
const withDevice = <A, E>(folders: readonly string[], body: (url: string) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const port = freePort();
        yield* Layer.build(deviceLayer({ claude: ECHO, folders, host: "127.0.0.1", killGrace: "300 millis", name: "macbook", port, trust: loopback }));
        return yield* body(`http://127.0.0.1:${port}`);
      }),
    ),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return false;
};
const pidOf = (text: string | undefined) => Number(/pid=(\d+)/.exec(text ?? "")?.[1]);

const say = (text: string) => [{ text, type: "text" as const }];

test("a message goes to claude on the device and its events come back; /health says what runs there", async () => {
  const folder = tmp();
  await withDevice([folder], (url) =>
    Effect.gen(function* () {
      const claude = yield* remoteRunner("macbook", url).spawn({ args: ["-p"], cwd: folder, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" } });
      yield* claude.send(say("hello"));
      const result = yield* claude.result;
      expect(result.result).toStartWith(`echo: hello pid=`);
      expect(result.result).toEndWith(`cwd=${folder}`);
      expect(claude.model()).toBe("echo");

      const health = yield* deviceHealth(url, "2 seconds");
      expect(Option.getOrThrow(health)).toEqual({ claudeVersion: "0.0.0 (Claude Code)", device: "macbook", folders: [folder] });
    }),
  );
});

test("a cwd outside the folders is refused, through .. and through a symlink too", async () => {
  const folder = tmp(), outside = tmp();
  mkdirSync(`${folder}/repo`);
  symlinkSync(outside, `${folder}/escape`);
  await withDevice([folder], (url) =>
    Effect.gen(function* () {
      const runner = remoteRunner("macbook", url);
      const refused = (cwd: string, env = {}) => Effect.scoped(runner.spawn({ args: [], cwd, env })).pipe(Effect.flip);
      for (const cwd of [outside, `${folder}/repo/../..`, `${folder}/escape`, "relative"]) {
        const e = yield* refused(cwd);
        expect(e._tag).toBe("DeviceOffline");
        expect(e.message).toStartWith("macbook: refused:");
      }
      expect((yield* refused(folder, { LD_PRELOAD: "/tmp/x.so" })).message).toContain("LD_PRELOAD is not passed");
      const inside = yield* Effect.scoped(
        Effect.gen(function* () {
          const claude = yield* runner.spawn({ args: [], cwd: `${folder}/repo/../repo`, env: {} });
          yield* claude.send(say("hi"));
          return (yield* claude.result).result;
        }),
      );
      expect(inside).toEndWith(`cwd=${folder}/repo`);
    }),
  );
});

test("closing the scope kills claude on the device, also one that ignores SIGTERM", async () => {
  const folder = tmp();
  const pid = await withDevice([folder], (url) =>
    Effect.gen(function* () {
      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const claude = yield* remoteRunner("macbook", url).spawn({ args: [], cwd: folder, env: {} });
          yield* claude.send(say("stubborn"));
          return pidOf((yield* claude.result).result);
        }),
      );
      expect(alive(pid)).toBe(true); // SIGTERM is ignored; SIGKILL follows after the grace
      expect(yield* Effect.promise(() => gone(pid))).toBe(true);
      return pid;
    }),
  );
  expect(alive(pid)).toBe(false);
});

test("no device runner: DeviceOffline at once", async () => {
  const t0 = Date.now();
  const e = await Effect.runPromise(
    Effect.scoped(remoteRunner("macbook", `http://127.0.0.1:${freePort()}`).spawn({ args: [], env: {} })).pipe(Effect.flip),
  );
  expect(e._tag).toBe("DeviceOffline");
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(Option.isNone(await Effect.runPromise(deviceHealth(`http://127.0.0.1:${freePort()}`, "1 second")))).toBe(true);
});

test("the daemon's SIGTERM kills the claude it runs", async () => {
  const folder = tmp(), port = freePort();
  const config = `${tmp()}/optchat.config.ts`;
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      allowedLogins: [],
      cache: { apiKeyTtls: [], claudeCodeTtl: "1h", primeTtl: "1h" },
      compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
      defaultDevice: "macbook",
      devices: { macbook: { folders: [folder], url: `http://127.0.0.1:${port}` } },
      master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    })};\n`,
  );
  const daemon = Bun.spawn([MAIN], {
    env: { ...Bun.env, OPTCHAT_CLAUDE: ECHO, OPTCHAT_CONFIG: config, OPTCHAT_DEVICE: "macbook", OPTCHAT_DEVICE_HOST: "127.0.0.1", OPTCHAT_DEVICE_TRUST: "loopback" },
    stderr: "pipe",
    stdout: "pipe",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let k = 0; k < 100 && Option.isNone(await Effect.runPromise(deviceHealth(url, "1 second"))); k++) await Bun.sleep(50);
    const pid = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const claude = yield* remoteRunner("macbook", url).spawn({ args: [], cwd: folder, env: {} });
          yield* claude.send(say("hi"));
          const child = pidOf((yield* claude.result).result);
          expect(alive(child)).toBe(true);
          daemon.kill("SIGTERM");
          yield* Effect.promise(async () => daemon.exited);
          return child;
        }),
      ),
    );
    expect(await gone(pid, 1000)).toBe(true);
  } finally {
    daemon.kill("SIGKILL");
  }
});
