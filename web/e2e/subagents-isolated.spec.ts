// An isolated subagent (SPEC "Subagents", M7b), end to end with the fake claude (E2E_ISOLATED): a
// turn spawns "fixer" isolated in a demo git repository; its card shows its branch while it runs;
// it commits in its worktree and finishes; the card shows its branch merged back with what it
// changed; and its report wakes the master, whose next turn answers without the user's nudge.
import { answered, expect, FIXER_REPORT, FIXER_TASK, open, send, SPAWNED_ISOLATED, test, WOKEN } from "./fixture";

test.use({ isolated: true });

test("spawn isolated: the branch on the card, the merge once it finishes, and the master wakes on the report", async ({ page, server }) => {
  await open(page);
  await send(page, "add a changelog entry, on a branch");
  await answered(page, "add a changelog entry, on a branch");
  await expect(page.getByText(SPAWNED_ISOLATED)).toBeVisible();
  // a phone: Background work opens from Devices
  await page.getByRole("tab", { name: "devices" }).click();
  await page.getByTestId("devices").getByRole("button", { name: "Background work" }).click();
  const sheet = page.getByRole("dialog", { name: "Background work" });
  const fixer = sheet.getByTestId("subagent-fixer");
  await expect(fixer.getByText("Running fixer")).toBeVisible();
  await expect(fixer.getByText(FIXER_TASK)).toBeVisible();
  await expect(fixer.getByText("optchat/fixer")).toBeVisible();
  await expect(sheet.getByTestId("stop-all")).toBeVisible();
  // it finishes: its branch went back into main, with what it changed
  await expect(fixer.getByText("Ran fixer")).toBeVisible({ timeout: 15_000 });
  await fixer.getByText("Ran fixer").click();
  await expect(fixer.getByText("Merged into main (fast-forward): 1 file changed, +1 −0")).toBeVisible();
  await expect(fixer.getByText("optchat/fixer")).toBeVisible();
  await expect(fixer).toContainText(FIXER_REPORT);
  await sheet.getByRole("button", { name: "Close" }).click();

  // its report reached the chat and woke the master: a turn of its own, nobody typed anything
  await page.getByRole("tab", { name: "chat" }).click();
  const report = page.getByTestId("user-message").filter({ hasText: `[fixer] ${FIXER_REPORT}` });
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(report).toContainText("main fast-forwarded to optchat/fixer");
  await expect(page.getByText(WOKEN)).toBeVisible({ timeout: 15_000 });
  const logged = await server.log();
  const texts = logged.map((e) => `${e.kind}: ${e.text.split("\n")[0] ?? ""}`);
  expect(texts.slice(-2)).toEqual([`user: [fixer] ${FIXER_REPORT}`, `talk: ${WOKEN}`]);
  expect(texts.filter((t) => t.startsWith("user:"))).toEqual(["user: add a changelog entry, on a branch", `user: [fixer] ${FIXER_REPORT}`]);
});
