// Replays the fixture into a fresh data dir through optchat-du-jour. Caught up (the default): one
// message at a time, waiting after each until the compactor has built everything it can. Lagging
// (`lag`): fixture.ts's scripted batches, releases and failures. One job at a time either way, so
// the order of the calls (and the contexts they see) is the order rule 3 gives. Prints a Report.
import { Effect } from "effect";
import { openChat } from "../../src/chat.ts";
import { CompactError } from "../../src/compactor.ts";
import { built, type Mem, nodes } from "../../src/tree.ts";
import { fakeSummary, fixture, type FixtureMsg, gate, replayLagging, type Report, type Split, watch } from "./fixture.ts";

const [dir, mode] = [process.argv[2], process.argv[3]];
if (!dir) throw new Error("usage: drive-ours.ts <data dir> [lag]");

const caughtUp = (mem: Mem) => nodes(mem.root.length).every((c) => built(mem, c));
const watching = (mem: Mem, calls: readonly string[]) => watch({ calls: () => calls.length, nodes: () => mem.tree.size, view: () => mem.view });
const print = (calls: readonly string[], split: Split) => {
  console.log(JSON.stringify({ calls, split } satisfies Report));
};

if (mode === "lag") {
  const g = gate();
  const summarize = (job: Parameters<typeof g.call>[0]) =>
    Effect.tryPromise({ catch: (e) => new CompactError({ message: e instanceof Error ? e.message : String(e) }), try: async () => g.call(job) });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* openChat(dir, { jobs: 1, report: () => Effect.void, summarize });
        const w = watching(chat.mem, g.calls);
        const log = async (m: FixtureMsg) => Effect.runPromise(chat.log(m.kind, m.text).pipe(Effect.asVoid));
        // a failed call waits for the next message; while the driver waits, none comes
        const idle = async () => Effect.runPromise(chat.retry);
        yield* Effect.promise(async () => replayLagging({ caughtUp: () => caughtUp(chat.mem), gate: g, idle, log, look: w.look }));
        print(g.calls, w.split());
      }),
    ),
  );
} else {
  const calls: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* openChat(dir, {
          jobs: 1,
          summarize: (job) =>
            Effect.sync(() => {
              calls.push(`${job.l}:${job.i}/1`);
              return fakeSummary(job);
            }),
        });
        const w = watching(chat.mem, calls);
        for (const m of fixture()) {
          yield* chat.log(m.kind, m.text);
          w.look();
          while (!caughtUp(chat.mem)) yield* Effect.sleep(1);
          w.look();
        }
        print(calls, w.split());
      }),
    ),
  );
}
