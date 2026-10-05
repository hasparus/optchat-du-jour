#!/usr/bin/env bun
// The `optchat` command. With no argument it is the REPL, a client of optchat-server ($OPTCHAT_URL,
// default http://127.0.0.1:7700). The rest run once and exit: `view` reads the data dir without
// taking the lock, `import-optmem` fills an empty chat from OptMem's notes, `login openai` signs
// in with ChatGPT for the openai-plan engine.
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Predicate } from "effect";
import { FetchHttpClient } from "effect/http";
import { loadSettings } from "../src/config.ts";
import { importOptmem } from "../src/import.ts";
import { login } from "../src/openai/auth.ts";
import { SecretsLive } from "../src/secrets.ts";
import { runRepl } from "./repl.ts";
import { streamDir } from "../src/paths.ts";
import { loadChat } from "../src/store.ts";
import { stats, render } from "../src/view.ts";

const USAGE = "usage: optchat [view | import-optmem [LOG.txt] | login openai]   (server: $OPTCHAT_URL; data dir: $OPTCHAT_DIR or ~/.optchat/streams/mini)";
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
  const c = yield* login({ endpoints: settings.openai, open: openUrl }).pipe(Effect.provide([SecretsLive, FetchHttpClient.layer]));
  yield* Console.log(`signed in${c.email === undefined ? "" : ` as ${c.email}`}; the compactor can use your ChatGPT plan`);
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
  ["login", arg === "openai" ? loginOpenai : help(false)],
  ["view", view],
]);
const repl = runRepl({ url: Bun.env.OPTCHAT_URL ?? "http://127.0.0.1:7700" });
const command = cmd === undefined ? repl : (commands.get(cmd) ?? help(false));

// why the command stopped, in one line: its error, or what was thrown (a defect, e.g. in the kernel)
const reason = (cause: Cause.Cause<{ readonly message: string }>) => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted";
  const thrown = Cause.squash(cause);
  if (thrown instanceof Error) return thrown.message;
  return Predicate.hasProperty(thrown, "message") && Predicate.isString(thrown.message) ? thrown.message : String(thrown);
};

BunRuntime.runMain(
  command.pipe(
    Effect.catchCause((cause) =>
      Console.error(`optchat: ${reason(cause)}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
  { disableErrorReporting: true },
);
