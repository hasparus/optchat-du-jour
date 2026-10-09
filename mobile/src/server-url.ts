// The server's address as typed on the setup screen, and what the app does with it.
//
// The app loads the web UI from the server itself, so the UI always matches the server it talks
// to, and /ws, /api and the uploads are same-origin: the server's Host and Origin checks
// (server/auth.ts) pass as they do for the PWA, with no change. The address is the one
// `tailscale serve` publishes, https://<machine>.<tailnet>.ts.net, which must also be the
// server's `server.publicUrl` (the Host it accepts). Plain http is only for 127.0.0.1 or
// localhost, the server on the Mac that runs the iOS simulator.

export type Parsed =
  | { readonly ok: true; readonly origin: string } // e.g. https://mini.tailnet.ts.net
  | { readonly ok: false; readonly error: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseServerUrl(input: string): Parsed {
  const text = input.trim();
  if (text === "") return { error: "Type your server's address, like https://mini.tailnet.ts.net", ok: false };
  // a bare host name gets https://, as tailscale serve publishes it
  const withScheme = /^[a-z][\d+.a-z-]*:\/\//iu.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "That isn't a web address.", ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "The address must start with https://.", ok: false };
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return { error: "Use the https:// address that tailscale serve gives the server; plain http only reaches 127.0.0.1.", ok: false };
  }
  if (url.username !== "" || url.password !== "") return { error: "Leave the user name and password out of the address.", ok: false };
  // the app always opens the server's own /, so a path would be dropped without a word
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return { error: `Type the server's address alone, without a path: ${url.origin}`, ok: false };
  if (url.hostname === "") return { error: "That address has no host name.", ok: false };
  return { ok: true, origin: url.origin };
}

// whether `target` is on the server: same scheme, host and port
export function sameOrigin(origin: string, target: string): boolean {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

// What may load in the app's WebView. In any frame: nothing but the server's origin (a blob: URL
// its page made has its origin too) and the empty documents a page makes itself (about:blank, an
// iframe's srcdoc), so no other site, and no other port on the server's host, runs with the app's
// bridge or its media grant. The top frame holds the app itself, the server's `/`: a link to
// another of its paths (an attachment, an API answer) would leave the app on a page with no way
// back, so it opens outside, as a link elsewhere does.
export function loadsInApp(origin: string, request: { readonly url: string; readonly isTopFrame: boolean }): boolean {
  const { isTopFrame, url } = request;
  if (url === "about:blank" || (!isTopFrame && url === "about:srcdoc")) return true;
  if (!sameOrigin(origin, url)) return false;
  return !isTopFrame || new URL(url).pathname === "/";
}

export type Probe = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// One request to /api/devices, the cheapest route behind the server's guard, before the address is
// kept: it says whether the phone reaches the server and whether the server lets it in. The app's
// own fetch sends no Origin, and tailscale serve adds the phone's Tailscale login.
export async function probe(origin: string, fetcher: Fetch = fetch, timeoutMs = 10_000): Promise<Probe> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    const response = await fetcher(`${origin}/api/devices`, { headers: { accept: "application/json" }, signal: abort.signal });
    if (response.ok) return { ok: true };
    if (response.status === 403) {
      return {
        error:
          "The server refused this phone (403). Check that your Tailscale login is in allowedLogins and that server.publicUrl in optchat.config.ts is this address.",
        ok: false,
      };
    }
    return { error: `The server answered ${response.status}.`, ok: false };
  } catch {
    return {
      error: abort.signal.aborted
        ? `No answer in ${Math.round(timeoutMs / 1000)} s. Is Tailscale connected on this phone, and is tailscale serve running on the server?`
        : "Can't reach that address. Is Tailscale connected on this phone, and is tailscale serve running on the server?",
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
