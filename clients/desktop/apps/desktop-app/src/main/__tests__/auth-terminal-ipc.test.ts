import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { AuthTerminalEventSender } from '../auth-terminal/manager';

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
const mockGetActiveSessionId = jest.fn();

jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: mockOpenManaged,
  revokeOpenCodeRuntimes: mockRevokeOpenCode,
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
  sendToWindow: mockSendToWindow,
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: mockRegisterIpcHandler,
}));

jest.mock('../auth/provider-auth-state', () => ({
  checkClaudeAuthStatusObserved: mockCheckClaudeAuthStatusObserved,
  checkCodexAuthStatusObserved: mockCheckCodexAuthStatusObserved,
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
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolve) {
        throw new Error('Deferred resolver was not initialized');
      }
      resolve(value);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRuntimeAbort = new AbortController();
  mockRuntimeClose.mockReset().mockResolvedValue(undefined);
  mockRevokeOpenCode.mockReset().mockResolvedValue(undefined);
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

it('releases the login lease before successful-auth revocation and notification', async () => {
  const sender = registerAndGetSender();
  const closed = deferred<void>();
  await startOpenCodeLogin();
  mockRuntimeClose.mockReturnValue(closed.promise);
  sender(IPC_CHANNELS.authTerminalExit, {
    sessionId: 'opencode-login',
    provider: 'opencode',
    exitCode: 0,
    signal: null,
  });
  expect(mockRevokeOpenCode).not.toHaveBeenCalled();
  expect(mockSendToWindow).not.toHaveBeenCalled();
  closed.resolve();
  await flushPromises();
  await flushPromises();
  expect(mockRevokeOpenCode).toHaveBeenCalledTimes(1);
  expect(mockSendToWindow).toHaveBeenCalled();
});

it('releases the login lease if terminal creation fails', async () => {
  registerAndGetSender();
  mockStart.mockImplementationOnce(() => {
    throw new Error('spawn failed');
  });
  await expect(startOpenCodeLogin()).rejects.toThrow('spawn failed');
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
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
