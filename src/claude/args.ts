// The flags every `claude -p` call shares (ref §4). The master adds its MCP config and replays,
// the compactor and the caption --safe-mode. A call with no effort (the caption's: a cheap model
// with no thinking to tune) sends none.
export const baseArgs = (o: { model: string; effort?: string | undefined; systemFile: string; tools: string }) => [
  "-p",
  "--model",
  o.model,
  ...(o.effort === undefined ? [] : ["--effort", o.effort]),
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--system-prompt-file",
  o.systemFile,
  "--tools",
  o.tools,
];
