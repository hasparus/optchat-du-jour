// Artifacts in the web UI (SPEC "Artifacts"): a fake turn publishes a page, its input streamed
// slowly; the draft shows while it streams and runs no script; the card appears on the call's row
// and opens the pane (a side panel on a wide screen, a sheet on a phone); a second turn edits it;
// both versions are listed; copy and download give the version's HTML.
import { readFileSync } from "node:fs";
import { answered, ARTIFACT, EDITED, EDITED_HEADING, expect, LANDING, LANDING_HEADING, open, PUBLISHED, send, test } from "./fixture.ts";

test.use({ artifacts: "ui" });

test("a publish streams a scriptless draft, then a card opens the pane; an edit adds a version; copy and download", async ({ page, context }) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await send(page, "plan my Lisbon weekend as a page");

  // while the model writes it: a card for the draft, which opens the pane on the draft
  const drafting = page.getByTestId("artifact-draft-card");
  await expect(drafting).toBeVisible();
  await expect(drafting).toContainText(ARTIFACT);
  await drafting.click();
  const pane = page.getByTestId("artifact-pane");
  await expect(pane).toBeVisible();
  const draft = page.frameLocator('[data-testid="artifact-draft-frame"]');
  await expect(draft.locator("#heading")).toHaveText(LANDING_HEADING);
  // the draft runs no script: its own script would have changed #ran and the body's data-ran
  await expect(draft.locator("#ran")).toHaveText("scripts did not run");
  await expect(draft.locator("body")).not.toHaveAttribute("data-ran", "yes");
  await expect(draft.locator("script")).toHaveCount(0);

  // the call is logged: the card on its row, the version saved, and the page running its scripts
  await answered(page, "plan my Lisbon weekend as a page");
  await expect(page.getByText(PUBLISHED)).toBeVisible();
  const card = page.getByTestId("artifact-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("v1");
  await expect(page.getByTestId("artifact-draft-card")).toHaveCount(0);
  const shown = page.frameLocator('[data-testid="artifact-frame"]').frameLocator("iframe");
  await expect(shown.locator("#ran")).toHaveText("scripts run");
  await expect(page.getByTestId("artifact-draft")).toHaveCount(0);

  // a second turn edits it: a second card, and both versions in the picker
  await send(page, "call it a long weekend");
  await answered(page, "call it a long weekend");
  await expect(page.getByText(EDITED)).toBeVisible();
  await expect(card).toHaveCount(2);
  await expect(card.nth(1)).toContainText("v2");
  await expect(shown.locator("#heading")).toHaveText(EDITED_HEADING);
  const picker = page.getByLabel("Version");
  await expect(picker.locator("option")).toHaveCount(2);
  await picker.selectOption("1");
  await expect(shown.locator("#heading")).toHaveText(LANDING_HEADING);

  // copy: the shown version's HTML, as stored
  await page.getByTestId("artifact-copy").click();
  await expect(page.getByTestId("artifact-pane").getByRole("status")).toHaveText("Copied the HTML");
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(LANDING);
  // download: the same, as <name>-v<n>.html
  const saving = page.waitForEvent("download");
  await page.getByTestId("artifact-download").click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(`${ARTIFACT}-v1.html`);
  expect(readFileSync(await file.path(), "utf8")).toBe(LANDING);
  // open in a new tab: the wrapper route, never the page itself
  await expect(page.getByTestId("artifact-open")).toHaveAttribute("href", `/artifact/frame?name=${ARTIFACT}&v=1`);

  // the first card opens v1 again after following the latest; close
  await page.getByTestId("artifact-close").click();
  await expect(pane).toHaveCount(0);
  await card.nth(1).click();
  await expect(page.getByLabel("Version")).toHaveValue("2");
});

test("on a phone the pane is a sheet from the bottom", async ({ page }) => {
  await open(page);
  await send(page, "plan my Lisbon weekend as a page");
  await answered(page, "plan my Lisbon weekend as a page");
  await page.getByTestId("artifact-card").click();
  const sheet = page.getByTestId("artifact-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: ARTIFACT })).toBeVisible();
  await expect(page.frameLocator('[data-testid="artifact-frame"]').frameLocator("iframe").locator("#ran")).toHaveText("scripts run");
  const box = await sheet.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(600);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
