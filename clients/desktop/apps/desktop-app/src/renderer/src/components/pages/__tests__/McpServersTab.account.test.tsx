/** @jest-environment jsdom */
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  ACCOUNT_MCP_ACTION_EVENT,
  type AccountMcpActionEventDetail,
} from '@/lib/accountMcpEvents';
jest.mock('@/hooks/useCurrentUiStateReporter', (): object => ({
  useCurrentUiStateReporter: jest.fn(),
}));
import { act } from 'react';
import { brandText } from '@/lib/brand';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CanopyServerAccountInfo,
} from '@canopy/desktop-shared/types';
import type {
  AccountMcpConnection,
  McpServerFileView,
  McpServerIndexEntry,
  McpServersAPI,
  SaveMcpServerRequest,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  McpServersTab,
  McpServerDetailOverlay,
  McpServerDialog,
} from '../McpServersTab';
import { AccountMcpDetails, McpTierBadge } from '../../mcp/AccountMcpControls';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

function accountInfo(id: string): CanopyServerAccountInfo {
  return {
    id,
    name: 'Test account',
    email: 'test@example.test',
    role: 'DEVELOPER',
  };
}

function cloudAccountState(
  hasApiKey: boolean,
  account?: CanopyServerAccountInfo,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey,
    authMode: hasApiKey ? 'oauth' : null,
    credentialSource: hasApiKey ? 'oauth_desktop' : null,
    capabilities: [],
    storageAvailable: true,
    ...(account === undefined ? {} : { account }),
  };
}

function createSaveServerMock(): jest.Mock<
  Promise<McpServerFileView>,
  [SaveMcpServerRequest]
> {
  return jest.fn<Promise<McpServerFileView>, [SaveMcpServerRequest]>(
    (server): Promise<McpServerFileView> =>
      Promise.resolve({ version: 1, server }),
  );
}

let mockEntries: Awaited<ReturnType<McpServersAPI['listCurated']>>['servers'] =
  [];
let mockEnabled = true;
let mockAvailable = true;
let mockUnavailableReason: 'unavailable' | undefined;
let mockServers: McpServerIndexEntry[] = [];
const mockRefresh = jest.fn((): Promise<void> => Promise.resolve());
let mockRefreshedEntries: typeof mockEntries = [];
const mockRefreshCurated = jest.fn(
  (): Promise<typeof mockEntries> => Promise.resolve(mockRefreshedEntries),
);
const mockLoadPreferences = jest.fn<Promise<unknown>, []>();
const mockLoadCanopyCloudAccount = jest.fn<
  Promise<CanopyCloudAccountPublicState>,
  []
>();
jest.mock(
  '@/stores/featureFlagsStore',
  (): Record<string, unknown> => ({
    useFeatureFlagsStore: Object.assign((): boolean => mockEnabled, {
      getState: (): { isEnabled: () => boolean } => ({
        isEnabled: (): boolean => false,
      }),
    }),
  }),
);
jest.mock(
  '../../../hooks/useMcpServerList',
  (): Record<string, unknown> => ({
    useMcpServerList: (): Record<string, unknown> => ({
      servers: mockServers,
      loading: false,
      error: null,
      refresh: mockRefresh,
      accountConnectionsAvailable: mockAvailable,
      accountConnectionsUnavailableReason: mockUnavailableReason,
    }),
  }),
);
jest.mock(
  '../../../hooks/useCuratedMcpServers',
  (): Record<string, unknown> => ({
    useCuratedMcpServers: (): Record<string, unknown> => ({
      entries: mockEntries,
      refresh: mockRefreshCurated,
    }),
  }),
);
jest.mock(
  '../../../hooks/useMcpServerStatuses',
  (): Record<string, unknown> => ({
    useMcpServerStatuses: (): Record<string, unknown> => ({
      statuses: new Map(
        mockServers.map((row) => [row.id, { handler: row.authHandler }]),
      ),
      refresh: jest.fn(),
    }),
  }),
);
const connection: AccountMcpConnection = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  serverKey: 'github',
  configId: 'default',
  displayName: 'GitHub',
  status: 'DISCONNECTED',
  routeId: 'route',
  enabledTools: null,
  kind: 'CURATED',
};
const device: McpServerIndexEntry = {
  id: 'aabbcc',
  name: 'GitHub',
  description: '',
  type: 'http',
  curatedKey: 'github',
  configs: [{ id: 'ddeeff', name: 'Default', enabled: true }],
  updatedAt: '',
};
const account: McpServerIndexEntry = {
  ...device,
  id: connection.serverKey,
  scope: 'account',
  authHandler: 'account',
  accountConnectionId: connection.id,
  accountConnection: connection,
  configs: [{ id: 'default', name: 'Default', enabled: true }],
  deviceCopies: [device],
};
let root: Root;
let container: HTMLDivElement;
let originalApi: PropertyDescriptor | undefined;
let originalPreferencesApi: PropertyDescriptor | undefined;
beforeEach((): void => {
  useNavigationStore.setState({ settingsOpen: false });
  mockEntries = [];
  mockRefreshedEntries = [];
  mockEnabled = true;
  mockAvailable = true;
  mockUnavailableReason = undefined;
  mockServers = [account];
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  originalApi = Object.getOwnPropertyDescriptor(window, 'mcpServers');
  originalPreferencesApi = Object.getOwnPropertyDescriptor(window, 'api');
  mockLoadPreferences.mockResolvedValue({});
  mockLoadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('acct-1')),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadPreferences: mockLoadPreferences,
      loadCanopyCloudAccount: mockLoadCanopyCloudAccount,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
  if (originalApi) Object.defineProperty(window, 'mcpServers', originalApi);
  else Reflect.deleteProperty(window, 'mcpServers');
  if (originalPreferencesApi)
    Object.defineProperty(window, 'api', originalPreferencesApi);
  else Reflect.deleteProperty(window, 'api');
});
function install(api: Partial<McpServersAPI>): void {
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    writable: true,
    value: api,
  });
}
function button(text: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll('button')).find(
    (entry): boolean => entry.textContent === text,
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
it('shows account tier, connection actions, and a secondary device copy with the flag on', async (): Promise<void> => {
  await flush((): void => root.render(<McpServersTab />));
  expect(
    container.querySelector('[data-testid="mcp-tier-badge"]')?.textContent,
  ).toBe('Cloud + desktop');
  expect(button('Connect')).toBeDefined();
  expect(button('Device copy')).toBeDefined();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
});
it('opens the account details from the row Details button (REG-3033)', async (): Promise<void> => {
  // Rows are keyed by connection id now; the Details button must store the
  // same key the details lookup reads, since its cell stops propagation and
  // the row click cannot stand in for it.
  install({});
  await flush((): void => root.render(<McpServersTab />));
  const details = container.querySelector(
    '[data-testid="mcp-account-details-button"]',
  );
  if (!(details instanceof HTMLButtonElement))
    throw new Error('Missing Details button');
  await flush((): void => details.click());
  expect(
    document.querySelector('[data-testid="mcp-account-details"]'),
  ).not.toBeNull();
});
it('closes an open account setup dialog when the signed-in account changes', async (): Promise<void> => {
  mockServers = [device];
  mockEntries = [
    {
      key: 'github',
      name: 'GitHub',
      shortDescription: '',
      url: 'https://mcp.example.test',
      transport: 'http',
      categories: [],
      popular: true,
      sortOrder: 0,
      updatedAt: '',
      requiredConfigFields: [
        { kind: 'oauth-client-id' as const },
        { kind: 'oauth-client-secret' as const },
      ],
    },
  ];
  const start = jest.fn();
  let authChanged: (() => void) | undefined;
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account] }),
    onAuthChanged: (callback: () => void): (() => void) => {
      authChanged = callback;
      return (): void => undefined;
    },
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).not.toBeNull();
  if (!authChanged) throw new Error('Missing auth change subscription');
  // Inventory changes under the same account leave the dialog alone.
  await flush((): void => authChanged?.());
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).not.toBeNull();
  mockLoadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('acct-2')),
  );
  await flush((): void => authChanged?.());
  // Credentials typed for the previous sign-in are discarded with the dialog.
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).toBeNull();
  expect(start).not.toHaveBeenCalled();
});
it('refuses to submit account setup credentials captured under another account', async (): Promise<void> => {
  mockServers = [device];
  mockEntries = [
    {
      key: 'github',
      name: 'GitHub',
      shortDescription: '',
      url: 'https://mcp.example.test',
      transport: 'http',
      categories: [],
      popular: true,
      sortOrder: 0,
      updatedAt: '',
      requiredConfigFields: [
        { kind: 'oauth-client-id' as const },
        { kind: 'oauth-client-secret' as const },
      ],
    },
  ];
  const start = jest.fn();
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).not.toBeNull();
  // The dialog captured acct-1 when it opened; sign-in changes before submit
  // without the dialog hearing about it.
  mockLoadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('acct-2')),
  );
  const clientId = document.querySelector<HTMLInputElement>(
    '[data-testid="mcp-account-oauth-client-id"]',
  );
  if (!clientId) throw new Error('Missing account client id');
  await flush((): void => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(clientId, 'fresh-client');
    clientId.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await fillAccountInput('oauth-client-secret', 'fresh-secret');
  await flush((): void => button('Connect').click());
  expect(start).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Account changed. Connect again.');
});
it.each([
  ['signed out', cloudAccountState(false)],
  ['unreadable', new Error('offline')],
] as const)(
  'keeps account setup closed when the account is %s',
  async (_label, outcome): Promise<void> => {
    mockServers = [device];
    mockEntries = [
      {
        key: 'github',
        name: 'GitHub',
        shortDescription: '',
        url: 'https://mcp.example.test',
        transport: 'http',
        categories: [],
        popular: true,
        sortOrder: 0,
        updatedAt: '',
        requiredConfigFields: [
          { kind: 'oauth-client-id' as const },
          { kind: 'oauth-client-secret' as const },
        ],
      },
    ];
    if (outcome instanceof Error)
      mockLoadCanopyCloudAccount.mockRejectedValue(outcome);
    else mockLoadCanopyCloudAccount.mockResolvedValue(outcome);
    const start = jest.fn();
    install({
      startAccountConnection: start,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [account] }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Make available in cloud').click());
    expect(
      document.querySelector('[data-testid="mcp-account-setup"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      'Sign in to connect account servers.',
    );
    expect(start).not.toHaveBeenCalled();
  },
);
it('drops credentials typed for one server when setup reopens for another', async (): Promise<void> => {
  const setup = (key: string, name: string): (typeof mockEntries)[number] => ({
    key,
    name,
    shortDescription: '',
    url: `https://${key}.example.test`,
    transport: 'http',
    categories: [],
    popular: true,
    sortOrder: 0,
    updatedAt: '',
  });
  mockServers = [device];
  mockEntries = [
    {
      ...setup('github', 'GitHub'),
      requiredConfigFields: [
        { kind: 'oauth-client-id' as const },
        { kind: 'oauth-client-secret' as const },
      ],
    },
    {
      ...setup('linear', 'Linear'),
      urlOptions: [
        { label: 'US', url: 'https://us.linear.test/mcp' },
        { label: 'Europe', url: 'https://eu.linear.test/mcp' },
      ],
    },
  ];
  const start = jest.fn().mockResolvedValue({
    connection: { ...connection, status: 'CONNECTED' },
  });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  await fillAccountInput('oauth-client-id', 'github-client');
  await fillAccountInput('oauth-client-secret', 'github-secret');
  // A second action arrives while the GitHub setup is still open.
  await flush((): void => {
    window.dispatchEvent(
      new CustomEvent(ACCOUNT_MCP_ACTION_EVENT, {
        detail: {
          operation: 'connect',
          serverId: 'linear',
          acknowledge: (): void => undefined,
        },
      }),
    );
  });
  expect(document.body.textContent).toContain('Connect Linear');
  expect(
    document.querySelector('[data-testid="mcp-account-oauth-client-id"]'),
  ).toBeNull();
  await flush((): void => button('Connect').click());
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith({
    serverKey: 'linear',
    configId: 'default',
    endpointUrl: 'https://us.linear.test/mcp',
    expectedAccountId: 'acct-1',
  });
});
it('collects a replacement token before reconnecting a custom bearer connection', async (): Promise<void> => {
  const custom: McpServerIndexEntry = {
    ...account,
    id: 'account-custom',
    name: 'internal.example.test',
    curatedKey: undefined,
    accountConnectionId: 'custom-1',
    accountConnection: {
      ...connection,
      id: 'custom-1',
      serverKey: 'custom:abc',
      displayName: 'internal.example.test',
      kind: 'CUSTOM',
      authMode: 'BEARER',
    },
    deviceCopies: [],
  };
  mockServers = [custom];
  const start = jest.fn().mockResolvedValue({
    connection: { ...custom.accountConnection, status: 'CONNECTED' },
  });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [custom] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Connect').click());
  expect(start).not.toHaveBeenCalled();
  const dialogConnect = (): HTMLButtonElement => {
    const result = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="mcp-account-credential-setup"] button',
      ),
    ).find((entry): boolean => entry.textContent === 'Connect');
    if (!result) throw new Error('Missing credential setup connect button');
    return result;
  };
  await flush((): void => dialogConnect().click());
  expect(start).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'Enter the access token to connect.',
  );
  await fillAccountInput('bearer-token', 'fresh-token');
  await flush((): void => dialogConnect().click());
  expect(start).toHaveBeenCalledWith({
    serverKey: 'custom:abc',
    configId: 'default',
    bearerToken: 'fresh-token',
    expectedAccountId: 'acct-1',
  });
  expect(
    document.querySelector('[data-testid="mcp-account-credential-setup"]'),
  ).toBeNull();
});
it('collects the OAuth client ID when a custom OAuth reconnect is refused for lack of one', async (): Promise<void> => {
  const custom: McpServerIndexEntry = {
    ...account,
    id: 'account-custom',
    name: 'internal.example.test',
    curatedKey: undefined,
    accountConnectionId: 'custom-2',
    accountConnection: {
      ...connection,
      id: 'custom-2',
      serverKey: 'custom:def',
      displayName: 'internal.example.test',
      kind: 'CUSTOM',
      authMode: 'OAUTH',
    },
    deviceCopies: [],
  };
  mockServers = [custom];
  const start = jest
    .fn()
    .mockResolvedValueOnce({ error: { code: 'oauth-client-required' } })
    .mockResolvedValueOnce({
      connection: { ...custom.accountConnection, status: 'CONNECTED' },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [custom] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Connect').click());
  await flush((): void => undefined);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'custom:def',
    configId: 'default',
    expectedAccountId: 'acct-1',
  });
  expect(container.textContent).not.toContain('Could not connect.');
  expect(
    document.querySelector('[data-testid="mcp-account-credential-setup"]'),
  ).not.toBeNull();
  await fillAccountInput('oauth-client-id', ' own-client ');
  const dialogConnect = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mcp-account-credential-setup"] button',
    ),
  ).find((entry): boolean => entry.textContent === 'Connect');
  if (!dialogConnect) throw new Error('Missing credential setup connect');
  await flush((): void => dialogConnect.click());
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'custom:def',
    configId: 'default',
    oauthClient: { clientId: 'own-client' },
    expectedAccountId: 'acct-1',
  });
});
const spotifyClientSetup = {
  redirectUri:
    'https://app.example.test/api/mcp-connections/callback/spotify-issuer-key',
  issuer: 'https://accounts.spotify.com',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};
const spotifyEntry = {
  key: 'spotify',
  name: 'Spotify',
  shortDescription: '',
  url: 'https://mcp-gateway-external-pilot.spotify.net/mcp',
  transport: 'http' as const,
  categories: [],
  popular: false,
  sortOrder: 0,
  updatedAt: '',
};
const spotifyDevice: McpServerIndexEntry = {
  ...device,
  id: 'spotify-device',
  name: 'Spotify',
  curatedKey: 'spotify',
};
it('asks a catalog server that registers no OAuth clients for the user’s own app', async (): Promise<void> => {
  mockEntries = [spotifyEntry];
  mockServers = [spotifyDevice];
  const start = jest
    .fn()
    .mockResolvedValueOnce({
      error: {
        code: 'oauth-client-required',
        clientSetup: spotifyClientSetup,
      },
    })
    .mockResolvedValueOnce({
      connection: {
        ...connection,
        serverKey: 'spotify',
        displayName: 'Spotify',
        status: 'CONNECTED',
      },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [spotifyDevice] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  await flush((): void => undefined);
  await flush((): void => undefined);
  expect(start).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain('Could not connect.');
  const setup = document.querySelector('[data-testid="mcp-account-setup"]');
  expect(setup).not.toBeNull();
  expect(
    setup?.querySelector('[data-testid="mcp-client-setup-intro"]')?.textContent,
  ).toBe(
    'Spotify doesn’t let apps register themselves. Create an app in Spotify’s developer dashboard with this redirect URI, then paste its client ID.',
  );
  expect(
    setup?.querySelector('[data-testid="mcp-client-setup-redirect-uri"]')
      ?.textContent,
  ).toBe(spotifyClientSetup.redirectUri);
  expect(
    setup?.querySelector('[data-testid="mcp-account-oauth-client-secret"]'),
  ).toBeNull();
  await fillAccountInput('oauth-client-id', ' my-spotify-app ');
  const dialogConnect = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mcp-account-setup"] button',
    ),
  ).find((entry): boolean => entry.textContent === 'Connect');
  if (!dialogConnect) throw new Error('Missing setup connect');
  await flush((): void => dialogConnect.click());
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'spotify',
    configId: 'default',
    oauthClient: { clientId: 'my-spotify-app' },
    expectedAccountId: 'acct-1',
  });
});
it('collects a secret the account can store for a catalog server’s own app', async (): Promise<void> => {
  const connect = jest.fn();
  await flush((): void =>
    root.render(
      <McpServerDialog
        serverId={null}
        initialCurated={spotifyEntry}
        clientSetup={{
          ...spotifyClientSetup,
          clientSecretRequired: true,
          clientSecretAccepted: true,
        }}
        mode="account"
        onClose={(): void => undefined}
        onSaved={mockRefresh}
        onAccountConnect={connect}
      />,
    ),
  );
  await fillAccountInput('oauth-client-id', 'my-app');
  await flush((): void => button('Connect').click());
  expect(connect).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'Fill in each required field to connect.',
  );
  await fillAccountInput('oauth-client-secret', 'my-secret');
  await flush((): void => button('Connect').click());
  expect(connect).toHaveBeenCalledWith({
    oauthClient: { clientId: 'my-app', clientSecret: 'my-secret' },
  });
});
it('asks for an access token when a catalog server needs a secret the account can’t store', async (): Promise<void> => {
  mockEntries = [spotifyEntry];
  mockServers = [spotifyDevice];
  const start = jest
    .fn()
    .mockResolvedValueOnce({
      error: {
        code: 'oauth-client-required',
        clientSetup: { ...spotifyClientSetup, clientSecretRequired: true },
      },
    })
    .mockResolvedValueOnce({
      connection: { ...connection, serverKey: 'spotify', status: 'CONNECTED' },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [spotifyDevice] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  await flush((): void => undefined);
  await flush((): void => undefined);
  const prompt = document.querySelector(
    '[data-testid="mcp-account-credential-setup"]',
  );
  expect(prompt?.textContent).toContain(
    'Spotify needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.',
  );
  await fillAccountInput('bearer-token', 'token-1');
  const dialogConnect = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mcp-account-credential-setup"] button',
    ),
  ).find((entry): boolean => entry.textContent === 'Connect');
  if (!dialogConnect) throw new Error('Missing credential connect');
  await flush((): void => dialogConnect.click());
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'spotify',
    configId: 'default',
    bearerToken: 'token-1',
    expectedAccountId: 'acct-1',
  });
});
it('shows the redirect URI when a custom server needs its own OAuth app', async (): Promise<void> => {
  const custom: McpServerIndexEntry = {
    ...account,
    id: 'account-custom',
    name: 'internal.example.test',
    curatedKey: undefined,
    accountConnectionId: 'custom-2',
    accountConnection: {
      ...connection,
      id: 'custom-2',
      serverKey: 'custom:def',
      displayName: 'internal.example.test',
      kind: 'CUSTOM',
      authMode: 'OAUTH',
    },
    deviceCopies: [],
  };
  mockServers = [custom];
  install({
    startAccountConnection: jest.fn().mockResolvedValueOnce({
      error: {
        code: 'oauth-client-required',
        clientSetup: spotifyClientSetup,
      },
    }),
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [custom] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Connect').click());
  await flush((): void => undefined);
  const prompt = document.querySelector(
    '[data-testid="mcp-account-credential-setup"]',
  );
  expect(
    prompt?.querySelector('[data-testid="mcp-client-setup-redirect-uri"]')
      ?.textContent,
  ).toBe(spotifyClientSetup.redirectUri);
  expect(
    prompt?.querySelector('[data-testid="mcp-account-oauth-client-id"]'),
  ).not.toBeNull();
});
function setupDialogConnect(): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mcp-account-setup"] button',
    ),
  ).find((entry): boolean => entry.textContent === 'Connect');
  if (!found) throw new Error('Missing setup connect');
  return found;
}
function credentialDialogConnect(): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="mcp-account-credential-setup"] button',
    ),
  ).find((entry): boolean => entry.textContent === 'Connect');
  if (!found) throw new Error('Missing credential setup connect');
  return found;
}
it('reopens the catalog setup for the endpoint it chose when that endpoint registers no OAuth clients', async (): Promise<void> => {
  const us = 'https://us.linear.test/mcp';
  const europe = 'https://eu.linear.test/mcp';
  mockEntries = [
    {
      ...spotifyEntry,
      key: 'linear',
      name: 'Linear',
      url: us,
      urlOptions: [
        { label: 'US', url: us },
        { label: 'Europe', url: europe },
      ],
    },
  ];
  const linearDevice = {
    ...device,
    id: 'linear-device',
    name: 'Linear',
    curatedKey: 'linear',
  };
  mockServers = [linearDevice];
  const start = jest
    .fn()
    .mockResolvedValueOnce({
      error: { code: 'oauth-client-required', clientSetup: spotifyClientSetup },
    })
    .mockResolvedValueOnce({
      connection: { ...connection, serverKey: 'linear', status: 'CONNECTED' },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [linearDevice] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  chooseSelectOption(
    document.querySelector('[data-testid="mcp-curated-url-option"]'),
    'Europe',
  );
  await flush((): void => undefined);
  await flush((): void => setupDialogConnect().click());
  await flush((): void => undefined);
  await flush((): void => undefined);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'linear',
    configId: 'default',
    endpointUrl: europe,
    expectedAccountId: 'acct-1',
  });
  const setup = document.querySelector('[data-testid="mcp-account-setup"]');
  expect(
    setup?.querySelector('[data-testid="mcp-client-setup-intro"]')?.textContent,
  ).toBe(
    'Linear doesn’t let apps register themselves. Create an app in Linear’s developer dashboard with this redirect URI, then paste its client ID.',
  );
  expect(
    setup?.querySelector('[data-testid="mcp-client-setup-redirect-uri"]')
      ?.textContent,
  ).toBe(spotifyClientSetup.redirectUri);
  expect(
    setup?.querySelector('[data-testid="mcp-curated-url-option"]')?.textContent,
  ).toBe('Europe');
  await fillAccountInput('oauth-client-id', 'my-linear-app');
  await flush((): void => setupDialogConnect().click());
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'linear',
    configId: 'default',
    endpointUrl: europe,
    oauthClient: { clientId: 'my-linear-app' },
    expectedAccountId: 'acct-1',
  });
});
describe('a start the cloud refuses for want of an endpoint', (): void => {
  const us = 'https://us.datadog.test/mcp';
  const europe = 'https://eu.datadog.test/mcp';
  const datadogEntry = {
    ...spotifyEntry,
    key: 'datadog',
    name: 'Datadog',
    url: us,
    urlOptions: [
      { label: 'US1', url: us },
      { label: 'EU', url: europe, description: 'Europe' },
    ],
  };
  const datadogDevice = {
    ...device,
    id: 'datadog-device',
    name: 'Datadog',
    curatedKey: 'datadog',
  };
  function refuseOnce(): jest.Mock {
    const start = jest
      .fn()
      .mockResolvedValueOnce({
        error: { code: 'connect-refused', serverCode: 'endpoint_required' },
      })
      .mockResolvedValueOnce({
        connection: {
          ...connection,
          serverKey: 'datadog',
          status: 'CONNECTED',
        },
      });
    install({
      startAccountConnection: start,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [datadogDevice] }),
    });
    return start;
  }

  it('reads the catalog again and opens the endpoint choice, then connects to the chosen one', async (): Promise<void> => {
    mockServers = [datadogDevice];
    mockRefreshedEntries = [datadogEntry];
    const start = refuseOnce();
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Make available in cloud').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mockRefreshCurated).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(
      'Choose an endpoint for this server, then sign in again.',
    );
    chooseSelectOption(
      document.querySelector(
        '[data-testid="mcp-account-setup"] [data-testid="mcp-curated-url-option"]',
      ),
      'EU',
    );
    await flush((): void => undefined);
    await flush((): void => setupDialogConnect().click());
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith({
      serverKey: 'datadog',
      configId: 'default',
      endpointUrl: europe,
      expectedAccountId: 'acct-1',
    });
  });

  it('keeps a setup opened while the catalog is read instead of replacing it', async (): Promise<void> => {
    mockEntries = [
      { ...spotifyEntry, requiredConfigFields: [{ kind: 'oauth-client-id' }] },
    ];
    mockServers = [datadogDevice, spotifyDevice];
    let finishRefresh: (entries: typeof mockEntries) => void = (): void =>
      undefined;
    mockRefreshCurated.mockImplementationOnce(
      (): Promise<typeof mockEntries> =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    refuseOnce();
    await flush((): void => root.render(<McpServersTab />));
    const rowButton = (name: string): HTMLButtonElement => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find(
        (entry): boolean => entry.textContent?.includes(name) ?? false,
      );
      const found = Array.from(
        row?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find(
        (entry): boolean => entry.textContent === 'Make available in cloud',
      );
      if (!found) throw new Error(`Missing ${name} button`);
      return found;
    };
    await flush((): void => rowButton('Datadog').click());
    await flush((): void => undefined);
    expect(mockRefreshCurated).toHaveBeenCalledTimes(1);
    await flush((): void => rowButton('Spotify').click());
    await flush((): void => undefined);
    const title = (): string | null | undefined =>
      document.getElementById('mcp-server-dialog-title')?.textContent;
    expect(title()).toBe('Connect Spotify');
    await flush((): void => finishRefresh([datadogEntry]));
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(title()).toBe('Connect Spotify');
    expect(container.textContent).not.toContain(
      'Choose an endpoint for this server, then sign in again.',
    );
  });

  describe('a catalog read that outlasts another dialog', (): void => {
    let finishRefresh: (entries: typeof mockEntries) => void = (): void =>
      undefined;
    async function startRecovery(
      servers: McpServerIndexEntry[] = [datadogDevice],
    ): Promise<void> {
      mockEntries = [spotifyEntry];
      mockServers = servers;
      mockRefreshCurated.mockImplementationOnce(
        (): Promise<typeof mockEntries> =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
      refuseOnce();
      await flush((): void => root.render(<McpServersTab />));
      await flush((): void => button('Make available in cloud').click());
      await flush((): void => undefined);
      expect(mockRefreshCurated).toHaveBeenCalledTimes(1);
      expect(setupOpen()).toBe(false);
    }
    async function openBrowse(): Promise<void> {
      await flush((): void =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="mcp-add-menu-trigger"]',
          )
          ?.click(),
      );
      // Both Add rows lead with an icon in the shared icon slot.
      for (const id of ['mcp-add-browse', 'mcp-add-custom']) {
        expect(
          document
            .querySelector(`[data-testid="${id}"]`)
            ?.firstElementChild?.querySelector('svg'),
        ).not.toBeNull();
      }
      await flush((): void =>
        document
          .querySelector<HTMLButtonElement>('[data-testid="mcp-add-browse"]')
          ?.click(),
      );
      expect(
        document.querySelector('[data-testid="mcp-browse-dialog"]'),
      ).not.toBeNull();
    }
    async function finish(): Promise<void> {
      await flush((): void => finishRefresh([datadogEntry]));
      await flush((): void => undefined);
      await flush((): void => undefined);
    }
    const setupOpen = (): boolean =>
      document.querySelector('[data-testid="mcp-account-setup"]') !== null;

    it('does not open over Browse', async (): Promise<void> => {
      await startRecovery();
      await openBrowse();
      await finish();
      expect(setupOpen()).toBe(false);
      expect(
        document.querySelector('[data-testid="mcp-browse-dialog"]'),
      ).not.toBeNull();
    });

    it('does not open once Browse was opened and closed', async (): Promise<void> => {
      await startRecovery();
      await openBrowse();
      await flush((): void =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="mcp-browse-dialog"] button[aria-label="Close"]',
          )
          ?.click(),
      );
      expect(
        document.querySelector('[data-testid="mcp-browse-dialog"]'),
      ).toBeNull();
      await finish();
      expect(setupOpen()).toBe(false);
    });

    it('does not open once account details were opened and closed', async (): Promise<void> => {
      await startRecovery([datadogDevice, account]);
      await flush((): void =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="mcp-account-details-button"]',
          )
          ?.click(),
      );
      const details = (): Element | null =>
        document.querySelector('[data-testid="mcp-account-details"]');
      expect(details()).not.toBeNull();
      await flush((): void =>
        details()
          ?.closest('[role="dialog"]')
          ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
          ?.click(),
      );
      expect(details()).toBeNull();
      await finish();
      expect(setupOpen()).toBe(false);
    });
  });

  it('says to choose an endpoint when the catalog still lists none', async (): Promise<void> => {
    mockServers = [datadogDevice];
    refuseOnce();
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Make available in cloud').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(mockRefreshCurated).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="mcp-account-setup"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      'Choose an endpoint for this server, then sign in again.',
    );
  });
});
it('asks the catalog setup for a secret when the server refuses a client ID alone', async (): Promise<void> => {
  mockEntries = [
    { ...spotifyEntry, requiredConfigFields: [{ kind: 'oauth-client-id' }] },
  ];
  mockServers = [spotifyDevice];
  const start = jest
    .fn()
    .mockResolvedValueOnce({
      error: {
        code: 'oauth-client-required',
        clientSetup: {
          ...spotifyClientSetup,
          clientSecretRequired: true,
          clientSecretAccepted: true,
        },
      },
    })
    .mockResolvedValueOnce({
      connection: { ...connection, serverKey: 'spotify', status: 'CONNECTED' },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [spotifyDevice] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  await fillAccountInput('oauth-client-id', 'my-spotify-app');
  await flush((): void => setupDialogConnect().click());
  await flush((): void => undefined);
  await flush((): void => undefined);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'spotify',
    configId: 'default',
    oauthClient: { clientId: 'my-spotify-app' },
    expectedAccountId: 'acct-1',
  });
  expect(
    document.querySelector('[data-testid="mcp-client-setup-intro"]')
      ?.textContent,
  ).toBe(
    'Spotify doesn’t let apps register themselves. Create an app in Spotify’s developer dashboard with this redirect URI, then paste its client ID and client secret.',
  );
  await fillAccountInput('oauth-client-id', 'my-spotify-app');
  await fillAccountInput('oauth-client-secret', 'my-secret');
  await flush((): void => setupDialogConnect().click());
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenLastCalledWith({
    serverKey: 'spotify',
    configId: 'default',
    oauthClient: { clientId: 'my-spotify-app', clientSecret: 'my-secret' },
    expectedAccountId: 'acct-1',
  });
});
it('asks for an access token when a custom server refuses the OAuth client the prompt collected', async (): Promise<void> => {
  const custom: McpServerIndexEntry = {
    ...account,
    id: 'account-custom',
    name: 'internal.example.test',
    curatedKey: undefined,
    accountConnectionId: 'custom-2',
    accountConnection: {
      ...connection,
      id: 'custom-2',
      serverKey: 'custom:def',
      displayName: 'internal.example.test',
      kind: 'CUSTOM',
      authMode: 'OAUTH',
    },
    deviceCopies: [],
  };
  mockServers = [custom];
  const start = jest
    .fn()
    .mockResolvedValueOnce({
      error: { code: 'oauth-client-required', clientSetup: spotifyClientSetup },
    })
    .mockResolvedValueOnce({
      error: {
        code: 'oauth-client-required',
        clientSetup: { ...spotifyClientSetup, clientSecretRequired: true },
      },
    });
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [custom] }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Connect').click());
  await flush((): void => undefined);
  await fillAccountInput('oauth-client-id', 'own-client');
  await flush((): void => credentialDialogConnect().click());
  await flush((): void => undefined);
  await flush((): void => undefined);
  expect(start).toHaveBeenCalledTimes(2);
  const prompt = document.querySelector(
    '[data-testid="mcp-account-credential-setup"]',
  );
  expect(prompt?.textContent).toContain(
    'internal.example.test needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.',
  );
  expect(
    prompt?.querySelector('[data-testid="mcp-account-bearer-token"]'),
  ).not.toBeNull();
});
it('names a cloud refusal in plain words and keeps its code at hand', async (): Promise<void> => {
  mockServers = [
    {
      ...account,
      accountConnection: { ...connection, status: 'REAUTH_REQUIRED' },
    },
  ];
  install({
    startAccountConnection: jest.fn().mockResolvedValueOnce({
      error: {
        code: 'connect-refused',
        serverCode: 'untrusted_authorization_server',
      },
    }),
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: mockServers }),
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Reconnect').click());
  await flush((): void => undefined);
  expect(container.textContent).toContain(
    'This server signs in through a service that isn’t trusted for it, so it can’t connect.',
  );
  expect(container.textContent).not.toContain('untrusted_authorization_server');
  expect(
    container
      .querySelector('[data-mcp-error-code="untrusted_authorization_server"]')
      ?.getAttribute('title'),
  ).toBe('Error code: untrusted_authorization_server');
});
it('preserves the old local table with the flag off', async (): Promise<void> => {
  mockEnabled = false;
  mockServers = [device];
  await flush((): void => root.render(<McpServersTab />));
  expect(container.querySelector('[data-testid="mcp-tier-badge"]')).toBeNull();
  expect(container.textContent).not.toContain('Make available in cloud');
  expect(container.textContent).not.toContain('Cloud + desktop');
});
it('renders a quiet hint when signed out or the capability is missing', async (): Promise<void> => {
  mockAvailable = false;
  mockServers = [device];
  await flush((): void => root.render(<McpServersTab />));
  expect(container.textContent).toContain('Sign in to see account connections');
  expect(container.textContent).not.toContain('Make available in cloud');
});
it('starts a cloud connection without a device token, waits inline, and cancels by account id', async (): Promise<void> => {
  mockServers = [device];
  let finish: (value: AccountMcpConnection) => void = (): void => undefined;
  const start = jest
    .fn()
    .mockResolvedValue({ authorizationUrl: 'https://auth.example.test/' });
  const disconnect = jest.fn().mockResolvedValue(undefined);
  install({
    startAccountConnection: start,
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({
        version: 1,
        servers: [
          {
            ...account,
            accountConnection: { ...connection, status: 'PENDING' },
          },
        ],
      }),
    awaitAccountConnection: (): Promise<AccountMcpConnection> =>
      new Promise((resolve): void => {
        finish = resolve;
      }),
    disconnectAccountConnection: disconnect,
  });
  await flush((): void => root.render(<McpServersTab />));
  await flush((): void => button('Make available in cloud').click());
  // The start carries the account the panel captured it under so main can
  // refuse the send if sign-in changes underneath it.
  expect(start).toHaveBeenCalledWith({
    serverKey: 'github',
    configId: 'default',
    expectedAccountId: 'acct-1',
  });
  expect(container.textContent).toContain('Waiting for browser');
  await flush((): void => button('Cancel').click());
  expect(disconnect).toHaveBeenCalledWith(connection.id);
  await flush((): void => finish({ ...connection, status: 'DISCONNECTED' }));
  expect(
    container.querySelector('[data-testid="mcp-account-pending"]'),
  ).toBeNull();
});
it('offers Reconnect for terminal authorization failures and Disconnect for connected accounts', async (): Promise<void> => {
  mockServers = [
    {
      ...account,
      accountConnection: { ...connection, status: 'REAUTH_REQUIRED' },
    },
  ];
  await flush((): void => root.render(<McpServersTab />));
  expect(button('Reconnect')).toBeDefined();
  expect(button('Disconnect')).toBeDefined();
});
describe('a connection made before its server was marked desktop only (REG-3035)', () => {
  const flaggedEntry = {
    key: 'github',
    name: 'GitHub',
    shortDescription: '',
    url: 'https://mcp.example.test',
    transport: 'http' as const,
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '',
    availability: 'desktop' as const,
    oauthHints: { scopes: ['repo'] },
  };

  it.each(['CONNECTED', 'REAUTH_REQUIRED', 'PENDING'] as const)(
    'keeps Disconnect and offers no cloud Connect for a %s row',
    async (status): Promise<void> => {
      mockEntries = [flaggedEntry];
      mockServers = [
        { ...account, accountConnection: { ...connection, status } },
      ];
      const disconnect = jest.fn().mockResolvedValue(undefined);
      const start = jest.fn();
      install({
        startAccountConnection: start,
        disconnectAccountConnection: disconnect,
      });
      await flush((): void => root.render(<McpServersTab />));
      expect(
        container.querySelector('[data-testid="mcp-account-connect"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="mcp-tier-badge"]')?.textContent,
      ).toBe('Desktop only');
      expect(
        container.querySelector('[data-testid="mcp-account-pending"]'),
      ).toBeNull();
      await flush((): void => button('Disconnect').click());
      expect(disconnect).toHaveBeenCalledWith(connection.id);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('shows no cloud controls once nothing is connected', async (): Promise<void> => {
    mockEntries = [flaggedEntry];
    mockServers = [account];
    install({});
    await flush((): void => root.render(<McpServersTab />));
    expect(
      container.querySelector('[data-testid="mcp-account-disconnect"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-account-connect"]'),
    ).toBeNull();
  });

  it('lets Advisor disconnect it but not connect it', async (): Promise<void> => {
    mockEntries = [flaggedEntry];
    mockServers = [
      {
        ...account,
        accountConnection: { ...connection, status: 'REAUTH_REQUIRED' },
      },
    ];
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const start = jest.fn();
    install({
      startAccountConnection: start,
      disconnectAccountConnection: disconnect,
    });
    useNavigationStore.setState({
      settingsOpen: true,
      settingsInitialSection: 'mcp',
    });
    await flush((): void => root.render(<McpServersTab accountPanel />));
    for (const operation of ['reconnect', 'disconnect'] as const) {
      const acknowledge = jest.fn();
      const detail: AccountMcpActionEventDetail = {
        operation,
        serverId: account.id,
        acknowledge,
      };
      await flush((): void => {
        window.dispatchEvent(
          new CustomEvent(ACCOUNT_MCP_ACTION_EVENT, { detail }),
        );
      });
      expect(acknowledge).toHaveBeenCalledTimes(
        operation === 'disconnect' ? 1 : 0,
      );
    }
    expect(disconnect).toHaveBeenCalledWith(connection.id);
    expect(start).not.toHaveBeenCalled();
  });
});

it('renders provider ownership badges from connector metadata', async (): Promise<void> => {
  await flush((): void =>
    root.render(
      <McpTierBadge
        row={{ ...device, authHandler: 'provider' }}
        providers={['claude', 'codex']}
      />,
    ),
  );
  expect(container.textContent).toContain('Managed by Claude');
  expect(container.textContent).toContain('Managed by Codex');
});
it('labels device rows without provider ownership desktop only', async (): Promise<void> => {
  await flush((): void => root.render(<McpTierBadge row={device} />));
  expect(container.textContent).toBe('Desktop only');
});
it('chooses tools from the server’s list and saves null or an allowlist', async (): Promise<void> => {
  const save = jest.fn().mockResolvedValue(connection);
  const listTools = jest
    .fn()
    .mockResolvedValue([
      { name: 'search_code', title: 'Search code' },
      { name: 'create_issue' },
    ]);
  install({
    setAccountConnectionTools: save,
    listAccountConnectionUpstreamTools: listTools,
  });
  await flush((): void =>
    root.render(
      <AccountMcpDetails
        connection={{ ...connection, enabledTools: null }}
        onClose={(): void => undefined}
        onSaved={mockRefresh}
      />,
    ),
  );
  expect(document.querySelector('textarea')).toBeNull();
  expect(listTools).not.toHaveBeenCalled();
  const toggle = document.querySelector('[role="switch"]');
  if (!(toggle instanceof HTMLButtonElement)) throw new Error('Missing switch');
  await flush((): void => toggle.click());
  expect(listTools).toHaveBeenCalledWith(connection.id);
  const tool = (name: string): HTMLInputElement => {
    const input = document.querySelector(
      `[data-tool-name="${name}"] input[type="checkbox"]`,
    );
    if (!(input instanceof HTMLInputElement))
      throw new Error(`Missing tool ${name}`);
    return input;
  };
  expect(tool('search_code').checked).toBe(true);
  expect(tool('create_issue').checked).toBe(true);
  await flush((): void => tool('create_issue').click());
  await flush((): void => button('Save').click());
  expect(save).toHaveBeenLastCalledWith(connection.id, ['search_code']);
  await flush((): void => button('Clear').click());
  await flush((): void => button('Save').click());
  expect(save).toHaveBeenLastCalledWith(connection.id, []);
  await flush((): void => toggle.click());
  await flush((): void => button('Save').click());
  expect(save).toHaveBeenLastCalledWith(connection.id, null);
});

async function flush(action: () => void): Promise<void> {
  await act(async (): Promise<void> => {
    action();
    await Promise.resolve();
  });
}

it('opens account details from the plugins picker without reading a device file', async (): Promise<void> => {
  const loadServer = jest.fn();
  install({
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account] }),
    getAccountConnection: (id): Promise<AccountMcpConnection> =>
      id === connection.id
        ? Promise.resolve(connection)
        : Promise.reject(new Error('Unexpected connection')),
    loadServer,
  });
  await flush((): void =>
    root.render(
      <McpServerDetailOverlay
        serverId="github"
        onBack={(): void => undefined}
      />,
    ),
  );
  expect(
    document.querySelector('[data-testid="mcp-account-details"]'),
  ).not.toBeNull();
  expect(loadServer).not.toHaveBeenCalled();
});

it('opens the connection the picker row names when one key has several configurations (REG-3033)', async (): Promise<void> => {
  // A picker row's key is `serverId/configId`; dropping the config opened
  // the default connection for a Work row.
  const work: AccountMcpConnection = {
    ...connection,
    id: 'ffffffff-1111-4222-8333-444444444444',
    configId: 'work',
  };
  const workRow: McpServerIndexEntry = {
    ...account,
    accountConnectionId: work.id,
    accountConnection: work,
    configs: [{ id: 'work', name: 'Work', enabled: true }],
    deviceCopies: [],
  };
  const getAccountConnection = jest.fn(
    (id: string): Promise<AccountMcpConnection> =>
      Promise.resolve(id === work.id ? work : connection),
  );
  install({
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account, workRow] }),
    getAccountConnection,
    loadServer: jest.fn(),
  });
  await flush((): void =>
    root.render(
      <McpServerDetailOverlay
        serverId="github"
        configId="work"
        onBack={(): void => undefined}
      />,
    ),
  );
  expect(getAccountConnection).toHaveBeenCalledWith(work.id);
});

it('opens a device copy as a device server even when an account row shares its key', async (): Promise<void> => {
  const getAccountConnection = jest.fn();
  const loadServer = jest.fn(
    (): ReturnType<McpServersAPI['loadServer']> =>
      new Promise((): void => undefined),
  );
  install({
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [account] }),
    getAccountConnection,
    loadServer,
  });
  await flush((): void =>
    root.render(
      <McpServerDetailOverlay
        serverId={device.id}
        onBack={(): void => undefined}
      />,
    ),
  );
  expect(loadServer).toHaveBeenCalledWith(device.id);
  expect(getAccountConnection).not.toHaveBeenCalled();
});

it('records the device server detail card and its labels, blocking the command and args value', async (): Promise<void> => {
  install({
    loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
      Promise.resolve({ version: 1, servers: [device] }),
    loadServer: (): ReturnType<McpServersAPI['loadServer']> =>
      Promise.resolve({
        version: 1,
        server: {
          definition: {
            id: device.id,
            name: 'Local tools',
            description: '',
            type: 'command',
            command: 'npx',
            args: ['local-tools'],
            createdAt: '',
            updatedAt: '',
          },
          configs: [
            {
              id: 'cfg',
              name: 'Default',
              description: '',
              enabled: true,
              envVars: { LOCAL_TOOLS_TOKEN: 'secret' },
              extraArgs: [],
              extraHeaders: {},
              createdAt: '',
              updatedAt: '',
            },
          ],
        },
      }),
  });
  await flush((): void =>
    root.render(
      <McpServerDetailOverlay
        serverId={device.id}
        onBack={(): void => undefined}
      />,
    ),
  );
  await flush((): void => undefined);
  const card = document.querySelector('[role="dialog"]');
  if (card === null) throw new Error('Detail card not rendered');
  // The card, its title, and its static labels stay recorded.
  expect(card.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  // The title holds the name, then the server type badge.
  const title = card.querySelector('h2 .truncate');
  expect(title?.textContent).toBe('Local tools');
  const entries = Array.from(card.querySelectorAll('dd'));
  const command = entries.find(
    (entry): boolean => entry.textContent === 'npx local-tools',
  );
  // Command args often carry API keys inline, so the value is blocked; its
  // "Command:" label stays recorded.
  expect(command).toBeDefined();
  expect(
    command?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
  ).toBe('npx local-tools');
  expect(
    command?.previousElementSibling?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
  ).toBeNull();
  const envVars = entries.find(
    (entry): boolean => entry.textContent === 'LOCAL_TOOLS_TOKEN',
  );
  expect(envVars).toBeDefined();
});

it('retries a failed account connection read for a catalog server on this device', async (): Promise<void> => {
  const listAccountConnections = jest
    .fn()
    .mockRejectedValueOnce(new Error('Cloud unavailable'))
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ ...connection, status: 'CONNECTED' }]);
  install({
    loadServer: jest.fn().mockResolvedValue({
      version: 1,
      server: {
        definition: {
          id: device.id,
          name: 'GitHub',
          description: '',
          type: 'http',
          url: 'https://mcp.example.test',
          httpAuthHandler: 'provider',
          curated: { key: 'github', requiresProviderAuth: false },
          createdAt: '',
          updatedAt: '',
        },
        configs: [],
      },
    }),
    loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [device] }),
    listAccountConnections,
  });
  await flush((): void =>
    root.render(
      <McpServerDialog
        serverId={device.id}
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  await flush((): void => undefined);
  const cloudScope = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-server-scope-cloud"]',
    );
  const reason = (): string | null | undefined =>
    document.querySelector('[data-testid="mcp-cloud-local-reason"]')
      ?.textContent;
  expect(cloudScope()?.disabled).toBe(true);
  expect(reason()).toBe(
    'Could not load account connections. Check your cloud sign-in and try again.',
  );
  await flush((): void => button('Try again').click());
  await flush((): void => undefined);
  expect(cloudScope()?.disabled).toBe(true);
  expect(reason()).toBe(
    'Connect this catalog server in your cloud account first.',
  );
  await flush((): void => button('Try again').click());
  await flush((): void => undefined);
  expect(listAccountConnections).toHaveBeenCalledTimes(3);
  expect(cloudScope()?.disabled).toBe(false);
  await flush((): void => cloudScope()?.click());
  expect(
    document.querySelector('[data-testid="mcp-account-match"]')?.textContent,
  ).toBe('Account connection: GitHub');
});

it.each(['oauth', 'url', 'both'] as const)(
  'collects account setup before the %s shortcut starts',
  async (kind): Promise<void> => {
    mockServers = [device];
    mockEntries = [
      {
        key: 'github',
        name: 'GitHub',
        shortDescription: '',
        url: 'https://mcp.example.test',
        transport: 'http',
        categories: [],
        popular: true,
        sortOrder: 0,
        updatedAt: '',
        ...(kind !== 'url'
          ? {
              requiredConfigFields: [
                { kind: 'oauth-client-id' as const },
                { kind: 'oauth-client-secret' as const },
              ],
            }
          : {}),
        ...(kind !== 'oauth'
          ? {
              urlOptions: [
                { label: 'US', url: 'https://us.example.test/mcp' },
                { label: 'Europe', url: 'https://eu.example.test/mcp' },
              ],
            }
          : {}),
      },
    ];
    const start = jest.fn().mockResolvedValue({
      connection: { ...connection, status: 'CONNECTED' },
    });
    const save = jest.fn();
    const load = jest.fn();
    install({
      startAccountConnection: start,
      saveServer: save,
      loadServer: load,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({
          version: 1,
          servers: [account],
        }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Make available in cloud').click());
    expect(start).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="mcp-account-setup"]'),
    ).not.toBeNull();
    if (kind !== 'oauth') {
      const endpoint = document.querySelector(
        '[data-testid="mcp-curated-url-option"]',
      );
      if (!endpoint) throw new Error('Missing endpoint selector');
      expect(endpoint.textContent).toBe('US');
      chooseSelectOption(endpoint, 'Europe');
      await flush((): void => undefined);
    }
    if (kind !== 'url') {
      await flush((): void => button('Connect').click());
      expect(start).not.toHaveBeenCalled();
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="mcp-account-oauth-client-id"]',
      );
      if (!input) throw new Error('Missing account token');
      await flush((): void => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, 'fresh-client');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    if (kind !== 'url')
      await fillAccountInput('oauth-client-secret', 'fresh-secret');
    await flush((): void => button('Connect').click());
    expect(start).toHaveBeenCalledWith({
      expectedAccountId: 'acct-1',
      ...(kind !== 'oauth'
        ? {
            serverKey: 'github',
            endpointUrl: 'https://eu.example.test/mcp',
            configId: 'default',
          }
        : { serverKey: 'github', configId: 'default' }),
      ...(kind !== 'url'
        ? {
            oauthClient: {
              clientId: 'fresh-client',
              clientSecret: 'fresh-secret',
            },
          }
        : {}),
    });
    expect(save).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  },
);

it.each([
  ['connection-timeout', 'Connection timed out. Connect again.'],
  ['account-changed', 'Account changed. Connect again.'],
  ['other', 'Could not connect. Try again.'],
])(
  'shows the %s recovery state from the account hook',
  async (code, message): Promise<void> => {
    install({
      startAccountConnection: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Private details'), { code }),
        ),
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Connect').click());
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('Private details');
  },
);

it.each(['connection-timeout', 'account-changed'] as const)(
  'preserves %s across the IPC response',
  async (code): Promise<void> => {
    install({
      startAccountConnection: (): ReturnType<
        McpServersAPI['startAccountConnection']
      > =>
        Promise.resolve({ connection: { ...connection, status: 'PENDING' } }),
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({
          version: 1,
          servers: [account],
        }),
      awaitAccountConnection: (): ReturnType<
        McpServersAPI['awaitAccountConnection']
      > => Promise.resolve({ error: { code } }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Connect').click());
    expect(container.textContent).toContain(
      code === 'connection-timeout'
        ? 'Connection timed out. Connect again.'
        : 'Account changed. Connect again.',
    );
  },
);

it('hides account controls for provider-managed curated rows', async (): Promise<void> => {
  mockServers = [{ ...device, authHandler: 'provider' }];
  mockEntries = [
    {
      key: 'github',
      name: 'GitHub',
      shortDescription: '',
      url: '',
      transport: 'http',
      categories: [],
      popular: true,
      sortOrder: 0,
      updatedAt: '',
      providerConnector: { providers: ['claude', 'codex'] },
    },
  ];
  await flush((): void => root.render(<McpServersTab />));
  expect(container.textContent).toContain('Managed by Claude');
  expect(container.textContent).toContain('Managed by Codex');
  expect(
    container.querySelector('[data-testid="mcp-account-connect"]'),
  ).toBeNull();
  expect(container.textContent).not.toContain('Make available in cloud');
});
it('keeps account controls for provider connectors with a cloud connection path', async (): Promise<void> => {
  mockServers = [device];
  mockEntries = [
    {
      key: 'github',
      name: 'GitHub',
      shortDescription: '',
      url: '',
      transport: 'http',
      categories: [],
      popular: true,
      sortOrder: 0,
      updatedAt: '',
      providerConnector: { providers: ['claude'] },
      oauthHints: { scopes: ['repo'] },
    },
  ];
  await flush((): void => root.render(<McpServersTab />));
  expect(container.textContent).toContain('Make available in cloud');
});

it.each(['connect', 'reconnect', 'disconnect', 'promote'] as const)(
  'bridges Advisor %s to the visible account panel',
  async (operation): Promise<void> => {
    const start = jest.fn().mockResolvedValue({
      connection: { ...connection, status: 'CONNECTED' },
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    mockServers =
      operation === 'promote'
        ? [device]
        : [
            {
              ...account,
              accountConnection: {
                ...connection,
                status:
                  operation === 'connect' ? 'DISCONNECTED' : 'REAUTH_REQUIRED',
              },
            },
          ];
    install({
      startAccountConnection: start,
      disconnectAccountConnection: disconnect,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [account] }),
    });
    useNavigationStore.setState({
      settingsOpen: true,
      settingsInitialSection: 'mcp',
    });
    await flush((): void => root.render(<McpServersTab accountPanel />));
    const acknowledge = jest.fn();
    const detail: AccountMcpActionEventDetail = {
      operation,
      serverId: operation === 'promote' ? device.id : account.id,
      acknowledge,
    };
    await flush((): void => {
      window.dispatchEvent(
        new CustomEvent(ACCOUNT_MCP_ACTION_EVENT, { detail }),
      );
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    if (operation === 'disconnect')
      expect(disconnect).toHaveBeenCalledWith(connection.id);
    else
      expect(start).toHaveBeenCalledWith({
        serverKey: 'github',
        configId: 'default',
        expectedAccountId: 'acct-1',
      });
    expect(useCurrentUiStateReporter).toHaveBeenCalledWith(
      'mcp.accountConnections.settings',
      expect.objectContaining({ available: true, loading: false }),
    );
  },
);
it.each(['disabled', 'unavailable', 'provider', 'background'] as const)(
  'rejects Advisor actions on a %s panel',
  async (state): Promise<void> => {
    mockEnabled = state !== 'disabled';
    mockAvailable = state !== 'unavailable';
    mockServers = [
      {
        ...device,
        ...(state === 'provider' ? { authHandler: 'provider' as const } : {}),
      },
    ];
    if (state === 'provider')
      mockEntries = [
        {
          key: 'github',
          name: 'GitHub',
          shortDescription: '',
          url: '',
          transport: 'http',
          categories: [],
          popular: false,
          sortOrder: 0,
          updatedAt: '',
          providerConnector: { providers: ['claude'] },
        },
      ];
    useNavigationStore.setState({ settingsOpen: state === 'background' });
    const start = jest.fn();
    install({ startAccountConnection: start });
    await flush((): void => root.render(<McpServersTab />));
    const acknowledge = jest.fn();
    const detail: AccountMcpActionEventDetail = {
      operation: 'promote',
      serverId: device.id,
      acknowledge,
    };
    await flush((): void => {
      window.dispatchEvent(
        new CustomEvent(ACCOUNT_MCP_ACTION_EVENT, { detail }),
      );
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  },
);

it('keeps device rows visible with a non-blocking cloud outage message', async (): Promise<void> => {
  mockAvailable = false;
  mockUnavailableReason = 'unavailable';
  mockServers = [device];
  await flush((): void => root.render(<McpServersTab />));
  expect(container.textContent).toContain(
    'Account MCP connections are unavailable.',
  );
  expect(container.textContent).toContain('GitHub');
  expect(container.textContent).not.toContain(
    'Sign in to see account connections',
  );
});

async function fillAccountInput(kind: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `[data-testid="mcp-account-${kind}"]`,
  );
  if (!input) throw new Error(`Missing account field: ${kind}`);
  await flush((): void => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([
  ['REAUTH_REQUIRED', 'oauth'],
  ['DISCONNECTED', 'oauth'],
  ['REAUTH_REQUIRED', 'regional'],
  ['DISCONNECTED', 'regional'],
  ['REAUTH_REQUIRED', 'both'],
  ['DISCONNECTED', 'both'],
] as const)(
  'collects fresh setup for %s %s reconnects',
  async (status, kind): Promise<void> => {
    mockServers = [
      {
        ...account,
        accountConnection: { ...connection, configId: 'work', status },
      },
    ];
    mockEntries = [
      {
        key: 'github',
        name: 'GitHub',
        shortDescription: '',
        url: 'https://us.example.test/mcp',
        transport: 'http',
        categories: [],
        popular: true,
        sortOrder: 0,
        updatedAt: '',
        ...(kind !== 'regional'
          ? {
              requiredConfigFields: [
                { kind: 'oauth-client-id' as const },
                { kind: 'oauth-client-secret' as const },
              ],
            }
          : {}),
        ...(kind !== 'oauth'
          ? {
              urlOptions: [
                { label: 'US', url: 'https://us.example.test/mcp' },
                { label: 'Europe', url: 'https://eu.example.test/mcp' },
              ],
            }
          : {}),
      },
    ];
    const start = jest.fn().mockResolvedValue({
      connection: { ...connection, status: 'CONNECTED' },
    });
    install({
      startAccountConnection: start,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({
          version: 1,
          servers: mockServers,
        }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void =>
      button(status === 'REAUTH_REQUIRED' ? 'Reconnect' : 'Connect').click(),
    );
    expect(start).not.toHaveBeenCalled();
    if (kind !== 'regional') {
      await fillAccountInput('oauth-client-id', 'new-client');
      await fillAccountInput('oauth-client-secret', 'new-secret');
    }
    if (kind !== 'oauth') {
      chooseSelectOption(
        document.querySelector('[data-testid="mcp-curated-url-option"]'),
        'Europe',
      );
      await flush((): void => undefined);
    }
    const setup = document.querySelector('[data-testid="mcp-account-setup"]');
    const submit = setup?.querySelector<HTMLButtonElement>('button:last-child');
    if (!submit) throw new Error('Missing setup submit');
    await flush((): void => submit.click());
    expect(start).toHaveBeenCalledWith({
      serverKey: 'github',
      configId: 'work',
      expectedAccountId: 'acct-1',
      ...(kind !== 'oauth'
        ? { endpointUrl: 'https://eu.example.test/mcp' }
        : {}),
      ...(kind !== 'regional'
        ? {
            oauthClient: { clientId: 'new-client', clientSecret: 'new-secret' },
          }
        : {}),
    });
  },
);

it.each(['future-field'])(
  'disables account setup for an unexpressible %s field',
  async (kind): Promise<void> => {
    const entry = {
      key: 'github',
      name: 'GitHub',
      shortDescription: '',
      url: 'https://mcp.example.test',
      transport: 'http' as const,
      categories: [],
      popular: true,
      sortOrder: 0,
      updatedAt: '',
    };
    Reflect.set(entry, 'requiredConfigFields', [{ kind }]);
    const connect = jest.fn();
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId={null}
          initialCurated={entry}
          mode="account"
          onClose={(): void => undefined}
          onSaved={mockRefresh}
          onAccountConnect={connect}
        />,
      ),
    );
    expect(button('Connect').disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'This server needs setup fields that account connections do not support yet.',
    );
    await flush((): void => button('Connect').click());
    expect(connect).not.toHaveBeenCalled();
  },
);

it('collects a client ID alongside a declared client secret', async (): Promise<void> => {
  const connect = jest.fn();
  const entry = {
    key: 'github',
    name: 'GitHub',
    shortDescription: '',
    url: 'https://mcp.example.test',
    transport: 'http' as const,
    categories: [],
    popular: true,
    sortOrder: 0,
    updatedAt: '',
    requiredConfigFields: [{ kind: 'oauth-client-secret' as const }],
  };
  await flush((): void =>
    root.render(
      <McpServerDialog
        serverId={null}
        initialCurated={entry}
        mode="account"
        onClose={(): void => undefined}
        onSaved={mockRefresh}
        onAccountConnect={connect}
      />,
    ),
  );
  await fillAccountInput('oauth-client-id', 'private-client');
  await fillAccountInput('oauth-client-secret', 'private-secret');
  await flush((): void => button('Connect').click());
  expect(connect).toHaveBeenCalledWith({
    oauthClient: { clientId: 'private-client', clientSecret: 'private-secret' },
  });
});

const customConnection: AccountMcpConnection = {
  ...connection,
  id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  serverKey: 'custom:new',
  displayName: 'Internal tools',
  kind: 'CUSTOM',
  status: 'CONNECTED',
};

const SINGLE_CONFIG_REQUIRED =
  'This server has more than one configuration. Only single-configuration servers can move to your cloud account.';
const twoIndexConfigs: McpServerIndexEntry['configs'] = [
  { id: 'cfg-1', name: 'Default', enabled: true },
  { id: 'cfg-2', name: 'Staging', enabled: true },
];

function startMock(): jest.Mock<
  ReturnType<McpServersAPI['startAccountConnection']>,
  Parameters<McpServersAPI['startAccountConnection']>
> {
  return jest
    .fn<
      ReturnType<McpServersAPI['startAccountConnection']>,
      Parameters<McpServersAPI['startAccountConnection']>
    >()
    .mockResolvedValue({ connection: customConnection });
}

function setValue(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The shared `Select` is a Canopy-drawn listbox, not a native `<select>`:
 * open its combobox trigger and press the option with `label`.
 */
function chooseSelectOption(trigger: Element | null, label: string): void {
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`Missing select for ${label}`);
  }
  act(() => trigger.click());
  const listId = trigger.getAttribute('aria-controls');
  const listbox = listId ? document.getElementById(listId) : null;
  const option = Array.from(
    listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
  ).find((row) => row.textContent === label);
  if (!option) throw new Error(`Missing option ${label}`);
  act(() => option.click());
}

function input(selector: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(selector);
  if (!found) throw new Error(`Missing input: ${selector}`);
  return found;
}

const HANDLER_VALUES: Record<string, string> = {
  'Use default': '',
  [`${brandText.appName} proxy`]: 'canopy',
  'Agent provider': 'provider',
};

function handlerChoice(): string | undefined {
  const label = document.querySelector(
    '[data-testid="mcp-server-auth-handler"]',
  )?.textContent;
  return label === null || label === undefined
    ? undefined
    : (HANDLER_VALUES[label] ?? label);
}

function scopeChoice(): string | undefined {
  return document
    .querySelector('[data-testid="mcp-server-scope"] [aria-checked="true"]')
    ?.getAttribute('data-testid')
    ?.replace('mcp-server-scope-', '');
}

function scopeButton(scope: 'device' | 'cloud'): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `[data-testid="mcp-server-scope-${scope}"]`,
  );
  if (!found) throw new Error(`Missing scope: ${scope}`);
  return found;
}

async function renderCustomDialog(
  url: string,
  props: {
    onClose?: () => void;
    onSaved?: () => Promise<void>;
  } = {},
): Promise<void> {
  await flush((): void =>
    root.render(
      <McpServerDialog
        serverId={null}
        onClose={props.onClose ?? ((): void => undefined)}
        onSaved={props.onSaved ?? mockRefresh}
      />,
    ),
  );
  await flush((): void => button('HTTP').click());
  await flush((): void =>
    setValue(input('input[placeholder="My MCP server"]'), 'Internal tools'),
  );
  await flush((): void =>
    setValue(input('input[placeholder="https://mcp.example.com/sse"]'), url),
  );
}

// Moves reload the project list and report partial failures as toasts.
function stubProjectsAndToasts(): {
  loadProjects: jest.Mock;
  addToast: jest.Mock;
} {
  const loadProjects = jest.fn().mockResolvedValue(undefined);
  const addToast = jest.fn();
  useProjectsStore.setState({ loadProjects });
  useGitHubStore.setState({ addToast });
  return { loadProjects, addToast };
}

const initialProjectsState = useProjectsStore.getState();
const initialGitHubState = useGitHubStore.getState();
afterEach((): void => {
  useProjectsStore.setState({
    projects: [],
    loadProjects: initialProjectsState.loadProjects,
  });
  useGitHubStore.setState({ addToast: initialGitHubState.addToast });
});

describe('custom HTTP servers and the cloud account', (): void => {
  it.each(['connected', 'browser sign-in'] as const)(
    'defaults a new server to the cloud account and binds the %s connection',
    async (flow): Promise<void> => {
      const start = jest
        .fn()
        .mockResolvedValue(
          flow === 'connected'
            ? { connection: customConnection }
            : { authorizationUrl: 'https://auth.example.test/' },
        );
      const list = jest
        .fn()
        .mockResolvedValueOnce([{ ...connection, id: 'existing' }])
        .mockResolvedValue([
          { ...connection, id: 'existing' },
          { ...customConnection, status: 'PENDING' },
        ]);
      const save = createSaveServerMock();
      const onClose = jest.fn();
      const onSaved = jest.fn((): Promise<void> => Promise.resolve());
      install({
        startAccountConnection: start,
        listAccountConnections: list,
        saveServer: save,
        awaitAccountConnection: (): Promise<AccountMcpConnection> =>
          new Promise((): void => undefined),
      });
      await renderCustomDialog('https://mcp.example.test/mcp', {
        onClose,
        onSaved,
      });
      expect(scopeChoice()).toBe('cloud');
      // Under the cloud account there is no local auth choice to make.
      expect(handlerChoice()).toBeUndefined();
      expect(
        document.querySelector(
          '[data-testid="mcp-server-dialog-workspace-default"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="mcp-cloud-placement"]')
          ?.textContent,
      ).toContain('Will be added to your cloud account');
      expect(document.body.textContent).toContain(
        'The token is stored in your cloud account.',
      );
      await flush((): void =>
        setValue(
          input('[data-testid="mcp-cloud-access-token"]'),
          'device-token',
        ),
      );
      await flush((): void => button('Save').click());
      await flush((): void => undefined);
      expect(start).toHaveBeenCalledWith({
        customUrl: 'https://mcp.example.test/mcp',
        displayName: 'Internal tools',
        bearerToken: 'device-token',
        configId: 'default',
        expectedAccountId: 'acct-1',
      });
      const definition: unknown = expect.objectContaining({
        url: 'https://mcp.example.test/mcp',
        httpAuthHandler: 'account',
      });
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          accountConnectionId: customConnection.id,
          definition,
        }),
      );
      // The token is stored in the cloud account, not in the device copy.
      expect(JSON.stringify(save.mock.calls[0]?.[0])).not.toContain(
        'device-token',
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('caps the cloud display name at 120 characters', async (): Promise<void> => {
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: jest.fn().mockResolvedValue(undefined),
    });
    await renderCustomDialog('https://mcp.example.test/mcp');
    const nameInput = input('input[placeholder="My MCP server"]');
    expect(nameInput.maxLength).toBe(120);
    await flush((): void => setValue(nameInput, `  ${'n'.repeat(150)}  `));
    await flush((): void =>
      setValue(input('[data-testid="mcp-cloud-access-token"]'), 'device-token'),
    );
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'n'.repeat(120) }),
    );
  });

  it('keeps a new server on this device when asked', async (): Promise<void> => {
    const start = jest.fn();
    const save = createSaveServerMock();
    install({ startAccountConnection: start, saveServer: save });
    await renderCustomDialog('https://mcp.example.test/mcp');
    expect(scopeChoice()).toBe('cloud');
    await flush((): void => scopeButton('device').click());
    expect(scopeChoice()).toBe('device');
    expect(handlerChoice()).toBe('');
    expect(
      document.querySelector('[data-testid="mcp-cloud-placement"]'),
    ).toBeNull();
    await flush((): void => button('Save').click());
    expect(start).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('accountConnectionId');
    expect(save.mock.calls[0]?.[0].definition.httpAuthHandler).toBeUndefined();
  });

  async function addHeader(name: string, value: string): Promise<void> {
    await flush((): void =>
      setValue(input('input[placeholder="Header-Name"]'), name),
    );
    await flush((): void =>
      setValue(input('input[placeholder="header-value"]'), value),
    );
    const add = Array.from(document.querySelectorAll('button')).find(
      (entry): boolean => entry.textContent === 'Add',
    );
    if (!add) throw new Error('Missing header add button');
    await flush((): void => add.click());
  }

  it('adds a server with custom headers to the cloud account with its headers', async (): Promise<void> => {
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    const save = jest.fn().mockResolvedValue(undefined);
    install({
      startAccountConnection: start,
      listAccountConnections: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([customConnection]),
      saveServer: save,
      awaitAccountConnection: (): Promise<AccountMcpConnection> =>
        new Promise((): void => undefined),
    });
    await renderCustomDialog('https://mcp.example.test/mcp');
    await addHeader('X-Api-Key', 'upstream-key');
    expect(scopeChoice()).toBe('cloud');
    expect(
      document.querySelector('[data-testid="mcp-cloud-local-reason"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="mcp-cloud-headers-consent"]')
        ?.textContent,
    ).toBe('Its headers are stored in your cloud account too.');
    expect(document.body.textContent).not.toContain(
      "Custom headers aren't supported in cloud yet",
    );
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      headers: { 'X-Api-Key': 'upstream-key' },
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ accountConnectionId: customConnection.id }),
    );
  });

  it('keeps a server with a header the cloud sets on this device', async (): Promise<void> => {
    const start = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    install({ startAccountConnection: start, saveServer: save });
    await renderCustomDialog('https://mcp.example.test/mcp');
    await addHeader('Authorization', 'Bearer local');
    expect(scopeChoice()).toBe('device');
    expect(scopeButton('cloud').disabled).toBe(true);
    expect(handlerChoice()).toBe('');
    expect(
      document.querySelector('[data-testid="mcp-cloud-local-reason"]')
        ?.textContent,
    ).toBe(
      'The cloud sets Authorization itself, so this server stays on this device.',
    );
    expect(
      document.querySelector('[data-testid="mcp-cloud-keep-local"]'),
    ).toBeNull();
    await flush((): void => button('Save').click());
    expect(start).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a loopback URL', 'http://127.0.0.1:3000/mcp', 'Desktop only.'],
    ['a localhost URL', 'https://api.localhost/mcp', 'Desktop only.'],
    [
      'a plain HTTP URL',
      'http://mcp.example.test/mcp',
      'Use an HTTPS URL to add this server to your cloud account.',
    ],
  ])('keeps %s on this device', async (_label, url, reason): Promise<void> => {
    install({ saveServer: jest.fn() });
    await renderCustomDialog(url);
    expect(handlerChoice()).toBe('');
    expect(
      document.querySelector('[data-testid="mcp-cloud-local-reason"]')
        ?.textContent,
    ).toContain(reason);
    expect(
      document.querySelector('[data-testid="mcp-cloud-keep-local"]'),
    ).toBeNull();
  });

  it('labels command servers desktop only', async (): Promise<void> => {
    install({ saveServer: jest.fn() });
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId={null}
          onClose={(): void => undefined}
          onSaved={mockRefresh}
        />,
      ),
    );
    await flush((): void => button('Command').click());
    expect(
      document.querySelector('[data-testid="mcp-cloud-local-reason"]')
        ?.textContent,
    ).toBe('Desktop only. Command servers run on this device.');
    expect(
      document.querySelector('[data-testid="mcp-cloud-keep-local"]'),
    ).toBeNull();
  });

  it('falls back to this device when signed out', async (): Promise<void> => {
    mockLoadCanopyCloudAccount.mockResolvedValue(cloudAccountState(false));
    const start = jest.fn();
    install({ startAccountConnection: start, saveServer: jest.fn() });
    await renderCustomDialog('https://mcp.example.test/mcp');
    expect(handlerChoice()).toBe('');
    expect(
      document.querySelector('[data-testid="mcp-cloud-local-reason"]')
        ?.textContent,
    ).toBe(
      'Sign in to add this server to your cloud account. It stays on this device for now.',
    );
  });

  it('shows the cloud connection limit in the dialog without saving', async (): Promise<void> => {
    const save = jest.fn();
    const onClose = jest.fn();
    install({
      startAccountConnection: jest
        .fn()
        .mockResolvedValue({ error: { code: 'connection-limit-reached' } }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: save,
    });
    await renderCustomDialog('https://mcp.example.test/mcp', { onClose });
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      'Your cloud account has reached its server limit. Disconnect one to add another.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the new cloud connection when saving the device row fails', async (): Promise<void> => {
    const save = jest.fn().mockRejectedValue(new Error('Disk is full.'));
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    install({
      startAccountConnection: jest
        .fn()
        .mockResolvedValue({ connection: customConnection }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      saveServer: save,
    });
    await renderCustomDialog('https://mcp.example.test/mcp', { onClose });
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(document.body.textContent).toContain('Disk is full.');
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Save').disabled).toBe(false);
  });

  it('still shows the save failure when removing the new connection fails', async (): Promise<void> => {
    const disconnect = jest.fn().mockRejectedValue(new Error('offline'));
    install({
      startAccountConnection: jest
        .fn()
        .mockResolvedValue({ connection: customConnection }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      saveServer: jest.fn().mockRejectedValue(new Error('Disk is full.')),
    });
    await renderCustomDialog('https://mcp.example.test/mcp');
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(document.body.textContent).toContain('Disk is full.');
  });

  it('keeps the bound connection when only the list refresh fails', async (): Promise<void> => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    install({
      startAccountConnection: jest
        .fn()
        .mockResolvedValue({ connection: customConnection }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      saveServer: jest.fn().mockResolvedValue(undefined),
    });
    await renderCustomDialog('https://mcp.example.test/mcp', {
      onClose,
      onSaved: (): Promise<void> =>
        Promise.reject(new Error('Could not reload the list.')),
    });
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(disconnect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks for an access token when the server cannot register a client', async (): Promise<void> => {
    const save = jest.fn();
    const onClose = jest.fn();
    install({
      startAccountConnection: jest
        .fn()
        .mockResolvedValue({ error: { code: 'oauth-client-required' } }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: save,
    });
    await renderCustomDialog('https://mcp.example.test/mcp', { onClose });
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      "This server doesn't support automatic client registration. Connect it with an access token instead.",
    );
    expect(document.body.textContent).not.toContain(
      'This server needs its OAuth client ID.',
    );
    expect(document.activeElement).toBe(
      input('[data-testid="mcp-cloud-access-token"]'),
    );
    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Save').disabled).toBe(false);
  });

  it.each([
    ['a loopback URL', 'http://127.0.0.1:3000/mcp', 'Desktop only.', true],
    [
      'a plain HTTP URL',
      'http://mcp.example.test/mcp',
      'Use an HTTPS URL to add this server to your cloud account.',
      true,
    ],
    [
      'a signed-out HTTPS URL',
      'https://mcp.example.test/mcp',
      'Sign in to add this server to your cloud account.',
      false,
    ],
  ])(
    'saves %s locally when the global default is the cloud account',
    async (_label, url, reason, signedIn): Promise<void> => {
      mockLoadPreferences.mockResolvedValue({
        mcpHttpAuthDefaultHandler: 'account',
      });
      if (!signedIn) {
        mockLoadCanopyCloudAccount.mockResolvedValue(cloudAccountState(false));
      }
      const start = jest.fn();
      const save = jest
        .fn<ReturnType<McpServersAPI['saveServer']>, [SaveMcpServerRequest]>()
        .mockImplementation((server) =>
          Promise.resolve({ version: 1, server }),
        );
      const onClose = jest.fn();
      install({
        startAccountConnection: start,
        listAccountConnections: jest.fn().mockResolvedValue([]),
        saveServer: save,
      });
      await renderCustomDialog(url, { onClose });
      expect(handlerChoice()).toBe('canopy');
      expect(
        document.querySelector('[data-testid="mcp-cloud-placement"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="mcp-cloud-local-reason"]')
          ?.textContent,
      ).toContain(reason);
      await flush((): void => button('Save').click());
      await flush((): void => undefined);
      expect(start).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]?.[0]).not.toHaveProperty('accountConnectionId');
      expect(save.mock.calls[0]?.[0].definition.httpAuthHandler).toBe('canopy');
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('names the header the cloud refused in the dialog without saving', async (): Promise<void> => {
    const save = jest.fn();
    install({
      startAccountConnection: jest.fn().mockResolvedValue({
        error: { code: 'invalid-headers', header: 'X-Team' },
      }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: save,
    });
    await renderCustomDialog('https://mcp.example.test/mcp');
    await addHeader('X-Team', 'core');
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      "Your cloud account couldn't store the X-Team header. Check it and try again.",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('shows a cloud broker failure in the dialog without saving', async (): Promise<void> => {
    const save = jest.fn();
    const onClose = jest.fn();
    install({
      startAccountConnection: jest
        .fn()
        .mockRejectedValue(new Error('Upstream unreachable')),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: save,
    });
    await renderCustomDialog('https://mcp.example.test/mcp', { onClose });
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      'Could not add this server to your cloud account. Try again.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Save').disabled).toBe(false);
  });
});

describe('promoting existing custom HTTP rows', (): void => {
  const customDevice: McpServerIndexEntry = {
    id: 'custom-device',
    name: 'Internal tools',
    description: '',
    type: 'http',
    urlHost: 'mcp.example.test',
    urlScheme: 'https',
    configs: [{ id: 'cfg-1', name: 'Default', enabled: true }],
    updatedAt: '',
  };
  const customServer = {
    definition: {
      id: 'custom-device',
      name: 'Internal tools',
      description: '',
      type: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      createdAt: '',
      updatedAt: '',
    },
    configs: [
      {
        id: 'cfg-1',
        name: 'Default',
        description: '',
        enabled: true,
        authToken: 'device-token',
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '',
        updatedAt: '',
      },
    ],
  };

  const twoConfigServer = {
    ...customServer,
    configs: [
      ...customServer.configs,
      { ...customServer.configs[0], id: 'cfg-2', name: 'Staging' },
    ],
  };

  function promoteDialog(): Element | null {
    return document.querySelector('[data-testid="mcp-promote-dialog"]');
  }

  // The row's button asks before it moves the server to the cloud account.
  async function openPromote(): Promise<void> {
    await flush((): void => button('Make available in cloud').click());
    await flush((): void => undefined);
  }

  async function promote(): Promise<void> {
    await openPromote();
    await flush((): void => button('Move to cloud account').click());
  }

  it.each(['button', 'advisor'] as const)(
    'moves a custom row to the cloud account from the %s',
    async (source): Promise<void> => {
      mockServers = [customDevice];
      const start = jest
        .fn()
        .mockResolvedValue({ connection: customConnection });
      const save = createSaveServerMock();
      const disconnect = jest.fn().mockResolvedValue(undefined);
      const rewrite = jest
        .fn()
        .mockResolvedValue({ globalDefaults: true, workspaces: 1, chats: 2 });
      const clearToken = jest.fn().mockResolvedValue(undefined);
      install({
        startAccountConnection: start,
        listAccountConnections: jest.fn().mockResolvedValue([]),
        disconnectAccountConnection: disconnect,
        rewriteServerRefs: rewrite,
        clearOAuthToken: clearToken,
        loadServer: jest
          .fn()
          .mockResolvedValue({ version: 1, server: customServer }),
        saveServer: save,
      });
      if (source === 'advisor')
        useNavigationStore.setState({
          settingsOpen: true,
          settingsInitialSection: 'mcp',
        });
      await flush((): void =>
        root.render(<McpServersTab accountPanel={source === 'advisor'} />),
      );
      let dispatched: Awaited<ReturnType<typeof dispatchAppAction>> | undefined;
      if (source === 'button') await openPromote();
      await flush((): void => {
        if (source === 'advisor')
          void dispatchAppAction({
            requestId: 'promote-custom',
            source: 'assistant',
            action: { type: 'mcp.account_promote', serverId: customDevice.id },
          }).then((result): void => {
            dispatched = result;
          });
      });
      await flush((): void => undefined);
      await flush((): void => undefined);
      if (source === 'advisor') expect(dispatched).toMatchObject({ ok: true });
      // Either way the user sees what moves, token included, and confirms.
      expect(promoteDialog()?.textContent).toContain(
        'Its URL, headers, and access token move to your cloud account.',
      );
      expect(input('[data-testid="mcp-promote-access-token"]').value).toBe(
        'device-token',
      );
      expect(start).not.toHaveBeenCalled();
      await flush((): void => button('Move to cloud account').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(start).toHaveBeenCalledWith({
        customUrl: 'https://mcp.example.test/mcp',
        displayName: 'Internal tools',
        bearerToken: 'device-token',
        configId: 'default',
        expectedAccountId: 'acct-1',
      });
      const definition: unknown = expect.objectContaining({
        httpAuthHandler: 'account',
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          accountConnectionId: customConnection.id,
          definition,
        }),
      );
      // The device keeps its token until the cloud connects, so a cancelled
      // move can restore it (CAN-4411); then it lives only in the cloud.
      expect(save.mock.calls[0]?.[0].configs[0]).toHaveProperty(
        'authToken',
        'device-token',
      );
      expect(save.mock.calls[1]?.[0].configs[0]).not.toHaveProperty(
        'authToken',
      );
      expect(rewrite).toHaveBeenCalledWith({
        from: [{ serverId: 'custom-device', configId: 'cfg-1' }],
        to: { serverId: 'custom:new', configId: 'default' },
      });
      expect(clearToken).toHaveBeenCalledWith({
        serverId: 'custom-device',
        configId: 'cfg-1',
      });
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it('confirms before moving a custom row to the cloud account', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: jest.fn().mockResolvedValue(undefined),
    });
    await flush((): void => root.render(<McpServersTab />));
    await openPromote();
    const dialog = promoteDialog();
    expect(dialog?.textContent).toContain(
      'Move Internal tools to your cloud account',
    );
    expect(dialog?.textContent).toContain(
      "OAuth sign-ins don't move. If it signs in with OAuth, sign in again after it moves.",
    );
    expect(dialog?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(start).not.toHaveBeenCalled();
    await flush((): void => button('Cancel').click());
    expect(promoteDialog()).toBeNull();
    expect(start).not.toHaveBeenCalled();
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cleared', '', undefined],
    ['replaced', 'cloud-token', 'cloud-token'],
  ] as const)(
    'moves a custom row with the token the user %s in the confirmation',
    async (_label, typed, sent): Promise<void> => {
      mockServers = [customDevice];
      const start = startMock();
      install({
        startAccountConnection: start,
        listAccountConnections: jest.fn().mockResolvedValue([]),
        loadServer: jest
          .fn()
          .mockResolvedValue({ version: 1, server: customServer }),
        saveServer: jest.fn().mockResolvedValue(undefined),
        rewriteServerRefs: jest.fn().mockResolvedValue({
          globalDefaults: false,
          workspaces: 0,
          chats: 0,
        }),
        clearOAuthToken: jest.fn().mockResolvedValue(undefined),
      });
      await flush((): void => root.render(<McpServersTab />));
      await openPromote();
      await flush((): void =>
        setValue(input('[data-testid="mcp-promote-access-token"]'), typed),
      );
      expect(promoteDialog()?.textContent).toContain(
        sent
          ? 'Its URL, headers, and access token move to your cloud account.'
          : 'Its URL and headers move to your cloud account. No access token goes with it.',
      );
      await flush((): void => button('Move to cloud account').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]?.bearerToken).toBe(sent);
      expect(start.mock.calls[0]?.[0]?.expectedAccountId).toBe('acct-1');
    },
  );

  it('caps the promoted display name at 120 characters', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: {
          ...customServer,
          definition: {
            ...customServer.definition,
            name: ` ${'p'.repeat(150)} `,
          },
        },
      }),
      saveServer: jest.fn().mockResolvedValue(undefined),
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'p'.repeat(120) }),
    );
  });

  it("forwards a custom row's headers when making it available in cloud", async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      saveServer: jest.fn().mockResolvedValue(undefined),
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: {
          definition: {
            ...customServer.definition,
            headers: { 'x-team': 'a', 'X-Region': 'eu' },
          },
          configs: [
            {
              ...customServer.configs[0],
              extraHeaders: { 'X-Team': 'b' },
            },
          ],
        },
      }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      headers: { 'X-Region': 'eu', 'X-Team': 'b' },
      bearerToken: 'device-token',
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
  });

  it('asks for an access token when a promoted row cannot register a client', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest
      .fn()
      .mockResolvedValueOnce({ error: { code: 'oauth-client-required' } })
      .mockResolvedValueOnce({ connection: customConnection });
    const save = jest.fn().mockResolvedValue(undefined);
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: {
          ...customServer,
          configs: customServer.configs.map((config) => ({
            ...config,
            authToken: undefined,
          })),
        },
      }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
    expect(save).not.toHaveBeenCalled();
    const setup = document.querySelector(
      '[data-testid="mcp-account-credential-setup"]',
    );
    expect(setup?.textContent).toContain(
      "This server doesn't support automatic client registration. Connect it with an access token instead.",
    );
    expect(
      document.querySelector('[data-testid="mcp-account-oauth-client-id"]'),
    ).toBeNull();
    // The prompt is the answer; no failure banner repeats it behind the dialog.
    expect(container.textContent).not.toContain(
      'This server needs its own OAuth app.',
    );
    await fillAccountInput('bearer-token', 'typed-token');
    const dialogConnect = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="mcp-account-credential-setup"] button',
      ),
    ).find((entry): boolean => entry.textContent === 'Connect');
    if (!dialogConnect) throw new Error('Missing credential setup connect');
    await flush((): void => dialogConnect.click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      bearerToken: 'typed-token',
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
    const definition: unknown = expect.objectContaining({
      httpAuthHandler: 'account',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        accountConnectionId: customConnection.id,
        definition,
      }),
    );
    expect(
      document.querySelector('[data-testid="mcp-account-credential-setup"]'),
    ).toBeNull();
  });

  it('refuses to promote a custom row that sends a header the cloud sets', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn();
    install({
      startAccountConnection: start,
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: {
          ...customServer,
          definition: {
            ...customServer.definition,
            headers: { Cookie: 'a=b' },
          },
        },
      }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'The cloud sets Cookie itself, so this server stays on this device.',
    );
  });

  it.each([
    [
      'plain HTTP',
      'http://mcp.example.test/mcp',
      'Use an HTTPS URL to add this server to your cloud account.',
    ],
    [
      'loopback',
      'https://127.0.0.1:3000/mcp',
      "Desktop only. Local addresses can't be reached from the cloud.",
    ],
  ])(
    'refuses to promote a row whose saved URL is now %s',
    async (_label, url, reason): Promise<void> => {
      mockServers = [customDevice];
      const start = jest
        .fn()
        .mockResolvedValue({ connection: customConnection });
      install({
        startAccountConnection: start,
        listAccountConnections: jest.fn().mockResolvedValue([]),
        saveServer: jest.fn().mockResolvedValue(undefined),
        loadServer: jest.fn().mockResolvedValue({
          version: 1,
          server: {
            ...customServer,
            definition: { ...customServer.definition, url },
          },
        }),
      });
      await flush((): void => root.render(<McpServersTab />));
      await promote();
      await flush((): void => undefined);
      expect(start).not.toHaveBeenCalled();
      expect(container.textContent).toContain(reason);
    },
  );

  it('refuses to move a row with more than one configuration', async (): Promise<void> => {
    mockServers = [{ ...customDevice, configs: twoIndexConfigs }];
    const start = jest.fn();
    const load = jest
      .fn()
      .mockResolvedValue({ version: 1, server: twoConfigServer });
    install({ startAccountConnection: start, loadServer: load });
    await flush((): void => root.render(<McpServersTab />));
    await openPromote();
    expect(promoteDialog()).toBeNull();
    expect(container.textContent).toContain(SINGLE_CONFIG_REQUIRED);
    expect(start).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('tells App Advisor why a row with more than one configuration stays on this device', async (): Promise<void> => {
    mockServers = [{ ...customDevice, configs: twoIndexConfigs }];
    const start = jest.fn();
    install({
      startAccountConnection: start,
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: twoConfigServer }),
    });
    useNavigationStore.setState({
      settingsOpen: true,
      settingsInitialSection: 'mcp',
    });
    await flush((): void => root.render(<McpServersTab accountPanel />));
    let dispatched: Awaited<ReturnType<typeof dispatchAppAction>> | undefined;
    await flush((): void => {
      void dispatchAppAction({
        requestId: 'promote-multi-config',
        source: 'assistant',
        action: { type: 'mcp.account_promote', serverId: customDevice.id },
      }).then((result): void => {
        dispatched = result;
      });
    });
    await flush((): void => undefined);
    expect(dispatched).toMatchObject({
      ok: false,
      error: { code: 'invalid_target', message: SINGLE_CONFIG_REQUIRED },
    });
    expect(promoteDialog()).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('says why in the confirmation when the server gained a configuration', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn();
    install({
      startAccountConnection: start,
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: twoConfigServer }),
    });
    await flush((): void => root.render(<McpServersTab />));
    await openPromote();
    const dialog = promoteDialog();
    expect(
      dialog?.querySelector('[data-testid="mcp-move-blocked"]')?.textContent,
    ).toBe(SINGLE_CONFIG_REQUIRED);
    expect(dialog?.textContent).not.toContain('Its URL');
    expect(
      dialog?.querySelector('[data-testid="mcp-promote-access-token"]'),
    ).toBeNull();
    expect(button('Move to cloud account').disabled).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('removes the new cloud connection when binding the promoted row fails', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockRejectedValue(new Error('Disk is full.'));
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(container.textContent).toContain('Could not connect. Try again.');
  });

  it('binds nothing when the promotion is cancelled before the connection exists', async (): Promise<void> => {
    mockServers = [customDevice];
    let started: (value: {
      connection: AccountMcpConnection;
    }) => void = (): void => undefined;
    const start = jest.fn(
      (): Promise<{ connection: AccountMcpConnection }> =>
        new Promise((resolve): void => {
          started = resolve;
        }),
    );
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    await flush((): void => button('Cancel').click());
    // Nothing is known to disconnect until the start answers.
    expect(disconnect).not.toHaveBeenCalled();
    await flush((): void => started({ connection: customConnection }));
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(container.textContent).not.toContain('Could not connect');
  });

  it('restores the device row when the promotion is cancelled while it is being bound', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    let resolveSave: ((file: McpServerFileView) => void) | undefined;
    const save = createSaveServerMock().mockImplementationOnce(
      (): Promise<McpServerFileView> =>
        new Promise((resolve): void => {
          resolveSave = resolve;
        }),
    );
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    await flush((): void => button('Cancel').click());
    await flush((): void => {
      if (!resolveSave) throw new Error('Missing pending server save');
      resolveSave({ version: 1, server: customServer });
    });
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(2);
    const restored = save.mock.calls[1]?.[0];
    if (!restored) throw new Error('Missing restoring save');
    expect(restored.accountConnectionId).toBeUndefined();
    expect(restored.accountRouting).toBe('clear');
    expect(restored.definition).toEqual(customServer.definition);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(container.textContent).not.toContain('Could not connect');
  });

  it('restores the device row when the promotion is cancelled during browser sign-in', async (): Promise<void> => {
    mockServers = [customDevice];
    const start = jest.fn().mockResolvedValue({
      connection: { ...customConnection, status: 'PENDING' },
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    let finish: (value: AccountMcpConnection) => void = (): void => undefined;
    const save = createSaveServerMock();
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      awaitAccountConnection: (): Promise<AccountMcpConnection> =>
        new Promise((resolve): void => {
          finish = resolve;
        }),
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    await flush((): void => button('Cancel').click());
    await flush((): void =>
      finish({ ...customConnection, status: 'DISCONNECTED' }),
    );
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(2);
    const restored = save.mock.calls[1]?.[0];
    if (!restored) throw new Error('Missing restoring save');
    expect(restored.accountConnectionId).toBeUndefined();
    expect(restored.accountRouting).toBe('clear');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Connection needs attention');
  });

  it('restores the device row when the promotion is cancelled after the row moved under the account', async (): Promise<void> => {
    mockServers = [customDevice];
    const pendingConnection: AccountMcpConnection = {
      ...customConnection,
      status: 'PENDING',
    };
    const start = jest
      .fn()
      .mockResolvedValue({ connection: pendingConnection });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    let finish: (value: AccountMcpConnection) => void = (): void => undefined;
    const save = createSaveServerMock()
      .mockImplementationOnce((): Promise<McpServerFileView> => {
        // The bind moves the device row under the account connection, the
        // way the merged index lists it after the next refresh.
        mockServers = [
          {
            id: `account:${pendingConnection.id}`,
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: pendingConnection.id,
            accountConnection: pendingConnection,
            name: pendingConnection.displayName,
            description: '',
            type: 'http',
            updatedAt: '',
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            deviceCopies: [
              {
                ...customDevice,
                authHandler: 'account',
                accountConnectionId: pendingConnection.id,
              },
            ],
          },
        ];
        return Promise.resolve({ version: 1, server: customServer });
      })
      .mockImplementation((): Promise<McpServerFileView> => {
        mockServers = [customDevice];
        return Promise.resolve({ version: 1, server: customServer });
      });
    install({
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([]),
      disconnectAccountConnection: disconnect,
      awaitAccountConnection: (): Promise<AccountMcpConnection> =>
        new Promise((resolve): void => {
          finish = resolve;
        }),
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: customServer }),
      saveServer: save,
    });
    await flush((): void => root.render(<McpServersTab />));
    await promote();
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalled();
    // The refreshed list now renders the row under its account key.
    await flush((): void => root.render(<McpServersTab />));
    expect(container.textContent).not.toContain('Make available in cloud');
    await flush((): void => button('Cancel').click());
    await flush((): void =>
      finish({ ...customConnection, status: 'DISCONNECTED' }),
    );
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(save).toHaveBeenCalledTimes(2);
    const restored = save.mock.calls[1]?.[0];
    if (!restored) throw new Error('Missing restoring save');
    expect(restored.accountConnectionId).toBeUndefined();
    expect(restored.accountRouting).toBe('clear');
    expect(restored.definition).toEqual(customServer.definition);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(customConnection.id);
    expect(container.textContent).not.toContain('Connection needs attention');
  });

  it.each([
    ['loopback', { urlHost: '127.0.0.1' }],
    ['plain HTTP', { urlScheme: 'http' }],
    ['provider-managed', { authHandler: 'provider' as const }],
  ])(
    'offers no cloud promotion for a %s custom row',
    async (_label, overrides): Promise<void> => {
      mockServers = [{ ...customDevice, ...overrides }];
      await flush((): void => root.render(<McpServersTab />));
      expect(container.textContent).not.toContain('Make available in cloud');
      expect(
        container.querySelector('[data-testid="mcp-tier-badge"]')?.textContent,
      ).toBe('Desktop only');
    },
  );
});

describe('moving servers between this device and the cloud account', (): void => {
  const cloudConnection: AccountMcpConnection = {
    ...customConnection,
    authMode: 'OAUTH',
    upstreamHost: 'mcp.example.test',
    hasExtraHeaders: false,
  };
  const boundDevice: McpServerIndexEntry = {
    id: 'bound-device',
    name: 'Internal tools',
    description: '',
    type: 'http',
    urlHost: 'mcp.example.test',
    urlScheme: 'https',
    scope: 'account',
    authHandler: 'account',
    accountConnectionId: cloudConnection.id,
    configs: [{ id: 'cfg-1', name: 'Default', enabled: true }],
    updatedAt: '',
  };
  const accountRow = (
    connection: AccountMcpConnection,
    copies: McpServerIndexEntry[] = [],
  ): McpServerIndexEntry => ({
    id: connection.serverKey,
    scope: 'account',
    authHandler: 'account',
    accountConnectionId: connection.id,
    accountConnection: connection,
    name: connection.displayName,
    description: '',
    type: 'http',
    updatedAt: '',
    configs: [{ id: connection.configId, name: 'Default', enabled: true }],
    ...(copies.length ? { deviceCopies: copies } : {}),
  });
  const boundServer = {
    definition: {
      id: 'bound-device',
      name: 'Internal tools',
      description: '',
      type: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Team': 'core' },
      httpAuthHandler: 'account' as const,
      createdAt: '',
      updatedAt: '',
    },
    configs: [
      {
        id: 'cfg-1',
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
  const deviceServer = {
    definition: {
      id: 'custom-device',
      name: 'Internal tools',
      description: '',
      type: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      createdAt: '',
      updatedAt: '',
    },
    configs: [{ ...boundServer.configs[0], authToken: 'device-token' }],
  };

  async function openEditor(): Promise<void> {
    await flush((): void => root.render(<McpServersTab />));
    const edit = document.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-account-edit-button"]',
    );
    if (!edit) throw new Error('Missing account edit button');
    await flush((): void => edit.click());
    await flush((): void => undefined);
  }

  function echoSave(): jest.Mock<
    ReturnType<McpServersAPI['saveServer']>,
    [SaveMcpServerRequest]
  > {
    return jest
      .fn<ReturnType<McpServersAPI['saveServer']>, [SaveMcpServerRequest]>()
      .mockImplementation(
        (request): ReturnType<McpServersAPI['saveServer']> =>
          Promise.resolve({ version: 1, server: request }),
      );
  }

  function lastEditorState(): unknown {
    return jest
      .mocked(useCurrentUiStateReporter)
      .mock.calls.filter(([key]) => key === 'mcp.serverEditor')
      .at(-1)?.[1];
  }

  it('edits a cloud server in place through its device copy', async (): Promise<void> => {
    const row = accountRow(cloudConnection, [boundDevice]);
    mockServers = [row];
    const update = jest.fn().mockResolvedValue(cloudConnection);
    const save = echoSave();
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
      updateAccountConnection: update,
      saveServer: save,
    });
    await openEditor();
    // The editor stands in for the copy's own button.
    expect(
      container.querySelector('[data-testid="mcp-device-copy"]'),
    ).toBeNull();
    expect(scopeChoice()).toBe('cloud');
    expect(input('[data-testid="mcp-cloud-access-token"]').placeholder).toBe(
      'Optional',
    );
    await flush((): void =>
      setValue(input('input[placeholder="My MCP server"]'), 'Team tools'),
    );
    await flush((): void =>
      setValue(
        input('[data-testid="mcp-server-url"]'),
        'https://mcp2.example.test/mcp',
      ),
    );
    expect(
      document.querySelector('[data-testid="mcp-cloud-url-warning"]')
        ?.textContent,
    ).toBe('Changing the URL signs you out. Sign in again after you save.');
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    // A new address drops the cloud's stored headers, so the ones shown here
    // travel with it.
    expect(update).toHaveBeenCalledWith(cloudConnection.id, {
      displayName: 'Team tools',
      customUrl: 'https://mcp2.example.test/mcp',
      headers: { 'X-Team': 'core' },
      expectedAccountId: 'acct-1',
    });
    const saved = save.mock.calls.find(
      ([request]) => request.accountConnectionId === cloudConnection.id,
    )?.[0];
    expect(saved?.definition).toMatchObject({
      url: 'https://mcp2.example.test/mcp',
      httpAuthHandler: 'account',
    });
  });

  it('shows the cloud refusal and keeps the device copy unchanged', async (): Promise<void> => {
    const row = accountRow(cloudConnection, [boundDevice]);
    mockServers = [row];
    const save = echoSave();
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
      updateAccountConnection: jest
        .fn()
        .mockResolvedValue({ error: { code: 'edit-unavailable' } }),
      saveServer: save,
    });
    await openEditor();
    await flush((): void =>
      setValue(input('input[placeholder="My MCP server"]'), 'Team tools'),
    );
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      "Your cloud account can't edit servers yet. Try again after it updates.",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('edits a cloud-only server without its full URL', async (): Promise<void> => {
    const connection: AccountMcpConnection = {
      ...cloudConnection,
      authMode: 'BEARER',
      hasExtraHeaders: true,
    };
    mockServers = [accountRow(connection)];
    const update = jest.fn().mockResolvedValue(connection);
    const save = jest.fn();
    install({
      updateAccountConnection: update,
      saveServer: save,
      listAccountConnections: jest.fn().mockResolvedValue([connection]),
    });
    await openEditor();
    const url = input('[data-testid="mcp-server-url"]');
    expect(url.value).toBe('');
    expect(url.placeholder).toBe('https://mcp.example.test/…');
    expect(
      document.querySelector('[data-testid="mcp-server-url-hint"]')
        ?.textContent,
    ).toBe('Leave it empty to keep mcp.example.test.');
    expect(input('[data-testid="mcp-cloud-access-token"]').placeholder).toBe(
      'Stored',
    );
    expect(document.body.textContent).toContain(
      'Custom headers are stored in your cloud account. Add headers here to replace them.',
    );
    expect(document.body.textContent).not.toContain('Health check');
    expect(document.body.textContent).not.toContain('Configurations');
    await flush((): void => button('Remove stored headers').click());
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(update).toHaveBeenCalledWith(connection.id, {
      headers: {},
      expectedAccountId: 'acct-1',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('moves a cloud-only server to this device', async (): Promise<void> => {
    const { loadProjects } = stubProjectsAndToasts();
    mockServers = [accountRow(cloudConnection)];
    const save = echoSave();
    const rewrite = jest
      .fn()
      .mockResolvedValue({ globalDefaults: false, workspaces: 1, chats: 1 });
    const remove = jest.fn().mockResolvedValue({ removed: true });
    const start = jest.fn();
    install({
      saveServer: save,
      rewriteServerRefs: rewrite,
      removeAccountConnection: remove,
      startAccountConnection: start,
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
    });
    await openEditor();
    await flush((): void => scopeButton('device').click());
    expect(button('Save').disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="mcp-server-url-hint"]')
        ?.textContent,
    ).toBe('Enter the full URL to run it on this device.');
    await flush((): void =>
      setValue(
        input('[data-testid="mcp-server-url"]'),
        'https://mcp.example.test/mcp',
      ),
    );
    await flush((): void =>
      setValue(input('[data-testid="mcp-device-access-token"]'), 'local-token'),
    );
    await flush((): void => button('Save').click());
    const confirm = document.querySelector(
      '[data-testid="mcp-move-to-device-dialog"]',
    );
    expect(confirm?.textContent).toContain(
      'Cloud chats, cloud project defaults, and your other desktops lose Internal tools',
    );
    expect(save).not.toHaveBeenCalled();
    await flush((): void => button('Move to this device').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    if (!saved) throw new Error('Missing device save');
    expect(saved.definition.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.definition.url).toBe('https://mcp.example.test/mcp');
    expect(saved.definition.httpAuthHandler).toBeUndefined();
    expect(saved.accountRouting).toBe('clear');
    expect(saved.accountConnectionId).toBeUndefined();
    expect(saved.configs[0]?.authToken).toBe('local-token');
    expect(rewrite).toHaveBeenCalledWith({
      from: [
        { serverId: 'custom:new', configId: 'default' },
        { serverId: `account:${cloudConnection.id}`, configId: 'default' },
      ],
      to: {
        serverId: saved.definition.id,
        configId: saved.configs[0]?.id,
      },
    });
    expect(loadProjects).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(cloudConnection.id);
    expect(rewrite.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0] ?? 0,
    );
  });

  describe('stored headers the cloud never returns', (): void => {
    const withHeaders: AccountMcpConnection = {
      ...cloudConnection,
      hasExtraHeaders: true,
    };

    function installMove(
      rows: McpServerIndexEntry[],
      extra: Partial<McpServersAPI> = {},
    ): {
      save: ReturnType<typeof echoSave>;
      remove: jest.Mock;
    } {
      stubProjectsAndToasts();
      mockServers = rows;
      const save = echoSave();
      const remove = jest.fn().mockResolvedValue({ removed: true });
      install({
        saveServer: save,
        rewriteServerRefs: jest.fn().mockResolvedValue({
          globalDefaults: false,
          workspaces: 0,
          chats: 0,
        }),
        removeAccountConnection: remove,
        listAccountConnections: jest.fn().mockResolvedValue([withHeaders]),
        ...extra,
      });
      return { save, remove };
    }

    function storedHeadersNotice(): string | null | undefined {
      return document.querySelector('[data-testid="mcp-cloud-stored-headers"]')
        ?.textContent;
    }

    function dropHeadersChoice(): HTMLInputElement | null {
      return document.querySelector<HTMLInputElement>(
        '[data-testid="mcp-move-drop-stored-headers"]',
      );
    }

    async function moveCloudOnlyToDevice(): Promise<void> {
      await openEditor();
      expect(storedHeadersNotice()).toContain(
        'Custom headers are stored in your cloud account.',
      );
      await flush((): void => scopeButton('device').click());
      expect(storedHeadersNotice()).toBe(
        "Its stored headers can't be copied to this device. Enter them again here to keep them.",
      );
      await flush((): void =>
        setValue(
          input('[data-testid="mcp-server-url"]'),
          'https://mcp.example.test/mcp',
        ),
      );
    }

    it('moves a cloud-only server only after the user drops its stored headers', async (): Promise<void> => {
      const { save, remove } = installMove([accountRow(withHeaders)]);
      await moveCloudOnlyToDevice();
      expect(lastEditorState()).toMatchObject({
        moveDropsStoredHeaders: true,
        moveWithoutStoredHeaders: false,
      });
      await flush((): void => button('Save').click());
      expect(
        document.querySelector('[data-testid="mcp-move-to-device-dialog"]')
          ?.textContent,
      ).toContain(
        "This server has stored headers that can't be copied to this device. Enter them again in the editor, or move it without them.",
      );
      expect(button('Move to this device').disabled).toBe(true);
      await flush((): void => button('Move to this device').click());
      expect(save).not.toHaveBeenCalled();
      const choice = dropHeadersChoice();
      if (!choice) throw new Error('Missing stored headers choice');
      await flush((): void => choice.click());
      expect(lastEditorState()).toMatchObject({
        moveToDeviceDialogOpen: true,
        moveDropsStoredHeaders: true,
        moveWithoutStoredHeaders: true,
      });
      expect(button('Move to this device').disabled).toBe(false);
      await flush((): void => button('Move to this device').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]?.[0].definition.headers).toBeUndefined();
      expect(remove).toHaveBeenCalledWith(withHeaders.id);
    });

    it('asks again after the confirmation is cancelled', async (): Promise<void> => {
      installMove([accountRow(withHeaders)]);
      await moveCloudOnlyToDevice();
      await flush((): void => button('Save').click());
      const choice = dropHeadersChoice();
      if (!choice) throw new Error('Missing stored headers choice');
      await flush((): void => choice.click());
      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="mcp-move-to-device-dialog"] button',
        ),
      ).find((entry): boolean => entry.textContent === 'Cancel');
      if (!cancel) throw new Error('Missing move cancel');
      await flush((): void => cancel.click());
      await flush((): void => button('Save').click());
      expect(dropHeadersChoice()?.checked).toBe(false);
      expect(button('Move to this device').disabled).toBe(true);
    });

    it('moves a cloud-only server with the headers entered again', async (): Promise<void> => {
      const { save } = installMove([accountRow(withHeaders)]);
      await moveCloudOnlyToDevice();
      await flush((): void =>
        setValue(input('input[placeholder="Header-Name"]'), 'X-Team'),
      );
      await flush((): void =>
        setValue(input('input[placeholder="header-value"]'), 'core'),
      );
      await flush((): void => button('Add').click());
      expect(storedHeadersNotice()).toBe(
        "Its stored headers can't be copied to this device. Enter them again here to keep them.",
      );
      expect(lastEditorState()).toMatchObject({
        moveDropsStoredHeaders: false,
      });
      await flush((): void => button('Save').click());
      expect(dropHeadersChoice()).toBeNull();
      await flush((): void => button('Move to this device').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(save.mock.calls[0]?.[0].definition.headers).toEqual({
        'X-Team': 'core',
      });
    });

    // Without the merged index, the account list is all the editor has; a
    // connection whose header metadata it doesn't carry may still store some.
    it.each([
      ['unknown', undefined, true],
      ['known to be absent', false, false],
    ] as const)(
      'from the account list, asks about stored headers that are %s',
      async (_label, hasExtraHeaders, asks): Promise<void> => {
        const listed: AccountMcpConnection = { ...cloudConnection };
        if (hasExtraHeaders === undefined) delete listed.hasExtraHeaders;
        else listed.hasExtraHeaders = hasExtraHeaders;
        const { save, remove } = installMove([boundDevice], {
          listAccountConnections: jest.fn().mockResolvedValue([listed]),
          loadServer: jest.fn().mockResolvedValue({
            version: 1,
            server: {
              ...boundServer,
              definition: { ...boundServer.definition, headers: undefined },
            },
          }),
          loadIndex: jest
            .fn()
            .mockResolvedValue({ version: 1, servers: [boundDevice] }),
        });
        await flush((): void =>
          root.render(
            <McpServerDialog
              serverId={boundDevice.id}
              onClose={(): void => undefined}
              onSaved={mockRefresh}
            />,
          ),
        );
        await flush((): void => undefined);
        await flush((): void => scopeButton('device').click());
        await flush((): void => button('Save').click());
        expect(
          document.querySelector('[data-testid="mcp-move-to-device-dialog"]'),
        ).not.toBeNull();
        expect(dropHeadersChoice() !== null).toBe(asks);
        expect(button('Move to this device').disabled).toBe(asks);
        if (asks) {
          expect(
            document.querySelector('[data-testid="mcp-move-to-device-dialog"]')
              ?.textContent,
          ).toContain(
            "This server may have stored headers that can't be copied to this device. Enter them again in the editor, or move it without them.",
          );
          await flush((): void => button('Move to this device').click());
          expect(save).not.toHaveBeenCalled();
          expect(remove).not.toHaveBeenCalled();
        }
      },
    );

    it('moves a bound device copy with its own headers without asking', async (): Promise<void> => {
      const row = accountRow(withHeaders, [boundDevice]);
      const { save } = installMove([row], {
        loadServer: jest
          .fn()
          .mockResolvedValue({ version: 1, server: boundServer }),
        loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      });
      await openEditor();
      await flush((): void => scopeButton('device').click());
      expect(storedHeadersNotice()).toBeUndefined();
      await flush((): void => button('Save').click());
      expect(dropHeadersChoice()).toBeNull();
      await flush((): void => button('Move to this device').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(save.mock.calls[0]?.[0].definition.headers).toEqual({
        'X-Team': 'core',
      });
    });
  });

  it('lets App Advisor open a cloud server editor and see the move confirmation', async (): Promise<void> => {
    stubProjectsAndToasts();
    const row = accountRow(cloudConnection, [boundDevice]);
    const curatedRow = { ...account, id: 'github-row' };
    mockServers = [row, curatedRow];
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
    });
    await flush((): void => root.render(<McpServersTab />));
    const edit = async (
      serverId: string,
    ): Promise<Awaited<ReturnType<typeof dispatchAppAction>> | undefined> => {
      let result: Awaited<ReturnType<typeof dispatchAppAction>> | undefined;
      await flush((): void => {
        void dispatchAppAction({
          requestId: `edit-${serverId}`,
          source: 'assistant',
          action: { type: 'mcp.account_edit', serverId },
        }).then((value): void => {
          result = value;
        });
      });
      await flush((): void => undefined);
      await flush((): void => undefined);
      return result;
    };
    expect(await edit('github-row')).toMatchObject({ ok: false });
    expect(await edit(row.id)).toMatchObject({ ok: true });
    expect(scopeChoice()).toBe('cloud');
    const reporter = jest.mocked(useCurrentUiStateReporter);
    expect(reporter).toHaveBeenLastCalledWith(
      'mcp.serverEditor',
      expect.objectContaining({
        mode: 'edit',
        serverId: 'bound-device',
        scope: 'cloud',
        initialScope: 'cloud',
        moveToDeviceDialogOpen: false,
      }),
    );
    await flush((): void => scopeButton('device').click());
    await flush((): void => button('Save').click());
    expect(
      document.querySelector('[data-testid="mcp-move-to-device-dialog"]'),
    ).not.toBeNull();
    expect(
      reporter.mock.calls.filter(([key]) => key === 'mcp.serverEditor').at(-1),
    ).toEqual([
      'mcp.serverEditor',
      expect.objectContaining({
        scope: 'device',
        initialScope: 'cloud',
        moveToDeviceDialogOpen: true,
      }),
    ]);
    expect(JSON.stringify(reporter.mock.calls)).not.toContain(
      'mcp.example.test/mcp',
    );
  });

  it('keeps the cloud server when its references cannot move', async (): Promise<void> => {
    stubProjectsAndToasts();
    const row = accountRow(cloudConnection, [boundDevice]);
    mockServers = [row];
    const remove = jest.fn();
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
      saveServer: echoSave(),
      rewriteServerRefs: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'mcp-servers:rewrite-refs': Error: Couldn't point every chat on this device at the moved server. Try again.",
          ),
        ),
      removeAccountConnection: remove,
    });
    await openEditor();
    await flush((): void => scopeButton('device').click());
    await flush((): void => button('Save').click());
    await flush((): void => button('Move to this device').click());
    await flush((): void => undefined);
    expect(document.body.textContent).toContain(
      "Couldn't point every chat on this device at the moved server. Try again.",
    );
    expect(document.body.textContent).not.toContain('Error invoking');
    expect(remove).not.toHaveBeenCalled();
  });

  it('says the move is unfinished when an older cloud only signs the server out', async (): Promise<void> => {
    const { addToast } = stubProjectsAndToasts();
    const row = accountRow(cloudConnection, [boundDevice]);
    mockServers = [row];
    const remove = jest.fn().mockResolvedValue({ removed: false });
    const closed = jest.fn();
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
      saveServer: echoSave(),
      rewriteServerRefs: jest
        .fn()
        .mockResolvedValue({ globalDefaults: false, workspaces: 0, chats: 0 }),
      removeAccountConnection: remove,
    });
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId="bound-device"
          onClose={closed}
          onSaved={mockRefresh}
        />,
      ),
    );
    await flush((): void => undefined);
    await flush((): void => scopeButton('device').click());
    await flush((): void => button('Save').click());
    await flush((): void => button('Move to this device').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(remove).toHaveBeenCalledWith(cloudConnection.id);
    expect(addToast).toHaveBeenCalledWith(
      "Moved to this device, but your cloud account can't remove servers yet. Delete it from the list after it updates.",
      'error',
    );
    expect(closed).toHaveBeenCalled();
  });

  it('moves a device server to the cloud account from its editor', async (): Promise<void> => {
    stubProjectsAndToasts();
    const device: McpServerIndexEntry = {
      ...boundDevice,
      id: 'custom-device',
      scope: undefined,
      authHandler: undefined,
      accountConnectionId: undefined,
    };
    const start = jest.fn().mockResolvedValue({ connection: customConnection });
    const save = echoSave();
    const rewrite = jest.fn().mockResolvedValue({
      globalDefaults: true,
      workspaces: 0,
      chats: 0,
    });
    const clearToken = jest.fn().mockResolvedValue(undefined);
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: deviceServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [device] }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      startAccountConnection: start,
      saveServer: save,
      rewriteServerRefs: rewrite,
      clearOAuthToken: clearToken,
    });
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId="custom-device"
          onClose={(): void => undefined}
          onSaved={mockRefresh}
        />,
      ),
    );
    await flush((): void => undefined);
    expect(scopeChoice()).toBe('device');
    await flush((): void => scopeButton('cloud').click());
    // The move says what goes with the server, and its token stays editable.
    expect(
      document.querySelector('[data-testid="mcp-cloud-move-carries"]')
        ?.textContent,
    ).toBe(
      "Its URL, headers, and access token move to your cloud account. OAuth sign-ins don't move, so sign in again after you save if it uses OAuth.",
    );
    expect(input('[data-testid="mcp-cloud-access-token"]').value).toBe(
      'device-token',
    );
    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    const confirm = document.querySelector(
      '[data-testid="mcp-move-to-cloud-dialog"]',
    );
    expect(confirm?.textContent).toContain(
      'Its URL, headers, and access token move to your cloud account.',
    );
    expect(confirm?.textContent).toContain(
      "OAuth sign-ins don't move. If it signs in with OAuth, sign in again after it moves.",
    );
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(lastEditorState()).toMatchObject({ moveToCloudDialogOpen: true });
    await flush((): void => button('Move to cloud account').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      bearerToken: 'device-token',
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
    const bound = save.mock.calls[0]?.[0];
    expect(bound?.accountConnectionId).toBe(customConnection.id);
    expect(bound?.configs[0]).not.toHaveProperty('authToken');
    expect(clearToken).toHaveBeenCalledWith({
      serverId: 'custom-device',
      configId: 'cfg-1',
    });
    expect(rewrite).toHaveBeenCalledWith({
      from: [{ serverId: 'custom-device', configId: 'cfg-1' }],
      to: { serverId: 'custom:new', configId: 'default' },
    });
  });

  async function renderDeviceEditor(
    configs: typeof deviceServer.configs,
    start: jest.Mock,
  ): Promise<void> {
    stubProjectsAndToasts();
    const device: McpServerIndexEntry = {
      ...boundDevice,
      id: 'custom-device',
      scope: undefined,
      authHandler: undefined,
      accountConnectionId: undefined,
    };
    install({
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: { ...deviceServer, configs },
      }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [device] }),
      listAccountConnections: jest.fn().mockResolvedValue([]),
      startAccountConnection: start,
      saveServer: echoSave(),
    });
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId="custom-device"
          onClose={(): void => undefined}
          onSaved={mockRefresh}
        />,
      ),
    );
    await flush((): void => undefined);
  }

  function cloudReason(): string | null | undefined {
    return document.querySelector('[data-testid="mcp-cloud-local-reason"]')
      ?.textContent;
  }

  it('keeps a device server with more than one configuration on this device', async (): Promise<void> => {
    const start = jest.fn();
    await renderDeviceEditor(
      [
        ...deviceServer.configs,
        { ...deviceServer.configs[0], id: 'cfg-2', name: 'Staging' },
      ],
      start,
    );
    expect(scopeChoice()).toBe('device');
    expect(scopeButton('cloud').disabled).toBe(true);
    expect(cloudReason()).toBe(SINGLE_CONFIG_REQUIRED);
    expect(start).not.toHaveBeenCalled();
  });

  it('stops a move to the cloud account once the server gains a configuration', async (): Promise<void> => {
    const start = jest.fn();
    await renderDeviceEditor(deviceServer.configs, start);
    await flush((): void => scopeButton('cloud').click());
    expect(cloudReason()).toBeUndefined();
    const addConfig = document.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-server-add-config"]',
    );
    if (!addConfig) throw new Error('Missing add config button');
    await flush((): void => addConfig.click());
    expect(cloudReason()).toBe(SINGLE_CONFIG_REQUIRED);
    expect(button('Save').disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="mcp-move-to-cloud-dialog"]'),
    ).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['cleared', '', undefined],
    ['replaced', 'cloud-token', 'cloud-token'],
  ] as const)(
    'moves a device server with the token the user %s in the editor',
    async (_label, typed, sent): Promise<void> => {
      stubProjectsAndToasts();
      const device: McpServerIndexEntry = {
        ...boundDevice,
        id: 'custom-device',
        scope: undefined,
        authHandler: undefined,
        accountConnectionId: undefined,
      };
      const start = startMock();
      install({
        loadServer: jest
          .fn()
          .mockResolvedValue({ version: 1, server: deviceServer }),
        loadIndex: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [device] }),
        listAccountConnections: jest.fn().mockResolvedValue([]),
        startAccountConnection: start,
        saveServer: echoSave(),
        rewriteServerRefs: jest.fn().mockResolvedValue({
          globalDefaults: false,
          workspaces: 0,
          chats: 0,
        }),
        clearOAuthToken: jest.fn().mockResolvedValue(undefined),
      });
      await flush((): void =>
        root.render(
          <McpServerDialog
            serverId="custom-device"
            onClose={(): void => undefined}
            onSaved={mockRefresh}
          />,
        ),
      );
      await flush((): void => undefined);
      await flush((): void => scopeButton('cloud').click());
      await flush((): void =>
        setValue(input('[data-testid="mcp-cloud-access-token"]'), typed),
      );
      await flush((): void => button('Save').click());
      expect(
        document.querySelector('[data-testid="mcp-move-to-cloud-dialog"]')
          ?.textContent,
      ).toContain(
        sent
          ? 'Its URL, headers, and access token move to your cloud account.'
          : 'Its URL and headers move to your cloud account. No access token goes with it.',
      );
      await flush((): void => button('Move to cloud account').click());
      await flush((): void => undefined);
      await flush((): void => undefined);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]?.bearerToken).toBe(sent);
    },
  );

  it('deletes a cloud-only server from the cloud account', async (): Promise<void> => {
    mockServers = [accountRow(cloudConnection)];
    const remove = jest.fn().mockResolvedValue({ removed: true });
    const deleteServer = jest.fn();
    install({
      removeAccountConnection: remove,
      deleteServer,
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
    });
    await openEditor();
    await flush((): void => button('Delete').click());
    expect(
      document.querySelector('[data-testid="mcp-server-delete-scope"]')
        ?.textContent,
    ).toBe(
      'Deletes it from your cloud account. Cloud chats and every signed-in desktop lose it.',
    );
    await flush((): void => button('Confirm').click());
    await flush((): void => undefined);
    expect(remove).toHaveBeenCalledWith(cloudConnection.id);
    expect(deleteServer).not.toHaveBeenCalled();
  });

  it('keeps the editor open when an older cloud only signs a cloud-only server out', async (): Promise<void> => {
    mockServers = [accountRow(cloudConnection)];
    const remove = jest.fn().mockResolvedValue({ removed: false });
    const deleteServer = jest.fn();
    install({
      removeAccountConnection: remove,
      deleteServer,
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
    });
    await openEditor();
    await flush((): void => button('Delete').click());
    await flush((): void => button('Confirm').click());
    await flush((): void => undefined);
    expect(remove).toHaveBeenCalledWith(cloudConnection.id);
    expect(deleteServer).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Your cloud account can't remove servers yet, so it was only signed out. Try again after it updates.",
    );
    expect(
      document.querySelector('[data-testid="mcp-server-scope"]'),
    ).not.toBeNull();
  });

  async function deleteBoundCopy(
    api: Pick<McpServersAPI, 'deleteServer' | 'removeAccountConnection'>,
  ): Promise<jest.Mock> {
    const row = accountRow(cloudConnection, [boundDevice]);
    mockServers = [row];
    const closed = jest.fn();
    install({
      loadServer: jest
        .fn()
        .mockResolvedValue({ version: 1, server: boundServer }),
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [row] }),
      listAccountConnections: jest.fn().mockResolvedValue([cloudConnection]),
      ...api,
    });
    await flush((): void =>
      root.render(
        <McpServerDialog
          serverId="bound-device"
          onClose={closed}
          onSaved={mockRefresh}
        />,
      ),
    );
    await flush((): void => undefined);
    await flush((): void => button('Delete').click());
    await flush((): void => button('Confirm').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    return closed;
  }

  it('deletes the device copy first and keeps the cloud server when that fails', async (): Promise<void> => {
    stubProjectsAndToasts();
    const deleteServer = jest
      .fn()
      .mockRejectedValueOnce(new Error("Couldn't delete the server file."))
      .mockResolvedValue(undefined);
    // The main process answers a connection the cloud no longer has as removed.
    const remove = jest.fn().mockResolvedValue({ removed: true });
    const closed = await deleteBoundCopy({
      deleteServer,
      removeAccountConnection: remove,
    });
    expect(deleteServer).toHaveBeenCalledWith('bound-device');
    expect(remove).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Couldn't delete the server file.",
    );
    await flush((): void => button('Confirm').click());
    await flush((): void => undefined);
    await flush((): void => undefined);
    expect(remove).toHaveBeenCalledWith(cloudConnection.id);
    expect(deleteServer.mock.invocationCallOrder[1]).toBeLessThan(
      remove.mock.invocationCallOrder[0] ?? 0,
    );
    expect(closed).toHaveBeenCalled();
  });

  it('says the device copy is gone but the cloud server stays when an older cloud only signs it out', async (): Promise<void> => {
    const { addToast } = stubProjectsAndToasts();
    const deleteServer = jest.fn().mockResolvedValue(undefined);
    const remove = jest.fn().mockResolvedValue({ removed: false });
    const closed = await deleteBoundCopy({
      deleteServer,
      removeAccountConnection: remove,
    });
    expect(deleteServer.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0] ?? 0,
    );
    expect(addToast).toHaveBeenCalledWith(
      "Deleted from this device. It's still in your cloud account, which can't remove servers yet. Delete it from the list after your cloud account updates.",
      'error',
    );
    expect(mockRefresh).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it('says the device copy is gone but the cloud server stays when removing it fails', async (): Promise<void> => {
    const { addToast } = stubProjectsAndToasts();
    const closed = await deleteBoundCopy({
      deleteServer: jest.fn().mockResolvedValue(undefined),
      removeAccountConnection: jest
        .fn()
        .mockRejectedValue(new Error('HTTP 500: connection_failed')),
    });
    expect(addToast).toHaveBeenCalledWith(
      "Deleted from this device, but couldn't remove it from your cloud account. Delete it from the list to try again.",
      'error',
    );
    expect(closed).toHaveBeenCalled();
  });

  it('says a curated device copy delete keeps the cloud server', async (): Promise<void> => {
    const deleteServer = jest.fn().mockResolvedValue(undefined);
    install({
      loadServer: jest.fn().mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: device.id,
            name: 'GitHub',
            description: '',
            type: 'http',
            url: 'https://mcp.example.test',
            curated: { key: 'github' },
            createdAt: '',
            updatedAt: '',
          },
          configs: [],
        },
      }),
      loadIndex: jest
        .fn()
        .mockResolvedValue({ version: 1, servers: [account] }),
      listAccountConnections: jest.fn().mockResolvedValue([connection]),
      deleteServer,
    });
    await flush((): void => root.render(<McpServersTab />));
    await flush((): void => button('Device copy').click());
    await flush((): void => undefined);
    await flush((): void => button('Delete').click());
    expect(
      document.querySelector('[data-testid="mcp-server-delete-scope"]')
        ?.textContent,
    ).toBe('Deletes the copy on this device. It stays in your cloud account.');
  });
});

describe('provider connector feedback', () => {
  const gmail = {
    key: 'gmail',
    name: 'Gmail',
    shortDescription: '',
    url: '',
    transport: 'http' as const,
    categories: [],
    popular: true,
    sortOrder: 0,
    updatedAt: '',
    providerConnector: { providers: ['claude' as const, 'codex' as const] },
  };

  async function addFromBrowse(): Promise<void> {
    await flush((): void =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="mcp-add-menu-trigger"]',
        )
        ?.click(),
    );
    await flush((): void =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="mcp-add-browse"]')
        ?.click(),
    );
    const add = document.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-browse-card-add"]',
    );
    if (!add) throw new Error('Missing browse Add');
    await flush((): void => add.click());
  }

  it('says what to connect first inside the dialog a provider connector opens', async (): Promise<void> => {
    mockServers = [];
    mockEntries = [gmail];
    const start = jest.fn();
    install({
      startAccountConnection: start,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [] }),
      listAccountConnections: (): ReturnType<
        McpServersAPI['listAccountConnections']
      > => Promise.resolve([]),
    });
    await flush((): void => root.render(<McpServersTab />));

    await addFromBrowse();

    // The add dialog is modal, so the guidance lives in it, not behind it.
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    const notice = dialog?.querySelector(
      '[data-testid="mcp-server-provider-connector-notice"]',
    );
    expect(notice?.textContent).toContain(
      'Gmail connects through your Claude or Codex account. Connect Claude or Codex first, then link Gmail there.',
    );
    expect(
      container.querySelector('[data-testid="mcp-connect-notice"]'),
    ).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('names only the providers that offer the connector', async (): Promise<void> => {
    mockServers = [];
    mockEntries = [
      { ...gmail, providerConnector: { providers: ['claude' as const] } },
    ];
    install({
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [] }),
      listAccountConnections: (): ReturnType<
        McpServersAPI['listAccountConnections']
      > => Promise.resolve([]),
    });
    await flush((): void => root.render(<McpServersTab />));
    await addFromBrowse();
    expect(
      document.querySelector(
        '[data-testid="mcp-server-provider-connector-notice"]',
      )?.textContent,
    ).toContain(
      'Gmail connects through your Claude account. Connect Claude first, then link Gmail there.',
    );
  });

  it('adds a server the catalog marks desktop only as a device server here (REG-3035)', async (): Promise<void> => {
    // The cloud cannot sign in to it, but this device can: Add opens the
    // device editor with no "can't connect" notice and saves a device server
    // that signs in with the app's own handler.
    mockServers = [];
    mockEntries = [
      {
        ...gmail,
        key: 'canva',
        name: 'Canva',
        url: 'https://mcp.canva.example/mcp',
        providerConnector: undefined,
        availability: 'desktop' as const,
        oauthHints: { scopes: ['design'] },
      },
    ];
    const start = jest.fn();
    const save = createSaveServerMock();
    install({
      startAccountConnection: start,
      saveServer: save,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [] }),
      listAccountConnections: (): ReturnType<
        McpServersAPI['listAccountConnections']
      > => Promise.resolve([]),
    });
    await flush((): void => root.render(<McpServersTab />));
    await addFromBrowse();

    expect(start).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="mcp-server-provider-connector-notice"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-connect-notice"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "This server can't be connected from here.",
    );
    // The cloud account is never an option for it, so the editor says why
    // instead of asking to connect it in the cloud account first.
    expect(
      dialog?.querySelector('[data-testid="mcp-cloud-local-reason"]')
        ?.textContent,
    ).toBe('Desktop only. This server signs in on this device.');
    expect(
      Array.from(dialog?.querySelectorAll('button') ?? []).some(
        (candidate): boolean => candidate.textContent === 'Try again',
      ),
    ).toBe(false);

    await flush((): void => button('Save').click());
    await flush((): void => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    const definition = save.mock.calls[0]?.[0].definition;
    expect(definition?.url).toBe('https://mcp.canva.example/mcp');
    expect(definition?.curated?.key).toBe('canva');
    expect(definition?.httpAuthHandler).not.toBe('account');
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('accountConnectionId');
  });

  it('starts the account sign-in without a notice when the server signs in here', async (): Promise<void> => {
    mockServers = [];
    mockEntries = [
      {
        ...gmail,
        key: 'google-calendar',
        name: 'Google Calendar',
        url: 'https://calendar.example.test/mcp',
        oauthHints: { scopes: ['calendar'] },
      },
    ];
    const start = jest.fn().mockResolvedValue({
      connection: { ...connection, serverKey: 'google-calendar' },
    });
    install({
      startAccountConnection: start,
      loadIndex: (): ReturnType<McpServersAPI['loadIndex']> =>
        Promise.resolve({ version: 1, servers: [] }),
      listAccountConnections: (): ReturnType<
        McpServersAPI['listAccountConnections']
      > => Promise.resolve([]),
    });
    await flush((): void => root.render(<McpServersTab />));
    await addFromBrowse();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ serverKey: 'google-calendar' }),
    );
    expect(
      container.querySelector('[data-testid="mcp-connect-notice"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="mcp-server-provider-connector-notice"]',
      ),
    ).toBeNull();
  });
});

it('threads Marketplace Share into the account-only detail action area', async () => {
  install({
    loadIndex: () => Promise.resolve({ version: 1, servers: [account] }),
    getAccountConnection: () => Promise.resolve(connection),
  });
  const actionProps = {
    shareAction: {
      status: 'blocked' as const,
      reason: 'MCP server connections cannot be shared.',
    },
  };
  await flush(() =>
    root.render(
      <McpServerDetailOverlay
        serverId="github"
        onBack={() => {}}
        {...actionProps}
      />,
    ),
  );
  const share = document.querySelector(
    '[data-testid="mcp-account-details-share"]',
  );
  expect(share).not.toBeNull();
  expect(share?.getAttribute('aria-description')).toBe(
    actionProps.shareAction.reason,
  );
  expect(
    share
      ?.closest('[data-testid="mcp-account-tools"]')
      ?.querySelector('[data-testid="mcp-account-tools-save"]'),
  ).not.toBeNull();
});
