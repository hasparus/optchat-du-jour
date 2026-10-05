#!/usr/bin/env bun
// optchat: the REPL, a client of optchat-server ($OPTCHAT_URL, default http://127.0.0.1:7700), and
// one-shot commands that read the data dir without the lock, plus import.
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { loadSettings } from "../src/config.ts";
import { importOptmem } from "../src/import.ts";
import { endpointsOf, login } from "../src/openai/auth.ts";
import { SecretsLive } from "../src/secrets.ts";
import { runRepl } from "./repl.ts";
import { streamDir } from "../src/paths.ts";
import { loadChat } from "../src/store.ts";
import { render, stats } from "../src/view.ts";

const USAGE = "usage: optchat [view | import-optmem [LOG.txt] | login openai]   (server: $OPTCHAT_URL; data dir: $OPTCHAT_DIR or ~/.optchat/streams/mini)";
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

const openUrl = (url: string) =>
  Effect.gen(function* () {
    yield* Console.log(`Sign in with ChatGPT in your browser; if it does not open, visit:\n${url}`);
    // macOS `open`; anywhere else the URL above is the way
    if (process.platform === "darwin") yield* Effect.sync(() => Bun.spawn(["open", url], { stderr: "ignore", stdout: "ignore" }));
  });

// Sign in with ChatGPT for the openai-plan engine; the tokens go to the Keychain (SPEC "Tailscale, auth and operations")
const loginOpenai = Effect.gen(function* () {
  const root = new URL("..", import.meta.url).pathname;
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const c = yield* login({ endpoints: endpointsOf(settings.openai), open: openUrl }).pipe(Effect.provide([SecretsLive, FetchHttpClient.layer]));
  yield* Console.log(`signed in${c.email === undefined ? "" : ` as ${c.email}`}; the compactor can use your ChatGPT plan`);
});

const usage = Effect.gen(function* () {
  yield* Console.error(USAGE);
  process.exitCode = cmd === "--help" || cmd === "-h" ? 0 : 2;
});

const repl = runRepl({ url: Bun.env.OPTCHAT_URL ?? "http://127.0.0.1:7700" });

const pick = (): Effect.Effect<void, { readonly message: string }> => {
  switch (cmd) {
    case undefined:
      return repl;
    case "view":
      return view;
    case "import-optmem":
      return importNotes;
    case "login":
      return arg === "openai" ? loginOpenai : usage;
    default:
      return usage;
  }
};
const command = pick();

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
