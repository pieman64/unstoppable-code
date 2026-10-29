/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  AccountOrganizationSettingsApi,
  AccountOrganizationSettingsEventMessage,
  AccountOrganizationSettingsResponse,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import {
  SettingsOperationError,
  type SettingsBootstrap,
  type SettingsEvent,
} from '@canopy/protocol/settings';
import {
  createCanopyCloudAccountIdSource,
  createDesktopSettingsClient,
} from '../account-organization-settings-client';

beforeAll(() => {
  // jsdom has no TextEncoder; the settings table measures input with it.
  Object.assign(globalThis, { TextEncoder });
});

const BOOTSTRAP: SettingsBootstrap = {
  version: 1,
  viewer: { id: 'acct-1', email: 'person@example.com', name: null },
  account: {
    billingEnabled: true,
    digestsEnabled: true,
    integrationsEnabled: true,
    freeAccess: false,
  },
  organizations: [],
  organization: null,
};

type SubscribeRequest = Parameters<
  AccountOrganizationSettingsApi['subscribe']
>[0];

function fakeApi(): {
  api: AccountOrganizationSettingsApi;
  read: jest.Mock;
  subscribe: jest.Mock<
    Promise<AccountOrganizationSettingsResponse>,
    [SubscribeRequest]
  >;
  unsubscribe: jest.Mock;
  emit(message: AccountOrganizationSettingsEventMessage): void;
  listenerCount(): number;
} {
  const listeners = new Set<
    (message: AccountOrganizationSettingsEventMessage) => void
  >();
  const read = jest.fn(() => Promise.resolve({ ok: true, result: BOOTSTRAP }));
  const subscribe = jest.fn<
    Promise<AccountOrganizationSettingsResponse>,
    [SubscribeRequest]
  >(() => Promise.resolve({ ok: true, result: null }));
  const unsubscribe = jest.fn(() => Promise.resolve(undefined));
  const api: AccountOrganizationSettingsApi = {
    read,
    write: jest.fn(() => Promise.resolve({ ok: true, result: null })),
    subscribe,
    unsubscribe,
    onEvent: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    paymentHandoff: jest.fn(() => Promise.resolve({ ok: true as const })),
    paymentHandoffAvailability: jest.fn(() =>
      Promise.resolve({ available: true }),
    ),
    onOpenRequest: () => () => undefined,
  };
  return {
    api,
    read,
    subscribe,
    unsubscribe,
    emit: (message): void => {
      for (const listener of Array.from(listeners)) listener(message);
    },
    listenerCount: () => listeners.size,
  };
}

function item(sequence: number, eventId = `event-${sequence}`): SettingsEvent {
  return {
    type: 'feed.item',
    organizationId: 'org-1',
    sequence,
    eventId,
    item: { id: `item-${sequence}`, type: 'summary' } as never,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('desktop settings client', () => {
  it('sends the named call for the current account and validates the result', async () => {
    const harness = fakeApi();
    const client = createDesktopSettingsClient(harness.api, () =>
      Promise.resolve('acct-1'),
    );
    await expect(client.read('settings.bootstrap', {})).resolves.toEqual(
      BOOTSTRAP,
    );
    expect(harness.read).toHaveBeenCalledWith({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
  });

  it('rejects with unauthenticated when no account is signed in', async () => {
    const harness = fakeApi();
    const client = createDesktopSettingsClient(harness.api, () =>
      Promise.resolve(null),
    );
    await expect(client.read('settings.bootstrap', {})).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(harness.read).not.toHaveBeenCalled();
  });

  it('rethrows a main failure as a settings error', async () => {
    const harness = fakeApi();
    const onUnauthenticated = jest.fn();
    harness.read.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    const client = createDesktopSettingsClient(
      harness.api,
      () => Promise.resolve('acct-1'),
      {
        onUnauthenticated,
      },
    );
    const failure: unknown = await client.read('settings.bootstrap', {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SettingsOperationError);
    expect(failure).toMatchObject({ code: 'unauthenticated' });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed result as invalid_response', async () => {
    const harness = fakeApi();
    harness.read.mockResolvedValueOnce({ ok: true, result: { version: 2 } });
    const client = createDesktopSettingsClient(harness.api, () =>
      Promise.resolve('acct-1'),
    );
    await expect(client.read('settings.bootstrap', {})).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('refuses invalid input before calling main', async () => {
    const harness = fakeApi();
    const client = createDesktopSettingsClient(harness.api, () =>
      Promise.resolve('acct-1'),
    );
    await expect(
      client.read('settings.bootstrap', { organizationId: '../../x' }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(harness.read).not.toHaveBeenCalled();
  });

  it('sends an upload file to main as bytes and its declared type', async () => {
    const harness = fakeApi();
    const write = jest.fn(() =>
      Promise.resolve({
        ok: true as const,
        result: { image: 'https://x/a.png' },
      }),
    );
    const client = createDesktopSettingsClient({ ...harness.api, write }, () =>
      Promise.resolve('acct-1'),
    );
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    // jsdom's Blob has no arrayBuffer(); Chromium's does.
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          const reader = new FileReader();
          reader.onload = (): void => {
            if (reader.result instanceof ArrayBuffer) resolve(reader.result);
          };
          reader.readAsArrayBuffer(file);
        }),
    });
    await expect(
      client.write('account.avatar.upload', {
        mimeType: 'image/png',
        size: 3,
        file,
      }),
    ).resolves.toEqual({ image: 'https://x/a.png' });
    expect(write).toHaveBeenCalledWith({
      accountId: 'acct-1',
      operation: 'account.avatar.upload',
      input: {
        mimeType: 'image/png',
        size: 3,
        file: { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
      },
    });
  });

  describe('subscriptions', () => {
    let ids = 0;
    const randomId = (): string => `sub-${(ids += 1)}`;

    it('routes events by subscription and dedupes feed items', async () => {
      const harness = fakeApi();
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve('acct-1'),
        {
          randomId,
        },
      );
      const first: SettingsEvent[] = [];
      const second: SettingsEvent[] = [];
      client.subscribe(
        { kind: 'organization-feed', organizationId: 'org-1' },
        (e) => first.push(e),
      );
      client.subscribe(
        { kind: 'organization-feed', organizationId: 'org-2' },
        (e) => second.push(e),
      );
      await settle();
      const [firstId, secondId] = harness.subscribe.mock.calls.map(
        ([request]: [{ subscriptionId: string }]) => request.subscriptionId,
      );
      expect(harness.listenerCount()).toBe(1);

      harness.emit({ subscriptionId: String(firstId), event: item(1) });
      harness.emit({ subscriptionId: String(firstId), event: item(1) });
      harness.emit({
        subscriptionId: String(firstId),
        event: item(2, 'event-1'),
      });
      harness.emit({ subscriptionId: String(firstId), event: item(3) });
      harness.emit({
        subscriptionId: String(secondId),
        event: { type: 'reconnected', organizationId: 'org-2' },
      });
      harness.emit({ subscriptionId: 'someone-else', event: item(9) });

      expect(first).toEqual([item(1), item(3)]);
      expect(second).toEqual([
        { type: 'reconnected', organizationId: 'org-2' },
      ]);
    });

    it('passes the last seen sequence when the scope is subscribed again', async () => {
      const harness = fakeApi();
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve('acct-1'),
        {
          randomId,
        },
      );
      const scope = {
        kind: 'organization-feed' as const,
        organizationId: 'org-1',
      };
      const stop = client.subscribe(scope, () => undefined);
      await settle();
      const firstRequest = harness.subscribe.mock.calls[0]?.[0];
      expect(firstRequest?.scope).toEqual(scope);
      harness.emit({
        subscriptionId: String(firstRequest?.subscriptionId),
        event: item(41),
      });
      stop();

      client.subscribe(scope, () => undefined);
      await settle();
      expect(harness.subscribe.mock.calls[1]?.[0].scope).toEqual({
        ...scope,
        lastSequence: 41,
      });
    });

    it('subscribes to credit-pool signals without a resume sequence', async () => {
      const harness = fakeApi();
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve('acct-1'),
        { randomId },
      );
      const received: SettingsEvent[] = [];
      const scope = { kind: 'credit-pool' as const };
      client.subscribe(scope, (event) => received.push(event));
      client.subscribe(scope, () => undefined);
      await settle();
      const [first, second] = harness.subscribe.mock.calls.map(
        ([request]: [{ subscriptionId: string; scope: unknown }]) => request,
      );
      expect(first?.scope).toEqual(scope);
      expect(second?.scope).toEqual(scope);
      harness.emit({
        subscriptionId: String(first?.subscriptionId),
        event: { type: 'credit.pool' },
      });
      expect(received).toEqual([{ type: 'credit.pool' }]);
    });

    it('unsubscribes once and stops delivering', async () => {
      const harness = fakeApi();
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve('acct-1'),
        {
          randomId,
        },
      );
      const received: SettingsEvent[] = [];
      const stop = client.subscribe(
        { kind: 'organization-feed', organizationId: 'org-1' },
        (event) => received.push(event),
      );
      await settle();
      const id = String(harness.subscribe.mock.calls[0]?.[0].subscriptionId);
      stop();
      stop();
      harness.emit({ subscriptionId: id, event: item(1) });
      expect(received).toEqual([]);
      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      expect(harness.unsubscribe).toHaveBeenCalledWith({ subscriptionId: id });
      expect(harness.listenerCount()).toBe(0);
    });

    it('reports a refused subscription as a disabled stream', async () => {
      const harness = fakeApi();
      harness.subscribe.mockResolvedValueOnce({
        ok: false,
        error: { code: 'forbidden' },
      });
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve('acct-1'),
        {
          randomId,
        },
      );
      const received: SettingsEvent[] = [];
      client.subscribe(
        { kind: 'organization-feed', organizationId: 'org-1' },
        (e) => received.push(e),
      );
      await settle();
      expect(received).toEqual([
        {
          type: 'state',
          organizationId: 'org-1',
          state: 'disabled',
          error: 'forbidden',
        },
      ]);
    });

    it('reports a signed-out subscription as expired without calling main', async () => {
      const harness = fakeApi();
      const client = createDesktopSettingsClient(
        harness.api,
        () => Promise.resolve(null),
        {
          randomId,
        },
      );
      const received: SettingsEvent[] = [];
      client.subscribe(
        { kind: 'organization-feed', organizationId: 'org-1' },
        (e) => received.push(e),
      );
      await settle();
      expect(harness.subscribe).not.toHaveBeenCalled();
      expect(received).toEqual([
        {
          type: 'state',
          organizationId: 'org-1',
          state: 'disabled',
          error: 'expired',
        },
      ]);
    });
  });
});

describe('cloud account id source', () => {
  function account(
    overrides: Partial<CanopyCloudAccountPublicState>,
  ): CanopyCloudAccountPublicState {
    return {
      read: 'ok',
      hasApiKey: true,
      authMode: 'oauth',
      account: { id: 'acct-1', email: 'person@example.com' },
      ...overrides,
    } as CanopyCloudAccountPublicState;
  }

  it('caches the signed-in id until the account changes', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(account({}))
      .mockResolvedValueOnce(
        account({ account: { id: 'acct-2', email: 'b@example.com' } } as never),
      );
    const source = createCanopyCloudAccountIdSource(load);
    await expect(source.get()).resolves.toBe('acct-1');
    await expect(source.get()).resolves.toBe('acct-1');
    expect(load).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    await expect(source.get()).resolves.toBe('acct-2');
  });

  it('reports no account for guests, sign-out and inconclusive reads', async () => {
    const guest = createCanopyCloudAccountIdSource(() =>
      Promise.resolve(account({ authMode: 'guest' })),
    );
    await expect(guest.get()).resolves.toBeNull();
    const signedOut = createCanopyCloudAccountIdSource(() =>
      Promise.resolve(account({ hasApiKey: false })),
    );
    await expect(signedOut.get()).resolves.toBeNull();
    const load = jest
      .fn()
      .mockResolvedValueOnce(account({ read: 'unavailable' } as never))
      .mockResolvedValueOnce(account({}));
    const inconclusive = createCanopyCloudAccountIdSource(load);
    await expect(inconclusive.get()).resolves.toBeNull();
    await expect(inconclusive.get()).resolves.toBe('acct-1');
  });
});
