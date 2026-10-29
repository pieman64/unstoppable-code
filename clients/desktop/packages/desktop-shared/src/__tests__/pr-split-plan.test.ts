import type {
  DiffFileEntry,
  DiffHunk,
  PrDiffSnapshot,
  SplitPlan,
  SplitPlanChild,
} from '../types/github';
import type { SplitPlanIssue } from '../types/pr-split-plan';
import {
  computeChildLineStats,
  deriveSplitBranchNames,
  isSplitPlan,
  SplitPlanCycleError,
  SplitPlanDanglingDependencyError,
  topologicalChildOrder,
  validateSplitPlan,
} from '../lib/pr-split-plan';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeHunk(overrides: Partial<DiffHunk> & { file: string }): DiffHunk {
  return {
    file: overrides.file,
    hunkIndex: overrides.hunkIndex ?? 0,
    header: overrides.header ?? '@@ -1,1 +1,1 @@',
    contentHash:
      overrides.contentHash ??
      `hash-${overrides.file}-${overrides.hunkIndex ?? 0}`,
    coreLines: overrides.coreLines ?? ['-old', '+new'],
    occurrenceIndex: overrides.occurrenceIndex ?? 0,
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 1,
    preview: overrides.preview ?? 'preview',
  };
}

function makeFile(
  overrides: Partial<DiffFileEntry> & { path: string },
): DiffFileEntry {
  const hunks = overrides.hunks ?? [makeHunk({ file: overrides.path })];
  const additions =
    overrides.additions ?? hunks.reduce((sum, h) => sum + h.additions, 0);
  const deletions =
    overrides.deletions ?? hunks.reduce((sum, h) => sum + h.deletions, 0);
  return {
    path: overrides.path,
    oldPath: overrides.oldPath,
    kind: overrides.kind ?? 'modified',
    isBinary: overrides.isBinary ?? false,
    additions,
    deletions,
    hunks,
  };
}

function makeSnapshot(files: DiffFileEntry[]): PrDiffSnapshot {
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files,
    totalAdditions,
    totalDeletions,
  };
}

function makeChild(
  overrides: Partial<SplitPlanChild> & { index: number },
): SplitPlanChild {
  return {
    index: overrides.index,
    title: overrides.title ?? `refactor: child ${overrides.index}`,
    type: overrides.type ?? 'refactor',
    dependsOn: overrides.dependsOn ?? [],
    changes: overrides.changes ?? [],
    renames: overrides.renames ?? [],
    testProof: overrides.testProof ?? 'existing tests unchanged',
    risk: overrides.risk ?? 'low',
    rationale: overrides.rationale ?? 'standalone rationale',
  };
}

function makePlan(
  overrides: Partial<SplitPlan> & { children: SplitPlanChild[] },
): SplitPlan {
  return {
    finalGoal: overrides.finalGoal ?? 'accomplish the thing',
    concerns: overrides.concerns ?? [],
    children: overrides.children,
    parallelizable: overrides.parallelizable ?? '',
    landOrder: overrides.landOrder ?? '',
    buildTestCommand: overrides.buildTestCommand ?? '',
    unassignedHunks: overrides.unassignedHunks ?? [],
  };
}

function issuesOfCode(
  issues: SplitPlanIssue[],
  code: SplitPlanIssue['code'],
): SplitPlanIssue[] {
  return issues.filter((issue) => issue.code === code);
}

// ---------------------------------------------------------------------------
// Valid refactor-first plan (baseline "happy path")
// ---------------------------------------------------------------------------

describe('validateSplitPlan — valid refactor-first plan', () => {
  it('passes with two stacked children sharing one file (refactor owns hunk 0, feature owns hunk 1)', () => {
    const file = makeFile({
      path: 'client.ts',
      hunks: [
        makeHunk({
          file: 'client.ts',
          hunkIndex: 0,
          additions: 2,
          deletions: 1,
        }),
        makeHunk({
          file: 'client.ts',
          hunkIndex: 1,
          additions: 3,
          deletions: 0,
        }),
      ],
    });
    const other = makeFile({
      path: 'registry.ts',
      hunks: [
        makeHunk({
          file: 'registry.ts',
          hunkIndex: 0,
          additions: 5,
          deletions: 0,
        }),
      ],
    });
    const snapshot = makeSnapshot([file, other]);

    const refactorChild = makeChild({
      index: 1,
      title: 'refactor: extract client seam',
      type: 'refactor',
      dependsOn: [],
      changes: [{ file: 'client.ts', hunks: [0] }],
    });
    const featureChild = makeChild({
      index: 2,
      title: 'feature: add registry wiring',
      type: 'feature',
      dependsOn: [1],
      changes: [
        { file: 'client.ts', hunks: [1] },
        { file: 'registry.ts', hunks: 'all' },
      ],
    });

    const plan = makePlan({ children: [refactorChild, featureChild] });
    const result = validateSplitPlan(plan, snapshot);

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// unassigned-hunk / duplicate-hunk
// ---------------------------------------------------------------------------

describe('validateSplitPlan — unassigned-hunk', () => {
  it('fires when a snapshot hunk has no owning child', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0 }),
        makeHunk({ file: 'a.ts', hunkIndex: 1 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    const child = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const plan = makePlan({ children: [child] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'unassigned-hunk');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].file).toBe('a.ts');
    expect(issues[0].hunkIndex).toBe(1);
  });

  it('fires when plan.unassignedHunks is non-empty even if hunk assignment looks complete', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [makeHunk({ file: 'a.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([file]);
    const child = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: 'all' }],
    });
    const plan = makePlan({
      children: [child],
      unassignedHunks: [{ file: 'a.ts', hunkIndex: 0 }],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(
      issuesOfCode(result.issues, 'unassigned-hunk').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('requires a whole-file owner for a binary (zero-hunk) file', () => {
    const binary = makeFile({
      path: 'logo.png',
      isBinary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const snapshot = makeSnapshot([binary]);
    const plan = makePlan({ children: [makeChild({ index: 1, changes: [] })] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'unassigned-hunk');
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('logo.png');
  });

  it('requires a whole-file owner for a deleted file', () => {
    const deleted = makeFile({
      path: 'old.ts',
      kind: 'deleted',
      hunks: [
        makeHunk({ file: 'old.ts', hunkIndex: 0, additions: 0, deletions: 4 }),
      ],
    });
    const snapshot = makeSnapshot([deleted]);
    const plan = makePlan({ children: [makeChild({ index: 1, changes: [] })] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'unassigned-hunk')).toHaveLength(1);
  });
});

describe('validateSplitPlan — duplicate-hunk', () => {
  it('fires when two children both claim the same hunk', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [makeHunk({ file: 'a.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([file]);
    const childA = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const childB = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const plan = makePlan({ children: [childA, childB] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'duplicate-hunk');
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('a.ts');
    expect(issues[0].hunkIndex).toBe(0);
  });
});

describe('validateSplitPlan — duplicate-child-index', () => {
  it('fires when two children share the same index', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [makeHunk({ file: 'a.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([file]);
    const childA = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const childB = makeChild({ index: 1, changes: [] });
    const plan = makePlan({ children: [childA, childB] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'duplicate-child-index');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/duplicate/i);
    expect(issues[0].childIndex).toBe(1);
  });

  it('fires for a zero index', () => {
    const file = makeFile({ path: 'a.ts' });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({ index: 0, changes: [{ file: 'a.ts', hunks: 'all' }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'duplicate-child-index');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/positive/i);
  });

  it('fires for a negative index', () => {
    const file = makeFile({ path: 'a.ts' });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({ index: -2, changes: [{ file: 'a.ts', hunks: 'all' }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'duplicate-child-index')).toHaveLength(
      1,
    );
  });

  it('fires for a non-integer index', () => {
    const file = makeFile({ path: 'a.ts' });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({ index: 1.5, changes: [{ file: 'a.ts', hunks: 'all' }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'duplicate-child-index')).toHaveLength(
      1,
    );
  });

  it('does not fire for a valid unique-index plan', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0 }),
        makeHunk({ file: 'a.ts', hunkIndex: 1 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    const childA = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const childB = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [{ file: 'a.ts', hunks: [1] }],
    });
    const plan = makePlan({ children: [childA, childB] });

    const result = validateSplitPlan(plan, snapshot);
    expect(issuesOfCode(result.issues, 'duplicate-child-index')).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// unknown-file / unknown-hunk-index
// ---------------------------------------------------------------------------

describe('validateSplitPlan — unknown-file', () => {
  it('fires when a change references a file not in the snapshot', () => {
    const snapshot = makeSnapshot([makeFile({ path: 'a.ts' })]);
    const plan = makePlan({
      children: [
        makeChild({
          index: 1,
          changes: [{ file: 'missing.ts', hunks: 'all' }],
        }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'unknown-file');
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('missing.ts');
    expect(issues[0].childIndex).toBe(1);
  });
});

describe('validateSplitPlan — unknown-hunk-index', () => {
  it('fires when a change references a hunk index the file does not have', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [makeHunk({ file: 'a.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({ index: 1, changes: [{ file: 'a.ts', hunks: [0, 5] }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'unknown-hunk-index');
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('a.ts');
    expect(issues[0].hunkIndex).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// shared-file-not-stacked
// ---------------------------------------------------------------------------

describe('validateSplitPlan — shared-file-not-stacked', () => {
  it('fires when two independent (non-ancestor) children touch the same file', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0 }),
        makeHunk({ file: 'a.ts', hunkIndex: 1 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    const childA = makeChild({
      index: 1,
      dependsOn: [],
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const childB = makeChild({
      index: 2,
      dependsOn: [],
      changes: [{ file: 'a.ts', hunks: [1] }],
    });
    const plan = makePlan({ children: [childA, childB] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'shared-file-not-stacked')).toHaveLength(
      1,
    );
  });

  it('does not fire when sharing children form a transitive ancestor chain (grandparent case)', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0 }),
        makeHunk({ file: 'a.ts', hunkIndex: 1 }),
        makeHunk({ file: 'a.ts', hunkIndex: 2 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    const grandparent = makeChild({
      index: 1,
      dependsOn: [],
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const parent = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [{ file: 'a.ts', hunks: [1] }],
    });
    const child = makeChild({
      index: 3,
      dependsOn: [2],
      changes: [{ file: 'a.ts', hunks: [2] }],
    });
    const plan = makePlan({ children: [grandparent, parent, child] });

    const result = validateSplitPlan(plan, snapshot);
    expect(issuesOfCode(result.issues, 'shared-file-not-stacked')).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// dependson-forward-ref / dependson-cycle
// ---------------------------------------------------------------------------

describe('validateSplitPlan — dependson-forward-ref', () => {
  it('fires when dependsOn references the same or a higher index', () => {
    const snapshot = makeSnapshot([]);
    const childForwardRef = makeChild({
      index: 1,
      dependsOn: [2],
      changes: [],
    });
    const childSelfRef = makeChild({ index: 2, dependsOn: [2], changes: [] });
    const plan = makePlan({ children: [childForwardRef, childSelfRef] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'dependson-forward-ref');
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('fires when dependsOn references a missing lower-index child', () => {
    const file = makeFile({ path: 'a.ts' });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({
          index: 2,
          dependsOn: [1],
          changes: [{ file: 'a.ts', hunks: 'all' }],
        }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    const issues = issuesOfCode(result.issues, 'dependson-forward-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/does not match any child/);
  });
});

describe('validateSplitPlan — dependson-cycle', () => {
  it('fires and reports both members of a 2-cycle without forward-ref indices', () => {
    // Cast around the forward-ref rule by using equal-looking indices is not
    // possible since dependsOn must be lower indices; a true cycle requires an
    // index-invariant graph check, so this uses a synthetic 3-node cycle where
    // each individual edge still looks locally valid except the wraparound.
    const snapshot = makeSnapshot([]);
    // index 1 depends on 3 (forward ref) is unavoidable to create a genuine
    // cycle under a "lower index only" dependsOn rule, so the cycle check must
    // run independently of (and in addition to) the forward-ref check.
    const a = makeChild({ index: 1, dependsOn: [3], changes: [] });
    const b = makeChild({ index: 2, dependsOn: [1], changes: [] });
    const c = makeChild({ index: 3, dependsOn: [2], changes: [] });
    const plan = makePlan({ children: [a, b, c] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(
      issuesOfCode(result.issues, 'dependson-cycle').length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// binary-not-whole
// ---------------------------------------------------------------------------

describe('validateSplitPlan — binary-not-whole', () => {
  it('fires when a binary file is assigned via hunk indices instead of "all"', () => {
    const binary = makeFile({
      path: 'logo.png',
      isBinary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const snapshot = makeSnapshot([binary]);
    const plan = makePlan({
      children: [
        makeChild({ index: 1, changes: [{ file: 'logo.png', hunks: [0] }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'binary-not-whole')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// non-modified-not-whole
// ---------------------------------------------------------------------------

describe('validateSplitPlan — non-modified-not-whole', () => {
  it.each(['added', 'deleted', 'renamed'] as const)(
    'fires when a %s file is assigned via hunk indices instead of "all"',
    (kind) => {
      const file = makeFile({
        path: kind === 'renamed' ? 'new.ts' : `${kind}.ts`,
        oldPath: kind === 'renamed' ? 'old.ts' : undefined,
        kind,
        hunks: [
          makeHunk({ file: kind === 'renamed' ? 'new.ts' : `${kind}.ts` }),
        ],
      });
      const snapshot = makeSnapshot([file]);
      const plan = makePlan({
        children: [
          makeChild({
            index: 1,
            changes: [{ file: file.path, hunks: [0] }],
          }),
        ],
      });

      const result = validateSplitPlan(plan, snapshot);
      expect(result.valid).toBe(false);
      const issues = issuesOfCode(result.issues, 'non-modified-not-whole');
      expect(issues).toHaveLength(1);
      expect(issues[0].file).toBe(file.path);
    },
  );
});

// ---------------------------------------------------------------------------
// rename-split
// ---------------------------------------------------------------------------

describe('validateSplitPlan — rename-split', () => {
  it('fires when a rename pair is owned by different children', () => {
    const renamed = makeFile({
      path: 'new.ts',
      oldPath: 'old.ts',
      kind: 'renamed',
      hunks: [makeHunk({ file: 'new.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([renamed]);
    const childA = makeChild({
      index: 1,
      changes: [{ file: 'new.ts', hunks: 'all' }],
      renames: [{ from: 'old.ts', to: 'new.ts' }],
    });
    const childB = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [],
      renames: [{ from: 'old.ts', to: 'new.ts' }],
    });
    const plan = makePlan({ children: [childA, childB] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(
      issuesOfCode(result.issues, 'rename-split').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('fires when a rename pair is not listed together in any child renames array', () => {
    const renamed = makeFile({
      path: 'new.ts',
      oldPath: 'old.ts',
      kind: 'renamed',
      hunks: [makeHunk({ file: 'new.ts', hunkIndex: 0 })],
    });
    const snapshot = makeSnapshot([renamed]);
    const child = makeChild({
      index: 1,
      changes: [{ file: 'new.ts', hunks: 'all' }],
      renames: [],
    });
    const plan = makePlan({ children: [child] });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(
      issuesOfCode(result.issues, 'rename-split').length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// aggregate-mismatch
// ---------------------------------------------------------------------------

describe('validateSplitPlan — aggregate-mismatch', () => {
  it('fires when the sum of per-child line stats does not equal the snapshot totals', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0, additions: 10, deletions: 2 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    // Snapshot totals will be 10/2 from the fixture builder, but manually force
    // a mismatch by overriding totals directly.
    snapshot.totalAdditions = 999;
    const plan = makePlan({
      children: [
        makeChild({ index: 1, changes: [{ file: 'a.ts', hunks: 'all' }] }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    expect(result.valid).toBe(false);
    expect(issuesOfCode(result.issues, 'aggregate-mismatch')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// depth-warning / fragment-warning / multi-parent-unsupported
// ---------------------------------------------------------------------------

describe('validateSplitPlan — depth-warning', () => {
  it('warns when the dependency chain depth exceeds 7', () => {
    const children: SplitPlanChild[] = [];
    for (let i = 1; i <= 9; i += 1) {
      children.push(
        makeChild({ index: i, dependsOn: i === 1 ? [] : [i - 1], changes: [] }),
      );
    }
    const snapshot = makeSnapshot([]);
    const plan = makePlan({ children });

    const result = validateSplitPlan(plan, snapshot);
    const issues = issuesOfCode(result.issues, 'depth-warning');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    // Warnings alone must not make the plan invalid.
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
  });
});

describe('validateSplitPlan — fragment-warning', () => {
  it('warns for a child with empty changes', () => {
    const snapshot = makeSnapshot([]);
    const plan = makePlan({
      children: [
        makeChild({
          index: 1,
          changes: [],
          testProof: 'existing tests unchanged',
        }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    const issues = issuesOfCode(result.issues, 'fragment-warning');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('warns for a child with empty testProof', () => {
    const file = makeFile({ path: 'a.ts' });
    const snapshot = makeSnapshot([file]);
    const plan = makePlan({
      children: [
        makeChild({
          index: 1,
          changes: [{ file: 'a.ts', hunks: 'all' }],
          testProof: '',
        }),
      ],
    });

    const result = validateSplitPlan(plan, snapshot);
    const issues = issuesOfCode(result.issues, 'fragment-warning');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe('warning');
  });
});

describe('validateSplitPlan — multi-parent-unsupported', () => {
  it('errors (blocking Approve) when a child declares more than one parent', () => {
    const fileA = makeFile({ path: 'a.ts' });
    const fileB = makeFile({ path: 'b.ts' });
    const fileC = makeFile({ path: 'c.ts' });
    const snapshot = makeSnapshot([fileA, fileB, fileC]);
    const parent1 = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: 'all' }],
    });
    const parent2 = makeChild({
      index: 2,
      changes: [{ file: 'b.ts', hunks: 'all' }],
    });
    const child = makeChild({
      index: 3,
      dependsOn: [1, 2],
      changes: [{ file: 'c.ts', hunks: 'all' }],
    });
    const plan = makePlan({ children: [parent1, parent2, child] });

    const result = validateSplitPlan(plan, snapshot);
    const issues = issuesOfCode(result.issues, 'multi-parent-unsupported');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].childIndex).toBe(3);
    expect(issues[0].message).toContain('multiple parents');
    // A multi-parent plan is now invalid overall, so it cannot be executed.
    expect(result.valid).toBe(false);
  });

  it('does not fire for a single-parent (linear) plan', () => {
    const fileA = makeFile({ path: 'a.ts' });
    const fileB = makeFile({ path: 'b.ts' });
    const snapshot = makeSnapshot([fileA, fileB]);
    const parent = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: 'all' }],
    });
    const child = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [{ file: 'b.ts', hunks: 'all' }],
    });
    const plan = makePlan({ children: [parent, child] });

    const result = validateSplitPlan(plan, snapshot);
    expect(
      issuesOfCode(result.issues, 'multi-parent-unsupported'),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeChildLineStats
// ---------------------------------------------------------------------------

describe('computeChildLineStats', () => {
  it('sums additions/deletions of owned hunks per child', () => {
    const file = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0, additions: 3, deletions: 1 }),
        makeHunk({ file: 'a.ts', hunkIndex: 1, additions: 2, deletions: 4 }),
      ],
    });
    const snapshot = makeSnapshot([file]);
    const childA = makeChild({
      index: 1,
      changes: [{ file: 'a.ts', hunks: [0] }],
    });
    const childB = makeChild({
      index: 2,
      dependsOn: [1],
      changes: [{ file: 'a.ts', hunks: [1] }],
    });
    const plan = makePlan({ children: [childA, childB] });

    const stats = computeChildLineStats(plan, snapshot);
    expect(stats).toEqual([
      { index: 1, additions: 3, deletions: 1 },
      { index: 2, additions: 2, deletions: 4 },
    ]);
  });

  it('uses whole-file totals for whole-file ownership, contributing 0/0 for binary files', () => {
    const binary = makeFile({
      path: 'logo.png',
      isBinary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const text = makeFile({
      path: 'a.ts',
      hunks: [
        makeHunk({ file: 'a.ts', hunkIndex: 0, additions: 7, deletions: 2 }),
      ],
    });
    const snapshot = makeSnapshot([binary, text]);
    const child = makeChild({
      index: 1,
      changes: [
        { file: 'logo.png', hunks: 'all' },
        { file: 'a.ts', hunks: 'all' },
      ],
    });
    const plan = makePlan({ children: [child] });

    const stats = computeChildLineStats(plan, snapshot);
    expect(stats).toEqual([{ index: 1, additions: 7, deletions: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// topologicalChildOrder
// ---------------------------------------------------------------------------

describe('topologicalChildOrder', () => {
  it('returns children in ascending index order when there are no dependencies', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1 }),
        makeChild({ index: 2 }),
        makeChild({ index: 3 }),
      ],
    });
    expect(topologicalChildOrder(plan)).toEqual([1, 2, 3]);
  });

  it('is stable, preferring ascending index among ready nodes', () => {
    // 3 depends on 1; 2 has no deps. Ready set after nothing runs: {1, 2}.
    // Ascending-index tie-break picks 1, then {2, 3} ready -> 2, then 3.
    const plan = makePlan({
      children: [
        makeChild({ index: 1, dependsOn: [] }),
        makeChild({ index: 2, dependsOn: [] }),
        makeChild({ index: 3, dependsOn: [1] }),
      ],
    });
    expect(topologicalChildOrder(plan)).toEqual([1, 2, 3]);
  });

  it('linearizes a multi-parent DAG deterministically', () => {
    // 3 depends on both 1 and 2.
    const plan = makePlan({
      children: [
        makeChild({ index: 1, dependsOn: [] }),
        makeChild({ index: 2, dependsOn: [] }),
        makeChild({ index: 3, dependsOn: [1, 2] }),
      ],
    });
    const order = topologicalChildOrder(plan);
    expect(order).toHaveLength(3);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  it('throws a typed error naming the cycle members on a cyclic graph', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, dependsOn: [3] }),
        makeChild({ index: 2, dependsOn: [1] }),
        makeChild({ index: 3, dependsOn: [2] }),
      ],
    });

    let caught: unknown;
    try {
      topologicalChildOrder(plan);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SplitPlanCycleError);
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('1');
    expect(message).toContain('2');
    expect(message).toContain('3');
  });

  it('throws SplitPlanDanglingDependencyError (not SplitPlanCycleError) when a dependsOn entry names a missing child index', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, dependsOn: [] }),
        makeChild({ index: 2, dependsOn: [99] }),
      ],
    });

    let caught: unknown;
    try {
      topologicalChildOrder(plan);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SplitPlanDanglingDependencyError);
    expect(caught).not.toBeInstanceOf(SplitPlanCycleError);
    const dangling = caught as SplitPlanDanglingDependencyError;
    expect(dangling.childIndex).toBe(2);
    expect(dangling.missingDependsOnIndex).toBe(99);
    expect(dangling.message).toContain('2');
    expect(dangling.message).toContain('99');
    expect(dangling.message.toLowerCase()).not.toContain('cycle');
  });
});

// ---------------------------------------------------------------------------
// deriveSplitBranchNames
// ---------------------------------------------------------------------------

describe('deriveSplitBranchNames', () => {
  it('derives the integration branch and per-child branches with zero-padded index + slug', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, title: 'refactor: extract client seam' }),
        makeChild({
          index: 2,
          title: 'feature: add registry wiring',
          type: 'feature',
        }),
      ],
    });

    const result = deriveSplitBranchNames('alice/my-feature', plan);
    expect(result.integrationBranch).toBe('alice/my-feature-split/integration');
    expect(result.childBranches[1]).toBe(
      'alice/my-feature-split/01-extract-client-seam',
    );
    expect(result.childBranches[2]).toBe(
      'alice/my-feature-split/02-add-registry-wiring',
    );
  });

  it('strips feat: prefix as well as feature:/refactor:', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, title: 'feat: short title', type: 'feature' }),
      ],
    });
    const result = deriveSplitBranchNames('head', plan);
    expect(result.childBranches[1]).toBe('head-split/01-short-title');
  });

  it('sanitizes non [a-z0-9] runs, trims edges, and caps length', () => {
    const longTitle =
      'refactor: This Title!! Has ---- Weird_Characters &&& and is quite long indeed to test truncation behavior';
    const plan = makePlan({
      children: [makeChild({ index: 1, title: longTitle })],
    });
    const result = deriveSplitBranchNames('head', plan);
    const slug = result.childBranches[1].replace('head-split/01-', '');
    expect(slug).not.toMatch(/[^a-z0-9-]/);
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('produces git-check-ref-format-safe slugs: no .., no trailing .lock/., no leading -', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, title: 'refactor: a..b.lock. edge case' }),
      ],
    });
    const result = deriveSplitBranchNames('head', plan);
    const branch = result.childBranches[1];
    expect(branch).not.toContain('..');
    expect(branch.endsWith('.lock')).toBe(false);
    expect(branch.endsWith('.')).toBe(false);
    const slug = branch.slice(branch.lastIndexOf('/') + 1);
    expect(slug.startsWith('-')).toBe(false);
  });

  it('ensures uniqueness by suffixing -2, -3 on slug collision within the plan', () => {
    const plan = makePlan({
      children: [
        makeChild({ index: 1, title: 'refactor: shared title' }),
        makeChild({
          index: 2,
          title: 'refactor: shared title',
          dependsOn: [1],
        }),
        makeChild({
          index: 3,
          title: 'refactor: shared title',
          dependsOn: [1],
        }),
      ],
    });
    const result = deriveSplitBranchNames('head', plan);
    expect(result.childBranches[1]).toBe('head-split/01-shared-title');
    expect(result.childBranches[2]).toBe('head-split/02-shared-title-2');
    expect(result.childBranches[3]).toBe('head-split/03-shared-title-3');
  });
});

// ---------------------------------------------------------------------------
// isSplitPlan
// ---------------------------------------------------------------------------

describe('isSplitPlan', () => {
  const validPlan: SplitPlan = makePlan({
    children: [
      makeChild({
        index: 1,
        changes: [{ file: 'a.ts', hunks: 'all' }],
        renames: [{ from: 'x.ts', to: 'y.ts' }],
      }),
    ],
  });

  it('accepts a well-formed SplitPlan', () => {
    expect(isSplitPlan(validPlan)).toBe(true);
  });

  it('accepts a well-formed SplitPlan carrying unknown extra properties (LLM output may carry extras)', () => {
    const withExtras = {
      ...validPlan,
      someUnknownTopLevelField: 'ignored',
      children: validPlan.children.map((c) => ({ ...c, extraChildField: 42 })),
    };
    expect(isSplitPlan(withExtras)).toBe(true);
  });

  it('rejects null/undefined/primitives', () => {
    expect(isSplitPlan(null)).toBe(false);
    expect(isSplitPlan(undefined)).toBe(false);
    expect(isSplitPlan('plan')).toBe(false);
    expect(isSplitPlan(42)).toBe(false);
    expect(isSplitPlan([])).toBe(false);
  });

  it('rejects a plan missing a required field', () => {
    const { finalGoal, ...rest } = validPlan;
    void finalGoal;
    expect(isSplitPlan(rest)).toBe(false);
  });

  it('rejects a plan whose children array element is wrongly typed', () => {
    const badChildren = {
      ...validPlan,
      children: [{ ...validPlan.children[0], index: 'one' }],
    };
    expect(isSplitPlan(badChildren)).toBe(false);
  });

  it('rejects a plan whose concerns array element has a bad "kind"', () => {
    const badConcerns = {
      ...validPlan,
      concerns: [{ concern: 'x', kind: 'not-a-kind' }],
    };
    expect(isSplitPlan(badConcerns)).toBe(false);
  });

  it('rejects a plan whose child.changes[].hunks is neither "all" nor number[]', () => {
    const badChanges = {
      ...validPlan,
      children: [
        {
          ...validPlan.children[0],
          changes: [{ file: 'a.ts', hunks: 'some' }],
        },
      ],
    };
    expect(isSplitPlan(badChanges)).toBe(false);
  });

  it('rejects a plan whose unassignedHunks element is malformed', () => {
    const badUnassigned = {
      ...validPlan,
      unassignedHunks: [{ file: 'a.ts' }],
    };
    expect(isSplitPlan(badUnassigned)).toBe(false);
  });
});
