import type {
  ChildChange,
  DiffFileEntry,
  PrDiffSnapshot,
  SplitPlan,
  SplitPlanChild,
} from '../types/github';
import type {
  SplitPlanIssue,
  SplitPlanValidation,
} from '../types/pr-split-plan';
export type {
  SplitPlanIssue,
  SplitPlanIssueCode,
  SplitPlanValidation,
} from '../types/pr-split-plan';

const MAX_DEPTH_BEFORE_WARNING = 7;

// ---------------------------------------------------------------------------
// Cycle error
// ---------------------------------------------------------------------------

/** Thrown by `topologicalChildOrder` when the child dependency graph has a cycle. */
export class SplitPlanCycleError extends Error {
  readonly cycleChildIndices: number[];

  constructor(cycleChildIndices: number[]) {
    super(
      `Split plan has a dependsOn cycle among children: ${cycleChildIndices.join(' -> ')}`,
    );
    this.name = 'SplitPlanCycleError';
    this.cycleChildIndices = cycleChildIndices;
  }
}

/**
 * Thrown by `topologicalChildOrder` when a child's `dependsOn` entry names an
 * index that is not present among `plan.children` (as opposed to a true cycle
 * among indices that DO exist — see `SplitPlanCycleError`). Distinct type/name
 * so callers and messages do not mislabel a dangling reference as a cycle.
 */
export class SplitPlanDanglingDependencyError extends Error {
  readonly childIndex: number;
  readonly missingDependsOnIndex: number;

  constructor(childIndex: number, missingDependsOnIndex: number) {
    super(
      `Child ${childIndex} has a dependsOn entry (${missingDependsOnIndex}) that does not match any child index in the plan`,
    );
    this.name = 'SplitPlanDanglingDependencyError';
    this.childIndex = childIndex;
    this.missingDependsOnIndex = missingDependsOnIndex;
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function fileKey(file: string, hunkIndex: number): string {
  return `${file}#${hunkIndex}`;
}

/** Direct-parent adjacency: index -> its declared dependsOn indices (as-is, not deduped/validated). */
function buildDependsOnMap(plan: SplitPlan): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const child of plan.children) {
    map.set(child.index, child.dependsOn);
  }
  return map;
}

/** All ancestors (transitive) of `index`, safe against cycles via a visited guard. */
function ancestorsOf(
  index: number,
  dependsOnMap: Map<number, number[]>,
): Set<number> {
  const ancestors = new Set<number>();
  const stack = [...(dependsOnMap.get(index) ?? [])];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    ancestors.add(current);
    for (const next of dependsOnMap.get(current) ?? []) {
      stack.push(next);
    }
  }
  return ancestors;
}

/** True when `a` is an ancestor of `b` or `b` is an ancestor of `a` (linear chain). */
function isAncestorRelated(
  a: number,
  b: number,
  dependsOnMap: Map<number, number[]>,
): boolean {
  return (
    ancestorsOf(b, dependsOnMap).has(a) || ancestorsOf(a, dependsOnMap).has(b)
  );
}

function filesTouchedByChild(child: SplitPlanChild): Set<string> {
  const files = new Set<string>();
  for (const change of child.changes) {
    files.add(change.file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// validateSplitPlan
// ---------------------------------------------------------------------------

export function validateSplitPlan(
  plan: SplitPlan,
  snapshot: PrDiffSnapshot,
): SplitPlanValidation {
  const issues: SplitPlanIssue[] = [];
  const filesByPath = new Map<string, DiffFileEntry>();
  for (const file of snapshot.files) {
    filesByPath.set(file.path, file);
  }

  // Run child-index integrity FIRST: duplicate or non-positive/non-integer
  // indices poison every downstream map keyed by `child.index` (dependsOn
  // resolution, partition ownership, branch derivation), so surface them
  // before those checks build garbage from bad keys.
  checkChildIndexIntegrity(plan, issues);
  checkUnknownFilesAndHunks(plan, filesByPath, issues);
  checkHunkAssignmentCompleteness(plan, snapshot, issues);
  checkBinaryWholeOwnership(plan, filesByPath, issues);
  checkNonModifiedWholeOwnership(plan, filesByPath, issues);
  checkDependsOnForwardRefsAndCycles(plan, issues);
  checkSharedFileStacking(plan, issues);
  checkRenameSplit(plan, snapshot, issues);
  checkAggregate(plan, snapshot, issues);
  checkDepthAndFragments(plan, issues);

  const valid = !issues.some((issue) => issue.severity === 'error');
  return { valid, issues };
}

/**
 * Reject duplicate child indices and non-positive / non-integer indices under
 * a single `duplicate-child-index` code (the message distinguishes which).
 * Child indices are the primary key for the whole plan: `dependsOn` targets
 * them, hunk-partition ownership is reported by them, and branch names are
 * derived from them. A duplicate or a `0`/`-1`/`1.5` index would silently
 * collide or corrupt every downstream `Map` keyed by index, so this must run
 * before any of those checks.
 */
function checkChildIndexIntegrity(
  plan: SplitPlan,
  issues: SplitPlanIssue[],
): void {
  const seen = new Set<number>();
  const reportedDuplicates = new Set<number>();
  for (const child of plan.children) {
    const index = child.index;
    if (!Number.isInteger(index) || index < 1) {
      issues.push({
        code: 'duplicate-child-index',
        severity: 'error',
        message: `Child index ${index} is invalid; child indices must be positive integers (1-based)`,
        childIndex: index,
      });
      continue;
    }
    if (seen.has(index)) {
      if (!reportedDuplicates.has(index)) {
        reportedDuplicates.add(index);
        issues.push({
          code: 'duplicate-child-index',
          severity: 'error',
          message: `Duplicate child index ${index}; each child must have a unique index`,
          childIndex: index,
        });
      }
      continue;
    }
    seen.add(index);
  }
}

function checkUnknownFilesAndHunks(
  plan: SplitPlan,
  filesByPath: Map<string, DiffFileEntry>,
  issues: SplitPlanIssue[],
): void {
  for (const child of plan.children) {
    for (const change of child.changes) {
      const file = filesByPath.get(change.file);
      if (!file) {
        issues.push({
          code: 'unknown-file',
          severity: 'error',
          message: `Child ${child.index} references unknown file "${change.file}"`,
          childIndex: child.index,
          file: change.file,
        });
        continue;
      }
      if (change.hunks === 'all') {
        continue;
      }
      for (const hunkIndex of change.hunks) {
        const known = file.hunks.some((h) => h.hunkIndex === hunkIndex);
        if (!known) {
          issues.push({
            code: 'unknown-hunk-index',
            severity: 'error',
            message: `Child ${child.index} references unknown hunk index ${hunkIndex} of file "${change.file}"`,
            childIndex: child.index,
            file: change.file,
            hunkIndex,
          });
        }
      }
    }
  }
}

function checkHunkAssignmentCompleteness(
  plan: SplitPlan,
  snapshot: PrDiffSnapshot,
  issues: SplitPlanIssue[],
): void {
  // owners[fileKey] = list of child indices claiming that hunk (or the
  // whole-file sentinel key for zero-hunk files).
  const owners = new Map<string, number[]>();

  function addOwner(key: string, childIndex: number): void {
    const list = owners.get(key);
    if (list) {
      list.push(childIndex);
    } else {
      owners.set(key, [childIndex]);
    }
  }

  for (const child of plan.children) {
    for (const change of child.changes) {
      const file = snapshot.files.find((f) => f.path === change.file);
      if (!file) {
        continue; // unknown-file already reported separately
      }
      if (change.hunks === 'all') {
        if (file.hunks.length === 0) {
          addOwner(fileKey(file.path, -1), child.index);
        } else {
          for (const hunk of file.hunks) {
            addOwner(fileKey(file.path, hunk.hunkIndex), child.index);
          }
        }
      } else {
        for (const hunkIndex of change.hunks) {
          addOwner(fileKey(change.file, hunkIndex), child.index);
        }
      }
    }
  }

  for (const file of snapshot.files) {
    const requiredKeys =
      file.hunks.length === 0
        ? [fileKey(file.path, -1)]
        : file.hunks.map((hunk) => fileKey(file.path, hunk.hunkIndex));

    for (const key of requiredKeys) {
      const claimants = owners.get(key) ?? [];
      const hunkIndex = Number(key.slice(key.lastIndexOf('#') + 1));
      if (claimants.length === 0) {
        issues.push({
          code: 'unassigned-hunk',
          severity: 'error',
          message:
            hunkIndex === -1
              ? `File "${file.path}" (binary/zero-hunk) has no owning child`
              : `Hunk ${hunkIndex} of file "${file.path}" has no owning child`,
          file: file.path,
          ...(hunkIndex === -1 ? {} : { hunkIndex }),
        });
      } else if (claimants.length > 1) {
        issues.push({
          code: 'duplicate-hunk',
          severity: 'error',
          message:
            hunkIndex === -1
              ? `File "${file.path}" (binary/zero-hunk) is owned by multiple children: ${claimants.join(', ')}`
              : `Hunk ${hunkIndex} of file "${file.path}" is owned by multiple children: ${claimants.join(', ')}`,
          file: file.path,
          ...(hunkIndex === -1 ? {} : { hunkIndex }),
        });
      }
    }
  }

  if (plan.unassignedHunks.length > 0) {
    for (const entry of plan.unassignedHunks) {
      issues.push({
        code: 'unassigned-hunk',
        severity: 'error',
        message: `Plan declares unassignedHunks entry for "${entry.file}" hunk ${entry.hunkIndex}`,
        file: entry.file,
        hunkIndex: entry.hunkIndex,
      });
    }
  }
}

function checkBinaryWholeOwnership(
  plan: SplitPlan,
  filesByPath: Map<string, DiffFileEntry>,
  issues: SplitPlanIssue[],
): void {
  for (const child of plan.children) {
    for (const change of child.changes) {
      const file = filesByPath.get(change.file);
      if (!file || !file.isBinary) {
        continue;
      }
      if (change.hunks !== 'all') {
        issues.push({
          code: 'binary-not-whole',
          severity: 'error',
          message: `Child ${child.index} assigns binary file "${change.file}" by hunk indices instead of "all"`,
          childIndex: child.index,
          file: change.file,
        });
      }
    }
  }
}

function checkNonModifiedWholeOwnership(
  plan: SplitPlan,
  filesByPath: Map<string, DiffFileEntry>,
  issues: SplitPlanIssue[],
): void {
  for (const child of plan.children) {
    for (const change of child.changes) {
      const file = filesByPath.get(change.file);
      if (!file || file.kind === 'modified') {
        continue;
      }
      if (change.hunks !== 'all') {
        issues.push({
          code: 'non-modified-not-whole',
          severity: 'error',
          message: `Child ${child.index} assigns ${file.kind} file "${change.file}" by hunk indices instead of "all"`,
          childIndex: child.index,
          file: change.file,
        });
      }
    }
  }
}

function checkDependsOnForwardRefsAndCycles(
  plan: SplitPlan,
  issues: SplitPlanIssue[],
): void {
  const childIndices = new Set(plan.children.map((child) => child.index));
  for (const child of plan.children) {
    for (const dep of child.dependsOn) {
      if (!childIndices.has(dep)) {
        issues.push({
          code: 'dependson-forward-ref',
          severity: 'error',
          message: `Child ${child.index} has a dependsOn entry (${dep}) that does not match any child`,
          childIndex: child.index,
        });
        continue;
      }
      if (dep >= child.index) {
        issues.push({
          code: 'dependson-forward-ref',
          severity: 'error',
          message: `Child ${child.index} has a dependsOn entry (${dep}) that is not a lower index`,
          childIndex: child.index,
        });
      }
    }
  }

  const dependsOnMap = buildDependsOnMap(plan);
  const cycle = findCycle(dependsOnMap);
  if (cycle) {
    issues.push({
      code: 'dependson-cycle',
      severity: 'error',
      message: `Split plan has a dependsOn cycle among children: ${cycle.join(' -> ')}`,
    });
  }
}

/** Standard 3-color DFS cycle detection; returns the cycle path if one exists. */
function findCycle(dependsOnMap: Map<number, number[]>): number[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  for (const index of Array.from(dependsOnMap.keys())) {
    color.set(index, WHITE);
  }

  let foundCycle: number[] | null = null;

  function visit(index: number, path: number[]): void {
    if (foundCycle) {
      return;
    }
    color.set(index, GRAY);
    for (const dep of dependsOnMap.get(index) ?? []) {
      if (foundCycle) {
        return;
      }
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const cycleStart = path.indexOf(dep);
        foundCycle = [...path.slice(cycleStart === -1 ? 0 : cycleStart), dep];
        return;
      }
      if (depColor === WHITE) {
        visit(dep, [...path, dep]);
      }
    }
    color.set(index, BLACK);
  }

  for (const index of Array.from(dependsOnMap.keys())) {
    if (foundCycle) {
      break;
    }
    if (color.get(index) === WHITE) {
      visit(index, [index]);
    }
  }

  return foundCycle;
}

function checkSharedFileStacking(
  plan: SplitPlan,
  issues: SplitPlanIssue[],
): void {
  const dependsOnMap = buildDependsOnMap(plan);
  const touchedFiles = plan.children.map((child) => ({
    index: child.index,
    files: filesTouchedByChild(child),
  }));

  const reportedPairs = new Set<string>();

  for (let i = 0; i < touchedFiles.length; i += 1) {
    for (let j = i + 1; j < touchedFiles.length; j += 1) {
      const a = touchedFiles[i];
      const b = touchedFiles[j];
      const sharedFiles = Array.from(a.files).filter((file) =>
        b.files.has(file),
      );
      if (sharedFiles.length === 0) {
        continue;
      }
      if (isAncestorRelated(a.index, b.index, dependsOnMap)) {
        continue;
      }
      const pairKey = `${a.index}:${b.index}`;
      if (reportedPairs.has(pairKey)) {
        continue;
      }
      reportedPairs.add(pairKey);
      issues.push({
        code: 'shared-file-not-stacked',
        severity: 'error',
        message: `Children ${a.index} and ${b.index} both touch file(s) ${sharedFiles.join(', ')} but are not in a linear ancestor chain`,
        childIndex: a.index,
        file: sharedFiles[0],
      });
    }
  }
}

function checkRenameSplit(
  plan: SplitPlan,
  snapshot: PrDiffSnapshot,
  issues: SplitPlanIssue[],
): void {
  const renamedFiles = snapshot.files.filter(
    (file) => file.kind === 'renamed' && file.oldPath,
  );
  if (renamedFiles.length === 0) {
    return;
  }

  // Find which child owns each renamed file's post-image path.
  const ownerOfFile = new Map<string, number>();
  for (const child of plan.children) {
    for (const change of child.changes) {
      if (!ownerOfFile.has(change.file)) {
        ownerOfFile.set(change.file, child.index);
      }
    }
  }

  // Find which child(ren) list the rename pair together.
  function childrenListingRenamePair(from: string, to: string): number[] {
    const owners: number[] = [];
    for (const child of plan.children) {
      const hasPair = child.renames.some(
        (rename) => rename.from === from && rename.to === to,
      );
      if (hasPair) {
        owners.push(child.index);
      }
    }
    return owners;
  }

  for (const renamedFile of renamedFiles) {
    const from = renamedFile.oldPath;
    const to = renamedFile.path;
    if (!from) {
      continue;
    }

    const listedIn = childrenListingRenamePair(from, to);
    if (listedIn.length === 0) {
      issues.push({
        code: 'rename-split',
        severity: 'error',
        message: `Rename ${from} -> ${to} is not listed together in any child's renames array`,
        file: to,
      });
      continue;
    }

    const fileOwner = ownerOfFile.get(to);
    const mismatchedOwner = listedIn.some((owner) => owner !== fileOwner);
    if (mismatchedOwner || listedIn.length > 1) {
      issues.push({
        code: 'rename-split',
        severity: 'error',
        message: `Rename ${from} -> ${to} is claimed by inconsistent children (renames: ${listedIn.join(', ')}; file owner: ${fileOwner ?? 'none'})`,
        file: to,
      });
    }
  }
}

function checkAggregate(
  plan: SplitPlan,
  snapshot: PrDiffSnapshot,
  issues: SplitPlanIssue[],
): void {
  const stats = computeChildLineStats(plan, snapshot);
  const totalAdditions = stats.reduce((sum, s) => sum + s.additions, 0);
  const totalDeletions = stats.reduce((sum, s) => sum + s.deletions, 0);

  if (
    totalAdditions !== snapshot.totalAdditions ||
    totalDeletions !== snapshot.totalDeletions
  ) {
    issues.push({
      code: 'aggregate-mismatch',
      severity: 'error',
      message: `Sum of per-child line stats (+${totalAdditions}/-${totalDeletions}) does not match snapshot totals (+${snapshot.totalAdditions}/-${snapshot.totalDeletions})`,
    });
  }
}

function computeDepth(
  index: number,
  dependsOnMap: Map<number, number[]>,
  memo: Map<number, number>,
): number {
  const memoized = memo.get(index);
  if (memoized !== undefined) {
    return memoized;
  }
  const deps = dependsOnMap.get(index) ?? [];
  if (deps.length === 0) {
    memo.set(index, 0);
    return 0;
  }
  let maxParentDepth = 0;
  for (const dep of deps) {
    // Guard against cycles (already reported separately): do not recurse
    // through a node currently being computed.
    maxParentDepth = Math.max(
      maxParentDepth,
      computeDepth(dep, dependsOnMap, memo),
    );
  }
  const depth = maxParentDepth + 1;
  memo.set(index, depth);
  return depth;
}

function checkDepthAndFragments(
  plan: SplitPlan,
  issues: SplitPlanIssue[],
): void {
  const dependsOnMap = buildDependsOnMap(plan);
  if (!findCycle(dependsOnMap)) {
    const memo = new Map<number, number>();
    let maxDepth = 0;
    for (const child of plan.children) {
      maxDepth = Math.max(
        maxDepth,
        computeDepth(child.index, dependsOnMap, memo),
      );
    }
    if (maxDepth > MAX_DEPTH_BEFORE_WARNING) {
      issues.push({
        code: 'depth-warning',
        severity: 'warning',
        message: `Dependency chain depth ${maxDepth} exceeds ${MAX_DEPTH_BEFORE_WARNING}`,
      });
    }
  }

  for (const child of plan.children) {
    if (child.dependsOn.length > 1) {
      issues.push({
        code: 'multi-parent-unsupported',
        severity: 'error',
        message: `child ${child.index} declares multiple parents; multi-parent dependencies are not supported — keep a single parent per child`,
        childIndex: child.index,
      });
    }

    const isFragment =
      child.changes.length === 0 || child.testProof.trim().length === 0;
    if (isFragment) {
      issues.push({
        code: 'fragment-warning',
        severity: 'warning',
        message: `Child ${child.index} looks like a fragment (${child.changes.length === 0 ? 'empty changes' : 'empty testProof'})`,
        childIndex: child.index,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// computeChildLineStats
// ---------------------------------------------------------------------------

export interface ChildLineStats {
  index: number;
  additions: number;
  deletions: number;
}

export function computeChildLineStats(
  plan: SplitPlan,
  snapshot: PrDiffSnapshot,
): ChildLineStats[] {
  const filesByPath = new Map<string, DiffFileEntry>();
  for (const file of snapshot.files) {
    filesByPath.set(file.path, file);
  }

  return plan.children.map((child) => {
    let additions = 0;
    let deletions = 0;
    for (const change of child.changes) {
      const file = filesByPath.get(change.file);
      if (!file) {
        continue;
      }
      if (change.hunks === 'all') {
        additions += file.additions;
        deletions += file.deletions;
        continue;
      }
      for (const hunkIndex of change.hunks) {
        const hunk = file.hunks.find((h) => h.hunkIndex === hunkIndex);
        if (hunk) {
          additions += hunk.additions;
          deletions += hunk.deletions;
        }
      }
    }
    return { index: child.index, additions, deletions };
  });
}

// ---------------------------------------------------------------------------
// topologicalChildOrder
// ---------------------------------------------------------------------------

export function topologicalChildOrder(plan: SplitPlan): number[] {
  const dependsOnMap = buildDependsOnMap(plan);
  const cycle = findCycle(dependsOnMap);
  if (cycle) {
    throw new SplitPlanCycleError(cycle);
  }

  const indices = plan.children
    .map((child) => child.index)
    .sort((a, b) => a - b);
  const knownIndices = new Set(indices);

  // Dangling-reference check: a `dependsOn` entry naming an index that is not
  // present among `plan.children` at all is a distinct failure mode from a
  // true cycle (which only involves indices that DO exist). Report it as such
  // — with the specific child/missing-index pair — instead of letting it fall
  // through to the generic "no ready node" stall below, which would otherwise
  // be misreported as a cycle even though no cycle exists.
  for (const child of plan.children) {
    for (const dep of dependsOnMap.get(child.index) ?? []) {
      if (!knownIndices.has(dep)) {
        throw new SplitPlanDanglingDependencyError(child.index, dep);
      }
    }
  }

  const remainingDeps = new Map<number, Set<number>>();
  for (const index of indices) {
    remainingDeps.set(index, new Set(dependsOnMap.get(index) ?? []));
  }

  const order: number[] = [];
  const done = new Set<number>();

  while (order.length < indices.length) {
    let picked: number | null = null;
    for (const index of indices) {
      if (done.has(index)) {
        continue;
      }
      const deps = remainingDeps.get(index) ?? new Set<number>();
      const isReady = Array.from(deps).every((dep) => done.has(dep));
      if (isReady) {
        picked = index;
        break;
      }
    }
    if (picked === null) {
      // Unreachable: the cycle check and dangling-reference check above cover
      // every way this loop could otherwise fail to find a ready node.
      throw new SplitPlanCycleError(
        indices.filter((index) => !done.has(index)),
      );
    }
    order.push(picked);
    done.add(picked);
  }

  return order;
}

// ---------------------------------------------------------------------------
// deriveSplitBranchNames
// ---------------------------------------------------------------------------

export interface SplitBranchNames {
  integrationBranch: string;
  childBranches: Record<number, string>;
}

const TYPE_PREFIX_RE = /^(refactor|feat|feature):\s*/i;
const SLUG_MAX_LENGTH = 40;

function slugify(title: string): string {
  const withoutPrefix = title.replace(TYPE_PREFIX_RE, '');
  const lowered = withoutPrefix.toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  const truncated = trimmed.slice(0, SLUG_MAX_LENGTH).replace(/^-+|-+$/g, '');
  return truncated;
}

function makeRefSafe(segment: string): string {
  let safe = segment.replace(/\.\.+/g, '-');
  safe = safe.replace(/\.lock$/g, '');
  safe = safe.replace(/\.+$/g, '');
  safe = safe.replace(/^-+/g, '');
  return safe.length > 0 ? safe : 'child';
}

function padChildIndex(index: number): string {
  return String(index).padStart(2, '0');
}

export function deriveSplitBranchNames(
  headBranch: string,
  plan: SplitPlan,
): SplitBranchNames {
  const integrationBranch = `${headBranch}-split/integration`;
  const childBranches: Record<number, string> = {};
  const usedSlugs = new Set<string>();

  const orderedChildren = [...plan.children].sort((a, b) => a.index - b.index);
  for (const child of orderedChildren) {
    const baseSlug = makeRefSafe(slugify(child.title));
    let candidateSlug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(candidateSlug)) {
      candidateSlug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    usedSlugs.add(candidateSlug);
    childBranches[child.index] =
      `${headBranch}-split/${padChildIndex(child.index)}-${candidateSlug}`;
  }

  return { integrationBranch, childBranches };
}

// ---------------------------------------------------------------------------
// isSplitPlan — structural type guard over unknown
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'number')
  );
}

function isChildChange(value: unknown): value is ChildChange {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.file !== 'string') {
    return false;
  }
  if (value.hunks === 'all') {
    return true;
  }
  return isNumberArray(value.hunks);
}

function isRenamePair(value: unknown): value is { from: string; to: string } {
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string'
  );
}

function isConcern(
  value: unknown,
): value is { concern: string; kind: 'refactor' | 'behavior' } {
  return (
    isRecord(value) &&
    typeof value.concern === 'string' &&
    (value.kind === 'refactor' || value.kind === 'behavior')
  );
}

function isUnassignedHunkEntry(
  value: unknown,
): value is { file: string; hunkIndex: number } {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.hunkIndex === 'number'
  );
}

function isSplitPlanChild(value: unknown): value is SplitPlanChild {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.index !== 'number') {
    return false;
  }
  if (typeof value.title !== 'string') {
    return false;
  }
  if (value.type !== 'refactor' && value.type !== 'feature') {
    return false;
  }
  if (!isNumberArray(value.dependsOn)) {
    return false;
  }
  if (!Array.isArray(value.changes) || !value.changes.every(isChildChange)) {
    return false;
  }
  if (!Array.isArray(value.renames) || !value.renames.every(isRenamePair)) {
    return false;
  }
  if (typeof value.testProof !== 'string') {
    return false;
  }
  if (value.risk !== 'low' && value.risk !== 'med' && value.risk !== 'high') {
    return false;
  }
  if (typeof value.rationale !== 'string') {
    return false;
  }
  return true;
}

export function isSplitPlan(value: unknown): value is SplitPlan {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.finalGoal !== 'string') {
    return false;
  }
  if (!Array.isArray(value.concerns) || !value.concerns.every(isConcern)) {
    return false;
  }
  if (
    !Array.isArray(value.children) ||
    !value.children.every(isSplitPlanChild)
  ) {
    return false;
  }
  if (typeof value.parallelizable !== 'string') {
    return false;
  }
  if (typeof value.landOrder !== 'string') {
    return false;
  }
  if (typeof value.buildTestCommand !== 'string') {
    return false;
  }
  if (
    !Array.isArray(value.unassignedHunks) ||
    !value.unassignedHunks.every(isUnassignedHunkEntry)
  ) {
    return false;
  }
  return true;
}
