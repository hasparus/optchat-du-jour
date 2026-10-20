// The chat in daily use, against the real server with the fake claude: Esc and an empty Enter stop
// a running turn (and Esc stays a popover's own while one is open); a long paste folds in the
// composer and in the sent message, and the log holds it whole; an Edit is a diff that grows as
// its input streams (E45) and a Write a closed new file; a page from another build is told to
// reload instead of reconnecting (E44). 360 px wide, like the other specs.
import type { Page } from "@playwright/test";
import { EDIT_INPUT, expect, open, REPLY, send, test, WRITE_INPUT } from "./fixture";

const box = (page: Page) => page.getByLabel("Message");

// a turn of the fake claude has begun: its reply streams for a few seconds (e2e/server.ts)
async function running(page: Page, text: string) {
  await send(page, text);
  await expect(page.getByText("Streamed reply")).toBeVisible();
}

test("Esc stops a running turn, and so does Enter in an empty composer; Esc in an open popover only closes it", async ({ page }) => {
  await open(page);
  await running(page, "stop me with Esc");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status")).toBeHidden();
  await expect(page.getByText("cancelled").first()).toBeVisible();
  await expect(page.getByText(REPLY)).toHaveCount(0);

  await running(page, "stop me with Enter");
  await expect(box(page)).toHaveValue("");
  await box(page).press("Enter");
  await expect(page.getByTestId("status")).toBeHidden();
  await expect(page.getByText("cancelled")).toHaveCount(2);

  // a popover open over the composer takes Esc for itself: the turn goes on to its reply
  await send(page, "let me finish");
  await page.getByRole("button", { name: /^Follow-ups:/ }).click();
  const popover = page.getByRole("dialog");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("cancelled")).toHaveCount(2);
});

const LOG = Array.from({ length: 80 }, (_, k) => `10:${String(k % 60).padStart(2, "0")} worker[${k}]: step ${k} ok`).join("\n");

test("a long paste folds into a chip that opens and can be removed; the message logged has it whole, and its bubble folds it", async ({ page, server }) => {
  await open(page);
  await box(page).fill("why so slow?\n");
  // a paste as the browser makes one, at the caret
  await box(page).evaluate((el, text) => {
    if (!(el instanceof HTMLTextAreaElement)) return;
    el.setSelectionRange(el.value.length, el.value.length);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, LOG);
  await expect(box(page)).toHaveValue("why so slow?\n[Pasted text #1, 80 lines]");
  const chip = page.getByTestId("pasted-chip");
  await expect(chip).toContainText("80 lines");
  await chip.getByRole("button", { name: /show it/ }).click();
  await expect(page.getByTestId("paste-preview")).toContainText("worker[79]: step 79 ok");
  await box(page).press("Enter");

  const sent = `why so slow?\n${LOG}`;
  await expect.poll(async () => (await server.log()).some((e) => e.kind === "user" && e.text === sent)).toBe(true);
  const bubble = page.getByTestId("user-message").filter({ hasText: "why so slow?" });
  const fold = bubble.getByTestId("pasted-fold");
  await expect(fold).toBeVisible();
  await expect(fold.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  // folded: its summary line and two lines of the block, not 80
  const closed = (await fold.boundingBox())?.height ?? Number.POSITIVE_INFINITY;
  expect(closed).toBeLessThan(100);
  await fold.getByRole("button").click();
  await expect(fold).toContainText("worker[79]: step 79 ok");
  expect((await fold.boundingBox())?.height).toBeGreaterThan(closed * 5);
  await expect(page.getByTestId("pasted-chip")).toHaveCount(0);
});

test.describe("file tools", () => {
  test.use({ edits: true });

  test("an Edit is a diff that grows as its input streams, with its counts; a Write is a closed new file; the input stays behind the line", async ({ page }) => {
    await open(page);
    await send(page, "move the trip a day");
    const diff = page.getByTestId("tool-diff");
    await expect(diff).toBeVisible();
    // seen first while the new text was still coming: fewer added lines than in the end
    const first = await diff.locator('[data-diff="add"]').count();
    await expect(diff.locator('[data-diff="add"]')).toHaveCount(5, { timeout: 15_000 });
    expect(first).toBeLessThan(5);
    await expect(diff.locator('[data-diff="del"]')).toHaveCount(1);
    await expect(diff.locator('[data-diff="del"]')).toContainText('to: "Oct 8",');
    await expect(page.getByTestId("diff-stat")).toContainText("+5 −1");
    await expect(page.getByText(EDIT_INPUT.file_path)).toBeVisible();

    const toggle = page.getByTestId("new-file-toggle");
    await expect(toggle).toHaveText("New file · 6 lines", { timeout: 15_000 });
    await expect(page.getByTestId("new-file")).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId("new-file")).toContainText("- rain jacket");
    await expect(page.getByText(WRITE_INPUT.file_path)).toBeVisible();

    // the raw input, as logged, behind the Edit's line
    await page.getByText("Edit", { exact: true }).click();
    await expect(page.getByText("Input").first()).toBeVisible();
    await expect(page.getByText(REPLY)).toBeVisible({ timeout: 15_000 });
  });
});

test("a page from another build is told OptChat was updated, and doesn't reconnect", async ({ page }) => {
  // this page names a wire the server doesn't speak, as one left open across a deploy would
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(String(url).replace(/wire=\d+/, "wire=0"), protocols);
      }
    };
  });
  let sockets = 0;
  page.on("websocket", () => {
    sockets++;
  });
  await page.goto("/");
  const banner = page.getByTestId("outdated");
  await expect(banner).toContainText("OptChat was updated — reload");
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("img", { name: "connection outdated" })).toHaveAttribute("title", "OptChat was updated: reload");
  await page.waitForTimeout(3000); // the link's first retry is 1 s, then 2 s
  expect(sockets).toBe(1);
  await expect(page.getByTestId("status")).toHaveCount(0);
});
