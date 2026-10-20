#!/usr/bin/env bun
// The cache replay's numbers (test/cache-replay.ts): every layout over the same chat, on
// docs/optchat.md's sawtooths (the test runs a shorter chat on smaller ones), as a table of tokens
// read, written and sent uncached per engine and role, cold turns and dollars at the price table,
// then the checks the test makes. Against fake vendors (test/fake-cache.ts has their rules): it
// shows our requests are cache-shaped, not what a real vendor does with them.
// Usage: bun dev/cache-replay.ts [turns = 200] [seed = 1] [layout…]
//        bun dev/cache-replay.ts --test   the test's chat, twice: the two runs must agree, and
//                                          RECORDED prints for test/cache-replay.test.ts
import { afterLongTurn, checks, LAYOUTS, type Layout, replay, type Row, rows, script, summary, table, TEST_MARKS, TEST_TURNS } from "../test/cache-replay.ts";

const args = process.argv.slice(2);
const small = args.includes("--test");
const [turns = small ? String(TEST_TURNS) : "200", seed = "1", ...names] = args.filter((a) => a !== "--test");
const steps = script(Number(turns), Number(seed));
const layouts = LAYOUTS.filter((l) => names.length === 0 || names.includes(l.name));

// one run of every layout: the table, a note per layout, and what the test records
const once = async () => {
  const all: Row[] = [];
  const notes: string[] = [];
  const recorded: Record<string, ReturnType<typeof summary> & { readonly afterLongTurn: ReturnType<typeof afterLongTurn> }> = {};
  const times: number[] = [];
  for (const layout of layouts) {
    const started = performance.now();
    const r = await replay(layout, steps, small ? TEST_MARKS : undefined);
    times.push(Math.round(performance.now() - started));
    const c = checks(r);
    const s = summary(r);
    const long = afterLongTurn(r.sent);
    all.push(...rows(r));
    recorded[layout.name] = { ...s, afterLongTurn: long };
    notes.push(
      `${layout.name} (${layout.what}): ${r.messages} log entries, ${r.batches} view batches, ${r.sent.length} requests. ` +
        `Turns read ${(100 * s.turnRead).toFixed(1)}%, compactions ${(100 * s.compactRead).toFixed(1)}%; ${s.cold} cold turns; $${s.dollars.toFixed(2)} at the price table. ` +
        `Continuations read whole: ${c.continuations.checked - c.continuations.broken.length}/${c.continuations.checked}; ` +
        `turns warm from priming: ${c.primed.warm} (${c.primed.broken.length} not); ` +
        `the turn queued behind the long one: ${long === null ? "none" : `${long.blocksBack === null ? "no primed mark left" : `${long.blocksBack} blocks past the last priming's mark`}, read ${long.read} of ${long.total}`}; ` +
        `compaction prefixes written twice: ${c.doubleWrites.broken.length} of ${c.doubleWrites.checked}; ` +
        `compactions reading a turn's entry: ${c.turnEntries.requests} (${c.turnEntries.tokens} tokens); ` +
        `usage limits ${r.limits}, resumes ${r.resumes}; ` +
        `logged vs vendor read ${c.accounting.logged.read}/${c.accounting.vendor.read}, written ${c.accounting.logged.written}/${c.accounting.vendor.written}; ` +
        `reports: ${r.reports.length === 0 ? "none" : r.reports.join(" / ")}`,
    );
  }
  return { out: `${table(all)}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`, recorded, times };
};

const name = (l: Layout) => l.name;
const first = await once();
process.stderr.write(`${layouts.map(name).map((n, k) => `${n} ${first.times[k] ?? 0} ms`).join(", ")}\n`);
process.stdout.write(first.out);
if (small) {
  const again = await once();
  if (again.out !== first.out) {
    process.stderr.write("the second run differs from the first: the replay is not deterministic\n");
    process.exitCode = 1;
  }
  process.stdout.write(`\nRECORDED (test/cache-replay.test.ts):\n${JSON.stringify(first.recorded, null, 2)}\n`);
}
