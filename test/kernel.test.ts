// The Bend kernel against a literal model of the view, written from the gist's prose alone
// (gist §3 "Addressing", §4.1, §5.2). Seeded random chats, several budgets; after every step the
// kernel and the model must agree on the view, `first` and rule 3's offers, and now and then on
// the refold from message 0.
import { expect, test } from "bun:test";
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

  built = (l: number, i: number) => this.sizes.has(`${l},${i}`);
  size = (c: Coord) => this.sizes.get(`${c.l},${c.i}`) ?? HOLE; // an unbuilt part counts its placeholder
  start = (c: Coord) => c.i * 2 ** c.l;

  // while over budget, replace the most due adjacent built pair by its parent; ties to the left
  fit() {
    let total = this.view.reduce((sum, c) => sum + this.size(c), 0);
    while (total > this.budget) {
      let best = -1, most = -1;
      for (let k = 0; k + 1 < this.view.length; k++) {
        const a = this.view[k]!, b = this.view[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !this.built(a.l + 1, a.i / 2)) continue;
        const due = (this.T - this.start(a)) / 2 ** (a.l + 2);
        if (due > most) [best, most] = [k, due];
      }
      if (best < 0) break; // wait until a parent is built
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
    const p = this.view.find((c) => !this.built(c.l, c.i));
    return p ? this.start(p) : this.T;
  }

  ready = (l: number, i: number) => (l === 0 ? i < this.T : this.built(l - 1, 2 * i) && this.built(l - 1, 2 * i + 1));

  // rule 3 (gist §4.1): unbuilt, its sources there, everything before its end summarized
  offers() {
    const out: Coord[] = [], head = this.first();
    for (let l = 0; 2 ** l <= this.T; l++)
      for (let i = 0; (i + 1) * 2 ** l <= this.T; i++) {
        const end = l === 0 ? i : (i + 1) * 2 ** l;
        if (!this.built(l, i) && this.ready(l, i) && end <= head) out.push({ i, l });
      }
    return out;
  }

  // every unbuilt node whose sources exist, as the free-node pass builds them, rule 3 aside
  readies() {
    const out: Coord[] = [];
    for (let l = 0; 2 ** l <= this.T; l++)
      for (let i = 0; (i + 1) * 2 ** l <= this.T; i++) if (!this.built(l, i) && this.ready(l, i)) out.push({ i, l });
    return out;
  }
}

// id+n: n a power of two, id a multiple of n, id + n <= T (gist §3, §7.1)
function address(id: number, n: number, T: number): Coord | null {
  if (n < 1 || id < 0 || id % n !== 0 || id + n > T) return null;
  const l = Math.log2(n);
  return Number.isInteger(l) ? { i: id / n, l } : null;
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
const text = (r: () => number, max: number) =>
  Array.from({ length: 1 + Math.floor(r() * max) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("");


// `appends`: the share of steps that log a message; low, the compactor keeps up, high, it lags
function run(seed: number, budget: number, steps: number, appends: number) {
  const r = rng(seed), model = new Model(budget), mem = newMem(budget);
  for (let step = 0; step < steps; step++) {
    const offered = model.offers(), roll = r();
    // mostly the pump's order; sometimes any ready node (free nodes skip rule 3); and runs of
    // messages with nothing built, so the view sits over budget with unbuilt lines
    const pool = roll < appends ? [] : roll < 0.9 ? offered : model.readies();
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
    for (let n = 0; n < 70; n++) for (let id = 0; id < 70; id++) expect(K.address(id, n, T)).toEqual(address(id, n, T));
  expect(K.address(1.5, 1, 4)).toBeNull();
  expect(K.address(-1, 1, 4)).toBeNull();
});
