import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { applyRuntimeStatusesToTabs } from '@/stores/chat/canonical-changes';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import type { ChatTab } from '@/stores/chat/types';
import {
  PLAN_REVISING_EXECUTE_TITLE,
  planExecuteAvailability,
  selectPlanRevisionInProgress,
} from '../usePlanImplementationState';

const plan = { id: 'plan-1', projectId: 'p1', worktreeId: 'w1' };

function tab(overrides: Partial<ChatTab>): ChatTab {
  return {
    ...createEmptyTab(),
    id: 'chat-1',
    createdAt: '2026-10-30T00:00:00.000Z',
    trackedPlanId: plan.id,
    trackedPlanReviewStatus: 'pending',
    latestRevisionNumber: 1,
    ...overrides,
  };
}

function revising(...tabs: ChatTab[]): boolean {
  return selectPlanRevisionInProgress(
    { worktreeChats: { 'p1/w1': { tabs, activeTabId: 'chat-1' } } },
    plan,
  );
}

describe('selectPlanRevisionInProgress (CAN-5431)', () => {
  it('holds while a retired review has an accepted or optimistic turn', () => {
    // Starting, streaming and tool-approval pauses all project as streaming.
    expect(revising(tab({ status: 'streaming' }))).toBe(true);
    // An optimistic send awaiting main's acknowledgement.
    expect(
      revising(
        tab({
          status: 'idle',
          sendingLease: {
            userMessageId: 'u1',
            kind: 'send',
            issuedAt: 0,
            deadline: Number.MAX_SAFE_INTEGER,
            state: 'pending',
          },
        }),
      ),
    ).toBe(true);
  });

  it.each(['starting', 'streaming', 'awaiting_input'] as const)(
    'disables execution for canonical %s even without emitted tokens',
    (status) => {
      const tabs = applyRuntimeStatusesToTabs([tab({ status: 'idle' })], {
        'chat-1': { status, queuedMessageIds: [], lastActivityAt: 1 },
      });
      expect(revising(...tabs)).toBe(true);
    },
  );

  it('ends when a fresh plan request arrives, even mid-turn', () => {
    expect(
      revising(tab({ status: 'streaming', pendingPlanExit: { plan: '# v2' } })),
    ).toBe(false);
  });

  it('ends when the turn is idle, so the Plan panel can recover', () => {
    expect(revising(tab({ status: 'idle' }))).toBe(false);
    expect(revising(tab({ status: 'error' }))).toBe(false);
  });

  it('ignores reviews that are no longer pending', () => {
    expect(
      revising(
        tab({ status: 'streaming', trackedPlanReviewStatus: 'approved' }),
      ),
    ).toBe(false);
  });

  it("ignores another chat's activity", () => {
    expect(
      revising(
        tab({ status: 'idle' }),
        tab({
          id: 'chat-other',
          status: 'streaming',
          trackedPlanId: 'plan-other',
        }),
      ),
    ).toBe(false);
  });
});

describe('planExecuteAvailability', () => {
  const claudePlan: Pick<TrackedPlanData, 'source'> = { source: 'claude' };
  const idle = {
    revising: false,
    dispatchInFlight: false,
    status: { kind: 'pending' as const },
  };

  it('keeps an existing restriction without the revising title', () => {
    expect(
      planExecuteAvailability(
        { source: 'cursor' },
        { ...idle, revising: true },
      ),
    ).toEqual({ executeDisabled: true });
  });

  it('disables Execute with the revising title while revising', () => {
    expect(
      planExecuteAvailability(claudePlan, { ...idle, revising: true }),
    ).toEqual({
      executeDisabled: true,
      executeTitle: PLAN_REVISING_EXECUTE_TITLE,
    });
    expect(planExecuteAvailability(claudePlan, idle)).toEqual({
      executeDisabled: false,
    });
  });

  it('disables Execute while a dispatch is in flight or implementing', () => {
    expect(
      planExecuteAvailability(claudePlan, { ...idle, dispatchInFlight: true }),
    ).toEqual({ executeDisabled: true });
    expect(
      planExecuteAvailability(claudePlan, {
        ...idle,
        status: { kind: 'implementing' },
      }),
    ).toEqual({ executeDisabled: true });
  });
});
