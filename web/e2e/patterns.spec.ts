// AI Elements' Plan and Sources on what the log holds (SPEC "Web UI", Chat): a turn of the fake
// claude that writes a todo list (TodoWrite), searches the web and fetches a page before its reply
// (E2E_PATTERNS). Each reads the same live and after a reload, since both come from the log.
import type { Page } from "@playwright/test";
import { answered, expect, expectShowsLog, FETCHED, open, REPLY, SEARCH_LINKS, send, test } from "./fixture";

test.use({ patterns: true });

const plans = (page: Page) => page.locator('[data-slot="plan"]');

async function sourcesOf(page: Page) {
  const reply = page.locator("[data-reply]").filter({ hasText: REPLY });
  const sources = reply.locator('[data-slot="sources"]');
  await expect(sources).toContainText("Used 2 sources");
  await sources.getByText("Used 2 sources").click();
  return sources.locator('[data-slot="source"]');
}

test("a turn's TodoWrite calls read as one plan: live, its step in progress and how far it got; then done", async ({ page, server }) => {
  await open(page);
  await send(page, "look it up");
  // the first call: one step in progress, in its present tense, and the line shimmers
  const plan = plans(page);
  await expect(plan.locator('[data-slot="plan-progress"]')).toHaveText("0 of 3 done");
  await expect(plan.locator('[data-slot="trace-line"][data-status="running"]').first()).toBeVisible();
  await expect(plan.getByText("Searching the web", { exact: true })).toBeVisible();
  await answered(page, "look it up");
  // the second call is the turn's plan now: one plan, open, every step done, nothing shimmering;
  // the first call reads as a plain tool line
  const done = async () => {
    await expect(plans(page)).toHaveCount(1);
    await expect(plan.locator('[data-slot="plan-progress"]')).toHaveText("3 of 3 done");
    await expect(plan.locator('[data-step="completed"]')).toHaveCount(3);
    await expect(plan).toHaveAttribute("data-state", "open");
    await expect(page.locator('[data-slot="plan"] [data-status="running"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="tool"]').filter({ hasText: "TodoWrite" })).toHaveCount(1);
  };
  await done();
  // its input as logged is a line under the steps
  await expect(plan.getByText('"status":"completed"', { exact: false })).toHaveCount(0);
  await plan.getByText("Input and output").click();
  await expect(plan.getByText('"status":"completed"', { exact: false }).first()).toBeVisible();
  await expectShowsLog(page, server);
  // a reload reads the same from the snapshot
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  await done();
});

test("the links a turn's web tools used are its reply's sources, live and after a reload", async ({ page, server }) => {
  await open(page);
  await send(page, "look it up");
  await answered(page, "look it up");
  const links = await sourcesOf(page);
  // the search's links, the fetched page once (it was also a search result), in order
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", FETCHED);
  await expect(links.nth(0)).toContainText(SEARCH_LINKS[0]?.title ?? "");
  await expect(links.nth(1)).toHaveAttribute("href", SEARCH_LINKS[1]?.url ?? "");
  await expect(links.nth(0)).toHaveAttribute("target", "_blank");
  await expect(links.nth(0)).toHaveAttribute("rel", "noreferrer");
  await expectShowsLog(page, server);
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  const again = await sourcesOf(page);
  await expect(again).toHaveCount(2);
  await expect(again.nth(1)).toHaveAttribute("href", SEARCH_LINKS[1]?.url ?? "");
  // the web tools' own lines are still there, with their input as logged
  await expect(page.locator('[data-slot="tool"]').filter({ hasText: "WebSearch" })).toBeVisible();
  await expect(page.locator('[data-slot="tool"]').filter({ hasText: "WebFetch" })).toBeVisible();
});
