// Screenshots of Background work with subagents (SPEC "Subagents", M7b), not checks: an isolated
// subagent running on its branch, then merged back (fake data only: the e2e server's fake claude).
// `SHOTS_DIR=<dir> bun run shots -- subagents`.
import type { Page } from "@playwright/test";
import { answered, expect, open, send, test } from "./fixture";

const dir = process.env.SHOTS_DIR ?? "shots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${dir}/${name}.png` });
}

test.use({ isolated: true });

for (const theme of ["light", "dark"] as const) {
  for (const [form, viewport] of [["phone", { height: 844, width: 390 }], ["desktop", { height: 800, width: 1280 }]] as const) {
    test(`${form} ${theme}: an isolated subagent, running and merged`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((t) => {
        localStorage.setItem("theme", t);
      }, theme);
      await open(page);
      await send(page, "add a changelog entry, on a branch");
      await answered(page, "add a changelog entry, on a branch");
      await page.getByRole("tab", { name: "devices" }).click();
      await page.getByTestId("devices").getByRole("button", { name: "Background work" }).click();
      const fixer = page.getByTestId("subagent-fixer");
      await expect(fixer.getByText("optchat/fixer")).toBeVisible();
      await shot(page, `subagents-${form}-${theme}-running`);
      await expect(fixer.getByText("Ran fixer")).toBeVisible({ timeout: 15_000 });
      // its report wakes the master: once that turn is over, the card is opened if it is closed
      await expect(page.getByTestId("stop-all")).toBeHidden({ timeout: 15_000 });
      if (!(await fixer.getByText(/Merged into main/).isVisible())) await fixer.getByText("Ran fixer").click();
      await expect(fixer.getByText(/Merged into main/)).toBeVisible();
      await shot(page, `subagents-${form}-${theme}-merged`);
    });
  }
}
