// A take-back whose answer was lost with the socket (E41): the server took the message out of its
// queue and told every client, but the page's socket dropped before `taken-back` came. After the
// reconnect the page sends the message again under its id, and the server answers that it was taken
// back: the text comes back to this page's composer, never lost between the queue and the composer.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { fakeServer, IDLE, received, snapshot } from "../test/fixture";
import { openLink } from "./connection";
import { makeSession, queued } from "./session";

const tick = async (ms = 5) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type Held = { readonly clientId: string | null; readonly engine: string; readonly queued: boolean; readonly text: string };

test("the user's text comes back to the composer when the take-back's answer was lost with the socket", async () => {
  let heldThere: readonly Held[] = [];
  const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, pending: heldThere, phase: "running" }, type: EventType.STATE_SNAPSHOT }]);
  const session = makeSession(openLink("ws://x/ws", { retryMs: 1, socket: server.socket }));
  await tick();
  session.send("a long message I want to edit");
  await tick();
  const id = session.get().pending[0]?.id ?? "";
  heldThere = [{ clientId: id, engine: "claude-code:opus", queued: true, text: "a long message I want to edit" }];
  server.play({ snapshot: { ...IDLE, pending: heldThere, phase: "running" }, type: EventType.STATE_SNAPSHOT });
  const q = queued(session.get()).find((x) => x.clientId === id);
  if (!q) throw new Error("not queued");
  expect(session.takeBack(q)).toBe(true);
  // the server takes it back (its queue is empty now); its `taken-back` goes to the socket that drops
  heldThere = [];
  server.drop();
  await tick(20);
  // after the reconnect the page sends the message again; the server answers it was taken back
  server.play(received(id, "taken-back"));
  await tick();
  expect(session.get().restored?.text).toBe("a long message I want to edit");
  expect(session.get().pending).toEqual([]);
  expect(session.get().asking).toEqual([]);
});

test("one another page took back is only dropped here: its text goes to that page's composer, not to two", async () => {
  const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, phase: "running" }, type: EventType.STATE_SNAPSHOT }]);
  const session = makeSession(openLink("ws://x/ws", { retryMs: 1, socket: server.socket }));
  await tick();
  session.send("theirs to edit");
  await tick();
  const id = session.get().pending[0]?.id ?? "";
  server.play(received(id, "taken-back"));
  expect(session.get().pending).toEqual([]);
  expect(session.get().restored).toBeNull();
});
