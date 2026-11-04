import type { readCodeGraphWorktreeCompletion } from '../lib/code-graph-worktree-fingerprint';
import type { startCodeGraphGenerationTelemetry } from '../lib/code-graph-telemetry';

const mockResolveWorktreeCwd = jest.fn();
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (...args: unknown[]): unknown =>
    mockResolveWorktreeCwd(...args),
}));

const mockRunCodeGraphWorkerBuild = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../code-graph/build-runner', () => ({
  beginCodeGraphWorkerBuild: (...args: unknown[]): unknown => ({
    attemptId: 'admitted-service-fixture',
    promise: mockRunCodeGraphWorkerBuild(...args),
  }),
  runCodeGraphWorkerBuild: (...args: unknown[]): unknown =>
    mockRunCodeGraphWorkerBuild(...args),
}));

const mockCopyCompatibleCodeGraphBaseForSeed = jest.fn();
jest.mock('../lib/code-graph-base-store', () => ({
  copyCompatibleCodeGraphBaseForSeed: (...args: unknown[]): unknown =>
    mockCopyCompatibleCodeGraphBaseForSeed(...args),
}));

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): unknown => ({
    withWorktreeClosed: (
      _projectId: string,
      _worktreeId: string,
      callback: () => unknown,
    ): unknown => callback(),
  }),
}));

const mockIsCodeGraphAvailableForWorkspace = jest.fn<boolean, [string]>(
  () => true,
);
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (workspaceId: string): boolean =>
    mockIsCodeGraphAvailableForWorkspace(workspaceId),
}));

const mockResolveWorktreeCodeGraphRepositories = jest.fn();
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (...args: unknown[]): unknown =>
    mockResolveWorktreeCodeGraphRepositories(...args),
}));

const mockReadWorkspaceIndexEntry = jest.fn();
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (...args: unknown[]): unknown =>
    mockReadWorkspaceIndexEntry(...args),
}));

const mockFingerprintCodeGraphWorktree = jest.fn<Promise<string>, unknown[]>();
jest.mock('../code-graph/fingerprint-runner', () => ({
  runCodeGraphWorkerFingerprint: async (
    ...args: unknown[]
  ): Promise<unknown> => ({
    ok: true,
    fingerprint: await mockFingerprintCodeGraphWorktree(...args),
  }),
}));
// Completion is read through the off-main fingerprint metadata lane.
const mockHasCompletedCodeGraph = jest.fn<
  Awaited<ReturnType<typeof readCodeGraphWorktreeCompletion>>,
  Parameters<typeof readCodeGraphWorktreeCompletion>
>(() => false);
jest.mock('../lib/code-graph-worktree-fingerprint', () => ({
  clearCodeGraphWorktreeFingerprintCache: jest.fn(),
  readCodeGraphWorktreeCompletion: (
    ...args: Parameters<typeof readCodeGraphWorktreeCompletion>
  ): Promise<boolean> => Promise.resolve(mockHasCompletedCodeGraph(...args)),
}));

const mockFingerprintCustomLanguageInputs = jest.fn();
jest.mock('@canopy/code-graph/languages/custom-config', () => ({
  fingerprintCustomLanguageInputs: (...args: unknown[]): unknown =>
    mockFingerprintCustomLanguageInputs(...args),
}));

const mockReadWorkspaceConfig = jest.fn();
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (...args: unknown[]): unknown =>
    mockReadWorkspaceConfig(...args),
}));

jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (): string =>
    '/tmp/canopy-code-graph-build-service-test/graph.db',
  getWorktreeCodeGraphDir: (): string =>
    '/tmp/canopy-code-graph-build-service-test',
}));

const mockStartCodeGraphGenerationTelemetry = jest.fn<
  ReturnType<typeof startCodeGraphGenerationTelemetry>,
  Parameters<typeof startCodeGraphGenerationTelemetry>
>(() => ({
  operationKey: 'operation-key',
  startedAtMs: 1_000,
  context: {},
}));
const mockFailCodeGraphGenerationTelemetry = jest.fn();
jest.mock('../lib/code-graph-telemetry', () => ({
  codeGraphGenerationFailureReason: jest.fn(() => 'unknown'),
  completeCodeGraphGenerationTelemetry: jest.fn(),
  failCodeGraphGenerationTelemetry: (...args: unknown[]): unknown =>
    mockFailCodeGraphGenerationTelemetry(...args),
  startCodeGraphGenerationTelemetry: (
    ...args: Parameters<typeof startCodeGraphGenerationTelemetry>
  ): ReturnType<typeof startCodeGraphGenerationTelemetry> =>
    mockStartCodeGraphGenerationTelemetry(...args),
}));

jest.mock('../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: jest.fn(() => true),
}));

import { runWorktreeCodeGraphBuild } from '../lib/code-graph-build-service';
import {
  codeGraphFirstRequestedAt,
  noteCodeGraphFirstRequest,
  resetCodeGraphBuildDiagnosticsForTests,
  setCodeGraphBuildDiagnosticRecorderForTests,
} from '../lib/code-graph-build-diagnostics';
import type { SessionDiagnosticRecord } from '../observability/service';
import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';

const anyNumber: unknown = expect.any(Number);

function builtResult(): CodeGraphBuildResult {
  return {
    filesScanned: 3,
    filesParsed: 2,
    filesUnchanged: 1,
    filesSkipped: 0,
    filesRemoved: 0,
    parseFailures: 0,
    symbolCount: 9,
    edgeCount: 4,
    durationMs: 120,
    derived: [],
    customLanguages: null,
    factsChanged: true,
    timings: {
      queueWaitMs: 40,
      fingerprintMs: 5,
      seedCopyMs: 0,
      fusionMs: 3,
      prepareMs: 2,
      scanMs: 10,
      hashMs: 4,
      parseMs: 60,
      diagnosticsMs: 6,
      commitMs: 8,
      rowsWritten: 311,
      peakWalBytes: 4_096,
      peakRssBytes: 90_000_000,
      timeToFirstGraphMs: 9_000,
    },
  };
}

describe('code graph build service', () => {
  beforeEach(() => {
    mockResolveWorktreeCwd.mockReset();
    mockResolveWorktreeCwd.mockReturnValue('/worktree');
    mockIsCodeGraphAvailableForWorkspace.mockReset();
    mockIsCodeGraphAvailableForWorkspace.mockReturnValue(true);
    mockResolveWorktreeCodeGraphRepositories.mockReset();
    mockResolveWorktreeCodeGraphRepositories.mockResolvedValue([
      { repoId: 'repo-1', rootPath: '/worktree' },
    ]);
    mockReadWorkspaceIndexEntry.mockReset();
    mockReadWorkspaceIndexEntry.mockResolvedValue(null);
    mockFingerprintCodeGraphWorktree.mockReset();
    mockFingerprintCodeGraphWorktree.mockResolvedValue('fingerprint');
    mockFingerprintCustomLanguageInputs.mockReset();
    mockFingerprintCustomLanguageInputs.mockResolvedValue({
      value: 'custom-languages',
    });
    mockReadWorkspaceConfig.mockReset();
    mockReadWorkspaceConfig.mockResolvedValue({
      type: 'single-repo',
      repoPath: '/canonical',
    });
    mockHasCompletedCodeGraph.mockReset();
    mockHasCompletedCodeGraph.mockReturnValue(false);
    mockCopyCompatibleCodeGraphBaseForSeed.mockReset();
    mockCopyCompatibleCodeGraphBaseForSeed.mockResolvedValue(null);
    mockRunCodeGraphWorkerBuild.mockReset();
    mockRunCodeGraphWorkerBuild.mockResolvedValue({
      ok: false,
      message: 'stopped after queue admission',
    });
    mockStartCodeGraphGenerationTelemetry.mockClear();
    mockFailCodeGraphGenerationTelemetry.mockClear();
  });

  it('reports worktree resolution failures as preflight telemetry', async () => {
    const error = new Error('private worktree resolution detail');
    mockResolveWorktreeCwd.mockImplementation(() => {
      throw error;
    });

    await expect(
      runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      }),
    ).rejects.toBe(error);

    expect(mockStartCodeGraphGenerationTelemetry).toHaveBeenCalledWith({
      operationSeed: 'project-1/worktree-1',
      scope: 'worktree',
      trigger: 'refresh',
    });
    expect(
      mockStartCodeGraphGenerationTelemetry.mock.invocationCallOrder[0],
    ).toBeLessThan(mockResolveWorktreeCwd.mock.invocationCallOrder[0] ?? 0);
    expect(mockFailCodeGraphGenerationTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'operation-key' }),
      { stage: 'preflight', reason: 'unknown' },
    );
  });

  it('closes telemetry when availability changes during preflight', async () => {
    mockIsCodeGraphAvailableForWorkspace
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Code graph tools are not available for this project.',
    });

    expect(mockFailCodeGraphGenerationTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'operation-key' }),
      { stage: 'preflight', reason: 'unavailable' },
    );
  });

  it('closes telemetry when availability changes during seed preparation', async () => {
    mockIsCodeGraphAvailableForWorkspace
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Code graph tools are not available for this project.',
    });

    expect(mockFailCodeGraphGenerationTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'operation-key' }),
      { stage: 'seed-preparation', reason: 'unavailable' },
    );
  });

  it('admits manual builds to the foreground worker lane', async () => {
    await runWorktreeCodeGraphBuild({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      reason: 'manual',
    });

    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
      'project-1/worktree-1',
      expect.any(Object),
      expect.objectContaining({ priority: 'agent' }),
    );
  });

  it.each([
    [false, 'first-build'],
    [true, 'worktree'],
  ] as const)(
    'queues an automatic build for a worktree whose graph completed=%s as %s',
    async (completed, priority) => {
      mockHasCompletedCodeGraph.mockReturnValue(completed);
      await runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      });

      expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
        'project-1/worktree-1',
        expect.any(Object),
        expect.objectContaining({ priority }),
      );
    },
  );

  it('keeps an agent request in the agent lane even without a graph', async () => {
    mockHasCompletedCodeGraph.mockReturnValue(false);
    await runWorktreeCodeGraphBuild({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      reason: 'tool-request',
    });

    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
      'project-1/worktree-1',
      expect.any(Object),
      expect.objectContaining({ priority: 'agent' }),
    );
  });

  it('queues the cold fallback after failed seed preparation as a first build', async () => {
    mockHasCompletedCodeGraph.mockReturnValue(false);
    mockFingerprintCustomLanguageInputs.mockRejectedValue(
      new Error('config unreadable'),
    );
    await runWorktreeCodeGraphBuild({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      reason: 'worktree-created',
    });

    const fallbackMetadata: unknown = expect.objectContaining({
      trigger: 'seed-preparation-fallback',
    });
    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledTimes(1);
    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
      'project-1/worktree-1',
      expect.any(Object),
      expect.objectContaining({
        priority: 'first-build',
        metadata: fallbackMetadata,
      }),
    );
  });

  describe('build timings and diagnostics', () => {
    let records: SessionDiagnosticRecord[];

    beforeEach(() => {
      records = [];
      resetCodeGraphBuildDiagnosticsForTests();
      setCodeGraphBuildDiagnosticRecorderForTests((record) =>
        records.push(record),
      );
    });

    afterEach(() => {
      setCodeGraphBuildDiagnosticRecorderForTests(null);
    });

    it('sends the prelude timings and the first-graph request time to the worker', async () => {
      noteCodeGraphFirstRequest('project-1/worktree-1', 1_000);
      mockRunCodeGraphWorkerBuild.mockResolvedValue({
        ok: true,
        result: builtResult(),
        seedOutcomes: [],
      });

      await runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'worktree-created',
        observedFingerprint: 'fingerprint',
        observedFingerprintMs: 17,
      });

      expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
        'project-1/worktree-1',
        expect.objectContaining({
          // The build host stores this once the graph is published, when the
          // worktree still matches it.
          fingerprint: { start: 'fingerprint' },
          timings: {
            fingerprintMs: 17,
            seedCopyMs: anyNumber,
            firstGraphRequestedAt: 1_000,
          },
        }),
        expect.any(Object),
      );
      // The first graph completed, so its request time is released.
      expect(codeGraphFirstRequestedAt('project-1/worktree-1')).toBeUndefined();
    });

    it('records one worktree build diagnostic with worker and main timings', async () => {
      mockRunCodeGraphWorkerBuild.mockResolvedValue({
        ok: true,
        result: builtResult(),
        seedOutcomes: [],
        fingerprint: {
          outcome: 'persisted',
          endFingerprintMs: 4.04,
          persistMs: 1.01,
        },
      });

      await runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        version: 1,
        kind: 'code_graph_build',
        sessionKey: 'project-1/worktree-1/',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: '',
        providerType: 'unknown',
        codeGraphBuild: {
          scope: 'worktree',
          trigger: 'refresh',
          outcome: 'success',
          queuePriority: 'first-build',
          filesScanned: 3,
          filesParsed: 2,
          factsChanged: true,
          timings: builtResult().timings,
        },
      });
      const build = records[0]?.codeGraphBuild;
      expect(build?.totalMs).toBeGreaterThanOrEqual(0);
      expect(build).toMatchObject({
        endFingerprintMs: 4,
        fingerprintPersistMs: 1,
        fingerprintPersistOutcome: 'persisted',
      });
    });

    it('omits the first-graph request time once the worktree has a graph', async () => {
      mockHasCompletedCodeGraph.mockReturnValue(true);
      noteCodeGraphFirstRequest('project-1/worktree-1', 1_000);
      mockRunCodeGraphWorkerBuild.mockResolvedValue({
        ok: true,
        result: builtResult(),
      });

      await runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      });

      // Exactly these timings: no first-graph request time.
      expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
        'project-1/worktree-1',
        expect.objectContaining({
          timings: { fingerprintMs: anyNumber, seedCopyMs: 0 },
        }),
        expect.any(Object),
      );
      expect(codeGraphFirstRequestedAt('project-1/worktree-1')).toBeUndefined();
    });

    it('records a failed build with its failure stage', async () => {
      mockRunCodeGraphWorkerBuild.mockResolvedValue({
        ok: false,
        message: 'worker failed',
      });

      await runWorktreeCodeGraphBuild({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        reason: 'refresh',
      });

      expect(records).toHaveLength(1);
      expect(records[0]?.codeGraphBuild).toMatchObject({
        scope: 'worktree',
        outcome: 'failure',
        failureStage: 'worker-build',
        queuePriority: 'first-build',
      });
      // The first graph did not complete; its request time is kept.
      expect(codeGraphFirstRequestedAt('project-1/worktree-1')).toEqual(
        expect.any(Number),
      );
    });
  });
});
