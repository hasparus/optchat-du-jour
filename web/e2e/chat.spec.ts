// The web UI against the real server and a fake `claude` (e2e/server.ts), on a 360 px phone
// screen. The tests share one server and one log, so they run in order.
import { type Page, expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const REPLY = "Streamed reply from the fake claude.";

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
}

test("a message gets a reply that streams in, after its tool call", async ({ page }) => {
  await open(page);
  await send(page, "hello there");
  await expect(page.getByTestId("user-message").filter({ hasText: "hello there" })).toBeVisible();
  await expect(page.getByText("Bash")).toBeVisible();
  // part of the reply while the turn still runs, then all of it
  await expect(page.getByText("Streamed reply")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("running");
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status")).toBeHidden();
  // the tool row opens to its input and output
  await page.getByText(/^Bash/).click();
  await expect(page.getByText("notes.md")).toBeVisible();
});

test("a turn started on one page streams into another", async ({ browser }) => {
  const watcher = await browser.newPage({ viewport: { height: 740, width: 360 } });
  const sender = await browser.newPage({ viewport: { height: 740, width: 360 } });
  await open(watcher);
  await open(sender);
  await send(sender, "from the other page");
  await expect(watcher.getByTestId("user-message").filter({ hasText: "from the other page" })).toBeVisible();
  await expect(watcher.getByTestId("status")).toContainText("running");
  await expect(watcher.getByText(REPLY)).toHaveCount(2, { timeout: 15_000 });
  await watcher.close();
  await sender.close();
});

test("cancel stops the turn and says so", async ({ page }) => {
  await open(page);
  const replies = await page.getByText(REPLY).count();
  await send(page, "this one gets cancelled");
  await expect(page.getByText("Streamed reply").nth(replies)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("marker-info").filter({ hasText: "cancelled" })).toBeVisible();
  await expect(page.getByTestId("status")).toBeHidden();
  await page.waitForTimeout(4000); // longer than the rest of the reply would have taken
  await expect(page.getByText(REPLY)).toHaveCount(replies);
});

test("the memory screen zooms into a line and shows it in the chat", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "Memory" }).click();
  const line = page.getByTestId("view-line").filter({ hasText: "from the other page" });
  await expect(line).toBeVisible();
  await expect(page.getByRole("button", { name: /%/ })).toBeVisible(); // the context meter
  await line.click();
  await expect(page.getByTestId("zoom-message")).toHaveText("from the other page");
  await page.getByRole("button", { name: "show in chat" }).click();
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("user-message").filter({ hasText: "from the other page" })).toBeInViewport();
});

test("the stats and devices screens render", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByTestId("stats")).toContainText("cache hit rate");
  await expect(page.getByText("Calls per day, by role")).toBeVisible();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.getByRole("tab", { name: "Devices" }).click();
  await expect(page.getByTestId("devices")).toContainText("macbook");
});

test("a reload shows the log again from the snapshot", async ({ page }) => {
  await open(page);
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: "hello there" })).toBeVisible();
  await expect(page.getByText(REPLY).first()).toBeVisible();
  // nothing scrolls sideways on a 360 px screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
