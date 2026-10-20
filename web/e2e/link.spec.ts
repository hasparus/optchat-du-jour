// The phone's link drops mid-send (E41): the page's socket closes as a message goes out, before the
// server's answer comes back, or before the message gets there at all. After the reconnect the
// link sends it again under its id; the server, answering an id once, logs it once either way, and
// nothing is left for the user to send again. Playwright stands between the page and the real
// server on the first socket only.
import type { WebSocketRoute } from "@playwright/test";
import { Schema } from "effect";
import { answered, expect, open, send, type Server, test } from "./fixture";

// a RunAgentInput's message ids
const decodeRun = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String })) })));

// The first /ws the page opens is cut as `text` goes out: `delivered` decides whether the server
// got it first. The page's side closes at once and whatever the server says after is dropped, as
// on a socket that died; every later socket goes straight through.
const cutFirstSend = async (page: Parameters<typeof open>[0], text: string, delivered: "delivered" | "lost") => {
  let sockets = 0;
  let cut = false;
  const sent: string[] = []; // the frames carrying `text`, on whichever socket
  const carries = (frame: string | Buffer): frame is string => typeof frame === "string" && frame.includes('"messages"') && frame.includes(text);
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    if (++sockets > 1) {
      // forwarded both ways as they are, what the page sends looked at on its way
      ws.onMessage((frame) => {
        if (carries(frame)) sent.push(frame);
        server.send(frame);
      });
      return;
    }
    ws.onMessage((frame) => {
      if (cut) return;
      const sending = carries(frame);
      if (!sending || delivered === "delivered") server.send(frame);
      if (!sending) return;
      sent.push(frame);
      cut = true;
      void ws.close({ code: 4000, reason: "the network went away" });
    });
    server.onMessage((frame) => {
      if (!cut) ws.send(frame);
    });
  });
  // the message's id each time it went out
  return { ids: () => sent.flatMap((f) => decodeRun(f).messages.map((m) => m.id)), sockets: () => sockets };
};

// the user messages with this text, in the log and on the page
const once = async (page: Parameters<typeof open>[0], server: Server, text: string) => {
  await answered(page, text);
  await expect(page.getByTestId("user-message").filter({ hasText: text })).toHaveCount(1);
  const log = await server.log();
  expect(log.filter((e) => e.kind === "user" && e.text === text)).toHaveLength(1);
  await expect(page.getByTestId("queue")).toBeHidden(); // nothing waits, nothing to send again
};

test("a message whose answer was lost with the socket is sent again on the next and logged once", async ({ page, server }) => {
  const link = await cutFirstSend(page, "did this get there?", "delivered");
  await open(page);
  await send(page, "did this get there?");
  await once(page, server, "did this get there?");
  expect(link.sockets()).toBeGreaterThan(1);
  const [first, again] = link.ids();
  expect(again).toBe(first); // the same message, sent again under its id: the server had it already
});

test("a message lost with the socket before it reached the server is sent again on the next and logged once", async ({ page, server }) => {
  const link = await cutFirstSend(page, "lost on the way", "lost");
  await open(page);
  await send(page, "lost on the way");
  await once(page, server, "lost on the way");
  expect(link.sockets()).toBeGreaterThan(1);
  const [first, again] = link.ids();
  expect(again).toBe(first);
});
