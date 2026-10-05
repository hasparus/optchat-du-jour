// The inbox's rules (src/inbox.ts) without the turn loop: its order (offered, then held), the cut
// at the first message for another device, the steer prefix, the hand-back and take-back.
import { describe, expect, test } from "bun:test";
import { forThis, giveBack, held, type Incoming, nextTurn, offered, steerIn, takeBack } from "../src/inbox.ts";

let seq = 0;
const msg = (text: string, o: { device?: string; steer?: boolean; state?: Incoming["state"] } = {}): Incoming => ({
  clientId: `c-${text}`,
  described: null,
  device: o.device ?? null,
  media: [],
  seq: ++seq,
  state: o.state ?? "held",
  steer: o.steer ?? true,
  text,
});
const texts = (ms: readonly Incoming[]) => ms.map((m) => m.text);
const states = (ms: readonly Incoming[]) => ms.map((m) => `${m.text}:${m.state}`);

describe("inbox", () => {
  test("forThis: no device, or the turn's own", () => {
    expect([forThis(null, "mini"), forThis("mini", "mini"), forThis("mac", "mini")]).toEqual([true, true, false]);
  });

  test("nextTurn: the device of the first held message that has one, and the held ones up to the first for another", () => {
    const inbox = [msg("a"), msg("b", { device: "mac" }), msg("c"), msg("d", { device: "mini" }), msg("e")];
    expect(nextTurn(inbox, "mini")).toEqual({ batch: inbox.slice(0, 3), on: "mac" });
    expect(nextTurn([msg("x"), msg("y")], "mini").on).toBe("mini");
    // offered and picked ones are the running turn's, not the next one's
    expect(texts(nextTurn([msg("o", { state: "offered" }), msg("p", { state: "picked" }), msg("h")], "mini").batch)).toEqual(["h"]);
  });

  test("steerIn: held ones up to the last that steers, never past one for another device; the inbox stays offered-then-held", () => {
    const queueing = [msg("q1", { steer: false }), msg("q2", { steer: false })];
    expect(steerIn(queueing, "mini")).toEqual([]);
    expect(states(queueing)).toEqual(["q1:held", "q2:held"]);

    // a message that steers takes the ones queued before it along, not the one queued after
    const mixed = [msg("q1", { steer: false }), msg("s", { steer: true }), msg("q2", { steer: false })];
    expect(texts(steerIn(mixed, "mini"))).toEqual(["q1", "s"]);
    expect(states(mixed)).toEqual(["q1:offered", "s:offered", "q2:held"]);

    // one for another device stops it: it waits with everything after it, also one that steers
    const devices = [msg("here"), msg("there", { device: "mac" }), msg("after")];
    expect(texts(steerIn(devices, "mini"))).toEqual(["here"]);
    expect(states(devices)).toEqual(["here:offered", "there:held", "after:held"]);
    // nothing joins once a message is held before it
    expect(steerIn(devices, "mini")).toEqual([]);

    // the order holds in every case: no offered one after a held one
    for (const inbox of [queueing, mixed, devices]) {
      const firstHeld = inbox.findIndex((m) => m.state === "held");
      expect(firstHeld === -1 || inbox.slice(firstHeld).every((m) => m.state !== "offered")).toBe(true);
    }
  });

  test("giveBack: offered and picked ones are held again on the call's device unless sent for one; held ones keep theirs", () => {
    const inbox = [msg("o", { state: "offered" }), msg("p", { device: "mac", state: "picked" }), msg("h")];
    expect(texts(giveBack(inbox, "mini"))).toEqual(["o"]);
    expect(inbox.map((m) => [m.text, m.state, m.device])).toEqual([
      ["o", "held", "mini"],
      ["p", "held", "mac"],
      ["h", "held", null],
    ]);
    expect([held(inbox).length, offered(inbox).length]).toEqual([3, 0]);
  });

  test("takeBack: a held message leaves the inbox, by any client's ask; one the turn has, or none, is refused", () => {
    const inbox = [msg("o", { state: "offered" }), msg("p", { state: "picked" }), msg("h")];
    expect(takeBack(inbox, "c-o")).toEqual({ error: "too late: the model has it" });
    expect(takeBack(inbox, "c-p")).toEqual({ error: "too late: the model has it" });
    expect(takeBack(inbox, "nobody")).toEqual({ error: "the server holds no such message" });
    const out = takeBack(inbox, "c-h");
    expect("taken" in out ? out.taken.text : null).toBe("h");
    expect(texts(inbox)).toEqual(["o", "p"]);
  });
});
