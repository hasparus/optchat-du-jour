# The kernel's own vocabulary for the proofs: what LAWS.bend says in the
# spec's words, said here in the kernel's (its checks, its merge, its
# start and pow2), plus the plain structural forms of the kernel's
# tail-recursive walks. bridge.bend shows each agrees with LAWS.bend.

import Base
import ./kernel.bend as K
import ./LAWS.bend as Laws

# Vocabulary
# ----------

def Len(-A: Data, xs: List<&2, A>) -> Nat:
  Laws.Len(A, xs)

def Nth(-A: Data, xs: List<&2, A>, k: Nat, d: A) -> A:
  Laws.Nth(A, xs, k, d)

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

# lines k and k+1 of ps pass the kernel's mergeable check
def PairAt(ps: List<&2, K.Part>, k: Nat) -> Bool:
  match ps k:
    case Nil{} _:
      False{}
    case Con{a, rest} 0n:
      PairHead(a, rest)
    case Con{_, rest} 1n+j:
      PairAt(rest, j)

# the kernel's merge_at, as plain structural recursion
def merge_s(ps: List<&2, K.Part>, k: Nat) -> List<&2, K.Part>:
  match ps k:
    case Nil{} _:
      Nil{}
    case Con{a, rest} 0n:
      K.merge_head(a, rest)
    case Con{a, rest} 1n+j:
      a <> merge_s(rest, j)

# qs comes from ps by exactly n merges, each of a pair PairAt allows
def Merges(n: Nat, ps: List<&2, K.Part>, qs: List<&2, K.Part>) -> Type:
  match n:
    case 0n:
      {qs == ps : List<&2, K.Part>}
    case 1n+m:
      &k: Nat -> ({PairAt(ps, k) == True{} : Bool} & Merges(m, merge_s(ps, k), qs))

# what fit leaves behind: a view within budget, or one where no pair can
# merge
def Fits(budget: Nat, ps: List<&2, K.Part>) -> Type:
  {Nat.is_gt(K.size(ps), budget) == False{} : Bool} | (@k: Nat -> {PairAt(ps, k) == False{} : Bool})

# node (l, i) is present (one entry per node in levels[l]); and built
def Present(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Laws.Present(levels, l, i)

def Built(levels: List<&2, List<&2, Bool>>, l: Nat, i: Nat) -> Bool:
  Laws.Built(levels, l, i)

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

# the kernel's snoc and first, as plain structural recursion
def snoc_s(ps: List<&2, K.Part>, p: K.Part) -> List<&2, K.Part>:
  match ps:
    case Nil{}:
      [p]
    case Con{h, t}:
      h <> snoc_s(t, p)

def first_pick(b: Bool, s: Nat, rest: Nat) -> Nat:
  match b:
    case True{}:
      rest
    case False{}:
      s

def first_s(+T: Nat, ps: List<&2, K.Part>) -> Nat:
  match ps:
    case Nil{}:
      T
    case Con{p, rest}:
      K.Part{+l, i, _, b, _} = p
      first_pick(b, K.start(l, i), first_s(T, rest))
