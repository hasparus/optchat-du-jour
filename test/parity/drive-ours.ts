// Replays the fixture into a fresh data dir through optchat-du-jour, one message at a time,
// waiting after each until the compactor has built everything it can. One job at a time, so the
// order of the calls (and the contexts they see) is the order rule 3 gives.
import { Effect } from "effect";
import { openChat } from "../../src/chat.ts";
import { built, nodes } from "../../src/tree.ts";
import { fakeSummary, fixture } from "./fixture.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: drive-ours.ts <data dir>");

const done = (T: number, has: (l: number, i: number) => boolean) => nodes(T).every((c) => has(c.l, c.i));

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, { jobs: 1, summarize: (job) => Effect.succeed(fakeSummary(job)) });
      for (const m of fixture()) {
        yield* chat.log(m.kind, m.text);
        while (!done(chat.mem.root.length, (l, i) => built(chat.mem, l, i))) yield* Effect.sleep(1);
      }
    }),
  ),
);
