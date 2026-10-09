// The setup screen's address and its check, with no phone and no network.
import { describe, expect, test } from "bun:test";
import { type Fetch, parseServerUrl, probe, sameOrigin } from "./server-url";

describe("parseServerUrl", () => {
  test("a tailnet address, typed in full or as a bare host name, becomes its https origin", () => {
    expect(parseServerUrl("https://mini.tailnet.ts.net")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net" });
    expect(parseServerUrl("  mini.tailnet.ts.net/chat?x=1 ")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net" });
    expect(parseServerUrl("HTTPS://Mini.Tailnet.TS.net:8443/")).toEqual({ ok: true, origin: "https://mini.tailnet.ts.net:8443" });
  });

  test("plain http only for loopback (the simulator's own Mac)", () => {
    expect(parseServerUrl("http://127.0.0.1:7700")).toEqual({ ok: true, origin: "http://127.0.0.1:7700" });
    expect(parseServerUrl("http://localhost:7700")).toEqual({ ok: true, origin: "http://localhost:7700" });
    expect(parseServerUrl("http://mini.tailnet.ts.net").ok).toBe(false);
    expect(parseServerUrl("http://192.168.1.20:7700").ok).toBe(false);
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
