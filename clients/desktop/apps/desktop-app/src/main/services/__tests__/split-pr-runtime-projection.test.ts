jest.mock('../desktop-session-snapshot-invalidation', () => ({
  scheduleDesktopSessionSnapshotInvalidation: jest.fn(),
}));

import { scheduleDesktopSessionSnapshotInvalidation } from '../desktop-session-snapshot-invalidation';
import {
  clearSplitPrRuntimeProjection,
  getSplitPrRuntimeProjection,
  projectSplitPrProgress,
  setSplitPrRuntimeProjection,
} from '../split-pr-runtime-projection';
import type {
  SplitPrPhase,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';

describe('split PR runtime projection', () => {
  afterEach(() => {
    clearSplitPrRuntimeProjection('workspace', 'worktree');
    jest.clearAllMocks();
  });

  it('projects main-owned phase, copy, and lock and invalidates snapshots', () => {
    setSplitPrRuntimeProjection(
      'workspace',
      'worktree',
      'ready',
      'Waiting for your plan approval',
    );

    expect(getSplitPrRuntimeProjection('workspace', 'worktree')).toEqual({
      splitPrStatus: 'ready',
      splitPrStatusMessage: 'Waiting for your plan approval',
    });
    expect(scheduleDesktopSessionSnapshotInvalidation).toHaveBeenCalled();
  });

  it('is gracefully absent before a split exists and after discard/exit', () => {
    expect(
      getSplitPrRuntimeProjection('workspace', 'worktree'),
    ).toBeUndefined();
    setSplitPrRuntimeProjection(
      'workspace',
      'worktree',
      'preparing',
      'Analyzing the PR diff',
    );
    clearSplitPrRuntimeProjection('workspace', 'worktree');
    expect(
      getSplitPrRuntimeProjection('workspace', 'worktree'),
    ).toBeUndefined();
  });

  it('does not invalidate the snapshot when clearing an absent projection', () => {
    jest.clearAllMocks();

    clearSplitPrRuntimeProjection('workspace', 'worktree');

    expect(scheduleDesktopSessionSnapshotInvalidation).not.toHaveBeenCalled();
  });

  it.each<{
    phase: SplitPrPhase;
    expected: ReturnType<typeof projectSplitPrProgress>;
  }>([
    {
      phase: 'done',
      expected: {
        status: 'completed',
        message: 'All child PRs created',
        locked: false,
      },
    },
    {
      phase: 'error',
      expected: {
        status: 'failed',
        message: 'Preparing the split',
        locked: false,
      },
    },
    {
      phase: 'cancelled',
      expected: {
        status: 'failed',
        message: 'Split cancelled',
        locked: false,
      },
    },
    ...(
      [
        'gathering_diff',
        'planning',
        'creating_integration_branch',
        'running_setup',
        'carving_child',
        'verifying_child',
        'opening_child_pr',
        'reconstructing_tip',
        'opening_integration_pr',
        'updating_pr_bodies',
        'retargeting_original',
        'retargeting_dependents',
        'closing_original',
      ] satisfies SplitPrPhase[]
    ).map((phase) => ({
      phase,
      expected: {
        status: 'running' as const,
        message: 'Preparing the split',
        locked: true,
      },
    })),
  ])(
    'maps $phase progress to its runtime projection',
    ({ phase, expected }) => {
      const event: SplitPrProgressEvent = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        phase,
      };

      expect(projectSplitPrProgress(event)).toEqual(expected);
    },
  );

  it('prefers explicit progress copy for failure and running phases', () => {
    expect(
      projectSplitPrProgress({
        projectId: 'workspace',
        worktreeId: 'worktree',
        phase: 'error',
        error: 'Carving failed',
        message: 'Ignored message',
      }),
    ).toMatchObject({ message: 'Carving failed' });
    expect(
      projectSplitPrProgress({
        projectId: 'workspace',
        worktreeId: 'worktree',
        phase: 'carving_child',
        message: 'Creating child 1',
      }),
    ).toMatchObject({ message: 'Creating child 1' });
  });
});
