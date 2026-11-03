/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CanopyServerAccountInfo,
} from '@canopy/desktop-shared/types';
import type {
  McpServerData,
  SaveMcpServerRequest,
  McpServerFile,
  McpServerStatusEntry,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
import { McpServerDialog, McpServersTab } from '../McpServersTab';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
jest.mock('@/hooks/useCurrentUiStateReporter', (): object => ({
  useCurrentUiStateReporter: jest.fn(),
}));
jest.mock('@/stores/featureFlagsStore', (): object => ({
  useFeatureFlagsStore: Object.assign((): boolean => true, {
    getState: (): { isEnabled: () => boolean } => ({
      isEnabled: (): boolean => false,
    }),
  }),
}));
jest.mock('../../../hooks/useCuratedMcpServers', (): object => ({
  useCuratedMcpServers: (): object => ({ entries: [] }),
}));
jest.mock('../../shared/DialogModal', (): object => ({
  DialogModal: ({ children }: { children: ReactNode }): JSX.Element => (
    <div>{children}</div>
  ),
}));
const server: McpServerData = {
  definition: {
    id: 'server',
    name: 'Account server',
    description: '',
    type: 'http',
    url: 'https://mcp.example.test',
    createdAt: '',
    updatedAt: '',
  },
  configs: [
    {
      id: 'default',
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
const index: McpServersIndexFile = {
  version: 1,
  servers: [{ ...server.definition, configs: server.configs }],
};
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
const loadServer = jest.fn<Promise<McpServerFile>, [string]>();
const loadIndex = jest.fn<Promise<McpServersIndexFile>, []>();
const saveServer = jest.fn<Promise<McpServerFile>, [SaveMcpServerRequest]>(
  (savedServer): Promise<McpServerFile> =>
    Promise.resolve({ version: 1, server: savedServer }),
);
const loadPreferences = jest.fn<Promise<unknown>, []>();
const loadCanopyCloudAccount = jest.fn<
  Promise<CanopyCloudAccountPublicState>,
  []
>();
const listAccountConnections = jest.fn();
const startOAuthLogin = jest.fn();
const listStatus = jest.fn();
let container: HTMLDivElement;
let root: Root;
function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate): boolean => candidate.textContent === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function update(action: () => void): Promise<void> {
  await act(async (): Promise<void> => {
    action();
    await Promise.resolve();
  });
}
beforeEach((): void => {
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  loadServer.mockResolvedValue({ version: 1, server });
  loadIndex.mockResolvedValue(index);
  saveServer.mockResolvedValue({ version: 1, server });
  loadPreferences.mockResolvedValue({
    mcpHttpAuthDefaultHandler: 'account',
  });
  loadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('acct-1')),
  );
  listAccountConnections.mockResolvedValue([
    {
      id: 'account-1',
      kind: 'CUSTOM',
      serverKey: 'custom',
      configId: 'default',
      displayName: 'Work account',
      status: 'CONNECTED',
      hasExtraHeaders: false,
    },
  ]);
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadPreferences,
      loadCanopyCloudAccount,
    },
  });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    writable: true,
    value: {
      loadServer,
      loadIndex,
      saveServer,
      listAccountConnections,
      startOAuthLogin,
      listStatus,
      onOAuthTokensChanged: (): (() => void) => (): void => undefined,
    },
  });
});
afterEach(async (): Promise<void> => {
  await update((): void => root.unmount());
  container.remove();
});

it.each(['device', 'account'] as const)(
  'omits internal catalog setup instructions from the %s connection dialog',
  async (mode): Promise<void> => {
    const setupInstructions =
      'claude mcp add --transport http datadog "https://mcp.datadoghq.com/v1/mcp?toolsets=all"';
    await update((): void =>
      root.render(
        <McpServerDialog
          serverId={null}
          mode={mode}
          initialCurated={{
            key: 'datadog',
            name: 'Datadog',
            shortDescription: 'Datadog telemetry',
            transport: 'http',
            url: 'https://mcp.datadoghq.com/v1/mcp?toolsets=all',
            categories: [],
            popular: false,
            sortOrder: 0,
            updatedAt: '2026-11-02T00:00:00.000Z',
            setupInstructions,
            urlOptions: [
              {
                label: 'US1',
                url: 'https://mcp.datadoghq.com/v1/mcp?toolsets=all',
              },
            ],
          }}
          onClose={(): void => undefined}
          onSaved={(): Promise<void> => Promise.resolve()}
          onAccountConnect={jest.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('Endpoint');
    expect(container.textContent).not.toContain(setupInstructions);
    expect(
      container.querySelector('[data-testid="mcp-curated-url-option"]'),
    ).not.toBeNull();
  },
);

it('keeps an unbound server on this device when the default is the cloud account', async (): Promise<void> => {
  const startAccountConnection = jest.fn();
  Object.assign(window.mcpServers, { startAccountConnection });
  loadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('acct-1')),
  );
  await update((): void =>
    root.render(
      <McpServerDialog
        serverId="server"
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  expect(scopeChoice()).toBe('device');
  expect(
    container.querySelector('[data-testid="mcp-cloud-placement"]'),
  ).toBeNull();
  // An account default has no connection behind it on this device.
  expect(handlerValue()).toBe('canopy');
  await update((): void => button('Save').click());
  await update((): void => undefined);
  expect(startAccountConnection).not.toHaveBeenCalled();
  expect(saveServer.mock.calls[0]?.[0].definition.httpAuthHandler).toBe(
    'canopy',
  );
});
it.each([
  { authHandler: 'account' },
  { scope: 'account' },
] satisfies Partial<McpServerIndexEntry>[])(
  'shows index-owned account routing from %j',
  async (routing): Promise<void> => {
    loadPreferences.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    loadIndex.mockResolvedValue({
      version: 1,
      servers: [
        {
          ...server.definition,
          configs: server.configs,
          ...routing,
          accountConnectionId: 'account-1',
        },
      ],
    });
    await update((): void =>
      root.render(
        <McpServerDialog
          serverId="server"
          onClose={(): void => undefined}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      ),
    );
    expect(scopeChoice()).toBe('cloud');
    expect(
      container.querySelector('[data-testid="mcp-server-auth-handler"]'),
    ).toBeNull();
    await update((): void => button('Save').click());
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({ accountConnectionId: 'account-1' }),
    );
    expect(saveServer.mock.calls[0]?.[0]).not.toHaveProperty('accountRouting');
  },
);

function scopeChoice(): string | undefined {
  return container
    .querySelector('[data-testid="mcp-server-scope"] [aria-checked="true"]')
    ?.getAttribute('data-testid')
    ?.replace('mcp-server-scope-', '');
}

function scopeButton(scope: 'device' | 'cloud'): HTMLButtonElement {
  const found = container.querySelector(
    `[data-testid="mcp-server-scope-${scope}"]`,
  );
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`Missing scope: ${scope}`);
  return found;
}

const HANDLER_LABELS: Record<string, string> = {
  '': 'Use default',
  canopy: `${brandText.appName} proxy`,
  provider: 'Agent provider',
};

function handlerSelect(): HTMLButtonElement {
  const select = container.querySelector(
    '[data-testid="mcp-server-auth-handler"]',
  );
  if (!(select instanceof HTMLButtonElement))
    throw new Error('Missing handler selector');
  return select;
}

/** The chosen handling, read from the label the dropdown shows. */
function handlerValue(): string | undefined {
  const label = handlerSelect().textContent;
  return Object.keys(HANDLER_LABELS).find(
    (value) => HANDLER_LABELS[value] === label,
  );
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

it.each(['account', 'provider', 'canopy'] as const)(
  'preserves definition-owned %s routing ahead of the index',
  async (httpAuthHandler): Promise<void> => {
    loadPreferences.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    loadServer.mockResolvedValue({
      version: 1,
      server: {
        ...server,
        definition: { ...server.definition, httpAuthHandler },
      },
    });
    loadIndex.mockResolvedValue({
      version: 1,
      servers: [
        {
          ...server.definition,
          configs: server.configs,
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: 'account-1',
        },
      ],
    });
    await update((): void =>
      root.render(
        <McpServerDialog
          serverId="server"
          onClose={(): void => undefined}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      ),
    );
    if (httpAuthHandler === 'account') expect(scopeChoice()).toBe('cloud');
    else expect(handlerValue()).toBe(httpAuthHandler);
    await update((): void => button('Save').click());
    expect(saveServer.mock.calls[0]?.[0].definition.httpAuthHandler).toBe(
      httpAuthHandler,
    );
    expect(saveServer.mock.calls[0]?.[0]).not.toHaveProperty('accountRouting');
  },
);

it.each(['', 'provider', 'canopy'])(
  'moves an index-bound server to this device with %s',
  async (choice): Promise<void> => {
    const rewriteServerRefs = jest.fn().mockResolvedValue({
      globalDefaults: false,
      workspaces: 0,
      chats: 0,
    });
    const removeAccountConnection = jest
      .fn()
      .mockResolvedValue({ removed: true });
    Object.assign(window.mcpServers, {
      rewriteServerRefs,
      removeAccountConnection,
    });
    loadPreferences.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    loadIndex.mockResolvedValue({
      version: 1,
      servers: [
        {
          ...server.definition,
          configs: server.configs,
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: 'account-1',
        },
      ],
    });
    await update((): void =>
      root.render(
        <McpServerDialog
          serverId="server"
          onClose={(): void => undefined}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      ),
    );
    expect(scopeChoice()).toBe('cloud');
    await update((): void => scopeButton('device').click());
    chooseSelectOption(handlerSelect(), HANDLER_LABELS[choice] ?? choice);
    await update((): void => undefined);
    await update((): void => button('Save').click());
    expect(saveServer).not.toHaveBeenCalled();
    await update((): void => button('Move to this device').click());
    await update((): void => undefined);
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({ accountRouting: 'clear' }),
    );
    expect(saveServer.mock.calls[0]?.[0].definition.httpAuthHandler).toBe(
      choice || undefined,
    );
    expect(rewriteServerRefs).toHaveBeenCalledWith({
      from: [
        { serverId: 'custom', configId: 'default' },
        { serverId: 'account:account-1', configId: 'default' },
      ],
      to: { serverId: 'server', configId: 'default' },
    });
    expect(removeAccountConnection).toHaveBeenCalledWith('account-1');
  },
);

it('does not clear routing on an unrelated editor save', async (): Promise<void> => {
  loadPreferences.mockResolvedValue({
    mcpHttpAuthDefaultHandler: 'canopy',
  });
  await update((): void =>
    root.render(
      <McpServerDialog
        serverId="server"
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  await update((): void => button('Save').click());
  expect(saveServer).toHaveBeenCalledTimes(1);
  expect(saveServer.mock.calls[0]?.[0]).not.toHaveProperty('accountRouting');
});

it.each(['not_connected', 'error'] as const)(
  'opens cloud account settings for %s instead of local OAuth',
  async (authStatus): Promise<void> => {
    const status: McpServerStatusEntry = {
      serverId: 'server',
      transport: 'http',
      handler: 'account',
      connectionStatus: 'auth_required',
      reachability: 'unknown',
      configs: [{ configId: 'default', authStatus }],
    };
    listStatus.mockResolvedValue([status]);
    const openSettings = jest.spyOn(
      useNavigationStore.getState(),
      'openSettings',
    );
    await update((): void => root.render(<McpServersTab />));
    await update((): void =>
      button(
        authStatus === 'error' ? 'Reconnect in cloud' : 'Connect in cloud',
      ).click(),
    );
    expect(openSettings).toHaveBeenCalledWith('account');
    expect(startOAuthLogin).not.toHaveBeenCalled();
    openSettings.mockRestore();
  },
);
it('surfaces a rejected local OAuth attempt', async (): Promise<void> => {
  listStatus.mockResolvedValue([
    {
      serverId: 'server',
      transport: 'http',
      handler: 'canopy',
      connectionStatus: 'auth_required',
      reachability: 'unknown',
      configs: [],
    },
  ]);
  startOAuthLogin.mockRejectedValue(
    new Error('Account connections require cloud authorization.'),
  );
  await update((): void => root.render(<McpServersTab />));
  await update((): void => button('Connect').click());
  expect(container.textContent).toContain(
    'Account connections require cloud authorization.',
  );
});
it.each([
  ['completed', 'Account server is already connected.'],
  ['started', null],
] as const)(
  'reports a %s local sign-in on the row',
  async (status, message): Promise<void> => {
    listStatus.mockResolvedValue([
      {
        serverId: 'server',
        transport: 'http',
        handler: 'canopy',
        connectionStatus: 'auth_required',
        reachability: 'unknown',
        configs: [],
      },
    ]);
    startOAuthLogin.mockResolvedValue({ status });
    await update((): void => root.render(<McpServersTab />));
    await update((): void => button('Connect').click());
    const notice = container.querySelector(
      '[data-testid="mcp-connect-notice"]',
    );
    if (message === null) expect(notice).toBeNull();
    else expect(notice?.textContent).toContain(message);
  },
);

it('defaults new custom servers to HTTP and still lets users choose Command', async (): Promise<void> => {
  await update((): void =>
    root.render(
      <McpServerDialog
        serverId={null}
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  expect(button('HTTP').getAttribute('aria-pressed')).toBe('true');
  expect(
    container.querySelector('input[placeholder="https://mcp.example.com/sse"]'),
  ).not.toBeNull();
  await update((): void => button('Command').click());
  expect(container.querySelector('input[placeholder="npx"]')).not.toBeNull();
});

it('turns on Use OAuth when its text is clicked', async (): Promise<void> => {
  await update((): void =>
    root.render(
      <McpServerDialog
        serverId={null}
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[data-testid="mcp-server-use-oauth"]',
  );
  expect(checkbox?.type).toBe('checkbox');
  expect(checkbox?.checked).toBe(false);
  const text = Array.from(container.querySelectorAll('span')).find(
    (span) => span.textContent === 'Use OAuth',
  );
  if (!text) throw new Error('Missing Use OAuth text');
  await update((): void => text.click());
  expect(checkbox?.checked).toBe(true);
});

it('preserves Command when editing an existing command server', async (): Promise<void> => {
  loadServer.mockResolvedValue({
    version: 1,
    server: {
      ...server,
      definition: { ...server.definition, type: 'command', command: 'npx' },
    },
  });
  await update((): void =>
    root.render(
      <McpServerDialog
        serverId="server"
        onClose={(): void => undefined}
        onSaved={(): Promise<void> => Promise.resolve()}
      />,
    ),
  );
  expect(button('Command').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('input[placeholder="npx"]')).not.toBeNull();
});

it('opens the explicit move entry once and preserves unrelated saved fields (CAN-4265)', async () => {
  const onSaved = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  loadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('account')),
  );
  Object.assign(window.mcpServers, {
    rewriteServerRefs: jest.fn().mockResolvedValue({}),
    removeAccountConnection: jest.fn().mockResolvedValue({ removed: true }),
  });
  loadIndex.mockResolvedValue({
    version: 1,
    servers: [
      {
        ...server.definition,
        configs: server.configs,
        scope: 'account',
        authHandler: 'account',
        accountConnectionId: 'account-1',
      },
    ],
  });
  await update(() =>
    root.render(
      <McpServerDialog
        serverId="server"
        entryAction="move-to-device"
        onSaved={onSaved}
        onClose={onClose}
      />,
    ),
  );
  await update(() => undefined);
  await update(() => undefined);
  expect(button('Move to this device')).toBeDefined();
  expect(saveServer).not.toHaveBeenCalled();
  await update(() => button('Move to this device').click());
  expect(saveServer).toHaveBeenCalledTimes(1);
  expect(saveServer.mock.calls[0]?.[0].definition.name).toBe(
    server.definition.name,
  );
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('waits for auth preferences before the explicit move confirmation (CAN-4265)', async () => {
  let resolvePreferences: ((value: unknown) => void) | undefined;
  loadPreferences.mockImplementationOnce(
    () =>
      new Promise<unknown>((resolve): void => {
        resolvePreferences = resolve;
      }),
  );
  loadCanopyCloudAccount.mockResolvedValue(
    cloudAccountState(true, accountInfo('account')),
  );
  loadIndex.mockResolvedValue({
    version: 1,
    servers: [
      {
        ...server.definition,
        configs: server.configs,
        scope: 'account',
        authHandler: 'account',
        accountConnectionId: 'account-1',
      },
    ],
  });
  await update(() =>
    root.render(
      <McpServerDialog
        serverId="server"
        entryAction="move-to-device"
        onSaved={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    ),
  );
  await update(() => undefined);
  await update(() => undefined);
  expect(saveServer).not.toHaveBeenCalled();
  await update(() =>
    resolvePreferences?.({ mcpHttpAuthDefaultHandler: 'canopy' }),
  );
  expect(button('Move to this device')).toBeDefined();
});
