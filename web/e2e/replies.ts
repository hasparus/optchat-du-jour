// What the e2e server's fake engines answer (e2e/server.ts), for the specs to look for.
export const REPLY = "Streamed reply from the fake claude.";
// E2E_THINKING: what every Claude turn thinks before its tool call (SPEC "Reasoning")
export const THOUGHT = "They want to see what is here. A listing first, then a short answer.";
export const SOL_REPLY = "Answered by the fake ChatGPT plan.";
// the tool's output when E2E_TOOL_ERROR fails it: nothing in the text says it failed, only the flag
export const TOOL_ERROR = "ls: cannot open directory '.': Permission denied";

// E2E_PATTERNS: Claude Code's TodoWrite input, before and after the work (the Plan pattern)
export const PLAN_START = {
  todos: [
    { activeForm: "Searching the web", content: "Search the web", status: "in_progress" },
    { activeForm: "Reading the page", content: "Read the page", status: "pending" },
    { activeForm: "Writing the answer", content: "Write the answer", status: "pending" },
  ],
};
export const PLAN_DONE = { todos: PLAN_START.todos.map((t) => ({ ...t, status: "completed" })) };
// WebSearch's result as Claude Code words it, and the page WebFetch reads (the Sources pattern)
export const SEARCH_LINKS = [
  { title: "Streaming replies", url: "https://docs.example.com/streaming" },
  { title: "A fake claude", url: "https://fake.example.org/claude" },
];
export const FETCHED = "https://docs.example.com/streaming";
export const SEARCH_RESULT = `Web search results for query: "fake claude streaming"\n\nLinks: ${JSON.stringify(SEARCH_LINKS)}\n\nBoth pages describe streamed replies.`;
