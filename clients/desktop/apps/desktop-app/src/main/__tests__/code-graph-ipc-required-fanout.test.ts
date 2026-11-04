import type * as ReadRunner from '../code-graph/read-runner';
/** PRIVATE CANDIDATE: unrun. Public DTO deliberately remains aggregate-wide. */
import { IPC_CHANNELS, type SidebarItem } from '@canopy/desktop-shared/types';
import type { CodeGraphSummaryProjectionV1 } from '@canopy/code-graph/summary-projection';
import type { CodeGraphWorkerReadResponse } from '../code-graph/read-runner';
const handlers = new Map<
  string,
  (_event: unknown, payload: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (_event: unknown, payload: unknown) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));
const mockRead = jest.fn<Promise<CodeGraphWorkerReadResponse>, [unknown]>();
const mockDiagnostic = jest.fn<void, [unknown]>();
const mockRepair = jest.fn<
  Promise<unknown>,
  [{ workspaceId: string; repoId: string }]
>(({ repoId }) => Promise.resolve({ repoId, ok: true }));
const mockFingerprint = jest.fn<Promise<string | null>, []>();
const mockAvailable = jest.fn<boolean, []>();
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  utilityProcess: { fork: jest.fn() },
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphSummaryFanoutDiagnostic: (input: unknown): void => {
    mockDiagnostic(input);
  },
}));
jest.mock('../code-graph/build-runner', () => ({
  getCodeGraphSourceBuildState: (): string => 'idle',
  setCodeGraphGenerationQueueListener: jest.fn(),
  getCodeGraphGenerationQueueSnapshot: jest.fn(),
  reorderCodeGraphGenerationQueue: jest.fn(),
  requestCodeGraphSummaryRepair: jest.fn(),
  isCodeGraphSummaryRepairActive: (): boolean => true,
}));
jest.mock('../code-graph/read-runner', () => {
  const actual = jest.requireActual<typeof ReadRunner>(
    '../code-graph/read-runner',
  );
  return {
    ...actual,
    runCodeGraphWorkerRead: (
      input: unknown,
    ): Promise<CodeGraphWorkerReadResponse> => mockRead(input),
  };
});
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE: 'Unavailable',
  isCodeGraphAvailableForWorkspace: (): boolean => mockAvailable(),
}));
jest.mock('../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: (): boolean => true,
}));
jest.mock('../lib/code-graph-build-service', () => ({
  runWorktreeCodeGraphBuild: jest.fn(),
}));
jest.mock('../lib/code-graph-scheduler', () => ({
  isCodeGraphPerformanceSchedulerEnabled: (): boolean => false,
  runCodeGraphPerformanceBuild: jest.fn(),
}));
const workspace: SidebarItem = {
  type: 'single-repo',
  id: 'workspace',
  name: 'Project',
  color: '#000000',
  collapsed: false,
  order: 0,
  repoPath: '/private/repo',
  worktrees: [
    {
      id: 'worktree',
      branchName: 'branch',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({ version: 1, items: [workspace] }),
}));
jest.mock('../lib/code-graph-base-manager', () => ({
  describeCodeGraphBaseWorkspace: (): unknown => ({
    workspaceId: 'workspace',
    customLanguageRepoPath: null,
    repositories: [
      { repoId: 'a', repoPath: '/a' },
      { repoId: 'b', repoPath: '/b' },
    ],
  }),
  resolveCodeGraphBaseWorkspaceFingerprint: (): Promise<string | null> =>
    mockFingerprint(),
  syncCodeGraphBaseRepositories: jest.fn(),
  maintainCodeGraphBasesForWorkspace: jest.fn(),
  requestCodeGraphBaseSummaryRepair: (
    workspaceId: string,
    repoId: string,
  ): Promise<unknown> => mockRepair({ workspaceId, repoId }),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: (value: string): Promise<string> =>
    Promise.resolve(value),
}));
jest.mock('../lib/code-graph-base-store', () => ({
  codeGraphBaseRunnerKey: (root: string): string => `base:${root}`,
  readCompatibleCodeGraphBase: (input: {
    canonicalRepoRoot: string;
  }): Promise<unknown> =>
    Promise.resolve({
      dbPath: `${input.canonicalRepoRoot}/graph.db`,
      manifest: { gitHead: 'head' },
    }),
}));
jest.mock('../lib/repo-shadow', () => ({
  getRepoShadowDir: (): string => '/shadow',
}));
jest.mock('../lib/git', () => ({
  getHeadCommitSha: (): Promise<string> => Promise.resolve('head'),
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (): string => '/graph.db',
}));
import { CodeGraphWorkerReadError } from '../code-graph/read-runner';
import { registerCodeGraphHandlers } from '../ipc/code-graph';
function ready(repoId: string): CodeGraphWorkerReadResponse {
  const counts = {
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    contextUnresolvedEdgeCount: 0,
    contextFilesWithErrors: 0,
    legacyUnresolvedEdgeCount: 0,
    legacyFilesWithErrors: 0,
    communityCount: 0,
    flowCount: 0,
  };
  const projection: CodeGraphSummaryProjectionV1 = {
    formatVersion: 1,
    schemaVersion: 1,
    extractorVersion: 1,
    projectionRevision: 1,
    lastBuildAt: 10,
    completedBuildAt: 10,
    derivedAt: null,
    assembly: 'complete',
    customLanguagesFingerprint: 'none',
    repositories: [{ repoId, gitHead: 'head', counts }],
    totals: counts,
    topCommunities: [],
    customLanguages: null,
  };
  return {
    ok: true,
    result: {
      kind: 'readonly-summary',
      value: { state: 'ready', projection, diagnostics: null },
    },
  };
}
async function readSummary(): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.codeGraphGetWorkspaceSummary);
  if (handler === undefined) throw new Error('Missing handler');
  return handler({}, { workspaceId: 'workspace' });
}
import { installCodeGraphReadDispatcherForTests } from './helpers/code-graph-read-dispatcher';
import { installCodeGraphBuildDispatcherForTests } from './helpers/code-graph-build-dispatcher';

beforeAll(() => {
  installCodeGraphReadDispatcherForTests();
  installCodeGraphBuildDispatcherForTests();
});

/** The repair is dispatched without waiting; let it reach the base manager. */
async function repairsSettled(): Promise<void> {
  for (let turn = 0; turn < 50 && mockRepair.mock.calls.length === 0; turn++)
    await new Promise((resolve) => setImmediate(resolve));
}

describe('required repository read fanout', () => {
  beforeEach(() => {
    handlers.clear();
    mockRead.mockReset();
    mockDiagnostic.mockClear();
    mockRepair.mockClear();
    mockFingerprint.mockReset();
    mockFingerprint.mockResolvedValue('none');
    mockAvailable.mockReset();
    mockAvailable.mockReturnValue(true);
    registerCodeGraphHandlers({
      dispatcher: {
        query: (): Promise<never> =>
          Promise.reject(new Error('Not exercised.')),
        instruction: (): Promise<never> =>
          Promise.reject(new Error('Not exercised.')),
      },
      resolveCaller: () => {
        throw new Error('Not exercised.');
      },
    });
  });
  it('one ready plus a real rejected read returns public error, not synthetic partial totals', async () => {
    mockRead
      .mockResolvedValueOnce(ready('a'))
      .mockRejectedValueOnce(
        new CodeGraphWorkerReadError('timeout', 'SELECT /private/graph.db'),
      );
    const result = await readSummary();
    expect(result).toMatchObject({
      ok: false,
      snapshotState: 'read-error',
      readFailure: 'execution-timeout',
    });
    expect(result).not.toHaveProperty('totals');
    expect(result).not.toHaveProperty('repositories');
    expect(JSON.stringify(result)).not.toMatch(/SELECT|\/private/);
    expect(mockDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            repoId: 'a',
            state: 'ready',
            fileCount: 0,
          }),
          { repoId: 'b', state: 'error', readFailure: 'execution-timeout' },
        ],
      }),
    );
  });
  it('one ready plus pending retains pending identity and publishes no counts', async () => {
    mockRead.mockResolvedValueOnce(ready('a')).mockResolvedValueOnce({
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'pending',
          reason: 'projection-missing',
          observed: {
            schemaVersion: null,
            extractorVersion: null,
            projectionRevision: null,
            lastBuildAt: 5,
            completedBuildAt: 5,
            derivedAt: null,
          },
          diagnostics: null,
        },
      },
    });
    const result = await readSummary();
    expect(result).toMatchObject({
      ok: false,
      snapshotState: 'summary-pending',
    });
    expect(result).not.toHaveProperty('totals');
    await repairsSettled();
    expect(mockRepair).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      repoId: 'b',
    });
    expect(mockDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({ repoId: 'a', state: 'ready' }),
          { repoId: 'b', state: 'pending' },
        ],
      }),
    );
  });
  it('a project that never enabled Code Graph reports the not-enabled empty state, not a pending summary', async () => {
    // No fingerprint is prepared or persisted for a project without Code Graph.
    mockFingerprint.mockResolvedValue(null);
    mockAvailable.mockReturnValue(false);
    const result = await readSummary();
    expect(result).toMatchObject({
      scope: 'workspace-shadow',
      enabled: false,
      state: 'missing',
      snapshotState: 'missing',
      buildState: 'idle',
      repositories: [],
    });
    expect(result).not.toHaveProperty('ok');
    expect(mockRead).not.toHaveBeenCalled();
    await repairsSettled();
    expect(mockRepair).not.toHaveBeenCalled();
    expect(mockDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          { repoId: 'a', state: 'missing' },
          { repoId: 'b', state: 'missing' },
        ],
      }),
    );
  });
  it('a repository with no committed build is missing and requests no repair', async () => {
    mockRead.mockResolvedValueOnce(ready('a')).mockResolvedValueOnce({
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'pending',
          reason: 'build-incomplete',
          observed: {
            schemaVersion: 5,
            extractorVersion: null,
            projectionRevision: null,
            lastBuildAt: null,
            completedBuildAt: null,
            derivedAt: null,
          },
          diagnostics: null,
        },
      },
    });
    await readSummary();
    await repairsSettled();
    expect(mockRepair).not.toHaveBeenCalled();
    expect(mockDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({ repoId: 'a', state: 'ready' }),
          { repoId: 'b', state: 'missing' },
        ],
      }),
    );
  });
  it('a disabled project with a pending repository reports not enabled, not a pending summary', async () => {
    // The base repair is refused for a disabled project, so the pending
    // repository could never become ready.
    mockAvailable.mockReturnValue(false);
    mockRead.mockResolvedValueOnce(ready('a')).mockResolvedValueOnce({
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'pending',
          reason: 'projection-missing',
          observed: {
            schemaVersion: null,
            extractorVersion: null,
            projectionRevision: null,
            lastBuildAt: 5,
            completedBuildAt: 5,
            derivedAt: null,
          },
          diagnostics: null,
        },
      },
    });
    const result = await readSummary();
    expect(result).toMatchObject({
      scope: 'workspace-shadow',
      enabled: false,
      state: 'missing',
      snapshotState: 'missing',
      buildState: 'idle',
      lastBuildAt: 10,
      repositories: [],
      totals: { fileCount: 0, symbolCount: 0, edgeCount: 0 },
    });
    expect(result).not.toHaveProperty('ok');
  });
  it('measured zero from both ready projections remains a readable measured zero', async () => {
    mockRead
      .mockResolvedValueOnce(ready('a'))
      .mockResolvedValueOnce(ready('b'));
    expect(await readSummary()).toMatchObject({
      snapshotState: 'readable',
      state: 'ready',
      totals: { fileCount: 0, symbolCount: 0, edgeCount: 0 },
      repositories: [
        expect.objectContaining({ repoId: 'a', fileCount: 0 }),
        expect.objectContaining({ repoId: 'b', fileCount: 0 }),
      ],
    });
  });
});
