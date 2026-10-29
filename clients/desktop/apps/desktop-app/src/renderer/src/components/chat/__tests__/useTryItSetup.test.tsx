/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TryItCapability } from '@canopy/protocol/try-it';
import type { AccountMcpConnectionSummary } from '@canopy/desktop-shared/types/mcp-servers';
import type {
  AccountMcpSignInFlow,
  AccountMcpSignInTarget,
} from '@/components/mcp/useAccountMcpSignIn';
import { useTryItSetupPaneStore } from '@/stores/tryItSetupPaneStore';
import {
  resolveTryItSetupTarget,
  useTryItSetup,
  type TryItSetup,
  type TryItSetupPhase,
} from '../useTryItSetup';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockConnect = jest.fn<
  void,
  [AccountMcpSignInTarget, AccountMcpSignInFlow | undefined]
>();
const mockCancel = jest.fn<void, [string]>();
const mockCatalog = { waits: false, failed: false };
const mockCapabilities: { embeddedOAuthBrowser?: boolean } = {};
const mockInAppBrowser = { available: true };

jest.mock('@/components/mcp/useAccountMcpSignIn', () => ({
  useAccountMcpSignIn: (): unknown => ({
    pending: new Set(),
    error: null,
    errorCode: null,
    setupOpen: false,
    waitsForCatalog: (): boolean => mockCatalog.waits,
    catalogFailed: mockCatalog.failed,
    retryCatalog: (): void => undefined,
    connect: (
      target: AccountMcpSignInTarget,
      flow?: AccountMcpSignInFlow,
    ): void => mockConnect(target, flow),
    cancel: (serverKey: string): void => mockCancel(serverKey),
    dialogs: <></>,
  }),
}));
jest.mock('@canopy/app-state', () => ({
  useCanopyClient: (): unknown => ({ capabilities: mockCapabilities }),
}));
jest.mock('@/lib/remote-control/in-app-browser-availability', () => ({
  isInAppBrowserAvailable: (): boolean => mockInAppBrowser.available,
}));

const LINEAR: TryItCapability = {
  kind: 'mcp',
  sourceId: 'curated-mcp',
  catalogId: 'linear',
  name: 'Linear',
};
const CUSTOM: TryItCapability = {
  kind: 'mcp',
  sourceId: 'account-mcp',
  catalogId: 'custom-tracker',
  name: 'Tracker',
};
const TARGET = { projectId: 'cowork', worktreeId: 'entry-1', chatId: 'chat-1' };

function connection(
  overrides: Partial<AccountMcpConnectionSummary> = {},
): AccountMcpConnectionSummary {
  return {
    id: 'conn-1',
    kind: 'CURATED',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    status: 'REAUTH_REQUIRED',
    ...overrides,
  };
}

describe('resolveTryItSetupTarget', () => {
  it('signs a curated server in by catalog key when it has no connection', () => {
    expect(resolveTryItSetupTarget(LINEAR, [])).toEqual({
      kind: 'ready',
      target: { curatedKey: 'linear' },
      requiresSignIn: true,
      connected: false,
    });
  });

  it('reuses the matching connection with its own config', () => {
    const existing = connection({ configId: 'work' });
    expect(resolveTryItSetupTarget(LINEAR, [existing])).toMatchObject({
      kind: 'ready',
      target: { connection: existing, configId: 'work' },
    });
  });

  it('never treats a custom server key as the curated one', () => {
    const custom = connection({ kind: 'CUSTOM' });
    expect(resolveTryItSetupTarget(LINEAR, [custom])).toMatchObject({
      target: { curatedKey: 'linear' },
    });
    expect(
      resolveTryItSetupTarget(CUSTOM, [
        connection({ serverKey: 'custom-tracker' }),
      ]),
    ).toMatchObject({ kind: 'unavailable' });
  });

  it('reports ambiguity, a disabled connection and a missing custom server', () => {
    expect(
      resolveTryItSetupTarget(LINEAR, [
        connection(),
        connection({ id: 'conn-2', configId: 'work' }),
      ]).kind,
    ).toBe('unavailable');
    expect(
      resolveTryItSetupTarget(LINEAR, [
        connection({ status: 'CONNECTED', enabled: false }),
      ]).kind,
    ).toBe('unavailable');
    expect(resolveTryItSetupTarget(CUSTOM, []).kind).toBe('unavailable');
  });

  it('reads a no-auth connection as Connect', () => {
    expect(
      resolveTryItSetupTarget(CUSTOM, [
        connection({
          kind: 'CUSTOM',
          serverKey: 'custom-tracker',
          authMode: 'NONE',
        }),
      ]),
    ).toMatchObject({ kind: 'ready', requiresSignIn: false });
  });
});

describe('useTryItSetup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let setup: TryItSetup;
  let phase: TryItSetupPhase;
  const resume = jest.fn<boolean, [string]>(() => true);
  let list: jest.Mock;

  function Harness({
    requestId,
    accountKey,
    chatId,
    capability = LINEAR,
  }: {
    requestId: string | null;
    accountKey: string | null;
    chatId: string;
    capability?: TryItCapability;
  }): JSX.Element {
    const [current, setPhase] = useState<TryItSetupPhase>('idle');
    phase = current;
    setup = useTryItSetup({
      target: { ...TARGET, chatId },
      capability,
      requestId,
      accountKey,
      phase: current,
      setPhase,
      resume,
    });
    return <></>;
  }

  async function render(
    props: Partial<{
      requestId: string | null;
      accountKey: string | null;
      chatId: string;
      capability: TryItCapability;
    }> = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <Harness
          requestId="request-1"
          accountKey="account:1"
          chatId="chat-1"
          {...props}
        />,
      );
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  }

  function flow(call = 0): AccountMcpSignInFlow {
    const value = mockConnect.mock.calls[call]?.[1];
    if (!value) throw new Error(`no flow ${call}`);
    return value;
  }

  beforeEach(() => {
    mockConnect.mockClear();
    mockCancel.mockClear();
    resume.mockClear();
    mockCatalog.waits = false;
    mockCatalog.failed = false;
    mockCapabilities.embeddedOAuthBrowser = true;
    mockInAppBrowser.available = true;
    useTryItSetupPaneStore.setState({ pane: null, reservation: null });
    list = jest.fn(() => Promise.resolve([]));
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listAccountConnections: list },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('cancels the original target when capability changes', async () => {
    await render();
    act(() => setup.setup?.onActivate());
    await render({
      capability: { ...LINEAR, catalogId: 'notion', name: 'Notion' },
    });
    expect(mockCancel).toHaveBeenCalledWith('linear');
    expect(mockCancel).not.toHaveBeenCalledWith('notion');
    act(() =>
      flow().onSettled?.({ kind: 'connected', connection: connection() }),
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it('offers nothing until a signed-in record waits on setup', async () => {
    await render({ requestId: null });
    expect(setup.setup).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('opens the pane for an embedded attempt and resumes once connected', async () => {
    await render();
    expect(setup.loading).toBe(false);
    expect(setup.setup).toMatchObject({ route: 'embedded' });
    act(() => setup.setup?.onActivate());
    act(() => setup.setup?.onActivate());
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(flow().browser).toBe('embedded');
    expect(phase).toBe('active');
    act(() => flow().onAuthorizing?.('https://app.example.test/one-shot'));
    expect(useTryItSetupPaneStore.getState().pane).toMatchObject({
      chatId: 'chat-1',
      url: 'https://app.example.test/one-shot',
    });
    act(() =>
      flow().onSettled?.({ kind: 'connected', connection: connection() }),
    );
    expect(useTryItSetupPaneStore.getState().pane).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith('request-1');
    expect(phase).toBe('idle');
  });

  it('starts externally without a pane from the default-browser choice', async () => {
    await render();
    act(() => setup.setup?.onActivateExternal?.());
    expect(flow().browser).toBeUndefined();
    act(() => flow().onAuthorizing?.(undefined));
    expect(useTryItSetupPaneStore.getState().pane).toBeNull();
  });

  it('routes externally when the host or window cannot embed', async () => {
    mockInAppBrowser.available = false;
    await render();
    expect(setup.setup?.route).toBe('external');
    expect(setup.setup?.onActivateExternal).toBeUndefined();
    act(() => setup.setup?.onActivate());
    expect(flow().browser).toBeUndefined();
  });

  it('ignores a late success after cancel, and a stale failure after retry', async () => {
    await render();
    act(() => setup.setup?.onActivate());
    act(() => flow(0).onAuthorizing?.('https://app.example.test/one-shot'));
    act(() => setup.setup?.onCancel?.());
    expect(phase).toBe('cancelled');
    expect(mockCancel).toHaveBeenCalledWith('linear');
    expect(useTryItSetupPaneStore.getState().pane).toBeNull();
    act(() =>
      flow(0).onSettled?.({ kind: 'connected', connection: connection() }),
    );
    expect(resume).not.toHaveBeenCalled();
    act(() => setup.setup?.onActivate());
    expect(mockConnect).toHaveBeenCalledTimes(2);
    act(() => flow(0).onSettled?.({ kind: 'failed', message: 'stale' }));
    expect(phase).toBe('active');
    act(() => flow(1).onSettled?.({ kind: 'failed', message: null }));
    expect(phase).toBe('failed');
    expect(setup.errorMessage).toBeUndefined();
  });

  it('closing the pane cancels like the notice', async () => {
    await render();
    act(() => setup.setup?.onActivate());
    act(() => flow().onAuthorizing?.('https://app.example.test/one-shot'));
    act(() => useTryItSetupPaneStore.getState().pane?.onClose());
    expect(phase).toBe('cancelled');
    expect(mockCancel).toHaveBeenCalledWith('linear');
  });

  it.each([LINEAR, CUSTOM])(
    'keeps the $catalogId connection after provider refusal and retries once',
    async (capability) => {
      const existing = connection({
        kind: capability === CUSTOM ? 'CUSTOM' : 'CURATED',
        serverKey: capability.catalogId,
        configId: 'saved-config',
      });
      list.mockResolvedValue([existing]);
      await render({ capability });
      act(() => setup.setup?.onActivate());
      act(() => flow().onAuthorizing?.('https://app.example.test/one-shot'));
      act(() =>
        flow().onSettled?.({
          kind: 'failed',
          message: 'Access wasn’t approved. Sign in again to approve it.',
        }),
      );
      expect(phase).toBe('failed');
      expect(useTryItSetupPaneStore.getState().pane).toBeNull();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      act(() => setup.setup?.onActivate());
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockConnect.mock.calls[1]?.[0]).toEqual({
        connection: existing,
        configId: 'saved-config',
      });
      act(() =>
        flow(1).onSettled?.({ kind: 'connected', connection: existing }),
      );
      expect(resume).toHaveBeenCalledTimes(1);
    },
  );

  it("fails recoverably instead of replacing another chat's pane", async () => {
    const other = {};
    useTryItSetupPaneStore.getState().open({
      ...TARGET,
      chatId: 'chat-2',
      attempt: other,
      url: 'https://app.example.test/other',
      capabilityName: 'Notion',
      onClose: () => undefined,
      onError: () => undefined,
    });
    await render();
    act(() => setup.setup?.onActivate());
    expect(mockConnect).not.toHaveBeenCalled();
    expect(phase).toBe('failed');
    expect(setup.errorMessage).toMatch(/Another connection/);
    expect(useTryItSetupPaneStore.getState().pane?.attempt).toBe(other);
  });

  it('fails the attempt when the native browser cannot open', async () => {
    await render();
    act(() => setup.setup?.onActivate());
    act(() => flow().onAuthorizing?.('https://app.example.test/one-shot'));
    act(() => useTryItSetupPaneStore.getState().pane?.onError());
    expect(phase).toBe('failed');
    expect(useTryItSetupPaneStore.getState().pane).toBeNull();
    expect(mockCancel).toHaveBeenCalledWith('linear');
  });

  it('releases its attempt when the chat or account changes', async () => {
    await render();
    act(() => setup.setup?.onActivate());
    act(() => flow().onAuthorizing?.('https://app.example.test/one-shot'));
    await render({ accountKey: 'account:2' });
    expect(useTryItSetupPaneStore.getState().pane).toBeNull();
    expect(mockCancel).toHaveBeenCalledWith('linear');
    expect(phase).toBe('idle');
    act(() =>
      flow().onSettled?.({ kind: 'connected', connection: connection() }),
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes once when the connection is already usable', async () => {
    list.mockResolvedValue([connection({ status: 'CONNECTED' })]);
    await render();
    expect(resume).toHaveBeenCalledTimes(1);
    await render();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('waits while the catalog loads and recovers from a failed read', async () => {
    mockCatalog.waits = true;
    await render();
    expect(setup.loading).toBe(true);
    act(() => setup.setup?.onActivate());
    expect(mockConnect).not.toHaveBeenCalled();
    list.mockRejectedValueOnce(new Error('offline'));
    mockCatalog.waits = false;
    await render({ requestId: 'request-2' });
    expect(phase).toBe('failed');
    expect(setup.errorMessage).toMatch(/Couldn't load Linear setup/);
    await act(async () => {
      setup.setup?.onActivate();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(phase).toBe('idle');
    expect(setup.errorMessage).toBeUndefined();
  });
});
