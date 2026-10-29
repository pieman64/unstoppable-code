/** PRIVATE CANDIDATE: no tests executed. Dedicated reader is the only summary path. */
import * as base from '@canopy/desktop-shared/node/code-graph/base-graph';
import type {
  ReadCodeGraphSummaryProjectionResult,
  CodeGraphSummaryProjectionV1,
} from '@canopy/desktop-shared/node/code-graph/summary-projection';
import {
  executeCodeGraphRead,
  CodeGraphReadConnectionCache,
} from '../code-graph/read-worker';
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
  lastBuildAt: null,
  completedBuildAt: null,
  derivedAt: null,
  assembly: 'imported',
  customLanguagesFingerprint: null,
  repositories: [],
  totals: counts,
  topCommunities: [],
  customLanguages: null,
};
const observed = {
  schemaVersion: null,
  extractorVersion: null,
  projectionRevision: null,
  lastBuildAt: null,
  completedBuildAt: null,
  derivedAt: null,
};
const outcomes: ReadCodeGraphSummaryProjectionResult[] = [
  { state: 'missing' },
  {
    state: 'pending',
    reason: 'projection-missing',
    observed,
    diagnostics: null,
  },
  { state: 'ready', projection, diagnostics: null },
  { state: 'error', classification: 'busy' },
];
describe('dedicated readonly summary/status route', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(outcomes)(
    'preserves union %j without structural/count fallback',
    async (value) => {
      const reader = jest
        .spyOn(base, 'readCodeGraphSummaryProjection')
        .mockReturnValue(value);
      const legacy = jest
        .spyOn(base, 'readReadonlyCodeGraphSummary')
        .mockImplementation(() => {
          throw new Error('Forbidden legacy count reader');
        });
      const connections = new CodeGraphReadConnectionCache();
      const lease = jest.spyOn(connections, 'lease').mockImplementation(() => {
        throw new Error('Forbidden structural opener');
      });
      expect(
        await executeCodeGraphRead(
          { dbPath: '/private/graph.db', task: { kind: 'readonly-summary' } },
          connections,
        ),
      ).toEqual({ ok: true, result: { kind: 'readonly-summary', value } });
      expect(
        await executeCodeGraphRead(
          {
            dbPath: '/private/graph.db',
            task: { kind: 'calls', calls: [{ method: 'status' }] },
          },
          connections,
        ),
      ).toEqual({ ok: true, result: { kind: 'calls', value: [value] } });
      expect(reader).toHaveBeenCalledTimes(2);
      expect(legacy).not.toHaveBeenCalled();
      expect(lease).not.toHaveBeenCalled();
      connections.close();
    },
  );
});
