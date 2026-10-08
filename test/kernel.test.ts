// The Bend kernel against a literal model of the view, written from the gist's prose alone
// (gist §3 "Addressing", §4.1; the merge order of the 2026-10-08 gist §3.2). Seeded random chats,
// several budgets; after every step the kernel and the model must agree on the view, `first` and
// rule 3's offers, and now and then on the refold from message 0. Then the merge order against
// Taelin's rollback push, the check the gist itself reports (§3.2).
import { expect, test } from "bun:test";
import kernel, { type List, type Part } from "../kernel/kernel.mjs";
import * as K from "../src/kernel.ts";
import { type Coord, newMem, setNode } from "../src/tree.ts";
import { PLACEHOLDER } from "../src/view.ts";

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s).length; // the model's own byte count
const HOLE = utf8(PLACEHOLDER);

// The model: plain arrays, every rule spelled out as the gist states it.
class Model {
  T = 0;
  view: Coord[] = [];
  readonly sizes = new Map<string, number>(); // built nodes: "l,i" -> bytes of their text
  constructor(readonly budget: number) {}

  has = (c: Coord) => this.sizes.has(`${c.l},${c.i}`);
  size = (c: Coord) => this.sizes.get(`${c.l},${c.i}`) ?? HOLE; // an unbuilt part counts its placeholder
  start = (c: Coord) => c.i * 2 ** c.l;

  // while over budget, replace the most due adjacent built pair by its parent; ties to the left.
  // due = (T - last) / 2^l, last being the pair's last message: how long ago it ended, in its own
  // line size (exact in binary floating point)
  fit() {
    let total = this.view.reduce((sum, c) => sum + this.size(c), 0);
    while (total > this.budget) {
      let best = -1, most = -1;
      for (const [k, left] of this.view.entries()) {
        const right = this.view[k + 1];
        if (right === undefined) break;
        // siblings: one level, `left` at an even index, `right` just after it, their parent built
        const siblings = left.l === right.l && left.i % 2 === 0 && right.i === left.i + 1;
        if (!siblings || !this.has({ i: left.i / 2, l: left.l + 1 })) continue;
        const due = (this.T - (this.start(left) + 2 * 2 ** left.l - 1)) / 2 ** left.l;
        if (due > most) [best, most] = [k, due];
      }
      if (best === -1) return; // no pair has its parent yet: over budget until one is built
      const a = this.view[best]!, b = this.view[best + 1]!, up = { i: a.i / 2, l: a.l + 1 };
      total += this.size(up) - this.size(a) - this.size(b);
      this.view.splice(best, 2, up);
    }
  }

  append() {
    this.view.push({ i: this.T, l: 0 });
    this.T++;
    this.fit();
  }

  build(l: number, i: number, bytes: number) {
    this.sizes.set(`${l},${i}`, bytes);
    this.fit();
  }

  // at load: the same append + fit for every message in order, against today's tree
  refold() {
    const m = new Model(this.budget);
    for (const [k, v] of this.sizes) m.sizes.set(k, v);
    while (m.T < this.T) m.append();
    return m.view;
  }

  first() {
    const p = this.view.find((c) => !this.has(c));
    return p ? this.start(p) : this.T;
  }

  // its message is logged, or both its children are built
  ready = (c: Coord) =>
    c.l === 0 ? c.i < this.T : this.has({ i: 2 * c.i, l: c.l - 1 }) && this.has({ i: 2 * c.i + 1, l: c.l - 1 });

  // every node over whole messages, unbuilt and with its sources there: level 0 up, oldest first
  // (what the free-node pass may build, rule 3 aside)
  candidates() {
    const found: Coord[] = [];
    for (let l = 0, width = 1; width <= this.T; l++, width *= 2)
      for (let i = 0; i < Math.floor(this.T / width); i++) if (!this.has({ i, l }) && this.ready({ i, l })) found.push({ i, l });
    return found;
  }

  // rule 3 (gist §4.1): unbuilt, its sources there, everything before its end summarized; a
  // message's own summary waits for the lines before it, a merge for all it covers
  offers() {
    const head = this.first();
    return this.candidates().filter((c) => (c.l === 0 ? c.i : (c.i + 1) * 2 ** c.l) <= head);
  }
}

// id+n names a node when n is a power of two, id is a multiple of n and the n messages from id
// are all logged (gist §3, §7.1)
function named(id: number, n: number, logged: number): Coord | null {
  const l = Math.log2(n);
  const fits = Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= logged;
  return fits ? { i: id / n, l } : null;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D_2B_79_F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const CHARS = ["a", "b", " ", "\n", "ä", "ß", "日", "本", "😀", "\u{10348}"];
function text(r: () => number, max: number) {
  let out = "";
  for (let left = 1 + Math.floor(r() * max); left > 0; left--) out += CHARS[Math.floor(r() * CHARS.length)];
  return out;
}

// `appends`: the share of steps that log a message; low, the compactor keeps up, high, it lags
function run(seed: number, budget: number, steps: number, appends: number) {
  const r = rng(seed), model = new Model(budget), mem = newMem(budget);
  for (let step = 0; step < steps; step++) {
    const offered = model.offers(), roll = r();
    // mostly the pump's order; sometimes any ready node (free nodes skip rule 3); and runs of
    // messages with nothing built, so the view sits over budget with unbuilt lines
    const pool = roll < appends ? [] : roll < 0.9 ? offered : model.candidates();
    const pick = pool[Math.floor(r() * pool.length)];
    if (pick) {
      const t = text(r, r() < 0.1 ? 400 : 120);
      setNode(mem, { i: pick.i, l: pick.l, text: t });
      mem.view = K.fit(mem, HOLE);
      model.build(pick.l, pick.i, utf8(t));
    } else {
      const t = text(r, r() < 0.05 ? 3000 : 200);
      mem.root.push({ date: new Date(0).toISOString(), i: mem.root.length, kind: "user", size: utf8(`user: ${t}`), text: t });
      mem.view = K.append(mem, HOLE);
      model.append();
    }
    expect(mem.view).toEqual(model.view);
    expect(K.first(mem)).toBe(model.first());
    expect(K.offers(mem)).toEqual(model.offers());
    if (step % 25 === 24) expect(K.refold(mem, HOLE)).toEqual(model.refold());
  }
  expect(K.refold(mem, HOLE)).toEqual(model.refold());
  return model;
}

test("the kernel's view, refold, first and rule-3 offers match the gist's literal model", () => {
  const budgets = [200, 450, 1000, 2500, 6000, 10_000];
  let merged = 0;
  for (const [k, budget] of budgets.entries())
    for (const [seed, appends] of [0.15, 0.25, 0.35, 0.5].entries()) {
      const model = run(1000 * k + seed, budget, 300, appends);
      merged += model.view.filter((c) => c.l > 0).length;
    }
  expect(merged).toBeGreaterThan(0); // the runs did exercise fit
});

test("id+n addressing matches the gist for every id, n and T under 70", () => {
  for (let T = 0; T < 70; T++)
    for (let n = 0; n < 70; n++) for (let id = 0; id < 70; id++) expect(K.address(id, n, T)).toEqual(named(id, n, T));
  expect(K.address(1.5, 1, 4)).toBeNull();
  expect(K.address(-1, 1, 4)).toBeNull();
});

const logged = (i: number) => ({ date: "2026-10-05T00:00:00.000Z", i, kind: "user" as const, size: 9, text: "x" });

// A view waits on a long backlog after a big import: 100k lines, nothing to merge. Every walk over it
// must stay off the JS stack (it overflows past ~20k nested calls), and refold must not go quadratic.
test("a 100k-line view refolds, appends, fits and offers without blowing the stack", () => {
  const T = 100_000, mem = newMem(128_000);
  for (let k = 0; k < T; k++) mem.root.push(logged(k));
  for (let i = 0; i < T; i += 2) setNode(mem, { i, l: 0, size: 100, text: "z".repeat(100) }); // every other leaf built
  const t0 = performance.now();
  mem.view = K.refold(mem, HOLE);
  expect(mem.view).toHaveLength(T);
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(K.first(mem)).toBe(1);
  expect(K.offers(mem)).toEqual([{ i: 1, l: 0 }]);
  mem.root.push(logged(T));
  mem.view = K.append(mem, HOLE);
  expect(mem.view).toHaveLength(T + 1);
  expect(K.fit(mem, HOLE)).toHaveLength(T + 1);
});

// Taelin's push (rollback_state_list.js, 2022, as gist §3.1 quotes it), life = 0: a list of
// states, newest first, each with one bit
type States = { readonly keep: 0 | 1; readonly life: number; readonly state: number; readonly older: States } | null;
function push(fresh: number, states: States): States {
  if (states === null) return { keep: 0, life: 0, older: null, state: fresh };
  const { keep, life, older, state } = states;
  if (keep === 0) return { keep: 1, life, older, state };
  if (life > 0) return { keep: 0, life: 0, older: { keep: 0, life: life - 1, older, state }, state: fresh };
  return { keep: 0, life, older: push(state, older), state: fresh };
}
// the list read as a view of T messages, oldest line first: each state starts a line that runs
// up to the next newer state, the newest up to T
function asView(states: States, T: number): Coord[] {
  const view: Coord[] = [];
  let end = T;
  for (let at = states; at; at = at.older) {
    const width = end - at.state;
    view.push({ i: at.state / width, l: Math.log2(width) });
    end = at.state;
  }
  return view.toReversed();
}

// The merge order alone, by line count: every line 1 byte and every parent built, so a budget of
// n bytes is n lines. One step appends message t's line and fits to the push list's length.
const nil: List<never> = { $: "Nil" };
function toList<T>(xs: readonly T[]): List<T> {
  let out: List<T> = nil;
  for (const head of xs.toReversed()) out = { $: "Con", head, tail: out };
  return out;
}
const ancestors = toList(Array.from({ length: 40 }, () => 1)); // more than any line here has
const line = (c: Coord): Part => ({ $: "Part", built: true, i: c.i, l: c.l, size: 1, ups: ancestors });
function kernelFit(view: readonly Coord[], T: number, lines: number): Coord[] {
  const out: Coord[] = [];
  for (let at = kernel.fit(T, lines, toList(view.map(line))); at.$ === "Con"; at = at.tail) out.push({ i: Number(at.head.i), l: Number(at.head.l) });
  return out;
}
// the first version of the recipe: due from the pair's first message, (T - first) / 2^(l+2)
function firstMessageFit(view: readonly Coord[], T: number, lines: number): Coord[] {
  const v = [...view];
  while (v.length > lines) {
    let best = -1, most = -1;
    for (const [k, a] of v.entries()) {
      const b = v[k + 1];
      if (b === undefined) break;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      const due = (T - a.i * 2 ** a.l) / 2 ** (a.l + 2);
      if (due > most) [best, most] = [k, due];
    }
    const a = v[best];
    if (a === undefined) break;
    v.splice(best, 2, { i: a.i / 2, l: a.l + 1 });
  }
  return v;
}
// at how many steps t = 0..last a fit's view equals push's list, each step building on its own
// view of the step before
function matches(fit: (view: readonly Coord[], T: number, lines: number) => Coord[], last: number) {
  let states: States = null, view: Coord[] = [], same = 0;
  for (let t = 0; t <= last; t++) {
    states = push(t, states);
    const want = asView(states, t + 1);
    view = fit([...view, { i: t, l: 0 }], t + 1, want.length);
    if (JSON.stringify(view) === JSON.stringify(want)) same++;
  }
  return same;
}

test("push's list as the view: with its length as the budget, the kernel makes exactly push's merges", () => {
  // the gist's own example of the first ten pushes: at t=9 the lines 0+4, 4+4, 8+2
  let states: States = null;
  for (let t = 0; t <= 9; t++) states = push(t, states);
  expect(asView(states, 10)).toEqual([{ i: 0, l: 2 }, { i: 1, l: 2 }, { i: 4, l: 1 }]);
  // gist §3.2: at T=10 with 0+4, 4+4, 8+1, 9+1, push merges 8-9; due from the first message merges 0-7
  const at10 = [{ i: 0, l: 2 }, { i: 1, l: 2 }, { i: 8, l: 0 }, { i: 9, l: 0 }];
  expect(kernelFit(at10, 10, 3)).toEqual([{ i: 0, l: 2 }, { i: 1, l: 2 }, { i: 4, l: 1 }]);
  expect(firstMessageFit(at10, 10, 3)).toEqual([{ i: 0, l: 3 }, { i: 8, l: 0 }, { i: 9, l: 0 }]);
  // every step t = 0..20,000; the first-message rule fails the same check
  expect(matches(kernelFit, 20_000)).toBe(20_001);
  expect(matches(firstMessageFit, 20_000)).toBe(481);
}, 30_000);
