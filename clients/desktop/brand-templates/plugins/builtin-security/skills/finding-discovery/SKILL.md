---
name: finding-discovery
description: Discover concrete candidate security vulnerabilities in a code diff using focused input, authorization, data, boundary, state, and deployment passes.
---

# Discover security candidates

Read `../../references/diff-scan-methodology.md` and `../../references/finding-criteria.md`. Inventory the changed files, apply each relevant discovery pass, and generate concrete candidates with a changed location, attacker capability, source, suspected sink, missing or weakened control, and potential consequence.

Candidates are hypotheses, not reportable findings. Keep contradictory evidence and uncertainty visible. Do not assign final severity or present candidates as confirmed until validation traces them through the real code path.
