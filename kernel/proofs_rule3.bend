# Law 5: every node offers() hands the pump is one rule 3 allows. The
# walks over each level keep an invariant: the part of the level still to
# walk is Drop(j, level) (and, above level 0, the children still to walk
# are Drop(2j, the level below)), so drop_con turns each element they meet
# into a fact about the whole `levels`.

import Base
import ./kernel.bend as K
import ./kspec.bend as KS
import ./lemmas_a.bend as A

def R.offer_ok(+L: List<&2, List<&2, Bool>>, +head: Nat, ok: Bool, -c: K.Coord, -acc: List<&2, K.Coord>,
  h: {ok == True{} : Bool} -> KS.Allowed(L, head, c), hacc: KS.AllAllowed(L, head, acc))
  -> KS.AllAllowed(L, head, K.offer(ok, c, acc)):
  match ok:
    case True{}:
      (h({==}), hacc)
    case False{}:
      hacc

# Level 0
# -------

# the suffix from n + 1, out of what drop_con says
def R.next(-A: Data, -n: Nat, -xs: List<&2, A>, -d: A, -b: A, -rest: List<&2, A>, dc: A.DropCon(A, n, xs, d, b, rest))
  -> {A.Drop(A, 1n+n, xs) == rest : List<&2, A>}:
  (_, _, next) = dc
  next

def R.leaf_fin(+L: List<&2, List<&2, Bool>>, +head: Nat, +i: Nat, b: Bool,
  nb: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), i, False{}) == b : Bool},
  inr: {Nat.is_lt(i, KS.Len(Bool, KS.Nth(List<&2, Bool>, L, 0n, Nil{}))) == True{} : Bool},
  both: {Bool.not(b) == True{} : Bool} & {Nat.is_le(i, head) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{0n, i}):
  (nf, le) = both
  (inr, Equal.trans(Bool, KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), i, False{}), b, False{}, nb, A.not_true(b, nf)), le)

def R.leaf_allowed(+L: List<&2, List<&2, Bool>>, +head: Nat, +i: Nat, +b: Bool, -rest: List<&2, Bool>,
  dc: A.DropCon(Bool, i, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), False{}, b, rest),
  e: {Bool.and(Bool.not(b), Nat.is_le(i, head)) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{0n, i}):
  (nb, inr, _) = dc
  R.leaf_fin(L, head, i, b, nb, inr, A.and_true(Bool.not(b), Nat.is_le(i, head), e))

def R.leaves_ok(+bs: List<&2, Bool>, +L: List<&2, List<&2, Bool>>, +head: Nat, +i: Nat, -acc: List<&2, K.Coord>,
  +inv: {A.Drop(Bool, i, KS.Nth(List<&2, Bool>, L, 0n, Nil{})) == bs : List<&2, Bool>},
  hacc: KS.AllAllowed(L, head, acc))
  -> KS.AllAllowed(L, head, K.offers.leaves(bs, head, i, acc)):
  match bs:
    case Nil{}:
      hacc
    case Con{b, rest}:
      R.leaves_ok(rest, L, head, 1n+i, K.offer(Bool.and(Bool.not(b), Nat.is_le(i, head)), K.Coord{0n, i}, acc),
        R.next(Bool, i, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), False{}, b, rest, A.drop_con(Bool, i, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), False{}, b, rest, inv)),
        R.offer_ok(L, head, Bool.and(Bool.not(b), Nat.is_le(i, head)), K.Coord{0n, i}, acc,
          e => R.leaf_allowed(L, head, i, b, rest, A.drop_con(Bool, i, KS.Nth(List<&2, Bool>, L, 0n, Nil{}), False{}, b, rest, inv), e),
          hacc))

# Levels above 0
# --------------

# the element at n, out of what drop_con says
def R.at(-A: Data, -n: Nat, -xs: List<&2, A>, -d: A, -b: A, -rest: List<&2, A>, dc: A.DropCon(A, n, xs, d, b, rest))
  -> {KS.Nth(A, xs, n, d) == b : A}:
  (at, _, _) = dc
  at

# the node's check, ((not b && x) && y) && end <= head, taken apart
def R.node_c(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +x: Bool, +y: Bool,
  nb: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), j, False{}) == b : Bool},
  inr: {Nat.is_lt(j, KS.Len(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}))) == True{} : Bool},
  nx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}) == x : Bool},
  ny: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), 1n+Nat.double(j), False{}) == y : Bool},
  t: {Bool.not(b) == True{} : Bool} & {x == True{} : Bool}, yt: {y == True{} : Bool}, le: {Nat.is_le(K.start(1n+m, 1n+j), head) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  (nbt, xt) = t
  (inr,
    Equal.trans(Bool, KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), j, False{}), b, False{}, nb, A.not_true(b, nbt)),
    Equal.trans(Bool, KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}), x, True{}, nx, xt),
    Equal.trans(Bool, KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), 1n+Nat.double(j), False{}), y, True{}, ny, yt),
    le)

def R.node_b(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +x: Bool, +y: Bool,
  nb: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), j, False{}) == b : Bool},
  inr: {Nat.is_lt(j, KS.Len(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}))) == True{} : Bool},
  nx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}) == x : Bool},
  ny: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), 1n+Nat.double(j), False{}) == y : Bool},
  t: {Bool.and(Bool.not(b), x) == True{} : Bool} & {y == True{} : Bool}, le: {Nat.is_le(K.start(1n+m, 1n+j), head) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  (q, yt) = t
  R.node_c(L, head, m, j, b, x, y, nb, inr, nx, ny, A.and_true(Bool.not(b), x, q), yt, le)

def R.node_a(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +x: Bool, +y: Bool,
  nb: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), j, False{}) == b : Bool},
  inr: {Nat.is_lt(j, KS.Len(Bool, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}))) == True{} : Bool},
  nx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}) == x : Bool},
  ny: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), 1n+Nat.double(j), False{}) == y : Bool},
  t: {Bool.and(Bool.and(Bool.not(b), x), y) == True{} : Bool} & {Nat.is_le(K.start(1n+m, 1n+j), head) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  (q, le) = t
  R.node_b(L, head, m, j, b, x, y, nb, inr, nx, ny, A.and_true(Bool.and(Bool.not(b), x), y, q), le)

def R.node_fin(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +x: Bool, +y: Bool,
  -own: List<&2, Bool>, -rest: List<&2, Bool>,
  dcb: A.DropCon(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, own),
  nx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}) == x : Bool},
  ny: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), 1n+Nat.double(j), False{}) == y : Bool},
  e: {K.offers.node(1n+m, head, j, b, Con{x, Con{y, rest}}) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  (nb, inr, _) = dcb
  R.node_a(L, head, m, j, b, x, y, nb, inr, nx, ny, A.and_true(Bool.and(Bool.and(Bool.not(b), x), y), Nat.is_le(K.start(1n+m, 1n+j), head), e))

def R.node_more(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +x: Bool, +more: List<&2, Bool>,
  -own: List<&2, Bool>,
  dcb: A.DropCon(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, own),
  nx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, L, m, Nil{}), Nat.double(j), False{}) == x : Bool},
  im: {A.Drop(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == more : List<&2, Bool>},
  e: {K.offers.node(1n+m, head, j, b, Con{x, more}) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  match more:
    case Nil{}:
      A.false_true(KS.Allowed(L, head, K.Coord{1n+m, j}), e)
    case Con{y, rest}:
      R.node_fin(L, head, m, j, b, x, y, own, rest, dcb, nx,
        R.at(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, y, rest, A.drop_con(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, y, rest, im)), e)

# a node offered at level 1+m: its children are the next two kids, Drop(2j, level m)
def R.node_ok(+L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat, +b: Bool, +kids: List<&2, Bool>,
  -own: List<&2, Bool>,
  dcb: A.DropCon(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, own),
  +ik: {A.Drop(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == kids : List<&2, Bool>},
  e: {K.offers.node(1n+m, head, j, b, kids) == True{} : Bool})
  -> KS.Allowed(L, head, K.Coord{1n+m, j}):
  match kids:
    case Nil{}:
      A.false_true(KS.Allowed(L, head, K.Coord{1n+m, j}), e)
    case Con{x, more}:
      R.node_more(L, head, m, j, b, x, more, own, dcb,
        R.at(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, A.drop_con(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, ik)),
        R.next(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, A.drop_con(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, ik)),
        e)

def R.drop2_more(+L: List<&2, List<&2, Bool>>, +m: Nat, +j: Nat, -x: Bool, +more: List<&2, Bool>,
  +im: {A.Drop(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == more : List<&2, Bool>})
  -> {A.Drop(Bool, Nat.double(1n+j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == K.offers.drop2(Con{x, more}) : List<&2, Bool>}:
  match more:
    case Nil{}:
      A.drop_nil(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), im)
    case Con{y, rest}:
      R.next(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, y, rest, A.drop_con(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, y, rest, im))

# the kids two further on are the children of node j + 1
def R.drop2_ok(+L: List<&2, List<&2, Bool>>, +m: Nat, +j: Nat, +kids: List<&2, Bool>,
  +ik: {A.Drop(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == kids : List<&2, Bool>})
  -> {A.Drop(Bool, Nat.double(1n+j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == K.offers.drop2(kids) : List<&2, Bool>}:
  match kids:
    case Nil{}:
      A.drop_nil(Bool, 1n+Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), A.drop_nil(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), ik))
    case Con{x, more}:
      R.drop2_more(L, m, j, x, more,
        R.next(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, A.drop_con(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{}), False{}, x, more, ik)))

def R.level_ok(+own: List<&2, Bool>, +kids: List<&2, Bool>, +L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat, +j: Nat,
  -acc: List<&2, K.Coord>,
  +io: {A.Drop(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{})) == own : List<&2, Bool>},
  +ik: {A.Drop(Bool, Nat.double(j), KS.Nth(List<&2, Bool>, L, m, Nil{})) == kids : List<&2, Bool>},
  hacc: KS.AllAllowed(L, head, acc))
  -> KS.AllAllowed(L, head, K.offers.level(own, kids, 1n+m, head, j, acc)):
  match own:
    case Nil{}:
      hacc
    case Con{b, rest}:
      R.level_ok(rest, K.offers.drop2(kids), L, head, m, 1n+j,
        K.offer(K.offers.node(1n+m, head, j, b, kids), K.Coord{1n+m, j}, acc),
        R.next(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, rest, A.drop_con(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, rest, io)),
        R.drop2_ok(L, m, j, kids, ik),
        R.offer_ok(L, head, K.offers.node(1n+m, head, j, b, kids), K.Coord{1n+m, j}, acc,
          e => R.node_ok(L, head, m, j, b, kids, rest, A.drop_con(Bool, j, KS.Nth(List<&2, Bool>, L, 1n+m, Nil{}), False{}, b, rest, io), ik, e),
          hacc))

def R.up_ok(+levels: List<&2, List<&2, Bool>>, +below: List<&2, Bool>, +L: List<&2, List<&2, Bool>>, +head: Nat, +m: Nat,
  -acc: List<&2, K.Coord>,
  +il: {A.Drop(List<&2, Bool>, 1n+m, L) == levels : List<&2, List<&2, Bool>>},
  +ib: {KS.Nth(List<&2, Bool>, L, m, Nil{}) == below : List<&2, Bool>},
  hacc: KS.AllAllowed(L, head, acc))
  -> KS.AllAllowed(L, head, K.offers.up(levels, below, 1n+m, head, acc)):
  match levels:
    case Nil{}:
      hacc
    case Con{own, rest}:
      R.up_ok(rest, own, L, head, 1n+m, K.offers.level(own, below, 1n+m, head, 0n, acc),
        R.next(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, A.drop_con(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, il)),
        R.at(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, A.drop_con(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, il)),
        R.level_ok(own, below, L, head, m, 0n, acc,
          R.at(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, A.drop_con(List<&2, Bool>, 1n+m, L, Nil{}, own, rest, il)),
          ib, hacc))

# Law 5
# -----

def offers_allowed_k(+levels: List<&2, List<&2, Bool>>, +head: Nat) -> KS.AllAllowed(levels, head, K.offers(levels, head)):
  match levels:
    case Nil{}:
      Unit{}
    case Con{leaves, rest}:
      R.up_ok(rest, leaves, Con{leaves, rest}, head, 0n, K.offers.leaves(leaves, head, 0n, Nil{}), {==}, {==},
        R.leaves_ok(leaves, Con{leaves, rest}, head, 0n, Nil{}, {==}, Unit{}))
