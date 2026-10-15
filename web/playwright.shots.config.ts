// Screenshots of the main states for a before/after diff of a visual change (e2e/shots.visual.ts),
// not checks: `SHOTS_DIR=<dir> bun run shots` on each side, then compare the two folders.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /\.visual\.ts$/,
  fullyParallel: true,
  reporter: "list",
  timeout: 90_000,
  use: { ...devices["Desktop Chrome"], viewport: { height: 740, width: 360 } },
});
