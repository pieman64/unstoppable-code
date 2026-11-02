import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { ProviderConnectionEvent } from '../lib/provider-connection-events';
import type { AuthTerminalEventSender } from '../auth-terminal/manager';
import type { refreshOpenCodeAccounts } from '../opencode/connection';

const mockSetEventSender = jest.fn<void, [AuthTerminalEventSender]>();
const mockStart = jest.fn();
const mockWrite = jest.fn();
const mockResize = jest.fn();
const mockStop = jest.fn();
const mockSendToWindow = jest.fn();
const mockRegisterIpcHandler = jest.fn<
  void,
  [string, (event: unknown, request: unknown) => unknown]
>();
const mockCheckClaudeAuthStatusObserved = jest.fn();
const mockCheckCodexAuthStatusObserved = jest.fn();
let mockRuntimeAbort = new AbortController();
const mockRuntimeClose = jest.fn(() => Promise.resolve());
const mockOpenManaged = jest.fn();
const mockRevokeOpenCode = jest.fn(() => Promise.resolve());
const mockRefreshOpenCodeAccounts = jest.fn<
  ReturnType<typeof refreshOpenCodeAccounts>,
  Parameters<typeof refreshOpenCodeAccounts>
>();
const mockGetActiveSessionId = jest.fn();

jest.mock('../opencode/connection', () => ({
  get openManagedOpenCodeRuntime(): typeof mockOpenManaged {
    return mockOpenManaged;
  },
  get revokeOpenCodeRuntimes(): typeof mockRevokeOpenCode {
    return mockRevokeOpenCode;
  },
  refreshOpenCodeAccounts: mockRefreshOpenCodeAccounts,
}));

jest.mock('../auth-terminal/manager', () => ({
  getAuthTerminalManager: jest.fn(() => ({
    setEventSender: mockSetEventSender,
    start: mockStart,
    write: mockWrite,
    resize: mockResize,
    stop: mockStop,
    getActiveSessionId: mockGetActiveSessionId,
  })),
}));

jest.mock('../lib/window-send', () => ({
  get sendToWindow(): typeof mockSendToWindow {
    return mockSendToWindow;
  },
}));

jest.mock('../ipc/register', () => ({
  get registerIpcHandler(): typeof mockRegisterIpcHandler {
    return mockRegisterIpcHandler;
  },
}));

jest.mock('../auth/provider-auth-state', () => ({
  get checkClaudeAuthStatusObserved(): typeof mockCheckClaudeAuthStatusObserved {
    return mockCheckClaudeAuthStatusObserved;
  },
  get checkCodexAuthStatusObserved(): typeof mockCheckCodexAuthStatusObserved {
    return mockCheckCodexAuthStatusObserved;
  },
}));

import { registerAuthTerminalHandlers } from '../ipc/auth-terminal';

function registerAndGetSender(): AuthTerminalEventSender {
  registerAuthTerminalHandlers(() => null);
  const sender = mockSetEventSender.mock.calls[0]?.[0];
  if (!sender) {
    throw new Error('Expected auth terminal event sender to be registered');
  }
  return sender;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolve) {
        throw new Error('Deferred resolver was not initialized');
      }
      resolve(value);
    },
    reject(reason: Error): void {
      if (!reject) {
        throw new Error('Deferred rejecter was not initialized');
      }
      reject(reason);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRuntimeAbort = new AbortController();
  mockRuntimeClose.mockReset().mockResolvedValue(undefined);
  mockRevokeOpenCode.mockReset().mockResolvedValue(undefined);
  mockRefreshOpenCodeAccounts.mockReset().mockResolvedValue(undefined);
  mockStart.mockReset().mockReturnValue('opencode-login');
  mockGetActiveSessionId.mockReturnValue('opencode-login');
  mockOpenManaged.mockReset().mockResolvedValue({
    executable: '/verified/opencode',
    signal: mockRuntimeAbort.signal,
    close: mockRuntimeClose,
  });
  mockCheckClaudeAuthStatusObserved.mockResolvedValue({
    authenticated: true,
    accountLabel: 'claude@example.com',
    detail: null,
    error: null,
  });
  mockCheckCodexAuthStatusObserved.mockResolvedValue({
    authenticated: true,
    accountLabel: 'codex@example.com',
    detail: null,
    error: null,
  });
});

async function startOpenCodeLogin(): Promise<void> {
  const handler = mockRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.authTerminalStart,
  )?.[1];
  if (!handler) throw new Error('Missing start handler');
  await handler({}, { provider: 'opencode', cols: 80, rows: 24 });
}

it('keeps the login runtime revocable until the terminal exits', async () => {
  const sender = registerAndGetSender();
  await startOpenCodeLogin();
  expect(mockRuntimeClose).not.toHaveBeenCalled();
  mockRuntimeAbort.abort();
  expect(mockStop).toHaveBeenCalledWith('opencode-login');
  expect(mockRuntimeClose).not.toHaveBeenCalled();
  sender(IPC_CHANNELS.authTerminalExit, {
    sessionId: 'opencode-login',
    provider: 'opencode',
    exitCode: 1,
    signal: null,
  });
  await flushPromises();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
});

it('cleans up a login which exits synchronously during terminal creation', async () => {
  registerAndGetSender();
  mockGetActiveSessionId.mockReturnValueOnce(null);
  await startOpenCodeLogin();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
  mockRuntimeAbort.abort();
  expect(mockStop).not.toHaveBeenCalled();
});

it('does not impose the verification deadline on an interactive login', async () => {
  jest.useFakeTimers();
  try {
    const sender = registerAndGetSender();
    let verificationSignal: AbortSignal | undefined;
    mockOpenManaged.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) => {
        verificationSignal = signal;
        return Promise.resolve({
          executable: '/verified/opencode',
          signal,
          close: mockRuntimeClose,
        });
      },
    );
    await startOpenCodeLogin();
    jest.advanceTimersByTime(61_000);
    expect(verificationSignal?.aborted).toBe(false);
    expect(mockStop).not.toHaveBeenCalled();
    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'opencode-login',
      provider: 'opencode',
      exitCode: 1,
      signal: null,
    });
    await flushPromises();
  } finally {
    jest.useRealTimers();
  }
});

it('refuses a login revoked before the PTY starts', async () => {
  registerAndGetSender();
  mockRuntimeAbort.abort();
  await expect(startOpenCodeLogin()).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
});

it.each(['resolve', 'reject'] as const)(
  'waits for login release and revocation, but not account discovery, before notifying (%s)',
  async (outcome) => {
    const sender = registerAndGetSender();
    const closed = deferred<void>();
    const revoked = deferred<void>();
    const refresh = deferred<void>();
    await startOpenCodeLogin();
    mockRuntimeClose.mockReturnValue(closed.promise);
    mockRevokeOpenCode.mockReturnValueOnce(revoked.promise);
    mockRefreshOpenCodeAccounts.mockReturnValueOnce(refresh.promise);
    const payload = {
      sessionId: 'opencode-login',
      provider: 'opencode' as const,
      exitCode: 0,
      signal: null,
    };
    sender(IPC_CHANNELS.authTerminalExit, payload);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
    expect(mockRevokeOpenCode).not.toHaveBeenCalled();
    expect(mockRefreshOpenCodeAccounts).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
    closed.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRevokeOpenCode).toHaveBeenCalledTimes(1);
    expect(mockRefreshOpenCodeAccounts).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
    revoked.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRefreshOpenCodeAccounts).toHaveBeenCalledTimes(1);
    expect(mockRefreshOpenCodeAccounts).toHaveBeenCalledWith(
      undefined,
      'in_app',
    );
    // Discovery is still pending: it must not hold the modal's exit event.
    try {
      expect(mockSendToWindow).toHaveBeenCalledTimes(1);
      expect(mockSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.authTerminalExit,
        payload,
      );
    } finally {
      if (outcome === 'reject') refresh.reject(new Error('discovery failed'));
      else refresh.resolve();
      // Let rejection handling run; an unhandled rejection must fail this test.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockSendToWindow).toHaveBeenCalledTimes(1);
  },
);

it('releases the login lease if terminal creation fails', async () => {
  const events = await import('../lib/provider-connection-events');
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  registerAndGetSender();
  mockStart.mockImplementationOnce(() => {
    throw new Error('spawn failed');
  });
  await expect(startOpenCodeLogin()).rejects.toThrow('spawn failed');
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
  expect(connection).toHaveBeenCalledWith({
    provider: 'opencode',
    connectionMethod: 'native_login',
    connectSource: 'in_app',
    failureReason: 'other',
  });
  stop();
});

describe('registerAuthTerminalHandlers event sender', () => {
  it('refreshes Claude auth status after forwarding a Claude exit event', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-1',
      provider: 'claude',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.authTerminalExit,
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      { forceAuthenticatedInvalidation: true },
    );
    expect(mockCheckCodexAuthStatusObserved).not.toHaveBeenCalled();
  });

  it('forwards a successful Codex exit only after the explicit cutover settles', async () => {
    const refresh = deferred<unknown>();
    mockCheckCodexAuthStatusObserved.mockReturnValueOnce(refresh.promise);
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2',
      provider: 'codex',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).not.toHaveBeenCalled();
    expect(mockCheckCodexAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      {
        forceAuthenticatedInvalidation: true,
        prepareExplicitTransitionBeforeProbe: true,
      },
    );
    expect(mockCheckClaudeAuthStatusObserved).not.toHaveBeenCalled();

    refresh.resolve({ authenticated: true });
    await flushPromises();
    expect(mockSendToWindow).toHaveBeenCalled();
  });

  it('does not force invalidation after failed Claude or Codex exits', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2a',
      provider: 'claude',
      exitCode: 1,
      signal: null,
    });
    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2b',
      provider: 'codex',
      exitCode: 1,
      signal: null,
    });

    expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      { forceAuthenticatedInvalidation: false },
    );
    expect(mockCheckCodexAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      {
        forceAuthenticatedInvalidation: false,
        prepareExplicitTransitionBeforeProbe: false,
      },
    );
  });

  it('does not refresh provider auth status for GitHub exits', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-3',
      provider: 'github',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).toHaveBeenCalled();
    expect(mockCheckClaudeAuthStatusObserved).not.toHaveBeenCalled();
    expect(mockCheckCodexAuthStatusObserved).not.toHaveBeenCalled();
  });

  it('still forwards a successful Codex exit when the gated auth refresh rejects', async () => {
    mockCheckCodexAuthStatusObserved.mockRejectedValueOnce(
      new Error('refresh failed'),
    );
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-4',
      provider: 'codex',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).not.toHaveBeenCalled();
    await flushPromises();
    expect(mockSendToWindow).toHaveBeenCalled();
  });
});

it('reports the verification deadline as timeout rather than cancellation', async () => {
  jest.useFakeTimers();
  const events = await import('../lib/provider-connection-events');
  events.resetProviderConnectionEventsForTests();
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  try {
    registerAndGetSender();
    mockOpenManaged.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('verification aborted')),
            {
              once: true,
            },
          );
        }),
    );
    const result = expect(startOpenCodeLogin()).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(60_000);
    await result;
    expect(connection).toHaveBeenCalledTimes(1);
    expect(connection).toHaveBeenCalledWith({
      provider: 'opencode',
      connectionMethod: 'native_login',
      connectSource: 'in_app',
      failureReason: 'timeout',
    });
    expect(mockStart).not.toHaveBeenCalled();
  } finally {
    stop();
    events.resetProviderConnectionEventsForTests();
    jest.useRealTimers();
  }
});

it.each(['claude', 'opencode'] as const)(
  'reports a modal-close SIGTERM with exit code zero once as cancelled for %s',
  async (provider) => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const unsubscribe = events.subscribeProviderConnections(connection);
    try {
      const sender = registerAndGetSender();
      if (provider === 'opencode') await startOpenCodeLogin();
      const stopHandler = mockRegisterIpcHandler.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.authTerminalStop,
      )?.[1];
      if (!stopHandler) throw new Error('Missing stop handler');
      stopHandler({}, { sessionId: 'opencode-login' });
      sender(IPC_CHANNELS.authTerminalExit, {
        sessionId: 'opencode-login',
        provider,
        exitCode: 0,
        signal: '15',
      });
      await flushPromises();
      await flushPromises();
      expect(connection.mock.calls.map(([event]) => event)).toEqual([
        {
          provider,
          connectionMethod: 'native_login',
          connectSource: 'in_app',
          failureReason: 'cancelled',
        },
      ]);
      expect(mockRevokeOpenCode).not.toHaveBeenCalled();
      if (provider === 'claude') {
        expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
          'auth-terminal-exit',
          { forceAuthenticatedInvalidation: false },
        );
      } else expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
      expect(mockSendToWindow).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      events.resetProviderConnectionEventsForTests();
    }
  },
);
