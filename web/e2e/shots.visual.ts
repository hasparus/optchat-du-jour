// Screenshots of the main states, for a before/after diff (not part of `bun run e2e`: `SHOTS_DIR=<dir>
// bun run shots`). Fake data only: the e2e server's fake claude. SHOTS_NEW=1 adds the states that
// didn't exist before this round's patterns (the model menu).
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { answered, attach, expect, open, send, test, THOUGHT } from "./fixture";

const dir = process.env.SHOTS_DIR ?? "shots";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${dir}/${name}.png` });
}

const themed = async (page: Page, theme: "light" | "dark") => {
  await page.addInitScript((t) => {
    localStorage.setItem("theme", t);
  }, theme);
};

for (const theme of ["light", "dark"] as const) {
  for (const [form, viewport] of [["phone", { height: 844, width: 390 }], ["desktop", { height: 800, width: 1280 }]] as const) {
    test.describe(`${form} ${theme}`, () => {
      test.use({ viewport });
      test("chat", async ({ page }) => {
        await themed(page, theme);
        await open(page);
        await shot(page, `${form}-${theme}-empty`);
        await send(page, "hello there");
        await answered(page, "hello there");
        await shot(page, `${form}-${theme}-turn`);
        await page.getByText(/^Bash/).click();
        await shot(page, `${form}-${theme}-tool-open`);
        await page.getByLabel("Message").fill("a draft with a photo");
        await attach(page, { buffer: png, mimeType: "image/png", name: "dot.png" });
        await expect(page.getByTestId("attachment")).toHaveAttribute("data-state", "done");
        await shot(page, `${form}-${theme}-tray`);
        await page.getByRole("button", { name: /^Follow-ups:/ }).click();
        await shot(page, `${form}-${theme}-followups`);
        await page.keyboard.press("Escape");
        if (form === "desktop" && process.env.SHOTS_NEW) {
          await page.getByTestId("model-picker").click();
          await shot(page, `${form}-${theme}-model-menu`);
          await page.keyboard.press("Escape");
        }
        if (form === "desktop") {
          await page.getByRole("button", { name: /^Background work/ }).click();
          await shot(page, `${form}-${theme}-background`);
          await page.keyboard.press("Escape");
        }
        for (const tab of ["memory", "stats", "devices"]) {
          await page.getByRole("tab", { name: tab }).click();
          await page.waitForTimeout(600);
          await shot(page, `${form}-${theme}-${tab}`);
        }
      });
    });
  }
}

test.describe("phone touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });
  test("add context and reply actions", async ({ page }) => {
    await open(page);
    await send(page, "hello there");
    await page.getByRole("button", { name: "Send" }).click().catch(() => null);
    await answered(page, "hello there");
    await page.getByText("Streamed reply from the fake claude.").tap();
    await shot(page, "touch-reply-actions");
    await page.getByRole("button", { name: "Add context" }).tap();
    await shot(page, "touch-add-context");
  });
});

test.describe("held", () => {
  test.use({ spent: true, viewport: { height: 844, width: 390 } });
  test("banner", async ({ page }) => {
    await open(page);
    await send(page, "spend it");
    await expect(page.getByText(/Choose how to go on/)).toBeVisible({ timeout: 15_000 });
    await shot(page, "phone-light-held");
  });
});

test.describe("failed tool", () => {
  test.use({ toolError: true, viewport: { height: 844, width: 390 } });
  test("row", async ({ page }) => {
    await open(page);
    await send(page, "list it");
    await answered(page, "list it");
    await page.getByText(/^Bash/).click();
    await shot(page, "phone-light-tool-failed");
  });
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`patterns ${theme}`, () => {
    test.use({ patterns: true, viewport: { height: 844, width: 390 } });
    test("plan and sources", async ({ page }) => {
      await themed(page, theme);
      await open(page);
      await send(page, "look it up");
      await expect(page.locator('[data-slot="plan-progress"]').first()).toHaveText("0 of 3 done");
      await shot(page, `patterns-${theme}-live`);
      await answered(page, "look it up");
      await page.getByText(/^Used 2 sources/).click();
      await shot(page, `patterns-${theme}-done`);
    });
  });
}

test.describe("tray states", () => {
  test.use({ viewport: { height: 844, width: 390 } });
  test("error and uploading", async ({ page }) => {
    await open(page);
    let puts = 0;
    await page.route("**/api/assets**", async (route) => {
      if (route.request().method() !== "PUT" || puts++ > 0) return route.continue();
      await new Promise((resolve) => {
        setTimeout(resolve, 60_000);
      });
      return route.abort().catch(() => null);
    });
    await attach(page, { buffer: png, mimeType: "image/png", name: "slow.png" });
    await attach(page, { buffer: Buffer.from("not an image at all"), mimeType: "image/png", name: "bad.png" });
    await page.waitForTimeout(1500);
    await shot(page, "tray-states");
  });
});

test.describe("sent photo", () => {
  test.use({ viewport: { height: 844, width: 390 } });
  test("thumbnail", async ({ page }) => {
    await open(page);
    const photo = await sharp({ create: { background: "#3a7", channels: 3, height: 480, width: 640 } })
      .png()
      .toBuffer();
    await attach(page, { buffer: photo, mimeType: "image/png", name: "board.png" });
    await expect(page.getByTestId("attachment")).toHaveAttribute("data-state", "done");
    await send(page, "what is on the board?");
    await answered(page, "what is on the board?");
    await shot(page, "sent-photo");
  });
});

// What the model thought (SPEC "Reasoning"): a turn of the fake claude that thinks before its tool
// call (E2E_THINKING), live and shimmering, opened, and after a reload
for (const theme of ["light", "dark"] as const) {
  for (const [form, viewport] of [["phone", { height: 844, width: 390 }], ["desktop", { height: 800, width: 1280 }]] as const) {
    test.describe(`reasoning ${form} ${theme}`, () => {
      test.use({ thinking: true, viewport });
      test("reasoning", async ({ page }) => {
        await themed(page, theme);
        await open(page);
        await send(page, "what is here?");
        const line = page.locator('[data-slot="reasoning"]');
        await expect(line.getByRole("button")).toHaveText("Thinking…");
        await page.waitForTimeout(700);
        await page.screenshot({ caret: "hide", path: `${dir}/reasoning-${form}-${theme}-live.png` }); // the sweep caught mid-way
        await answered(page, "what is here?");
        await shot(page, `reasoning-${form}-${theme}-done`);
        await line.getByRole("button").click();
        await expect(line.locator('[data-slot="reasoning-text"]')).toHaveText(THOUGHT);
        await shot(page, `reasoning-${form}-${theme}-open`);
        await page.reload();
        await expect(page.locator('[data-slot="reasoning"]')).toHaveCount(1);
        await shot(page, `reasoning-${form}-${theme}-reloaded`);
      });
    });
  }
}
