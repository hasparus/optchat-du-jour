// Subagent runs as SPEC M7 would tell them, for the story page (stories.html) and the tests. Fake
// data only: the names, tasks, paths and reports are made up.
import type { SubagentRun } from "@/components/ai-elements/subagent";

export const RUNS: readonly SubagentRun[] = [
  {
    device: "macbook",
    elapsed: "1 min 05 s",
    engine: "Claude Sonnet (Claude Code)",
    name: "scout",
    report: null,
    status: "running",
    steps: [
      { args: '{"pattern":"TODO","path":"~/repos/demo"}', failed: false, key: "s0", name: "Grep", output: "src/app.ts:12: // TODO: retry" },
      { args: '{"file_path":"~/repos/demo/src/app.ts"}', failed: false, key: "s1", name: "Read", output: null },
    ],
    task: "Find every TODO in the demo repo and say which ones block the release.",
  },
  {
    device: "mini",
    elapsed: "48 s",
    engine: "Claude Haiku (Claude Code, xhigh)",
    name: "notes",
    report: "Three notes mention the trip; the newest (Oct 3) has the dates.",
    status: "finished",
    steps: [{ args: '{"pattern":"trip","path":"~/notes"}', failed: false, key: "n0", name: "Grep", output: "~/notes/oct.md:4: trip dates" }],
    task: "Which notes mention the trip, and which is the latest?",
  },
  {
    device: "mini",
    elapsed: "12 s",
    engine: null,
    name: "builder",
    reason: "usage limit: Claude AI usage limit reached",
    report: null,
    status: "failed",
    steps: [{ args: '{"command":"bun run build"}', failed: true, key: "b0", name: "Bash", output: "error: Cannot find module './missing'" }],
    task: "Build the demo and report the first error.",
  },
  {
    device: "macbook",
    elapsed: "3 s",
    engine: "GPT-6.1 Sol (ChatGPT plan)",
    name: "reader",
    reason: "stopped by you",
    report: null,
    status: "stopped",
    steps: [],
    task: "Read the release notes and list breaking changes.",
  },
];
