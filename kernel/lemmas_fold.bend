# Lemmas for the fold proofs (proofs_fold.bend): Bool and Nat algebra,
# soundness of the kernel's boolean checks, and list facts. Imported as F.

import Base
import ./kernel.bend as K
import ./LAWS.bend as Laws

# Refutations
# -----------

def BoolD(b: Bool) -> Type:
  match b:
    case True{}:
      Empty
    case False{}:
      Unit

# False is not True
def false_true(e: {False{} == True{} : Bool}) -> Empty:
  %e : BoolD(_)
  Unit{}

def NatD(n: Nat) -> Type:
  match n:
    case 0n:
      Empty
    case 1n+p:
      Unit

# a successor is not zero
def succ_zero(-p: Nat, e: {1n+p == 0n : Nat}) -> Empty:
  %e : NatD(_)
  Unit{}

def pred(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n+p:
      p

def succ_inj(-a: Nat, -b: Nat, e: {1n+a == 1n+b : Nat}) -> {a == b : Nat}:
  %e : {a == pred(_) : Nat}
  {==}

# Bool
# ----

def and_l(a: Bool, -b: Bool, e: {Bool.and(a, b) == True{} : Bool}) -> {a == True{} : Bool}:
  match a:
    case True{}:
      {==}
    case False{}:
      Empty.absurd({False{} == True{} : Bool}, false_true(e))

def and_r(a: Bool, -b: Bool, e: {Bool.and(a, b) == True{} : Bool}) -> {b == True{} : Bool}:
  match a:
    case True{}:
      e
    case False{}:
      Empty.absurd({b == True{} : Bool}, false_true(e))

# Nat.is_eq is sound
def eq_sound(a: Nat, b: Nat, e: {Nat.is_eq(a, b) == True{} : Bool}) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      Empty.absurd({0n == 1n+q : Nat}, false_true(e))
    case 1n+p 0n:
      Empty.absurd({1n+p == 0n : Nat}, false_true(e))
    case 1n+p 1n+q:
      %eq_sound(p, q, e) : {1n+p == 1n+_ : Nat}
      {==}

# a && b && c && d (left-nested) holds: so do a, b and d
def and4_a(+a: Bool, +b: Bool, +c: Bool, -d: Bool, h: {Bool.and(Bool.and(Bool.and(a, b), c), d) == True{} : Bool})
  -> {a == True{} : Bool}:
  and_l(a, b, and_l(Bool.and(a, b), c, and_l(Bool.and(Bool.and(a, b), c), d, h)))

def and4_b(+a: Bool, +b: Bool, +c: Bool, -d: Bool, h: {Bool.and(Bool.and(Bool.and(a, b), c), d) == True{} : Bool})
  -> {b == True{} : Bool}:
  and_r(a, b, and_l(Bool.and(a, b), c, and_l(Bool.and(Bool.and(a, b), c), d, h)))

def and4_d(+a: Bool, +b: Bool, +c: Bool, -d: Bool, h: {Bool.and(Bool.and(Bool.and(a, b), c), d) == True{} : Bool})
  -> {d == True{} : Bool}:
  and_r(Bool.and(Bool.and(a, b), c), d, h)

# Nat algebra
# -----------
# A rewrite %e : P with e : {a == b} turns the b marked by _ into a.

def add_zero_r(a: Nat) -> {Nat.add(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_zero_r(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

def add_succ_r(a: Nat, -b: Nat) -> {1n+Nat.add(a, b) == Nat.add(a, 1n+b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_succ_r(p, b) : {2n+Nat.add(p, b) == 1n+_ : Nat}
      {==}

def add_one_r(+a: Nat) -> {Nat.add(a, 1n) == 1n+a : Nat}:
  %add_zero_r(a) : {Nat.add(a, 1n) == 1n+_ : Nat}
  Equal.sym(Nat, 1n+Nat.add(a, 0n), Nat.add(a, 1n), add_succ_r(a, 0n))

def add_assoc(a: Nat, -b: Nat, -c: Nat) -> {Nat.add(Nat.add(a, b), c) == Nat.add(a, Nat.add(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_assoc(p, b, c) : {1n+Nat.add(Nat.add(p, b), c) == 1n+_ : Nat}
      {==}

def add_comm(a: Nat, +b: Nat) -> {Nat.add(a, b) == Nat.add(b, a) : Nat}:
  match a:
    case 0n:
      %add_zero_r(b) : {_ == Nat.add(b, 0n) : Nat}
      {==}
    case 1n+p:
      %add_succ_r(b, p) : {1n+Nat.add(p, b) == _ : Nat}
      %add_comm(p, b) : {1n+Nat.add(p, b) == 1n+_ : Nat}
      {==}

def double_add(+x: Nat) -> {Nat.double(x) == Nat.add(x, x) : Nat}:
  match x:
    case 0n:
      {==}
    case 1n+p:
      %add_succ_r(p, p) : {2n+Nat.double(p) == 1n+_ : Nat}
      %double_add(p) : {2n+Nat.double(p) == 2n+_ : Nat}
      {==}

def mul_one_r(a: Nat) -> {Nat.mul(a, 1n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %mul_one_r(p) : {1n+Nat.mul(p, 1n) == 1n+_ : Nat}
      {==}

def add_double(+x: Nat) -> {Nat.add(x, x) == Nat.double(x) : Nat}:
  Equal.sym(Nat, Nat.double(x), Nat.add(x, x), double_add(x))

def double_distr(a: Nat, +b: Nat) -> {Nat.double(Nat.add(a, b)) == Nat.add(Nat.double(a), Nat.double(b)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %double_distr(p, b) : {2n+Nat.double(Nat.add(p, b)) == 2n+_ : Nat}
      {==}

def mul_double_r(+j: Nat, +x: Nat) -> {Nat.mul(j, Nat.double(x)) == Nat.double(Nat.mul(j, x)) : Nat}:
  match j:
    case 0n:
      {==}
    case 1n+p:
      %Equal.sym(Nat, Nat.double(Nat.add(x, Nat.mul(p, x))), Nat.add(Nat.double(x), Nat.double(Nat.mul(p, x))), double_distr(x, Nat.mul(p, x))) : {Nat.add(Nat.double(x), Nat.mul(p, Nat.double(x))) == _ : Nat}
      %mul_double_r(p, x) : {Nat.add(Nat.double(x), Nat.mul(p, Nat.double(x))) == Nat.add(Nat.double(x), _) : Nat}
      {==}

def mul_double_l(+j: Nat, +x: Nat) -> {Nat.mul(Nat.double(j), x) == Nat.double(Nat.mul(j, x)) : Nat}:
  match j:
    case 0n:
      {==}
    case 1n+p:
      %Equal.sym(Nat, Nat.double(Nat.add(x, Nat.mul(p, x))), Nat.add(Nat.double(x), Nat.double(Nat.mul(p, x))), double_distr(x, Nat.mul(p, x))) : {Nat.add(x, Nat.add(x, Nat.mul(Nat.double(p), x))) == _ : Nat}
      %mul_double_l(p, x) : {Nat.add(x, Nat.add(x, Nat.mul(Nat.double(p), x))) == Nat.add(Nat.double(x), _) : Nat}
      %add_double(x) : {Nat.add(x, Nat.add(x, Nat.mul(Nat.double(p), x))) == Nat.add(_, Nat.mul(Nat.double(p), x)) : Nat}
      %add_assoc(x, x, Nat.mul(Nat.double(p), x)) : {_ == Nat.add(Nat.add(x, x), Nat.mul(Nat.double(p), x)) : Nat}
      {==}

# start(l+1, j) == start(l, 2j): a parent starts where its left child does
def start_parent(+l: Nat, +j: Nat) -> {K.start(1n+l, j) == K.start(l, Nat.double(j)) : Nat}:
  %Equal.sym(Nat, Nat.mul(Nat.double(j), K.pow2(l)), Nat.double(Nat.mul(j, K.pow2(l))), mul_double_l(j, K.pow2(l))) : {Nat.mul(j, Nat.double(K.pow2(l))) == _ : Nat}
  mul_double_r(j, K.pow2(l))

# (s + x) + x == s + 2x
def add_twice(+s: Nat, +x: Nat) -> {Nat.add(Nat.add(s, x), x) == Nat.add(s, Nat.double(x)) : Nat}:
  %add_double(x) : {Nat.add(Nat.add(s, x), x) == Nat.add(s, _) : Nat}
  add_assoc(s, x, x)

def not_true(b: Bool, f: {b == True{} : Bool} -> Empty) -> {b == False{} : Bool}:
  match b:
    case True{}:
      Empty.absurd({True{} == False{} : Bool}, f({==}))
    case False{}:
      {==}

# Lists
# -----

def length_len(+ps: List<&2, K.Part>, +acc: Nat) -> {Nat.add(Laws.Len(K.Part, ps), acc) == K.length(ps, acc) : Nat}:
  match ps:
    case Nil{}:
      {==}
    case Con{_, r}:
      %length_len(r, 1n+acc) : {1n+Nat.add(Laws.Len(K.Part, r), acc) == _ : Nat}
      add_succ_r(Laws.Len(K.Part, r), acc)

# a merge of an allowed pair shortens the list by one
def len_merge(ps: List<&2, K.Part>, k: Nat, h: {Laws.PairAt(ps, k) == True{} : Bool})
  -> {1n+Laws.Len(K.Part, K.merge_at(ps, k)) == Laws.Len(K.Part, ps) : Nat}:
  match ps k:
    case Nil{} _:
      Empty.absurd({1n+Laws.Len(K.Part, K.merge_at(Nil{}, k)) == 0n : Nat}, false_true(h))
    case Con{a, Nil{}} 0n:
      Empty.absurd({1n+Laws.Len(K.Part, K.merge_at([a], 0n)) == 1n : Nat}, false_true(h))
    case Con{a, Con{b, more}} 0n:
      {==}
    case Con{a, rest} 1n+j:
      %len_merge(rest, j, h) : {2n+Laws.Len(K.Part, K.merge_at(rest, j)) == 1n+_ : Nat}
      {==}

# a cons is not Nil: ListD(_, P) is P at a cons and Unit at Nil
def ListD(x: List<&2, K.Part>, P: Type) -> Type:
  match x:
    case Nil{}:
      Unit
    case Con{_, _}:
      P

def tail(x: List<&2, K.Part>) -> List<&2, K.Part>:
  match x:
    case Nil{}:
      Nil{}
    case Con{_, t}:
      t

# the suffix of ps from index k
def Drop(k: Nat, ps: List<&2, K.Part>) -> List<&2, K.Part>:
  match k:
    case 0n:
      ps
    case 1n+j:
      match ps:
        case Nil{}:
          Nil{}
        case Con{_, t}:
          Drop(j, t)

# PairAt(ps0, k) only looks at the suffix from k
def drop_pair(ps0: List<&2, K.Part>, k: Nat, -a: K.Part, -b: K.Part, -more: List<&2, K.Part>,
  e: {Drop(k, ps0) == a <> b <> more : List<&2, K.Part>})
  -> {Laws.PairAt(ps0, k) == K.mergeable(a, b) : Bool}:
  match ps0 k:
    case Nil{} 0n:
      %e : ListD(_, {False{} == K.mergeable(a, b) : Bool})
      Unit{}
    case Nil{} 1n+j:
      %e : ListD(_, {False{} == K.mergeable(a, b) : Bool})
      Unit{}
    case Con{h, t} 0n:
      %e : {Laws.PairHead(h, t) == Laws.PairAt(_, 0n) : Bool}
      {==}
    case Con{_, t} 1n+j:
      drop_pair(t, j, a, b, more, e)

def drop_tail(ps0: List<&2, K.Part>, k: Nat, -a: K.Part, -rest: List<&2, K.Part>,
  e: {Drop(k, ps0) == a <> rest : List<&2, K.Part>})
  -> {Drop(1n+k, ps0) == rest : List<&2, K.Part>}:
  match ps0 k:
    case Nil{} 0n:
      %e : ListD(_, {Nil{} == rest : List<&2, K.Part>})
      Unit{}
    case Nil{} 1n+j:
      %e : ListD(_, {Nil{} == rest : List<&2, K.Part>})
      Unit{}
    case Con{h, t} 0n:
      %e : {t == tail(_) : List<&2, K.Part>}
      {==}
    case Con{_, t} 1n+j:
      drop_tail(t, j, a, rest, e)
