#!/usr/bin/env bun
// The `optchat` command. With no argument it is the REPL, a client of optchat-server ($OPTCHAT_URL,
// default http://127.0.0.1:7700). The rest run once and exit: `view` reads the data dir without
// taking the lock, `import-optmem` fills an empty chat from OptMem's notes.
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { importOptmem } from "../src/import.ts";
import { runRepl } from "./repl.ts";
import { streamDir } from "../src/paths.ts";
import { loadChat } from "../src/store.ts";
import { stats, render } from "../src/view.ts";

const USAGE = "usage: optchat [view | import-optmem [LOG.txt]]   (server: $OPTCHAT_URL; data dir: $OPTCHAT_DIR or ~/.optchat/streams/mini)";
const [cmd, arg] = [process.argv[2], process.argv[3]];
const dir = streamDir("mini");

const view = Effect.gen(function* () {
  const { mem, problems } = yield* loadChat(dir, { repair: false });
  for (const p of problems) yield* Console.error(p);
  // a dim header for a person at a terminal; piped, stdout is the view and nothing else
  if (process.stdout.isTTY) yield* Effect.sync(() => process.stderr.write(`\u001B[2m${stats(mem).join("\n")}\u001B[0m\n`));
  yield* Console.log(render(mem));
});

const importNotes = Effect.gen(function* () {
  const mem = yield* importOptmem(dir, arg);
  const facts = [`${mem.root.length} OptMem notes are now messages in ${dir}`, `free nodes: ${mem.tree.size}`, `view: ${mem.view.length} lines`];
  yield* Console.log(facts.join("; "));
});

// asking for help is a success; anything else this command doesn't know is a usage error (2)
const help = (asked: boolean) =>
  Console.error(USAGE).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (!asked) process.exitCode = 2;
      }),
    ),
  );

const commands = new Map<string, Effect.Effect<void, { readonly message: string }>>([
  ["--help", help(true)],
  ["-h", help(true)],
  ["import-optmem", importNotes],
  ["view", view],
]);
const repl = runRepl({ url: Bun.env.OPTCHAT_URL ?? "http://127.0.0.1:7700" });
const command = cmd === undefined ? repl : (commands.get(cmd) ?? help(false));

BunRuntime.runMain(
  command.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Console.error(`optchat: ${error.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
      onSuccess: () => Effect.void,
    }),
  ),
  { disableErrorReporting: true },
);
