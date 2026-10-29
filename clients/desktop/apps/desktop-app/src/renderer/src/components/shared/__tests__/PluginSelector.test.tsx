/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  PluginDetails,
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/desktop-shared/types/plugins';
import type {
  UnifiedTableRow,
  UseUnifiedTableDataReturn,
} from '../../../hooks/useUnifiedTableData';

// Mock the hooks PluginSelector pulls in so we can hand it a deterministic
// row set without spinning up the marketplace IPC.
jest.mock('@/hooks/useUnifiedTableData', (): Record<string, unknown> => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/hooks/useUnifiedTableData',
  );
  return {
    ...actual,
    useUnifiedTableData: jest.fn(),
  };
});
jest.mock('@/hooks/useCollectionList', () => ({
  useCollectionList: (): {
    collections: never[];
    loading: boolean;
    error: null;
    refresh: () => Promise<void>;
  } => ({
    collections: [],
    loading: false,
    error: null,
    refresh: jest.fn(() => Promise.resolve()),
  }),
}));
jest.mock('../../pages/CollectionsTab', () => ({
  CollectionModal: (): null => null,
}));
jest.mock('../../pages/UnifiedTableDetailOverlays', () => ({
  UnifiedTableDetailOverlays: (): null => null,
}));
jest.mock('../../pages/unifiedTableDetailView', () => ({
  useUnifiedTableDetailView: (): {
    openRowDetails: jest.Mock;
    closeDetails: jest.Mock;
    viewingSkill: null;
    viewingPlugin: null;
    viewingMcpServerId: null;
  } => ({
    openRowDetails: jest.fn(),
    closeDetails: jest.fn(),
    viewingSkill: null,
    viewingPlugin: null,
    viewingMcpServerId: null,
  }),
}));

import {
  PluginSelector,
  type PluginSelectorProviderScope,
} from '../PluginSelector';
import { buildMcpRows, useUnifiedTableData } from '@/hooks/useUnifiedTableData';

const mockUseUnifiedTableData =
  useUnifiedTableData as unknown as jest.MockedFunction<
    () => UseUnifiedTableDataReturn
  >;

function makePluginRow(
  name: string,
  marketplaceId: string,
  support: PluginProviderSupport,
): UnifiedTableRow {
  const original: PluginInfo = {
    name,
    sourcePath: `plugins/${name}`,
    marketplaceId,
    providerSupport: support,
    facets: {},
  };
  return {
    rowOrigin: 'catalog',
    kind: 'plugin',
    key: `${marketplaceId}/${name}`,
    name,
    description: '',
    source: 'acme/plugins',
    sourceSubtitle: 'Acme Plugins',
    sourceIcon: 'mixed',
    lastUpdated: '2026-05-01T00:00:00.000Z',
    original,
    providerSupport: support,
  };
}

function makeEmptySelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function requireCheckbox(
  node: Element | null,
  label: string,
): HTMLInputElement {
  if (!(node instanceof HTMLInputElement) || node.type !== 'checkbox') {
    throw new Error(`${label} not found or not a checkbox`);
  }
  return node;
}

describe('PluginSelector provider scope sanitization', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockUseUnifiedTableData.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('selects account MCP rows by server key, the ref shape cloud sessions use', (): void => {
    const serverId = 'github';
    mockUseUnifiedTableData.mockReturnValue({
      rows: buildMcpRows([
        {
          id: serverId,
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          name: 'Account GitHub',
          description: '',
          type: 'http',
          configs: [{ id: 'default', name: 'Default', enabled: true }],
          updatedAt: '',
        },
      ]),
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    act((): void =>
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={onChange}
          providerScope="claude"
        />,
      ),
    );
    act((): void =>
      requireCheckbox(
        container.querySelector('input[aria-label="Select Account GitHub"]'),
        'account selection',
      ).click(),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...makeEmptySelections(),
      mcpServerRefs: [{ serverId, configId: 'default' }],
    });
  });

  it('labels MCP rows with where they run, leaving connectors unbadged', (): void => {
    const connector: UnifiedTableRow = {
      rowOrigin: 'catalog',
      kind: 'mcp',
      key: 'provider-connector:gmail-gmailmcp',
      name: 'Gmail',
      description: '',
      source: 'Claude account',
      sourceId: 'provider-account',
      sourceSubtitle: 'Linked',
      sourceIcon: 'none',
      lastUpdated: '2026-08-31T00:00:00.000Z',
      toggleMode: 'locked',
      viewDisabled: true,
      original: {
        key: 'gmail-gmailmcp',
        name: 'Gmail',
        shortDescription: '',
        url: 'https://gmail.example.com/mcp',
        transport: 'http',
        categories: [],
        popular: false,
        sortOrder: 0,
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    };
    mockUseUnifiedTableData.mockReturnValue({
      rows: [
        ...buildMcpRows([
          {
            id: 'custom:11111111-2222-4333-8444-555555555555',
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            name: 'Team tracker',
            description: '',
            type: 'http',
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            updatedAt: '',
          },
          {
            id: 'local-files',
            name: 'Local files',
            description: '',
            type: 'command',
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            updatedAt: '',
          },
        ]),
        connector,
      ],
      sourceOptions: [],
      loading: false,
    });
    act((): void =>
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
        />,
      ),
    );
    const rowText = (key: string): string =>
      container.querySelector(`input[data-row-key="${key}"]`)?.closest('tr')
        ?.textContent ?? '';
    expect(
      rowText('custom:11111111-2222-4333-8444-555555555555/default'),
    ).toContain('Cloud + desktop');
    expect(rowText('local-files/default')).toContain('Desktop only');
    expect(rowText('provider-connector:gmail-gmailmcp')).not.toMatch(
      /Cloud \+ desktop|Desktop only/,
    );
  });

  it.each<[PluginSelectorProviderScope, string]>([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['ollama', 'Ollama'],
    ['cursor', 'Cursor'],
    ['mixed', 'All supported providers'],
  ])('labels the %s provider scope accurately', (providerScope, label) => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: [],
      sourceOptions: [],
      loading: false,
    });
    act(() =>
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope={providerScope}
        />,
      ),
    );
    const chip = container.querySelector(
      '[data-testid="unified-table"] [data-testid="plugin-selector-scope"]',
    );
    expect(chip?.textContent).toBe(`Provider scope: ${label}`);
    expect(chip?.getAttribute('title')).toBe(`Provider scope: ${label}`);
    expect(container.textContent).not.toContain('Choose capabilities');
  });

  it.each(['ollama', 'cursor'] as const)(
    'shows capabilities supported by %s',
    (providerScope) => {
      const plugin = makePluginRow('scoped-plugin', 'mkt', {
        claude: 'native',
        codex: 'native',
      });
      if (!('facets' in plugin.original))
        throw new Error('Expected plugin fixture');
      const details: PluginDetails = {
        skills: [],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [{ name: 'Shared tools', type: 'http' }],
        lspServers: [],
        hasReadme: false,
      };
      plugin.original.details = {
        ...details,
        skills: [
          {
            name: 'Other harness skill',
            description: 'Other skill',
            path: 'other',
          },
        ],
      };
      plugin.original.facets.claude = {
        provider: 'claude',
        mode: 'native',
        name: 'scoped-plugin',
        sourcePath: 'plugin',
        details: {
          ...details,
          skills: [
            {
              name: 'Claude skill',
              description: 'Claude skill',
              path: 'claude',
            },
          ],
        },
      };
      mockUseUnifiedTableData.mockReturnValue({
        rows: [plugin],
        sourceOptions: [],
        loading: false,
      });
      act(() =>
        root.render(
          <PluginSelector
            selections={makeEmptySelections()}
            onChange={jest.fn()}
            providerScope={providerScope}
          />,
        ),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="plugin-members-toggle"]',
          )
          ?.click(),
      );
      const capabilities = container.querySelector(
        '[aria-label="scoped-plugin capabilities"]',
      );
      expect(capabilities?.textContent).toContain('Shared tools');
      // Both scopes read the Claude facet, never the merged top-level details.
      expect(capabilities?.textContent).not.toContain('Other harness skill');
      expect(capabilities?.textContent).toContain('Claude skill');
    },
  );

  // Copilot chats resolve plugins through the same Cursor projection.
  it.each(['cursor', 'copilot'] as const)(
    'previews what a %s session loads: skills from a Codex-only plugin, commands only from a Claude plugin',
    (providerScope) => {
      const base: PluginDetails = {
        skills: [],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        hasReadme: false,
      };
      const codexOnly = makePluginRow('codex-plugin', 'mkt', {
        claude: 'none',
        codex: 'native',
      });
      if (!('facets' in codexOnly.original))
        throw new Error('Expected plugin fixture');
      codexOnly.original.facets.codex = {
        provider: 'codex',
        mode: 'native',
        name: 'codex-plugin',
        sourcePath: 'plugin',
        details: {
          ...base,
          skills: [{ name: 'Codex skill', description: '', path: 'skill' }],
          commands: [
            { name: 'Codex command', description: '', filePath: 'cmd.md' },
          ],
        },
      };
      const claudeOnly = makePluginRow('claude-plugin', 'mkt', {
        claude: 'native',
        codex: 'none',
      });
      if (!('facets' in claudeOnly.original))
        throw new Error('Expected plugin fixture');
      claudeOnly.original.facets.claude = {
        provider: 'claude',
        mode: 'native',
        name: 'claude-plugin',
        sourcePath: 'plugin',
        details: {
          ...base,
          commands: [
            { name: 'Claude command', description: '', filePath: 'cmd.md' },
          ],
        },
      };
      mockUseUnifiedTableData.mockReturnValue({
        rows: [codexOnly, claudeOnly],
        sourceOptions: [],
        loading: false,
      });
      act(() =>
        root.render(
          <PluginSelector
            selections={makeEmptySelections()}
            onChange={jest.fn()}
            providerScope={providerScope}
          />,
        ),
      );
      for (const toggle of Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="plugin-members-toggle"]',
        ),
      )) {
        act(() => {
          toggle.click();
        });
      }
      const codexCapabilities = container.querySelector(
        '[aria-label="codex-plugin capabilities"]',
      );
      expect(codexCapabilities?.textContent).toContain('Codex skill');
      expect(codexCapabilities?.textContent).not.toContain('Codex command');
      expect(
        container.querySelector('[aria-label="claude-plugin capabilities"]')
          ?.textContent,
      ).toContain('Claude command');
    },
  );

  it('disables Codex-only plugins under claude scope', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly],
      sourceOptions: [],
      loading: false,
    });

    const onChange = jest.fn();
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={onChange}
          providerScope="claude"
        />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Unsupported checkbox',
    );
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.getAttribute('aria-label')).toBe(
      'Select codex-only (Only available for Codex)',
    );
  });

  it('mirrors claude scope for ollama: Codex-only plugins are disabled', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="ollama"
        />,
      );
    });
    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Ollama unsupported checkbox',
    );
    expect(checkbox.disabled).toBe(true);
  });

  it('keeps skill rows selectable under cursor scope, like plugins', () => {
    const skill: UnifiedTableRow = {
      rowOrigin: 'catalog',
      kind: 'skill',
      key: 'custom:local/review',
      name: 'review',
      description: '',
      source: 'custom:local',
      sourceSubtitle: '',
      sourceIcon: 'app',
      lastUpdated: '2026-05-01T00:00:00.000Z',
      original: {
        name: 'review',
        sourceId: 'custom:local',
        description: '',
        source: 'custom:local',
        installedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        updateAvailable: false,
        custom: true,
      },
    };
    const claudeOnly = makePluginRow('claude-only', 'mkt', {
      claude: 'native',
      codex: 'none',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [skill, claudeOnly],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="cursor"
        />,
      );
    });
    const skillCheckbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label^="Select review"]',
      ),
      'Skill checkbox',
    );
    expect(skillCheckbox.disabled).toBe(false);
    expect(skillCheckbox.getAttribute('data-toggle-mode')).not.toBe(
      'unsupported',
    );
    expect(skillCheckbox.getAttribute('aria-label')).toBe('Select review');
    const pluginCheckbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select claude-only"]',
      ),
      'Plugin checkbox',
    );
    expect(pluginCheckbox.disabled).toBe(false);
  });

  it('keeps a persisted skill checked and removable under cursor scope', () => {
    const skill: UnifiedTableRow = {
      rowOrigin: 'catalog',
      kind: 'skill',
      key: 'custom:local/review',
      name: 'review',
      description: '',
      source: 'custom:local',
      sourceSubtitle: '',
      sourceIcon: 'app',
      lastUpdated: '2026-05-01T00:00:00.000Z',
      original: {
        name: 'review',
        sourceId: 'custom:local',
        description: '',
        source: 'custom:local',
        installedAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        updateAvailable: false,
        custom: true,
      },
    };
    mockUseUnifiedTableData.mockReturnValue({
      rows: [skill],
      sourceOptions: [],
      loading: false,
    });
    const onSanitizedChange = jest.fn();
    act(() => {
      root.render(
        <PluginSelector
          selections={{
            ...makeEmptySelections(),
            collectionIds: ['col-a'],
            skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
          }}
          onChange={jest.fn()}
          onSanitizedChange={onSanitizedChange}
          providerScope="cursor"
        />,
      );
    });
    // The row renders checked (and, being checked, still removable)...
    const skillCheckbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label^="Select review"]',
      ),
      'Skill checkbox',
    );
    expect(skillCheckbox.checked).toBe(true);
    expect(skillCheckbox.getAttribute('data-toggle-mode')).not.toBe(
      'unsupported',
    );
    expect(skillCheckbox.disabled).toBe(false);
    // ...and the emitted selection still carries what the chat persisted, so
    // a save on Cursor does not drop it.
    expect(onSanitizedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collectionIds: ['col-a'],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
      }),
    );
    // Unchecking it is a real removal.
    act(() => {
      skillCheckbox.click();
    });
    expect(onSanitizedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionIds: ['col-a'], skillRefs: [] }),
    );
  });

  it('puts a linked connector in the table selection so the filters agree', () => {
    // The row renders checked because `UnifiedTable` draws
    // `checked={locked || checked}`, but the Selected/Not selected filter and
    // the summary read `selectedKeys` only. Leaving a locked connector out of
    // that set showed a ticked box that hid under "Selected" and appeared
    // under "Not selected" — the same row disagreeing with itself.
    const connector: UnifiedTableRow = {
      rowOrigin: 'catalog',
      kind: 'mcp',
      key: 'provider-connector:gmail-gmailmcp',
      name: 'Gmail',
      description: 'Read and send mail',
      source: 'Claude account',
      sourceId: 'provider-account',
      sourceSubtitle: 'Linked',
      sourceIcon: 'none',
      lastUpdated: '2026-08-31T00:00:00.000Z',
      toggleMode: 'locked',
      excludeFromSelectionCount: true,
      providerSupport: { claude: 'native', codex: 'native' },
    };
    mockUseUnifiedTableData.mockReturnValue({
      rows: [connector],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="mixed"
        />,
      );
    });

    // Drive the real filter rather than inspecting props: switch to
    // "Selected" and the ticked row must still be there.
    const filter = container.querySelector<HTMLButtonElement>(
      '[data-testid="unified-table-filter-selected"]',
    );
    if (!filter) {
      throw new Error('Selected/Not selected filter not found');
    }
    act(() => {
      filter.click();
    });

    const table = container.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('1');
  });

  it('mirrors claude scope for ollama: a Codex-only connector is not shown as live', () => {
    // `locked` renders CHECKED, and checked on this surface means "active in
    // this session". Ollama sessions reuse the Claude resolver path — the same
    // aliasing `getUnsupportedReason` applies — so a connector linked only on
    // Codex is not active here. Written as `scope === 'claude' ? claude :
    // codex`, ollama fell into the Codex branch and the row stayed checked.
    const connector: UnifiedTableRow = {
      rowOrigin: 'catalog',
      kind: 'mcp',
      key: 'provider-connector:gmail-gmailmcp',
      name: 'Gmail',
      description: 'Read and send mail',
      source: 'Codex account',
      sourceId: 'provider-account',
      sourceSubtitle: 'Linked',
      sourceIcon: 'none',
      lastUpdated: '2026-08-31T00:00:00.000Z',
      toggleMode: 'locked',
      providerSupport: { claude: 'none', codex: 'native' },
    };
    mockUseUnifiedTableData.mockReturnValue({
      rows: [connector],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="ollama"
        />,
      );
    });
    const checkbox = requireCheckbox(
      container.querySelector('input[type="checkbox"]'),
      'Ollama connector checkbox',
    );
    expect(checkbox.getAttribute('data-toggle-mode')).toBe('disabled');
    expect(checkbox.checked).toBe(false);
  });

  it('leaves Claude-only plugins enabled under codex scope (compatibility mode)', () => {
    const claudeOnly = makePluginRow('claude-only', 'mkt', {
      claude: 'native',
      codex: 'compat',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [claudeOnly],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="codex"
        />,
      );
    });
    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="normal"]',
      ),
      'Codex-compat-enabled checkbox',
    );
    expect(checkbox.disabled).toBe(false);
  });

  it('shows every row enabled under mixed scope', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    const claudeOnly = makePluginRow('claude-only', 'mkt', {
      claude: 'native',
      codex: 'none',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly, claudeOnly],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
          providerScope="mixed"
        />,
      );
    });
    const checkboxes = container.querySelectorAll(
      'input[type="checkbox"][data-toggle-mode]',
    );
    for (const cb of Array.from(checkboxes)) {
      if (!(cb instanceof HTMLInputElement)) continue;
      expect(cb.disabled).toBe(false);
      expect(cb.getAttribute('data-toggle-mode')).toBe('normal');
    }
  });

  it('treats undefined scope the same as mixed', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly],
      sourceOptions: [],
      loading: false,
    });
    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          onChange={jest.fn()}
        />,
      );
    });
    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="normal"]',
      ),
      'Undefined-scope checkbox',
    );
    expect(checkbox.disabled).toBe(false);
  });

  it('badges inherited defaults by layer and keeps them toggleable', () => {
    const projectPlugin = makePluginRow('project-tool', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    const globalPlugin = makePluginRow('global-tool', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    const bothPlugin = makePluginRow('both-tool', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    const localPlugin = makePluginRow('local-tool', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [
        projectPlugin,
        globalPlugin,
        bothPlugin,
        localPlugin,
        ...buildMcpRows([
          {
            id: 'linear',
            name: 'Linear',
            description: '',
            type: 'command',
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            updatedAt: '',
          },
        ]),
      ],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    const selections: ChatTabPluginSelections = {
      ...makeEmptySelections(),
      pluginRefs: [
        { marketplaceId: 'mkt', pluginName: 'project-tool' },
        { marketplaceId: 'mkt', pluginName: 'global-tool' },
      ],
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    };
    act(() => {
      root.render(
        <PluginSelector
          selections={selections}
          onChange={onChange}
          inheritedDefaults={{
            project: {
              ...makeEmptySelections(),
              pluginRefs: [
                { marketplaceId: 'mkt', pluginName: 'project-tool' },
                { marketplaceId: 'mkt', pluginName: 'both-tool' },
              ],
              mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
            },
            global: {
              ...makeEmptySelections(),
              pluginRefs: [
                { marketplaceId: 'mkt', pluginName: 'global-tool' },
                { marketplaceId: 'mkt', pluginName: 'both-tool' },
              ],
            },
          }}
        />,
      );
    });
    const rowText = (key: string): string =>
      container.querySelector(`input[data-row-key="${key}"]`)?.closest('tr')
        ?.textContent ?? '';
    expect(rowText('mkt/project-tool')).toContain('Project default');
    expect(rowText('mkt/global-tool')).toContain('Global default');
    expect(rowText('mkt/both-tool')).toContain('Project default');
    expect(rowText('mkt/both-tool')).not.toContain('Global default');
    expect(rowText('mkt/local-tool')).not.toMatch(
      /Project default|Global default/,
    );
    expect(rowText('linear/default')).toContain('Project default');

    const projectCheckbox = requireCheckbox(
      container.querySelector('input[data-row-key="mkt/project-tool"]'),
      'project default checkbox',
    );
    expect(projectCheckbox.disabled).toBe(false);
    expect(projectCheckbox.checked).toBe(true);
    act(() => projectCheckbox.click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...makeEmptySelections(),
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'global-tool' }],
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    });
  });

  it('renders the shared unavailable status and Remove for recorded selections', () => {
    const docs = makePluginRow('docs', 'acme', {
      claude: 'native',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [docs],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    act((): void =>
      root.render(
        <PluginSelector
          selections={{
            ...makeEmptySelections(),
            skillRefs: [{ sourceId: 'custom', skillName: 'notes' }],
            pluginRefs: [{ marketplaceId: 'acme', pluginName: 'docs' }],
          }}
          onChange={onChange}
          unavailable={[
            {
              ref: {
                kind: 'plugin',
                marketplaceId: 'acme',
                pluginName: 'docs',
                via: { kind: 'direct' },
              },
              reason: 'turned_off',
              disposition: 'unavailable',
            },
            {
              ref: {
                kind: 'skill',
                sourceId: 'custom',
                skillName: 'notes',
                via: { kind: 'direct' },
              },
              displayName: 'Release notes',
              reason: 'deleted',
              disposition: 'gone',
            },
          ]}
        />,
      ),
    );
    expect(container.textContent).toContain('Turned off');
    expect(container.textContent).toContain('Release notes');
    expect(container.textContent).toContain('No longer available');
    const removes = container.querySelectorAll(
      '[data-testid="portal-plugins-remove-unavailable"]',
    );
    expect(removes).toHaveLength(2);
    const removeNotes = container.querySelector(
      'button[aria-label="Remove Release notes"]',
    );
    if (!(removeNotes instanceof HTMLButtonElement))
      throw new Error('Remove for the deleted skill not found');
    act((): void => removeNotes.click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...makeEmptySelections(),
      pluginRefs: [{ marketplaceId: 'acme', pluginName: 'docs' }],
    });
  });

  it('keeps Agent-provided plugin selections checked and locked', () => {
    const inheritedPlugin = makePluginRow('review-tools', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [inheritedPlugin],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    const onSanitizedChange = jest.fn();

    act(() => {
      root.render(
        <PluginSelector
          selections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
            mcpServerRefs: [],
          }}
          lockedSelections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
            mcpServerRefs: [],
          }}
          onChange={onChange}
          onSanitizedChange={onSanitizedChange}
          providerScope="claude"
        />,
      );
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="locked"]',
      ),
      'Agent-provided plugin checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.getAttribute('aria-label')).toBe('Select review-tools');
    expect(onSanitizedChange).toHaveBeenLastCalledWith({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
      mcpServerRefs: [],
    });

    act(() => {
      checkbox.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('unions locked selections into emitted values when they are not selected', () => {
    const inheritedPlugin = makePluginRow('review-tools', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    const editablePlugin = makePluginRow('local-tools', 'mkt', {
      claude: 'native',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [inheritedPlugin, editablePlugin],
      sourceOptions: [],
      loading: false,
    });
    const onChange = jest.fn();
    const onSanitizedChange = jest.fn();

    act(() => {
      root.render(
        <PluginSelector
          selections={makeEmptySelections()}
          lockedSelections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
            mcpServerRefs: [],
          }}
          onChange={onChange}
          onSanitizedChange={onSanitizedChange}
          providerScope="claude"
        />,
      );
    });

    expect(onSanitizedChange).toHaveBeenLastCalledWith({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'review-tools' }],
      mcpServerRefs: [],
    });

    const editableCheckbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][aria-label="Select local-tools"]',
      ),
      'editable plugin checkbox',
    );
    act(() => {
      editableCheckbox.click();
    });

    expect(onChange).toHaveBeenLastCalledWith({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'mkt', pluginName: 'local-tools' },
        { marketplaceId: 'mkt', pluginName: 'review-tools' },
      ],
      mcpServerRefs: [],
    });
  });

  it('preserves disabled-but-checked persisted refs and drops them only when explicitly unchecked', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly],
      sourceOptions: [],
      loading: false,
    });

    const initial: ChatTabPluginSelections = {
      bundleIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'codex-only' }],
      mcpServerRefs: [],
    };
    const onChange = jest.fn();
    act(() => {
      root.render(
        <PluginSelector
          selections={initial}
          onChange={onChange}
          providerScope="claude"
        />,
      );
    });

    // The checkbox should be checked but visually muted; it remains
    // interactive so the user can uncheck it.
    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Persisted unsupported checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);

    // Explicit uncheck → onChange called with pluginRefs cleared.
    act(() => {
      checkbox.click();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });
  });

  it('reports sanitized selections with unsupported persisted plugin refs removed', () => {
    const codexOnly = makePluginRow('codex-only', 'mkt', {
      claude: 'none',
      codex: 'native',
    });
    mockUseUnifiedTableData.mockReturnValue({
      rows: [codexOnly],
      sourceOptions: [],
      loading: false,
    });

    const initial: ChatTabPluginSelections = {
      bundleIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'codex-only' }],
      mcpServerRefs: [],
    };
    const onSanitizedChange = jest.fn();
    act(() => {
      root.render(
        <PluginSelector
          selections={initial}
          onChange={jest.fn()}
          providerScope="claude"
          onSanitizedChange={onSanitizedChange}
        />,
      );
    });

    expect(onSanitizedChange).toHaveBeenLastCalledWith({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Persisted unsupported checkbox',
    );
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });
});
