// Where the long pastes are in the messages sent from here (lib/draft.ts, lib/session.ts): kept by
// the log index the server's ack gives each message, none for a message without any, read once
// per page and kept across a reload, the newest FOLDS_MAX messages only.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { lastId } from "../test/app";
import { ack, fakeServer, IDLE, snapshot } from "../test/fixture";
import { openLink } from "./connection";
import { FOLDS_MAX, loadFolds, rememberFolds } from "./draft";
import { makeSession } from "./session";

const greeting = () => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT } as const];
const settle = async () => {
  await Bun.sleep(20);
};

test("a message's spans are kept under the index its ack names; one without pastes is kept with none; a reload reads them back", async () => {
  const server = fakeServer(greeting);
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link);
  await settle();
  session.send("see:\nPASTED", { spans: [[5, 11]] });
  server.play(ack(lastId(server.sent), 7));
  session.send("a long typed message");
  server.play(ack(lastId(server.sent), 9));
  expect(session.get().folds.get(7)).toEqual([[5, 11]]);
  expect(session.get().folds.get(9)).toEqual([]);
  expect(session.get().folds.has(8)).toBe(false); // another client's
  // a page loaded later finds them
  expect(makeSession(link).get().folds.get(7)).toEqual([[5, 11]]);
  link.close();
});

test(`only the newest ${FOLDS_MAX} messages are remembered`, () => {
  let folds = loadFolds();
  for (let i = 0; i <= FOLDS_MAX; i++) folds = rememberFolds(folds, i, [[0, i + 1]]);
  expect(folds.size).toBe(FOLDS_MAX);
  expect(folds.has(0)).toBe(false);
  expect(folds.get(FOLDS_MAX)).toEqual([[0, FOLDS_MAX + 1]]);
  expect(loadFolds()).toEqual(folds);
});
