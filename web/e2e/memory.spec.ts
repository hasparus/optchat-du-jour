// The live memory view (E46, E47) end to end: the real server, with tiny view marks and the fake
// claude as a compactor that takes MEMORY_WAIT per call (E2E_MEMORY). In the chat's Memory mode a
// long message's line waits for its summary under the shimmer and fills in when the compactor
// writes it; a later message merges the view into a summary that opens in place. All on one page
// load: nothing is reloaded.
import { answered, expect, MEMORY_SUMMARY, open, send, test } from "./fixture.ts";

test.use({ memory: true });

test("a summary appears in the chat's Memory mode and fills in live, without a reload", async ({ page }) => {
  await open(page);
  await page.evaluate(() => Object.assign(globalThis, { sameLoad: true }));
  await page.getByRole("button", { name: "Memory" }).click();
  await expect(page.getByRole("button", { name: "Memory" })).toHaveAttribute("aria-pressed", "true");

  // past NODE: the compactor has to summarize it
  await send(page, `remember this: ${"a long note to keep. ".repeat(40)}`);
  const line = page.locator('[data-testid="memory-block"][data-node="0:0"]');
  await expect(line).toHaveAttribute("data-built", "false");
  await expect(line.getByText("Summarizing…").first()).toBeVisible();
  await expect(line).toHaveAttribute("data-built", "true", { timeout: 15_000 });
  await expect(line.getByText(MEMORY_SUMMARY)).toBeVisible();
  await answered(page, "remember this:");

  // a second long one takes the view past its high mark: the oldest lines merge into a summary
  await send(page, `and this as well: ${"another long note. ".repeat(40)}`);
  const merged = page.locator('[data-testid="memory-block"]:not([data-level="0"])').first();
  await expect(merged).toBeVisible({ timeout: 20_000 });
  await expect(merged).toHaveAttribute("data-built", "true");
  await merged.click();
  await expect(merged.getByTestId("memory-inside")).toBeVisible();
  await answered(page, "and this as well:");

  expect(await page.evaluate(() => "sameLoad" in globalThis)).toBe(true);
});
