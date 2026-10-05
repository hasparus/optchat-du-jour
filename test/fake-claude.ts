#!/usr/bin/env bun
// Stands in for `claude -p --input-format stream-json` in tests (ref §10): records what it is
// given and answers from a script, so no test ever reaches a model.
//
//   FAKE_CLAUDE_LOG     a JSONL file; each process appends {start: {role, argv, env, pid}} and then
//                       one {message} per user message it reads
//   FAKE_CLAUDE_SCRIPT  a JSON file: {"turn": [...], "prime": [...], "compact": [...]}, each a list
//                       of processes, each a list of steps. The role comes from the argv and env:
//                       --safe-mode is a compactor call, DISABLE_PROMPT_CACHING without it a priming
//                       call, anything else a turn. The nth process of a role (counted in the log)
//                       plays its list n, the last list repeating; each user message plays the next
//                       step, the last step repeating. A role the script leaves out behaves as a
//                       real claude would at its simplest: a turn replies "ok", a priming call
//                       accepts the request and waits, a compactor call answers one short line.
//                       A step is one of
//                         {"reply": "text", "stop_reason"?: "..."}   a result with that text
//                         {"error": "text"}                          an is_error result
//                         {"exit": 3, "stderr"?: "..."}              exit with that code
//                         {"hang": true}                             never answer
//                         {"events": [...]}                          print these events, where
//                           {"$wait": true}    reads the next user message first
//                           {"$replay": true}  prints the replay of the last message read
//                           {"$sleep": ms}     pauses
//                           {"$hang": true}    never goes on
// The process ends when its stdin closes, also while it hangs, and on SIGTERM.
import { appendFileSync, readFileSync } from "node:fs";

type Step = {
  readonly reply?: string;
  readonly stop_reason?: string;
  readonly error?: string;
  readonly exit?: number;
  readonly stderr?: string;
  readonly hang?: boolean;
  readonly events?: readonly object[];
};
type Role = "compact" | "prime" | "turn";
type Script = { readonly [R in Role]?: readonly (readonly Step[])[] };

const logPath = Bun.env.FAKE_CLAUDE_LOG ?? "";
const scriptPath = Bun.env.FAKE_CLAUDE_SCRIPT ?? "";
// SAFETY: the tests write this file with the Script shape above
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
const argv = process.argv.slice(2);
const role: Role = argv.includes("--safe-mode") ? "compact" : Bun.env.DISABLE_PROMPT_CACHING ? "prime" : "turn";
const DEFAULTS: Script = {
  compact: [[{ reply: "summary: a short line." }]],
  prime: [[{ events: [{ event: { message: { model: "fake", usage: { input_tokens: 9 } }, type: "message_start" }, type: "stream_event" }, { $hang: true }] }]],
  turn: [[{ reply: "ok" }]],
};
const lists = script[role] ?? DEFAULTS[role] ?? [];
const before = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(`"role":"${role}"`) && l.startsWith('{"start"')).length;
const steps = lists[Math.min(before, lists.length - 1)] ?? [];

const record = (entry: object) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
record({
  start: {
    role,
    argv,
    env: {
      CLAUDE_CODE_PROMPT_CACHE_TTL: Bun.env.CLAUDE_CODE_PROMPT_CACHE_TTL,
      DISABLE_PROMPT_CACHING: Bun.env.DISABLE_PROMPT_CACHING,
    },
    pid: process.pid,
  },
});

const input = console[Symbol.asyncIterator]();
let last: { message: { content: unknown } } | undefined;
async function read() {
  for (;;) {
    const line = await input.next();
    if (line.done) return false;
    if (!line.value.trim()) continue;
    // SAFETY: the harness writes stream-json user messages, {type, message: {role, content}}
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    last = JSON.parse(line.value) as { message: { content: unknown } };
    record({ message: last });
    return true;
  }
}
// a hung claude still drains its stdin, so a closed stdin (the parent gone) ends it
async function hang(): Promise<never> {
  while (await read());
  process.exit(0);
}

const usage = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 2, output_tokens: 5 };
for (let n = 0; await read(); n++) {
  const step = steps[Math.min(n, steps.length - 1)] ?? {};
  if (step.exit !== undefined) {
    process.stderr.write(step.stderr ?? "");
    process.exit(step.exit);
  }
  if (step.hang) await hang();
  if (step.events) {
    for (const event of step.events) {
      if ("$wait" in event) await read();
      else if ("$replay" in event) emit({ isReplay: true, message: { content: last?.message.content, role: "user" }, type: "user" });
      else if ("$sleep" in event) await Bun.sleep(Number(event.$sleep));
      else if ("$hang" in event) await hang();
      else emit(event);
    }
    continue;
  }
  emit({
    duration_ms: 10,
    is_error: step.error !== undefined,
    result: step.error ?? step.reply ?? "",
    stop_reason: step.stop_reason ?? "end_turn",
    subtype: step.error === undefined ? "success" : "error_during_execution",
    type: "result",
    usage,
  });
}
