// Single flight on every block prefix (docs/optchat.md §3.3, E50; after UniiChat's AskAI.keys and
// AskAI.wait). "A call whose marked prefix another call is writing waits until that call's
// response starts; otherwise both pay to write it." A vendor keeps an entry only where a request
// marks a block, and a later request finds the longest entry that ends on one of its own block
// boundaries, at most LOOKBACK blocks before its mark. So a call that extends a prefix another
// call is writing waits for that call's response to start, then writes only the blocks after it;
// one whose whole prefix was written within the entry's lifetime (its TTL) reads it and holds no
// one up; one that shares nothing, or nothing within the lookback, goes at once. A writer holds
// its prefix until its first response event, or until it ends, but never longer than FLIGHT_WAIT:
// past that its claim lapses and the next waiter writes instead, so a stuck call holds no one up
// for good.
import { Clock, Deferred, Duration, Effect } from "effect";
import { FLIGHT_WAIT, LOOKBACK } from "../config.ts";

// how long a vendor keeps an entry no request reads: a Claude subscription's marks as E6 sets
// them, and five minutes everywhere else (an API key's marks; OpenAI keeps one 5 to 10 minutes)
export type Ttl = "1h" | "5m";
const TTL_MS = { "1h": 3_600_000, "5m": 300_000 } satisfies Record<Ttl, number>;

// What single flight knows of a request: a key per block, each naming everything the request
// sends up to that block's end (prefixKeys), through the last block it marks before its end; the
// blocks it marks, whose entries it writes; and how long the vendor keeps them.
export type Prefix = { readonly keys: readonly string[]; readonly marks: readonly number[]; readonly ttl: Ttl };

export type Gate = {
  // `call` once no other call is writing a prefix of its own that it could read; it runs `started`
  // at each response event, the first of which ends its claim
  readonly through: <A, E, R>(prefix: Prefix | null, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

// The keys of a request's blocks: the first hashes what comes before the blocks (`head`: the
// engine, model, effort, system prompt and tools) and the first block, and each later one the key
// before it and its own block, so a key names its whole prefix and two requests share a key
// exactly where they share every byte up to it.
export const prefixKeys = (head: readonly string[], blocks: readonly string[]): string[] => {
  const start = new Bun.CryptoHasher("sha256");
  for (const h of head) start.update(`${h.length}:${h}`);
  let key = start.digest("hex");
  return blocks.map((b) => (key = new Bun.CryptoHasher("sha256").update(`${key}:${b.length}:${b}`).digest("hex")));
};

// What a request shares with others: `blocks`, what it sends before its own end (a task, a size
// retry's text, priming's "ok"), up to the last of `marks`, the blocks it marks among them; null
// when it marks none of them.
export const prefixOf = (head: readonly string[], blocks: readonly string[], marks: readonly number[], ttl: Ttl): Prefix | null => {
  const shared = [...new Set(marks)].filter((m) => m >= 0 && m < blocks.length).toSorted((a, b) => a - b);
  const last = shared.at(-1);
  return last === undefined ? null : { keys: prefixKeys(head, blocks.slice(0, last + 1)), marks: shared, ttl };
};

// a prefix some call is writing, whose response hasn't started (it holds the prefix until `lapses`),
// or one written whose entry the vendor keeps until `until`
type Entry = { readonly _tag: "Writing"; readonly done: Deferred.Deferred<true>; readonly lapses: number } | { readonly _tag: "Cached"; readonly until: number };

export const makeGate = (): Gate => {
  // by key, the least lately used first
  const entries = new Map<string, Entry>();
  const wait = Duration.toMillis(Duration.fromInputUnsafe(FLIGHT_WAIT));

  const live = (e: Entry | undefined, now: number) => e !== undefined && (e._tag === "Writing" ? e.lapses > now : e.until > now);
  const touch = (key: string, e: Entry) => {
    entries.delete(key);
    entries.set(key, e);
  };
  // entries the vendor no longer keeps go, the least lately used first, up to the first still kept
  // or being written (entries of other TTLs may wait behind it for a later sweep)
  const sweep = (now: number) => {
    for (const [key, e] of entries) {
      if (e._tag === "Writing" || e.until > now) return;
      entries.delete(key);
    }
  };

  // `call` writing the entries at `keys`: they are the vendor's from its first response event
  // (each key that is still this call's), and free again when it ends without one
  const lead = <A, E, R>(keys: readonly string[], prefix: Prefix, now: number, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) => {
    const own: Entry = { _tag: "Writing", done: Deferred.makeUnsafe<true>(), lapses: now + wait };
    for (const key of keys) touch(key, own);
    const settle = (next: (now: number) => Entry | null) =>
      Clock.clockWith((clock) =>
        Effect.sync(() => {
          const e = next(clock.currentTimeMillisUnsafe());
          for (const key of keys) {
            if (entries.get(key) !== own) continue;
            if (e === null) entries.delete(key);
            else touch(key, e);
          }
          Deferred.doneUnsafe(own.done, Effect.succeed(true));
        }),
      );
    const started = settle((at) => ({ _tag: "Cached", until: at + TTL_MS[prefix.ttl] }));
    return call(started).pipe(Effect.ensuring(settle(() => null)));
  };

  const through: Gate["through"] = (prefix, call) =>
    prefix === null
      ? call(Effect.void)
      : Clock.clockWith((clock) =>
          Effect.suspend(() => {
            const now = clock.currentTimeMillisUnsafe();
            sweep(now);
            // the longest prefix of this call's, within the lookback of its last mark, that is
            // written or being written: none when `k` falls below the lookback
            const reach = Math.max(0, prefix.keys.length - 1 - LOOKBACK);
            let k = prefix.keys.length - 1;
            while (k >= reach && !live(entries.get(prefix.keys[k] ?? ""), now)) k--;
            const key = k >= reach ? prefix.keys[k] : undefined;
            const found = key === undefined ? undefined : entries.get(key);
            if (found?._tag === "Writing") return Deferred.await(found.done).pipe(Effect.timeoutOption(found.lapses - now), Effect.andThen(through(prefix, call)));
            if (key !== undefined) touch(key, { _tag: "Cached", until: now + TTL_MS[prefix.ttl] }); // a read keeps it longer
            // what this call writes: its marked entries past what it reads
            const writes = prefix.marks.filter((m) => key === undefined || m > k).flatMap((m) => prefix.keys[m] ?? []);
            return writes.length === 0 ? call(Effect.void) : lead(writes, prefix, now, call);
          }),
        );
  return { through };
};
