#!/usr/bin/env bun
// optchat: one-shot commands that read the data dir without the lock, plus import.
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { importOptmem } from "../src/import.ts";
import { streamDir } from "../src/paths.ts";
import { loadChat } from "../src/store.ts";
import { render } from "../src/view.ts";

const USAGE = "usage: optchat [view | import-optmem [LOG.txt]]   (data dir: $OPTCHAT_DIR or ~/.optchat/streams/mini)";
const [cmd, arg] = process.argv.slice(2);
const dir = streamDir("mini");

const view = Effect.gen(function* () {
  const { mem, problems } = yield* loadChat(dir, { repair: false });
  for (const p of problems) yield* Console.error(p);
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

const commands: Record<string, Effect.Effect<void, { readonly message: string }>> = { "import-optmem": importNotes, view };

BunRuntime.runMain(
  (commands[cmd ?? ""] ?? usage).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Console.error(`optchat: ${error.message}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
      onSuccess: () => Effect.void,
    }),
  ),
  { disableErrorReporting: true },
);
