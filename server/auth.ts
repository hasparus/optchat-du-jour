// Tailscale identity is the only auth (E9). `tailscale serve` publishes the server, which listens on
// loopback only, and adds Tailscale-User-Login to what it forwards. So: a request must arrive on
// loopback; one that carries a login must carry an allowed one; one that carries none is a local
// process only if nothing forwarded it.
import { Option } from "effect";
import { LOOPBACK } from "../src/http.ts";

export type Caller = {
  readonly remoteAddress: Option.Option<string>;
  readonly header: (name: string) => string | undefined;
};

export function allowed(caller: Caller, logins: readonly string[]): boolean {
  const remote = Option.getOrUndefined(caller.remoteAddress);
  if (remote === undefined || !LOOPBACK.has(remote)) return false;
  const login = caller.header("tailscale-user-login");
  if (login !== undefined) return logins.includes(login);
  return caller.header("x-forwarded-for") === undefined && caller.header("tailscale-user-name") === undefined;
}
