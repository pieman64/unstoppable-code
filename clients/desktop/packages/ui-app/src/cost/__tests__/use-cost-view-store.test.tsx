/** @jest-environment jsdom */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CostClient } from '@canopy/app-core';
import type {
  CostRefreshReceipt,
  CostScopeRef,
  CostScopeView,
  CostUpdatedEvent,
  CostViewResult,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import { createEmptyCostTotals } from '@canopy/protocol/cost-view';
import type {
  CostChatSummaryStore,
  CostScopeStore,
} from '@canopy/app-state/cost';
import {
  useCostChatSummaryStore,
  useCostScopeStore,
} from '../use-cost-view-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

const OTHER_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-2',
};

function scopeView(scope: CostScopeRef): CostScopeView {
  return {
    scope,
    updatedAt: '2026-10-08T12:00:00.000Z',
    building: false,
    retentionDays: 7,
    totals: createEmptyCostTotals(),
    chats: [],
    pipelineRuns: [],
    hasCodexEstimate: false,
  };
}

function ok<Value>(value: Value): CostViewResult<Value> {
  return { status: 'ok', value };
}

interface FakeClient {
  readonly client: CostClient;
  readonly getScope: jest.Mock<
    ReturnType<CostClient['getScope']>,
    Parameters<CostClient['getScope']>
  >;
  readonly getChat: jest.Mock<
    ReturnType<CostClient['getChat']>,
    Parameters<CostClient['getChat']>
  >;
  readonly getPipelineRun: jest.Mock<
    ReturnType<CostClient['getPipelineRun']>,
    Parameters<CostClient['getPipelineRun']>
  >;
  readonly refresh: jest.Mock<
    ReturnType<CostClient['refresh']>,
    Parameters<CostClient['refresh']>
  >;
  readonly watchScope: jest.Mock<
    ReturnType<CostClient['watchScope']>,
    Parameters<CostClient['watchScope']>
  >;
  readonly subscribeUpdates: jest.Mock<
    ReturnType<CostClient['subscribeUpdates']>,
    Parameters<CostClient['subscribeUpdates']>
  >;
  readonly watchReleases: readonly jest.Mock<void, []>[];
  readonly subscriptionReleases: readonly jest.Mock<void, []>[];
}

function makeClient(): FakeClient {
  const handlers = new Set<(event: CostUpdatedEvent) => void>();
  const watchReleases: Array<jest.Mock<void, []>> = [];
  const subscriptionReleases: Array<jest.Mock<void, []>> = [];
  const getScope = jest.fn<
    ReturnType<CostClient['getScope']>,
    Parameters<CostClient['getScope']>
  >((request) => Promise.resolve(ok(scopeView(request.scope))));
  const getChat = jest
    .fn<ReturnType<CostClient['getChat']>, Parameters<CostClient['getChat']>>()
    .mockResolvedValue({
      status: 'error',
      reason: 'NOT_FOUND',
      message: 'No chat view.',
    });
  const getPipelineRun = jest
    .fn<
      ReturnType<CostClient['getPipelineRun']>,
      Parameters<CostClient['getPipelineRun']>
    >()
    .mockResolvedValue(
      ok<PipelineRunCostView>({
        run: {
          executionId: 'run-1',
          pipelineName: 'Release',
          startedAt: '2026-10-08T12:00:00.000Z',
          status: 'succeeded',
          totals: createEmptyCostTotals(),
          agentStepCount: 0,
        },
        updatedAt: '2026-10-08T12:00:00.000Z',
        steps: [],
        subagents: [],
        delegations: [],
        childRuns: [],
        byModel: [],
      }),
    );
  const refresh = jest
    .fn<ReturnType<CostClient['refresh']>, Parameters<CostClient['refresh']>>()
    .mockResolvedValue(
      ok<CostRefreshReceipt>({
        ran: true,
        updatedAt: '2026-10-08T12:00:00.000Z',
        revision: 1,
      }),
    );
  const watchScope = jest.fn<
    ReturnType<CostClient['watchScope']>,
    Parameters<CostClient['watchScope']>
  >(() => {
    const release = jest.fn<void, []>();
    watchReleases.push(release);
    return release;
  });
  const subscribeUpdates = jest.fn<
    ReturnType<CostClient['subscribeUpdates']>,
    Parameters<CostClient['subscribeUpdates']>
  >((handler: (event: CostUpdatedEvent) => void): (() => void) => {
    handlers.add(handler);
    const release = jest.fn<void, []>(() => {
      handlers.delete(handler);
    });
    subscriptionReleases.push(release);
    return release;
  });
  const client: CostClient = {
    getScope,
    getChat,
    getPipelineRun,
    refresh,
    watchScope,
    subscribeUpdates,
  };

  return {
    client,
    getScope,
    getChat,
    getPipelineRun,
    refresh,
    watchScope,
    subscribeUpdates,
    watchReleases,
    subscriptionReleases,
  };
}

function ScopeHarness(props: {
  readonly client: CostClient;
  readonly scope: CostScopeRef;
}): JSX.Element {
  latestScopeStore = useCostScopeStore(props.client, props.scope);
  return <span />;
}

function SummaryHarness(props: {
  readonly client: CostClient;
  readonly scope: CostScopeRef;
  readonly enabled?: boolean;
}): JSX.Element {
  latestSummaryStore = useCostChatSummaryStore(
    props.client,
    props.scope,
    'chat-1',
    { enabled: props.enabled },
  );
  return <span />;
}

let latestScopeStore: CostScopeStore | null = null;
let latestSummaryStore: CostChatSummaryStore | null = null;

describe('use cost view store hooks', () => {
  let container: HTMLElement;
  let root: Root | null;

  beforeEach(() => {
    latestScopeStore = null;
    latestSummaryStore = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root !== null) {
      const mountedRoot = root;
      await act(async () => {
        mountedRoot.unmount();
        await Promise.resolve();
      });
      root = null;
    }
    container.remove();
  });

  it('attaches a mounted scope store once and releases its watch on unmount', async () => {
    const fake = makeClient();
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('Expected a mounted root.');

    await act(async () => {
      mountedRoot.render(
        <ScopeHarness client={fake.client} scope={ENTRY_SCOPE} />,
      );
      await Promise.resolve();
    });

    expect(fake.watchScope).toHaveBeenCalledTimes(1);
    expect(fake.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(fake.refresh).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      trigger: 'open',
    });

    await act(async () => {
      mountedRoot.unmount();
      await Promise.resolve();
    });
    root = null;

    expect(fake.watchReleases[0]).toHaveBeenCalledTimes(1);
    expect(fake.subscriptionReleases[0]).toHaveBeenCalledTimes(1);
  });

  it('creates a new store when the scope key changes and releases the old watch', async () => {
    const fake = makeClient();
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('Expected a mounted root.');

    act(() => {
      mountedRoot.render(
        <ScopeHarness client={fake.client} scope={ENTRY_SCOPE} />,
      );
    });
    const firstStore = latestScopeStore;

    await act(async () => {
      mountedRoot.render(
        <ScopeHarness client={fake.client} scope={OTHER_SCOPE} />,
      );
      await Promise.resolve();
    });

    expect(latestScopeStore).not.toBe(firstStore);
    expect(fake.watchScope).toHaveBeenCalledTimes(2);
    expect(fake.watchScope).toHaveBeenNthCalledWith(1, ENTRY_SCOPE);
    expect(fake.watchScope).toHaveBeenNthCalledWith(2, OTHER_SCOPE);
    expect(fake.watchReleases[0]).toHaveBeenCalledTimes(1);
    expect(fake.subscriptionReleases[0]).toHaveBeenCalledTimes(1);
  });

  it('does not attach the usage-popover summary while disabled', () => {
    const fake = makeClient();
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('Expected a mounted root.');

    act(() => {
      mountedRoot.render(
        <SummaryHarness
          client={fake.client}
          scope={ENTRY_SCOPE}
          enabled={false}
        />,
      );
    });

    expect(latestSummaryStore).not.toBeNull();
    expect(fake.getChat).not.toHaveBeenCalled();
    expect(fake.watchScope).not.toHaveBeenCalled();
    expect(fake.subscribeUpdates).not.toHaveBeenCalled();
  });

  it('survives StrictMode effect replay without duplicating the open refresh', async () => {
    const fake = makeClient();
    const mountedRoot = root;
    if (mountedRoot === null) throw new Error('Expected a mounted root.');

    await act(async () => {
      mountedRoot.render(
        <StrictMode>
          <ScopeHarness client={fake.client} scope={ENTRY_SCOPE} />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect(fake.watchScope).toHaveBeenCalledTimes(2);
    expect(fake.watchReleases[0]).toHaveBeenCalledTimes(1);
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(latestScopeStore?.getState().value?.scope).toEqual(ENTRY_SCOPE);
  });
});
