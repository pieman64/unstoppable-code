import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import type { ConfirmedProviderAuthEvent } from '../auth/provider-auth-state';
import type { ConfirmedCursorAccountEvent } from '../cursor/connection';
import { startProviderAccountConnectTelemetry } from '../lib/desktop-telemetry';

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
});

describe('startProviderAccountConnectTelemetry', () => {
  it.each([
    ['claude', 'at_startup'],
    ['claude', 'in_app'],
    ['claude', 'external_change'],
    ['codex', 'at_startup'],
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

  it.each(['at_startup', 'in_app', 'external_change'] as const)(
    'records a Cursor %s sign-in',
    async (connectSource) => {
      const feeds = startWithFeeds();
      feeds.emitCursor({ connectSource });
      await flushScheduledTelemetry();

      expect(succeedDesktopOperation).toHaveBeenCalledWith(
        'canopy.provider_account_connect',
        expect.objectContaining({
          context: { provider: 'cursor', connect_source: connectSource },
        }),
      );
      feeds.stop();
    },
  );

  it('stops listening to both feeds when disposed', () => {
    const feeds = startWithFeeds();
    feeds.stop();
    expect(feeds.unsubscribeProvider).toHaveBeenCalledTimes(1);
    expect(feeds.unsubscribeCursor).toHaveBeenCalledTimes(1);
  });
});
