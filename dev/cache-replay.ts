#!/usr/bin/env bun
// The cache replay's numbers (test/cache-replay.ts): every layout over the same chat, on
// docs/optchat.md's sawtooths (the test runs a shorter chat on smaller ones), as a table of tokens
// read, written and sent uncached per engine and role, cold turns and dollars at the price table,
// then the checks the test makes. Against fake vendors (test/fake-cache.ts has their rules): it
// shows our requests are cache-shaped, not what a real vendor does with them.
// Usage: bun dev/cache-replay.ts [turns = 200] [seed = 1] [layout…]; `--test` runs the test's chat
import { checks, LAYOUTS, replay, type Row, rows, script, summary, table, TEST_MARKS, TEST_TURNS } from "../test/cache-replay.ts";

const args = process.argv.slice(2);
const small = args.includes("--test");
const [turns = small ? String(TEST_TURNS) : "200", seed = "1", ...names] = args.filter((a) => a !== "--test");
const steps = script(Number(turns), Number(seed));
const all: Row[] = [];
const notes: string[] = [];
for (const layout of LAYOUTS.filter((l) => names.length === 0 || names.includes(l.name))) {
  const started = performance.now();
  const r = await replay(layout, steps, small ? TEST_MARKS : undefined);
  const c = checks(r);
  const s = summary(r);
  all.push(...rows(r));
  notes.push(
    `${layout.name} (${layout.what}): ${r.messages} log entries, ${r.batches} view batches, ${r.sent.length} requests, ${Math.round(performance.now() - started)} ms. ` +
      `Turns read ${(100 * s.turnRead).toFixed(1)}%, compactions ${(100 * s.compactRead).toFixed(1)}%; ${s.cold} cold turns; $${s.dollars.toFixed(2)} at the price table. ` +
      `Continuations read whole: ${c.continuations.checked - c.continuations.broken.length}/${c.continuations.checked}; ` +
      `turns warm from priming: ${c.primed.warm} (${c.primed.broken.length} not); ` +
      `compaction prefixes written twice: ${c.doubleWrites.broken.length} of ${c.doubleWrites.checked}; ` +
      `compactions reading a turn's entry: ${c.turnEntries.requests} (${c.turnEntries.tokens} tokens); ` +
      `logged vs vendor read ${c.accounting.logged.read}/${c.accounting.vendor.read}, written ${c.accounting.logged.written}/${c.accounting.vendor.written}; ` +
      `reports: ${r.reports.length === 0 ? "none" : r.reports.join(" / ")}`,
  );
}
process.stdout.write(`${table(all)}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`);
