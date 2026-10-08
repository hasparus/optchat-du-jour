# The laws of the fold kernel (SPEC "Bend laws"). This file states them;
# PROOF.bend proves them, and `bend PROOF.bend` must print ALL PROOFS CHECK.
# Change a law only when the spec changes; never to make a proof go through.
#
# The words below are the spec's, defined here from Base alone: where a
# law says "siblings", "merge" or "size", it does not ask the kernel what
# those mean. Only the kernel's data types (Part, Coord, Msg) and the
# functions the laws are about are imported.

import Base
import ./kernel.bend as K

# Vocabulary
# ----------

def Len(-A: Data, xs: List<&2, A>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case Con{_, t}:
      1n+Len(A, t)

def Nth(-A: Data, xs: List<&2, A>, k: Nat, d: A) -> A:
  match xs k:
    case Nil{} _:
      d
    case Con{h, _} 0n:
      h
    case Con{_, t} 1n+j:
      Nth(A, t, j, d)

# node (l, i) covers the messages [Start(l, i), Start(l, i) + Width(l))
def Start(l: Nat, i: Nat) -> Nat:
  Nat.mul(i, Nat.pow(2n, l))

def Width(l: Nat) -> Nat:
  Nat.pow(2n, l)

# ps tiles the messages [s, e): each line starts where the one before it
# ended, the first at s, and the last ends at e. No gap, no overlap.
def Tiles(ps: List<&2, K.Part>, s: Nat, e: Nat) -> Type:
  match ps:
    case Nil{}:
      {s == e : Nat}
    case Con{p, rest}:
      K.Part{+l, i, _, _, _} = p
      ({Start(l, i) == s : Nat} & Tiles(rest, Nat.add(s, Width(l)), e))

def NonEmpty(xs: List<&2, Nat>) -> Type:
  match xs:
    case Nil{}:
      Empty
    case Con{_, _}:
      Unit

# a and b are the lines (l, 2j) and (l, 2j + 1), and their parent is
# built: a line carries the sizes of its built ancestors, nearest first
def Siblings(a: K.Part, b: K.Part) -> Type:
  K.Part{la, ia, _, _, ua} = a
  K.Part{lb, ib, _, _, _} = b
  ({la == lb : Nat} & (&j: Nat -> {ia == Nat.double(j) : Nat}) & {ib == 1n+ia : Nat} & NonEmpty(ua))

def PairHead(a: K.Part, rest: List<&2, K.Part>) -> Type:
  match rest:
    case Nil{}:
      Empty
    case Con{b, _}:
      Siblings(a, b)

# lines k and k + 1 of ps are siblings whose parent is built
def PairAt(ps: List<&2, K.Part>, k: Nat) -> Type:
  match ps k:
    case Nil{} _:
      Empty
    case Con{a, rest} 0n:
      PairHead(a, rest)
    case Con{_, rest} 1n+j:
      PairAt(rest, j)

# the parent of (l, 2j): (l + 1, j), built, with the size of the first
# built ancestor and the rest above it
def ParentOf(a: K.Part) -> K.Part:
  K.Part{l, i, s, b, ups} = a
  match ups:
    case Nil{}:
      K.Part{l, i, s, b, Nil{}}
    case Con{u, us}:
      K.Part{1n+l, Nat.div(i, 2n), u, True{}, us}

def MergeHead(a: K.Part, rest: List<&2, K.Part>) -> List<&2, K.Part>:
  match rest:
    case Nil{}:
      [a]
    case Con{_, more}:
      ParentOf(a) <> more

# ps with lines k and k + 1 replaced by the parent of line k; every other
# line as it was
def Merged(ps: List<&2, K.Part>, k: Nat) -> List<&2, K.Part>:
  match ps k:
    case Nil{} _:
      Nil{}
    case Con{a, rest} 0n:
      MergeHead(a, rest)
    case Con{a, rest} 1n+j:
      a <> Merged(rest, j)

# qs comes from ps by exactly n merges, each of a sibling pair whose parent
# is built
def Merges(n: Nat, ps: List<&2, K.Part>, qs: List<&2, K.Part>) -> Type:
  match n:
    case 0n:
      {qs == ps : List<&2, K.Part>}
    case 1n+m:
      &k: Nat -> (PairAt(ps, k) & Merges(m, Merged(ps, k), qs))

# the view's size: its lines' sizes added up
def Total(ps: List<&2, K.Part>) -> Nat:
  match ps:
    case Nil{}:
      0n
    case Con{p, rest}:
      K.Part{_, _, s, _, _} = p
      Nat.add(s, Total(rest))

# what fit leaves behind: a view within budget, or one where no pair can
# merge
def Fits(budget: Nat, ps: List<&2, K.Part>) -> Type:
  {Nat.is_gt(Total(ps), budget) == False{} : Bool} | (@k: Nat -> PairAt(ps, k) -> Empty)

# The sawtooth's words: the view a Saw holds and whether it owes a batch;
# the view with a line after its last; message T's line (0, T)
def ViewOf(r: K.Saw) -> List<&2, K.Part>:
  K.Saw{ps, _} = r
  ps

def Snoc(ps: List<&2, K.Part>, p: K.Part) -> List<&2, K.Part>:
  match ps:
    case Nil{}:
      [p]
    case Con{h, t}:
      h <> Snoc(t, p)

def Line(T: Nat, m: K.Msg) -> K.Part:
  K.Msg{s, b, ups} = m
  K.Part{0n, T, s, b, ups}

# what a batch leaves: a view within low, or one where no pair can merge;
# and it owes the rest exactly when it ended over low
def Batched(low: Nat, r: K.Saw) -> Type:
  K.Saw{ps, f} = r
  (Fits(low, ps) & {f == Nat.is_gt(Total(ps), low) : Bool})

# node (l, i) is present (one entry per node in levels[l]); and built
def Present(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Nat.is_lt(i, Len(Bool, Nth(List<&2, Bool>, levels, l, Nil{})))

def Built(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Nth(Bool, Nth(List<&2, Bool>, levels, l, Nil{}), i, False{})

# every view line that starts before message x is built
def BuiltBefore(ps: List<&2, K.Part>, x: Nat) -> Type:
  match ps:
    case Nil{}:
      Unit
    case Con{p, rest}:
      K.Part{+l, i, _, b, _} = p
      (({Nat.is_lt(Start(l, i), x) == True{} : Bool} -> {b == True{} : Bool}) & BuiltBefore(rest, x))

# some view line starts at x and is unbuilt
def UnbuiltAt(ps: List<&2, K.Part>, x: Nat) -> Type:
  match ps:
    case Nil{}:
      Empty
    case Con{p, rest}:
      K.Part{+l, i, _, b, _} = p
      (({Start(l, i) == x : Nat} & {b == False{} : Bool}) | UnbuiltAt(rest, x))

# an offer rule 3 allows (gist §4.1): the node exists and is unbuilt, its
# sources exist (above level 0, both children are built), and every view
# line before the node's end is built
def Allowed(levels: List<&2, List<&2, Bool>>, ps: List<&2, K.Part>, c: K.Coord) -> Type:
  K.Coord{l, i} = c
  match l:
    case 0n:
      ({Present(levels, 0n, i) == True{} : Bool}
        & {Built(levels, 0n, i) == False{} : Bool}
        & BuiltBefore(ps, i))
    case 1n+m:
      ({Present(levels, 1n+m, i) == True{} : Bool}
        & {Built(levels, 1n+m, i) == False{} : Bool}
        & {Built(levels, m, Nat.double(i)) == True{} : Bool}
        & {Built(levels, m, 1n+Nat.double(i)) == True{} : Bool}
        & BuiltBefore(ps, Start(1n+m, 1n+i)))

def AllAllowed(levels: List<&2, List<&2, Bool>>, ps: List<&2, K.Part>, cs: List<&2, K.Coord>) -> Type:
  match cs:
    case Nil{}:
      Unit
    case Con{c, rest}:
      (Allowed(levels, ps, c) & AllAllowed(levels, ps, rest))

# what coords answers names the node id+n: it starts at id, covers n
# messages and ends within the chat
def Names(m: Maybe<&2, K.Coord>, id: Nat, n: Nat, T: Nat) -> Type:
  match m:
    case None{}:
      Unit
    case Some{c}:
      K.Coord{+l, i} = c
      ({Start(l, i) == id : Nat}
        & {Width(l) == n : Nat}
        & {Nat.is_le(Nat.add(id, n), T) == True{} : Bool})

# 1. The view tiles messages 0 to T with no gap and no overlap
# ------------------------------------------------------------

law tiles_refold:
  for +high: Nat
  for +low: Nat
  for +ms: List<&2, K.Msg>
  Tiles(ViewOf(K.refold(high, low, ms)), 0n, Len(K.Msg, ms))

law tiles_append:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +folding: Bool
  for +ps: List<&2, K.Part>
  for +m: K.Msg
  Tiles(ps, 0n, T) -> Tiles(ViewOf(K.append(T, high, low, folding, ps, m)), 0n, 1n+T)

law tiles_fit:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  Tiles(ps, 0n, T) -> Tiles(K.fit(T, budget, ps), 0n, T)

# 2. Every part (l, i) starts at i * 2^l and covers 2^l messages
# --------------------------------------------------------------

law span_start:
  for +l: Nat
  for +i: Nat
  {K.start(l, i) == Start(l, i) : Nat}

law span_size:
  for +l: Nat
  {K.pow2(l) == Width(l) : Nat}

law coords_names:
  for +id: Nat
  for +n: Nat
  for +T: Nat
  Names(K.coords(id, n, T), id, n, T)

# 3. fit and the sawtooth merge only an adjacent sibling pair whose parent
#    is built, and never split a part; they leave alone a view that needs
#    no merge
# ------------------------------------------------------------------------

law fit_merges:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  exs n: Nat
  Merges(n, ps, K.fit(T, budget, ps))

# fit merges nothing unless it must
law fit_within:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  {Nat.is_gt(Total(ps), budget) == False{} : Bool} -> {K.fit(T, budget, ps) == ps : List<&2, K.Part>}

law saw_merges:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +folding: Bool
  for +ps: List<&2, K.Part>
  exs n: Nat
  Merges(n, ps, ViewOf(K.saw(T, high, low, folding, ps)))

law append_merges:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +folding: Bool
  for +ps: List<&2, K.Part>
  for +m: K.Msg
  exs n: Nat
  Merges(n, Snoc(ps, Line(T, m)), ViewOf(K.append(T, high, low, folding, ps, m)))

# fit_within for the sawtooth: a view within high that owes no batch is
# left as it is, still owing none (gist §3.2 "When")
law saw_within:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +ps: List<&2, K.Part>
  {Nat.is_gt(Total(ps), high) == False{} : Bool} -> {K.saw(T, high, low, False{}, ps) == K.Saw{ps, False{}} : K.Saw}

# Between batches the view only grows at its end (gist §3.3): a message
# that leaves a view owing no batch within high is its line put after the
# last, and nothing else changes, so the last call's view is a prefix of
# the next one's
law append_grows:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +ps: List<&2, K.Part>
  for +m: K.Msg
  {Nat.is_gt(Total(Snoc(ps, Line(T, m))), high) == False{} : Bool}
    -> {K.append(T, high, low, False{}, ps, m) == K.Saw{Snoc(ps, Line(T, m)), False{}} : K.Saw}

# 4. After fit, the view's size is at most its budget, or no pair can be
#    merged; a batch ends at most low, or with no pair left to merge, and
#    owes the rest exactly when it ends over low
# ----------------------------------------------------------------------

law fit_fits:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  Fits(budget, K.fit(T, budget, ps))

law saw_batch:
  for +T: Nat
  for +high: Nat
  for +low: Nat
  for +folding: Bool
  for +ps: List<&2, K.Part>
  {Bool.or(folding, Nat.is_gt(Total(ps), high)) == True{} : Bool} -> Batched(low, K.saw(T, high, low, folding, ps))

# 5. Rule 3 never offers a node whose children are unbuilt, nor one beyond
#    the first unbuilt view line
# ------------------------------------------------------------------------

# first is the first unbuilt view line's start (or T when there is none):
# every line before it is built
law first_first:
  for +T: Nat
  for +ps: List<&2, K.Part>
  Tiles(ps, 0n, T) -> (BuiltBefore(ps, K.first(T, ps)) & ({K.first(T, ps) == T : Nat} | UnbuiltAt(ps, K.first(T, ps))))

law offers_allowed:
  for +levels: List<&2, List<&2, Bool>>
  for +T: Nat
  for +ps: List<&2, K.Part>
  Tiles(ps, 0n, T) -> AllAllowed(levels, ps, K.offers(levels, K.first(T, ps)))
