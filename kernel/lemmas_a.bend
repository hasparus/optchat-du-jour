# Shared lemmas for the addressing and rule 3 proofs (proofs_addr.bend,
# proofs_rule3.bend): Nat arithmetic, Bool reflection of the kernel's
# computed checks (Nat.is_eq, Bool.and, Bool.not), and Drop, the suffix
# of a list, with what it says about Nth and Len.

import Base
import ./LAWS.bend as Laws

# Refutations
# -----------

# a type picked by a Bool: a rewrite through it refutes False{} == True{}
def BD(b: Bool, t: Type, f: Type) -> Type:
  match b:
    case True{}:
      t
    case False{}:
      f

def false_true(-P: Type, e: {False{} == True{} : Bool}) -> P:
  %e : BD(_, P, Unit)
  Unit{}

def true_false(-P: Type, e: {True{} == False{} : Bool}) -> P:
  %e : BD(_, Unit, P)
  Unit{}

# a type picked by a list's shape: refutes Nil{} == Con{..}
def LD(-A: Data, xs: List<&2, A>, n: Type, c: Type) -> Type:
  match xs:
    case Nil{}:
      n
    case Con{_, _}:
      c

def nil_con(-A: Data, -P: Type, -h: A, -t: List<&2, A>, e: {Nil{} == Con{h, t} : List<&2, A>}) -> P:
  %e : LD(A, _, Unit, P)
  Unit{}

def con_nil(-A: Data, -P: Type, -h: A, -t: List<&2, A>, e: {Con{h, t} == Nil{} : List<&2, A>}) -> P:
  %e : LD(A, _, P, Unit)
  Unit{}

# Nat arithmetic
# --------------

def add_zero(a: Nat) -> {a == Nat.add(a, 0n) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_zero(p) : {1n+p == 1n+_ : Nat}
      {==}

def add_succ(a: Nat, -b: Nat) -> {1n+Nat.add(a, b) == Nat.add(a, 1n+b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_succ(p, b) : {2n+Nat.add(p, b) == 1n+_ : Nat}
      {==}

# double is x + x
def double_add(a: Nat) -> {Nat.double(a) == Nat.add(a, a) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n++p:
      %add_succ(p, p) : {2n+Nat.double(p) == 1n+_ : Nat}
      %double_add(p) : {2n+Nat.double(p) == 2n+_ : Nat}
      {==}

# 2 * x, as Nat.mul spells it, is double
def mul2(+a: Nat) -> {Nat.double(a) == Nat.mul(2n, a) : Nat}:
  %add_zero(a) : {Nat.double(a) == Nat.add(a, _) : Nat}
  double_add(a)

# Bool reflection
# ---------------

def and_true(a: Bool, -b: Bool, e: {Bool.and(a, b) == True{} : Bool})
  -> {a == True{} : Bool} & {b == True{} : Bool}:
  match a:
    case True{}:
      ({==}, e)
    case False{}:
      false_true({False{} == True{} : Bool} & {b == True{} : Bool}, e)

def not_true(a: Bool, e: {Bool.not(a) == True{} : Bool}) -> {a == False{} : Bool}:
  match a:
    case True{}:
      false_true({True{} == False{} : Bool}, e)
    case False{}:
      {==}

# a check that holds hands over the equation
def eq_sound(a: Nat, b: Nat, e: {Nat.is_eq(a, b) == True{} : Bool}) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      false_true({0n == 1n+q : Nat}, e)
    case 1n+p 0n:
      false_true({1n+p == 0n : Nat}, e)
    case 1n+p 1n+q:
      %eq_sound(p, q, e) : {1n+p == 1n+_ : Nat}
      {==}

# Drop: the suffix of a list from index n
# ---------------------------------------

def Drop(-A: Data, n: Nat, xs: List<&2, A>) -> List<&2, A>:
  match n:
    case 0n:
      xs
    case 1n+k:
      match xs:
        case Nil{}:
          Nil{}
        case Con{_, t}:
          Drop(A, k, t)

def hd(-A: Data, xs: List<&2, A>, d: A) -> A:
  match xs:
    case Nil{}:
      d
    case Con{h, _}:
      h

def tl(-A: Data, xs: List<&2, A>) -> List<&2, A>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{_, t}:
      t

# the suffix from n is b <> rest: so xs[n] is b, n is in range, and the
# suffix from n + 1 is rest
def DropCon(-A: Data, n: Nat, xs: List<&2, A>, d: A, b: A, rest: List<&2, A>) -> Type:
  {Laws.Nth(A, xs, n, d) == b : A}
    & {Nat.is_lt(n, Laws.Len(A, xs)) == True{} : Bool}
    & {Drop(A, 1n+n, xs) == rest : List<&2, A>}

def drop_con(-A: Data, n: Nat, xs: List<&2, A>, -d: A, -b: A, -rest: List<&2, A>,
  e: {Drop(A, n, xs) == Con{b, rest} : List<&2, A>}) -> DropCon(A, n, xs, d, b, rest):
  match n xs:
    case 0n Nil{}:
      nil_con(A, DropCon(A, 0n, Nil{}, d, b, rest), b, rest, e)
    case 0n Con{h, t}:
      %e : ({h == hd(A, _, h) : A}
        & {Nat.is_lt(0n, 1n+Laws.Len(A, t)) == True{} : Bool}
        & {t == tl(A, _) : List<&2, A>})
      ({==}, {==}, {==})
    case 1n+k Nil{}:
      nil_con(A, DropCon(A, 1n+k, Nil{}, d, b, rest), b, rest, e)
    case 1n+k Con{h, t}:
      drop_con(A, k, t, d, b, rest, e)

# past the end, the suffix stays empty
def drop_nil(-A: Data, n: Nat, xs: List<&2, A>, e: {Drop(A, n, xs) == Nil{} : List<&2, A>})
  -> {Drop(A, 1n+n, xs) == Nil{} : List<&2, A>}:
  match n xs:
    case 0n Nil{}:
      {==}
    case 0n Con{h, t}:
      con_nil(A, {Drop(A, 1n, Con{h, t}) == Nil{} : List<&2, A>}, h, t, e)
    case 1n+k Nil{}:
      {==}
    case 1n+k Con{h, t}:
      drop_nil(A, k, t, e)
