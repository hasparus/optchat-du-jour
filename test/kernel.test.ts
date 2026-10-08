// The Bend kernel against a literal model of the view, written from the gist's prose alone
// (gist §3 "Addressing", §4.1, §5.2). Seeded random chats, several budgets; after every step the
// kernel and the model must agree on the view, `first` and rule 3's offers, and now and then on
// the refold from message 0.
import { expect, spyOn, test } from "bun:test";
import kernel, { type List, type Part } from "../kernel/kernel.mjs";
import * as K from "../src/kernel.ts";
import { type Coord, getNode, type Mem, newMem, setNode } from "../src/tree.ts";
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

  // while over budget, replace the most due adjacent built pair by its parent; ties to the left
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
        const due = (this.T - this.start(left)) / (4 * 2 ** left.l);
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

// What src/kernel.ts hands the kernel, against the tree it comes from. The laws take their
// inputs at their word, and no proof covers the conversion: a line's `built` and size are the
// tree's, its `ups` the sizes of its built ancestors up to the first unbuilt one (so non-empty
// exactly when its parent is built, and the parent a merge makes is that parent's own line), the
// view tiles [0, T), and `levels` holds one flag per node of a chat of T, the tree's.
const array = <T>(xs: List<T>): T[] => (xs.$ === "Con" ? [xs.head, ...array(xs.tail)] : []);
function list<T>(xs: readonly T[]): List<T> {
  let out: List<T> = { $: "Nil" };
  for (const head of xs.toReversed()) out = { $: "Con", head, tail: out };
  return out;
}
const at = (c: { readonly l: bigint | number; readonly i: bigint | number }): Coord => ({ i: Number(c.i), l: Number(c.l) });

// a line as kernel.ts builds it: the tree's flag and size, and its parent's line when the parent
// is built (gist §5.2: a pair merges only into a built parent). How many ancestors it carries.
function line(mem: Mem, p: Part): number {
  const c = at(p), ups = array(p.ups), up = { i: Math.floor(c.i / 2), l: c.l + 1 };
  expect(p.built).toBe(getNode(mem, c) !== undefined);
  expect(Number(p.size)).toBe(getNode(mem, c)?.size ?? HOLE);
  expect(ups.length > 0).toBe(getNode(mem, up) !== undefined);
  const [size, ...rest] = ups;
  if (size === undefined) return 0;
  return 1 + line(mem, { $: "Part", built: true, ...up, size, ups: list(rest) });
}

// the view as kernel.ts hands it over: mem.view's lines in order, tiling [0, T)
function view(mem: Mem, ps: List<Part>, T: number) {
  const lines = array(ps);
  expect(lines.map(at)).toEqual([...mem.view]);
  let end = 0;
  for (const p of lines) {
    expect(at(p).i * 2 ** at(p).l).toBe(end);
    end += 2 ** at(p).l;
  }
  expect(end).toBe(T);
  return lines;
}

// a chat of T messages and a tree over it: mostly nodes whose sources are built, as the pump
// builds them, and now and then any node at all, as an import may leave them
function chat(r: () => number, T: number) {
  const mem = newMem(200 + Math.floor(r() * 3000)), odd = r() < 0.2, p = r();
  for (let i = 0; i < T; i++) mem.root.push(logged(i));
  for (let l = 0; 2 ** l <= T; l++)
    for (let i = 0; i < Math.floor(T / 2 ** l); i++) {
      const ready = l === 0 || (getNode(mem, { i: 2 * i, l: l - 1 }) && getNode(mem, { i: 2 * i + 1, l: l - 1 }));
      if ((ready || odd) && r() < p) setNode(mem, { i, l, text: "y".repeat(1 + Math.floor(r() * 600)) });
    }
  return mem;
}

// the arguments of the one call `act` makes through `spy`
function handed<A extends unknown[]>(spy: { mock: { calls: A[] }; mockClear(): void }, act: () => void): A {
  spy.mockClear();
  act();
  expect(spy.mock.calls).toHaveLength(1);
  return spy.mock.calls[0]!;
}

test("what kernel.ts hands the kernel is the tree it comes from", () => {
  const append = spyOn(kernel, "append"), first = spyOn(kernel, "first"), fit = spyOn(kernel, "fit");
  const offers = spyOn(kernel, "offers"), refold = spyOn(kernel, "refold");
  try {
    const r = rng(7);
    let deepest = 0;
    for (let run = 0; run < 300; run++) {
      const T = Math.floor(r() * 70), mem = chat(r, T);
      // the refold of all but the newest message, then its append
      const last = mem.root.pop();
      const [budget, ms] = handed(refold, () => {
        mem.view = K.refold(mem, HOLE);
      });
      expect(Number(budget)).toBe(mem.budget);
      expect(array(ms).map((m, i) => line(mem, { $: "Part", built: m.built, i, l: 0, size: m.size, ups: m.ups }))).toHaveLength(mem.root.length);
      if (last) {
        mem.root.push(last);
        let next = mem.view;
        const [t, b, ps, m] = handed(append, () => {
          next = K.append(mem, HOLE);
        });
        expect([Number(t), Number(b)]).toEqual([T - 1, mem.budget]);
        for (const p of view(mem, ps, T - 1)) deepest = Math.max(deepest, line(mem, p));
        line(mem, { $: "Part", built: m.built, i: T - 1, l: 0, size: m.size, ups: m.ups });
        mem.view = next;
      }
      const [t, b, ps] = handed(fit, () => {
        K.fit(mem, HOLE);
      });
      expect([Number(t), Number(b)]).toEqual([T, mem.budget]);
      for (const p of view(mem, ps, T)) deepest = Math.max(deepest, line(mem, p));
      // first reads only where a line is and whether it is built
      const [tf, bare] = handed(first, () => {
        K.first(mem);
      });
      expect(Number(tf)).toBe(T);
      for (const p of view(mem, bare, T)) expect(p.built).toBe(getNode(mem, at(p)) !== undefined);
      // one flag per node of a chat of T, level 0 first: levels[l][i] is node (l, i)'s
      const [levels, head] = handed(offers, () => {
        K.offers(mem);
      });
      expect(Number(head)).toBe(K.first(mem));
      const flags = array(levels).map((level) => array(level));
      expect(flags.length).toBe(T === 0 ? 0 : Math.floor(Math.log2(T)) + 1);
      for (const [l, level] of flags.entries()) {
        expect(level).toHaveLength(Math.floor(T / 2 ** l));
        for (const [i, b] of level.entries()) expect(b).toBe(getNode(mem, { i, l }) !== undefined);
      }
    }
    expect(deepest).toBeGreaterThan(2); // the runs did carry lines with built ancestors
  } finally {
    for (const spy of [append, first, fit, offers, refold]) spy.mockRestore();
  }
});
