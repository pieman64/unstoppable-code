import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import {
  appendEnableRef,
  buildSlashInventoryCommands,
  flattenCollectionRefs,
  inventoryRowNeedsResolution,
  runInventorySelection,
} from '../slashInvocableInventory';

function makeEntry(
  overrides: Partial<InvocableInventoryEntry> & { name: string },
): InvocableInventoryEntry {
  const { name } = overrides;
  return {
    id: overrides.id ?? `id:${name}`,
    provider: overrides.provider ?? 'claude',
    kind: overrides.kind ?? 'skill',
    name,
    displayName: overrides.displayName ?? `/${name}`,
    description: overrides.description ?? `${name} description`,
    insertText: overrides.insertText ?? `/${name} `,
    invocationKey: overrides.invocationKey ?? `claude:${name}`,
    enableRef:
      overrides.enableRef ??
      ({ kind: 'skill', sourceId: 'src-1', skillName: name } as const),
    ...(overrides.sourceName ? { sourceName: overrides.sourceName } : {}),
    ...(overrides.requiresCodexCompatPrepare
      ? { requiresCodexCompatPrepare: overrides.requiresCodexCompatPrepare }
      : {}),
    ...(overrides.sourceLabel ? { sourceLabel: overrides.sourceLabel } : {}),
  };
}

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

describe('buildSlashInventoryCommands', () => {
  it('emits available rows for installed-but-disabled entries', () => {
    const entry = makeEntry({ name: 'alpha' });
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(result.availableInventoryCommands).toHaveLength(1);
    const row = result.availableInventoryCommands[0];
    expect(row.section).toBe('available');
    expect(row.inventoryEntry).toBe(entry);
    expect(row.data).toBe(entry);
    expect(row.displayName).toBe('/alpha');
  });

  it('treats an inherited row as enabled and promotes it under the discovered rows', () => {
    const entry = makeEntry({
      name: 'review',
      provider: 'cursor',
      kind: 'inherited_skill',
      invocationKey: '/review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(result.availableInventoryCommands).toEqual([]);
    expect(result.promotedInventoryCommands).toHaveLength(1);
    expect(result.promotedInventoryCommands[0]).toMatchObject({
      section: 'discovered',
      displayName: '/review',
      insertText: '/review ',
      category: '~/.claude/skills',
    });
  });

  it('promotes a selected Canopy skill ahead of an inherited row with the same name, so the pick stays reachable', () => {
    // The chat root gives the pick the base id and the inherited copy the
    // suffix; the menu must not let the inherited row claim the name first.
    const inherited = makeEntry({
      id: 'cursor:inherited_skill:claude:review',
      name: 'review',
      provider: 'cursor',
      kind: 'inherited_skill',
      invocationKey: '/review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    const canopy = makeEntry({
      id: 'cursor:skill:custom:review',
      name: 'review',
      provider: 'cursor',
      invocationKey: '/review',
      enableRef: { kind: 'skill', sourceId: 'custom', skillName: 'review' },
      sourceLabel: 'Custom',
    });
    const result = buildSlashInventoryCommands({
      entries: [inherited, canopy],
      discoveredCommands: [],
      selections: {
        ...emptySelections(),
        skillRefs: [{ sourceId: 'custom', skillName: 'review' }],
      },
      isDiscovering: false,
    });

    expect(
      result.promotedInventoryCommands.map(
        (command) => command.inventoryEntry?.id,
      ),
    ).toEqual(['cursor:skill:custom:review']);
    expect(result.availableInventoryCommands).toEqual([]);
  });

  it('keeps two inherited rows that share a name but not an invocation key', () => {
    // Two cached plugins each ship `brainstorming`; the inventory already
    // gave the second its own id, so both are separately invocable.
    const first = makeEntry({
      id: 'cursor:inherited_skill:cursor-plugin:a:brainstorming',
      name: 'brainstorming',
      provider: 'cursor',
      kind: 'inherited_skill',
      invocationKey: '/brainstorming',
      insertText: '/brainstorming ',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.cursor/plugins/cursor-public/a',
    });
    const second = makeEntry({
      id: 'cursor:inherited_skill:cursor-plugin:b:brainstorming',
      name: 'brainstorming',
      provider: 'cursor',
      kind: 'inherited_skill',
      displayName: '/brainstorming-1',
      invocationKey: '/brainstorming-1',
      insertText: '/brainstorming-1 ',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.cursor/plugins/cursor-public/b',
    });
    const result = buildSlashInventoryCommands({
      entries: [first, second],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(
      result.promotedInventoryCommands.map((command) => command.insertText),
    ).toEqual(['/brainstorming ', '/brainstorming-1 ']);
  });

  it('hides an inherited row once the CLI itself advertises the same name', () => {
    const entry = makeEntry({
      name: 'review',
      provider: 'cursor',
      kind: 'inherited_skill',
      enableRef: { kind: 'none' },
    });
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [
        { name: 'review', description: 'review skill', insertText: '/review ' },
      ],
      selections: emptySelections(),
      isDiscovering: false,
    });
    expect(result.promotedInventoryCommands).toEqual([]);
    expect(result.availableInventoryCommands).toEqual([]);
  });

  it('promotes already-selected skill refs into discovered rows', () => {
    const entry = makeEntry({
      name: 'alpha',
      enableRef: { kind: 'skill', sourceId: 'src-1', skillName: 'alpha' },
    });
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [],
      selections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'src-1', skillName: 'alpha' }],
        pluginRefs: [],
      },
      isDiscovering: false,
    });

    expect(result.discoveredCommands).toHaveLength(0);
    expect(result.promotedInventoryCommands).toHaveLength(1);
    expect(result.promotedInventoryCommands[0]).toMatchObject({
      name: 'alpha',
      displayName: '/alpha',
      insertText: '/alpha ',
      section: 'discovered',
    });
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('promotes already-selected plugin refs (all rows backed by that plugin)', () => {
    const skillRow = makeEntry({
      name: 'plugin-skill',
      kind: 'plugin_skill',
      enableRef: { kind: 'plugin', marketplaceId: 'mkt', pluginName: 'pl' },
    });
    const commandRow = makeEntry({
      name: 'plugin-cmd',
      kind: 'plugin_command',
      enableRef: { kind: 'plugin', marketplaceId: 'mkt', pluginName: 'pl' },
    });
    const result = buildSlashInventoryCommands({
      entries: [skillRow, commandRow],
      discoveredCommands: [],
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'pl' }],
      },
      isDiscovering: false,
    });

    expect(result.promotedInventoryCommands.map((cmd) => cmd.name)).toEqual([
      'plugin-cmd',
      'plugin-skill',
    ]);
    expect(result.promotedInventoryCommands.map((cmd) => cmd.section)).toEqual([
      'discovered',
      'discovered',
    ]);
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('promotes refs contained in a selected Collection', () => {
    const skillEntry = makeEntry({
      name: 'alpha',
      enableRef: { kind: 'skill', sourceId: 'src-1', skillName: 'alpha' },
    });
    const pluginEntry = makeEntry({
      name: 'beta',
      kind: 'plugin_skill',
      enableRef: { kind: 'plugin', marketplaceId: 'mkt', pluginName: 'pl' },
    });
    const result = buildSlashInventoryCommands({
      entries: [skillEntry, pluginEntry],
      discoveredCommands: [],
      selections: { collectionIds: ['col-1'], skillRefs: [], pluginRefs: [] },
      collectionRefs: {
        skillRefs: [{ sourceId: 'src-1', skillName: 'alpha' }],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'pl' }],
      },
      isDiscovering: false,
    });

    expect(result.promotedInventoryCommands.map((cmd) => cmd.name)).toEqual([
      'beta',
      'alpha',
    ]);
    expect(result.promotedInventoryCommands.map((cmd) => cmd.section)).toEqual([
      'discovered',
      'discovered',
    ]);
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('lets discovered rows win on a name collision', () => {
    const entry = makeEntry({ name: 'shared', insertText: '/shared ' });
    const discovered: SlashCommandData[] = [
      { name: 'shared', description: 'discovered', insertText: '/shared ' },
    ];
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: discovered,
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(result.discoveredCommands).toBe(discovered);
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('lets discovered rows win on an insert-text collision', () => {
    const entry = makeEntry({
      name: 'aliased',
      insertText: '/canonical ',
    });
    const discovered: SlashCommandData[] = [
      {
        name: 'canonical',
        description: 'discovered',
        insertText: '/canonical ',
      },
    ];
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: discovered,
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('lets Claude discovered plugin-prefixed rows win over short inventory names', () => {
    const entry = makeEntry({
      name: 'channel-digest',
      displayName: '/slack:channel-digest',
      insertText: '/slack:channel-digest ',
      invocationKey: '/slack:channel-digest',
    });
    const discovered: SlashCommandData[] = [
      {
        name: 'slack:channel-digest',
        description: 'discovered by Claude',
      },
    ];
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: discovered,
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(result.discoveredCommands).toBe(discovered);
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('lets Claude synthetic selected-skill rows win over enabled inventory fallbacks', () => {
    const entry = makeEntry({
      name: 'release-check',
      enableRef: {
        kind: 'skill',
        sourceId: 'custom:app',
        skillName: 'release-check',
      },
    });
    const discovered: SlashCommandData[] = [
      {
        name: 'example-chat-skills:release-check',
        description: 'discovered from the selected-skills plugin',
      },
    ];
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: discovered,
      selections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'release-check' }],
        pluginRefs: [],
      },
      isDiscovering: false,
    });

    expect(result.discoveredCommands).toBe(discovered);
    expect(result.promotedInventoryCommands).toHaveLength(0);
    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  describe('verified plugin member identity', () => {
    const owner = {
      marketplaceId: 'unstoppable-domains-plugins',
      pluginName: 'ud-ecom-debugger',
    };

    it.each(['investigate', 'ecom-debugger'])(
      'keeps the canonical discovered %s command across available, direct and Collection states',
      (name) => {
        const entry = makeEntry({
          name,
          kind: 'plugin_command',
          invocationKey: `/${name}`,
          enableRef: { kind: 'plugin', ...owner },
        });
        const canonical: SlashCommandData = {
          name: `${owner.pluginName}:${name}`,
          description: 'real SDK description',
          insertText: `/${owner.pluginName}:${name} `,
        };
        const discovered = [canonical];
        const direct: ChatTabPluginSelections = {
          ...emptySelections(),
          pluginRefs: [owner],
        };
        const states = [
          { selections: emptySelections() },
          { selections: direct },
          {
            selections: { ...emptySelections(), collectionIds: ['selected'] },
            collectionRefs: { skillRefs: [], pluginRefs: [owner] },
          },
        ];
        for (const state of states) {
          const result = buildSlashInventoryCommands({
            entries: [entry],
            discoveredCommands: discovered,
            ...state,
            isDiscovering: false,
          });
          expect(result.discoveredCommands).toBe(discovered);
          expect(result.discoveredCommands[0]).toBe(canonical);
          expect(result.promotedInventoryCommands).toEqual([]);
          expect(result.availableInventoryCommands).toEqual([]);
          expect(canonical.insertText).toBe(`/${owner.pluginName}:${name} `);
        }
      },
    );

    it('qualifies inventory command labels without rewriting insertion or resolution metadata', () => {
      const entry = makeEntry({
        name: 'investigate',
        kind: 'plugin_command',
        invocationKey: '/investigate',
        enableRef: { kind: 'plugin', ...owner },
      });
      for (const enabled of [false, true]) {
        const result = buildSlashInventoryCommands({
          entries: [entry],
          discoveredCommands: [],
          selections: {
            ...emptySelections(),
            pluginRefs: enabled ? [owner] : [],
          },
          isDiscovering: false,
        });
        const rows = enabled
          ? result.promotedInventoryCommands
          : result.availableInventoryCommands;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          displayName: '/ud-ecom-debugger:investigate',
          insertText: '/investigate ',
          section: enabled ? 'discovered' : 'available',
        });
        expect(rows[0].inventoryEntry).toBe(entry);
        expect(rows[0].data).toBe(entry);
        expect(entry.displayName).toBe('/investigate');
        expect(entry.invocationKey).toBe('/investigate');
      }
    });

    it.each(['plugin_skill', 'plugin_command'] as const)(
      'preserves ambiguous marketplace owners for %s',
      (kind) => {
        const entries = ['market-a', 'market-b'].map((marketplaceId) =>
          makeEntry({
            name: 'investigate',
            kind,
            invocationKey: '/investigate',
            enableRef: { kind: 'plugin', ...owner, marketplaceId },
          }),
        );
        const result = buildSlashInventoryCommands({
          entries,
          discoveredCommands: [
            { name: 'ud-ecom-debugger:investigate', description: 'SDK' },
          ],
          selections: emptySelections(),
          isDiscovering: false,
        });
        expect(
          result.availableInventoryCommands.map((row) => row.inventoryEntry),
        ).toEqual(entries);
      },
    );

    it.each(['plugin_skill', 'plugin_command'] as const)(
      'does not claim a different plugin or an unqualified SDK token for %s',
      (kind) => {
        const entries = ['ud-ecom-debugger', 'other-plugin'].map((pluginName) =>
          makeEntry({
            name: 'investigate',
            kind,
            invocationKey: '/investigate',
            enableRef: { kind: 'plugin', ...owner, pluginName },
          }),
        );
        for (const token of ['ud-ecom-debugger:investigate', 'investigate']) {
          const result = buildSlashInventoryCommands({
            entries,
            discoveredCommands: [{ name: token, description: 'SDK' }],
            selections: emptySelections(),
            isDiscovering: false,
          });
          const expected = token.includes(':')
            ? [entries[1]]
            : [entries[1], entries[0]];
          expect(
            result.availableInventoryCommands.map((row) => row.inventoryEntry),
          ).toEqual(expected);
        }
      },
    );
  });

  it('keeps distinct plugin commands with the same provisional invocation', () => {
    // Provisional invocation spelling does not prove equal plugin ownership.
    const first = makeEntry({
      name: 'dup',
      kind: 'plugin_command',
      insertText: '/dup ',
      invocationKey: 'claude:command:dup',
      enableRef: { kind: 'plugin', marketplaceId: 'm1', pluginName: 'p1' },
    });
    const second = makeEntry({
      name: 'dup',
      kind: 'plugin_command',
      insertText: '/dup ',
      invocationKey: 'claude:command:dup',
      enableRef: { kind: 'plugin', marketplaceId: 'm2', pluginName: 'p2' },
    });
    const result = buildSlashInventoryCommands({
      entries: [first, second],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: false,
    });

    expect(
      result.availableInventoryCommands.map((row) => row.inventoryEntry),
    ).toEqual([first, second]);
  });

  it('keeps a disabled command from another plugin beside an enabled command', () => {
    const disabled = makeEntry({
      name: 'shared',
      kind: 'plugin_command',
      insertText: '/shared ',
      invocationKey: 'claude:command:shared',
      enableRef: { kind: 'plugin', marketplaceId: 'm1', pluginName: 'p1' },
    });
    const enabled = makeEntry({
      name: 'shared',
      kind: 'plugin_command',
      insertText: '/shared ',
      invocationKey: 'claude:command:shared',
      enableRef: { kind: 'plugin', marketplaceId: 'm2', pluginName: 'p2' },
    });
    const result = buildSlashInventoryCommands({
      entries: [disabled, enabled],
      discoveredCommands: [],
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'm2', pluginName: 'p2' }],
      },
      isDiscovering: false,
    });

    expect(result.promotedInventoryCommands.map((cmd) => cmd.name)).toEqual([
      'shared',
    ]);
    expect(
      result.availableInventoryCommands.map((row) => row.inventoryEntry),
    ).toEqual([disabled]);
  });

  it('hides inventory rows while discovery is loading', () => {
    const entry = makeEntry({ name: 'alpha' });
    const result = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: true,
    });

    expect(result.availableInventoryCommands).toHaveLength(0);
  });

  it('returns the discovered list untouched for the popup surface', () => {
    const discovered: SlashCommandData[] = [
      { name: 'discovered-1', description: 'one' },
      { name: 'discovered-2', description: 'two' },
    ];
    const result = buildSlashInventoryCommands({
      entries: [makeEntry({ name: 'available-1' })],
      discoveredCommands: discovered,
      selections: emptySelections(),
      isDiscovering: false,
    });

    // The discovered-only list (used for CommandsPopup) carries no available rows.
    expect(result.discoveredCommands).toBe(discovered);
    expect(
      result.discoveredCommands.some((cmd) => cmd.section === 'available'),
    ).toBe(false);
  });

  it('keeps promoted inventory rows out of the popup surface', () => {
    const discovered: SlashCommandData[] = [
      { name: 'discovered-1', description: 'one' },
    ];
    const result = buildSlashInventoryCommands({
      entries: [
        makeEntry({
          name: 'selected',
          enableRef: {
            kind: 'skill',
            sourceId: 'src-1',
            skillName: 'selected',
          },
        }),
      ],
      discoveredCommands: discovered,
      selections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'src-1', skillName: 'selected' }],
        pluginRefs: [],
      },
      isDiscovering: false,
    });

    expect(result.discoveredCommands).toBe(discovered);
    expect(result.promotedInventoryCommands).toHaveLength(1);
  });

  it('carries the source label into the muted category slot', () => {
    const entry = makeEntry({ name: 'alpha', sourceLabel: 'my-plugin' });
    const [row] = buildSlashInventoryCommands({
      entries: [entry],
      discoveredCommands: [],
      selections: emptySelections(),
      isDiscovering: false,
    }).availableInventoryCommands;

    expect(row.category).toBe('my-plugin');
  });
});

describe('appendEnableRef', () => {
  it('appends a skill ref with the plugin-picker shape (no kind)', () => {
    const next = appendEnableRef(emptySelections(), {
      kind: 'skill',
      sourceId: 'src-1',
      skillName: 'alpha',
    });
    expect(next.skillRefs).toEqual([{ sourceId: 'src-1', skillName: 'alpha' }]);
    expect(next.pluginRefs).toEqual([]);
  });

  it('appends a plugin ref with the plugin-picker shape (no kind)', () => {
    const next = appendEnableRef(emptySelections(), {
      kind: 'plugin',
      marketplaceId: 'mkt',
      pluginName: 'pl',
    });
    expect(next.pluginRefs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'pl' },
    ]);
  });

  it('does not duplicate an already-present ref', () => {
    const base: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'src-1', skillName: 'alpha' }],
      pluginRefs: [],
    };
    const next = appendEnableRef(base, {
      kind: 'skill',
      sourceId: 'src-1',
      skillName: 'alpha',
    });
    expect(next.skillRefs).toHaveLength(1);
  });

  it('preserves unrelated selection fields and appends the candidate last', () => {
    const base: ChatTabPluginSelections = {
      collectionIds: ['col-1'],
      skillRefs: [{ sourceId: 'src-0', skillName: 'existing' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
    };
    const next = appendEnableRef(base, {
      kind: 'skill',
      sourceId: 'src-1',
      skillName: 'alpha',
    });
    expect(next.collectionIds).toEqual(['col-1']);
    expect(next.mcpServerRefs).toEqual([{ serverId: 'srv', configId: 'cfg' }]);
    expect(next.skillRefs).toEqual([
      { sourceId: 'src-0', skillName: 'existing' },
      { sourceId: 'src-1', skillName: 'alpha' },
    ]);
    // The original selections are not mutated.
    expect(base.skillRefs).toHaveLength(1);
  });
});

describe('flattenCollectionRefs', () => {
  it('flattens skills and plugins and skips null configs', () => {
    const config: CollectionConfig = {
      id: 'col-1',
      name: 'Col',
      description: '',
      skills: [{ sourceId: 'src-1', skillName: 'alpha' }],
      plugins: [{ marketplaceId: 'mkt', pluginName: 'pl' }],
      mcpServers: [],
      createdAt: '',
      updatedAt: '',
    };
    const flattened = flattenCollectionRefs([config, null, undefined]);
    expect(flattened.skillRefs).toEqual([
      { sourceId: 'src-1', skillName: 'alpha' },
    ]);
    expect(flattened.pluginRefs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'pl' },
    ]);
  });
});

describe('appendEnableRef', () => {
  it('returns an unchanged copy for a row with nothing to enable', () => {
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'src-1', skillName: 'alpha' }],
      pluginRefs: [],
    };
    const next = appendEnableRef(selections, { kind: 'none' });
    expect(next).toEqual(selections);
    expect(next).not.toBe(selections);
  });
});

describe('inventoryRowNeedsResolution', () => {
  it('resolves available rows and inherited rows; promoted enabled rows and agent rows insert as cached', () => {
    const available: Pick<SlashCommandData, 'section' | 'inventoryEntry'> = {
      section: 'available',
      inventoryEntry: makeEntry({ name: 'a' }),
    };
    const promoted: Pick<SlashCommandData, 'section' | 'inventoryEntry'> = {
      section: 'discovered',
      inventoryEntry: makeEntry({ name: 'b' }),
    };
    // Promoted like an enabled row, but its cached id was assigned over the
    // inherited set alone: only the resolver knows the id the chat root gives
    // it next to the selection.
    const inherited: Pick<SlashCommandData, 'section' | 'inventoryEntry'> = {
      section: 'discovered',
      inventoryEntry: makeEntry({
        name: 'c',
        provider: 'cursor',
        kind: 'inherited_skill',
        enableRef: { kind: 'none' },
      }),
    };
    const agent: Pick<SlashCommandData, 'section' | 'inventoryEntry'> = {
      section: 'discovered',
    };
    expect(inventoryRowNeedsResolution(available)).toBe(true);
    expect(inventoryRowNeedsResolution(promoted)).toBe(false);
    expect(inventoryRowNeedsResolution(inherited)).toBe(true);
    expect(inventoryRowNeedsResolution(agent)).toBe(false);
  });
});

describe('runInventorySelection', () => {
  it('resolves an inherited row against the current selection and inserts the resolved id without enabling anything', async () => {
    const entry = makeEntry({
      name: 'review',
      provider: 'cursor',
      kind: 'inherited_skill',
      enableRef: { kind: 'none' },
      insertText: '/review ',
      invocationKey: '/review',
    });
    const current: ChatTabPluginSelections = {
      ...emptySelections(),
      skillRefs: [{ sourceId: 'src', skillName: 'review' }],
    };
    const resolveSelection = jest.fn().mockResolvedValue({
      success: true,
      data: { insertText: '/review-1 ', invocationKey: '/review-1' },
    });
    const applySelections = jest.fn();
    const insertResolvedText = jest.fn();
    const onError = jest.fn();

    const status = await runInventorySelection({
      entry,
      providerType: 'cursor',
      currentSelections: current,
      deps: {
        prepareCodexCompatibilityPlugin: jest.fn(),
        resolveSelection,
        applySelections,
        insertResolvedText,
        onError,
        refreshInventory: jest.fn(),
      },
    });

    expect(status).toBe('inserted');
    expect(resolveSelection).toHaveBeenCalledWith({
      providerType: 'cursor',
      entry,
      selections: current,
    });
    expect(insertResolvedText).toHaveBeenCalledWith('/review-1 ');
    // Nothing to enable, so nothing is written: a selection write would
    // restart the Cursor session and pin the chat's defaults as local picks.
    expect(applySelections).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
