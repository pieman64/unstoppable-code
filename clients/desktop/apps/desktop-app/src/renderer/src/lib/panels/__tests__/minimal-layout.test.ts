/** @jest-environment jsdom */
import type {
  ISerializedPanelEntry,
  SerializablePanelLayoutFile,
} from '@canopy/protocol';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import {
  ensureMinimalDestination,
  hideOptionalMinimalRegions,
  isMinimalLayoutShape,
  planMinimalLayout,
  repairMinimalLayout,
} from '../minimal-layout';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_FILE_EXPLORER_PANEL_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '../panel-group-ids';

function source(panels: ISerializedPanelEntry[]): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      orientation: 1,
      width: 1000,
      height: 700,
      root: {
        type: 'leaf',
        groupId: 'source',
        panels,
        activePanelId: panels[0]?.panelId ?? null,
        size: 1000,
      },
    },
    activeGroupId: 'source',
    mostRecentActiveGroupIds: ['source'],
  };
}

function leafGroups(
  node: SerializablePanelLayoutFile['grid']['root'],
): string[] {
  return node.type === 'leaf'
    ? [node.groupId]
    : node.children.flatMap(leafGroups);
}

function resultLeaves(
  node: SerializablePanelLayoutFile['grid']['root'],
): Array<
  Extract<SerializablePanelLayoutFile['grid']['root'], { type: 'leaf' }>
> {
  return node.type === 'leaf'
    ? [node]
    : node.children.flatMap((child) => resultLeaves(child));
}

describe('Minimal layout planner', () => {
  it.each([
    [1586, 857],
    [1000, 700],
  ])(
    'preserves the coordinate space when converting a %i × %i workspace repeatedly',
    (width, height) => {
      const current = source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
      ]);
      current.grid.width = width;
      current.grid.height = height;
      let layout = planMinimalLayout(current).layout;
      const side = resultLeaves(layout.grid.root).find(
        (group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID,
      );
      const bottom = resultLeaves(layout.grid.root).find(
        (group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID,
      );
      if (!side || !bottom) throw new Error('Missing Minimal destinations');
      side.size = 350;
      bottom.size = 200;
      for (let cycle = 0; cycle < 4; cycle++) {
        layout = planMinimalLayout(layout).layout;
        expect(layout.grid).toMatchObject({ width, height });
        expect(resultLeaves(layout.grid.root)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              groupId: DEFAULT_EXTRAS_GROUP_ID,
              size: 350,
            }),
            expect.objectContaining({
              groupId: DEFAULT_TERMINAL_GROUP_ID,
              size: 200,
            }),
          ]),
        );
      }
    },
  );

  it('retains the unbound Advanced Terminal placeholder in the Bottom Drawer', () => {
    const current: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1586,
        height: 857,
        root: {
          type: 'branch',
          size: 857,
          children: [
            {
              type: 'branch',
              size: 1143,
              children: [
                {
                  type: 'leaf',
                  groupId: DEFAULT_CHAT_GROUP_ID,
                  panels: [
                    {
                      panelId: 'chat',
                      kind: 'chat',
                      instance: { chatTabId: 'c1' },
                    },
                  ],
                  activePanelId: 'chat',
                  size: 600,
                },
                {
                  type: 'leaf',
                  groupId: DEFAULT_TERMINAL_GROUP_ID,
                  panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
                  activePanelId: 'panel-terminal',
                  size: 257,
                },
              ],
            },
            {
              type: 'leaf',
              groupId: DEFAULT_ACTIVITY_GROUP_ID,
              panels: [
                { panelId: 'panel-activity', kind: 'activity-section' },
                { panelId: 'panel-files', kind: 'file-explorer' },
              ],
              activePanelId: 'panel-activity',
              size: 443,
            },
          ],
        },
      },
      activeGroupId: DEFAULT_CHAT_GROUP_ID,
      mostRecentActiveGroupIds: [
        DEFAULT_CHAT_GROUP_ID,
        DEFAULT_ACTIVITY_GROUP_ID,
        DEFAULT_TERMINAL_GROUP_ID,
      ],
    };

    const plan = planMinimalLayout(current);

    expect(plan.closedPanels).toEqual([]);
    expect(leafGroups(plan.layout.grid.root)).toEqual([
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_EXTRAS_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ]);
    const groups = resultLeaves(plan.layout.grid.root);
    expect(
      groups.find((group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID)?.panels,
    ).toEqual([
      { panelId: 'panel-activity', kind: 'activity-section' },
      { panelId: 'panel-files', kind: 'file-explorer' },
    ]);
    expect(
      groups.find((group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID)
        ?.panels,
    ).toEqual([{ panelId: 'panel-terminal', kind: 'terminal' }]);
  });

  it('builds a full-width Bottom Drawer beneath Chat and Side Panel', () => {
    const plan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
        { panelId: 'browser', kind: 'browser', instance: { browserId: 'b1' } },
        {
          panelId: 'terminal',
          kind: 'terminal',
          instance: { terminalId: 't1' },
        },
      ]),
    );

    const root = plan.layout.grid.root;
    expect(root.type).toBe('branch');
    if (root.type !== 'branch') return;
    expect(plan.layout.grid.orientation).toBe(0);
    expect(root.children).toHaveLength(2);
    const [mainRow, bottomDrawer] = root.children;
    expect(mainRow.type).toBe('branch');
    if (mainRow.type !== 'branch') return;
    expect(mainRow.children.map((child) => leafGroups(child))).toEqual([
      [DEFAULT_CHAT_GROUP_ID],
      [DEFAULT_EXTRAS_GROUP_ID],
    ]);
    expect(leafGroups(bottomDrawer)).toEqual([DEFAULT_TERMINAL_GROUP_ID]);
  });

  it('builds three canonical destinations and keeps every panel', () => {
    const plan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
        {
          panelId: 'file',
          kind: 'file-diff',
          instance: { fileTabId: 'f1', filePath: '/tmp/a' },
        },
        { panelId: 'browser', kind: 'browser', instance: { browserId: 'b1' } },
        {
          panelId: 'terminal',
          kind: 'terminal',
          instance: { terminalId: 't1' },
        },
        { panelId: 'closed', kind: 'settings' },
      ]),
    );
    expect(leafGroups(plan.layout.grid.root)).toEqual([
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_EXTRAS_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ]);
    const sidePanel = resultLeaves(plan.layout.grid.root).find(
      (group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID,
    );
    expect(sidePanel?.type).toBe('leaf');
    if (sidePanel?.type === 'leaf') {
      expect(sidePanel.panels.map((panel) => panel.kind)).toEqual([
        'activity-section',
        'file-explorer',
        'file-diff',
        'browser',
        'settings',
      ]);
      expect(sidePanel.panels[1]?.panelId).toBe(DEFAULT_FILE_EXPLORER_PANEL_ID);
    }
    expect(plan.closedPanels).toEqual([]);
    expect(
      plan.impacts.find((impact) => impact.panelId === 'file')?.outcome,
    ).toBe('Move to side panel');
    expect(
      plan.impacts.find((impact) => impact.panelId === 'browser')?.outcome,
    ).toBe('Move to side panel');
    expect(
      plan.impacts.find((impact) => impact.panelId === 'closed')?.outcome,
    ).toBe('Move to side panel');
  });

  it('always initializes Side Panel and Bottom Drawer', () => {
    const plan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
      ]),
    );
    expect(leafGroups(plan.layout.grid.root)).toEqual([
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_EXTRAS_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ]);
    const groups = resultLeaves(plan.layout.grid.root);
    expect(
      groups.find((group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID)?.panels,
    ).toEqual([
      expect.objectContaining({ kind: 'activity-section' }),
      expect.objectContaining({ kind: 'file-explorer' }),
    ]);
    expect(
      groups.find((group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID)
        ?.panels,
    ).toEqual([
      expect.objectContaining({ panelId: 'panel-terminal', kind: 'terminal' }),
    ]);
  });

  it('reasserts a missing Bottom Drawer without moving a user-placed Side Panel terminal', () => {
    const worktreeKey = 'project/minimal-repair';
    const initial = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
      ]),
    ).layout;
    const store = usePanelLayoutStore.getState();
    expect(store.restoreLayout(worktreeKey, initial)).toBe(true);
    store.addTab(worktreeKey, DEFAULT_EXTRAS_GROUP_ID, 'terminal', {
      panelId: 'terminal-side',
      instance: { terminalId: 't-side' },
    });
    store.closeTab(worktreeKey, DEFAULT_TERMINAL_GROUP_ID, 'panel-terminal');

    expect(ensureMinimalDestination(worktreeKey, 'terminal')).toBe(
      DEFAULT_TERMINAL_GROUP_ID,
    );
    const repaired = store.serializeLayout(worktreeKey);
    expect(repaired).not.toBeNull();
    if (repaired === null) throw new Error('expected repaired layout');
    const groups = resultLeaves(repaired.grid.root);
    expect(
      groups
        .find((group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID)
        ?.panels.map((panel) => panel.panelId),
    ).toContain('terminal-side');
    expect(
      groups.find((group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID)
        ?.panels,
    ).toEqual([
      expect.objectContaining({ panelId: 'panel-terminal', kind: 'terminal' }),
    ]);
    store.disposeLayout(worktreeKey);
  });

  it('gives run panels the same destination as file content', () => {
    const run: ISerializedPanelEntry = {
      panelId: 'panel-pipeline-run-1',
      kind: 'pipeline-execution',
      instance: { executionId: 'run-1' },
    };
    const file: ISerializedPanelEntry = {
      panelId: 'file',
      kind: 'file-diff',
      instance: { fileTabId: 'f1', filePath: '/tmp/a' },
    };
    const destinationOf = (
      plan: ReturnType<typeof planMinimalLayout>,
      panelId: string,
    ): string | undefined =>
      resultLeaves(plan.layout.grid.root).find((group) =>
        group.panels.some((panel) => panel.panelId === panelId),
      )?.groupId;

    // Top row: Side Panel, never the fixed Chat section.
    const topPlan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
        file,
        run,
      ]),
    );
    expect(destinationOf(topPlan, 'file')).toBe(DEFAULT_EXTRAS_GROUP_ID);
    expect(destinationOf(topPlan, run.panelId)).toBe(DEFAULT_EXTRAS_GROUP_ID);
    expect(
      topPlan.impacts.find((impact) => impact.panelId === run.panelId)?.outcome,
    ).toBe('Move to side panel');

    // A window popped from the bottom row: Bottom Drawer, like a file there.
    const bottomPlan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
      ]),
      [{ layout: source([file, run]), sourceWasBottom: true }],
    );
    expect(destinationOf(bottomPlan, 'file')).toBe(DEFAULT_TERMINAL_GROUP_ID);
    expect(destinationOf(bottomPlan, run.panelId)).toBe(
      DEFAULT_TERMINAL_GROUP_ID,
    );
  });

  it('keeps Subagents in the Side Panel while subagent chats follow file content', () => {
    const chat: ISerializedPanelEntry = {
      panelId: 'panel-subagent-chat',
      kind: 'subagent-chat',
      instance: {
        rootChatId: 'chat-1',
        subagentId: 'agent-1',
        subagentKind: 'managed',
      },
    };
    const file: ISerializedPanelEntry = {
      panelId: 'file',
      kind: 'file-diff',
      instance: { fileTabId: 'file-1', filePath: '/tmp/file' },
    };
    const destinationOf = (
      plan: ReturnType<typeof planMinimalLayout>,
      panelId: string,
    ): string | undefined =>
      resultLeaves(plan.layout.grid.root).find((group) =>
        group.panels.some((panel) => panel.panelId === panelId),
      )?.groupId;
    const topPlan = planMinimalLayout(
      source([
        {
          panelId: 'root-chat',
          kind: 'chat',
          instance: { chatTabId: 'chat-1' },
        },
        chat,
        file,
      ]),
    );
    expect(destinationOf(topPlan, chat.panelId)).toBe(DEFAULT_EXTRAS_GROUP_ID);
    expect(destinationOf(topPlan, file.panelId)).toBe(DEFAULT_EXTRAS_GROUP_ID);

    const bottomPlan = planMinimalLayout(
      source([
        {
          panelId: 'root-chat',
          kind: 'chat',
          instance: { chatTabId: 'chat-1' },
        },
      ]),
      [
        {
          layout: source([
            chat,
            file,
            { panelId: 'panel-subagents', kind: 'subagents' },
          ]),
          sourceWasBottom: true,
        },
      ],
    );
    expect(destinationOf(bottomPlan, chat.panelId)).toBe(
      DEFAULT_TERMINAL_GROUP_ID,
    );
    expect(destinationOf(bottomPlan, file.panelId)).toBe(
      DEFAULT_TERMINAL_GROUP_ID,
    );
    expect(destinationOf(bottomPlan, 'panel-subagents')).toBe(
      DEFAULT_EXTRAS_GROUP_ID,
    );
  });

  it('resolves the run panel Minimal destination to the file Side Panel', () => {
    const worktreeKey = 'project/minimal-run-destination';
    const store = usePanelLayoutStore.getState();
    expect(
      store.restoreLayout(
        worktreeKey,
        planMinimalLayout(
          source([
            { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
          ]),
        ).layout,
      ),
    ).toBe(true);
    expect(ensureMinimalDestination(worktreeKey, 'pipeline-execution')).toBe(
      ensureMinimalDestination(worktreeKey, 'file-diff'),
    );
    expect(ensureMinimalDestination(worktreeKey, 'pipeline-execution')).toBe(
      DEFAULT_EXTRAS_GROUP_ID,
    );
    store.disposeLayout(worktreeKey);
  });

  it('reports panels from auxiliary layouts even when their group id is already canonical', () => {
    const current = source([
      { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
    ]);
    const auxiliary: SerializablePanelLayoutFile = {
      ...source([
        {
          panelId: 'terminal-aux',
          kind: 'terminal',
          title: 'Build terminal',
          instance: { terminalId: 't1' },
        },
      ]),
      grid: {
        ...source([]).grid,
        root: {
          type: 'leaf',
          groupId: DEFAULT_TERMINAL_GROUP_ID,
          panels: [
            {
              panelId: 'terminal-aux',
              kind: 'terminal',
              title: 'Build terminal',
              instance: { terminalId: 't1' },
            },
          ],
          activePanelId: 'terminal-aux',
          size: 1000,
        },
      },
      activeGroupId: DEFAULT_TERMINAL_GROUP_ID,
    };

    const plan = planMinimalLayout(current, [auxiliary]);

    expect(plan.impacts).toContainEqual({
      panelId: 'terminal-aux',
      title: 'Build terminal',
      outcome: 'Move to bottom drawer',
    });
  });

  it('preserves a non-terminal auxiliary tab popped from the Advanced bottom group in Bottom Drawer', () => {
    const current = source([]);
    const auxiliary: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 900,
        height: 600,
        root: {
          type: 'leaf',
          groupId: DEFAULT_TERMINAL_GROUP_ID,
          panels: [{ panelId: 'browser-aux', kind: 'browser' }],
          activePanelId: 'browser-aux',
          size: 900,
        },
      },
      activeGroupId: DEFAULT_TERMINAL_GROUP_ID,
      mostRecentActiveGroupIds: [DEFAULT_TERMINAL_GROUP_ID],
    };

    const plan = planMinimalLayout(current, [auxiliary]);
    const bottom = resultLeaves(plan.layout.grid.root).find(
      (leaf) => leaf.groupId === DEFAULT_TERMINAL_GROUP_ID,
    );

    expect(bottom?.panels.map((panel) => panel.panelId)).toContain(
      'browser-aux',
    );

    const customGroupAuxiliary = {
      ...auxiliary,
      grid: {
        ...auxiliary.grid,
        root: {
          ...auxiliary.grid.root,
          groupId: 'group-custom-bottom',
        },
      },
      activeGroupId: 'group-custom-bottom',
    } satisfies SerializablePanelLayoutFile;
    const customGroupPlan = planMinimalLayout(current, [
      { layout: customGroupAuxiliary, sourceWasBottom: true },
    ]);
    expect(
      resultLeaves(customGroupPlan.layout.grid.root)
        .find((leaf) => leaf.groupId === DEFAULT_TERMINAL_GROUP_ID)
        ?.panels.map((panel) => panel.panelId),
    ).toContain('browser-aux');
  });

  it('preserves non-chat panels from an Advanced bottom row in the Bottom Drawer', () => {
    const current: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'branch',
          size: 800,
          children: [
            {
              type: 'branch',
              size: 850,
              children: [
                {
                  type: 'leaf',
                  groupId: DEFAULT_CHAT_GROUP_ID,
                  panels: [
                    {
                      panelId: 'chat',
                      kind: 'chat',
                      instance: { chatTabId: 'c1' },
                    },
                  ],
                  activePanelId: 'chat',
                  size: 560,
                },
                {
                  type: 'leaf',
                  groupId: 'advanced-bottom',
                  panels: [
                    {
                      panelId: 'browser-bottom',
                      kind: 'browser',
                      instance: { browserId: 'b1' },
                    },
                    { panelId: 'settings-bottom', kind: 'settings' },
                  ],
                  activePanelId: 'browser-bottom',
                  size: 240,
                  collapsed: { edge: 'bottom', expandedSize: 240 },
                },
              ],
            },
            {
              type: 'leaf',
              groupId: DEFAULT_ACTIVITY_GROUP_ID,
              panels: [{ panelId: 'activity', kind: 'activity-section' }],
              activePanelId: 'activity',
              size: 350,
            },
          ],
        },
      },
      activeGroupId: 'advanced-bottom',
      mostRecentActiveGroupIds: ['advanced-bottom', DEFAULT_CHAT_GROUP_ID],
    };

    const plan = planMinimalLayout(current);
    const groups = resultLeaves(plan.layout.grid.root);
    const bottom = groups.find(
      (group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID,
    );
    expect(bottom?.panels.map((panel) => panel.panelId)).toEqual([
      'panel-terminal',
      'browser-bottom',
      'settings-bottom',
    ]);
    expect(bottom).toMatchObject({
      activePanelId: 'browser-bottom',
      collapsed: { edge: 'bottom', expandedSize: 240 },
    });
    expect(plan.layout.activeGroupId).toBe(DEFAULT_TERMINAL_GROUP_ID);
  });

  it('preserves the focused tab when multiple Advanced groups merge into one destination', () => {
    const current: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'branch',
          size: 1200,
          children: [
            {
              type: 'leaf',
              groupId: DEFAULT_CHAT_GROUP_ID,
              panels: [
                {
                  panelId: 'chat',
                  kind: 'chat',
                  instance: { chatTabId: 'c1' },
                },
              ],
              activePanelId: 'chat',
              size: 600,
            },
            {
              type: 'leaf',
              groupId: 'advanced-side-first',
              panels: [{ panelId: 'settings-first', kind: 'settings' }],
              activePanelId: 'settings-first',
              size: 300,
            },
            {
              type: 'leaf',
              groupId: 'advanced-side-focused',
              panels: [{ panelId: 'usage-focused', kind: 'usage' }],
              activePanelId: 'usage-focused',
              size: 300,
            },
          ],
        },
      },
      activeGroupId: 'advanced-side-focused',
      mostRecentActiveGroupIds: [
        'advanced-side-focused',
        'advanced-side-first',
        DEFAULT_CHAT_GROUP_ID,
      ],
    };

    const plan = planMinimalLayout(current);
    const side = resultLeaves(plan.layout.grid.root).find(
      (group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID,
    );
    expect(side?.activePanelId).toBe('usage-focused');
    expect(plan.layout.activeGroupId).toBe(DEFAULT_EXTRAS_GROUP_ID);
  });

  it('preserves canonical active tabs, legal sizes, and drawer collapse state', () => {
    const current: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'branch',
          size: 800,
          children: [
            {
              type: 'branch',
              size: 790,
              children: [
                {
                  type: 'leaf',
                  groupId: DEFAULT_CHAT_GROUP_ID,
                  panels: [
                    {
                      panelId: 'chat-1',
                      kind: 'chat',
                      instance: { chatTabId: 'c1' },
                    },
                    {
                      panelId: 'chat-2',
                      kind: 'chat',
                      instance: { chatTabId: 'c2' },
                    },
                  ],
                  activePanelId: 'chat-2',
                  size: 430,
                },
                {
                  type: 'leaf',
                  groupId: DEFAULT_TERMINAL_GROUP_ID,
                  panels: [
                    {
                      panelId: 'terminal-1',
                      kind: 'terminal',
                      instance: { terminalId: 't1' },
                    },
                  ],
                  activePanelId: 'terminal-1',
                  size: 245,
                  collapsed: { edge: 'bottom', expandedSize: 245 },
                },
              ],
            },
            {
              type: 'leaf',
              groupId: DEFAULT_ACTIVITY_GROUP_ID,
              panels: [],
              activePanelId: null,
              size: 410,
              collapsed: { edge: 'right', expandedSize: 410 },
            },
          ],
        },
      },
      activeGroupId: DEFAULT_CHAT_GROUP_ID,
      mostRecentActiveGroupIds: [DEFAULT_CHAT_GROUP_ID],
    };
    const plan = planMinimalLayout(current);
    const groups = resultLeaves(plan.layout.grid.root);
    expect(
      groups.find((group) => group.groupId === DEFAULT_CHAT_GROUP_ID),
    ).toMatchObject({ activePanelId: 'chat-2' });
    expect(
      groups.find((group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID),
    ).toMatchObject({
      activePanelId: 'terminal-1',
      size: 245,
      collapsed: { edge: 'bottom', expandedSize: 245 },
    });
    expect(
      groups.find((group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID),
    ).toMatchObject({
      size: 410,
      collapsed: { edge: 'right', expandedSize: 410 },
    });
  });

  it('marks the initial Side Panel collapse as auto, but not the Bottom Drawer', () => {
    const plan = planMinimalLayout(
      source([
        { panelId: 'chat', kind: 'chat', instance: { chatTabId: 'c1' } },
      ]),
      [],
      { initial: true },
    );

    const groups = resultLeaves(plan.layout.grid.root);
    expect(
      groups.find((group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID)
        ?.collapsed,
    ).toMatchObject({ edge: 'right', auto: true });
    expect(
      groups.find((group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID)
        ?.collapsed?.auto,
    ).toBeUndefined();
  });

  it('does not invent an auto flag when converting an existing layout to Minimal', () => {
    // A mode conversion carries the preserved descriptor verbatim, so a
    // collapse the user performed in Advanced stays the user's.
    const current: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1000,
        height: 700,
        root: {
          type: 'branch',
          size: 1000,
          children: [
            {
              type: 'leaf',
              groupId: DEFAULT_CHAT_GROUP_ID,
              panels: [
                {
                  panelId: 'chat-1',
                  kind: 'chat',
                  instance: { chatTabId: 'c1' },
                },
              ],
              activePanelId: 'chat-1',
              size: 590,
            },
            {
              type: 'leaf',
              groupId: DEFAULT_ACTIVITY_GROUP_ID,
              panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
              activePanelId: 'panel-activity',
              size: 410,
              collapsed: { edge: 'right', expandedSize: 410 },
            },
          ],
        },
      },
      activeGroupId: DEFAULT_CHAT_GROUP_ID,
      mostRecentActiveGroupIds: [DEFAULT_CHAT_GROUP_ID],
    };

    const plan = planMinimalLayout(current);

    const side = resultLeaves(plan.layout.grid.root).find(
      (group) => group.groupId === DEFAULT_EXTRAS_GROUP_ID,
    );
    expect(side?.collapsed).toMatchObject({ edge: 'right' });
    expect(side?.collapsed?.auto).toBeUndefined();
  });
});

describe('early access Minimal defaults', () => {
  const converted = (): SerializablePanelLayoutFile =>
    planMinimalLayout(
      source([
        { panelId: 'chat-1', kind: 'chat' },
        { panelId: 'terminal-1', kind: 'terminal' },
      ]),
    ).layout;

  it('recognizes the Minimal shape and rejects an Advanced one', () => {
    expect(isMinimalLayoutShape(converted())).toBe(true);
    expect(isMinimalLayoutShape(source([]))).toBe(false);
  });

  it('hides the Side Panel and Bottom Drawer as a lasting collapse and focuses Chat', () => {
    const hidden = hideOptionalMinimalRegions({
      ...converted(),
      activeGroupId: DEFAULT_TERMINAL_GROUP_ID,
    });
    const byGroup = new Map(
      resultLeaves(hidden.grid.root).map((leaf) => [leaf.groupId, leaf]),
    );

    expect(byGroup.get(DEFAULT_CHAT_GROUP_ID)?.collapsed).toBeUndefined();
    expect(byGroup.get(DEFAULT_EXTRAS_GROUP_ID)?.collapsed).toEqual({
      edge: 'right',
      expandedSize: byGroup.get(DEFAULT_EXTRAS_GROUP_ID)?.size,
    });
    expect(byGroup.get(DEFAULT_TERMINAL_GROUP_ID)?.collapsed).toEqual({
      edge: 'bottom',
      expandedSize: byGroup.get(DEFAULT_TERMINAL_GROUP_ID)?.size,
    });
    expect(hidden.activeGroupId).toBe(DEFAULT_CHAT_GROUP_ID);
    expect(isMinimalLayoutShape(hidden)).toBe(true);
  });

  const sidePanels = (layout: SerializablePanelLayoutFile): string[] =>
    resultLeaves(layout.grid.root)
      .find((leaf) => leaf.groupId === DEFAULT_EXTRAS_GROUP_ID)
      ?.panels.map((panel) => panel.kind) ?? [];

  it('starts the Side Panel empty, so it lists what can be opened there', () => {
    const seeded = planMinimalLayout(source([]), [], {
      initial: true,
      seedSidePanels: false,
    }).layout;
    expect(sidePanels(seeded)).toEqual([]);
    expect(isMinimalLayoutShape(seeded)).toBe(true);
    // Without the option, Activity and File explorer still lead it.
    expect(
      sidePanels(planMinimalLayout(source([]), [], { initial: true }).layout),
    ).toEqual(['activity-section', 'file-explorer']);
  });

  it('does not put Activity and File explorer back once they are closed', () => {
    const empty = planMinimalLayout(source([]), [], {
      initial: true,
      seedSidePanels: false,
    }).layout;
    expect(
      sidePanels(repairMinimalLayout(empty, [], { seedSidePanels: false })),
    ).toEqual([]);
    expect(sidePanels(repairMinimalLayout(empty))).toEqual([
      'activity-section',
      'file-explorer',
    ]);
  });

  it('keeps the Side Panel tabs a layout already holds, in their order', () => {
    const seededBefore = planMinimalLayout(
      source([
        { panelId: 'chat-1', kind: 'chat' },
        { panelId: 'panel-files-2', kind: 'file-explorer' },
      ]),
      [],
      { initial: true },
    ).layout;
    expect(sidePanels(seededBefore)).toContain('activity-section');
    const idsOf = (layout: typeof seededBefore): string[][] =>
      resultLeaves(layout.grid.root).map((leaf) =>
        leaf.panels.map((panel) => panel.panelId),
      );

    const repaired = repairMinimalLayout(seededBefore, [], {
      seedSidePanels: false,
    });

    expect(idsOf(repaired)).toEqual(idsOf(seededBefore));
  });

  it('converts to Minimal without seeding or dropping Side Panel tabs', () => {
    const plan = planMinimalLayout(
      source([
        { panelId: 'chat-1', kind: 'chat' },
        { panelId: 'panel-activity', kind: 'activity-section' },
        { panelId: DEFAULT_FILE_EXPLORER_PANEL_ID, kind: 'file-explorer' },
      ]),
      [],
      { seedSidePanels: false },
    );
    const ids = resultLeaves(plan.layout.grid.root).flatMap((leaf) =>
      leaf.panels.map((panel) => panel.panelId),
    );
    expect(ids).toContain('panel-activity');
    expect(ids).toContain(DEFAULT_FILE_EXPLORER_PANEL_ID);

    const empty = planMinimalLayout(
      source([{ panelId: 'chat-1', kind: 'chat' }]),
      [],
      { seedSidePanels: false },
    );
    expect(sidePanels(empty.layout)).toEqual([]);
  });

  it('drops the automatic-reopen flag from the fresh Minimal seed', () => {
    const seeded = planMinimalLayout(source([]), [], { initial: true }).layout;
    const side = resultLeaves(
      hideOptionalMinimalRegions(seeded).grid.root,
    ).find((leaf) => leaf.groupId === DEFAULT_EXTRAS_GROUP_ID);
    expect(side?.collapsed?.auto).toBeUndefined();
  });
});
