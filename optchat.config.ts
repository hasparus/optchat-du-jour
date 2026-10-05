// This machine's optchat (SPEC "Constants and configuration"). The compactor runs on the ChatGPT
// plan (E5) once `optchat login openai` has been run; until then, and whenever the plan's limit is
// spent, each node falls over to claude-code:sonnet at medium effort, as the reference runs it
// (ref §7). Model ids as OpenAI's docs name them in Oct 2026 (gpt-6-luna, gpt-6.1-sol), not yet
// checked against the models this plan token lists. The level cutoff (3) waits for the bake-off.
// The master falls over to Sol on the plan, then to an Anthropic API key (M5); an engine that is
// signed out or has no key fails with a usage limit, so the chain just moves on to the next.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  master: {
    chain: ["claude-code:opus", "openai-plan:gpt-6.1-sol", "api-key:anthropic/claude-opus-5-5"],
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
  // 1-hour entries on the Claude subscription only (E6); an API key's are gist §8's: 3 view
  // marks plus the request end, all 5-minute
  cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["5m", "5m", "5m"] },
  // The api-key engine's price table, $ per million tokens, and its monthly budget (SPEC "Usage and
  // cost tracking"). PLACEHOLDERS: copied from Anthropic's published Opus 5.5 rates as of
  // Sep 2026 (writes at 1.25× input for 5 min, 2× for 1 h; we write 5-minute entries only, the
  // 1-hour rate prices a write the API doesn't split). Verify against the console before relying
  // on the budget. A model without a price here is never called.
  apiKey: {
    monthlyBudget: 20, // the Cursor money
    prices: {
      "anthropic/claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    },
  },
  devices: {
    mini: { url: "http://optchat-mini:7710", folders: ["~/repos", "~/notes"] },
    macbook: { url: "http://optchat-macbook:7710", folders: ["~/repos"] },
  },
  defaultDevice: "mini",
  // turns on another device reach zoom and date through the server's tailnet URL (E8):
  // server: { host: "127.0.0.1", port: 7700, publicUrl: "https://<mini>.<tailnet>.ts.net" },
  allowedLogins: [],
});
