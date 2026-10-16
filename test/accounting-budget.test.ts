import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { logUsage, type UsageRecord } from "../src/usage.ts";

const dir = mkdtempSync(`${tmpdir()}/budget-`);
afterAll(() => { rmSync(dir, { force: true, recursive: true }); });
const date = new Date(2026, 9, 5);
const charge = (dollars?: number, at = date): UsageRecord => ({ attempt: 1, auth: "api-key", cold: false, date: at.toISOString(), device: null, dollars, engine: "api-key", failoverFrom: null, level: null, model: "fake", ms: 0, role: "caption", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 0 } });
const tag = async (e: Effect.Effect<void, { readonly _tag: string }>) => {
  const r = await Effect.runPromise(Effect.result(e));
  return r._tag === "Success" ? "ok" : r.failure._tag;
};

test("two failed reads authorize no requests; recovery loads actual spend", async () => {
  const path = `${dir}/unreadable`;
  mkdirSync(path);
  const b = makeBudget({ monthly: 10, now: () => date, report: () => Effect.void, usagePath: path });
  let requests = 0;
  const call = b.check.pipe(Effect.andThen(Effect.sync(() => { requests++; })));
  expect(await tag(call)).toBe("ModelError");
  expect(await tag(call)).toBe("ModelError");
  expect(requests).toBe(0);
  rmSync(path, { recursive: true });
  writeFileSync(path, JSON.stringify(charge(12)));
  expect(await tag(call)).toBe("UsageLimit");
  expect(b.spent()).toBe(12);
  expect(requests).toBe(0);
});

test("rollover publishes no partial balance; clean checks recover", async () => {
  const path = `${dir}/roll`;
  writeFileSync(path, JSON.stringify(charge(4)));
  let now = date;
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.void, usagePath: path });
  expect(await tag(b.check)).toBe("ok");
  now = new Date(2026, 10, 1);
  writeFileSync(path, "broken");
  expect(await tag(b.check)).toBe("ModelError");
  expect(b.spent()).toBe(4);
  expect(await tag(b.check)).toBe("ModelError");
  writeFileSync(path, JSON.stringify(charge(11, now)));
  expect(await tag(b.check)).toBe("UsageLimit");
  expect(b.spent()).toBe(11);
});

for (const appendWorks of [false, true]) test(`note on failed load permits append (${appendWorks}) but quarantines month`, async () => {
  const path = `${dir}/pending-${appendWorks}`;
  mkdirSync(path);
  const b = makeBudget({ monthly: 10, now: () => date, report: () => Effect.void, usagePath: path });
  const record = charge(3);
  await Effect.runPromise(b.note(record));
  if (appendWorks) rmSync(path, { recursive: true });
  const error = await Effect.runPromise(logUsage(path, record));
  expect(error === null).toBe(appendWorks);
  if (!appendWorks) { rmSync(path, { recursive: true }); writeFileSync(path, JSON.stringify(record)); }
  expect(await tag(b.check)).toBe("ModelError");
  expect(await tag(b.check)).toBe("ModelError");
  expect(b.spent()).toBe(3);
});

test("retains trusted increments, quarantine and out-of-month notes across clock rollback", async () => {
  const path = `${dir}/rollback`;
  let now = date;
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.void, usagePath: path });
  await Effect.runPromise(b.check);
  await Effect.runPromise(b.note(charge(4)));
  now = new Date(2026, 10, 2);
  await Effect.runPromise(b.check);
  await Effect.runPromise(b.note(charge(5, now)));
  await Effect.runPromise(b.note(charge(3, date)));
  now = date;
  await Effect.runPromise(b.check);
  expect(b.spent()).toBe(7);
  now = new Date(2026, 10, 2);
  await Effect.runPromise(b.check);
  expect(b.spent()).toBe(5);
});

test("failed rollover notes quarantine without replacing prior trusted balance, even after repair/rollback", async () => {
  const path = `${dir}/roll-note`;
  let now = date;
  writeFileSync(path, JSON.stringify(charge(2)));
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.void, usagePath: path });
  await Effect.runPromise(b.check);
  await Effect.runPromise(b.note(charge(3)));
  now = new Date(2026, 10, 1);
  writeFileSync(path, "broken");
  expect(await tag(b.check)).toBe("ModelError");
  await Effect.runPromise(b.note(charge(4, now)));
  await Effect.runPromise(b.note(charge(2, now)));
  writeFileSync(path, JSON.stringify(charge(4, now)));
  expect(await tag(b.check)).toBe("ModelError");
  expect(b.spent()).toBe(6);
  now = date;
  expect(await tag(b.check)).toBe("ok");
  expect(b.spent()).toBe(5);
  now = new Date(2026, 11, 1);
  expect(await tag(b.check)).toBe("ok");
  now = new Date(2026, 10, 1);
  expect(await tag(b.check)).toBe("ModelError");
  expect(b.spent()).toBe(6);
});

for (const notesFirst of [false, true]) test(`concurrent synchronous checks/notes serialize without losing increments (${notesFirst})`, async () => {
  const b = makeBudget({ monthly: 100, now: () => date, report: () => Effect.void, usagePath: `${dir}/ordering-${notesFirst}` });
  const notes = Array.from({ length: 30 }, () => b.note(charge(1)));
  const checks = Array.from({ length: 30 }, () => b.check);
  await Effect.runPromise(Effect.all(notesFirst ? [...notes, ...checks] : [...checks, ...notes], { concurrency: "unbounded" }));
  expect(b.spent()).toBe(30);
});

test("unpriceable notes block only their month; observer defect cannot replace denial", async () => {
  let now = date;
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.die("report defect"), usagePath: `${dir}/unknown` });
  await Effect.runPromise(b.note(charge()));
  expect(await tag(b.check)).toBe("ModelError");
  now = new Date(2026, 10, 2);
  expect(await tag(b.check)).toBe("ok");
  await Effect.runPromise(b.note(charge(12, now)));
  expect(await tag(b.check)).toBe("UsageLimit");
  expect(await tag(b.check)).toBe("UsageLimit");
  now = date;
  expect(await tag(b.check)).toBe("ModelError");
});
