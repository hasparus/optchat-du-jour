// The web UI against the real server and a fake `claude` (e2e/fixture.ts, e2e/server.ts), on a
// 360 px phone screen. Every test gets its own server and an empty log (or one it seeds).
import { expect, expectShowsLog, open, REPLY, send, test } from "./fixture";

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
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
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
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
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
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: "still here?" })).toBeVisible();
  await expect(page.getByText(REPLY)).toBeVisible();
  await expectShowsLog(page, server);
  // nothing scrolls sideways on a 360 px screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
