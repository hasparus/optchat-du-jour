// Replays the fixture into a fresh data dir through optchat-du-jour. Caught up (the default): one
// message at a time, waiting after each until the compactor has built everything it can. Lagging
// (`lag`): fixture.ts's scripted batches, releases and failures. One job at a time either way, so
// the order of the calls (and the contexts they see) is the order rule 3 gives.
import { Effect } from "effect";
import { openChat } from "../../src/chat.ts";
import { CompactError } from "../../src/compactor.ts";
import { built, type Mem, nodes } from "../../src/tree.ts";
import { fakeSummary, fixture, type FixtureMsg, gate, replayLagging, RETRY_MS } from "./fixture.ts";

const [dir, mode] = [process.argv[2], process.argv[3]];
if (!dir) throw new Error("usage: drive-ours.ts <data dir> [lag]");

const caughtUp = (mem: Mem) => nodes(mem.root.length).every((c) => built(mem, c));

if (mode === "lag") {
  const g = gate();
  const summarize = (job: Parameters<typeof g.call>[0]) =>
    Effect.tryPromise({ catch: (e) => new CompactError({ message: e instanceof Error ? e.message : String(e) }), try: async () => g.call(job) });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* openChat(dir, { jobs: 1, report: () => Effect.void, retry: `${RETRY_MS} millis`, summarize });
        const log = async (m: FixtureMsg) => Effect.runPromise(chat.log(m.kind, m.text).pipe(Effect.asVoid));
        yield* Effect.promise(async () => replayLagging({ caughtUp: () => caughtUp(chat.mem), gate: g, log }));
      }),
    ),
  );
} else {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* openChat(dir, { jobs: 1, summarize: (job) => Effect.succeed(fakeSummary(job)) });
        for (const m of fixture()) {
          yield* chat.log(m.kind, m.text);
          while (!caughtUp(chat.mem)) yield* Effect.sleep(1);
        }
      }),
    ),
  );
}
