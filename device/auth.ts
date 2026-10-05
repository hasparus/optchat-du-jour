// Machine auth for the device runner (SPEC "Tailscale, auth and operations", E9). No tokens: the
// runner listens on its tailnet address only, and asks Tailscale's local WhoIs which node is
// calling. A caller is let in when that node's full MagicDNS name is in `names`: ./main.ts gives
// the server's device's only (its URL's host plus this tailnet's suffix), the runner's one
// legitimate caller (SPEC "Multi-machine"). A browser on an allowed machine is that
// machine's node too, so routes also refuse any request that carries an Origin (./runner.ts).
// `loopback` lets in callers on this machine only and never asks Tailscale: tests and development.
import { Clock, Duration, Effect, Option, Schema, Semaphore } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isIP } from "node:net";
import { ConfigError } from "../src/config.ts";
import { LOOPBACK } from "../src/http.ts";

// the calling node's MagicDNS name, e.g. "optchat-mini.tail1234.ts.net."; None when Tailscale doesn't know the address
export type WhoIs = (address: string) => Effect.Effect<Option.Option<string>>;

export type Trust =
  | { readonly _tag: "loopback" }
  | { readonly _tag: "tailnet"; readonly whois: WhoIs; readonly names: readonly string[] }; // full names, as `fullName` gives

// "Optchat-Mini.tail1234.ts.net." and "optchat-mini.tail1234.ts.net" are one node
export const fullName = (name: string) => name.toLowerCase().replace(/\.$/, "");

export const trusted = (trust: Trust, remote: Option.Option<string>): Effect.Effect<boolean> => {
  if (Option.isNone(remote)) return Effect.succeed(false);
  if (trust._tag === "loopback") return Effect.succeed(LOOPBACK.has(remote.value));
  const { names, whois } = trust;
  return whois(remote.value).pipe(Effect.map(Option.exists((name) => names.includes(fullName(name)))));
};

// The full MagicDNS names of the devices at `urls`, in the tailnet whose suffix is `suffix`
// ("tail1234.ts.net"): a short host gets the suffix, a dotted one is taken as written. An IP address
// can't be matched to a WhoIs answer, so it is a configuration error.
export const callerNames = (urls: readonly string[], suffix: string) =>
  Effect.forEach(urls, (url) => {
    const host = new URL(url).hostname.replaceAll(/^\[|\]$/g, "");
    if (isIP(host) !== 0)
      return Effect.fail(new ConfigError({ message: `${url}: the device runner knows callers by name, so a device URL needs its MagicDNS name, not an IP address` }));
    return Effect.succeed(host.includes(".") ? fullName(host) : `${fullName(host)}.${fullName(suffix)}`);
  });

// One WhoIs per peer address every `ttl`, and at most `concurrency` at once: a burst of requests,
// or someone knocking on the port, doesn't fork a `tailscale` process per request.
export const cachedWhois = (whois: WhoIs, o: { readonly ttl: Duration.Input; readonly concurrency: number }) =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(o.concurrency);
    const ttl = Duration.toMillis(Duration.fromInputUnsafe(o.ttl));
    const seen = new Map<string, { readonly until: number; readonly name: Effect.Effect<Option.Option<string>> }>();
    const cached: WhoIs = (address) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const hit = seen.get(address);
        if (hit && hit.until > now) return yield* hit.name;
        for (const [key, entry] of seen) if (entry.until <= now) seen.delete(key);
        const name = yield* Effect.cached(permits.withPermit(whois(address)));
        seen.set(address, { name, until: now + ttl });
        return yield* name;
      });
    return cached;
  });

const WhoIsReply = Schema.Struct({ Node: Schema.Struct({ Name: Schema.String }) });
const decodeWhoIs = Schema.decodeUnknownOption(Schema.fromJsonString(WhoIsReply));

const run = (binary: string, args: readonly string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(binary, [...args], { stdin: "ignore" }))).pipe(
    Effect.timeout("5 seconds"),
  );

// `tailscale whois --json <ip>` through the local tailscaled; any failure is "unknown caller"
export const tailscaleWhois = (binary: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const whois: WhoIs = (address) =>
      run(binary, ["whois", "--json", address]).pipe(
        Effect.map((out) => Option.map(decodeWhoIs(out), (r) => r.Node.Name)),
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    return whois;
  });

// this machine's tailnet IPv4 address, the only one the runner listens on
export const tailnetAddress = (binary: string) =>
  run(binary, ["ip", "-4"]).pipe(
    Effect.map((out) => out.trim().split("\n")[0] ?? ""),
    Effect.option,
    Effect.map(Option.filter((ip) => ip !== "")),
  );

const Status = Schema.Struct({
  MagicDNSSuffix: Schema.optional(Schema.String),
  Self: Schema.optional(Schema.Struct({ DNSName: Schema.optional(Schema.String) })),
});
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Status));

// this tailnet's MagicDNS suffix, e.g. "tail1234.ts.net", from `tailscale status --json`
export const tailnetSuffix = (binary: string) =>
  run(binary, ["status", "--json"]).pipe(
    Effect.option,
    Effect.map((out) =>
      Option.flatMap(Option.flatMap(out, decodeStatus), (s) => {
        const own = s.Self?.DNSName === undefined ? undefined : fullName(s.Self.DNSName).split(".").slice(1).join(".");
        return Option.fromNullishOr([s.MagicDNSSuffix, own].find((x) => x !== undefined && x !== ""));
      }),
    ),
  );
