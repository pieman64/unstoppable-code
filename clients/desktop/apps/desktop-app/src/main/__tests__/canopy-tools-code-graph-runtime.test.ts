import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { resetCodeGraphWorktreeServiceForTests } from '@canopy/desktop-shared/node/code-graph/service';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '@canopy/code-graph/store/database';
import { runCodeGraphMigrations } from '@canopy/code-graph/store/migrations';
import { CodeGraphStore } from '@canopy/code-graph/store/graph-store';
import { publishCodeGraphSummaryProjection } from '@canopy/code-graph/summary-projection';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { fingerprintCodeGraphWorktree } from '../lib/code-graph-worktree-fingerprint-core';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
} from '../code-graph/build-runner';
import type { CodeGraphFingerprintWorkerResponse } from '../code-graph/fingerprint-runner';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import type * as CodeGraphBuildRunnerModule from '../code-graph/build-runner';
import type * as CodeGraphReadRunnerModule from '../code-graph/read-runner';
import type {
  CodeGraphWorkerReadInput,
  CodeGraphWorkerReadResponse,
} from '../code-graph/read-runner';

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

interface MockWorktreeRepoEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}
const mockListWorkspaceWorktreeRepoEntries = jest.fn<
  Promise<MockWorktreeRepoEntry[]>,
  [string, string]
>();
const mockResolveWorktreeCodeGraphRepositories = jest.fn<
  Promise<CodeGraphRepositoryInput[]>,
  [string, string]
>(async (workspaceId, worktreePath) => {
  const entries = await mockListWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  );
  return entries.length === 0
    ? [{ repoId: '__workspace_root__', rootPath: worktreePath }]
    : entries.map((entry) => ({
        repoId: entry.repoId,
        rootPath: entry.repoPath,
      }));
});
jest.mock('../lib/worktree-repo-entries', () => ({
  get listWorkspaceWorktreeRepoEntries(): typeof mockListWorkspaceWorktreeRepoEntries {
    return mockListWorkspaceWorktreeRepoEntries;
  },
  get resolveWorktreeCodeGraphRepositories(): typeof mockResolveWorktreeCodeGraphRepositories {
    return mockResolveWorktreeCodeGraphRepositories;
  },
}));

// Mocks `runCodeGraphWorkerBuild` only (every other export — notably the real
// `CodeGraphWorkerBuildError` class — passes through via `requireActual` so
// `instanceof` checks in both this test and the source under test see the
// SAME class object). The default implementation (set in `beforeEach` below)
// delegates to the REAL `executeCodeGraphBuild` from `build-worker.ts` so
// every other describe block below — which depends on `buildOrUpdateCodeGraph`
// having actually built a real sqlite/tree-sitter graph — keeps working
// unchanged; only the dedicated 'worker build routing' tests below override
// this per-call to exercise the request-shape and error-mapping contract.
const mockRunCodeGraphWorkerBuild = jest.fn<
  ReturnType<typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild>,
  Parameters<typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild>
>();
const mockIsCodeGraphBuildPending = jest.fn<boolean, [string]>();
jest.mock('../code-graph/build-runner', () => {
  const actual: typeof CodeGraphBuildRunnerModule = jest.requireActual(
    '../code-graph/build-runner',
  );
  return {
    ...actual,
    // Keep the real constructor live across the runner/telemetry import cycle.
    get CodeGraphWorkerBuildError(): typeof actual.CodeGraphWorkerBuildError {
      return actual.CodeGraphWorkerBuildError;
    },
    beginCodeGraphWorkerBuild: (
      key: string,
      request: CodeGraphWorkerBuildRequest,
      scheduling?: CodeGraphBuildRunnerModule.CodeGraphBuildSchedulingOptions,
    ): CodeGraphBuildRunnerModule.CodeGraphWorkerBuildHandle => ({
      attemptId: 'fixture-admitted-build',
      promise: mockRunCodeGraphWorkerBuild(key, request, scheduling),
    }),
    getCodeGraphSourceBuildState: (key: string): 'running' | 'idle' =>
      mockIsCodeGraphBuildPending(key) ? 'running' : 'idle',
    runCodeGraphWorkerBuild: (
      key: string,
      request: CodeGraphWorkerBuildRequest,
      scheduling?: CodeGraphBuildRunnerModule.CodeGraphBuildSchedulingOptions,
    ): Promise<CodeGraphWorkerBuildResponse> =>
      mockRunCodeGraphWorkerBuild(key, request, scheduling),
    isCodeGraphBuildPending: (key: string): boolean =>
      mockIsCodeGraphBuildPending(key),
  };
});

const mockRunCodeGraphWorkerFingerprint = jest.fn<
  Promise<CodeGraphFingerprintWorkerResponse>,
  [string, readonly CodeGraphRepositoryInput[]]
>();
jest.mock('../code-graph/fingerprint-runner', () => ({
  runCodeGraphWorkerFingerprint: (
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
  ): Promise<CodeGraphFingerprintWorkerResponse> =>
    mockRunCodeGraphWorkerFingerprint(key, repositories),
}));

const mockRunCodeGraphWorkerRead = jest.fn<
  Promise<CodeGraphWorkerReadResponse>,
  [CodeGraphWorkerReadInput]
>();
jest.mock('../code-graph/read-runner', () => {
  const actual: typeof CodeGraphReadRunnerModule = jest.requireActual(
    '../code-graph/read-runner',
  );
  return {
    ...actual,
    get CodeGraphReadFailureError(): typeof actual.CodeGraphReadFailureError {
      return actual.CodeGraphReadFailureError;
    },
    get CodeGraphWorkerReadError(): typeof actual.CodeGraphWorkerReadError {
      return actual.CodeGraphWorkerReadError;
    },
    runCodeGraphWorkerRead: (
      input: CodeGraphWorkerReadInput,
    ): Promise<CodeGraphWorkerReadResponse> =>
      mockRunCodeGraphWorkerRead(input),
  };
});

const mockIsEnabled = jest.fn();
jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    get isEnabled(): typeof mockIsEnabled {
      return mockIsEnabled;
    },
  }),
}));

import {
  buildOrUpdateCodeGraph,
  codeGraphRuntimeTestExports,
  compareChangeImpact,
  detectChangedSymbols,
  explainCodeSymbol,
  getCodeGraphContext,
  getImpactRadius,
  getReviewContext,
  queryCodeGraph,
  searchCodeGraph,
  type CodeGraphToolRuntime,
} from '../canopy-tools/code-graph-runtime';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { CodeGraphWorkerBuildError } from '../code-graph/build-runner';
import { codeGraphGenerationFailureReason } from '../lib/code-graph-telemetry';
import { CodeGraphWorkerReadError } from '../code-graph/read-runner';
import {
  executeCodeGraphBuild,
  executeDeferredCodeGraphDerived,
} from '../code-graph/build-worker';
import { executeCodeGraphRead } from '../code-graph/read-worker';

const mockResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;
const TEST = `import { doWork } from '../lib';

function checksDoWork(): void {
  doWork();
}
checksDoWork();
`;
// Six extra callers of doWork, used only by the truncation test so the other
// tests' exact-count assertions stay unaffected.
const EXTRA = `import { doWork } from './lib';

export function alpha(): number { return doWork(); }
export function bravo(): number { return doWork(); }
export function charlie(): number { return doWork(); }
export function delta(): number { return doWork(); }
export function echo(): number { return doWork(); }
export function foxtrot(): number { return doWork(); }
`;

// --- Change-impact fixture content (detectChangedSymbols/compareChangeImpact/
// getReviewContext below) ---------------------------------------------------
const V1_AUTH_TOOL = `export function checkAuthToken(token: string): boolean {
  return token.length > 0;
}
`;
const V2_AUTH_TOOL = `export function checkAuthToken(token: string): boolean {
  return token.trim().length > 0;
}
`;
const GONE = `export function goneFn(): void {}
`;
// v2 of src/lib.ts: doWork's signature gains a parameter (signatureChanged),
// and newFn is a brand-new symbol (added).
const V2_LIB = `export function doWork(x: number): number {
  return 42 + x;
}
export function newFn(): number {
  return 1;
}
`;

// Nearly every test builds a real tree-sitter + SQLite graph in-process, and
// the change-impact hooks add real git repos and commits. Under a loaded
// two-worker CI run those exceeded Jest's default 5 s for both tests and
// hooks; this matches the sibling code-graph suites.
jest.setTimeout(30_000);

describe('code-graph-runtime', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  const projectId = 'proj-1';
  const worktreeId = 'wt-1';
  const runtime: CodeGraphToolRuntime = { projectId, worktreeId };
  let dataDirRoot: string;
  let repoDir: string;
  // Second repo dir for the multi-repo scoping test below. Owned by
  // beforeEach/afterEach (like repoDir) rather than the test body so an
  // assertion failure inside the test cannot leak the temp directory.
  let repoBDir: string;

  beforeEach(() => {
    mockIsEnabled.mockReset();
    mockIsEnabled.mockReturnValue(true);
    mockIsCodeGraphBuildPending.mockReset();
    mockIsCodeGraphBuildPending.mockReturnValue(false);
    dataDirRoot = mkdtempSync(path.join(tmpdir(), 'code-graph-runtime-data-'));
    process.env.CANOPY_DATA_DIR = path.join(dataDirRoot, 'data');

    repoDir = mkdtempSync(path.join(tmpdir(), 'code-graph-runtime-repo-'));
    mkdirSync(path.join(repoDir, 'src', '__tests__'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(repoDir, 'src', 'main.ts'), MAIN);
    writeFileSync(path.join(repoDir, 'src', '__tests__', 'lib.test.ts'), TEST);

    repoBDir = mkdtempSync(path.join(tmpdir(), 'code-graph-runtime-repo-b-'));

    mockResolveWorktreeCwd.mockReset();
    mockResolveWorktreeCwd.mockReturnValue(repoDir);
    mockListWorkspaceWorktreeRepoEntries.mockReset();
    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'fixture', repoName: 'Fixture', repoPath: repoDir },
    ]);
    mockResolveWorktreeCodeGraphRepositories.mockClear();

    // Default: delegate to the REAL worker handler (in-process, no fork) so
    // every test that calls `buildOrUpdateCodeGraph` still gets an actual
    // sqlite/tree-sitter build. Individual 'worker build routing' tests below
    // override this per-call via `mockResolvedValueOnce`/`mockRejectedValueOnce`.
    mockRunCodeGraphWorkerBuild.mockReset();
    mockRunCodeGraphWorkerBuild.mockImplementation(
      (_key: string, request: CodeGraphWorkerBuildRequest) =>
        executeCodeGraphBuild(request),
    );
    mockRunCodeGraphWorkerFingerprint.mockReset();
    mockRunCodeGraphWorkerFingerprint.mockImplementation(
      async (
        _key: string,
        repositories: readonly CodeGraphRepositoryInput[],
      ) => ({
        ok: true,
        fingerprint: await fingerprintCodeGraphWorktree(repositories),
      }),
    );
    mockRunCodeGraphWorkerRead.mockReset();
    mockRunCodeGraphWorkerRead.mockImplementation(
      (input: CodeGraphWorkerReadInput) => executeCodeGraphRead(input.request),
    );
  });

  afterEach(async () => {
    // Awaits closeAll() on the outgoing singleton so every engine (and its
    // sqlite fds) is closed before the temp dirs below are removed.
    await resetCodeGraphWorktreeServiceForTests();

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(repoBDir, { recursive: true, force: true });
    rmSync(dataDirRoot, { recursive: true, force: true });

    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
  });

  it('preserves the real worker error identity through telemetry and runner imports', () => {
    const error = new CodeGraphWorkerBuildError(
      'canceled',
      'Canceled fixture build.',
    );
    expect(codeGraphGenerationFailureReason(error)).toBe('canceled');
  });
  describe('feature flag', () => {
    it('returns an unavailable disabled result and never touches the worker when the code-graph feature flag is off', async () => {
      mockIsEnabled.mockReturnValue(false);

      const build = await buildOrUpdateCodeGraph(runtime);

      expect(build.status).toBe('unavailable');
      expect(build.summary).toBe(
        'Code graph tools are not available for this project.',
      );
      expect(mockRunCodeGraphWorkerBuild).not.toHaveBeenCalled();
    });

    it('proceeds with a build when the code-graph feature flag is on', async () => {
      mockIsEnabled.mockReturnValue(true);

      const build = await buildOrUpdateCodeGraph(runtime);

      expect(build.status).toBe('ok');
      expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledTimes(1);
    });
  });

  describe('guardrails', () => {
    it('rejects cowork projects for every tool with an unavailable envelope, never touching the worktree', async () => {
      const coworkRuntime: CodeGraphToolRuntime = {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'home',
      };

      const context = await getCodeGraphContext(coworkRuntime);
      expect(context.status).toBe('unavailable');
      expect(context.summary).toContain(
        'only available for worktree chats, not standalone chats',
      );

      const build = await buildOrUpdateCodeGraph(coworkRuntime);
      expect(build.status).toBe('unavailable');

      const query = await queryCodeGraph(coworkRuntime, {
        mode: 'callers',
        target: 'src/lib.ts::doWork',
      });
      expect(query.status).toBe('unavailable');

      const search = await searchCodeGraph(coworkRuntime, { query: 'doWork' });
      expect(search.status).toBe('unavailable');

      const explain = await explainCodeSymbol(coworkRuntime, {
        qualifiedName: 'src/lib.ts::doWork',
      });
      expect(explain.status).toBe('unavailable');

      const impact = await getImpactRadius(coworkRuntime, {
        target: 'src/lib.ts::doWork',
      });
      expect(impact.status).toBe('unavailable');

      const detect = await detectChangedSymbols(coworkRuntime, {});
      expect(detect.status).toBe('unavailable');
      expect(detect.summary).toContain(
        'only available for worktree chats, not standalone chats',
      );

      const compare = await compareChangeImpact(coworkRuntime, {});
      expect(compare.status).toBe('unavailable');

      const review = await getReviewContext(coworkRuntime, {});
      expect(review.status).toBe('unavailable');

      expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
    });

    it('rejects App Advisor sentinel ids for every tool with an unavailable envelope, never touching the worktree', async () => {
      const sentinelRuntime: CodeGraphToolRuntime = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
      };

      const context = await getCodeGraphContext(sentinelRuntime);
      expect(context.status).toBe('unavailable');
      expect(context.summary).toContain('assistant sentinel ids');

      const build = await buildOrUpdateCodeGraph(sentinelRuntime);
      expect(build.status).toBe('unavailable');

      const query = await queryCodeGraph(sentinelRuntime, {
        mode: 'callers',
        target: 'src/lib.ts::doWork',
      });
      expect(query.status).toBe('unavailable');

      const search = await searchCodeGraph(sentinelRuntime, {
        query: 'doWork',
      });
      expect(search.status).toBe('unavailable');

      const explain = await explainCodeSymbol(sentinelRuntime, {
        qualifiedName: 'src/lib.ts::doWork',
      });
      expect(explain.status).toBe('unavailable');

      const impact = await getImpactRadius(sentinelRuntime, {
        target: 'src/lib.ts::doWork',
      });
      expect(impact.status).toBe('unavailable');

      const detect = await detectChangedSymbols(sentinelRuntime, {});
      expect(detect.status).toBe('unavailable');
      expect(detect.summary).toContain('assistant sentinel ids');

      const compare = await compareChangeImpact(sentinelRuntime, {});
      expect(compare.status).toBe('unavailable');

      const review = await getReviewContext(sentinelRuntime, {});
      expect(review.status).toBe('unavailable');

      expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
    });
  });

  it('returns unavailable envelopes for every read tool before any graph has been built', async () => {
    const context = await getCodeGraphContext(runtime);
    expect(context.status).toBe('unavailable');
    expect(context.hasGraph).toBe(false);
    expect(context.suggestedNextTools).toEqual(['BuildOrUpdateCodeGraph']);

    const query = await queryCodeGraph(runtime, {
      mode: 'callers',
      target: 'src/lib.ts::doWork',
    });
    expect(query.status).toBe('unavailable');
    expect(query.mode).toBe('callers');
    expect(query.target).toBe('src/lib.ts::doWork');
    expect(query.suggestedNextTools).toEqual(['BuildOrUpdateCodeGraph']);

    const search = await searchCodeGraph(runtime, { query: 'doWork' });
    expect(search.status).toBe('unavailable');

    const explain = await explainCodeSymbol(runtime, {
      qualifiedName: 'src/lib.ts::doWork',
    });
    expect(explain.status).toBe('unavailable');

    const impact = await getImpactRadius(runtime, {
      target: 'src/lib.ts::doWork',
    });
    expect(impact.status).toBe('unavailable');

    const detect = await detectChangedSymbols(runtime, {});
    expect(detect.status).toBe('unavailable');
    expect(detect.baseRef).toBe('');
    expect(detect.suggestedNextTools).toEqual(['BuildOrUpdateCodeGraph']);

    const compare = await compareChangeImpact(runtime, {});
    expect(compare.status).toBe('unavailable');

    const review = await getReviewContext(runtime, {});
    expect(review.status).toBe('unavailable');

    // build_or_update_code_graph is the one tool NOT gated on hasGraph.
    expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('reports a running source with an explicitly missing, unmeasured snapshot', async () => {
    mockIsCodeGraphBuildPending.mockReturnValue(true);

    const context = await getCodeGraphContext(runtime);

    expect(context).toMatchObject({
      status: 'unavailable',
      hasGraph: false,
      snapshotState: 'missing',
      buildState: 'running',
      suggestedNextTools: ['BuildOrUpdateCodeGraph'],
    });
    expect(context.summary).toContain('Counts are unmeasured.');
    expect(mockIsCodeGraphBuildPending).toHaveBeenCalledWith(
      `${projectId}/${worktreeId}`,
    );
    expect(mockRunCodeGraphWorkerRead).not.toHaveBeenCalled();
  });

  it('preserves a retained snapshot read failure while a refresh is pending', async () => {
    const build = await buildOrUpdateCodeGraph(runtime);
    expect(build.status).toBe('ok');
    mockIsCodeGraphBuildPending.mockReturnValue(true);
    mockRunCodeGraphWorkerRead.mockRejectedValueOnce(
      new CodeGraphWorkerReadError('timeout', 'private path must not escape'),
    );

    const context = await getCodeGraphContext(runtime);

    expect(context).toMatchObject({ status: 'error', hasGraph: true });
    expect(context.summary).not.toContain('no readable snapshot');
    expect(context.summary).not.toContain('private path must not escape');
  });

  it('builds the graph and reports counts through GetCodeGraphContext', async () => {
    const build = await buildOrUpdateCodeGraph(runtime);
    expect(build.status).toBe('ok');
    expect(build.filesParsed).toBe(3);
    expect(build.filesUnchanged).toBe(0);
    expect(build.parseFailures).toBe(0);
    // A clean derived-analysis pass reports the field as an empty array (it
    // is only ABSENT when computeDerived: false skips derived analysis
    // entirely -- see CodeGraphBuildToolResult.derivedWarnings).
    expect(build.derivedWarnings).toEqual([]);

    const context = await getCodeGraphContext(runtime);
    expect(context.status).toBe('ok');
    expect(context.hasGraph).toBe(true);
    expect(context.fileCount).toBe(3);
    expect(context.symbolCount).toBeGreaterThanOrEqual(6);
    expect(context.lastBuildAt).not.toBeNull();
    // The build reports the stamp it wrote, which is what the graph holds.
    expect(build.lastBuildAt).toBe(context.lastBuildAt);
    expect(context.repositories).toEqual([{ repoId: 'fixture', fileCount: 3 }]);
  });

  describe('worker build routing', () => {
    it('routes the build through the worker runner with a fully-resolved request', async () => {
      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('ok');

      expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledTimes(1);
      const call = mockRunCodeGraphWorkerBuild.mock.calls[0];
      if (call === undefined) {
        throw new Error('Expected runCodeGraphWorkerBuild to have been called');
      }
      const [key, request, scheduling] = call;
      expect(key).toBe(`${projectId}/${worktreeId}`);
      expect(scheduling).toEqual({
        priority: 'agent',
        metadata: {
          scope: 'worktree',
          workspaceIds: [projectId],
          workspaceLabel: projectId,
          worktreeId,
          label: worktreeId,
          trigger: 'tool-request',
        },
      });
      expect(request).toEqual(
        expect.objectContaining({
          dbPath: getWorktreeCodeGraphDbPath(projectId, worktreeId),
          worktreeRootPath: repoDir,
          resourcesDir: getBundledCodeGraphDir(),
          repositories: [{ repoId: 'fixture', rootPath: repoDir }],
          options: { verifyContent: true },
        }),
      );
      expect(request.preparation?.seedSources).toEqual([]);
      expect(typeof request.preparation?.customLanguagesFingerprint).toBe(
        'string',
      );
    });

    it('times out the agent wait after 10 minutes without canceling the underlying build', async () => {
      jest.useFakeTimers();
      let resolveWorker:
        | ((response: CodeGraphWorkerBuildResponse) => void)
        | undefined;
      try {
        const generation = new Promise<CodeGraphWorkerBuildResponse>(
          (resolve) => {
            resolveWorker = resolve;
          },
        );
        const wait = codeGraphRuntimeTestExports
          .waitForAgentBuild(generation)
          .catch((error: unknown) => error);

        await jest.advanceTimersByTimeAsync(
          codeGraphRuntimeTestExports.agentBuildWaitTimeoutMs,
        );
        const error = await wait;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'Timed out after 10 minutes',
        );
        expect((error as Error).message).toContain('still queued or running');
        expect((error as Error).message).toContain('wait and try');

        // The wait timeout has no cancellation capability. The original
        // generation promise remains pending and can still resolve normally.
        resolveWorker?.({
          ok: true,
          result: {
            filesScanned: 0,
            filesParsed: 0,
            filesUnchanged: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            parseFailures: 0,
            symbolCount: 0,
            edgeCount: 0,
            durationMs: 1,
            derived: [],
            customLanguages: null,
          },
        });
        await expect(generation).resolves.toEqual(
          expect.objectContaining({ ok: true }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports an error result naming the cause when the worker rejects with a canceled build', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError(
          'canceled',
          'Code-graph build for "proj-1/wt-1" was canceled.',
        ),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('canceled');
      expect(build.summary).toContain(
        'Code-graph build for "proj-1/wt-1" was canceled.',
      );
      expect(build.filesParsed).toBe(0);
    });

    it('maps availability cancellation to the exact unavailable tool result', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError(
          'unavailable',
          'Code graph generation is unavailable.',
        ),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build).toMatchObject({
        status: 'unavailable',
        summary: 'Code graph tools are not available for this project.',
      });
    });

    it('reports an error result naming the cause when the worker rejects with a timeout', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError('timeout', 'exceeded the watchdog'),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('timeout');
      expect(build.summary).toContain('exceeded the watchdog');
    });

    it('reports an error result naming the cause when the worker rejects with worker-exit', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError('worker-exit', 'exited unexpectedly'),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('worker-exit');
    });

    it('reports an error result naming the cause when the worker rejects with spawn-failed', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError('spawn-failed', 'could not fork'),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('spawn-failed');
    });

    it('reports an error result naming the cause when the worker rejects with post-failed', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError('post-failed', 'could not post message'),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('post-failed');
    });

    it('reports an error result naming the cause when the worker rejects with malformed-response', async () => {
      mockRunCodeGraphWorkerBuild.mockRejectedValueOnce(
        new CodeGraphWorkerBuildError('malformed-response', 'bad protocol'),
      );

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('malformed-response');
    });

    it('reports an error result when the worker responds with ok:false', async () => {
      mockRunCodeGraphWorkerBuild.mockResolvedValueOnce({
        ok: false,
        message: 'engine exploded mid-build',
      });

      const build = await buildOrUpdateCodeGraph(runtime);
      expect(build.status).toBe('error');
      expect(build.summary).toContain('engine exploded mid-build');
    });
  });

  it('falls back to a synthetic workspace-root repository when no repo entries are returned', async () => {
    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);

    const build = await buildOrUpdateCodeGraph(runtime);
    expect(build.status).toBe('ok');
    expect(build.filesParsed).toBe(3);

    const context = await getCodeGraphContext(runtime);
    expect(context.repositories).toEqual([
      { repoId: WORKSPACE_ROOT_REPO_ID, fileCount: 3 },
    ]);
  });

  it('queries callers and file-summary after a build', async () => {
    await buildOrUpdateCodeGraph(runtime);

    const callers = await queryCodeGraph(runtime, {
      mode: 'callers',
      target: 'src/lib.ts::doWork',
    });
    expect(callers.status).toBe('ok');
    expect(callers.truncated).toBe(false);
    expect(callers.hits.map((hit) => hit.qualifiedName).sort()).toEqual([
      'src/__tests__/lib.test.ts::checksDoWork',
      'src/main.ts::run',
    ]);

    const summary = await queryCodeGraph(runtime, {
      mode: 'file-summary',
      target: 'src/main.ts',
    });
    expect(summary.status).toBe('ok');
    expect(summary.hits).toEqual([]);
    expect(
      summary.fileSummary?.symbols.map((symbol) => symbol.qualifiedName),
    ).toContain('src/main.ts::run');
    expect(summary.fileSummary?.imports).toEqual(['./lib']);

    const missing = await queryCodeGraph(runtime, {
      mode: 'file-summary',
      target: 'src/nope.ts',
    });
    expect(missing.status).toBe('ok');
    expect(missing.fileSummary).toBeUndefined();
  });

  it('searches symbols after a build', async () => {
    await buildOrUpdateCodeGraph(runtime);

    const results = await searchCodeGraph(runtime, { query: 'doWork' });
    expect(results.status).toBe('ok');
    expect(
      results.hits.some((hit) => hit.qualifiedName === 'src/lib.ts::doWork'),
    ).toBe(true);
  });

  it('explains a symbol after a build', async () => {
    await buildOrUpdateCodeGraph(runtime);

    const explain = await explainCodeSymbol(runtime, {
      qualifiedName: 'src/lib.ts::doWork',
    });
    expect(explain.status).toBe('ok');
    expect(explain.symbol?.qualifiedName).toBe('src/lib.ts::doWork');
    expect(explain.symbol?.kind).toBe('function');
    expect(explain.symbol?.filePath).toBe('src/lib.ts');
    expect(explain.callers.map((hit) => hit.qualifiedName).sort()).toEqual([
      'src/__tests__/lib.test.ts::checksDoWork',
      'src/main.ts::run',
    ]);
    expect(explain.callees).toEqual([]);
    expect(explain.tests).toEqual(['src/__tests__/lib.test.ts']);
    expect(explain.truncated).toBe(false);
  });

  it('computes an impact radius after a build', async () => {
    await buildOrUpdateCodeGraph(runtime);

    const impact = await getImpactRadius(runtime, {
      target: 'src/lib.ts::doWork',
    });
    expect(impact.status).toBe('ok');
    expect(impact.maxDepth).toBe(2);
    expect(
      impact.impacted.some(
        (entry) => entry.qualifiedName === 'src/main.ts::run',
      ),
    ).toBe(true);
  });

  it('routes the docs-for/rationale-for/scripts-for-file modes after a build', async () => {
    writeFileSync(
      path.join(repoDir, 'src', 'lib.ts'),
      `// NOTE: doWork returns the answer to everything.\n${LIB}`,
    );
    writeFileSync(
      path.join(repoDir, 'docs.md'),
      '# Guide\n\nSee [lib](./src/lib.ts) for details.\n',
    );
    writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { build: 'tsc -p .' } }),
    );

    await buildOrUpdateCodeGraph(runtime);

    const docs = await queryCodeGraph(runtime, {
      mode: 'docs-for',
      target: 'src/lib.ts',
    });
    expect(docs.status).toBe('ok');
    expect(docs.hits).toEqual([
      {
        qualifiedName: 'docs.md::guide',
        kind: 'doc_section',
        filePath: 'docs.md',
        line: 3,
      },
    ]);

    const rationale = await queryCodeGraph(runtime, {
      mode: 'rationale-for',
      target: 'src/lib.ts::doWork',
    });
    expect(rationale.status).toBe('ok');
    expect(rationale.hits).toEqual([
      {
        // qualifiedName is the rationale symbol's REAL, chainable identifier;
        // the human-readable marker+text rides in `label`.
        qualifiedName: 'src/lib.ts::rationale.L1',
        kind: 'rationale',
        filePath: 'src/lib.ts',
        line: 1,
        label: 'NOTE: doWork returns the answer to everything.',
      },
    ]);

    const scripts = await queryCodeGraph(runtime, {
      mode: 'scripts-for-file',
      target: 'package.json',
    });
    expect(scripts.status).toBe('ok');
    expect(scripts.hits).toEqual([]);
    expect(scripts.scripts).toEqual([{ name: 'build', command: 'tsc -p .' }]);
    expect(scripts.truncated).toBe(false);
  });

  it('scopes scripts-for-file per repo (Task 7 repo-scoping discriminating case)', async () => {
    writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'repo-a', scripts: { build: 'tsc -p .' } }),
    );
    writeFileSync(
      path.join(repoBDir, 'package.json'),
      JSON.stringify({ name: 'repo-b', scripts: { build: 'webpack' } }),
    );

    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'fixture-a', repoName: 'Fixture A', repoPath: repoDir },
      { repoId: 'fixture-b', repoName: 'Fixture B', repoPath: repoBDir },
    ]);

    await buildOrUpdateCodeGraph(runtime);

    const scriptsA = await queryCodeGraph(runtime, {
      mode: 'scripts-for-file',
      target: 'package.json',
      repoId: 'fixture-a',
    });
    expect(scriptsA.scripts).toEqual([{ name: 'build', command: 'tsc -p .' }]);

    const scriptsB = await queryCodeGraph(runtime, {
      mode: 'scripts-for-file',
      target: 'package.json',
      repoId: 'fixture-b',
    });
    expect(scriptsB.scripts).toEqual([{ name: 'build', command: 'webpack' }]);
  });

  it('routes bounded path queries through the read worker and rejects missing endpoints', async () => {
    const missing = await queryCodeGraph(runtime, {
      mode: 'call-path',
      target: 'src/main.ts::run',
    });
    expect(missing.status).toBe('error');
    await buildOrUpdateCodeGraph(runtime);
    const result = await queryCodeGraph(runtime, {
      mode: 'call-path',
      target: 'src/main.ts::run',
      to: 'src/lib.ts::doWork',
      repoId: 'fixture',
    });
    expect(result.path?.status).toBe('found');
    expect(result.path?.hops[0]).toMatchObject({
      kind: 'CALLS',
      direction: 'forward',
      filePath: 'src/main.ts',
    });
    expect(result.truncated).toBe(false);
  });

  it('routes the ipc-channel mode after a build (P5)', async () => {
    mkdirSync(path.join(repoDir, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(repoDir, 'src', 'main', 'ipc'), { recursive: true });
    mkdirSync(path.join(repoDir, 'src', 'preload'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'src', 'shared', 'ipc-channels.ts'),
      `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
} as const;
`,
    );
    writeFileSync(
      path.join(repoDir, 'src', 'main', 'ipc', 'register.ts'),
      `import { IPC_CHANNELS } from '../../shared/ipc-channels';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.fooLoad, () => {});
}
`,
    );
    writeFileSync(
      path.join(repoDir, 'src', 'preload', 'index.ts'),
      `import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

export function loadFoo(): void {
  ipcRenderer.invoke(IPC_CHANNELS.fooLoad);
}
`,
    );

    await buildOrUpdateCodeGraph(runtime);

    const byKey = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'fooLoad',
    });
    expect(byKey.status).toBe('ok');
    expect(byKey.hits).toEqual([]);
    expect(byKey.truncated).toBe(false);
    expect(byKey.ipcChannel?.ambiguousCount).toBe(0);
    expect(byKey.ipcChannel?.channel).toEqual({
      qualifiedName: 'src/shared/ipc-channels.ts::ipc.fooLoad',
      filePath: 'src/shared/ipc-channels.ts',
      signature: 'foo:load',
      line: 2,
    });
    expect(byKey.ipcChannel?.handlers).toEqual([
      {
        qualifiedName: 'src/main/ipc/register.ts::registerHandlers',
        kind: 'function',
        filePath: 'src/main/ipc/register.ts',
        line: 6,
      },
    ]);
    expect(byKey.ipcChannel?.invokers).toEqual([
      {
        qualifiedName: 'src/preload/index.ts::loadFoo',
        kind: 'function',
        filePath: 'src/preload/index.ts',
        line: 5,
      },
    ]);

    const byQualifiedName = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'src/shared/ipc-channels.ts::ipc.fooLoad',
    });
    expect(byQualifiedName.ipcChannel).toEqual(byKey.ipcChannel);

    const missing = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'noSuchChannel',
    });
    expect(missing.status).toBe('ok');
    expect(missing.ipcChannel?.channel).toBeNull();
    expect(missing.ipcChannel?.ambiguousCount).toBe(0);
    expect(missing.summary).toContain('not found');
  });

  it('scopes ipc-channel per repo and reports ambiguity for a same-repo duplicate key (P5 repo-scoping discriminating case)', async () => {
    for (const [root, handlerName, invokerName] of [
      [repoDir, 'handleA', 'invokeA'],
      [repoBDir, 'handleB', 'invokeB'],
    ] as const) {
      mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'main', 'ipc'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'shared', 'ipc-channels.ts'),
        `export const IPC_CHANNELS = {
  sharedChannel: 'shared:channel',
} as const;
`,
      );
      writeFileSync(
        path.join(root, 'src', 'main', 'ipc', 'register.ts'),
        `import { IPC_CHANNELS } from '../../shared/ipc-channels';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function ${handlerName}(): void {
  registerIpcHandler(IPC_CHANNELS.sharedChannel, () => {});
}
`,
      );
      writeFileSync(
        path.join(root, 'src', 'renderer', 'api.ts'),
        `import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

export function ${invokerName}(): void {
  ipcRenderer.invoke(IPC_CHANNELS.sharedChannel);
}
`,
      );
    }

    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'fixture-a', repoName: 'Fixture A', repoPath: repoDir },
      { repoId: 'fixture-b', repoName: 'Fixture B', repoPath: repoBDir },
    ]);

    await buildOrUpdateCodeGraph(runtime);

    const channelA = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'sharedChannel',
      repoId: 'fixture-a',
    });
    expect(channelA.ipcChannel?.ambiguousCount).toBe(0);
    expect(
      channelA.ipcChannel?.handlers.map((hit) => hit.qualifiedName),
    ).toEqual(['src/main/ipc/register.ts::handleA']);
    expect(
      channelA.ipcChannel?.invokers.map((hit) => hit.qualifiedName),
    ).toEqual(['src/renderer/api.ts::invokeA']);

    const channelB = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'sharedChannel',
      repoId: 'fixture-b',
    });
    expect(
      channelB.ipcChannel?.handlers.map((hit) => hit.qualifiedName),
    ).toEqual(['src/main/ipc/register.ts::handleB']);
    expect(
      channelB.ipcChannel?.invokers.map((hit) => hit.qualifiedName),
    ).toEqual(['src/renderer/api.ts::invokeB']);

    // Cross-repo ambiguity: omitting repoId leaves both repos' 'sharedChannel'
    // as legitimate candidates, so the honest answer is "ambiguous", not a
    // silent pick of whichever repo happens to be built first.
    const unscoped = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'sharedChannel',
    });
    expect(unscoped.ipcChannel?.ambiguousCount).toBe(2);
    expect(unscoped.ipcChannel?.channel).toBeNull();
    expect(unscoped.summary).toContain('Ambiguous');
    // F2: the ambiguity summary must point the caller at BOTH a qualified
    // name AND a repoId retry -- a qualified name alone still leaves a
    // cross-repo caller guessing which repo's declaration it means.
    expect(unscoped.summary).toContain('repoId');
  });

  it('surfaces unresolved call sites for a same-repo duplicate channel key even after resolving one declaration by qualified name (F2)', async () => {
    mkdirSync(path.join(repoDir, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(repoDir, 'src', 'shared2'), { recursive: true });
    mkdirSync(path.join(repoDir, 'src', 'main', 'ipc'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'src', 'shared', 'ipc-channels.ts'),
      `export const IPC_CHANNELS = {
  dupKey: 'dup:key',
} as const;
`,
    );
    writeFileSync(
      path.join(repoDir, 'src', 'shared2', 'ipc-channels.ts'),
      `export const IPC_CHANNELS = {
  dupKey: 'dup:key-2',
} as const;
`,
    );
    writeFileSync(
      path.join(repoDir, 'src', 'main', 'ipc', 'register.ts'),
      `import { IPC_CHANNELS } from '../../shared/ipc-channels';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.dupKey, () => {});
}
`,
    );

    await buildOrUpdateCodeGraph(runtime);

    // Same-repo bare-key ambiguity: two files declare 'dupKey' in this ONE
    // repo, so the honest answer is "ambiguous", not a silent pick.
    const ambiguous = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'dupKey',
    });
    expect(ambiguous.ipcChannel?.ambiguousCount).toBe(2);
    expect(ambiguous.summary).toContain('repoId');

    // Resolving ONE of the two duplicate declarations directly by qualified
    // name bypasses the bare-key ambiguity check above -- but the handler
    // call site was NEVER bound to either declaration by
    // resolve/ipc-resolver.ts (it left both declarations' shared key
    // unresolved), so the resolved channel must still surface that instead
    // of silently reporting zero handlers.
    const resolved = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'src/shared/ipc-channels.ts::ipc.dupKey',
    });
    expect(resolved.ipcChannel?.channel).not.toBeNull();
    expect(resolved.ipcChannel?.ambiguousCount).toBe(0);
    expect(resolved.ipcChannel?.handlers).toEqual([]);
    expect(resolved.ipcChannel?.unresolvedCallSiteCount).toBe(1);
    expect(resolved.summary).toContain('remain unbound');
  });

  it('says the signature-value lookup matched in the ambiguity summary when the match came via the string-value fallback (P6 wording)', async () => {
    // Two channels with DIFFERENT keys sharing the SAME string value: the
    // bare-key lookup finds nothing, the signature fallback finds both. The
    // summary must attribute the ambiguity to the string value -- claiming
    // two channels "declare this key" would be false.
    mkdirSync(path.join(repoDir, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(repoDir, 'src', 'shared2'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'src', 'shared', 'ipc-channels.ts'),
      `export const IPC_CHANNELS = {
  keyOne: 'dup:value',
} as const;
`,
    );
    writeFileSync(
      path.join(repoDir, 'src', 'shared2', 'ipc-channels.ts'),
      `export const IPC_CHANNELS = {
  keyTwo: 'dup:value',
} as const;
`,
    );

    await buildOrUpdateCodeGraph(runtime);

    const ambiguous = await queryCodeGraph(runtime, {
      mode: 'ipc-channel',
      target: 'dup:value',
    });
    expect(ambiguous.ipcChannel?.ambiguousCount).toBe(2);
    expect(ambiguous.summary).toContain('Ambiguous channel value');
    expect(ambiguous.summary).toContain('declare this string value');
    expect(ambiguous.summary).toContain('repoId');
    expect(ambiguous.summary).not.toContain('declare this key');
  });

  it('applies minimal vs standard detail level with truncation flags', async () => {
    writeFileSync(path.join(repoDir, 'src', 'extra.ts'), EXTRA);
    await buildOrUpdateCodeGraph(runtime);

    const minimal = await queryCodeGraph(runtime, {
      mode: 'callers',
      target: 'src/lib.ts::doWork',
    });
    expect(minimal.status).toBe('ok');
    expect(minimal.hits).toHaveLength(5);
    expect(minimal.truncated).toBe(true);
    expect(minimal.suggestedNextTools).toEqual(['QueryCodeGraph']);

    const standard = await queryCodeGraph(runtime, {
      mode: 'callers',
      target: 'src/lib.ts::doWork',
      detailLevel: 'standard',
      limit: 50,
    });
    expect(standard.status).toBe('ok');
    // main.ts::run + test file's checksDoWork + 6 EXTRA callers.
    expect(standard.hits).toHaveLength(8);
    expect(standard.truncated).toBe(false);
    expect(standard.suggestedNextTools).toBeUndefined();
  });

  describe('derived-analysis surfaces (Phase 6 Task 7)', () => {
    // A normal `buildOrUpdateCodeGraph` already runs the derived phase
    // (`computeDerived` defaults true, see engine.ts's `buildOrUpdate`), so
    // this fixture's real communities/flows already exist after a build.
    // To deterministically exercise the "derived analysis never computed"
    // honest-empty path (rather than depending on Louvain/flow-tracing
    // internals happening to produce zero output), this opens a second raw
    // connection to the SAME worktree db (WAL mode makes concurrent
    // connections safe -- same technique the desktop CLI's
    // `openWorktreeGraphConnection` uses) and overwrites whatever the build
    // computed with an explicitly empty derived state.
    function clearDerivedData(): void {
      const db: CodeGraphDatabase = openCodeGraphDatabase(
        getWorktreeCodeGraphDbPath(projectId, worktreeId),
      );
      runCodeGraphMigrations(db);
      const store = new CodeGraphStore(db);
      store.replaceDerivedForRepo('fixture', [], [], [], []);
      // This direct fixture writer must publish the same coherent projection as the engine.
      expect(publishCodeGraphSummaryProjection(db)).not.toBeNull();
      db.close();
    }

    it('rejects a target-requiring mode called without a target as a clear error, while targetless/optional-target modes succeed', async () => {
      // The missing-argument error takes precedence over the no-graph gate
      // (argument validation is a caller error and should be reported
      // precisely even before any build) — so no build for this first call.
      const missingCallers = await queryCodeGraph(runtime, {
        mode: 'callers',
      });
      expect(missingCallers.status).toBe('error');
      expect(missingCallers.summary).toContain('"callers"');
      expect(missingCallers.summary).toContain('requires a target');
      expect(missingCallers.hits).toEqual([]);

      await buildOrUpdateCodeGraph(runtime);

      // Same enforcement with a graph present, for a payload-carrying mode.
      const missingFileSummary = await queryCodeGraph(runtime, {
        mode: 'file-summary',
      });
      expect(missingFileSummary.status).toBe('error');
      expect(missingFileSummary.summary).toContain('"file-summary"');
      expect(missingFileSummary.summary).toContain('requires a target');
      expect(missingFileSummary.fileSummary).toBeUndefined();

      // Targetless modes and 'flows' (optional filter) still succeed with
      // no target at all.
      expect(
        (await queryCodeGraph(runtime, { mode: 'communities' })).status,
      ).toBe('ok');
      expect((await queryCodeGraph(runtime, { mode: 'hubs' })).status).toBe(
        'ok',
      );
      expect((await queryCodeGraph(runtime, { mode: 'flows' })).status).toBe(
        'ok',
      );
    });

    it('reports an honest-empty result (not an error) for communities/flows, and no enrichment, when derived tables are empty for the repo', async () => {
      await buildOrUpdateCodeGraph(runtime);
      clearDerivedData();

      const communities = await queryCodeGraph(runtime, {
        mode: 'communities',
      });
      expect(communities.status).toBe('ok');
      expect(communities.communities).toEqual([]);
      expect(communities.hits).toEqual([]);
      expect(communities.summary).toContain('derived: none');
      expect(communities.truncated).toBe(false);

      const flows = await queryCodeGraph(runtime, { mode: 'flows' });
      expect(flows.status).toBe('ok');
      expect(flows.flows).toEqual([]);
      expect(flows.summary).toContain('derived: none');

      const flowsForSymbol = await queryCodeGraph(runtime, {
        mode: 'flows',
        target: 'src/lib.ts::doWork',
      });
      expect(flowsForSymbol.status).toBe('ok');
      expect(flowsForSymbol.flows).toEqual([]);
      expect(flowsForSymbol.summary).toContain('derived: none');

      // 'hubs' is NOT a derived-analysis reading (it aggregates the live
      // `edges` table directly), so clearing communities/flows must not
      // affect it or append the derived:none note.
      const hubs = await queryCodeGraph(runtime, { mode: 'hubs' });
      expect(hubs.status).toBe('ok');
      expect(hubs.hits.length).toBeGreaterThan(0);
      expect(hubs.summary).not.toContain('derived: none');

      const context = await getCodeGraphContext(runtime);
      expect(context.status).toBe('ok');
      expect(context.topCommunities).toEqual([]);
      expect(context.communityCount).toBe(0);
      expect(context.flowCount).toBe(0);

      const explain = await explainCodeSymbol(runtime, {
        qualifiedName: 'src/lib.ts::doWork',
      });
      expect(explain.status).toBe('ok');
      expect(explain.community).toBeNull();
      expect(explain.flows).toEqual([]);
    });

    it('lists real communities/flows/hubs and enriches ExplainCodeSymbol/GetCodeGraphContext after a normal build', async () => {
      await buildOrUpdateCodeGraph(runtime);

      const communities = await queryCodeGraph(runtime, {
        mode: 'communities',
      });
      expect(communities.status).toBe('ok');
      expect(communities.communities?.length).toBeGreaterThan(0);
      expect(communities.hits).toEqual([]);
      expect(communities.summary).not.toContain('derived: none');
      for (const hit of communities.communities ?? []) {
        expect(typeof hit.id).toBe('string');
        expect(typeof hit.label).toBe('string');
        expect(typeof hit.size).toBe('number');
        expect(typeof hit.cohesion).toBe('number');
      }

      const flows = await queryCodeGraph(runtime, { mode: 'flows' });
      expect(flows.status).toBe('ok');
      expect(flows.flows?.length).toBeGreaterThan(0);

      // `run` (main.ts) calls `doWork` and has no incoming CALLS, making it
      // a call-graph-root flow entry that traces forward through doWork —
      // so filtering flows by doWork's qualified name must find at least
      // one of the same flows the unfiltered list above surfaced.
      const flowsForDoWork = await queryCodeGraph(runtime, {
        mode: 'flows',
        target: 'src/lib.ts::doWork',
      });
      expect(flowsForDoWork.status).toBe('ok');
      expect(flowsForDoWork.flows?.length).toBeGreaterThan(0);

      const hubs = await queryCodeGraph(runtime, { mode: 'hubs' });
      expect(hubs.status).toBe('ok');
      expect(hubs.hits.length).toBeGreaterThan(0);
      expect(hubs.hits[0].label).toMatch(/^degree \d+$/);
      // 'hubs' hits reuse the shared symbol-hit shape (a real, chainable
      // qualifiedName), not a synthetic identifier.
      expect(hubs.hits[0].qualifiedName).not.toBe('');

      const context = await getCodeGraphContext(runtime);
      expect(context.status).toBe('ok');
      expect(context.communityCount).toBeGreaterThan(0);
      expect(context.topCommunities.length).toBeGreaterThan(0);
      expect(context.topCommunities.length).toBeLessThanOrEqual(5);

      const explain = await explainCodeSymbol(runtime, {
        qualifiedName: 'src/lib.ts::doWork',
      });
      expect(explain.status).toBe('ok');
      expect(explain.community).not.toBeNull();
      expect(explain.flows.length).toBeGreaterThan(0);
      expect(explain.flows.length).toBeLessThanOrEqual(3);
    });

    // Whole-branch-review fix: `CodeGraphBuildResult.derived[].warnings` used
    // to be recorded engine-level but discarded here. Exercising the real
    // 50k-symbol community-detection skip / flow global-membership cap isn't
    // practical in a fixture-sized test, so this reaches the SAME non-fatal
    // derived-analysis-failure path `engine.test.ts` already covers at the
    // engine level (`CodeGraphStore.prototype.listSymbolsForRepo` throwing
    // sends `computeDerivedForRepo` into its catch branch) but end to end
    // through `buildOrUpdateCodeGraph`, proving the warning now reaches the
    // tool result instead of being silently dropped.
    it('surfaces a non-fatal derived-analysis failure as a derivedWarnings entry without failing the build', async () => {
      const listSpy = jest
        .spyOn(CodeGraphStore.prototype, 'listSymbolsForRepo')
        .mockImplementation(() => {
          throw new Error('boom: symbol load failed');
        });
      try {
        const build = await buildOrUpdateCodeGraph(runtime);
        expect(build.status).toBe('ok');
        expect(build.filesParsed).toBe(3);
        expect(build.derivedWarnings).toHaveLength(1);
        expect(build.derivedWarnings?.[0]).toContain(
          'derived analysis failed for fixture',
        );
        expect(build.derivedWarnings?.[0]).toContain(
          'boom: symbol load failed',
        );
      } finally {
        listSpy.mockRestore();
      }
    });
  });

  describe('change-impact tools', () => {
    function git(root: string, args: string[]): string {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
      }).trim();
    }

    function commitAll(root: string, message: string): string {
      git(root, ['add', '-A']);
      git(root, [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '--quiet',
        '-m',
        message,
      ]);
      return git(root, ['rev-parse', 'HEAD']);
    }

    let v1Sha: string;

    beforeEach(async () => {
      // `-b main` forces the initial branch name regardless of this test
      // machine's `init.defaultBranch` config, so committing v2 on a
      // DIFFERENT branch (`work`) below reliably leaves `main` pinned at v1
      // for the default baseRef-resolution chain (origin/develop -> develop
      // -> origin/main -> main -> HEAD) to resolve via merge-base.
      git(repoDir, ['init', '-b', 'main', '--quiet']);
      writeFileSync(path.join(repoDir, 'src', 'authTool.ts'), V1_AUTH_TOOL);
      writeFileSync(path.join(repoDir, 'src', 'gone.ts'), GONE);
      v1Sha = commitAll(repoDir, 'v1');
      git(repoDir, ['checkout', '--quiet', '-b', 'work']);

      writeFileSync(path.join(repoDir, 'src', 'lib.ts'), V2_LIB);
      writeFileSync(path.join(repoDir, 'src', 'authTool.ts'), V2_AUTH_TOOL);
      rmSync(path.join(repoDir, 'src', 'gone.ts'));
      commitAll(repoDir, 'v2');

      await buildOrUpdateCodeGraph(runtime);
    });

    describe('detectChangedSymbols', () => {
      it('detects changed symbols against the default-resolved baseRef', async () => {
        const result = await detectChangedSymbols(runtime, {});

        expect(result.status).toBe('ok');
        expect(result.baseRef).toBe(v1Sha);
        expect(
          result.changed.map((symbol) => symbol.qualifiedName).sort(),
        ).toEqual([
          'src/authTool.ts::checkAuthToken',
          'src/lib.ts::doWork',
          'src/lib.ts::newFn',
        ]);
        expect(
          result.changed.every((symbol) => symbol.changeKind === 'modified'),
        ).toBe(true);
        expect(result.unmatchedFiles).toEqual(['src/gone.ts']);
        expect(result.truncated).toBe(false);
        // Staleness signal: the graph was just built, so lastBuildAt is set.
        expect(result.lastBuildAt).not.toBeNull();
      });

      it('echoes an explicitly-provided baseRef verbatim instead of resolving one', async () => {
        const result = await detectChangedSymbols(runtime, {
          baseRef: v1Sha,
        });

        expect(result.status).toBe('ok');
        expect(result.baseRef).toBe(v1Sha);
        expect(result.changed).toHaveLength(3);
      });

      it('returns an error envelope (not a throw) for an unsafe baseRef', async () => {
        const result = await detectChangedSymbols(runtime, {
          baseRef: '--upload-pack=evil',
        });

        expect(result.status).toBe('error');
        expect(result.summary).toContain('Unsafe git ref');
        expect(result.baseRef).toBe('');
        expect(result.changed).toEqual([]);
      });

      it('caps changed symbols at 200 with truncated: true even at detailLevel standard', async () => {
        // 210 generated functions in one added file → 211 changed symbols
        // from that file alone (file symbol + functions), plus the base
        // fixture's 3, comfortably past the 200-item standard-detail cap.
        const manyFns = Array.from(
          { length: 210 },
          (_, i) =>
            `export function generatedFn${i}(): number { return ${i}; }`,
        ).join('\n');
        writeFileSync(path.join(repoDir, 'src', 'many.ts'), `${manyFns}\n`);
        commitAll(repoDir, 'v3-many');
        await buildOrUpdateCodeGraph(runtime);

        const result = await detectChangedSymbols(runtime, {
          baseRef: v1Sha,
          detailLevel: 'standard',
        });

        expect(result.status).toBe('ok');
        expect(result.changed).toHaveLength(200);
        expect(result.truncated).toBe(true);
        expect(result.summary).toContain('showing 200');
      });
    });

    describe('compareChangeImpact', () => {
      it('computes delta counts and risk at the default (minimal) detail level', async () => {
        const result = await compareChangeImpact(runtime, {
          baseRef: v1Sha,
        });

        expect(result.status).toBe('ok');
        expect(result.baseRef).toBe(v1Sha);
        expect(result.delta.addedCount).toBe(1);
        expect(result.delta.removedCount).toBe(2);
        expect(result.delta.signatureChangedCount).toBe(1);
        // Detail arrays are omitted entirely at the default 'minimal' level.
        expect(result.delta.added).toBeUndefined();
        expect(result.delta.removed).toBeUndefined();
        expect(result.delta.signatureChanged).toBeUndefined();

        // 'high' (not just the Phase 4 'medium' ceiling of 0.60): the real
        // build's derived phase (Task 6, `computeDerived` defaults true)
        // now also scores flow-participation/community-crossing for
        // checkAuthToken, pushing the score above the old 0.60 cap.
        expect(result.risk.level).toBe('high');
        expect(
          result.risk.reasons.some((reason) =>
            reason.includes('src/authTool.ts::checkAuthToken'),
          ),
        ).toBe(true);

        // Depth-1 callers of doWork are run() and checksDoWork(); at the
        // default depth (2), the test file's own module-level
        // `checksDoWork();` call also makes the FILE symbol itself a
        // (depth-2) caller of checksDoWork, hence a third impacted hit.
        expect(result.impacted.map((hit) => hit.qualifiedName).sort()).toEqual([
          'src/__tests__/lib.test.ts',
          'src/__tests__/lib.test.ts::checksDoWork',
          'src/main.ts::run',
        ]);
        // Each impacted hit carries its traversal depth (mirroring the
        // GetImpactRadius tool) so direct vs transitive is distinguishable.
        const depthByName = new Map(
          result.impacted.map((hit) => [hit.qualifiedName, hit.depth]),
        );
        expect(depthByName.get('src/main.ts::run')).toBe(1);
        expect(depthByName.get('src/__tests__/lib.test.ts::checksDoWork')).toBe(
          1,
        );
        expect(depthByName.get('src/__tests__/lib.test.ts')).toBe(2);
        expect(result.impactedTests).toEqual(['src/__tests__/lib.test.ts']);
        expect(result.lastBuildAt).not.toBeNull();
      });

      it('includes full delta detail arrays at detailLevel standard', async () => {
        const result = await compareChangeImpact(runtime, {
          baseRef: v1Sha,
          detailLevel: 'standard',
        });

        expect(result.delta.added?.map((s) => s.qualifiedName)).toEqual([
          'src/lib.ts::newFn',
        ]);
        expect(
          result.delta.removed?.map((s) => s.qualifiedName).sort(),
        ).toEqual(['src/gone.ts', 'src/gone.ts::goneFn']);
        expect(
          result.delta.signatureChanged?.map((s) => s.qualifiedName),
        ).toEqual(['src/lib.ts::doWork']);
      });
    });

    describe('getReviewContext', () => {
      it('builds review context with test gaps and review priorities', async () => {
        const result = await getReviewContext(runtime, { baseRef: v1Sha });

        expect(result.status).toBe('ok');
        expect(result.baseRef).toBe(v1Sha);
        expect(result.testGaps.map((gap) => gap.qualifiedName).sort()).toEqual([
          'src/authTool.ts::checkAuthToken',
          'src/lib.ts::newFn',
        ]);
        expect(result.reviewPriorities[0]?.qualifiedName).toBe(
          'src/authTool.ts::checkAuthToken',
        );
        expect(result.impactedFiles.slice().sort()).toEqual([
          'src/__tests__/lib.test.ts',
          'src/main.ts',
        ]);
        expect(result.impactedTests).toEqual(['src/__tests__/lib.test.ts']);
        // See the identical note in compareChangeImpact's test above: the
        // derived phase's flow-participation term now pushes this above
        // the old Phase 4 'medium' ceiling.
        expect(result.risk.level).toBe('high');
        expect(
          result.changedSymbols.find(
            (symbol) =>
              symbol.qualifiedName === 'src/authTool.ts::checkAuthToken',
          )?.riskReasons.length,
        ).toBeGreaterThan(0);
        expect(result.lastBuildAt).not.toBeNull();
      });
    });

    describe('stale derived analysis (Phase 20)', () => {
      // A worktree build that defers derived analysis publishes its graph
      // first; until derived analysis completes, every surface that reads
      // communities or flows says so, including change impact's risk.
      async function publishWithDerivedPending(): Promise<void> {
        writeFileSync(
          path.join(repoDir, 'src', 'extra.ts'),
          `import { checkAuthToken } from './authTool';\nexport function extra(): boolean { return checkAuthToken('x'); }\n`,
        );
        mockRunCodeGraphWorkerBuild.mockImplementationOnce(
          (_key: string, request: CodeGraphWorkerBuildRequest) =>
            executeCodeGraphBuild(request, { allowDeferredDerived: true }),
        );
        const build = await buildOrUpdateCodeGraph(runtime);
        expect(build.status).toBe('ok');
        expect(build.summary).toContain(
          'Derived analysis (communities, flows) is still running',
        );
      }

      it('reports stale derived data in queries, context and change impact until derived analysis completes', async () => {
        await publishWithDerivedPending();

        const communities = await queryCodeGraph(runtime, {
          mode: 'communities',
        });
        expect(communities.status).toBe('ok');
        expect(communities.communities?.length).toBeGreaterThan(0);
        expect(communities.summary).toContain('derived: stale');
        const flows = await queryCodeGraph(runtime, { mode: 'flows' });
        expect(flows.summary).toContain('derived: stale');

        const context = await getCodeGraphContext(runtime);
        expect(context.status).toBe('ok');
        expect(context.derivedState).toBe('stale');
        expect(context.summary).toContain('derived: stale');

        const impact = await compareChangeImpact(runtime, { baseRef: v1Sha });
        expect(impact.status).toBe('ok');
        expect(impact.risk.staleInputs).toEqual([
          'flowParticipation',
          'communityCrossing',
        ]);
        expect(impact.risk.formula).toContain('derived analyses stale');
        expect(impact.summary).toContain('flow/community inputs stale');
        const review = await getReviewContext(runtime, { baseRef: v1Sha });
        expect(review.summary).toContain('flow/community inputs stale');

        const completion = await executeDeferredCodeGraphDerived({
          dbPath: getWorktreeCodeGraphDbPath(projectId, worktreeId),
        });
        expect(completion).toMatchObject({ ok: true, ran: true });

        const caughtUp = await queryCodeGraph(runtime, {
          mode: 'communities',
        });
        expect(caughtUp.summary).not.toContain('derived: stale');
        const currentContext = await getCodeGraphContext(runtime);
        expect(currentContext).not.toHaveProperty('derivedState');
        expect(currentContext.summary).not.toContain('derived:');
        const currentImpact = await compareChangeImpact(runtime, {
          baseRef: v1Sha,
        });
        expect(currentImpact.risk).not.toHaveProperty('staleInputs');
        expect(currentImpact.summary).not.toContain('stale');
      });
    });
  });

  it('names the analyzed repo in the summary when the worktree has more than one repository', async () => {
    function git(root: string, args: string[]): string {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
      }).trim();
    }
    function commitAll(root: string, message: string): string {
      git(root, ['add', '-A']);
      git(root, [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '--quiet',
        '-m',
        message,
      ]);
      return git(root, ['rev-parse', 'HEAD']);
    }

    git(repoDir, ['init', '--quiet']);
    const shaA = commitAll(repoDir, 'v1');

    git(repoBDir, ['init', '--quiet']);
    writeFileSync(path.join(repoBDir, 'readme.md'), '# b\n');
    commitAll(repoBDir, 'v1');

    mockListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'fixture-a', repoName: 'Fixture A', repoPath: repoDir },
      { repoId: 'fixture-b', repoName: 'Fixture B', repoPath: repoBDir },
    ]);

    await buildOrUpdateCodeGraph(runtime);

    const detect = await detectChangedSymbols(runtime, {
      repoId: 'fixture-a',
      baseRef: shaA,
    });
    expect(detect.status).toBe('ok');
    expect(detect.summary).toContain('(repo: fixture-a)');

    const compare = await compareChangeImpact(runtime, {
      repoId: 'fixture-a',
      baseRef: shaA,
    });
    expect(compare.status).toBe('ok');
    expect(compare.summary).toContain('(repo: fixture-a)');

    const review = await getReviewContext(runtime, {
      repoId: 'fixture-a',
      baseRef: shaA,
    });
    expect(review.status).toBe('ok');
    expect(review.summary).toContain('(repo: fixture-a)');
  });
});
