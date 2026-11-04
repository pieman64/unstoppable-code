import type { CodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import type {
  CodeGraphBuildOptions,
  CodeGraphBuildResult,
  CodeGraphRepositoryInput,
} from '@canopy/desktop-shared/types/code-graph';
import type { CodeGraphReadFailure } from '@canopy/desktop-shared/types/code-graph-tools';
import type {
  CodeGraphBuildSchedulingOptions,
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerBuildHandle,
} from '../code-graph/build-runner';
import type {
  CodeGraphFingerprintOptions,
  CodeGraphFingerprintWorkerResponse,
} from '../code-graph/fingerprint-runner';
import type { SessionDiagnosticRecord } from '../observability/service';

type BuildHandle = CodeGraphWorkerBuildHandle;

const mockBeginBuild = jest.fn<
  BuildHandle,
  [string, CodeGraphWorkerBuildRequest, CodeGraphBuildSchedulingOptions?]
>();
const mockCodeGraphReadFailure = jest.fn<CodeGraphReadFailure, [unknown]>();
const mockCodeGraphReadFailureErrorClass = class extends Error {
  public constructor(public readonly readFailure: CodeGraphReadFailure) {
    super('Code-graph metadata is temporarily unavailable.');
  }
};
const mockCopyBase = jest.fn<Promise<null>, [unknown]>();
const mockCustomLanguages = jest.fn<Promise<{ value: string }>, [string]>();
const mockFailTelemetry = jest.fn<void, [unknown, unknown]>();
const mockFingerprint = jest.fn<
  Promise<CodeGraphFingerprintWorkerResponse>,
  [string, readonly CodeGraphRepositoryInput[], CodeGraphFingerprintOptions?]
>();
const mockFsMkdir = jest.fn<Promise<void>, [string, { recursive: true }]>();
const mockFsReadDir = jest.fn<
  Promise<never[]>,
  [string, { withFileTypes: true }]
>();
const mockFsRemove = jest.fn<
  Promise<void>,
  [string, { recursive: true; force: true }]
>();
const mockIsAvailable = jest.fn<boolean, [string]>();
const mockReadCompletion = jest.fn<Promise<boolean>, [string, string]>();
const mockReadWorkspaceConfig = jest.fn<
  Promise<{ type: 'single-repo'; repoPath: string }>,
  []
>();
const mockReadWorkspaceIndexEntry = jest.fn<Promise<null>, [string]>();
const mockResolveRepositories = jest.fn<
  Promise<CodeGraphRepositoryInput[]>,
  [string, string]
>();
const mockResolveWorktree = jest.fn<string, [string, string]>();
const mockStartTelemetry = jest.fn(() => ({
  operationKey: 'operation-key',
  startedAtMs: 1_000,
  context: {},
}));
const mockCompleteTelemetry = jest.fn<void, [unknown, unknown]>();

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: true }): Promise<void> =>
    mockFsMkdir(path, options),
  readdir: (path: string, options: { withFileTypes: true }): Promise<never[]> =>
    mockFsReadDir(path, options),
  rm: (
    path: string,
    options: { recursive: true; force: true },
  ): Promise<void> => mockFsRemove(path, options),
}));
jest.mock('@canopy/code-graph/languages/custom-config', () => ({
  fingerprintCustomLanguageInputs: (
    worktreePath: string,
  ): Promise<{ value: string }> => mockCustomLanguages(worktreePath),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): Pick<
    CodeGraphWorktreeService,
    'withWorktreeClosed'
  > => ({
    withWorktreeClosed: <T>(
      _projectId: string,
      _worktreeId: string,
      callback: () => Promise<T>,
    ): Promise<T> => callback(),
  }),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (projectId: string, worktreeId: string): string =>
    `/mock/${projectId}/${worktreeId}/graph.db`,
  getWorktreeCodeGraphDir: (projectId: string, worktreeId: string): string =>
    `/mock/${projectId}/${worktreeId}`,
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledCodeGraphDir: (): string => '/mock/bundled-code-graph',
}));
jest.mock('../code-graph/build-runner', () => ({
  beginCodeGraphWorkerBuild: (
    key: string,
    request: CodeGraphWorkerBuildRequest,
    scheduling?: CodeGraphBuildSchedulingOptions,
  ): BuildHandle => mockBeginBuild(key, request, scheduling),
}));
jest.mock('../code-graph/fingerprint-runner', () => ({
  runCodeGraphWorkerFingerprint: (
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
    options?: CodeGraphFingerprintOptions,
  ): Promise<CodeGraphFingerprintWorkerResponse> =>
    mockFingerprint(key, repositories, options),
}));
jest.mock('../code-graph/read-runner', () => ({
  get CodeGraphReadFailureError(): typeof mockCodeGraphReadFailureErrorClass {
    return mockCodeGraphReadFailureErrorClass;
  },
  codeGraphReadFailure: (error: unknown): CodeGraphReadFailure =>
    mockCodeGraphReadFailure(error),
}));
jest.mock('../lib/code-graph-base-store', () => ({
  copyCompatibleCodeGraphBaseForSeed: (input: unknown): Promise<null> =>
    mockCopyBase(input),
}));
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (projectId: string): boolean =>
    mockIsAvailable(projectId),
}));
jest.mock('../lib/code-graph-worktree-fingerprint', () => ({
  clearCodeGraphWorktreeFingerprintCache: jest.fn(),
  readCodeGraphWorktreeCompletion: (
    dbPath: string,
    key: string,
  ): Promise<boolean> => mockReadCompletion(dbPath, key),
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  codeGraphGenerationFailureReason: jest.fn(() => 'unknown'),
  completeCodeGraphGenerationTelemetry: (
    handle: unknown,
    input: unknown,
  ): void => mockCompleteTelemetry(handle, input),
  failCodeGraphGenerationTelemetry: (handle: unknown, input: unknown): void =>
    mockFailTelemetry(handle, input),
  startCodeGraphGenerationTelemetry: (_input: unknown): unknown => {
    void _input;
    return mockStartTelemetry();
  },
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (projectId: string, worktreeId: string): string =>
    mockResolveWorktree(projectId, worktreeId),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (projectId: string): Promise<null> =>
    mockReadWorkspaceIndexEntry(projectId),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (): Promise<{ type: 'single-repo'; repoPath: string }> =>
    mockReadWorkspaceConfig(),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (
    projectId: string,
    worktreePath: string,
  ): Promise<CodeGraphRepositoryInput[]> =>
    mockResolveRepositories(projectId, worktreePath),
}));

import { CodeGraphReadFailureError } from '../code-graph/read-runner';
import { runWorktreeCodeGraphBuild } from '../lib/code-graph-build-service';
import {
  resetCodeGraphBuildDiagnosticsForTests,
  setCodeGraphBuildDiagnosticRecorderForTests,
} from '../lib/code-graph-build-diagnostics';

const buildOptions: CodeGraphBuildOptions = {};

function successfulBuildResult(): CodeGraphBuildResult {
  return {
    filesScanned: 4,
    filesParsed: 3,
    filesUnchanged: 1,
    filesSkipped: 0,
    filesRemoved: 0,
    parseFailures: 0,
    symbolCount: 9,
    edgeCount: 5,
    durationMs: 25,
    derived: [],
    customLanguages: null,
    factsChanged: true,
    timings: {
      queueWaitMs: 7,
      seedCopyMs: 0,
      prepareMs: 1,
      scanMs: 2,
      hashMs: 3,
      parseMs: 4,
      diagnosticsMs: 1,
      commitMs: 1,
      rowsWritten: 10,
    },
  };
}

describe('worktree Code Graph build saturation handling', () => {
  let diagnostics: SessionDiagnosticRecord[];

  beforeEach(() => {
    jest.clearAllMocks();
    diagnostics = [];
    resetCodeGraphBuildDiagnosticsForTests();
    setCodeGraphBuildDiagnosticRecorderForTests((record) =>
      diagnostics.push(record),
    );
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsReadDir.mockResolvedValue([]);
    mockFsRemove.mockResolvedValue(undefined);
    mockCustomLanguages.mockResolvedValue({
      value: 'custom-language-fingerprint',
    });
    mockCodeGraphReadFailure.mockImplementation((error) =>
      error instanceof mockCodeGraphReadFailureErrorClass
        ? error.readFailure
        : 'database-error',
    );
    mockIsAvailable.mockReturnValue(true);
    mockReadWorkspaceConfig.mockResolvedValue({
      type: 'single-repo',
      repoPath: '/private/source-repo',
    });
    mockReadWorkspaceIndexEntry.mockResolvedValue(null);
    mockReadCompletion.mockResolvedValue(true);
    mockResolveRepositories.mockResolvedValue([
      { repoId: 'repo-safe', rootPath: '/private/worktree' },
    ]);
    mockResolveWorktree.mockReturnValue('/private/worktree');
    mockFingerprint.mockResolvedValue({
      ok: true,
      fingerprint: 'same-worktree-fingerprint',
    });
    mockCopyBase.mockResolvedValue(null);
    mockBeginBuild.mockImplementation(() => ({
      attemptId: 'stable-coalesced-build-record',
      promise: Promise.resolve<CodeGraphWorkerBuildResponse>({
        ok: false,
        message: 'test default response',
      }),
    }));
  });

  afterEach(() => {
    resetCodeGraphBuildDiagnosticsForTests();
  });

  it('rereads the root-amended nullable handle after settlement, emitting only the selected record id', async () => {
    let selectedId: string | null = null;
    let complete: (response: CodeGraphWorkerBuildResponse) => void = () => {
      throw new Error('Missing completion.');
    };
    const promise = new Promise<CodeGraphWorkerBuildResponse>((resolve) => {
      complete = resolve;
    });
    mockBeginBuild.mockReturnValue({
      get attemptId(): string | null {
        return selectedId;
      },
      promise,
    });
    const result = runWorktreeCodeGraphBuild({
      projectId: 'project-safe',
      worktreeId: 'worktree-safe',
      reason: 'refresh',
      observedFingerprint: 'same-worktree-fingerprint',
    });
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    expect(mockBeginBuild).toHaveBeenCalledTimes(1);
    selectedId = 'actual-build-record';
    complete({ ok: true, result: successfulBuildResult() });
    await result;
    expect(diagnostics[0]?.codeGraphBuild?.attemptId).toBe(
      'actual-build-record',
    );
  });

  it('omits attempt identity when a pending handle rejects before any real record is admitted', async () => {
    mockBeginBuild.mockImplementation(() => ({
      attemptId: null,
      promise: Promise.reject(new Error('Canceled before admission.')),
    }));
    await expect(
      runWorktreeCodeGraphBuild({
        projectId: 'project-safe',
        worktreeId: 'worktree-safe',
        reason: 'refresh',
        observedFingerprint: 'same-worktree-fingerprint',
      }),
    ).rejects.toThrow('Canceled before admission.');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.codeGraphBuild).not.toHaveProperty('attemptId');
  });

  it('propagates busy completion metadata before the seed fallback can run', async () => {
    const busy = new CodeGraphReadFailureError('busy');
    mockReadCompletion.mockRejectedValue(busy);

    await expect(
      runWorktreeCodeGraphBuild({
        projectId: 'project-safe',
        worktreeId: 'worktree-safe',
        reason: 'refresh',
        options: buildOptions,
        observedFingerprint: 'scheduler-observed-fingerprint',
      }),
    ).rejects.toBe(busy);

    expect(mockCopyBase).not.toHaveBeenCalled();
    expect(mockBeginBuild).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.codeGraphBuild).toMatchObject({
      outcome: 'deferred',
      failureStage: 'preflight',
      failureReason: 'busy',
    });
    expect(diagnostics[0]?.codeGraphBuild).not.toHaveProperty('attemptId');
  });

  it('keeps publication successful when the host could not store the fingerprint and records the shared build id', async () => {
    const sharedResponse: CodeGraphWorkerBuildResponse = {
      ok: true,
      result: successfulBuildResult(),
      fingerprint: { outcome: 'error', endFingerprintMs: 2 },
    };
    const sharedHandle: BuildHandle = {
      attemptId: 'stable-coalesced-build-record',
      promise: Promise.resolve(sharedResponse),
    };
    mockBeginBuild.mockReturnValue(sharedHandle);

    const input: Parameters<typeof runWorktreeCodeGraphBuild>[0] = {
      projectId: 'project-safe',
      worktreeId: 'worktree-safe',
      reason: 'refresh',
      observedFingerprint: 'same-worktree-fingerprint',
    };
    const responses = await Promise.all([
      runWorktreeCodeGraphBuild(input),
      runWorktreeCodeGraphBuild(input),
    ]);

    expect(responses.every((response) => response.ok)).toBe(true);
    expect(mockBeginBuild).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveLength(2);
    expect(
      diagnostics.map((record) => record.codeGraphBuild?.attemptId),
    ).toEqual([
      'stable-coalesced-build-record',
      'stable-coalesced-build-record',
    ]);
    for (const record of diagnostics) {
      expect(record.codeGraphBuild).toMatchObject({
        outcome: 'success',
        queueWaitMs: 7,
        endFingerprintMs: 2,
        fingerprintPersistOutcome: 'error',
      });
    }
  });
});
