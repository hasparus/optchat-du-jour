// End-to-end tests (SPEC "Web UI"): the real server with a fake `claude`, the built UI, Chromium
// at a phone's 360 px. Run `bun run e2e` in web/ (it builds web/dist first). Each test starts its
// own server (e2e/fixture.ts), so the tests are independent and run in parallel.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { height: 740, width: 360 },
    trace: "retain-on-failure",
  },
});
