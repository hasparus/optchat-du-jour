// Who may talk to the server (E9, SPEC "Tailscale, auth and operations").
//
// Threat model. The server listens on loopback only and `tailscale serve` publishes it to the
// tailnet, adding Tailscale-User-Login to what it forwards; that login is the only identity. What
// the server can do is a lot: /ws drives a master that runs with bypassPermissions, so whoever
// reaches it can run commands on this machine. Three ways in had to be shut:
//   1. A forwarded request carrying a login: it must be one of `allowedLogins`.
//   2. A web page in a browser on this machine, or on the phone through `tailscale serve` (which
//      would add the user's own login): a browser lets any page open a WebSocket to any host and
//      sends its own origin along. So a request that names an origin must name ours.
//   3. DNS rebinding: a page whose hostname is made to resolve to 127.0.0.1 is same-origin with
//      itself, not with us, but its requests carry its own name in Host. So Host must be one of
//      the names this server answers to: the loopback names with our port, or the public URL.
// Local processes (the REPL, `claude`'s MCP client, curl) send no Origin and are let through on
// loopback, as long as nothing forwarded them. Both WebSockets, /ws and /mcp's, pass this same
// check on their upgrade request; a browser sends its Origin there too (way 2). /mcp also needs
// the per-start key in its URL, over either transport (E8).
import { Option } from "effect";
import { LOOPBACK } from "../src/http.ts";

export type Caller = {
  readonly remoteAddress: Option.Option<string>;
  readonly header: (name: string) => string | undefined;
};

export type Policy = {
  readonly logins: readonly string[];
  readonly hosts: ReadonlySet<string>; // acceptable Host headers
  readonly origins: ReadonlySet<string>; // acceptable Origin headers, when one is sent
};

// the names this server answers to: loopback on its port, and the published URL if there is one
export function policyFor(port: number, logins: readonly string[], publicUrl?: string): Policy {
  const local = ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);
  const published = publicUrl === undefined ? [] : [new URL(publicUrl)];
  return {
    hosts: new Set([...local, ...published.map((u) => u.host)]),
    logins,
    origins: new Set([...local.map((h) => `http://${h}`), ...published.map((u) => u.origin)]),
  };
}

export function allowed(caller: Caller, policy: Policy): boolean {
  const remote = Option.getOrUndefined(caller.remoteAddress);
  if (remote === undefined || !LOOPBACK.has(remote)) return false;
  const host = caller.header("host");
  if (host === undefined || !policy.hosts.has(host.toLowerCase())) return false;
  const origin = caller.header("origin");
  if (origin !== undefined && !policy.origins.has(origin.toLowerCase())) return false;
  const login = caller.header("tailscale-user-login");
  if (login !== undefined) return policy.logins.includes(login);
  return caller.header("x-forwarded-for") === undefined && caller.header("tailscale-user-name") === undefined;
}
