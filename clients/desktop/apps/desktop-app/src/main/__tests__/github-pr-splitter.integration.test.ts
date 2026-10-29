// Real-git integration coverage for the Split PR engine.
//
// This suite intentionally uses REAL git and REAL fs — no `jest.mock` for
// `node:fs/promises`, `../lib/git`, or
// `@canopy/desktop-shared/node/lib/pr-split-diff`.
// It proves that `executePrSplit`'s carve/orchestrator engine reproduces the
// original PR diff byte-for-byte against actual git repositories.
//
// GitHub side effects are the only thing faked: `createPr`, `closePr`,
// `updatePrBody`, the persisted `SplitPrMap`, worktree bookkeeping, the verify
// runner, and — crucially — `fetchPrData`. `fetchPrData` is a first-class
// injectable `SplitterDeps` member (see `SplitterDeps.fetchPrData`), so the
// pre-flight PR-detection seam is satisfied WITHOUT mocking `../lib/github-pr`.
// Every git-touching dep (`createWorktree` = `git worktree add`) is real.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gatherPrDiffSnapshot } from '@canopy/desktop-shared/node/lib/pr-split-diff';
import { validateSplitPlan as realValidatePlan } from '@canopy/desktop-shared/lib/pr-split-plan';
import type {
  RepoPrTrackingData,
  SplitPlan,
  SplitPlanChild,
  SplitPrMap,
} from '@canopy/desktop-shared/types/github';

import {
  executePrSplit,
  SplitPrExecutionError,
} from '../lib/github-pr-splitter';
import type { SplitterDeps } from '../lib/github-pr-splitter';

const TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// git fixture helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * The currently checked-out branch of a real git repo, or null when detached.
 * Used by the contract-faithful `fetchPrData` fake to resolve the
 * branchName-omitted (checkout-derived) lookup path exactly like production
 * `getCheckedOutBranch`.
 */
function getCheckedOutBranchName(cwd: string): Promise<string | null> {
  const name = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return Promise.resolve(name === 'HEAD' ? null : name);
}

/**
 * Configure a clone's local git identity and disable commit/tag signing so the
 * suite is hermetic: engine commits (`git commit`, `commit-tree`, merges) never
 * depend on the developer's global git config or a GPG agent. `git worktree
 * add` children share this clone's `.git/config`, so one call covers every
 * child worktree.
 */
function configureHermeticGit(repoPath: string): void {
  git(repoPath, ['config', 'user.name', 'Canopy Split Test']);
  git(repoPath, ['config', 'user.email', 'split-test@canopy.example']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  git(repoPath, ['config', 'tag.gpgsign', 'false']);
  // Deterministic merge-commit identity for the reconstructed-tip check.
  git(repoPath, ['config', 'merge.ff', 'false']);
}

interface Fixture {
  root: string;
  originPath: string;
  workPath: string;
  baseSha: string;
  headSha: string;
}

/**
 * Build a temp bare `origin.git` + a `work/` clone on `main`, apply the caller's
 * base + feature mutations, push both branches, and return the resolved base
 * (origin/main) and head SHAs. The clone's HEAD is left on the feature branch so
 * the pre-flight's `HEAD === snapshot.headRef` check passes.
 */
function buildFixture(params: {
  featureBranch: string;
  seedBase: (workPath: string) => void;
  seedFeature: (workPath: string) => void;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'canopy-split-int-'));
  const originPath = join(root, 'origin.git');
  const workPath = join(root, 'work');

  execFileSync('git', ['init', '--bare', '-b', 'main', originPath], {
    encoding: 'utf8',
  });
  execFileSync('git', ['clone', originPath, workPath], { encoding: 'utf8' });
  configureHermeticGit(workPath);

  // --- base commit on main ---
  params.seedBase(workPath);
  git(workPath, ['add', '-A']);
  git(workPath, ['commit', '-m', 'base: initial commit']);
  git(workPath, ['push', '-u', 'origin', 'main']);
  const baseSha = git(workPath, ['rev-parse', 'HEAD']);

  // --- feature branch ---
  git(workPath, ['checkout', '-b', params.featureBranch]);
  params.seedFeature(workPath);
  git(workPath, ['add', '-A']);
  git(workPath, ['commit', '-m', 'feature: multi-concern work']);
  git(workPath, ['push', '-u', 'origin', params.featureBranch]);
  const headSha = git(workPath, ['rev-parse', 'HEAD']);

  return { root, originPath, workPath, baseSha, headSha };
}

function cleanupFixture(fixture: Fixture | null): void {
  if (fixture) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// fake GitHub / map / worktree deps
// ---------------------------------------------------------------------------

interface CreatePrCall {
  branchName: string;
  title: string;
  baseBranch: string;
  body: string;
}

interface UpdateBodyCall {
  prNumber: number;
  body: string;
}

interface ClosePrCall {
  prNumber: number;
  comment?: string;
}

interface VerifyOutcome {
  exitCode: number;
  tail: string;
}

/**
 * Setup outcome the harness's `runWorktreeSetup` fake returns per worktree,
 * keyed by worktree id. Defaults to `completed`. `writesGitignoredMarker`
 * models a real setup script (e.g. `npm ci`) creating a gitignored artifact
 * (`node_modules/...`) which must NOT trip the carve's clean-worktree
 * precondition.
 */
interface SetupOutcome {
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
  writesGitignoredMarker?: boolean;
}

interface Harness {
  deps: SplitterDeps;
  map: { current: SplitPrMap | null };
  createPrCalls: CreatePrCall[];
  updateBodyCalls: UpdateBodyCall[];
  closePrCalls: ClosePrCall[];
  createWorktreeCalls: { branchName: string; baseBranch: string }[];
  worktreePaths: Map<string, string>;
  groupedWorktreeIds: string[];
  originalWorktreePatches: {
    branchName: string;
    trackedBaseBranch: string;
  }[];
  /**
   * Ordered log of `setup:<worktreeId>` / `carve:<worktreeId>` events, letting
   * a test assert that setup ran before the carve for each child.
   */
  lifecycle: string[];
}

/** Gitignored marker path a `writesGitignoredMarker` setup fake creates. */
const SETUP_MARKER_REL_PATH = 'node_modules/.canopy-setup-marker';

/**
 * Assemble a `SplitterDeps` where git-touching deps are real and GitHub/map deps
 * are fakes. `verifyByTitle` scripts per-child verify outcomes keyed by the
 * child's raw title (the carve build/test command runs against the resolved
 * child cwd). `existingMap` seeds a resume run with a previously-persisted map.
 */
function buildHarness(params: {
  fixture: Fixture;
  prData: RepoPrTrackingData;
  verifyByTitle?: Map<string, VerifyOutcome>;
  existingMap?: SplitPrMap | null;
  /** Per-worktree-id setup outcome the `runWorktreeSetup` fake returns. */
  setupByWorktreeId?: Map<string, SetupOutcome>;
  /** Default setup outcome when a worktree id has no entry above. */
  defaultSetupOutcome?: SetupOutcome;
}): Harness {
  const { fixture, prData } = params;

  const createPrCalls: CreatePrCall[] = [];
  const updateBodyCalls: UpdateBodyCall[] = [];
  const closePrCalls: ClosePrCall[] = [];
  const createWorktreeCalls: { branchName: string; baseBranch: string }[] = [];
  const worktreePaths = new Map<string, string>();
  const groupedWorktreeIds: string[] = [];
  const lifecycle: string[] = [];
  const originalWorktreePatches: {
    branchName: string;
    trackedBaseBranch: string;
  }[] = [];
  const mapRef: { current: SplitPrMap | null } = {
    current: params.existingMap ?? null,
  };

  let prCounter = 100;
  // Seed the worktree id counter past any id already recorded in a seeded
  // (resume) map so a newly created child worktree never collides with a
  // child that was created in a prior run.
  let worktreeCounter = highestChildWorktreeOrdinal(params.existingMap ?? null);

  // The fakes are synchronous but must satisfy the Promise-returning
  // `SplitterDeps` signatures, so they return `Promise.resolve(...)` rather than
  // being `async` (no `await` inside → the repo's `require-await` lint rule).
  const deps: SplitterDeps = {
    createWorktree: (opts): Promise<{ id: string }> => {
      createWorktreeCalls.push({
        branchName: opts.branchName,
        baseBranch: opts.baseBranch,
      });
      worktreeCounter += 1;
      const id = `child-wt-${worktreeCounter}`;
      const path = join(fixture.root, 'child-worktrees', id);
      // Real git worktree: a fresh checkout of `child.branchName` created off
      // `baseBranch`, mirroring production `createSingleRepoWorktree`. The carve
      // then mutates this worktree in place.
      git(fixture.workPath, [
        'worktree',
        'add',
        '-b',
        opts.branchName,
        path,
        opts.baseBranch,
      ]);
      worktreePaths.set(id, path);
      return Promise.resolve({ id });
    },
    runWorktreeSetup: (
      worktreeId: string,
    ): Promise<{
      status: 'completed' | 'failed' | 'skipped';
      detail?: string;
    }> => {
      lifecycle.push(`setup:${worktreeId}`);
      const outcome = params.setupByWorktreeId?.get(worktreeId) ??
        params.defaultSetupOutcome ?? { status: 'completed' };
      if (outcome.writesGitignoredMarker) {
        // Model a real setup script (npm ci) creating a gitignored artifact.
        // The child worktree's .gitignore (seeded by the fixture base) ignores
        // node_modules/, so this must NOT trip carveChild's clean precondition.
        const path = worktreePaths.get(worktreeId);
        if (path) {
          mkdirSync(join(path, 'node_modules'), { recursive: true });
          writeFileSync(join(path, SETUP_MARKER_REL_PATH), 'ok');
        }
      }
      return Promise.resolve({
        status: outcome.status,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      });
    },
    setWorktreeGrouping: (
      _workspaceId: string,
      worktreeId: string,
    ): Promise<void> => {
      groupedWorktreeIds.push(worktreeId);
      return Promise.resolve();
    },
    createPr: (
      _repoPath: string,
      branchName: string,
      title: string,
      body: string,
      baseBranch: string,
    ): Promise<{ prNumber: number; prUrl: string; created: boolean }> => {
      createPrCalls.push({ branchName, title, baseBranch, body });
      prCounter += 1;
      return Promise.resolve({
        prNumber: prCounter,
        prUrl: `https://github.test/pr/${prCounter}`,
        created: true,
      });
    },
    closePr: (
      _repoPath: string,
      prNumber: number,
      comment?: string,
    ): Promise<void> => {
      closePrCalls.push({ prNumber, comment });
      return Promise.resolve();
    },
    updatePrBody: (
      _repoPath: string,
      prNumber: number,
      body: string,
    ): Promise<void> => {
      updateBodyCalls.push({ prNumber, body });
      return Promise.resolve();
    },
    // No dependent-PR scenario is exercised by this real-git suite; a
    // dependent-PR-based retarget path is covered by the unit-level
    // `github-pr-splitter.test.ts` harness instead.
    listOpenPrsBasedOnBranch: (): ReturnType<
      SplitterDeps['listOpenPrsBasedOnBranch']
    > => Promise.resolve([]),
    updatePrBase: (): ReturnType<SplitterDeps['updatePrBase']> =>
      Promise.resolve({ prUrl: 'https://github.test/pr/0' }),
    updateOriginalWorktree: (
      _workspaceId: string,
      _worktreeId: string,
      patch: { branchName: string; trackedBaseBranch: string },
    ): Promise<void> => {
      originalWorktreePatches.push(patch);
      return Promise.resolve();
    },
    readMap: (): Promise<SplitPrMap | null> => Promise.resolve(mapRef.current),
    writeMap: (
      _workspaceId: string,
      _worktreeId: string,
      map: SplitPrMap,
    ): Promise<boolean> => {
      // Deep clone so later engine mutations of its in-memory `map` object do
      // not retroactively rewrite what a prior checkpoint recorded.
      mapRef.current = structuredClone(map);
      return Promise.resolve(true);
    },
    runVerifyCommand: (
      cwd: string,
    ): Promise<{ exitCode: number; tail: string }> => {
      // Verify runs at the tail of the carve, so record it here as the carve
      // marker keyed by the worktree id whose path this cwd is.
      for (const [id, path] of worktreePaths.entries()) {
        if (path === cwd) {
          lifecycle.push(`carve:${id}`);
          break;
        }
      }
      const title = readVerifyTitle(cwd);
      const outcome = params.verifyByTitle?.get(title);
      return Promise.resolve(outcome ?? { exitCode: 0, tail: '' });
    },
    resolveChildWorktreePath: (worktreeId: string): Promise<string> => {
      const path = worktreePaths.get(worktreeId);
      if (!path) {
        return Promise.reject(
          new Error(`No child worktree path for id "${worktreeId}"`),
        );
      }
      return Promise.resolve(path);
    },
    resolveOriginalWorktreePath: (): Promise<string> =>
      Promise.resolve(fixture.workPath),
    // Contract-faithful: return the original PR's data only when asked for the
    // original head branch, or when branchName is omitted while the repo is
    // checked out on the original head branch. After retarget the checkout is
    // the integration branch, so an omitted-branch (checkout-derived) lookup
    // must NOT resolve the original PR — this mirrors production
    // `fetchRepoPrTrackingData(repoPath, branch)`. The resume path reads the
    // map first and passes `map.originalHeadBranch`, so detection targets the
    // original PR regardless of the current checkout.
    fetchPrData: async (
      repoPath: string,
      branchName?: string,
    ): Promise<RepoPrTrackingData> => {
      const originalHeadBranch = prData.branchName;
      const branch =
        branchName ??
        (await getCheckedOutBranchName(repoPath)) ??
        originalHeadBranch;
      if (branch === originalHeadBranch) {
        return prData;
      }
      // Any other branch (e.g. the integration branch after retarget) has no
      // detectable ORIGINAL PR. Returning null status/snapshot models "no open
      // original PR from this branch's perspective".
      return {
        status: null,
        snapshot: null,
        branchName: branch,
        remote: prData.remote,
      };
    },
    // Fake generation: return distinct, recognizable content per child branch so
    // the recorded created/updated bodies can be asserted to contain the
    // generated content + separator + stack block. No LLM.
    generateChildPrContent: (args: {
      worktreePath: string;
      branchName: string;
      baseBranch: string;
    }): Promise<{ title: string; body: string } | null> =>
      Promise.resolve({
        title: `AI title for ${args.branchName}`,
        body: `AI body for ${args.branchName}`,
      }),
    validatePlan: realValidatePlan,
  };

  return {
    deps,
    map: mapRef,
    createPrCalls,
    updateBodyCalls,
    closePrCalls,
    createWorktreeCalls,
    worktreePaths,
    groupedWorktreeIds,
    originalWorktreePatches,
    lifecycle,
  };
}

/**
 * Highest `child-wt-N` ordinal already recorded in a seeded map, so a resume
 * harness continues numbering from there instead of colliding.
 */
function highestChildWorktreeOrdinal(map: SplitPrMap | null): number {
  if (!map) {
    return 0;
  }
  let highest = 0;
  for (const child of map.children) {
    const match = /^child-wt-(\d+)$/.exec(child.worktreeId ?? '');
    if (match) {
      highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
  }
  return highest;
}

/**
 * Resolve which child a verify invocation belongs to by reading the tip commit
 * subject of the worktree at `cwd`. The engine commits children as
 * `[i/total] <title>`, so the title is recoverable from `HEAD`'s subject.
 */
function readVerifyTitle(cwd: string): string {
  const subject = git(cwd, ['log', '-1', '--format=%s']);
  const match = /^\[\d+\/\d+\]\s+(.*)$/.exec(subject);
  return match ? match[1] : subject;
}

// ---------------------------------------------------------------------------
// PR-tracking + plan builders
// ---------------------------------------------------------------------------

/**
 * Build the fixture-derived `RepoPrTrackingData` the pre-flight's
 * `detectOriginalPr` consumes: it needs a PR number, url, base ref name, head
 * branch name, and `isCrossRepository:false`.
 */
function buildPrData(params: {
  headBranch: string;
  baseBranch: string;
  headSha: string;
  prNumber: number;
}): RepoPrTrackingData {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return {
    branchName: params.headBranch,
    remote: { owner: 'canopy', repo: 'fixture' },
    status: {
      prNumber: params.prNumber,
      prUrl: `https://github.test/pr/${params.prNumber}`,
      state: 'open',
      title: 'Original multi-concern PR',
      checkStatus: 'passing',
      checkDetails: [],
      reviewStatus: 'none',
      reviewers: [],
      hasConflicts: false,
      commentCount: 0,
      updatedAt: now,
    },
    snapshot: {
      version: 1,
      provider: 'github',
      capturedAt: now,
      includesComments: false,
      includesReviews: false,
      includesReviewComments: false,
      repository: {
        owner: 'canopy',
        name: 'fixture',
        fullName: 'canopy/fixture',
      },
      branch: {
        currentName: params.headBranch,
        headRefName: params.headBranch,
        baseRefName: params.baseBranch,
        headSha: params.headSha,
        baseSha: null,
      },
      pr: {
        id: 1,
        number: params.prNumber,
        nodeId: null,
        htmlUrl: `https://github.test/pr/${params.prNumber}`,
        apiUrl: null,
        state: 'open',
        isDraft: false,
        title: 'Original multi-concern PR',
        body: '',
        author: null,
        createdAt: now,
        updatedAt: now,
        mergedAt: null,
        closedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        isCrossRepository: false,
        labels: [],
        assignees: [],
        requestedReviewers: [],
      },
      issueComments: [],
      reviews: [],
      reviewComments: [],
    },
  };
}

function makeChild(params: {
  index: number;
  title: string;
  type: 'refactor' | 'feature';
  dependsOn: number[];
  changes: SplitPlanChild['changes'];
  renames?: { from: string; to: string }[];
}): SplitPlanChild {
  return {
    index: params.index,
    title: params.title,
    type: params.type,
    dependsOn: params.dependsOn,
    changes: params.changes,
    renames: params.renames ?? [],
    testProof: 'covered by fixture',
    risk: 'low',
    rationale: 'fixture',
  };
}

function makePlan(children: SplitPlanChild[]): SplitPlan {
  return {
    finalGoal: 'fixture split',
    concerns: [],
    children,
    parallelizable: 'no',
    landOrder: 'stacked',
    buildTestCommand: 'true',
    unassignedHunks: [],
  };
}

const noopProgress = (): void => {
  // progress events are irrelevant to content assertions
};

/** File content at a git ref for a path (throws if the path is absent). */
function fileAtRef(repoPath: string, ref: string, path: string): string {
  return execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: repoPath,
    encoding: 'utf8',
  });
}

/** Raw bytes of a blob at a git ref, for binary-identity comparisons. */
function bytesAtRef(repoPath: string, ref: string, path: string): Buffer {
  return execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: repoPath,
    maxBuffer: 1024 * 1024 * 16,
  });
}

// ===========================================================================
// Case 1 — multi-concern branch (1 refactor + 2 features, one stacked)
// ===========================================================================

describe('executePrSplit — real git integration', () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    cleanupFixture(fixture);
    fixture = null;
  });

  it(
    'case 1: carves a multi-concern branch and reconstructs the head tree exactly',
    async () => {
      const featureBranch = 'feature/multi';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          // util.ts: refactor target. helper.ts: feature 1. api.ts: feature 2
          // (stacked onto feature 1 via a shared-file edit).
          writeFileSync(
            join(work, 'util.ts'),
            ['export function add(a, b) {', '  return a + b;', '}', ''].join(
              '\n',
            ),
          );
          writeFileSync(
            join(work, 'feature.ts'),
            ['export const flag = false;', ''].join('\n'),
          );
        },
        seedFeature: (work) => {
          // Concern A (refactor): reshape util.ts (rename param, add a guard).
          writeFileSync(
            join(work, 'util.ts'),
            [
              'export function add(left, right) {',
              '  if (left === undefined) {',
              '    return right;',
              '  }',
              '  return left + right;',
              '}',
              '',
            ].join('\n'),
          );
          // Concern B (feature 1): a brand-new whole file.
          writeFileSync(
            join(work, 'greeter.ts'),
            [
              'export function greet(name) {',
              '  return `hi ${name}`;',
              '}',
              '',
            ].join('\n'),
          );
          // Concern C (feature 2): flip the flag in feature.ts.
          writeFileSync(
            join(work, 'feature.ts'),
            ['export const flag = true;', ''].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      // Topology: child 1 (refactor util.ts) at integration base; child 2
      // (greeter.ts feature) at integration base; child 3 (feature.ts) stacked
      // on child 1. Each child whole-owns its distinct file, so the plan is a
      // simple file partition.
      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'refactor: reshape add()',
          type: 'refactor',
          dependsOn: [],
          changes: [{ file: 'util.ts', hunks: 'all' }],
        }),
        makeChild({
          index: 2,
          title: 'feat: add greeter',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'greeter.ts', hunks: 'all' }],
        }),
        makeChild({
          index: 3,
          title: 'feat: enable flag',
          type: 'feature',
          dependsOn: [1],
          changes: [{ file: 'feature.ts', hunks: 'all' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 42,
      });

      const harness = buildHarness({ fixture, prData });

      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: harness.deps,
      });

      expect(result.status).toBe('completed');

      // --- CONTENT: each child's tip reproduces its assigned file exactly ---
      const child1 = result.children.find((c) => c.index === 1);
      const child2 = result.children.find((c) => c.index === 2);
      const child3 = result.children.find((c) => c.index === 3);
      expect(child1?.branchName).toBeDefined();
      expect(child2?.branchName).toBeDefined();
      expect(child3?.branchName).toBeDefined();

      const child1Branch = child1?.branchName ?? '';
      const child2Branch = child2?.branchName ?? '';
      const child3Branch = child3?.branchName ?? '';

      // Refactor child: util.ts matches head; feature.ts/greeter.ts untouched
      // vs base at that tip (child1 is based off integration = base tree).
      expect(fileAtRef(fixture.workPath, child1Branch, 'util.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.headSha, 'util.ts'),
      );
      expect(fileAtRef(fixture.workPath, child1Branch, 'feature.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.baseSha, 'feature.ts'),
      );

      // Feature 1 child: greeter.ts appears and equals head; it does NOT carry
      // the refactor (util.ts still at base).
      expect(fileAtRef(fixture.workPath, child2Branch, 'greeter.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.headSha, 'greeter.ts'),
      );
      expect(fileAtRef(fixture.workPath, child2Branch, 'util.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.baseSha, 'util.ts'),
      );

      // Feature 2 child (stacked on refactor): feature.ts flipped AND the
      // inherited refactor is present (it is based on child 1).
      expect(fileAtRef(fixture.workPath, child3Branch, 'feature.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.headSha, 'feature.ts'),
      );
      expect(fileAtRef(fixture.workPath, child3Branch, 'util.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.headSha, 'util.ts'),
      );

      // --- child PR create calls carry the right head/base per topology ---
      const prByBranch = new Map(
        harness.createPrCalls.map((c) => [c.branchName, c]),
      );
      expect(prByBranch.get(child1Branch)?.baseBranch).toBe(
        result.integrationBranch,
      );
      expect(prByBranch.get(child2Branch)?.baseBranch).toBe(
        result.integrationBranch,
      );
      // Stacked child 3 bases on child 1's branch, not integration.
      expect(prByBranch.get(child3Branch)?.baseBranch).toBe(child1Branch);

      // The engine's own reconstructed-tip check already passed (status
      // completed). Assert head-tree equality independently for defence in
      // depth by merging leaves ourselves.
      const leafTree = mergeLeavesAndGetTree(fixture, result);
      expect(leafTree).toBe(
        git(fixture.workPath, ['rev-parse', `${fixture.headSha}^{tree}`]),
      );

      // Child PR titles/bodies come from the standard generation flow: the
      // created body carries the generated content, a `---` separator, and the
      // stack block; the title prepends `[X/Y]` to the generated title.
      const child1Create = prByBranch.get(child1Branch);
      expect(child1Create?.title).toContain(`AI title for ${child1Branch}`);
      expect(child1Create?.title).toMatch(/^\[\d+\/\d+] /);
      expect(child1Create?.body).toContain(`AI body for ${child1Branch}`);
      expect(child1Create?.body).toContain('\n\n---\n\n');
      expect(child1Create?.body).toContain('Part of a Split PR of');

      // Integration + all children got a body-update pass.
      const integrationPr = result.integrationPrNumber ?? -1;
      expect(
        harness.updateBodyCalls.some((c) => c.prNumber === integrationPr),
      ).toBe(true);

      // The update pass preserved the generated content above the separator: a
      // refreshed child body still carries the generated base + `---` + stack.
      const child1BodyUpdate = harness.updateBodyCalls.find(
        (c) =>
          c.body.includes(`AI body for ${child1Branch}`) &&
          c.body.includes('Part of a Split PR of'),
      );
      expect(child1BodyUpdate).toBeDefined();
      expect(child1BodyUpdate?.body).toContain('\n\n---\n\n');
      // Original PR retargeted + closed.
      expect(harness.originalWorktreePatches).toContainEqual({
        branchName: result.integrationBranch,
        trackedBaseBranch: 'main',
      });
      expect(harness.closePrCalls.map((c) => c.prNumber)).toContain(42);
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 1b — worktree setup runs to completion before each child's carve,
  // and a gitignored setup artifact does not trip the carve precondition.
  // =========================================================================

  it(
    'case 1b: runs worktree setup before carve for each child; gitignored setup artifact does not break the clean precondition',
    async () => {
      const featureBranch = 'feature/setup-order';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          // Ignore the artifact a real setup script (npm ci) would create, so
          // the carve's `git status --porcelain` clean check is unaffected.
          writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
          writeFileSync(
            join(work, 'feature.ts'),
            ['export const flag = false;', ''].join('\n'),
          );
        },
        seedFeature: (work) => {
          writeFileSync(
            join(work, 'greeter.ts'),
            ['export function greet(name) {', '  return name;', '}', ''].join(
              '\n',
            ),
          );
          writeFileSync(
            join(work, 'feature.ts'),
            ['export const flag = true;', ''].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'feat: add greeter',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'greeter.ts', hunks: 'all' }],
        }),
        makeChild({
          index: 2,
          title: 'feat: enable flag',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'feature.ts', hunks: 'all' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 77,
      });

      const harness = buildHarness({
        fixture,
        prData,
        // Every child's setup writes a gitignored node_modules artifact.
        defaultSetupOutcome: {
          status: 'completed',
          writesGitignoredMarker: true,
        },
      });

      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: harness.deps,
      });

      expect(result.status).toBe('completed');

      // Ordering: for each child worktree, setup:<id> precedes carve:<id>.
      const worktreeIds = Array.from(harness.worktreePaths.keys());
      expect(worktreeIds.length).toBe(2);
      for (const id of worktreeIds) {
        const setupAt = harness.lifecycle.indexOf(`setup:${id}`);
        const carveAt = harness.lifecycle.indexOf(`carve:${id}`);
        expect(setupAt).toBeGreaterThanOrEqual(0);
        expect(carveAt).toBeGreaterThanOrEqual(0);
        expect(setupAt).toBeLessThan(carveAt);
      }

      // The gitignored artifact did not corrupt the carve: each child tip still
      // reproduces its assigned file exactly.
      const child1 = result.children.find((c) => c.index === 1);
      const child2 = result.children.find((c) => c.index === 2);
      expect(
        fileAtRef(fixture.workPath, child1?.branchName ?? '', 'greeter.ts'),
      ).toBe(fileAtRef(fixture.workPath, fixture.headSha, 'greeter.ts'));
      expect(
        fileAtRef(fixture.workPath, child2?.branchName ?? '', 'feature.ts'),
      ).toBe(fileAtRef(fixture.workPath, fixture.headSha, 'feature.ts'));
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 2 — refactor-first same file (hunk-split, stacked)
  // =========================================================================

  it(
    'case 2: refactor and stacked feature split hunks of the same file; feature tip is byte-identical to head',
    async () => {
      const featureBranch = 'feature/same-file';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          // A file with a clear top region (refactor target) and a bottom
          // region (feature target), separated by a wide band of stable
          // context (> 6 unchanged lines) so the U3 diff yields TWO independent
          // hunks rather than coalescing them into one.
          writeFileSync(
            join(work, 'service.ts'),
            [
              'function raw(input) {',
              '  return input * 2;',
              '}',
              '',
              '// stable line 1',
              '// stable line 2',
              '// stable line 3',
              '// stable line 4',
              '// stable line 5',
              '// stable line 6',
              '// stable line 7',
              '// stable line 8',
              '',
              'export function run(input) {',
              '  return raw(input);',
              '}',
              '',
            ].join('\n'),
          );
        },
        seedFeature: (work) => {
          // Refactor (top hunk): extract a `double` helper reshaping raw().
          // Feature (bottom hunk): add validation behavior in run().
          writeFileSync(
            join(work, 'service.ts'),
            [
              'function double(value) {',
              '  return value + value;',
              '}',
              '',
              '// stable line 1',
              '// stable line 2',
              '// stable line 3',
              '// stable line 4',
              '// stable line 5',
              '// stable line 6',
              '// stable line 7',
              '// stable line 8',
              '',
              'export function run(input) {',
              '  if (input < 0) {',
              '    throw new Error("negative");',
              '  }',
              '  return double(input);',
              '}',
              '',
            ].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const serviceEntry = snapshot.files.find((f) => f.path === 'service.ts');
      if (!serviceEntry) {
        throw new Error('service.ts missing from snapshot');
      }
      // Two independent hunks are required for a hunk-split same-file case.
      expect(serviceEntry.hunks.length).toBe(2);
      const [topHunk, bottomHunk] = serviceEntry.hunks;

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'refactor: extract double helper',
          type: 'refactor',
          dependsOn: [],
          changes: [{ file: 'service.ts', hunks: [topHunk.hunkIndex] }],
        }),
        makeChild({
          index: 2,
          title: 'feat: validate run input',
          type: 'feature',
          dependsOn: [1],
          changes: [{ file: 'service.ts', hunks: [bottomHunk.hunkIndex] }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 7,
      });
      const harness = buildHarness({ fixture, prData });

      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: harness.deps,
      });

      expect(result.status).toBe('completed');

      const refactorBranch =
        result.children.find((c) => c.index === 1)?.branchName ?? '';
      const featureBranchName =
        result.children.find((c) => c.index === 2)?.branchName ?? '';

      const headFile = fileAtRef(
        fixture.workPath,
        fixture.headSha,
        'service.ts',
      );
      const baseFile = fileAtRef(
        fixture.workPath,
        fixture.baseSha,
        'service.ts',
      );

      // Refactor child: only the top region is reshaped; the bottom feature
      // region is NOT yet present (still base's run()).
      const refactorFile = fileAtRef(
        fixture.workPath,
        refactorBranch,
        'service.ts',
      );
      expect(refactorFile).not.toBe(headFile);
      expect(refactorFile).not.toBe(baseFile);
      // The reshape carries ONLY its own (top) hunk: the helper is extracted,
      // but the bottom feature hunk is absent — run() still calls the OLD
      // helper name (`raw`) and has no validation guard. This is the precise
      // hunk-boundary behavior a same-file stacked split must produce.
      expect(refactorFile).toContain('function double(value)');
      expect(refactorFile).not.toContain('throw new Error("negative")');
      expect(refactorFile).toContain('return raw(input);');
      expect(refactorFile).not.toContain('return double(input);');

      // Stacked feature child's tip: byte-identical to the original head file.
      const featureFile = fileAtRef(
        fixture.workPath,
        featureBranchName,
        'service.ts',
      );
      expect(featureFile).toBe(headFile);

      // Topology sanity: feature bases on the refactor branch.
      const prByBranch = new Map(
        harness.createPrCalls.map((c) => [c.branchName, c]),
      );
      expect(prByBranch.get(featureBranchName)?.baseBranch).toBe(
        refactorBranch,
      );

      const leafTree = mergeLeavesAndGetTree(fixture, result);
      expect(leafTree).toBe(
        git(fixture.workPath, ['rev-parse', `${fixture.headSha}^{tree}`]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 3 — renames / deletes / binary, whole-owned
  // =========================================================================

  it(
    'case 3: renames, deletes, and a binary file are whole-owned and reconstruct the head tree byte-for-byte',
    async () => {
      const featureBranch = 'feature/mixed-ops';
      const binaryBase = Buffer.from([0, 1, 2, 3, 255, 254, 253, 0, 42]);
      const binaryHead = Buffer.from([9, 8, 7, 6, 0, 1, 2, 3, 200, 100]);

      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          // A file large enough that a small content edit still leaves it >50%
          // similar, so git `-M` rename detection fires instead of reporting an
          // add/delete pair.
          writeFileSync(
            join(work, 'old-name.ts'),
            [
              'export const value = 1;',
              'export const kept = true;',
              'export const alpha = "a";',
              'export const beta = "b";',
              'export const gamma = "c";',
              'export const delta = "d";',
              'export const epsilon = "e";',
              'export const zeta = "f";',
              '',
            ].join('\n'),
          );
          writeFileSync(
            join(work, 'to-delete.ts'),
            ['export const gone = "soon";', ''].join('\n'),
          );
          writeFileSync(join(work, 'asset.bin'), binaryBase);
        },
        seedFeature: (work) => {
          // Rename old-name.ts -> new-name.ts WITH a content edit (one line
          // changed, one line added; the bulk of the file is preserved).
          rmSync(join(work, 'old-name.ts'));
          writeFileSync(
            join(work, 'new-name.ts'),
            [
              'export const value = 2;',
              'export const kept = true;',
              'export const alpha = "a";',
              'export const beta = "b";',
              'export const gamma = "c";',
              'export const delta = "d";',
              'export const epsilon = "e";',
              'export const zeta = "f";',
              'export const added = "here";',
              '',
            ].join('\n'),
          );
          // Delete to-delete.ts.
          rmSync(join(work, 'to-delete.ts'));
          // Mutate the binary blob.
          writeFileSync(join(work, 'asset.bin'), binaryHead);
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const renamed = snapshot.files.find((f) => f.path === 'new-name.ts');
      const binary = snapshot.files.find((f) => f.path === 'asset.bin');
      expect(renamed?.kind).toBe('renamed');
      expect(renamed?.oldPath).toBe('old-name.ts');
      expect(binary?.isBinary).toBe(true);

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'chore: rename, delete, and update binary',
          type: 'feature',
          dependsOn: [],
          changes: [
            { file: 'new-name.ts', hunks: 'all' },
            { file: 'to-delete.ts', hunks: 'all' },
            { file: 'asset.bin', hunks: 'all' },
          ],
          renames: [{ from: 'old-name.ts', to: 'new-name.ts' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 11,
      });
      const harness = buildHarness({ fixture, prData });

      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: harness.deps,
      });

      expect(result.status).toBe('completed');
      const childBranch = result.children[0]?.branchName ?? '';

      // Renamed file present with content edits and equal to head.
      expect(fileAtRef(fixture.workPath, childBranch, 'new-name.ts')).toBe(
        fileAtRef(fixture.workPath, fixture.headSha, 'new-name.ts'),
      );
      // Old path is gone.
      const workPath = fixture.workPath;
      expect(() => fileAtRef(workPath, childBranch, 'old-name.ts')).toThrow();
      // Deleted file is gone.
      expect(() => fileAtRef(workPath, childBranch, 'to-delete.ts')).toThrow();
      // Binary blob byte-identical to head.
      expect(bytesAtRef(fixture.workPath, childBranch, 'asset.bin')).toEqual(
        binaryHead,
      );

      // Whole tree reconstructs byte-for-byte (single leaf).
      const leafTree = mergeLeavesAndGetTree(fixture, result);
      expect(leafTree).toBe(
        git(fixture.workPath, ['rev-parse', `${fixture.headSha}^{tree}`]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 4 — red verify on child 2 stops the split
  // =========================================================================

  it(
    'case 4: a red verify on child 2 stops the split with status failed and no downstream PRs',
    async () => {
      const featureBranch = 'feature/red-verify';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 0;', ''].join('\n'),
          );
          writeFileSync(
            join(work, 'b.ts'),
            ['export const b = 0;', ''].join('\n'),
          );
        },
        seedFeature: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 1;', ''].join('\n'),
          );
          writeFileSync(
            join(work, 'b.ts'),
            ['export const b = 2;', ''].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'feat: bump a',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'a.ts', hunks: 'all' }],
        }),
        makeChild({
          index: 2,
          title: 'feat: bump b',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'b.ts', hunks: 'all' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 55,
      });
      const verifyByTitle = new Map<string, VerifyOutcome>([
        ['feat: bump b', { exitCode: 1, tail: 'FAIL: b test exploded' }],
      ]);
      const harness = buildHarness({ fixture, prData, verifyByTitle });

      let thrown: unknown = null;
      try {
        await executePrSplit({
          projectId: 'proj',
          worktreeId: 'wt-original',
          plan,
          snapshot,
          signal: new AbortController().signal,
          onProgress: noopProgress,
          deps: harness.deps,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SplitPrExecutionError);
      if (thrown instanceof SplitPrExecutionError) {
        expect(thrown.childIndex).toBe(2);
        expect(thrown.verifyTail).toContain('b test exploded');
      }

      // Persisted map recorded status:'failed' with child 2 red + tail.
      const persisted = harness.map.current;
      expect(persisted?.status).toBe('failed');
      const persistedChild2 = persisted?.children.find((c) => c.index === 2);
      expect(persistedChild2?.verifyStatus).toBe('red');

      // Child 1 artifacts recorded (branch + worktree + PR).
      const persistedChild1 = persisted?.children.find((c) => c.index === 1);
      expect(persistedChild1?.worktreeId).toBeDefined();
      expect(persistedChild1?.prNumber).toBeDefined();

      // No PR for child 2, and no integration PR.
      expect(
        harness.createPrCalls.some((c) => c.title.includes('bump b')),
      ).toBe(false);
      expect(persisted?.integrationPrNumber).toBeUndefined();
      // Original PR NOT closed.
      expect(harness.closePrCalls).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 5 — resume after a red stop with a now-green verifier
  // =========================================================================

  it(
    'case 5: resuming after a red stop skips completed child 1 and finishes the split',
    async () => {
      const featureBranch = 'feature/resume';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 0;', ''].join('\n'),
          );
          writeFileSync(
            join(work, 'b.ts'),
            ['export const b = 0;', ''].join('\n'),
          );
        },
        seedFeature: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 1;', ''].join('\n'),
          );
          writeFileSync(
            join(work, 'b.ts'),
            ['export const b = 2;', ''].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'feat: bump a',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'a.ts', hunks: 'all' }],
        }),
        makeChild({
          index: 2,
          title: 'feat: bump b',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'b.ts', hunks: 'all' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 77,
      });

      // --- First run: red on child 2. ---
      const redVerify = new Map<string, VerifyOutcome>([
        ['feat: bump b', { exitCode: 1, tail: 'boom' }],
      ]);
      const firstHarness = buildHarness({
        fixture,
        prData,
        verifyByTitle: redVerify,
      });
      await expect(
        executePrSplit({
          projectId: 'proj',
          worktreeId: 'wt-original',
          plan,
          snapshot,
          signal: new AbortController().signal,
          onProgress: noopProgress,
          deps: firstHarness.deps,
        }),
      ).rejects.toBeInstanceOf(SplitPrExecutionError);

      const failedMap = firstHarness.map.current;
      expect(failedMap?.status).toBe('failed');
      const failedChild1 = failedMap?.children.find((c) => c.index === 1);
      const child1Branch = failedChild1?.branchName ?? '';
      const child1CarveSha = failedChild1?.carveCommitSha;
      expect(child1CarveSha).toBeDefined();

      // --- Resume: green verifier, seeded with the persisted (failed) map. ---
      // A resume runs in a fresh process, so the in-memory worktree-path map is
      // empty. Re-register every worktree path recorded by the first run (both
      // child 1, which fully carved, and child 2, whose worktree was created
      // and persisted before the red stop) so the recorded worktreeIds resolve.
      const resumeHarness = buildHarness({
        fixture,
        prData,
        existingMap: failedMap,
      });
      for (const [id, path] of Array.from(firstHarness.worktreePaths)) {
        resumeHarness.worktreePaths.set(id, path);
      }

      // No manual worktree reset here: the engine now handles a red-verify
      // child natively on resume. Child 2's red run recorded BOTH its carve sha
      // and `verifyStatus:'red'` and deliberately left the carve commit in its
      // worktree. On resume the engine recognizes the already-carved tip
      // (carve sha === branch tip), skips `carveChild` entirely, and re-verifies
      // the child standalone — which is now green — before pushing and opening
      // its PR. Child 1 (fully carved + green + PR recorded on the first run)
      // exercises the full skip path.
      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: resumeHarness.deps,
      });

      expect(result.status).toBe('completed');

      // Child 1 was NOT re-created on resume: no new worktree, no new PR for it.
      expect(
        resumeHarness.createWorktreeCalls.some(
          (c) => c.branchName === child1Branch,
        ),
      ).toBe(false);
      expect(
        resumeHarness.createPrCalls.some((c) => c.branchName === child1Branch),
      ).toBe(false);
      // Child 1's carve sha is unchanged across resume.
      const resumedChild1 = result.children.find((c) => c.index === 1);
      expect(resumedChild1?.carveCommitSha).toBe(child1CarveSha);

      // Child 2 IS created on resume and now green; integration PR opened.
      const child2Branch =
        result.children.find((c) => c.index === 2)?.branchName ?? '';
      expect(
        resumeHarness.createPrCalls.some((c) => c.branchName === child2Branch),
      ).toBe(true);
      expect(result.integrationPrNumber).toBeDefined();

      // Reconstructed tip reproduces head exactly.
      const leafTree = mergeLeavesAndGetTree(fixture, result);
      expect(leafTree).toBe(
        git(fixture.workPath, ['rev-parse', `${fixture.headSha}^{tree}`]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // Case 6 — tampered plan drives an unmatched carve run; worktree restored
  // =========================================================================
  //
  // The engine's carve is built to be robust for *well-formed* hunk splits:
  // `computeChildBaseDiffU0` recomputes the zero-context diff against each
  // child's actual base, so line-number drift alone never breaks a carve, and
  // `validateSplitPlan` rejects unassigned/duplicate/unstacked-shared-file
  // plans up front. To reach a genuine carve abort through PLAN DATA ALONE (no
  // matcher mock) we exploit the one seam the validator cannot see: a stacked
  // child whose owned hunk, when recomputed against its parent's tip, produces
  // a run whose core lines no longer match any original snapshot hunk.
  //
  // Construction: a file has two identical-content edit hunks separated by wide
  // context (H0 and H1 change the same text at two sites). The plan stacks
  // child 2 on child 1, gives child 1 the FIRST occurrence (hunk 0) and child 2
  // the SECOND (hunk 1). When child 2 recomputes its U0 diff against child 1's
  // tip — where occurrence 0 is ALREADY applied — only ONE run remains for the
  // still-unchanged occurrence, and the greedy cursor in
  // `matchRunsToOriginalHunks` binds it to original hunk index 0 (the earliest
  // identical-content match). Child 2 owns hunk index 1, so
  // `selected.length === 0`: no patch is applied, nothing is staged, and the
  // carve commit (`git commit`) fails on an empty index. That failure is caught
  // by `carveChild`, which restores child 2's worktree to its base
  // (`resetHardTo` + `cleanUntrackedFiles`) and rethrows a CarveError, folded by
  // the orchestrator into a `SplitPrExecutionError`.
  //
  // This is the closest carve abort reachable through plan data alone. A pure
  // `unmatched-run`/`ambiguous-run` from `matchRunsToOriginalHunks` requires a
  // recomputed run whose CORE LINES exist in the working diff but match no
  // original hunk (or span two). Because `computeChildBaseDiffU0` recomputes the
  // exact childBase->head diff, every recomputed run's content is by
  // construction a subsequence of the real base->head change, so its cores
  // always correspond to some original hunk — the matcher's own invariant makes
  // a genuine unmatched-run unreachable without corrupting the snapshot's
  // `coreLines` by hand (which would be faking the seam, forbidden here). The
  // identical-twin-hunk misassignment above is therefore the deepest reachable
  // carve failure, and it still exercises the load-bearing behavior: carve
  // aborts and the child worktree is restored clean.

  it(
    'case 6: a tampered hunk split yields a CarveError and restores the child worktree clean',
    async () => {
      const featureBranch = 'feature/tampered';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          // Two identical edit sites (TARGET) separated by wide stable context
          // so base->head yields two distinct-but-identical-content hunks.
          const lines: string[] = [];
          lines.push('TARGET');
          for (let i = 0; i < 10; i += 1) {
            lines.push(`stable ${i}`);
          }
          lines.push('TARGET');
          writeFileSync(join(work, 'twin.ts'), `${lines.join('\n')}\n`);
        },
        seedFeature: (work) => {
          const lines: string[] = [];
          lines.push('TARGET_CHANGED');
          for (let i = 0; i < 10; i += 1) {
            lines.push(`stable ${i}`);
          }
          lines.push('TARGET_CHANGED');
          writeFileSync(join(work, 'twin.ts'), `${lines.join('\n')}\n`);
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );
      const twin = snapshot.files.find((f) => f.path === 'twin.ts');
      if (!twin) {
        throw new Error('twin.ts missing from snapshot');
      }
      // Two identical-content hunks are required for the tamper to bite.
      expect(twin.hunks.length).toBe(2);
      expect(twin.hunks[0].contentHash).toBe(twin.hunks[1].contentHash);

      // Stacked split of the two occurrences across a parent/child pair. This
      // plan is well-formed to `validateSplitPlan` (every hunk owned once,
      // shared file is a linear chain) but drives an unmatched carve run.
      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'refactor: first occurrence',
          type: 'refactor',
          dependsOn: [],
          changes: [{ file: 'twin.ts', hunks: [twin.hunks[0].hunkIndex] }],
        }),
        makeChild({
          index: 2,
          title: 'feat: second occurrence',
          type: 'feature',
          dependsOn: [1],
          changes: [{ file: 'twin.ts', hunks: [twin.hunks[1].hunkIndex] }],
        }),
      ]);

      // The plan must pass validation, otherwise the pre-flight would reject it
      // before any carve runs (which would not exercise the carve seam).
      const validation = realValidatePlan(plan, snapshot);
      expect(validation.valid).toBe(true);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 88,
      });
      const harness = buildHarness({ fixture, prData });

      let thrown: unknown = null;
      try {
        await executePrSplit({
          projectId: 'proj',
          worktreeId: 'wt-original',
          plan,
          snapshot,
          signal: new AbortController().signal,
          onProgress: noopProgress,
          deps: harness.deps,
        });
      } catch (error) {
        thrown = error;
      }

      // Carve failure surfaces as a SplitPrExecutionError (CarveError is folded
      // into it by `toSplitPrError`). The concrete abort here is the empty-index
      // commit rejection produced by the misassigned twin hunk.
      expect(thrown).toBeInstanceOf(SplitPrExecutionError);
      if (thrown instanceof SplitPrExecutionError) {
        expect(thrown.message.toLowerCase()).toContain('commit');
      }
      expect(harness.map.current?.status).toBe('failed');

      // The child-2 worktree was restored clean at its base (no leftover carve
      // artifacts): porcelain empty AND HEAD back at the child base branch.
      const failedChild2 = harness.map.current?.children.find(
        (c) => c.index === 2,
      );
      const child2WorktreeId = failedChild2?.worktreeId ?? '';
      const child2Path = harness.worktreePaths.get(child2WorktreeId);
      if (!child2Path || !failedChild2) {
        throw new Error('child 2 worktree missing');
      }
      expect(git(child2Path, ['status', '--porcelain'])).toBe('');
      const headSha = git(child2Path, ['rev-parse', 'HEAD']);
      const baseSha = git(child2Path, ['rev-parse', failedChild2.baseBranch]);
      expect(headSha).toBe(baseSha);
    },
    TEST_TIMEOUT_MS,
  );
  // =========================================================================
  // Case 7 — resume after a post-retarget failure (closePr throws once)
  // =========================================================================
  //
  // After the retarget step checks out the integration branch, local HEAD no
  // longer sits at the recorded PR head. A failure AFTER retarget (here:
  // closePr) must still be resumable: the pre-flight HEAD-match/clean gates are
  // skipped when the original worktree is already on the integration branch,
  // and the retarget checkout is idempotent. This proves the resume completes
  // and closes the original.

  it(
    'case 7: a post-retarget closePr failure is resumable and the resume closes the original',
    async () => {
      const featureBranch = 'feature/post-retarget';
      fixture = buildFixture({
        featureBranch,
        seedBase: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 0;', ''].join('\n'),
          );
        },
        seedFeature: (work) => {
          writeFileSync(
            join(work, 'a.ts'),
            ['export const a = 1;', ''].join('\n'),
          );
        },
      });

      const snapshot = await gatherPrDiffSnapshot(
        fixture.workPath,
        fixture.baseSha,
        fixture.headSha,
      );

      const plan = makePlan([
        makeChild({
          index: 1,
          title: 'feat: bump a',
          type: 'feature',
          dependsOn: [],
          changes: [{ file: 'a.ts', hunks: 'all' }],
        }),
      ]);

      const prData = buildPrData({
        headBranch: featureBranch,
        baseBranch: 'main',
        headSha: fixture.headSha,
        prNumber: 99,
      });

      // --- First run: closePr throws once, after retarget already happened. ---
      const firstHarness = buildHarness({ fixture, prData });
      const realClosePr = firstHarness.deps.closePr;
      let closeAttempts = 0;
      firstHarness.deps.closePr = (
        repoPath: string,
        prNumber: number,
        comment?: string,
      ): Promise<void> => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          return Promise.reject(new Error('injected closePr failure'));
        }
        return realClosePr(repoPath, prNumber, comment);
      };

      await expect(
        executePrSplit({
          projectId: 'proj',
          worktreeId: 'wt-original',
          plan,
          snapshot,
          signal: new AbortController().signal,
          onProgress: noopProgress,
          deps: firstHarness.deps,
        }),
      ).rejects.toBeInstanceOf(SplitPrExecutionError);

      const failedMap = firstHarness.map.current;
      expect(failedMap?.status).toBe('failed');
      // Retarget already ran: the original worktree is on the integration branch.
      expect(git(fixture.workPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
        failedMap?.integrationBranch,
      );

      // --- Resume: local HEAD is on the integration branch, not the PR head. ---
      const resumeHarness = buildHarness({
        fixture,
        prData,
        existingMap: failedMap,
      });
      for (const [id, path] of Array.from(firstHarness.worktreePaths)) {
        resumeHarness.worktreePaths.set(id, path);
      }

      const result = await executePrSplit({
        projectId: 'proj',
        worktreeId: 'wt-original',
        plan,
        snapshot,
        signal: new AbortController().signal,
        onProgress: noopProgress,
        deps: resumeHarness.deps,
      });

      expect(result.status).toBe('completed');
      // The resume closed the original PR (#99) that the first run never did.
      expect(resumeHarness.closePrCalls.map((c) => c.prNumber)).toContain(99);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * Independently reconstruct the tip: in a throwaway detached worktree off the
 * integration branch, merge every leaf child branch and return the resulting
 * tree sha. Mirrors the engine's own check so a case can assert reconstruction
 * without trusting `status: 'completed'` alone.
 */
function mergeLeavesAndGetTree(fixture: Fixture, map: SplitPrMap): string {
  const dependedOn = new Set<number>();
  for (const child of map.children) {
    for (const dep of child.dependsOn) {
      dependedOn.add(dep);
    }
  }
  const leaves = map.children
    .filter((c) => !dependedOn.has(c.index))
    .map((c) => c.branchName);

  const tempPath = join(fixture.root, `recon-${Date.now()}`);
  git(fixture.workPath, [
    'worktree',
    'add',
    '--detach',
    tempPath,
    map.integrationBranch,
  ]);
  try {
    for (const branch of leaves) {
      git(tempPath, ['merge', '--no-ff', '-m', `merge ${branch}`, branch]);
    }
    return git(tempPath, ['rev-parse', 'HEAD^{tree}']);
  } finally {
    git(fixture.workPath, ['worktree', 'remove', '--force', tempPath]);
  }
}
