# The laws of the fold kernel (SPEC "Bend laws"). This file states them;
# PROOF.bend proves them, and `bend PROOF.bend` must print ALL PROOFS CHECK.
# Change a law only when the spec changes; never to make a proof go through.

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

# ps tiles the messages [s, e): each line starts where the one before it
# ended, the first at s, and the last ends at e. No gap, no overlap.
def Tiles(ps: List<&2, K.Part>, s: Nat, e: Nat) -> Type:
  match ps:
    case Nil{}:
      {s == e : Nat}
    case Con{p, rest}:
      K.Part{+l, i, _, _, _} = p
      ({K.start(l, i) == s : Nat} & Tiles(rest, Nat.add(s, K.pow2(l)), e))

def PairHead(a: K.Part, rest: List<&2, K.Part>) -> Bool:
  match rest:
    case Nil{}:
      False{}
    case Con{b, _}:
      K.mergeable(a, b)

# lines k and k+1 of ps are siblings whose parent is built
def PairAt(ps: List<&2, K.Part>, k: Nat) -> Bool:
  match ps k:
    case Nil{} _:
      False{}
    case Con{a, rest} 0n:
      PairHead(a, rest)
    case Con{_, rest} 1n+j:
      PairAt(rest, j)

# qs comes from ps by exactly n merges, each of a pair PairAt allows
def Merges(n: Nat, ps: List<&2, K.Part>, qs: List<&2, K.Part>) -> Type:
  match n:
    case 0n:
      {qs == ps : List<&2, K.Part>}
    case 1n+m:
      &k: Nat -> ({PairAt(ps, k) == True{} : Bool} & Merges(m, K.merge_at(ps, k), qs))

# what fit leaves behind: a view within budget, or one where no pair can
# merge
def Fits(budget: Nat, ps: List<&2, K.Part>) -> Type:
  {Nat.is_gt(K.size(ps), budget) == False{} : Bool} | (@k: Nat -> {PairAt(ps, k) == False{} : Bool})

# node (l, i) is present (one entry per node in levels[l]); and built
def Present(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Nat.is_lt(i, Len(Bool, Nth(List<&2, Bool>, levels, l, Nil{})))

def Built(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Nth(Bool, Nth(List<&2, Bool>, levels, l, Nil{}), i, False{})

# an offer rule 3 allows: the node exists and is unbuilt; at level 0 every
# view line before the message is built, above it both children are built
# and every view line before the node's end is built
def Allowed(levels: List<&2, List<&2, Bool>>, head: Nat, c: K.Coord) -> Type:
  K.Coord{l, i} = c
  match l:
    case 0n:
      ({Present(levels, 0n, i) == True{} : Bool}
        & {Built(levels, 0n, i) == False{} : Bool}
        & {Nat.is_le(i, head) == True{} : Bool})
    case 1n+m:
      ({Present(levels, 1n+m, i) == True{} : Bool}
        & {Built(levels, 1n+m, i) == False{} : Bool}
        & {Built(levels, m, Nat.double(i)) == True{} : Bool}
        & {Built(levels, m, 1n+Nat.double(i)) == True{} : Bool}
        & {Nat.is_le(K.start(1n+m, 1n+i), head) == True{} : Bool})

def AllAllowed(levels: List<&2, List<&2, Bool>>, head: Nat, cs: List<&2, K.Coord>) -> Type:
  match cs:
    case Nil{}:
      Unit
    case Con{c, rest}:
      (Allowed(levels, head, c) & AllAllowed(levels, head, rest))

# what coords answers names the node id+n: it starts at id, covers n
# messages and ends within the chat
def Names(m: Maybe<&2, K.Coord>, id: Nat, n: Nat, T: Nat) -> Type:
  match m:
    case None{}:
      Unit
    case Some{c}:
      K.Coord{+l, i} = c
      ({K.start(l, i) == id : Nat}
        & {K.pow2(l) == n : Nat}
        & {Nat.is_le(Nat.add(id, n), T) == True{} : Bool})

# 1. The view tiles messages 0 to T with no gap and no overlap
# ------------------------------------------------------------

law tiles_refold:
  for +budget: Nat
  for +ms: List<&2, K.Msg>
  Tiles(K.refold(budget, ms), 0n, Len(K.Msg, ms))

law tiles_append:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  for +m: K.Msg
  Tiles(ps, 0n, T) -> Tiles(K.append(T, budget, ps, m), 0n, 1n+T)

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
  {K.start(l, i) == Nat.mul(i, Nat.pow(2n, l)) : Nat}

law span_size:
  for +l: Nat
  {K.pow2(l) == Nat.pow(2n, l) : Nat}

law coords_names:
  for +id: Nat
  for +n: Nat
  for +T: Nat
  Names(K.coords(id, n, T), id, n, T)

# 3. fit merges only an adjacent sibling pair whose parent is built, and
#    never splits a part
# ----------------------------------------------------------------------

law fit_merges:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  exs n: Nat
  Merges(n, ps, K.fit(T, budget, ps))

# 4. After fit, the view's size is at most VIEW, or no pair can be merged
# -----------------------------------------------------------------------

law fit_fits:
  for +T: Nat
  for +budget: Nat
  for +ps: List<&2, K.Part>
  Fits(budget, K.fit(T, budget, ps))

# 5. Rule 3 never offers a node whose children are unbuilt, nor one beyond
#    the first unbuilt view line
# ------------------------------------------------------------------------

law offers_allowed:
  for +levels: List<&2, List<&2, Bool>>
  for +head: Nat
  AllAllowed(levels, head, K.offers(levels, head))
