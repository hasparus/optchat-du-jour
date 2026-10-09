// The web UI against the real server and a fake `claude` (e2e/fixture.ts, e2e/server.ts), on a
// 360 px phone screen. Every test gets its own server and an empty log (or one it seeds).
import { Schema } from "effect";
import sharp from "sharp";
import { CHANGE_SERVER, shellScript } from "../../mobile/src/bridge.ts";
import { answered, expect, expectShowsLog, open, REPLY, send, test } from "./fixture";

test("a message gets a reply that streams in, after its tool call", async ({ page, server }) => {
  await open(page);
  await send(page, "hello there");
  await expect(page.getByTestId("user-message").filter({ hasText: "hello there" })).toBeVisible();
  await expect(page.getByText("Bash")).toBeVisible();
  // part of the reply while the turn still runs, then all of it
  await expect(page.getByText("Streamed reply")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("running");
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status")).toBeHidden();
  // the tool row opens to its input, as logged, and its output
  await page.getByText(/^Bash/).click();
  await expect(page.getByText('{"command":"ls"}', { exact: true })).toBeVisible();
  await expect(page.getByText("notes.md")).toBeVisible();
  await expectShowsLog(page, server);
});

test("a turn started on one page streams into another", async ({ browser, server }) => {
  const watcher = await browser.newPage({ baseURL: server.url, viewport: { height: 740, width: 360 } });
  const sender = await browser.newPage({ baseURL: server.url, viewport: { height: 740, width: 360 } });
  await open(watcher);
  await open(sender);
  await send(sender, "from the other page");
  await expect(watcher.getByTestId("user-message").filter({ hasText: "from the other page" })).toBeVisible();
  await expect(watcher.getByTestId("status")).toContainText("running");
  await expect(watcher.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  // the last word streams in a moment before the reply is logged: the log is read once the turn is over
  await expect(watcher.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  await expectShowsLog(watcher, server);
  await watcher.close();
  await sender.close();
});

test("a page that opens mid-reply ends with the whole reply as logged", async ({ browser, server }) => {
  const sender = await browser.newPage({ baseURL: server.url, viewport: { height: 740, width: 360 } });
  await open(sender);
  await send(sender, "join in the middle");
  await expect(sender.getByText("Streamed reply")).toBeVisible();
  const late = await browser.newPage({ baseURL: server.url, viewport: { height: 740, width: 360 } });
  await open(late);
  await expect(late.getByTestId("status")).toContainText("running");
  await expect(sender.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  await expect(late.getByText(REPLY)).toBeVisible();
  await expectShowsLog(late, server);
  await late.close();
  await sender.close();
});

test("cancel stops the turn; the next message gets its own bubble", async ({ page, server }) => {
  await open(page);
  await send(page, "this one gets cancelled");
  await expect(page.getByText("Streamed reply")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("status")).toBeHidden();
  await expect(page.getByText("cancelled").first()).toBeVisible();
  // the cut-off reply isn't in the log, so it isn't on the page either, and it doesn't come back
  await expectShowsLog(page, server);
  await expect(page.getByText("Streamed reply")).toHaveCount(0);

  await send(page, "AFTER CANCEL");
  await expect(page.getByTestId("user-message").filter({ hasText: "AFTER CANCEL" })).toHaveText("AFTER CANCEL");
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status")).toBeHidden();
  await expectShowsLog(page, server);
  // the "cancelled" markers stay where the cancel happened: after the cancelled turn's rows, above
  // the next message, which took the index the cut-off reply had
  const order = await page.locator("[data-log-index], [data-testid^=marker]").evaluateAll((els) =>
    els.map((el) => (el instanceof HTMLElement && el.dataset.testid?.startsWith("marker") ? "marker" : el.textContent)),
  );
  const after = order.indexOf("AFTER CANCEL");
  expect(order.filter((o) => o === "marker").length).toBeGreaterThan(0);
  expect(order.lastIndexOf("marker")).toBeLessThan(after);
  expect(order.indexOf("marker")).toBeGreaterThan(order.indexOf("this one gets cancelled"));
});

test.describe("a long log", () => {
  test.use({ seeded: 300 });

  test("a reconnect with older history loaded leaves no gap", async ({ page, server }) => {
    await open(page);
    await expect(page.getByText("m299", { exact: true })).toBeVisible();
    // scrolled to the top, older pages load until the first message
    await expect(async () => {
      await page.getByRole("region", { name: "Chat" }).evaluate((chat) => {
        chat.scrollTop = 0;
      });
      await expect(page.getByText("m0", { exact: true })).toBeAttached({ timeout: 1000 });
    }).toPass();
    await expectShowsLog(page, server, "indexes");
    // the phone sleeps while 20 more are logged, then while more than a window is
    await server.restart(20);
    await expect(page.getByText("m319", { exact: true })).toBeAttached({ timeout: 15_000 });
    await expectShowsLog(page, server, "indexes");
    await server.restart(250);
    await expect(page.getByText("m569", { exact: true })).toBeAttached({ timeout: 15_000 });
    await expectShowsLog(page, server, "indexes");
  });
});

test("the memory screen zooms into a line and shows it in the chat", async ({ page }) => {
  await open(page);
  await send(page, "remember this");
  await answered(page, "remember this");
  await page.getByRole("tab", { name: "Memory" }).click();
  const line = page.getByTestId("view-line").filter({ hasText: "remember this" });
  await expect(line).toBeVisible();
  await expect(page.getByRole("button", { name: /%/ })).toBeVisible(); // the context meter
  await line.click();
  await expect(page.getByTestId("zoom-message")).toHaveText("remember this");
  await page.getByRole("button", { name: "show in chat" }).click();
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("user-message").filter({ hasText: "remember this" })).toBeInViewport();
});

test("the stats and devices screens render", async ({ page }) => {
  await open(page);
  await send(page, "count this");
  await answered(page, "count this");
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByTestId("stats")).toContainText("cache hit rate");
  await expect(page.getByText("Calls per day, by role")).toBeVisible();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.getByRole("tab", { name: "Devices" }).click();
  await expect(page.getByTestId("devices")).toContainText("macbook");
});

test("a reload shows the log again from the snapshot", async ({ page, server }) => {
  await open(page);
  await send(page, "still here?");
  await answered(page, "still here?");
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: "still here?" })).toBeVisible();
  await expect(page.getByText(REPLY)).toBeVisible();
  await expectShowsLog(page, server);
  // nothing scrolls sideways on a 360 px screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("a Stats screen that fails to load says so, and the chat stays up", async ({ browser, server }) => {
  // no service worker: it would serve the chunk from its cache before the page's network sees it
  const context = await browser.newContext({ baseURL: server.url, serviceWorkers: "block", viewport: { height: 740, width: 360 } });
  const page = await context.newPage();
  await open(page);
  await page.route(/lazy\/stats-/, async (route) => route.abort());
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load this screen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // the rest of the app works
  await page.getByRole("tab", { name: "Chat" }).click();
  await send(page, "still usable");
  await expect(page.getByTestId("user-message").filter({ hasText: "still usable" })).toBeVisible();
  await page.getByRole("tab", { name: "Devices" }).click();
  await expect(page.getByTestId("devices")).toContainText("macbook");
  // back online, a reload gets the screen
  await page.unroute(/lazy\/stats-/);
  await page.reload();
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByTestId("stats")).toBeVisible();
  await context.close();
});

test("the server answers a missing asset with 404, and any other path with the app", async ({ server }) => {
  const gone = await fetch(`${server.url}/assets/lazy/stats-gone.js`);
  const css = await fetch(`${server.url}/assets/gone.css`);
  expect([gone.status, css.status]).toEqual([404, 404]);
  const app = await fetch(`${server.url}/some/screen`);
  expect(app.status).toBe(200);
  expect(await app.text()).toContain('<div id="root">');
});

test("an attached photo is uploaded, sent, shown in the chat with its marker, and reaches the fake claude as an image block", async ({ page, server }) => {
  await open(page);
  const photo = await sharp({ create: { background: "#3a7", channels: 3, height: 480, width: 640 } })
    .png()
    .toBuffer();
  await page.getByLabel("Attach: files").setInputFiles({ buffer: photo, mimeType: "image/png", name: "board.png" });
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-state", "done");
  await page.getByLabel("Message").fill("what is on the board?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("attachments")).toBeHidden();

  const row = page.getByTestId("user-message").filter({ hasText: "what is on the board?" });
  await expect(row).toContainText(/\[image [0-9a-f]{12} 640x480 \d+KB: a picture from the fake claude\]/);
  const thumb = row.getByRole("img");
  await expect(thumb).toHaveAttribute("src", /^\/api\/assets\/[0-9a-f]{12}\/thumb$/);
  await expect.poll(async () => thumb.evaluate((img) => (img instanceof HTMLImageElement ? img.naturalWidth : 0))).toBe(640);
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  await expectShowsLog(page, server);

  // the turn's opening message carried the picture, as stream-json takes it
  const Blocks = Schema.Array(Schema.Struct({ type: Schema.String, source: Schema.optional(Schema.Struct({ type: Schema.String, media_type: Schema.String })) }));
  const opening = Schema.decodeUnknownSync(Blocks)(server.fakeInputs("turn")[0]);
  expect(opening.filter((b) => b.type === "image")).toEqual([{ source: { media_type: "image/jpeg", type: "base64" }, type: "image" }]);
});

// The iOS app (mobile/) loads this same page in a WebView and runs its script before the page's
// own; here Chromium stands in for WKWebView and exposeFunction for react-native-webview's bridge.
test("in the iOS app's WebView the header's server button asks the app for its server screen", async ({ page }) => {
  const posted: string[] = [];
  await page.exposeFunction("rnPost", (data: string) => {
    posted.push(data);
  });
  await page.addInitScript(`window.ReactNativeWebView = { postMessage: function (data) { window.rnPost(data); } };\n${shellScript}`);
  await open(page);
  await page.getByRole("button", { name: "Change server" }).click();
  await expect.poll(() => posted).toEqual([CHANGE_SERVER]);
});

test("in a browser there is no server button", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Dark theme" }).or(page.getByRole("button", { name: "Light theme" }))).toBeVisible();
  await expect(page.getByRole("button", { name: "Change server" })).toHaveCount(0);
});
