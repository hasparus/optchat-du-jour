// The session's inbox (src/session.ts, SPEC "Turn and priming"): every message from a client that
// is not logged yet, in the order they came in, and the rules over it, as plain functions over the
// array. The order is the offered messages first, then the picked or held ones: nothing is offered
// once anything is held, so the log keeps the order they were sent in.
import type { Deferred } from "effect";
import type { Asset } from "./wire.ts";

// A message from a client, the session's until it is logged: "held" for a turn, "picked" by the
// turn that is logging it now, or "offered" to the running call, which may take it (it is logged
// then) or leave it (it comes back "held" when the call ends). Only a held one can be taken back.
// Each carries the id its client sent it with, so its ack names it. (The state clients see lists
// all of them as `pending`.)
export type Incoming = {
  readonly seq: number; // the order messages came in
  readonly text: string; // as typed; the log gets it with a marker line per attachment
  readonly media: readonly Asset[];
  device: string | null; // the device it was sent for; one a call left gets that call's device
  readonly clientId: string | null;
  state: "held" | "picked" | "offered";
  readonly steer: boolean; // sent mid-run, it joins the running call; else it waits for the next turn
  // the captions of its attachments, asked for once (session.ts `captionsOf`); null until needed
  described: Deferred.Deferred<readonly string[]> | null;
};

export const held = (inbox: readonly Incoming[]) => inbox.filter((m) => m.state === "held");
export const offered = (inbox: readonly Incoming[]) => inbox.filter((m) => m.state === "offered");

// a message sent for no device, or for the one the turn runs on, may join it; one sent for
// another waits, and the turn after it runs there
export const forThis = (sentFor: string | null, on: string) => sentFor === null || sentFor === on;

// the held messages before the first one for another device than `on`: those that may run there
// now, in the order sent; that one waits for the turn after, with all sent after it
const runnable = (inbox: readonly Incoming[], on: string) => {
  const waiting = held(inbox);
  const other = waiting.findIndex((m) => !forThis(m.device, on));
  return other === -1 ? waiting : waiting.slice(0, other);
};

// The next turn's device and messages: the device of the first held message that has one (sent
// for it, or left by a call that ran there), else the default; and the held messages up to the
// first one for another device.
export const nextTurn = (inbox: readonly Incoming[], defaultDevice: string) => {
  const on = held(inbox).find((m) => m.device)?.device ?? defaultDevice;
  return { batch: runnable(inbox, on), on };
};

// The held messages that join the call running on `on`, marked offered and returned for its
// queue: of those that may run there, every one up to the last that was sent to steer, oldest
// first. So a message that steers takes the ones queued before it along, none overtakes one sent
// before it, and the inbox keeps its order.
export const steerIn = (inbox: readonly Incoming[], on: string): Incoming[] => {
  const may = runnable(inbox, on);
  const joining = may.slice(0, may.findLastIndex((m) => m.steer) + 1);
  for (const m of joining) m.state = "offered";
  return joining;
};

// The call is over, or its turn stopped: what it was offered and never took is held again, on its
// device `on` unless it was sent for one, and so is what a turn that stopped had picked. Held ones
// (queued, or for another device) stay as they are. Returns the ones that were offered.
export const giveBack = (inbox: readonly Incoming[], on: string): Incoming[] => {
  const left = offered(inbox);
  for (const m of inbox) {
    if (m.state === "held") continue;
    m.state = "held";
    m.device ??= on;
  }
  return left;
};

// A held message out of the inbox by its client id, for whichever client asks (one user, one
// shared queue); one a turn picked or a call was offered is the turn's
export const takeBack = (inbox: Incoming[], clientId: string): { readonly taken: Incoming } | { readonly error: string } => {
  const m = inbox.find((x) => x.clientId === clientId);
  if (!m) return { error: "the server holds no such message" };
  if (m.state !== "held") return { error: "too late: the model has it" };
  inbox.splice(inbox.indexOf(m), 1);
  return { taken: m };
};
