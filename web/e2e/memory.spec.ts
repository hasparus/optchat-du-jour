// The live memory view (E46, E47) end to end: the real server, with tiny view marks and the fake
// claude as a compactor that takes MEMORY_WAIT per call (E2E_MEMORY). In the chat's Memory mode a
// long message's line waits for its summary under the shimmer, and the summary shows when the
// compactor writes it (in that line, or in the merge that took it: with these marks the turn's next
// entry may fold it at once); a later message merges the view into a summary that opens in place,
// and "Show in the log" lands on its first message. All on one page load: nothing is reloaded.
import type { Page } from "@playwright/test";
import { expect, MEMORY_SUMMARY, open, send, type Server, test } from "./fixture.ts";

// A turn is over: its reply is in the log, then the status line goes. Not by the message's bubble,
// as the log's tests wait: in Memory mode a long message may already be folded into a summary.
async function replied(page: Page, server: Server, replies: number) {
  const talks = async () => {
    const log = await server.log();
    return log.filter((e) => e.kind === "talk").length;
  };
  await expect.poll(talks, { timeout: 20_000 }).toBe(replies);
  await expect(page.getByTestId("status")).toBeHidden({ timeout: 15_000 });
}

test.use({ memory: true });

test("a summary appears in the chat's Memory mode and fills in live, without a reload", async ({ page, server }) => {
  await open(page);
  await page.evaluate(() => Object.assign(globalThis, { sameLoad: true }));
  await page.getByRole("button", { name: "Memory" }).click();
  await expect(page.getByRole("button", { name: "Memory" })).toHaveAttribute("aria-pressed", "true");

  // past NODE: the compactor has to summarize it (MEMORY_WAIT, 2.5 s)
  await send(page, `remember this: ${"a long note to keep. ".repeat(40)}`);
  const line = page.locator('[data-testid="memory-block"][data-node="0:0"]');
  await expect(line).toHaveAttribute("data-built", "false");
  await expect(line.getByText("Summarizing…").first()).toBeVisible();
  // written: the summary shows, live, wherever the view now has it
  await expect(page.getByTestId("memory-block").filter({ hasText: MEMORY_SUMMARY }).first()).toBeVisible({ timeout: 15_000 });
  await replied(page, server, 1);

  // a second long one takes the view past its high mark: the oldest lines merge into a summary
  await send(page, `and this as well: ${"another long note. ".repeat(40)}`);
  const merged = page.locator('[data-testid="memory-block"][data-node^="1:"], [data-testid="memory-block"][data-node^="2:"], [data-testid="memory-block"][data-node^="3:"]').first();
  await expect(merged).toBeVisible({ timeout: 20_000 });
  await replied(page, server, 2);
  const node = (await merged.getAttribute("data-node")) ?? "";
  const block = page.locator(`[data-testid="memory-block"][data-node="${node}"]`);
  await block.click();
  await expect(block.getByTestId("memory-inside")).toBeVisible();

  // its first message, in the log
  const [l = 0, i = 0] = node.split(":").map(Number);
  await block.getByRole("button", { name: "Show in the log" }).click();
  await expect(page.getByRole("button", { name: "Log" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-region="chat-content"] > [data-log-index="${i * 2 ** l}"]`)).toBeInViewport();

  expect(await page.evaluate(() => "sameLoad" in globalThis)).toBe(true);
});
