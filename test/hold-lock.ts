// A second process for the lock test: it takes the lock on the data dir in argv[2] the way the
// chat does, says "held" on stdout, and keeps it until it is killed.
import { Effect } from "effect";
import { lock } from "../src/store.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: hold-lock.ts <data dir>");
// the lock's socket never keeps a process alive on its own; this timer does
setInterval(() => {
  // nothing to do: being scheduled is the point
}, 60_000);
await Effect.runPromise(
  Effect.scoped(
    lock(dir).pipe(
      Effect.andThen(Effect.sync(() => process.stdout.write("held\n"))),
      Effect.andThen(Effect.never),
    ),
  ),
);
