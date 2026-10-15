import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { readBudgetUsage, readUsage, type UsageRecord } from "../src/usage.ts";

const dir = mkdtempSync(`${tmpdir()}/strict-usage-`);
afterAll(() => { rmSync(dir, { force: true, recursive: true }); });
const now = new Date(2026, 9, 5);
const record: UsageRecord = { attempt: 1, auth: "api-key", cold: false, date: now.toISOString(), device: null, dollars: 3, engine: "api-key", failoverFrom: null, level: null, model: "fake", ms: 0, role: "caption", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 0 } };

test("strict reader: only ENOENT is empty, not EACCES/EISDIR", () => {
  expect(readBudgetUsage(`${dir}/absent`)).toEqual([]);
  for (const code of ["EACCES", "EISDIR"]) expect(() => readBudgetUsage("fake", () => { throw Object.assign(new Error("private path"), { code }); })).toThrow("ledger is unavailable");
  expect(() => readBudgetUsage(dir)).toThrow("ledger is unavailable");
});

test("blank and narrowly recognized legacy envelopes skip; modern unknown fields remain compatible", () => {
  const path = `${dir}/valid`;
  writeFileSync(path, `\n \n${JSON.stringify({ date: record.date, kind: "turn", model: "old", usage: { input_tokens: 3 } })}\n${JSON.stringify({ ...record, future: true })}\n`);
  expect(readBudgetUsage(path)).toEqual([record]);
  expect(readUsage(path)).toEqual([record]);
});

const invalid = [
  "{private malformed",
  "{}",
  JSON.stringify({ date: record.date, kind: "turn", model: "old", usage: {}, auth: "api-key" }),
  JSON.stringify({ ...record, date: "invalid private date" }),
  JSON.stringify({ ...record, dollars: undefined }),
  JSON.stringify({ ...record, dollars: -1 }),
  JSON.stringify({ ...record, dollars: null }),
  JSON.stringify({ ...record, usage: { ...record.usage, input: -1 } }),
  JSON.stringify(record).replace('"dollars":3', '"dollars":1e999'),
];
for (const [i, line] of invalid.entries()) test(`strict invalid ledger ${i} fails safely; tolerant API still skips/reads as before`, async () => {
  const path = `${dir}/invalid-${i}`;
  writeFileSync(path, line);
  expect(() => readBudgetUsage(path)).toThrow("ledger is invalid");
  expect(() => readUsage(path)).not.toThrow();
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.void, usagePath: path });
  const error = await Effect.runPromise(Effect.flip(b.check));
  expect(error._tag).toBe("ModelError");
  expect(error.message).not.toContain(path);
  expect(error.message).not.toContain("private");
});

test("finite individual dollars cannot overflow the aggregate", async () => {
  const path = `${dir}/overflow`;
  writeFileSync(path, [record, record].map((r) => JSON.stringify({ ...r, dollars: Number.MAX_VALUE })).join("\n"));
  const b = makeBudget({ monthly: 10, now: () => now, report: () => Effect.void, usagePath: path });
  const error = await Effect.runPromise(Effect.flip(b.check));
  expect(error._tag).toBe("ModelError");
  expect(b.spent()).toBe(0);
});
