// An artifact can't get out (SPEC "Artifacts"): a fake turn publishes hostile(stun), which tries
// fetch, XMLHttpRequest, a WebSocket out and to the app's /ws, an image from outside, sendBeacon,
// the cookies, localStorage, the parent's document and storage, the top window's location, a popup,
// RTCPeerConnection in its own window, and in a srcdoc frame it makes (by createElement, by
// insertAdjacentHTML, in a closed shadow root): no such frame ever runs. Every one fails, no request
// leaves for the outside host, no STUN datagram reaches the UDP listener, and the app's own cookie
// and storage are as they were. A link in it
// opens in a new tab, only through the parent and only during the click; a message with a forged
// token opens nothing, and navigating itself away goes nowhere.
import type { Request } from "@playwright/test";
import { Schema } from "effect";
import { answered, expect, OUTSIDE, open, send, test } from "./fixture.ts";

const isOutside = (url: string) => url.startsWith(OUTSIDE) || url.startsWith("ws://outside.test");
const decodeResults = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)));

test.use({ artifacts: "hostile" });

test("a published page can reach no network, cookie, storage, parent or socket of the app", async ({ page, context, stun }) => {
  // Chromium reports a request the CSP stopped too, as one that failed ("csp") before it left: only
  // a request that reached the network (the route below) or failed for any other reason counts as out
  const outside: string[] = [];
  context.on("requestfailed", (r: Request) => {
    if (isOutside(r.url()) && !/csp/i.test(r.failure()?.errorText ?? "")) outside.push(`${r.url()} ${r.failure()?.errorText ?? ""}`);
  });
  // anything that does get out finds an answer, so a leak reads as a success, not a network error
  await context.route(`${OUTSIDE}/**`, async (route) => {
    outside.push(route.request().url());
    await route.fulfill({ body: "leaked", status: 200 });
  });
  await context.route("https://example.com/**", async (route) => route.fulfill({ body: "<title>opened</title>", contentType: "text/html" }));

  await open(page);
  await page.evaluate(() => {
    // oxlint-disable-next-line unicorn/no-document-cookie -- the app's own cookie, which the artifact must not reach
    document.cookie = "app=1; path=/";
    localStorage.setItem("app-key", "app-value");
  });
  const before = await context.cookies();
  await send(page, "publish the page");
  await answered(page, "publish the page");
  await page.getByTestId("artifact-card").click();

  const inner = page.frameLocator('[data-testid="artifact-frame"]').frameLocator("iframe");
  await expect(inner.locator("body")).toHaveAttribute("data-done", "yes", { timeout: 15_000 });
  const results = decodeResults((await inner.locator("#out").textContent()) ?? "{}");
  for (const attempt of ["fetch", "xhr", "websocket", "appSocket", "image", "cookie", "localStorage", "parentDocument", "parentStorage", "topLocation", "windowOpen", "rtc", "srcdocFrame", "srcdocInHTML", "srcdocInShadow", "framesLeft"]) {
    expect([attempt, results[attempt]?.startsWith("blocked:")]).toEqual([attempt, true]);
  }
  // sendBeacon says it queued the beacon whatever the CSP then does with it: the request itself
  // is what must not leave (`outside`, below)
  expect(results.sendBeacon).toBeDefined();

  // the app's own cookie and storage are untouched, and nothing of the artifact's got in
  expect(await context.cookies()).toEqual(before);
  expect(await page.evaluate(() => [document.cookie, localStorage.getItem("app-key"), localStorage.getItem("pwned")])).toEqual(["app=1", "app-value", null]);

  // a link opens in a new tab, through the parent, with no opener
  const opened = context.waitForEvent("page");
  await inner.locator("#link").click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe("https://example.com/opened");
  expect(await tab.evaluate(() => window.opener === null)).toBe(true);
  await tab.close();
  // a forged token opens nothing
  let more = 0;
  context.on("page", () => {
    more++;
  });
  await inner.locator("#forged").click();
  // navigating itself away goes nowhere: the wrapper's frame-src lets in only the artifact page
  await inner.locator("#selfnav").click();
  await page.waitForTimeout(1500);
  expect(more).toBe(0);
  expect(outside).toEqual([]);
  expect(stun.datagrams()).toBe(0);
  // and the wrapper brought the page back
  await expect(inner.locator("body")).toHaveAttribute("data-done", "yes", { timeout: 10_000 });
});
