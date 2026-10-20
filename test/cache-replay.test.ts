// The cache replay (test/cache-replay.ts): a real session, real engines, fake vendors whose prompt
// caches follow test/fake-cache.ts's rules, a test clock. A chat of TEST_TURNS messages on each
// layout; the invariants SPEC claims hold on every request, and the numbers stay within the bounds
// recorded below, so a change that costs cache fails here. `bun dev/cache-replay.ts` prints the
// table, at full size too.
//
// When a change moves a number on purpose, run `bun dev/cache-replay.ts --test` and record the new
// one in BOUNDS, with why in the commit.
import { beforeAll, expect, test } from "bun:test";
import { checks, LAYOUTS, type Replay, replay, script, summary, TEST_MARKS, TEST_TURNS } from "./cache-replay.ts";

const runs = new Map<string, Replay>();
beforeAll(async () => {
  const steps = script(TEST_TURNS);
  for (const layout of LAYOUTS) runs.set(layout.name, await replay(layout, steps, TEST_MARKS));
}, 60_000);
const run = (name: string) => {
  const r = runs.get(name);
  if (r === undefined) throw new Error(`no replay of ${name}`);
  return r;
};

// Recorded from the test's chat (seed 1). Each layout's share of its turns' and its compactions'
// input read from the cache may fall by half a point at most; its cold turns may not grow, its
// tokens written and its dollars at the price table by 2% at most. A gain is welcome: record it.
type Bounds = { readonly turnRead: number; readonly compactRead: number; readonly cold: number; readonly written: number; readonly dollars: number };
const BOUNDS = new Map<string, Bounds>(Object.entries({
  "api-key": { cold: 24, compactRead: 0.7697, dollars: 1.8471, turnRead: 0.7044, written: 446_200 },
  "claude-code": { cold: 7, compactRead: 0.8657, dollars: 3.4559, turnRead: 0.8966, written: 620_894 },
  "claude-code-5m": { cold: 11, compactRead: 0.8202, dollars: 3.8088, turnRead: 0.8581, written: 993_498 },
  shipped: { cold: 8, compactRead: 0.7092, dollars: 2.734, turnRead: 0.891, written: 640_962 },
}));

// "ok", or the number that broke its bound
const within = (ok: boolean, n: number) => (ok ? "ok" : n);

test("the replay runs the whole script on every layout: batches merged, the outage failed over and back, nothing refused", () => {
  for (const layout of LAYOUTS) {
    const r = run(layout.name);
    expect(r.batches).toBeGreaterThanOrEqual(2);
    expect(r.messages).toBeGreaterThan(150);
    // the only reports are the compactor's move to the next engine and its way back
    expect(r.reports).toEqual([expect.stringContaining(" unavailable: "), expect.stringContaining(" back: compacting on it again")]);
    expect(r.refused).toEqual([]);
  }
});

test("each request reads everything the request before it in the same call sent: a turn's next round, after a mid-run message too, and a size retry", () => {
  for (const layout of LAYOUTS) {
    const { continuations } = checks(run(layout.name));
    expect(continuations.broken).toEqual([]);
    expect(continuations.checked).toBeGreaterThan(80);
  }
});

test("priming makes the next turn warm: a claude-code turn after a priming of its view reads all of it", () => {
  for (const layout of LAYOUTS.filter((l) => l.master[0].startsWith("claude-code:"))) {
    const { primed } = checks(run(layout.name));
    expect(primed.broken).toEqual([]);
    expect(primed.warm).toBeGreaterThanOrEqual(layout.ttl === "1h" ? 27 : 25);
  }
});

test("compactions write each prefix of their context once per TTL: single flight (E50) leaves no second writer", () => {
  for (const layout of LAYOUTS) {
    const { doubleWrites } = checks(run(layout.name));
    expect(doubleWrites.broken).toEqual([]);
    expect(doubleWrites.checked).toBeGreaterThan(250);
  }
});

test("what the engines log to usage.jsonl is what the vendors said: tokens read, and written on Anthropic", () => {
  for (const layout of LAYOUTS) {
    const { accounting } = checks(run(layout.name));
    expect(accounting.logged).toEqual(accounting.vendor);
  }
});

test("E6: the Claude plan's 1-hour marks leave fewer cold turns and write less than 5-minute ones, on the same chat", () => {
  const hour = summary(run("claude-code")), five = summary(run("claude-code-5m"));
  expect(hour.cold).toBeLessThan(five.cold);
  expect(hour.written).toBeLessThan(five.written * 0.7);
  expect(hour.turnRead).toBeGreaterThan(five.turnRead);
});

test("E26: a compaction on the turns' model reads the turns' tools and system entry on an API key; the shipped chains share none", () => {
  expect(checks(run("api-key")).turnEntries.requests).toBeGreaterThan(0);
  expect(checks(run("shipped")).turnEntries.requests).toBe(0);
});

test("the numbers stay within the recorded bounds", () => {
  for (const layout of LAYOUTS) {
    const s = summary(run(layout.name));
    const b = BOUNDS.get(layout.name);
    expect(b).toBeDefined();
    if (b === undefined) continue;
    expect({
      cold: within(s.cold <= b.cold, s.cold),
      compactRead: within(s.compactRead >= b.compactRead - 0.005, s.compactRead),
      dollars: within(s.dollars <= b.dollars * 1.02, s.dollars),
      layout: layout.name,
      turnRead: within(s.turnRead >= b.turnRead - 0.005, s.turnRead),
      written: within(s.written <= b.written * 1.02, s.written),
    }).toEqual({ cold: "ok", compactRead: "ok", dollars: "ok", layout: layout.name, turnRead: "ok", written: "ok" });
  }
});
