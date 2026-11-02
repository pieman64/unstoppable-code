import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import type { ConfirmedProviderAuthEvent } from '../auth/provider-auth-state';
import type { ConfirmedCursorAccountEvent } from '../cursor/connection';
import { startProviderAccountConnectTelemetry } from '../lib/desktop-telemetry';
import { recordPostHogProviderConnection } from '../lib/anonymous-id';
import {
  observeProviderConnection,
  resetProviderConnectionEventsForTests,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';

jest.mock('../lib/anonymous-id', () => ({
  recordPostHogProviderConnection: jest.fn(),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

const flushScheduledTelemetry = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function startWithFeeds(): {
  emitProvider: (event: ConfirmedProviderAuthEvent) => void;
  emitCursor: (event: ConfirmedCursorAccountEvent) => void;
  unsubscribeProvider: jest.Mock;
  unsubscribeCursor: jest.Mock;
  stop: () => void;
} {
  let emitProvider: (event: ConfirmedProviderAuthEvent) => void = () => {};
  let emitCursor: (event: ConfirmedCursorAccountEvent) => void = () => {};
  const unsubscribeProvider = jest.fn();
  const unsubscribeCursor = jest.fn();
  const stop = startProviderAccountConnectTelemetry({
    subscribeProviderAuth: (listener) => {
      emitProvider = listener;
      return unsubscribeProvider;
    },
    subscribeCursorAccount: (listener) => {
      emitCursor = listener;
      return unsubscribeCursor;
    },
  });
  return {
    emitProvider: (event) => emitProvider(event),
    emitCursor: (event) => emitCursor(event),
    unsubscribeProvider,
    unsubscribeCursor,
    stop,
  };
}

// Every account detail the app knows about a confirmed sign-in.
const signedInStatus: AgentProviderAuthStatus = {
  authenticated: true,
  accountLabel: 'person@example.com',
  accountEmail: 'person@example.com',
  accountKind: 'subscription',
  planType: 'max',
  detail: 'Signed in as person@example.com (Example Org)',
  error: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetProviderConnectionEventsForTests();
  jest.mocked(recordPostHogProviderConnection).mockResolvedValue({
    is_first_connection: false,
    first_connected_provider: 'unknown',
  });
});

describe('startProviderAccountConnectTelemetry', () => {
  it('does not count existing startup accounts as new connections', async () => {
    const feeds = startWithFeeds();
    feeds.emitProvider({
      provider: 'claude',
      status: signedInStatus,
      fingerprint: 'existing-account',
      connectSource: 'at_startup',
    });
    feeds.emitCursor({ connectSource: 'at_startup' });
    await flushScheduledTelemetry();
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    feeds.stop();
  });

  it.each([
    ['claude', 'in_app'],
    ['claude', 'external_change'],
    ['codex', 'in_app'],
    ['codex', 'external_change'],
  ] as const)(
    'records a %s %s sign-in with only provider and connect_source',
    async (provider, connectSource) => {
      const feeds = startWithFeeds();
      feeds.emitProvider({
        provider,
        status: signedInStatus,
        fingerprint: 'auth:subscription:person@example.com',
        connectSource,
      });
      await flushScheduledTelemetry();

      expect(startDesktopOperation).toHaveBeenCalledTimes(1);
      expect(succeedDesktopOperation).toHaveBeenCalledTimes(1);
      const [name, options] = jest.mocked(succeedDesktopOperation).mock
        .calls[0];
      expect(name).toBe('canopy.provider_account_connect');
      expect(options?.context).toEqual({
        provider,
        connect_source: connectSource,
        connection_method: 'native_login',
        is_first_connection: false,
        first_connected_provider: 'unknown',
      });
      expect(jest.mocked(startDesktopOperation).mock.calls[0]).toEqual([
        name,
        options,
      ]);
      // No account detail leaves the app, not even inside the operation key.
      expect(JSON.stringify(options)).not.toMatch(/person|example|max|Org/);
      feeds.stop();
    },
  );

  it.each(['in_app', 'external_change'] as const)(
    'records a Cursor %s sign-in',
    async (connectSource) => {
      const feeds = startWithFeeds();
      feeds.emitCursor({ connectSource });
      await flushScheduledTelemetry();

      expect(succeedDesktopOperation).toHaveBeenCalledWith(
        'canopy.provider_account_connect',
        expect.objectContaining({
          context: {
            provider: 'cursor',
            connect_source: connectSource,
            connection_method: 'native_login',
            is_first_connection: false,
            first_connected_provider: 'unknown',
          },
        }),
      );
      feeds.stop();
    },
  );

  it('distinguishes API-key authentication from a native subscription', async () => {
    const feeds = startWithFeeds();
    feeds.emitProvider({
      provider: 'codex',
      connectSource: 'in_app',
      fingerprint: 'private-api-key-revision',
      status: { ...signedInStatus, accountKind: 'api_key' },
    });
    await flushScheduledTelemetry();
    expect(
      jest.mocked(succeedDesktopOperation).mock.calls[0]?.[1]?.context,
    ).toMatchObject({ provider: 'codex', connection_method: 'api_key' });
    expect(
      JSON.stringify(jest.mocked(succeedDesktopOperation).mock.calls),
    ).not.toContain('private-api-key');
    feeds.stop();
  });

  it.each(['copilot', 'opencode', 'ollama', 'model_gateway'] as const)(
    'records %s setup and categorized failures through the common feed',
    async (provider) => {
      const feeds = startWithFeeds();
      observeProviderConnection({
        provider,
        fingerprint: 'private-identity',
        connectionMethod: 'api_key',
        via: 'in_app',
      });
      await withProviderConnectionAttempt(provider, 'api_key', undefined, () =>
        Promise.reject(
          Object.assign(new Error('private credential'), {
            name: 'TimeoutError',
          }),
        ),
      ).catch(() => undefined);
      await flushScheduledTelemetry();
      expect(
        jest
          .mocked(succeedDesktopOperation)
          .mock.calls.find(
            ([name]) => name === 'canopy.provider_account_connect',
          )?.[1]?.context,
      ).toMatchObject({ provider, connection_method: 'api_key' });
      expect(succeedDesktopOperation).toHaveBeenCalledWith(
        'canopy.provider_account_connect_fail',
        expect.objectContaining({
          context: {
            provider,
            connection_method: 'api_key',
            connect_source: 'in_app',
            failure_reason: 'timeout',
          },
        }),
      );
      expect(
        JSON.stringify(jest.mocked(succeedDesktopOperation).mock.calls),
      ).not.toContain('private');
      feeds.stop();
    },
  );

  it('records a legacy gateway baseline before a later Copilot connection', async () => {
    const feeds = startWithFeeds();
    observeProviderConnection({
      provider: 'model_gateway',
      connectionMethod: 'api_key',
      via: 'read',
      fingerprint: 'legacy-key',
      baselineOnly: true,
    });
    await flushScheduledTelemetry();
    expect(recordPostHogProviderConnection).toHaveBeenCalledWith(
      'model_gateway',
      true,
    );
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    observeProviderConnection({
      provider: 'copilot',
      connectionMethod: 'native_login',
      via: 'in_app',
      fingerprint: 'copilot-account',
    });
    await flushScheduledTelemetry();
    expect(recordPostHogProviderConnection).toHaveBeenNthCalledWith(
      2,
      'copilot',
      false,
    );
    expect(succeedDesktopOperation).toHaveBeenCalledTimes(1);
    expect(jest.mocked(succeedDesktopOperation).mock.calls[0]?.[0]).toBe(
      'canopy.provider_account_connect',
    );
    expect(
      jest.mocked(succeedDesktopOperation).mock.calls[0]?.[1]?.context,
    ).toMatchObject({
      provider: 'copilot',
      is_first_connection: false,
      first_connected_provider: 'unknown',
    });
    feeds.stop();
  });

  it('attaches the durable first-provider claim to a successful connection', async () => {
    jest.mocked(recordPostHogProviderConnection).mockResolvedValueOnce({
      is_first_connection: true,
      first_connected_provider: 'copilot',
    });
    const feeds = startWithFeeds();
    observeProviderConnection({
      provider: 'copilot',
      connectionMethod: 'native_login',
      via: 'in_app',
      fingerprint: 'private-account',
    });
    await flushScheduledTelemetry();
    expect(
      jest.mocked(succeedDesktopOperation).mock.calls[0]?.[1]?.context,
    ).toEqual({
      provider: 'copilot',
      connection_method: 'native_login',
      connect_source: 'in_app',
      is_first_connection: true,
      first_connected_provider: 'copilot',
    });
    feeds.stop();
  });

  it('preserves a real connection even when first-provider storage is unavailable', async () => {
    jest
      .mocked(recordPostHogProviderConnection)
      .mockRejectedValue(new Error('private filesystem error'));
    const feeds = startWithFeeds();
    feeds.emitCursor({ connectSource: 'in_app' });
    await flushScheduledTelemetry();
    expect(succeedDesktopOperation).toHaveBeenCalledWith(
      'canopy.provider_account_connect',
      expect.objectContaining({
        context: {
          provider: 'cursor',
          connect_source: 'in_app',
          connection_method: 'native_login',
        },
      }),
    );
    feeds.stop();
  });

  it('stops listening to both feeds when disposed', () => {
    const feeds = startWithFeeds();
    feeds.stop();
    expect(feeds.unsubscribeProvider).toHaveBeenCalledTimes(1);
    expect(feeds.unsubscribeCursor).toHaveBeenCalledTimes(1);
  });
});
