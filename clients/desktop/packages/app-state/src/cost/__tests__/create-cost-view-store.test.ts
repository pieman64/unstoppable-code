import type { CostClient } from '@canopy/app-core';
import type {
  CostAttributedItem,
  CostChatRow,
  CostRefreshReceipt,
  CostScopeRef,
  CostScopeView,
  CostUpdatedEvent,
  CostViewResult,
  PipelineRunCostView,
  SessionBreakdownView,
} from '@canopy/protocol/cost-view';
import { createEmptyCostTotals } from '@canopy/protocol/cost-view';
import {
  createCostChatSummaryStore,
  createCostScopeStore,
  createCostSubagentStore,
  createCostViewStore,
  createPipelineRunCostStore,
  createSessionBreakdownStore,
} from '../create-cost-view-store';

const ENTRY_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

const OTHER_ENTRY_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-2',
};

const RETAINED_SCOPE: CostScopeRef = {
  kind: 'retained',
  projectId: 'project-1',
  containerId: 'container-1',
};

const UPDATED_AT = '2026-10-08T12:00:00.000Z';

function chatRow(chatId = 'chat-1'): CostChatRow {
  return {
    chatId,
    label: 'Fix flaky test',
    state: 'open',
    totals: createEmptyCostTotals(),
    turnCount: 2,
    lastActivityAt: UPDATED_AT,
    running: false,
    models: ['Claude Sonnet'],
  };
}

function scopeView(
  scope: CostScopeRef = ENTRY_SCOPE,
  updatedAt: string | null = UPDATED_AT,
): CostScopeView {
  return {
    scope,
    updatedAt,
    building: false,
    retentionDays: 7,
    totals: createEmptyCostTotals(),
    chats: [chatRow()],
    pipelineRuns: [],
    hasCodexEstimate: false,
  };
}

function sessionView(
  updatedAt: string | null = UPDATED_AT,
): SessionBreakdownView {
  return {
    chat: chatRow(),
    updatedAt,
    bySource: {
      chat: { usd: 0, turnCount: 0 },
      subagents: { usd: 0, items: [] },
      delegations: { usd: 0, items: [] },
      background: { usd: 0, rows: [] },
    },
    chatTurnsByModel: [],
    byModel: [],
    context: { categories: [], timeline: [] },
    compactions: { total: 0, auto: 0, manual: 0 },
    activity: {
      turnCount: 0,
      totalDurationMs: 0,
      averageTurnMs: null,
      p95TurnMs: null,
      toolCallCount: 0,
      subagentCount: 0,
      plansCreated: 0,
      plansApproved: 0,
      topTools: [],
    },
  };
}

function pipelineView(
  updatedAt: string | null = UPDATED_AT,
): PipelineRunCostView {
  return {
    run: {
      executionId: 'run-1',
      pipelineName: 'Release',
      startedAt: UPDATED_AT,
      status: 'succeeded',
      totals: createEmptyCostTotals(),
      agentStepCount: 1,
    },
    updatedAt,
    steps: [],
    subagents: [],
    delegations: [],
    childRuns: [],
    byModel: [],
  };
}

const ATTRIBUTED_ITEM: CostAttributedItem = {
  id: 'subagent-1',
  kind: 'claude_task',
  label: 'Inspect tests',
  model: 'Claude Sonnet',
  billingBasis: 'api_key',
  tokens: createEmptyCostTotals().tokens,
  usd: 0.25,
  costStatus: 'reported',
  inclusion: 'additional',
};

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function ok<Value>(value: Value): CostViewResult<Value> {
  return { status: 'ok', value };
}

interface FakeCostClient {
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
  readonly watchRelease: jest.Mock<void, []>;
  readonly subscriptionRelease: jest.Mock<void, []>;
  readonly emit: (event: CostUpdatedEvent) => void;
}

function makeClient(): FakeCostClient {
  const handlers = new Set<(event: CostUpdatedEvent) => void>();
  const watchRelease = jest.fn<void, []>();
  const subscriptionRelease = jest.fn<void, []>();
  const getScope = jest
    .fn<
      ReturnType<CostClient['getScope']>,
      Parameters<CostClient['getScope']>
    >()
    .mockResolvedValue(ok(scopeView()));
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
    .mockResolvedValue(ok(pipelineView()));
  const refresh = jest
    .fn<ReturnType<CostClient['refresh']>, Parameters<CostClient['refresh']>>()
    .mockResolvedValue(ok({ ran: true, updatedAt: UPDATED_AT, revision: 1 }));
  const watchScope = jest
    .fn<
      ReturnType<CostClient['watchScope']>,
      Parameters<CostClient['watchScope']>
    >()
    .mockReturnValue(watchRelease);
  const subscribeUpdates = jest.fn<
    ReturnType<CostClient['subscribeUpdates']>,
    Parameters<CostClient['subscribeUpdates']>
  >((handler: (event: CostUpdatedEvent) => void): (() => void) => {
    handlers.add(handler);
    return (): void => {
      handlers.delete(handler);
      subscriptionRelease();
    };
  });
  const client: CostClient = {
    getScope,
    getChat,
    getPipelineRun,
    refresh,
    watchScope,
    subscribeUpdates,
  };
  const emit = (event: CostUpdatedEvent): void => {
    handlers.forEach((handler) => handler(event));
  };

  return {
    client,
    getScope,
    getChat,
    getPipelineRun,
    refresh,
    watchScope,
    subscribeUpdates,
    watchRelease,
    subscriptionRelease,
    emit,
  };
}

describe('createCostViewStore', () => {
  it('loads a successful value and its updatedAt', async () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);

    await store.getState().load();

    expect(fake.getScope).toHaveBeenCalledWith({ scope: ENTRY_SCOPE });
    expect(store.getState()).toMatchObject({
      status: 'ready',
      value: scopeView(),
      problem: null,
      reading: false,
      updatedAt: UPDATED_AT,
    });
  });

  it('keeps the last value while a re-read is in flight', async () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);
    await store.getState().load();
    const previousValue = store.getState().value;
    const pending = deferred<CostViewResult<CostScopeView>>();
    fake.getScope.mockReturnValueOnce(pending.promise);

    const reread = store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'loading',
      value: previousValue,
      reading: true,
    });
    pending.resolve(ok(scopeView(ENTRY_SCOPE, '2026-10-08T12:05:00.000Z')));
    await reread;

    expect(store.getState()).toMatchObject({
      status: 'ready',
      value: scopeView(ENTRY_SCOPE, '2026-10-08T12:05:00.000Z'),
      reading: false,
    });
  });

  it('does not turn read errors into empty values and keeps prior data on later errors', async () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);
    fake.getScope.mockResolvedValueOnce({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Read failed.',
    });

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'problem',
      value: null,
      problem: { kind: 'error', reason: 'UNKNOWN', message: 'Read failed.' },
    });

    await store.getState().load();
    const previousValue = store.getState().value;
    fake.getScope.mockResolvedValueOnce({
      status: 'error',
      reason: 'NOT_FOUND',
      message: 'The updated view is unavailable.',
    });

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'ready',
      value: previousValue,
      problem: {
        kind: 'error',
        reason: 'NOT_FOUND',
        message: 'The updated view is unavailable.',
      },
    });
  });

  it('maps unavailable reads and rejected reads to problems', async () => {
    const fake = makeClient();
    fake.getScope.mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'runtime_unavailable',
    });
    const unavailableStore = createCostScopeStore(fake.client, ENTRY_SCOPE);

    await unavailableStore.getState().load();

    expect(unavailableStore.getState().problem).toEqual({
      kind: 'unavailable',
      reason: 'runtime_unavailable',
    });

    const rejectedStore = createCostViewStore<string>({
      client: fake.client,
      scope: ENTRY_SCOPE,
      read: () => Promise.reject(new Error('Transport rejected.')),
      updatedAtOf: () => null,
    });

    await rejectedStore.getState().load();

    expect(rejectedStore.getState().problem).toEqual({
      kind: 'error',
      reason: 'UNKNOWN',
      message: 'Transport rejected.',
    });
  });

  it('drops superseded read results while keeping reading true for any in-flight read', async () => {
    const fake = makeClient();
    const first = deferred<CostViewResult<string>>();
    const second = deferred<CostViewResult<string>>();
    let readCount = 0;
    const store = createCostViewStore<string>({
      client: fake.client,
      scope: ENTRY_SCOPE,
      read: () => {
        readCount += 1;
        return readCount === 1 ? first.promise : second.promise;
      },
      updatedAtOf: () => null,
    });

    const firstRead = store.getState().load();
    const secondRead = store.getState().load();
    second.resolve(ok('newer'));
    await secondRead;

    expect(store.getState()).toMatchObject({
      value: 'newer',
      status: 'ready',
      reading: true,
    });

    first.resolve(ok('older'));
    await firstRead;

    expect(store.getState()).toMatchObject({
      value: 'newer',
      status: 'ready',
      reading: false,
    });
  });

  it('re-reads after refresh and uses the later receipt timestamp', async () => {
    const fake = makeClient();
    fake.getScope.mockResolvedValueOnce(ok(scopeView(ENTRY_SCOPE, UPDATED_AT)));
    fake.refresh.mockResolvedValueOnce(
      ok({
        ran: false,
        updatedAt: '2026-10-08T12:05:00.000Z',
        revision: 2,
      }),
    );
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);

    await store.getState().requestRefresh('open');

    expect(fake.refresh).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      trigger: 'open',
    });
    expect(fake.getScope).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      status: 'ready',
      updatedAt: '2026-10-08T12:05:00.000Z',
      refresh: { status: 'idle', completedManual: 0, problem: null },
    });
  });

  it('increments completedManual only for successful manual refreshes', async () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);

    await store.getState().requestRefresh('open');
    expect(store.getState().refresh.completedManual).toBe(0);

    await store.getState().requestRefresh('manual');
    expect(store.getState().refresh.completedManual).toBe(1);
  });

  it('shares an in-flight refresh for the same trigger', async () => {
    const fake = makeClient();
    const pending = deferred<CostViewResult<CostRefreshReceipt>>();
    fake.refresh.mockReturnValueOnce(pending.promise);
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);

    const first = store.getState().requestRefresh('manual');
    const second = store.getState().requestRefresh('manual');

    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().refresh.status).toBe('refreshing');
    pending.resolve(ok({ ran: true, updatedAt: UPDATED_AT, revision: 1 }));
    await Promise.all([first, second]);

    expect(store.getState().refresh.completedManual).toBe(1);
  });

  it('drops a refresh result after dispose, even if the store attaches again', async () => {
    const fake = makeClient();
    const staleRefresh = deferred<CostViewResult<CostRefreshReceipt>>();
    fake.refresh.mockReturnValueOnce(staleRefresh.promise);
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);
    const staleManual = store.getState().requestRefresh('manual');

    store.getState().dispose();
    const release = store.getState().attach();
    await store.getState().requestRefresh('open');
    staleRefresh.resolve(
      ok({
        ran: true,
        updatedAt: '2030-01-01T00:00:00.000Z',
        revision: 9,
      }),
    );
    await staleManual;

    expect(store.getState().refresh.completedManual).toBe(0);
    expect(store.getState().updatedAt).not.toBe('2030-01-01T00:00:00.000Z');
    release();
    store.getState().dispose();
  });

  it('keeps the value when refresh fails', async () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);
    await store.getState().load();
    const previousValue = store.getState().value;
    fake.refresh.mockResolvedValueOnce({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Refresh failed.',
    });

    await store.getState().requestRefresh('manual');

    expect(store.getState()).toMatchObject({
      status: 'ready',
      value: previousValue,
      refresh: {
        status: 'failed',
        problem: {
          kind: 'error',
          reason: 'UNKNOWN',
          message: 'Refresh failed.',
        },
        completedManual: 0,
      },
    });
  });

  it('re-reads only for matching update scopes', () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, RETAINED_SCOPE);
    const release = store.getState().attach();

    expect(fake.getScope).toHaveBeenCalledTimes(1);
    fake.emit({ scopes: [OTHER_ENTRY_SCOPE], revision: 1 });
    expect(fake.getScope).toHaveBeenCalledTimes(1);
    fake.emit({
      scopes: [
        {
          kind: 'retained',
          projectId: 'project-1',
          containerId: 'container-1',
        },
      ],
      revision: 2,
    });
    expect(fake.getScope).toHaveBeenCalledTimes(2);

    release();
    store.getState().dispose();
  });

  it('watches and opens entry scopes on attach but not retained scopes', async () => {
    const entryClient = makeClient();
    const entryStore = createCostScopeStore(entryClient.client, ENTRY_SCOPE);
    const releaseEntry = entryStore.getState().attach();

    expect(entryClient.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(entryClient.watchScope).toHaveBeenCalledWith(ENTRY_SCOPE);
    expect(entryClient.refresh).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      trigger: 'open',
    });
    releaseEntry();
    entryStore.getState().dispose();

    const retainedClient = makeClient();
    const retainedStore = createCostScopeStore(
      retainedClient.client,
      RETAINED_SCOPE,
    );
    const releaseRetained = retainedStore.getState().attach();
    const refreshBefore = retainedStore.getState().refresh;

    await retainedStore.getState().requestRefresh('manual');

    expect(retainedClient.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(retainedClient.watchScope).not.toHaveBeenCalled();
    expect(retainedClient.refresh).not.toHaveBeenCalled();
    expect(retainedStore.getState().refresh).toBe(refreshBefore);
    releaseRetained();
    retainedStore.getState().dispose();
  });

  it('ref-counts attach and releases the watch and subscription on last release or dispose', () => {
    const fake = makeClient();
    const store = createCostScopeStore(fake.client, ENTRY_SCOPE);
    const releaseFirst = store.getState().attach();
    const releaseSecond = store.getState().attach();

    expect(fake.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(fake.watchScope).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect(fake.watchRelease).not.toHaveBeenCalled();
    expect(fake.subscriptionRelease).not.toHaveBeenCalled();
    releaseSecond();
    releaseSecond();
    expect(fake.watchRelease).toHaveBeenCalledTimes(1);
    expect(fake.subscriptionRelease).toHaveBeenCalledTimes(1);

    const releaseThird = store.getState().attach();
    store.getState().dispose();
    releaseThird();
    store.getState().dispose();
    expect(fake.watchRelease).toHaveBeenCalledTimes(2);
    expect(fake.subscriptionRelease).toHaveBeenCalledTimes(2);
  });

  it('maps the typed constructors to their request and chat view kinds', async () => {
    const fake = makeClient();
    const scopeStore = createCostScopeStore(fake.client, ENTRY_SCOPE);
    await scopeStore.getState().load();
    expect(fake.getScope).toHaveBeenCalledWith({ scope: ENTRY_SCOPE });

    fake.getChat.mockResolvedValueOnce(
      ok({ kind: 'full', breakdown: sessionView() }),
    );
    const sessionStore = createSessionBreakdownStore(
      fake.client,
      ENTRY_SCOPE,
      'chat-1',
    );
    await sessionStore.getState().load();
    expect(fake.getChat).toHaveBeenLastCalledWith({
      scope: ENTRY_SCOPE,
      chatId: 'chat-1',
      detail: 'full',
    });
    expect(sessionStore.getState().value).toEqual(sessionView());

    const runStore = createPipelineRunCostStore(
      fake.client,
      ENTRY_SCOPE,
      'run-1',
    );
    await runStore.getState().load();
    expect(fake.getPipelineRun).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      executionId: 'run-1',
    });

    fake.getChat.mockResolvedValueOnce(
      ok({ kind: 'summary', chat: chatRow() }),
    );
    const summaryStore = createCostChatSummaryStore(
      fake.client,
      ENTRY_SCOPE,
      'chat-1',
    );
    await summaryStore.getState().load();
    expect(fake.getChat).toHaveBeenLastCalledWith({
      scope: ENTRY_SCOPE,
      chatId: 'chat-1',
      detail: 'summary',
    });
    expect(summaryStore.getState().value).toEqual(chatRow());
    expect(summaryStore.getState().updatedAt).toBeNull();

    fake.getChat.mockResolvedValueOnce(
      ok({
        kind: 'subagent',
        chat: chatRow(),
        item: ATTRIBUTED_ITEM,
      }),
    );
    const subagentStore = createCostSubagentStore(
      fake.client,
      ENTRY_SCOPE,
      'chat-1',
      'subagent-1',
    );
    await subagentStore.getState().load();
    expect(fake.getChat).toHaveBeenLastCalledWith({
      scope: ENTRY_SCOPE,
      chatId: 'chat-1',
      subagentId: 'subagent-1',
    });
    expect(subagentStore.getState().value).toEqual({
      chat: chatRow(),
      item: ATTRIBUTED_ITEM,
    });
    expect(subagentStore.getState().updatedAt).toBeNull();
  });

  it('treats an unexpected CostChatView kind as an UNKNOWN error', async () => {
    const fake = makeClient();
    fake.getChat.mockResolvedValueOnce(
      ok({ kind: 'summary', chat: chatRow() }),
    );
    const store = createSessionBreakdownStore(
      fake.client,
      ENTRY_SCOPE,
      'chat-1',
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'problem',
      value: null,
      problem: {
        kind: 'error',
        reason: 'UNKNOWN',
        message: 'Expected a full cost chat view.',
      },
    });
  });
});
