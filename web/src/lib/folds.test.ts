// Where the long pastes are in the messages sent from here (lib/draft.ts, lib/session.ts): kept by
// the log index the server's ack gives each message, or its answer to the message sent again after
// the ack was lost (E41); none for a message without any; read once per page and kept across a
// reload, with the text's length, so an index that now names another message folds nothing of it;
// the newest FOLDS_MAX messages only.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { lastId } from "../test/app";
import { ack, fakeServer, IDLE, received, snapshot } from "../test/fixture";
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

test("a message whose ack was lost with its socket: sent again on the next, its spans are kept under the index the server's answer names", async () => {
  const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  await settle();
  session.send("see:\nPASTED", { spans: [[5, 11]] });
  const id = lastId(server.sent);
  server.drop(); // its ack went to the socket that dropped
  await settle();
  // sent again on the next socket (E41); the server answers that it logged it at 4 already
  expect(lastId(server.sent)).toBe(id);
  server.play(received(id, "logged", 4));
  expect(session.get().pending).toEqual([]);
  expect(session.get().folds.get(4)).toEqual({ length: 11, spans: [[5, 11]] });
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
