// Machine auth for the device runner (SPEC "Tailscale, auth and operations", E9): the runner listens
// on its tailnet address only, and asks Tailscale's local WhoIs which node is calling. A caller is
// let in when that node's MagicDNS name is one of the configured devices' hosts. No tokens.
// `loopback` trusts 127.0.0.1 and ::1 without asking, for tests and local development only.
import { Effect, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// the calling node's MagicDNS name, e.g. "optchat-mini.tail1234.ts.net."; None when Tailscale doesn't know the address
export type WhoIs = (address: string) => Effect.Effect<Option.Option<string>>;

export type Trust = {
  readonly whois: WhoIs;
  readonly nodes: readonly string[]; // allowed node names: the first label, lower case
  readonly loopback: boolean;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const label = (name: string) => name.toLowerCase().replace(/\.$/, "").split(".")[0] ?? "";

// the node names that may spawn: the hosts of the configured device URLs
export const nodesOf = (urls: readonly string[]) => urls.map((u) => label(new URL(u).hostname));

export const trusted = (trust: Trust, remote: Option.Option<string>) =>
  Option.match(remote, {
    onNone: () => Effect.succeed(false),
    onSome: (address) =>
      trust.loopback && LOOPBACK.has(address)
        ? Effect.succeed(true)
        : trust.whois(address).pipe(Effect.map(Option.exists((name) => trust.nodes.includes(label(name))))),
  });

const WhoIsReply = Schema.Struct({ Node: Schema.Struct({ Name: Schema.String }) });
const decodeWhoIs = Schema.decodeUnknownOption(Schema.fromJsonString(WhoIsReply));

// `tailscale whois --json <ip>` through the local tailscaled; any failure is "unknown caller"
export const tailscaleWhois = (binary: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const whois: WhoIs = (address) =>
      spawner.string(ChildProcess.make(binary, ["whois", "--json", address])).pipe(
        Effect.timeout("5 seconds"),
        Effect.map((out) => Option.map(decodeWhoIs(out), (r) => r.Node.Name)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    return whois;
  });

// this machine's tailnet IPv4 address, the only one the runner listens on
export const tailnetAddress = (binary: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(binary, ["ip", "-4"]))).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((out) => out.trim().split("\n")[0] ?? ""),
    Effect.option,
    Effect.map(Option.filter((ip) => ip !== "")),
  );
