// Types of the module `bend kernel.bend -o kernel.mjs` writes. Bend passes
// constructors as {$: "Name", ...fields} and returns every Nat as a bigint;
// it takes numbers or bigints. src/kernel.ts is its only caller in the app (tests and dev scripts
// call it directly).
export type Nat = bigint | number;
export type List<T> = { readonly $: "Con"; readonly head: T; readonly tail: List<T> } | { readonly $: "Nil" };
export type Coord = { readonly $: "Coord"; readonly i: Nat; readonly l: Nat };
export type Part = {
  readonly $: "Part";
  readonly built: boolean;
  readonly i: Nat;
  readonly l: Nat;
  readonly size: Nat;
  readonly ups: List<Nat>;
};
export type Msg = { readonly $: "Msg"; readonly built: boolean; readonly size: Nat; readonly ups: List<Nat> };
export type Maybe<T> = { readonly $: "None" } | { readonly $: "Some"; readonly value: T };
// the view and whether a batch is still owed (the sawtooth's state)
export type Saw = { readonly $: "Saw"; readonly folding: boolean; readonly ps: List<Part> };

declare const kernel: {
  readonly append: (T: Nat, high: Nat, low: Nat, folding: boolean, ps: List<Part>, m: Msg) => Saw;
  readonly coords: (id: Nat, n: Nat, T: Nat) => Maybe<Coord>;
  readonly first: (T: Nat, ps: List<Part>) => bigint;
  readonly extend: (T: Nat, high: Nat, low: Nat, r: Saw, ms: List<Msg>) => Saw;
  readonly fit: (T: Nat, budget: Nat, ps: List<Part>) => List<Part>;
  readonly offers: (levels: List<List<boolean>>, head: Nat) => List<Coord>;
  readonly refold: (high: Nat, low: Nat, ms: List<Msg>) => Saw;
  readonly saw: (T: Nat, high: Nat, low: Nat, folding: boolean, ps: List<Part>) => Saw;
  readonly window: (T: Nat, ps: List<Part>, n: Nat) => bigint;
};
// oxlint-disable-next-line import/no-default-export -- the shape bend gives the module
export default kernel;
