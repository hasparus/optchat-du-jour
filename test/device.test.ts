// The device runner and RemoteRunner (SPEC "Multi-machine"): a turn's round trip, machine auth,
// the folder boundary, how claude ended, children that outlive their socket, an offline device and
// a connection lost mid-turn. A fake claude, no model.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, type Scope } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Trust, type WhoIs, cachedWhois, callerNames, trusted } from "../device/auth.ts";
import { deviceLayer } from "../device/runner.ts";
import { deviceHealth, remoteRunner } from "../src/claude/remote.ts";
import { type FromDevice, type ToDevice, decodeFromDevice, frame } from "../src/claude/wire.ts";
import { failover } from "../src/engines/chain.ts";
import { MASTER_TOOLS } from "../src/config.ts";
import { claudeCodeTurn } from "../src/turn/claude-code.ts";
import { freePort } from "./ports.ts";

const ECHO = new URL("echo-claude.ts", import.meta.url).pathname;
// the daemon as people start it: `optchat device NAME`
const CLI = new URL("../cli/optchat.ts", import.meta.url).pathname;

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(`${tmpdir()}/od-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const loopback: Trust = { _tag: "loopback" };
const SUFFIX = "tail1234.ts.net";
// a WhoIs that knows a fixed set of addresses
const whoisOf =
  (nodes: Record<string, string>): WhoIs =>
  (address) =>
    Effect.succeed(Option.fromUndefinedOr(nodes[address]));

// a device runner on 127.0.0.1 for the length of `body`
const withDevice = async <A, E>(
  folders: readonly string[],
  body: (url: string) => Effect.Effect<A, E, Scope.Scope>,
  o: { readonly trust?: Trust; readonly port?: number } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const port = o.port ?? freePort();
        const trust = o.trust ?? loopback;
        yield* Layer.build(deviceLayer({ claude: ECHO, folders, host: "127.0.0.1", killGrace: "300 millis", name: "macbook", port, trust }));
        return yield* body(`http://127.0.0.1:${port}`);
      }),
    ),
  );

// one raw WebSocket conversation with a device runner: `first`, then each of `stdin` as it goes,
// and every frame back until the runner closes the socket
const converse = async (url: string, first: ToDevice, stdin: readonly string[]) => {
  const ws = new WebSocket(`${url.replace("http", "ws")}/spawn`);
  const frames: FromDevice[] = [];
  const closed = Promise.withResolvers<null>();
  ws.addEventListener("message", (m) => {
    frames.push(...Option.toArray(decodeFromDevice(String(m.data))));
  });
  ws.addEventListener("close", () => {
    closed.resolve(null);
  });
  ws.addEventListener("open", () => {
    ws.send(frame(first));
    for (const line of stdin) ws.send(frame({ _tag: "Stdin", line }));
  });
  await closed.promise;
  return frames;
};
// the status of a plain GET
const statusOf = async (url: string, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { headers });
  return response.status;
};
const healthTag = async (url: string) => {
  const health = await Effect.runPromise(deviceHealth(url, "1 second"));
  return health._tag;
};
const admits = async (trust: Trust, address?: string) => Effect.runPromise(trusted(trust, Option.fromUndefinedOr(address)));

const userLine = (text: string) => `${JSON.stringify({ message: { content: [{ text, type: "text" }], role: "user" }, type: "user" })}\n`;

// a WebSocket server that plays a device runner badly: `onFrame` answers each frame it gets
const withFakeDevice = async <A, E>(
  onFrame: (ws: Bun.ServerWebSocket, frame: string) => void,
  body: (url: string) => Effect.Effect<A, E, Scope.Scope>,
) => {
  const server = Bun.serve({
    fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      message: (ws, m) => {
        onFrame(ws, String(m));
      },
    },
  });
  try {
    return await Effect.runPromise(Effect.scoped(body(`http://127.0.0.1:${server.port}`)));
  } finally {
    void server.stop(true);
  }
};

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
      expect(health).toEqual({ _tag: "online", health: { claudeVersion: "0.0.0 (Claude Code)", device: "macbook", folders: [folder] } });
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
      expect(yield* Effect.promise(async () => gone(pid))).toBe(true);
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
  expect(await Effect.runPromise(deviceHealth(`http://127.0.0.1:${freePort()}`, "1 second"))).toEqual({ _tag: "offline" });
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
  const daemon = Bun.spawn([CLI, "device", "macbook"], {
    env: { ...Bun.env, OPTCHAT_CLAUDE: ECHO, OPTCHAT_CONFIG: config, OPTCHAT_DEVICE_HOST: "127.0.0.1", OPTCHAT_DEVICE_TRUST: "loopback" },
    stderr: "pipe",
    stdout: "pipe",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let k = 0; k < 100 && (await healthTag(url)) !== "online"; k++) await Bun.sleep(50);
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

// ---------------------------------------------------------------------------------------------
// machine auth

test("loopback trust lets in this machine only; tailnet trust wants a configured node's full name", async () => {
  expect(await admits(loopback, "127.0.0.1")).toBe(true);
  expect(await admits(loopback, "::1")).toBe(true);
  expect(await admits(loopback, "100.64.0.2")).toBe(false);
  expect(await admits(loopback)).toBe(false);

  const names = await Effect.runPromise(callerNames(["http://optchat-mini:7710", "http://Optchat-MacBook.tail1234.ts.net:7710"], SUFFIX));
  expect(names).toEqual(["optchat-mini.tail1234.ts.net", "optchat-macbook.tail1234.ts.net"]);
  const tailnet: Trust = {
    _tag: "tailnet",
    names,
    whois: whoisOf({
      "100.64.0.1": "Optchat-Mini.tail1234.ts.net.",
      "100.64.0.2": "optchat-mini.elsewhere.ts.net.", // the same first label in another tailnet
      "100.64.0.3": "optchat-mini.tail1234.ts.net.evil.", // a name that only starts like it
    }),
  };
  expect(await admits(tailnet, "100.64.0.1")).toBe(true);
  expect(await admits(tailnet, "100.64.0.2")).toBe(false);
  expect(await admits(tailnet, "100.64.0.3")).toBe(false);
  expect(await admits(tailnet, "100.64.0.9")).toBe(false); // Tailscale doesn't know it
  expect(await admits(tailnet, "127.0.0.1")).toBe(false); // no loopback pass in tailnet mode

  for (const url of ["http://100.64.0.1:7710", "http://[fd7a:115c:a1e0::1]:7710"]) {
    const e = await Effect.runPromise(Effect.flip(callerNames([url], SUFFIX)));
    expect(e.message).toContain("not an IP address");
  }
});

test("WhoIs answers are kept per address for a while, and only so many are asked at once", async () => {
  let calls = 0, running = 0, most = 0;
  const slow: WhoIs = (address) =>
    Effect.gen(function* () {
      calls++;
      most = Math.max(most, ++running);
      yield* Effect.sleep("30 millis");
      running--;
      return Option.some(`${address}.${SUFFIX}.`);
    });
  await Effect.runPromise(
    Effect.gen(function* () {
      const whois = yield* cachedWhois(slow, { concurrency: 2, ttl: "200 millis" });
      yield* Effect.forEach(["a", "a", "b", "a"], whois, { concurrency: "unbounded" });
      expect(calls).toBe(2);
      yield* Effect.forEach(["c", "d", "e", "f", "g", "h"], whois, { concurrency: "unbounded" });
      expect(most).toBe(2);
      expect(calls).toBe(8);
      yield* Effect.sleep("250 millis");
      expect(yield* whois("a")).toEqual(Option.some(`a.${SUFFIX}.`));
      expect(calls).toBe(9); // asked again once the answer is old
    }),
  );
});

test("a request with an Origin is refused before WhoIs, and so is a node that isn't a configured device", async () => {
  const folder = tmp();
  let asked = 0;
  const mini: WhoIs = () => Effect.sync(() => (asked++, Option.some("optchat-mini.tail1234.ts.net.")));
  const allowed: Trust = { _tag: "tailnet", names: ["optchat-mini.tail1234.ts.net"], whois: mini };
  await withDevice(
    [folder],
    (url) =>
      Effect.gen(function* () {
        const get = (path: string, headers: Record<string, string> = {}) => Effect.promise(async () => statusOf(`${url}${path}`, headers));
        // a page open in a browser on the server's own machine: the node is right, the Origin gives it away
        expect(yield* get("/health", { Origin: "https://example.com" })).toBe(403);
        expect(yield* get("/spawn", { Origin: "http://optchat-macbook:7710" })).toBe(403);
        expect(asked).toBe(0);
        expect(yield* get("/spawn")).toBe(400); // let in, but not a WebSocket handshake
        // Bun's WebSocket and fetch send no Origin, so the server's RemoteRunner gets through
        expect((yield* deviceHealth(url, "2 seconds"))._tag).toBe("online");
        const claude = yield* remoteRunner("macbook", url).spawn({ args: [], cwd: folder, env: {} });
        yield* claude.send(say("hi"));
        expect((yield* claude.result).result).toStartWith("echo: hi");
      }),
    { trust: allowed },
  );

  const stranger: Trust = { _tag: "tailnet", names: ["optchat-mini.tail1234.ts.net"], whois: whoisOf({ "127.0.0.1": "laptop.tail1234.ts.net." }) };
  await withDevice(
    [folder],
    (url) =>
      Effect.gen(function* () {
        expect(yield* Effect.promise(async () => statusOf(`${url}/health`))).toBe(403);
        expect(yield* deviceHealth(url, "2 seconds")).toEqual({ _tag: "refused" });
        const e = yield* Effect.flip(Effect.scoped(remoteRunner("macbook", url).spawn({ args: [], cwd: folder, env: {} })));
        expect(e._tag).toBe("DeviceOffline");
      }),
    { trust: stranger },
  );
});

// ---------------------------------------------------------------------------------------------
// how claude ended, and how the connection did

test("the Exit frame says how claude ended: its code, or the signal, with its stderr", async () => {
  const folder = tmp();
  await withDevice([folder], (url) =>
    Effect.gen(function* () {
      const spawn: ToDevice = { _tag: "Spawn", args: [], cwd: folder, env: {} };
      const exited = yield* Effect.promise(async () => converse(url, spawn, [userLine("exit 3")]));
      expect(exited.map((f) => f._tag)).toEqual(["Spawned", "Exit"]);
      expect(exited.at(-1)).toEqual({ _tag: "Exit", code: 3, signal: null, stderr: "bye\n" });

      const killed = yield* Effect.promise(async () => converse(url, spawn, [userLine("die")]));
      expect(killed.at(-1)).toEqual({ _tag: "Exit", code: null, signal: "SIGKILL", stderr: "dying\n" });

      // and RemoteRunner turns them into the same words as a local claude's
      const claude = yield* remoteRunner("macbook", url).spawn({ args: [], cwd: folder, env: {} });
      yield* claude.send(say("exit 3"));
      expect((yield* Effect.flip(claude.result)).message).toBe("claude on macbook exited (code 3): bye");
    }),
  );
});

test("no answer to the spawn request in time: DeviceOffline", async () => {
  const t0 = Date.now();
  let heard = 0;
  const e = await withFakeDevice(
    () => {
      heard++; // takes the Spawn frame and says nothing
    },
    (url) => Effect.flip(remoteRunner("macbook", url, { spawn: "300 millis" }).spawn({ args: [], env: {} })),
  );
  expect(e._tag).toBe("DeviceOffline");
  expect(e.message).toBe("macbook: no answer to the spawn request");
  expect(heard).toBe(1);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("a connection lost mid-turn is a ModelError, so the chain doesn't run the turn again elsewhere", async () => {
  let next = false;
  const failure = await withFakeDevice(
    (ws, f) => {
      if (f.includes('"Spawn"')) ws.send(frame({ _tag: "Spawned", pid: 1 }));
      else ws.terminate(); // the user message arrived: the device vanishes
    },
    (url) =>
      Effect.gen(function* () {
        const engine = yield* claudeCodeTurn({
          effort: "high",
          lead: true,
          logUsage: () => Effect.void,
          model: "opus",
          permissionMode: "bypassPermissions",
          primeTtl: "1h",
          report: () => Effect.void,
          runnerFor: () => Effect.succeed({ cwd: undefined, mcpConfig: "{}", mcpSeen: () => Effect.succeed(false), runner: remoteRunner("macbook", url) }),
          systemFile: "/dev/null",
          tools: MASTER_TOOLS,
          ttl: "1h",
        });
        const input = { device: "macbook", earlier: [], media: [], mid: { next: Effect.never, ready: Effect.succeed([]) }, texts: ["edit it"], view: "<chat>\n</chat>" };
        const out = { info: () => Effect.void, log: () => Effect.void, text: () => Effect.void, thinking: () => Effect.void, took: () => Effect.void, usage: () => Effect.void };
        return yield* failover(
          [
            { ref: "claude-code:opus", run: (from) => engine.run(input, out, from) },
            {
              ref: "next",
              run: () =>
                Effect.sync(() => {
                  next = true;
                }),
            },
          ],
          { moved: () => Effect.void },
        ).pipe(Effect.flip);
      }),
  );
  expect(failure._tag).toBe("ModelError");
  expect(failure.message).toStartWith("lost the connection to macbook");
  expect(next).toBe(false);
});

test("an unreachable device stays offline for a moment, so a turn after its priming fails at once", async () => {
  const folder = tmp(), port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const runner = remoteRunner("macbook", url, { remember: "500 millis" });
  const first = await Effect.runPromise(Effect.flip(Effect.scoped(runner.spawn({ args: [], cwd: folder, env: {} }))));
  expect(first.message).toStartWith("macbook: no device runner");
  await withDevice(
    [folder],
    () =>
      Effect.gen(function* () {
        const again = yield* Effect.flip(Effect.scoped(runner.spawn({ args: [], cwd: folder, env: {} })));
        expect(again).toBe(first); // the verdict it remembered, though the runner is up now
        yield* Effect.sleep("600 millis");
        const claude = yield* runner.spawn({ args: [], cwd: folder, env: {} });
        yield* claude.send(say("back"));
        expect((yield* claude.result).result).toStartWith("echo: back");
      }),
    { port },
  );
});
