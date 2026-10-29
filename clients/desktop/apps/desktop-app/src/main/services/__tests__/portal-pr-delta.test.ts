jest.mock('../../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

import { enqueuePortalEvent } from '../../portal/portal-event-bus';
import {
  getCachedPortalPrState,
  emitPrStatusDelta,
  forgetPortalPrState,
  rememberPortalPrState,
} from '../portal-pr-delta';

describe('portal pr_status delta emitter', () => {
  afterEach(() => {
    forgetPortalPrState('ws', 'wt');
    jest.clearAllMocks();
  });

  it('caches only complete recent projections and retains live progress', () => {
    jest.useFakeTimers();
    emitPrStatusDelta('ws', 'wt', { mergeProgress: null });
    expect(getCachedPortalPrState('ws', 'wt')).toBeUndefined();
    rememberPortalPrState({
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      number: 42,
    });
    emitPrStatusDelta('ws', 'wt', { title: 'Updated' });
    expect(getCachedPortalPrState('ws', 'wt')).toMatchObject({
      number: 42,
      title: 'Updated',
    });
    jest.advanceTimersByTime(30_000);
    expect(getCachedPortalPrState('ws', 'wt')).toBeUndefined();
    jest.useRealTimers();
  });

  it('merges overrides onto the remembered payload without clobbering it', () => {
    rememberPortalPrState({
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      number: 42,
      title: 'Existing PR',
    });

    emitPrStatusDelta('ws', 'wt', {
      creationProgress: { steps: [], currentPhase: 'gathering_changes' },
    });

    expect(enqueuePortalEvent).toHaveBeenCalledTimes(1);
    const call = jest.mocked(enqueuePortalEvent).mock.calls[0][0];
    expect(call).toMatchObject({
      payload: {
        scope: 'pr',
        entities: [
          {
            entityType: 'pr_status',
            localId: 'wt',
            payload: {
              number: 42,
              title: 'Existing PR',
              creationProgress: {
                steps: [],
                currentPhase: 'gathering_changes',
              },
            },
          },
        ],
      },
    });
  });

  it('falls back to a minimal payload when nothing was remembered', () => {
    emitPrStatusDelta('ws', 'wt', { mergeProgress: null });
    const call = jest.mocked(enqueuePortalEvent).mock.calls[0][0];
    expect(call).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
              number: null,
              mergeProgress: null,
            },
          },
        ],
      },
    });
  });

  it('retains a tombstone when a later delta is merged', () => {
    rememberPortalPrState({
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      number: 42,
      creationProgress: { steps: [], currentPhase: 'gathering_changes' },
    });

    emitPrStatusDelta('ws', 'wt', { creationProgress: null });
    jest.clearAllMocks();
    emitPrStatusDelta('ws', 'wt', {
      mergeProgress: { steps: [], currentPhase: 'checking_mergeability' },
    });

    const call = jest.mocked(enqueuePortalEvent).mock.calls[0][0];
    expect(call).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              creationProgress: null,
              mergeProgress: {
                steps: [],
                currentPhase: 'checking_mergeability',
              },
            },
          },
        ],
      },
    });
  });
});
