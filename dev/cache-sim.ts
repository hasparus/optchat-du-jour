#!/usr/bin/env bun
// The cache simulation of gist 2026-10-08 §3.3: replay synthetic messages with the compactor caught
// up (every node built as soon as its messages are logged) and count, per message, the line-inputs
// a call must write anew: the view's lines from the first one that differs from the last call's
// view to its end (the new line included). Three ways to keep the view:
//   first: due from the pair's first message, a fit at every message to VIEW_HIGH (our view before
//          the sawtooth, and the reference's at its pinned commit)
//   last:  due from the pair's last message, a fit at every message to VIEW_HIGH
//   saw:   due from the last message, batches from VIEW_HIGH down to VIEW_LOW (what we do now)
// Usage: bun dev/cache-sim.ts [messages = 30000] [seed = 1]
import kernel, { type List, type Part } from "../kernel/kernel.mjs";
import { VIEW_HIGH, VIEW_LOW } from "../src/config.ts";
import type { Coord } from "../src/tree.ts";

const N = Number(process.argv[2] ?? 30_000), SEED = Number(process.argv[3] ?? 1);

// a node's size: a summary of 300 to 512 bytes, fixed by its place
function size(c: Coord) {
  let h = Math.imul(c.l + 1, 0x9E_37_79_B1) ^ Math.imul(c.i + SEED, 0x85_EB_CA_6B);
  h = Math.imul(h ^ (h >>> 15), 0xC2_B2_AE_35);
  return 300 + (((h ^ (h >>> 13)) >>> 0) % 213);
}

const nil: List<never> = { $: "Nil" };
function list<T>(xs: readonly T[]): List<T> {
  let out: List<T> = nil;
  for (const head of xs.toReversed()) out = { $: "Con", head, tail: out };
  return out;
}
function coords(ps: List<Part>): Coord[] {
  const out: Coord[] = [];
  for (let at = ps; at.$ === "Con"; at = at.tail) out.push({ i: Number(at.head.i), l: Number(at.head.l) });
  return out;
}
// with T messages logged every node within them is built: its ancestors up to the first that ends past T
function part(c: Coord, T: number): Part {
  const ups: number[] = [];
  for (let l = c.l + 1, i = c.i >> 1; (i + 1) * 2 ** l <= T; l++, i >>= 1) ups.push(size({ i, l }));
  return { $: "Part", built: true, i: c.i, l: c.l, size: size(c), ups: list(ups) };
}
const parts = (view: readonly Coord[], T: number) => list(view.map((c) => part(c, T)));

// the first-message rule, as it was: while over budget, merge the pair with the largest (T - first) / 2^(l+2)
function fitFirst(view: Coord[], T: number, budget: number) {
  let total = view.reduce((sum, c) => sum + size(c), 0);
  while (total > budget) {
    let best = -1, most = -1;
    for (const [k, a] of view.entries()) {
      const b = view[k + 1];
      if (b === undefined) break;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || (a.i / 2 + 1) * 2 ** (a.l + 1) > T) continue;
      const due = (T - a.i * 2 ** a.l) / 2 ** (a.l + 2);
      if (due > most) [best, most] = [k, due];
    }
    const a = view[best];
    if (a === undefined) return view;
    const up = { i: a.i / 2, l: a.l + 1 };
    total += size(up) - size(a) - size(view[best + 1] ?? a);
    view.splice(best, 2, up);
  }
  return view;
}

type State = { readonly view: readonly Coord[]; readonly folding: boolean };
type Policy = (view: readonly Coord[], t: number, folding: boolean) => State;
const POLICIES = {
  first: (view, t) => ({ folding: false, view: fitFirst([...view, { i: t, l: 0 }], t + 1, VIEW_HIGH) }),
  last: (view, t) => ({ folding: false, view: coords(kernel.fit(t + 1, VIEW_HIGH, parts([...view, { i: t, l: 0 }], t + 1))) }),
  saw: (view, t, folding) => {
    const r = kernel.append(t, VIEW_HIGH, VIEW_LOW, folding, parts(view, t + 1), { $: "Msg", built: true, size: size({ i: t, l: 0 }), ups: part({ i: t, l: 0 }, t + 1).ups });
    return { folding: r.folding, view: coords(r.ps) };
  },
} satisfies Record<string, Policy>;

const same = (a: Coord, b: Coord | undefined) => b !== undefined && a.l === b.l && a.i === b.i;
const say = (line: string) => process.stdout.write(`${line}\n`);
say(`${N} messages, nodes of 300-512 bytes, VIEW_HIGH ${VIEW_HIGH}, VIEW_LOW ${VIEW_LOW}`);
for (const [name, policy] of Object.entries<Policy>(POLICIES)) {
  const t0 = performance.now();
  let at: State = { folding: false, view: [] };
  let rewritten = 0, counted = 0, lines = 0, from = -1;
  for (let t = 0; t < N; t++) {
    const next = policy(at.view, t, at.folding);
    let k = 0;
    while (k < next.view.length && same(next.view[k] ?? { i: -1, l: -1 }, at.view[k])) k++;
    // counted from the first message whose view reached the high mark: before it, every policy only appends
    if (from === -1 && next.view.reduce((sum, c) => sum + size(c), 0) + 600 > VIEW_HIGH) from = t;
    if (from !== -1) {
      rewritten += next.view.length - k;
      lines += next.view.length;
      counted++;
    }
    at = next;
  }
  const per = (x: number) => (x / counted).toFixed(1);
  say(`${name.padEnd(6)} ${per(rewritten)} line-inputs rewritten per message, of ${per(lines)} lines (${counted} messages from t=${from}; ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
