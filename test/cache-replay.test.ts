// The cache replay (test/cache-replay.ts): a real session, real engines, fake vendors whose prompt
// caches follow test/fake-cache.ts's rules, a test clock. A chat of TEST_TURNS messages on each
// layout; the invariants SPEC claims hold on every request, and each layout's numbers are exactly
// the ones recorded below. The replay is deterministic, so any change to them, a gain as much as
// a loss, is a change to record: run `bun dev/cache-replay.ts --test` (it runs the replay twice
// and fails if the two differ), paste its RECORDED here, and say why in the commit.
import { beforeAll, describe, expect, test } from "bun:test";
import { afterLongTurn, checks, LAYOUTS, type Layout, type Replay, replay, script, summary, TEST_MARKS, TEST_TURNS } from "./cache-replay.ts";

const RECORDED = new Map(
  Object.entries({
    "api-key": { afterLongTurn: { blocksBack: null, primed: false, read: 2661, total: 5660 }, cold: 25, compactRead: 0.7721, dollars: 2.4091, turnRead: 0.833, written: 580_446 },
    "claude-code": { afterLongTurn: { blocksBack: null, primed: true, read: 0, total: 13_014 }, cold: 6, compactRead: 0.85, dollars: 4.6504, turnRead: 0.9329, written: 891_802 },
    "claude-code-5m": { afterLongTurn: { blocksBack: null, primed: true, read: 10_015, total: 13_014 }, cold: 8, compactRead: 0.8046, dollars: 4.5321, turnRead: 0.9207, written: 1_281_032 },
    shipped: { afterLongTurn: { blocksBack: 20, primed: true, read: 12_457, total: 16_403 }, cold: 6, compactRead: 0.7142, dollars: 3.4894, turnRead: 0.9331, written: 843_065 },
  }),
);

// each layout replayed once, whichever test asks first; a layout takes a few seconds alone, many
// times that on a loaded machine
const steps = script(TEST_TURNS);
const replays = new Map<string, Promise<Replay>>();
const replayOf = async (layout: Layout) => {
  const known = replays.get(layout.name);
  if (known !== undefined) return known;
  const started = replay(layout, steps, TEST_MARKS);
  replays.set(layout.name, started);
  return started;
};
const BUDGET = 180_000;

for (const layout of LAYOUTS) {
  describe(layout.name, () => {
    let r: Replay;
    beforeAll(async () => {
      r = await replayOf(layout);
    }, BUDGET);

    test("the whole script ran: batches merged, the outage failed over and back, one turn stopped by a usage limit and resumed, nothing refused", () => {
      expect(r.batches).toBeGreaterThanOrEqual(2);
      expect(r.messages).toBeGreaterThan(250);
      // the only reports are the compactor's move to the next engine and its way back
      expect(r.reports).toEqual([expect.stringContaining(" unavailable: "), expect.stringContaining(" back: compacting on it again")]);
      expect({ limits: r.limits, resumes: r.resumes }).toEqual({ limits: 1, resumes: 1 });
      expect(r.refused).toEqual([]);
    });

    test("each request reads everything the request before it in the same call sent: a turn's next round, after a mid-run message too, and a size retry", () => {
      const { continuations } = checks(r);
      expect(continuations.broken).toEqual([]);
      expect(continuations.checked).toBeGreaterThan(130);
    });

    test("compactions write each prefix of their context once per TTL: single flight (E50) leaves no second writer", () => {
      const { doubleWrites } = checks(r);
      expect(doubleWrites.broken).toEqual([]);
      expect(doubleWrites.checked).toBeGreaterThan(350);
    });

    test("what the engines log to usage.jsonl is what the vendors said: tokens read, and written on Anthropic", () => {
      const { accounting } = checks(r);
      expect(accounting.logged).toEqual(accounting.vendor);
    });

    if (layout.master[0].startsWith("claude-code:"))
      test("priming makes the next turn warm: a claude-code turn after a priming of its view reads all of it", () => {
        const { primed } = checks(r);
        expect(primed.broken).toEqual([]);
        expect(primed.warm).toBeGreaterThanOrEqual(25);
      });

    test("the numbers are the recorded ones", () => {
      expect(RECORDED.has(layout.name)).toBe(true);
      expect({ ...summary(r), afterLongTurn: afterLongTurn(r.sent) }).toEqual(RECORDED.get(layout.name) ?? { ...summary(r), afterLongTurn: null });
    });
  });
}

describe("across layouts", () => {
  const runs = new Map<string, Replay>();
  beforeAll(async () => {
    for (const layout of LAYOUTS) runs.set(layout.name, await replayOf(layout));
  }, BUDGET * LAYOUTS.length);
  const run = (name: string) => {
    const r = runs.get(name);
    if (r === undefined) throw new Error(`no replay of ${name}`);
    return r;
  };

  test("E6: the Claude plan's 1-hour marks leave fewer cold turns, write less and read more than 5-minute ones, on the same chat", () => {
    const hour = summary(run("claude-code")), five = summary(run("claude-code-5m"));
    expect(hour.cold).toBeLessThan(five.cold);
    expect(hour.written).toBeLessThan(five.written);
    expect(hour.turnRead).toBeGreaterThan(five.turnRead);
  });

  test("E26: a compaction on the turns' model reads the turns' tools and system entry on an API key", () => {
    expect(checks(run("api-key")).turnEntries.requests).toBeGreaterThan(0);
  });

  test("a guard on the shipped config: its compactor chains share no model with its turns, so no compaction reads a turn's entry", () => {
    expect(checks(run("shipped")).turnEntries.requests).toBe(0);
  });
});
