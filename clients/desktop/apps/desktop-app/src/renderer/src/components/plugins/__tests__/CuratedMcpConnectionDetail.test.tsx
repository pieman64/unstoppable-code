/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type {
  AccountMcpConnection,
  McpServerData,
  McpServersAPI,
  McpServerStatusEntry,
  RewriteMcpServerRefsRequest,
  RewriteMcpServerRefsResponse,
} from '@canopy/desktop-shared/types/mcp-servers';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import { CuratedMcpConnectionDetail } from '../CuratedMcpConnectionDetail';
import { installOnboardingPlugin } from '../../home/onboarding-suggestions/installOnboardingPlugin';
import type { AccountMcpConnectOptions } from '@/hooks/useAccountMcpActions';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockConnect = jest.fn();
const mockOAuthStart = jest.fn();
let mockDialogProps: {
  mode?: 'device' | 'account';
  onAccountConnect?: (options: {
    oauthClient?: { clientId: string; clientSecret?: string };
  }) => void;
} | null = null;

jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    selector: (state: { isEnabled: () => boolean }) => boolean,
  ): boolean => selector({ isEnabled: (): boolean => true }),
}));
jest.mock('@/hooks/useAccountMcpActions', () => ({
  useAccountMcpActions: (): object => ({
    pending: new Set<string>(),
    error: null,
    errorCode: null,
    connect: mockConnect,
    cancel: jest.fn(),
    disconnect: jest.fn(),
  }),
}));
jest.mock('@/hooks/useMarketplaceOAuth', () => ({
  useMarketplaceOAuth: (): object => ({
    pending: false,
    error: null,
    url: undefined,
    start: mockOAuthStart,
    finish: jest.fn(),
    closeBrowser: jest.fn(),
  }),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/lib/workspaceDefaultMcp', () => ({
  useMcpWorkspaceDefaultChoices: (): never[] => [],
  addMcpServerToWorkspaceDefaults: jest.fn(),
  removeMcpServerFromWorkspaceDefaults: jest.fn(),
}));
jest.mock('../PluginHarnessStatus', () => ({
  PluginHarnessStatus: (): null => null,
}));
jest.mock('../McpOAuthBrowser', () => ({ McpOAuthBrowser: (): null => null }));
jest.mock('../../home/onboarding-suggestions/installOnboardingPlugin', () => ({
  installOnboardingPlugin: jest.fn(),
}));
jest.mock('../../mcp/AccountMcpControls', () => ({
  ...jest.requireActual<object>('../../mcp/AccountMcpControls'),
  AccountMcpDetails: (): null => null,
}));
jest.mock('../../mcp/McpBrowseDialog', () => ({
  CuratedDetail: ({
    actions,
    connectionContent,
    routes,
  }: {
    actions?: JSX.Element;
    connectionContent?: JSX.Element;
    routes?: { others: React.ReactNode };
  }): JSX.Element => (
    <div data-testid="curated-detail-stub">
      {actions}
      {connectionContent}
      {routes?.others}
    </div>
  ),
}));
jest.mock('../../pages/McpServersTab', () => ({
  ...jest.requireActual<object>('../../pages/McpServersTab'),
  McpServerDialog: (props: typeof mockDialogProps): JSX.Element | null => {
    mockDialogProps = props;
    return props?.mode === 'account' ? (
      <div data-testid="mcp-account-setup-stub" />
    ) : null;
  },
}));

const entry: CuratedMcpServerEntry = {
  key: 'linear',
  name: 'Linear',
  shortDescription: 'Issues and projects',
  url: 'https://mcp.linear.example/mcp',
  transport: 'http',
  categories: [],
  popular: false,
  sortOrder: 0,
  updatedAt: '2026-10-01T00:00:00.000Z',
  // Required fields send Add through the account setup dialog.
  requiredConfigFields: [
    { kind: 'oauth-client-id' },
    { kind: 'oauth-client-secret' },
  ],
};

describe('CuratedMcpConnectionDetail account setup (REG-3033)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let authChanged: (() => void) | undefined;
  let loadAccount: jest.Mock;

  async function flush(action: () => void): Promise<void> {
    await act(async (): Promise<void> => {
      action();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockConnect.mockReset();
    mockDialogProps = null;
    authChanged = undefined;
    loadAccount = jest
      .fn()
      .mockResolvedValue({ hasApiKey: true, account: { id: 'acct-1' } });
    const api: Partial<McpServersAPI> = {
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({
          version: 1,
          servers: [],
          accountConnectionsAvailable: true,
        }),
      listStatus: (): ReturnType<McpServersAPI['listStatus']> =>
        Promise.resolve([]),
      onAuthChanged: (callback: () => void): (() => void) => {
        authChanged = callback;
        return (): void => undefined;
      },
    };
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: api,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount: loadAccount },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'mcpServers');
    Reflect.deleteProperty(window, 'api');
  });

  async function openSetup(): Promise<void> {
    await flush((): void =>
      root.render(
        <CuratedMcpConnectionDetail
          entry={entry}
          installedServerId={null}
          accountConnectionsAvailable
          onServersChanged={(): Promise<void> => Promise.resolve()}
        />,
      ),
    );
    const add = document.querySelector('[data-testid="mcp-browse-detail-add"]');
    if (!(add instanceof HTMLButtonElement)) throw new Error('Missing Add');
    await flush((): void => add.click());
    expect(
      document.querySelector('[data-testid="mcp-account-setup-stub"]'),
    ).not.toBeNull();
  }

  it('closes the setup dialog when the signed-in account changes, so its credentials never reach another account', async () => {
    await openSetup();
    if (!authChanged) throw new Error('Missing auth change subscription');
    // Inventory changes under the same account leave the dialog alone.
    await flush((): void => authChanged?.());
    expect(
      document.querySelector('[data-testid="mcp-account-setup-stub"]'),
    ).not.toBeNull();
    loadAccount.mockResolvedValue({
      hasApiKey: true,
      account: { id: 'acct-2' },
    });
    await flush((): void => authChanged?.());
    expect(
      document.querySelector('[data-testid="mcp-account-setup-stub"]'),
    ).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('binds the submitted OAuth client to the account that opened the dialog', async () => {
    await openSetup();
    const submit = mockDialogProps?.onAccountConnect;
    if (!submit) throw new Error('Missing account connect handler');
    await flush((): void =>
      submit({ oauthClient: { clientId: 'client', clientSecret: 'secret' } }),
    );
    expect(mockConnect).toHaveBeenCalledWith(
      'linear',
      'default',
      expect.objectContaining({
        expectedAccountId: 'acct-1',
        oauthClient: { clientId: 'client', clientSecret: 'secret' },
      }),
    );
  });
});

describe('CuratedMcpConnectionDetail desktop sign-ins and the account (REG-3052)', () => {
  const anyFunction: unknown = expect.any(Function);
  const linear: CuratedMcpServerEntry = {
    key: 'linear',
    name: 'Linear',
    shortDescription: 'Issues and projects',
    url: 'https://mcp.linear.example/mcp',
    transport: 'http',
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const deviceServer: McpServerData = {
    definition: {
      id: 'device-linear',
      name: 'Linear',
      description: '',
      type: 'http',
      url: 'https://mcp.linear.example/mcp',
      httpAuthHandler: 'canopy',
      curated: { key: 'linear' },
      createdAt: '',
      updatedAt: '',
    },
    configs: [
      {
        id: 'device-config',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '',
        updatedAt: '',
      },
    ],
  };
  const accountConnection: AccountMcpConnection = {
    id: 'conn-linear',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
  };
  let root: Root;
  let container: HTMLDivElement;
  let authStatus: 'connected' | 'not_connected';
  let rewriteServerRefs: jest.Mock;
  let deleteServer: jest.Mock;
  let movedRefs: RewriteMcpServerRefsRequest[];
  const anyString: unknown = expect.any(String);

  // Stands in for main: the fingerprint check, the rewrite and the removal
  // are one step against whatever the server file holds at that moment.
  async function fakeMainRewrite(
    request: RewriteMcpServerRefsRequest,
  ): Promise<RewriteMcpServerRefsResponse> {
    if (
      request.retire &&
      stableStringify(currentDeviceServer) !== request.retire.fingerprint
    )
      return {
        globalDefaults: false,
        workspaces: 0,
        chats: 0,
        retired: 'changed',
      };
    movedRefs.push(request);
    if (request.retire) await deleteServer(request.retire.serverId);
    return {
      globalDefaults: false,
      workspaces: 1,
      chats: 0,
      ...(request.retire ? { retired: 'removed' as const } : {}),
    };
  }
  let onServersChanged: jest.Mock;
  let currentDeviceServer: McpServerData;

  async function flush(
    action: () => void = (): void => undefined,
  ): Promise<void> {
    await act(async (): Promise<void> => {
      action();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function status(): string {
    return (
      byTestId('plugin-account-connection')?.querySelector('[aria-live]')
        ?.textContent ?? ''
    );
  }

  beforeEach(() => {
    mockConnect.mockReset();
    mockOAuthStart.mockReset();
    authStatus = 'connected';
    currentDeviceServer = deviceServer;
    movedRefs = [];
    deleteServer = jest.fn().mockResolvedValue(undefined);
    rewriteServerRefs = jest.fn(fakeMainRewrite);
    onServersChanged = jest.fn().mockResolvedValue(undefined);
    const statusEntry = (): McpServerStatusEntry => ({
      serverId: 'device-linear',
      transport: 'http',
      connectionStatus: 'connected',
      reachability: 'reachable',
      configs: [{ configId: 'device-config', authStatus }],
    });
    const api: Partial<McpServersAPI> = {
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({
          version: 1,
          servers: [],
          accountConnectionsAvailable: true,
        }),
      loadServer: (): ReturnType<McpServersAPI['loadServer']> =>
        Promise.resolve({ version: 1, server: currentDeviceServer }),
      listStatus: (): ReturnType<McpServersAPI['listStatus']> =>
        Promise.resolve([statusEntry()]),
      rewriteServerRefs,
      deleteServer,
      onAuthChanged: (): (() => void) => (): void => undefined,
    };
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: api,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest
          .fn()
          .mockResolvedValue({ hasApiKey: true, account: { id: 'acct-1' } }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'mcpServers');
    Reflect.deleteProperty(window, 'api');
  });

  async function renderDetail(
    props: Partial<Parameters<typeof CuratedMcpConnectionDetail>[0]> = {},
  ): Promise<void> {
    await flush((): void =>
      root.render(
        <CuratedMcpConnectionDetail
          entry={linear}
          installedServerId="device-linear"
          accountConnectionsAvailable
          onServersChanged={onServersChanged}
          {...props}
        />,
      ),
    );
  }

  it('never mounts app connection controls or starts sign-in for provider-only entries, even with a legacy device server', async () => {
    const loadServer = jest.spyOn(window.mcpServers, 'loadServer');
    const listStatus = jest.spyOn(window.mcpServers, 'listStatus');
    await renderDetail({
      entry: {
        ...linear,
        oauthHints: undefined,
        requiredConfigFields: undefined,
        providerConnector: { providers: ['claude', 'codex'] },
      },
      autoConnect: true,
      providerConnections: (
        <section data-testid="provider-route">Provider connections</section>
      ),
    });
    expect(byTestId('plugin-account-connection')).toBeNull();
    expect(byTestId('plugin-advanced-configuration')).toBeNull();
    expect(byTestId('mcp-browse-detail-add')).toBeNull();
    expect(byTestId('provider-route')).not.toBeNull();
    expect(loadServer).not.toHaveBeenCalled();
    expect(listStatus).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockOAuthStart).not.toHaveBeenCalled();
  });

  it('keeps the folded plugin skills on a provider-only card (REG-3033)', async () => {
    // A provider-only card has no app connection, but the plugin folded into
    // it still installs: Install skills only installs it alone, and a
    // provider route the host starts from Add requests it.
    const install = jest.mocked(installOnboardingPlugin);
    install.mockReset();
    install.mockResolvedValue(undefined);
    const providerOnly = {
      ...linear,
      oauthHints: undefined,
      requiredConfigFields: undefined,
      providerConnector: { providers: ['claude' as const] },
    };
    const foldedPlugin = {
      key: 'linear',
      name: 'Linear',
      skills: 2,
      installed: false,
    };
    await renderDetail({
      entry: providerOnly,
      foldedPlugin,
      providerConnections: <section data-testid="provider-route" />,
    });
    const installSkills = byTestId('mcp-browse-detail-install-skills');
    expect(installSkills?.textContent).toBe('Install skills only');
    await flush((): void => installSkills?.click());
    expect(install).toHaveBeenCalledTimes(1);
    expect(byTestId('mcp-browse-detail-skills-installed')?.textContent).toBe(
      'Linear skills are installed.',
    );
    expect(byTestId('mcp-browse-detail-install-skills')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    install.mockClear();
    await renderDetail({
      entry: providerOnly,
      foldedPlugin,
      installFoldedPluginRequest: 0,
      providerConnections: <section data-testid="provider-route" />,
    });
    expect(install).not.toHaveBeenCalled();
    await renderDetail({
      entry: providerOnly,
      foldedPlugin,
      installFoldedPluginRequest: 1,
      providerConnections: <section data-testid="provider-route" />,
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('keeps the guidance and skills status on a provider-only card whose connector did not fold in (REG-3033)', async () => {
    // With no provider CLI to read, no connector folds into the card, so no
    // provider route renders. The card still says how to connect and still
    // reports what Install skills only did.
    const install = jest.mocked(installOnboardingPlugin);
    install.mockReset();
    install.mockRejectedValue(new Error('Install failed'));
    await renderDetail({
      entry: {
        ...linear,
        oauthHints: undefined,
        requiredConfigFields: undefined,
        providerConnector: { providers: ['claude' as const] },
      },
      foldedPlugin: {
        key: 'linear',
        name: 'Linear',
        skills: 2,
        installed: false,
      },
    });
    expect(
      byTestId('mcp-browse-detail-provider-guidance')?.textContent,
    ).toContain('Linear connects through your Claude account.');
    await flush((): void =>
      byTestId('mcp-browse-detail-install-skills')?.click(),
    );
    expect(byTestId('mcp-browse-detail-skills-error')?.textContent).toBe(
      'Install failed',
    );
    expect(byTestId('mcp-browse-detail-install-skills')?.textContent).toBe(
      'Install skills only',
    );

    install.mockResolvedValue(undefined);
    await flush((): void =>
      byTestId('mcp-browse-detail-install-skills')?.click(),
    );
    expect(byTestId('mcp-browse-detail-skills-installed')?.textContent).toBe(
      'Linear skills are installed.',
    );
    expect(byTestId('mcp-browse-detail-provider-guidance')).not.toBeNull();
  });

  it('says a device sign-in is on this desktop only and moves it to the account through the account sign-in', async () => {
    mockConnect.mockImplementation(
      async (
        _key: string,
        _config: string,
        options: {
          onConnected?: (connection: AccountMcpConnection) => Promise<void>;
        },
      ): Promise<undefined> => {
        await options.onConnected?.(accountConnection);
        return undefined;
      },
    );
    await renderDetail();
    expect(status()).toBe('Linear is connected on this desktop only');
    expect(byTestId('plugin-account-connection')?.textContent).toContain(
      "Connect it to your account to use Linear on the web and in cloud chats. You'll sign in to Linear once more.",
    );
    const move = byTestId('mcp-browse-detail-connect-account');
    expect(move?.textContent).toBe('Connect Linear to your account');
    await flush((): void => move?.click());
    expect(mockConnect).toHaveBeenCalledWith(
      'linear',
      'default',
      expect.objectContaining({ onConnected: anyFunction }),
    );
    expect(mockOAuthStart).not.toHaveBeenCalled();
    expect(rewriteServerRefs).toHaveBeenCalledWith({
      from: [{ serverId: 'device-linear', configId: 'device-config' }],
      to: { serverId: 'linear', configId: 'default' },
      retire: { serverId: 'device-linear', fingerprint: anyString },
    });
    expect(deleteServer).toHaveBeenCalledWith('device-linear');
    expect(rewriteServerRefs.mock.invocationCallOrder[0]).toBeLessThan(
      deleteServer.mock.invocationCallOrder[0],
    );
    expect(onServersChanged).toHaveBeenCalled();
  });

  it('keeps the device server when a configuration is saved while its references move to the account', async () => {
    mockConnect.mockImplementation(
      async (
        _key: string,
        _config: string,
        options: {
          onConnected?: (connection: AccountMcpConnection) => Promise<void>;
        },
      ): Promise<undefined> => {
        await options.onConnected?.(accountConnection);
        return undefined;
      },
    );
    rewriteServerRefs.mockImplementationOnce(
      (request: RewriteMcpServerRefsRequest) => {
        currentDeviceServer = {
          ...deviceServer,
          configs: [
            ...deviceServer.configs,
            { ...deviceServer.configs[0], id: 'saved-meanwhile', name: 'Work' },
          ],
        };
        return fakeMainRewrite(request);
      },
    );
    await renderDetail();
    await flush((): void =>
      byTestId('mcp-browse-detail-connect-account')?.click(),
    );
    expect(rewriteServerRefs).toHaveBeenCalledTimes(1);
    expect(movedRefs).toEqual([]);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(byTestId('plugin-account-connection')?.textContent).toContain(
      "Its setup on this desktop changed while you signed in, so it wasn't removed.",
    );
  });

  it('does not bring back a replaced device server when an older status refresh finishes afterwards', async () => {
    let authChanged: (() => void) | undefined;
    let releaseStatus: (() => void) | undefined;
    const api = window.mcpServers as Partial<McpServersAPI>;
    const listStatus = api.listStatus;
    api.onAuthChanged = (listener: () => void): (() => void) => {
      authChanged = listener;
      return (): void => undefined;
    };
    mockConnect.mockImplementation(
      async (
        _key: string,
        _config: string,
        options: {
          onConnected?: (connection: AccountMcpConnection) => Promise<void>;
        },
      ): Promise<undefined> => {
        await options.onConnected?.(accountConnection);
        return undefined;
      },
    );
    await renderDetail();
    expect(status()).toBe('Linear is connected on this desktop only');
    api.listStatus = (): ReturnType<McpServersAPI['listStatus']> =>
      new Promise((resolve) => {
        releaseStatus = (): void => {
          void listStatus?.().then(resolve);
        };
      });
    await flush((): void => authChanged?.());
    api.listStatus = listStatus;
    await flush((): void =>
      byTestId('mcp-browse-detail-connect-account')?.click(),
    );
    expect(deleteServer).toHaveBeenCalledWith('device-linear');
    await flush((): void => releaseStatus?.());
    expect(status()).not.toBe('Linear is connected on this desktop only');
    expect(byTestId('mcp-browse-detail-connect-account')).toBeNull();
  });

  it('keeps the device server, its configurations, and their references when one is added while the account sign-in is pending', async () => {
    const [firstConfig] = deviceServer.configs;
    if (!firstConfig) throw new Error('Missing device configuration');
    let finishSignIn: () => Promise<void> = (): Promise<void> =>
      Promise.resolve();
    mockConnect.mockImplementation(
      (
        _key: string,
        _config: string,
        options: {
          onConnected?: (connection: AccountMcpConnection) => Promise<void>;
        },
      ): Promise<undefined> =>
        new Promise((resolve): void => {
          finishSignIn = async (): Promise<void> => {
            await options.onConnected?.(accountConnection);
            resolve(undefined);
          };
        }),
    );
    await renderDetail();
    await flush((): void =>
      byTestId('mcp-browse-detail-connect-account')?.click(),
    );
    expect(mockConnect).toHaveBeenCalled();
    expect(
      byTestId('plugin-advanced-configuration')?.hasAttribute('disabled'),
    ).toBe(true);
    currentDeviceServer = {
      ...deviceServer,
      configs: [...deviceServer.configs, { ...firstConfig, id: 'work' }],
    };
    await flush((): void => void finishSignIn());
    expect(rewriteServerRefs).not.toHaveBeenCalled();
    expect(deleteServer).not.toHaveBeenCalled();
    expect(byTestId('mcp-browse-detail-move-notice')?.textContent).toBe(
      "Linear is connected to your account. Its setup on this desktop changed while you signed in, so it wasn't removed.",
    );
    expect(
      byTestId('plugin-advanced-configuration')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it.each([
    [
      'its address',
      (server: McpServerData): McpServerData => ({
        ...server,
        definition: {
          ...server.definition,
          url: 'https://mcp.linear.example/v2',
        },
      }),
    ],
    [
      'its configuration headers',
      (server: McpServerData): McpServerData => ({
        ...server,
        configs: server.configs.map((config) => ({
          ...config,
          extraHeaders: { 'X-Team': 'platform' },
        })),
      }),
    ],
  ])(
    'keeps the device server and its references when %s changes while the account sign-in is pending',
    async (_label, edit) => {
      let finishSignIn: () => Promise<void> = (): Promise<void> =>
        Promise.resolve();
      mockConnect.mockImplementation(
        (
          _key: string,
          _config: string,
          options: {
            onConnected?: (connection: AccountMcpConnection) => Promise<void>;
          },
        ): Promise<undefined> =>
          new Promise((resolve): void => {
            finishSignIn = async (): Promise<void> => {
              await options.onConnected?.(accountConnection);
              resolve(undefined);
            };
          }),
      );
      await renderDetail();
      await flush((): void =>
        byTestId('mcp-browse-detail-connect-account')?.click(),
      );
      expect(mockConnect).toHaveBeenCalled();
      currentDeviceServer = edit(deviceServer);
      await flush((): void => void finishSignIn());
      expect(rewriteServerRefs).not.toHaveBeenCalled();
      expect(deleteServer).not.toHaveBeenCalled();
      expect(byTestId('mcp-browse-detail-move-notice')?.textContent).toBe(
        "Linear is connected to your account. Its setup on this desktop changed while you signed in, so it wasn't removed.",
      );
    },
  );

  it('keeps the device server when the account sign-in does not finish', async () => {
    mockConnect.mockResolvedValue('connection-timeout');
    await renderDetail();
    await flush((): void =>
      byTestId('mcp-browse-detail-connect-account')?.click(),
    );
    expect(mockConnect).toHaveBeenCalled();
    expect(rewriteServerRefs).not.toHaveBeenCalled();
    expect(deleteServer).not.toHaveBeenCalled();
  });

  it('switches to an account connection that already exists without signing in again', async () => {
    authStatus = 'not_connected';
    await renderDetail({ accountConnectionBehindDevice: accountConnection });
    expect(status()).toBe('Linear is connected to your account');
    expect(byTestId('plugin-account-connection')?.textContent).toContain(
      'Use that connection on this desktop too',
    );
    expect(byTestId('mcp-browse-detail-add')).toBeNull();
    const use = byTestId('mcp-browse-detail-connect-account');
    expect(use?.textContent).toBe('Use Linear from your account');
    await flush((): void => use?.click());
    expect(mockConnect).not.toHaveBeenCalled();
    expect(rewriteServerRefs).toHaveBeenCalledWith({
      from: [{ serverId: 'device-linear', configId: 'device-config' }],
      to: { serverId: 'linear', configId: 'default' },
      retire: { serverId: 'device-linear', fingerprint: anyString },
    });
    expect(deleteServer).toHaveBeenCalledWith('device-linear');
  });

  it('signs a signed-out device server in through the account the next time it connects', async () => {
    authStatus = 'not_connected';
    await renderDetail();
    await flush((): void => byTestId('mcp-browse-detail-add')?.click());
    expect(mockOAuthStart).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledWith(
      'linear',
      'default',
      expect.objectContaining({ onConnected: anyFunction }),
    );
  });

  it.each([
    [
      'a desktop-only entry',
      { entry: { ...linear, availability: 'desktop' as const } },
    ],
    ['unavailable account connections', { accountConnectionsAvailable: false }],
  ])('keeps %s signing in on this desktop', async (_label, props) => {
    await renderDetail(props);
    expect(status()).toBe('Linear is connected on this desktop');
    expect(byTestId('mcp-browse-detail-connect-account')).toBeNull();
    authStatus = 'not_connected';
    act(() => root.unmount());
    root = createRoot(container);
    await renderDetail(props);
    expect(status()).toBe("Linear isn't connected on this desktop");
    await flush((): void => byTestId('mcp-browse-detail-add')?.click());
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockOAuthStart).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'device-linear',
        configId: 'device-config',
      }),
    );
  });

  it.each([
    [
      'a custom endpoint',
      (server: McpServerData): McpServerData => ({
        ...server,
        definition: {
          ...server.definition,
          url: 'https://linear.internal.example/mcp',
        },
      }),
    ],
    [
      'custom headers',
      (server: McpServerData): McpServerData => ({
        ...server,
        configs: server.configs.map((config) => ({
          ...config,
          extraHeaders: { 'X-Team': 'platform' },
        })),
      }),
    ],
    [
      'its own OAuth client on the default endpoint',
      (server: McpServerData): McpServerData => ({
        ...server,
        definition: {
          ...server.definition,
          oauth: { clientId: 'my-own-app', scopes: ['read', 'write'] },
        },
      }),
    ],
  ])(
    'keeps a device server with %s on this desktop and never replaces it',
    async (_label, customize) => {
      currentDeviceServer = customize(deviceServer);
      await renderDetail();
      expect(status()).toBe('Linear is connected on this desktop');
      expect(byTestId('mcp-browse-detail-connect-account')).toBeNull();
      expect(byTestId('plugin-account-connection')?.textContent).toContain(
        'Linear has a custom setup on this desktop, so it stays here.',
      );
      authStatus = 'not_connected';
      act(() => root.unmount());
      root = createRoot(container);
      await renderDetail();
      expect(status()).toBe("Linear isn't connected on this desktop");
      await flush((): void => byTestId('mcp-browse-detail-add')?.click());
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockOAuthStart).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'device-linear' }),
      );
      expect(rewriteServerRefs).not.toHaveBeenCalled();
      expect(deleteServer).not.toHaveBeenCalled();
    },
  );

  it('words a signed-out device server by where Connect will sign it in', async () => {
    authStatus = 'not_connected';
    await renderDetail();
    expect(status()).toBe("Linear isn't connected to your account");
    expect(byTestId('mcp-browse-detail-connect-account')).toBeNull();
    expect(byTestId('mcp-browse-detail-add')?.textContent).toBe(
      'Connect Linear',
    );
  });

  it('leaves the harness sentence to the route heading beside provider connections (REG-3033)', async () => {
    // Beside the provider route the section description already says the
    // server works with every supported harness, so the card keeps only what
    // it adds, in both states, and its heading sits under the route's.
    const providerConnections = <section data-testid="provider-route" />;
    const card = (): HTMLElement | null =>
      byTestId('plugin-account-connection');
    const remount = (): void => {
      act(() => root.unmount());
      root = createRoot(container);
    };

    await renderDetail({ installedServerId: null, accountConnection });
    expect(card()?.textContent).toContain(
      'Shared across your supported harnesses.',
    );
    expect(card()?.querySelector('h3')?.textContent).toBe('Connection');
    remount();
    await renderDetail({
      installedServerId: null,
      accountConnection,
      providerConnections,
    });
    expect(card()?.textContent).not.toContain('supported harnesses');
    expect(card()?.querySelector('h3')).toBeNull();
    expect(card()?.querySelector('h4')?.textContent).toBe('Connection');

    remount();
    await renderDetail({ installedServerId: null });
    expect(card()?.textContent).toContain(
      'Connect once for all supported harnesses.',
    );
    remount();
    await renderDetail({ installedServerId: null, providerConnections });
    expect(card()?.textContent).not.toContain('supported harnesses');

    remount();
    await renderDetail({
      installedServerId: null,
      providerConnections,
      foldedPlugin: {
        key: 'linear',
        name: 'Linear',
        skills: 2,
        installed: false,
      },
    });
    expect(card()?.textContent).toContain(
      'Add also installs the Linear skills.',
    );
    expect(card()?.textContent).not.toContain('supported harnesses');
  });

  it('words a new server by where Add will connect it', async () => {
    await renderDetail({ installedServerId: null });
    expect(status()).toBe("Linear isn't connected to your account");
    expect(byTestId('mcp-browse-detail-add')?.textContent).toBe('Add');
    act(() => root.unmount());
    root = createRoot(container);
    await renderDetail({
      installedServerId: null,
      accountConnection: { ...accountConnection, status: 'REAUTH_REQUIRED' },
    });
    expect(status()).toBe('Linear needs reconnecting');
    act(() => root.unmount());
    root = createRoot(container);
    await renderDetail({ installedServerId: null, accountConnection });
    expect(status()).toBe('Linear is connected to your account');
  });

  it('shows the device server health and tests its configuration (CAN-4265)', async () => {
    const testConnection = jest.fn().mockResolvedValue({
      serverId: 'device-linear',
      configId: 'device-config',
      success: true,
      message: 'Connected',
      tools: ['issues'],
    });
    Object.assign(window.mcpServers, { testConnection });
    await renderDetail();
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Connected');
    await flush((): void => byTestId('mcp-health-test')?.click());
    expect(testConnection).toHaveBeenCalledWith(
      'device-linear',
      'device-config',
    );
    expect(byTestId('mcp-health-result')?.dataset.success).toBe('true');
  });

  it('deletes the device server only after confirmation, then leaves (CAN-4265)', async () => {
    const onDeleted = jest.fn();
    await renderDetail({ onDeleted });
    expect(byTestId('mcp-management-placement')?.textContent).toBe(
      'This device',
    );
    await flush((): void => byTestId('mcp-management-delete')?.click());
    await flush((): void => byTestId('mcp-management-delete-cancel')?.click());
    expect(deleteServer).not.toHaveBeenCalled();
    await flush((): void => byTestId('mcp-management-delete')?.click());
    await flush((): void => byTestId('mcp-management-delete-confirm')?.click());
    expect(deleteServer).toHaveBeenCalledTimes(1);
    expect(deleteServer).toHaveBeenCalledWith('device-linear');
    expect(onServersChanged).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('keeps the detail with an error when deletion fails (CAN-4265)', async () => {
    const onDeleted = jest.fn();
    deleteServer.mockRejectedValue(new Error('File is locked'));
    await renderDetail({ onDeleted });
    await flush((): void => byTestId('mcp-management-delete')?.click());
    await flush((): void => byTestId('mcp-management-delete-confirm')?.click());
    expect(onDeleted).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('File is locked');
  });

  it('shows a failed IPC deletion without the Electron wrapper (CAN-4265)', async () => {
    deleteServer.mockRejectedValue(
      new Error(
        "Error invoking remote method 'mcp-servers:delete-server': Error: The server file is in use. Try again.",
      ),
    );
    await renderDetail();
    await flush((): void => byTestId('mcp-management-delete')?.click());
    await flush((): void => byTestId('mcp-management-delete-confirm')?.click());
    const dialog = byTestId('mcp-management-delete-dialog')?.textContent;
    expect(dialog).toContain('The server file is in use. Try again.');
    expect(dialog).not.toContain('Error invoking remote method');
  });

  it('shows a thrown IPC test failure without the Electron wrapper (CAN-4265)', async () => {
    Object.assign(window.mcpServers, {
      testConnection: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'mcp-servers:test-connection': Error: Server not found",
          ),
        ),
    });
    await renderDetail();
    await flush((): void => byTestId('mcp-health-test')?.click());
    const section = byTestId('mcp-health-section')?.textContent;
    expect(section).toContain('Server not found');
    expect(section).not.toContain('Error invoking remote method');
  });

  it('shows account health without device actions (CAN-4265)', async () => {
    await renderDetail({
      installedServerId: null,
      accountConnection: { ...accountConnection, status: 'REAUTH_REQUIRED' },
    });
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Auth required');
    expect(byTestId('mcp-management-placement')?.textContent).toBe(
      'Cloud account',
    );
    expect(byTestId('mcp-health-test')?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('mcp-management-delete')).not.toBeNull();
  });
  it('retains the curated cloud connection when deleting its device copy', async () => {
    const removeAccountConnection = jest.fn();
    Object.assign(window.mcpServers, { removeAccountConnection });
    currentDeviceServer = {
      ...deviceServer,
      definition: { ...deviceServer.definition, httpAuthHandler: 'account' },
    };
    const device = {
      id: 'device-linear',
      name: 'Linear',
      description: '',
      type: 'http' as const,
      configs: [{ id: 'device-config', name: 'Default', enabled: true }],
      updatedAt: '',
    };
    jest.spyOn(window.mcpServers, 'loadIndex').mockResolvedValue({
      version: 1,
      accountConnectionsAvailable: true,
      servers: [
        {
          ...device,
          id: 'account:conn-linear',
          accountConnection,
          deviceCopies: [device],
        },
      ],
    });
    await renderDetail();
    await flush(() => byTestId('mcp-management-delete')?.click());
    expect(document.body.textContent).toContain('stays in your cloud account');
    await flush(() => byTestId('mcp-management-delete-confirm')?.click());
    expect(deleteServer).toHaveBeenCalledWith('device-linear');
    expect(removeAccountConnection).not.toHaveBeenCalled();
  });
  it('tries an existing custom OAuth registration before requesting credentials', async () => {
    await renderDetail({
      installedServerId: null,
      accountConnection: {
        ...accountConnection,
        kind: 'CUSTOM',
        status: 'DISCONNECTED',
        authMode: 'OAUTH',
      },
    });
    await flush(() => byTestId('mcp-management-account')?.click());
    expect(mockConnect).toHaveBeenCalledWith(
      'linear',
      'default',
      expect.objectContaining({ expectedAccountId: 'acct-1' }),
    );
    expect(byTestId('mcp-account-oauth-client-id')).toBeNull();
  });
  it('requests OAuth credentials only when reconnect requires them', async () => {
    mockConnect.mockImplementation(
      (_key: string, _config: string, options: AccountMcpConnectOptions) => {
        options.onOAuthClientRequired?.({
          redirectUri: 'https://cloud.example/callback',
          issuer: 'https://auth.example',
          clientSecretRequired: true,
          clientSecretAccepted: true,
        });
        return Promise.resolve('oauth-client-required');
      },
    );
    await renderDetail({
      installedServerId: null,
      accountConnection: {
        ...accountConnection,
        kind: 'CUSTOM',
        status: 'DISCONNECTED',
        authMode: 'OAUTH',
      },
    });
    await flush(() => byTestId('mcp-management-account')?.click());
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(byTestId('mcp-account-oauth-client-id')).not.toBeNull();
  });
  it('deletes an account-only target through the account removal service (CAN-4265)', async () => {
    const removeAccountConnection = jest
      .fn()
      .mockResolvedValue({ removed: true });
    Object.assign(window.mcpServers, { removeAccountConnection });
    const onDeleted = jest.fn();
    await renderDetail({
      installedServerId: null,
      accountConnection,
      onDeleted,
    });
    await flush(() => byTestId('mcp-management-delete')?.click());
    expect(document.body.textContent).toContain('cloud account');
    await flush(() => byTestId('mcp-management-delete-confirm')?.click());
    expect(removeAccountConnection).toHaveBeenCalledWith(accountConnection.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
  it('blocks cloud deletion after the captured account changes (CAN-4265)', async () => {
    const removeAccountConnection = jest.fn();
    Object.assign(window.mcpServers, { removeAccountConnection });
    await renderDetail({ installedServerId: null, accountConnection });
    await flush(() => byTestId('mcp-management-delete')?.click());
    jest
      .mocked(window.api.loadCanopyCloudAccount)
      .mockResolvedValue({ account: { id: 'other' }, hasApiKey: true });
    await flush(() => byTestId('mcp-management-delete-confirm')?.click());
    expect(removeAccountConnection).not.toHaveBeenCalled();
    expect(byTestId('mcp-management-delete-confirm')).not.toBeNull();
  });
  it('refreshes account state when deletion only signs out an older cloud (CAN-4265)', async () => {
    Object.assign(window.mcpServers, {
      removeAccountConnection: jest.fn().mockResolvedValue({ removed: false }),
    });
    const onDeleted = jest.fn();
    await renderDetail({
      installedServerId: null,
      accountConnection,
      onDeleted,
    });
    onServersChanged.mockClear();
    await flush(() => byTestId('mcp-management-delete')?.click());
    await flush(() => byTestId('mcp-management-delete-confirm')?.click());
    expect(onServersChanged).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('only signed out');
  });
});
