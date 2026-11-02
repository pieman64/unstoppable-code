import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  SETTINGS_OPERATIONS,
  SettingsOperationError,
  defineSettingsWrite,
  settingsAcknowledgementSchema,
  type SettingsBootstrap,
  type SettingsEvent,
  type SettingsSubscriptionScope,
} from '@canopy/protocol/settings';
import { ACCOUNT_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-account';
import type { CanopyCloudCredentialContext } from '../../canopy-cloud/client';
import type { StrictAuthenticatedPortalResult } from '../../canopy-cloud/authenticated-portal';
import {
  createAccountOrganizationSettingsService,
  type AccountOrganizationSettingsDeps,
  type AccountOrganizationSettingsService,
  type SettingsBridgeSessionState,
  type SettingsSessionPort,
  type SettingsOrchestratedOperation,
  type SettingsWriteFollowUp,
} from '../account-organization-settings';

// Test-only entries: the shipped table has reads only until the organization
// and account entries land, so writes and uploads are exercised through these.
const TEST_OPERATIONS = {
  'test.write': defineSettingsWrite({
    transport: 'backend',
    input: z.strictObject({ organizationId: z.string().min(1) }),
    result: z.looseObject({ saved: z.literal(true) }),
    request: (input) => ({
      method: 'PATCH',
      path: `/api/test/${input.organizationId}`,
      body: input,
    }),
  }),
  'test.upload': defineSettingsWrite({
    transport: 'upload',
    input: z.strictObject({ organizationId: z.string().min(1) }),
    result: settingsAcknowledgementSchema,
    request: () => ({ method: 'POST', path: '/api/test/unused' }),
    upload: {
      maxBytes: 8,
      contentTypes: ['image/png'],
      sign: () => ({ method: 'POST', path: '/api/test/sign' }),
      commit: () => ({ method: 'POST', path: '/api/test/commit' }),
    },
  }),
};

// The real avatar entry, installed under its own name until the account
// table is merged into SETTINGS_OPERATIONS.
const INSTALLED_OPERATIONS: Record<string, unknown> = {
  ...TEST_OPERATIONS,
  'account.avatar.upload': ACCOUNT_SETTINGS_OPERATIONS['account.avatar.upload'],
};
const added: string[] = [];

beforeAll(() => {
  for (const [name, operation] of Object.entries(INSTALLED_OPERATIONS)) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_OPERATIONS, name))
      continue;
    Object.defineProperty(SETTINGS_OPERATIONS, name, {
      value: operation,
      configurable: true,
      enumerable: true,
    });
    added.push(name);
  }
});

afterAll(() => {
  for (const name of added) Reflect.deleteProperty(SETTINGS_OPERATIONS, name);
});

class FakeSession implements SettingsSessionPort {
  state: SettingsBridgeSessionState = 'ready';
  generation: number;
  readonly ensureReady = jest.fn<
    Promise<void>,
    [options?: { userInitiated?: boolean }]
  >(() => Promise.resolve());
  private readonly listeners = new Set<
    (state: SettingsBridgeSessionState) => void
  >();

  constructor(
    readonly accountId: string,
    generation = 1,
  ) {
    this.generation = generation;
  }

  onStateChange(
    listener: (state: SettingsBridgeSessionState) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  setState(state: SettingsBridgeSessionState): void {
    this.state = state;
    for (const listener of Array.from(this.listeners)) listener(state);
  }
}

class FakeSender extends EventEmitter {
  destroyed = false;
  readonly sent: Array<{ channel: string; message: unknown }> = [];

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, message: args[0] });
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

interface FakeStream {
  scope: SettingsSubscriptionScope;
  emit(event: SettingsEvent): void;
  close: jest.Mock;
}

function bootstrap(
  organizationIds: string[],
  viewerId = 'acct-1',
): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: viewerId, email: 'person@example.com', name: null },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: false,
    },
    organizations: organizationIds.map((id) => ({
      id,
      name: id,
      role: 'OWNER',
      isPersonal: false,
    })),
    organization: null,
  };
}

const CREDENTIALS: CanopyCloudCredentialContext = {
  baseUrl: 'https://cloud.example.com',
  apiKey: 'csk_test',
};

function setup(
  overrides: Partial<AccountOrganizationSettingsDeps<FakeSession>> = {},
): {
  service: AccountOrganizationSettingsService;
  state: { account: string | null; session: FakeSession };
  execute: jest.Mock;
  acquireSession: jest.Mock;
  openStrictPortalPage: jest.Mock<
    Promise<StrictAuthenticatedPortalResult>,
    [string, CanopyCloudCredentialContext]
  >;
  streams: FakeStream[];
  changeAccount(accountId: string | null): void;
} {
  const state = {
    account: 'acct-1' as string | null,
    session: new FakeSession('acct-1'),
  };
  const accountListeners = new Set<(accountId: string | null) => void>();
  const streams: FakeStream[] = [];
  const acquireSession = jest.fn((accountId: string): Promise<FakeSession> => {
    if (accountId !== state.account)
      return Promise.reject(
        new SettingsOperationError({ code: 'unauthenticated' }),
      );
    if (
      state.session.accountId !== accountId ||
      state.session.state === 'disposed'
    )
      state.session = new FakeSession(accountId, state.session.generation + 1);
    return Promise.resolve(state.session);
  });
  const execute = jest.fn(
    (_session: FakeSession, name: string): Promise<unknown> =>
      Promise.resolve(
        name === 'settings.bootstrap' ? bootstrap(['org-1']) : { saved: true },
      ),
  );
  const openStrictPortalPage = jest.fn<
    Promise<StrictAuthenticatedPortalResult>,
    [string, CanopyCloudCredentialContext]
  >(() => Promise.resolve({ ok: true }));
  const deps: AccountOrganizationSettingsDeps<FakeSession> = {
    acquireSession,
    execute,
    openFeedStream: (_session, scope, handlers) => {
      const stream: FakeStream = {
        scope,
        emit: (event) => handlers.onEvent(event),
        close: jest.fn(),
      };
      streams.push(stream);
      return stream;
    },
    credentials: (accountId) =>
      accountId === state.account
        ? Promise.resolve(CREDENTIALS)
        : Promise.reject(new Error('Account changed')),
    currentAccountId: () => Promise.resolve(state.account),
    currentSession: () => state.session,
    signedInAccountId: () => state.account,
    subscribeAccountChanges: (listener) => {
      accountListeners.add(listener);
      return (): void => {
        accountListeners.delete(listener);
      };
    },
    openStrictPortalPage,
    paymentHandoffAvailable: (accountId) =>
      Promise.resolve(accountId === state.account),
    randomId: () => '0f8fad5b-d9cb-469f-a165-70867728950e',
    ...overrides,
  };
  return {
    service: createAccountOrganizationSettingsService(deps),
    state,
    execute,
    acquireSession,
    openStrictPortalPage,
    streams,
    changeAccount: (accountId): void => {
      state.account = accountId;
      for (const listener of Array.from(accountListeners)) listener(accountId);
    },
  };
}

function feedItem(organizationId: string, sequence: number): SettingsEvent {
  return {
    type: 'feed.item',
    organizationId,
    sequence,
    eventId: `event-${organizationId}-${sequence}`,
    item: {
      id: `item-${sequence}`,
      type: 'summary',
    } as never,
  };
}

describe('account organization settings dispatch', () => {
  it('refuses an operation name that is not in the table', async () => {
    const { service, acquireSession, execute } = setup();
    const response = await service.read({
      accountId: 'acct-1',
      operation: 'https://evil.example.com/steal',
      input: {},
    });
    expect(response).toEqual({
      ok: false,
      error: { code: 'failed', message: 'Unknown settings operation' },
    });
    expect(acquireSession).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an operation of the wrong kind', async () => {
    const { service, execute } = setup();
    const asWrite = await service.write({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
    const asRead = await service.read({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(asWrite.ok).toBe(false);
    expect(asRead.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses oversized input before acquiring a session or parsing', async () => {
    const { service, acquireSession, execute } = setup();
    const response = await service.read({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: { organizationId: 'x'.repeat(70 * 1024) },
    });
    expect(response).toEqual({
      ok: false,
      error: { code: 'failed', message: 'Input too large' },
    });
    expect(acquireSession).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects input that tries to choose a URL, method, or headers', async () => {
    const { service, execute } = setup();
    const response = await service.read({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {
        url: 'https://evil.example.com',
        method: 'DELETE',
        headers: { Authorization: 'Bearer x' },
      },
    });
    expect(response).toEqual({
      ok: false,
      error: { code: 'failed', message: 'Invalid input' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a read as a user-initiated call through the bridge session', async () => {
    const { service, execute, state } = setup();
    const response = await service.read({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: { organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: true, result: bootstrap(['org-1']) });
    expect(state.session.ensureReady).toHaveBeenCalledWith({
      userInitiated: true,
    });
    expect(execute).toHaveBeenCalledWith(
      state.session,
      'settings.bootstrap',
      { organizationId: 'org-1' },
      undefined,
    );
  });

  it('reports unauthenticated for an account that is not signed in', async () => {
    const { service, execute } = setup();
    const response = await service.read({
      accountId: 'acct-2',
      operation: 'settings.bootstrap',
      input: {},
    });
    expect(response).toEqual({ ok: false, error: { code: 'unauthenticated' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('discards a result when the account changed while it was in flight', async () => {
    const harness = setup();
    harness.execute.mockImplementationOnce(() => {
      harness.changeAccount('acct-2');
      return Promise.resolve(bootstrap(['org-1']));
    });
    const response = await harness.service.read({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
    expect(response).toEqual({ ok: false, error: { code: 'expired' } });
  });

  it('fences a completed write on memory, not on another credential read', async () => {
    const currentAccountId = jest.fn(() =>
      Promise.resolve<string | null>(null),
    );
    const harness = setup({ currentAccountId });
    harness.execute.mockImplementationOnce(() => {
      // Credential reads after the write would now fail transiently.
      harness.acquireSession.mockRejectedValue(
        new SettingsOperationError({ code: 'unauthenticated' }),
      );
      return Promise.resolve({ saved: true });
    });
    const response = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: true, result: { saved: true } });
    expect(harness.acquireSession).toHaveBeenCalledTimes(1);
    expect(currentAccountId).not.toHaveBeenCalled();
  });

  it('treats a missing in-memory account as inconclusive, not signed out', async () => {
    const harness = setup({ signedInAccountId: () => undefined });
    const response = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: true, result: { saved: true } });
  });

  it.each([
    ['write', 'test.write', 'uncertain'],
    ['read', 'settings.bootstrap', 'expired'],
  ] as const)(
    'fences a %s on the in-memory account while the session stays live',
    async (kind, operation, code) => {
      const harness = setup();
      harness.execute.mockImplementationOnce(() => {
        // The cache moved to another account; no disposal has run yet.
        harness.state.account = 'acct-2';
        return Promise.resolve({ saved: true });
      });
      const request = {
        accountId: 'acct-1',
        operation,
        input: kind === 'write' ? { organizationId: 'org-1' } : {},
      };
      const response =
        kind === 'write'
          ? await harness.service.write(request)
          : await harness.service.read(request);
      expect(response).toEqual({ ok: false, error: { code } });
    },
  );

  it('reports a write that completed while the session generation changed as uncertain', async () => {
    const harness = setup();
    harness.execute.mockImplementationOnce(() => {
      harness.state.session.setState('disposed');
      return Promise.resolve({ saved: true });
    });
    const response = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    // The write may have landed, so the user is asked to check, not told the
    // session ended.
    expect(response).toEqual({ ok: false, error: { code: 'uncertain' } });
  });

  it('never retries a write and reports an unknown write failure as uncertain', async () => {
    const harness = setup();
    harness.execute.mockRejectedValueOnce(new Error('socket hang up'));
    const response = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: false, error: { code: 'uncertain' } });
    expect(harness.execute).toHaveBeenCalledTimes(1);

    harness.execute.mockRejectedValueOnce(
      new SettingsOperationError({ code: 'forbidden', status: 403 }),
    );
    const refused = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown read failure as failed', async () => {
    const harness = setup();
    harness.execute.mockRejectedValueOnce(new Error('boom'));
    const response = await harness.service.read({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
    expect(response).toEqual({ ok: false, error: { code: 'failed' } });
  });

  describe('uploads', () => {
    it('refuses an oversized file before any session or network work', async () => {
      const { service, acquireSession, execute } = setup();
      const response = await service.write({
        accountId: 'acct-1',
        operation: 'test.upload',
        input: {
          organizationId: 'org-1',
          file: { bytes: new Uint8Array(9), contentType: 'image/png' },
        },
      });
      expect(response).toEqual({
        ok: false,
        error: { code: 'failed', message: 'Upload too large' },
      });
      expect(acquireSession).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses an undeclared content type', async () => {
      const { service, execute } = setup();
      const response = await service.write({
        accountId: 'acct-1',
        operation: 'test.upload',
        input: {
          organizationId: 'org-1',
          file: { bytes: new Uint8Array(4), contentType: 'text/html' },
        },
      });
      expect(response.ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses an avatar whose declared size or type differs from the bytes', async () => {
      const { service, execute } = setup();
      const bytes = new Uint8Array(16);
      for (const declared of [
        { mimeType: 'image/png', size: 17 },
        { mimeType: 'image/jpeg', size: 16 },
      ]) {
        const response = await service.write({
          accountId: 'acct-1',
          operation: 'account.avatar.upload',
          input: { ...declared, file: { bytes, contentType: 'image/png' } },
        });
        expect(response).toEqual({
          ok: false,
          error: { code: 'failed', message: 'Invalid upload file' },
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('uploads an avatar whose declaration matches the bytes', async () => {
      const { service, execute, state } = setup();
      execute.mockResolvedValueOnce({ image: 'https://cdn.example.com/a.png' });
      const bytes = new Uint8Array(16);
      const response = await service.write({
        accountId: 'acct-1',
        operation: 'account.avatar.upload',
        input: {
          mimeType: 'image/png',
          size: 16,
          file: { bytes, contentType: 'IMAGE/PNG' },
        },
      });
      expect(response.ok).toBe(true);
      expect(execute).toHaveBeenCalledWith(
        state.session,
        'account.avatar.upload',
        { mimeType: 'image/png', size: 16 },
        { uploadBytes: bytes, uploadContentType: 'image/png' },
      );
    });

    it('passes the bytes separately from the validated input', async () => {
      const { service, execute, state } = setup();
      execute.mockResolvedValueOnce(null);
      const bytes = new Uint8Array([1, 2, 3]);
      const response = await service.write({
        accountId: 'acct-1',
        operation: 'test.upload',
        input: {
          organizationId: 'org-1',
          file: { bytes, contentType: 'image/png' },
        },
      });
      expect(response).toEqual({ ok: true, result: null });
      expect(execute).toHaveBeenCalledWith(
        state.session,
        'test.upload',
        { organizationId: 'org-1' },
        { uploadBytes: bytes, uploadContentType: 'image/png' },
      );
    });
  });

  it('routes a call through existing orchestration and validates its result', async () => {
    const orchestrated = jest.fn(() => Promise.resolve({ saved: true }));
    const harness = setup({
      resolveOrchestrated: (name: string) =>
        name === 'test.write' ? orchestrated : null,
    });
    const response = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: true, result: { saved: true } });
    expect(orchestrated).toHaveBeenCalledTimes(1);
    expect(harness.execute).not.toHaveBeenCalled();

    orchestrated.mockResolvedValueOnce({ saved: 'maybe' } as never);
    const malformed = await harness.service.write({
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    });
    expect(malformed).toEqual({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });
});

describe('settings write follow-ups', () => {
  const request = {
    accountId: 'acct-1',
    operation: 'test.write',
    input: { organizationId: 'org-1' },
  };

  it.each([false, true])(
    'awaits the validated follow-up (orchestrated: %s)',
    async (orchestrated) => {
      let finish!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const followUp = jest.fn(() => {
        started();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const resolveWriteFollowUp = jest.fn(() => followUp);
      const harness = setup({
        resolveWriteFollowUp,
        ...(orchestrated
          ? {
              resolveOrchestrated:
                (): SettingsOrchestratedOperation => (): Promise<unknown> =>
                  Promise.resolve({ saved: true }),
            }
          : {}),
      });
      let settled = false;
      const pending = harness.service.write(request).then((response) => {
        settled = true;
        return response;
      });
      await ready;
      expect(settled).toBe(false);
      expect(resolveWriteFollowUp).toHaveBeenCalledWith(
        'test.write',
        request.input,
      );
      expect(followUp).toHaveBeenCalledTimes(1);
      finish();
      await expect(pending).resolves.toEqual({
        ok: true,
        result: { saved: true },
      });
    },
  );

  it.each(['resolver', 'follow-up'])(
    'preserves success when the %s fails without logging sensitive errors',
    async (where) => {
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const harness = setup({
          resolveWriteFollowUp: (): SettingsWriteFollowUp => {
            if (where === 'resolver') throw new Error('credential-secret');
            return (): Promise<void> =>
              Promise.reject(new Error('credential-secret'));
          },
        });
        await expect(harness.service.write(request)).resolves.toEqual({
          ok: true,
          result: { saved: true },
        });
        expect(harness.execute).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('follow-up'),
        );
        expect(stderr.mock.calls.flat().join('')).not.toContain(
          'credential-secret',
        );
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it.each([false, true])(
    'skips reads, invalid input/results and rejected execution (orchestrated: %s)',
    async (orchestrated) => {
      const resolveWriteFollowUp = jest.fn(
        (): SettingsWriteFollowUp => (): Promise<void> => Promise.resolve(),
      );
      const run = jest.fn<Promise<unknown>, []>();
      const harness = setup({
        resolveWriteFollowUp,
        ...(orchestrated
          ? { resolveOrchestrated: (): SettingsOrchestratedOperation => run }
          : {}),
      });
      if (orchestrated) run.mockResolvedValueOnce(bootstrap(['org-1']));
      await harness.service.read({
        accountId: 'acct-1',
        operation: 'settings.bootstrap',
        input: {},
      });
      await harness.service.write({ ...request, input: {} });
      const execution = orchestrated ? run : harness.execute;
      execution.mockResolvedValueOnce({ saved: false });
      await expect(harness.service.write(request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_response' },
      });
      execution.mockRejectedValueOnce(
        new SettingsOperationError({ code: 'forbidden' }),
      );
      await harness.service.write(request);
      expect(resolveWriteFollowUp).not.toHaveBeenCalled();
    },
  );

  it('does not resolve a follow-up for a session invalidated during execution', async () => {
    const resolveWriteFollowUp = jest.fn();
    const harness = setup({ resolveWriteFollowUp });
    harness.execute.mockImplementationOnce((): Promise<unknown> => {
      harness.state.session.setState('disposed');
      return Promise.resolve({ saved: true });
    });
    await expect(harness.service.write(request)).resolves.toMatchObject({
      error: { code: 'uncertain' },
    });
    expect(resolveWriteFollowUp).not.toHaveBeenCalled();
  });

  it.each(['same-account', 'replacement', 'disposed'])(
    'fences the session after refresh: %s',
    async (change) => {
      const harness = setup({
        resolveWriteFollowUp:
          (): SettingsWriteFollowUp => (): Promise<void> => {
            if (change === 'replacement') harness.changeAccount('acct-2');
            if (change === 'disposed')
              harness.state.session.setState('disposed');
            return Promise.resolve();
          },
      });
      await expect(harness.service.write(request)).resolves.toEqual(
        change === 'same-account'
          ? { ok: true, result: { saved: true } }
          : { ok: false, error: { code: 'uncertain' } },
      );
    },
  );
});

describe('account organization settings streams', () => {
  function messagesFor(sender: FakeSender): unknown[] {
    return sender.sent
      .filter(
        ({ channel }) =>
          channel === IPC_CHANNELS.accountOrganizationSettingsEvent,
      )
      .map(({ message }) => message);
  }

  it('delivers each window only its own subscription events', async () => {
    const harness = setup();
    const first = new FakeSender(1);
    const second = new FakeSender(2);
    await expect(
      harness.service.subscribe(first, {
        accountId: 'acct-1',
        subscriptionId: 'sub-a',
        scope: { kind: 'organization-feed', organizationId: 'org-1' },
      }),
    ).resolves.toEqual({ ok: true, result: null });
    await harness.service.subscribe(second, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-2' },
    });
    expect(harness.streams).toHaveLength(2);
    expect(harness.state.session.ensureReady).toHaveBeenCalledWith({
      userInitiated: false,
    });

    const [orgOne, orgTwo] = harness.streams;
    orgOne?.emit(feedItem('org-1', 1));
    orgTwo?.emit(feedItem('org-2', 7));

    expect(messagesFor(first)).toEqual([
      { subscriptionId: 'sub-a', event: feedItem('org-1', 1) },
    ]);
    expect(messagesFor(second)).toEqual([
      { subscriptionId: 'sub-a', event: feedItem('org-2', 7) },
    ]);
  });

  it('closes the stream on unsubscribe and stops forwarding', async () => {
    const harness = setup();
    const sender = new FakeSender(1);
    await harness.service.subscribe(sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    harness.service.unsubscribe(sender, 'sub-a');
    harness.service.unsubscribe(sender, 'sub-a');
    const stream = harness.streams[0];
    expect(stream?.close).toHaveBeenCalledTimes(1);
    stream?.emit(feedItem('org-1', 2));
    expect(messagesFor(sender)).toEqual([]);
    expect(harness.service.subscriptionCount()).toBe(0);
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it('another window cannot unsubscribe a stream it does not own', async () => {
    const harness = setup();
    const owner = new FakeSender(1);
    await harness.service.subscribe(owner, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    harness.service.unsubscribe(new FakeSender(2), 'sub-a');
    expect(harness.streams[0]?.close).not.toHaveBeenCalled();
  });

  it('disposes every stream of a window when it is destroyed', async () => {
    const harness = setup();
    const sender = new FakeSender(1);
    for (const id of ['sub-a', 'sub-b'])
      await harness.service.subscribe(sender, {
        accountId: 'acct-1',
        subscriptionId: id,
        scope: { kind: 'organization-feed', organizationId: 'org-1' },
      });
    sender.destroy();
    expect(
      harness.streams.map((stream) => stream.close.mock.calls.length),
    ).toEqual([1, 1]);
    expect(harness.service.subscriptionCount()).toBe(0);
  });

  it('disposes streams when the page navigates', async () => {
    const harness = setup();
    const sender = new FakeSender(1);
    await harness.service.subscribe(sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    sender.emit('did-navigate');
    expect(harness.streams[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('ends streams on account change and on session disposal', async () => {
    const harness = setup();
    const sender = new FakeSender(1);
    await harness.service.subscribe(sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    harness.state.session.setState('disposed');
    expect(harness.streams[0]?.close).toHaveBeenCalledTimes(1);
    expect(messagesFor(sender)).toEqual([
      {
        subscriptionId: 'sub-a',
        event: {
          type: 'state',
          organizationId: 'org-1',
          state: 'disabled',
          error: 'expired',
        },
      },
    ]);

    await harness.service.subscribe(sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-b',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    harness.changeAccount('acct-2');
    expect(harness.streams[1]?.close).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending stream when the window unsubscribes during setup', async () => {
    const harness = setup();
    const sender = new FakeSender(1);
    let release: () => void = () => undefined;
    harness.state.session.ensureReady.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const pending = harness.service.subscribe(sender, {
      accountId: 'acct-1',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.service.unsubscribe(sender, 'sub-a');
    release();
    await expect(pending).resolves.toEqual({ ok: true, result: null });
    expect(harness.streams).toHaveLength(0);
  });

  it('refuses a subscription for another account', async () => {
    const harness = setup();
    const response = await harness.service.subscribe(new FakeSender(1), {
      accountId: 'acct-2',
      subscriptionId: 'sub-a',
      scope: { kind: 'organization-feed', organizationId: 'org-1' },
    });
    expect(response).toEqual({ ok: false, error: { code: 'unauthenticated' } });
    expect(harness.streams).toHaveLength(0);
    expect(harness.service.subscriptionCount()).toBe(0);
  });
});

describe('account organization settings payment handoff', () => {
  const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('defaults legacy unlock attribution to desktop and returns the main id', async () => {
    const harness = setup();
    await expect(
      harness.service.paymentHandoff({
        accountId: 'acct-1',
        owner: { kind: 'personal' },
        intent: { kind: 'top-up', reason: 'unlock_models' },
      }),
    ).resolves.toEqual({ ok: true, requestId: REQUEST_ID });
    const url = new URL(
      String(harness.openStrictPortalPage.mock.calls[0]?.[0]),
      'https://billing.invalid',
    );
    expect(url.searchParams.get('source')).toBe('desktop');
    expect(url.searchParams.get('requestId')).toBe(REQUEST_ID);
  });

  it.each([
    'unavailable',
    'identity_changed',
    'failed',
    'browser_failed',
  ] as const)('does not return an unlock id after %s', async (reason) => {
    const harness = setup();
    harness.openStrictPortalPage.mockResolvedValueOnce({ ok: false, reason });
    await expect(
      harness.service.paymentHandoff({
        accountId: 'acct-1',
        owner: { kind: 'personal' },
        intent: { kind: 'top-up', reason: 'unlock_models' },
      }),
    ).resolves.toEqual({ ok: false, reason });
    expect(harness.openStrictPortalPage).toHaveBeenCalledTimes(1);
  });

  it('keeps correlation local to overlapping attempts that settle out of order', async () => {
    let sequence = 0;
    let finishFirst:
      | ((value: StrictAuthenticatedPortalResult) => void)
      | undefined;
    let startedFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstResult = new Promise<StrictAuthenticatedPortalResult>(
      (resolve) => {
        finishFirst = resolve;
      },
    );
    const harness = setup({ randomId: () => `request-${++sequence}` });
    harness.openStrictPortalPage.mockImplementationOnce(() => {
      startedFirst?.();
      return firstResult;
    });
    const request = {
      accountId: 'acct-1',
      owner: { kind: 'personal' as const },
      intent: { kind: 'top-up' as const, reason: 'unlock_models' as const },
    };
    const first = harness.service.paymentHandoff(request);
    await firstStarted;
    await expect(harness.service.paymentHandoff(request)).resolves.toEqual({
      ok: true,
      requestId: 'request-2',
    });
    finishFirst?.({ ok: true });
    await expect(first).resolves.toEqual({ ok: true, requestId: 'request-1' });
    expect(
      harness.openStrictPortalPage.mock.calls.map(([path]) =>
        new URL(path, 'https://billing.invalid').searchParams.get('requestId'),
      ),
    ).toEqual(['request-1', 'request-2']);
  });

  it.each([
    { kind: 'personal' } as const,
    { kind: 'organization', organizationId: 'org-1' } as const,
  ])('correlates an unlock opening for %j', async (owner) => {
    const harness = setup();
    const request = {
      accountId: 'acct-1',
      owner,
      intent: {
        kind: 'top-up' as const,
        reason: 'unlock_models' as const,
        source: 'picker' as const,
        modelId: 'provider/model:1',
        chatId: 'chat-1',
      },
    };
    const result = await harness.service.paymentHandoff(request);
    const url = new URL(
      String(harness.openStrictPortalPage.mock.calls[0]?.[0]),
      'https://billing.invalid',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      source: 'picker',
      modelId: 'provider/model:1',
      chatId: 'chat-1',
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({
      ok: true,
      requestId: url.searchParams.get('requestId'),
    });
  });

  it('opens the personal billing page with a top-up intent', async () => {
    const harness = setup();
    const result = await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'personal' },
      intent: { kind: 'top-up', reason: 'credits', amountUsd: 25 },
    });
    expect(result).toEqual({ ok: true });
    const [path, credentials] =
      harness.openStrictPortalPage.mock.calls[0] ?? [];
    const url = new URL(String(path), 'https://billing.invalid');
    expect(url.pathname).toBe('/account/billing');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      topUp: '1',
      reason: 'credits',
      source: 'desktop',
      amountUsd: '25',
      requestId: REQUEST_ID,
    });
    expect(credentials).toBe(CREDENTIALS);
    // A personal handoff needs no membership read.
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('opens the personal billing page with a modal intent', async () => {
    const harness = setup();
    await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'personal' },
      intent: { kind: 'modal', modal: 'payment-method' },
    });
    expect(harness.openStrictPortalPage.mock.calls[0]?.[0]).toBe(
      `/account/billing?paymentModal=payment-method&paymentRequestId=${REQUEST_ID}`,
    );
  });

  it('opens an organization billing tab after checking membership', async () => {
    const harness = setup();
    const result = await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'organization', organizationId: 'org-1' },
      intent: { kind: 'modal', modal: 'auto-top-up' },
    });
    expect(result).toEqual({ ok: true });
    expect(harness.execute).toHaveBeenCalledWith(
      harness.state.session,
      'settings.bootstrap',
      {},
    );
    expect(harness.openStrictPortalPage.mock.calls[0]?.[0]).toBe(
      `/organization/org-1/settings?tab=billing&paymentModal=auto-top-up&paymentRequestId=${REQUEST_ID}`,
    );
  });

  it('refuses an organization that is not in the current membership', async () => {
    const harness = setup();
    harness.execute.mockResolvedValueOnce(bootstrap(['org-2']));
    const result = await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'organization', organizationId: 'org-1' },
      intent: { kind: 'top-up', reason: 'credits' },
    });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(harness.openStrictPortalPage).not.toHaveBeenCalled();
  });

  it('cancels with identity_changed when the account changes before opening', async () => {
    const harness = setup();
    harness.execute.mockImplementationOnce(() => {
      harness.changeAccount('acct-2');
      return Promise.resolve(bootstrap(['org-1']));
    });
    const result = await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'organization', organizationId: 'org-1' },
      intent: { kind: 'modal', modal: 'subscription', plan: 'business' },
    });
    expect(result).toEqual({ ok: false, reason: 'identity_changed' });
    expect(harness.openStrictPortalPage).not.toHaveBeenCalled();
  });

  it('reports unavailable when the handoff is off', async () => {
    const harness = setup({
      paymentHandoffAvailable: () => Promise.resolve(false),
    });
    const result = await harness.service.paymentHandoff({
      accountId: 'acct-1',
      owner: { kind: 'personal' },
      intent: { kind: 'top-up', reason: 'credits' },
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(harness.openStrictPortalPage).not.toHaveBeenCalled();
    await expect(
      harness.service.paymentHandoffAvailability('acct-1'),
    ).resolves.toEqual({ available: false });
  });

  it('passes strict-mode failures through', async () => {
    const harness = setup();
    harness.openStrictPortalPage.mockResolvedValueOnce({
      ok: false,
      reason: 'browser_failed',
    });
    await expect(
      harness.service.paymentHandoff({
        accountId: 'acct-1',
        owner: { kind: 'personal' },
        intent: { kind: 'modal', modal: 'payment-method' },
      }),
    ).resolves.toEqual({ ok: false, reason: 'browser_failed' });
  });

  it('reports availability for the signed-in account', async () => {
    const harness = setup();
    await expect(
      harness.service.paymentHandoffAvailability('acct-1'),
    ).resolves.toEqual({ available: true });
  });
});

describe('post-success settings observer', () => {
  it('observes validated results before unrelated follow-ups and isolates throws', async () => {
    const order: string[] = [];
    const observeWrite = jest.fn(() => {
      order.push('observe');
      throw new Error('telemetry');
    });
    const { service } = setup({
      observeWrite,
      resolveWriteFollowUp: () => (): Promise<void> => {
        order.push('refresh');
        throw new Error('refresh');
      },
    });
    const request = {
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    };
    await expect(service.write(request)).resolves.toEqual({
      ok: true,
      result: { saved: true },
    });
    expect(order).toEqual(['observe', 'refresh']);
    expect(observeWrite).toHaveBeenCalledWith(
      'test.write',
      { organizationId: 'org-1' },
      { saved: true },
      'acct-1',
    );
    service.dispose();
  });
  it('does not observe failures or malformed successful results', async () => {
    const observeWrite = jest.fn();
    const { service, execute } = setup({ observeWrite });
    const request = {
      accountId: 'acct-1',
      operation: 'test.write',
      input: { organizationId: 'org-1' },
    };
    execute.mockResolvedValueOnce({ saved: false });
    expect(await service.write(request)).toEqual({
      ok: false,
      error: { code: 'invalid_response' },
    });
    execute.mockRejectedValueOnce(
      new SettingsOperationError({ code: 'failed' }),
    );
    await service.write(request);
    expect(observeWrite).not.toHaveBeenCalled();
    service.dispose();
  });
});
