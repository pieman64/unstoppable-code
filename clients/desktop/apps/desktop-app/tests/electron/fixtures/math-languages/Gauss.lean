import Mathlib.Tactic

/-! # Gauss sums
  A small example file. /- Nested comments are allowed. -/ -/

namespace Gauss

open Finset

/-- The sum `0 + 1 + ⋯ + n`, doubled, is `n * (n + 1)`. -/
theorem two_mul_sum_range (n : ℕ) :
    2 * ∑ i ∈ range (n + 1), i = n * (n + 1) := by
  induction n with
  | zero => simp
  | succ k ih =>
    rw [sum_range_succ, mul_add, ih]
    ring

@[simp] lemma pair_fst (a b : ℕ) : (⟨a, b⟩ : ℕ × ℕ).1 = a := rfl

def greeting : String := "Hello, \"Lean\"!\n"

example (p q : Prop) (hp : p) (hq : q) : p ∧ q := ⟨hp, hq⟩

theorem todo (x : ℝ) (h : 0 < x) : x ≠ 0 := by
  -- finish this later
  sorry

#check two_mul_sum_range
#eval greeting.length + 'a'.toNat

end Gauss
