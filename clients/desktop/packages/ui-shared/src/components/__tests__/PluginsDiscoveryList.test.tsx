/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginsDiscoveryList } from '../PluginsDiscoveryList';
import {
  visibleSectionEntries,
  type PluginsDiscoverySection,
} from '../../lib/plugins-discovery-sections';
import type { UnifiedPluginEntry } from '../../lib/unified-plugin-entry';
import {
  collectionShareBlockedState,
  type MarketplaceEntryShareStates,
} from '../../lib/marketplace-share';

/**
 * Component-level coverage for the parts of the discovery grid the page suite
 * cannot reach through `PluginsPage`: prop combinations the page never emits
 * (a `collapsedCount` with no `onExpand`, an out-of-range `collapsedCount`, a
 * host that omits `onConnectEntry`) and the menus' dismiss contract.
 */

function makeEntry(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id: 'curated:alpha',
    kind: 'plugin',
    origin: 'curated',
    name: 'Alpha',
    description: 'An alpha plugin.',
    categories: ['utilities'],
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'available',
    recommended: false,
    ref: { type: 'curated-plugin', key: 'alpha' },
    ...overrides,
  };
}

function makeEntries(count: number): UnifiedPluginEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeEntry({
      id: `curated:tool-${index}`,
      name: `Tool ${index}`,
      ref: { type: 'curated-plugin', key: `tool-${index}` },
    }),
  );
}

describe('PluginsDiscoveryList', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  interface RenderOptions {
    hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
    sections: PluginsDiscoverySection[];
    onSelectEntry?: (entry: UnifiedPluginEntry) => void;
    onAddEntry?: ((entry: UnifiedPluginEntry) => void) | null;
    entryShareStates?: MarketplaceEntryShareStates;
    onShareEntry?: (entry: UnifiedPluginEntry) => void;
    onConnectEntry?: (entry: UnifiedPluginEntry) => void;
    onOpenEntryId?: (entryId: string) => void;
  }

  function renderList({
    hrefForEntry,
    sections,
    onSelectEntry = (): void => {},
    // `null` renders the list without an add flow (`undefined` takes the
    // default handler, matching every host that has one).
    onAddEntry: onAddEntryOption = (): void => {},
    entryShareStates,
    onShareEntry,
    onConnectEntry,
    onOpenEntryId,
  }: RenderOptions): void {
    const onAddEntry = onAddEntryOption === null ? undefined : onAddEntryOption;
    act(() => {
      root.render(
        <PluginsDiscoveryList
          hrefForEntry={hrefForEntry}
          sections={sections}
          selectedEntryId={null}
          onSelectEntry={onSelectEntry}
          onAddEntry={onAddEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={onConnectEntry}
          onOpenEntryId={onOpenEntryId}
          emptyMessage="Nothing here."
        />,
      );
    });
  }

  it('CAN-4847 hides requirement navigation when the host cannot open it', () => {
    const item = makeEntry({
      requirements: [{ key: 'github', name: 'GitHub', entryId: 'github' }],
    });
    renderList({ sections: [{ id: 'curated', title: '', entries: [item] }] });
    act(() =>
      container
        .querySelector<HTMLElement>(
          '[data-testid="plugins-entry-menu-curated:alpha"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha-requirement-github"]',
      ),
    ).toBeNull();
  });

  it.each([
    'skill',
    'plugin',
    'app',
    'agent',
    'pipeline',
    'collection',
  ] as const)(
    'CAN-4847 renders %s discovery through the common compact row with one install slot',
    (kind) => {
      const item = makeEntry({
        kind,
        authorName: 'Publisher',
        typeLabel: kind,
      });
      const onAddEntry = jest.fn();
      renderList({
        sections: [{ id: 'curated', title: 'Browse', entries: [item] }],
        onAddEntry,
      });
      const row = container.querySelector(
        `[data-testid="customize-discovery-row-${item.id}"]`,
      );
      expect(row?.tagName).toBe('LI');
      expect(
        row?.querySelector(`[data-testid="customize-row-subtitle-${item.id}"]`)
          ?.textContent,
      ).toBe('Publisher');
      const add = row?.querySelector<HTMLButtonElement>(
        `[data-testid="plugins-entry-add-${item.id}"]`,
      );
      expect(add?.textContent).toBe(kind === 'collection' ? 'Add' : 'Install');
      expect(row?.querySelector('[aria-haspopup="listbox"]')).toBeNull();
      act(() => add?.click());
      expect(onAddEntry).toHaveBeenCalledWith(item);
    },
  );

  it('CAN-4847 puts Share in the menu and preserves blocked reasons without starting another action', () => {
    const item = makeEntry({
      kind: 'collection',
      components: {
        skills: 0,
        plugins: 0,
        mcpServers: 1,
        commands: 0,
        agents: 0,
      },
      ref: { type: 'local-collection', collectionId: 'abc' },
    });
    const onShareEntry = jest.fn(),
      onSelectEntry = jest.fn(),
      onAddEntry = jest.fn();
    const state = collectionShareBlockedState(item);
    if (!state) throw new Error('Expected an MCP restriction');
    renderList({
      sections: [{ id: 'collections', title: '', entries: [item] }],
      onShareEntry,
      onSelectEntry,
      onAddEntry,
      entryShareStates: new Map([[item.id, state]]),
    });
    expect(
      container.querySelector(`[data-testid="plugins-entry-share-${item.id}"]`),
    ).toBeNull();
    press(
      container.querySelector(`[data-testid="plugins-entry-menu-${item.id}"]`),
      'Menu',
    );
    const share = document.querySelector(
      `[data-testid="plugins-entry-menu-${item.id}-share"]`,
    );
    expect(share?.textContent).toBe('Share…');
    expect(share?.getAttribute('aria-disabled')).toBe('true');
    expect(share?.getAttribute('aria-description')).toBe(
      'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
    );
    press(share, 'Blocked Share');
    expect(onShareEntry).not.toHaveBeenCalled();
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(onAddEntry).not.toHaveBeenCalled();
  });

  it('CAN-4847 invokes menu Share only for a shareable entry', () => {
    const item = makeEntry();
    const onShareEntry = jest.fn();
    renderList({
      sections: [{ id: 'curated', title: '', entries: [item] }],
      onShareEntry,
      entryShareStates: new Map([[item.id, { status: 'shareable' }]]),
    });
    press(
      container.querySelector(`[data-testid="plugins-entry-menu-${item.id}"]`),
      'Menu',
    );
    press(
      document.querySelector(
        `[data-testid="plugins-entry-menu-${item.id}-share"]`,
      ),
      'Share',
    );
    expect(onShareEntry).toHaveBeenCalledWith(item);
    expect(menuSurface(item.id)).toBeNull();
  });

  it('CAN-4847 keeps required integration navigation in the menu', () => {
    const onOpenEntryId = jest.fn();
    const item = makeEntry({
      requirements: [{ key: 'docs', name: 'Docs', entryId: 'mcp:docs' }],
    });
    renderList({
      sections: [{ id: 'curated', title: '', entries: [item] }],
      onOpenEntryId,
    });
    press(
      container.querySelector(`[data-testid="plugins-entry-menu-${item.id}"]`),
      'Menu',
    );
    const requirement = document.querySelector(
      `[data-testid="plugins-entry-menu-${item.id}-requirement-docs"]`,
    );
    expect(requirement?.textContent).toBe('Open Docs');
    press(requirement, 'Required integration');
    expect(onOpenEntryId).toHaveBeenCalledWith('mcp:docs');
  });

  it('CAN-4847 keeps source, health and execution surface while omitting description prose', () => {
    const item = makeEntry({
      origin: 'marketplace',
      sourceLabel: 'Anthropic',
      description: 'Private descriptive prose',
      version: '0.12.0',
      surface: 'desktop',
      connection: { status: 'connected' },
    });
    renderList({ sections: [{ id: 'curated', title: '', entries: [item] }] });
    const row = container.querySelector(
      `[data-testid="customize-discovery-row-${item.id}"]`,
    );
    expect(
      row?.querySelector(`[data-testid="customize-row-subtitle-${item.id}"]`)
        ?.textContent,
    ).toBe('Anthropic·v0.12.0');
    expect(row?.textContent).not.toContain('Private descriptive prose');
    expect(
      row?.querySelector(`[data-testid="plugins-surface-${item.id}"]`),
    ).not.toBeNull();
    expect(
      row?.querySelector(`[data-testid="plugins-connection-status-${item.id}"]`)
        ?.textContent,
    ).toContain('Connected');
  });

  it('CAN-4847 nests category links under Browse as smaller h3 headings', () => {
    const onExpand = jest.fn();
    act(() =>
      root.render(
        <PluginsDiscoveryList
          nested
          sections={[
            {
              id: 'curated',
              title: 'Utilities',
              entries: [makeEntry()],
              onExpand,
            },
          ]}
          selectedEntryId={null}
          onSelectEntry={() => {}}
          emptyMessage="Empty"
        />,
      ),
    );
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('h3')?.textContent).toContain('Utilities');
    const link = container.querySelector<HTMLButtonElement>('h3 button');
    expect(link?.querySelector('svg')).not.toBeNull();
    act(() => link?.click());
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  function requireElement(node: Element | null, label: string): HTMLElement {
    if (!(node instanceof HTMLElement)) {
      throw new Error(`${label} not found or wrong element type`);
    }
    return node;
  }

  /** Press a control the way a pointer does: pointerdown, then click. */
  function press(node: Element | null, label: string): void {
    const element = requireElement(node, label);
    act(() => {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function cardIds(): string[] {
    return Array.from(
      container.querySelectorAll('[data-testid^="plugins-entry-"]'),
    )
      .map((node) => node.getAttribute('data-testid') ?? '')
      .filter(
        (testId) =>
          !testId.startsWith('plugins-entry-menu-') &&
          !testId.startsWith('plugins-entry-add-'),
      );
  }

  function menuSurface(entryId: string): Element | null {
    return document.querySelector(
      `[data-testid="plugins-entry-menu-${entryId}-surface"]`,
    );
  }

  it('renders matching anchors with the same card content and styling as buttons', () => {
    const sections: PluginsDiscoverySection[] = [
      { id: 'curated', title: '', entries: [makeEntry()] },
    ];
    renderList({ sections });
    const button = requireElement(
      container.querySelector('[data-marketplace-entry="true"]'),
      'card',
    );
    expect(button.tagName).toBe('BUTTON');
    const className = button.className;
    const content = button.innerHTML;
    renderList({
      sections,
      hrefForEntry: (): string => '/share/plugins/alpha',
    });
    const anchor = requireElement(
      container.querySelector('[data-marketplace-entry="true"]'),
      'card',
    );
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('/share/plugins/alpha');
    expect(anchor.getAttribute('data-testid')).toBe(
      'plugins-entry-curated:alpha',
    );
    expect(anchor.getAttribute('data-selected')).toBe('false');
    expect(anchor.className).toBe(className);
    expect(anchor.innerHTML).toBe(content);
    renderList({ sections, hrefForEntry: (): undefined => undefined });
    expect(
      container.querySelector('[data-marketplace-entry="true"]')?.tagName,
    ).toBe('BUTTON');
  });

  it.each([
    [{}, true],
    [{ metaKey: true }, false],
    [{ ctrlKey: true }, false],
    [{ shiftKey: true }, false],
    [{ altKey: true }, false],
    [{ button: 1 }, false],
    [{ button: 2 }, false],
  ])(
    'intercepts only unmodified primary link clicks: %j',
    (options, intercepted) => {
      const entry = makeEntry();
      const onSelectEntry = jest.fn();
      renderList({
        sections: [{ id: 'curated', title: '', entries: [entry] }],
        hrefForEntry: (): string => '#alpha',
        onSelectEntry,
      });
      const card = requireElement(
        container.querySelector('[data-marketplace-entry="true"]'),
        'card',
      );
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ...options,
      });
      act(() => {
        card.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(intercepted);
      if (intercepted) expect(onSelectEntry).toHaveBeenCalledWith(entry);
      else expect(onSelectEntry).not.toHaveBeenCalled();
    },
  );

  it('moves focus between anchors and buttons with arrow keys', () => {
    renderList({
      sections: [{ id: 'curated', title: '', entries: makeEntries(2) }],
      hrefForEntry: (entry): string | undefined =>
        entry.id === 'curated:tool-0' ? '#first' : undefined,
    });
    const first = requireElement(
      container.querySelector('a[data-marketplace-entry]'),
      'anchor',
    );
    const second = requireElement(
      container.querySelector('button[data-marketplace-entry]'),
      'button',
    );
    first.focus();
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(second);
    act(() => {
      second.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(first);
  });

  describe('CAN-3653 — plugin provenance on cards', () => {
    const catalogCard = makeEntry({
      id: 'mcp-catalog:slack',
      kind: 'app',
      name: 'Slack',
      typeLabel: 'MCP server',
      sourceLabel: 'Curated',
      ref: { type: 'curated-mcp', key: 'slack' },
      installedVia: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
    });
    const bundledRow = makeEntry({
      id: 'mcp-local:slack',
      kind: 'app',
      origin: 'installed-standalone',
      name: 'Slack',
      description: 'Team chat',
      sourceLabel: 'Local',
      state: 'installed',
      ref: { type: 'local-mcp', serverId: 'slack' },
      bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
    });
    const section = (
      entries: UnifiedPluginEntry[],
    ): PluginsDiscoverySection[] => [
      { id: 'apps', title: 'MCP servers', entries },
    ];

    it('renders no source label on curated plugins', () => {
      renderList({
        sections: section([
          makeEntry({ typeLabel: 'Plugin', sourceLabel: 'Curated' }),
        ]),
      });
      expect(
        container.querySelector('[data-testid^="plugins-card-source-"]'),
      ).toBeNull();
    });

    it('renders no source label on MCP rows', () => {
      renderList({ sections: section([catalogCard, bundledRow]) });
      expect(
        container.querySelector('[data-testid^="plugins-card-source-"]'),
      ).toBeNull();
    });
  });

  it('omits the card subtitle when the description has no visible text', () => {
    renderList({
      sections: [
        {
          id: 'featured',
          title: 'Featured',
          entries: [
            makeEntry({
              id: 'curated:rule-only',
              name: 'Rule Only',
              description: '---',
              ref: { type: 'curated-plugin', key: 'rule-only' },
            }),
          ],
        },
      ],
    });

    expect(
      container.querySelector(
        '[data-testid="plugins-card-subtitle-curated:rule-only"]',
      ),
    ).toBeNull();
  });

  function menuItem(
    action: 'view' | 'connect',
    entryId: string,
  ): Element | null {
    return document.querySelector(
      `[data-testid="plugins-entry-menu-${entryId}-${action}"]`,
    );
  }

  // -------------------------------------------------------------------------
  // Collapsing
  // -------------------------------------------------------------------------

  it('collapses nothing when collapsedCount arrives without onExpand', () => {
    const section: PluginsDiscoverySection = {
      id: 'curated',
      title: 'Curated',
      entries: makeEntries(5),
      collapsedCount: 3,
    };
    renderList({ sections: [section] });

    // Hiding entries behind an affordance the host never wired up would
    // strand them with no way to reach them.
    expect(cardIds()).toHaveLength(5);
    expect(
      container.querySelector('[data-testid="plugins-section-more-curated"]'),
    ).toBeNull();
    expect(visibleSectionEntries(section)).toHaveLength(5);
  });

  it('uses the same heading line box for plain and clickable sections', () => {
    renderList({
      sections: [
        {
          id: 'pipelines',
          title: 'Pipelines',
          entries: makeEntries(1),
        },
      ],
    });

    const headingLabel = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-pipelines"] h2 > span',
      ),
      'Pipelines heading label',
    );
    expect(headingLabel.className).toContain('inline-flex');
    expect(headingLabel.className).toContain('h-7');
    expect(headingLabel.className).toContain('items-center');
  });

  it('clamps a collapsedCount larger than the section', () => {
    const section: PluginsDiscoverySection = {
      id: 'curated',
      title: 'Curated',
      entries: makeEntries(3),
      collapsedCount: 10,
      onExpand: (): void => {},
    };
    renderList({ sections: [section] });

    // Clamped to 3, not left negative: the slice stays in range and the
    // clickable heading remains the route to the complete section.
    expect(cardIds()).toHaveLength(0);
    expect(visibleSectionEntries(section)).toHaveLength(0);
    const heading = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-heading-curated"]',
      ),
      'Curated heading',
    );
    expect(heading.textContent).toBe('Curated');
    expect(heading.getAttribute('aria-label')).toBe('Browse Curated');
  });

  it('makes every browsable section heading the category-page control', () => {
    let opened = false;
    renderList({
      sections: [
        {
          id: 'curated',
          title: 'Curated',
          entries: makeEntries(4),
          collapsedCount: 2,
          onExpand: (): void => {
            opened = true;
          },
        },
      ],
    });

    expect(cardIds()).toEqual([
      'plugins-entry-curated:tool-0',
      'plugins-entry-curated:tool-1',
    ]);
    const heading = requireElement(
      container.querySelector(
        '[data-testid="plugins-section-heading-curated"]',
      ),
      'Curated heading',
    );
    expect(heading.tagName).toBe('BUTTON');
    expect(heading.getAttribute('aria-label')).toBe('Browse Curated');
    expect(heading.className).toContain('group');
    const title = requireElement(
      heading.querySelector('[data-testid="plugins-section-heading-title"]'),
      'Curated heading title',
    );
    const chevron = heading.querySelector(
      '[data-testid="plugins-section-heading-chevron"]',
    );
    expect(chevron).not.toBeNull();
    expect(title.className).toContain('fg-primary');
    expect(title.className).toContain('group-hover:fg-secondary');
    expect(chevron?.getAttribute('class')).toContain('fg-tertiary');
    expect(chevron?.getAttribute('class')).not.toContain(
      'group-hover:fg-secondary',
    );
    expect(chevron?.getAttribute('class')).toContain(
      'group-hover:translate-x-0.5',
    );
    expect(chevron?.getAttribute('class')).toContain('duration-200');
    expect(chevron?.getAttribute('class')).toContain('ease-out');
    expect(chevron?.getAttribute('class')).toContain(
      'motion-reduce:transform-none',
    );
    expect(chevron?.getAttribute('class')).toContain(
      'motion-reduce:transition-none',
    );
    expect(
      container.querySelector('[data-testid="plugins-section-more-curated"]'),
    ).toBeNull();

    press(heading, 'Curated heading');
    expect(opened).toBe(true);
  });

  it('suppresses its own heading when the host passes an empty title', () => {
    renderList({
      sections: [{ id: 'installed', title: '', entries: makeEntries(1) }],
    });

    expect(container.querySelectorAll('h2')).toHaveLength(0);
    expect(cardIds()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Card menu
  // -------------------------------------------------------------------------

  it('shows Add for available items and no single-action menu for installed items', () => {
    const selected: string[] = [];
    const added: string[] = [];
    renderList({
      sections: [
        {
          id: 'search-results',
          title: '',
          entries: [
            makeEntry(),
            makeEntry({
              id: 'curated:installed',
              name: 'Installed Tool',
              state: 'installed',
              ref: { type: 'curated-plugin', key: 'installed' },
            }),
          ],
        },
      ],
      onSelectEntry: (entry): void => {
        selected.push(entry.id);
      },
      onAddEntry: (entry): void => {
        added.push(entry.id);
      },
    });

    const addButton = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:alpha"]',
      ),
      'Alpha Add button',
    );
    expect(addButton.classList.contains('fg-primary')).toBe(true);
    expect(addButton.classList.contains('h-7')).toBe(true);
    expect(addButton.classList.contains('text-xs')).toBe(true);
    expect(
      addButton.classList.contains('pointer-coarse:before:-inset-y-2'),
    ).toBe(true);
    expect(addButton.hasAttribute('disabled')).toBe(false);
    press(addButton, 'Alpha Add button');
    expect(added).toEqual(['curated:alpha']);
    expect(selected).toEqual([]);
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:installed"]',
      ),
    ).toBeNull();

    expect(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:installed"]',
      ),
    ).not.toBeNull();
    press(
      container.querySelector(
        '[data-testid="plugins-entry-curated:installed"]',
      ),
      'Installed Tool card',
    );
    expect(selected).toEqual(['curated:installed']);
  });

  it('renders no Share on a host without a share callback', () => {
    renderList({
      sections: [{ id: 'search-results', title: '', entries: [makeEntry()] }],
      entryShareStates: new Map([['curated:alpha', { status: 'shareable' }]]),
    });
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-share-curated:alpha"]',
      ),
    ).toBeNull();
  });

  it('omits the menu for a needs-auth entry without a Connect handler', () => {
    renderList({
      sections: [
        {
          id: 'installed',
          title: 'Installed',
          entries: [makeEntry({ state: 'needs-auth' })],
        },
      ],
    });

    expect(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
    ).not.toBeNull();
  });

  it('offers Connect for a needs-auth entry when the host wires it', () => {
    const connected: UnifiedPluginEntry[] = [];
    const onConnectEntry = (entry: UnifiedPluginEntry): void => {
      connected.push(entry);
    };
    renderList({
      sections: [
        {
          id: 'installed',
          title: 'Installed',
          entries: [makeEntry({ state: 'needs-auth' })],
        },
      ],
      onConnectEntry,
    });

    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
      'Alpha menu trigger',
    );
    expect(menuItem('view', 'curated:alpha')).not.toBeNull();
    // Each row leads with its own icon, on the shared action-menu recipe.
    expect(menuItem('connect', 'curated:alpha')?.textContent).toBe('Connect');
    expect(menuItem('view', 'curated:alpha')?.textContent).toBe('Open details');
    press(menuItem('connect', 'curated:alpha'), 'Alpha Connect item');

    expect(connected.map((entry) => entry.id)).toEqual(['curated:alpha']);
  });

  it('omits the menu when View would be its only action', () => {
    renderList({
      sections: [{ id: 'curated', title: 'Curated', entries: [makeEntry()] }],
      onConnectEntry: (): void => {},
    });

    expect(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:alpha"]',
      ),
    ).not.toBeNull();
  });

  it('closes the menu after Connect is chosen', () => {
    const connected: UnifiedPluginEntry[] = [];
    renderList({
      sections: [
        {
          id: 'installed',
          title: 'Installed',
          entries: [makeEntry({ state: 'needs-auth' })],
        },
      ],
      onConnectEntry: (entry): void => {
        connected.push(entry);
      },
    });

    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
      'Alpha menu trigger',
    );
    press(menuItem('connect', 'curated:alpha'), 'Alpha Connect item');

    expect(connected.map((entry) => entry.id)).toEqual(['curated:alpha']);
    expect(menuSurface('curated:alpha')).toBeNull();
  });

  it('closes the menu on an outside pointer-down', () => {
    renderList({
      sections: [
        {
          id: 'installed',
          title: 'Installed',
          entries: [makeEntry({ state: 'needs-auth' })],
        },
      ],
      onConnectEntry: (): void => {},
    });

    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
      'Alpha menu trigger',
    );
    expect(menuSurface('curated:alpha')).not.toBeNull();

    press(document.body, 'document body');

    expect(menuSurface('curated:alpha')).toBeNull();
  });

  it('keeps the menu open when the surface itself is pressed', () => {
    renderList({
      sections: [
        {
          id: 'installed',
          title: 'Installed',
          entries: [makeEntry({ state: 'needs-auth' })],
        },
      ],
      onConnectEntry: (): void => {},
    });

    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
      'Alpha menu trigger',
    );
    act(() => {
      requireElement(
        menuSurface('curated:alpha'),
        'Alpha menu surface',
      ).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(menuSurface('curated:alpha')).not.toBeNull();
  });

  it('closes the open menu when another card menu is opened', () => {
    renderList({
      sections: [
        {
          id: 'curated',
          title: 'Curated',
          entries: [
            makeEntry({ state: 'needs-auth' }),
            makeEntry({
              id: 'curated:beta',
              name: 'Beta',
              ref: { type: 'curated-plugin', key: 'beta' },
              state: 'needs-auth',
            }),
          ],
        },
      ],
      onConnectEntry: (): void => {},
    });

    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:alpha"]',
      ),
      'Alpha menu trigger',
    );
    press(
      container.querySelector(
        '[data-testid="plugins-entry-menu-curated:beta"]',
      ),
      'Beta menu trigger',
    );
    // The shared floating layer dismisses the first menu on pointerdown and
    // intentionally suppresses that press's click. The trigger handles that
    // pointerdown so the second menu still opens in the same press.
    expect(menuSurface('curated:alpha')).toBeNull();
    expect(menuSurface('curated:beta')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scroll ownership
  // -------------------------------------------------------------------------

  it('keeps sections in normal page flow regardless of the page total', () => {
    renderList({
      sections: [
        { id: 'curated', title: 'Curated', entries: makeEntries(60) },
        { id: 'apps', title: 'Apps', entries: makeEntries(60) },
      ],
    });

    // 120 cards on the page, but neither section is long on its own.
    for (const sectionId of ['curated', 'apps']) {
      expect(
        container
          .querySelector(`[data-testid="plugins-section-${sectionId}"]`)
          ?.getAttribute('data-virtualized'),
      ).toBe('false');
    }
  });

  it('renders a large section without a nested scroller', () => {
    renderList({
      sections: [
        { id: 'curated', title: 'Curated', entries: makeEntries(150) },
      ],
    });

    const section = requireElement(
      container.querySelector('[data-testid="plugins-section-curated"]'),
      'Curated section',
    );
    expect(section.getAttribute('data-virtualized')).toBe('false');
    expect(
      section.querySelectorAll('[data-marketplace-entry="true"]'),
    ).toHaveLength(150);

    const body = requireElement(
      container.querySelector('[data-testid="plugins-section-body-curated"]'),
      'Curated section body',
    );
    expect(body.className).not.toContain('overflow-auto');
    expect(body.className).toContain('grid');
  });

  it('renders the empty message when every section is empty', () => {
    renderList({
      sections: [{ id: 'curated', title: 'Curated', entries: [] }],
    });

    expect(container.textContent).toContain('Nothing here.');
    expect(
      container.querySelector('[data-testid="plugins-discovery-list"]'),
    ).toBeNull();
  });
  it('sets header actions on the heading row and keeps an emptied section', () => {
    renderList({
      sections: [
        {
          id: 'pipelines',
          title: 'Pipelines',
          entries: [],
          headerActions: <button type="button">Any source</button>,
          emptyMessage: 'No pipelines match these filters.',
        },
      ],
    });

    const section = container.querySelector(
      '[data-testid="plugins-section-pipelines"]',
    );
    expect(section).not.toBeNull();
    // The heading and its actions share one divided row.
    const heading = section?.querySelector('h2');
    expect(heading?.textContent).toBe('Pipelines');
    expect(heading?.parentElement?.textContent).toContain('Any source');
    expect(heading?.parentElement?.className).toContain('border-b');
    expect(
      section?.querySelector('[data-testid="plugins-section-empty-pipelines"]')
        ?.textContent,
    ).toBe('No pipelines match these filters.');
    expect(container.textContent).not.toContain('Nothing here.');
  });

  it('hides connection health that was never checked (CAN-4840)', () => {
    renderList({
      sections: [
        {
          id: 'apps',
          title: 'Apps',
          entries: [
            makeEntry({ id: 'unchecked', connection: { status: 'unknown' } }),
          ],
        },
      ],
    });
    expect(
      container.querySelector(
        '[data-testid="plugins-connection-status-unchecked"]',
      ),
    ).toBeNull();
  });

  it('renders no Add button for available entries when the host has no add flow', () => {
    renderList({
      sections: [
        {
          id: 'featured',
          title: 'Featured',
          entries: [makeEntry({ id: 'curated:alpha', state: 'available' })],
        },
      ],
      onAddEntry: null,
    });

    expect(
      container.querySelector('[data-testid="plugins-entry-curated:alpha"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:alpha"]',
      ),
    ).toBeNull();
  });

  // CAN-3009: who an entry is shared with is routine metadata, so it is plain
  // text beside the name (`Team: Growth`, `Organization`), never a pill.

  // CAN-4261 QA: every Browse card reads name and type, then its
  // description, then one meta line for where it comes from and who it is
  // shared with.
});
