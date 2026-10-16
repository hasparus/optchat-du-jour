// Subagents (SPEC M7a), end to end with the fake claude (E2E_SUBAGENTS): a turn spawns "notes"
// and "scout" over /mcp; their cards show in Background work, notes done with its report and scout
// running; a message from scout's card reaches it, it finishes, and its report reaches the chat as
// a user message starting "[scout] ".
import { answered, expect, NOTES_REPORT, open, SCOUT_REPORT, SCOUT_TASK, send, SPAWNED, test } from "./fixture";

test.use({ subagents: true });

test("start subagents, see their cards, tell one something; it finishes and its report reaches the chat", async ({ page, server }) => {
  await open(page);
  await send(page, "find the trip dates, with subagents");
  await answered(page, "find the trip dates, with subagents");
  await expect(page.getByText(SPAWNED)).toBeVisible();
  // a phone: Background work opens from Devices
  await page.getByRole("tab", { name: "devices" }).click();
  await page.getByTestId("devices").getByRole("button", { name: "Background work" }).click();
  const sheet = page.getByRole("dialog", { name: "Background work" });
  await expect(sheet.getByRole("button", { name: "Subagents" })).toBeVisible();
  const scout = sheet.getByTestId("subagent-scout");
  const notes = sheet.getByTestId("subagent-notes");
  await expect(scout.getByText("Running scout")).toBeVisible();
  await expect(scout.getByText(SCOUT_TASK)).toBeVisible();
  await expect(scout.getByTestId("subagent-model-scout")).toContainText("Opus");
  await expect(notes.getByText("Ran notes")).toBeVisible();
  // the model the master picked for notes: Opus at low
  await notes.getByText("Ran notes").click();
  await expect(notes.getByTestId("subagent-model-notes")).toContainText("low");
  await expect(notes).toContainText(NOTES_REPORT);
  await expect(notes.getByText("Grep")).toBeVisible();

  // a message from scout's card, which it waits for
  await scout.getByLabel("Tell scout").fill("check the October notes");
  await scout.getByRole("button", { name: "Send to scout" }).click();
  await expect(scout.getByText("Ran scout")).toBeVisible({ timeout: 15_000 });
  await expect(scout).toContainText(SCOUT_REPORT);
  await expect(scout.getByText("Read")).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();

  // both reports are in the chat, as user messages starting "[Name] "; nothing else they did is
  await page.getByRole("tab", { name: "chat" }).click();
  await expect(page.getByTestId("user-message").filter({ hasText: `[scout] ${SCOUT_REPORT}` })).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: `[notes] ${NOTES_REPORT}` })).toBeVisible();
  const logged = await server.log();
  expect(logged.filter((e) => e.text.startsWith("[")).map((e) => e.text)).toEqual([`[notes] ${NOTES_REPORT}`, `[scout] ${SCOUT_REPORT}`]);
  expect(logged.some((e) => e.text.includes("check the October notes") || e.text.includes("trip: Oct 3 to Oct 9"))).toBe(false);
});
