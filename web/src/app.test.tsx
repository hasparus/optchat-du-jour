// The app against a scripted server (test/fixture.ts): what a phone shows as the server's AG-UI
// events arrive, and what it sends back.
import { EventType } from "@ag-ui/core";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./app";
import { openLink } from "./lib/connection";
import type { Inbound } from "./lib/protocol";
import { makeSession } from "./lib/session";
import { type Entry, fakeServer, IDLE, parseSent, said, snapshot, state } from "./test/fixture";

const LOG: Entry[] = [
  { kind: "user", text: "what is in the repo?" },
  { kind: "tool", text: 'Bash {"command":"ls"}' },
  { kind: "echo", text: "notes.md\nrepo" },
  { kind: "talk", text: "Two things: **notes** and a repo." },
];

const DEVICES = [
  { folders: ["~/repos"], local: true, name: "mini", url: "http://optchat-mini:7710" },
  { folders: ["~/repos"], local: false, name: "macbook", url: "http://optchat-macbook:7710" },
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

function start(log: readonly Entry[] = LOG, from = 0) {
  let entries = [...log];
  const greeting = (): Inbound[] => [snapshot(entries, from), { snapshot: { ...IDLE, messages: from + entries.length }, type: EventType.STATE_SNAPSHOT }];
  const server = fakeServer(greeting);
  const link = openLink("ws://127.0.0.1:7700/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  render(<App link={link} session={session} />);
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

test("the snapshot shows the log: messages, a collapsed tool call, markdown with a raw-text toggle", async () => {
  start();
  await screen.findByText("what is in the repo?");
  expect(screen.getByText(/^Bash/)).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  fireEvent.click(screen.getByText(/^Bash/));
  expect((await screen.findByText(/notes\.md/)).textContent).toContain("repo");
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

  play(state({ phase: "running" }), ...said(4, "user", "and now?"));
  await waitFor(() => {
    expect(screen.queryByTestId("queue")).toBeNull();
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(server.sent.at(-1)).toBe('{"type":"abort"}');
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
