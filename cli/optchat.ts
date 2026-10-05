#!/usr/bin/env bun
// optchat: the REPL, a client of optchat-server ($OPTCHAT_URL, default http://127.0.0.1:7700), and
// one-shot commands that read the data dir without the lock, plus import.
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { importOptmem } from "../src/import.ts";
import { runRepl } from "./repl.ts";
import { streamDir } from "../src/paths.ts";
import { loadChat } from "../src/store.ts";
import { render, stats } from "../src/view.ts";

const USAGE = "usage: optchat [view | import-optmem [LOG.txt]]   (server: $OPTCHAT_URL; data dir: $OPTCHAT_DIR or ~/.optchat/streams/mini)";
const [cmd, arg] = process.argv.slice(2);
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
  yield* Console.log(`imported ${mem.root.length} notes into ${dir}; ${mem.tree.size} free nodes built, ${mem.view.length} view lines`);
});

const usage = Effect.gen(function* () {
  yield* Console.error(USAGE);
  process.exitCode = cmd === "--help" || cmd === "-h" ? 0 : 2;
});

const repl = runRepl({ url: Bun.env.OPTCHAT_URL ?? "http://127.0.0.1:7700" });

const command = cmd === undefined ? repl : cmd === "view" ? view : cmd === "import-optmem" ? importNotes : usage;

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
