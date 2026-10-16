// What the model thought, beside the log (SPEC "Reasoning"): a turn of the fake claude that thinks
// before its tool call (E2E_THINKING). Live, the Reasoning line streams collapsed and shimmering
// in the row its tool call then takes; after a reload it reads the same, its text read from the
// server when it is opened. The log never holds it.
import { answered, expect, expectShowsLog, open, send, test, THOUGHT } from "./fixture";

test.use({ thinking: true });

test("a reply with thinking shows Reasoning live and after a reload", async ({ page, server }) => {
  await open(page);
  await send(page, "what is here?");
  const line = page.locator('[data-slot="reasoning"]');
  const trigger = line.getByRole("button");
  // live: collapsed, its title sweeping, nothing of the thought shown until it is opened
  await expect(trigger).toHaveText("Thinking…");
  await expect(line.locator('[data-slot="trace-line"][data-status="running"]')).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(THOUGHT)).toHaveCount(0);
  await trigger.click();
  await expect(line.locator('[data-slot="reasoning-text"]')).toContainText("They want");
  await answered(page, "what is here?");
  // done: it says how long it took, stays open as the reader left it, and sits above the tool call it came before
  await expect(trigger).toHaveText(/^(Thought for \d+ s|Reasoning)$/);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(line.locator('[data-slot="reasoning-text"]')).toHaveText(THOUGHT);
  const row = page.locator('[data-slot="message-scroller-item"]').filter({ has: line });
  await expect(row).toHaveAttribute("data-kind", "tool");
  await expect(row.locator('[data-slot="tool"]')).toContainText("Bash");
  // the log holds no thought
  const logged = await server.log();
  expect(logged.filter((e) => e.text.includes("A listing first"))).toEqual([]);
  await expectShowsLog(page, server);

  // after a reload: the same line, closed again, its text read only once it is opened
  const label = await trigger.textContent();
  await page.reload();
  await expect(page.getByRole("img", { name: "connection open" })).toBeVisible();
  const again = page.locator('[data-slot="reasoning"]');
  await expect(again).toHaveCount(1);
  await expect(again.getByRole("button")).toHaveText(label ?? "");
  await expect(again.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-slot="message-scroller-item"]').filter({ has: again })).toHaveAttribute("data-kind", "tool");
  const read = page.waitForResponse((r) => r.url().includes("/api/reasoning/text"));
  await again.getByRole("button").click();
  await read;
  await expect(again.locator('[data-slot="reasoning-text"]')).toHaveText(THOUGHT);
  await expectShowsLog(page, server);
});
