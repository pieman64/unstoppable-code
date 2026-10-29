import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createAccountOrganizationSettingsApi,
  type AccountOrganizationSettingsIpc,
} from '../api/account-organization-settings-api';

type Listener = (event: unknown, payload: unknown) => void;

function fakeIpc(reply: unknown = { ok: true, result: null }): {
  ipc: AccountOrganizationSettingsIpc;
  invoke: jest.Mock;
  listeners: Map<string, Set<Listener>>;
  push: (channel: string, payload: unknown) => void;
} {
  const listeners = new Map<string, Set<Listener>>();
  const invoke = jest.fn((): Promise<unknown> => Promise.resolve(reply));
  return {
    invoke,
    listeners,
    ipc: {
      invoke,
      on: (channel, listener): void => {
        const set = listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(channel, set);
      },
      removeListener: (channel, listener): void => {
        listeners.get(channel)?.delete(listener);
      },
    },
    push: (channel, payload): void => {
      for (const listener of Array.from(listeners.get(channel) ?? []))
        listener({}, payload);
    },
  };
}

describe('account organization settings preload bridge', () => {
  it('forwards only the named call envelope', async () => {
    const { ipc, invoke } = fakeIpc({ ok: true, result: { a: 1 } });
    const api = createAccountOrganizationSettingsApi(ipc);
    const request = {
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
      url: 'https://evil.example.com',
    };
    await expect(api.read(request)).resolves.toEqual({
      ok: true,
      result: { a: 1 },
    });
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.accountOrganizationSettingsRead,
      { accountId: 'acct-1', operation: 'settings.bootstrap', input: {} },
    );
  });

  it('turns a malformed reply into invalid_response', async () => {
    const { ipc } = fakeIpc({ ok: false, error: { code: 'teapot' } });
    const api = createAccountOrganizationSettingsApi(ipc);
    await expect(
      api.write({ accountId: 'acct-1', operation: 'x', input: {} }),
    ).resolves.toEqual({ ok: false, error: { code: 'invalid_response' } });
  });

  it('keeps known error fields from main', async () => {
    const { ipc } = fakeIpc({
      ok: false,
      error: {
        code: 'forbidden',
        status: 403,
        serverCode: 'last_owner',
        extra: 1,
      },
    });
    const api = createAccountOrganizationSettingsApi(ipc);
    await expect(
      api.write({ accountId: 'acct-1', operation: 'x', input: {} }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden', status: 403, serverCode: 'last_owner' },
    });
  });

  it('delivers well-formed events and unsubscribes once', () => {
    const { ipc, listeners, push } = fakeIpc();
    const api = createAccountOrganizationSettingsApi(ipc);
    const received: unknown[] = [];
    const stop = api.onEvent((message) => received.push(message));
    const message = {
      subscriptionId: 'sub-1',
      event: { type: 'reconnected', organizationId: 'org-1' },
    };
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, message);
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, { subscriptionId: 1 });
    expect(received).toEqual([message]);
    stop();
    stop();
    expect(
      listeners.get(IPC_CHANNELS.accountOrganizationSettingsEvent)?.size,
    ).toBe(0);
  });

  it('delivers credit-pool signals, with or without an organization', () => {
    const { ipc, push } = fakeIpc();
    const api = createAccountOrganizationSettingsApi(ipc);
    const received: unknown[] = [];
    api.onEvent((message) => received.push(message));
    const personal = {
      subscriptionId: 'sub-1',
      event: { type: 'credit.pool' },
    };
    const organization = {
      subscriptionId: 'sub-2',
      event: { type: 'credit.pool', organizationId: 'org-1' },
    };
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, personal);
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, organization);
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, {
      subscriptionId: 'sub-3',
      event: { type: 'credit.pool', organizationId: 7 },
    });
    push(IPC_CHANNELS.accountOrganizationSettingsEvent, {
      subscriptionId: 'sub-4',
      event: { type: 'feed.item', sequence: 1 },
    });
    expect(received).toEqual([personal, organization]);
  });

  it('validates payment handoff replies and open requests', async () => {
    const { ipc, push } = fakeIpc({ ok: true, extra: true });
    const api = createAccountOrganizationSettingsApi(ipc);
    await expect(
      api.paymentHandoff({
        accountId: 'acct-1',
        owner: { kind: 'personal' },
        intent: { kind: 'top-up', reason: 'credits' },
      }),
    ).resolves.toEqual({ ok: false, reason: 'failed' });

    const routes: unknown[] = [];
    api.onOpenRequest((route) => routes.push(route));
    push(IPC_CHANNELS.accountOrganizationSettingsOpen, { nope: true });
    expect(routes).toEqual([]);
  });

  it('reports availability false for a malformed reply', async () => {
    const { ipc } = fakeIpc('yes');
    const api = createAccountOrganizationSettingsApi(ipc);
    await expect(
      api.paymentHandoffAvailability({ accountId: 'acct-1' }),
    ).resolves.toEqual({ available: false });
  });
});
