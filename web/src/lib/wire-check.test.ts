// The wire check (E44): a server of another build closes the socket with WIRE_STALE, and the link
// stays down, "outdated", instead of reconnecting for ever; any other close is reconnected as ever.
import { EventType } from "@ag-ui/core";
import { WIRE_STALE } from "@wire";
import { expect, test } from "bun:test";
import { fakeServer, IDLE, snapshot } from "../test/fixture";
import { type LinkStatus, openLink } from "./connection";

const greeting = () => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT } as const];
const settle = async () => {
  await Bun.sleep(20); // the 1 ms retry, and the fake socket's open
};

test("a close with WIRE_STALE leaves the link outdated: no reconnect, nothing sent later goes out, wake does nothing", async () => {
  const server = fakeServer(greeting);
  const link = openLink("ws://x/ws?wire=1", { retryMs: 1, socket: server.socket });
  const seen: LinkStatus[] = [];
  link.onStatus((s) => {
    seen.push(s);
  });
  await settle();
  expect(link.status()).toBe("open");
  server.sockets[0]?.close(WIRE_STALE);
  await settle();
  expect(link.status()).toBe("outdated");
  expect(seen.at(-1)).toBe("outdated");
  link.wake(Number.POSITIVE_INFINITY);
  await settle();
  expect(server.sockets).toHaveLength(1);
  expect(link.abort()).toBe(false);
  link.close();
});

test("any other close is reconnected", async () => {
  const server = fakeServer(greeting);
  const link = openLink("ws://x/ws?wire=1", { retryMs: 1, socket: server.socket });
  await settle();
  server.sockets[0]?.close(1006);
  await settle();
  expect(server.sockets).toHaveLength(2);
  expect(link.status()).toBe("open");
  link.close();
});
