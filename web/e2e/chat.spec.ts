// The web UI against the real server and a fake `claude` (e2e/fixture.ts, e2e/server.ts), on a
// 360 px phone screen. Every test gets its own server and an empty log (or one it seeds).
import { Schema } from "effect";
import sharp from "sharp";
import { CHANGE_SERVER, shellScript } from "../../mobile/src/bridge.ts";
import { answered, attach, clearOfDock, expect, expectShowsLog, open, REPLY, send, test, TOOL_ERROR } from "./fixture";

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

test("a tool that worked says nothing aloud but Completed", async ({ page }) => {
  await open(page);
  await send(page, "hello there");
  await answered(page, "hello there");
  const status = page.locator('[data-slot="tool"] [data-slot="tool-status"]');
  await expect(status).toHaveText("Completed");
  await expect(page.getByText("Failed")).toHaveCount(0);
});

test.describe("a tool call that fails", () => {
  test.use({ toolError: true });
  test("reads as Failed from the flag the server logged, live and after a reload, with its output as logged", async ({ page, server }) => {
    await open(page);
    await send(page, "list it");
    const row = page.locator('[data-slot="tool"]').filter({ hasText: "Bash" });
    // the output itself says nothing of a failure (TOOL_ERROR): only Claude Code's is_error does
    await expect(row.locator('[data-slot="tool-status"]')).toHaveText("Failed");
    await answered(page, "list it");
    const logged = await server.log();
    expect(logged.filter((e) => e.kind === "echo")).toMatchObject([{ error: true, text: TOOL_ERROR }]);
    await row.getByText(/^Bash/).click();
    await expect(row.getByText(TOOL_ERROR)).toBeVisible();
    // the snapshot a fresh page gets carries it too
    await page.reload();
    await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
    await expect(page.locator('[data-slot="tool"]').filter({ hasText: "Bash" }).locator('[data-slot="tool-status"]')).toHaveText("Failed");
    await expectShowsLog(page, server);
  });
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

  test("the chat opens at its newest message, not at the oldest one loaded, clear of the composer", async ({ page }) => {
    await open(page);
    const newest = page.getByText("m299", { exact: true });
    await expect(newest).toBeInViewport();
    // in view and not under the floating dock: its bottom is above the dock's top
    await expect.poll(async () => clearOfDock(page, newest)).toBeGreaterThanOrEqual(0);
  });

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

test.describe("a log with history above", () => {
  test.use({ seeded: 40 }); // room to scroll the first turn's row down under the dock

  test("a control reached by keyboard is never left under the floating dock (WCAG 2.4.11)", async ({ page }) => {
    await open(page);
    for (const text of ["first question", "second question"]) {
      await send(page, text);
      await answered(page, text);
    }
    // the first turn's tool row, scrolled to sit under the composer
    const tool = page.locator('[data-slot="tool"]').first().locator('[data-slot="trace-collapsible-trigger"]');
    const chat = page.getByRole("region", { name: "Chat" });
    await chat.evaluate((viewport) => {
      const row = viewport.querySelector('[data-slot="tool"] [data-slot="trace-collapsible-trigger"]');
      const dock = document.querySelector('[data-testid="dock"]');
      if (!row || !dock) throw new Error("no tool row or dock");
      viewport.scrollTop += row.getBoundingClientRect().top - (dock.getBoundingClientRect().top + 16);
    });
    await expect.poll(async () => clearOfDock(page, tool)).toBeLessThan(0);
    // Tab from the chat region lands on it: the browser scrolls it clear of the dock
    await chat.focus();
    await page.keyboard.press("Tab");
    await expect(tool).toBeFocused();
    await expect.poll(async () => clearOfDock(page, tool)).toBeGreaterThanOrEqual(0);
  });
});

test.describe("on a touch screen, with history above", () => {
  test.use({ hasTouch: true, isMobile: true, seeded: 40 });

  test("a tap on the newest reply shows its actions clear of the dock, and the chat stays at its end", async ({ page, server }) => {
    await open(page);
    await page.getByLabel("Message").fill("one more");
    await page.getByRole("button", { name: /^Send/ }).first().tap(); // Enter is a new line on a touch screen
    await answered(page, "one more");
    // opened afresh, the chat starts at its end, under the newest reply (no turn's room below it)
    await server.restart(0);
    await open(page);
    const chat = page.getByRole("region", { name: "Chat" });
    const gap = async () => chat.evaluate((v) => v.scrollHeight - v.clientHeight - v.scrollTop);
    await expect(page.getByText(REPLY)).toBeInViewport();
    // the reader scrolls back a little and down to the end again, as one reading does
    await chat.hover();
    await page.mouse.wheel(0, -300);
    await expect.poll(gap).toBeGreaterThan(1);
    await page.mouse.wheel(0, 1000);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    const reply = page.locator("[data-reply]").last();
    await expect(reply).not.toHaveAttribute("data-actions", "shown");
    await reply.getByText(REPLY).tap();
    await expect(reply).toHaveAttribute("data-actions", "shown");
    // the row that opened sits above the dock, not under it, and the chat is still at its end
    await expect.poll(async () => clearOfDock(page, reply.locator('[data-slot="message-actions"]'))).toBeGreaterThanOrEqual(0);
    await expect.poll(gap).toBeLessThanOrEqual(1);
  });
});

test("Background work, opened from the status line, shows the running turn and stops it; the devices are there too", async ({ page }) => {
  await open(page);
  await send(page, "take your time");
  const status = page.getByTestId("status");
  await status.getByRole("button").click();
  const sheet = page.getByRole("dialog", { name: "Background work" });
  await expect(sheet).toHaveAttribute("data-vaul-drawer-direction", "bottom"); // a phone: from the bottom edge
  // on the glass radius, not the Drawer's 10 px
  expect(await sheet.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("28px");
  await expect(sheet.getByTestId("work-turn")).toContainText(/Turn · on mini, \d+ s/);
  await expect(sheet.getByTestId("work-device").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Stop the turn" }).click();
  await expect(sheet.getByTestId("work-turn")).toBeHidden();
  await expect(sheet).toContainText("Nothing is running");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
});

test.describe("on a wide screen", () => {
  test.use({ viewport: { height: 800, width: 1280 } });

  test("Background work is a side panel, opened from the header", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /^Background work/ }).click();
    const panel = page.getByRole("dialog", { name: "Background work" });
    await expect(panel).toHaveAttribute("data-vaul-drawer-direction", "right");
    await expect(panel).toContainText("Nothing is running");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: /^Background work/ })).toBeFocused(); // focus back on what opened it
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

test("an empty log says what this chat is, until the first message", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("empty-chat")).toBeVisible();
  await send(page, "first words");
  await expect(page.getByTestId("user-message").filter({ hasText: "first words" })).toBeVisible();
  await expect(page.getByTestId("empty-chat")).toBeHidden();
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
  await attach(page, { buffer: photo, mimeType: "image/png", name: "board.png" });
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

for (const width of [360, 390])
  for (const shell of [false, true])
    test.describe(`the header at ${width} px${shell ? " in the iOS app" : " in a browser"}`, () => {
      test.use({ hasTouch: true, isMobile: true, viewport: { height: 780, width } });

      test("fits: no two of its targets overlap, and Background work opens from Devices", async ({ page }) => {
        if (shell) await page.addInitScript(`window.ReactNativeWebView = { postMessage: function () {} };\n${shellScript}`);
        await open(page);
        const header = page.locator("header");
        await expect(header.getByRole("tab", { name: "devices" })).toBeVisible();
        if (shell) await expect(header.getByRole("button", { name: "Change server" })).toBeVisible();
        const boxes = await header.locator('button, [role="tab"]').evaluateAll((els) =>
          els
            .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height > 0)
            .map(({ name, r }) => ({ bottom: r.bottom, left: r.left, name, right: r.right, top: r.top })),
        );
        expect(boxes.length).toBeGreaterThanOrEqual(5); // four tabs and the theme button, at least
        for (const [k, a] of boxes.entries())
          for (const b of boxes.slice(k + 1)) {
            const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
            expect(overlap, `${a.name} and ${b.name}`).toBe(false);
          }
        for (const b of boxes) expect(b.right, b.name).toBeLessThanOrEqual(width);
        // on a phone the sheet opens from Devices (and from a running turn's status line)
        await header.getByRole("tab", { name: "devices" }).click();
        const entry = page.getByTestId("devices").getByRole("button", { name: "Background work" });
        await entry.click();
        const sheet = page.getByRole("dialog", { name: "Background work" });
        await expect(sheet).toBeVisible();
        await sheet.getByRole("button", { name: "Close" }).click();
        await expect(sheet).toBeHidden();
        await expect(entry).toBeFocused(); // focus back on what opened it
      });
    });

test("in a browser there is no server button", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Dark theme" }).or(page.getByRole("button", { name: "Light theme" }))).toBeVisible();
  await expect(page.getByRole("button", { name: "Change server" })).toHaveCount(0);
});
