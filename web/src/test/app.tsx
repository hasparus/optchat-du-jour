// The app against a scripted server (test/fixture.ts), shared by the component test files: the log
// a page opens on, the devices and older pages /api serves, and `start`, which renders the app over
// a fake server and returns what it sent and a way to play it more events. A test file calls
// `stubApi()` once at its top.
import { EventType } from "@ag-ui/core";
import { afterEach, beforeEach } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../app";
import type { Uploader } from "../lib/attach";
import { openLink } from "../lib/connection";
import type { Inbound } from "../lib/protocol";
import { makeMemory } from "../lib/memory";
import { makeSession } from "../lib/session";
import { type Entry, fakeServer, IDLE, parseSent, snapshot } from "./fixture";
import { childrenPage, type Counted, viewPage } from "../../../src/memory-view.ts";
import type { Mem } from "../../../src/tree.ts";

export const LOG: Entry[] = [
  { kind: "user", text: "what is in the repo?" },
  { kind: "tool", text: 'Bash {"command":"ls"}' },
  { kind: "echo", text: "notes.md\nrepo" },
  { kind: "talk", text: "Two things: **notes** and a repo." },
];

export const DEVICES = [
  { claudeVersion: "2.1.289", folders: ["~/repos"], local: true, name: "mini", status: "online", url: "http://optchat-mini:7710" },
  { claudeVersion: null, folders: ["~/repos"], local: false, name: "macbook", status: "offline", url: "http://optchat-macbook:7710" },
];

// What /api/reasoning answers in a test: the pieces kept, by the entry they came before (none
// unless a test puts some here; emptied after each test), and how often a piece's text was read
export const THOUGHTS = new Map<number, { readonly ms: number; readonly text: string }>();
export const thoughtReads: number[] = [];

// The memory /api/memory/* reads from in a test that sets one (the server's own, in this process),
// the change it is as of, and the paths read, to tell a live update from a read
// `failing`: reads of older view lines (with a `before`) answer 503, as a server gone offline
type MemoryServer = { mem: Mem | null; at: () => Counted; reads: string[]; failing: boolean };
export const MEMORY: MemoryServer = { at: () => ({ boot: "b", rev: 0 }), failing: false, mem: null, reads: [] };
const memoryApi = (url: URL, mem: Mem) => {
  const n = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
  MEMORY.reads.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/api/memory/view") {
    if (MEMORY.failing && url.searchParams.has("before")) return new Response(null, { status: 503 });
    return Response.json(viewPage(mem, MEMORY.at(), n("before"), n("limit")));
  }
  if (url.pathname === "/api/memory/children") {
    const page = childrenPage(mem, { i: n("i") ?? 0, l: n("l") ?? 0 }, n("depth") ?? 1, n("from"), n("limit"));
    return page === null ? new Response(null, { status: 404 }) : Response.json(page);
  }
  const before = n("before") ?? mem.root.length;
  return Response.json({ entries: mem.root.slice(Math.max(0, before - (n("limit") ?? 100)), before), total: mem.root.length });
};

// the memory stores start() made, disposed after each test
const made: { readonly dispose: () => void }[] = [];

// /api for each test: the devices, the page before message 100 of a long log, and THOUGHTS
export function stubApi() {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://127.0.0.1:7700/");
      const path = url.pathname;
      if (MEMORY.mem !== null && (path.startsWith("/api/memory/") || path === "/api/messages")) return memoryApi(url, MEMORY.mem);
      if (path === "/api/devices") return Response.json(DEVICES);
      if (path === "/api/reasoning") {
        const pieces = [...THOUGHTS].map(([i, t]) => ({ chars: t.text.length, engine: "claude-code:opus", i, ms: t.ms }));
        return Response.json({ pieces });
      }
      if (path === "/api/reasoning/text") {
        const i = Number(new URL(input instanceof Request ? input.url : input, "http://127.0.0.1:7700/").searchParams.get("i"));
        thoughtReads.push(i);
        const t = THOUGHTS.get(i);
        return t ? Response.json({ chars: t.text.length, date: "2026-10-15T10:00:00Z", engine: "claude-code:opus", i, ms: t.ms, text: t.text }) : new Response(null, { status: 404 });
      }
      if (path === "/api/messages") {
        // the page before message 100 of a long log: two entries are enough
        const entries = [98, 99].map((i) => ({ date: "2026-10-05T10:00:00Z", i, kind: "user", text: `older message ${i}` }));
        return Response.json({ entries, total: 104 });
      }
      return Response.json({ error: "not in this test" }, { status: 404 });
    }, { preconnect: realFetch.preconnect });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    THOUGHTS.clear();
    thoughtReads.length = 0;
    for (const store of made.splice(0)) store.dispose();
    MEMORY.mem = null;
    MEMORY.reads = [];
    MEMORY.failing = false;
    MEMORY.at = () => ({ boot: "b", rev: 0 });
    try {
      localStorage.removeItem("transcript");
    } catch {
      // none to clear
    }
  });
}

// `stateless`: the server's greeting holds the log only, as before its first STATE_SNAPSHOT arrives
export function start(log: readonly Entry[] = LOG, from = 0, uploader?: Uploader, stateless = false) {
  let entries = [...log];
  const greeting = (): Inbound[] =>
    stateless ? [snapshot(entries, from)] : [snapshot(entries, from), { snapshot: { ...IDLE, messages: from + entries.length }, type: EventType.STATE_SNAPSHOT }];
  const server = fakeServer(greeting);
  const link = openLink("ws://127.0.0.1:7700/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  const memory = makeMemory(link, { retryMs: 20 });
  made.push(memory); // disposed after the test: a store left behind would read the next test's server
  render(<App link={link} memory={memory} session={session} uploader={uploader} />);
  const play = (...events: Inbound[]) => {
    act(() => {
      server.play(...events);
    });
  };
  return {
    log: (more: readonly Entry[]) => {
      entries = [...entries, ...more];
    },
    play,
    server,
  };
}

export { actionsOf as frames } from "./fixture";
export const box = () => screen.getByLabelText<HTMLTextAreaElement>("Message");
export const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
};

// a touch screen for the length of `body`: (pointer: coarse) matches
export async function onTouchScreen(body: () => Promise<void>) {
  const realMatch = globalThis.matchMedia;
  globalThis.matchMedia = (query: string) => {
    const list = realMatch(query);
    Object.defineProperty(list, "matches", { value: query === "(pointer: coarse)" });
    return list;
  };
  try {
    await body();
  } finally {
    globalThis.matchMedia = realMatch;
  }
}

// what the app sent as messages: the device each was for and its text
export const sentTexts = (sent: readonly string[]) =>
  sent.flatMap((f) => {
    const frame = parseSent(f);
    return frame.messages ? [{ device: frame.forwardedProps?.device, text: frame.messages.at(-1)?.content }] : [];
  });
// the id the newest message went out with, which the server's ack names
export const lastId = (sent: readonly string[]) => sent.flatMap((f) => parseSent(f).messages?.at(-1)?.id ?? []).at(-1) ?? "";
