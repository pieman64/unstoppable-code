jest.mock('node:fs/promises');

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/tmp/worktree'),
}));

jest.mock('../lib/github-pr', () => ({
  fetchRepoPrTrackingData: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
}));

jest.mock('../lib/git', () => ({
  fetchOrigin: jest.fn(),
  getCurrentBranch: jest.fn(),
  isAncestor: jest.fn(),
  resolveRefSha: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/node/lib/pr-split-diff', () => ({
  gatherPrDiffSnapshot: jest.fn(),
}));

jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(),
  // Mirrors the real report-only posture (CAN-1641): no built-in tools, the
  // trusted internal report tool allowed, and no dangerous permission skip.
  structuredHelperReportOnlyPermission: jest.fn(() => ({
    tools: [],
    allowedTools: ['mcp__canopy__ReportStructuredResult'],
  })),
}));

jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@canopy/desktop-shared/lib/structured-helper-query',
  );
  return {
    ...actual,
    runCodexStructuredHelperQuery: jest.fn(),
  };
});

interface PlannerPreferencesFixture {
  splitPrPlannerModel: string;
  splitPrPlannerThinkingLevel: ThinkingLevel;
}

const readPreferencesFileMock = jest.fn<
  Promise<PlannerPreferencesFixture>,
  []
>();

jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof readPreferencesFileMock {
    return readPreferencesFileMock;
  },
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

function mockPreferences(preferences: PlannerPreferencesFixture): void {
  readPreferencesFileMock.mockResolvedValue(preferences);
}

const startObservedHelperTaskMock = jest.fn<
  void,
  [ObservedHelperTaskOptions]
>();
const finalizeObservedHelperTaskMock = jest.fn();

jest.mock('../lib/helper-observed-task', () => ({
  get startObservedHelperTask(): typeof startObservedHelperTaskMock {
    return startObservedHelperTaskMock;
  },
  get finalizeObservedHelperTask(): typeof finalizeObservedHelperTaskMock {
    return finalizeObservedHelperTaskMock;
  },
}));

const transcriptSeedMock = jest.fn();
const transcriptAppendEventMock = jest.fn();

jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: jest.fn(() => ({
    get seed(): typeof transcriptSeedMock {
      return transcriptSeedMock;
    },
    get appendEvent(): typeof transcriptAppendEventMock {
      return transcriptAppendEventMock;
    },
  })),
}));

jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(() =>
    Promise.resolve({
      providerType: 'claude',
      sdkModel: undefined,
      envOverride: undefined,
    }),
  ),
}));

const resolveHelperInvocationMock = jest.fn<
  Promise<Record<string, unknown>>,
  unknown[]
>();
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (
    ...args: unknown[]
  ): Promise<Record<string, unknown>> => resolveHelperInvocationMock(...args),
}));
const resolveInvocationWorkOwnerMock = jest.fn();
jest.mock('../agents/work-owner', () => ({
  resolveInvocationWorkOwner: (...args: unknown[]): unknown =>
    resolveInvocationWorkOwnerMock(...args),
}));

import { lstat, readFile, realpath } from 'node:fs/promises';
import {
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type {
  DiffFileEntry,
  DiffHunk,
  PersistedPrSnapshotFileV1,
  PrDiffSnapshot,
  RepoPrTrackingData,
  SplitPlan,
} from '@canopy/desktop-shared/types/github';
import { isSplitPlan } from '@canopy/desktop-shared/lib/pr-split-plan';
import { gatherPrDiffSnapshot } from '@canopy/desktop-shared/node/lib/pr-split-diff';
import { runCodexStructuredHelperQuery } from '@canopy/desktop-shared/lib/structured-helper-query';
import { runStructuredHelper } from '../integration/structured-helper-dispatch';
import {
  fetchOrigin,
  getCurrentBranch,
  isAncestor,
  resolveRefSha,
} from '../lib/git';
import { fetchRepoPrTrackingData } from '../lib/github-pr';
import type { ObservedHelperTaskOptions } from '../lib/helper-observed-task';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { planPrSplit, PrSplitPlanningError } from '../lib/pr-split-planner';
import {
  buildSplitPlannerSystemPrompt,
  buildSplitPlannerUserPrompt,
  buildSplitPlanStructuralRetryAddendum,
  buildSplitPlanValidationRetryAddendum,
  SPLIT_PLAN_JSON_SCHEMA,
} from '../lib/pr-split-planner-prompt';

initClaudeModels([
  { id: 'opus[1m]', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initClaudeModels([
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'sonnet', label: 'Claude Sonnet' },
]);
initModelAliases({ 'claude-opus-5': 'opus[1m]' });

const mockedReadFile = jest.mocked(readFile);
const mockedLstat = jest.mocked(lstat);
const mockedRealpath = jest.mocked(realpath);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedFetchRepoPrTrackingData = jest.mocked(fetchRepoPrTrackingData);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedIsAncestor = jest.mocked(isAncestor);
const mockedResolveRefSha = jest.mocked(resolveRefSha);
const mockedGatherPrDiffSnapshot = jest.mocked(gatherPrDiffSnapshot);
const mockedRunStructuredHelper = jest.mocked(runStructuredHelper);
const mockedRunCodexStructuredHelperQuery = jest.mocked(
  runCodexStructuredHelperQuery,
);

function pathLikeToText(path: unknown): string {
  if (typeof path === 'string') {
    return path;
  }
  if (Buffer.isBuffer(path)) {
    return path.toString('utf8');
  }
  if (path instanceof URL) {
    return path.pathname;
  }
  throw new Error('Unexpected non-path argument');
}

const REPO_PATH = '/tmp/worktree';
const HEAD_SHA = 'headsha1234567890headsha1234567890headsha';
const BASE_SHA = 'basesha1234567890basesha1234567890basesha';

function makeHunk(
  file: string,
  hunkIndex: number,
  additions: number,
  deletions: number,
): DiffHunk {
  return {
    file,
    hunkIndex,
    header: `@@ -1,${deletions} +1,${additions} @@`,
    contentHash: `hash-${file}-${hunkIndex}`,
    coreLines: [`+core-line-secret-${file}-${hunkIndex}`],
    occurrenceIndex: 0,
    additions,
    deletions,
    preview: `@@ preview-of ${file} hunk ${hunkIndex}`,
  };
}

function makeDiffSnapshot(): PrDiffSnapshot {
  const registryHunks = [
    makeHunk('src/registry.ts', 0, 1, 0),
    makeHunk('src/registry.ts', 1, 2, 1),
  ];
  const clientHunks = [makeHunk('src/client.ts', 0, 3, 1)];
  const files: DiffFileEntry[] = [
    {
      path: 'src/registry.ts',
      kind: 'modified',
      isBinary: false,
      additions: 3,
      deletions: 1,
      hunks: registryHunks,
    },
    {
      path: 'src/client.ts',
      kind: 'modified',
      isBinary: false,
      additions: 3,
      deletions: 1,
      hunks: clientHunks,
    },
  ];
  return {
    baseRef: BASE_SHA,
    headRef: HEAD_SHA,
    files,
    totalAdditions: 6,
    totalDeletions: 2,
  };
}

function makeValidPlan(): SplitPlan {
  return {
    finalGoal: 'Split the registry refactor from the client feature',
    concerns: [
      { concern: 'extract registry seam', kind: 'refactor' },
      { concern: 'client uses seam', kind: 'behavior' },
    ],
    children: [
      {
        index: 1,
        title: 'refactor: extract registry seam',
        type: 'refactor',
        dependsOn: [],
        changes: [{ file: 'src/registry.ts', hunks: 'all' }],
        renames: [],
        testProof: 'existing tests unchanged',
        risk: 'low',
        rationale: 'reshapes the registry without behavior change',
      },
      {
        index: 2,
        title: 'feat: client consumes registry seam',
        type: 'feature',
        dependsOn: [],
        changes: [{ file: 'src/client.ts', hunks: 'all' }],
        renames: [],
        testProof: 'new client tests',
        risk: 'low',
        rationale: 'adds the client behavior',
      },
    ],
    parallelizable: 'children 1 and 2 are independent',
    landOrder: '1 then 2',
    buildTestCommand: 'npm test',
    unassignedHunks: [],
  };
}

function makeInvalidPlan(): SplitPlan {
  const plan = makeValidPlan();
  // Drop the client child: src/client.ts hunk 0 becomes unassigned and the
  // aggregate no longer matches the snapshot totals.
  plan.children = [plan.children[0]];
  return plan;
}

interface TrackingOverrides {
  baseRefName?: string;
  headSha?: string;
  state?: PersistedPrSnapshotFileV1['pr']['state'];
  isCrossRepository?: boolean;
  snapshot?: PersistedPrSnapshotFileV1 | null;
}

function makeTrackingData(
  overrides: TrackingOverrides = {},
): RepoPrTrackingData {
  if (overrides.snapshot === null) {
    return {
      status: null,
      snapshot: null,
      branchName: 'feature-x',
      remote: { owner: 'acme', repo: 'app' },
    };
  }

  const snapshot: PersistedPrSnapshotFileV1 = {
    version: 1,
    provider: 'github',
    capturedAt: '2026-07-01T00:00:00.000Z',
    includesComments: false,
    includesReviews: false,
    includesReviewComments: false,
    repository: { owner: 'acme', name: 'app', fullName: 'acme/app' },
    branch: {
      currentName: 'feature-x',
      headRefName: 'feature-x',
      baseRefName: overrides.baseRefName ?? 'develop',
      headSha: overrides.headSha ?? HEAD_SHA,
      baseSha: null,
    },
    pr: {
      id: 1,
      number: 42,
      nodeId: null,
      htmlUrl: 'https://github.com/acme/app/pull/42',
      apiUrl: null,
      state: overrides.state ?? 'open',
      isDraft: false,
      title: 'Big combined PR',
      body: 'A refactor and a feature in one diff.',
      author: null,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: overrides.isCrossRepository ?? false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  };

  return {
    status: null,
    snapshot,
    branchName: 'feature-x',
    remote: { owner: 'acme', repo: 'app' },
  };
}

const USAGE_FIXTURE = { inputTokens: 10, outputTokens: 5 };

async function expectPlanningError(
  promise: Promise<unknown>,
  code: string,
  messagePattern?: RegExp,
): Promise<PrSplitPlanningError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PrSplitPlanningError);
  const planningError = caught as PrSplitPlanningError;
  expect(planningError.code).toBe(code);
  if (messagePattern) {
    expect(planningError.message).toMatch(messagePattern);
  }
  return planningError;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveInvocationWorkOwnerMock.mockResolvedValue({
    kind: 'organization',
    organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  mockedLstat.mockResolvedValue({
    isSymbolicLink: () => false,
    isFile: () => true,
  } as Awaited<ReturnType<typeof lstat>>);
  mockedRealpath.mockImplementation((path) => Promise.resolve(String(path)));
  mockedIsMultiRepoWorkspace.mockReturnValue(false);
  mockedResolveWorktreeCwd.mockReturnValue(REPO_PATH);
  mockedGetCurrentBranch.mockResolvedValue('feature-x');
  mockedFetchRepoPrTrackingData.mockResolvedValue(makeTrackingData());
  mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
    branch: 'main',
    existsLocally: true,
    existsInRemote: true,
  });
  mockedFetchOrigin.mockResolvedValue(undefined);
  mockedResolveRefSha.mockImplementation((_repoPath, ref) =>
    Promise.resolve(ref === 'HEAD' ? HEAD_SHA : BASE_SHA),
  );
  mockedIsAncestor.mockResolvedValue(true);
  mockedGatherPrDiffSnapshot.mockResolvedValue(makeDiffSnapshot());
  mockedRunStructuredHelper.mockResolvedValue({
    value: makeValidPlan(),
    usage: { ...USAGE_FIXTURE },
  });
  resolveHelperInvocationMock.mockImplementation(
    (...args: unknown[]): Promise<Record<string, unknown>> => {
      const model = args[0];
      if (typeof model !== 'string') throw new TypeError('Expected model ID');
      return Promise.resolve(
        model.startsWith('gpt-')
          ? {
              providerType: 'codex',
              source: 'codex-managed',
              harness: 'codex',
              sdkModel: model,
              aiCreditsRouted: false,
            }
          : {
              providerType: 'claude',
              source: 'claude-managed',
              harness: 'claude',
              sdkModel: model,
              aiCreditsRouted: false,
            },
      );
    },
  );
  // Matches github-pr-generator.test.ts: the reader is module-mocked, so a
  // partial preferences object is sufficient for the fields the planner reads.
  mockPreferences({
    splitPrPlannerModel: 'claude-opus-5',
    splitPrPlannerThinkingLevel: 'high',
  });
  delete process.env.CANOPY_TEST_SPLIT_PLAN_FIXTURE;
});

describe('planPrSplit refusals', () => {
  it('refuses multi-repo worktrees without starting an observed task', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'multi_repo_unsupported',
      /multi-repo/i,
    );
    expect(startObservedHelperTaskMock).not.toHaveBeenCalled();
    expect(mockedRunStructuredHelper).not.toHaveBeenCalled();
  });

  it('no longer refuses on Windows: planning proceeds once the gate is removed', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      // With the v1 Windows gate removed, win32 planning runs the full path
      // (all mocks resolve happily in beforeEach), so it starts an observed
      // task and invokes the structured helper rather than throwing a
      // platform refusal.
      await expect(
        planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      ).resolves.toBeDefined();
      expect(startObservedHelperTaskMock).toHaveBeenCalled();
      expect(mockedRunStructuredHelper).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('refuses when no PR tracking snapshot exists', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeTrackingData({ snapshot: null }),
    );

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'no_open_pr',
      /open pull request/i,
    );
    expect(startObservedHelperTaskMock).not.toHaveBeenCalled();
  });

  it('refuses when the PR is not open', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeTrackingData({ state: 'merged' }),
    );

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'no_open_pr',
    );
  });

  it('refuses fork / cross-repository PRs', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeTrackingData({ isCrossRepository: true }),
    );

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'fork_pr_unsupported',
      /fork|cross-repo/i,
    );
    expect(startObservedHelperTaskMock).not.toHaveBeenCalled();
  });

  it('refuses when local HEAD drifted from the PR head, before observing or gathering', async () => {
    mockedResolveRefSha.mockImplementation((_repoPath, ref) =>
      Promise.resolve(ref === 'HEAD' ? 'differentlocalsha' : BASE_SHA),
    );

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'head_out_of_sync',
      /sync|push/i,
    );
    expect(mockedGatherPrDiffSnapshot).not.toHaveBeenCalled();
    expect(startObservedHelperTaskMock).not.toHaveBeenCalled();
  });

  it('refuses when the base is not an ancestor of the PR head', async () => {
    mockedIsAncestor.mockResolvedValue(false);

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'base_not_ancestor',
      /rebase|merge/i,
    );
    expect(mockedIsAncestor).toHaveBeenCalledWith(
      REPO_PATH,
      BASE_SHA,
      HEAD_SHA,
    );
    expect(startObservedHelperTaskMock).not.toHaveBeenCalled();
  });
});

describe('planPrSplit origin fetch', () => {
  it('bounds the fetch with a 30 second signal so a prompt cannot hold the split', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      await planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' });

      expect(timeout).toHaveBeenCalledWith(30_000);
      const options = mockedFetchOrigin.mock.calls[0]?.[1];
      expect(options?.nonInteractive).toBe(true);
      expect(options?.signal).toBe(timeout.mock.results[0]?.value);
    } finally {
      timeout.mockRestore();
    }
  });

  it('plans against the refs already here when the fetch fails or times out', async () => {
    mockedFetchOrigin.mockRejectedValueOnce(
      new Error('The operation timed out'),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await planPrSplit({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });

      expect(response.originalPr.baseBranch).toBe('develop');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('origin fetch failed or timed out'),
        expect.objectContaining({ repoPath: REPO_PATH }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(mockedResolveRefSha).toHaveBeenCalledWith(
      REPO_PATH,
      'origin/develop',
    );
  });
});

describe('planPrSplit base detection', () => {
  it('detects the base branch from the PR (develop) and diffs against it', async () => {
    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      REPO_PATH,
      expect.objectContaining({ prune: true }),
    );
    expect(mockedResolveRefSha).toHaveBeenCalledWith(
      REPO_PATH,
      'origin/develop',
    );
    expect(mockedGatherPrDiffSnapshot).toHaveBeenCalledWith(
      REPO_PATH,
      BASE_SHA,
      HEAD_SHA,
    );
    expect(response.originalPr.baseBranch).toBe('develop');
  });

  it('detects a release-branch base from the PR', async () => {
    mockedFetchRepoPrTrackingData.mockResolvedValue(
      makeTrackingData({ baseRefName: 'release/1.2' }),
    );

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedResolveRefSha).toHaveBeenCalledWith(
      REPO_PATH,
      'origin/release/1.2',
    );
    expect(response.originalPr.baseBranch).toBe('release/1.2');
  });

  it('prefers the PR base over a mismatching worktree-configured base', async () => {
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoPath: REPO_PATH,
    });
    expect(response.originalPr.baseBranch).toBe('develop');
    expect(mockedResolveRefSha).not.toHaveBeenCalledWith(
      REPO_PATH,
      'origin/main',
    );
  });
});

describe('planPrSplit LLM planning', () => {
  it('resolves helper routing against the planner project credentials', async () => {
    await planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' });

    expect(resolveHelperInvocationMock).toHaveBeenCalledWith(
      'claude-opus-5',
      undefined,
      {
        workspaceId: 'ws-1',
        workOwner: {
          kind: 'organization',
          organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
    );
  });

  it('returns the plan, snapshot, and original PR metadata on success', async () => {
    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(response.plan).toEqual(makeValidPlan());
    expect(response.snapshot).toEqual(makeDiffSnapshot());
    expect(response.originalPr).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/app/pull/42',
      baseBranch: 'develop',
      headBranch: 'feature-x',
      headSha: HEAD_SHA,
    });

    expect(mockedRunStructuredHelper).toHaveBeenCalledTimes(1);
    const callOptions = mockedRunStructuredHelper.mock.calls[0][0];
    expect(callOptions.model).toBe('claude-opus-5');
    expect(callOptions.thinkingLevel).toBe('high');
    expect(callOptions.schema).toBe(SPLIT_PLAN_JSON_SCHEMA);
    expect(callOptions.isResult).toBe(isSplitPlan);
    expect(callOptions.kind).toBe('pr_split_planning');
  });

  it('omits symlinked or escaped repo context files from the helper prompt', async () => {
    mockedLstat.mockImplementation((path) =>
      Promise.resolve({
        isSymbolicLink: () => pathLikeToText(path).endsWith('CODEOWNERS'),
        isFile: () => true,
      } as Awaited<ReturnType<typeof lstat>>),
    );
    mockedRealpath.mockImplementation((path) => {
      const pathText = pathLikeToText(path);
      if (pathText.toLowerCase().includes('pull_request_template.md')) {
        return Promise.resolve('/Users/dev/.ssh/id_rsa');
      }
      return Promise.resolve(pathText);
    });
    mockedReadFile.mockImplementation((path) => {
      const pathText = pathLikeToText(path);
      if (pathText.endsWith('CONTRIBUTING.md')) {
        return Promise.resolve('safe contributing guidance');
      }
      if (pathText.endsWith('CLAUDE.md')) {
        return Promise.resolve('safe local agent guidance');
      }
      if (pathText.endsWith('package.json')) {
        return Promise.resolve(
          JSON.stringify({ scripts: { test: 'jest --runInBand' } }),
        );
      }
      if (pathText === '/Users/dev/.ssh/id_rsa') {
        return Promise.resolve(`sensitive content from ${pathText}`);
      }
      return Promise.reject(new Error('ENOENT'));
    });

    await planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' });

    const userMessage = mockedRunStructuredHelper.mock.calls[0][0].userMessage;
    expect(userMessage).toContain('safe contributing guidance');
    expect(userMessage).toContain('safe local agent guidance');
    expect(userMessage).toContain('package.json scripts: test');
    expect(userMessage).not.toContain('sensitive content');
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      expect.stringContaining('CODEOWNERS'),
      'utf-8',
    );
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      '/Users/dev/.ssh/id_rsa',
      'utf-8',
    );
  });

  it('starts and finalizes the observed task with usage on success', async () => {
    await planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' });

    expect(startObservedHelperTaskMock).toHaveBeenCalledTimes(1);
    const startOptions = startObservedHelperTaskMock.mock.calls[0][0];
    expect(startOptions.eventType).toBe('pr_split_planning');
    expect(startOptions.model).toBe('claude-opus-5');
    expect(startOptions.auditContext).toEqual({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledTimes(1);
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      startOptions.taskKey,
      'success',
      undefined,
      expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
    );
  });

  it('retries once when the plan fails validation, appending the issues', async () => {
    mockedRunStructuredHelper
      .mockResolvedValueOnce({
        value: makeInvalidPlan(),
        usage: { ...USAGE_FIXTURE },
      })
      .mockResolvedValueOnce({
        value: makeValidPlan(),
        usage: { ...USAGE_FIXTURE },
      });

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedRunStructuredHelper).toHaveBeenCalledTimes(2);
    expect(resolveInvocationWorkOwnerMock).toHaveBeenCalledTimes(1);
    expect(resolveHelperInvocationMock).toHaveBeenCalledTimes(2);
    for (const call of resolveHelperInvocationMock.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        }),
      );
    }
    const firstMessage = mockedRunStructuredHelper.mock.calls[0][0].userMessage;
    const retryMessage = mockedRunStructuredHelper.mock.calls[1][0].userMessage;
    expect(firstMessage).not.toContain('unassigned-hunk');
    expect(retryMessage).toContain('unassigned-hunk');
    expect(retryMessage).toContain('src/client.ts');

    expect(response.plan).toEqual(makeValidPlan());
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'success',
      undefined,
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('surfaces the validation issues after a failed retry', async () => {
    mockedRunStructuredHelper.mockResolvedValue({
      value: makeInvalidPlan(),
      usage: { ...USAGE_FIXTURE },
    });

    const error = await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'invalid_plan',
    );

    expect(mockedRunStructuredHelper).toHaveBeenCalledTimes(2);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.some((issue) => issue.code === 'unassigned-hunk')).toBe(
      true,
    );
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      expect.stringContaining('invalid'),
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('finalizes the observed task as failure when the LLM query throws', async () => {
    mockedRunStructuredHelper.mockRejectedValue(new Error('provider exploded'));

    await expect(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
    ).rejects.toThrow('provider exploded');

    expect(startObservedHelperTaskMock).toHaveBeenCalledTimes(1);
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'provider exploded',
      undefined,
    );
  });

  it('keeps attempt-1 usage when the provider fails on the retry attempt', async () => {
    mockedRunStructuredHelper
      .mockResolvedValueOnce({
        value: makeInvalidPlan(),
        usage: { ...USAGE_FIXTURE },
      })
      .mockRejectedValueOnce(new Error('provider exploded on retry'));

    await expect(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
    ).rejects.toThrow('provider exploded on retry');

    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'provider exploded on retry',
      expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
    );
  });

  it('routes Codex planner models through the Codex structured helper query', async () => {
    mockPreferences({
      splitPrPlannerModel: 'gpt-5.5',
      splitPrPlannerThinkingLevel: 'high',
    });
    mockedRunCodexStructuredHelperQuery.mockResolvedValue({
      value: makeValidPlan(),
      usage: { ...USAGE_FIXTURE },
    });

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedRunCodexStructuredHelperQuery).toHaveBeenCalledTimes(1);
    expect(mockedRunStructuredHelper).not.toHaveBeenCalled();
    const codexOptions = mockedRunCodexStructuredHelperQuery.mock.calls[0][0];
    expect(codexOptions.model).toBe('gpt-5.5');
    expect(codexOptions.isResult).toBe(isSplitPlan);
    expect(response.plan).toEqual(makeValidPlan());
  });

  it('retries once on Codex when the first response fails isSplitPlan, then succeeds', async () => {
    mockPreferences({
      splitPrPlannerModel: 'gpt-5.5',
      splitPrPlannerThinkingLevel: 'high',
    });
    mockedRunCodexStructuredHelperQuery
      .mockResolvedValueOnce({
        // Wrong shape: top-level `pr` wrapper, `files` instead of `changes`,
        // 0-based index — mirrors the 2026-07-02 dogfood failure.
        value: null,
        usage: { ...USAGE_FIXTURE },
      })
      .mockResolvedValueOnce({
        value: makeValidPlan(),
        usage: { ...USAGE_FIXTURE },
      });

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedRunCodexStructuredHelperQuery).toHaveBeenCalledTimes(2);
    const combinedPrompts = mockedRunCodexStructuredHelperQuery.mock.calls.map(
      (call) => call[0].combinedPrompt,
    );
    expect(combinedPrompts[0]).not.toContain('Your previous response was not');
    expect(combinedPrompts[1]).toContain(
      'Your previous response was not valid',
    );
    expect(combinedPrompts[1]).toContain('No top-level `pr` wrapper');

    expect(response.plan).toEqual(makeValidPlan());
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'success',
      undefined,
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('retries once on Claude when the first response fails isSplitPlan, then succeeds', async () => {
    mockPreferences({
      splitPrPlannerModel: 'sonnet',
      splitPrPlannerThinkingLevel: 'high',
    });
    mockedRunStructuredHelper
      .mockResolvedValueOnce({
        // Structurally invalid: fails isSplitPlan entirely (e.g. wrong shape),
        // distinct from a structurally-valid-but-semantically-invalid plan.
        value: null,
        usage: { ...USAGE_FIXTURE },
      })
      .mockResolvedValueOnce({
        value: makeValidPlan(),
        usage: { ...USAGE_FIXTURE },
      });

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(mockedRunStructuredHelper).toHaveBeenCalledTimes(2);
    const firstMessage = mockedRunStructuredHelper.mock.calls[0][0].userMessage;
    const retryMessage = mockedRunStructuredHelper.mock.calls[1][0].userMessage;
    expect(firstMessage).not.toContain('Your previous response was not');
    expect(retryMessage).toContain('Your previous response was not valid');
    expect(retryMessage).toContain(buildSplitPlanStructuralRetryAddendum());

    expect(response.plan).toEqual(makeValidPlan());
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'success',
      undefined,
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('fails with the existing "no structured Split Plan" error after two structural rejections on Codex, spending exactly 2 calls', async () => {
    mockPreferences({
      splitPrPlannerModel: 'gpt-5.5',
      splitPrPlannerThinkingLevel: 'high',
    });
    mockedRunCodexStructuredHelperQuery.mockResolvedValue({
      value: null,
      usage: { ...USAGE_FIXTURE },
    });

    await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'invalid_plan',
      /no structured Split Plan/i,
    );

    expect(mockedRunCodexStructuredHelperQuery).toHaveBeenCalledTimes(2);
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      expect.stringContaining('no structured Split Plan'),
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('surfaces validation issues (not a third call) when a structural retry produces a structurally-valid but semantically-invalid plan', async () => {
    mockPreferences({
      splitPrPlannerModel: 'gpt-5.5',
      splitPrPlannerThinkingLevel: 'high',
    });
    mockedRunCodexStructuredHelperQuery
      .mockResolvedValueOnce({
        value: null,
        usage: { ...USAGE_FIXTURE },
      })
      .mockResolvedValueOnce({
        value: makeInvalidPlan(),
        usage: { ...USAGE_FIXTURE },
      });

    const error = await expectPlanningError(
      planPrSplit({ projectId: 'ws-1', worktreeId: 'wt-1' }),
      'invalid_plan',
    );

    // The shared 2-call budget is exhausted by the structural retry, so the
    // loop must NOT spend a third call retrying validation — it surfaces the
    // deterministic-validation issues from the second attempt directly.
    expect(mockedRunCodexStructuredHelperQuery).toHaveBeenCalledTimes(2);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.some((issue) => issue.code === 'unassigned-hunk')).toBe(
      true,
    );
    expect(finalizeObservedHelperTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      expect.stringContaining('invalid'),
      expect.objectContaining({ inputTokens: 20, outputTokens: 10 }),
    );
  });

  it('ignores the split-plan fixture env var outside E2E builds', async () => {
    process.env.CANOPY_TEST_SPLIT_PLAN_FIXTURE = '/tmp/fixture.json';

    const response = await planPrSplit({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    // jest bakes __CANOPY_E2E__ === false, so the fixture seam must be dead:
    // the LLM path runs and the fixture file is never read.
    expect(mockedRunStructuredHelper).toHaveBeenCalledTimes(1);
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      '/tmp/fixture.json',
      'utf-8',
    );
    expect(response.plan).toEqual(makeValidPlan());
  });
});

describe('split planner prompts', () => {
  it('encodes the system framing, procedure, and hard constraints', () => {
    const systemPrompt = buildSplitPlannerSystemPrompt();

    // System framing (One-Thing Rule).
    expect(systemPrompt).toContain('one thesis');
    expect(systemPrompt).toContain('NOT touch git');
    expect(systemPrompt).toContain('Split Plan');

    // 4-step decomposition procedure.
    expect(systemPrompt).toContain('Map the end state');
    expect(systemPrompt).toContain('Find the seams');
    expect(systemPrompt).toContain('Order by dependency');
    expect(systemPrompt).toContain('Size & scope');

    // Hard constraints.
    expect(systemPrompt).toContain('Split by thesis, not by file');
    expect(systemPrompt).toContain('exactly one');
    expect(systemPrompt).toContain('stacked');
    expect(systemPrompt).toContain('file-disjoint');
    expect(systemPrompt).toContain('integration branch');
    // Multi-parent dependencies are unsupported; the plan must keep each child
    // to at most one parent (the validator rejects more than one).
    expect(systemPrompt).toContain('exactly one parent at most');
    expect(systemPrompt).toContain(
      'multi-parent dependencies are not supported',
    );
    expect(systemPrompt).toContain('unassignedHunks');
    expect(systemPrompt).toContain('3–7');
    expect(systemPrompt).toContain('200–400');

    // Within-file limitation note.
    expect(systemPrompt).toContain('inside a single hunk');

    // buildTestCommand runs after the worktree setup script finishes, so it may
    // assume a set-up worktree but should stay reasonably self-contained when no
    // setup script is configured.
    expect(systemPrompt).toContain('AFTER the worktree setup script');
    expect(systemPrompt).toContain('self-contained');
  });

  it('embeds an explicit output schema section with a minimal example and the observed-failure prohibitions', () => {
    const systemPrompt = buildSplitPlannerSystemPrompt();

    // Schema section header + all required top-level keys named explicitly.
    expect(systemPrompt).toContain('Output schema');
    expect(systemPrompt).toContain('"finalGoal"');
    expect(systemPrompt).toContain('"concerns"');
    expect(systemPrompt).toContain('"children"');
    expect(systemPrompt).toContain('"parallelizable"');
    expect(systemPrompt).toContain('"landOrder"');
    expect(systemPrompt).toContain('"buildTestCommand"');
    expect(systemPrompt).toContain('"unassignedHunks"');
    expect(systemPrompt).toContain('1-based');
    expect(systemPrompt).toContain('"changes"');

    // Minimal valid example instance (one child, one change).
    expect(systemPrompt).toContain('Minimal valid example');
    expect(systemPrompt).toContain('"src/registry.ts"');

    // Explicit prohibitions derived from the 2026-07-02 dogfood failure.
    expect(systemPrompt).toContain('a `pr` field');
    expect(systemPrompt).toContain('`files`');
    expect(systemPrompt).toContain('0-based');
    expect(systemPrompt).toContain('never per-child');
  });

  it('builds the user prompt from PR metadata, file summary, and hunk enumeration', () => {
    const snapshot = makeDiffSnapshot();
    const userPrompt = buildSplitPlannerUserPrompt({
      pr: {
        prNumber: 42,
        title: 'Big combined PR',
        body: 'A refactor and a feature in one diff.',
        headBranch: 'feature-x',
        baseBranch: 'develop',
        headSha: HEAD_SHA,
      },
      snapshot,
      repoContext: {
        codeowners: '* @acme/reviewers',
        prTemplate: null,
        contributing: null,
        claudeMd: null,
        buildTestHint: 'package.json scripts: build, test',
      },
    });

    expect(userPrompt).toContain('#42');
    expect(userPrompt).toContain('Big combined PR');
    expect(userPrompt).toContain('develop');
    expect(userPrompt).toContain('feature-x');

    // Per-file summary with counts.
    expect(userPrompt).toContain('src/registry.ts');
    expect(userPrompt).toContain('+3/-1');

    // Hunk enumeration: index, header, contentHash, counts, preview — but not
    // the full coreLines payload.
    expect(userPrompt).toContain('hash-src/registry.ts-0');
    expect(userPrompt).toContain('hash-src/client.ts-0');
    expect(userPrompt).toContain('preview-of src/registry.ts hunk 1');
    expect(userPrompt).not.toContain('core-line-secret');

    // Repo context sections.
    expect(userPrompt).toContain('@acme/reviewers');
    expect(userPrompt).toContain('package.json scripts: build, test');
  });

  it('renders validation issues in the retry addendum', () => {
    const addendum = buildSplitPlanValidationRetryAddendum([
      {
        code: 'unassigned-hunk',
        severity: 'error',
        message: 'Hunk 0 of file "src/client.ts" has no owning child',
        file: 'src/client.ts',
        hunkIndex: 0,
      },
    ]);

    expect(addendum).toContain('unassigned-hunk');
    expect(addendum).toContain('src/client.ts');
    expect(addendum).toMatch(/corrected/i);
  });

  it('renders the required top-level keys and common mistakes in the structural retry addendum', () => {
    const addendum = buildSplitPlanStructuralRetryAddendum();

    expect(addendum).toContain('finalGoal');
    expect(addendum).toContain('concerns');
    expect(addendum).toContain('children');
    expect(addendum).toContain('parallelizable');
    expect(addendum).toContain('landOrder');
    expect(addendum).toContain('buildTestCommand');
    expect(addendum).toContain('unassignedHunks');
    expect(addendum).toContain('`changes`');
    expect(addendum).toContain('1-based');
    expect(addendum).toContain('pr` wrapper');
  });

  it('exposes a SplitPlan JSON schema requiring every plan field', () => {
    expect(SPLIT_PLAN_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const required = SPLIT_PLAN_JSON_SCHEMA.required;
    expect(required).toEqual(
      expect.arrayContaining([
        'finalGoal',
        'concerns',
        'children',
        'parallelizable',
        'landOrder',
        'buildTestCommand',
        'unassignedHunks',
      ]),
    );
  });
});
