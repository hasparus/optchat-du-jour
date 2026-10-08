# Law 2: addressing. pow2 is 2^l, so a node (l, i) starts at i * 2^l; what
# coords answers names the node id+n, because log2 only answers an l with
# pow2(l) == n and coords.at only answers when its checks hold; and every
# node within the chat gets its name back (Completeness, at the end).

import Base
import ./kernel.bend as K
import ./kspec.bend as KS
import ./lemmas_a.bend as A

def span_size_k(+l: Nat) -> {K.pow2(l) == Nat.pow(2n, l) : Nat}:
  match l:
    case 0n:
      {==}
    case 1n+p:
      %A.mul2(Nat.pow(2n, p)) : {Nat.double(K.pow2(p)) == _ : Nat}
      %span_size_k(p) : {Nat.double(K.pow2(p)) == Nat.double(_) : Nat}
      {==}

def span_start_k(+l: Nat, +i: Nat) -> {K.start(l, i) == Nat.mul(i, Nat.pow(2n, l)) : Nat}:
  %span_size_k(l) : {Nat.mul(i, K.pow2(l)) == Nat.mul(i, _) : Nat}
  {==}

# log2 answers only a level l with pow2(l) == n
def Addr.LogOk(ml: Maybe<&2, Nat>, n: Nat) -> Type:
  match ml:
    case None{}:
      Unit
    case Some{l}:
      {K.pow2(l) == n : Nat}

# what a search state promises: a found l is the one
def Addr.StOk(st: K.Search, n: Nat) -> Type:
  match st:
    case K.Below{_}:
      Unit
    case K.Found{l}:
      {K.pow2(l) == n : Nat}
    case K.Past{}:
      Unit

def Addr.is_eq_of_cmp(+a: Nat, +b: Nat, e: {Nat.cmp(a, b) == EQ{} : Cmp}) -> {Nat.is_eq(a, b) == True{} : Bool}:
  %Equal.sym(Cmp, Nat.cmp(a, b), EQ{}, e) : {Cmp.is_eq(_) == True{} : Bool}
  {==}

def Addr.step_ok(c: Cmp, +l: Nat, +n: Nat, e: {Nat.cmp(K.pow2(l), n) == c : Cmp})
  -> Addr.StOk(K.log2.step(c, l), n):
  match c:
    case LT{}:
      Unit{}
    case EQ{}:
      A.eq_sound(K.pow2(l), n, Addr.is_eq_of_cmp(K.pow2(l), n, e))
    case GT{}:
      Unit{}

def Addr.done_ok(st: K.Search, -n: Nat, h: Addr.StOk(st, n)) -> Addr.LogOk(K.log2.done(st), n):
  match st:
    case K.Below{_}:
      Unit{}
    case K.Found{l}:
      h
    case K.Past{}:
      Unit{}

def Addr.log2_ok(fuel: Nat, st: K.Search, +n: Nat, h: Addr.StOk(st, n)) -> Addr.LogOk(K.log2(fuel, st, n), n):
  match fuel st:
    case 0n s:
      Addr.done_ok(s, n, h)
    case 1n+f K.Below{+l}:
      Addr.log2_ok(f, K.log2.step(Nat.cmp(K.pow2(l), n), l), n, Addr.step_ok(Nat.cmp(K.pow2(l), n), l, n, {==}))
    case 1n+f K.Found{l}:
      h
    case 1n+f K.Past{}:
      Unit{}

def Addr.check_yes(+l: Nat, +i: Nat, +id: Nat, -n: Nat, -T: Nat,
  w: {Nat.is_eq(K.start(l, i), id) == True{} : Bool} & {Nat.is_le(Nat.add(id, n), T) == True{} : Bool},
  pl: {K.pow2(l) == n : Nat})
  -> KS.Names(Some{K.Coord{l, i}}, id, n, T):
  (s, le) = w
  (A.eq_sound(K.start(l, i), id, s), pl, le)

def Addr.check_ok(ok: Bool, +l: Nat, +i: Nat, +id: Nat, -n: Nat, -T: Nat,
  e: {Bool.and(Nat.is_eq(K.start(l, i), id), Nat.is_le(Nat.add(id, n), T)) == ok : Bool},
  pl: {K.pow2(l) == n : Nat})
  -> KS.Names(K.coords.check(ok, l, i), id, n, T):
  match ok:
    case False{}:
      Unit{}
    case True{}:
      Addr.check_yes(l, i, id, n, T, A.and_true(Nat.is_eq(K.start(l, i), id), Nat.is_le(Nat.add(id, n), T), e), pl)

def Addr.at_ok(+id: Nat, +n: Nat, +T: Nat, ml: Maybe<&2, Nat>, h: Addr.LogOk(ml, n))
  -> KS.Names(K.coords.at(id, n, T, ml), id, n, T):
  match ml:
    case None{}:
      Unit{}
    case Some{+l}:
      +i = Nat.div(id, n)
      Addr.check_ok(Bool.and(Nat.is_eq(K.start(l, i), id), Nat.is_le(Nat.add(id, n), T)), l, i, id, n, T, {==}, h)

def coords_names_k(+id: Nat, +n: Nat, +T: Nat) -> KS.Names(K.coords(id, n, T), id, n, T):
  Addr.at_ok(id, n, T, K.log2(1n+n, K.Below{0n}, n), Addr.log2_ok(1n+n, K.Below{0n}, n, Unit{}))

# Completeness: every node within the chat has its name
# -----------------------------------------------------
# For a node (l, i) that ends within the chat, coords(start(l, i), pow2(l),
# T) answers (l, i): log2's search walks up from 0 and meets l within its
# 1 + pow2(l) steps, since every power below pow2(l) is smaller and
# pow2(l) > l; and start(l, i) / pow2(l) is i.

# what pow2(l) has to spare over l + 1
def Addr.Excess(+l: Nat) -> Nat:
  match l:
    case 0n:
      0n
    case 1n+p:
      Nat.add(p, Nat.double(Addr.Excess(p)))

def Addr.dbl(+p: Nat, -h: Nat) -> {Nat.double(Nat.add(p, 1n+h)) == 1n+Nat.add(p, 1n+Nat.add(p, Nat.double(h))) : Nat}:
  match p:
    case 0n:
      {==}
    case 1n+q:
      %A.add_succ(q, 1n+Nat.add(q, Nat.double(h))) : {2n+Nat.double(Nat.add(q, 1n+h)) == 2n+_ : Nat}
      %Addr.dbl(q, h) : {2n+Nat.double(Nat.add(q, 1n+h)) == 2n+_ : Nat}
      {==}

# 2^l > l
def Addr.pow_big(+l: Nat) -> {K.pow2(l) == Nat.add(l, 1n+Addr.Excess(l)) : Nat}:
  match l:
    case 0n:
      {==}
    case 1n+p:
      %Addr.dbl(p, Addr.Excess(p)) : {Nat.double(K.pow2(p)) == _ : Nat}
      %Addr.pow_big(p) : {Nat.double(K.pow2(p)) == Nat.double(_) : Nat}
      {==}

# 2^l > 0
def Addr.pow_pos(+l: Nat) -> {K.pow2(l) == 1n+Nat.add(l, Addr.Excess(l)) : Nat}:
  Equal.trans(Nat, K.pow2(l), Nat.add(l, 1n+Addr.Excess(l)), 1n+Nat.add(l, Addr.Excess(l)),
    Addr.pow_big(l), Equal.sym(Nat, 1n+Nat.add(l, Addr.Excess(l)), Nat.add(l, 1n+Addr.Excess(l)), A.add_succ(l, Addr.Excess(l))))

def Addr.cmp_refl(x: Nat) -> {Nat.cmp(x, x) == EQ{} : Cmp}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      Addr.cmp_refl(p)

def Addr.cmp_double(a: Nat, b: Nat) -> {Nat.cmp(Nat.double(a), Nat.double(b)) == Nat.cmp(a, b) : Cmp}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      {==}
    case 1n+p 0n:
      {==}
    case 1n+p 1n+q:
      Addr.cmp_double(p, q)

# 2^k < 2^(k + 1 + d)
def Addr.lt_pow(+k: Nat, +d: Nat) -> {Nat.cmp(K.pow2(k), K.pow2(Nat.add(k, 1n+d))) == LT{} : Cmp}:
  match k:
    case 0n:
      %Equal.sym(Nat, K.pow2(d), 1n+Nat.add(d, Addr.Excess(d)), Addr.pow_pos(d)) : {Nat.cmp(1n, Nat.double(_)) == LT{} : Cmp}
      {==}
    case 1n+j:
      Equal.trans(Cmp, Nat.cmp(Nat.double(K.pow2(j)), Nat.double(K.pow2(Nat.add(j, 1n+d)))), Nat.cmp(K.pow2(j), K.pow2(Nat.add(j, 1n+d))), LT{},
        Addr.cmp_double(K.pow2(j), K.pow2(Nat.add(j, 1n+d))), Addr.lt_pow(j, d))

def Addr.below(+k: Nat, +d: Nat, -l: Nat, e: {Nat.add(k, 1n+d) == l : Nat}) -> {Nat.cmp(K.pow2(k), K.pow2(l)) == LT{} : Cmp}:
  %e : {Nat.cmp(K.pow2(k), K.pow2(_)) == LT{} : Cmp}
  Addr.lt_pow(k, d)

# a search that has found l answers l, whatever fuel is left
def Addr.found(g: Nat, -l: Nat, -n: Nat) -> {K.log2(g, K.Found{l}, n) == Some{l} : Maybe<&2, Nat>}:
  match g:
    case 0n:
      {==}
    case 1n+f:
      {==}

# looking at k, d levels below l, with d + 1 + g steps of fuel: log2 finds l
def Addr.search(+d: Nat, +k: Nat, -l: Nat, +g: Nat, +e: {Nat.add(k, d) == l : Nat})
  -> {K.log2(Nat.add(d, 1n+g), K.Below{k}, K.pow2(l)) == Some{l} : Maybe<&2, Nat>}:
  match d:
    case 0n:
      %Equal.trans(Nat, k, Nat.add(k, 0n), l, A.add_zero(k), e) : {K.log2(1n+g, K.Below{k}, K.pow2(_)) == Some{_} : Maybe<&2, Nat>}
      %Equal.sym(Cmp, Nat.cmp(K.pow2(k), K.pow2(k)), EQ{}, Addr.cmp_refl(K.pow2(k))) : {K.log2(g, K.log2.step(_, k), K.pow2(k)) == Some{k} : Maybe<&2, Nat>}
      Addr.found(g, k, K.pow2(k))
    case 1n+d2:
      %Equal.sym(Cmp, Nat.cmp(K.pow2(k), K.pow2(l)), LT{}, Addr.below(k, d2, l, e)) : {K.log2(Nat.add(d2, 1n+g), K.log2.step(_, k), K.pow2(l)) == Some{l} : Maybe<&2, Nat>}
      Addr.search(d2, 1n+k, l, g, Equal.trans(Nat, 1n+Nat.add(k, d2), Nat.add(k, 1n+d2), l, A.add_succ(k, d2), e))

# coords' search for pow2(l) answers l
def Addr.log2_finds(+l: Nat) -> {K.log2(1n+K.pow2(l), K.Below{0n}, K.pow2(l)) == Some{l} : Maybe<&2, Nat>}:
  %Equal.sym(Nat, K.pow2(l), Nat.add(l, 1n+Addr.Excess(l)), Addr.pow_big(l)) : {K.log2(1n+_, K.Below{0n}, K.pow2(l)) == Some{l} : Maybe<&2, Nat>}
  %Equal.sym(Nat, 1n+Nat.add(l, 1n+Addr.Excess(l)), Nat.add(l, 2n+Addr.Excess(l)), A.add_succ(l, 1n+Addr.Excess(l))) : {K.log2(_, K.Below{0n}, K.pow2(l)) == Some{l} : Maybe<&2, Nat>}
  Addr.search(l, 0n, l, 1n+Addr.Excess(l), {==})

# m + 1 more steps of divmod's countdown from m: the quotient one more, the
# countdown restarted
def Addr.chunk(+m: Nat, -n: Nat, -d: Nat, +r: Nat)
  -> {Nat.divmod.go(Nat.add(m, 1n+n), m, d, r) == Nat.divmod.go(n, Nat.add(m, r), 1n+d, 0n) : Nat & Nat}:
  match m:
    case 0n:
      {==}
    case 1n+p:
      %Equal.sym(Nat, 1n+Nat.add(p, r), Nat.add(p, 1n+r), A.add_succ(p, r)) : {Nat.divmod.go(Nat.add(p, 1n+n), p, d, 1n+r) == Nat.divmod.go(n, _, 1n+d, 0n) : Nat & Nat}
      Addr.chunk(p, n, d, 1n+r)

# i blocks of b + 1: the quotient grows by i, nothing left over
def Addr.blocks(+i: Nat, +b: Nat, -d: Nat) -> {Nat.divmod.go(Nat.mul(i, 1n+b), b, d, 0n) == (Nat.add(i, d), 0n) : Nat & Nat}:
  match i:
    case 0n:
      {==}
    case 1n+j:
      %Equal.sym(Nat, 1n+Nat.add(b, Nat.mul(j, 1n+b)), Nat.add(b, 1n+Nat.mul(j, 1n+b)), A.add_succ(b, Nat.mul(j, 1n+b)))
        : {Nat.divmod.go(_, b, d, 0n) == (1n+Nat.add(j, d), 0n) : Nat & Nat}
      %Equal.sym(Nat & Nat, Nat.divmod.go(Nat.add(b, 1n+Nat.mul(j, 1n+b)), b, d, 0n), Nat.divmod.go(Nat.mul(j, 1n+b), Nat.add(b, 0n), 1n+d, 0n), Addr.chunk(b, Nat.mul(j, 1n+b), d, 0n))
        : {_ == (1n+Nat.add(j, d), 0n) : Nat & Nat}
      %A.add_zero(b) : {Nat.divmod.go(Nat.mul(j, 1n+b), _, 1n+d, 0n) == (1n+Nat.add(j, d), 0n) : Nat & Nat}
      %Equal.sym(Nat, 1n+Nat.add(j, d), Nat.add(j, 1n+d), A.add_succ(j, d)) : {Nat.divmod.go(Nat.mul(j, 1n+b), b, 1n+d, 0n) == (_, 0n) : Nat & Nat}
      Addr.blocks(j, b, 1n+d)

# start(l, i) / pow2(l) is i
def Addr.div_start(+l: Nat, +i: Nat) -> {Nat.div(K.start(l, i), K.pow2(l)) == i : Nat}:
  %Equal.sym(Nat, K.pow2(l), 1n+Nat.add(l, Addr.Excess(l)), Addr.pow_pos(l)) : {Nat.div(Nat.mul(i, _), _) == i : Nat}
  %Equal.sym(Nat & Nat, Nat.divmod.go(Nat.mul(i, 1n+Nat.add(l, Addr.Excess(l))), Nat.add(l, Addr.Excess(l)), 0n, 0n), (Nat.add(i, 0n), 0n), Addr.blocks(i, Nat.add(l, Addr.Excess(l)), 0n))
    : {Pair.fst(Nat, Nat, _) == i : Nat}
  Equal.sym(Nat, i, Nat.add(i, 0n), A.add_zero(i))

def coords_complete_k(+l: Nat, +i: Nat, +T: Nat, h: {Nat.is_le(Nat.add(K.start(l, i), K.pow2(l)), T) == True{} : Bool})
  -> {K.coords(K.start(l, i), K.pow2(l), T) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}:
  %Equal.sym(Maybe<&2, Nat>, K.log2(1n+K.pow2(l), K.Below{0n}, K.pow2(l)), Some{l}, Addr.log2_finds(l))
    : {K.coords.at(K.start(l, i), K.pow2(l), T, _) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
  %Equal.sym(Nat, Nat.div(K.start(l, i), K.pow2(l)), i, Addr.div_start(l, i))
    : {K.coords.check(Bool.and(Nat.is_eq(K.start(l, _), K.start(l, i)), Nat.is_le(Nat.add(K.start(l, i), K.pow2(l)), T)), l, _) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
  %Equal.sym(Bool, Nat.is_eq(K.start(l, i), K.start(l, i)), True{}, A.eq_refl(K.start(l, i)))
    : {K.coords.check(Bool.and(_, Nat.is_le(Nat.add(K.start(l, i), K.pow2(l)), T)), l, i) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
  %Equal.sym(Bool, Nat.is_le(Nat.add(K.start(l, i), K.pow2(l)), T), True{}, h)
    : {K.coords.check(Bool.and(True{}, _), l, i) == Some{K.Coord{l, i}} : Maybe<&2, K.Coord>}
  {==}
