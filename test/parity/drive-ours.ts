// Replays the fixture into a fresh data dir through optchat-du-jour, one message at a time,
// waiting after each until the compactor has built everything it can. One job at a time, so the
// order of the calls (and the contexts they see) is the order rule 3 gives.
import { Effect } from "effect";
import { openChat } from "../../src/chat.ts";
import { built, type Mem, nodes } from "../../src/tree.ts";
import { fakeSummary, fixture } from "./fixture.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: drive-ours.ts <data dir>");

const caughtUp = (mem: Mem) => nodes(mem.root.length).every((c) => built(mem, c));

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
