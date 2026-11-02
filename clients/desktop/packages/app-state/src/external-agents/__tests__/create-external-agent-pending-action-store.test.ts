import type {
  ExternalAgentsClient,
  ExternalAgentsFailure,
  ExternalAgentsResult,
} from '@canopy/app-core';
import type {
  ExternalAgentAccess,
  ExternalAgentAccessUpdate,
  ExternalAgentConnectionDetail,
  ExternalAgentConnectionSummary,
  ExternalAgentPendingAction,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import {
  createExternalAgentPendingActionStore,
  type ExternalAgentDecision,
} from '../create-external-agent-pending-action-store';

const pendingActionId = 'pending-action-1';
const connectionId = 'connection-1';

const access: ExternalAgentAccess = {
  groups: { account: 'read' },
  disabledTools: [],
  enabledDefaultOff: [],
  organizations: { mode: 'all', organizationIds: [] },
  hosts: {
    managed: false,
    connected: { mode: 'all', remoteIds: [] },
    exposeNames: false,
  },
};

const summary: ExternalAgentConnectionSummary = {
  id: connectionId,
  server: 'account',
  clientName: 'Cursor',
  verified: true,
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  access: {
    read: ['account'],
    write: [],
    destructive: [],
    organizations: 'all',
    desktops: null,
    managed: null,
  },
};

function createDetail(
  overrides: Partial<ExternalAgentConnectionDetail> = {},
): ExternalAgentConnectionDetail {
  return {
    ...summary,
    revision: 7,
    from: null,
    returnsTo: '127.0.0.1',
    loopback: true,
    groups: [],
    current: access,
    organizations: [],
    remoteControlEnabled: false,
    maxTools: 80,
    activity: [],
    confirmationClasses: ['profile', 'settings', 'content'],
    confirmation: {
      profile: 'act',
      settings: 'act',
      membership: 'act',
      sharing: 'act',
      content: 'act',
      task: 'act',
      pipeline: 'act',
    },
    waiting: [],
    textContentCompatibility: false,
    ...overrides,
  };
}

function createAction(
  overrides: Partial<ExternalAgentPendingAction> = {},
): ExternalAgentPendingAction {
  return {
    pendingActionId,
    connectionId,
    server: 'account',
    clientName: 'Cursor',
    clientVerified: true,
    toolName: 'account.updateProfile',
    confirmation: {
      class: 'profile',
      action: 'Update your profile',
      effects: ['Changes your profile'],
      resolvedTargets: [
        { resourceKind: 'account', displayName: 'Your account' },
      ],
    },
    status: 'pending',
    arguments: {},
    requestedAt: '2026-10-15T12:00:00.000Z',
    decisionExpiresAt: '2026-10-15T12:10:00.000Z',
    confirmedAt: null,
    terminalAt: null,
    outcomeExpiresAt: null,
    outcome: null,
    ...overrides,
  };
}

const overview: ExternalAgentsOverview = {
  notices: [],
  waiting: [],
  servers: [],
  cursorClientId: 'cursor-client',
  connections: [summary],
};

function success<Value>(value: Value): ExternalAgentsResult<Value> {
  return { ok: true, value };
}

function failure<Value>(
  error: ExternalAgentsFailure,
): ExternalAgentsResult<Value> {
  return { ok: false, error };
}

interface FakeClient {
  readonly client: ExternalAgentsClient;
  readonly getPendingAction: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
    [string]
  >;
  readonly decidePendingAction: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
    [string, ExternalAgentDecision]
  >;
  readonly getConnection: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string]
  >;
  readonly pause: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, number]
  >;
}

function createFakeClient(): FakeClient {
  const getOverview = jest
    .fn<Promise<ExternalAgentsResult<ExternalAgentsOverview>>, []>()
    .mockResolvedValue(success(overview));
  const getConnection = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string]
    >()
    .mockResolvedValue(success(createDetail()));
  const updateAccess = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, ExternalAgentAccessUpdate]
    >()
    .mockResolvedValue(success(createDetail()));
  const pause = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, number]
    >()
    .mockResolvedValue(success(createDetail({ status: 'paused' })));
  const resume = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, number]
    >()
    .mockResolvedValue(success(createDetail()));
  const remove = jest
    .fn<Promise<ExternalAgentsResult<null>>, [string]>()
    .mockResolvedValue(success(null));
  const getPendingAction = jest
    .fn<Promise<ExternalAgentsResult<ExternalAgentPendingAction>>, [string]>()
    .mockResolvedValue(success(createAction()));
  const decidePendingAction = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
      [string, ExternalAgentDecision]
    >()
    .mockResolvedValue(success(createAction({ status: 'confirmed' })));
  const getWaitingCount = jest
    .fn<Promise<ExternalAgentsResult<number>>, []>()
    .mockResolvedValue(success(0));

  return {
    client: {
      getOverview,
      getConnection,
      listDesktops: () =>
        Promise.resolve({ ok: true, value: { desktops: [] } }),
      updateAccess,
      pause,
      resume,
      remove,
      getPendingAction,
      decidePendingAction,
      getWaitingCount,
    },
    getPendingAction,
    decidePendingAction,
    getConnection,
    pause,
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: (value: Value) => void = () => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

describe('createExternalAgentPendingActionStore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('loads a pending action', async () => {
    const fake = createFakeClient();
    const action = createAction();
    fake.getPendingAction.mockResolvedValueOnce(success(action));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();

    expect(fake.getPendingAction).toHaveBeenCalledWith(pendingActionId);
    expect(store.getState()).toMatchObject({
      status: 'ready',
      action,
      problem: null,
      resultPoll: 'idle',
    });
  });

  it('sets not_found for a missing action', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(failure('not_found'));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'not_found',
      action: null,
      problem: null,
    });
  });

  it('records a load problem when no action is available', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'problem',
      action: null,
      problem: 'unavailable',
    });
  });

  it('keeps a loaded action when a later load fails', async () => {
    const fake = createFakeClient();
    const action = createAction();
    fake.getPendingAction
      .mockResolvedValueOnce(success(action))
      .mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'ready',
      action,
      problem: 'unavailable',
    });
  });

  it('turns a thrown read into unavailable', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockRejectedValueOnce(new Error('network failed'));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'problem',
      problem: 'unavailable',
    });
  });

  it('confirms an action that has already executed', async () => {
    const fake = createFakeClient();
    const executed = createAction({ status: 'executed' });
    fake.decidePendingAction.mockResolvedValueOnce(success(executed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().decide('confirm')).resolves.toBe(true);

    expect(fake.decidePendingAction).toHaveBeenCalledWith(
      pendingActionId,
      'confirm',
    );
    expect(store.getState()).toMatchObject({
      status: 'ready',
      action: executed,
      deciding: null,
      decided: 'confirm',
      decisionOutcome: null,
      resultPoll: 'idle',
    });
  });

  it('polls a confirmed action until it executes', async () => {
    jest.useFakeTimers();
    const fake = createFakeClient();
    const confirmed = createAction({ status: 'confirmed' });
    const executed = createAction({ status: 'executed' });
    fake.decidePendingAction.mockResolvedValueOnce(success(confirmed));
    fake.getPendingAction
      .mockResolvedValueOnce(success(createAction()))
      .mockResolvedValueOnce(success(confirmed))
      .mockResolvedValueOnce(success(executed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();
    await store.getState().decide('confirm');
    expect(store.getState().resultPoll).toBe('polling');

    await jest.advanceTimersByTimeAsync(4_000);

    expect(fake.getPendingAction).toHaveBeenCalledTimes(3);
    expect(store.getState()).toMatchObject({
      action: executed,
      resultPoll: 'idle',
    });
  });

  it('keeps polling after a failed result read', async () => {
    jest.useFakeTimers();
    const fake = createFakeClient();
    const confirmed = createAction({ status: 'confirmed' });
    const executed = createAction({ status: 'executed' });
    fake.getPendingAction
      .mockResolvedValueOnce(success(confirmed))
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(success(executed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(store.getState().resultPoll).toBe('polling');
    expect(fake.getPendingAction).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(2_000);

    expect(fake.getPendingAction).toHaveBeenCalledTimes(3);
    expect(store.getState()).toMatchObject({
      action: executed,
      resultPoll: 'idle',
    });
  });

  it('times out after sixty seconds and restarts polling on load', async () => {
    jest.useFakeTimers();
    const fake = createFakeClient();
    const confirmed = createAction({ status: 'confirmed' });
    fake.getPendingAction
      .mockResolvedValueOnce(success(confirmed))
      .mockResolvedValue(success(confirmed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    await store.getState().load();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(fake.getPendingAction).toHaveBeenCalledTimes(31);
    expect(store.getState().resultPoll).toBe('timed_out');

    await store.getState().load();

    expect(store.getState().resultPoll).toBe('polling');
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fake.getPendingAction).toHaveBeenCalledTimes(33);
  });

  it('declines a pending action', async () => {
    const fake = createFakeClient();
    const declined = createAction({ status: 'declined' });
    fake.decidePendingAction.mockResolvedValueOnce(success(declined));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().decide('decline')).resolves.toBe(true);

    expect(fake.decidePendingAction).toHaveBeenCalledWith(
      pendingActionId,
      'decline',
    );
    expect(store.getState()).toMatchObject({
      action: declined,
      decided: 'decline',
      resultPoll: 'idle',
    });
  });

  it('reloads a conflicting decision and reports the conflict', async () => {
    const fake = createFakeClient();
    const decidedElsewhere = createAction({ status: 'executed' });
    fake.decidePendingAction.mockResolvedValueOnce(failure('conflict'));
    fake.getPendingAction
      .mockResolvedValueOnce(success(createAction()))
      .mockResolvedValueOnce(success(decidedElsewhere));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().decide('confirm')).resolves.toBe(false);

    expect(fake.getPendingAction).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      action: decidedElsewhere,
      status: 'ready',
      deciding: null,
      decisionOutcome: { kind: 'conflict' },
    });
  });

  it('reloads an expired decision and reports the expiry', async () => {
    const fake = createFakeClient();
    const expired = createAction({ status: 'expired' });
    fake.decidePendingAction.mockResolvedValueOnce(failure('expired'));
    fake.getPendingAction
      .mockResolvedValueOnce(success(createAction()))
      .mockResolvedValueOnce(success(expired));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().decide('confirm')).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      action: expired,
      status: 'ready',
      decisionOutcome: { kind: 'expired' },
    });
  });

  it('reports unavailable decision failures without changing the action', async () => {
    const fake = createFakeClient();
    const action = createAction();
    fake.getPendingAction.mockResolvedValueOnce(success(action));
    fake.decidePendingAction.mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().decide('decline')).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      action,
      deciding: null,
      decided: null,
      decisionOutcome: { kind: 'unavailable', decision: 'decline' },
    });
  });

  it('ignores decisions unless the action is pending and no decision is in flight', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    fake.getPendingAction.mockResolvedValueOnce(
      success(createAction({ status: 'executed' })),
    );
    await store.getState().load();
    await expect(store.getState().decide('confirm')).resolves.toBe(false);
    expect(fake.decidePendingAction).not.toHaveBeenCalled();

    const pending =
      deferred<ExternalAgentsResult<ExternalAgentPendingAction>>();
    fake.getPendingAction.mockResolvedValueOnce(success(createAction()));
    fake.decidePendingAction.mockReturnValueOnce(pending.promise);
    await store.getState().load();
    const decision = store.getState().decide('confirm');
    expect(store.getState().deciding).toBe('confirm');
    await expect(store.getState().decide('decline')).resolves.toBe(false);
    expect(fake.decidePendingAction).toHaveBeenCalledTimes(1);
    pending.resolve(success(createAction({ status: 'executed' })));
    await decision;
  });

  it('loads the connection revision and pauses after decline', async () => {
    const fake = createFakeClient();
    const declined = createAction({ status: 'declined' });
    const activeDetail = createDetail({ revision: 12, status: 'active' });
    fake.decidePendingAction.mockResolvedValueOnce(success(declined));
    fake.getConnection.mockResolvedValueOnce(success(activeDetail));
    fake.pause.mockResolvedValueOnce(
      success(createDetail({ revision: 13, status: 'paused' })),
    );
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();
    await store.getState().decide('decline');

    await expect(store.getState().pauseConnection()).resolves.toBe(true);

    expect(fake.getConnection).toHaveBeenCalledWith(connectionId);
    expect(fake.pause).toHaveBeenCalledWith(connectionId, 12);
    expect(store.getState().pauseOffer).toBe('paused');
  });

  it('does not pause a connection that is already paused', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(
      success(createAction({ status: 'declined' })),
    );
    fake.getConnection.mockResolvedValueOnce(
      success(createDetail({ status: 'paused' })),
    );
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().pauseConnection()).resolves.toBe(true);

    expect(fake.pause).not.toHaveBeenCalled();
    expect(store.getState().pauseOffer).toBe('paused');
  });

  it('marks pause failures and allows a retry', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(
      success(createAction({ status: 'declined' })),
    );
    fake.getConnection
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(success(createDetail({ revision: 21 })));
    fake.pause.mockResolvedValueOnce(
      success(createDetail({ status: 'paused' })),
    );
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().pauseConnection()).resolves.toBe(false);
    expect(store.getState().pauseOffer).toBe('failed');
    await expect(store.getState().pauseConnection()).resolves.toBe(true);

    expect(fake.getConnection).toHaveBeenCalledTimes(2);
    expect(fake.pause).toHaveBeenCalledWith(connectionId, 21);
    expect(store.getState().pauseOffer).toBe('paused');
  });

  it('allows a retry after the pause request itself fails', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(
      success(createAction({ status: 'declined' })),
    );
    fake.getConnection
      .mockResolvedValueOnce(success(createDetail({ revision: 30 })))
      .mockResolvedValueOnce(success(createDetail({ revision: 31 })));
    fake.pause
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(success(createDetail({ status: 'paused' })));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().pauseConnection()).resolves.toBe(false);
    expect(store.getState().pauseOffer).toBe('failed');
    await expect(store.getState().pauseConnection()).resolves.toBe(true);

    expect(fake.pause).toHaveBeenNthCalledWith(1, connectionId, 30);
    expect(fake.pause).toHaveBeenNthCalledWith(2, connectionId, 31);
    expect(store.getState().pauseOffer).toBe('paused');
  });

  it('does not pause an expired connection', async () => {
    const fake = createFakeClient();
    fake.getPendingAction.mockResolvedValueOnce(
      success(createAction({ status: 'declined' })),
    );
    fake.getConnection.mockResolvedValueOnce(
      success(createDetail({ status: 'expired' })),
    );
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();

    await expect(store.getState().pauseConnection()).resolves.toBe(false);

    expect(fake.pause).not.toHaveBeenCalled();
    expect(store.getState().pauseOffer).toBe('failed');
  });

  it('stops its timer and drops poll results after disposal', async () => {
    jest.useFakeTimers();
    const fake = createFakeClient();
    const confirmed = createAction({ status: 'confirmed' });
    fake.getPendingAction.mockResolvedValueOnce(success(confirmed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();
    store.getState().dispose();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(fake.getPendingAction).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      action: confirmed,
      resultPoll: 'polling',
    });
  });

  it('drops an in-flight poll result after disposal', async () => {
    jest.useFakeTimers();
    const fake = createFakeClient();
    const confirmed = createAction({ status: 'confirmed' });
    const executed = createAction({ status: 'executed' });
    const pendingPoll =
      deferred<ExternalAgentsResult<ExternalAgentPendingAction>>();
    fake.getPendingAction.mockResolvedValueOnce(success(confirmed));
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );
    await store.getState().load();
    fake.getPendingAction.mockReturnValueOnce(pendingPoll.promise);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(fake.getPendingAction).toHaveBeenCalledTimes(2);
    store.getState().dispose();
    pendingPoll.resolve(success(executed));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState()).toMatchObject({
      action: confirmed,
      resultPoll: 'polling',
    });
  });

  it('drops a load result after disposal', async () => {
    const fake = createFakeClient();
    const pending =
      deferred<ExternalAgentsResult<ExternalAgentPendingAction>>();
    fake.getPendingAction.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentPendingActionStore(
      fake.client,
      pendingActionId,
    );

    const load = store.getState().load();
    store.getState().dispose();
    pending.resolve(success(createAction()));
    await load;

    expect(store.getState()).toMatchObject({
      status: 'loading',
      action: null,
    });
  });
});
