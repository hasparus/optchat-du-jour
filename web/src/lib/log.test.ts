import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { type Entry, said, snapshot } from "../test/fixture";
import { applyEvent, applyPage, emptyLog } from "./log";

const read = (via: "snapshot" | "page", log: typeof emptyLog, entries: readonly Entry[]) =>
  via === "snapshot" ? applyEvent(log, snapshot(entries)) : applyPage(log, entries.map((e, i) => ({ ...e, i })));

for (const via of ["snapshot", "page"] as const) {
  describe(`canonical ${via} sharing`, () => {
    test("identical canonical entries keep their objects at the same index", () => {
      const entries: Entry[] = [{ kind: "user", text: "go" }, { kind: "echo", text: "out", error: true }];
      const before = read(via, emptyLog, entries);
      const after = read(via, before, entries.map((e) => ({ ...e })));
      expect(after.items.get(0)).toBe(before.items.get(0));
      expect(after.items.get(1)).toBe(before.items.get(1));
    });

    test("changed kind, text or error invalidates only the changed item", () => {
      const first = { kind: "user", text: "same" } satisfies Entry;
      const entries: Entry[] = [first, { kind: "echo", text: "out" }];
      const before = read(via, emptyLog, entries);
      for (const changed of [
        { kind: "talk", text: "out" },
        { kind: "echo", text: "different" },
        { kind: "echo", text: "out", error: true },
      ] satisfies Entry[]) {
        const after = read(via, before, [first, changed]);
        expect(after.items.get(0)).toBe(before.items.get(0));
        expect(after.items.get(1)).not.toBe(before.items.get(1));
        expect(after.items.get(1)).toMatchObject(changed);
      }
      const failed = read(via, before, [{ kind: "user", text: "same" }, { kind: "echo", text: "out", error: true }]);
      const cleared = read(via, failed, entries);
      expect(cleared.items.get(1)).not.toBe(failed.items.get(1));
      expect(cleared.items.get(1)?.error).toBeUndefined();
    });

    test("live to canonical replaces provenance, then survives a window shift; unconfirmed live entries do not", () => {
      let live = emptyLog;
      for (const event of said(0, "user", "confirmed")) live = applyEvent(live, event);
      const confirmed = read(via, live, [{ kind: "user", text: "confirmed" }]);
      expect(confirmed.items.get(0)).not.toBe(live.items.get(0));
      expect(confirmed.items.get(0)?.live).toBe(false);
      let tail = confirmed;
      for (const event of said(1, "assistant", "unconfirmed")) tail = applyEvent(tail, event);
      const shifted = applyEvent(tail, snapshot([{ kind: "user", text: "next window" }], 2));
      expect(shifted.items.get(0)).toBe(confirmed.items.get(0));
      expect(shifted.items.has(1)).toBe(false);
      expect(shifted.base).toBe(2);
      expect(shifted.draft).toBeNull();
    });
  });
}

test("canonical equality does not merge entries at different indices", () => {
  const before = applyEvent(emptyLog, snapshot([{ kind: "talk", text: "same" }]));
  const after = applyEvent(before, { messages: [{ content: "same", id: "1", role: "assistant" }], type: EventType.MESSAGES_SNAPSHOT });
  expect(after.items.get(1)).not.toBe(before.items.get(0));
  expect(after.items.get(1)?.i).toBe(1);
});
