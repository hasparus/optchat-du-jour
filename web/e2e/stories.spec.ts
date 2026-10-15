// The story page (web/stories.html, src/stories): UI the server has no data for yet, served by
// Vite's dev server (the build never takes it). Today AI Elements' Subagent, which SPEC M7 will
// feed: each state alone, and the Background work sheet's slot filled with them.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";

// a port the OS just gave out and took back (Playwright runs these in Node, not Bun)
const freePort = async () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && address instanceof Object && "port" in address ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });

const web = fileURLToPath(new URL("..", import.meta.url));

const test = base.extend<object, { stories: string }>({
  stories: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern, and this one has none
    async ({}, provide) => {
      const port = await freePort();
      const child: ChildProcess = spawn("./node_modules/.bin/vite", ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: web, stdio: "ignore" });
      const url = `http://127.0.0.1:${port}/stories.html`;
      for (let tries = 0; tries < 300; tries++) {
        try {
          const answer = await fetch(url);
          if (answer.ok) break;
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      await provide(url);
      child.kill("SIGKILL");
    },
    { scope: "worker" },
  ],
});

test("a subagent's four states: running (open, Stop, Tell), finished with its report, failed and stopped with why", async ({ page, stories }) => {
  await page.goto(stories);
  const running = page.getByTestId("story-running");
  await expect(running.getByText("Running scout")).toBeVisible();
  await expect(running.locator('[data-slot="trace-line"][data-status="running"]').first()).toBeVisible();
  await expect(running.getByText("on macbook")).toBeVisible();
  await expect(running.getByText("Find every TODO in the demo repo")).toBeVisible();
  // its steps are tool lines: the last one, with no output yet, still runs
  const steps = running.locator('[data-slot="subagent-steps"] [data-slot="tool"]');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1).locator('[data-slot="trace-line"]')).toHaveAttribute("data-status", "running");
  await running.getByLabel("Tell scout").fill("skip the vendored code");
  await running.getByRole("button", { name: "Send to scout" }).click();
  await expect(running.getByLabel("Tell scout")).toHaveValue("");
  await running.getByRole("button", { name: "Stop scout" }).click();
  await expect(page.getByTestId("story-calls")).toHaveText(["tell scout: skip the vendored code", "stop scout"].join(""));

  const finished = page.getByTestId("story-finished");
  await expect(finished.getByText("Ran notes")).toBeVisible();
  await expect(finished.locator('[data-slot="subagent-report"]')).toContainText("the newest (Oct 3) has the dates");
  await expect(finished.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await expect(finished.getByLabel(/^Tell/)).toHaveCount(0);

  const failed = page.getByTestId("story-failed");
  await expect(failed.getByText("Failed to run builder")).toBeVisible();
  await expect(failed.locator('[data-slot="trace-line"][data-status="error"]').first()).toBeVisible();
  await expect(failed.locator('[data-slot="subagent-reason"]')).toHaveText("usage limit: Claude AI usage limit reached");

  await expect(page.getByTestId("story-stopped").getByText("Stopped reader")).toBeVisible();
});

test("the Background work sheet's subagent slot: a group of its own, Stop and Tell from there", async ({ page, stories }) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto(stories);
  await page.getByRole("button", { name: "Background work with subagents" }).click();
  const sheet = page.getByTestId("background-work");
  await expect(sheet.getByText("Subagents")).toBeVisible();
  await expect(sheet.getByTestId("work-subagent")).toHaveCount(4);
  // the running one is open; the others are one line each
  await expect(sheet.getByLabel("Tell scout")).toBeVisible();
  await expect(sheet.locator('[data-slot="subagent"][data-state="open"]')).toHaveCount(1);
  await sheet.getByRole("button", { name: "Stop scout" }).click();
  await expect(page.getByTestId("story-calls")).toHaveText("stop scout");
});

// screenshots for a look (not checks): STORY_SHOTS=<dir>
for (const theme of ["light", "dark"] as const) {
  test(`shots: subagents, ${theme}`, async ({ page, stories }) => {
    test.skip(process.env.STORY_SHOTS === undefined, "only when asked for screenshots");
    const dir = process.env.STORY_SHOTS ?? "";
    await page.setViewportSize({ height: 1100, width: 390 });
    await page.goto(`${stories}?theme=${theme}`);
    await page.waitForTimeout(500);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${dir}/subagents-${theme}.png` });
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.getByRole("button", { name: "Background work with subagents" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ animations: "disabled", path: `${dir}/subagents-sheet-${theme}.png` });
  });
}
