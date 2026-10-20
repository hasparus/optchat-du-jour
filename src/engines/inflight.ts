// Single flight on every block prefix (docs/optchat.md §3.3, E50; after UniiChat's AskAI.keys and
// AskAI.wait). "A call whose marked prefix another call is writing waits until that call's
// response starts; otherwise both pay to write it." A vendor keeps an entry only where a request
// marks a block, and a later request finds the longest entry that ends on one of its own block
// boundaries, at most LOOKBACK blocks before its mark. So a call that comes while another writes
// a prefix of its own waits for that call's response to begin, once, then reads what is written
// and writes the rest; one whose whole prefix was written within the entry's lifetime (its TTL)
// reads it and holds no one up; one that shares nothing, or nothing within the lookback, goes at
// once. A writer holds its prefix until its response begins, or until it ends, but never longer
// than FLIGHT_WAIT: past that its claim lapses, so a stuck call holds no one up for good.
//
// Waiting once bounds what single flight costs a call to one wait, as an exact-prefix wait did:
// calls on contexts that extend each other (a merge batch's) all wait on the first writer and then
// go together, each writing its own tail, rather than one after another (`test/single-flight.test.ts`).
import { Clock, Deferred, Duration, Effect, Option } from "effect";
import { FLIGHT_WAIT, LOOKBACK } from "../config.ts";

// how long a vendor keeps an entry no request reads: a Claude subscription's marks as E6 sets
// them, and five minutes everywhere else (an API key's marks; OpenAI keeps one 5 to 10 minutes)
export type Ttl = "1h" | "5m";
const TTL_MS = { "1h": 3_600_000, "5m": 300_000 } satisfies Record<Ttl, number>;

// What a request sends before its blocks, which every key starts from: the engine and the model
// it runs, at its effort, the system prompt and the tools, as that engine writes them. Not the
// device or the account: every call through one gate is a compactor call on the server's own
// machine, and an engine there has one login (the Claude subscription, the ChatGPT plan, an API
// key per provider), so neither varies within a gate.
export type Head = {
  readonly engine: string;
  readonly model: string;
  readonly effort: string | undefined;
  readonly instructions: string;
  readonly tools: string;
};

// What single flight knows of a request: a key per block, each naming everything the request
// sends up to that block's end (prefixKeys), through the last block it marks before its end; the
// blocks it marks, whose entries it writes; and how long the vendor keeps them.
export type Prefix = { readonly keys: readonly string[]; readonly marks: readonly number[]; readonly ttl: Ttl };

export type Gate = {
  // `call`, once a call that was writing a prefix of its own when it came has begun its response;
  // it runs `started` as its own response begins (message_start, response.output_item.added)
  readonly through: <A, E, R>(prefix: Prefix | null, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

// The keys of a request's blocks: the first hashes the head and the first block, and each later
// one the key before it and its own block, so a key names its whole prefix and two requests share
// a key exactly where they share every byte up to it.
export const prefixKeys = (head: Head, blocks: readonly string[]): string[] => {
  const start = new Bun.CryptoHasher("sha256");
  for (const h of [head.engine, head.model, head.effort ?? "", head.instructions, head.tools]) start.update(`${h.length}:${h}`);
  let key = start.digest("hex");
  return blocks.map((b) => (key = new Bun.CryptoHasher("sha256").update(`${key}:${b.length}:${b}`).digest("hex")));
};

// What a request shares with others: `blocks`, what it sends before its own end (a task, a size
// retry's text), up to the last of `marks`, the blocks it marks among them; null when it marks
// none of them.
export const prefixFor = (head: Head, blocks: readonly string[], marks: readonly number[], ttl: Ttl): Prefix | null => {
  const shared = [...new Set(marks)].filter((m) => m >= 0 && m < blocks.length).toSorted((a, b) => a - b);
  const last = shared.at(-1);
  return last === undefined ? null : { keys: prefixKeys(head, blocks.slice(0, last + 1)), marks: shared, ttl };
};

// a prefix some call is writing, whose response hasn't begun (it holds the prefix until `lapses`;
// `done` is true once its response began, false when it ended without that), or one written,
// which the vendor keeps until `until`, and `ttl` longer after each read
type Entry =
  | { readonly _tag: "Writing"; readonly done: Deferred.Deferred<boolean>; readonly lapses: number; readonly ttl: number }
  | { readonly _tag: "Cached"; readonly until: number; readonly ttl: number };

export const makeGate = (): Gate => {
  // by key, the least lately used first
  const entries = new Map<string, Entry>();
  const wait = Duration.toMillis(Duration.fromInputUnsafe(FLIGHT_WAIT));

  const writing = (e: Entry | undefined, now: number) => e?._tag === "Writing" && e.lapses > now;
  const written = (e: Entry | undefined, now: number) => e?._tag === "Cached" && e.until > now;
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
  // the longest of a call's keys, within the lookback of its last mark, whose entry `holds`; -1 for none
  const longest = (prefix: Prefix, now: number, holds: (e: Entry | undefined, now: number) => boolean) => {
    const reach = Math.max(0, prefix.keys.length - 1 - LOOKBACK);
    for (let k = prefix.keys.length - 1; k >= reach; k--) if (holds(entries.get(prefix.keys[k] ?? ""), now)) return k;
    return -1;
  };

  // Wait for `writer`'s response to begin, or for it to end without that, or for its claim to lapse;
  // then `next` if its response began, else `otherwise`
  const after = <A, E, R>(writer: Entry & { readonly _tag: "Writing" }, now: number, next: Effect.Effect<A, E, R>, otherwise: Effect.Effect<A, E, R>) =>
    Deferred.await(writer.done).pipe(
      Effect.timeoutOption(writer.lapses - now),
      Effect.flatMap((began) => (Option.getOrElse(began, () => false) ? next : otherwise)),
    );

  // The call goes now: it reads the longest written prefix of its own and writes its marked
  // entries past it, those no other call is writing. Once its response begins, what it wrote is
  // the vendor's, and what it read is kept a TTL longer (the entry's own TTL); a call that ends
  // before that frees what it held, and the calls waiting on it look again.
  const go = <A, E, R>(prefix: Prefix, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
    Clock.clockWith((clock) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();
        sweep(now);
        const k = longest(prefix, now, written);
        const read = prefix.keys[k];
        const writes = prefix.marks.flatMap((m) => (m > k ? (prefix.keys[m] ?? []) : [])).filter((key) => !writing(entries.get(key), now));
        const own: Entry & { readonly _tag: "Writing" } = { _tag: "Writing", done: Deferred.makeUnsafe<boolean>(), lapses: now + wait, ttl: TTL_MS[prefix.ttl] };
        for (const key of writes) touch(key, own);
        const mine = () => writes.filter((key) => entries.get(key) === own);
        const began = Clock.clockWith((at) =>
          Effect.sync(() => {
            const t = at.currentTimeMillisUnsafe();
            for (const key of mine()) touch(key, { _tag: "Cached", ttl: own.ttl, until: t + own.ttl });
            const kept = read === undefined ? undefined : entries.get(read);
            if (read !== undefined && kept?._tag === "Cached") touch(read, { ...kept, until: Math.max(kept.until, t + kept.ttl) });
            Deferred.doneUnsafe(own.done, Effect.succeed(true));
          }),
        );
        const ended = Effect.sync(() => {
          for (const key of mine()) entries.delete(key);
          Deferred.doneUnsafe(own.done, Effect.succeed(false));
        });
        return call(began).pipe(Effect.ensuring(ended));
      }),
    );

  // After its one wait, a call goes; but when another call that woke with it already writes this
  // call's whole prefix, it waits for that one too, and then goes whatever came of it: one more
  // wait at most, never a chain, and the tail is written once
  const fly = <A, E, R>(prefix: Prefix, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
    Clock.clockWith((clock) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();
        const tail = entries.get(prefix.keys.at(-1) ?? "");
        return tail?._tag === "Writing" && writing(tail, now) ? after(tail, now, go(prefix, call), go(prefix, call)) : go(prefix, call);
      }),
    );

  const through: Gate["through"] = (prefix, call) =>
    prefix === null
      ? call(Effect.void)
      : Clock.clockWith((clock) =>
          Effect.suspend(() => {
            const now = clock.currentTimeMillisUnsafe();
            sweep(now);
            // a writer of a prefix of its own, already writing, and longer than any written one:
            // wait for its response to begin, then go. A writer that ended without that, or whose
            // claim lapsed, wrote nothing: look again, so one of those that waited writes the
            // prefix and the others wait for it, rather than all writing it at once
            const found = entries.get(prefix.keys[longest(prefix, now, (e, t) => writing(e, t) || written(e, t))] ?? "");
            if (found?._tag !== "Writing") return fly(prefix, call);
            return after(found, now, fly(prefix, call), through(prefix, call));
          }),
        );
  return { through };
};
