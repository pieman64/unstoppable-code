import type { WorkspaceContextState } from '@canopy/protocol/workspace-context';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
} from '../../create-client-store';
import {
  accountChange,
  deferred,
  createFakeClient,
} from '../../__tests__/fake-org-projects-client';
import {
  createWorkspaceContextStore,
  selectCurrentWorkspaceContext,
  selectSwitchableOrganizations,
} from '../create-workspace-context-store';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function state(
  overrides: Partial<WorkspaceContextState> = {},
): WorkspaceContextState {
  return {
    context: { kind: 'personal' },
    revision: 1,
    organizations: [{ id: ORG_ID, name: 'Acme', role: 'MEMBER' }],
    ...overrides,
  };
}

describe('createWorkspaceContextStore', () => {
  it('keeps a matching switch event received before the command resolves', async (): Promise<void> => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    store.getState().applyState(state());
    const reply = deferred<WorkspaceContextState>();
    fake.command.mockReturnValueOnce(reply.promise);
    const confirmed = state({
      context: { kind: 'organization', organizationId: ORG_ID },
      revision: 3,
    });
    const pending = store.getState().setContext(confirmed.context);
    fake.emit('workspace-context.changed', {
      occurredAt: '2026-09-10T00:00:00.000Z',
      reason: 'switch',
      state: confirmed,
    });
    const eventApplied = store.getState();
    reply.resolve({ ...confirmed, revision: 2 });
    await expect(pending).resolves.toBeUndefined();
    expect(store.getState()).toBe(eventApplied);
    expect(store.getState().state).toBe(confirmed);
  });

  it('accepts an account-change reset below the current revision', () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    store.getState().applyState(state({ revision: 9 }));
    fake.emit('workspace-context.changed', accountChange());
    expect(store.getState().state).toEqual(accountChange().state);
  });

  it.each(['load', 'setContext'])(
    'drops an old-account %s reply',
    async (operation) => {
      const fake = createFakeClient();
      const store = createWorkspaceContextStore(fake.client);
      store[CLIENT_STORE_ACTIVATE]?.();
      const reply = deferred<WorkspaceContextState>();
      fake.query.mockReturnValueOnce(reply.promise);
      fake.command.mockReturnValueOnce(reply.promise);
      const pending =
        operation === 'load'
          ? store.getState().load()
          : store
              .getState()
              .setContext({ kind: 'organization', organizationId: ORG_ID });
      const result = pending.catch(() => {});
      fake.emit('workspace-context.changed', accountChange());
      reply.resolve(state({ revision: 10 }));
      await result;
      expect(store.getState().state).toEqual(accountChange().state);
    },
  );

  it('defaults to Personal before the host answers and mirrors the host after load', async () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    expect(selectCurrentWorkspaceContext(store.getState())).toEqual({
      kind: 'personal',
    });
    expect(selectSwitchableOrganizations(store.getState())).toEqual([]);

    fake.query.mockResolvedValueOnce(state());
    await store.getState().load();

    expect(fake.query).toHaveBeenCalledWith('workspaceContext.get', {});
    expect(store.getState().status).toBe('ready');
    expect(selectSwitchableOrganizations(store.getState())).toHaveLength(1);
  });

  it('records a failed load without dropping the last good state', async () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store.getState().applyState(state());
    fake.query.mockRejectedValueOnce(new Error('offline'));
    await store.getState().load();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('offline');
    expect(store.getState().state?.revision).toBe(1);
  });

  it('keeps a newer successful load when an older load rejects', async (): Promise<void> => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    const older = deferred<WorkspaceContextState>();
    const newer = deferred<WorkspaceContextState>();
    fake.query
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const first = store.getState().load();
    const second = store.getState().load();
    const latest = state({ revision: 2 });
    newer.resolve(latest);
    await second;
    expect(store.getState()).toMatchObject({
      state: latest,
      status: 'ready',
      error: null,
    });

    older.reject(new Error('offline'));
    await first;
    expect(store.getState()).toMatchObject({
      state: latest,
      status: 'ready',
      error: null,
    });
  });

  it('switches through the host with the last-seen revision and adopts the result', async () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store.getState().applyState(state({ revision: 3 }));
    const next = state({
      context: { kind: 'organization', organizationId: ORG_ID },
      revision: 4,
    });
    fake.command.mockResolvedValueOnce(next);

    await store
      .getState()
      .setContext({ kind: 'organization', organizationId: ORG_ID });

    expect(fake.command).toHaveBeenCalledWith('workspaceContext.set', {
      context: { kind: 'organization', organizationId: ORG_ID },
      expectedRevision: 3,
    });
    expect(selectCurrentWorkspaceContext(store.getState())).toEqual({
      kind: 'organization',
      organizationId: ORG_ID,
    });
  });

  it('is a no-op when switching to the current context', async () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store.getState().applyState(state());
    await store.getState().setContext({ kind: 'personal' });
    expect(fake.command).not.toHaveBeenCalled();
  });

  it('propagates a refused switch and leaves the mirror untouched', async () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store.getState().applyState(state({ revision: 2 }));
    fake.command.mockRejectedValueOnce(new Error('stale-revision'));
    await expect(
      store
        .getState()
        .setContext({ kind: 'organization', organizationId: ORG_ID }),
    ).rejects.toThrow('stale-revision');
    expect(store.getState().state?.revision).toBe(2);
    expect(selectCurrentWorkspaceContext(store.getState())).toEqual({
      kind: 'personal',
    });
  });

  it('ignores host states older than the one it holds', () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store.getState().applyState(state({ revision: 5 }));
    store.getState().applyState(
      state({
        revision: 4,
        context: { kind: 'organization', organizationId: ORG_ID },
      }),
    );
    expect(store.getState().state?.revision).toBe(5);
  });

  it('folds workspace-context.changed while active and unsubscribes on dispose', () => {
    const fake = createFakeClient();
    const store = createWorkspaceContextStore(fake.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(fake.subscribed).toEqual(['workspace-context.changed']);

    fake.emit('workspace-context.changed', {
      occurredAt: '2026-09-10T00:00:00.000Z',
      reason: 'switch',
      state: state({
        revision: 7,
        context: { kind: 'organization', organizationId: ORG_ID },
      }),
    });
    expect(store.getState().state?.revision).toBe(7);

    store[CLIENT_STORE_DISPOSE]?.();
    expect(fake.unsubscribed).toEqual(['workspace-context.changed']);
  });
});
