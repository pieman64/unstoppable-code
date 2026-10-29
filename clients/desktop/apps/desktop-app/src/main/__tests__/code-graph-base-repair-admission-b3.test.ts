/** PRIVATE UNRUN candidates for the exact immutable-generation pre-staging decision. */
import type { ReadCodeGraphSummaryProjectionResult } from '@canopy/desktop-shared/node/code-graph/summary-projection';
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: jest.fn(),
}));
jest.mock('../code-graph/build-runner', () => ({
  beginCodeGraphWorkerBuild: jest.fn(),
  cancelBuild: jest.fn(),
  updateCodeGraphBuildOwners: jest.fn(),
  CodeGraphWorkerBuildError: class extends Error {},
}));
import { runCodeGraphWorkerRead } from '../code-graph/read-runner';
import { beginCodeGraphWorkerBuild } from '../code-graph/build-runner';
import { codeGraphBaseManagerTestExports } from '../lib/code-graph-base-manager';
const mockRead = jest.mocked(runCodeGraphWorkerRead);
const ready: ReadCodeGraphSummaryProjectionResult = {
  state: 'ready',
  diagnostics: null,
  projection: {
    formatVersion: 1,
    schemaVersion: 1,
    extractorVersion: 1,
    projectionRevision: 1,
    lastBuildAt: 10,
    completedBuildAt: 10,
    derivedAt: null,
    assembly: 'complete',
    customLanguagesFingerprint: null,
    repositories: [],
    totals: {
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      contextUnresolvedEdgeCount: 0,
      contextFilesWithErrors: 0,
      legacyUnresolvedEdgeCount: 0,
      legacyFilesWithErrors: 0,
      communityCount: 0,
      flowCount: 0,
    },
    topCommunities: [],
    customLanguages: null,
  },
};
const pending: ReadCodeGraphSummaryProjectionResult = {
  state: 'pending',
  reason: 'projection-missing',
  diagnostics: null,
  observed: {
    schemaVersion: 1,
    extractorVersion: 1,
    projectionRevision: null,
    lastBuildAt: 10,
    completedBuildAt: 10,
    derivedAt: null,
  },
};
const publishedDbPath = '/bases/variant/generations/immutable/graph.db';
describe('immutable base readonly admission before staging', () => {
  beforeEach(() => {
    mockRead.mockReset();
    jest.mocked(beginCodeGraphWorkerBuild).mockClear();
  });
  it.each<{
    value: ReadCodeGraphSummaryProjectionResult;
    expected: 'ready' | 'pending' | 'unavailable';
  }>([
    { value: ready, expected: 'ready' },
    { value: pending, expected: 'pending' },
    { value: { state: 'missing' }, expected: 'unavailable' },
    {
      value: { state: 'error', classification: 'busy' },
      expected: 'unavailable',
    },
    {
      value: { state: 'error', classification: 'corrupt' },
      expected: 'unavailable',
    },
    {
      value: { state: 'error', classification: 'permission-denied' },
      expected: 'unavailable',
    },
  ])(
    'returns $expected for $value.state without a writer/fact-count fallback',
    async ({ value, expected }) => {
      mockRead.mockResolvedValue({
        ok: true,
        result: { kind: 'readonly-summary', value },
      });
      await expect(
        codeGraphBaseManagerTestExports.publishedSummaryRepairState(
          'base-hashed-key',
          publishedDbPath,
          'real-owner',
        ),
      ).resolves.toBe(expected);
      expect(mockRead).toHaveBeenCalledWith({
        key: 'base-hashed-key',
        kind: 'base-validation',
        diagnosticOwner: { projectId: 'real-owner', worktreeId: '' },
        request: {
          dbPath: publishedDbPath,
          task: { kind: 'readonly-summary' },
        },
      });
      expect(beginCodeGraphWorkerBuild).not.toHaveBeenCalled();
    },
  );
  it('omits an unavailable diagnostic owner instead of attributing the hashed base/path as a workspace', async () => {
    mockRead.mockResolvedValue({
      ok: true,
      result: { kind: 'readonly-summary', value: ready },
    });
    await codeGraphBaseManagerTestExports.publishedSummaryRepairState(
      'base-hash',
      publishedDbPath,
    );
    expect(mockRead).toHaveBeenCalledWith({
      key: 'base-hash',
      kind: 'base-validation',
      request: { dbPath: publishedDbPath, task: { kind: 'readonly-summary' } },
    });
  });
  it('real read rejection and wrong result kind prevent staging admission', async () => {
    mockRead.mockRejectedValueOnce(new Error('SQL /private/graph.db'));
    await expect(
      codeGraphBaseManagerTestExports.publishedSummaryRepairState(
        'base',
        publishedDbPath,
      ),
    ).resolves.toBe('unavailable');
    mockRead.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'validate-base', value: true },
    });
    await expect(
      codeGraphBaseManagerTestExports.publishedSummaryRepairState(
        'base',
        publishedDbPath,
      ),
    ).resolves.toBe('unavailable');
    expect(beginCodeGraphWorkerBuild).not.toHaveBeenCalled();
  });
});
