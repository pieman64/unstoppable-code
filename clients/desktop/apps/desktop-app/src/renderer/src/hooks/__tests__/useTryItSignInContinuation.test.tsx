/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as zustand from 'zustand';
import type { TryItCapability } from '@canopy/protocol/try-it';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import type { DesktopTryItLaunch } from '@/lib/tryItChat';
import {
  readTryItContinuation,
  writeTryItContinuation,
  type DesktopTryItContinuation,
} from '@/lib/tryItContinuation';
import {
  useTryItSignInContinuation,
  bindTryItContinuation,
  type DesktopTryItSignIn,
  type UseTryItSignInContinuationInput,
} from '../useTryItSignInContinuation';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockAccount = {
  current: { status: 'guest', accountId: 'guest' } as {
    status: 'loading' | 'guest' | 'signed-in';
    accountId: string | null;
  },
};
interface MockGateState {
  pending: { context: unknown; proceed: () => void } | null;
  requestConnect: (context: unknown, proceed: () => void) => void;
}
type ZustandModule = typeof zustand;

const mockLaunches = new Map<string, DesktopTryItLaunch>();
const mockRebind = jest.fn<string, [unknown]>(() => 'rebound');
const mockContinue = jest.fn(() => Promise.resolve());
const mockTabs: { current: Record<string, unknown>[] } = { current: [] };
const mockSetPluginSelections = jest.fn();
const mockUpdatePlugins = jest.fn(() => Promise.resolve());

const mockTryItAccountKey = jest.fn(
  (account: { account?: { id: string } }): string =>
    account.account ? `account:${account.account.id}` : 'guest',
);

jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  useTryItAccount: (): typeof mockAccount.current => mockAccount.current,
  tryItAccountKey: (account: { account?: { id: string } }): string =>
    mockTryItAccountKey(account),
}));
jest.mock('@/lib/tryItChat', () => ({
  readTryItChatLaunch: (
    accountId: string,
    capability: { catalogId: string },
  ): DesktopTryItLaunch | null =>
    mockLaunches.get(`${accountId}/${capability.catalogId}`) ?? null,
  rebindTryItChatLaunch: (input: unknown): string => mockRebind(input),
  continueTryItChat: (): Promise<void> => mockContinue(),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): {
      worktreeChats: Record<string, { tabs: Record<string, unknown>[] }>;
      setPluginSelections: typeof mockSetPluginSelections;
    } => ({
      worktreeChats: { 'cowork/entry-1': { tabs: mockTabs.current } },
      setPluginSelections: mockSetPluginSelections,
    }),
  },
}));
jest.mock('@/stores/cloudConnectGateStore', () => {
  const { create } = jest.requireActual<ZustandModule>('zustand');
  return {
    useCloudConnectGateStore: create<MockGateState>(() => ({
      pending: null,
      requestConnect: (): void => undefined,
    })),
    isConnectedNonGuest: (account: { account?: unknown } | null): boolean =>
      Boolean(account?.account),
  };
});

// Imported after the mock so tests drive the same store instance.
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';

const LINEAR: TryItCapability = {
  kind: 'mcp',
  sourceId: 'curated-mcp',
  catalogId: 'linear',
  name: 'Linear',
};
const TARGET = { projectId: 'cowork', worktreeId: 'entry-1', chatId: 'chat-1' };

function launch(overrides: Partial<DesktopTryItLaunch> = {}): void {
  mockLaunches.set('guest/linear', {
    version: 1,
    accountId: 'guest',
    requestId: 'launch-request',
    capability: LINEAR,
    chatId: 'chat-1',
    prompt: 'List my open issues',
    destination: 'standalone',
    status: 'completed',
    location: { projectId: 'cowork', worktreeId: 'entry-1' },
    ...overrides,
  });
}

type RelayReply = Awaited<ReturnType<Window['canopyCore']['invoke']>>;
const MISSING_RECEIPT: RelayReply = { ok: true, value: { outcome: 'missing' } };
const ACCEPTED_RECEIPT: RelayReply = {
  ok: true,
  value: {
    outcome: 'matched',
    receipt: {
      commandId: 'try-it-continuation-request',
      revision: 1,
      outcome: 'applied',
      entityId: 'chat-1',
      messageId: 'continuation-request',
    },
  },
};
const ERROR_RECEIPT: RelayReply = {
  ok: false,
  error: {
    kind: 'unavailable',
    message: 'The relay is unavailable.',
    retry: { kind: 'never' },
  },
};
const mockInvoke = jest.fn<Promise<RelayReply>, [unknown]>(() =>
  Promise.resolve(MISSING_RECEIPT),
);
const mockCommand = jest.fn();

function setAccount(
  account: Partial<CanopyCloudAccountPublicState> | Error,
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest.fn(() =>
        account instanceof Error
          ? Promise.reject(account)
          : Promise.resolve(account),
      ),
      chat: { command: mockCommand, updatePlugins: mockUpdatePlugins },
    } as Partial<CanopyApi> as CanopyApi,
  });
  // The main renderer's core relay; each test controls its receipt reply.
  Object.defineProperty(window, 'canopyCore', {
    configurable: true,
    value: { invoke: mockInvoke },
  });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { listAccountConnections: jest.fn(() => Promise.resolve([])) },
  });
}

const SIGNED_IN = { read: 'ok', account: { id: '1' } } as const;
const STILL_GUEST = { read: 'ok' } as const;

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe('useTryItSignInContinuation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let gate: DesktopTryItSignIn;

  function Harness(props: UseTryItSignInContinuationInput): JSX.Element {
    gate = useTryItSignInContinuation(props);
    return <></>;
  }

  function render(input: Partial<UseTryItSignInContinuationInput> = {}): void {
    act(() => {
      root.render(
        <Harness
          target={TARGET}
          unresolvedCapabilities={[LINEAR]}
          hasUserTurn
          initialSendPending={false}
          {...input}
        />,
      );
    });
  }

  /** Opens the gate modal for the request instead of proceeding at once. */
  function openGateOnRequest(): void {
    useCloudConnectGateStore.setState({
      requestConnect: (context, proceed) =>
        useCloudConnectGateStore.setState({ pending: { context, proceed } }),
    });
  }

  beforeEach(() => {
    localStorage.clear();
    mockLaunches.clear();
    mockRebind.mockClear();
    mockContinue.mockClear();
    mockCommand.mockClear();
    mockSetPluginSelections.mockClear();
    mockUpdatePlugins.mockReset();
    mockUpdatePlugins.mockResolvedValue(undefined);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(MISSING_RECEIPT);
    mockAccount.current = { status: 'guest', accountId: 'guest' };
    mockTabs.current = [
      { id: 'chat-1', pluginSelections: { unresolvedCapabilities: [LINEAR] } },
    ];
    useCloudConnectGateStore.setState({ pending: null });
    openGateOnRequest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'canopyCore');
  });

  it('saves a setup continuation for an initially signed-in launch', () => {
    launch();
    const saved = mockLaunches.get('guest/linear');
    if (!saved) throw new Error('Missing launch');
    mockLaunches.delete('guest/linear');
    mockLaunches.set('account:1/linear', { ...saved, accountId: 'account:1' });
    mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
    setAccount(SIGNED_IN);
    render();
    expect(gate.state).toBe('setup-required');
    expect(gate.setupRequestId).not.toBeNull();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      sourceRequestId: 'launch-request',
      sourceAccountKey: 'account:1',
      destinationAccountKey: 'account:1',
      status: 'setup-required',
    });
  });

  it('asks a guest to sign in once the launch settled, and saves the prompt', () => {
    launch();
    render();
    expect(gate.state).toBe('sign-in');
    expect(gate.capability).toEqual(LINEAR);
    expect(gate.promptSaved).toBe(true);
    expect(readTryItContinuation('chat-1')).toMatchObject({
      sourceRequestId: 'launch-request',
      prompt: 'List my open issues',
      status: 'pending',
      host: { projectId: 'cowork', worktreeId: 'entry-1' },
    });
  });

  it.each([
    [
      'the initial send is pending',
      (): void => launch(),
      { initialSendPending: true },
    ],
    ['there is no user turn', (): void => launch(), { hasUserTurn: false }],
    ['the launch is unsettled', (): void => launch({ status: 'pending' }), {}],
    [
      'the launch belongs to another chat',
      (): void => launch({ chatId: 'chat-2' }),
      {},
    ],
    [
      'the capability is local',
      (): void => {
        mockLaunches.set('guest/linear', {
          version: 1,
          accountId: 'guest',
          requestId: 'launch-request',
          capability: { ...LINEAR, sourceId: 'local-mcp' },
          chatId: 'chat-1',
          prompt: 'x',
          destination: 'standalone',
          status: 'completed',
          location: { projectId: 'cowork', worktreeId: 'entry-1' },
        });
      },
      { unresolvedCapabilities: [{ ...LINEAR, sourceId: 'local-mcp' }] },
    ],
  ])('stays hidden when %s', (_label, seed, input) => {
    seed();
    render(input);
    expect(gate.state).toBe('hidden');
  });

  it('records a cancelled sign-in and retries with the same request', async () => {
    launch();
    setAccount(STILL_GUEST);
    render();
    const requestId = readTryItContinuation('chat-1')?.requestId;
    act(() => gate.signIn());
    expect(gate.state).toBe('signing-in');
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      status: 'failed',
      failure: 'authentication-cancelled',
      requestId,
    });
    expect(gate.state).toBe('retry');
    expect(gate.retry).toBe('authentication');
    act(() => gate.retryContinuation());
    await flush();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      status: 'pending',
      requestId,
    });
  });

  it('binds the account and records setup-required after sign-in', async () => {
    launch();
    setAccount(SIGNED_IN);
    render();
    act(() => gate.signIn());
    const pending = useCloudConnectGateStore.getState().pending;
    // The gate proceeds and then closes; only the first signal counts.
    act(() => {
      pending?.proceed();
      useCloudConnectGateStore.setState({ pending: null });
    });
    await flush();
    const record = readTryItContinuation('chat-1');
    expect(record).toMatchObject({
      status: 'setup-required',
      destinationAccountKey: 'account:1',
      prompt: 'List my open issues',
    });
    expect(mockRebind).toHaveBeenCalledTimes(1);
    expect(mockRebind).toHaveBeenCalledWith({
      fromAccountId: 'guest',
      toAccountId: 'account:1',
      capability: LINEAR,
      chatId: 'chat-1',
    });
    mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
    render();
    expect(gate.state).toBe('setup-required');
  });

  it('lets successful proceed supersede a stale guest read started by gate close', async () => {
    launch();
    setAccount(SIGNED_IN);
    let releaseGuest:
      | ((value: CanopyCloudAccountPublicState) => void)
      | undefined;
    const stale = new Promise<CanopyCloudAccountPublicState>((resolve) => {
      releaseGuest = resolve;
    });
    jest.mocked(window.api.loadCanopyCloudAccount).mockReturnValueOnce(stale);
    render();
    act(() => gate.signIn());
    const pending = useCloudConnectGateStore.getState().pending;
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    act(() => pending?.proceed());
    releaseGuest?.(STILL_GUEST as CanopyCloudAccountPublicState);
    await flush();
    expect(readTryItContinuation('chat-1')?.status).toBe('setup-required');
  });

  it('handles an already connected account that proceeds immediately', async () => {
    launch();
    setAccount(SIGNED_IN);
    useCloudConnectGateStore.setState({
      requestConnect: (_context, proceed) => proceed(),
    });
    render();
    act(() => gate.signIn());
    await flush();
    expect(readTryItContinuation('chat-1')?.status).toBe('setup-required');
  });

  it('never binds an account whose Try it scope is still guest', async () => {
    launch();
    setAccount(SIGNED_IN);
    // The gate reads the account as connected, but Try it scopes it as a
    // guest (no resolved credential): binding would scope the record to
    // `guest` and re-offer sign-in over a setup-required record.
    mockTryItAccountKey.mockReturnValueOnce('guest');
    render();
    act(() => gate.signIn());
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      status: 'failed',
      failure: 'authentication-cancelled',
    });
    expect(readTryItContinuation('chat-1')?.destinationAccountKey).toBe(
      undefined,
    );
    expect(mockRebind).not.toHaveBeenCalled();
  });

  it('marks an unreadable account as a failed sign-in', async () => {
    launch();
    setAccount(new Error('ipc'));
    render();
    act(() => gate.signIn());
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      status: 'failed',
      failure: 'authentication-failed',
    });
  });

  it('does not bind a chat whose tab was deleted', async () => {
    launch();
    setAccount(SIGNED_IN);
    render();
    act(() => gate.signIn());
    mockTabs.current = [];
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    expect(readTryItContinuation('chat-1')?.status).toBe('pending');
    expect(mockRebind).not.toHaveBeenCalled();
  });

  it('still opens sign-in but never continues when storage fails', async () => {
    launch();
    setAccount(SIGNED_IN);
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((): void => {
        throw new Error('quota');
      });
    render();
    expect(gate.promptSaved).toBe(false);
    act(() => gate.signIn());
    expect(useCloudConnectGateStore.getState().pending).not.toBeNull();
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    setItem.mockRestore();
    expect(readTryItContinuation('chat-1')).toBeNull();
    expect(mockRebind).not.toHaveBeenCalled();
  });

  it('binds an activated attempt after signing in elsewhere', async () => {
    setAccount(SIGNED_IN);
    const record: DesktopTryItContinuation = {
      version: 1,
      sourceChatId: 'chat-1',
      sourceSessionId: 'chat-1',
      sourceAccountKey: 'guest',
      capability: LINEAR,
      sourceRequestId: 'launch-request',
      requestId: 'continuation-request',
      prompt: 'List my open issues',
      createdAtMs: Date.now() - 1000,
      status: 'pending',
      host: {
        projectId: 'cowork',
        worktreeId: 'entry-1',
        authIntentAtMs: Date.now(),
      },
    };
    writeTryItContinuation(record);
    mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
    render();
    expect(gate.state).toBe('retry');
    expect(gate.retry).toBe('continuation');
    act(() => gate.retryContinuation());
    await flush();
    expect(readTryItContinuation('chat-1')).toMatchObject({
      status: 'setup-required',
      destinationAccountKey: 'account:1',
    });
    expect(gate.state).toBe('setup-required');
  });

  // CAN-4404: recovery reads main's durable receipt before any send.
  describe('receipt reconciliation', () => {
    const bound = (
      overrides: Partial<DesktopTryItContinuation> = {},
    ): DesktopTryItContinuation => ({
      version: 1,
      sourceChatId: 'chat-1',
      sourceSessionId: 'chat-1',
      sourceAccountKey: 'guest',
      capability: LINEAR,
      sourceRequestId: 'launch-request',
      requestId: 'continuation-request',
      prompt: 'List my open issues',
      createdAtMs: Date.now() - 1000,
      status: 'sending',
      destinationAccountKey: 'account:1',
      host: { projectId: 'cowork', worktreeId: 'entry-1' },
      ...overrides,
    });
    const receiptQuery = {
      kind: 'request',
      method: 'core.chat.send.receipt',
      params: {
        scope: {
          workspaceId: 'cowork',
          worktreeId: 'entry-1',
          chatId: 'chat-1',
        },
        commandId: 'try-it-continuation-request',
      },
    };

    it('rejects a mounted target different from the persisted send scope', async () => {
      setAccount(SIGNED_IN);
      writeTryItContinuation(
        bound({ host: { projectId: 'other', worktreeId: 'other-entry' } }),
      );
      const before = readTryItContinuation('chat-1');
      await bindTryItContinuation(
        { projectId: 'cowork', worktreeId: 'entry-1', chatId: 'chat-1' },
        'continuation-request',
        'account:1',
      );
      expect(readTryItContinuation('chat-1')).toEqual(before);
      expect(mockRebind).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockContinue).not.toHaveBeenCalled();
    });

    it('preserves possible dispatch when a signed-out owner signs in again', async () => {
      setAccount(SIGNED_IN);
      mockInvoke.mockResolvedValue(ERROR_RECEIPT);
      writeTryItContinuation(
        bound({ status: 'failed', failure: 'acceptance-uncertain' }),
      );
      render();
      act(() => gate.signIn());
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'failed',
        failure: 'acceptance-uncertain',
      });
      const pending = useCloudConnectGateStore.getState().pending;
      act(() => pending?.proceed());
      await flush();
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'failed',
        failure: 'acceptance-uncertain',
      });
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockContinue).not.toHaveBeenCalled();
    });

    it('does not update local selections for a record replaced during plugin persistence', async () => {
      setAccount(SIGNED_IN);
      writeTryItContinuation(bound());
      jest
        .spyOn(window.mcpServers, 'listAccountConnections')
        .mockResolvedValue([
          {
            id: 'connection',
            serverKey: 'linear',
            configId: 'default',
            kind: 'CURATED',
            status: 'CONNECTED',
            displayName: 'Linear',
            routeId: 'fixture',
            enabledTools: null,
          },
        ]);
      mockUpdatePlugins.mockImplementationOnce(() => {
        writeTryItContinuation(bound({ requestId: 'newer-request' }));
        return Promise.resolve();
      });
      await bindTryItContinuation(TARGET, 'continuation-request', 'account:1');
      expect(mockUpdatePlugins).toHaveBeenCalledTimes(1);
      expect(mockSetPluginSelections).not.toHaveBeenCalled();
      expect(mockContinue).not.toHaveBeenCalled();
      expect(readTryItContinuation('chat-1')?.requestId).toBe('newer-request');
    });

    it('completes a bound sending record on mount from an accepted receipt', async () => {
      setAccount(SIGNED_IN);
      mockInvoke.mockResolvedValue(ACCEPTED_RECEIPT);
      writeTryItContinuation(bound());
      mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
      render();
      await flush();
      expect(mockInvoke).toHaveBeenCalledWith(receiptQuery);
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'completed',
        receipt: {
          accountKey: 'account:1',
          chatId: 'chat-1',
          requestId: 'continuation-request',
        },
      });
      expect(gate.state).toBe('hidden');
      expect(mockContinue).not.toHaveBeenCalled();
      expect(mockCommand).not.toHaveBeenCalled();
    });

    it('keeps an error reply uncertain and retryable without dispatch', async () => {
      setAccount(SIGNED_IN);
      mockInvoke.mockResolvedValue(ERROR_RECEIPT);
      writeTryItContinuation(bound());
      mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
      render();
      await flush();
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'failed',
        failure: 'acceptance-uncertain',
      });
      expect(gate.state).toBe('retry');
      expect(gate.retry).toBe('continuation');
      expect(mockContinue).not.toHaveBeenCalled();
      expect(mockCommand).not.toHaveBeenCalled();
    });

    it('rechecks the receipt on Try again without looping on its own', async () => {
      setAccount(SIGNED_IN);
      mockInvoke.mockResolvedValue(ERROR_RECEIPT);
      writeTryItContinuation(
        bound({ status: 'failed', failure: 'acceptance-uncertain' }),
      );
      mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
      render();
      await flush();
      await flush();
      // Persistent unknown: one read on mount, no automatic retries.
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(gate.state).toBe('retry');

      act(() => gate.retryContinuation());
      await flush();
      await flush();
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(readTryItContinuation('chat-1')?.failure).toBe(
        'acceptance-uncertain',
      );

      mockInvoke.mockResolvedValue(ACCEPTED_RECEIPT);
      act(() => gate.retryContinuation());
      await flush();
      expect(mockInvoke).toHaveBeenCalledTimes(3);
      expect(readTryItContinuation('chat-1')?.status).toBe('completed');
      expect(gate.state).toBe('hidden');
      expect(mockContinue).not.toHaveBeenCalled();
      expect(mockCommand).not.toHaveBeenCalled();
    });
  });

  it('stops listening to the gate after unmount', async () => {
    launch();
    setAccount(SIGNED_IN);
    render();
    act(() => gate.signIn());
    act(() => root.unmount());
    root = createRoot(container);
    act(() => useCloudConnectGateStore.setState({ pending: null }));
    await flush();
    expect(readTryItContinuation('chat-1')?.status).toBe('pending');
  });
  describe('setup (CAN-4451)', () => {
    function setupRecord(
      overrides: Partial<DesktopTryItContinuation> = {},
    ): DesktopTryItContinuation {
      return {
        version: 1,
        sourceChatId: 'chat-1',
        sourceSessionId: 'chat-1',
        sourceAccountKey: 'guest',
        destinationAccountKey: 'account:1',
        capability: LINEAR,
        sourceRequestId: 'launch-request',
        requestId: 'continuation-request',
        prompt: 'List my open issues',
        createdAtMs: Date.now() - 1000,
        status: 'setup-required',
        host: { projectId: 'cowork', worktreeId: 'entry-1' },
        ...overrides,
      };
    }

    beforeEach(() => {
      setAccount(SIGNED_IN);
      mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
    });

    it('exposes the waiting record and maps transient setup to the gate', () => {
      writeTryItContinuation(setupRecord());
      render();
      expect(gate.state).toBe('setup-required');
      expect(gate.setupRequestId).toBe('continuation-request');
      expect(gate.accountKey).toBe('account:1');
      render({ setup: 'active' });
      expect(gate.state).toBe('authorizing');
      render({ setup: 'cancelled' });
      expect(gate.state).toBe('retry');
      expect(gate.retry).toBe('setup');
      render({ setup: 'failed' });
      expect(gate.retry).toBe('setup');
    });

    it('offers no setup to a guest or a sending record', () => {
      writeTryItContinuation(setupRecord({ status: 'sending' }));
      render();
      expect(gate.setupRequestId).toBeNull();
      mockAccount.current = { status: 'guest', accountId: 'guest' };
      writeTryItContinuation(setupRecord());
      render();
      expect(gate.setupRequestId).toBeNull();
    });

    it('requeues the current record once, keeping its request and prompt', async () => {
      writeTryItContinuation(setupRecord());
      render();
      let resumed = false;
      act(() => {
        resumed = gate.resumeAfterSetup('continuation-request');
      });
      expect(resumed).toBe(true);
      const stored = readTryItContinuation('chat-1');
      expect(stored).toMatchObject({
        requestId: 'continuation-request',
        prompt: 'List my open issues',
      });
      expect(stored?.failure).toBeUndefined();
      await flush();
      // Still no usable connection: the runner re-resolves and waits again.
      expect(readTryItContinuation('chat-1')).toMatchObject({
        requestId: 'continuation-request',
        status: 'setup-required',
      });
    });

    it('refuses a replaced record, another status, or another account', () => {
      writeTryItContinuation(setupRecord());
      render();
      expect(gate.resumeAfterSetup('older-request')).toBe(false);
      writeTryItContinuation(
        setupRecord({ status: 'failed', failure: 'send-failed' }),
      );
      expect(gate.resumeAfterSetup('continuation-request')).toBe(false);
      writeTryItContinuation(
        setupRecord({ destinationAccountKey: 'account:2' }),
      );
      expect(gate.resumeAfterSetup('continuation-request')).toBe(false);
      expect(readTryItContinuation('chat-1')).toMatchObject({
        status: 'setup-required',
        destinationAccountKey: 'account:2',
      });
    });
  });
});
