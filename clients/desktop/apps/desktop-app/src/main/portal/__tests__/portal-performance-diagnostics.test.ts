import type { SessionDiagnosticRecord } from '../../observability/service';

const mockRecordSessionDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();

jest.mock('../../observability', (): unknown => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));

import {
  elapsedSinceTimestamp,
  recordPortalOutboxUploadLatency,
  recordPortalSnapshotTiming,
  recordWorktreeStatsTiming,
} from '../portal-performance-diagnostics';

describe('portal performance diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes target-scoped timing to session diagnostics', () => {
    recordPortalSnapshotTiming({
      commandId: 'command-1',
      stage: 'snapshot_section_completed',
      section: 'worktrees',
      scope: 'overview',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      elapsedMs: 123.45,
      entityCount: 38,
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'portal_snapshot_timing',
        sessionKey: 'portal-command:command-1',
        projectId: 'workspace-1',
        worktreeId: 'snake',
        portalSnapshotStage: 'snapshot_section_completed',
        portalSnapshotSection: 'worktrees',
        portalSnapshotScope: 'overview',
        elapsedMs: 123.45,
        portalSnapshotEntityCount: 38,
      }),
    );
  });

  it('records effective queue depth and request class independently of build timing', () => {
    recordPortalSnapshotTiming({
      commandId: 'command-1',
      stage: 'snapshot_dequeued',
      scope: 'chat',
      requestClass: 'foreground',
      queueDepth: 3,
      activeCount: 2,
      elapsedMs: 12,
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSnapshotStage: 'snapshot_dequeued',
        portalSnapshotRequestClass: 'foreground',
        portalSnapshotQueueDepth: 3,
        portalSnapshotActiveCount: 2,
        elapsedMs: 12,
      }),
    );
  });

  it('computes command pickup latency from the server creation timestamp', () => {
    expect(
      elapsedSinceTimestamp(
        '2026-07-23T10:00:00.000Z',
        Date.parse('2026-07-23T10:00:12.345Z'),
      ),
    ).toBe(12_345);
    expect(elapsedSinceTimestamp('invalid', 100)).toBeUndefined();
  });

  it('writes one cleanup-compatible outbox latency record per aggregate', () => {
    recordPortalOutboxUploadLatency({
      sessionId: 'session-1',
      batchSize: 3,
      queueDepthAfterSelection: 5,
      oldestEventAgeMs: 2_500,
      controlOnly: false,
      latencyAggregates: [
        {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'tree-1',
          meanEnqueueToAckMs: 1_500,
          maxEnqueueToAckMs: 2_500,
          eventCount: 2,
          selected: true,
        },
        {
          meanEnqueueToAckMs: 500,
          maxEnqueueToAckMs: 500,
          eventCount: 1,
          selected: false,
        },
      ],
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'portal_outbox_upload_latency',
        sessionKey: 'portal-session:session-1',
        projectId: 'workspace-1',
        worktreeId: 'tree-1',
        portalOutboxBatchSize: 3,
        portalOutboxQueueDepthAfterSelection: 5,
        portalOutboxOldestEventAgeMs: 2_500,
        portalOutboxControlOnly: false,
        portalOutboxMeanEnqueueToAckMs: 1_500,
        portalOutboxMaxEnqueueToAckMs: 2_500,
        portalOutboxEventCount: 2,
        portalOutboxSelected: true,
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: '',
        worktreeId: '',
        portalOutboxEventCount: 1,
        portalOutboxSelected: false,
      }),
    );
    const firstRecord = mockRecordSessionDiagnostic.mock.calls[0]?.[0];
    const secondRecord = mockRecordSessionDiagnostic.mock.calls[1]?.[0];
    expect(firstRecord?.portalOutboxBatchTimestamp).toBeDefined();
    expect(firstRecord?.portalOutboxBatchTimestamp).toBe(
      secondRecord?.portalOutboxBatchTimestamp,
    );
  });

  it('writes slow worktree stats to worktree-scoped session diagnostics', () => {
    recordWorktreeStatsTiming({
      workspaceId: 'workspace-1',
      worktreeId: 'tree-1',
      elapsedMs: 450,
      diffStatsElapsedMs: 120,
      skipFetch: true,
      mode: 'full',
      outcome: 'success',
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'worktree_stats_timing',
        projectId: 'workspace-1',
        worktreeId: 'tree-1',
        elapsedMs: 450,
        diffStatsElapsedMs: 120,
        worktreeStatsSkipFetch: true,
        worktreeStatsMode: 'full',
        worktreeStatsOutcome: 'success',
      }),
    );
  });
});
