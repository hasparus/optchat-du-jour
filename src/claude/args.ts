// The flags every `claude -p` call shares (ref §4). The master adds its MCP config and replays,
// the compactor and the caption --safe-mode. A call with no effort (the caption's, unless its
// chain entry sets one: a cheap model with no thinking to tune) sends none. The system prompt goes inline as `--system-prompt` on every
// device, the server's own included, so one text gives one argv and one cache key by construction
// (SPEC "Multi-machine"); no file is read on the far side.
export const baseArgs = (o: { model: string; effort?: string | undefined; system: string; tools: string }) => [
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
  "--system-prompt",
  o.system,
  "--tools",
  o.tools,
];
