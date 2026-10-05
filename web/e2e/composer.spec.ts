// The composer against the real server (SPEC "Web UI", Chat; "Turn and priming"): a draft that
// outlives a reload, follow-ups queued for the next turn, sent now, or taken back, and the model
// picker, also when a usage limit stops a turn. 360 px wide, like the other specs.
import type { Page } from "@playwright/test";
import { answered, expect, expectShowsLog, open, REPLY, send, SOL_REPLY, test } from "./fixture";

const box = (page: Page) => page.getByLabel("Message");

// the session's follow-up behavior, from the composer's popover
async function followUps(page: Page, mode: "Steer" | "Queue") {
  await page.getByRole("button", { name: /^Follow-ups:/ }).click();
  await page.getByRole("button", { name: new RegExp(`^${mode}`) }).click();
  await expect(page.getByRole("button", { name: `Follow-ups: ${mode.toLowerCase()}` })).toBeVisible();
  await page.keyboard.press("Escape");
}

test("a draft survives a reload: its text and its uploaded photo", async ({ page }) => {
  await open(page);
  await box(page).fill("a thought to finish later");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.getByLabel("Attach: files").setInputFiles({ buffer: png, mimeType: "image/png", name: "dot.png" });
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-state", "done");
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await expect(box(page)).toHaveValue("a thought to finish later");
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("attachment").getByRole("img")).toHaveAttribute("src", /^\/api\/assets\/[0-9a-f]{12}\/thumb$/);
  // sent, the draft is gone; a reload brings nothing back
  await box(page).press("Enter");
  await answered(page, "a thought to finish later");
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await expect(page.getByTestId("attachments")).toBeHidden();
});

test("queue: a follow-up sent mid-run waits, shown as queued, and gets a turn of its own", async ({ page, server }) => {
  await open(page);
  await followUps(page, "Queue");
  await send(page, "start something");
  await expect(page.getByTestId("status")).toContainText("running");
  await expect(box(page)).toHaveAttribute("placeholder", "Queue a follow-up");
  await send(page, "and after that");
  const item = page.getByTestId("queue-item").filter({ hasText: "and after that" });
  await expect(item).toHaveAttribute("data-state", "queued");
  await expect(item.getByTestId("queue-where")).toHaveText("queued for the next turn");
  // the first turn ends without it; the next turn answers it
  await expect(page.getByTestId("queue")).toBeHidden({ timeout: 15_000 });
  await answered(page, "and after that");
  const log = await server.log();
  expect(log.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["start something", "and after that"]);
  expect(log.filter((e) => e.kind === "talk").map((e) => e.text)).toEqual([REPLY, REPLY]);
  // the follow-up waited for the turn after: the first turn's claude never read it
  expect(server.fakeInputs("turn").filter((c) => JSON.stringify(c).includes("and after that"))).toHaveLength(1);
  await expectShowsLog(page, server);
});

test("take-back: a queued follow-up comes back into the composer and is never sent", async ({ page, server }) => {
  await open(page);
  await followUps(page, "Queue");
  await send(page, "a long job");
  await expect(page.getByTestId("status")).toContainText("running");
  await send(page, "oops, not this");
  await page.getByRole("button", { name: "Take back: oops, not this" }).click();
  await expect(box(page)).toHaveValue("oops, not this");
  await expect(box(page)).toBeFocused();
  await expect(page.getByTestId("queue")).toBeHidden();
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  const log = await server.log();
  expect(log.some((e) => e.text.includes("oops"))).toBe(false);
  expect(JSON.stringify(server.fakeInputs("turn"))).not.toContain("oops");
});

test("send now: while the session queues, the other button hands a message to the running turn", async ({ page, server }) => {
  await open(page);
  await followUps(page, "Queue");
  await send(page, "working on it");
  await expect(page.getByTestId("status")).toContainText("running");
  await box(page).fill("look at this too");
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(box(page)).toHaveValue("");
  // offered to the running call at once: its claude reads it on stdin (it never takes it, so the
  // next turn answers it, logged once)
  await expect.poll(() => JSON.stringify(server.fakeInputs("turn")).includes("look at this too")).toBe(true);
  await answered(page, "look at this too");
  const log = await server.log();
  expect(log.filter((e) => e.text === "look at this too")).toHaveLength(1);
  await expectShowsLog(page, server);
});

test("the model picker: a turn on GPT-6.1 Sol is served by the ChatGPT plan; the pick is the server's", async ({ browser, page, server }) => {
  await open(page);
  const model = page.getByLabel("Model");
  await expect(model.locator("option")).toHaveText(["Claude Opus (Claude Code)", "GPT-6.1 Sol (ChatGPT plan)"]);
  await model.selectOption("openai-plan:gpt-6.1-sol");
  await expect(page.getByTestId("model-picker")).toContainText("GPT-6.1 Sol");
  await send(page, "hello Sol");
  await expect(page.getByText(SOL_REPLY)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
  const log = await server.log();
  expect(log.map((e) => [e.kind, e.text])).toEqual([
    ["user", "hello Sol"],
    ["talk", SOL_REPLY],
  ]);
  expect(server.fakeInputs("turn")).toEqual([]); // claude was never asked
  // another page, and this one after a reload, show the same pick
  const other = await browser.newPage({ baseURL: server.url, viewport: { height: 740, width: 360 } });
  await open(other);
  await expect(other.getByTestId("model-picker")).toContainText("GPT-6.1 Sol");
  await other.close();
});

test.describe("a spent Claude plan", () => {
  test.use({ spent: true });

  test("a usage limit stops the turn and waits; picking another model answers the held message there", async ({ page, server }) => {
    await open(page);
    await send(page, "are you there?");
    const alert = page.getByTestId("needs-model");
    await expect(alert).toContainText("Claude Opus (Claude Code): usage limit: Claude AI usage limit reached");
    await expect(page.getByTestId("model-picker")).toHaveClass(/ring-destructive/);
    // held, not answered and not lost
    const held = await server.log();
    expect(held.map((e) => e.kind)).toEqual(["user"]);
    await alert.getByRole("button", { name: "GPT-6.1 Sol (ChatGPT plan)" }).click();
    await expect(page.getByText(SOL_REPLY)).toBeVisible({ timeout: 15_000 });
    await expect(alert).toBeHidden();
    await expect(page.getByTestId("model-picker")).toContainText("GPT-6.1 Sol");
    const log = await server.log();
    expect(log.map((e) => [e.kind, e.text])).toEqual([
      ["user", "are you there?"],
      ["talk", SOL_REPLY],
    ]);
    // Opus shows as unavailable, with why
    await expect(page.getByLabel("Model").locator("option").first()).toHaveText("Claude Opus (Claude Code): unavailable, Claude AI usage limit reached");
    await expectShowsLog(page, server);
  });
});
