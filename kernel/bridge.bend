# The laws, in LAWS.bend's words, from the lemmas the other proof files
# prove in the kernel's (kspec.bend): the kernel's start and pow2 are
# Start and Width, its mergeable check is Siblings, its merge is Merged,
# its size is Total, its snoc is Snoc, and its tail-recursive walks are
# their structural forms.

import Base
import ./kernel.bend as K
import ./LAWS.bend as Laws
import ./kspec.bend as KS
import ./lemmas_a.bend as A
import ./lemmas_fold.bend as F
import ./proofs_addr.bend as PA
import ./proofs_fold.bend as PF
import ./proofs_rule3.bend as PR
import ./proofs_saw.bend as PS

# Addressing (law 2)
# ------------------

def Laws.span_start(l, i):
  PA.span_start_k(l, i)

def Laws.span_size(l):
  PA.span_size_k(l)

# rewrites between the two vocabularies, one equation each
def start_laws(+l: Nat, +i: Nat, -x: Nat, h: {K.start(l, i) == x : Nat}) -> {Laws.Start(l, i) == x : Nat}:
  %PA.span_start_k(l, i) : {_ == x : Nat}
  h

def start_ks(+l: Nat, +i: Nat, -x: Nat, h: {Laws.Start(l, i) == x : Nat}) -> {K.start(l, i) == x : Nat}:
  %Equal.sym(Nat, K.start(l, i), Laws.Start(l, i), PA.span_start_k(l, i)) : {_ == x : Nat}
  h

def width_laws(+l: Nat, -x: Nat, h: {K.pow2(l) == x : Nat}) -> {Laws.Width(l) == x : Nat}:
  %PA.span_size_k(l) : {_ == x : Nat}
  h

def names_of(+m: Maybe<&2, K.Coord>, -id: Nat, -n: Nat, -T: Nat, h: KS.Names(m, id, n, T)) -> Laws.Names(m, id, n, T):
  match m:
    case None{}:
      Unit{}
    case Some{K.Coord{+l, +i}}:
      (s, w, le) = h
      (start_laws(l, i, id, s), width_laws(l, n, w), le)

def Laws.coords_names(id, n, T):
  names_of(K.coords(id, n, T), id, n, T, PA.coords_names_k(id, n, T))

def le_ks(+l: Nat, +i: Nat, -T: Nat, h: {Nat.is_le(Nat.add(Laws.Start(l, i), Laws.Width(l)), T) == True{} : Bool})
  -> {Nat.is_le(Nat.add(K.start(l, i), K.pow2(l)), T) == True{} : Bool}:
  %Equal.sym(Nat, K.start(l, i), Laws.Start(l, i), PA.span_start_k(l, i)) : {Nat.is_le(Nat.add(_, K.pow2(l)), T) == True{} : Bool}
  %Equal.sym(Nat, K.pow2(l), Laws.Width(l), PA.span_size_k(l)) : {Nat.is_le(Nat.add(Laws.Start(l, i), _), T) == True{} : Bool}
  h

def Laws.coords_complete(l, i, T):
  h =>
    %PA.span_start_k(l, i) : {K.coords(_, Laws.Width(l), T) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
    %PA.span_size_k(l) : {K.coords(K.start(l, i), _, T) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
    PA.coords_complete_k(l, i, T, le_ks(l, i, T, h))

# Tiling, in either vocabulary
# ----------------------------

def rest_laws(-rest: List<&2, K.Part>, +s: Nat, +l: Nat, -e: Nat, t: Laws.Tiles(rest, Nat.add(s, K.pow2(l)), e))
  -> Laws.Tiles(rest, Nat.add(s, Laws.Width(l)), e):
  %PA.span_size_k(l) : Laws.Tiles(rest, Nat.add(s, _), e)
  t

def rest_ks(-rest: List<&2, K.Part>, +s: Nat, +l: Nat, -e: Nat, t: KS.Tiles(rest, Nat.add(s, Laws.Width(l)), e))
  -> KS.Tiles(rest, Nat.add(s, K.pow2(l)), e):
  %Equal.sym(Nat, K.pow2(l), Laws.Width(l), PA.span_size_k(l)) : KS.Tiles(rest, Nat.add(s, _), e)
  t

def tiles_laws(+ps: List<&2, K.Part>, +s: Nat, -e: Nat, t: KS.Tiles(ps, s, e)) -> Laws.Tiles(ps, s, e):
  match ps:
    case Nil{}:
      t
    case Con{K.Part{+l, +i, sz, b, u}, rest}:
      (t1, t2) = t
      (start_laws(l, i, s, t1), rest_laws(rest, s, l, e, tiles_laws(rest, Nat.add(s, K.pow2(l)), e, t2)))

def tiles_ks(+ps: List<&2, K.Part>, +s: Nat, -e: Nat, t: Laws.Tiles(ps, s, e)) -> KS.Tiles(ps, s, e):
  match ps:
    case Nil{}:
      t
    case Con{K.Part{+l, +i, sz, b, u}, rest}:
      (t1, t2) = t
      (start_ks(l, i, s, t1), rest_ks(rest, s, l, e, tiles_ks(rest, Nat.add(s, Laws.Width(l)), e, t2)))

# Siblings, both ways
# -------------------

# divmod by 2 counts the pairs
def halve(+j: Nat, +d: Nat) -> {Nat.divmod.go(Nat.double(j), 1n, d, 0n) == (Nat.add(j, d), 0n) : Nat & Nat}:
  match j:
    case 0n:
      {==}
    case 1n+jp:
      %Equal.sym(Nat, 1n+Nat.add(jp, d), Nat.add(jp, 1n+d), F.add_succ_r(jp, d)) : {Nat.divmod.go(Nat.double(jp), 1n, 1n+d, 0n) == (_, 0n) : Nat & Nat}
      halve(jp, 1n+d)

def div_double(+j: Nat) -> {Nat.div(Nat.double(j), 2n) == j : Nat}:
  %Equal.sym(Nat & Nat, Nat.divmod.go(Nat.double(j), 1n, 0n, 0n), (Nat.add(j, 0n), 0n), halve(j, 0n)) : {Pair.fst(Nat, Nat, _) == j : Nat}
  F.add_zero_r(j)

def and4_true(a: Bool, b: Bool, c: Bool, d: Bool,
  ha: {a == True{} : Bool}, hb: {b == True{} : Bool}, hc: {c == True{} : Bool}, hd: {d == True{} : Bool})
  -> {Bool.and(Bool.and(Bool.and(a, b), c), d) == True{} : Bool}:
  %Equal.sym(Bool, a, True{}, ha) : {Bool.and(Bool.and(Bool.and(_, b), c), d) == True{} : Bool}
  %Equal.sym(Bool, b, True{}, hb) : {Bool.and(Bool.and(Bool.and(True{}, _), c), d) == True{} : Bool}
  %Equal.sym(Bool, c, True{}, hc) : {Bool.and(Bool.and(Bool.and(True{}, True{}), _), d) == True{} : Bool}
  %Equal.sym(Bool, d, True{}, hd) : {Bool.and(Bool.and(Bool.and(True{}, True{}), True{}), _) == True{} : Bool}
  {==}

def same_level(+la: Nat, -lb: Nat, e: {la == lb : Nat}) -> {Nat.is_eq(la, lb) == True{} : Bool}:
  %e : {Nat.is_eq(la, _) == True{} : Bool}
  A.eq_refl(la)

def even_check(+ia: Nat, +j: Nat, e: {ia == Nat.double(j) : Nat}) -> {Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia) == True{} : Bool}:
  %Equal.sym(Nat, ia, Nat.double(j), e) : {Nat.is_eq(Nat.double(Nat.div(_, 2n)), _) == True{} : Bool}
  %Equal.sym(Nat, Nat.div(Nat.double(j), 2n), j, div_double(j)) : {Nat.is_eq(Nat.double(_), Nat.double(j)) == True{} : Bool}
  A.eq_refl(Nat.double(j))

def next_check(+ia: Nat, -ib: Nat, e: {ib == 1n+ia : Nat}) -> {Nat.is_eq(1n+ia, ib) == True{} : Bool}:
  %Equal.sym(Nat, ib, 1n+ia, e) : {Nat.is_eq(1n+ia, _) == True{} : Bool}
  A.eq_refl(1n+ia)

def ups_check(ua: List<&2, Nat>, ne: Laws.NonEmpty(ua)) -> {K.built_up(ua) == True{} : Bool}:
  match ua:
    case Nil{}:
      Empty.absurd({K.built_up(Nil{}) == True{} : Bool}, ne)
    case Con{_, _}:
      {==}

def even_of(+ia: Nat, w: &j: Nat -> {ia == Nat.double(j) : Nat}) -> {Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia) == True{} : Bool}:
  (+j, e) = w
  even_check(ia, j, e)

def mergeable_complete(+a: K.Part, +b: K.Part, s: Laws.Siblings(a, b)) -> {K.mergeable(a, b) == True{} : Bool}:
  match a b:
    case K.Part{+la, +ia, sa, ba, ua} K.Part{+lb, +ib, sb, bb, ub}:
      (el, w, eb, ne) = s
      and4_true(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia), Nat.is_eq(1n+ia, ib), K.built_up(ua),
        same_level(la, lb, el), even_of(ia, w), next_check(ia, ib, eb), ups_check(ua, ne))

def nonempty_of(ua: List<&2, Nat>, h: {K.built_up(ua) == True{} : Bool}) -> Laws.NonEmpty(ua):
  match ua:
    case Nil{}:
      Empty.absurd(Laws.NonEmpty(Nil{}), F.false_true(h))
    case Con{_, _}:
      Unit{}

def mergeable_sound(+a: K.Part, +b: K.Part, +h: {K.mergeable(a, b) == True{} : Bool}) -> Laws.Siblings(a, b):
  match a b:
    case K.Part{+la, +ia, sa, ba, ua} K.Part{+lb, +ib, sb, bb, ub}:
      hl = F.and4_a(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia), Nat.is_eq(1n+ia, ib), K.built_up(ua), h)
      hd = F.and4_b(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia), Nat.is_eq(1n+ia, ib), K.built_up(ua), h)
      hn = F.and_r(Bool.and(Bool.and(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia)), Nat.is_eq(1n+ia, ib)), K.built_up(ua), h)
      hc = F.and_r(Bool.and(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia)), Nat.is_eq(1n+ia, ib),
        F.and_l(Bool.and(Bool.and(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia)), Nat.is_eq(1n+ia, ib)), K.built_up(ua), h))
      (F.eq_sound(la, lb, hl),
        (Nat.div(ia, 2n), Equal.sym(Nat, Nat.double(Nat.div(ia, 2n)), ia, F.eq_sound(Nat.double(Nat.div(ia, 2n)), ia, hd))),
        Equal.sym(Nat, 1n+ia, ib, F.eq_sound(1n+ia, ib, hc)),
        nonempty_of(ua, hn))

# Pairs, merges and sizes, both ways
# ----------------------------------

def pair_sound(+ps: List<&2, K.Part>, +k: Nat, +h: {KS.PairAt(ps, k) == True{} : Bool}) -> Laws.PairAt(ps, k):
  match ps k:
    case Nil{} _:
      Empty.absurd(Laws.PairAt(Nil{}, k), F.false_true(h))
    case Con{a, Nil{}} 0n:
      Empty.absurd(Laws.PairAt([a], 0n), F.false_true(h))
    case Con{+a, Con{+b, more}} 0n:
      mergeable_sound(a, b, h)
    case Con{a, rest} 1n+j:
      pair_sound(rest, j, h)

def pair_complete(+ps: List<&2, K.Part>, +k: Nat, p: Laws.PairAt(ps, k)) -> {KS.PairAt(ps, k) == True{} : Bool}:
  match ps k:
    case Nil{} _:
      Empty.absurd({KS.PairAt(Nil{}, k) == True{} : Bool}, p)
    case Con{a, Nil{}} 0n:
      Empty.absurd({KS.PairAt([a], 0n) == True{} : Bool}, p)
    case Con{+a, Con{+b, more}} 0n:
      mergeable_complete(a, b, p)
    case Con{a, rest} 1n+j:
      pair_complete(rest, j, p)

def parent_eq(a: K.Part) -> {K.parent(a) == Laws.ParentOf(a) : K.Part}:
  match a:
    case K.Part{l, i, s, b, ups}:
      match ups:
        case Nil{}:
          {==}
        case Con{u, us}:
          {==}

def merged_eq(ps: List<&2, K.Part>, k: Nat) -> {KS.merge_s(ps, k) == Laws.Merged(ps, k) : List<&2, K.Part>}:
  match ps k:
    case Nil{} _:
      {==}
    case Con{a, Nil{}} 0n:
      {==}
    case Con{+a, Con{b, more}} 0n:
      %parent_eq(a) : {K.parent(a) <> more == _ <> more : List<&2, K.Part>}
      {==}
    case Con{+a, rest} 1n+j:
      %merged_eq(rest, j) : {a <> KS.merge_s(rest, j) == a <> _ : List<&2, K.Part>}
      {==}

def merges_rw(-n: Nat, +ps: List<&2, K.Part>, +k: Nat, -qs: List<&2, K.Part>, m: Laws.Merges(n, KS.merge_s(ps, k), qs))
  -> Laws.Merges(n, Laws.Merged(ps, k), qs):
  %merged_eq(ps, k) : Laws.Merges(n, _, qs)
  m

def merges_laws(n: Nat, +ps: List<&2, K.Part>, -qs: List<&2, K.Part>, m: KS.Merges(n, ps, qs)) -> Laws.Merges(n, ps, qs):
  match n:
    case 0n:
      m
    case 1n+n2:
      (+k, hm) = m
      (+h, m2) = hm
      (k, (pair_sound(ps, k, h), merges_rw(n2, ps, k, qs, merges_laws(n2, KS.merge_s(ps, k), qs, m2))))

def merges_of(+ps: List<&2, K.Part>, -qs: List<&2, K.Part>, w: &n: Nat -> KS.Merges(n, ps, qs)) -> &n: Nat -> Laws.Merges(n, ps, qs):
  (+n, m) = w
  (n, merges_laws(n, ps, qs, m))

def total_acc(ps: List<&2, K.Part>, +acc: Nat) -> {K.total(ps, acc) == Nat.add(acc, Laws.Total(ps)) : Nat}:
  match ps:
    case Nil{}:
      Equal.sym(Nat, Nat.add(acc, 0n), acc, F.add_zero_r(acc))
    case Con{K.Part{l, i, +s, b, u}, rest}:
      Equal.trans(Nat, K.total(rest, Nat.add(acc, s)), Nat.add(Nat.add(acc, s), Laws.Total(rest)), Nat.add(acc, Nat.add(s, Laws.Total(rest))),
        total_acc(rest, Nat.add(acc, s)), F.add_assoc(acc, s, Laws.Total(rest)))

def size_total(+ps: List<&2, K.Part>) -> {K.size(ps) == Laws.Total(ps) : Nat}:
  total_acc(ps, 0n)

def within(+ps: List<&2, K.Part>, -budget: Nat, h: {Nat.is_gt(K.size(ps), budget) == False{} : Bool})
  -> {Nat.is_gt(Laws.Total(ps), budget) == False{} : Bool}:
  %size_total(ps) : {Nat.is_gt(_, budget) == False{} : Bool}
  h

def no_pair(+ps: List<&2, K.Part>, +k: Nat, g: {KS.PairAt(ps, k) == False{} : Bool}, p: Laws.PairAt(ps, k)) -> Empty:
  F.false_true(Equal.trans(Bool, False{}, KS.PairAt(ps, k), True{}, Equal.sym(Bool, KS.PairAt(ps, k), False{}, g), pair_complete(ps, k, p)))

def fits_laws(-budget: Nat, +ps: List<&2, K.Part>, f: KS.Fits(budget, ps)) -> Laws.Fits(budget, ps):
  match f:
    case Inl{h}:
      Inl{within(ps, budget, h)}
    case Inr{g}:
      Inr{+k => p => no_pair(ps, k, g(k), p)}

# Laws 1 (fit), 3 and 4
# ---------------------

def Laws.fit_merges(T, budget, ps):
  merges_of(ps, K.fit(T, budget, ps), PF.fit_merges_k(T, budget, ps))

def Laws.fit_fits(T, budget, ps):
  fits_laws(budget, K.fit(T, budget, ps), PF.fit_fits_k(T, budget, ps))

# fit.go stops at a Stop, whatever fuel is left
def stop_go(f: Nat, +T: Nat, +budget: Nat, ps: List<&2, K.Part>) -> {K.fit.go(f, K.Stop{ps}, T, budget) == ps : List<&2, K.Part>}:
  match f:
    case 0n:
      {==}
    case 1n+g:
      {==}

# within budget in LAWS.bend's words is within budget in the kernel's
def within_k(+ps: List<&2, K.Part>, -budget: Nat, h: {Nat.is_gt(Laws.Total(ps), budget) == False{} : Bool})
  -> {Nat.is_gt(K.size(ps), budget) == False{} : Bool}:
  %Equal.sym(Nat, K.size(ps), Laws.Total(ps), size_total(ps)) : {Nat.is_gt(_, budget) == False{} : Bool}
  h

# within budget, fit's first step is a Stop on the view itself
def Laws.fit_within(T, budget, ps):
  h =>
    %Equal.sym(Bool, Nat.is_gt(K.size(ps), budget), False{}, within_k(ps, budget, h)) : {K.fit.go(K.length(ps, 0n), K.step.over(_, T, ps), T, budget) == ps : List<&2, K.Part>}
    stop_go(K.length(ps, 0n), T, budget, ps)

def Laws.tiles_fit(T, budget, ps):
  t => tiles_laws(K.fit(T, budget, ps), 0n, T, PF.tiles_fit_k(T, budget, ps)(tiles_ks(ps, 0n, T, t)))

# Appends and the rebuild (law 1)
# -------------------------------

def AppS(xs: List<&2, K.Part>, ys: List<&2, K.Part>) -> List<&2, K.Part>:
  match xs:
    case Nil{}:
      ys
    case Con{h, t}:
      h <> AppS(t, ys)

# reversing onto acc, then onto ys, is ys after xs, reversed onto acc
def rev_rev(xs: List<&2, K.Part>, -acc: List<&2, K.Part>, -ys: List<&2, K.Part>)
  -> {K.rev_onto(K.rev_onto(xs, acc), ys) == K.rev_onto(acc, AppS(xs, ys)) : List<&2, K.Part>}:
  match xs:
    case Nil{}:
      {==}
    case Con{h, t}:
      rev_rev(t, h <> acc, ys)

# reversing onto a list that ends in ys is the same as appending ys after
def rev_app(xs: List<&2, K.Part>, -acc: List<&2, K.Part>, -ys: List<&2, K.Part>)
  -> {K.rev_onto(xs, AppS(acc, ys)) == AppS(K.rev_onto(xs, acc), ys) : List<&2, K.Part>}:
  match xs:
    case Nil{}:
      {==}
    case Con{h, t}:
      rev_app(t, h <> acc, ys)

def app_nil(xs: List<&2, K.Part>) -> {AppS(xs, Nil{}) == xs : List<&2, K.Part>}:
  match xs:
    case Nil{}:
      {==}
    case Con{+h, t}:
      %app_nil(t) : {h <> AppS(t, Nil{}) == h <> _ : List<&2, K.Part>}
      {==}

def app_snoc(xs: List<&2, K.Part>, -p: K.Part) -> {AppS(xs, [p]) == KS.snoc_s(xs, p) : List<&2, K.Part>}:
  match xs:
    case Nil{}:
      {==}
    case Con{+h, t}:
      %app_snoc(t, p) : {h <> AppS(t, [p]) == h <> _ : List<&2, K.Part>}
      {==}

def snoc_eq(+ps: List<&2, K.Part>, +p: K.Part) -> {K.snoc(ps, p) == KS.snoc_s(ps, p) : List<&2, K.Part>}:
  Equal.trans(List<&2, K.Part>, K.snoc(ps, p), AppS(ps, [p]), KS.snoc_s(ps, p), rev_rev(ps, Nil{}, [p]), app_snoc(ps, p))

def reverse_twice(+xs: List<&2, K.Part>) -> {K.rev_onto(K.rev_onto(xs, Nil{}), Nil{}) == xs : List<&2, K.Part>}:
  Equal.trans(List<&2, K.Part>, K.rev_onto(K.rev_onto(xs, Nil{}), Nil{}), AppS(xs, Nil{}), xs, rev_rev(xs, Nil{}, Nil{}), app_nil(xs))

# the newest line pushed onto a reversed view is the view with it at the end
def push_end(+rev: List<&2, K.Part>, +p: K.Part) -> {K.rev_onto(p <> rev, Nil{}) == KS.snoc_s(K.rev_onto(rev, Nil{}), p) : List<&2, K.Part>}:
  Equal.trans(List<&2, K.Part>, K.rev_onto(rev, [p]), AppS(K.rev_onto(rev, Nil{}), [p]), KS.snoc_s(K.rev_onto(rev, Nil{}), p),
    rev_app(rev, Nil{}, [p]), app_snoc(K.rev_onto(rev, Nil{}), p))

def tiles_snoc_k(+ps: List<&2, K.Part>, +T: Nat, +s: Nat, +b: Bool, +ups: List<&2, Nat>, t: KS.Tiles(ps, 0n, T))
  -> KS.Tiles(K.snoc(ps, K.Part{0n, T, s, b, ups}), 0n, 1n+T):
  %Equal.sym(List<&2, K.Part>, K.snoc(ps, K.Part{0n, T, s, b, ups}), KS.snoc_s(ps, K.Part{0n, T, s, b, ups}), snoc_eq(ps, K.Part{0n, T, s, b, ups})) : KS.Tiles(_, 0n, 1n+T)
  PF.tiles_snoc(ps, 0n, T, s, b, ups, t)

def snoc_s_laws(ps: List<&2, K.Part>, -p: K.Part) -> {KS.snoc_s(ps, p) == Laws.Snoc(ps, p) : List<&2, K.Part>}:
  match ps:
    case Nil{}:
      {==}
    case Con{+h, t}:
      %snoc_s_laws(t, p) : {h <> KS.snoc_s(t, p) == h <> _ : List<&2, K.Part>}
      {==}

# the kernel's snoc is LAWS.bend's
def snoc_laws(+ps: List<&2, K.Part>, +p: K.Part) -> {K.snoc(ps, p) == Laws.Snoc(ps, p) : List<&2, K.Part>}:
  Equal.trans(List<&2, K.Part>, K.snoc(ps, p), KS.snoc_s(ps, p), Laws.Snoc(ps, p), snoc_eq(ps, p), snoc_s_laws(ps, p))

def Laws.tiles_append(T, high, low, folding, ps, m):
  match m:
    case K.Msg{+s, +b, +ups}:
      t => tiles_laws(Laws.ViewOf(K.saw(1n+T, high, low, folding, K.snoc(ps, K.Part{0n, T, s, b, ups}))), 0n, 1n+T,
        PS.tiles_saw_k(1n+T, high, low, folding, K.snoc(ps, K.Part{0n, T, s, b, ups}))(tiles_snoc_k(ps, T, s, b, ups, tiles_ks(ps, 0n, T, t))))

# The sawtooth (laws 3 and 4)
# ---------------------------

def Laws.saw_merges(T, high, low, folding, ps):
  merges_of(ps, Laws.ViewOf(K.saw(T, high, low, folding, ps)), PS.saw_merges_k(T, high, low, folding, ps))

def Laws.append_merges(T, high, low, folding, ps, m):
  match m:
    case K.Msg{+s, +b, +ups}:
      %snoc_laws(ps, K.Part{0n, T, s, b, ups}) : (&n: Nat -> Laws.Merges(n, _, Laws.ViewOf(K.saw(1n+T, high, low, folding, K.snoc(ps, K.Part{0n, T, s, b, ups})))))
      merges_of(K.snoc(ps, K.Part{0n, T, s, b, ups}), Laws.ViewOf(K.saw(1n+T, high, low, folding, K.snoc(ps, K.Part{0n, T, s, b, ups}))),
        PS.saw_merges_k(1n+T, high, low, folding, K.snoc(ps, K.Part{0n, T, s, b, ups})))

# within high and owing nothing, saw.go is asked False and answers the view
def Laws.saw_within(T, high, low, ps):
  h =>
    %Equal.sym(Bool, Nat.is_gt(K.size(ps), high), False{}, within_k(ps, high, h)) : {K.saw.go(_, T, low, ps) == K.Saw{ps, False{}} : K.Saw}
    {==}

def Laws.append_grows(T, high, low, ps, m):
  match m:
    case K.Msg{+s, +b, +ups}:
      h =>
        %Equal.sym(List<&2, K.Part>, K.snoc(ps, K.Part{0n, T, s, b, ups}), Laws.Snoc(ps, K.Part{0n, T, s, b, ups}), snoc_laws(ps, K.Part{0n, T, s, b, ups}))
          : {K.saw(1n+T, high, low, False{}, _) == K.Saw{Laws.Snoc(ps, K.Part{0n, T, s, b, ups}), False{}} : K.Saw}
        Laws.saw_within(1n+T, high, low, Laws.Snoc(ps, K.Part{0n, T, s, b, ups}))(h)

def folding_laws(+ps: List<&2, K.Part>, -low: Nat, -f: Bool, e: {f == Nat.is_gt(K.size(ps), low) : Bool})
  -> {f == Nat.is_gt(Laws.Total(ps), low) : Bool}:
  %size_total(ps) : {f == Nat.is_gt(_, low) : Bool}
  e

def batched_laws(-low: Nat, r: K.Saw, b: PS.Batched(low, r)) -> Laws.Batched(low, r):
  match r:
    case K.Saw{+ps, f}:
      (fi, e) = b
      (fits_laws(low, ps, fi), folding_laws(ps, low, f, e))

def due_ks(+folding: Bool, +ps: List<&2, K.Part>, -high: Nat, h: {Bool.or(folding, Nat.is_gt(Laws.Total(ps), high)) == True{} : Bool})
  -> {Bool.or(folding, Nat.is_gt(K.size(ps), high)) == True{} : Bool}:
  %Equal.sym(Nat, K.size(ps), Laws.Total(ps), size_total(ps)) : {Bool.or(folding, Nat.is_gt(_, high)) == True{} : Bool}
  h

def Laws.saw_batch(T, high, low, folding, ps):
  h => batched_laws(low, K.saw(T, high, low, folding, ps), PS.saw_batch_k(T, high, low, folding, ps, due_ks(folding, ps, high, h)))

# what refold carries tiles [0, T) once turned the right way round
def FoldTiles(f: K.Fold, T: Nat) -> Type:
  K.Fold{rev, _, _} = f
  KS.Tiles(K.rev_onto(rev, Nil{}), 0n, T)

def batch_tiles(+T: Nat, +low: Nat, +ps: List<&2, K.Part>, t: KS.Tiles(ps, 0n, T)) -> FoldTiles(K.fold.batch(T, low, ps), T):
  %Equal.sym(List<&2, K.Part>, K.rev_onto(K.rev_onto(K.fit(T, low, ps), Nil{}), Nil{}), K.fit(T, low, ps), reverse_twice(K.fit(T, low, ps))) : KS.Tiles(_, 0n, T)
  PF.tiles_fit_k(T, low, ps)(t)

def decide_tiles(skip: Bool, +T: Nat, +low: Nat, +rev: List<&2, K.Part>, -n: Nat, -folding: Bool,
  t: KS.Tiles(K.rev_onto(rev, Nil{}), 0n, T)) -> FoldTiles(K.fold.decide(skip, T, low, rev, n, folding), T):
  match skip:
    case True{}:
      t
    case False{}:
      batch_tiles(T, low, K.rev_onto(rev, Nil{}), t)

def pushed_tiles(+rev: List<&2, K.Part>, +T: Nat, +s: Nat, +b: Bool, +ups: List<&2, Nat>, t: KS.Tiles(K.rev_onto(rev, Nil{}), 0n, T))
  -> KS.Tiles(K.rev_onto(K.Part{0n, T, s, b, ups} <> rev, Nil{}), 0n, 1n+T):
  %Equal.sym(List<&2, K.Part>, K.rev_onto(K.Part{0n, T, s, b, ups} <> rev, Nil{}), KS.snoc_s(K.rev_onto(rev, Nil{}), K.Part{0n, T, s, b, ups}), push_end(rev, K.Part{0n, T, s, b, ups})) : KS.Tiles(_, 0n, 1n+T)
  PF.tiles_snoc(K.rev_onto(rev, Nil{}), 0n, T, s, b, ups, t)

def push_tiles(+T: Nat, +high: Nat, +low: Nat, f: K.Fold, m: K.Msg, t: FoldTiles(f, T)) -> FoldTiles(K.fold.push(T, high, low, f, m), 1n+T):
  match f m:
    case K.Fold{+rev, +n, +folding} K.Msg{+s, +b, +ups}:
      decide_tiles(
        Bool.or(Bool.and(Bool.not(folding), Nat.is_le(Nat.add(n, s), high)), Bool.and(folding, Bool.not(K.pairs_with(rev, K.Part{0n, T, s, b, ups})))),
        1n+T, low, K.Part{0n, T, s, b, ups} <> rev, Nat.add(n, s), folding,
        pushed_tiles(rev, T, s, b, ups, t))

def refold_tiles(+ms: List<&2, K.Msg>, +high: Nat, +low: Nat, +T: Nat, +f: K.Fold, t: FoldTiles(f, T))
  -> FoldTiles(K.refold.go(ms, high, low, T, f), Nat.add(Laws.Len(K.Msg, ms), T)):
  match ms:
    case Nil{}:
      t
    case Con{+m, +rest}:
      %Equal.sym(Nat, 1n+Nat.add(Laws.Len(K.Msg, rest), T), Nat.add(Laws.Len(K.Msg, rest), 1n+T), F.add_succ_r(Laws.Len(K.Msg, rest), T))
        : FoldTiles(K.refold.go(rest, high, low, 1n+T, K.fold.push(T, high, low, f, m)), _)
      refold_tiles(rest, high, low, 1n+T, K.fold.push(T, high, low, f, m), push_tiles(T, high, low, f, m, t))

def end_tiles(f: K.Fold, -T: Nat, t: FoldTiles(f, T)) -> KS.Tiles(Laws.ViewOf(K.refold.end(f)), 0n, T):
  match f:
    case K.Fold{rev, n, folding}:
      t

def refold_ks(+high: Nat, +low: Nat, +ms: List<&2, K.Msg>) -> KS.Tiles(Laws.ViewOf(K.refold(high, low, ms)), 0n, Laws.Len(K.Msg, ms)):
  %F.add_zero_r(Laws.Len(K.Msg, ms)) : KS.Tiles(Laws.ViewOf(K.refold(high, low, ms)), 0n, _)
  end_tiles(K.refold.go(ms, high, low, 0n, K.Fold{Nil{}, 0n, False{}}), Nat.add(Laws.Len(K.Msg, ms), 0n),
    refold_tiles(ms, high, low, 0n, K.Fold{Nil{}, 0n, False{}}, {==}))

# a saved view's tiling carries over: its first new message as append,
# the rest as the rebuild
def of_tiles(+ps: List<&2, K.Part>, -folding: Bool, -T: Nat, t: KS.Tiles(ps, 0n, T)) -> FoldTiles(K.fold.of(K.Saw{ps, folding}), T):
  %Equal.sym(List<&2, K.Part>, K.rev_onto(K.rev_onto(ps, Nil{}), Nil{}), ps, reverse_twice(ps)) : KS.Tiles(_, 0n, T)
  t

def saw_tiles(+r: K.Saw, -T: Nat, t: KS.Tiles(Laws.ViewOf(r), 0n, T)) -> FoldTiles(K.fold.of(r), T):
  match r:
    case K.Saw{+ps, folding}:
      of_tiles(ps, folding, T, t)

def Laws.tiles_extend(T, high, low, ps, folding, ms):
  match ms:
    case Nil{}:
      t => t
    case Con{+m, +rest}:
      t =>
        %Equal.sym(Nat, 1n+Nat.add(Laws.Len(K.Msg, rest), T), Nat.add(Laws.Len(K.Msg, rest), 1n+T), F.add_succ_r(Laws.Len(K.Msg, rest), T))
          : Laws.Tiles(Laws.ViewOf(K.extend(T, high, low, K.Saw{ps, folding}, m <> rest)), 0n, _)
        tiles_laws(Laws.ViewOf(K.refold.end(K.refold.go(rest, high, low, 1n+T, K.fold.of(K.append(T, high, low, folding, ps, m))))), 0n, Nat.add(Laws.Len(K.Msg, rest), 1n+T),
          end_tiles(K.refold.go(rest, high, low, 1n+T, K.fold.of(K.append(T, high, low, folding, ps, m))), Nat.add(Laws.Len(K.Msg, rest), 1n+T),
            refold_tiles(rest, high, low, 1n+T, K.fold.of(K.append(T, high, low, folding, ps, m)),
              saw_tiles(K.append(T, high, low, folding, ps, m), 1n+T, tiles_ks(Laws.ViewOf(K.append(T, high, low, folding, ps, m)), 0n, 1n+T, Laws.tiles_append(T, high, low, folding, ps, m)(t))))))

def Laws.tiles_refold(high, low, ms):
  tiles_laws(Laws.ViewOf(K.refold(high, low, ms)), 0n, Laws.Len(K.Msg, ms), refold_ks(high, low, ms))

# first, structurally (law 5: a compaction's view stops at the first
# unbuilt line)
# ---------------------------

def first_some(ps: List<&2, K.Part>, +T: Nat, -x: Nat) -> {K.first.go(ps, T, Some{x}) == x : Nat}:
  match ps:
    case Nil{}:
      {==}
    case Con{p, rest}:
      first_some(rest, T, x)

def first_none(ps: List<&2, K.Part>, +T: Nat) -> {K.first.go(ps, T, None{}) == KS.first_s(T, ps) : Nat}:
  match ps:
    case Nil{}:
      {==}
    case Con{K.Part{+l, +i, sz, True{}, u}, rest}:
      first_none(rest, T)
    case Con{K.Part{+l, +i, sz, False{}, u}, rest}:
      first_some(rest, T, K.start(l, i))

def first_eq(+T: Nat, +ps: List<&2, K.Part>) -> {K.first(T, ps) == KS.first_s(T, ps) : Nat}:
  first_none(ps, T)

# Comparisons
# -----------

def lt_irrefl(y: Nat) -> {Nat.is_lt(y, y) == False{} : Bool}:
  match y:
    case 0n:
      {==}
    case 1n+p:
      lt_irrefl(p)

def le_refl(y: Nat) -> {Nat.is_le(y, y) == True{} : Bool}:
  match y:
    case 0n:
      {==}
    case 1n+p:
      le_refl(p)

def le_zero(b: Nat) -> {Nat.is_le(0n, b) == True{} : Bool}:
  match b:
    case 0n:
      {==}
    case 1n+p:
      {==}

def lt_le_absurd(a: Nat, x: Nat, h1: {Nat.is_lt(a, x) == True{} : Bool}, h2: {Nat.is_le(x, a) == True{} : Bool}) -> Empty:
  match a x:
    case 0n 0n:
      F.false_true(h1)
    case 0n 1n+q:
      F.false_true(h2)
    case 1n+p 0n:
      F.false_true(h1)
    case 1n+p 1n+q:
      lt_le_absurd(p, q, h1, h2)

def le_add(x: Nat, s: Nat, +w: Nat, h: {Nat.is_le(x, s) == True{} : Bool}) -> {Nat.is_le(x, Nat.add(s, w)) == True{} : Bool}:
  match x s:
    case 0n s0:
      le_zero(Nat.add(s0, w))
    case 1n+p 0n:
      Empty.absurd({Nat.is_le(1n+p, Nat.add(0n, w)) == True{} : Bool}, F.false_true(h))
    case 1n+p 1n+q:
      le_add(p, q, w, h)

def lt_le_trans(a: Nat, x: Nat, y: Nat, h1: {Nat.is_lt(a, x) == True{} : Bool}, h2: {Nat.is_le(x, y) == True{} : Bool})
  -> {Nat.is_lt(a, y) == True{} : Bool}:
  match a x y:
    case 0n 0n y0:
      Empty.absurd({Nat.is_lt(0n, y0) == True{} : Bool}, F.false_true(h1))
    case 0n 1n+q 0n:
      Empty.absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, F.false_true(h2))
    case 0n 1n+q 1n+r:
      {==}
    case 1n+p 0n y0:
      Empty.absurd({Nat.is_lt(1n+p, y0) == True{} : Bool}, F.false_true(h1))
    case 1n+p 1n+q 0n:
      Empty.absurd({Nat.is_lt(1n+p, 0n) == True{} : Bool}, F.false_true(h2))
    case 1n+p 1n+q 1n+r:
      lt_le_trans(p, q, r, h1, h2)

# Built before
# ------------

def lt_start(+l: Nat, +i: Nat, -s: Nat, -x: Nat, t1: {Laws.Start(l, i) == s : Nat}, h: {Nat.is_lt(Laws.Start(l, i), x) == True{} : Bool})
  -> {Nat.is_lt(s, x) == True{} : Bool}:
  %t1 : {Nat.is_lt(_, x) == True{} : Bool}
  h

# a tiling that starts at or after x has nothing before x
def bb_after(ps: List<&2, K.Part>, +s: Nat, -e: Nat, t: Laws.Tiles(ps, s, e), +x: Nat, +h: {Nat.is_le(x, s) == True{} : Bool})
  -> Laws.BuiltBefore(ps, x):
  match ps:
    case Nil{}:
      Unit{}
    case Con{K.Part{+l, +i, sz, b, u}, rest}:
      (t1, t2) = t
      (hl => Empty.absurd({b == True{} : Bool}, lt_le_absurd(s, x, lt_start(l, i, s, x, t1, hl), h)),
        bb_after(rest, Nat.add(s, Laws.Width(l)), e, t2, x, le_add(x, s, Laws.Width(l), h)))

# Law 5
# -----

def FirstOk(ps: List<&2, K.Part>, f: Nat, e: Nat) -> Type:
  (Laws.BuiltBefore(ps, f) & ({f == e : Nat} | Laws.UnbuiltAt(ps, f)))

def unbuilt_here(+l: Nat, +i: Nat) -> {Laws.Start(l, i) == K.start(l, i) : Nat}:
  Equal.sym(Nat, K.start(l, i), Laws.Start(l, i), PA.span_start_k(l, i))

def start_is(+l: Nat, +i: Nat, -s: Nat, t1: {Laws.Start(l, i) == s : Nat}) -> {K.start(l, i) == s : Nat}:
  Equal.trans(Nat, K.start(l, i), Laws.Start(l, i), s, PA.span_start_k(l, i), t1)

def le_start(+l: Nat, +i: Nat, +s: Nat, +w: Nat, t1: {Laws.Start(l, i) == s : Nat}) -> {Nat.is_le(K.start(l, i), Nat.add(s, w)) == True{} : Bool}:
  %Equal.sym(Nat, K.start(l, i), s, start_is(l, i, s, t1)) : {Nat.is_le(_, Nat.add(s, w)) == True{} : Bool}
  le_add(s, s, w, le_refl(s))

def lt_same(+l: Nat, +i: Nat, h: {Nat.is_lt(Laws.Start(l, i), K.start(l, i)) == True{} : Bool})
  -> {Nat.is_lt(Laws.Start(l, i), Laws.Start(l, i)) == True{} : Bool}:
  %PA.span_start_k(l, i) : {Nat.is_lt(Laws.Start(l, i), _) == True{} : Bool}
  h

def irr(+l: Nat, +i: Nat, h: {Nat.is_lt(Laws.Start(l, i), K.start(l, i)) == True{} : Bool}) -> Empty:
  F.false_true(Equal.trans(Bool, False{}, Nat.is_lt(Laws.Start(l, i), Laws.Start(l, i)), True{},
    Equal.sym(Bool, Nat.is_lt(Laws.Start(l, i), Laws.Start(l, i)), False{}, lt_irrefl(Laws.Start(l, i))),
    lt_same(l, i, h)))

def alt_cons(-l: Nat, -i: Nat, -sz: Nat, -b: Bool, -u: List<&2, Nat>, -rest: List<&2, K.Part>, -f: Nat, -e: Nat,
  a: {f == e : Nat} | Laws.UnbuiltAt(rest, f))
  -> {f == e : Nat} | (Laws.UnbuiltAt(K.Part{l, i, sz, b, u} <> rest, f)):
  match a:
    case Inl{x}:
      Inl{x}
    case Inr{u}:
      Inr{Inr{u}}

def ff_built(+l: Nat, +i: Nat, -sz: Nat, -u: List<&2, Nat>, -rest: List<&2, K.Part>, -e: Nat,
  r: FirstOk(rest, KS.first_s(e, rest), e))
  -> FirstOk(K.Part{l, i, sz, True{}, u} <> rest, KS.first_s(e, rest), e):
  (bb, alt) = r
  ((_ => {==}, bb), alt_cons(l, i, sz, True{}, u, rest, KS.first_s(e, rest), e, alt))

# the first line is the first unbuilt one, or none is unbuilt and first is the end
def ff(ps: List<&2, K.Part>, +s: Nat, +e: Nat, t: Laws.Tiles(ps, s, e)) -> FirstOk(ps, KS.first_s(e, ps), e):
  match ps:
    case Nil{}:
      (Unit{}, Inl{{==}})
    case Con{K.Part{+l, +i, sz, True{}, u}, rest}:
      (t1, t2) = t
      ff_built(l, i, sz, u, rest, e, ff(rest, Nat.add(s, Laws.Width(l)), e, t2))
    case Con{K.Part{+l, +i, sz, False{}, u}, rest}:
      (t1, t2) = t
      ((h => Empty.absurd({False{} == True{} : Bool}, irr(l, i, h)),
          bb_after(rest, Nat.add(s, Laws.Width(l)), e, t2, K.start(l, i), le_start(l, i, s, Laws.Width(l), t1))),
        Inr{Inl{(unbuilt_here(l, i), {==})}})

def first_ok(+T: Nat, +ps: List<&2, K.Part>, t: Laws.Tiles(ps, 0n, T)) -> FirstOk(ps, K.first(T, ps), T):
  %Equal.sym(Nat, K.first(T, ps), KS.first_s(T, ps), first_eq(T, ps)) : FirstOk(ps, _, T)
  ff(ps, 0n, T, t)

def Laws.first_first(T, ps):
  t => first_ok(T, ps, t)

# The window (law 5)
# ------------------
# window(e, ps, n), for a view ps tiling [s, e), is the start of its
# (n + 1)-th unbuilt line, or e: a message x at or before it has at most n
# unbuilt lines before it (window_few), and one with at most n unbuilt lines
# before it is at or before it (window_all).

def lt_zero(x: Nat) -> {Nat.is_lt(x, 0n) == False{} : Bool}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      {==}

# x <= y: y is not before x
def lt_false(x: Nat, y: Nat, h: {Nat.is_le(x, y) == True{} : Bool}) -> {Nat.is_lt(y, x) == False{} : Bool}:
  match x y:
    case 0n y0:
      lt_zero(y0)
    case 1n+p 0n:
      Empty.absurd({Nat.is_lt(0n, 1n+p) == False{} : Bool}, F.false_true(h))
    case 1n+p 1n+q:
      lt_false(p, q, h)

def le_trans(a: Nat, b: Nat, c: Nat, h1: {Nat.is_le(a, b) == True{} : Bool}, h2: {Nat.is_le(b, c) == True{} : Bool})
  -> {Nat.is_le(a, c) == True{} : Bool}:
  match a b c:
    case 0n b0 c0:
      le_zero(c0)
    case 1n+p 0n c0:
      Empty.absurd({Nat.is_le(1n+p, c0) == True{} : Bool}, F.false_true(h1))
    case 1n+p 1n+q 0n:
      Empty.absurd({Nat.is_le(1n+p, 0n) == True{} : Bool}, F.false_true(h2))
    case 1n+p 1n+q 1n+r:
      le_trans(p, q, r, h1, h2)

def le_succ(a: Nat, b: Nat, h: {Nat.is_le(a, b) == True{} : Bool}) -> {Nat.is_le(a, 1n+b) == True{} : Bool}:
  match a b:
    case 0n b0:
      {==}
    case 1n+p 0n:
      Empty.absurd({Nat.is_le(1n+p, 1n) == True{} : Bool}, F.false_true(h))
    case 1n+p 1n+q:
      le_succ(p, q, h)

def le_laws(+l: Nat, +i: Nat, -x: Nat, h: {Nat.is_le(x, K.start(l, i)) == True{} : Bool}) -> {Nat.is_le(x, Laws.Start(l, i)) == True{} : Bool}:
  %PA.span_start_k(l, i) : {Nat.is_le(x, _) == True{} : Bool}
  h

def le_kernel(+l: Nat, +i: Nat, -x: Nat, h: {Nat.is_le(x, Laws.Start(l, i)) == True{} : Bool}) -> {Nat.is_le(x, K.start(l, i)) == True{} : Bool}:
  %Equal.sym(Nat, K.start(l, i), Laws.Start(l, i), PA.span_start_k(l, i)) : {Nat.is_le(x, _) == True{} : Bool}
  h

# a line's start, in the spec's words, at or after x: it is not before x
def start_not_before(+l: Nat, +i: Nat, +x: Nat, h: {Nat.is_le(x, K.start(l, i)) == True{} : Bool})
  -> {Nat.is_lt(Laws.Start(l, i), x) == False{} : Bool}:
  lt_false(x, Laws.Start(l, i), le_laws(l, i, x, h))

def le_at(-a: Nat, -b: Nat, -x: Nat, e: {a == b : Nat}, h: {Nat.is_le(x, a) == True{} : Bool}) -> {Nat.is_le(x, b) == True{} : Bool}:
  %e : {Nat.is_le(x, _) == True{} : Bool}
  h

def line_zero(b: Bool, c: Bool, -r: Nat, hc: {c == False{} : Bool}, hr: {r == 0n : Nat}) -> {Laws.UnbuiltLine(b, c, r) == 0n : Nat}:
  match b c:
    case True{} c0:
      hr
    case False{} True{}:
      A.true_false({Laws.UnbuiltLine(False{}, True{}, r) == 0n : Nat}, hc)
    case False{} False{}:
      hr

# no line of a tiling that starts at or after x is before x
def ub_after(ps: List<&2, K.Part>, +s: Nat, -e: Nat, t: Laws.Tiles(ps, s, e), +x: Nat, +h: {Nat.is_le(x, s) == True{} : Bool})
  -> {Laws.UnbuiltBefore(ps, x) == 0n : Nat}:
  match ps:
    case Nil{}:
      {==}
    case Con{K.Part{+l, +i, sz, b, u}, rest}:
      (t1, t2) = t
      line_zero(b, Nat.is_lt(Laws.Start(l, i), x), Laws.UnbuiltBefore(rest, x),
        lt_false(x, Laws.Start(l, i), le_at(s, Laws.Start(l, i), x, Equal.sym(Nat, Laws.Start(l, i), s, t1), h)),
        ub_after(rest, Nat.add(s, Laws.Width(l)), e, t2, x, le_add(x, s, Laws.Width(l), h)))

# the window is at or after the tiling's start
def window_ge(ps: List<&2, K.Part>, +n: Nat, +s: Nat, +e: Nat, t: Laws.Tiles(ps, s, e)) -> {Nat.is_le(s, K.window(e, ps, n)) == True{} : Bool}:
  match ps n:
    case Nil{} n0:
      le_at(s, e, s, t, le_refl(s))
    case Con{K.Part{+l, +i, sz, True{}, u}, +rest} m:
      (t1, t2) = t
      le_trans(s, Nat.add(s, Laws.Width(l)), K.window(e, rest, m), le_add(s, s, Laws.Width(l), le_refl(s)),
        window_ge(rest, m, Nat.add(s, Laws.Width(l)), e, t2))
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 0n:
      (t1, t2) = t
      le_kernel(l, i, s, le_at(s, Laws.Start(l, i), s, Equal.sym(Nat, Laws.Start(l, i), s, t1), le_refl(s)))
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 1n+m:
      (t1, t2) = t
      le_trans(s, Nat.add(s, Laws.Width(l)), K.window(e, rest, m), le_add(s, s, Laws.Width(l), le_refl(s)),
        window_ge(rest, m, Nat.add(s, Laws.Width(l)), e, t2))

# an unbuilt line's share, when it is the n-th: at most what is left

def line_succ(c: Bool, +r: Nat, +m: Nat, h: {Nat.is_le(r, m) == True{} : Bool}) -> {Nat.is_le(Laws.UnbuiltLine(False{}, c, r), 1n+m) == True{} : Bool}:
  match c:
    case True{}:
      h
    case False{}:
      le_succ(r, m, h)

def line_last(c: Bool, -r: Nat, hc: {c == False{} : Bool}, hr: {r == 0n : Nat}) -> {Nat.is_le(Laws.UnbuiltLine(False{}, c, r), 0n) == True{} : Bool}:
  %Equal.sym(Nat, Laws.UnbuiltLine(False{}, c, r), 0n, line_zero(False{}, c, r, hc, hr)) : {Nat.is_le(_, 0n) == True{} : Bool}
  {==}

# a message at or before the window has at most n unbuilt lines before it
def window_few(ps: List<&2, K.Part>, +n: Nat, +s: Nat, +e: Nat, t: Laws.Tiles(ps, s, e), +x: Nat,
  +h: {Nat.is_le(x, K.window(e, ps, n)) == True{} : Bool}) -> {Nat.is_le(Laws.UnbuiltBefore(ps, x), n) == True{} : Bool}:
  match ps n:
    case Nil{} n0:
      le_zero(n0)
    case Con{K.Part{+l, +i, sz, True{}, u}, +rest} m:
      (t1, t2) = t
      window_few(rest, m, Nat.add(s, Laws.Width(l)), e, t2, x, h)
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 0n:
      (t1, t2) = t
      line_last(Nat.is_lt(Laws.Start(l, i), x), Laws.UnbuiltBefore(rest, x), start_not_before(l, i, x, h),
        ub_after(rest, Nat.add(s, Laws.Width(l)), e, t2, x,
          le_add(x, s, Laws.Width(l), le_at(Laws.Start(l, i), s, x, t1, le_laws(l, i, x, h)))))
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 1n+m:
      (t1, t2) = t
      line_succ(Nat.is_lt(Laws.Start(l, i), x), Laws.UnbuiltBefore(rest, x), m, window_few(rest, m, Nat.add(s, Laws.Width(l)), e, t2, x, h))

def le_not_lt(x: Nat, f: Nat, n: {Nat.is_lt(f, x) == True{} : Bool} -> Empty) -> {Nat.is_le(x, f) == True{} : Bool}:
  match x f:
    case 0n f0:
      le_zero(f0)
    case 1n+p 0n:
      Empty.absurd({Nat.is_le(1n+p, 0n) == True{} : Bool}, n({==}))
    case 1n+p 1n+q:
      le_not_lt(p, q, n)

def not_lt_le(x: Nat, y: Nat, h: {Nat.is_lt(y, x) == False{} : Bool}) -> {Nat.is_le(x, y) == True{} : Bool}:
  le_not_lt(x, y, g => F.false_true(Equal.trans(Bool, False{}, Nat.is_lt(y, x), True{}, Equal.sym(Bool, Nat.is_lt(y, x), False{}, h), g)))

# its own start is the window when it is the (n + 1)-th unbuilt line: x is
# at or before it unless the line is before x, and then it would be one too many
def all_last(+l: Nat, +i: Nat, +x: Nat, c: Bool, -r: Nat, ec: {Nat.is_lt(Laws.Start(l, i), x) == c : Bool},
  h: {Nat.is_le(Laws.UnbuiltLine(False{}, c, r), 0n) == True{} : Bool}) -> {Nat.is_le(x, K.start(l, i)) == True{} : Bool}:
  match c:
    case True{}:
      Empty.absurd({Nat.is_le(x, K.start(l, i)) == True{} : Bool}, F.false_true(h))
    case False{}:
      le_kernel(l, i, x, not_lt_le(x, Laws.Start(l, i), ec))

def all_more(+rest: List<&2, K.Part>, +l: Nat, +i: Nat, +s: Nat, +e: Nat, +x: Nat, +m: Nat, c: Bool,
  ec: {Nat.is_lt(Laws.Start(l, i), x) == c : Bool}, t1: {Laws.Start(l, i) == s : Nat}, t2: Laws.Tiles(rest, Nat.add(s, Laws.Width(l)), e),
  ih: Laws.Tiles(rest, Nat.add(s, Laws.Width(l)), e) -> {Nat.is_le(Laws.UnbuiltBefore(rest, x), m) == True{} : Bool} -> {Nat.is_le(x, K.window(e, rest, m)) == True{} : Bool},
  h: {Nat.is_le(Laws.UnbuiltLine(False{}, c, Laws.UnbuiltBefore(rest, x)), 1n+m) == True{} : Bool})
  -> {Nat.is_le(x, K.window(e, rest, m)) == True{} : Bool}:
  match c:
    case True{}:
      ih(t2, h)
    case False{}:
      le_trans(x, Nat.add(s, Laws.Width(l)), K.window(e, rest, m),
        le_add(x, s, Laws.Width(l), le_at(Laws.Start(l, i), s, x, t1, not_lt_le(x, Laws.Start(l, i), ec))),
        window_ge(rest, m, Nat.add(s, Laws.Width(l)), e, t2))

# a message within the tiling with at most n unbuilt lines before it is at
# or before the window
def window_all(ps: List<&2, K.Part>, +n: Nat, +s: Nat, +e: Nat, t: Laws.Tiles(ps, s, e), +x: Nat,
  hx: {Nat.is_le(x, e) == True{} : Bool}, h: {Nat.is_le(Laws.UnbuiltBefore(ps, x), n) == True{} : Bool})
  -> {Nat.is_le(x, K.window(e, ps, n)) == True{} : Bool}:
  match ps n:
    case Nil{} n0:
      hx
    case Con{K.Part{+l, +i, sz, True{}, u}, +rest} m:
      (t1, t2) = t
      window_all(rest, m, Nat.add(s, Laws.Width(l)), e, t2, x, hx, h)
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 0n:
      (t1, t2) = t
      all_last(l, i, x, Nat.is_lt(Laws.Start(l, i), x), Laws.UnbuiltBefore(rest, x), {==}, h)
    case Con{K.Part{+l, +i, sz, False{}, u}, +rest} 1n+m:
      (t1, t2) = t
      all_more(rest, l, i, s, e, x, m, Nat.is_lt(Laws.Start(l, i), x), {==}, t1, t2, r => hu => window_all(rest, m, Nat.add(s, Laws.Width(l)), e, r, x, hx, hu), h)

# Law 5
# -----

# Tiles as a Bool, so one proof of it serves every offer (a proof that
# is a Type can be used once; an equation, any number of times)
def TB(ps: List<&2, K.Part>, +s: Nat, +e: Nat) -> Bool:
  match ps:
    case Nil{}:
      Nat.is_eq(s, e)
    case Con{p, rest}:
      K.Part{+l, i, _, _, _} = p
      Bool.and(Nat.is_eq(Laws.Start(l, i), s), TB(rest, Nat.add(s, Laws.Width(l)), e))

def eq_at(-s: Nat, -e: Nat, h: {s == e : Nat}, r: {Nat.is_eq(s, s) == True{} : Bool}) -> {Nat.is_eq(s, e) == True{} : Bool}:
  %h : {Nat.is_eq(s, _) == True{} : Bool}
  r

def eq_start(+l: Nat, +i: Nat, -s: Nat, h: {Laws.Start(l, i) == s : Nat}) -> {Nat.is_eq(Laws.Start(l, i), s) == True{} : Bool}:
  %h : {Nat.is_eq(Laws.Start(l, i), _) == True{} : Bool}
  A.eq_refl(Laws.Start(l, i))

def both(a: Bool, b: Bool, ha: {a == True{} : Bool}, hb: {b == True{} : Bool}) -> {Bool.and(a, b) == True{} : Bool}:
  %Equal.sym(Bool, a, True{}, ha) : {Bool.and(_, b) == True{} : Bool}
  %Equal.sym(Bool, b, True{}, hb) : {Bool.and(True{}, _) == True{} : Bool}
  {==}

def tb_of(ps: List<&2, K.Part>, +s: Nat, +e: Nat, t: Laws.Tiles(ps, s, e)) -> {TB(ps, s, e) == True{} : Bool}:
  match ps:
    case Nil{}:
      eq_at(s, e, t, A.eq_refl(s))
    case Con{K.Part{+l, +i, sz, b, u}, +rest}:
      (t1, t2) = t
      both(Nat.is_eq(Laws.Start(l, i), s), TB(rest, Nat.add(s, Laws.Width(l)), e), eq_start(l, i, s, t1), tb_of(rest, Nat.add(s, Laws.Width(l)), e, t2))

def tiles_of(ps: List<&2, K.Part>, +s: Nat, +e: Nat, +h: {TB(ps, s, e) == True{} : Bool}) -> Laws.Tiles(ps, s, e):
  match ps:
    case Nil{}:
      A.eq_sound(s, e, h)
    case Con{K.Part{+l, +i, sz, b, u}, +rest}:
      (A.eq_sound(Laws.Start(l, i), s, F.and_l(Nat.is_eq(Laws.Start(l, i), s), TB(rest, Nat.add(s, Laws.Width(l)), e), h)),
        tiles_of(rest, Nat.add(s, Laws.Width(l)), e, F.and_r(Nat.is_eq(Laws.Start(l, i), s), TB(rest, Nat.add(s, Laws.Width(l)), e), h)))

def allowed_of(+levels: List<&2, List<&2, Bool>>, +ps: List<&2, K.Part>, +n: Nat, +T: Nat, +tb: {TB(ps, 0n, T) == True{} : Bool}, c: K.Coord,
  a: KS.Allowed(levels, K.window(T, ps, n), c)) -> Laws.Allowed(levels, ps, n, c):
  match c:
    case K.Coord{0n, +i}:
      (pr, nb, le) = a
      (pr, nb, window_few(ps, n, 0n, T, tiles_of(ps, 0n, T, tb), i, le))
    case K.Coord{1n++m, +i}:
      (pr, nb, k1, k2) = a
      (pr, nb, k1, k2)

def all_of(+levels: List<&2, List<&2, Bool>>, +ps: List<&2, K.Part>, +n: Nat, +T: Nat, +tb: {TB(ps, 0n, T) == True{} : Bool}, cs: List<&2, K.Coord>,
  a: KS.AllAllowed(levels, K.window(T, ps, n), cs)) -> Laws.AllAllowed(levels, ps, n, cs):
  match cs:
    case Nil{}:
      Unit{}
    case Con{c, rest}:
      (ac, ar) = a
      (allowed_of(levels, ps, n, T, tb, c, ac), all_of(levels, ps, n, T, tb, rest, ar))

def Laws.offers_allowed(levels, T, ps, n):
  t => all_of(levels, ps, n, T, tb_of(ps, 0n, T, t), K.offers(levels, K.window(T, ps, n)), PR.offers_allowed_k(levels, K.window(T, ps, n)))

def le_pred(i: Nat, T: Nat, h: {Nat.is_le(1n+i, T) == True{} : Bool}) -> {Nat.is_le(i, T) == True{} : Bool}:
  match i T:
    case 0n T0:
      le_zero(T0)
    case 1n+p 0n:
      Empty.absurd({Nat.is_le(1n+p, 0n) == True{} : Bool}, F.false_true(h))
    case 1n+p 1n+q:
      le_pred(p, q, h)

# a message within the chat comes before its end
def leaf_end(+i: Nat, -T: Nat, w: {Nat.is_le(Laws.Start(0n, 1n+i), T) == True{} : Bool}) -> {Nat.is_le(1n+i, T) == True{} : Bool}:
  %F.mul_one_r(i) : {Nat.is_le(1n+_, T) == True{} : Bool}
  w

def leaf_within(+i: Nat, +T: Nat, w: {Nat.is_le(Laws.Start(0n, 1n+i), T) == True{} : Bool}) -> {Nat.is_le(i, T) == True{} : Bool}:
  le_pred(i, T, leaf_end(i, T, w))

def allowed_ks(+levels: List<&2, List<&2, Bool>>, +T: Nat, +ps: List<&2, K.Part>, +n: Nat, c: K.Coord, t: Laws.Tiles(ps, 0n, T),
  w: Laws.Within(c, T), a: Laws.Allowed(levels, ps, n, c)) -> KS.Allowed(levels, K.window(T, ps, n), c):
  match c:
    case K.Coord{0n, +i}:
      (pr, nb, le) = a
      (pr, nb, window_all(ps, n, 0n, T, t, i, leaf_within(i, T, w), le))
    case K.Coord{1n++m, +i}:
      (pr, nb, k1, k2) = a
      (pr, nb, k1, k2)

def Laws.offers_complete(levels, T, ps, n, c):
  t => w => a => PR.offers_complete_k(levels, K.window(T, ps, n), c, allowed_ks(levels, T, ps, n, c, t, w, a))
