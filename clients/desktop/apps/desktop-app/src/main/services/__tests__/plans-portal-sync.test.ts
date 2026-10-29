import type {
  PortalEventEnvelope,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createPlan,
  deletePlan,
  syncTrackedPlansToPortal,
  updatePlan,
} from '../plans-service';
import { setCanopyPortalEventSink } from '../../portal/portal-event-bus';
import {
  createTrackedPlan,
  deleteTrackedPlan,
  getTrackedPlan,
  updateTrackedPlan,
} from '../../lib/plan-persistence';
import { sendToWindow } from '../../lib/window-send';

jest.mock('../../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  deleteTrackedPlan: jest.fn(),
  getTrackedPlan: jest.fn(),
  listTrackedPlans: jest.fn(),
  saveTrackedPlanComments: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));
jest.mock('../../lib/plan-explore-cleanup', () => ({
  removePlanExploreChat: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockedCreateTrackedPlan = jest.mocked(createTrackedPlan);
const mockedUpdateTrackedPlan = jest.mocked(updateTrackedPlan);
const mockedGetTrackedPlan = jest.mocked(getTrackedPlan);
const mockedDeleteTrackedPlan = jest.mocked(deleteTrackedPlan);
const mockedSendToWindow = jest.mocked(sendToWindow);

/**
 * Portal publication for tracked plans written outside the IPC service layer
 * (CAN-3019).
 *
 * `plans-service` emits `portal.plan.event` from each of its own mutators, but
 * the agent's plan-mode path does not go through them: `ExitPlanMode` calls
 * `upsertTrackedPlan` in `agents/claude-session.ts`, which writes through
 * `lib/plan-persistence` directly. A plan created from Remote Control therefore
 * never reached the portal store, and the web Plans card stayed absent while
 * desktop showed the plan. These cover the write-hook publisher that closes
 * that gap for every writer at once.
 */

function plan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'canopy',
    worktreeId: 'dev-cockatoo',
    source: 'claude',
    title: 'Update the UD homepage hero headline',
    content: '# Update the UD homepage hero headline\n\nDo the thing.',
    reviewStatus: 'pending',
    createdAt: '2026-09-13T12:14:02.000Z',
    updatedAt: '2026-09-13T12:14:02.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

describe('syncTrackedPlansToPortal', () => {
  let events: PortalEventEnvelope[];

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    setCanopyPortalEventSink((event) => events.push(event));
    // Each test owns a distinct worktree so the module-level published-state
    // map cannot leak a fingerprint between cases.
  });

  afterEach(() => {
    setCanopyPortalEventSink(null);
  });

  it('publishes an agent-written plan the IPC service layer never saw', () => {
    syncTrackedPlansToPortal('canopy', 'wt-publish', [
      plan({ worktreeId: 'wt-publish' }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.plan.event',
      payload: {
        kind: 'upsert',
        entity: {
          entityType: 'plan',
          localId: 'plan-1',
          parentLocalId: 'canopy:wt-publish',
          payload: {
            planId: 'plan-1',
            title: 'Update the UD homepage hero headline',
            status: 'pending',
            // `content` is what lights up the rail's Implement / Pipeline /
            // Copy actions; a summary-only payload leaves them inert.
            content: '# Update the UD homepage hero headline\n\nDo the thing.',
          },
        },
      },
    });
  });

  it('does not re-publish an unchanged plan', () => {
    const plans = [plan({ worktreeId: 'wt-unchanged' })];
    syncTrackedPlansToPortal('canopy', 'wt-unchanged', plans);
    events = [];

    // The tracked-plans file is rewritten by unrelated writers (comment saves,
    // share-state changes, diagram artifacts). Those must not re-push bodies.
    syncTrackedPlansToPortal('canopy', 'wt-unchanged', plans);

    expect(events).toEqual([]);
  });

  it('publishes a revised plan again', () => {
    syncTrackedPlansToPortal('canopy', 'wt-revised', [
      plan({ worktreeId: 'wt-revised' }),
    ]);
    events = [];

    syncTrackedPlansToPortal('canopy', 'wt-revised', [
      plan({
        worktreeId: 'wt-revised',
        content: '# Revised\n\nDo it differently.',
        latestRevisionNumber: 2,
        updatedAt: '2026-09-13T12:20:00.000Z',
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: {
        kind: 'upsert',
        entity: { payload: { revisionNumber: 2 } },
      },
    });
  });

  it('removes a plan that disappeared from the file', () => {
    syncTrackedPlansToPortal('canopy', 'wt-removed', [
      plan({ worktreeId: 'wt-removed' }),
      plan({ id: 'plan-2', worktreeId: 'wt-removed' }),
    ]);
    events = [];

    syncTrackedPlansToPortal('canopy', 'wt-removed', [
      plan({ worktreeId: 'wt-removed' }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.plan.event',
      payload: {
        kind: 'remove',
        entityType: 'plan',
        localId: 'plan-2',
        parentLocalId: 'canopy:wt-removed',
      },
    });
  });

  it('keeps two worktrees independent', () => {
    syncTrackedPlansToPortal('canopy', 'wt-a', [plan({ worktreeId: 'wt-a' })]);
    events = [];

    // Publishing worktree B must not read as "plan-1 disappeared from A" — the
    // published set is keyed per worktree, not globally.
    syncTrackedPlansToPortal('canopy', 'wt-b', [plan({ worktreeId: 'wt-b' })]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: { kind: 'upsert', entity: { parentLocalId: 'canopy:wt-b' } },
    });
  });
});

describe('plan renderer synchronization', () => {
  const getWindow = jest.fn(() => null);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('broadcasts portal-created and portal-updated plans', async () => {
    const created = plan();
    const updated = plan({ title: 'Updated plan' });
    mockedCreateTrackedPlan.mockResolvedValue(created);
    mockedUpdateTrackedPlan.mockResolvedValue(updated);

    await createPlan(
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        title: created.title,
        content: created.content,
        source: created.source,
      },
      { getWindow },
    );
    await updatePlan(
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        planId: 'plan-1',
        title: updated.title,
      },
      { getWindow },
    );

    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      1,
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        plan: created,
        change: 'upsert',
      },
    );
    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      2,
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        plan: updated,
        change: 'upsert',
      },
    );
  });

  it('broadcasts a tombstone for a portal-deleted plan', async () => {
    const removed = plan();
    mockedGetTrackedPlan.mockResolvedValue(removed);
    mockedDeleteTrackedPlan.mockResolvedValue(undefined);

    await deletePlan(
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        planId: 'plan-1',
      },
      { getWindow },
    );

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        planId: 'plan-1',
        plan: removed,
        change: 'remove',
      },
    );
  });

  it('broadcasts a plan-id tombstone when the deleted plan is unreadable', async () => {
    mockedGetTrackedPlan.mockResolvedValue(null);
    mockedDeleteTrackedPlan.mockResolvedValue(undefined);

    await deletePlan(
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        planId: 'plan-1',
      },
      { getWindow },
    );

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      {
        projectId: 'canopy',
        worktreeId: 'dev-cockatoo',
        planId: 'plan-1',
        change: 'remove',
      },
    );
  });
});
