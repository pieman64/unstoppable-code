import type {
  ExternalAgentsClient,
  ExternalAgentsFailure,
  ExternalAgentsResult,
} from '@canopy/app-core';
import type {
  ExternalAgentAccessUpdate,
  ExternalAgentConnectionDetail,
  ExternalAgentPendingAction,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import { createExternalAgentsWaitingCountStore } from '../create-external-agents-waiting-count-store';

const detail: ExternalAgentConnectionDetail = {
  id: 'connection-1',
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
  revision: 1,
  from: null,
  returnsTo: '127.0.0.1',
  loopback: true,
  groups: [],
  current: {
    groups: { account: 'read' },
    disabledTools: [],
    enabledDefaultOff: [],
    organizations: { mode: 'all', organizationIds: [] },
    hosts: {
      managed: false,
      connected: { mode: 'all', remoteIds: [] },
      exposeNames: false,
    },
  },
  organizations: [],
  remoteControlEnabled: false,
  maxTools: 80,
  activity: [],
  confirmationClasses: ['profile'],
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
};

const overview: ExternalAgentsOverview = {
  notices: [],
  waiting: [],
  servers: [],
  cursorClientId: 'cursor-client',
  connections: [],
};

const pendingAction: ExternalAgentPendingAction = {
  pendingActionId: 'pending-action-1',
  connectionId: detail.id,
  server: 'account',
  clientName: 'Cursor',
  clientVerified: true,
  toolName: 'account.updateProfile',
  confirmation: {
    class: 'profile',
    action: 'Update your profile',
    effects: [],
    resolvedTargets: [],
  },
  status: 'pending',
  arguments: {},
  requestedAt: '2026-10-15T12:00:00.000Z',
  decisionExpiresAt: '2026-10-15T12:10:00.000Z',
  confirmedAt: null,
  terminalAt: null,
  outcomeExpiresAt: null,
  outcome: null,
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
  readonly getWaitingCount: jest.Mock<
    Promise<ExternalAgentsResult<number>>,
    []
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
    .mockResolvedValue(success(detail));
  const updateAccess = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, ExternalAgentAccessUpdate]
    >()
    .mockResolvedValue(success(detail));
  const pause = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, number]
    >()
    .mockResolvedValue(success(detail));
  const resume = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
      [string, number]
    >()
    .mockResolvedValue(success(detail));
  const remove = jest
    .fn<Promise<ExternalAgentsResult<null>>, [string]>()
    .mockResolvedValue(success(null));
  const getPendingAction = jest
    .fn<Promise<ExternalAgentsResult<ExternalAgentPendingAction>>, [string]>()
    .mockResolvedValue(success(pendingAction));
  const decidePendingAction = jest
    .fn<
      Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
      [string, 'confirm' | 'decline']
    >()
    .mockResolvedValue(success(pendingAction));
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
    getWaitingCount,
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

describe('createExternalAgentsWaitingCountStore', () => {
  it('loads and shows the waiting count', async () => {
    const fake = createFakeClient();
    fake.getWaitingCount.mockResolvedValueOnce(success(4));
    const store = createExternalAgentsWaitingCountStore(fake.client);

    await store.getState().load();

    expect(store.getState().count).toBe(4);
    expect(fake.getWaitingCount).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one request per load', async () => {
    const fake = createFakeClient();
    fake.getWaitingCount
      .mockResolvedValueOnce(success(2))
      .mockResolvedValueOnce(success(5));
    const store = createExternalAgentsWaitingCountStore(fake.client);

    await store.getState().load();
    await store.getState().load();

    expect(fake.getWaitingCount).toHaveBeenCalledTimes(2);
    expect(store.getState().count).toBe(5);
  });

  it('keeps the count null after a failed read', async () => {
    const fake = createFakeClient();
    fake.getWaitingCount.mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentsWaitingCountStore(fake.client);

    await store.getState().load();

    expect(store.getState().count).toBeNull();
  });

  it('clears a previous count after a failed read', async () => {
    const fake = createFakeClient();
    fake.getWaitingCount
      .mockResolvedValueOnce(success(3))
      .mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentsWaitingCountStore(fake.client);
    await store.getState().load();

    await store.getState().load();

    expect(store.getState().count).toBeNull();
  });

  it('turns a thrown read into a null count', async () => {
    const fake = createFakeClient();
    fake.getWaitingCount.mockRejectedValueOnce(new Error('network failed'));
    const store = createExternalAgentsWaitingCountStore(fake.client);

    await store.getState().load();

    expect(store.getState().count).toBeNull();
  });

  it('lets the latest concurrent load win', async () => {
    const fake = createFakeClient();
    const older = deferred<ExternalAgentsResult<number>>();
    fake.getWaitingCount
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(success(7));
    const store = createExternalAgentsWaitingCountStore(fake.client);

    const oldLoad = store.getState().load();
    await store.getState().load();
    older.resolve(success(2));
    await oldLoad;

    expect(store.getState().count).toBe(7);
    expect(fake.getWaitingCount).toHaveBeenCalledTimes(2);
  });

  it('drops a result after disposal', async () => {
    const fake = createFakeClient();
    const pending = deferred<ExternalAgentsResult<number>>();
    fake.getWaitingCount.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentsWaitingCountStore(fake.client);

    const load = store.getState().load();
    store.getState().dispose();
    pending.resolve(success(8));
    await load;

    expect(store.getState().count).toBeNull();
  });
});
