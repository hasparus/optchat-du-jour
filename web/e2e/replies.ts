// What the e2e server's fake engines answer (e2e/server.ts), for the specs to look for.
export const REPLY = "Streamed reply from the fake claude.";
export const SOL_REPLY = "Answered by the fake ChatGPT plan.";
// the tool's output when E2E_TOOL_ERROR fails it: nothing in the text says it failed, only the flag
export const TOOL_ERROR = "ls: cannot open directory '.': Permission denied";
