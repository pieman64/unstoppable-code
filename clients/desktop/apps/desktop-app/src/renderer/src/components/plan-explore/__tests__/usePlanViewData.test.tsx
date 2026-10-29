/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TrackedPlanData,
  TrackedPlanShareState,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import {
  usePlanViewData,
  useSharedPlanCommentPull,
  type PlanViewData,
} from '../usePlanViewData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const SCOPE = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };

let getMock: jest.Mock;
let refreshCommentsMock: jest.Mock;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: PlanViewData = { status: 'loading' };

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Plan',
    content: '# Plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function teamShare(): TrackedPlanShareState {
  return {
    serverId: 'canopy-cloud',
    remoteId: 'remote-1',
    shareScope: 'team',
    teamId: 'team-1',
    syncStatus: 'synced',
  };
}

function DataProbe({ planId }: { planId: string }): JSX.Element | null {
  latest = usePlanViewData(SCOPE, planId);
  return null;
}

function PullProbe({
  plan,
}: {
  plan: TrackedPlanData | null;
}): JSX.Element | null {
  useSharedPlanCommentPull(plan);
  return null;
}

/** Retry the failed load the probe last reported. */
function retryLatest(): void {
  const current = latest;
  if (current.status !== 'error') {
    throw new Error(`Expected a load error, got ${current.status}`);
  }
  act(() => {
    current.retry();
  });
}

function renderNode(node: JSX.Element | null): void {
  act(() => {
    root?.render(node);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = { status: 'loading' };
  getMock = jest.fn();
  refreshCommentsMock = jest.fn().mockResolvedValue(null);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      activity: {
        plans: { get: getMock, refreshComments: refreshCommentsMock },
      },
    },
  });
  useActivityStore.setState({
    trackedPlans: {},
    trackedPlanInventoryLoaded: {},
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe('usePlanViewData', () => {
  it('is ready from the store without fetching', () => {
    const plan = makePlan();
    useActivityStore.setState({ trackedPlans: { [KEY]: [plan] } });

    renderNode(createElement(DataProbe, { planId: 'plan-1' }));

    expect(latest).toEqual({ status: 'ready', plan });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('loads a plan missing from a partial list', async () => {
    let resolveGet: (plan: TrackedPlanData | null) => void = () => {};
    getMock.mockImplementation(
      (): Promise<TrackedPlanData | null> =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ id: 'plan-0' })] },
    });

    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    expect(latest.status).toBe('loading');

    const fetched = makePlan();
    resolveGet(fetched);
    await flush();

    expect(latest).toEqual({ status: 'ready', plan: fetched });
  });

  it('is missing when the loaded inventory does not contain the plan', () => {
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ id: 'plan-0' })] },
      trackedPlanInventoryLoaded: { [KEY]: true },
    });

    renderNode(createElement(DataProbe, { planId: 'plan-1' }));

    expect(latest).toEqual({ status: 'missing' });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('is missing when a direct fetch reports the plan gone', async () => {
    getMock.mockResolvedValue(null);

    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    await flush();

    expect(latest).toEqual({ status: 'missing' });
  });

  it('reports a failed fetch as a load error, not a missing plan', async () => {
    getMock.mockRejectedValue(new Error('IPC unavailable'));

    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    await flush();

    expect(latest.status).toBe('error');
  });

  it('retries a failed fetch and becomes ready', async () => {
    const plan = makePlan();
    getMock
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce(plan);
    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    await flush();
    expect(latest.status).toBe('error');

    retryLatest();
    expect(latest.status).toBe('loading');
    await flush();

    expect(latest).toEqual({ status: 'ready', plan });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('settles a load error once the full inventory loads', async () => {
    getMock.mockRejectedValue(new Error('IPC unavailable'));
    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    await flush();
    expect(latest.status).toBe('error');

    act(() => {
      useActivityStore.setState({
        trackedPlans: { [KEY]: [makePlan({ id: 'plan-0' })] },
        trackedPlanInventoryLoaded: { [KEY]: true },
      });
    });

    expect(latest).toEqual({ status: 'missing' });
  });

  it('returns to ready when the plan arrives later', async () => {
    getMock.mockResolvedValue(null);
    renderNode(createElement(DataProbe, { planId: 'plan-1' }));
    await flush();
    expect(latest.status).toBe('missing');

    const plan = makePlan();
    act(() => {
      useActivityStore.getState().upsertTrackedPlan(plan);
    });

    expect(latest).toEqual({ status: 'ready', plan });
  });
});

describe('useSharedPlanCommentPull', () => {
  it('pulls once for views of one shared plan that are open together', () => {
    const plan = makePlan({ share: teamShare() });

    renderNode(
      createElement(
        'div',
        null,
        createElement(PullProbe, { key: 'document', plan }),
        createElement(PullProbe, { key: 'diagram', plan }),
      ),
    );

    expect(refreshCommentsMock).toHaveBeenCalledTimes(1);
    expect(refreshCommentsMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
  });

  it('does not pull for an unshared plan, and pulls when it becomes shared', () => {
    const plan = makePlan();
    renderNode(createElement(PullProbe, { plan }));
    expect(refreshCommentsMock).not.toHaveBeenCalled();

    renderNode(
      createElement(PullProbe, { plan: { ...plan, share: teamShare() } }),
    );
    expect(refreshCommentsMock).toHaveBeenCalledTimes(1);
  });

  it('does not pull again when only the comments change', () => {
    const plan = makePlan({ share: teamShare() });
    renderNode(createElement(PullProbe, { plan }));
    renderNode(
      createElement(PullProbe, { plan: { ...plan, commentThreads: [] } }),
    );

    expect(refreshCommentsMock).toHaveBeenCalledTimes(1);
  });

  it('pulls again when the plan is reopened after every view closed', () => {
    const plan = makePlan({ share: teamShare() });
    renderNode(createElement(PullProbe, { plan }));
    renderNode(null);
    renderNode(createElement(PullProbe, { plan }));

    expect(refreshCommentsMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates a failed pull', async () => {
    refreshCommentsMock.mockRejectedValueOnce(new Error('network'));
    renderNode(
      createElement(PullProbe, { plan: makePlan({ share: teamShare() }) }),
    );
    await flush();

    expect(refreshCommentsMock).toHaveBeenCalledTimes(1);
  });
});
