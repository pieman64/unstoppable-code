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
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
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
    showPipelineSources?: boolean;
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
    showPipelineSources,
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
          showPipelineSources={showPipelineSources}
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

  it('blocks local agent prompt subtitles from replay without blocking card controls', () => {
    const entry = makeEntry({
      id: 'agent:local:private',
      kind: 'agent',
      origin: 'installed-standalone',
      description: 'Private instructions for this agent.',
      ref: { type: 'local-agent', agentId: 'private' },
    });
    const publicEntry = makeEntry();
    renderList({
      sections: [
        { id: 'agents', title: 'Agents', entries: [entry] },
        { id: 'curated', title: 'Plugins', entries: [publicEntry] },
      ],
    });
    const subtitle = container.querySelector(
      `[data-testid="plugins-card-subtitle-${entry.id}"]`,
    );
    expect(subtitle?.textContent).toBe(entry.description);
    expect(subtitle?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      subtitle?.parentElement?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      container
        .querySelector(
          `[data-testid="plugins-card-subtitle-${publicEntry.id}"]`,
        )
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(false);
  });

  it('puts every row action in one trailing slot of the same width', () => {
    // A Share icon and an Add button line up down the column rather than
    // sitting at different x positions per row.
    const owned = makeEntry({
      id: 'agent:local:reviewer',
      kind: 'agent',
      name: 'Reviewer',
      state: 'installed',
      ref: { type: 'local-agent', agentId: 'reviewer' },
    });
    const available = makeEntry();
    renderList({
      sections: [
        { id: 'agents', title: 'Agents', entries: [owned, available] },
      ],
      entryShareStates: new Map([
        [owned.id, { status: 'shareable', onShare: (): void => {} }],
      ]),
      onShareEntry: (): void => {},
    });
    const ownedSlot = container.querySelector(
      `[data-testid="plugins-card-actions-${owned.id}"]`,
    );
    const availableSlot = container.querySelector(
      `[data-testid="plugins-card-actions-${available.id}"]`,
    );
    expect(
      ownedSlot?.querySelector(
        `[data-testid="plugins-entry-share-${owned.id}"]`,
      ),
    ).not.toBeNull();
    expect(
      availableSlot?.querySelector(
        `[data-testid="plugins-entry-add-${available.id}"]`,
      ),
    ).not.toBeNull();
    expect(ownedSlot?.className).toBe(availableSlot?.className);
    expect(ownedSlot?.classList.contains('min-w-16')).toBe(true);
    expect(ownedSlot?.classList.contains('justify-center')).toBe(true);
  });

  it('shows the MCP restriction on a disabled collection Share action', () => {
    const entry = makeEntry({
      id: 'collection:abc',
      kind: 'collection',
      components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
      ref: { type: 'local-collection', collectionId: 'abc' },
    });
    const onShare = jest.fn();
    const state = collectionShareBlockedState(entry);
    if (!state) throw new Error('Expected a blocked collection state');
    renderList({
      sections: [{ id: 'collections', title: 'Collections', entries: [entry] }],
      entryShareStates: new Map([[entry.id, state]]),
      onShareEntry: onShare,
    });
    const button = container.querySelector(
      `[data-testid="plugins-entry-share-${entry.id}"]`,
    );
    expect(button).not.toBeNull();
    // Focusable, so a keyboard user can reach the explanation.
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-description')).toBe(
      'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
    );
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShare).not.toHaveBeenCalled();
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
      `[data-testid="plugins-entry-menu-surface-${entryId}"]`,
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

  it('keeps discovery cards to title and description without a metadata line', () => {
    renderList({
      sections: [
        {
          id: 'curated',
          title: 'Curated',
          entries: [
            makeEntry({
              typeLabel: 'Plugin',
              sourceLabel: 'Codex official',
              ownershipLabel: 'OpenAI',
              availabilityLabel: 'Available',
            }),
          ],
        },
      ],
    });

    const card = requireElement(
      container.querySelector('[data-testid="plugins-entry-curated:alpha"]'),
      'Alpha card',
    );
    expect(card.textContent).toContain('Alpha');
    expect(card.textContent).toContain('An alpha plugin.');
    expect(card.textContent).not.toContain('Codex official');
    expect(card.textContent).not.toContain('OpenAI');
    expect(card.textContent).not.toContain('Available');
    expect(card.className).toContain('gap-4');
    expect(card.className).not.toContain('gap-3');
  });

  it('uses concise card subtitles without shortening detail copy', () => {
    renderList({
      sections: [
        {
          id: 'featured',
          title: 'Featured',
          entries: [
            makeEntry({
              id: 'mkt:openai-curated/github',
              name: 'GitHub',
              description:
                'Inspect repositories, triage pull requests and issues, debug continuous integration, and publish release workflows.',
              ref: {
                type: 'marketplace-plugin',
                marketplaceId: 'openai-curated',
                pluginName: 'github',
              },
            }),
            makeEntry({
              id: 'curated:long-copy',
              name: 'Long Copy',
              description:
                'Search company documents and prepare polished reports for busy operations teams.',
              ref: { type: 'curated-plugin', key: 'long-copy' },
            }),
          ],
        },
      ],
    });

    const githubCopy = requireElement(
      container.querySelector(
        '[data-testid="plugins-card-copy-mkt:openai-curated/github"]',
      ),
      'GitHub card copy',
    );
    const genericCopy = requireElement(
      container.querySelector(
        '[data-testid="plugins-card-copy-curated:long-copy"]',
      ),
      'generic card copy',
    );

    expect(githubCopy.textContent).toContain(
      'Triage PRs, issues, CI, and release workflows',
    );
    expect(githubCopy.textContent).not.toContain('Inspect repositories');
    expect(genericCopy.textContent).toContain(
      'Search company documents and prepare polished reports',
    );
    expect(genericCopy.textContent).not.toContain('busy operations teams');
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
      `[data-testid="plugins-menu-${action}-${entryId}"]`,
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

  it('says which skills an integration card includes (REG-3033)', () => {
    renderList({
      sections: [
        {
          id: 'suggested',
          title: 'Suggested',
          entries: [
            makeEntry({
              id: 'mcp-catalog:linear',
              kind: 'app',
              name: 'Linear',
              ref: { type: 'curated-mcp', key: 'linear' },
              integration: {
                curatedKey: 'linear',
                plugin: {
                  key: 'linear',
                  name: 'Linear',
                  skills: 2,
                  installed: false,
                },
                connections: [],
              },
            }),
          ],
        },
      ],
    });
    expect(
      container.querySelector(
        '[data-testid="plugins-includes-mcp-catalog:linear"]',
      )?.textContent,
    ).toBe('Includes Linear skills');
  });

  it('links each integration a multi-connection plugin needs to its card (REG-3033)', () => {
    const onOpenEntryId = jest.fn<void, [string]>();
    renderList({
      onOpenEntryId,
      sections: [
        {
          id: 'suggested',
          title: 'Suggested',
          entries: [
            makeEntry({
              id: 'curated:release-notes',
              name: 'Release Notes',
              ref: { type: 'curated-plugin', key: 'release-notes' },
              requirements: [
                {
                  key: 'linear',
                  name: 'Linear',
                  entryId: 'mcp-catalog:linear',
                },
                { key: 'jira', name: 'Jira', entryId: 'mcp-catalog:jira' },
              ],
            }),
          ],
        },
      ],
    });
    const chips = Array.from(
      container.querySelectorAll(
        '[data-testid^="plugins-requirement-curated:release-notes-"]',
      ),
    );
    expect(chips.map((chip) => chip.textContent)).toEqual(['Linear', 'Jira']);
    // The chips are controls of their own, never nested inside the card's
    // primary control: nested interactive content is invalid HTML and reads
    // as one control to assistive technology.
    for (const chip of chips) {
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.closest('[data-marketplace-entry="true"]')).toBeNull();
    }
    press(chips[1] ?? null, 'Jira requirement chip');
    expect(onOpenEntryId).toHaveBeenCalledWith('mcp-catalog:jira');
  });

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
    ).toBeNull();
    press(
      container.querySelector(
        '[data-testid="plugins-entry-curated:installed"]',
      ),
      'Installed Tool card',
    );
    expect(selected).toEqual(['curated:installed']);
  });

  it('shows an icon share action only for entries with a share state', () => {
    const shared: string[] = [];
    renderList({
      sections: [
        {
          id: 'search-results',
          title: '',
          entries: [
            makeEntry({ state: 'available' }),
            makeEntry({ id: 'curated:other' }),
          ],
        },
      ],
      entryShareStates: new Map([['curated:alpha', { status: 'shareable' }]]),
      onShareEntry: (entry): void => {
        shared.push(entry.id);
      },
    });

    const shareButton = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-share-curated:alpha"]',
      ),
      'Alpha share button',
    );
    expect(shareButton.getAttribute('aria-label')).toBe('Share Alpha');
    expect(shareButton.textContent).toBe('');
    // The one share glyph, the share nodes, not the arrow-out-of-box upload.
    expect(shareButton.innerHTML).toContain('data-glyph="share-2"');
    expect(shareButton.innerHTML).not.toContain('data-glyph="upload"');
    // Share and Add sit 8px apart (gap-2), up from 4.
    const addButton = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-add-curated:alpha"]',
      ),
      'Alpha add button',
    );
    expect(addButton.parentElement?.className ?? '').toContain('gap-2');
    expect(addButton.parentElement?.className ?? '').not.toMatch(/\bgap-1\b/);
    press(shareButton, 'Alpha share button');
    expect(shared).toEqual(['curated:alpha']);
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-share-curated:other"]',
      ),
    ).toBeNull();
  });

  it('shows a blocked Share with its reason without sharing, selecting or adding', () => {
    const shared: string[] = [];
    const selected: string[] = [];
    const added: string[] = [];
    const reason = 'MCP server connections cannot be shared.';
    renderList({
      sections: [
        {
          id: 'search-results',
          title: '',
          entries: [
            makeEntry({ state: 'available' }),
            makeEntry({ id: 'curated:installed', state: 'installed' }),
          ],
        },
      ],
      entryShareStates: new Map([
        ['curated:alpha', { status: 'blocked', reason }],
        ['curated:installed', { status: 'shareable' }],
      ]),
      onSelectEntry: (entry): void => {
        selected.push(entry.id);
      },
      onAddEntry: (entry): void => {
        added.push(entry.id);
      },
      onShareEntry: (entry): void => {
        shared.push(entry.id);
      },
    });

    const blocked = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-share-curated:alpha"]',
      ),
      'Alpha share button',
    );
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.getAttribute('aria-description')).toBe(reason);
    expect(blocked.hasAttribute('disabled')).toBe(false);
    // Share sits immediately before Add in the one action group.
    const actionGroup = requireElement(
      container.querySelector('[data-testid="plugins-entry-add-curated:alpha"]')
        ?.parentElement ?? null,
      'Alpha action group',
    );
    expect(actionGroup.contains(blocked)).toBe(true);
    press(blocked, 'Alpha share button');
    expect(shared).toEqual([]);
    expect(selected).toEqual([]);
    expect(added).toEqual([]);

    // Installation state does not hide Share.
    const installed = requireElement(
      container.querySelector(
        '[data-testid="plugins-entry-share-curated:installed"]',
      ),
      'Installed share button',
    );
    press(installed, 'Installed share button');
    expect(shared).toEqual(['curated:installed']);
    expect(selected).toEqual([]);
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
    ).toBeNull();
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
    expect(
      menuItem('connect', 'curated:alpha')?.querySelector('svg'),
    ).not.toBeNull();
    expect(
      menuItem('view', 'curated:alpha')?.querySelector('svg'),
    ).not.toBeNull();
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
    ).toBeNull();
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
  it('shows explicit pipeline source badges only when the host opts in', () => {
    const sources = ['Curated', 'Shared', 'Local', 'Built-in', 'Project'];
    const sections: PluginsDiscoverySection[] = [
      {
        id: 'pipelines',
        title: 'Pipelines',
        entries: sources.map((sourceLabel, index) =>
          makeEntry({
            id: `pipeline-${index}`,
            name: `Workflow ${index}`,
            kind: 'pipeline',
            sourceLabel,
          }),
        ),
      },
    ];
    renderList({ sections, showPipelineSources: true });
    sources.forEach((label, index) => {
      expect(
        container.querySelector(
          `[data-testid="plugins-pipeline-source-pipeline-${index}"]`,
        )?.textContent,
      ).toBe(label);
    });
    renderList({ sections });
    expect(
      container.querySelectorAll('[data-testid^="plugins-pipeline-source-"]'),
    ).toHaveLength(0);
  });
  it('labels where an MCP entry runs next to its state badge', () => {
    renderList({
      sections: [
        {
          id: 'apps',
          title: 'Apps',
          entries: [
            makeEntry({ id: 'cloud', surface: 'cloud', state: 'needs-auth' }),
            makeEntry({ id: 'desktop', surface: 'desktop' }),
            makeEntry({ id: 'plain' }),
          ],
        },
      ],
    });
    const badge = (id: string): string | null | undefined =>
      container.querySelector(`[data-testid="plugins-surface-${id}"]`)
        ?.textContent;
    expect(badge('cloud')).toBe('Cloud + desktop');
    expect(badge('desktop')).toBe('Desktop only');
    expect(badge('plain')).toBeUndefined();
    expect(
      container.querySelector('[data-testid="plugins-surface-cloud"]')
        ?.previousElementSibling?.textContent,
    ).toBe('Needs attention');
  });

  it("shows an MCP entry's connection status in place of the state badge (CAN-4265)", () => {
    renderList({
      sections: [
        {
          id: 'apps',
          title: 'Apps',
          entries: [
            makeEntry({
              id: 'mcp',
              state: 'needs-auth',
              connection: { status: 'auth_required' },
            }),
            makeEntry({
              id: 'provider',
              connection: { status: 'connected', provider: true },
            }),
            makeEntry({ id: 'plugin', state: 'needs-auth' }),
          ],
        },
      ],
    });
    const status = (id: string): string | null | undefined =>
      container.querySelector(`[data-testid="plugins-connection-status-${id}"]`)
        ?.textContent;
    expect(status('mcp')).toBe('Auth required');
    expect(
      container.querySelector('[data-testid="plugins-entry-mcp"]')?.textContent,
    ).not.toContain('Needs attention');
    expect(status('provider')).toBe('Connected');
    expect(
      container.querySelector(
        '[data-testid="plugins-connection-provider-provider"]',
      )?.textContent,
    ).toBe('Agent provider');
    expect(status('plugin')).toBeUndefined();
    expect(
      container.querySelector('[data-testid="plugins-entry-plugin"]')
        ?.textContent,
    ).toContain('Needs attention');
  });

  it('badges only the installed entries whose source has changed', () => {
    renderList({
      sections: [
        {
          id: 'automations',
          title: 'Automations',
          entries: [
            makeEntry({
              id: 'automation:local:stale',
              kind: 'automation',
              state: 'installed',
              updateAvailable: true,
              ref: { type: 'automation', activityId: 'stale' },
            }),
            makeEntry({
              id: 'automation:local:current',
              kind: 'automation',
              state: 'installed',
              ref: { type: 'automation', activityId: 'current' },
            }),
          ],
        },
      ],
    });

    expect(
      container.querySelector(
        '[data-testid="plugins-update-available-automation:local:stale"]',
      )?.textContent,
    ).toBe('Update available');
    expect(
      container.querySelector(
        '[data-testid="plugins-update-available-automation:local:current"]',
      ),
    ).toBeNull();
    // An installed automation is opened, never added again.
    expect(
      container.querySelector(
        '[data-testid="plugins-entry-add-automation:local:stale"]',
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
  it('names the team or organization a shared entry is shared with as plain text', () => {
    renderList({
      sections: [
        {
          id: 'skills',
          title: 'Shared skills',
          entries: [
            makeEntry({
              id: 'skill:shared:one',
              kind: 'skill',
              origin: 'shared',
              sharedWith: { audience: 'team', name: 'Growth' },
            }),
            makeEntry({
              id: 'skill:shared:two',
              kind: 'skill',
              origin: 'shared',
              sharedWith: { audience: 'organization', name: 'Acme' },
            }),
            makeEntry({ id: 'skill:shared:three', kind: 'skill' }),
          ],
        },
      ],
    });

    const team = requireElement(
      container.querySelector(
        '[data-testid="plugins-card-shared-with-skill:shared:one"]',
      ),
      'team label',
    );
    expect(team.textContent).toBe('Team: Growth');
    expect(team.className).not.toMatch(/\b(bg-|ring-|rounded|border)/);
    expect(
      container.querySelector(
        '[data-testid="plugins-card-shared-with-skill:shared:two"]',
      )?.textContent,
    ).toBe('Organization');
    expect(
      container.querySelector(
        '[data-testid="plugins-card-shared-with-skill:shared:three"]',
      ),
    ).toBeNull();
  });

  it('names an entry type only in a section that mixes kinds', () => {
    const entries = [
      makeEntry({ id: 'skill:one', kind: 'skill', typeLabel: 'Skill' }),
      makeEntry({ id: 'agent:one', kind: 'agent', typeLabel: 'Agent' }),
    ];
    renderList({
      sections: [
        { id: 'search-results', title: '', entries, showEntryTypes: true },
      ],
    });
    expect(
      container.querySelector('[data-testid="plugins-card-type-skill:one"]')
        ?.textContent,
    ).toBe('Skill');
    expect(
      container.querySelector('[data-testid="plugins-card-type-agent:one"]')
        ?.textContent,
    ).toBe('Agent');

    renderList({ sections: [{ id: 'skills', title: 'Skills', entries }] });
    expect(
      container.querySelector('[data-testid^="plugins-card-type-"]'),
    ).toBeNull();
  });
});
