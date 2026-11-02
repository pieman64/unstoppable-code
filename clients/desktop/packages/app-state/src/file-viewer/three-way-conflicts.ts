import { diff3MergeRegions } from 'node-diff3';

/** Largest UTF-8 input or output the merge accepts (2 MiB). */
export const THREE_WAY_MERGE_MAX_BYTES = 2 * 1024 * 1024;
/** Largest line count of any input the merge accepts. */
export const THREE_WAY_MERGE_MAX_LINES = 50_000;
/**
 * Upper bound on the estimated LCS work for each side's changed middle:
 * matching line pairs × the shorter middle. node-diff3's candidate search
 * scans linearly, so its cost grows with that product (measured: 5,000
 * unique lines ≈ 40 ms; a 10,000-line file with common blank and brace lines
 * ≈ 29 s). Larger middles skip the merge rather than block the UI thread;
 * prefix/suffix trimming keeps ordinary small edits far below this bound.
 */
export const THREE_WAY_MERGE_MAX_WORK = 30_000_000;

export type ThreeWayMergeSkipReason =
  | 'too-large'
  | 'too-complex'
  | 'binary'
  | 'output-too-large';

/** Which wording an overlapping passage keeps. */
export type OverlapChoice = 'ours' | 'theirs';

/**
 * Where one side's text of a passage sits in that side's document. `line` is
 * 1-based. A zero `lineCount` marks an insertion or deletion anchor before
 * `line`, not a text line of its own.
 */
export interface OverlapLineRange {
  readonly line: number;
  readonly lineCount: number;
}

/**
 * One passage both sides changed differently. Text is lossless: joining the
 * stable lines and each region's chosen side reproduces the input exactly,
 * terminators and final newline included.
 */
export interface OverlapRegion {
  /** 0-based order of this passage among the document's overlaps. */
  readonly index: number;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly baseLines: OverlapLineRange;
  readonly oursLines: OverlapLineRange;
  readonly theirsLines: OverlapLineRange;
}

export type ThreeWayAnalysis =
  | { readonly kind: 'clean'; readonly content: string }
  | { readonly kind: 'conflicts'; readonly regions: readonly OverlapRegion[] }
  | { readonly kind: 'skipped'; readonly reason: ThreeWayMergeSkipReason };

export type OverlapResolution =
  | { readonly kind: 'resolved'; readonly content: string }
  /** The choices do not match this snapshot's passages one for one. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'skipped'; readonly reason: ThreeWayMergeSkipReason };

/** A merged run of lines, or a passage awaiting a choice. */
type Segment =
  | { readonly kind: 'merged'; readonly tokens: readonly string[] }
  | { readonly kind: 'conflict'; readonly region: OverlapRegion };

type Walk =
  | { readonly kind: 'segments'; readonly segments: readonly Segment[] }
  | { readonly kind: 'skipped'; readonly reason: ThreeWayMergeSkipReason };

/**
 * Lossless line tokens: each token keeps its own terminator (`\n`, with any
 * preceding `\r`), and a final unterminated line is its own token, so joining
 * the tokens reproduces the input exactly and terminator or final-newline
 * changes are ordinary content changes.
 */
function lineTokens(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** Eligibility shared by merging and recovery's conditional-write baseline. */
export function mergeInputSkipReason(
  content: string,
): ThreeWayMergeSkipReason | null {
  if (content.includes('\0')) return 'binary';
  if (
    content.length > THREE_WAY_MERGE_MAX_BYTES ||
    utf8Bytes(content) > THREE_WAY_MERGE_MAX_BYTES ||
    lineTokens(content).length > THREE_WAY_MERGE_MAX_LINES
  )
    return 'too-large';
  return null;
}

function sameTokens(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

/** Matching line pairs between two middles × the shorter middle. */
function estimatedLcsWork(
  base: readonly string[],
  side: readonly string[],
): number {
  const counts = new Map<string, number>();
  for (const token of base) counts.set(token, (counts.get(token) ?? 0) + 1);
  let pairs = 0;
  for (const token of side) pairs += counts.get(token) ?? 0;
  return pairs * Math.min(base.length, side.length);
}

/** One side's lines of an unstable region and where they start (0-based). */
interface RegionSide {
  readonly tokens: readonly string[];
  readonly start: number;
}

/**
 * True when every changed line of `side` replaces the base line at the same
 * position: no changed line also appears elsewhere in the other's region, so
 * moves, shifts, and repeated-line matches are excluded.
 */
function replacesInPlace(
  base: readonly string[],
  side: readonly string[],
): boolean {
  const baseSet = new Set(base);
  const sideSet = new Set(side);
  return side.every(
    (token, position) =>
      token === base[position] ||
      (!baseSet.has(token) && !sideSet.has(base[position] ?? '')),
  );
}

/**
 * Splits an unstable region whose three sides each replace the same lines in
 * place into its maximal runs of conflicting lines; every other line merges
 * on its own (identical, or changed by one side only). Regions with unequal
 * line counts or ambiguous alignment come back whole.
 */
function refineRegion(
  o: RegionSide,
  a: RegionSide,
  b: RegionSide,
  nextIndex: number,
): Segment[] {
  const whole = (): Segment[] => [
    {
      kind: 'conflict',
      region: conflictRegion(nextIndex, o, a, b, 0, o.tokens.length, true),
    },
  ];
  const length = o.tokens.length;
  if (
    length === 0 ||
    a.tokens.length !== length ||
    b.tokens.length !== length ||
    !replacesInPlace(o.tokens, a.tokens) ||
    !replacesInPlace(o.tokens, b.tokens)
  ) {
    return whole();
  }
  const segments: Segment[] = [];
  let index = nextIndex;
  let runStart: number | null = null;
  const closeRun = (end: number): void => {
    if (runStart === null) return;
    segments.push({
      kind: 'conflict',
      region: conflictRegion(index, o, a, b, runStart, end, false),
    });
    index += 1;
    runStart = null;
  };
  for (let position = 0; position < length; position += 1) {
    const baseLine = o.tokens[position] ?? '';
    const ours = a.tokens[position] ?? '';
    const theirs = b.tokens[position] ?? '';
    if (ours === theirs || theirs === baseLine) {
      closeRun(position);
      segments.push({ kind: 'merged', tokens: [ours] });
    } else if (ours === baseLine) {
      closeRun(position);
      segments.push({ kind: 'merged', tokens: [theirs] });
    } else {
      runStart ??= position;
    }
  }
  closeRun(length);
  return segments;
}

/**
 * The passage covering `[from, to)` of an unstable region. A whole region
 * keeps each side's own extent; a refined run spans the same lines on every
 * side.
 */
function conflictRegion(
  index: number,
  o: RegionSide,
  a: RegionSide,
  b: RegionSide,
  from: number,
  to: number,
  whole: boolean,
): OverlapRegion {
  const part = (side: RegionSide): readonly string[] =>
    whole ? side.tokens : side.tokens.slice(from, to);
  const range = (side: RegionSide): OverlapLineRange => ({
    line: side.start + from + 1,
    lineCount: part(side).length,
  });
  return {
    index,
    base: part(o).join(''),
    ours: part(a).join(''),
    theirs: part(b).join(''),
    baseLines: range(o),
    oursLines: range(a),
    theirsLines: range(b),
  };
}

/**
 * The one guarded region walk behind merging, analysis, and resolution.
 * Lines shared by all three at either end are stable; only the rest is
 * diffed, so typical small edits stay cheap regardless of file size.
 * Region coordinates include the trimmed prefix. Unstable regions that
 * replace lines in place are refined line by line (see `refineRegion`), so
 * analysis and resolution see the same passages and indices.
 */
function walkThreeWay(base: string, ours: string, theirs: string): Walk {
  for (const input of [base, ours, theirs]) {
    const reason = mergeInputSkipReason(input);
    if (reason !== null) return { kind: 'skipped', reason };
  }
  if (ours === theirs || theirs === base) {
    return { kind: 'segments', segments: [{ kind: 'merged', tokens: [ours] }] };
  }
  if (ours === base) {
    return {
      kind: 'segments',
      segments: [{ kind: 'merged', tokens: [theirs] }],
    };
  }
  const o = lineTokens(base);
  const a = lineTokens(ours);
  const b = lineTokens(theirs);

  let prefix = 0;
  const shortest = Math.min(o.length, a.length, b.length);
  while (
    prefix < shortest &&
    o[prefix] === a[prefix] &&
    o[prefix] === b[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    o[o.length - 1 - suffix] === a[a.length - 1 - suffix] &&
    o[o.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oMid = o.slice(prefix, o.length - suffix);
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (
    estimatedLcsWork(oMid, aMid) > THREE_WAY_MERGE_MAX_WORK ||
    estimatedLcsWork(oMid, bMid) > THREE_WAY_MERGE_MAX_WORK
  ) {
    return { kind: 'skipped', reason: 'too-complex' };
  }

  const segments: Segment[] = [{ kind: 'merged', tokens: o.slice(0, prefix) }];
  let index = 0;
  for (const region of diff3MergeRegions(aMid, oMid, bMid)) {
    if (region.stable) {
      segments.push({ kind: 'merged', tokens: region.bufferContent });
      continue;
    }
    const { aContent, oContent, bContent } = region;
    if (sameTokens(aContent, bContent) || sameTokens(bContent, oContent)) {
      segments.push({ kind: 'merged', tokens: aContent });
    } else if (sameTokens(aContent, oContent)) {
      segments.push({ kind: 'merged', tokens: bContent });
    } else {
      for (const segment of refineRegion(
        { tokens: oContent, start: prefix + region.oStart },
        { tokens: aContent, start: prefix + region.aStart },
        { tokens: bContent, start: prefix + region.bStart },
        index,
      )) {
        segments.push(segment);
        if (segment.kind === 'conflict') index += 1;
      }
    }
  }
  segments.push({ kind: 'merged', tokens: o.slice(o.length - suffix) });
  return { kind: 'segments', segments };
}

/** Join merged segments, applying `pick` to each passage; guards the output. */
function joinSegments(
  segments: readonly Segment[],
  pick: (region: OverlapRegion) => string,
):
  | { readonly kind: 'clean'; readonly content: string }
  | { readonly kind: 'skipped'; readonly reason: 'output-too-large' } {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'merged') parts.push(...segment.tokens);
    else parts.push(pick(segment.region));
  }
  const content = parts.join('');
  if (utf8Bytes(content) > THREE_WAY_MERGE_MAX_BYTES) {
    return { kind: 'skipped', reason: 'output-too-large' };
  }
  return { kind: 'clean', content };
}

function conflictRegions(segments: readonly Segment[]): OverlapRegion[] {
  const regions: OverlapRegion[] = [];
  for (const segment of segments) {
    if (segment.kind === 'conflict') regions.push(segment.region);
  }
  return regions;
}

/**
 * Line-level three-way analysis of `ours` and `theirs`, both derived from
 * `base`. Disjoint and identical changes merge cleanly; different changes to
 * the same or adjacent lines become ordered passages, each with both sides'
 * complete wording. Where all three replace the same lines in place, a
 * passage narrows to each run of lines both sides changed differently and
 * the lines between merge; otherwise it covers the whole overlap. Never
 * normalizes line terminators.
 */
export function analyzeThreeWay(
  base: string,
  ours: string,
  theirs: string,
): ThreeWayAnalysis {
  const walk = walkThreeWay(base, ours, theirs);
  if (walk.kind === 'skipped') return walk;
  const regions = conflictRegions(walk.segments);
  if (regions.length > 0) return { kind: 'conflicts', regions };
  return joinSegments(walk.segments, (region) => region.ours);
}

/**
 * Merge `base`/`ours`/`theirs` with one choice per overlapping passage, in
 * passage order. Rejects missing, extra, or invalid choices rather than
 * resolving partially or guessing.
 */
export function resolveOverlaps(
  base: string,
  ours: string,
  theirs: string,
  choices: readonly OverlapChoice[],
): OverlapResolution {
  const walk = walkThreeWay(base, ours, theirs);
  if (walk.kind === 'skipped') return walk;
  const regions = conflictRegions(walk.segments);
  if (
    choices.length !== regions.length ||
    choices.some((choice) => choice !== 'ours' && choice !== 'theirs')
  ) {
    return { kind: 'invalid' };
  }
  const result = joinSegments(walk.segments, (region) =>
    choices[region.index] === 'theirs' ? region.theirs : region.ours,
  );
  return result.kind === 'clean'
    ? { kind: 'resolved', content: result.content }
    : result;
}
