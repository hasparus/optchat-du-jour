#!/usr/bin/env bun
// The smallest stand-in for `claude -p --input-format stream-json` that a device runner can spawn:
// each user message gets an init, a message_start, an assistant text and a result, the text saying
// what it heard, its pid and its cwd. It exits when stdin closes, except after the message
// "stubborn": then it ignores SIGTERM and stdin, so only SIGKILL ends it. `--version` prints
// FAKE_CLAUDE_VERSION.
import { Option, Schema } from "effect";

if (process.argv.includes("--version")) {
  process.stdout.write(`${Bun.env.FAKE_CLAUDE_VERSION ?? "0.0.0"} (Claude Code)\n`);
  process.exit(0);
}

const Message = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))]),
  }),
});
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Message));
const lastText = (line: string) =>
  Option.match(decode(line), {
    onNone: () => "",
    onSome: ({ message: { content } }) => (Schema.is(Schema.String)(content) ? content : (content.at(-1)?.text ?? "")),
  });

const emit = (event: Schema.Json) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = { input_tokens: 1, output_tokens: 1 };
let stubborn = false;

for await (const line of console) {
  if (!line.trim()) continue;
  const heard = lastText(line);
  if (heard === "stubborn") {
    stubborn = true;
    process.on("SIGTERM", () => {
      process.stderr.write("ignoring SIGTERM\n");
    });
  }
  const text = `echo: ${heard} pid=${process.pid} cwd=${process.cwd()}`;
  emit({ mcp_servers: [{ name: "optchat", status: "connected" }], model: "echo", subtype: "init", type: "system" });
  emit({ event: { message: { model: "echo", usage }, type: "message_start" }, type: "stream_event" });
  emit({ message: { content: [{ text, type: "text" }] }, type: "assistant" });
  emit({ is_error: false, result: text, stop_reason: "end_turn", subtype: "success", type: "result", usage });
}
if (stubborn)
  setInterval(() => {
    process.stderr.write("still here\n");
  }, 1000);
