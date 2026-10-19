// Screenshots of the artifacts' states (SPEC "Artifacts"; not part of `bun run e2e`: `SHOTS_DIR=<dir>
// bun run shots`): a live draft, a card, the pane and its version picker, on a phone and a desktop,
// light and dark. Fake data only: the e2e server's fake claude publishes LANDING, then edits it.
import type { Page } from "@playwright/test";
import { answered, expect, open, send, test } from "./fixture";

const dir = process.env.SHOTS_DIR ?? "shots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${dir}/artifacts-${name}.png` });
}

test.use({ artifacts: "ui" });

for (const theme of ["light", "dark"] as const) {
  for (const [form, viewport] of [["phone", { height: 844, width: 390 }], ["desktop", { height: 800, width: 1280 }]] as const) {
    test.describe(`${form} ${theme}`, () => {
      test.use({ colorScheme: theme, viewport });
      test("artifacts", async ({ page }) => {
        await page.addInitScript((t) => {
          localStorage.setItem("theme", t);
        }, theme);
        await open(page);
        await send(page, "plan my Lisbon weekend as a page");
        const drafting = page.getByTestId("artifact-draft-card");
        await expect(drafting).toBeVisible();
        await page.waitForTimeout(1200);
        await shot(page, `${form}-${theme}-draft-card`);
        await drafting.click();
        await expect(page.frameLocator('[data-testid="artifact-draft-frame"]').locator("#heading")).toBeVisible();
        await shot(page, `${form}-${theme}-draft-pane`);
        await answered(page, "plan my Lisbon weekend as a page");
        await expect(page.getByTestId("artifact-draft")).toHaveCount(0);
        await page.waitForTimeout(800);
        if (form === "phone") {
          await page.keyboard.press("Escape");
          await expect(page.getByTestId("artifact-sheet")).toBeHidden();
        }
        await send(page, "call it a long weekend");
        await answered(page, "call it a long weekend");
        await expect(page.getByTestId("artifact-card")).toHaveCount(2);
        await shot(page, `${form}-${theme}-cards`);
        await page.getByTestId("artifact-card").nth(1).click();
        await expect(page.frameLocator('[data-testid="artifact-frame"]').frameLocator("iframe").locator("#ran")).toHaveText("scripts run");
        await shot(page, `${form}-${theme}-pane`);
        // the native select's menu is the system's own and draws in no screenshot: its options, shown
        await page.getByLabel("Version").selectOption("1");
        await expect(page.frameLocator('[data-testid="artifact-frame"]').frameLocator("iframe").locator("#heading")).toHaveText("Weekend in Lisbon");
        await shot(page, `${form}-${theme}-version-1`);
      });
    });
  }
}
