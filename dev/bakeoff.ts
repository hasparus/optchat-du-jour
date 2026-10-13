#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { HELP, parseBakeoffCommand } from "./bakeoff-options.ts";

export const runBakeoffCli = (argv: readonly string[]) => Effect.gen(function* () {
  const command = yield* Effect.try(() => parseBakeoffCommand(argv));
  if (command.type === "help") {
    yield* Console.log(HELP);
    return 0;
  }
  const { executeBakeoff } = yield* Effect.promise(() => import("./bakeoff-live.ts"));
  return yield* executeBakeoff(command);
}).pipe(Effect.catchCause(() => Console.error("bake-off setup failed (details redacted); use --help").pipe(Effect.as(2))));

if (import.meta.main) BunRuntime.runMain(runBakeoffCli(Bun.argv.slice(2)).pipe(Effect.map((code) => { process.exitCode = code; })), { disableErrorReporting: true });
