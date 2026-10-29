/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TrackedPlanData,
  TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import { useActivityEventSubscriptions } from '../useActivityEventSubscriptions';
import { useActivityStore } from '@/stores/activityStore';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'My Plan',
    content: '# My Plan',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function HookHarness(): null {
  useActivityEventSubscriptions();
  return null;
}

describe('useActivityEventSubscriptions tracked-plan routing (CAN-1305)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;
  let trackedPlansHandler: ((event: TrackedPlansUpdatedEvent) => void) | null;
  const unsubscribe = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    trackedPlansHandler = null;
    useActivityStore.setState({
      trackedPlans: {},
    });
    originalApi = window.api;
    const subscribe = jest.fn(() => unsubscribe);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        activity: {
          onBgProcessOutput: subscribe,
          onWorktreeSummaryUpdated: subscribe,
          onWorktreeSummaryGenerating: subscribe,
          onDetectedPlansUpdated: subscribe,
          onTrackedPlansUpdated: jest.fn(
            (handler: (event: TrackedPlansUpdatedEvent) => void) => {
              trackedPlansHandler = handler;
              return unsubscribe;
            },
          ),
        },
        codeReview: { onUpdated: subscribe },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(HookHarness));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  function emit(event: TrackedPlansUpdatedEvent): void {
    act(() => {
      trackedPlansHandler?.(event);
    });
  }

  it('upserts when the event omits `change` (legacy senders)', () => {
    const plan = makePlan();
    emit({ projectId: PROJECT_ID, worktreeId: WORKTREE_ID, plan });

    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([plan]);
  });

  it('upserts on an explicit `change: "upsert"`', () => {
    const plan = makePlan();
    emit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      plan,
      change: 'upsert',
    });

    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([plan]);
  });

  it('removes the plan on `change: "remove"` instead of re-adding it', () => {
    const plan = makePlan();
    useActivityStore.setState({
      trackedPlans: { [KEY]: [plan] },
    });

    emit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: plan.id,
      plan,
      change: 'remove',
    });

    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([]);
  });

  it('removes an unreadable plan from a plan-id-only tombstone', () => {
    const plan = makePlan();
    useActivityStore.setState({
      trackedPlans: { [KEY]: [plan] },
    });

    emit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: plan.id,
      change: 'remove',
    });

    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([]);
  });
});
