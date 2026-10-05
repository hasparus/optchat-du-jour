// This machine's optchat (SPEC "Constants and configuration"). Until the openai-plan engine lands
// (M3), the compactor runs on claude-code:sonnet at medium effort, as the reference does (ref §7).
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  master: {
    chain: ["claude-code:opus"],
    effort: "high",
    permissionMode: "bypassPermissions", // ref D9
  },
  compactor: {
    byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }],
    effort: "medium",
  },
  cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["1h", "5m", "5m", "5m"] },
  devices: {
    mini: { url: "http://optchat-mini:7710", folders: ["~/repos", "~/notes"] },
    macbook: { url: "http://optchat-macbook:7710", folders: ["~/repos"] },
  },
  defaultDevice: "mini",
  allowedLogins: [],
});
