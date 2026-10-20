// Where the long pastes are in the messages sent from here (lib/draft.ts, lib/session.ts): kept by
// the log index the server's ack gives each message, or the entry a message whose ack was lost is
// matched to; none for a message without any; read once per page and kept across a reload, with
// the text's length, so an index that now names another message folds nothing of it; the newest
// FOLDS_MAX messages only.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { lastId } from "../test/app";
import { ack, type Entry, fakeServer, IDLE, snapshot } from "../test/fixture";
import { openLink } from "./connection";
import { FOLDS_MAX, loadFolds, rememberFolds } from "./draft";
import { foldsOf } from "./paste";
import { makeSession } from "./session";

const settle = async () => {
  await Bun.sleep(20);
};

test("a message's spans are kept under the index its ack names; one without pastes is kept with none; a reload reads them back", async () => {
  const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  await settle();
  session.send("see:\nPASTED", { spans: [[5, 11]] });
  server.play(ack(lastId(server.sent), 7));
  session.send("a long typed message");
  server.play(ack(lastId(server.sent), 9));
  expect(session.get().folds.get(7)).toEqual({ length: 11, spans: [[5, 11]] });
  expect(session.get().folds.get(9)).toEqual({ length: 20, spans: [] });
  expect(session.get().folds.has(8)).toBe(false); // another client's
  // a page loaded later finds them
  expect(makeSession(link).get().folds.get(7)).toEqual({ length: 11, spans: [[5, 11]] });
  link.close();
});

test("a message whose ack was lost with its socket: its spans are kept under the entry the next snapshot shows for it", async () => {
  const log: Entry[] = [{ kind: "user", text: "first" }];
  const server = fakeServer(() => [snapshot(log), { snapshot: { ...IDLE, messages: log.length }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  await settle();
  session.send("see:\nPASTED", { spans: [[5, 11]] });
  log.push({ kind: "user", text: "see:\nPASTED" }); // logged at 1; its ack never reached this page
  server.drop();
  await settle();
  expect(session.get().pending).toEqual([]);
  expect(session.get().folds.get(1)).toEqual({ length: 11, spans: [[5, 11]] });
  link.close();
});

test("kept spans fold only the text they were kept for: the same index on another message is none", () => {
  const fold = { length: 11, spans: [[5, 11]] as const };
  expect(foldsOf(fold, "see:\nPASTED")).toEqual([[5, 11]]);
  expect(foldsOf(fold, "a whole other message")).toBeNull(); // the server's log was started afresh
  expect(foldsOf(undefined, "see:\nPASTED")).toBeNull();
});

test(`only the newest ${FOLDS_MAX} messages are remembered`, () => {
  let folds = loadFolds();
  for (let i = 0; i <= FOLDS_MAX; i++) folds = rememberFolds(folds, i, { length: i + 1, spans: [[0, i + 1]] });
  expect(folds.size).toBe(FOLDS_MAX);
  expect(folds.has(0)).toBe(false);
  expect(folds.get(FOLDS_MAX)).toEqual({ length: FOLDS_MAX + 1, spans: [[0, FOLDS_MAX + 1]] });
  expect(loadFolds()).toEqual(folds);
});
