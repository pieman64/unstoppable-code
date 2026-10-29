import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

interface FakeIpcEvent {
  sender: { id: number };
}

const handlers = new Map<
  string,
  (event: FakeIpcEvent, value: unknown) => Promise<unknown>
>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: FakeIpcEvent, value: unknown) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));

const mockService = {
  read: jest.fn(() => Promise.resolve({ ok: true, result: 'read' })),
  write: jest.fn(() => Promise.resolve({ ok: true, result: 'write' })),
  subscribe: jest.fn(() => Promise.resolve({ ok: true, result: null })),
  unsubscribe: jest.fn(),
  paymentHandoff: jest.fn(() => Promise.resolve({ ok: true })),
  paymentHandoffAvailability: jest.fn(() =>
    Promise.resolve({ available: true }),
  ),
};
const mockDisposeService = jest.fn<void, []>();
jest.mock('../../services/account-organization-settings-host', () => ({
  getAccountOrganizationSettingsService: (): unknown => mockService,
  disposeAccountOrganizationSettingsService: (): void => mockDisposeService(),
}));

const mockUninstallLifecycle = jest.fn();
const mockInstallLifecycle = jest.fn(() => mockUninstallLifecycle);
jest.mock(
  '../../canopy-cloud/settings-session',
  () => ({
    installSettingsBridgeLifecycle: (): (() => void) => mockInstallLifecycle(),
  }),
  { virtual: true },
);

let mockHostedSettingsEnabled = true;
jest.mock('../../services/hosted-settings-feature-flag', () => ({
  isHostedSettingsEnabled: (): boolean => mockHostedSettingsEnabled,
}));

import { registerAccountOrganizationSettingsHandlers } from '../account-organization-settings';

const event: FakeIpcEvent = { sender: { id: 7 } };

function handler(
  channel: string,
): (event: FakeIpcEvent, value: unknown) => Promise<unknown> {
  const registered = handlers.get(channel);
  if (registered === undefined) throw new Error(`No handler for ${channel}`);
  return registered;
}

async function flushImports(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('account organization settings IPC', () => {
  let close: () => void = () => undefined;
  let lifecycleInstalls = 0;

  beforeAll(async () => {
    close = registerAccountOrganizationSettingsHandlers();
    await flushImports();
    lifecycleInstalls = mockInstallLifecycle.mock.calls.length;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('installs the bridge lifecycle once and removes it on teardown', async () => {
    expect(handlers.size).toBe(6);
    expect(lifecycleInstalls).toBe(1);
    close();
    await flushImports();
    expect(mockUninstallLifecycle).toHaveBeenCalledTimes(1);
    expect(mockDisposeService).toHaveBeenCalledTimes(1);
  });

  it('refuses every hosted call while the hosted settings flag is off', async () => {
    mockHostedSettingsEnabled = false;
    try {
      const unavailable = {
        ok: false,
        error: {
          code: 'failed',
          message: 'Account and organization settings are unavailable',
        },
      };
      const operation = {
        accountId: 'acct-1',
        operation: 'settings.bootstrap',
        input: {},
      };
      await expect(
        handler(IPC_CHANNELS.accountOrganizationSettingsRead)(event, operation),
      ).resolves.toEqual(unavailable);
      await expect(
        handler(IPC_CHANNELS.accountOrganizationSettingsWrite)(
          event,
          operation,
        ),
      ).resolves.toEqual(unavailable);
      await expect(
        handler(IPC_CHANNELS.accountOrganizationSettingsSubscribe)(event, {
          accountId: 'acct-1',
          subscriptionId: 'sub-1',
          scope: { kind: 'credit-pool' },
        }),
      ).resolves.toEqual(unavailable);
      await expect(
        handler(
          IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability,
        )(event, { accountId: 'acct-1' }),
      ).resolves.toEqual({ available: false });
      expect(mockService.read).not.toHaveBeenCalled();
      expect(mockService.write).not.toHaveBeenCalled();
      expect(mockService.subscribe).not.toHaveBeenCalled();
      expect(mockService.paymentHandoffAvailability).not.toHaveBeenCalled();
    } finally {
      mockHostedSettingsEnabled = true;
    }
  });

  it('forwards a named read with only the validated envelope', async () => {
    await expect(
      handler(IPC_CHANNELS.accountOrganizationSettingsRead)(event, {
        accountId: 'acct-1',
        operation: 'settings.bootstrap',
        input: {},
      }),
    ).resolves.toEqual({ ok: true, result: 'read' });
    expect(mockService.read).toHaveBeenCalledWith({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
  });

  it('rejects a request that carries a URL, method, or headers', async () => {
    for (const channel of [
      IPC_CHANNELS.accountOrganizationSettingsRead,
      IPC_CHANNELS.accountOrganizationSettingsWrite,
    ]) {
      await expect(
        handler(channel)(event, {
          accountId: 'acct-1',
          operation: 'settings.bootstrap',
          input: {},
          url: 'https://evil.example.com',
          method: 'POST',
          headers: { Cookie: 'x' },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'failed', message: 'Invalid settings request' },
      });
    }
    expect(mockService.read).not.toHaveBeenCalled();
    expect(mockService.write).not.toHaveBeenCalled();
  });

  it('binds subscriptions to the calling window', async () => {
    const scope = { kind: 'organization-feed', organizationId: 'org-1' };
    await handler(IPC_CHANNELS.accountOrganizationSettingsSubscribe)(event, {
      accountId: 'acct-1',
      subscriptionId: 'sub-1',
      scope,
    });
    expect(mockService.subscribe).toHaveBeenCalledWith(event.sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-1',
      scope,
    });
    await handler(IPC_CHANNELS.accountOrganizationSettingsUnsubscribe)(event, {
      subscriptionId: 'sub-1',
    });
    expect(mockService.unsubscribe).toHaveBeenCalledWith(event.sender, 'sub-1');
  });

  it('accepts a credit-pool scope and refuses one that carries a sequence', async () => {
    const scope = { kind: 'credit-pool' };
    await handler(IPC_CHANNELS.accountOrganizationSettingsSubscribe)(event, {
      accountId: 'acct-1',
      subscriptionId: 'sub-1',
      scope,
    });
    expect(mockService.subscribe).toHaveBeenCalledWith(event.sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-1',
      scope,
    });
    mockService.subscribe.mockClear();
    await expect(
      handler(IPC_CHANNELS.accountOrganizationSettingsSubscribe)(event, {
        accountId: 'acct-1',
        subscriptionId: 'sub-2',
        scope: { kind: 'credit-pool', lastSequence: 3 },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(mockService.subscribe).not.toHaveBeenCalled();
  });

  it('refuses a malformed subscription scope', async () => {
    await expect(
      handler(IPC_CHANNELS.accountOrganizationSettingsSubscribe)(event, {
        accountId: 'acct-1',
        subscriptionId: 'sub-1',
        scope: { kind: 'organization-feed', organizationId: '../../admin' },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(mockService.subscribe).not.toHaveBeenCalled();
  });

  it('validates payment handoff requests and never accepts a request id', async () => {
    await expect(
      handler(IPC_CHANNELS.accountOrganizationSettingsPaymentHandoff)(event, {
        accountId: 'acct-1',
        owner: { kind: 'personal' },
        intent: { kind: 'modal', modal: 'payment-method', requestId: 'mine' },
      }),
    ).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(mockService.paymentHandoff).not.toHaveBeenCalled();

    await expect(
      handler(IPC_CHANNELS.accountOrganizationSettingsPaymentHandoff)(event, {
        accountId: 'acct-1',
        owner: { kind: 'organization', organizationId: 'org-1' },
        intent: { kind: 'top-up', reason: 'credits' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockService.paymentHandoff).toHaveBeenCalledWith({
      accountId: 'acct-1',
      owner: { kind: 'organization', organizationId: 'org-1' },
      intent: { kind: 'top-up', reason: 'credits' },
    });
  });

  it('answers availability for a valid account only', async () => {
    await expect(
      handler(
        IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability,
      )(event, { accountId: '' }),
    ).resolves.toEqual({ available: false });
    await expect(
      handler(
        IPC_CHANNELS.accountOrganizationSettingsPaymentHandoffAvailability,
      )(event, { accountId: 'acct-1' }),
    ).resolves.toEqual({ available: true });
  });
});
