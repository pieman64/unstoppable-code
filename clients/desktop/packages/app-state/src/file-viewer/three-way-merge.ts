import {
  analyzeThreeWay,
  type ThreeWayMergeSkipReason,
} from './three-way-conflicts';

export {
  THREE_WAY_MERGE_MAX_BYTES,
  THREE_WAY_MERGE_MAX_LINES,
  THREE_WAY_MERGE_MAX_WORK,
  mergeInputSkipReason,
  type ThreeWayMergeSkipReason,
} from './three-way-conflicts';

export type ThreeWayMergeResult =
  | { readonly kind: 'clean'; readonly content: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'skipped'; readonly reason: ThreeWayMergeSkipReason };

/**
 * Line-level three-way merge of `ours` and `theirs`, both derived from
 * `base`. Disjoint and identical changes merge cleanly; different changes to
 * the same or adjacent lines conflict. The result never normalizes line
 * terminators. Line independence does not imply semantic correctness. See
 * {@link analyzeThreeWay} for the overlapping passages themselves.
 */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
): ThreeWayMergeResult {
  const analysis = analyzeThreeWay(base, ours, theirs);
  return analysis.kind === 'conflicts' ? { kind: 'conflict' } : analysis;
}
