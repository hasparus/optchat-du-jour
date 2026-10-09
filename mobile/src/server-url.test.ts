// The setup screen's address and its check, with no phone and no network.
import { describe, expect, test } from "bun:test";
import { type Fetch, loadsInApp, parseServerUrl, probe, sameOrigin } from "./server-url";

describe("parseServerUrl", () => {
  test("a tailnet address, typed in full or as a bare host name, becomes its https origin", () => {
    expect(parseServerUrl("https://mini.tailnet.ts.net")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net" });
    expect(parseServerUrl("  mini.tailnet.ts.net/ ")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net" });
    expect(parseServerUrl("HTTPS://Mini.Tailnet.TS.net:8443/")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net:8443" });
  });

  test("plain http only for loopback (the simulator's own Mac)", () => {
    expect(parseServerUrl("http://127.0.0.1:7700")).toEqual({ ok: true, origin: "http://127.0.0.1:7700" });
    expect(parseServerUrl("http://localhost:7700")).toEqual({ ok: true, origin: "http://localhost:7700" });
    expect(parseServerUrl("http://mini.tailnet.ts.net").ok).toBe(false);
    expect(parseServerUrl("http://192.168.1.20:7700").ok).toBe(false);
  });

  test("a path, query or fragment is refused, not dropped, and the message gives the address to type", () => {
    for (const input of ["mini.tailnet.ts.net/chat", "https://mini.tailnet.ts.net/?x=1", "https://mini.tailnet.ts.net/#memory", "https://mini.tailnet.ts.net/api/"]) {
      const parsed = parseServerUrl(input);
      expect(parsed).toEqual({ error: "Type the server's address alone, without a path: https://mini.tailnet.ts.net", ok: false });
    }
  });

  test("nothing, another scheme, or credentials in the address are refused with a reason", () => {
    for (const input of ["", "   ", "ftp://mini.tailnet.ts.net", "javascript:alert(1)", "https://me:pw@mini.tailnet.ts.net", "https://"]) {
      const parsed = parseServerUrl(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });
});

test("sameOrigin: only the server's own pages load in the app", () => {
  const origin = "https://mini.tailnet.ts.net";
  expect(sameOrigin(origin, "https://mini.tailnet.ts.net/api/assets/9d0c38e7aafe")).toBe(true);
  expect(sameOrigin(origin, "https://mini.tailnet.ts.net.evil.com/")).toBe(false);
  expect(sameOrigin(origin, "http://mini.tailnet.ts.net/")).toBe(false);
  expect(sameOrigin(origin, "https://example.com/?u=https://mini.tailnet.ts.net")).toBe(false);
  expect(sameOrigin(origin, "not a url")).toBe(false);
  expect(sameOrigin(origin, `blob:${origin}/1`)).toBe(false); // the maker's origin, but not a page of the server
});

// a server that answers every request with `status`, noting what was asked
const answering =
  (status: number, seen: string[] = []): Fetch =>
  async (url) => {
    seen.push(url);
    return new Response("[]", { status });
  };
const unreachable: Fetch = async () => {
  throw new TypeError("Network request failed");
};
// a server that never answers: the request ends only when the probe gives up on it
const silent: Fetch = async (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });

// Only what passes react-native-webview's own filter (http, https, about:blank) is ever asked; the
// rest is in here to show it would be refused anyway.
test("loadsInApp: a frame loads only the server's pages or about:blank; the top frame only the app at /", () => {
  const origin = "https://mini.tailnet.ts.net";
  const top = (url: string) => loadsInApp(origin, { isTopFrame: true, url });
  const frame = (url: string) => loadsInApp(origin, { isTopFrame: false, url });
  // the app itself, as loaded and reloaded
  for (const url of [`${origin}/`, origin, `${origin}/?tab=memory`, `${origin}/#x`]) expect(top(url)).toBe(true);
  // another of the server's paths would strand the app there: it opens outside; nor is a blank page the app
  for (const url of [`${origin}/api/assets/9d0c38e7aafe`, `${origin}/api/devices`, `${origin}/index.html`, "about:blank"]) expect(top(url)).toBe(false);
  for (const url of [`${origin}/`, `${origin}/api/assets/9d0c38e7aafe/thumb`, "about:blank"]) expect(frame(url)).toBe(true);
  for (const url of [
    "https://example.com/",
    "https://mini.tailnet.ts.net:8443/",
    "http://mini.tailnet.ts.net/",
    "https://other.tailnet.ts.net/",
    "about:blank#x",
    "about:srcdoc",
    `blob:${origin}/1`,
    "data:text/html,<script>1</script>",
    "javascript:alert(1)",
  ]) {
    expect(top(url)).toBe(false);
    expect(frame(url)).toBe(false);
  }
});

describe("probe", () => {
  test("asks /api/devices; 200 is in", async () => {
    const seen: string[] = [];
    expect(await probe("https://mini.tailnet.ts.net", answering(200, seen))).toEqual({ ok: true });
    expect(seen).toEqual(["https://mini.tailnet.ts.net/api/devices"]);
  });

  test("403 names the two settings that let a phone in", async () => {
    const answer = await probe("https://mini.tailnet.ts.net", answering(403));
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toContain("allowedLogins");
  });

  test("no connection, or no answer in time, points at Tailscale", async () => {
    const down = await probe("https://mini.tailnet.ts.net", unreachable);
    expect(!down.ok && down.error.includes("Tailscale")).toBe(true);
    const slow = await probe("https://mini.tailnet.ts.net", silent, 20);
    expect(!slow.ok && slow.error.startsWith("No answer in")).toBe(true);
  });
});
