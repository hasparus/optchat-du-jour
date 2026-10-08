# Proofs of the sawtooth's laws in the kernel's vocabulary (saw_merges,
# saw_batch, and the tiling of saw): saw either leaves the view as it is or
# runs one batch, which is fit to low, so fit's proofs (proofs_fold.bend)
# carry over. bridge.bend restates them in LAWS.bend's words.

import Base
import ./kernel.bend as K
import ./kspec.bend as KS
import ./LAWS.bend as Laws
import ./lemmas_fold.bend as F
import ./proofs_fold.bend as PF

# what a batch leaves, in the kernel's words: fit's Fits at low, and the
# debt flag is whether the view ended over low
def Batched(low: Nat, r: K.Saw) -> Type:
  K.Saw{ps, f} = r
  (KS.Fits(low, ps) & {f == Nat.is_gt(K.size(ps), low) : Bool})

# Merges
# ------

# saw.go merges only allowed pairs, whichever way `due` goes
def go_merges(due: Bool, +T: Nat, +low: Nat, +ps: List<&2, K.Part>)
  -> &n: Nat -> KS.Merges(n, ps, Laws.ViewOf(K.saw.go(due, T, low, ps))):
  match due:
    case True{}:
      PF.fit_merges_k(T, low, ps)
    case False{}:
      (0n, {==})

def saw_merges_k(+T: Nat, +high: Nat, +low: Nat, +folding: Bool, +ps: List<&2, K.Part>)
  -> &n: Nat -> KS.Merges(n, ps, Laws.ViewOf(K.saw(T, high, low, folding, ps))):
  go_merges(Bool.or(folding, Nat.is_gt(K.size(ps), high)), T, low, ps)

# so the view still tiles [0, T)
def tiles_saw_k(+T: Nat, +high: Nat, +low: Nat, +folding: Bool, +ps: List<&2, K.Part>)
  -> KS.Tiles(ps, 0n, T) -> KS.Tiles(Laws.ViewOf(K.saw(T, high, low, folding, ps)), 0n, T):
  t => PF.tiles_from(ps, Laws.ViewOf(K.saw(T, high, low, folding, ps)), T, saw_merges_k(T, high, low, folding, ps), t)

# A batch
# -------

# when a batch is due, saw runs one, and it ends as fit_fits says
def go_batch(due: Bool, +T: Nat, +low: Nat, +ps: List<&2, K.Part>, h: {due == True{} : Bool})
  -> Batched(low, K.saw.go(due, T, low, ps)):
  match due:
    case True{}:
      (PF.fit_fits_k(T, low, ps), {==})
    case False{}:
      Empty.absurd(Batched(low, K.Saw{ps, False{}}), F.false_true(h))

def saw_batch_k(+T: Nat, +high: Nat, +low: Nat, +folding: Bool, +ps: List<&2, K.Part>,
  h: {Bool.or(folding, Nat.is_gt(K.size(ps), high)) == True{} : Bool}) -> Batched(low, K.saw(T, high, low, folding, ps)):
  go_batch(Bool.or(folding, Nat.is_gt(K.size(ps), high)), T, low, ps, h)
