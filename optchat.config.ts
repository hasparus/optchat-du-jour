// This machine's optchat (SPEC "Constants and configuration"). The compactor runs on the ChatGPT
// plan (E5) once `optchat login openai` has been run; until then, and whenever the plan's limit is
// spent, each node falls over to claude-code:sonnet at medium effort, as the reference runs it
// (ref §7). Model ids as OpenAI's docs name them in Oct 2026 (gpt-6-luna, gpt-6.1-sol), not yet
// checked against the models this plan token lists. The level cutoff (3) waits for the bake-off.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  master: {
    chain: ["claude-code:opus"],
    effort: "high",
    permissionMode: "bypassPermissions", // ref D9
  },
  compactor: {
    byLevel: [
      { from: 0, chain: ["openai-plan:gpt-6-luna", "claude-code:sonnet"] },
      { from: 3, chain: ["openai-plan:gpt-6.1-sol", "claude-code:sonnet"] },
    ],
    effort: "medium",
  },
  cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["1h", "5m", "5m", "5m"] },
  devices: {
    mini: { url: "http://optchat-mini:7710", folders: ["~/repos", "~/notes"] },
    macbook: { url: "http://optchat-macbook:7710", folders: ["~/repos"] },
  },
  defaultDevice: "mini",
  // turns on another device reach zoom and date through the server's tailnet URL (E8):
  // server: { host: "127.0.0.1", port: 7700, publicUrl: "https://<mini>.<tailnet>.ts.net" },
  allowedLogins: [],
});
