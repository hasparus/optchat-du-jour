// This machine's optchat (SPEC "Constants and configuration").
//
// The models below are CHOICES, not decisions: the shipped defaults wait for the bake-off
// (`dev/bakeoff.ts`, TODO.md "The bake-off") and run on subscriptions only (Claude plan,
// ChatGPT plan). API keys are opt-in: see the commented `apiKey` block.
//
// A chain is tried in order; the master's is the per-message picker, and the compactor's moves on
// by itself when an engine is out of usage. An entry is "engine:model" and runs at its role's
// `effort`, clamped down to what its model takes (none for a model that takes none);
// "engine:model@effort" (or { ref, effort }) runs at its own, shown in the picker. Efforts: low,
// medium, high, xhigh, max.
//
// The compactor runs on the ChatGPT plan once `optchat login openai` has been run, and falls over
// to Claude Haiku at xhigh on the Claude plan, as docs/optchat.md §4 has it. OpenAI ids as its docs
// name them in Oct 2026, not yet checked against the models this plan's token lists. The level
// cutoff (3) waits for the bake-off too.
//
// An entry's own effort is checked at load against what its model takes (src/config.ts,
// `claudeEfforts`): Haiku 5.5 (the `haiku` alias) takes all five; Haiku 4.5, Opus 4.0/4.1 and
// Sonnet 4.0/4.5 take none; Opus 4.5 stops at high; Opus 4.6 and Sonnet 4.6 skip xhigh.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  master: {
    chain: ["claude-code:opus", "openai-plan:gpt-6.1-sol"],
    // alternatives: "claude-code:sonnet", "claude-code:opus@xhigh", "openai-plan:gpt-6.1-sol@xhigh",
    // and on an API key (below): "api-key:anthropic/claude-opus-5-5"
    effort: "high",
    permissionMode: "bypassPermissions", // ref D9
  },
  compactor: {
    byLevel: [
      { from: 0, chain: ["openai-plan:gpt-6-luna", "claude-code:haiku@xhigh"] },
      { from: 3, chain: ["openai-plan:gpt-6.1-sol", "claude-code:haiku@xhigh"] },
    ],
    // alternatives (a chain per level; "@effort" or the role's below):
    //   ["claude-code:haiku@xhigh"]                        the spec's choice (docs/optchat.md §4), Claude plan only
    //   ["api-key:anthropic/claude-haiku-5-5@xhigh"]       the same over an API key (apiKey, below)
    //   ["openai-plan:gpt-6-luna", "claude-code:sonnet"]   Sonnet at the role's medium (ref §7); "sonnet@high" for more
    effort: "medium",
  },
  // 1-hour entries on the Claude subscription only (E6); an API key's requests carry
  // docs/optchat.md §3.3's marks (the view's last 4-line block and the request end, all 5-minute),
  // with nothing to set
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  // API keys, off by default (`optchat key anthropic|openai` stores one). To use one, add an
  // "api-key:anthropic/<model>" ref to a chain and uncomment this: a monthly budget in dollars and
  // a price per million tokens for each model used (writes at 1.25× input for 5 minutes, 2× for 1
  // hour; we write 5-minute entries only, the 1-hour rate prices a write the API doesn't split).
  // A model without a price is never called. PLACEHOLDERS: Opus 5.5 as Anthropic published it in
  // Sep 2026; Haiku from the claude-api skill's Oct 2026 table, their cache rates the usual 0.1×,
  // 1.25× and 2× of the input rate, not checked against the console. Verify before relying on the
  // budget.
  // apiKey: {
  //   monthlyBudget: 20, // the Cursor money
  //   prices: {
  //     "anthropic/claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  //     // PLACEHOLDERS. Haiku 5.5, $0.10 in / $0.50 out for prompts up to 100K tokens (more beyond),
  //     // takes every effort; Haiku 4.5 (snapshot claude-haiku-4-5-20251001), $1 / $5, takes none
  //     "anthropic/claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  //     "anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  //   },
  // },
  devices: {
    mini: { url: "http://optchat-mini:7710", folders: ["~/repos", "~/notes"] },
    macbook: { url: "http://optchat-macbook:7710", folders: ["~/repos"] },
  },
  defaultDevice: "mini",
  // turns on another device reach zoom and date through the server's tailnet URL (E8):
  // server: { host: "127.0.0.1", port: 7700, publicUrl: "https://<mini>.<tailnet>.ts.net" },
  allowedLogins: [],
});
