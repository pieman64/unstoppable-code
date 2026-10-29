/** @jest-environment jsdom */
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
jest.mock('@/hooks/useCurrentUiStateReporter', (): object => ({
  useCurrentUiStateReporter: jest.fn(),
}));
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  AccountMcpConnection,
  DetectedMcpServerInfo,
  ListDetectedMcpServersRequest,
  McpServerIndexEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { useNavigationStore } from '@/stores/navigationStore';
import { useOverlayEscape } from '@canopy/ui-shared/components';
import { HomeMcpSignInStrip } from '../HomeMcpSignInStrip';

let mockFlagEnabled = true;
jest.mock(
  '@/stores/featureFlagsStore',
  (): Record<string, unknown> => ({
    useFeatureFlagsStore: Object.assign((): boolean => mockFlagEnabled, {
      getState: (): { isEnabled: () => boolean } => ({
        isEnabled: (): boolean => mockFlagEnabled,
      }),
    }),
  }),
);
let mockCatalog: {
  entries: CuratedMcpServerEntry[];
  loading: boolean;
  error: string | null;
} = { entries: [], loading: false, error: null };
let mockRefreshedEntries: CuratedMcpServerEntry[] = [];
const mockRefreshCatalog = jest.fn(
  (): Promise<CuratedMcpServerEntry[]> => Promise.resolve(mockRefreshedEntries),
);
jest.mock(
  '../../../hooks/useCuratedMcpServers',
  (): Record<string, unknown> => ({
    useCuratedMcpServers: (): Record<string, unknown> => ({
      ...mockCatalog,
      refresh: mockRefreshCatalog,
    }),
  }),
);

function catalogEntry(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'linear',
    name: 'Linear',
    shortDescription: '',
    url: 'https://mcp.linear.example.test/mcp',
    transport: 'http',
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

const reporter = jest.mocked(useCurrentUiStateReporter);

function connection(
  overrides: Partial<AccountMcpConnection> = {},
): AccountMcpConnection {
  return {
    id: 'conn-github',
    serverKey: 'github',
    configId: 'default',
    displayName: 'Account GitHub',
    status: 'DISCONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
    authMode: 'OAUTH',
    ...overrides,
  };
}

function indexRow(conn: AccountMcpConnection): McpServerIndexEntry {
  return {
    id: conn.serverKey,
    name: conn.displayName,
    description: '',
    type: 'http',
    updatedAt: '',
    scope: 'account',
    authHandler: 'account',
    accountConnectionId: conn.id,
    accountConnection: conn,
    configs: [{ id: conn.configId, name: 'Default', enabled: true }],
  };
}

function accountRow(
  conn: AccountMcpConnection,
  authStatus: DetectedMcpServerInfo['authStatus'],
): DetectedMcpServerInfo {
  return {
    key: `standalone:${conn.serverKey}:${conn.configId}`,
    source: 'standalone',
    serverName: conn.displayName,
    displayName: conn.displayName,
    type: 'http',
    serverId: conn.serverKey,
    configId: conn.configId,
    configName: 'Default',
    enabled: true,
    scope: 'account',
    authHandler: 'account',
    httpAuthHandler: 'account',
    accountConnectionId: conn.id,
    authStatus,
    authStatusLabel: 'Reconnect in cloud',
    canConnect: false,
  };
}

/** A device server bound to a catalog key and routed to the account, with no connection yet. */
function catalogAccountRow(configId: string): DetectedMcpServerInfo {
  return {
    key: `standalone:linear-device:${configId}`,
    source: 'standalone',
    serverName: 'Linear',
    displayName: 'Linear',
    type: 'http',
    url: 'https://mcp.linear.example.test/mcp',
    serverId: 'linear-device',
    configId,
    configName: 'Work',
    curatedKey: 'linear',
    enabled: true,
    scope: 'account',
    authHandler: 'account',
    httpAuthHandler: 'account',
    authStatus: 'not_connected',
    authStatusLabel: 'Connect in cloud',
    canConnect: false,
  };
}

function deviceRow(
  authStatus: DetectedMcpServerInfo['authStatus'],
): DetectedMcpServerInfo {
  return {
    key: 'standalone:notes:cfg1',
    source: 'standalone',
    serverName: 'Notes',
    displayName: 'Notes',
    type: 'http',
    serverId: 'notes',
    configId: 'cfg1',
    configName: 'Default',
    enabled: true,
    authHandler: 'canopy',
    authStatus,
    authStatusLabel: authStatus === 'connected' ? 'Connected' : 'Needs auth',
    canConnect: authStatus !== 'connected',
    ...(authStatus === 'connected' ? {} : { connectLabel: 'Connect' }),
  };
}

const PROVIDER_ROW: DetectedMcpServerInfo = {
  ...deviceRow('not_configured'),
  key: 'standalone:drive:cfg1',
  serverId: 'drive',
  displayName: 'Drive',
  authHandler: 'provider',
  authStatusLabel: 'Agent provider',
  canConnect: false,
};

const CLIENT_SETUP: AccountMcpClientSetup = {
  redirectUri: 'https://app.example.test/api/mcp-connections/callback/key',
  issuer: 'https://auth.example.test',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};

function selections(...serverIds: string[]): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: serverIds.map((serverId) => ({
      serverId,
      configId:
        serverId === 'notes' || serverId === 'drive' ? 'cfg1' : 'default',
    })),
  };
}

/** An HTTP server a plugin declares with no catalog key, routed to the account. */
const PLUGIN_ACCOUNT_ROW: DetectedMcpServerInfo = {
  key: 'plugin:acme:team-tools:tracker',
  source: 'plugin',
  serverName: 'team-tools_tracker',
  displayName: 'Tracker',
  type: 'http',
  url: 'https://tracker.example.test/mcp',
  marketplaceId: 'acme',
  pluginName: 'team-tools',
  pluginServerName: 'tracker',
  enabled: true,
  scope: 'account',
  authHandler: 'account',
  httpAuthHandler: 'account',
  authStatus: 'not_connected',
  authStatusLabel: 'Connect in cloud',
  canConnect: false,
};

/** Inventory rows by server id; `listDetected` answers only what the draft selects. */
let inventory = new Map<string, DetectedMcpServerInfo>();
/** Plugin servers by `marketplaceId/pluginName`. */
let pluginInventory = new Map<string, DetectedMcpServerInfo[]>();
let connections: AccountMcpConnection[] = [];
const listDetected = jest.fn(
  ({ selections: selected }: ListDetectedMcpServersRequest) =>
    Promise.resolve({
      servers: [
        ...(selected.mcpServerRefs ?? []).flatMap((ref) => {
          const row = inventory.get(ref.serverId);
          return row ? [row] : [];
        }),
        ...selected.pluginRefs.flatMap(
          (ref) =>
            pluginInventory.get(`${ref.marketplaceId}/${ref.pluginName}`) ?? [],
        ),
      ],
      warnings: [],
    }),
);
const listAccountConnections = jest.fn();
const startAccountConnection = jest.fn();
const awaitAccountConnection = jest.fn();
const startOAuthLogin = jest.fn();
const authListeners = new Set<() => void>();
function authChanged(): void {
  authListeners.forEach((listener): void => listener());
}

let container: HTMLDivElement;
let root: Root;
let originalMcpServers: PropertyDescriptor | undefined;
let originalApi: PropertyDescriptor | undefined;

async function flush(): Promise<void> {
  await act(async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(selected: ChatTabPluginSelections | null): Promise<void> {
  act((): void =>
    root.render(<HomeMcpSignInStrip selections={selected} reportUiState />),
  );
  await flush();
}

function strip(): HTMLElement | null {
  return container.querySelector('[data-testid="mcp-sign-in-strip"]');
}

function summary(): string | null | undefined {
  return container.querySelector('[data-testid="mcp-sign-in-strip-summary"]')
    ?.textContent;
}

function rows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="mcp-servers-card-row"]',
    ),
  );
}

function row(name: string): HTMLElement {
  const found = rows().find(
    (candidate) =>
      candidate.querySelector('[data-testid="mcp-servers-card-name"]')
        ?.textContent === name,
  );
  if (!found) throw new Error(`No ${name} row`);
  return found;
}

function badge(name: string): string | null | undefined {
  return row(name).querySelector('[data-testid="mcp-servers-card-badge"]')
    ?.textContent;
}

async function clickConnect(name: string): Promise<void> {
  const button = row(name).querySelector<HTMLButtonElement>(
    '[data-testid="mcp-servers-card-connect"]',
  );
  if (!button) throw new Error(`No Connect on ${name}`);
  act((): void => button.click());
  await flush();
}

function lastReport(): unknown {
  const calls = reporter.mock.calls.filter(([key]) => key === 'home.mcpSignIn');
  return calls[calls.length - 1]?.[1];
}

beforeEach((): void => {
  mockFlagEnabled = true;
  mockCatalog = { entries: [], loading: false, error: null };
  mockRefreshedEntries = [];
  jest.clearAllMocks();
  const github = connection();
  const slack = connection({
    id: 'conn-slack',
    serverKey: 'slack',
    displayName: 'Slack',
    status: 'REAUTH_REQUIRED',
  });
  const docs = connection({
    id: 'conn-docs',
    serverKey: 'docs',
    displayName: 'Docs',
    status: 'CONNECTED',
  });
  connections = [github, slack, docs];
  inventory = new Map([
    ['github', accountRow(github, 'not_connected')],
    ['slack', accountRow(slack, 'error')],
    ['docs', accountRow(docs, 'connected')],
    ['notes', deviceRow('not_connected')],
    ['drive', PROVIDER_ROW],
  ]);
  pluginInventory = new Map();
  listAccountConnections.mockImplementation(() => Promise.resolve(connections));
  useNavigationStore.getState().closeSettings();
  authListeners.clear();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  originalMcpServers = Object.getOwnPropertyDescriptor(window, 'mcpServers');
  originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      listDetected,
      listAccountConnections,
      startAccountConnection,
      awaitAccountConnection,
      startOAuthLogin,
      loadIndex: jest.fn(() =>
        Promise.resolve({
          version: 1,
          servers: connections.map(indexRow),
        }),
      ),
      onAuthChanged: (callback: () => void): (() => void) => {
        authListeners.add(callback);
        return (): void => {
          authListeners.delete(callback);
        };
      },
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest
        .fn()
        .mockResolvedValue({ hasApiKey: true, account: { id: 'acct-1' } }),
      loadPreferences: jest.fn().mockResolvedValue({}),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
  if (originalMcpServers)
    Object.defineProperty(window, 'mcpServers', originalMcpServers);
  else Reflect.deleteProperty(window, 'mcpServers');
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});

it('prompts sign-in for the draft’s account and device servers that need it', async (): Promise<void> => {
  await render(selections('github', 'slack', 'docs', 'notes', 'drive'));
  expect(summary()).toBe('Account GitHub, Notes, and Slack need sign-in');
  expect(rows()).toHaveLength(3);
  expect(badge('Account GitHub')).toBe('Not signed in');
  expect(badge('Slack')).toBe('Needs reconnecting');
  expect(
    row('Slack').querySelector('[data-testid="mcp-servers-card-connect"]')
      ?.textContent,
  ).toBe('Reconnect');
  expect(badge('Notes')).toBe('Not signed in');
  expect(lastReport()).toEqual({
    visible: true,
    setupOpen: false,
    servers: [
      { name: 'Account GitHub', status: 'not_signed_in', pending: false },
      { name: 'Notes', status: 'not_signed_in', pending: false },
      { name: 'Slack', status: 'needs_reconnecting', pending: false },
    ],
  });
});

it('stays hidden when every selected server is signed in, or with no draft', async (): Promise<void> => {
  await render(selections('docs', 'drive'));
  expect(strip()).toBeNull();
  expect(lastReport()).toEqual({
    visible: false,
    setupOpen: false,
    servers: [],
  });
  listDetected.mockClear();
  await render(null);
  expect(strip()).toBeNull();
  expect(listDetected).not.toHaveBeenCalled();
});

it('stays hidden while account connections are turned off', async (): Promise<void> => {
  mockFlagEnabled = false;
  await render(selections('github'));
  expect(strip()).toBeNull();
});

it('follows the draft as the picker changes it', async (): Promise<void> => {
  await render(selections('github'));
  expect(summary()).toBe('Account GitHub needs sign-in');
  await render(selections('github', 'slack'));
  expect(summary()).toBe('Account GitHub and Slack need sign-in');
  await render(selections('slack'));
  expect(summary()).toBe('Slack needs sign-in');
  expect(rows()).toHaveLength(1);
  await render(selections('docs'));
  expect(strip()).toBeNull();
});

it('signs an account server in from Connect and hides once all are connected', async (): Promise<void> => {
  let settle: (value: unknown) => void = (): void => undefined;
  startAccountConnection.mockResolvedValue({
    authorizationUrl: 'https://auth.example.test/authorize',
  });
  awaitAccountConnection.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await render(selections('github', 'slack'));
  const pending = connection({ status: 'PENDING' });
  connections = connections.map((entry) =>
    entry.id === pending.id ? pending : entry,
  );
  await clickConnect('Account GitHub');
  expect(startAccountConnection).toHaveBeenCalledWith({
    serverKey: 'github',
    configId: 'default',
    expectedAccountId: 'acct-1',
  });
  expect(
    row('Account GitHub').querySelector(
      '[data-testid="mcp-servers-card-connect"]',
    )?.textContent,
  ).toBe('Connecting…');
  expect(row('Account GitHub').textContent).toContain('Waiting for browser');

  const signedIn = connection({ status: 'CONNECTED' });
  connections = connections.map((entry) =>
    entry.id === signedIn.id ? signedIn : entry,
  );
  inventory.set('github', accountRow(signedIn, 'connected'));
  act((): void => settle(signedIn));
  await flush();
  expect(summary()).toBe('Slack needs sign-in');
  expect(badge('Account GitHub')).toBe('Signed in');
  expect(
    row('Account GitHub').querySelector(
      '[data-testid="mcp-servers-card-connect"]',
    ),
  ).toBeNull();

  inventory.set(
    'slack',
    accountRow(
      connection({
        id: 'conn-slack',
        serverKey: 'slack',
        displayName: 'Slack',
        status: 'CONNECTED',
      }),
      'connected',
    ),
  );
  act((): void => authChanged());
  await flush();
  expect(strip()).toBeNull();
});

it('asks for the user’s own OAuth app when the server registers no clients', async (): Promise<void> => {
  const custom = connection({
    id: 'conn-custom',
    serverKey: 'custom:tools',
    displayName: 'Tools',
    kind: 'CUSTOM',
  });
  connections = [custom];
  inventory.set('custom:tools', accountRow(custom, 'not_connected'));
  startAccountConnection.mockResolvedValue({
    error: { code: 'oauth-client-required', clientSetup: CLIENT_SETUP },
  });
  await render(selections('custom:tools'));
  await clickConnect('Tools');
  const dialog = document.querySelector(
    '[data-testid="mcp-account-credential-setup"]',
  );
  expect(dialog?.textContent).toContain(
    'Tools doesn’t let apps register themselves.',
  );
  expect(
    document.querySelector('[data-testid="mcp-account-oauth-client-id"]'),
  ).not.toBeNull();
  expect(lastReport()).toMatchObject({ visible: true, setupOpen: true });
});

it('signs a device server in through local OAuth, like the MCP Servers card', async (): Promise<void> => {
  startOAuthLogin.mockImplementation(() => {
    inventory.set('notes', deviceRow('connected'));
    return Promise.resolve({ status: 'completed' });
  });
  await render(selections('notes'));
  await clickConnect('Notes');
  expect(startOAuthLogin).toHaveBeenCalledWith({
    serverId: 'notes',
    configId: 'cfg1',
    force: false,
  });
  expect(strip()).toBeNull();
});

function connectButton(name: string): HTMLButtonElement | null {
  return row(name).querySelector<HTMLButtonElement>(
    '[data-testid="mcp-servers-card-connect"]',
  );
}

it('holds a catalog server’s Connect until the catalog loads, then runs its setup', async (): Promise<void> => {
  const custom = connection({
    id: 'conn-custom',
    serverKey: 'custom:tools',
    displayName: 'Tools',
    kind: 'CUSTOM',
  });
  connections = [...connections, custom];
  inventory.set('custom:tools', accountRow(custom, 'not_connected'));
  inventory.set('linear-device', catalogAccountRow('work'));
  mockCatalog = { entries: [], loading: true, error: null };
  await render(selections('linear-device', 'custom:tools'));
  expect(connectButton('Linear')?.disabled).toBe(true);
  expect(connectButton('Tools')?.disabled).toBe(false);
  await clickConnect('Linear');
  expect(startAccountConnection).not.toHaveBeenCalled();

  mockCatalog = {
    entries: [
      catalogEntry({ requiredConfigFields: [{ kind: 'oauth-client-id' }] }),
    ],
    loading: false,
    error: null,
  };
  await render(selections('linear-device', 'custom:tools'));
  expect(connectButton('Linear')?.disabled).toBe(false);
  await clickConnect('Linear');
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).not.toBeNull();
  expect(startAccountConnection).not.toHaveBeenCalled();
  const title = document.getElementById('mcp-server-dialog-title');
  expect(title?.textContent).toBe('Connect Linear');
});

it('opens the endpoint choice from a fresh catalog when the cloud asks for an endpoint', async (): Promise<void> => {
  mockCatalog = { entries: [catalogEntry()], loading: false, error: null };
  mockRefreshedEntries = [
    catalogEntry({
      urlOptions: [
        { label: 'US', url: 'https://mcp.linear.example.test/mcp' },
        { label: 'EU', url: 'https://mcp.linear.example.eu/mcp' },
      ],
    }),
  ];
  inventory.set('linear-device', catalogAccountRow('work'));
  startAccountConnection.mockResolvedValue({
    error: { code: 'connect-refused', serverCode: 'endpoint_required' },
  });
  await render(selections('linear-device'));
  await clickConnect('Linear');
  await flush();
  expect(startAccountConnection).toHaveBeenCalledTimes(1);
  expect(mockRefreshCatalog).toHaveBeenCalledTimes(1);
  const setup = document.querySelector('[data-testid="mcp-account-setup"]');
  expect(
    setup?.querySelector('[data-testid="mcp-curated-url-option"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="mcp-sign-in-strip-error"]'),
  ).toBeNull();
});

function PageOverlay({ open }: { readonly open: boolean }): null {
  useOverlayEscape(open, (): void => undefined);
  return null;
}

it('drops a delayed endpoint choice once another dialog on the page opened and closed', async (): Promise<void> => {
  mockCatalog = { entries: [catalogEntry()], loading: false, error: null };
  let finishRefresh: (entries: CuratedMcpServerEntry[]) => void = (): void =>
    undefined;
  mockRefreshCatalog.mockImplementationOnce(
    (): Promise<CuratedMcpServerEntry[]> =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  inventory.set('linear-device', catalogAccountRow('work'));
  startAccountConnection.mockResolvedValue({
    error: { code: 'connect-refused', serverCode: 'endpoint_required' },
  });
  await render(selections('linear-device'));
  await clickConnect('Linear');
  await flush();
  expect(mockRefreshCatalog).toHaveBeenCalledTimes(1);
  const overlayHost = document.createElement('div');
  const overlayRoot = createRoot(overlayHost);
  act((): void => overlayRoot.render(<PageOverlay open />));
  act((): void => overlayRoot.render(<PageOverlay open={false} />));
  await act(async (): Promise<void> => {
    finishRefresh([
      catalogEntry({
        urlOptions: [
          { label: 'US', url: 'https://mcp.linear.example.test/mcp' },
          { label: 'EU', url: 'https://mcp.linear.example.eu/mcp' },
        ],
      }),
    ]);
    await Promise.resolve();
  });
  await flush();
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).toBeNull();
  act((): void => overlayRoot.unmount());
});

it('drops a delayed endpoint choice once a newer prompt opened and closed', async (): Promise<void> => {
  const custom = connection({
    id: 'conn-custom',
    serverKey: 'custom:tools',
    displayName: 'Tools',
    kind: 'CUSTOM',
    authMode: 'BEARER',
  });
  connections = [...connections, custom];
  inventory.set('custom:tools', accountRow(custom, 'not_connected'));
  mockCatalog = { entries: [catalogEntry()], loading: false, error: null };
  let finishRefresh: (entries: CuratedMcpServerEntry[]) => void = (): void =>
    undefined;
  mockRefreshCatalog.mockImplementationOnce(
    (): Promise<CuratedMcpServerEntry[]> =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  inventory.set('linear-device', catalogAccountRow('work'));
  startAccountConnection.mockResolvedValue({
    error: { code: 'connect-refused', serverCode: 'endpoint_required' },
  });
  await render(selections('linear-device', 'custom:tools'));
  await clickConnect('Linear');
  await flush();
  expect(mockRefreshCatalog).toHaveBeenCalledTimes(1);
  await clickConnect('Tools');
  const prompt = document.querySelector(
    '[data-testid="mcp-account-credential-setup"]',
  );
  expect(prompt).not.toBeNull();
  const cancel = Array.from(
    prompt?.querySelectorAll<HTMLButtonElement>('button') ?? [],
  ).find((entry): boolean => entry.textContent === 'Cancel');
  act((): void => cancel?.click());
  await flush();
  expect(
    document.querySelector('[data-testid="mcp-account-credential-setup"]'),
  ).toBeNull();
  await act(async (): Promise<void> => {
    finishRefresh([
      catalogEntry({
        urlOptions: [
          { label: 'US', url: 'https://mcp.linear.example.test/mcp' },
          { label: 'EU', url: 'https://mcp.linear.example.eu/mcp' },
        ],
      }),
    ]);
    await Promise.resolve();
  });
  await flush();
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="mcp-sign-in-strip-error"]'),
  ).toBeNull();
});

it('offers a retry instead of connecting when the catalog fails to load', async (): Promise<void> => {
  inventory.set('linear-device', catalogAccountRow('work'));
  mockCatalog = { entries: [], loading: false, error: 'Network down' };
  await render(selections('linear-device'));
  expect(connectButton('Linear')?.disabled).toBe(true);
  await clickConnect('Linear');
  expect(startAccountConnection).not.toHaveBeenCalled();
  const notice = container.querySelector<HTMLElement>(
    '[data-testid="mcp-sign-in-strip-load-error"]',
  );
  expect(notice?.getAttribute('data-notice-intent')).toBe('destructive');
  expect(notice?.textContent).toContain('Couldn’t load sign-in details.');
  const retry = notice?.querySelector<HTMLButtonElement>(
    '[data-testid="mcp-sign-in-strip-load-retry"]',
  );
  expect(retry?.textContent).toBe('Try again');
  act((): void => retry?.click());
  await flush();
  expect(mockRefreshCatalog).toHaveBeenCalledTimes(1);
});

it('shows a failed start in the shared notice, with its code at hand', async (): Promise<void> => {
  startAccountConnection.mockResolvedValue({
    error: { code: 'connect-refused', serverCode: 'transient' },
  });
  await render(selections('github'));
  await clickConnect('Account GitHub');
  const error = container.querySelector<HTMLElement>(
    '[data-testid="mcp-sign-in-strip-error"]',
  );
  expect(error).not.toBeNull();
  expect(
    error?.querySelector('[data-notice-intent="destructive"]'),
  ).not.toBeNull();
  expect(error?.textContent).toBe(
    'Couldn’t reach this server’s sign-in service. Try again.',
  );
  expect(error?.getAttribute('title')).toBe('Error code: transient');
});

it('keeps a plugin account server with no catalog key and sends it to MCP settings', async (): Promise<void> => {
  pluginInventory.set('acme/team-tools', [PLUGIN_ACCOUNT_ROW]);
  await render({
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [{ marketplaceId: 'acme', pluginName: 'team-tools' }],
  });
  expect(summary()).toBe('Tracker needs sign-in');
  expect(badge('Tracker')).toBe('Not signed in');
  expect(connectButton('Tracker')).toBeNull();
  expect(lastReport()).toEqual({
    visible: true,
    setupOpen: false,
    servers: [{ name: 'Tracker', status: 'not_signed_in', pending: false }],
  });
  const open = row('Tracker').querySelector<HTMLButtonElement>(
    '[data-testid="mcp-sign-in-strip-open-settings"]',
  );
  expect(open?.textContent).toBe('Open MCP settings');
  expect(useNavigationStore.getState().settingsOpen).toBe(false);
  act((): void => open?.click());
  expect(useNavigationStore.getState()).toMatchObject({
    settingsOpen: true,
    settingsInitialSection: 'mcp',
  });
  expect(startAccountConnection).not.toHaveBeenCalled();
});

it('signs a server with no connection in under the draft’s configuration', async (): Promise<void> => {
  mockCatalog = { entries: [catalogEntry()], loading: false, error: null };
  inventory.set('linear-device', catalogAccountRow('work'));
  startAccountConnection.mockResolvedValue({
    authorizationUrl: 'https://auth.example.test/authorize',
  });
  awaitAccountConnection.mockReturnValue(new Promise(() => undefined));
  await render(selections('linear-device'));
  await clickConnect('Linear');
  expect(startAccountConnection).toHaveBeenCalledWith({
    serverKey: 'linear',
    configId: 'work',
    expectedAccountId: 'acct-1',
  });
});

/** A catalog server whose connection keeps its own configuration. */
function linearWithConnection(): void {
  const linear = connection({
    id: 'conn-linear',
    serverKey: 'linear',
    configId: 'team',
    displayName: 'Linear',
  });
  connections = [linear];
  inventory.set('linear-device', {
    ...catalogAccountRow('work'),
    accountConnectionId: linear.id,
  });
  mockCatalog = {
    entries: [
      catalogEntry({
        urlOptions: [
          { label: 'Cloud', url: 'https://mcp.linear.example.test/mcp' },
        ],
      }),
    ],
    loading: false,
    error: null,
  };
}

it('holds Connect until the server’s connection loads, then reconnects it under that connection', async (): Promise<void> => {
  linearWithConnection();
  let release: () => void = (): void => undefined;
  listAccountConnections.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = (): void => resolve(connections);
      }),
  );
  startAccountConnection.mockResolvedValue({
    authorizationUrl: 'https://auth.example.test/authorize',
  });
  awaitAccountConnection.mockReturnValue(new Promise(() => undefined));
  await render(selections('linear-device'));
  expect(connectButton('Linear')?.disabled).toBe(true);
  await clickConnect('Linear');
  expect(startAccountConnection).not.toHaveBeenCalled();
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).toBeNull();

  act((): void => release());
  await flush();
  expect(connectButton('Linear')?.disabled).toBe(false);
  await clickConnect('Linear');
  expect(
    document.querySelector('[data-testid="mcp-account-setup"]'),
  ).toBeNull();
  expect(startAccountConnection).toHaveBeenCalledWith({
    serverKey: 'linear',
    configId: 'team',
    expectedAccountId: 'acct-1',
  });
});

it('offers a retry instead of connecting when the connection list fails to load', async (): Promise<void> => {
  linearWithConnection();
  listAccountConnections.mockRejectedValueOnce(new Error('Network down'));
  startAccountConnection.mockResolvedValue({
    authorizationUrl: 'https://auth.example.test/authorize',
  });
  awaitAccountConnection.mockReturnValue(new Promise(() => undefined));
  await render(selections('linear-device'));
  expect(connectButton('Linear')?.disabled).toBe(true);
  await clickConnect('Linear');
  expect(startAccountConnection).not.toHaveBeenCalled();
  const notice = container.querySelector<HTMLElement>(
    '[data-testid="mcp-sign-in-strip-load-error"]',
  );
  expect(notice?.getAttribute('data-notice-intent')).toBe('destructive');
  expect(notice?.textContent).toContain('Couldn’t load sign-in details.');
  const calls = listAccountConnections.mock.calls.length;
  act((): void =>
    notice
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-sign-in-strip-load-retry"]',
      )
      ?.click(),
  );
  await flush();
  expect(listAccountConnections).toHaveBeenCalledTimes(calls + 1);
  expect(mockRefreshCatalog).not.toHaveBeenCalled();
  expect(
    container.querySelector('[data-testid="mcp-sign-in-strip-load-error"]'),
  ).toBeNull();
  await clickConnect('Linear');
  expect(startAccountConnection).toHaveBeenCalledWith({
    serverKey: 'linear',
    configId: 'team',
    expectedAccountId: 'acct-1',
  });
});
