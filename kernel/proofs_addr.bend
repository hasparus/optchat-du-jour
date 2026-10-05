# Law 2: addressing. pow2 is 2^l, so a node (l, i) starts at i * 2^l; and
# what coords answers names the node id+n, because log2 only answers an l
# with pow2(l) == n and coords.at only answers when its checks hold.

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
