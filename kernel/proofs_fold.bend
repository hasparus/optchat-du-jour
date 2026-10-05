# Proofs of laws 1, 3 and 4 (tiles_refold, tiles_append, tiles_fit,
# fit_merges, fit_fits). Lemmas on Nat, Bool and lists are in
# lemmas_fold.bend.
#
# Plan: step either stops on a view that fits, or merges a pair PairAt
# allows (step_ok); fit.go iterates it, so the merges compose (law 3),
# and each merge shortens the view by one, so the fuel suffices (law 4).
# A merge keeps the tiling (tiles_merge), so fit does too (law 1).

import Base
import ./kernel.bend as K
import ./LAWS.bend as Laws
import ./lemmas_fold.bend as F

# Tiling through one merge
# ------------------------

# the parent (l + 1, j) of (l, 2j) starts where it does
def head_start(+l: Nat, +i: Nat, +j: Nat, -s: Nat, ed: {Nat.double(j) == i : Nat}, t1: {K.start(l, i) == s : Nat})
  -> {K.start(1n+l, j) == s : Nat}:
  %Equal.sym(Nat, K.start(1n+l, j), K.start(l, Nat.double(j)), F.start_parent(l, j)) : {_ == s : Nat}
  %Equal.sym(Nat, Nat.double(j), i, ed) : {K.start(l, _) == s : Nat}
  t1

# and the lines after the pair start where the parent ends
def head_rest(+la: Nat, +lb: Nat, more: List<&2, K.Part>, +s: Nat, -e: Nat, el: {la == lb : Nat},
  t4: Laws.Tiles(more, Nat.add(Nat.add(s, K.pow2(la)), K.pow2(lb)), e))
  -> Laws.Tiles(more, Nat.add(s, K.pow2(1n+la)), e):
  %F.add_twice(s, K.pow2(la)) : Laws.Tiles(more, _, e)
  %Equal.sym(Nat, la, lb, el) : Laws.Tiles(more, Nat.add(Nat.add(s, K.pow2(la)), K.pow2(_)), e)
  t4

# the pair (la, ia), (lb, ib) merges into (la + 1, ia / 2), which starts
# where (la, ia) does and ends where (lb, ib) does
def tiles_head(+la: Nat, +ia: Nat, sa: Nat, ba: Bool, ua: List<&2, Nat>,
  +lb: Nat, +ib: Nat, sb: Nat, bb: Bool, ub: List<&2, Nat>, more: List<&2, K.Part>, +s: Nat, -e: Nat,
  +h: {K.mergeable(K.Part{la, ia, sa, ba, ua}, K.Part{lb, ib, sb, bb, ub}) == True{} : Bool},
  t: Laws.Tiles(K.Part{la, ia, sa, ba, ua} <> K.Part{lb, ib, sb, bb, ub} <> more, s, e))
  -> Laws.Tiles(K.merge_head(K.Part{la, ia, sa, ba, ua}, K.Part{lb, ib, sb, bb, ub} <> more), s, e):
  match ua:
    case Nil{}:
      Empty.absurd(Laws.Tiles(K.merge_head(K.Part{la, ia, sa, ba, Nil{}}, K.Part{lb, ib, sb, bb, ub} <> more), s, e),
        F.false_true(F.and_r(Bool.and(Bool.and(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia)), Nat.is_eq(1n+ia, ib)), False{}, h)))
    case Con{u, us}:
      (t1, t2) = t
      (t3, t4) = t2
      hl = F.and4_a(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia), Nat.is_eq(1n+ia, ib), True{}, h)
      hd = F.and4_b(Nat.is_eq(la, lb), Nat.is_eq(Nat.double(Nat.div(ia, 2n)), ia), Nat.is_eq(1n+ia, ib), True{}, h)
      (head_start(la, ia, Nat.div(ia, 2n), s, F.eq_sound(Nat.double(Nat.div(ia, 2n)), ia, hd), t1),
        head_rest(la, lb, more, s, e, F.eq_sound(la, lb, hl), t4))

# merging a pair PairAt allows keeps the tiling
def tiles_merge(ps: List<&2, K.Part>, k: Nat, +s: Nat, -e: Nat, +h: {Laws.PairAt(ps, k) == True{} : Bool},
  t: Laws.Tiles(ps, s, e)) -> Laws.Tiles(K.merge_at(ps, k), s, e):
  match ps k:
    case Nil{} _:
      t
    case Con{a, Nil{}} 0n:
      Empty.absurd(Laws.Tiles(K.merge_at([a], 0n), s, e), F.false_true(h))
    case Con{K.Part{+la, +ia, sa, ba, ua}, Con{K.Part{+lb, +ib, sb, bb, ub}, more}} 0n:
      tiles_head(la, ia, sa, ba, ua, lb, ib, sb, bb, ub, more, s, e, h, t)
    case Con{K.Part{+l, i, sz, bt, u}, rest} 1n+j:
      (t1, t2) = t
      (t1, tiles_merge(rest, j, Nat.add(s, K.pow2(l)), e, h, t2))

# so do any number of them
def tiles_merges(n: Nat, +ps: List<&2, K.Part>, -qs: List<&2, K.Part>, m: Laws.Merges(n, ps, qs), +s: Nat, -e: Nat,
  t: Laws.Tiles(ps, s, e)) -> Laws.Tiles(qs, s, e):
  match n:
    case 0n:
      %Equal.sym(List<&2, K.Part>, qs, ps, m) : Laws.Tiles(_, s, e)
      t
    case 1n+n2:
      (+k, hm) = m
      (h, m2) = hm
      tiles_merges(n2, K.merge_at(ps, k), qs, m2, s, e, tiles_merge(ps, k, s, e, h, t))

# What best finds
# ---------------
# Good(ps, x): the pair x names, if any, is one PairAt allows.
# Gd(ps, x): moreover, when x is None, PairAt allows no pair.

def is_some(x: Maybe<&2, K.Best>) -> Bool:
  match x:
    case None{}:
      False{}
    case Some{_}:
      True{}

def Good(ps: List<&2, K.Part>, x: Maybe<&2, K.Best>) -> Type:
  match x:
    case None{}:
      Unit
    case Some{b}:
      K.Best{k, _, _} = b
      {Laws.PairAt(ps, k) == True{} : Bool}

def Gd(ps: List<&2, K.Part>, x: Maybe<&2, K.Best>) -> Type:
  match x:
    case None{}:
      @k: Nat -> {Laws.PairAt(ps, k) == False{} : Bool}
    case Some{b}:
      Good(ps, Some{b})

def vs_good(-ps: List<&2, K.Part>, win: Bool, -cand: K.Best, -cur: K.Best,
  gc: Good(ps, Some{cand}), gu: Good(ps, Some{cur})) -> Good(ps, K.choose.vs(win, cand, cur)):
  match win:
    case True{}:
      gc
    case False{}:
      gu

def choose_good(+T: Nat, ok: Bool, +cand: K.Best, acc: Maybe<&2, K.Best>, -ps: List<&2, K.Part>,
  hc: {ok == True{} : Bool} -> Good(ps, Some{cand}), g: Good(ps, acc)) -> Good(ps, K.choose(T, ok, cand, acc)):
  match ok:
    case False{}:
      g
    case True{}:
      match acc:
        case None{}:
          hc({==})
        case Some{+cur}:
          vs_good(ps, K.more_due(T, cand, cur), cand, cur, hc({==}), g)

def pick_good(+T: Nat, +a: K.Part, +b: K.Part, +k: Nat, acc: Maybe<&2, K.Best>, -ps: List<&2, K.Part>,
  hp: {Laws.PairAt(ps, k) == K.mergeable(a, b) : Bool}, g: Good(ps, acc)) -> Good(ps, K.pick(T, a, b, k, acc)):
  match a:
    case K.Part{l, i, sz, bt, u}:
      choose_good(T, K.mergeable(K.Part{l, i, sz, bt, u}, b), K.Best{k, K.start(l, i), l}, acc, ps,
        hm => Equal.trans(Bool, Laws.PairAt(ps, k), K.mergeable(K.Part{l, i, sz, bt, u}, b), True{}, hp, hm), g)

# best.go from index k of ps0 keeps Good
def best_good(ps: List<&2, K.Part>, +T: Nat, +k: Nat, +acc: Maybe<&2, K.Best>, +ps0: List<&2, K.Part>,
  +e: {F.Drop(k, ps0) == ps : List<&2, K.Part>}, g: Good(ps0, acc)) -> Good(ps0, K.best.go(ps, T, k, acc)):
  match ps:
    case Nil{}:
      g
    case Con{a, Nil{}}:
      g
    case Con{+a, Con{+b, +more}}:
      best_good(b <> more, T, 1n+k, K.pick(T, a, b, k, acc), ps0, F.drop_tail(ps0, k, a, b <> more, e),
        pick_good(T, a, b, k, acc, ps0, F.drop_pair(ps0, k, a, b, more, e), g))

def vs_some(win: Bool, -cand: K.Best, -cur: K.Best) -> {is_some(K.choose.vs(win, cand, cur)) == True{} : Bool}:
  match win:
    case True{}:
      {==}
    case False{}:
      {==}

# choose answers Some once acc is Some, or when the candidate is ok
def choose_keep(+T: Nat, ok: Bool, +cand: K.Best, acc: Maybe<&2, K.Best>, h: {is_some(acc) == True{} : Bool})
  -> {is_some(K.choose(T, ok, cand, acc)) == True{} : Bool}:
  match ok:
    case False{}:
      h
    case True{}:
      match acc:
        case None{}:
          {==}
        case Some{+cur}:
          vs_some(K.more_due(T, cand, cur), cand, cur)

def choose_some(+T: Nat, ok: Bool, +cand: K.Best, acc: Maybe<&2, K.Best>, h: {ok == True{} : Bool})
  -> {is_some(K.choose(T, ok, cand, acc)) == True{} : Bool}:
  match ok:
    case False{}:
      Empty.absurd({is_some(acc) == True{} : Bool}, F.false_true(h))
    case True{}:
      match acc:
        case None{}:
          {==}
        case Some{+cur}:
          vs_some(K.more_due(T, cand, cur), cand, cur)

def pick_keep(+T: Nat, +a: K.Part, +b: K.Part, +k: Nat, acc: Maybe<&2, K.Best>, h: {is_some(acc) == True{} : Bool})
  -> {is_some(K.pick(T, a, b, k, acc)) == True{} : Bool}:
  match a:
    case K.Part{l, i, sz, bt, u}:
      choose_keep(T, K.mergeable(K.Part{l, i, sz, bt, u}, b), K.Best{k, K.start(l, i), l}, acc, h)

def pick_some(+T: Nat, +a: K.Part, +b: K.Part, +k: Nat, acc: Maybe<&2, K.Best>, h: {K.mergeable(a, b) == True{} : Bool})
  -> {is_some(K.pick(T, a, b, k, acc)) == True{} : Bool}:
  match a:
    case K.Part{l, i, sz, bt, u}:
      choose_some(T, K.mergeable(K.Part{l, i, sz, bt, u}, b), K.Best{k, K.start(l, i), l}, acc, h)

def best_keep(ps: List<&2, K.Part>, +T: Nat, +k: Nat, +acc: Maybe<&2, K.Best>, h: {is_some(acc) == True{} : Bool})
  -> {is_some(K.best.go(ps, T, k, acc)) == True{} : Bool}:
  match ps:
    case Nil{}:
      h
    case Con{a, Nil{}}:
      h
    case Con{+a, Con{+b, +more}}:
      best_keep(b <> more, T, 1n+k, K.pick(T, a, b, k, acc), pick_keep(T, a, b, k, acc, h))

# a pair PairAt allows makes best.go answer Some
def best_some(ps: List<&2, K.Part>, j: Nat, +T: Nat, +k: Nat, +acc: Maybe<&2, K.Best>, h: {Laws.PairAt(ps, j) == True{} : Bool})
  -> {is_some(K.best.go(ps, T, k, acc)) == True{} : Bool}:
  match ps j:
    case Nil{} _:
      Empty.absurd({is_some(acc) == True{} : Bool}, F.false_true(h))
    case Con{a, Nil{}} 0n:
      Empty.absurd({is_some(acc) == True{} : Bool}, F.false_true(h))
    case Con{a, Nil{}} 1n+j2:
      Empty.absurd({is_some(acc) == True{} : Bool}, F.false_true(h))
    case Con{+a, Con{+b, +more}} 0n:
      best_keep(b <> more, T, 1n+k, K.pick(T, a, b, k, acc), pick_some(T, a, b, k, acc, h))
    case Con{+a, Con{+b, +more}} 1n+j2:
      best_some(b <> more, j2, T, 1n+k, K.pick(T, a, b, k, acc), h)

def gd_of(+ps: List<&2, K.Part>, x: Maybe<&2, K.Best>, g: Good(ps, x),
  s: @j: Nat -> {Laws.PairAt(ps, j) == True{} : Bool} -> {is_some(x) == True{} : Bool}) -> Gd(ps, x):
  match x:
    case None{}:
      +j => F.not_true(Laws.PairAt(ps, j), hj => F.false_true(s(j, hj)))
    case Some{b}:
      g

# best(T, ps) names a pair PairAt allows, or there is none
def best_gd(+T: Nat, +ps: List<&2, K.Part>) -> Gd(ps, K.best(T, ps)):
  gd_of(ps, K.best(T, ps), best_good(ps, T, 0n, None{}, ps, {==}, Unit{}),
    j => hj => best_some(ps, j, T, 0n, None{}, hj))

# One step of fit
# ---------------
# step stops on the view it was given, which then fits; or it merges a
# pair PairAt allows.

def StepOk(budget: Nat, q: List<&2, K.Part>, st: K.Step) -> Type:
  match st:
    case K.More{q2}:
      &k: Nat -> ({Laws.PairAt(q, k) == True{} : Bool} & {q2 == K.merge_at(q, k) : List<&2, K.Part>})
    case K.Stop{q2}:
      ({q2 == q : List<&2, K.Part>} & Laws.Fits(budget, q2))

def so_merge(-budget: Nat, +q: List<&2, K.Part>, x: Maybe<&2, K.Best>, g: Gd(q, x))
  -> StepOk(budget, q, K.step.merge(q, x)):
  match x:
    case None{}:
      ({==}, Inr{g})
    case Some{K.Best{+k, s, l}}:
      (k, (g, {==}))

def so_over(+T: Nat, +budget: Nat, +q: List<&2, K.Part>, ov: Bool, he: {Nat.is_gt(K.size(q), budget) == ov : Bool},
  g: Gd(q, K.best(T, q))) -> StepOk(budget, q, K.step.over(ov, T, q)):
  match ov:
    case False{}:
      ({==}, Inl{he})
    case True{}:
      so_merge(budget, q, K.best(T, q), g)

def step_ok(+T: Nat, +budget: Nat, +q: List<&2, K.Part>) -> StepOk(budget, q, K.step(T, budget, q)):
  so_over(T, budget, q, Nat.is_gt(K.size(q), budget), {==}, best_gd(T, q))

# Law 3: fit's merges compose
# ---------------------------

def rw_merges(-n: Nat, -q2: List<&2, K.Part>, -mq: List<&2, K.Part>, -r: List<&2, K.Part>,
  eq: {q2 == mq : List<&2, K.Part>}, mm: Laws.Merges(n, q2, r)) -> Laws.Merges(n, mq, r):
  %eq : Laws.Merges(n, _, r)
  mm

def merges_cons(-q: List<&2, K.Part>, -q2: List<&2, K.Part>, k: Nat, h: {Laws.PairAt(q, k) == True{} : Bool},
  eq: {q2 == K.merge_at(q, k) : List<&2, K.Part>}, -r: List<&2, K.Part>,
  w: &n: Nat -> Laws.Merges(n, q2, r)) -> &n: Nat -> Laws.Merges(n, q, r):
  (n, mm) = w
  (1n+n, (k, (h, rw_merges(n, q2, K.merge_at(q, k), r, eq, mm))))

def fit_merges_go(m: Nat, st: K.Step, +T: Nat, +budget: Nat, -q: List<&2, K.Part>, so: StepOk(budget, q, st))
  -> &n: Nat -> Laws.Merges(n, q, K.fit.go(m, st, T, budget)):
  match m st:
    case 0n K.More{q2}:
      (k, p) = so
      (h, eq) = p
      (1n, (k, (h, eq)))
    case 0n K.Stop{q2}:
      (eq, fi) = so
      (0n, eq)
    case 1n+f K.Stop{q2}:
      (eq, fi) = so
      (0n, eq)
    case 1n+f K.More{+q2}:
      (k, p) = so
      (h, eq) = p
      merges_cons(q, q2, k, h, eq, K.fit.go(f, K.step(T, budget, q2), T, budget),
        fit_merges_go(f, K.step(T, budget, q2), T, budget, q2, step_ok(T, budget, q2)))

def Laws.fit_merges(T, budget, ps):
  fit_merges_go(K.length(ps, 0n), K.step(T, budget, ps), T, budget, ps, step_ok(T, budget, ps))

# Law 4: the fuel suffices
# ------------------------
# fit.go(m, More{q}) has m == 1 + Len(q): each merge shortens q by one
# and spends one unit, so fuel never runs out while a merge is pending.

def InvF(budget: Nat, m: Nat, st: K.Step) -> Type:
  match st:
    case K.More{q2}:
      {1n+Laws.Len(K.Part, q2) == m : Nat}
    case K.Stop{q2}:
      Laws.Fits(budget, q2)

def inv_step(-budget: Nat, +q: List<&2, K.Part>, -f: Nat, st: K.Step, so: StepOk(budget, q, st),
  hl: {Laws.Len(K.Part, q) == f : Nat}) -> InvF(budget, f, st):
  match st:
    case K.More{q2}:
      (+k, p) = so
      (h, eq) = p
      %Equal.sym(List<&2, K.Part>, q2, K.merge_at(q, k), eq) : {1n+Laws.Len(K.Part, _) == f : Nat}
      %hl : {1n+Laws.Len(K.Part, K.merge_at(q, k)) == _ : Nat}
      F.len_merge(q, k, h)
    case K.Stop{q2}:
      (eq, fi) = so
      fi

def fit_fits_go(m: Nat, st: K.Step, +T: Nat, +budget: Nat, inv: InvF(budget, m, st))
  -> Laws.Fits(budget, K.fit.go(m, st, T, budget)):
  match m st:
    case 0n K.More{q2}:
      Empty.absurd(Laws.Fits(budget, q2), F.succ_zero(Laws.Len(K.Part, q2), inv))
    case 0n K.Stop{q2}:
      inv
    case 1n+f K.Stop{q2}:
      inv
    case 1n+f K.More{+q2}:
      fit_fits_go(f, K.step(T, budget, q2), T, budget,
        inv_step(budget, q2, f, K.step(T, budget, q2), step_ok(T, budget, q2), F.succ_inj(Laws.Len(K.Part, q2), f, inv)))

def len_length(+ps: List<&2, K.Part>) -> {Laws.Len(K.Part, ps) == K.length(ps, 0n) : Nat}:
  %F.length_len(ps, 0n) : {Laws.Len(K.Part, ps) == _ : Nat}
  Equal.sym(Nat, Nat.add(Laws.Len(K.Part, ps), 0n), Laws.Len(K.Part, ps), F.add_zero_r(Laws.Len(K.Part, ps)))

def Laws.fit_fits(T, budget, ps):
  fit_fits_go(K.length(ps, 0n), K.step(T, budget, ps), T, budget,
    inv_step(budget, ps, K.length(ps, 0n), K.step(T, budget, ps), step_ok(T, budget, ps), len_length(ps)))

# Law 1: the view tiles [0, T)
# ----------------------------

def tiles_from(+ps: List<&2, K.Part>, -qs: List<&2, K.Part>, -T: Nat, w: &n: Nat -> Laws.Merges(n, ps, qs),
  t: Laws.Tiles(ps, 0n, T)) -> Laws.Tiles(qs, 0n, T):
  (n, m) = w
  tiles_merges(n, ps, qs, m, 0n, T, t)

def Laws.tiles_fit(T, budget, ps):
  t => tiles_from(ps, K.fit(T, budget, ps), T, Laws.fit_merges(T, budget, ps), t)

# a line (0, e) after a view tiling [s0, e) tiles [s0, e + 1)
def tiles_snoc(ps: List<&2, K.Part>, +s0: Nat, -e: Nat, sz: Nat, b: Bool, ups: List<&2, Nat>,
  t: Laws.Tiles(ps, s0, e)) -> Laws.Tiles(K.snoc(ps, K.Part{0n, e, sz, b, ups}), s0, 1n+e):
  match ps:
    case Nil{}:
      %t : ({K.start(0n, _) == s0 : Nat} & {Nat.add(s0, K.pow2(0n)) == 1n+_ : Nat})
      (F.mul_one_r(s0), F.add_one_r(s0))
    case Con{K.Part{+l, i, sz2, b2, u2}, rest}:
      (t1, t2) = t
      (t1, tiles_snoc(rest, Nat.add(s0, K.pow2(l)), e, sz, b, ups, t2))

def Laws.tiles_append(T, budget, ps, m):
  match m:
    case K.Msg{s, b, ups}:
      t => Laws.tiles_fit(1n+T, budget, K.snoc(ps, K.Part{0n, T, s, b, ups}))(tiles_snoc(ps, 0n, T, s, b, ups, t))

def refold_go(ms: List<&2, K.Msg>, +budget: Nat, +T: Nat, +ps: List<&2, K.Part>, t: Laws.Tiles(ps, 0n, T))
  -> Laws.Tiles(K.refold.go(ms, budget, T, ps), 0n, Nat.add(Laws.Len(K.Msg, ms), T)):
  match ms:
    case Nil{}:
      t
    case Con{+m, +rest}:
      %Equal.sym(Nat, 1n+Nat.add(Laws.Len(K.Msg, rest), T), Nat.add(Laws.Len(K.Msg, rest), 1n+T), F.add_succ_r(Laws.Len(K.Msg, rest), T)) : Laws.Tiles(K.refold.go(rest, budget, 1n+T, K.append(T, budget, ps, m)), 0n, _)
      refold_go(rest, budget, 1n+T, K.append(T, budget, ps, m), Laws.tiles_append(T, budget, ps, m)(t))

def Laws.tiles_refold(budget, ms):
  %F.add_zero_r(Laws.Len(K.Msg, ms)) : Laws.Tiles(K.refold(budget, ms), 0n, _)
  refold_go(ms, budget, 0n, Nil{}, {==})
