# Law 5: every node offers() hands the pump is one rule 3 allows, and every
# node rule 3 allows is in it (Completeness, at the end). The soundness
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

# Completeness
# ------------
# Every node rule 3 allows is offered. Each walk only ever conses onto what
# it was handed, so an offer once made stays (the _keep lemmas); and the
# walk that reaches the node, d steps further on, finds it unbuilt, its
# children built and its end at or before head, so offers it (the _hit
# lemmas). Their facts are about the node's own index in what is left to
# walk, so each step down a list is one step down d.

def R.lt_zero(x: Nat) -> {Nat.is_lt(x, 0n) == False{} : Bool}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      {==}

def R.add_one(p: Nat) -> {Nat.add(p, 1n) == 1n+p : Nat}:
  match p:
    case 0n:
      {==}
    case 1n+q:
      %R.add_one(q) : {1n+Nat.add(q, 1n) == 1n+_ : Nat}
      {==}

# nothing is at an index of an empty list
def R.none_at(-P: Type, +x: Nat, h: {Nat.is_lt(x, 0n) == True{} : Bool}) -> P:
  A.false_true(P, Equal.trans(Bool, False{}, Nat.is_lt(x, 0n), True{}, Equal.sym(Bool, Nat.is_lt(x, 0n), False{}, R.lt_zero(x)), h))

# a fact about j0 is one about j, when j is j0
def R.le_at(-j: Nat, -j0: Nat, -head: Nat, e: {j == j0 : Nat}, h: {Nat.is_le(j0, head) == True{} : Bool}) -> {Nat.is_le(j, head) == True{} : Bool}:
  %Equal.sym(Nat, j, j0, e) : {Nat.is_le(_, head) == True{} : Bool}
  h

def R.in_offer(ok: Bool, -d: K.Coord, -acc: List<&2, K.Coord>, -c: K.Coord, h: KS.In(c, acc)) -> KS.In(c, K.offer(ok, d, acc)):
  match ok:
    case True{}:
      Inr{h}
    case False{}:
      h

def R.leaves_keep(bs: List<&2, Bool>, +head: Nat, +i: Nat, -acc: List<&2, K.Coord>, -c: K.Coord, h: KS.In(c, acc))
  -> KS.In(c, K.offers.leaves(bs, head, i, acc)):
  match bs:
    case Nil{}:
      h
    case Con{+b, rest}:
      R.leaves_keep(rest, head, 1n+i, K.offer(Bool.and(Bool.not(b), Nat.is_le(i, head)), K.Coord{0n, i}, acc), c,
        R.in_offer(Bool.and(Bool.not(b), Nat.is_le(i, head)), K.Coord{0n, i}, acc, c, h))

def R.level_keep(own: List<&2, Bool>, +kids: List<&2, Bool>, +l: Nat, +head: Nat, +j: Nat, -acc: List<&2, K.Coord>, -c: K.Coord,
  h: KS.In(c, acc)) -> KS.In(c, K.offers.level(own, kids, l, head, j, acc)):
  match own:
    case Nil{}:
      h
    case Con{+b, rest}:
      R.level_keep(rest, K.offers.drop2(kids), l, head, 1n+j, K.offer(K.offers.node(l, head, j, b, kids), K.Coord{l, j}, acc), c,
        R.in_offer(K.offers.node(l, head, j, b, kids), K.Coord{l, j}, acc, c, h))

def R.up_keep(levels: List<&2, List<&2, Bool>>, +below: List<&2, Bool>, +l: Nat, +head: Nat, -acc: List<&2, K.Coord>, -c: K.Coord,
  h: KS.In(c, acc)) -> KS.In(c, K.offers.up(levels, below, l, head, acc)):
  match levels:
    case Nil{}:
      h
    case Con{+own, rest}:
      R.up_keep(rest, own, 1n+l, head, K.offers.level(own, below, l, head, 0n, acc), c,
        R.level_keep(own, below, l, head, 0n, acc, c, h))

# message j0, d further on: unbuilt and at or before head, so offered
def R.leaves_hit(bs: List<&2, Bool>, +d: Nat, +head: Nat, +j: Nat, -j0: Nat, -acc: List<&2, K.Coord>,
  +e: {Nat.add(d, j) == j0 : Nat},
  hl: {Nat.is_lt(d, KS.Len(Bool, bs)) == True{} : Bool},
  hb: {KS.Nth(Bool, bs, d, False{}) == False{} : Bool},
  +hh: {Nat.is_le(j0, head) == True{} : Bool})
  -> KS.In(K.Coord{0n, j0}, K.offers.leaves(bs, head, j, acc)):
  match bs:
    case Nil{}:
      R.none_at(KS.In(K.Coord{0n, j0}, K.offers.leaves(Nil{}, head, j, acc)), d, hl)
    case Con{+b, rest}:
      match d:
        case 0n:
          %e : KS.In(K.Coord{0n, _}, K.offers.leaves(Con{b, rest}, head, j, acc))
          %Equal.sym(Bool, b, False{}, hb) : KS.In(K.Coord{0n, j}, K.offers.leaves(Con{_, rest}, head, j, acc))
          %Equal.sym(Bool, Nat.is_le(j, head), True{}, R.le_at(j, j0, head, e, hh))
            : KS.In(K.Coord{0n, j}, K.offers.leaves(rest, head, 1n+j, K.offer(Bool.and(Bool.not(False{}), _), K.Coord{0n, j}, acc)))
          R.leaves_keep(rest, head, 1n+j, Con{K.Coord{0n, j}, acc}, K.Coord{0n, j}, Inl{{==}})
        case 1n+d2:
          R.leaves_hit(rest, d2, head, 1n+j, j0, K.offer(Bool.and(Bool.not(b), Nat.is_le(j, head)), K.Coord{0n, j}, acc),
            Equal.trans(Nat, Nat.add(d2, 1n+j), 1n+Nat.add(d2, j), j0, Equal.sym(Nat, 1n+Nat.add(d2, j), Nat.add(d2, 1n+j), A.add_succ(d2, j)), e),
            hl, hb, hh)

# the kids two further on: two steps down the level below
def R.drop2_nth(kids: List<&2, Bool>, -n: Nat) -> {KS.Nth(Bool, kids, 2n+n, False{}) == KS.Nth(Bool, K.offers.drop2(kids), n, False{}) : Bool}:
  match kids:
    case Nil{}:
      {==}
    case Con{x, Nil{}}:
      {==}
    case Con{x, Con{y, rest}}:
      {==}

# the node's check holds: unbuilt, both children built, its end at or
# before head
def R.node_true(+l: Nat, +head: Nat, +j: Nat, b: Bool, kids: List<&2, Bool>,
  hb: {b == False{} : Bool},
  hx: {KS.Nth(Bool, kids, 0n, False{}) == True{} : Bool},
  hy: {KS.Nth(Bool, kids, 1n, False{}) == True{} : Bool},
  hh: {Nat.is_le(K.start(l, 1n+j), head) == True{} : Bool})
  -> {K.offers.node(l, head, j, b, kids) == True{} : Bool}:
  match kids:
    case Nil{}:
      A.false_true({K.offers.node(l, head, j, b, Nil{}) == True{} : Bool}, hx)
    case Con{x, Nil{}}:
      A.false_true({K.offers.node(l, head, j, b, [x]) == True{} : Bool}, hy)
    case Con{x, Con{y, rest}}:
      %Equal.sym(Bool, b, False{}, hb) : {Bool.and(Bool.and(Bool.and(Bool.not(_), x), y), Nat.is_le(K.start(l, 1n+j), head)) == True{} : Bool}
      %Equal.sym(Bool, x, True{}, hx) : {Bool.and(Bool.and(Bool.and(Bool.not(False{}), _), y), Nat.is_le(K.start(l, 1n+j), head)) == True{} : Bool}
      %Equal.sym(Bool, y, True{}, hy) : {Bool.and(Bool.and(Bool.and(Bool.not(False{}), True{}), _), Nat.is_le(K.start(l, 1n+j), head)) == True{} : Bool}
      %Equal.sym(Bool, Nat.is_le(K.start(l, 1n+j), head), True{}, hh) : {Bool.and(Bool.and(Bool.and(Bool.not(False{}), True{}), True{}), _) == True{} : Bool}
      {==}

def R.end_at(+l: Nat, -j: Nat, -j0: Nat, -head: Nat, e: {j == j0 : Nat}, h: {Nat.is_le(K.start(l, 1n+j0), head) == True{} : Bool})
  -> {Nat.is_le(K.start(l, 1n+j), head) == True{} : Bool}:
  %Equal.sym(Nat, j, j0, e) : {Nat.is_le(K.start(l, 1n+_), head) == True{} : Bool}
  h

# node j0 of this level, d further on: offered
def R.level_hit(own: List<&2, Bool>, +d: Nat, +kids: List<&2, Bool>, +l: Nat, +head: Nat, +j: Nat, -j0: Nat, -acc: List<&2, K.Coord>,
  +e: {Nat.add(d, j) == j0 : Nat},
  hl: {Nat.is_lt(d, KS.Len(Bool, own)) == True{} : Bool},
  hb: {KS.Nth(Bool, own, d, False{}) == False{} : Bool},
  hx: {KS.Nth(Bool, kids, Nat.double(d), False{}) == True{} : Bool},
  hy: {KS.Nth(Bool, kids, 1n+Nat.double(d), False{}) == True{} : Bool},
  +hh: {Nat.is_le(K.start(l, 1n+j0), head) == True{} : Bool})
  -> KS.In(K.Coord{l, j0}, K.offers.level(own, kids, l, head, j, acc)):
  match own:
    case Nil{}:
      R.none_at(KS.In(K.Coord{l, j0}, K.offers.level(Nil{}, kids, l, head, j, acc)), d, hl)
    case Con{+b, rest}:
      match d:
        case 0n:
          %e : KS.In(K.Coord{l, _}, K.offers.level(Con{b, rest}, kids, l, head, j, acc))
          %Equal.sym(Bool, K.offers.node(l, head, j, b, kids), True{}, R.node_true(l, head, j, b, kids, hb, hx, hy, R.end_at(l, j, j0, head, e, hh)))
            : KS.In(K.Coord{l, j}, K.offers.level(rest, K.offers.drop2(kids), l, head, 1n+j, K.offer(_, K.Coord{l, j}, acc)))
          R.level_keep(rest, K.offers.drop2(kids), l, head, 1n+j, Con{K.Coord{l, j}, acc}, K.Coord{l, j}, Inl{{==}})
        case 1n+d2:
          R.level_hit(rest, d2, K.offers.drop2(kids), l, head, 1n+j, j0, K.offer(K.offers.node(l, head, j, b, kids), K.Coord{l, j}, acc),
            Equal.trans(Nat, Nat.add(d2, 1n+j), 1n+Nat.add(d2, j), j0, Equal.sym(Nat, 1n+Nat.add(d2, j), Nat.add(d2, 1n+j), A.add_succ(d2, j)), e),
            hl, hb,
            Equal.trans(Bool, KS.Nth(Bool, K.offers.drop2(kids), Nat.double(d2), False{}), KS.Nth(Bool, kids, 2n+Nat.double(d2), False{}), True{},
              Equal.sym(Bool, KS.Nth(Bool, kids, 2n+Nat.double(d2), False{}), KS.Nth(Bool, K.offers.drop2(kids), Nat.double(d2), False{}), R.drop2_nth(kids, Nat.double(d2))), hx),
            Equal.trans(Bool, KS.Nth(Bool, K.offers.drop2(kids), 1n+Nat.double(d2), False{}), KS.Nth(Bool, kids, 3n+Nat.double(d2), False{}), True{},
              Equal.sym(Bool, KS.Nth(Bool, kids, 3n+Nat.double(d2), False{}), KS.Nth(Bool, K.offers.drop2(kids), 1n+Nat.double(d2), False{}), R.drop2_nth(kids, 1n+Nat.double(d2))), hy),
            hh)

def R.lvl_at(-l: Nat, -lt: Nat, +j0: Nat, -head: Nat, e: {l == lt : Nat}, h: {Nat.is_le(K.start(lt, 1n+j0), head) == True{} : Bool})
  -> {Nat.is_le(K.start(l, 1n+j0), head) == True{} : Bool}:
  %Equal.sym(Nat, l, lt, e) : {Nat.is_le(K.start(_, 1n+j0), head) == True{} : Bool}
  h

# node j0 of the level d further up (level lt): offered
def R.up_hit(levels: List<&2, List<&2, Bool>>, +d: Nat, +below: List<&2, Bool>, +l: Nat, +head: Nat, -lt: Nat, +j0: Nat, -acc: List<&2, K.Coord>,
  +e: {Nat.add(d, l) == lt : Nat},
  hl: {Nat.is_lt(j0, KS.Len(Bool, KS.Nth(List<&2, Bool>, levels, d, Nil{}))) == True{} : Bool},
  hb: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, levels, d, Nil{}), j0, False{}) == False{} : Bool},
  hx: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, Con{below, levels}, d, Nil{}), Nat.double(j0), False{}) == True{} : Bool},
  hy: {KS.Nth(Bool, KS.Nth(List<&2, Bool>, Con{below, levels}, d, Nil{}), 1n+Nat.double(j0), False{}) == True{} : Bool},
  +hh: {Nat.is_le(K.start(lt, 1n+j0), head) == True{} : Bool})
  -> KS.In(K.Coord{lt, j0}, K.offers.up(levels, below, l, head, acc)):
  match levels:
    case Nil{}:
      R.none_at(KS.In(K.Coord{lt, j0}, K.offers.up(Nil{}, below, l, head, acc)), j0, hl)
    case Con{+own, rest}:
      match d:
        case 0n:
          %e : KS.In(K.Coord{_, j0}, K.offers.up(Con{own, rest}, below, l, head, acc))
          R.up_keep(rest, own, 1n+l, head, K.offers.level(own, below, l, head, 0n, acc), K.Coord{l, j0},
            R.level_hit(own, j0, below, l, head, 0n, j0, acc, Equal.sym(Nat, j0, Nat.add(j0, 0n), A.add_zero(j0)), hl, hb, hx, hy,
              R.lvl_at(l, lt, j0, head, e, hh)))
        case 1n+d2:
          R.up_hit(rest, d2, own, 1n+l, head, lt, j0, K.offers.level(own, below, l, head, 0n, acc),
            Equal.trans(Nat, Nat.add(d2, 1n+l), 1n+Nat.add(d2, l), lt, Equal.sym(Nat, 1n+Nat.add(d2, l), Nat.add(d2, 1n+l), A.add_succ(d2, l)), e),
            hl, hb, hx, hy, hh)

# Law 5, the other way
# --------------------

def offers_complete_k(+levels: List<&2, List<&2, Bool>>, +head: Nat, c: K.Coord, a: KS.Allowed(levels, head, c))
  -> KS.In(c, K.offers(levels, head)):
  match levels:
    case Nil{}:
      match c:
        case K.Coord{0n, +i}:
          (pr, _, _) = a
          R.none_at(KS.In(K.Coord{0n, i}, K.offers(Nil{}, head)), i, pr)
        case K.Coord{1n+m, +i}:
          (pr, _, _, _, _) = a
          R.none_at(KS.In(K.Coord{1n+m, i}, K.offers(Nil{}, head)), i, pr)
    case Con{leaves, rest}:
      match c:
        case K.Coord{0n, +i}:
          (pr, nb, le) = a
          R.up_keep(rest, leaves, 1n, head, K.offers.leaves(leaves, head, 0n, Nil{}), K.Coord{0n, i},
            R.leaves_hit(leaves, i, head, 0n, i, Nil{}, Equal.sym(Nat, i, Nat.add(i, 0n), A.add_zero(i)), pr, nb, le))
        case K.Coord{1n++m, +i}:
          (pr, nb, k1, k2, le) = a
          R.up_hit(rest, m, leaves, 1n, head, 1n+m, i, K.offers.leaves(leaves, head, 0n, Nil{}), R.add_one(m), pr, nb, k1, k2, le)
