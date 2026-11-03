/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BuiltInPluginInstallStatus,
  MarketplaceInfo,
  PluginDetails,
  PluginInfo,
  PluginProviderFacet,
} from '@canopy/desktop-shared/types/plugins';

let mockClaudeAuthenticated = true;
jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): { authenticated: boolean } => ({
    authenticated: mockClaudeAuthenticated,
  }),
}));
let mockCodexAuthenticated = false;
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): { authenticated: boolean } => ({
    authenticated: mockCodexAuthenticated,
  }),
}));
let mockCursorAvailable = false;
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => mockCursorAvailable,
}));

jest.mock('@canopy/ui-app', () => ({
  MarkdownFrontmatterContent: (): null => null,
}));

jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): object => ({
    requestShare: (_copy: unknown, onAllowed: () => void): void => onAllowed(),
    shareGateModal: null,
  }),
}));

jest.mock('@/components/plugins/SharePluginModal', () => ({
  SharePluginModal: ({ name }: { name: string }): JSX.Element => (
    <div data-testid="share-modal-name">{name}</div>
  ),
}));

import { PluginDetailView } from '../PluginDetailView';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { marketplaceSourceOperations } from '@/hooks/useMarketplaceList';

const externalPluginSource: NonNullable<PluginInfo['externalSource']> = {
  source: 'github',
  url: 'https://example.test/plugin.git',
};

function makeFacet(
  overrides: Partial<PluginProviderFacet> = {},
): PluginProviderFacet {
  return {
    provider: 'claude',
    mode: 'native',
    name: 'My Plugin',
    description: 'Claude facet description',
    version: '1.0.0',
    installLocation: '/tmp/mkt',
    sourcePath: 'plugins/my-plugin',
    ...overrides,
  };
}

function makeDetails(overrides: Partial<PluginDetails> = {}): PluginDetails {
  return {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
    ...overrides,
  };
}

function makePlugin(facets: PluginInfo['facets']): PluginInfo {
  const claudeName = facets.claude?.name;
  const codexName = facets.codex?.name ?? facets.codexCompatibility?.name;
  const name = claudeName ?? codexName ?? 'My Plugin';
  return {
    name,
    description: 'Top-level merged description',
    sourcePath: 'plugins/my-plugin',
    marketplaceId: 'mkt-1',
    providerSupport: {
      claude: facets.claude ? 'native' : 'none',
      codex: facets.codex
        ? 'native'
        : facets.codexCompatibility
          ? 'compat'
          : 'none',
    },
    facets,
  };
}

function makeMarketplace(): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Acme Plugins',
    sourceType: 'github',
    sourceUrl: 'acme/plugins',
    installLocation: '/tmp/mkt',
    pluginCount: 1,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'],
  };
}

function requireButton(node: Element | null, label: string): HTMLButtonElement {
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`${label} not found or not a button`);
  }
  return node;
}

function makeBuiltInStatus(
  overrides: Partial<BuiltInPluginInstallStatus> = {},
): BuiltInPluginInstallStatus {
  return {
    claude: { available: true, installed: false },
    codex: { available: true, installed: false },
    checkedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBuiltInPlugin(
  status: BuiltInPluginInstallStatus,
  facets: PluginInfo['facets'] = {
    claude: makeFacet({
      provider: 'claude',
      mode: 'native',
      details: makeDetails(),
    }),
    codex: makeFacet({
      provider: 'codex',
      mode: 'native',
      details: makeDetails(),
    }),
  },
): PluginInfo {
  return {
    ...makePlugin(facets),
    name: 'Built-in Plugin',
    builtIn: true,
    globalInstallStatus: status,
  };
}

function makeCuratedPlugin(
  status: BuiltInPluginInstallStatus,
  facets: PluginInfo['facets'] = {
    claude: makeFacet({
      provider: 'claude',
      mode: 'native',
      details: makeDetails(),
    }),
    codex: makeFacet({
      provider: 'codex',
      mode: 'native',
      details: makeDetails(),
    }),
  },
): PluginInfo {
  return {
    ...makePlugin(facets),
    name: 'Curated Plugin',
    marketplaceId: 'curated/cloud',
    curated: true,
    globalInstallStatus: status,
  };
}

describe('PluginDetailView provider toggle', () => {
  let container: HTMLElement;
  let root: Root;
  let pluginsApi: {
    installPlugin: jest.Mock;
    prepareCodexCompatibilityPlugin: jest.Mock;
    setCodexCompatDisabled: jest.Mock;
    readComponentContent: jest.Mock;
    installBuiltInPlugin: jest.Mock;
  };
  const originalPlugins = (window as unknown as Record<string, unknown>)
    .plugins;
  const originalMcpServers = Reflect.get(window, 'mcpServers');
  let mcpServersApi: {
    loadIndex: jest.Mock;
    listStatus: jest.Mock;
    testConnection: jest.Mock;
    onAuthChanged: jest.Mock;
  };

  beforeEach(() => {
    mockClaudeAuthenticated = true;
    mockCodexAuthenticated = false;
    mockCursorAvailable = false;
    // Protocol defaults: Cursor and OpenCode on, Copilot off.
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pluginsApi = {
      installPlugin: jest.fn(),
      prepareCodexCompatibilityPlugin: jest.fn().mockResolvedValue({
        success: true,
        data: makePlugin({ claude: makeFacet({ details: makeDetails() }) }),
      }),
      setCodexCompatDisabled: jest.fn().mockResolvedValue({
        success: true,
        data: makePlugin({ claude: makeFacet({ details: makeDetails() }) }),
      }),
      readComponentContent: jest.fn().mockResolvedValue({
        success: true,
        data: { frontmatter: {}, body: 'component body' },
      }),
      installBuiltInPlugin: jest.fn(),
    };
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: pluginsApi,
    });
    mcpServersApi = {
      loadIndex: jest.fn().mockResolvedValue({
        version: 1,
        servers: [
          {
            id: 'srv-slack',
            name: 'slack-mcp',
            description: '',
            type: 'http',
            configs: [{ id: 'cfg-1', name: 'Default' }],
          },
        ],
      }),
      listStatus: jest.fn().mockResolvedValue([]),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
      onAuthChanged: jest.fn(() => (): void => undefined),
    };
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: mcpServersApi,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalMcpServers === undefined) {
      Reflect.deleteProperty(window, 'mcpServers');
    } else {
      Object.defineProperty(window, 'mcpServers', {
        configurable: true,
        value: originalMcpServers,
      });
    }
    if (originalPlugins === undefined) {
      Reflect.deleteProperty(window, 'plugins');
    } else {
      Object.defineProperty(window, 'plugins', {
        configurable: true,
        value: originalPlugins,
      });
    }
  });

  function renderView(plugin: PluginInfo): void {
    act(() => {
      root.render(
        <PluginDetailView
          plugin={plugin}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={(): void => undefined}
        />,
      );
    });
  }

  it('does not auto-install while a source-view install owns the source', async () => {
    const release = marketplaceSourceOperations.acquire('mkt-1', 'install');
    if (!release) throw new Error('source unexpectedly busy');
    pluginsApi.installPlugin.mockResolvedValue({
      success: false,
      error: 'Unexpected duplicate',
    });
    try {
      const plugin = {
        ...makePlugin({}),
        externalSource: externalPluginSource,
      };
      await act(async () => {
        root.render(
          <PluginDetailView
            plugin={plugin}
            marketplace={makeMarketplace()}
            autoInstall
            onBack={() => undefined}
            onPluginUpdated={() => undefined}
          />,
        );
        await Promise.resolve();
      });
      expect(pluginsApi.installPlugin).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('shows installed details after automatic installation completes while mounted', async () => {
    const plugin = {
      ...makePlugin({}),
      externalSource: externalPluginSource,
    };
    const installed = { ...plugin, details: makeDetails() };
    let finish: (result: {
      success: boolean;
      data: PluginInfo;
    }) => void = () => {
      throw new Error('uninitialized');
    };
    pluginsApi.installPlugin.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    function InstalledDetails(): JSX.Element {
      const [current, setCurrent] = useState<PluginInfo>(plugin);
      return (
        <PluginDetailView
          plugin={current}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={setCurrent}
          autoInstall
        />
      );
    }
    await act(async () => {
      root.render(<InstalledDetails />);
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="plugin-detail-loading"]'),
    ).not.toBeNull();
    await act(async () => {
      finish({ success: true, data: installed });
      // Let the full IPC promise chain settle before act flushes the parent update.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('[data-testid="plugin-detail-loading"]'),
    ).toBeNull();
  });

  it('shows an automatic install failure', async () => {
    const plugin = {
      ...makePlugin({}),
      externalSource: externalPluginSource,
    };
    pluginsApi.installPlugin.mockResolvedValue({
      success: false,
      error: 'Clone failed in /Users/me/.canopy/plugins/private',
    });
    await act(async () => {
      root.render(
        <PluginDetailView
          plugin={plugin}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={(): void => undefined}
          autoInstall
        />,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const errorLeaf = Array.from(container.querySelectorAll('*')).find(
      (el) =>
        el.childElementCount === 0 &&
        el.textContent === 'Clone failed in /Users/me/.canopy/plugins/private',
    );
    expect(errorLeaf).toBeDefined();
  });

  it('propagates a successful automatic install after leaving details', async () => {
    const plugin = {
      ...makePlugin({}),
      externalSource: externalPluginSource,
    };
    const installed = { ...plugin, details: makeDetails() };
    let finishInstall: (result: {
      success: boolean;
      data: PluginInfo;
    }) => void = () => {
      throw new Error('Install resolver was not initialized');
    };
    pluginsApi.installPlugin.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
    );
    const onPluginUpdated = jest.fn();
    await act(async () => {
      root.render(
        <PluginDetailView
          plugin={plugin}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={onPluginUpdated}
          autoInstall
        />,
      );
      await Promise.resolve();
    });
    expect(pluginsApi.installPlugin).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    await act(async () => {
      finishInstall({ success: true, data: installed });
      await Promise.resolve();
    });
    expect(onPluginUpdated).toHaveBeenCalledTimes(1);
    expect(onPluginUpdated).toHaveBeenCalledWith(installed);
  });

  it.each([
    [undefined, 'Alpha Tool'],
    ['dbt labs', 'dbt labs'],
  ])('shares the display label %p', (displayName, expected): void => {
    renderView({
      ...makePlugin({
        claude: makeFacet({ name: 'alpha-tool', details: makeDetails() }),
      }),
      displayName,
    });
    const shareButton = requireButton(
      container.querySelector('[data-testid="plugin-detail-share"]'),
      'Share plugin',
    );
    act((): void => shareButton.click());
    expect(
      container.querySelector('[data-testid="share-modal-name"]')?.textContent,
    ).toBe(expected);
  });

  // A Cursor session reads the Claude facet when there is one, else the
  // native Codex facet, and loads that facet's MCP servers, skills, and (from
  // a Claude facet) commands. Hooks and agents never load, so a facet with
  // only those is not supported. `null` means the facet does not exist.
  it.each([
    ['claude-mcp', 'mcp', null, true, false, 'Installed'],
    ['claude-mcp-not-installed', 'mcp', null, false, true, 'Not installed'],
    ['claude-skills', 'skills', null, true, false, 'Installed'],
    ['claude-commands', 'commands', null, true, false, 'Installed'],
    ['claude-hooks-and-agents', 'hooks', null, true, false, 'Not supported'],
    [
      'claude-empty-over-codex-skills',
      'none',
      'skills',
      true,
      true,
      'Not supported',
    ],
    ['codex-mcp', null, 'mcp', false, true, 'Installed'],
    ['codex-skills', null, 'skills', false, true, 'Installed'],
    ['codex-commands', null, 'commands', false, true, 'Not supported'],
    ['codex-empty', null, 'none', false, true, 'Not supported'],
  ] as const)(
    'derives Cursor from the facet it loads: %s',
    (
      kind,
      claudeMembers,
      codexMembers,
      claudeInstalled,
      codexInstalled,
      expected,
    ) => {
      mockCursorAvailable = true;
      const memberDetails: Record<
        'mcp' | 'skills' | 'commands' | 'hooks' | 'none',
        Partial<PluginDetails>
      > = {
        mcp: {
          mcpServers: [{ name: 'test', type: 'command', command: 'test-mcp' }],
        },
        skills: {
          skills: [
            {
              name: 'triage',
              description: 'Triage issues',
              path: 'skills/triage',
            },
          ],
        },
        commands: {
          commands: [
            {
              name: 'ship',
              description: 'Ship it',
              filePath: 'commands/ship.md',
            },
          ],
        },
        hooks: {
          hooks: [{ event: 'PreToolUse', hookType: 'command' }],
          agents: [
            {
              name: 'reviewer',
              description: 'Reviews',
              filePath: 'agents/reviewer.md',
            },
          ],
        },
        none: {},
      };
      const detailsFor = (
        members: 'mcp' | 'skills' | 'commands' | 'hooks' | 'none',
      ): PluginDetails => makeDetails(memberDetails[members]);
      const plugin = makePlugin({
        ...(claudeMembers === null
          ? {}
          : { claude: makeFacet({ details: detailsFor(claudeMembers) }) }),
        ...(codexMembers === null
          ? {}
          : {
              codex: makeFacet({
                provider: 'codex',
                details: detailsFor(codexMembers),
              }),
            }),
      });
      // The Codex compatibility switch changes the Codex row only.
      plugin.codexCompatDisabled =
        kind === 'claude-mcp' || kind === 'codex-mcp';
      plugin.globalInstallStatus = makeBuiltInStatus({
        claude: { available: true, installed: claudeInstalled },
        codex: { available: true, installed: codexInstalled },
      });
      renderView(plugin);
      expect(
        container.querySelector('[data-testid="plugin-harness-cursor"] td')
          ?.textContent,
      ).toBe(expected);
    },
  );

  function harnessRows(): Array<[string | null, string | null]> {
    return Array.from(
      container.querySelectorAll(
        '[data-testid="plugin-harness-connections"] tbody tr',
      ),
    ).map((row) => [
      row.querySelector('th')?.textContent ?? null,
      row.querySelector('td')?.textContent ?? null,
    ]);
  }

  it('lists every harness regardless of sign-in without listing the app as a harness', () => {
    mockClaudeAuthenticated = false;
    mockCodexAuthenticated = false;
    mockCursorAvailable = false;
    renderView(
      makePlugin({
        claude: makeFacet({
          details: makeDetails({
            skills: [
              { name: 'triage', description: 'Triage', path: 'skills/t' },
            ],
          }),
        }),
      }),
    );
    const table = container.querySelector(
      '[data-testid="plugin-harness-connections"] table',
    );
    expect(table).not.toBeNull();
    expect(
      Array.from(table?.querySelectorAll('thead th') ?? []).map(
        (cell) => cell.textContent,
      ),
    ).toEqual(['Harness', 'Installation']);
    // The app is where the plugin is added, not a harness it installs into.
    // Copilot's harness gate is off by default, so it gets no row.
    expect(harnessRows()).toEqual([
      ['Claude', 'Installed'],
      ['Codex', 'Not supported'],
      ['Cursor', 'Installed'],
      ['OpenCode', 'Installed'],
    ]);
    expect(
      container.querySelector('[data-testid="plugin-harness-app"]'),
    ).toBeNull();
    const status = container.querySelector(
      '[data-testid="plugin-harness-claude"] td',
    );
    expect(status?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(status?.classList.contains('fg-success')).toBe(true);
  });

  it('shows a Codex-only plugin as installed for Codex and not supported elsewhere', () => {
    // No provider reported an install, which is the common case for plugins
    // from openai-curated, claude-plugins-official and user-added sources.
    mockClaudeAuthenticated = false;
    renderView(
      makePlugin({
        codex: makeFacet({ provider: 'codex', details: makeDetails() }),
      }),
    );
    expect(harnessRows()).toEqual([
      ['Claude', 'Not supported'],
      ['Codex', 'Installed'],
      ['Cursor', 'Not supported'],
      ['OpenCode', 'Not supported'],
    ]);
  });

  it('lists only the harnesses whose gates are on (CAN-4842)', () => {
    const defaults = getDefaultFeatureFlagSnapshot();
    const withGates = (gates: {
      cursor: boolean;
      copilot: boolean;
      opencode: boolean;
    }): void => {
      act(() => {
        useFeatureFlagsStore.setState({
          snapshot: {
            ...defaults,
            values: {
              ...defaults.values,
              [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]:
                gates.cursor,
              [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]:
                gates.copilot,
              [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]:
                gates.opencode,
            },
          },
        });
      });
    };
    renderView(
      makePlugin({
        codex: makeFacet({ provider: 'codex', details: makeDetails() }),
      }),
    );
    withGates({ cursor: true, copilot: true, opencode: true });
    expect(harnessRows().map(([name]) => name)).toEqual([
      'Claude',
      'Codex',
      'Cursor',
      'Copilot',
      'OpenCode',
    ]);
    withGates({ cursor: false, copilot: false, opencode: false });
    expect(harnessRows().map(([name]) => name)).toEqual(['Claude', 'Codex']);
  });

  it('shows no harness table while the plugin still needs installing', () => {
    renderView({
      ...makePlugin({ claude: makeFacet() }),
      externalSource: {
        source: 'github',
        url: 'https://github.com/acme/plugin',
      },
    });
    expect(
      container.querySelector('[data-testid="plugin-harness-connections"]'),
    ).toBeNull();
  });

  it('renders statusContent between the title and the harness table (CAN-4842)', () => {
    act(() => {
      root.render(
        <PluginDetailView
          plugin={makePlugin({ claude: makeFacet({ details: makeDetails() }) })}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={(): void => undefined}
          statusContent={<div data-testid="t-status" />}
        />,
      );
    });
    const title = container.querySelector('#plugin-detail-title');
    const status = container.querySelector('[data-testid="t-status"]');
    const harness = container.querySelector(
      '[data-testid="plugin-harness-connections"]',
    );
    expect(title && status && harness).toBeTruthy();
    expect(
      (title?.compareDocumentPosition(status as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (status?.compareDocumentPosition(harness as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows MCP health with Test connection for a configured bundled server (CAN-4842)', async () => {
    const plugin = makePlugin({
      claude: makeFacet({
        details: makeDetails({
          mcpServers: [
            {
              name: 'slack-mcp',
              type: 'http',
              url: 'https://mcp.slack.com/mcp',
            },
          ],
        }),
      }),
    });
    const render = (
      bundledServerRows?: Parameters<
        typeof PluginDetailView
      >[0]['bundledServerRows'],
    ): void => {
      act(() => {
        root.render(
          <PluginDetailView
            plugin={plugin}
            marketplace={makeMarketplace()}
            onBack={(): void => undefined}
            onPluginUpdated={(): void => undefined}
            bundledServerRows={bundledServerRows}
          />,
        );
      });
    };
    render();
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-mcp-status-unavailable"]',
      )?.textContent,
    ).toBe('Not configured yet');
    expect(mcpServersApi.loadIndex).not.toHaveBeenCalled();

    render([
      {
        serverName: 'slack-mcp',
        endpoint: 'http:mcp.slack.com',
        entryId: 'entry-slack',
        serverId: 'srv-slack',
      },
    ]);
    await act(async () => {
      await Promise.resolve();
    });
    const test = container.querySelector('[data-testid="mcp-health-test"]');
    expect(test).not.toBeNull();
    await act(async () => {
      if (test instanceof HTMLElement) test.click();
      await Promise.resolve();
    });
    expect(mcpServersApi.testConnection).toHaveBeenCalledWith(
      'srv-slack',
      'cfg-1',
    );
  });

  it('offers no sign-in for an installed plugin; its servers sign in from a chat', () => {
    renderView(
      makePlugin({
        claude: makeFacet({
          details: makeDetails({
            mcpServers: [
              { name: 'test', type: 'http', url: 'https://mcp.test/mcp' },
            ],
          }),
        }),
      }),
    );
    expect(
      container.querySelector('[data-testid="plugin-harness-connections"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-account-connection"]'),
    ).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).map(
        (button) => button.textContent,
      ),
    ).not.toContain('Connect');
  });

  it('does NOT render the toggle when the plugin has only one renderable facet', () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        name: 'Solo Plugin',
        details: makeDetails(),
      }),
    });
    renderView(plugin);
    expect(
      container.querySelector('[data-testid="plugin-detail-provider-toggle"]'),
    ).toBeNull();
  });

  it('renders a display name without replacing the provider identity', () => {
    const plugin = {
      ...makePlugin({
        claude: makeFacet({ name: 'writer-toolkit', details: makeDetails() }),
      }),
      displayName: 'Writer Toolkit',
    };

    renderView(plugin);

    expect(container.textContent).toContain('Writer Toolkit');
    expect(plugin.name).toBe('writer-toolkit');
    expect(
      Array.from(container.querySelectorAll('h1, h2')).filter(
        (heading) => heading.textContent === 'Writer Toolkit',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="plugin-detail-back"]'),
    ).toHaveLength(1);
  });

  it('renders the toggle and switches metadata when both facets exist', () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        name: 'Plugin Claude',
        version: '1.0.0',
        description: 'Claude facet description',
        details: makeDetails(),
      }),
      codex: makeFacet({
        provider: 'codex',
        mode: 'native',
        name: 'Plugin Codex',
        version: '2.0.0',
        description: 'Codex facet description',
        details: makeDetails(),
      }),
    });
    renderView(plugin);

    expect(
      container.querySelector('[data-testid="plugin-detail-provider-toggle"]'),
    ).not.toBeNull();
    // The switch sits at the top of the content it changes, not in the
    // chrome row, which holds page actions only.
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-provider-toggle-row"] [data-testid="plugin-detail-provider-toggle"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-chrome"] [data-testid="plugin-detail-provider-toggle"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain('Plugin Claude');
    expect(container.textContent).toContain('1.0.0');

    const codexButton = requireButton(
      container.querySelector('[data-testid="plugin-detail-toggle-codex"]'),
      'Codex toggle',
    );
    act(() => {
      codexButton.click();
    });
    expect(container.textContent).toContain('Plugin Codex');
    expect(container.textContent).toContain('2.0.0');
  });

  it('renders the amber compatibility badge when only the compat facet exists for Codex', () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        name: 'Compat Plugin Claude',
        details: makeDetails(),
      }),
      codexCompatibility: makeFacet({
        provider: 'codex',
        mode: 'compat',
        name: 'Compat Plugin Codex',
        details: makeDetails(),
      }),
    });
    renderView(plugin);

    const codexButton = requireButton(
      container.querySelector('[data-testid="plugin-detail-toggle-codex"]'),
      'Codex toggle',
    );
    act(() => {
      codexButton.click();
    });
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-codex-compat-badge"]',
      ),
    ).not.toBeNull();
  });

  it('shows the empty-state copy when the active facet has no components', () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        details: makeDetails(),
      }),
      codex: makeFacet({
        provider: 'codex',
        mode: 'native',
        details: makeDetails(),
      }),
    });
    renderView(plugin);
    expect(container.textContent).toContain(
      'No components found for this provider.',
    );
  });

  it('does not prepare Codex compatibility for an uninstalled external plugin', async () => {
    const plugin = {
      ...makePlugin({
        claude: makeFacet({
          provider: 'claude',
          mode: 'native',
          name: 'External Plugin',
          installLocation: '',
          sourcePath: '',
          externalSource: {
            source: 'github',
            url: 'https://github.com/acme/external-plugin',
          },
        }),
      }),
      externalSource: {
        source: 'github',
        url: 'https://github.com/acme/external-plugin',
      },
    };

    renderView(plugin);
    await act(async () => {
      await Promise.resolve();
    });

    expect(pluginsApi.prepareCodexCompatibilityPlugin).not.toHaveBeenCalled();
    // Install is the primary action in the detail's top-right action bar.
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-chrome"] [data-testid="plugin-detail-install"]',
      )?.textContent,
    ).toBe('Install');
  });

  it('reads component content from the active provider facet root', async () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        name: 'Plugin Claude',
        installLocation: '/tmp/mkt/plugins/shared',
        sourcePath: 'plugins/shared',
        details: makeDetails({
          skills: [
            {
              name: 'Claude Skill',
              description: 'Claude-only instructions',
              path: 'skills/claude-skill',
            },
          ],
        }),
      }),
      codex: makeFacet({
        provider: 'codex',
        mode: 'native',
        name: 'Plugin Codex',
        installLocation: '/tmp/codex/shared',
        sourcePath: '/tmp/codex/shared',
        details: makeDetails({
          skills: [
            {
              name: 'Codex Skill',
              description: 'Codex-native instructions',
              path: 'skills/codex-skill',
            },
          ],
        }),
      }),
    });
    renderView(plugin);

    const findButton = (label: string): HTMLButtonElement =>
      requireButton(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === label,
        ) ?? null,
        label,
      );

    await act(async () => {
      findButton('Claude Skill').click();
      await Promise.resolve();
    });

    expect(pluginsApi.readComponentContent).toHaveBeenLastCalledWith(
      '/tmp/mkt/plugins/shared',
      '',
      'skills/claude-skill/SKILL.md',
    );

    act(() => {
      findButton('Back').click();
    });
    act(() => {
      findButton('Codex').click();
    });
    await act(async () => {
      findButton('Codex Skill').click();
      await Promise.resolve();
    });

    expect(pluginsApi.readComponentContent).toHaveBeenLastCalledWith(
      '/tmp/codex/shared',
      '',
      'skills/codex-skill/SKILL.md',
    );
  });

  // A real compat-capable plugin exposes a Claude facet with no native Codex
  // facet, and the backend marks `providerSupport.codex === 'compat'`.
  function makeCompatCapablePlugin(
    overrides: Partial<PluginInfo> = {},
  ): PluginInfo {
    const base = makePlugin({ claude: makeFacet({ details: makeDetails() }) });
    return {
      ...base,
      providerSupport: { ...base.providerSupport, codex: 'compat' },
      ...overrides,
    };
  }

  describe('codex compat disable toggle', () => {
    it('shows the disable toggle only for compat-capable plugins', () => {
      const compatPlugin = makeCompatCapablePlugin();
      renderView(compatPlugin);
      expect(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
        ),
      ).not.toBeNull();
    });

    it('hides the toggle for plugins with a native Codex facet', () => {
      const nativePlugin = makePlugin({
        claude: makeFacet({ details: makeDetails() }),
        codex: makeFacet({
          provider: 'codex',
          mode: 'native',
          details: makeDetails(),
        }),
      });
      renderView(nativePlugin);
      expect(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
        ),
      ).toBeNull();
    });

    it('calls setCodexCompatDisabled and propagates the update on toggle', async () => {
      const compatPlugin = makeCompatCapablePlugin();
      const updated: PluginInfo = {
        ...compatPlugin,
        codexCompatDisabled: true,
      };
      pluginsApi.setCodexCompatDisabled.mockResolvedValue({
        success: true,
        data: updated,
      });
      const onPluginUpdated = jest.fn();
      act(() => {
        root.render(
          <PluginDetailView
            plugin={compatPlugin}
            marketplace={makeMarketplace()}
            onBack={(): void => undefined}
            onPluginUpdated={onPluginUpdated}
          />,
        );
      });
      const toggle = requireButton(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
        ),
        'compat disable toggle',
      );
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      expect(pluginsApi.setCodexCompatDisabled).toHaveBeenCalledWith(
        'mkt-1',
        compatPlugin.name,
        true,
      );
      expect(onPluginUpdated).toHaveBeenCalledWith(updated);
    });

    it('greys the Codex tab and shows the disabled badge when disabled', () => {
      const disabledPlugin = makeCompatCapablePlugin({
        codexCompatDisabled: true,
      });
      renderView(disabledPlugin);
      const codexTab = container.querySelector(
        '[data-testid="plugin-detail-toggle-codex"]',
      );
      expect(codexTab?.getAttribute('aria-disabled')).toBe('true');
      expect(
        container.querySelector(
          '[data-testid="plugin-detail-codex-compat-disabled-badge"]',
        ),
      ).not.toBeNull();
      expect(pluginsApi.prepareCodexCompatibilityPlugin).not.toHaveBeenCalled();
    });
  });
});

describe('PluginDetailView built-in provider install', () => {
  let container: HTMLElement;
  let root: Root;
  let pluginsApi: {
    installPlugin: jest.Mock;
    prepareCodexCompatibilityPlugin: jest.Mock;
    setCodexCompatDisabled: jest.Mock;
    readComponentContent: jest.Mock;
    installBuiltInPlugin: jest.Mock;
  };
  const originalPlugins = (window as unknown as Record<string, unknown>)
    .plugins;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pluginsApi = {
      installPlugin: jest.fn(),
      prepareCodexCompatibilityPlugin: jest.fn(),
      setCodexCompatDisabled: jest.fn(),
      readComponentContent: jest.fn().mockResolvedValue({
        success: true,
        data: { frontmatter: {}, body: 'component body' },
      }),
      installBuiltInPlugin: jest.fn(),
    };
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: pluginsApi,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalPlugins === undefined) {
      Reflect.deleteProperty(window, 'plugins');
    } else {
      Object.defineProperty(window, 'plugins', {
        configurable: true,
        value: originalPlugins,
      });
    }
  });

  function renderBuiltIn(
    plugin: PluginInfo,
    onPluginUpdated: (updated: PluginInfo) => void = (): void => undefined,
  ): void {
    act(() => {
      root.render(
        <PluginDetailView
          plugin={plugin}
          marketplace={makeMarketplace()}
          onBack={(): void => undefined}
          onPluginUpdated={onPluginUpdated}
        />,
      );
    });
  }

  const buttonByTestId = (testid: string): HTMLButtonElement =>
    requireButton(container.querySelector(`[data-testid="${testid}"]`), testid);

  it('renders the built-in install section with per-provider status', () => {
    renderBuiltIn(makeBuiltInPlugin(makeBuiltInStatus()));

    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Install in provider apps');
    expect(
      container.querySelector('[data-testid="built-in-install-status-claude"]')
        ?.textContent,
    ).toBe('Not installed');
    expect(
      container.querySelector('[data-testid="built-in-install-status-codex"]')
        ?.textContent,
    ).toBe('Not installed');
    // Both providers available + not installed → combined action shown.
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-chrome"] [data-testid="plugin-detail-install"]',
      ),
    ).not.toBeNull();
  });

  it('does not render the install section for a non-built-in plugin', () => {
    const plugin = makePlugin({
      claude: makeFacet({
        provider: 'claude',
        mode: 'native',
        details: makeDetails(),
      }),
    });
    renderBuiltIn(plugin);
    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).toBeNull();
  });

  it('renders the install section for a curated plugin', () => {
    renderBuiltIn(makeCuratedPlugin(makeBuiltInStatus()));

    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).not.toBeNull();
  });

  it('calls installBuiltInPlugin with the curated marketplaceId, not the built-in one', async () => {
    const plugin = makeCuratedPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin,
        providerOutcomes: { claude: { installed: true } },
      },
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'curated/cloud',
      pluginName: 'Curated Plugin',
      providers: ['claude'],
    });
  });

  it('calls installBuiltInPlugin with the claude provider', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin,
        providerOutcomes: { claude: { installed: true } },
      },
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'mkt-1',
      pluginName: 'Built-in Plugin',
      providers: ['claude'],
    });
  });

  it('calls installBuiltInPlugin with the codex provider', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin,
        providerOutcomes: { codex: { installed: true } },
      },
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-codex').click();
      await Promise.resolve();
    });

    expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'mkt-1',
      pluginName: 'Built-in Plugin',
      providers: ['codex'],
    });
  });

  it('installs to both providers from the combined action', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin,
        providerOutcomes: {
          claude: { installed: true },
          codex: { installed: true },
        },
      },
    });
    const onPluginUpdated = jest.fn();
    renderBuiltIn(plugin, onPluginUpdated);

    await act(async () => {
      // The header Install installs to every provider that lacks the plugin.
      buttonByTestId('plugin-detail-install').click();
      await Promise.resolve();
    });

    expect(pluginsApi.installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'mkt-1',
      pluginName: 'Built-in Plugin',
      providers: ['claude', 'codex'],
    });
    expect(onPluginUpdated).toHaveBeenCalledWith(plugin);
    expect(
      container.querySelector('[data-testid="built-in-install-message"]')
        ?.textContent,
    ).toBe('Installed to Claude and Codex.');
  });

  it('shows a loading label while an install is in flight', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    let resolveInstall: (value: unknown) => void = () => undefined;
    pluginsApi.installBuiltInPlugin.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(
      buttonByTestId('built-in-install-button-claude').textContent,
    ).toContain('Installing to Claude');

    await act(async () => {
      resolveInstall({
        success: true,
        data: { plugin, providerOutcomes: { claude: { installed: true } } },
      });
      await Promise.resolve();
    });
  });

  it('shows a success message after a successful install', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: { plugin, providerOutcomes: { claude: { installed: true } } },
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="built-in-install-message"]')
        ?.textContent,
    ).toBe('Installed to Claude.');
  });

  it('shows a per-provider error message when the provider install fails', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin,
        providerOutcomes: {
          claude: { installed: false, error: 'permission denied' },
        },
      },
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="built-in-install-message"]')
        ?.textContent,
    ).toBe('Could not install to Claude: permission denied');
  });

  it('shows a generic error when the install IPC fails outright', async () => {
    const plugin = makeBuiltInPlugin(makeBuiltInStatus());
    pluginsApi.installBuiltInPlugin.mockResolvedValue({
      success: false,
      error: 'backend exploded',
    });
    renderBuiltIn(plugin);

    await act(async () => {
      buttonByTestId('built-in-install-button-claude').click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="built-in-install-message"]')
        ?.textContent,
    ).toBe('Could not install plugin: backend exploded');
  });

  it('marks an unavailable provider as not available and hides its button', () => {
    const plugin = makeBuiltInPlugin(
      makeBuiltInStatus({
        claude: { available: true, installed: false },
        codex: { available: false, installed: false },
      }),
      {
        claude: makeFacet({
          provider: 'claude',
          mode: 'native',
          details: makeDetails(),
        }),
      },
    );
    renderBuiltIn(plugin);

    expect(
      container.querySelector('[data-testid="built-in-install-status-codex"]')
        ?.textContent,
    ).toBe('Not available for this plugin');
    expect(
      container.querySelector('[data-testid="built-in-install-button-codex"]'),
    ).toBeNull();
    // A single available provider: the header Install targets only it.
    expect(
      buttonByTestId('plugin-detail-install').getAttribute('aria-label'),
    ).toBe('Install to Claude');
  });

  it('renders Reinstall + Installed status for an installed provider', () => {
    const plugin = makeBuiltInPlugin(
      makeBuiltInStatus({
        claude: { available: true, installed: true, enabled: true },
        codex: { available: true, installed: true, enabled: false },
      }),
    );
    renderBuiltIn(plugin);

    expect(
      container.querySelector('[data-testid="built-in-install-status-claude"]')
        ?.textContent,
    ).toBe('Installed');
    expect(
      buttonByTestId('built-in-install-button-claude').textContent,
    ).toContain('Reinstall in Claude');
    expect(
      container.querySelector('[data-testid="built-in-install-status-codex"]')
        ?.textContent,
    ).toBe('Installed, disabled');
  });
});
