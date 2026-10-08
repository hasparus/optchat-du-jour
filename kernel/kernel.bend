# The fold kernel (SPEC E14): id+n addressing, the view's merge order, its
# sawtooth and the rebuild from the log, `first` and the pump's rule 3
# (docs/optchat.md §2-§4). It never sees text, only sizes in bytes, as Nats. LAWS.bend
# states what must hold; PROOF.bend proves it. src/kernel.ts is the only
# caller.
#
# Comparisons the proofs rely on are computed, then checked with is_eq:
# a check that holds hands the proof an equation, and nothing here divides
# without checking the result.

import Base

# Addressing
# ----------

# 2^l
def pow2(l: Nat) -> Nat:
  match l:
    case 0n:
      1n
    case 1n+p:
      Nat.double(pow2(p))

# node (l, i) covers the messages [start(l, i), start(l, i) + pow2(l))
def start(+l: Nat, i: Nat) -> Nat:
  Nat.mul(i, pow2(l))

type Coord is Data:
  Coord{l: Nat, i: Nat}

# Looking for the l with pow2(l) == n: still looking at l, found it, or
# passed n without meeting it
type Search is Data:
  Below{l: Nat}
  Found{l: Nat}
  Past{}

def log2.step(c: Cmp, l: Nat) -> Search:
  match c:
    case LT{}:
      Below{1n+l}
    case EQ{}:
      Found{l}
    case GT{}:
      Past{}

def log2.done(st: Search) -> Maybe<&2, Nat>:
  match st:
    case Below{_}:
      None{}
    case Found{l}:
      Some{l}
    case Past{}:
      None{}

# the l with pow2(l) == n: walks l up from where st says and stops at the
# first pow2(l) >= n, so it never computes a power past 2n
def log2(fuel: Nat, st: Search, +n: Nat) -> Maybe<&2, Nat>:
  match fuel st:
    case 0n s:
      log2.done(s)
    case 1n+f Below{+l}:
      log2(f, log2.step(Nat.cmp(pow2(l), n), l), n)
    case 1n+f Found{l}:
      Some{l}
    case 1n+f Past{}:
      None{}

def coords.check(ok: Bool, l: Nat, i: Nat) -> Maybe<&2, Coord>:
  match ok:
    case True{}:
      Some{Coord{l, i}}
    case False{}:
      None{}

def coords.at(+id: Nat, +n: Nat, +T: Nat, ml: Maybe<&2, Nat>) -> Maybe<&2, Coord>:
  match ml:
    case None{}:
      None{}
    case Some{+l}:
      +i = Nat.div(id, n)
      ok = Nat.is_eq(start(l, i), id) && Nat.is_le(Nat.add(id, n), T)
      coords.check(ok, l, i)

# the node named id+n in a chat of T messages: n a power of two, id a
# multiple of n, id + n <= T (docs/optchat.md §2). log2 needs at most
# n + 1 steps, since 2^n > n.
def coords(+id: Nat, +n: Nat, +T: Nat) -> Maybe<&2, Coord>:
  coords.at(id, n, T, log2(1n+n, Below{0n}, n))

# The view
# --------

# A view line: node (l, i), its size in bytes (the placeholder's when it is
# unbuilt), whether it is built, and the sizes of its built ancestors,
# nearest first. A parent is built only after its children, so the built
# ancestors are a prefix of the line above it, the one above that, ...
type Part is Data:
  Part{l: Nat, i: Nat, size: Nat, built: Bool, ups: List<&2, Nat>}

# What the caller knows of message T when it arrives: the size of its
# level-0 line, whether that is built, and its built ancestors' sizes.
type Msg is Data:
  Msg{size: Nat, built: Bool, ups: List<&2, Nat>}

# xs reversed onto acc. Every walk over a view or a log is tail-recursive:
# the JS output overflows its stack past ~20k nested calls, and a view
# waiting on a large backlog can be that long.
def rev_onto(xs: List<&2, Part>, acc: List<&2, Part>) -> List<&2, Part>:
  match xs:
    case Nil{}:
      acc
    case Con{h, t}:
      rev_onto(t, h <> acc)

def total(ps: List<&2, Part>, acc: Nat) -> Nat:
  match ps:
    case Nil{}:
      acc
    case Con{p, rest}:
      Part{_, _, s, _, _} = p
      total(rest, Nat.add(acc, s))

def size(ps: List<&2, Part>) -> Nat:
  total(ps, 0n)

def built_up(ups: List<&2, Nat>) -> Bool:
  match ups:
    case Nil{}:
      False{}
    case Con{_, _}:
      True{}

# a and b are siblings (l, 2j) and (l, 2j+1) and their parent is built
def mergeable(a: Part, b: Part) -> Bool:
  Part{+la, +ia, _, _, ups} = a
  Part{lb, ib, _, _, _} = b
  +j = Nat.div(ia, 2n)
  Nat.is_eq(la, lb) && Nat.is_eq(Nat.double(j), ia) && Nat.is_eq(1n+ia, ib) && built_up(ups)

# the line a pair (l, 2j), (l, 2j+1) merges into: (l+1, j), whose size is
# the first of the built ancestors
def parent(a: Part) -> Part:
  Part{l, i, s, b, ups} = a
  match ups:
    case Nil{}:
      Part{l, i, s, b, Nil{}}
    case Con{u, us}:
      Part{1n+l, Nat.div(i, 2n), u, True{}, us}

# The most due mergeable pair so far: its index k, the end e of the pair
# (one past its last message) and the level l of its lines.
type Best is Data:
  Best{k: Nat, e: Nat, l: Nat}

# Due is measured from the pair's LAST message (docs/optchat.md §3.2, §7 mistake 1):
#
#   due = (T - last) / 2^l,  last = e - 1,  so  due = (1 + T - e) / 2^l
#
# how long ago the pair ended, in its own line size. A pair lies inside the
# view, which tiles [0, T), so e <= T and 1 + T - e >= 1: the Nat
# subtraction never clips. (docs/optchat.md's code writes it (T + 1)/2^l - i, the
# same number shifted by 2: e = (i + 2) * 2^l.)
#
# a is more due than b when (1 + T - ea) / 2^la > (1 + T - eb) / 2^lb.
# Multiplying both sides by 2^la * 2^lb > 0 keeps the order and clears both
# divisions: (1 + T - ea) * 2^lb > (1 + T - eb) * 2^la. Equal pairs are not
# more due than each other, so the scan below keeps the oldest.
def more_due(+T: Nat, a: Best, b: Best) -> Bool:
  Best{_, ea, +la} = a
  Best{_, eb, +lb} = b
  Nat.is_gt(Nat.mul(Nat.sub(1n+T, ea), pow2(lb)), Nat.mul(Nat.sub(1n+T, eb), pow2(la)))

def choose.vs(win: Bool, cand: Best, cur: Best) -> Maybe<&2, Best>:
  match win:
    case True{}:
      Some{cand}
    case False{}:
      Some{cur}

def choose(+T: Nat, ok: Bool, +cand: Best, acc: Maybe<&2, Best>) -> Maybe<&2, Best>:
  match ok:
    case False{}:
      acc
    case True{}:
      match acc:
        case None{}:
          Some{cand}
        case Some{+cur}:
          choose.vs(more_due(T, cand, cur), cand, cur)

def pick(+T: Nat, +a: Part, +b: Part, k: Nat, acc: Maybe<&2, Best>) -> Maybe<&2, Best>:
  Part{+l, i, _, _, _} = a
  choose(T, mergeable(a, b), Best{k, start(l, 2n+i), l}, acc)

# the most due mergeable pair, ties to the leftmost; k is the index of ps's
# first line
def best.go(+ps: List<&2, Part>, +T: Nat, +k: Nat, acc: Maybe<&2, Best>) -> Maybe<&2, Best>:
  match ps:
    case Nil{}:
      acc
    case Con{+a, +rest}:
      match rest:
        case Nil{}:
          acc
        case Con{+b, _}:
          best.go(rest, T, 1n+k, pick(T, a, b, k, acc))

def best(+T: Nat, +ps: List<&2, Part>) -> Maybe<&2, Best>:
  best.go(ps, T, 0n, None{})

def merge_head(a: Part, rest: List<&2, Part>) -> List<&2, Part>:
  match rest:
    case Nil{}:
      [a]
    case Con{_, more}:
      parent(a) <> more

# the lines before k are reversed onto done as the walk passes them
def merge_at.go(ps: List<&2, Part>, k: Nat, done: List<&2, Part>) -> List<&2, Part>:
  match ps k:
    case Nil{} _:
      rev_onto(done, Nil{})
    case Con{a, rest} 0n:
      rev_onto(done, merge_head(a, rest))
    case Con{a, rest} 1n+j:
      merge_at.go(rest, j, a <> done)

# ps with lines k and k+1 replaced by their parent
def merge_at(ps: List<&2, Part>, k: Nat) -> List<&2, Part>:
  merge_at.go(ps, k, Nil{})

# One step of fit: Stop when the view fits or no pair can merge; else More
# with the most due pair merged.
type Step is Data:
  More{ps: List<&2, Part>}
  Stop{ps: List<&2, Part>}

def step.merge(ps: List<&2, Part>, b: Maybe<&2, Best>) -> Step:
  match b:
    case None{}:
      Stop{ps}
    case Some{x}:
      Best{k, _, _} = x
      More{merge_at(ps, k)}

def step.over(over: Bool, +T: Nat, +ps: List<&2, Part>) -> Step:
  match over:
    case False{}:
      Stop{ps}
    case True{}:
      step.merge(ps, best(T, ps))

def step(+T: Nat, +budget: Nat, +ps: List<&2, Part>) -> Step:
  step.over(Nat.is_gt(size(ps), budget), T, ps)

def fit.go(fuel: Nat, st: Step, +T: Nat, +budget: Nat) -> List<&2, Part>:
  match fuel st:
    case 0n More{ps}:
      ps
    case 0n Stop{ps}:
      ps
    case 1n+f Stop{ps}:
      ps
    case 1n+f More{+ps}:
      fit.go(f, step(T, budget, ps), T, budget)

def length(ps: List<&2, Part>, acc: Nat) -> Nat:
  match ps:
    case Nil{}:
      acc
    case Con{_, rest}:
      length(rest, 1n+acc)

# merge the most due built pair while over budget (docs/optchat.md §3.2). Every merge
# shortens the view by one, so its length plus one steps always suffice.
def fit(+T: Nat, +budget: Nat, +ps: List<&2, Part>) -> List<&2, Part>:
  fit.go(1n+length(ps, 0n), More{ps}, T, budget)

def snoc(ps: List<&2, Part>, p: Part) -> List<&2, Part>:
  rev_onto(rev_onto(ps, Nil{}), [p])

# The sawtooth (docs/optchat.md §3.2 "When", §7 mistake 2)
# -------------------------------------------------------
# The view, and whether a batch is still owed: the last one stopped over
# low because the parents it needed were not built yet. high and low are
# parameters: the turns' view runs 128 KB down to 64 KB, and a compaction
# view can run its own sawtooth at other marks.
type Saw is Data:
  Saw{ps: List<&2, Part>, folding: Bool}

# one batch: the most due built pairs merge until the view is at most low
# or nothing can merge; ending over low, it owes the rest
def batch(+T: Nat, +low: Nat, +ps: List<&2, Part>) -> Saw:
  +fitted = fit(T, low, ps)
  Saw{fitted, Nat.is_gt(size(fitted), low)}

def saw.go(due: Bool, +T: Nat, +low: Nat, +ps: List<&2, Part>) -> Saw:
  match due:
    case True{}:
      batch(T, low, ps)
    case False{}:
      Saw{ps, False{}}

# a view past high, or one a batch still owes, merges down to low; any
# other view stays as it is, so between batches it only grows at its end
# and the prompt cache keeps all of it (docs/optchat.md §3.3)
def saw(+T: Nat, +high: Nat, +low: Nat, folding: Bool, +ps: List<&2, Part>) -> Saw:
  saw.go(folding || Nat.is_gt(size(ps), high), T, low, ps)

# message T arrives: its line (0, T) goes at the end, then the sawtooth
# with T + 1 messages
def append(+T: Nat, +high: Nat, +low: Nat, folding: Bool, ps: List<&2, Part>, m: Msg) -> Saw:
  Msg{s, b, ups} = m
  saw(1n+T, high, low, folding, snoc(ps, Part{0n, T, s, b, ups}))

# The rebuild
# -----------
# The view is saved and loaded, never rebuilt (docs/optchat.md §3.2, §7 mistake 3);
# this is for a data dir with no saved view, or a damaged one. It appends
# every message as append does, against today's tree.
#
# What it carries from one message to the next: the view newest first (so
# a new line costs nothing), its size, and whether a batch is owed. Two
# kinds of message skip the batch, since it would leave the view as it is:
# one that keeps an owing-nothing view within high, and one that comes
# while a batch is owed and makes no new pair with the newest line. The
# tree does not change during a rebuild, so a batch that ended over low
# left no pair to merge (fit_fits), and only the new line can make one.
# After a big import the view waits on a long backlog, and scanning it on
# every message would make the rebuild quadratic.
type Fold is Data:
  Fold{rev: List<&2, Part>, size: Nat, folding: Bool}

# the newest line of the view and p are a pair that can merge
def pairs_with(rev: List<&2, Part>, +p: Part) -> Bool:
  match rev:
    case Nil{}:
      False{}
    case Con{q, _}:
      mergeable(q, p)

def fold.batch(+T: Nat, +low: Nat, ps: List<&2, Part>) -> Fold:
  +fitted = fit(T, low, ps)
  +n = size(fitted)
  Fold{rev_onto(fitted, Nil{}), n, Nat.is_gt(n, low)}

def fold.decide(skip: Bool, +T: Nat, +low: Nat, rev: List<&2, Part>, n: Nat, folding: Bool) -> Fold:
  match skip:
    case True{}:
      Fold{rev, n, folding}
    case False{}:
      fold.batch(T, low, rev_onto(rev, Nil{}))

# message T arrives; T + 1 messages afterwards
def fold.push(+T: Nat, +high: Nat, +low: Nat, f: Fold, m: Msg) -> Fold:
  Fold{+rev, n, +folding} = f
  Msg{+s, b, ups} = m
  +p = {Part{0n, T, s, b, ups} : Part}
  +n2 = Nat.add(n, s)
  +calm = Bool.not(folding) && Nat.is_le(n2, high)
  +stuck = folding && Bool.not(pairs_with(rev, p))
  fold.decide(calm || stuck, 1n+T, low, p <> rev, n2, folding)

def refold.go(ms: List<&2, Msg>, +high: Nat, +low: Nat, +T: Nat, f: Fold) -> Fold:
  match ms:
    case Nil{}:
      f
    case Con{m, rest}:
      refold.go(rest, high, low, 1n+T, fold.push(T, high, low, f, m))

def refold.end(f: Fold) -> Saw:
  Fold{rev, _, folding} = f
  Saw{rev_onto(rev, Nil{}), folding}

# the view rebuilt from message 0: what appending every message gives
def refold(+high: Nat, +low: Nat, ms: List<&2, Msg>) -> Saw:
  refold.end(refold.go(ms, high, low, 0n, Fold{Nil{}, 0n, False{}}))

# Rule 3
# ------

def first.unbuilt(b: Bool, s: Nat) -> Maybe<&2, Nat>:
  match b:
    case True{}:
      None{}
    case False{}:
      Some{s}

def first.or(found: Maybe<&2, Nat>, T: Nat) -> Nat:
  match found:
    case Some{x}:
      x
    case None{}:
      T

# the start of the first unbuilt line among those walked, if any
def first.keep(found: Maybe<&2, Nat>, p: Part) -> Maybe<&2, Nat>:
  match found:
    case Some{x}:
      Some{x}
    case None{}:
      Part{+l, i, _, b, _} = p
      first.unbuilt(b, start(l, i))

def first.go(ps: List<&2, Part>, +T: Nat, found: Maybe<&2, Nat>) -> Nat:
  match ps:
    case Nil{}:
      first.or(found, T)
    case Con{p, rest}:
      first.go(rest, T, first.keep(found, p))

# the first message whose view line is unbuilt, else T (rule 3)
def first(+T: Nat, ps: List<&2, Part>) -> Nat:
  first.go(ps, T, None{})

def offer(ok: Bool, c: Coord, acc: List<&2, Coord>) -> List<&2, Coord>:
  match ok:
    case True{}:
      c <> acc
    case False{}:
      acc

# level 0: message i is offered when its line is unbuilt and every view
# line before it is built (i <= head)
def offers.leaves(bs: List<&2, Bool>, +head: Nat, +i: Nat, acc: List<&2, Coord>) -> List<&2, Coord>:
  match bs:
    case Nil{}:
      acc
    case Con{b, rest}:
      offers.leaves(rest, head, 1n+i, offer(Bool.not(b) && Nat.is_le(i, head), Coord{0n, i}, acc))

def offers.node(+l: Nat, +head: Nat, +j: Nat, b: Bool, kids: List<&2, Bool>) -> Bool:
  match kids:
    case Nil{}:
      False{}
    case Con{x, more}:
      match more:
        case Nil{}:
          False{}
        case Con{y, _}:
          Bool.not(b) && x && y && Nat.is_le(start(l, 1n+j), head)

def offers.drop2(kids: List<&2, Bool>) -> List<&2, Bool>:
  match kids:
    case Nil{}:
      Nil{}
    case Con{_, more}:
      match more:
        case Nil{}:
          Nil{}
        case Con{_, rest}:
          rest

# level l > 0: node j is offered when it is unbuilt, both its children
# (the kids, two per node) are built, and every view line before its end
# is built
def offers.level(own: List<&2, Bool>, +kids: List<&2, Bool>, +l: Nat, +head: Nat, +j: Nat, acc: List<&2, Coord>) -> List<&2, Coord>:
  match own:
    case Nil{}:
      acc
    case Con{b, rest}:
      offers.level(rest, offers.drop2(kids), l, head, 1n+j, offer(offers.node(l, head, j, b, kids), Coord{l, j}, acc))

def offers.up(levels: List<&2, List<&2, Bool>>, +below: List<&2, Bool>, +l: Nat, +head: Nat, acc: List<&2, Coord>) -> List<&2, Coord>:
  match levels:
    case Nil{}:
      acc
    case Con{+own, rest}:
      offers.up(rest, own, 1n+l, head, offers.level(own, below, l, head, 0n, acc))

# The nodes rule 3 lets the pump start (SPEC E25): levels[l][i] says
# whether node (l, i) is built, level 0 first, one entry per node that
# exists; head is first(view). Most recent offer first: the caller reverses.
def offers(levels: List<&2, List<&2, Bool>>, +head: Nat) -> List<&2, Coord>:
  match levels:
    case Nil{}:
      Nil{}
    case Con{+leaves, rest}:
      offers.up(rest, leaves, 1n, head, offers.leaves(leaves, head, 0n, Nil{}))
