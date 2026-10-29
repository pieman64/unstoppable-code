/** PRIVATE CANDIDATE: no result asserted as executed. Independent of starting a source build. */
import * as fs from 'node:fs';
import type * as NodeFs from 'node:fs';
import type * as ReadRunner from '../code-graph/read-runner';
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  return { ...actual, existsSync: jest.fn() };
});
import type {
  CodeGraphBuildState,
  CodeGraphReadFailure,
} from '@canopy/desktop-shared/types/code-graph-tools';
import type { CodeGraphWorkerReadResponse } from '../code-graph/read-runner';
const mockRead = jest.fn<Promise<CodeGraphWorkerReadResponse>, [unknown]>();
const mockState = jest.fn<CodeGraphBuildState, [string]>(() => 'idle');
const mockRepair = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({ state: 'ready' }),
);
jest.mock('../code-graph/build-runner', () => ({
  getCodeGraphSourceBuildState: (key: string): CodeGraphBuildState =>
    mockState(key),
  requestCodeGraphSummaryRepair: (input: unknown): Promise<unknown> =>
    mockRepair(input),
  CodeGraphWorkerBuildError: class extends Error {},
}));
jest.mock('../lib/code-graph-build-service', () => ({
  runWorktreeCodeGraphBuild: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({ resolveWorktreeCwd: jest.fn() }));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE: 'Unavailable',
  isCodeGraphAvailableForWorkspace: (): boolean => true,
}));
jest.mock('electron', () => ({ utilityProcess: { fork: jest.fn() } }));
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphQueryTelemetry: jest.fn(),
  recordCodeGraphReadDiagnostic: jest.fn(),
  flushCodeGraphQueryTelemetry: jest.fn(),
  flushCodeGraphReadDiagnostics: jest.fn(),
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
import { CodeGraphWorkerReadError } from '../code-graph/read-runner';
import { getCodeGraphContext } from '../canopy-tools/code-graph-runtime';
const runtime = { projectId: 'workspace', worktreeId: 'worktree' };
describe('honest independent retained read errors', () => {
  beforeEach(() => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    mockRead.mockReset();
    mockState.mockReturnValue('idle');
    mockRepair.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());
  it.each<CodeGraphBuildState>(['queued', 'running', 'idle'])(
    'does not mask real rejection during %s (idle includes derived drain)',
    async (state) => {
      mockState.mockReturnValue(state);
      mockRead.mockRejectedValue(
        new CodeGraphWorkerReadError('timeout', 'SELECT /private/graph.db'),
      );
      const result = await getCodeGraphContext(runtime);
      expect(result).toMatchObject({
        status: 'error',
        snapshotState: 'read-error',
        buildState: state,
        readFailure: 'execution-timeout',
        hasGraph: true,
      });
      assertUnmeasured(result);
      expect(result.summary).not.toMatch(
        /SELECT|\/private|refresh is queued|no readable snapshot/,
      );
      expect(mockRepair).not.toHaveBeenCalled();
    },
  );
  it.each<CodeGraphReadFailure>([
    'queue-timeout',
    'execution-timeout',
    'busy',
    'worker-exit',
    'canceled',
    'invalid-response',
    'database-error',
  ])('preserves classified portable failure %s', async (code) => {
    mockRead.mockResolvedValue({ ok: false, code, message: 'generic failure' });
    const result = await getCodeGraphContext(runtime);
    expect(result).toMatchObject({
      status: 'error',
      snapshotState: 'read-error',
      readFailure: code,
      hasGraph: true,
    });
    assertUnmeasured(result);
  });
  it('pending metadata preserves known freshness and schedules but never waits for repair', async () => {
    mockRead.mockResolvedValue({
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
            lastBuildAt: 10,
            completedBuildAt: 10,
            derivedAt: null,
          },
          diagnostics: null,
        },
      },
    });
    mockRepair.mockReturnValue(new Promise(() => undefined));
    const result = await getCodeGraphContext(runtime);
    expect(result).toMatchObject({
      status: 'ok',
      snapshotState: 'summary-pending',
      buildState: 'idle',
      lastBuildAt: 10,
      hasGraph: true,
    });
    assertUnmeasured(result);
    expect(mockRepair).toHaveBeenCalledTimes(1);
    const expectedRequest: unknown = expect.objectContaining({
      task: { kind: 'readonly-summary' },
    });
    expect(mockRead).toHaveBeenCalledWith(
      expect.objectContaining({ request: expectedRequest }),
    );
  });
  describe('a graph with no committed build', () => {
    const incomplete: CodeGraphWorkerReadResponse = {
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
    };

    it('asks for a build, not a retry, and requests no repair when nothing is building', async () => {
      mockRead.mockResolvedValue(incomplete);
      const result = await getCodeGraphContext(runtime);
      expect(result).toMatchObject({
        status: 'ok',
        snapshotState: 'summary-pending',
        buildState: 'idle',
        hasGraph: true,
        suggestedNextTools: ['BuildOrUpdateCodeGraph'],
      });
      expect(result.summary).toContain('BuildOrUpdateCodeGraph');
      expect(result.summary).not.toContain('Try again');
      assertUnmeasured(result);
      expect(mockRepair).not.toHaveBeenCalled();
    });

    it.each<CodeGraphBuildState>(['queued', 'running'])(
      'stays a retryable pending read while its first build is %s',
      async (state) => {
        mockState.mockReturnValue(state);
        mockRead.mockResolvedValue(incomplete);
        const result = await getCodeGraphContext(runtime);
        expect(result).toMatchObject({
          status: 'ok',
          snapshotState: 'summary-pending',
          buildState: state,
          suggestedNextTools: ['GetCodeGraphContext', 'BuildOrUpdateCodeGraph'],
        });
        expect(result.summary).toContain('Try again');
        assertUnmeasured(result);
        expect(mockRepair).not.toHaveBeenCalled();
      },
    );
  });
  it('missing DB plus queued source is missing, not measured readable zero', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(false);
    mockState.mockReturnValue('queued');
    const result = await getCodeGraphContext(runtime);
    expect(result).toMatchObject({
      status: 'unavailable',
      snapshotState: 'missing',
      buildState: 'queued',
      hasGraph: false,
    });
    assertUnmeasured(result);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

function assertUnmeasured(result: unknown): void {
  const expectedSummary: unknown = expect.stringContaining(
    'Counts are unmeasured.',
  );
  expect(result).toMatchObject({
    summary: expectedSummary,
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    unresolvedEdgeCount: 0,
    filesWithErrors: 0,
    repositories: [],
    communityCount: 0,
    flowCount: 0,
    derivedAt: null,
    topCommunities: [],
  });
}

describe('measured zero positive control', () => {
  afterEach(() => jest.restoreAllMocks());
  it('keeps actual zero counts from a ready projection', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    mockState.mockReturnValue('idle');
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
    mockRead.mockResolvedValue({
      ok: true,
      result: {
        kind: 'readonly-summary',
        value: {
          state: 'ready',
          diagnostics: null,
          projection: {
            formatVersion: 1,
            schemaVersion: 5,
            extractorVersion: 1,
            projectionRevision: 1,
            lastBuildAt: 10,
            completedBuildAt: 10,
            derivedAt: null,
            assembly: 'complete',
            customLanguagesFingerprint: null,
            repositories: [],
            totals: counts,
            topCommunities: [],
            customLanguages: null,
          },
        },
      },
    });
    expect(await getCodeGraphContext(runtime)).toMatchObject({
      status: 'ok',
      snapshotState: 'readable',
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      unresolvedEdgeCount: 0,
      filesWithErrors: 0,
      communityCount: 0,
      flowCount: 0,
      repositories: [],
      topCommunities: [],
    });
  });
});
