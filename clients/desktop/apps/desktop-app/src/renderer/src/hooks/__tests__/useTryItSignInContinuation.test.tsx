/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as zustand from 'zustand';
import type { TryItCapability } from '@canopy/protocol/try-it';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type {
  DesktopTryItLaunch,
  LegacyDesktopTryItLaunch,
  StagedDesktopTryItLaunch,
} from '@/lib/tryItChat';
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
const mockTabs: { current: Record<string, unknown>[] } = { current: [] };
const mockSetPluginSelections = jest.fn();
const mockUpdatePlugins = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);

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
  subscribeTryItChatLaunch: (listener: () => void): (() => void) => {
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  },
  readTryItChatLaunch: (
    accountId: string,
    capability: { catalogId: string },
  ): DesktopTryItLaunch | null =>
    mockLaunches.get(`${accountId}/${capability.catalogId}`) ?? null,
  rebindTryItChatLaunch: (input: unknown): string => mockRebind(input),
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

/** A CAN-5218 launch that staged its prompt, unsent, in chat-1. */
function launch(overrides: Partial<StagedDesktopTryItLaunch> = {}): void {
  mockLaunches.set('guest/linear', {
    version: 2,
    operation: 'stage-draft',
    accountId: 'guest',
    requestId: 'launch-request',
    capability: LINEAR,
    chatId: 'chat-1',
    prompt: 'List my open issues',
    destination: 'worktree',
    status: 'staged',
    location: { projectId: 'cowork', worktreeId: 'entry-1' },
    ...overrides,
  });
}

/** A CAN-4359 launch, which sent its prompt. */
function legacyLaunch(overrides: Partial<LegacyDesktopTryItLaunch> = {}): void {
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
const mockInvoke = jest.fn<Promise<RelayReply>, [unknown]>(() =>
  Promise.reject(new Error('Try it never reads a send receipt')),
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
    },
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

const SIGNED_IN = {
  read: 'ok',
  account: {
    id: '1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'DEVELOPER',
  },
} as const;
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
          hasUserTurn={false}
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
    mockCommand.mockClear();
    mockSetPluginSelections.mockClear();
    mockUpdatePlugins.mockReset();
    mockUpdatePlugins.mockResolvedValue(undefined);
    mockInvoke.mockClear();
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

  it('asks a guest to sign in for a staged draft before any user turn', () => {
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

  it.each(['guest', 'signed-in'] as const)(
    'observes staging completion with stable inputs for %s',
    (status) => {
      const accountId = status === 'guest' ? 'guest' : 'account:1';
      launch({ status: 'staging', accountId });
      const saved = mockLaunches.get('guest/linear');
      if (saved?.version !== 2) throw new Error('Missing staged launch');
      mockLaunches.clear();
      mockLaunches.set(`${accountId}/linear`, saved);
      mockAccount.current = { status, accountId };
      const input = { unresolvedCapabilities: [LINEAR] };
      render(input);
      expect(gate.state).toBe('hidden');
      act(() => {
        mockLaunches.set(`${accountId}/linear`, { ...saved, status: 'staged' });
        window.dispatchEvent(new StorageEvent('storage'));
      });
      expect(gate.state).toBe(
        status === 'guest' ? 'sign-in' : 'setup-required',
      );
      expect(readTryItContinuation('chat-1')?.sourceRequestId).toBe(
        'launch-request',
      );
      expect(mockCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'the initial send is pending',
      (): void => launch(),
      { initialSendPending: true },
    ],
    [
      'a legacy launch has no user turn',
      (): void => legacyLaunch(),
      { hasUserTurn: false },
    ],
    [
      'the draft is still staging',
      (): void => launch({ status: 'staging' }),
      {},
    ],
    [
      'a legacy launch is unsettled',
      (): void => legacyLaunch({ status: 'pending' }),
      { hasUserTurn: true },
    ],
    [
      'the launch belongs to another chat',
      (): void => launch({ chatId: 'chat-2' }),
      {},
    ],
    [
      'the capability is local',
      (): void => {
        launch({ capability: { ...LINEAR, sourceId: 'local-mcp' } });
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
      intent: 'select-capability',
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

  it('keeps a legacy launch with a user turn on the sign-in notice', () => {
    legacyLaunch();
    render({ hasUserTurn: true });
    expect(gate.state).toBe('sign-in');
  });

  // CAN-5218: finishing sign-in only resolves the capability; it never sends.
  describe('selection-only continuation', () => {
    const bound = (
      overrides: Partial<DesktopTryItContinuation> = {},
    ): DesktopTryItContinuation => ({
      version: 1,
      intent: 'select-capability',
      sourceChatId: 'chat-1',
      sourceSessionId: 'chat-1',
      sourceAccountKey: 'guest',
      capability: LINEAR,
      sourceRequestId: 'launch-request',
      requestId: 'continuation-request',
      prompt: 'List my open issues',
      createdAtMs: Date.now() - 1000,
      status: 'pending',
      destinationAccountKey: 'account:1',
      host: { projectId: 'cowork', worktreeId: 'entry-1' },
      ...overrides,
    });
    const linearConnection = {
      id: 'connection',
      serverKey: 'linear',
      configId: 'default',
      kind: 'CURATED' as const,
      status: 'CONNECTED' as const,
      displayName: 'Linear',
      routeId: 'fixture',
      enabledTools: null,
    };

    it('offers setup for the next staged MCP after a completed continuation', () => {
      setAccount(SIGNED_IN);
      mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
      writeTryItContinuation(bound({ status: 'setup-required' }));
      render();
      const next = { ...LINEAR, catalogId: 'github', name: 'GitHub' };
      launch({
        accountId: 'account:1',
        capability: next,
        requestId: 'next-launch',
      });
      const saved = mockLaunches.get('guest/linear');
      if (!saved) throw new Error('Missing next launch');
      mockLaunches.set('account:1/github', saved);
      render({ unresolvedCapabilities: [LINEAR, next] });
      expect(gate.capability).toEqual(LINEAR);
      expect(readTryItContinuation('chat-1')?.requestId).toBe(
        'continuation-request',
      );
      act(() => {
        writeTryItContinuation(
          bound({
            status: 'completed',
            selectionResolution: {
              requestId: 'continuation-request',
              chatId: 'chat-1',
              accountKey: 'account:1',
            },
          }),
        );
      });
      expect(gate.state).toBe('setup-required');
      expect(gate.capability).toEqual(next);
      expect(readTryItContinuation('chat-1')).toMatchObject({
        sourceRequestId: 'next-launch',
        capability: next,
        status: 'setup-required',
      });
      expect(mockCommand).not.toHaveBeenCalled();
    });

    it('rejects a mounted target different from the persisted scope', async () => {
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
      expect(mockUpdatePlugins).not.toHaveBeenCalled();
    });

    it('does not update local selections for a record replaced during plugin persistence', async () => {
      setAccount(SIGNED_IN);
      writeTryItContinuation(bound());
      jest
        .spyOn(window.mcpServers, 'listAccountConnections')
        .mockResolvedValue([linearConnection]);
      mockUpdatePlugins.mockImplementationOnce(() => {
        writeTryItContinuation(bound({ requestId: 'newer-request' }));
        return Promise.resolve();
      });
      await bindTryItContinuation(TARGET, 'continuation-request', 'account:1');
      expect(mockUpdatePlugins).toHaveBeenCalledTimes(1);
      expect(mockSetPluginSelections).not.toHaveBeenCalled();
      expect(readTryItContinuation('chat-1')?.requestId).toBe('newer-request');
    });

    it('preserves unrelated selections edited while authorization persistence is pending', async () => {
      setAccount(SIGNED_IN);
      writeTryItContinuation(bound());
      jest
        .spyOn(window.mcpServers, 'listAccountConnections')
        .mockResolvedValue([linearConnection]);
      let entered: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockUpdatePlugins.mockImplementationOnce(() => {
        entered();
        return held;
      });
      const pending = bindTryItContinuation(
        TARGET,
        'continuation-request',
        'account:1',
      );
      await started;
      mockTabs.current = [
        {
          id: 'chat-1',
          pluginSelections: {
            collectionIds: ['added-during-persistence'],
            pluginRefs: [
              { marketplaceId: 'market', pluginName: 'keep-plugin' },
            ],
            skillRefs: [],
            unresolvedCapabilities: [LINEAR],
          },
        },
      ];
      release();
      await pending;
      const resolvedSelections = {
        collectionIds: ['added-during-persistence'],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'keep-plugin' }],
        skillRefs: [],
        unresolvedCapabilities: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      };
      expect(mockUpdatePlugins).toHaveBeenLastCalledWith({
        ...TARGET,
        pluginSelections: resolvedSelections,
      });
      expect(mockSetPluginSelections).toHaveBeenLastCalledWith(
        resolvedSelections,
        TARGET,
        undefined,
        { runtimeAlreadyUpdated: true },
      );
      expect(readTryItContinuation('chat-1')?.status).toBe('completed');
      expect(mockCommand).not.toHaveBeenCalled();
    });

    it.each([
      { status: 'pending' as const },
      { status: 'sending' as const },
      { status: 'failed' as const, failure: 'acceptance-uncertain' as const },
    ])(
      'resolves a bound %o record into selections and completes without sending',
      async (overrides) => {
        setAccount(SIGNED_IN);
        jest
          .spyOn(window.mcpServers, 'listAccountConnections')
          .mockResolvedValue([linearConnection]);
        writeTryItContinuation(bound(overrides));
        mockAccount.current = { status: 'signed-in', accountId: 'account:1' };
        render();
        await flush();
        await flush();
        const [update] = mockUpdatePlugins.mock.calls[0] ?? [];
        expect(update).toMatchObject({
          chatId: 'chat-1',
          pluginSelections: {
            unresolvedCapabilities: [],
            mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
          },
        });
        expect(mockSetPluginSelections).toHaveBeenCalledTimes(1);
        expect(readTryItContinuation('chat-1')?.status).toBe('completed');
        expect(mockCommand).not.toHaveBeenCalled();
        expect(mockInvoke).not.toHaveBeenCalled();
      },
    );
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
        intent: 'select-capability',
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
