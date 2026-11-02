/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import {
  McpBrowseDialog,
  CuratedDetail,
  buildInstalledCuratedMap,
  filterCuratedEntries,
  sortCuratedEntries,
} from '../McpBrowseDialog';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

function makeEntry(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'github',
    name: 'GitHub',
    shortDescription: 'GitHub repositories and issues',
    url: 'https://mcp.github.com/sse',
    transport: 'http',
    categories: ['dev'],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInstalled(
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id: 'srv-github',
    name: 'GitHub',
    description: '',
    type: 'http',
    configs: [],
    curatedKey: 'github',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('McpBrowseDialog helpers', () => {
  it('sorts by sortOrder then name', () => {
    const sorted = sortCuratedEntries([
      makeEntry({ key: 'b', name: 'Beta', sortOrder: 2 }),
      makeEntry({ key: 'a2', name: 'Alpha2', sortOrder: 1 }),
      makeEntry({ key: 'a1', name: 'Alpha1', sortOrder: 1 }),
    ]);
    expect(sorted.map((e) => e.key)).toEqual(['a1', 'a2', 'b']);
  });

  it('filters case-insensitively across name, description, and categories', () => {
    const entries = [
      makeEntry({
        key: 'github',
        name: 'GitHub',
        shortDescription: 'Repositories and pull requests',
        categories: ['dev'],
      }),
      makeEntry({
        key: 'linear',
        name: 'Linear',
        shortDescription: 'Issue tracking',
        categories: ['pm'],
      }),
    ];
    expect(filterCuratedEntries(entries, 'ISSUE').map((e) => e.key)).toEqual([
      'linear',
    ]);
    expect(filterCuratedEntries(entries, 'dev').map((e) => e.key)).toEqual([
      'github',
    ]);
    // Blank query matches everything.
    expect(filterCuratedEntries(entries, '  ')).toHaveLength(2);
  });

  it('maps only curatedKey-bearing installed servers', () => {
    const map = buildInstalledCuratedMap([
      makeInstalled({ id: 'srv-github', curatedKey: 'github' }),
      makeInstalled({ id: 'srv-custom', curatedKey: undefined }),
    ]);
    expect(map.get('github')).toBe('srv-github');
    expect(map.has('custom')).toBe(false);
  });
});

describe('McpBrowseDialog component', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getTools: jest.Mock;
  const originalMcp = window.mcpServers;

  beforeEach(() => {
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getTools = jest.fn((serverId: string) =>
      Promise.resolve(
        serverId === 'srv-github'
          ? {
              tools: ['search_issues', 'create_pull_request'],
              discoveredAt: '2026-07-01T00:00:00.000Z',
            }
          : null,
      ),
    );
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { getTools },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalMcp === undefined) {
      Reflect.deleteProperty(window, 'mcpServers');
    } else {
      Object.defineProperty(window, 'mcpServers', {
        configurable: true,
        value: originalMcp,
      });
    }
  });

  const entries: CuratedMcpServerEntry[] = [
    makeEntry({ key: 'github', name: 'GitHub', popular: true, sortOrder: 0 }),
    makeEntry({
      key: 'linear',
      name: 'Linear',
      shortDescription: 'Issue tracking',
      popular: false,
      sortOrder: 1,
      logoUrl: 'https://cdn.example.com/linear.png',
    }),
  ];

  async function mount(
    installedServers: McpServerIndexEntry[],
    onAdd: (entry: CuratedMcpServerEntry) => void = () => undefined,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <McpBrowseDialog
          entries={entries}
          installedServers={installedServers}
          onClose={() => undefined}
          onAdd={onAdd}
        />,
      );
      await Promise.resolve();
    });
  }

  function cardFor(name: string): HTMLElement {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="mcp-browse-card"]'),
    );
    const card = cards.find((c) => c.textContent?.includes(name));
    if (!card) throw new Error(`No browse card for ${name}`);
    return card;
  }

  it('renders a Popular section and every catalog card', async () => {
    await mount([makeInstalled()]);
    expect(
      document.querySelector('[data-testid="mcp-browse-dialog"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Popular');
    expect(
      document.querySelectorAll('[data-testid="mcp-browse-card"]').length,
    ).toBe(2);
  });

  it('filters cards by the search input', async () => {
    await mount([makeInstalled()]);
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="mcp-browse-search"]',
    );
    if (!search) throw new Error('missing search input');
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      descriptor?.set?.call(search, 'Issue tracking');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const cards = document.querySelectorAll('[data-testid="mcp-browse-card"]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Linear');
  });

  it('renders discovered tool chips only for an installed entry', async () => {
    await mount([makeInstalled({ id: 'srv-github', curatedKey: 'github' })]);
    await act(async () => {
      cardFor('GitHub').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getTools).toHaveBeenCalledWith('srv-github');
    const chips = document.querySelectorAll(
      '[data-testid="mcp-browse-tool-chip"]',
    );
    expect(chips.length).toBe(2);
    expect(document.body.textContent).toContain('search_issues');
    expect(
      useCurrentUiStateStore.getState().slices['plugins.mcpBrowseModal'],
    ).toEqual({
      open: true,
      view: 'detail',
      resultCount: 2,
      selectedEntry: {
        key: 'github',
        name: 'GitHub',
        installed: true,
      },
    });
  });

  it('never discovers tools or offers app actions for an old provider-only device server', async () => {
    await act(async () => {
      root.render(
        <CuratedDetail
          entry={makeEntry({ providerConnector: { providers: ['claude'] } })}
          installedServerId="legacy-device-server"
          onAdd={jest.fn()}
          onConfigure={jest.fn()}
        />,
      );
      await Promise.resolve();
    });
    expect(getTools).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="mcp-browse-tools"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="mcp-browse-detail-add"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="plugin-advanced-configuration"]'),
    ).toBeNull();
    // Without provider routes (the MCP tab's Browse dialog), the detail still
    // says how this service connects instead of ending on its description.
    expect(
      document.querySelector(
        '[data-testid="mcp-browse-detail-provider-guidance"]',
      )?.textContent,
    ).toContain('connects through your Claude account. Connect Claude first');
  });

  it('loads tools for an installed account without reading a device file', async (): Promise<void> => {
    const id = 'github';
    const loadServer = jest.fn();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { getTools, loadServer },
    });
    getTools.mockResolvedValue({ tools: ['account_search'], discoveredAt: '' });
    await mount([
      makeInstalled({
        id,
        curatedKey: 'github',
        scope: 'account',
        authHandler: 'account',
      }),
    ]);
    await act(async (): Promise<void> => {
      cardFor('GitHub').click();
      await Promise.resolve();
    });
    expect(getTools).toHaveBeenCalledWith(id);
    expect(document.body.textContent).toContain('account_search');
    expect(document.body.textContent).not.toContain(
      'Tools appear after you add',
    );
    expect(loadServer).not.toHaveBeenCalled();
  });

  it('omits tool chips (shows the install hint) for a not-installed entry', async () => {
    // Only GitHub is installed; Linear is not.
    await mount([makeInstalled({ id: 'srv-github', curatedKey: 'github' })]);
    await act(async () => {
      cardFor('Linear').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.querySelectorAll('[data-testid="mcp-browse-tool-chip"]').length,
    ).toBe(0);
    expect(document.body.textContent).toContain('Tools appear after you add');
    // getTools is never called for an un-added entry.
    expect(getTools).not.toHaveBeenCalled();
  });

  it('invokes onAdd from a card Add button', async () => {
    const onAdd = jest.fn<void, [CuratedMcpServerEntry]>();
    await mount([makeInstalled()], onAdd);
    await act(async () => {
      const add = cardFor('Linear').querySelector<HTMLButtonElement>(
        '[data-testid="mcp-browse-card-add"]',
      );
      add?.click();
      await Promise.resolve();
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].key).toBe('linear');
  });
});
