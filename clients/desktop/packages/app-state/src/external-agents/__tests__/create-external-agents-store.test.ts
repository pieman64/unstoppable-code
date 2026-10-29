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
  ExternalAgentDesktop,
  ExternalAgentDesktopList,
  ExternalAgentExpiryChange,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import {
  createExternalAgentStore,
  createExternalAgentsOverviewStore,
} from '../create-external-agents-store';

const connectionId = 'connection-1';

const access: ExternalAgentAccess = {
  groups: { account: 'read' },
  disabledTools: [],
  enabledDefaultOff: [],
  organizations: { mode: 'all', organizationIds: [] },
  remotes: { mode: 'all', remoteIds: [] },
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
  },
};

function createDetail(
  overrides: Partial<ExternalAgentConnectionDetail> = {},
): ExternalAgentConnectionDetail {
  return {
    ...summary,
    revision: 1,
    from: null,
    returnsTo: '127.0.0.1',
    loopback: true,
    groups: [],
    current: access,
    organizations: [],
    remoteControlEnabled: false,
    maxTools: 80,
    activity: [],
    confirmationClasses: [
      'profile',
      'settings',
      'membership',
      'sharing',
      'content',
    ],
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
    ...overrides,
  };
}

const detail = createDetail();
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
  readonly getOverview: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentsOverview>>,
    []
  >;
  readonly getConnection: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string]
  >;
  readonly listDesktops: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentDesktopList>>,
    []
  >;
  readonly updateAccess: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, ExternalAgentAccessUpdate]
  >;
  readonly pause: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, number]
  >;
  readonly resume: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, number]
  >;
  readonly remove: jest.Mock<Promise<ExternalAgentsResult<null>>, [string]>;
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
  const listDesktops = jest
    .fn<Promise<ExternalAgentsResult<ExternalAgentDesktopList>>, []>()
    .mockResolvedValue(success({ desktops: [] }));
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

  return {
    client: {
      getOverview,
      getConnection,
      listDesktops,
      updateAccess,
      pause,
      resume,
      remove,
      getPendingAction: () =>
        Promise.resolve({ ok: false, error: 'unavailable' }),
      decidePendingAction: () =>
        Promise.resolve({ ok: false, error: 'unavailable' }),
      getWaitingCount: () => Promise.resolve({ ok: true, value: 0 }),
    },
    getOverview,
    getConnection,
    listDesktops,
    updateAccess,
    pause,
    resume,
    remove,
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

describe('createExternalAgentsOverviewStore', () => {
  it('loads and retains the overview on success', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentsOverviewStore(fake.client);

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'ready',
      overview,
      problem: null,
    });
    expect(fake.getOverview).toHaveBeenCalledTimes(1);
  });

  it('records a failed load', async () => {
    const fake = createFakeClient();
    fake.getOverview.mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentsOverviewStore(fake.client);

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'problem',
      overview: null,
      problem: 'unavailable',
    });
  });

  it('drops an older read when a newer load supersedes it', async () => {
    const fake = createFakeClient();
    const older = deferred<ExternalAgentsResult<ExternalAgentsOverview>>();
    const newerOverview: ExternalAgentsOverview = {
      ...overview,
      cursorClientId: 'newer-client',
    };
    fake.getOverview
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(success(newerOverview));
    const store = createExternalAgentsOverviewStore(fake.client);

    const oldLoad = store.getState().load();
    await store.getState().load();
    older.resolve(success(overview));
    await oldLoad;

    expect(store.getState().overview).toEqual(newerOverview);
  });

  it('drops an in-flight result after disposal', async () => {
    const fake = createFakeClient();
    const pending = deferred<ExternalAgentsResult<ExternalAgentsOverview>>();
    fake.getOverview.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentsOverviewStore(fake.client);

    const load = store.getState().load();
    store.getState().dispose();
    store.getState().dispose();
    pending.resolve(success(overview));
    await load;

    expect(store.getState().overview).toBeNull();
  });
});

describe('createExternalAgentStore', () => {
  it('loads a connection', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentStore(fake.client, connectionId);

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      status: 'ready',
      detail,
      problem: null,
      detailVersion: 1,
    });
    expect(fake.getConnection).toHaveBeenCalledWith(connectionId);
  });

  it('loads the paired desktops independently', async () => {
    const fake = createFakeClient();
    const desktops: ExternalAgentDesktop[] = [
      {
        remoteId: 'c0ffee00-0000-4000-8000-000000000001',
        name: 'Work desktop',
        hostname: 'work.example',
        connection: 'active',
        lastSeenAt: null,
      },
    ];
    fake.listDesktops.mockResolvedValueOnce(success({ desktops }));
    const store = createExternalAgentStore(fake.client, connectionId);

    await store.getState().loadDesktops();

    expect(fake.listDesktops).toHaveBeenCalledTimes(1);
    expect(store.getState().desktops).toEqual({
      status: 'ready',
      list: desktops,
      problem: null,
    });
  });

  it('reports a desktop-list failure when no list is available', async () => {
    const fake = createFakeClient();
    fake.listDesktops.mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentStore(fake.client, connectionId);

    await store.getState().loadDesktops();

    expect(store.getState().desktops).toEqual({
      status: 'problem',
      list: null,
      problem: 'unavailable',
    });
  });

  it('keeps a successful desktop list when a later refresh fails', async () => {
    const fake = createFakeClient();
    const desktops: ExternalAgentDesktop[] = [
      {
        remoteId: 'c0ffee00-0000-4000-8000-000000000002',
        name: 'Home desktop',
        hostname: null,
        connection: 'inactive',
        lastSeenAt: null,
      },
    ];
    fake.listDesktops
      .mockResolvedValueOnce(success({ desktops }))
      .mockResolvedValueOnce(failure('unavailable'));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().loadDesktops();

    await store.getState().loadDesktops();

    expect(store.getState().desktops).toEqual({
      status: 'ready',
      list: desktops,
      problem: 'unavailable',
    });
  });

  it('turns a thrown desktop-list error into unavailable', async () => {
    const fake = createFakeClient();
    fake.listDesktops.mockRejectedValueOnce(new Error('request failed'));
    const store = createExternalAgentStore(fake.client, connectionId);

    await store.getState().loadDesktops();

    expect(store.getState().desktops).toEqual({
      status: 'problem',
      list: null,
      problem: 'unavailable',
    });
  });

  it('ignores a stale desktop-list result', async () => {
    const fake = createFakeClient();
    const older = deferred<ExternalAgentsResult<ExternalAgentDesktopList>>();
    const newer: ExternalAgentDesktop[] = [
      {
        remoteId: 'c0ffee00-0000-4000-8000-000000000003',
        name: 'New desktop',
        hostname: null,
        connection: 'reconnecting',
        lastSeenAt: null,
      },
    ];
    fake.listDesktops
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(success({ desktops: newer }));
    const store = createExternalAgentStore(fake.client, connectionId);

    const oldLoad = store.getState().loadDesktops();
    await store.getState().loadDesktops();
    older.resolve(success({ desktops: [] }));
    await oldLoad;

    expect(store.getState().desktops.list).toEqual(newer);
  });

  it('ignores a desktop-list result after disposal', async () => {
    const fake = createFakeClient();
    const pending = deferred<ExternalAgentsResult<ExternalAgentDesktopList>>();
    fake.listDesktops.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentStore(fake.client, connectionId);

    const load = store.getState().loadDesktops();
    store.getState().dispose();
    pending.resolve(success({ desktops: [] }));
    await load;

    expect(store.getState().desktops).toEqual({
      status: 'loading',
      list: null,
      problem: null,
    });
  });

  it('does not let a pending save block loading desktops', async () => {
    const fake = createFakeClient();
    const pendingSave =
      deferred<ExternalAgentsResult<ExternalAgentConnectionDetail>>();
    const desktops: ExternalAgentDesktop[] = [
      {
        remoteId: 'c0ffee00-0000-4000-8000-000000000004',
        name: 'Work desktop',
        hostname: null,
        connection: 'active',
        lastSeenAt: null,
      },
    ];
    fake.updateAccess.mockReturnValueOnce(pendingSave.promise);
    fake.listDesktops.mockResolvedValueOnce(success({ desktops }));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    const save = store.getState().save({
      access,
      expiry: { kind: 'keep' },
    });
    await store.getState().loadDesktops();

    expect(store.getState().desktops.list).toEqual(desktops);
    expect(store.getState().pending).toBe('save');
    pendingSave.resolve(success(detail));
    await expect(save).resolves.toBe(true);
  });

  it('does not let a pending desktop load block saving', async () => {
    const fake = createFakeClient();
    const pendingDesktops =
      deferred<ExternalAgentsResult<ExternalAgentDesktopList>>();
    fake.listDesktops.mockReturnValueOnce(pendingDesktops.promise);
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    const desktopLoad = store.getState().loadDesktops();
    await expect(
      store.getState().save({ access, expiry: { kind: 'keep' } }),
    ).resolves.toBe(true);

    expect(store.getState().desktops.status).toBe('loading');
    pendingDesktops.resolve(success({ desktops: [] }));
    await desktopLoad;
    expect(store.getState().desktops).toEqual({
      status: 'ready',
      list: [],
      problem: null,
    });
  });

  it('sets not_found and unavailable states for failed loads', async () => {
    const notFoundClient = createFakeClient();
    notFoundClient.getConnection.mockResolvedValueOnce(failure('not_found'));
    const notFoundStore = createExternalAgentStore(
      notFoundClient.client,
      connectionId,
    );
    await notFoundStore.getState().load();
    expect(notFoundStore.getState()).toMatchObject({
      status: 'not_found',
      detail: null,
      problem: null,
    });

    const unavailableClient = createFakeClient();
    unavailableClient.getConnection.mockResolvedValueOnce(
      failure('unavailable'),
    );
    const unavailableStore = createExternalAgentStore(
      unavailableClient.client,
      connectionId,
    );
    await unavailableStore.getState().load();
    expect(unavailableStore.getState()).toMatchObject({
      status: 'problem',
      detail: null,
      problem: 'unavailable',
    });
  });

  it('sends the loaded revision with save and bumps detailVersion on success', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentStore(fake.client, connectionId);
    const expiry: ExternalAgentExpiryChange = { kind: 'keep' };
    const changedAccess: ExternalAgentAccess = {
      ...access,
      groups: { account: 'write' },
    };
    await store.getState().load();

    await expect(
      store.getState().save({ access: changedAccess, expiry }),
    ).resolves.toBe(true);

    expect(fake.updateAccess).toHaveBeenCalledWith(connectionId, {
      revision: detail.revision,
      access: changedAccess,
      expiry,
    });
    expect(store.getState()).toMatchObject({
      detail,
      detailVersion: 2,
      outcome: { kind: 'saved' },
      pending: null,
    });
  });

  it('sends non-empty confirmation changes with save', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentStore(fake.client, connectionId);
    const confirmation = { profile: 'ask_first' } as const;
    const change = {
      access,
      expiry: { kind: 'keep' } as const,
      confirmation,
    };
    await store.getState().load();

    await expect(store.getState().save(change)).resolves.toBe(true);

    expect(fake.updateAccess).toHaveBeenCalledWith(connectionId, {
      revision: detail.revision,
      access,
      expiry: { kind: 'keep' },
      confirmation,
    });
  });

  it('omits empty confirmation changes with save', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentStore(fake.client, connectionId);
    const change = {
      access,
      expiry: { kind: 'keep' } as const,
      confirmation: {},
    };
    await store.getState().load();

    await expect(store.getState().save(change)).resolves.toBe(true);

    expect(fake.updateAccess).toHaveBeenCalledWith(connectionId, {
      revision: detail.revision,
      access,
      expiry: { kind: 'keep' },
    });
  });

  it('reloads after a conflict and sets the conflict outcome', async () => {
    const fake = createFakeClient();
    const reloaded = createDetail({ revision: 2 });
    fake.updateAccess.mockResolvedValueOnce(failure('conflict'));
    fake.getConnection
      .mockResolvedValueOnce(success(detail))
      .mockResolvedValueOnce(success(reloaded));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    await expect(
      store.getState().save({ access, expiry: { kind: 'keep' } }),
    ).resolves.toBe(false);

    expect(fake.getConnection).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      detail: reloaded,
      detailVersion: 2,
      outcome: { kind: 'conflict' },
      pending: null,
    });
  });

  it('reloads after expiry and refuses every further action', async () => {
    const fake = createFakeClient();
    const expired = createDetail({ status: 'expired', revision: 2 });
    fake.pause.mockResolvedValueOnce(failure('expired'));
    fake.getConnection
      .mockResolvedValueOnce(success(detail))
      .mockResolvedValueOnce(success(expired));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    await expect(store.getState().pause()).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      detail: expired,
      detailVersion: 2,
      outcome: { kind: 'expired' },
      pending: null,
    });

    const callsBeforeRefusals = {
      updateAccess: fake.updateAccess.mock.calls.length,
      pause: fake.pause.mock.calls.length,
      resume: fake.resume.mock.calls.length,
      remove: fake.remove.mock.calls.length,
    };
    await expect(
      store.getState().save({ access, expiry: { kind: 'keep' } }),
    ).resolves.toBe(false);
    await expect(store.getState().pause()).resolves.toBe(false);
    await expect(store.getState().resume()).resolves.toBe(false);
    await expect(store.getState().remove()).resolves.toBe(false);
    expect(fake.updateAccess).toHaveBeenCalledTimes(
      callsBeforeRefusals.updateAccess,
    );
    expect(fake.pause).toHaveBeenCalledTimes(callsBeforeRefusals.pause);
    expect(fake.resume).toHaveBeenCalledTimes(callsBeforeRefusals.resume);
    expect(fake.remove).toHaveBeenCalledTimes(callsBeforeRefusals.remove);
  });

  it.each([
    ['invalid_policy', { kind: 'invalid_policy' }],
    ['unavailable', { kind: 'unavailable', action: 'save' }],
  ] as const)(
    'keeps the detail for a %s save result',
    async (error, outcome) => {
      const fake = createFakeClient();
      fake.updateAccess.mockResolvedValueOnce(failure(error));
      const store = createExternalAgentStore(fake.client, connectionId);
      await store.getState().load();

      await expect(
        store.getState().save({ access, expiry: { kind: 'keep' } }),
      ).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        detail,
        outcome,
        pending: null,
      });
    },
  );

  it('pauses and resumes with the current revision', async () => {
    const fake = createFakeClient();
    const paused = createDetail({ status: 'paused', revision: 2 });
    const resumed = createDetail({ status: 'active', revision: 3 });
    fake.pause.mockResolvedValueOnce(success(paused));
    fake.resume.mockResolvedValueOnce(success(resumed));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    await expect(store.getState().pause()).resolves.toBe(true);
    expect(fake.pause).toHaveBeenCalledWith(connectionId, detail.revision);
    expect(store.getState().outcome).toEqual({ kind: 'paused' });
    await expect(store.getState().resume()).resolves.toBe(true);
    expect(fake.resume).toHaveBeenCalledWith(connectionId, paused.revision);
    expect(store.getState()).toMatchObject({
      detail: resumed,
      detailVersion: 3,
      outcome: { kind: 'resumed' },
    });
  });

  it('marks a removed connection after remove succeeds', async () => {
    const fake = createFakeClient();
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    await expect(store.getState().remove()).resolves.toBe(true);

    expect(fake.remove).toHaveBeenCalledWith(connectionId);
    expect(store.getState()).toMatchObject({
      status: 'removed',
      detail: null,
      pending: null,
    });
  });

  it('sets not_found when an action reports not_found', async () => {
    const fake = createFakeClient();
    fake.remove.mockResolvedValueOnce(failure('not_found'));
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    await expect(store.getState().remove()).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      status: 'not_found',
      detail: null,
      pending: null,
    });
  });

  it('refuses concurrent actions while an action is pending', async () => {
    const fake = createFakeClient();
    const pending =
      deferred<ExternalAgentsResult<ExternalAgentConnectionDetail>>();
    fake.updateAccess.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    const save = store.getState().save({
      access,
      expiry: { kind: 'keep' },
    });
    await expect(store.getState().pause()).resolves.toBe(false);
    expect(fake.pause).not.toHaveBeenCalled();
    pending.resolve(success(detail));
    await expect(save).resolves.toBe(true);
  });

  it('drops an action result after disposal', async () => {
    const fake = createFakeClient();
    const pending =
      deferred<ExternalAgentsResult<ExternalAgentConnectionDetail>>();
    fake.updateAccess.mockReturnValueOnce(pending.promise);
    const store = createExternalAgentStore(fake.client, connectionId);
    await store.getState().load();

    const save = store.getState().save({
      access,
      expiry: { kind: 'keep' },
    });
    store.getState().dispose();
    pending.resolve(success(createDetail({ revision: 2 })));
    await expect(save).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      detail,
      detailVersion: 1,
      pending: 'save',
      outcome: null,
    });
  });
});
