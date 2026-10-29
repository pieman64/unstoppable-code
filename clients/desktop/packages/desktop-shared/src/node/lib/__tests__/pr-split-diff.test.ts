import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DiffFileEntry,
  PrDiffSnapshot,
  SplitPlanChild,
} from '../../../types/github';
import {
  buildPatchFromRuns,
  computeChildBaseDiffU0,
  computeHunkIdentity,
  gatherPrDiffSnapshot,
  matchRunsToOriginalHunks,
  parseUnifiedDiff,
  planChildCarve,
  type HunkRun,
} from '../pr-split-diff';

// ---------------------------------------------------------------------------
// parseUnifiedDiff — file classification
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff — classification', () => {
  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n')).toEqual([]);
  });

  it('parses a modified file with one hunk', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1111111..2222222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file.path).toBe('src/foo.ts');
    expect(file.kind).toBe('modified');
    expect(file.isBinary).toBe(false);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].header).toBe('@@ -1,3 +1,3 @@');
    expect(file.hunks[0].hunkIndex).toBe(0);
    expect(file.hunks[0].additions).toBe(1);
    expect(file.hunks[0].deletions).toBe(1);
    // coreLines carries only the +/- lines (context excluded, prefixes kept).
    expect(file.hunks[0].coreLines).toEqual(['-const b = 2;', '+const b = 3;']);
  });

  it('parses an added file', () => {
    const diff = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..89b24ec',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('new.txt');
    expect(file.kind).toBe('added');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.oldPath).toBeUndefined();
  });

  it('parses a deleted file', () => {
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 89b24ec..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('gone.txt');
    expect(file.kind).toBe('deleted');
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
  });

  it('parses a rename with a content hunk', () => {
    const diff = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      'index 1111111..2222222 100644',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1,2 +1,2 @@',
      ' unchanged',
      '-old body',
      '+new body',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.kind).toBe('renamed');
    expect(file.path).toBe('new/name.ts');
    expect(file.oldPath).toBe('old/name.ts');
    expect(file.hunks).toHaveLength(1);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it('parses a pure rename with no content hunk', () => {
    const diff = [
      'diff --git a/a.txt b/b.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to b.txt',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.kind).toBe('renamed');
    expect(file.path).toBe('b.txt');
    expect(file.oldPath).toBe('a.txt');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it('parses a binary file diff (GIT binary patch)', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 8',
      'zcmZ',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.isBinary).toBe(true);
    expect(file.path).toBe('img.png');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it('parses a binary file diff (Binary files ... differ)', () => {
    const diff = [
      'diff --git a/logo.jpg b/logo.jpg',
      'index 1111111..2222222 100644',
      'Binary files a/logo.jpg and b/logo.jpg differ',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.isBinary).toBe(true);
    expect(file.hunks).toHaveLength(0);
  });

  it('parses a mode-only change (no hunks)', () => {
    const diff = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('script.sh');
    expect(file.kind).toBe('modified');
    expect(file.hunks).toHaveLength(0);
    expect(file.isBinary).toBe(false);
  });

  it('parses multiple files in one stream', () => {
    const diff = [
      'diff --git a/one.txt b/one.txt',
      'index 1111111..2222222 100644',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      'diff --git a/two.txt b/two.txt',
      'index 3333333..4444444 100644',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1 +1 @@',
      '-two',
      '+TWO',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['one.txt', 'two.txt']);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1].hunks).toHaveLength(1);
  });

  it('keeps "\\ No newline at end of file" attached to its hunk body', () => {
    const diff = [
      'diff --git a/nonl.txt b/nonl.txt',
      'index 1111111..2222222 100644',
      '--- a/nonl.txt',
      '+++ b/nonl.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.hunks).toHaveLength(1);
    // additions/deletions must not count the "\ No newline" marker
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    // coreLines keeps the markers attached to their +/- lines so U0 run bodies
    // survive serialization, while the hash invariant still holds.
    expect(file.hunks[0].coreLines).toEqual([
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ]);
    expect(computeHunkIdentity(file.hunks[0].coreLines)).toBe(
      file.hunks[0].contentHash,
    );
  });

  it('handles omitted ,count in @@ header (count defaults to 1)', () => {
    const diff = [
      'diff --git a/x.txt b/x.txt',
      'index 1111111..2222222 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -5 +5 @@ ctx',
      '-old',
      '+new',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.hunks[0].header).toBe('@@ -5 +5 @@ ctx');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeHunkIdentity — hashing + occurrenceIndex
// ---------------------------------------------------------------------------

describe('computeHunkIdentity + contentHash / occurrenceIndex', () => {
  it('hashes only +/- lines (context and @@ excluded), keeping prefixes', () => {
    const body = [' ctx a', '-old', '+new', ' ctx b'];
    const expected = createHash('sha256')
      .update(['-old', '+new'].join('\n'))
      .digest('hex');
    expect(computeHunkIdentity(body)).toBe(expected);
  });

  it('is stable under line-number drift (same edit at different line numbers)', () => {
    const early = [
      'diff --git a/f.ts b/f.ts',
      'index 1111111..2222222 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n');
    const late = [
      'diff --git a/f.ts b/f.ts',
      'index 1111111..2222222 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -50,3 +50,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n');
    const [earlyFile] = parseUnifiedDiff(early);
    const [lateFile] = parseUnifiedDiff(late);
    expect(earlyFile.hunks[0].contentHash).toBe(lateFile.hunks[0].contentHash);
  });

  it('assigns occurrenceIndex 0,1,2 to identical-content hunks in file order', () => {
    const diff = [
      'diff --git a/dup.txt b/dup.txt',
      'index 1111111..2222222 100644',
      '--- a/dup.txt',
      '+++ b/dup.txt',
      '@@ -1,3 +1,3 @@',
      ' head',
      '-x',
      '+y',
      ' tail',
      '@@ -20,3 +20,3 @@',
      ' head',
      '-x',
      '+y',
      ' tail',
      '@@ -40,3 +40,3 @@',
      ' head',
      '-x',
      '+y',
      ' tail',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file.hunks).toHaveLength(3);
    const hashes = file.hunks.map((h) => h.contentHash);
    expect(new Set(hashes).size).toBe(1);
    expect(file.hunks.map((h) => h.occurrenceIndex)).toEqual([0, 1, 2]);
  });

  it('resets occurrenceIndex per distinct content', () => {
    const diff = [
      'diff --git a/mix.txt b/mix.txt',
      'index 1111111..2222222 100644',
      '--- a/mix.txt',
      '+++ b/mix.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -10,1 +10,1 @@',
      '-b',
      '+B',
      '@@ -20,1 +20,1 @@',
      '-a',
      '+A',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    // hunk0 (a->A) occ 0, hunk1 (b->B) occ 0, hunk2 (a->A) occ 1
    expect(file.hunks.map((h) => h.occurrenceIndex)).toEqual([0, 0, 1]);
    expect(file.hunks[0].contentHash).toBe(file.hunks[2].contentHash);
    expect(file.hunks[0].contentHash).not.toBe(file.hunks[1].contentHash);
  });
});

// ---------------------------------------------------------------------------
// matchRunsToOriginalHunks
// ---------------------------------------------------------------------------

/** Simulates the IPC serialization boundary the snapshot crosses. */
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function u0File(path: string, ...hunks: string[]): DiffFileEntry {
  return parseUnifiedDiff(
    [
      `diff --git a/${path} b/${path}`,
      `index 1111111..2222222 100644`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...hunks,
      '',
    ].join('\n'),
  )[0];
}

describe('matchRunsToOriginalHunks', () => {
  it('matches a single U0 run to a single U3 hunk exactly', () => {
    const original = u0File('f.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c');
    const recomputed = u0File('f.ts', '@@ -2,1 +2,1 @@', '-b', '+B');
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].ownerHunkIndex).toBe(0);
    }
  });

  it('matches despite drifted line numbers (identity by content, not numbers)', () => {
    const original = u0File(
      'f.ts',
      '@@ -100,3 +100,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    );
    // recomputed against a different base — line numbers differ
    const recomputed = u0File('f.ts', '@@ -7,1 +7,1 @@', '-b', '+B');
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs[0].ownerHunkIndex).toBe(0);
    }
  });

  it('decomposes one U3 hunk into several U0 runs (context inside U3 separates them)', () => {
    // One U3 hunk with two edit regions separated by context.
    const original = u0File(
      'f.ts',
      '@@ -1,6 +1,6 @@',
      ' ctx1',
      '-x',
      '+X',
      ' ctx2',
      '-y',
      '+Y',
      ' ctx3',
    );
    // U0 recompute yields TWO runs, both owned by original hunk 0.
    const recomputed = u0File(
      'f.ts',
      '@@ -2,1 +2,1 @@',
      '-x',
      '+X',
      '@@ -5,1 +5,1 @@',
      '-y',
      '+Y',
    );
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs.map((r) => r.ownerHunkIndex)).toEqual([0, 0]);
    }
  });

  it('uses a greedy cursor to disambiguate identical runs across two U3 hunks', () => {
    // Two separate U3 hunks with identical content.
    const original = u0File(
      'f.ts',
      '@@ -1,3 +1,3 @@',
      ' p',
      '-a',
      '+A',
      ' q',
      '@@ -30,3 +30,3 @@',
      ' p',
      '-a',
      '+A',
      ' q',
    );
    const recomputed = u0File(
      'f.ts',
      '@@ -2,1 +2,1 @@',
      '-a',
      '+A',
      '@@ -31,1 +31,1 @@',
      '-a',
      '+A',
    );
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // First run -> hunk 0, second run -> hunk 1 (cursor advances).
      expect(result.runs.map((r) => r.ownerHunkIndex)).toEqual([0, 1]);
    }
  });

  it('matches on JSON-round-tripped entries (snapshot survives IPC serialization)', () => {
    // The PrDiffSnapshot round-trips through IPC: Phase A returns it to the
    // renderer and Phase B receives it back before carve-time matching, so
    // matching must work on structured-clone/JSON reloaded objects.
    const original = u0File(
      'f.ts',
      '@@ -1,6 +1,6 @@',
      ' ctx1',
      '-x',
      '+X',
      ' ctx2',
      '-y',
      '+Y',
      ' ctx3',
    );
    const recomputed = u0File(
      'f.ts',
      '@@ -2,1 +2,1 @@',
      '-x',
      '+X',
      '@@ -5,1 +5,1 @@',
      '-y',
      '+Y',
    );
    const reloadedOriginal = jsonRoundTrip(original);
    const reloadedRecomputed = jsonRoundTrip(recomputed);
    const result = matchRunsToOriginalHunks(
      reloadedRecomputed,
      reloadedOriginal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs.map((r) => r.ownerHunkIndex)).toEqual([0, 0]);
      // The reloaded runs still assemble a patch with real body lines.
      const patch = buildPatchFromRuns('f.ts', undefined, result.runs);
      expect(patch).toContain('-x');
      expect(patch).toContain('+Y');
    }
  });

  it('fails with unmatched-run when a run matches no original hunk', () => {
    const original = u0File('f.ts', '@@ -1,1 +1,1 @@', '-a', '+A');
    const recomputed = u0File('f.ts', '@@ -1,1 +1,1 @@', '-z', '+Z');
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unmatched-run');
      expect(result.file).toBe('f.ts');
    }
  });

  it('fails with ambiguous-run when a run would span two original hunks', () => {
    // Two distinct U3 hunks. A single recomputed run that concatenates lines
    // from both cannot be owned by one original hunk.
    const original = u0File(
      'f.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      '@@ -20,2 +20,2 @@',
      '-b',
      '+B',
    );
    const recomputed = u0File(
      'f.ts',
      '@@ -1,4 +1,4 @@',
      '-a',
      '+A',
      '-b',
      '+B',
    );
    const result = matchRunsToOriginalHunks(recomputed, original);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous-run');
    }
  });
});

// ---------------------------------------------------------------------------
// buildPatchFromRuns
// ---------------------------------------------------------------------------

describe('buildPatchFromRuns', () => {
  it('emits headers and body for a single selected run', () => {
    const run: HunkRun = {
      header: '@@ -2,1 +2,1 @@',
      bodyLines: ['-b', '+B'],
      ownerHunkIndex: 0,
    };
    const patch = buildPatchFromRuns('f.ts', undefined, [run]);
    expect(patch.startsWith('--- a/f.ts\n+++ b/f.ts\n')).toBe(true);
    expect(patch).toContain('@@ -2,1 +2,1 @@');
    expect(patch).toContain('-b');
    expect(patch).toContain('+B');
  });

  it('uses oldPath for the a/ header on renames', () => {
    const run: HunkRun = {
      header: '@@ -1,1 +1,1 @@',
      bodyLines: ['-x', '+y'],
      ownerHunkIndex: 0,
    };
    const patch = buildPatchFromRuns('new.ts', 'old.ts', [run]);
    expect(patch.startsWith('--- a/old.ts\n+++ b/new.ts\n')).toBe(true);
  });

  it('re-offsets new-side start by cumulative delta of PRIOR selected runs only', () => {
    // Run 1: pure insertion of 2 lines at old line 10 -> new side @@ -10,0 +11,2
    // Run 2: modify at old line 50. New start must shift by +2 (from run 1).
    const run1: HunkRun = {
      header: '@@ -10,0 +11,2 @@',
      bodyLines: ['+new1', '+new2'],
      ownerHunkIndex: 0,
    };
    const run2: HunkRun = {
      header: '@@ -50,1 +52,1 @@',
      bodyLines: ['-old', '+mod'],
      ownerHunkIndex: 1,
    };
    const patch = buildPatchFromRuns('f.ts', undefined, [run1, run2]);
    // Run 1 keeps its own new start; run 2 re-offset by +2 delta from run1.
    expect(patch).toContain('@@ -10,0 +11,2 @@');
    // old 50 with cumulative +2 => new start 52
    expect(patch).toContain('@@ -50,1 +52,1 @@');
  });

  it('excludes skipped-run deltas when re-offsetting (selected only)', () => {
    // Suppose upstream there was an insertion between these two, but it is NOT
    // selected. The second selected run must NOT absorb the skipped delta.
    // run A: modify at old 5 (delta 0). run B: modify at old 40.
    // With ONLY these two selected, run B new start == old start (no prior delta).
    const runA: HunkRun = {
      header: '@@ -5,1 +5,1 @@',
      bodyLines: ['-a', '+A'],
      ownerHunkIndex: 0,
    };
    const runB: HunkRun = {
      header: '@@ -40,1 +40,1 @@',
      bodyLines: ['-b', '+B'],
      ownerHunkIndex: 2,
    };
    const patch = buildPatchFromRuns('f.ts', undefined, [runA, runB]);
    expect(patch).toContain('@@ -5,1 +5,1 @@');
    // runA delta = 0 (1 add - 1 del), so runB new start stays 40.
    expect(patch).toContain('@@ -40,1 +40,1 @@');
  });

  it('handles pure-insertion header (-N,0) and pure-deletion header (+N,0)', () => {
    const insert: HunkRun = {
      header: '@@ -3,0 +4,2 @@',
      bodyLines: ['+ins1', '+ins2'],
      ownerHunkIndex: 0,
    };
    const del: HunkRun = {
      header: '@@ -10,2 +11,0 @@',
      bodyLines: ['-del1', '-del2'],
      ownerHunkIndex: 1,
    };
    const patch = buildPatchFromRuns('f.ts', undefined, [insert, del]);
    // insertion: 2 adds. pure insertion new start = oldStart(3) + prior(0) + 1 = 4.
    expect(patch).toContain('@@ -3,0 +4,2 @@');
    // deletion new-side is a zero-count range; pure deletion anchor =
    // oldStart(10) + priorDelta(2, from insertion) - 1 = 11.
    expect(patch).toContain('@@ -10,2 +11,0 @@');
  });

  it('re-offsets accumulating add and delete deltas across three runs', () => {
    const r1: HunkRun = {
      header: '@@ -1,0 +2,3 @@',
      bodyLines: ['+a', '+b', '+c'],
      ownerHunkIndex: 0,
    };
    const r2: HunkRun = {
      header: '@@ -10,2 +13,0 @@',
      bodyLines: ['-d', '-e'],
      ownerHunkIndex: 1,
    };
    const r3: HunkRun = {
      header: '@@ -20,1 +22,1 @@',
      bodyLines: ['-f', '+F'],
      ownerHunkIndex: 2,
    };
    const patch = buildPatchFromRuns('f.ts', undefined, [r1, r2, r3]);
    // r1 pure insertion: oldStart 1 + prior 0 + 1 = 2.
    expect(patch).toContain('@@ -1,0 +2,3 @@');
    // r2: prior delta +3, pure deletion -> new start 10 + 3 - 1 = 12, +12,0
    expect(patch).toContain('@@ -10,2 +12,0 @@');
    // r3: prior delta = +3 (r1) + (-2) (r2) = +1, old20 -> new21
    expect(patch).toContain('@@ -20,1 +21,1 @@');
  });
});

// ---------------------------------------------------------------------------
// planChildCarve
// ---------------------------------------------------------------------------

function snapshotWith(files: DiffFileEntry[]): PrDiffSnapshot {
  return {
    baseRef: 'base',
    headRef: 'head',
    files,
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

describe('planChildCarve', () => {
  it('classifies whole-file vs hunk-split, carrying kind/oldPath', () => {
    const snapshot = snapshotWith([
      {
        path: 'whole.ts',
        kind: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
      {
        path: 'new/name.ts',
        oldPath: 'old/name.ts',
        kind: 'renamed',
        isBinary: false,
        additions: 1,
        deletions: 1,
        hunks: [],
      },
      {
        path: 'split.ts',
        kind: 'modified',
        isBinary: false,
        additions: 3,
        deletions: 3,
        hunks: [],
      },
    ]);
    const child: SplitPlanChild = {
      index: 1,
      title: 'feat: x',
      type: 'feature',
      dependsOn: [],
      changes: [
        { file: 'whole.ts', hunks: 'all' },
        { file: 'new/name.ts', hunks: 'all' },
        { file: 'split.ts', hunks: [0, 2] },
      ],
      renames: [],
      testProof: '',
      risk: 'low',
      rationale: '',
    };
    const plan = planChildCarve(child, snapshot);
    expect(plan.wholeFiles).toEqual([
      { path: 'whole.ts', kind: 'modified', oldPath: undefined },
      { path: 'new/name.ts', kind: 'renamed', oldPath: 'old/name.ts' },
    ]);
    expect(plan.hunkFiles).toEqual([
      { path: 'split.ts', ownedHunkIndices: [0, 2] },
    ]);
  });

  it('treats a binary file as whole-owned even if hunks listed', () => {
    const snapshot = snapshotWith([
      {
        path: 'img.png',
        kind: 'modified',
        isBinary: true,
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    ]);
    const child: SplitPlanChild = {
      index: 1,
      title: 'feat: bin',
      type: 'feature',
      dependsOn: [],
      changes: [{ file: 'img.png', hunks: 'all' }],
      renames: [],
      testProof: '',
      risk: 'low',
      rationale: '',
    };
    const plan = planChildCarve(child, snapshot);
    expect(plan.wholeFiles).toEqual([
      { path: 'img.png', kind: 'modified', oldPath: undefined },
    ]);
    expect(plan.hunkFiles).toEqual([]);
  });

  it.each(['added', 'deleted', 'renamed'] as const)(
    'treats a %s file as whole-owned even if hunks are listed',
    (kind) => {
      const path = kind === 'renamed' ? 'new/name.ts' : `${kind}.ts`;
      const snapshot = snapshotWith([
        {
          path,
          oldPath: kind === 'renamed' ? 'old/name.ts' : undefined,
          kind,
          isBinary: false,
          additions: kind === 'deleted' ? 0 : 1,
          deletions: kind === 'added' ? 0 : 1,
          hunks: [],
        },
      ]);
      const child: SplitPlanChild = {
        index: 1,
        title: 'feat: file lifecycle',
        type: 'feature',
        dependsOn: [],
        changes: [{ file: path, hunks: [0] }],
        renames: [],
        testProof: '',
        risk: 'low',
        rationale: '',
      };

      const plan = planChildCarve(child, snapshot);
      expect(plan.wholeFiles).toEqual([
        {
          path,
          kind,
          oldPath: kind === 'renamed' ? 'old/name.ts' : undefined,
        },
      ]);
      expect(plan.hunkFiles).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// git-running composition (mocked runner)
// ---------------------------------------------------------------------------

describe('gatherPrDiffSnapshot + computeChildBaseDiffU0 (mocked git)', () => {
  it('composes numstat + name-status + per-file U3 diff into a snapshot', async () => {
    const calls: string[][] = [];
    const runner = (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.includes('--numstat')) {
        return Promise.resolve('1\t1\tsrc/foo.ts\n-\t-\timg.png\n');
      }
      if (args.includes('--name-status')) {
        return Promise.resolve('M\tsrc/foo.ts\nM\timg.png\n');
      }
      // per-file diff
      if (args.includes('src/foo.ts')) {
        return Promise.resolve(
          [
            'diff --git a/src/foo.ts b/src/foo.ts',
            'index 1111111..2222222 100644',
            '--- a/src/foo.ts',
            '+++ b/src/foo.ts',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
            '',
          ].join('\n'),
        );
      }
      if (args.includes('img.png')) {
        return Promise.resolve(
          [
            'diff --git a/img.png b/img.png',
            'index 1111111..2222222 100644',
            'Binary files a/img.png and b/img.png differ',
            '',
          ].join('\n'),
        );
      }
      return Promise.resolve('');
    };
    const snapshot = await gatherPrDiffSnapshot('/repo', 'base', 'head', {
      run: runner,
    });
    expect(snapshot.baseRef).toBe('base');
    expect(snapshot.headRef).toBe('head');
    expect(snapshot.files).toHaveLength(2);
    const foo = snapshot.files.find((f) => f.path === 'src/foo.ts');
    expect(foo?.isBinary).toBe(false);
    expect(foo?.hunks).toHaveLength(1);
    const img = snapshot.files.find((f) => f.path === 'img.png');
    expect(img?.isBinary).toBe(true);
    expect(snapshot.totalAdditions).toBe(1);
    expect(snapshot.totalDeletions).toBe(1);
  });

  it('detects renames from name-status R### rows', async () => {
    const perFileCalls: string[][] = [];
    const runner = (args: string[]): Promise<string> => {
      if (!args.includes('--numstat') && !args.includes('--name-status')) {
        perFileCalls.push(args);
      }
      if (args.includes('--numstat')) {
        return Promise.resolve('1\t1\told.ts => new.ts\n');
      }
      if (args.includes('--name-status')) {
        return Promise.resolve('R096\told.ts\tnew.ts\n');
      }
      return Promise.resolve(
        [
          'diff --git a/old.ts b/new.ts',
          'similarity index 96%',
          'rename from old.ts',
          'rename to new.ts',
          'index 1111111..2222222 100644',
          '--- a/old.ts',
          '+++ b/new.ts',
          '@@ -1,1 +1,1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      );
    };
    const snapshot = await gatherPrDiffSnapshot('/repo', 'base', 'head', {
      run: runner,
    });
    const file = snapshot.files.find((f) => f.path === 'new.ts');
    expect(file?.kind).toBe('renamed');
    expect(file?.oldPath).toBe('old.ts');
    // The per-file diff must include BOTH old and new paths in the pathspec so
    // git detects the rename instead of reporting a spurious add/delete.
    expect(perFileCalls).toHaveLength(1);
    expect(perFileCalls[0]).toContain('old.ts');
    expect(perFileCalls[0]).toContain('new.ts');
  });

  it('produces a git-applyable patch round-tripping real U0 output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopy-carve-'));
    try {
      const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t.com']);
      git(['config', 'user.name', 't']);
      const base = Array.from({ length: 30 }, (_, i) => String(i + 1)).join(
        '\n',
      );
      writeFileSync(join(dir, 'f.txt'), `${base}\n`);
      git(['add', 'f.txt']);
      git(['commit', '-qm', 'base']);
      // insertion after line1, deletion of 10/11, modification of 20
      const head = [
        '1',
        'a',
        'b',
        'c',
        ...Array.from({ length: 8 }, (_, i) => String(i + 2)),
        '12',
        ...Array.from({ length: 7 }, (_, i) => String(i + 13)),
        'TWENTY',
        ...Array.from({ length: 10 }, (_, i) => String(i + 21)),
      ].join('\n');
      writeFileSync(join(dir, 'f.txt'), `${head}\n`);

      const u0 = git([
        'diff',
        '--no-renames',
        '--unified=0',
        '--no-color',
        'f.txt',
      ]);
      const [file] = parseUnifiedDiff(u0);
      expect(file.hunks).toHaveLength(3);
      // Match runs against the same file (original == recomputed for round-trip).
      const match = matchRunsToOriginalHunks(file, file);
      expect(match.ok).toBe(true);
      if (!match.ok) {
        return;
      }
      const body = buildPatchFromRuns(file.path, file.oldPath, match.runs);
      const patch = `diff --git a/f.txt b/f.txt\n${body}`;

      // Reset the working tree to base, then apply the rebuilt patch.
      git(['checkout', '-q', '--', 'f.txt']);
      writeFileSync(join(dir, 'rebuilt.patch'), patch);
      // git apply must accept the reconstructed --unified=0 patch cleanly.
      git(['apply', '--unidiff-zero', join(dir, 'rebuilt.patch')]);
      expect(git(['diff', '--no-color', 'f.txt'])).toContain('+TWENTY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computeChildBaseDiffU0 runs --no-renames --unified=0 and parses runs', async () => {
    const calls: string[][] = [];
    const runner = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve(
        [
          'diff --git a/f.ts b/f.ts',
          'index 1111111..2222222 100644',
          '--- a/f.ts',
          '+++ b/f.ts',
          '@@ -2,1 +2,1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      );
    };
    const files = await computeChildBaseDiffU0(
      '/repo',
      'childBase',
      'head',
      ['f.ts'],
      { run: runner },
    );
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(1);
    expect(calls[0]).toContain('--no-renames');
    expect(calls[0]).toContain('--unified=0');
    expect(calls[0]).toContain('f.ts');
  });
});
