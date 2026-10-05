// End-to-end tests (SPEC "Web UI"): the real server with a fake `claude`, the built UI, Chromium
// at a phone's 360 px. Run `bun run e2e` in web/ (it builds web/dist first).
import { defineConfig, devices } from "@playwright/test";

const port = 7791;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1, // one server, one log: the tests run in order
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { height: 740, width: 360 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/server.ts",
    env: { E2E_PORT: String(port) },
    url: `http://127.0.0.1:${port}/api/state`,
    reuseExistingServer: false,
  },
});
