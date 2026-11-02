// Shared security-keyword pattern, extracted to a dependency-free leaf
// module so BOTH consumers can import it without creating a module cycle:
//
// - `impact/change-impact.ts` uses it for the risk formula's
//   security-keyword term (+0.20 when a changed symbol's qualified name
//   matches).
// - `analysis/flows.ts` uses it for flow criticality's
//   security-keyword-fraction component (Phase 6 Task 5), per the Phase 6
//   plan's instruction to reuse the EXACT risk pattern instead of
//   maintaining a second, driftable copy of the keyword list.
//
// It originally lived in change-impact.ts; flows.ts importing it from there
// was the sole load-bearing edge of a 5-hop cycle (engine ->
// analysis/derived -> analysis/flows -> impact/change-impact ->
// impact/before-graph -> engine). Hosting it here severs that edge
// structurally. Keep this module import-free (a true leaf) so it can never
// participate in a cycle itself.
//
// name/path match — a qualifiedName is always
// `${canonicalRelativePath}::${memberPath}` (see ids.ts), so testing it
// alone covers both the file path and the member name in one pass.
export const CODE_GRAPH_SECURITY_KEYWORD_PATTERN =
  /auth|token|crypt|secret|password|sql|exec|permission|sandbox/i;
