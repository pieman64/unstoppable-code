/** @jest-environment jsdom */

import {
  isSerializablePanelLayoutFile,
  migratePanelLayout,
  PANEL_INSTANCE_VALUE_MAX_LENGTH,
  PANEL_TITLE_MAX_LENGTH,
  type ISerializedPanelEntry,
  type ISerializedPanelLeafNode,
  type ISerializedPanelNode,
  type PanelCollapsedState,
  type PanelDropEdge,
  type PanelSplitDirection,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
} from '@canopy/protocol';
import {
  DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT,
  DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
  PANEL_COLLAPSED_BAR_SIZE,
  type PanelLayoutViewModel,
  type PanelLeafLayoutBox,
  type PanelLeafView,
} from '@canopy/ui-shared/panels';
import {
  findPanelByInstanceKey,
  getPanelGridController,
  getPanelInstanceKey,
  getPanelLayoutViewModel,
  isAuxPanelLayoutKey,
  isSingletonPanelKind,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  PRUNABLE_BOUND_PANEL_KINDS,
  pruneInvalidBoundPanelEntries,
  readPanelGroupRevealState,
  sanitizeRawPlanPanelBindings,
  setFixedSidePanelTabsClosable,
  setPanelLayoutChatGroup,
  setPanelLayoutExcludedKinds,
  setPanelLayoutFixedTopology,
  setPanelTabCloseGuard,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '../panel-layout-store';

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `worktree-${keyCounter}`);
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function createPointerEvent(
  type: string,
  pageX: number,
  pageY: number,
): MouseEvent {
  const Ctor =
    typeof window.PointerEvent === 'function'
      ? window.PointerEvent
      : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pageX', { value: pageX });
  Object.defineProperty(event, 'pageY', { value: pageY });
  return event;
}

/** Instance binding for the fixture chat tab (chat panels are per-entity). */
const CHAT_A_INSTANCE = { chatTabId: 'chat-a' } as const;

const THREE_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: CHAT_A_INSTANCE,
    },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
    {
      kind: 'browser',
      groupId: 'group-c',
      panelId: 'panel-c',
      instance: { browserId: 'browser-c' },
    },
  ],
  containerSize: { width: 900, height: 600 },
};

const TWO_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: CHAT_A_INSTANCE,
    },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
  ],
  containerSize: { width: 900, height: 600 },
};

const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: CHAT_A_INSTANCE,
    },
  ],
  containerSize: { width: 800, height: 600 },
};

function groupIds(viewModel: PanelLayoutViewModel | null): string[] {
  return (viewModel?.groups ?? []).map((group) => group.groupId);
}

function groupIdContainingPanel(
  viewModel: PanelLayoutViewModel | null,
  panelId: string,
): string | undefined {
  return viewModel?.groups.find((group) =>
    group.tabs.some((tab) => tab.panelId === panelId),
  )?.groupId;
}

/** Recursively walks `file.grid.root` and returns the leaf for `groupId`. */
function findLeafInFile(
  file: SerializablePanelLayoutFile,
  groupId: string,
): ISerializedPanelLeafNode | undefined {
  function walk(
    node: ISerializedPanelNode,
  ): ISerializedPanelLeafNode | undefined {
    if (node.type === 'leaf') {
      return node.groupId === groupId ? node : undefined;
    }
    for (const child of node.children) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  return walk(file.grid.root);
}

/** Recursively collects every leaf node under `node`, in tree order. */
function collectLeavesInNode(
  node: ISerializedPanelNode,
  out: ISerializedPanelLeafNode[],
): void {
  if (node.type === 'leaf') {
    out.push(node);
    return;
  }
  for (const child of node.children) {
    collectLeavesInNode(child, out);
  }
}

/**
 * Returns a new tree with `groupId`'s leaf carrying `collapsed`, rebuilt
 * immutably from the typed original (no `unknown`/`as` mangling of parsed
 * JSON — see task-5 brief).
 */
function withLeafCollapsed(
  node: ISerializedPanelNode,
  groupId: string,
  collapsed: PanelCollapsedState,
): ISerializedPanelNode {
  if (node.type === 'leaf') {
    return node.groupId === groupId ? { ...node, collapsed } : node;
  }
  return {
    ...node,
    children: node.children.map((child) =>
      withLeafCollapsed(child, groupId, collapsed),
    ),
  };
}

afterEach(() => {
  const state = store();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

describe('initializeLayout', () => {
  test('builds N groups with sane view-model, revision, active group, and MRU', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    const layout = store().layouts[key];
    expect(layout).toBeDefined();
    expect(layout.revision).toBe(1);
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.mruGroupIds).toEqual(['group-a', 'group-b', 'group-c']);
    expect(layout.maximizedGroupId).toBeNull();

    const viewModel = layout.viewModel;
    expect(groupIds(viewModel)).toEqual(['group-a', 'group-b', 'group-c']);
    expect(viewModel.activeGroupId).toBe('group-a');
    expect(viewModel.maximizedGroupId).toBeNull();
    expect(viewModel.groups[0].tabs).toEqual([
      {
        panelId: 'panel-a',
        kind: 'chat',
        title: 'chat',
        instance: CHAT_A_INSTANCE,
      },
    ]);
    expect(viewModel.groups[1].tabs[0].kind).toBe('terminal');
    expect(viewModel.groups[1].activePanelId).toBe('panel-b');
    expect(viewModel.groups[2].tabs[0].kind).toBe('browser');
  });

  test('exposes a controller with the live grid and leaf elements', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    const controller = getPanelGridController(key);
    expect(controller).not.toBeNull();
    expect(controller?.revision).toBe(1);
    expect(controller?.grid.element).toBeInstanceOf(HTMLElement);
    const leafElement = controller?.getLeafElement('group-b');
    expect(leafElement).toBeInstanceOf(HTMLElement);
    expect(controller?.grid.element.contains(leafElement ?? null)).toBe(true);
    expect(controller?.getLeafElement('nope')).toBeNull();
  });

  test('is a no-op when a layout already exists for the key', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    const before = store().layouts[key];

    store().initializeLayout(key, ONE_GROUP);
    expect(store().layouts[key]).toBe(before);
  });

  test('ignores empty descriptors', () => {
    const key = nextKey();
    store().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [],
    });
    expect(store().layouts[key]).toBeUndefined();
    expect(getPanelGridController(key)).toBeNull();
  });
});

describe('browser bounds invalidation topology signal', () => {
  test.each([
    [
      'move',
      THREE_GROUPS,
      (key: string): void => {
        store().movePanel(key, 'panel-c', 'group-a', 'center');
      },
    ],
    [
      'split',
      TWO_GROUPS,
      (key: string): void => {
        store().splitGroup(key, 'group-a', 'right');
      },
    ],
    [
      'collapse',
      TWO_GROUPS,
      (key: string): void => {
        store().collapseGroup(key, 'group-a');
      },
    ],
    [
      'maximize',
      TWO_GROUPS,
      (key: string): void => {
        store().maximizeGroup(key, 'group-a', true);
      },
    ],
  ] as const)(
    '%s replaces the controller observed by PanelGridSurface',
    (_name, descriptor, mutate) => {
      const key = nextKey();
      store().initializeLayout(key, descriptor);
      const before = getPanelGridController(key);

      mutate(key);

      expect(getPanelGridController(key)).not.toBe(before);
    },
  );
});

describe('splitGroup', () => {
  const cases: Array<{ direction: PanelSplitDirection; newIndex: number }> = [
    { direction: 'right', newIndex: 1 },
    { direction: 'down', newIndex: 1 },
    { direction: 'left', newIndex: 0 },
    { direction: 'up', newIndex: 0 },
  ];

  test.each(cases)(
    'splitting $direction creates a focused EMPTY group (panels are per-entity — no clone)',
    ({ direction, newIndex }) => {
      const key = nextKey();
      store().initializeLayout(key, ONE_GROUP);
      const gridBefore = getPanelGridController(key)?.grid;

      const newGroupId = store().splitGroup(key, 'group-a', direction);
      expect(newGroupId).not.toBeNull();
      if (newGroupId === null) {
        return;
      }

      const layout = store().layouts[key];
      expect(layout.revision).toBe(2);
      expect(groupIds(layout.viewModel)).toHaveLength(2);
      expect(groupIds(layout.viewModel)[newIndex]).toBe(newGroupId);

      // No clone: cloning the active tab would duplicate its entity binding,
      // so an unseeded split creates an empty group (add-tab affordance).
      const newGroup = layout.viewModel.groups[newIndex];
      expect(newGroup.tabs).toEqual([]);
      expect(newGroup.activePanelId).toBeNull();

      // The source group's tab is untouched.
      const sourceGroup = layout.viewModel.groups.find(
        (group) => group.groupId === 'group-a',
      );
      expect(sourceGroup?.tabs.map((tab) => tab.panelId)).toEqual(['panel-a']);

      // Focus moved to the new group.
      expect(layout.activeGroupId).toBe(newGroupId);
      expect(layout.mruGroupIds[0]).toBe(newGroupId);

      // Same grid instance, new controller revision.
      const controller = getPanelGridController(key);
      expect(controller?.grid).toBe(gridBefore);
      expect(controller?.revision).toBe(2);
    },
  );

  test('returns null for unknown keys and groups', () => {
    const key = nextKey();
    expect(store().splitGroup(key, 'group-a', 'right')).toBeNull();
    store().initializeLayout(key, ONE_GROUP);
    expect(store().splitGroup(key, 'missing', 'right')).toBeNull();
  });

  test('an explicit seed creates a fresh tab with stable ids (and optional instance)', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    const newGroupId = store().splitGroup(key, 'group-a', 'down', {
      kind: 'terminal',
      groupId: 'group-seeded',
      panelId: 'panel-seeded',
    });
    expect(newGroupId).toBe('group-seeded');

    const layout = store().layouts[key];
    const seededGroup = layout.viewModel.groups.find(
      (group) => group.groupId === 'group-seeded',
    );
    expect(seededGroup?.tabs).toEqual([
      { panelId: 'panel-seeded', kind: 'terminal', title: 'terminal' },
    ]);
    expect(seededGroup?.activePanelId).toBe('panel-seeded');
    expect(layout.activeGroupId).toBe('group-seeded');

    // Seeds carry instance bindings through to the descriptor/view-model.
    const instancedGroupId = store().splitGroup(key, 'group-a', 'right', {
      kind: 'file-diff',
      groupId: 'group-instanced',
      panelId: 'panel-instanced',
      instance: { fileTabId: 'file-1', filePath: '/tmp/file.ts' },
    });
    expect(instancedGroupId).toBe('group-instanced');
    const instancedGroup = store().layouts[key].viewModel.groups.find(
      (group) => group.groupId === 'group-instanced',
    );
    expect(instancedGroup?.tabs).toEqual([
      {
        panelId: 'panel-instanced',
        kind: 'file-diff',
        title: 'file-diff',
        instance: { fileTabId: 'file-1', filePath: '/tmp/file.ts' },
      },
    ]);
  });

  test('rejects a seeded group id that already exists in the layout', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    expect(
      store().splitGroup(key, 'group-a', 'down', {
        kind: 'terminal',
        groupId: 'group-b',
      }),
    ).toBeNull();
    expect(store().layouts[key]).toBe(before);
  });
});

describe('closeGroup', () => {
  test('is a safe no-op on the last remaining group', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const before = store().layouts[key];

    expect(store().closeGroup(key, 'group-a')).toBe(false);
    expect(store().layouts[key]).toBe(before);
    expect(groupIds(store().layouts[key].viewModel)).toEqual(['group-a']);
  });

  test('focuses the most-recently-active surviving group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().focusGroup(key, 'group-b');
    store().focusGroup(key, 'group-a');

    expect(store().closeGroup(key, 'group-a')).toBe(true);

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['group-b', 'group-c']);
    expect(layout.activeGroupId).toBe('group-b');
    expect(layout.mruGroupIds).toEqual(['group-b', 'group-c']);
    expect(layout.revision).toBe(2);
    expect(getPanelGridController(key)?.getLeafElement('group-a')).toBeNull();
  });

  describe('with a host close guard', () => {
    afterEach(() => {
      setPanelTabCloseGuard(undefined);
    });

    test('keeps the group and its protected tabs, closing only the rest', () => {
      const key = nextKey();
      store().initializeLayout(key, THREE_GROUPS);
      // Merge the terminal into the chat group so it holds two tabs.
      store().movePanel(key, 'panel-b', 'group-a', 'center');
      const guard = jest.fn(
        (_layoutKey: string, tab: { panelId: string }): boolean =>
          tab.panelId === 'panel-a',
      );
      setPanelTabCloseGuard(guard);

      expect(store().closeGroup(key, 'group-a')).toBe(false);

      expect(guard).toHaveBeenCalledWith(
        key,
        expect.objectContaining({ panelId: 'panel-a' }),
      );
      const layout = store().layouts[key];
      expect(groupIds(layout.viewModel)).toEqual(['group-a', 'group-c']);
      expect(layout.viewModel.groups[0].tabs.map((tab) => tab.panelId)).toEqual(
        ['panel-a'],
      );
    });

    test('leaves a group of only protected tabs untouched', () => {
      const key = nextKey();
      store().initializeLayout(key, THREE_GROUPS);
      setPanelTabCloseGuard(() => true);
      const before = store().layouts[key];

      expect(store().closeGroup(key, 'group-a')).toBe(false);
      expect(store().layouts[key]).toBe(before);
    });

    test('removes a group the guard does not protect', () => {
      const key = nextKey();
      store().initializeLayout(key, THREE_GROUPS);
      setPanelTabCloseGuard((_layoutKey, tab) => tab.panelId === 'panel-a');

      expect(store().closeGroup(key, 'group-b')).toBe(true);
      expect(groupIds(store().layouts[key].viewModel)).toEqual([
        'group-a',
        'group-c',
      ]);
    });
  });
});

describe('selectTab / closeTab', () => {
  function buildTwoTabGroup(key: string): void {
    store().initializeLayout(key, TWO_GROUPS);
    // Merge panel-b into group-a; emptied group-b closes automatically.
    store().movePanel(key, 'panel-b', 'group-a', 'center');
  }

  test('movePanel center merges tabs and auto-closes the emptied source group', () => {
    const key = nextKey();
    buildTwoTabGroup(key);

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['group-a']);
    expect(layout.viewModel.groups[0].tabs.map((tab) => tab.panelId)).toEqual([
      'panel-a',
      'panel-b',
    ]);
    expect(layout.viewModel.groups[0].activePanelId).toBe('panel-b');
    expect(layout.activeGroupId).toBe('group-a');
  });

  test('selectTab activates the tab and focuses its group', () => {
    const key = nextKey();
    buildTwoTabGroup(key);

    store().selectTab(key, 'group-a', 'panel-a');
    const layout = store().layouts[key];
    expect(layout.viewModel.groups[0].activePanelId).toBe('panel-a');
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.mruGroupIds[0]).toBe('group-a');

    const before = store().layouts[key];
    store().selectTab(key, 'group-a', 'panel-unknown');
    expect(store().layouts[key]).toBe(before);
  });

  test('selectTab with focus:false activates the tab WITHOUT stealing the active group', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const added = store().addTab(key, 'group-a', 'chat', {
      panelId: 'panel-a2',
      instance: { chatTabId: 'chat-a2' },
    });
    expect(added).toBe('panel-a2');
    store().focusGroup(key, 'group-b');

    store().selectTab(key, 'group-a', 'panel-a', { focus: false });

    const layout = store().layouts[key];
    const groupA = layout.viewModel.groups.find(
      (group) => group.groupId === 'group-a',
    );
    expect(groupA?.activePanelId).toBe('panel-a');
    // The active group and MRU order are untouched.
    expect(layout.activeGroupId).toBe('group-b');
    expect(layout.mruGroupIds[0]).toBe('group-b');
  });

  test('closing the active tab activates its neighbor', () => {
    const key = nextKey();
    buildTwoTabGroup(key);
    store().selectTab(key, 'group-a', 'panel-a');

    store().closeTab(key, 'group-a', 'panel-a');

    const group = store().layouts[key].viewModel.groups[0];
    expect(group.tabs.map((tab) => tab.panelId)).toEqual(['panel-b']);
    expect(group.activePanelId).toBe('panel-b');
  });

  test('closing the last tab of a group closes the group (MRU focus)', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().focusGroup(key, 'group-b');

    store().closeTab(key, 'group-b', 'panel-b');

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['group-a']);
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.revision).toBe(2);
  });

  test('closing the last tab of the last group leaves an empty group', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    store().closeTab(key, 'group-a', 'panel-a');

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['group-a']);
    expect(layout.viewModel.groups[0].tabs).toEqual([]);
    expect(layout.viewModel.groups[0].activePanelId).toBeNull();
  });
});

describe('addTab', () => {
  test('appends a fresh activated tab, focuses the group, and keeps revision/controller (no topology change)', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().focusGroup(key, 'group-a');
    const before = store().layouts[key];
    const controllerBefore = getPanelGridController(key);

    const panelId = store().addTab(key, 'group-b', 'file-diff', {
      instance: { fileTabId: 'file-new' },
    });
    expect(panelId).not.toBeNull();
    if (panelId === null) {
      return;
    }
    expect(panelId).toMatch(/^panel-/);

    const layout = store().layouts[key];
    expect(layout.revision).toBe(before.revision);
    expect(getPanelGridController(key)).toBe(controllerBefore);
    expect(layout.viewModel).not.toBe(before.viewModel);

    const groupB = layout.viewModel.groups.find(
      (group) => group.groupId === 'group-b',
    );
    expect(groupB?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-b',
      panelId,
    ]);
    expect(groupB?.tabs[1].kind).toBe('file-diff');
    expect(groupB?.activePanelId).toBe(panelId);
    expect(layout.activeGroupId).toBe('group-b');
    expect(layout.mruGroupIds[0]).toBe('group-b');
  });

  test('honors a seeded panel id, title, and instance binding', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    const panelId = store().addTab(key, 'group-a', 'terminal', {
      panelId: 'panel-seeded',
      title: 'My Terminal',
    });
    expect(panelId).toBe('panel-seeded');

    const group = store().layouts[key].viewModel.groups[0];
    expect(group.tabs[1]).toEqual({
      panelId: 'panel-seeded',
      kind: 'terminal',
      title: 'My Terminal',
    });

    const instancedId = store().addTab(key, 'group-a', 'chat', {
      panelId: 'panel-chat-b',
      title: 'Chat B',
      instance: { chatTabId: 'chat-b' },
    });
    expect(instancedId).toBe('panel-chat-b');
    expect(store().layouts[key].viewModel.groups[0].tabs[2]).toEqual({
      panelId: 'panel-chat-b',
      kind: 'chat',
      title: 'Chat B',
      instance: { chatTabId: 'chat-b' },
    });
  });

  test('returns null for unknown keys/groups and duplicate panel ids', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    expect(store().addTab('nope', 'group-a', 'chat')).toBeNull();
    expect(store().addTab(key, 'group-nope', 'chat')).toBeNull();
    // Duplicate panel id anywhere in the family (panel-b lives in group-b).
    expect(
      store().addTab(key, 'group-a', 'chat', {
        panelId: 'panel-b',
        instance: { chatTabId: 'chat-other' },
      }),
    ).toBeNull();
    expect(store().layouts[key]).toBe(before);
  });

  test('rejects tabs that violate their kind instance contract', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    expect(store().addTab(key, 'group-a', 'chat')).toBeNull();
    expect(store().addTab(key, 'group-a', 'file-diff')).toBeNull();
    expect(store().addTab(key, 'group-a', 'activity-card')).toBeNull();
    expect(store().addTab(key, 'group-a', 'usage')).toBeNull();
    expect(store().addTab(key, 'group-a', 'automations')).toBeNull();
    expect(
      store().addTab(key, 'group-a', 'usage', {
        instance: { variant: 'bogus' },
      }),
    ).toBeNull();
    expect(
      store().addTab(key, 'group-a', 'automations', {
        instance: { variant: 'all' },
      }),
    ).toBeNull();
    expect(store().layouts[key]).toBe(before);

    expect(
      store().addTab(key, 'group-a', 'usage', {
        instance: { variant: 'claude' },
      }),
    ).not.toBeNull();
    expect(
      store().addTab(key, 'group-a', 'automations', {
        instance: { variant: 'overview' },
      }),
    ).not.toBeNull();
  });

  test('enforces instance-key uniqueness across the layout family', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);

    // Terminal panels are per-session: distinct terminal bindings coexist.
    expect(
      store().addTab(key, 'group-a', 'terminal', {
        instance: { terminalId: 'terminal-b' },
      }),
    ).not.toBeNull();
    const afterTerminalAdd = store().layouts[key];
    expect(
      store().addTab(key, 'group-a', 'terminal', {
        instance: { terminalId: 'terminal-b' },
      }),
    ).toBeNull();
    expect(store().layouts[key]).toBe(afterTerminalAdd);

    // Entity-bound kinds key on their binding: same chat tab twice rejects…
    expect(
      store().addTab(key, 'group-b', 'chat', {
        instance: CHAT_A_INSTANCE,
      }),
    ).toBeNull();
    expect(store().layouts[key]).toBe(afterTerminalAdd);
    // …while a different chat tab is welcome.
    expect(
      store().addTab(key, 'group-b', 'chat', {
        instance: { chatTabId: 'chat-b' },
      }),
    ).not.toBeNull();

    // Uniqueness spans the whole family for the same terminal binding.
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(
      store().addTab(key, 'group-a', 'terminal', {
        instance: { terminalId: 'terminal-b' },
      }),
    ).toBeNull();
    // And an aux add collides with main-layout tabs too.
    const auxGroupId = groupIds(getPanelLayoutViewModel(auxKey))[0];
    expect(
      store().addTab(auxKey, auxGroupId, 'chat', {
        instance: CHAT_A_INSTANCE,
      }),
    ).toBeNull();
  });
});

describe('getPanelInstanceKey / findPanelByInstanceKey', () => {
  test('derives singleton and per-entity instance keys', () => {
    expect(getPanelInstanceKey({ kind: 'terminal' })).toBe('terminal:');
    expect(
      getPanelInstanceKey({
        kind: 'terminal',
        instance: { terminalId: 'terminal-1' },
      }),
    ).toBe('terminal:terminal-1');
    // Browser is per-entity: it keys on its bound session id (an unbound
    // legacy descriptor degrades to the bare `browser:` key).
    expect(
      getPanelInstanceKey({ kind: 'browser', instance: { browserId: 'b1' } }),
    ).toBe('browser:b1');
    expect(getPanelInstanceKey({ kind: 'browser' })).toBe('browser:');
    expect(getPanelInstanceKey({ kind: 'activity-section' })).toBe(
      'activity-section',
    );
    expect(getPanelInstanceKey({ kind: 'file-explorer' })).toBe(
      'file-explorer',
    );
    expect(
      getPanelInstanceKey({ kind: 'chat', instance: { chatTabId: 'c1' } }),
    ).toBe('chat:c1');
    expect(
      getPanelInstanceKey({
        kind: 'file-diff',
        instance: { fileTabId: 'f1', filePath: '/tmp/a.ts' },
      }),
    ).toBe('file-diff:f1');
    expect(
      getPanelInstanceKey({
        kind: 'file-diff',
        instance: { filePath: '/tmp/a.ts' },
      }),
    ).toBe('file-diff:/tmp/a.ts');
    expect(
      getPanelInstanceKey({
        kind: 'activity-card',
        instance: { sectionId: 'changed-files' },
      }),
    ).toBe('activity-card:changed-files');
    // Each usage variant is its own instance key, so all four coexist.
    expect(
      getPanelInstanceKey({ kind: 'usage', instance: { variant: 'all' } }),
    ).toBe('usage:all');
    expect(
      getPanelInstanceKey({ kind: 'usage', instance: { variant: 'codex' } }),
    ).toBe('usage:codex');
    expect(
      getPanelInstanceKey({
        kind: 'automations',
        instance: { variant: 'overview' },
      }),
    ).toBe('automations:overview');
    // Legacy instance-less entity kinds collapse to the bare `${kind}:` key.
    expect(getPanelInstanceKey({ kind: 'chat' })).toBe('chat:');
  });

  test('finds panels across the layout family (main first, then aux)', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);

    expect(findPanelByInstanceKey(key, 'chat:chat-a')).toEqual({
      layoutKey: key,
      groupId: 'group-a',
      panelId: 'panel-a',
    });
    // The terminal lives in the aux layout now — still found via the family.
    expect(findPanelByInstanceKey(key, 'terminal:')).toEqual({
      layoutKey: auxKey,
      groupId: 'group-b',
      panelId: 'panel-b',
    });
    expect(findPanelByInstanceKey(key, 'chat:missing')).toBeNull();
    expect(findPanelByInstanceKey('project/none', 'terminal')).toBeNull();
  });
});

describe('updateTabInstanceTitle', () => {
  test('updates a tab title (family-wide lookup) and no-ops when unchanged', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    const revisionBefore = store().layouts[key].revision;
    const controllerBefore = getPanelGridController(key);

    store().updateTabInstanceTitle(key, 'panel-a', 'Renamed Chat');
    expect(store().layouts[key].viewModel.groups[0].tabs[0].title).toBe(
      'Renamed Chat',
    );
    // Revision/controller stay put (pure metadata mutation).
    expect(store().layouts[key].revision).toBe(revisionBefore);
    expect(getPanelGridController(key)).toBe(controllerBefore);

    store().extractGroupToLayout(key, 'group-b', auxKey);

    // No-op when unchanged: the record identity is preserved.
    const before = store().layouts[key];
    store().updateTabInstanceTitle(key, 'panel-a', 'Renamed Chat');
    expect(store().layouts[key]).toBe(before);

    // Aux-layout panels are addressed through the owning worktree key.
    store().updateTabInstanceTitle(key, 'panel-b', 'Aux Terminal');
    expect(getPanelLayoutViewModel(auxKey)?.groups[0].tabs[0].title).toBe(
      'Aux Terminal',
    );

    // Unknown panels are a safe no-op.
    const mainBefore = store().layouts[key];
    store().updateTabInstanceTitle(key, 'panel-nope', 'x');
    expect(store().layouts[key]).toBe(mainBefore);
  });
});

describe('reorderTab', () => {
  /** group-a seeded with tabs [panel-a, panel-x, panel-y]. */
  function seedThreeTabGroup(): string {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    // Distinct per-entity bindings: family instance-key uniqueness would
    // reject a second instance-less file-diff tab or a second terminal.
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-x',
      instance: { fileTabId: 'file-x' },
    });
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-y',
      instance: { fileTabId: 'file-y' },
    });
    return key;
  }

  function groupATabIds(key: string): string[] {
    const group = store().layouts[key].viewModel.groups.find(
      (candidate) => candidate.groupId === 'group-a',
    );
    return (group?.tabs ?? []).map((tab) => tab.panelId);
  }

  test('moves a tab to a later final index, keeps the active tab, focuses the group, and keeps revision/controller', () => {
    const key = seedThreeTabGroup();
    store().selectTab(key, 'group-a', 'panel-a');
    store().focusGroup(key, 'group-b');
    const before = store().layouts[key];
    const controllerBefore = getPanelGridController(key);

    store().reorderTab(key, 'group-a', 'panel-a', 2);

    const layout = store().layouts[key];
    expect(groupATabIds(key)).toEqual(['panel-x', 'panel-y', 'panel-a']);
    // Pure tab-metadata mutation: no topology change.
    expect(layout.revision).toBe(before.revision);
    expect(getPanelGridController(key)).toBe(controllerBefore);
    expect(layout.viewModel).not.toBe(before.viewModel);
    // Reorder never changes the selected tab, but it focuses the group.
    expect(
      layout.viewModel.groups.find((group) => group.groupId === 'group-a')
        ?.activePanelId,
    ).toBe('panel-a');
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.mruGroupIds[0]).toBe('group-a');
  });

  test('moves a tab to an earlier index', () => {
    const key = seedThreeTabGroup();
    store().reorderTab(key, 'group-a', 'panel-y', 0);
    expect(groupATabIds(key)).toEqual(['panel-y', 'panel-a', 'panel-x']);
  });

  test('clamps out-of-range target indexes', () => {
    const key = seedThreeTabGroup();
    store().reorderTab(key, 'group-a', 'panel-a', 99);
    expect(groupATabIds(key)).toEqual(['panel-x', 'panel-y', 'panel-a']);

    store().reorderTab(key, 'group-a', 'panel-a', -5);
    expect(groupATabIds(key)).toEqual(['panel-a', 'panel-x', 'panel-y']);
  });

  test('is a state-preserving no-op for unknown keys/groups/panels and unchanged positions', () => {
    const key = seedThreeTabGroup();
    const before = store().layouts[key];

    store().reorderTab('nope', 'group-a', 'panel-a', 1);
    store().reorderTab(key, 'group-nope', 'panel-a', 1);
    store().reorderTab(key, 'group-a', 'panel-nope', 1);
    // panel-b lives in group-b, not group-a.
    store().reorderTab(key, 'group-a', 'panel-b', 1);
    // Same final position.
    store().reorderTab(key, 'group-a', 'panel-x', 1);

    expect(store().layouts[key]).toBe(before);
  });
});

describe('setTabPinned / closeTabs (pinned ordering + batch close)', () => {
  /** group-a with panels a (chat), b (terminal), c/d (file-diff), unpinned. */
  function fourTabGroup(): string {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    store().addTab(key, 'group-a', 'terminal', { panelId: 'panel-b' });
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-c',
      instance: { fileTabId: 'f-c', filePath: '/c' },
    });
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-d',
      instance: { fileTabId: 'f-d', filePath: '/d' },
    });
    return key;
  }

  function groupTabs(
    key: string,
    groupId: string,
  ): { panelId: string; pinned?: boolean }[] {
    const group = getPanelLayoutViewModel(key)?.groups.find(
      (g) => g.groupId === groupId,
    );
    return (group?.tabs ?? []).map((tab) => ({
      panelId: tab.panelId,
      ...(tab.pinned === true ? { pinned: true } : {}),
    }));
  }

  test('addTab keeps the pinned prefix invariant (new tabs are unpinned)', () => {
    const key = fourTabGroup();
    // All four tabs are unpinned and in insertion order.
    expect(groupTabs(key, 'group-a').map((t) => t.panelId)).toEqual([
      'panel-a',
      'panel-b',
      'panel-c',
      'panel-d',
    ]);
  });

  test('pinning moves a tab to the END of the pinned partition; unpinning to the START of the unpinned partition', () => {
    const key = fourTabGroup();
    store().setTabPinned(key, 'group-a', 'panel-c', true);
    expect(groupTabs(key, 'group-a')).toEqual([
      { panelId: 'panel-c', pinned: true },
      { panelId: 'panel-a' },
      { panelId: 'panel-b' },
      { panelId: 'panel-d' },
    ]);

    store().setTabPinned(key, 'group-a', 'panel-a', true);
    expect(groupTabs(key, 'group-a')).toEqual([
      { panelId: 'panel-c', pinned: true },
      { panelId: 'panel-a', pinned: true },
      { panelId: 'panel-b' },
      { panelId: 'panel-d' },
    ]);

    // Unpinning c lands it at the start of the unpinned partition.
    store().setTabPinned(key, 'group-a', 'panel-c', false);
    expect(groupTabs(key, 'group-a')).toEqual([
      { panelId: 'panel-a', pinned: true },
      { panelId: 'panel-c' },
      { panelId: 'panel-b' },
      { panelId: 'panel-d' },
    ]);
  });

  test('setTabPinned to the current state is a no-op (no commit)', () => {
    const key = fourTabGroup();
    const before = store().layouts[key];
    store().setTabPinned(key, 'group-a', 'panel-b', false);
    expect(store().layouts[key]).toBe(before);
    // Unknown group/panel are also no-ops.
    store().setTabPinned(key, 'group-nope', 'panel-b', true);
    store().setTabPinned(key, 'group-a', 'panel-nope', true);
    expect(store().layouts[key]).toBe(before);
  });

  test('reorderTab clamps to the dragged tab own partition', () => {
    const key = fourTabGroup();
    store().setTabPinned(key, 'group-a', 'panel-a', true);
    store().setTabPinned(key, 'group-a', 'panel-b', true);
    // Order: [a(pin), b(pin), c, d].
    // A pinned tab reordered far right clamps to the pinned partition.
    store().reorderTab(key, 'group-a', 'panel-a', 5);
    expect(groupTabs(key, 'group-a').map((t) => t.panelId)).toEqual([
      'panel-b',
      'panel-a',
      'panel-c',
      'panel-d',
    ]);
    // An unpinned tab reordered to index 0 clamps to the unpinned partition.
    store().reorderTab(key, 'group-a', 'panel-c', 0);
    expect(groupTabs(key, 'group-a').map((t) => t.panelId)).toEqual([
      'panel-b',
      'panel-a',
      'panel-c',
      'panel-d',
    ]);
    // Pinned tabs still lead the array.
    expect(
      groupTabs(key, 'group-a')
        .filter((t) => t.pinned)
        .map((t) => t.panelId),
    ).toEqual(['panel-b', 'panel-a']);
  });

  test('closeTabs closes a batch (Close Others / Right / Left / All semantics)', () => {
    const key = fourTabGroup();
    // Close Others relative to c: [a, b, d].
    store().closeTabs(key, 'group-a', ['panel-a', 'panel-b', 'panel-d']);
    expect(groupTabs(key, 'group-a').map((t) => t.panelId)).toEqual([
      'panel-c',
    ]);
  });

  test('closeTabs skips ids not in the group and no-ops on an empty batch', () => {
    const key = fourTabGroup();
    const before = store().layouts[key];
    store().closeTabs(key, 'group-a', []);
    store().closeTabs(key, 'group-a', ['panel-nope']);
    expect(store().layouts[key]).toBe(before);
    // Mixed: only the present id is closed.
    store().closeTabs(key, 'group-a', ['panel-b', 'panel-nope']);
    expect(groupTabs(key, 'group-a').map((t) => t.panelId)).toEqual([
      'panel-a',
      'panel-c',
      'panel-d',
    ]);
  });

  test('closeTabs closing every tab of the last group leaves an empty group', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    store().closeTabs(key, 'group-a', ['panel-a']);
    const group = getPanelLayoutViewModel(key)?.groups.find(
      (g) => g.groupId === 'group-a',
    );
    expect(group?.tabs).toEqual([]);
    expect(group?.activePanelId).toBeNull();
  });

  test('serialize/restore carries pinned state and canonical partition order', () => {
    const key = fourTabGroup();
    store().setTabPinned(key, 'group-a', 'panel-c', true);
    const file = store().serializeLayout(key);
    if (!file) {
      throw new Error('Expected a serialized layout');
    }
    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    expect(groupTabs(key2, 'group-a')).toEqual([
      { panelId: 'panel-c', pinned: true },
      { panelId: 'panel-a' },
      { panelId: 'panel-b' },
      { panelId: 'panel-d' },
    ]);
  });
});

describe('closing tabs under a fixed topology', () => {
  const SIDE_PANEL: DefaultLayoutDescriptor = {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-a',
        instance: CHAT_A_INSTANCE,
      },
      {
        kind: 'file-explorer',
        groupId: 'group-extras',
        panelId: 'panel-files',
      },
    ],
    containerSize: { width: 900, height: 600 },
  };
  const BOTTOM_DRAWER: DefaultLayoutDescriptor = {
    orientation: 'vertical',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-a',
        instance: CHAT_A_INSTANCE,
      },
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      },
    ],
    containerSize: { width: 900, height: 600 },
  };

  test('keeps the Side Panel as an empty group once its last tab closes', () => {
    const key = nextKey();
    store().initializeLayout(key, SIDE_PANEL);
    setPanelLayoutFixedTopology(key, true);
    setFixedSidePanelTabsClosable(true);
    try {
      store().closeTab(key, 'group-extras', 'panel-files');
      // Still there, empty, so it can be shown, hidden, and filled again.
      expect(store().layouts[key].groups['group-extras']).toEqual(
        expect.objectContaining({ tabs: [], activePanelId: null }),
      );
      expect(store().collapseGroup(key, 'group-extras')).toBe(true);
      expect(store().expandGroup(key, 'group-extras')).toBe(true);
    } finally {
      setFixedSidePanelTabsClosable(false);
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('keeps a collapsed Side Panel collapsed, and expandable, once its last tab closes', () => {
    const key = nextKey();
    store().initializeLayout(key, SIDE_PANEL);
    setPanelLayoutFixedTopology(key, true);
    setFixedSidePanelTabsClosable(true);
    try {
      expect(store().collapseGroup(key, 'group-extras')).toBe(true);
      store().closeTab(key, 'group-extras', 'panel-files');
      const group = store().layouts[key].groups['group-extras'];
      expect(group?.tabs).toEqual([]);
      expect(group?.collapsed).toBeDefined();
      expect(store().expandGroup(key, 'group-extras')).toBe(true);
      expect(store().layouts[key].groups['group-extras']?.collapsed).toBe(
        undefined,
      );
    } finally {
      setFixedSidePanelTabsClosable(false);
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('closes an emptied group under a fixed topology unless the Side Panel may be emptied', () => {
    const key = nextKey();
    store().initializeLayout(key, BOTTOM_DRAWER);
    setPanelLayoutFixedTopology(key, true);
    try {
      store().closeTab(key, 'group-terminal', 'panel-terminal');
      expect(groupIds(store().layouts[key].viewModel)).toEqual(['group-chat']);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }

    const kept = nextKey();
    store().initializeLayout(kept, BOTTOM_DRAWER);
    setPanelLayoutFixedTopology(kept, true);
    setFixedSidePanelTabsClosable(true);
    try {
      store().closeTab(kept, 'group-terminal', 'panel-terminal');
      expect(groupIds(store().layouts[kept].viewModel)).toEqual([
        'group-chat',
        'group-terminal',
      ]);
    } finally {
      setFixedSidePanelTabsClosable(false);
      setPanelLayoutFixedTopology(kept, false);
    }
  });

  test('keeps the Side Panel at the usual minimum width', () => {
    setFixedSidePanelTabsClosable(true);
    const key = nextKey();
    try {
      store().initializeLayout(key, SIDE_PANEL);
      const layout = store().layouts[key];
      expect(layout.leafViews.get('group-extras')?.minimumWidth).toBe(320);
      expect(layout.leafViews.get('group-chat')?.minimumWidth).toBe(320);
    } finally {
      setFixedSidePanelTabsClosable(false);
    }
    const plain = nextKey();
    store().initializeLayout(plain, SIDE_PANEL);
    expect(
      store().layouts[plain].leafViews.get('group-extras')?.minimumWidth,
    ).toBe(320);
  });

  test('keeps File explorer open unless the host makes it closable', () => {
    const key = nextKey();
    store().initializeLayout(key, SIDE_PANEL);
    setPanelLayoutFixedTopology(key, true);
    try {
      store().closeTab(key, 'group-extras', 'panel-files');
      expect(
        store().layouts[key].groups['group-extras'].tabs.map(
          (tab) => tab.panelId,
        ),
      ).toEqual(['panel-files']);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });
});

describe('setTabPinned under a fixed topology', () => {
  test('pins and unpins: it only reorders tabs within their group', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-x',
      instance: { fileTabId: 'file-x' },
    });
    setPanelLayoutFixedTopology(key, true);
    try {
      store().setTabPinned(key, 'group-a', 'panel-x', true);
      const pinned = store().layouts[key].groups['group-a'].tabs;
      expect(pinned.map((tab) => tab.panelId)).toEqual(['panel-x', 'panel-a']);
      expect(pinned[0].pinned).toBe(true);

      store().setTabPinned(key, 'group-a', 'panel-x', false);
      expect(
        store().layouts[key].groups['group-a'].tabs.some(
          (tab) => tab.pinned === true,
        ),
      ).toBe(false);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });
});

describe('crowded tab row', () => {
  test('a group with 20+ tabs still accepts a new tab and a center dock', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    for (let index = 1; index <= 20; index += 1) {
      expect(
        store().addTab(key, 'group-a', 'file-diff', {
          instance: { fileTabId: `crowded-${index}` },
          activate: false,
        }),
      ).not.toBeNull();
    }
    expect(store().layouts[key].groups['group-a'].tabs).toHaveLength(21);

    expect(
      store().addTab(key, 'group-a', 'file-diff', {
        instance: { fileTabId: 'crowded-next' },
      }),
    ).not.toBeNull();
    expect(store().canMovePanel(key, 'panel-b', 'group-a', 'center')).toBe(
      true,
    );
    expect(store().movePanel(key, 'panel-b', 'group-a', 'center')).toBe(true);
    expect(store().layouts[key].groups['group-a'].tabs).toHaveLength(23);
  });
});

describe('movePanel', () => {
  test('a background existing-file move preserves selections and focus in every publication', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const panelId = store().addTab(key, 'group-b', 'file-diff', {
      instance: { fileTabId: 'background-legacy' },
      activate: false,
    });
    if (panelId === null) throw new Error('File fixture did not materialize');
    const before = store().layouts[key];
    const published: boolean[] = [];
    const unsubscribe = usePanelLayoutStore.subscribe((state) => {
      const layout = state.layouts[key];
      published.push(
        layout.activeGroupId === before.activeGroupId &&
          layout.groups['group-a'].activePanelId ===
            before.groups['group-a'].activePanelId &&
          layout.groups['group-b'].activePanelId ===
            before.groups['group-b'].activePanelId,
      );
    });
    try {
      expect(
        store().movePanel(key, panelId, 'group-a', 'center', undefined, {
          activate: false,
        }),
      ).toBe(true);
      expect(published).toEqual([true]);
      expect(
        store().layouts[key].groups['group-a'].tabs.some(
          (tab) => tab.panelId === panelId,
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test('center inserts a cross-group tab at the requested target index', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-x',
      instance: { fileTabId: 'file-x' },
    });

    store().movePanel(key, 'panel-b', 'group-a', 'center', 1);

    const target = store().layouts[key].viewModel.groups.find(
      (group) => group.groupId === 'group-a',
    );
    expect(target?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-a',
      'panel-b',
      'panel-x',
    ]);
    expect(target?.activePanelId).toBe('panel-b');
  });

  test('center onto its own group just activates the tab', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().movePanel(key, 'panel-b', 'group-a', 'center');
    store().selectTab(key, 'group-a', 'panel-a');

    store().movePanel(key, 'panel-b', 'group-a', 'center');

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['group-a']);
    expect(layout.viewModel.groups[0].activePanelId).toBe('panel-b');
  });

  const edgeCases: Array<{
    edge: Exclude<PanelDropEdge, 'center'>;
    newIndex: number;
  }> = [
    { edge: 'top', newIndex: 0 },
    { edge: 'left', newIndex: 0 },
    { edge: 'bottom', newIndex: 1 },
    { edge: 'right', newIndex: 1 },
  ];

  test.each(edgeCases)(
    'edge $edge splits the target and auto-closes the emptied source',
    ({ edge, newIndex }) => {
      const key = nextKey();
      store().initializeLayout(key, TWO_GROUPS);
      const revisionBefore = store().layouts[key].revision;

      store().movePanel(key, 'panel-a', 'group-b', edge);

      const layout = store().layouts[key];
      const ids = groupIds(layout.viewModel);
      expect(ids).toHaveLength(2);
      expect(ids).toContain('group-b');
      expect(ids).not.toContain('group-a');

      const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
      expect(newGroupId).toBeDefined();
      expect(ids[newIndex]).toBe(newGroupId);
      expect(layout.activeGroupId).toBe(newGroupId);
      const newGroup = layout.viewModel.groups[newIndex];
      expect(newGroup.activePanelId).toBe('panel-a');
      expect(newGroup.tabs).toEqual([
        {
          panelId: 'panel-a',
          kind: 'chat',
          title: 'chat',
          instance: CHAT_A_INSTANCE,
        },
      ]);
      // Add + remove both bump topology revision.
      expect(layout.revision).toBe(revisionBefore + 2);
    },
  );

  test('multi-tab source group survives an edge move of one tab', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().movePanel(key, 'panel-b', 'group-a', 'center');

    store().movePanel(key, 'panel-b', 'group-a', 'right');

    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toHaveLength(2);
    expect(groupIdContainingPanel(layout.viewModel, 'panel-a')).toBe('group-a');
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-b');
    expect(newGroupId).toBeDefined();
    expect(newGroupId).not.toBe('group-a');
    expect(layout.viewModel.groups[0].groupId).toBe('group-a');
    expect(layout.viewModel.groups[0].tabs.map((tab) => tab.panelId)).toEqual([
      'panel-a',
    ]);
    expect(layout.activeGroupId).toBe(newGroupId);
  });
});

describe('movePanelToRootEdge', () => {
  const TWO_GROUPS_VERTICAL: DefaultLayoutDescriptor = {
    orientation: 'vertical',
    groups: [
      { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
      { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
    ],
    containerSize: { width: 900, height: 600 },
  };

  function rootChildren(key: string): ISerializedPanelNode[] {
    const file = store().serializeLayout(key);
    if (!file || file.grid.root.type !== 'branch') {
      throw new Error('Expected a serialized branch root');
    }
    return [...file.grid.root.children];
  }

  function rootOrientation(key: string): 0 | 1 {
    const file = store().serializeLayout(key);
    if (!file) {
      throw new Error('Expected a serialized layout');
    }
    return file.grid.orientation;
  }

  test('right edge on a horizontal root appends a full-height root-level group', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const revisionBefore = store().layouts[key].revision;

    expect(store().movePanelToRootEdge(key, 'panel-a', 'right')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
    expect(newGroupId).toBeDefined();
    // Emptied source closed; the new group is LAST at the root level.
    expect(groupIds(layout.viewModel)).toEqual(['group-b', newGroupId]);
    expect(layout.activeGroupId).toBe(newGroupId);
    expect(layout.mruGroupIds[0]).toBe(newGroupId);
    expect(layout.revision).toBe(revisionBefore + 2);

    // Direct root children (no wrapping branch), orientation unchanged
    // (1 = horizontal). The new leaf asks for 20% of the width but never
    // less than the leaf minimum; in this 900px fixture the transient
    // three-leaf state cannot honour every minimum, so the grid may settle
    // on a proportional split instead of the exact request.
    expect(rootOrientation(key)).toBe(1);
    const children = rootChildren(key);
    expect(children.map((child) => child.type)).toEqual(['leaf', 'leaf']);
    expect(children[1]).toMatchObject({ groupId: newGroupId });
    expect(children[1].size).toBeGreaterThanOrEqual(
      DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
    );
    expect(children[0].size).toBeGreaterThanOrEqual(
      DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
    );
  });

  test('same-axis insertion clears stale expanded sizes before persistence', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    const extraPanelId = store().addTab(key, 'group-b', 'file-diff', {
      instance: { fileTabId: 'root-edge-extra' },
    });
    expect(extraPanelId).not.toBeNull();

    expect(store().movePanelToRootEdge(key, extraPanelId ?? '', 'right')).toBe(
      true,
    );

    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    expect(isSerializablePanelLayoutFile(file)).toBe(true);
  });

  test('left edge on a horizontal root inserts at root index 0', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    expect(store().movePanelToRootEdge(key, 'panel-b', 'left')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-b');
    expect(groupIds(layout.viewModel)).toEqual([newGroupId, 'group-a']);
    expect(rootOrientation(key)).toBe(1);
    expect(rootChildren(key)[0]).toMatchObject({
      type: 'leaf',
      groupId: newGroupId,
    });
  });

  test('top edge on a horizontal root wraps the root (orientation flips)', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(store().movePanelToRootEdge(key, 'panel-a', 'top')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
    expect(groupIds(layout.viewModel)).toEqual([
      newGroupId,
      'group-b',
      'group-c',
    ]);
    // Root is now VERTICAL: [ new full-width row (~20% height),
    // horizontal branch [b, c] ].
    expect(rootOrientation(key)).toBe(0);
    const children = rootChildren(key);
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({
      type: 'leaf',
      groupId: newGroupId,
      size: Math.round(600 * 0.2),
    });
    expect(children[1].type).toBe('branch');
    if (children[1].type !== 'branch') {
      throw new Error('Expected the old root as a wrapped branch');
    }
    expect(
      children[1].children.map((child) =>
        child.type === 'leaf' ? child.groupId : child.type,
      ),
    ).toEqual(['group-b', 'group-c']);
    expect(layout.activeGroupId).toBe(newGroupId);
  });

  test('orthogonal root-edge insertion preserves wrapped expanded sizes', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    const extraPanelId = store().addTab(key, 'group-b', 'file-diff', {
      instance: { fileTabId: 'orthogonal-root-edge-extra' },
    });
    expect(extraPanelId).not.toBeNull();

    const before = store().serializeLayout(key);
    if (!before || before.grid.root.type !== 'branch') {
      throw new Error('Expected a serialized branch root');
    }
    expect(before.grid.root.expandedSizes).toBeDefined();

    expect(store().movePanelToRootEdge(key, extraPanelId ?? '', 'top')).toBe(
      true,
    );

    const after = store().serializeLayout(key);
    if (!after || after.grid.root.type !== 'branch') {
      throw new Error('Expected a serialized branch root');
    }
    const wrapped = after.grid.root.children[1];
    expect(wrapped?.type).toBe('branch');
    if (wrapped?.type !== 'branch') {
      throw new Error('Expected the old root as a wrapped branch');
    }
    expect(wrapped.expandedSizes).toEqual(before.grid.root.expandedSizes);
  });

  test('bottom edge on a vertical root appends at the end (matched axis)', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS_VERTICAL);

    expect(store().movePanelToRootEdge(key, 'panel-a', 'bottom')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
    expect(groupIds(layout.viewModel)).toEqual(['group-b', newGroupId]);
    expect(rootOrientation(key)).toBe(0);
    const children = rootChildren(key);
    expect(children.map((child) => child.type)).toEqual(['leaf', 'leaf']);
    expect(children[1]).toMatchObject({
      groupId: newGroupId,
      size: Math.round(600 * 0.2),
    });
  });

  test('left edge on a vertical root wraps the root into a horizontal branch', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS_VERTICAL);

    expect(store().movePanelToRootEdge(key, 'panel-a', 'left')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
    expect(groupIds(layout.viewModel)).toEqual([newGroupId, 'group-b']);
    expect(rootOrientation(key)).toBe(1);
    const children = rootChildren(key);
    // The emptied source's removal collapsed the wrapped branch down to the
    // surviving leaf, so both ends are direct root children.
    expect(children[0]).toMatchObject({ type: 'leaf', groupId: newGroupId });
    expect(children[0].size).toBeGreaterThanOrEqual(
      DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
    );
    expect(children[1]).toMatchObject({ type: 'leaf', groupId: 'group-b' });
  });

  test('nested source: full-height right column from a vertically split left side', () => {
    // The reported-impossible case: default-like layout
    // horizontal [ vertical [chat, terminal], activity ] — dragging the
    // terminal to the RIGHT root edge must create a full-height column.
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().splitGroup(key, 'group-a', 'down', {
      kind: 'terminal',
      groupId: 'group-t',
      panelId: 'panel-t',
    });

    expect(store().movePanelToRootEdge(key, 'panel-t', 'right')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-t');
    expect(groupIds(layout.viewModel)).toEqual([
      'group-a',
      'group-b',
      newGroupId,
    ]);
    expect(rootOrientation(key)).toBe(1);
    const children = rootChildren(key);
    // All three are DIRECT root children: the new column is root-level and
    // the emptied vertical branch collapsed back to the chat leaf.
    expect(children.map((child) => child.type)).toEqual([
      'leaf',
      'leaf',
      'leaf',
    ]);
    expect(children[2]).toMatchObject({ type: 'leaf', groupId: newGroupId });
    expect(layout.activeGroupId).toBe(newGroupId);
  });

  test('preserves leaf element identity while replacing the grid instance', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const controllerBefore = getPanelGridController(key);
    const elementBefore = controllerBefore?.getLeafElement('group-b');
    expect(elementBefore).toBeInstanceOf(HTMLElement);

    expect(store().movePanelToRootEdge(key, 'panel-a', 'right')).toBe(true);

    const controllerAfter = getPanelGridController(key);
    expect(controllerAfter).not.toBeNull();
    // Wholesale rebuild: new Grid identity...
    expect(controllerAfter?.grid).not.toBe(controllerBefore?.grid);
    // ...but the surviving group's leaf element (portal target) is REUSED,
    // and it lives inside the NEW grid's DOM.
    expect(controllerAfter?.getLeafElement('group-b')).toBe(elementBefore);
    expect(controllerAfter?.grid.element.contains(elementBefore ?? null)).toBe(
      true,
    );
  });

  test('multi-tab source group survives; focus and MRU follow the new group', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().movePanel(key, 'panel-b', 'group-a', 'center');

    expect(store().movePanelToRootEdge(key, 'panel-b', 'right')).toBe(true);

    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-b');
    expect(groupIds(layout.viewModel)).toEqual(['group-a', newGroupId]);
    expect(layout.viewModel.groups[0].tabs.map((tab) => tab.panelId)).toEqual([
      'panel-a',
    ]);
    const newGroup = layout.viewModel.groups[1];
    expect(newGroup.tabs).toEqual([
      { panelId: 'panel-b', kind: 'terminal', title: 'terminal' },
    ]);
    expect(newGroup.activePanelId).toBe('panel-b');
    expect(layout.activeGroupId).toBe(newGroupId);
    expect(layout.mruGroupIds[0]).toBe(newGroupId);
  });

  test('exits a maximized view before inserting', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    expect(store().movePanelToRootEdge(key, 'panel-b', 'left')).toBe(true);

    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-b');
    expect(groupIds(layout.viewModel)).toEqual([newGroupId, 'group-a']);
  });

  test.each([
    { panelId: 'panel-a', edge: 'left' as const },
    { panelId: 'panel-b', edge: 'right' as const },
  ])(
    'no-op ($edge) when the panel is already the sole content of the root-level group at that edge',
    ({ panelId, edge }) => {
      const key = nextKey();
      store().initializeLayout(key, TWO_GROUPS);
      const before = store().layouts[key];

      expect(store().movePanelToRootEdge(key, panelId, edge)).toBe(false);

      expect(store().layouts[key]).toBe(before);
    },
  );

  test('no-op for the sole tab of a single-group layout (any edge)', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const before = store().layouts[key];

    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      expect(store().movePanelToRootEdge(key, 'panel-a', edge)).toBe(false);
    }
    expect(store().layouts[key]).toBe(before);
  });

  test('a sole root-level tab CAN move to a different edge (only the same edge is a no-op)', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    // panel-a sits at the LEFT root edge; moving it to the RIGHT is real.
    expect(store().movePanelToRootEdge(key, 'panel-a', 'right')).toBe(true);
    const layout = store().layouts[key];
    const newGroupId = groupIdContainingPanel(layout.viewModel, 'panel-a');
    expect(groupIds(layout.viewModel)).toEqual(['group-b', newGroupId]);
  });

  test('returns false for unknown layouts and unknown panels', () => {
    expect(store().movePanelToRootEdge('nope/nope', 'panel-a', 'left')).toBe(
      false,
    );

    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];
    expect(store().movePanelToRootEdge(key, 'panel-nope', 'left')).toBe(false);
    expect(store().layouts[key]).toBe(before);
  });
});

describe('canMovePanelToRootEdge', () => {
  test('agrees with movePanelToRootEdge for every panel/edge combination', () => {
    // The drop-affordance predicate and the mutation share one guard
    // evaluation; this pins the contract that the grid host never shows a
    // root-edge highlight whose release would silently no-op.
    const edges = ['top', 'bottom', 'left', 'right'] as const;

    for (const panelId of ['panel-a', 'panel-b'] as const) {
      for (const edge of edges) {
        const key = nextKey();
        store().initializeLayout(key, TWO_GROUPS);
        const predicted = store().canMovePanelToRootEdge(key, panelId, edge);
        expect(store().movePanelToRootEdge(key, panelId, edge)).toBe(predicted);
      }
    }
  });

  test('is a pure query: no mutation, no revision bump', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    // A refusing edge (panel-b already IS the rightmost root-level group)...
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'right')).toBe(false);
    // ...and an accepting edge both leave the layout untouched.
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'left')).toBe(true);
    expect(store().layouts[key]).toBe(before);
  });

  test('nested default-like layout: terminal can move right, activity cannot', () => {
    // Default worktree shape: horizontal [ vertical [chat, terminal],
    // activity ] — the user-reported case: the activity tab (rightmost
    // sole-tab root child) dragged to the right edge must report false so
    // no drop affordance renders, while the terminal reports true.
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().splitGroup(key, 'group-a', 'down', {
      kind: 'terminal',
      groupId: 'group-t',
      panelId: 'panel-t',
    });

    expect(store().canMovePanelToRootEdge(key, 'panel-t', 'right')).toBe(true);
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'right')).toBe(false);
    // Every other edge remains meaningful for the rightmost group's tab.
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'left')).toBe(true);
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'top')).toBe(true);
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'bottom')).toBe(true);
  });

  test('returns false for unknown layouts and unknown panels', () => {
    expect(store().canMovePanelToRootEdge('nope/nope', 'panel-a', 'left')).toBe(
      false,
    );

    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(store().canMovePanelToRootEdge(key, 'panel-nope', 'left')).toBe(
      false,
    );
  });
});

describe('maximizeGroup', () => {
  test('is a no-op with fewer than two groups', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const before = store().layouts[key];

    store().maximizeGroup(key, 'group-a', true);

    expect(store().layouts[key]).toBe(before);
    expect(store().layouts[key].maximizedGroupId).toBeNull();
  });

  test('maximize and restore transition with revision bumps', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    store().maximizeGroup(key, 'group-a', true);
    let layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBe('group-a');
    expect(layout.viewModel.maximizedGroupId).toBe('group-a');
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.revision).toBe(2);
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(true);

    // Restoring a group that is not the maximized one is a no-op.
    store().maximizeGroup(key, 'group-b', false);
    expect(store().layouts[key].maximizedGroupId).toBe('group-a');

    store().maximizeGroup(key, 'group-a', false);
    layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.revision).toBe(3);
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
  });

  test('splitting while maximized exits and reconciles maximize state', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    const newGroupId = store().splitGroup(key, 'group-a', 'right');

    expect(newGroupId).not.toBeNull();
    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.viewModel.maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
  });

  test('arrangeGroups even distributes sizes and exits maximize', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    store().arrangeGroups(key, 'even');

    expect(store().layouts[key].maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
  });
});

describe('collapseGroup / expandGroup', () => {
  function initializeInnerSplit(axis: 'horizontal' | 'vertical'): string {
    const key = nextKey();
    const horizontalLeafSize = Math.max(250, DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    const horizontalInnerSize = horizontalLeafSize * 4;
    const horizontalGridSize = horizontalLeafSize * 6;
    const leaf = (id: string, size: number): ISerializedPanelLeafNode => ({
      type: 'leaf',
      groupId: id,
      panels: [
        {
          panelId: `panel-${id}`,
          kind: 'terminal',
          instance: { terminalId: id },
        },
      ],
      activePanelId: `panel-${id}`,
      size,
    });
    const file: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: axis === 'horizontal' ? 0 : 1,
        width: axis === 'horizontal' ? horizontalGridSize : 1000,
        height: 900,
        root: {
          type: 'branch',
          size: axis === 'horizontal' ? horizontalGridSize : 900,
          children: [
            leaf(
              'outside-start',
              axis === 'horizontal' ? horizontalLeafSize : 150,
            ),
            {
              type: 'branch',
              size: axis === 'horizontal' ? horizontalInnerSize : 600,
              children: ['a', 'b', 'c', 'd'].map((id) =>
                leaf(id, axis === 'horizontal' ? horizontalLeafSize : 225),
              ),
            },
            leaf(
              'outside-end',
              axis === 'horizontal' ? horizontalLeafSize : 250,
            ),
          ],
        },
      },
      activeGroupId: 'b',
      mostRecentActiveGroupIds: ['b'],
    };
    expect(store().restoreLayout(key, file)).toBe(true);
    return key;
  }

  function boxes(key: string): Record<string, PanelLeafLayoutBox | undefined> {
    const result: Record<string, PanelLeafLayoutBox | undefined> = {};
    store().layouts[key].leafViews.forEach(
      (view: PanelLeafView, id: string): void => {
        result[id] = view.lastLayout;
      },
    );
    return result;
  }

  test.each(['horizontal', 'vertical'] as const)(
    'inner %s collapse transfers space to the adjacent sibling and restores it',
    (axis) => {
      const key = initializeInnerSplit(axis);
      const dimension = axis === 'horizontal' ? 'width' : 'height';
      const before = boxes(key);
      const element = store().layouts[key].leafViews.get('b')?.element;
      expect(store().collapseGroup(key, 'b')).toBe(true);
      const after = boxes(key);
      expect(after.b?.[dimension]).toBe(48);
      expect(after.c?.[dimension]).toBe(
        (before.b?.[dimension] ?? 0) + (before.c?.[dimension] ?? 0) - 48,
      );
      for (const id of ['a', 'd', 'outside-start', 'outside-end'])
        expect(after[id]).toEqual(before[id]);
      expect(store().expandGroup(key, 'b')).toBe(true);
      expect(boxes(key)).toEqual(before);
      expect(store().layouts[key].leafViews.get('b')?.element).toBe(element);
    },
  );

  test('a compact branch updates its expansion direction when its receiving neighbor collapses', () => {
    const key = initializeInnerSplit('vertical');
    for (const id of ['a', 'b', 'c', 'd'])
      expect(store().collapseGroup(key, id)).toBe(true);
    expect(
      store().layouts[key].controller.getCollapsedBranches?.()[0].edge,
    ).toBe('left');
    expect(store().collapseGroup(key, 'outside-end')).toBe(true);
    expect(
      store().layouts[key].controller.getCollapsedBranches?.()[0].edge,
    ).toBe('right');
  });

  test('reopening siblings in a different order preserves their original sizes', () => {
    const key = initializeInnerSplit('vertical');
    const before = boxes(key);
    expect(store().collapseGroup(key, 'c')).toBe(true);
    expect(store().collapseGroup(key, 'b')).toBe(true);
    expect(store().expandGroup(key, 'c')).toBe(true);
    expect(store().expandGroup(key, 'b')).toBe(true);
    expect(boxes(key)).toEqual(before);
  });

  test('inner collapse falls back to the preceding sibling and survives restore and structural edits', () => {
    const key = initializeInnerSplit('vertical');
    expect(store().collapseGroup(key, 'c')).toBe(true);
    const before = boxes(key);
    expect(store().collapseGroup(key, 'b')).toBe(true);
    expect(store().layouts[key].groups.b.collapsed?.edge).toBe('bottom');
    expect(boxes(key).d).toEqual(before.d);
    expect(boxes(key).a?.height).toBe(
      (before.a?.height ?? 0) + (before.b?.height ?? 0) - 48,
    );
    const file = store().serializeLayout(key);
    const savedBoxes = boxes(key);
    const restored = nextKey();
    expect(store().restoreLayout(restored, file)).toBe(true);
    expect(boxes(restored)).toEqual(savedBoxes);
    expect(store().layouts[restored].groups.b.collapsed?.edge).toBe('bottom');
    expect(store().layouts[restored].groups.c.collapsed?.edge).toBe('top');
    store().closeGroup(restored, 'a');
    expect(store().layouts[restored].groups.b.collapsed).toBeDefined();
    expect(store().expandGroup(restored, 'c')).toBe(true);
  });

  test.each(['horizontal', 'vertical'] as const)(
    'a fully collapsed %s pair restores its ratio in either expansion order',
    (axis) => {
      for (const collapseOrder of [
        ['b', 'c'],
        ['c', 'b'],
      ]) {
        for (const expandOrder of [
          ['b', 'c'],
          ['c', 'b'],
        ]) {
          const key = initializeInnerSplit(axis);
          store().closeGroup(key, 'a');
          store().closeGroup(key, 'd');
          const before = boxes(key);
          for (const id of collapseOrder)
            expect(store().collapseGroup(key, id)).toBe(true);
          for (const id of expandOrder)
            expect(store().expandGroup(key, id)).toBe(true);
          expect(boxes(key)).toEqual(before);
        }
      }
    },
  );

  test('every collapse and expansion order restores a four-sibling split', () => {
    const permutations = (ids: string[]): string[][] =>
      ids.length === 0
        ? [[]]
        : ids.flatMap((id) =>
            permutations(ids.filter((other) => other !== id)).map((tail) => [
              id,
              ...tail,
            ]),
          );
    for (const collapseOrder of permutations(['a', 'b', 'c', 'd'])) {
      for (const expandOrder of permutations(['a', 'b', 'c', 'd'])) {
        const key = initializeInnerSplit('vertical');
        const before = boxes(key);
        for (const id of collapseOrder)
          expect(store().collapseGroup(key, id)).toBe(true);
        for (const id of expandOrder)
          expect(store().expandGroup(key, id)).toBe(true);
        expect(boxes(key)).toEqual(before);
        store().disposeLayout(key);
      }
    }
  });

  test.each([0, 1, 2, 3])(
    'pair ratios survive restart after step %i and repeated collapse',
    (restartStep) => {
      let key = initializeInnerSplit('vertical');
      store().closeGroup(key, 'a');
      store().closeGroup(key, 'd');
      store().resizeGroup(key, 'b', { width: 1000, height: 360 });
      const before = boxes(key);
      const actions: (() => boolean)[] = [
        (): boolean => store().collapseGroup(key, 'c'),
        (): boolean => store().collapseGroup(key, 'b'),
        (): boolean => store().expandGroup(key, 'c'),
        (): boolean => store().expandGroup(key, 'b'),
      ];
      for (let step = 0; step < actions.length; step++) {
        expect(actions[step]()).toBe(true);
        if (step === restartStep) {
          const file: unknown = JSON.parse(
            JSON.stringify(store().serializeLayout(key)),
          );
          store().disposeLayout(key);
          key = nextKey();
          expect(store().restoreLayout(key, file)).toBe(true);
        }
      }
      expect(boxes(key)).toEqual(before);
      for (const id of ['b', 'c'])
        expect(store().collapseGroup(key, id)).toBe(true);
      expect(store().expandGroup(key, 'c')).toBe(true);
      expect(store().collapseGroup(key, 'c')).toBe(true);
      for (const id of ['b', 'c'])
        expect(store().expandGroup(key, id)).toBe(true);
      expect(boxes(key)).toEqual(before);
    },
  );

  test('borrowed branch widths survive collapsing the receiving outer sibling', () => {
    const key = initializeInnerSplit('vertical');
    const before = boxes(key);
    for (const id of ['a', 'b', 'c', 'd', 'outside-end'])
      expect(store().collapseGroup(key, id)).toBe(true);
    for (const id of ['a', 'outside-end', 'b', 'c', 'd'])
      expect(store().expandGroup(key, id)).toBe(true);
    expect(boxes(key)).toEqual(before);
  });

  test('resizing expanded siblings while another is collapsed retains the new allocation', () => {
    const key = initializeInnerSplit('vertical');
    const before = boxes(key);
    expect(store().collapseGroup(key, 'a')).toBe(true);
    store().resizeGroup(key, 'c', { width: 1000, height: 275 });
    expect(store().expandGroup(key, 'a')).toBe(true);
    const after = boxes(key);
    expect(after.a).toEqual(before.a);
    expect(after.b).toEqual(before.b);
    expect(after.c?.height).toBe(275);
    expect(after.d?.height).toBe(175);
  });

  test('legacy collapsed layouts restore their saved extent without capturing bar proportions', () => {
    const key = initializeInnerSplit('vertical');
    const before = boxes(key);
    expect(store().collapseGroup(key, 'b')).toBe(true);
    const file: unknown = JSON.parse(
      JSON.stringify(store().serializeLayout(key)),
      (name: string, value: unknown): unknown =>
        name === 'expandedSizes' ? undefined : value,
    );
    const restored = nextKey();
    expect(store().restoreLayout(restored, file)).toBe(true);
    expect(store().expandGroup(restored, 'b')).toBe(true);
    expect(boxes(restored)).toEqual(before);
  });

  test('a topology edit does not turn a collapsed bar into its expanded preference', () => {
    const key = initializeInnerSplit('vertical');
    expect(store().collapseGroup(key, 'b')).toBe(true);
    store().closeGroup(key, 'a');
    expect(store().expandGroup(key, 'b')).toBe(true);
    expect(boxes(key).b?.height).toBe(225);
  });

  test('a compact pair retains its ratio through a container resize', () => {
    const key = initializeInnerSplit('vertical');
    store().closeGroup(key, 'a');
    store().closeGroup(key, 'd');
    store().resizeGroup(key, 'b', { width: 1000, height: 360 });
    for (const id of ['c', 'b'])
      expect(store().collapseGroup(key, id)).toBe(true);
    store().layoutContainer(key, 1000, 1800);
    for (const id of ['c', 'b'])
      expect(store().expandGroup(key, id)).toBe(true);
    expect(boxes(key).b?.height).toBe(720);
    expect(boxes(key).c?.height).toBe(1080);
  });

  test('a legacy half-collapsed pair can collapse fully and reopen in either order', () => {
    const key = initializeInnerSplit('vertical');
    store().closeGroup(key, 'a');
    store().closeGroup(key, 'd');
    const before = boxes(key);
    expect(store().collapseGroup(key, 'c')).toBe(true);
    const file: unknown = JSON.parse(
      JSON.stringify(store().serializeLayout(key)),
      (name: string, value: unknown): unknown =>
        name === 'expandedSizes' ? undefined : value,
    );
    const restored = nextKey();
    expect(store().restoreLayout(restored, file)).toBe(true);
    expect(store().collapseGroup(restored, 'b')).toBe(true);
    for (const id of ['c', 'b'])
      expect(store().expandGroup(restored, id)).toBe(true);
    expect(boxes(restored)).toEqual(before);
  });

  test('an inner pair collapses as a branch while outer panels remain expanded', () => {
    const key = initializeInnerSplit('horizontal');
    store().closeGroup(key, 'a');
    store().closeGroup(key, 'd');
    expect(store().collapseGroup(key, 'b')).toBe(true);
    expect(store().collapseGroup(key, 'c')).toBe(true);
    store().closeGroup(key, 'c');
    expect(store().layouts[key].groups.b.collapsed).toBeUndefined();
  });

  test.each(['horizontal', 'vertical'] as const)(
    'recursive branch collapse restores a selected child in a %s split',
    (axis) => {
      const key = initializeInnerSplit(axis);
      const before = boxes(key);
      const originalViews = new Map<string, PanelLeafView>(
        store().layouts[key].leafViews,
      );
      for (const id of ['a', 'b', 'c', 'd'])
        expect(store().collapseGroup(key, id)).toBe(true);
      const serialized = store().serializeLayout(key);
      expect(serialized).not.toBeNull();
      expect(store().expandGroup(key, 'b')).toBe(true);
      expect(store().layouts[key].groups.b.collapsed).toBeUndefined();
      for (const id of ['a', 'c', 'd'])
        expect(store().layouts[key].groups[id].collapsed).toBeDefined();
      const cross = axis === 'horizontal' ? 'height' : 'width';
      expect(boxes(key).b?.[cross]).toBe(before.b?.[cross]);
      originalViews.forEach((view: PanelLeafView, id: string): void => {
        expect(store().layouts[key].leafViews.get(id)).toBe(view);
      });
      const restored = nextKey();
      expect(store().restoreLayout(restored, serialized)).toBe(true);
      expect(store().expandGroup(restored, 'c')).toBe(true);
      expect(boxes(restored).c?.[cross]).toBe(before.c?.[cross]);
      for (const id of ['a', 'b', 'd'])
        expect(store().layouts[restored].groups[id].collapsed).toBeDefined();
    },
  );

  test.each('ABCDEFGHI'.split(''))(
    'recursive branch collapse can retain only %s in the nine-panel tree',
    (survivor) => {
      const key = nextKey();
      const leaf = (id: string, size: number): ISerializedPanelLeafNode => ({
        type: 'leaf',
        groupId: id,
        size,
        panels: [
          {
            panelId: `p-${id}`,
            kind: 'terminal',
            instance: { terminalId: id },
          },
        ],
        activePanelId: `p-${id}`,
      });
      const branch = (
        size: number,
        children: ISerializedPanelNode[],
      ): ISerializedPanelNode => ({ type: 'branch', size, children });
      expect(
        store().restoreLayout(key, {
          version: 1,
          activeGroupId: survivor,
          mostRecentActiveGroupIds: [survivor],
          grid: {
            orientation: 1,
            width: 1500,
            height: 800,
            root: branch(800, [
              leaf('A', 120),
              branch(700, [
                branch(620, [leaf('B', 350), leaf('C', 350)]),
                leaf('D', 180),
              ]),
              branch(340, [leaf('E', 300), leaf('F', 260), leaf('G', 240)]),
              branch(340, [leaf('H', 420), leaf('I', 380)]),
            ]),
          },
        }),
      ).toBe(true);
      const order = 'ABCDEFGHI'.split('').filter((id) => id !== survivor);
      const originalViews = new Map<string, PanelLeafView>(
        store().layouts[key].leafViews,
      );
      for (const id of order) expect(store().collapseGroup(key, id)).toBe(true);
      expect(store().collapseGroup(key, survivor)).toBe(false);
      expect(store().layouts[key].grid.maximumWidth).toBe(
        Number.POSITIVE_INFINITY,
      );
      expect(store().layouts[key].grid.maximumHeight).toBe(
        Number.POSITIVE_INFINITY,
      );
      const saved = store().serializeLayout(key);
      for (const id of [...order].reverse())
        expect(store().expandGroup(key, id)).toBe(true);
      originalViews.forEach((view: PanelLeafView, id: string): void => {
        expect(store().layouts[key].leafViews.get(id)).toBe(view);
      });
      const restored = nextKey();
      expect(store().restoreLayout(restored, saved)).toBe(true);
      expect(
        Object.values(store().layouts[restored].groups).filter(
          (group) => group.collapsed === undefined,
        ),
      ).toHaveLength(1);
      for (const id of order)
        expect(store().expandGroup(restored, id)).toBe(true);
    },
  );

  test.each(['close', 'move', 'split', 'maximize', 'close-expanded'] as const)(
    'recursive branch collapse survives %s operations',
    (operation) => {
      const key = initializeInnerSplit('vertical');
      for (const id of ['a', 'b', 'c', 'd'])
        expect(store().collapseGroup(key, id)).toBe(true);
      if (operation === 'close') store().closeGroup(key, 'b');
      if (operation === 'move')
        store().movePanel(key, 'panel-b', 'outside-end', 'center');
      if (operation === 'split')
        expect(store().splitGroup(key, 'b', 'right')).not.toBeNull();
      if (operation === 'maximize') {
        store().maximizeGroup(key, 'b', true);
        expect(store().layouts[key].maximizedGroupId).toBe('b');
        store().maximizeGroup(key, 'b', false);
      }
      if (operation === 'close-expanded') {
        store().closeGroup(key, 'outside-start');
        store().closeGroup(key, 'outside-end');
        expect(
          Object.values(store().layouts[key].groups).some(
            (group) => group.collapsed === undefined,
          ),
        ).toBe(true);
      }
      expect(store().expandGroup(key, 'c')).toBe(true);
      expect(store().layouts[key].grid.maximumWidth).toBe(
        Number.POSITIVE_INFINITY,
      );
      expect(store().layouts[key].grid.maximumHeight).toBe(
        Number.POSITIVE_INFINITY,
      );
      const saved = store().serializeLayout(key);
      const restored = nextKey();
      expect(store().restoreLayout(restored, saved)).toBe(true);
      expect(store().layouts[restored].groups.c.collapsed).toBeUndefined();
    },
  );

  test('fixed-topology restore from maximize keeps collapsed groups hidden', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    setPanelLayoutFixedTopology(key, true);
    try {
      const collapsedView = store().layouts[key].leafViews.get('group-b');
      expect(collapsedView).toBeDefined();
      if (!collapsedView) throw new Error('group-b view was not initialized');

      expect(store().collapseGroup(key, 'group-b')).toBe(true);
      expect(store().layouts[key].grid.isViewVisible(collapsedView)).toBe(
        false,
      );

      store().maximizeGroup(key, 'group-a', true);
      store().maximizeGroup(key, 'group-a', false);

      expect(store().layouts[key].groups['group-b'].collapsed).toBeDefined();
      expect(store().layouts[key].grid.isViewVisible(collapsedView)).toBe(
        false,
      );
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('fixed-topology collapsed groups are fully hidden and reappear when the policy is removed', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const view = store().layouts[key].leafViews.get('group-a');
    expect(view).toBeDefined();
    if (!view) throw new Error('group-a view was not initialized');

    store().collapseGroup(key, 'group-a');
    expect(store().layouts[key].grid.isViewVisible(view)).toBe(true);

    setPanelLayoutFixedTopology(key, true);
    expect(store().layouts[key].grid.isViewVisible(view)).toBe(false);
    expect(store().layouts[key].groups['group-a'].collapsed).toBeDefined();

    expect(store().expandGroup(key, 'group-a')).toBe(true);
    expect(store().layouts[key].grid.isViewVisible(view)).toBe(true);
    expect(store().layouts[key].groups['group-a'].collapsed).toBeUndefined();

    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    expect(store().layouts[key].grid.isViewVisible(view)).toBe(false);

    setPanelLayoutFixedTopology(key, false);
    expect(store().layouts[key].grid.isViewVisible(view)).toBe(true);
    expect(store().layouts[key].groups['group-a'].collapsed).toBeDefined();
  });

  test('removing fixed topology derives compact branches from collapsed descendants', () => {
    const key = initializeInnerSplit('vertical');
    setPanelLayoutFixedTopology(key, true);
    try {
      for (const id of ['a', 'b', 'c', 'd'])
        expect(store().collapseGroup(key, id)).toBe(true);

      expect(store().layouts[key].controller.getCollapsedBranches?.()).toEqual(
        [],
      );

      setPanelLayoutFixedTopology(key, false);

      expect(
        store().layouts[key].controller.getCollapsedBranches?.(),
      ).toHaveLength(1);
      for (const id of ['a', 'b', 'c', 'd']) {
        const view = store().layouts[key].leafViews.get(id);
        expect(view).toBeDefined();
        if (!view) throw new Error(`${id} view was not initialized`);
        expect(store().layouts[key].grid.isViewInCollapsedBranch(view)).toBe(
          true,
        );
      }
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('maximize temporarily releases an unrelated compact sibling branch', () => {
    const key = initializeInnerSplit('vertical');
    for (const id of ['a', 'b', 'c', 'd'])
      expect(store().collapseGroup(key, id)).toBe(true);
    expect(
      store().layouts[key].controller.getCollapsedBranches?.(),
    ).toHaveLength(1);

    store().maximizeGroup(key, 'outside-start', true);

    expect(store().layouts[key].controller.getCollapsedBranches?.()).toEqual(
      [],
    );

    store().maximizeGroup(key, 'outside-start', false);

    expect(
      store().layouts[key].controller.getCollapsedBranches?.(),
    ).toHaveLength(1);
  });

  test('collapse pins the leaf, records state, bumps revision, and view model reflects it', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS); // horizontal: group-a | group-b
    const before = store().layouts[key];
    const view = before.leafViews.get('group-a');
    expect(view).toBeDefined();

    const ok = store().collapseGroup(key, 'group-a');
    expect(ok).toBe(true);

    const layout = store().layouts[key];
    expect(layout.revision).toBe(before.revision + 1);
    const collapsedState = layout.groups['group-a'].collapsed;
    expect(collapsedState?.edge).toBe('left');
    expect(typeof collapsedState?.expandedSize).toBe('number');
    const model = layout.viewModel.groups.find((g) => g.groupId === 'group-a');
    expect(model?.collapsed).toEqual({ edge: 'left' });
    expect(view?.minimumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
    expect(view?.maximumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
  });

  test('collapsed group reports no active panel in the view model but retains and restores it', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const activeBefore = store().layouts[key].groups['group-a'].activePanelId;
    expect(activeBefore).not.toBeNull();

    store().collapseGroup(key, 'group-a');
    const collapsed = store().layouts[key];
    // View model hides the active panel (no active/selected state shown)...
    const collapsedModel = collapsed.viewModel.groups.find(
      (g) => g.groupId === 'group-a',
    );
    expect(collapsedModel?.activePanelId).toBeNull();
    // ...but the raw store state remembers it.
    expect(collapsed.groups['group-a'].activePanelId).toBe(activeBefore);

    store().expandGroup(key, 'group-a');
    const expanded = store().layouts[key];
    const expandedModel = expanded.viewModel.groups.find(
      (g) => g.groupId === 'group-a',
    );
    expect(expandedModel?.activePanelId).toBe(activeBefore);
  });

  test('expand restores constraints and size, clears state, optionally activates a tab', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const view = store().layouts[key].leafViews.get('group-a');
    const sizeBefore = store().layouts[key].grid.getViewSize(view);
    store().collapseGroup(key, 'group-a');

    const ok = store().expandGroup(key, 'group-a');
    expect(ok).toBe(true);
    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    expect(view?.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(view?.maximumWidth).toBe(Number.POSITIVE_INFINITY);
    expect(layout.grid.getViewSize(view).width).toBeCloseTo(
      sizeBefore.width,
      0,
    );
    expect(layout.activeGroupId).toBe('group-a'); // expand focuses the group
  });

  test("container relayout preserves a collapsed group's proportional expanded size", () => {
    const key = nextKey();
    store().initializeLayout(key, {
      ...TWO_GROUPS,
      containerSize: { width: 1_200, height: 600 },
    });
    setPanelLayoutFixedTopology(key, true);
    try {
      expect(store().collapseGroup(key, 'group-b')).toBe(true);

      store().layoutContainer(key, 1_120, 600);
      expect(store().expandGroup(key, 'group-b')).toBe(true);

      const layout = store().layouts[key];
      const first = layout.leafViews.get('group-a');
      const second = layout.leafViews.get('group-b');
      expect(layout.grid.getViewSize(first).width).toBeCloseTo(560, 0);
      expect(layout.grid.getViewSize(second).width).toBeCloseTo(560, 0);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('divider drag completion bumps the size revision while a sibling is collapsed', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    const revisionBefore = store().layoutSizeRevisions[key] ?? 0;
    const sashes = store().layouts[key].grid.element.querySelectorAll(
      '.canopy-sash.vertical',
    );
    const sash = sashes.item(1);
    expect(sash).toBeInstanceOf(HTMLElement);
    if (!(sash instanceof HTMLElement)) {
      throw new Error('Expected the second root sash');
    }

    sash.dispatchEvent(createPointerEvent('pointerdown', 600, 0));
    window.dispatchEvent(createPointerEvent('pointermove', 660, 0));
    window.dispatchEvent(createPointerEvent('pointerup', 660, 0));

    expect(store().layoutSizeRevisions[key]).toBeGreaterThan(revisionBefore);
  });

  test('container relayout does not rebuild the render view-model', () => {
    const key = nextKey();
    store().initializeLayout(key, {
      ...TWO_GROUPS,
      containerSize: { width: 1_200, height: 600 },
    });
    setPanelLayoutFixedTopology(key, true);
    try {
      expect(store().collapseGroup(key, 'group-b')).toBe(true);
      const layoutBefore = store().layouts[key];
      const groupsBefore = layoutBefore.groups;
      const viewModelBefore = layoutBefore.viewModel;
      const sizeRevisionBefore = store().layoutSizeRevisions[key] ?? 0;

      store().layoutContainer(key, 1_120, 600);

      const layoutAfter = store().layouts[key];
      expect(layoutAfter).toBe(layoutBefore);
      expect(layoutAfter.groups).not.toBe(groupsBefore);
      expect(layoutAfter.viewModel).toBe(viewModelBefore);
      expect(layoutAfter.groups['group-b'].collapsed?.expandedSize).toBeCloseTo(
        560,
        0,
      );
      expect(store().layoutSizeRevisions[key]).toBeGreaterThan(
        sizeRevisionBefore,
      );
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('collapsed restore proportions survive a below-minimum resize round trip', () => {
    const key = nextKey();
    store().initializeLayout(key, {
      ...TWO_GROUPS,
      containerSize: { width: 1_200, height: 600 },
    });
    setPanelLayoutFixedTopology(key, true);
    try {
      expect(store().collapseGroup(key, 'group-b')).toBe(true);

      store().layoutContainer(key, 400, 600);
      store().layoutContainer(key, 1_200, 600);
      expect(store().expandGroup(key, 'group-b')).toBe(true);

      const layout = store().layouts[key];
      const first = layout.leafViews.get('group-a');
      const second = layout.leafViews.get('group-b');
      expect(layout.grid.getViewSize(first).width).toBeCloseTo(600, 0);
      expect(layout.grid.getViewSize(second).width).toBeCloseTo(600, 0);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('collapse refuses when affordance is not enabled (blocked or none)', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().collapseGroup(key, 'group-a');
    // group-b is now the last expandable leaf → blocked
    expect(store().collapseGroup(key, 'group-b')).toBe(false);
    expect(store().layouts[key].groups['group-b'].collapsed).toBeUndefined();
  });

  test('collapse refuses while a group is maximized; maximize expands-then-maximizes a collapsed group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-a', true);
    expect(store().collapseGroup(key, 'group-b')).toBe(false);
    store().maximizeGroup(key, 'group-a', false);

    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    const view = store().layouts[key].leafViews.get('group-a');
    // Maximizing a collapsed group expands it first (clears the collapsed
    // metadata and unpins the bar-size constraint), then maximizes.
    store().maximizeGroup(key, 'group-a', true);
    expect(store().layouts[key].maximizedGroupId).toBe('group-a');
    expect(store().layouts[key].groups['group-a'].collapsed).toBeUndefined();
    expect(view?.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(view?.maximumWidth).toBe(Number.POSITIVE_INFINITY);
    expect(view?.minimumHeight).toBe(DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT);
    expect(view?.maximumHeight).toBe(Number.POSITIVE_INFINITY);
  });

  test('view model exposes affordances', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const groups = store().layouts[key].viewModel.groups;
    for (const group of groups) {
      expect(group.collapseAffordance?.state).toBe('enabled');
    }
    store().collapseGroup(key, 'group-a');
    const after = store().layouts[key].viewModel.groups;
    const blockedAffordance = after.find(
      (g) => g.groupId === 'group-b',
    )?.collapseAffordance;
    expect(blockedAffordance?.state).toBe('blocked');
    if (blockedAffordance?.state === 'blocked') {
      expect(typeof blockedAffordance.edge).toBe('string');
    }
  });

  test('ensureGroupExpanded expands only when collapsed', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const revision = store().layouts[key].revision;
    store().ensureGroupExpanded(key, 'group-a'); // expanded → no-op, no commit
    expect(store().layouts[key].revision).toBe(revision);
    store().collapseGroup(key, 'group-a');
    store().ensureGroupExpanded(key, 'group-a');
    expect(store().layouts[key].groups['group-a'].collapsed).toBeUndefined();
  });

  test('ensureGroupExpanded can expand without focusing the group', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().collapseGroup(key, 'group-a');
    store().focusGroup(key, 'group-b');

    store().ensureGroupExpanded(key, 'group-a', { focus: false });

    expect(store().layouts[key].groups['group-a'].collapsed).toBeUndefined();
    expect(store().layouts[key].activeGroupId).toBe('group-b');
  });
});

describe('resizeGroup minimum width floor', () => {
  /**
   * Min-content width of an activity card header: 24+24 padding, a 16px
   * icon, 12+8 gaps, and a 28px icon button. A leaf narrower than this clips
   * the header action (the leaf is `overflow: hidden`), which is the
   * "CTA disappears when dragged narrow" report the floor exists to prevent.
   */
  const ACTIVITY_HEADER_MIN_CONTENT_WIDTH = 112;

  test('resizing a group below the floor clamps to the leaf minimum width', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS); // horizontal: group-a | group-b
    const view = store().layouts[key].leafViews.get('group-a');
    expect(view).toBeDefined();
    if (!view) throw new Error('group-a view was not initialized');

    store().resizeGroup(key, 'group-a', { width: 40, height: 800 });

    const size = store().layouts[key].grid.getViewSize(view);
    expect(size.width).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(size.width).toBeGreaterThanOrEqual(
      ACTIVITY_HEADER_MIN_CONTENT_WIDTH,
    );
  });

  test('restoring a persisted layout with a leaf below the floor clamps instead of failing', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) return;
    // Simulate a layout persisted under the old 100px floor.
    const narrowed: unknown = JSON.parse(
      JSON.stringify(file).replace(
        /"groupId":"group-a","panels":(\[[^\]]*\]),"activePanelId":"([^"]*)","size":\d+/,
        '"groupId":"group-a","panels":$1,"activePanelId":"$2","size":60',
      ),
    );
    expect(JSON.stringify(narrowed)).toContain('"size":60');

    expect(store().restoreLayout(key, narrowed)).toBe(true);
    const layout = store().layouts[key];
    const view = layout.leafViews.get('group-a');
    expect(view).toBeDefined();
    if (!view) throw new Error('group-a view was not restored');
    expect(layout.grid.getViewSize(view).width).toBeGreaterThanOrEqual(
      DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
    );
    expect(layout.grid.getViewSize(view).width).toBeGreaterThanOrEqual(
      ACTIVITY_HEADER_MIN_CONTENT_WIDTH,
    );
  });
});

describe('serializeLayout / restoreLayout', () => {
  function buildRichLayout(key: string): void {
    store().initializeLayout(key, TWO_GROUPS);
    // Split group-b down with a seeded browser group, split group-a right
    // with a seeded file tab, then merge the seeded file tab back into
    // group-a so it holds two tabs (unseeded splits create EMPTY groups —
    // per-entity tabs are never cloned).
    store().splitGroup(key, 'group-b', 'down', {
      kind: 'browser',
      groupId: 'group-browser',
      panelId: 'panel-browser',
      instance: { browserId: 'browser-rich' },
    });
    const seededGroupId = store().splitGroup(key, 'group-a', 'right', {
      kind: 'file-diff',
      groupId: 'group-file',
      panelId: 'panel-file',
      instance: { fileTabId: 'file-1' },
    });
    expect(seededGroupId).not.toBeNull();
    store().movePanel(key, 'panel-file', 'group-a', 'center');
    store().focusGroup(key, 'group-b');
  }

  test('round-trips tree shape, groups, tabs, active ids, MRU, and sizes', () => {
    const key = nextKey();
    buildRichLayout(key);
    const original = store().layouts[key];
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) {
      return;
    }

    expect(file.version).toBe(1);
    expect(file.activeGroupId).toBe('group-b');
    expect(file.mostRecentActiveGroupIds).toEqual(original.mruGroupIds);

    // Restore through a real JSON round trip into the same key.
    const gridBefore = original.grid;
    const parsed: unknown = JSON.parse(JSON.stringify(file));
    const restored = store().restoreLayout(key, parsed);
    expect(restored).toBe(true);

    const layout = store().layouts[key];
    // Wholesale rebuild: new grid identity, bumped revision.
    expect(layout.grid).not.toBe(gridBefore);
    expect(layout.revision).toBe(original.revision + 1);
    // Full view-model equality (groups in serialization order, tabs, actives).
    expect(layout.viewModel).toEqual(original.viewModel);
    expect(layout.activeGroupId).toBe(original.activeGroupId);
    expect(layout.mruGroupIds).toEqual(original.mruGroupIds);

    // Sizes survive: re-serializing reproduces the same file.
    expect(store().serializeLayout(key)).toEqual(file);
  });

  test('rescales collapsed restore sizes for a different container size', () => {
    const sourceKey = nextKey();
    const restoredKey = nextKey();
    store().initializeLayout(sourceKey, {
      ...TWO_GROUPS,
      containerSize: { width: 1_200, height: 600 },
    });
    setPanelLayoutFixedTopology(sourceKey, true);
    setPanelLayoutFixedTopology(restoredKey, true);
    try {
      expect(store().collapseGroup(sourceKey, 'group-b')).toBe(true);
      const file = store().serializeLayout(sourceKey);
      expect(file).not.toBeNull();
      if (file === null) return;

      expect(
        store().restoreLayout(restoredKey, file, {
          width: 800,
          height: 600,
        }),
      ).toBe(true);
      expect(store().expandGroup(restoredKey, 'group-b')).toBe(true);

      const layout = store().layouts[restoredKey];
      const first = layout.leafViews.get('group-a');
      const second = layout.leafViews.get('group-b');
      expect(layout.grid.getViewSize(first).width).toBeCloseTo(400, 0);
      expect(layout.grid.getViewSize(second).width).toBeCloseTo(400, 0);
    } finally {
      setPanelLayoutFixedTopology(sourceKey, false);
      setPanelLayoutFixedTopology(restoredKey, false);
    }
  });

  test('round-trips a usage panel variant through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'usage', {
        panelId: 'panel-usage',
        title: 'Usage (Codex)',
        instance: { variant: 'codex' },
      }),
    ).not.toBeNull();

    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) {
      return;
    }

    // A valid variant satisfies the instance contract on restore into a
    // fresh key, keeping its per-variant instance key and title.
    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    const usageTab = store()
      .layouts[key2].viewModel.groups.flatMap((group) => group.tabs)
      .find((tab) => tab.kind === 'usage');
    expect(usageTab?.instance).toEqual({ variant: 'codex' });
    expect(usageTab?.title).toBe('Usage (Codex)');
  });

  test('round-trips an automations panel variant through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'automations', {
        panelId: 'panel-automations',
        title: 'Automations (Overview)',
        instance: { variant: 'overview' },
      }),
    ).not.toBeNull();

    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) return;

    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    const automationsTab = store()
      .layouts[key2].viewModel.groups.flatMap((group) => group.tabs)
      .find((tab) => tab.kind === 'automations');
    expect(automationsTab?.instance).toEqual({ variant: 'overview' });
    expect(automationsTab?.title).toBe('Automations (Overview)');
  });

  test('round-trips tab titles and clamps over-length titles at serialize', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const longTitle = 'T'.repeat(PANEL_TITLE_MAX_LENGTH + 25);
    // Per-entity kinds with distinct bindings: a second terminal would be
    // rejected by singleton uniqueness.
    expect(
      store().addTab(key, 'group-a', 'file-diff', {
        panelId: 'panel-titled',
        title: 'My File',
        instance: { fileTabId: 'file-titled' },
      }),
    ).not.toBeNull();
    expect(
      store().addTab(key, 'group-b', 'chat', {
        panelId: 'panel-long',
        title: longTitle,
        instance: { chatTabId: 'chat-long' },
      }),
    ).not.toBeNull();

    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) {
      return;
    }
    const entries: Array<readonly [string, ISerializedPanelEntry]> = [];
    const walk = (node: ISerializedPanelNode): void => {
      if (node.type === 'leaf') {
        for (const panel of node.panels) {
          entries.push([panel.panelId, panel] as const);
        }
        return;
      }
      node.children.forEach(walk);
    };
    walk(file.grid.root);
    const entryById = new Map(entries);
    expect(entryById.get('panel-titled')?.title).toBe('My File');
    // Over-length titles are clamped at write time (protocol contract).
    expect(entryById.get('panel-long')?.title).toBe(
      'T'.repeat(PANEL_TITLE_MAX_LENGTH),
    );
    // Untitled tabs persist without a title key at all (instance bindings
    // persist verbatim).
    expect(entryById.get('panel-a')).toEqual({
      panelId: 'panel-a',
      kind: 'chat',
      instance: CHAT_A_INSTANCE,
    });

    // Restore into a fresh key: titles rehydrate into PanelTabDescriptor.
    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    const tabById = new Map(
      Object.values(store().layouts[key2].groups)
        .flatMap((group) => group.tabs)
        .map((tab) => [tab.panelId, tab] as const),
    );
    expect(tabById.get('panel-titled')?.title).toBe('My File');
    expect(tabById.get('panel-long')?.title).toBe(
      'T'.repeat(PANEL_TITLE_MAX_LENGTH),
    );
    expect(tabById.get('panel-a')?.title).toBeUndefined();

    // Titles survive a second serialize identically.
    expect(store().serializeLayout(key2)).toEqual(file);
  });

  test('round-trips maximized state', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().maximizeGroup(key, 'group-b', true);

    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();

    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    const layout = store().layouts[key2];
    expect(layout.maximizedGroupId).toBe('group-b');
    expect(getPanelGridController(key2)?.grid.hasMaximizedView()).toBe(true);
  });

  test('restores a bare-leaf-root file by wrapping it in a branch', () => {
    const key = nextKey();
    const leafRootFile = {
      version: 1,
      grid: {
        root: {
          type: 'leaf',
          groupId: 'solo',
          panels: [{ panelId: 'p1', kind: 'terminal' }],
          activePanelId: 'p1',
          size: 600,
        },
        orientation: 1,
        width: 800,
        height: 600,
      },
      activeGroupId: 'solo',
      mostRecentActiveGroupIds: ['solo'],
    };

    expect(store().restoreLayout(key, leafRootFile)).toBe(true);
    const layout = store().layouts[key];
    expect(groupIds(layout.viewModel)).toEqual(['solo']);
    expect(layout.viewModel.groups[0].activePanelId).toBe('p1');
    expect(layout.activeGroupId).toBe('solo');
  });

  test('rejects corrupt files without touching existing state', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    expect(store().restoreLayout(key, null)).toBe(false);
    expect(store().restoreLayout(key, { version: 99 })).toBe(false);
    expect(
      store().restoreLayout(key, { version: 1, grid: { root: 'nope' } }),
    ).toBe(false);
    expect(store().layouts[key]).toBe(before);
  });

  test('rejects structurally valid files with duplicate group ids', () => {
    const key = nextKey();
    const duplicateFile = {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          children: [
            {
              type: 'leaf',
              groupId: 'dup',
              panels: [{ panelId: 'p1', kind: 'chat' }],
              activePanelId: 'p1',
              size: 300,
            },
            {
              type: 'leaf',
              groupId: 'dup',
              panels: [{ panelId: 'p2', kind: 'chat' }],
              activePanelId: 'p2',
              size: 300,
            },
          ],
          size: 600,
        },
        orientation: 1,
        width: 600,
        height: 600,
      },
      activeGroupId: 'dup',
      mostRecentActiveGroupIds: ['dup'],
    };

    expect(store().restoreLayout(key, duplicateFile)).toBe(false);
    expect(store().layouts[key]).toBeUndefined();
  });

  test('serializeLayout returns null for unknown keys', () => {
    expect(store().serializeLayout(nextKey())).toBeNull();
  });
});

describe('view-model referential behavior', () => {
  test('mutations produce a fresh view-model but keep the grid instance', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const layoutBefore = store().layouts[key];

    store().splitGroup(key, 'group-a', 'right');

    const layoutAfter = store().layouts[key];
    expect(layoutAfter.viewModel).not.toBe(layoutBefore.viewModel);
    expect(layoutAfter.grid).toBe(layoutBefore.grid);
    expect(layoutAfter.controller).not.toBe(layoutBefore.controller);
    expect(layoutAfter.controller.grid).toBe(layoutBefore.controller.grid);
  });

  test('non-topology commits keep the controller object stable', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const controllerBefore = store().layouts[key].controller;

    store().focusGroup(key, 'group-b');
    store().selectTab(key, 'group-a', 'panel-a');

    const layout = store().layouts[key];
    expect(layout.controller).toBe(controllerBefore);
    expect(layout.viewModel.activeGroupId).toBe('group-a');
  });

  test('mutating one worktree does not replace another worktree layout', () => {
    const keyA = nextKey();
    const keyB = nextKey();
    store().initializeLayout(keyA, TWO_GROUPS);
    store().initializeLayout(keyB, ONE_GROUP);

    const layoutBBefore = store().layouts[keyB];
    const viewModelBBefore = getPanelLayoutViewModel(keyB);

    const seenForB: Array<PanelLayoutViewModel | null> = [];
    const unsubscribe = usePanelLayoutStore.subscribe((state) => {
      seenForB.push(state.layouts[keyB]?.viewModel ?? null);
    });

    store().splitGroup(keyA, 'group-a', 'down');
    store().focusGroup(keyA, 'group-b');
    store().selectTab(keyA, 'group-a', 'panel-a');
    unsubscribe();

    // A selector for worktree B sees the identical object on every commit,
    // so components subscribed with useShallow never re-render for A.
    expect(seenForB.length).toBeGreaterThan(0);
    for (const seen of seenForB) {
      expect(seen).toBe(viewModelBBefore);
    }
    expect(store().layouts[keyB]).toBe(layoutBBefore);
    expect(store().layouts[keyA].viewModel).not.toBe(viewModelBBefore);
  });
});

describe('disposeLayout', () => {
  test('drops all state and disposes the grid', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(getPanelGridController(key)).not.toBeNull();

    store().disposeLayout(key);

    expect(store().layouts[key]).toBeUndefined();
    expect(getPanelGridController(key)).toBeNull();
    expect(getPanelLayoutViewModel(key)).toBeNull();
  });

  test('serialized files survive dispose + restore into a fresh key', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    const file: SerializablePanelLayoutFile | null =
      store().serializeLayout(key);
    store().disposeLayout(key);
    expect(file).not.toBeNull();

    const key2 = nextKey();
    expect(store().restoreLayout(key2, JSON.parse(JSON.stringify(file)))).toBe(
      true,
    );
    expect(groupIds(store().layouts[key2].viewModel)).toEqual([
      'group-a',
      'group-b',
      'group-c',
    ]);
  });
});

describe('focusGroupInDirection', () => {
  test('focuses the geometric neighbor and returns its id', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().layouts[key].activeGroupId).toBe('group-a');

    expect(store().focusGroupInDirection(key, 'right')).toBe('group-b');
    expect(store().layouts[key].activeGroupId).toBe('group-b');
    expect(store().layouts[key].mruGroupIds[0]).toBe('group-b');

    expect(store().focusGroupInDirection(key, 'right')).toBe('group-c');
    expect(store().focusGroupInDirection(key, 'left')).toBe('group-b');
  });

  test('returns null at layout edges and for row-orthogonal directions', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    // Horizontal row: nothing to the left of the first group, nothing above
    // or below any group.
    expect(store().focusGroupInDirection(key, 'left')).toBeNull();
    expect(store().focusGroupInDirection(key, 'up')).toBeNull();
    expect(store().focusGroupInDirection(key, 'down')).toBeNull();
    expect(store().layouts[key].activeGroupId).toBe('group-a');
  });

  test('returns null while a group is maximized or the layout is unknown', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    expect(store().focusGroupInDirection(key, 'right')).toBeNull();
    expect(store().layouts[key].activeGroupId).toBe('group-a');

    expect(store().focusGroupInDirection('project/none', 'right')).toBeNull();
  });

  test('prefers the most-recently-active group among boundary neighbors', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    // Split group-b downward so two groups (group-b + the clone) share the
    // boundary to the right of group-a.
    const cloneId = store().splitGroup(key, 'group-b', 'down');
    expect(cloneId).not.toBeNull();

    // Make group-b the more recently used of the two right-side neighbors,
    // then focus group-a.
    store().focusGroup(key, 'group-b');
    store().focusGroup(key, 'group-a');

    expect(store().focusGroupInDirection(key, 'right')).toBe('group-b');
  });
});

describe('aux layout keys', () => {
  test('makeAuxPanelLayoutKey/isAuxPanelLayoutKey round-trip', () => {
    const worktreeKey = makeWorktreePanelKey('project', 'worktree');
    const auxKey = makeAuxPanelLayoutKey(worktreeKey, 'aux-1');
    expect(auxKey).toBe('project/worktree#aux:aux-1');
    expect(isAuxPanelLayoutKey(auxKey)).toBe(true);
    expect(isAuxPanelLayoutKey(worktreeKey)).toBe(false);
  });
});

describe('extractGroupToLayout (Phase 8 pull-out)', () => {
  test('moves the group and ALL its tabs into a new single-group layout', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    // Give the moving group a second tab so multi-tab moves are covered.
    const extraPanelId = store().addTab(key, 'group-b', 'file-diff', {
      panelId: 'panel-extra',
      instance: { fileTabId: 'file-extra' },
    });
    expect(extraPanelId).toBe('panel-extra');

    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);

    // Source: group-b is gone; group-a survives.
    expect(groupIds(getPanelLayoutViewModel(key))).toEqual(['group-a']);

    // Target: single group with the same id, both tabs, active tab kept.
    const auxViewModel = getPanelLayoutViewModel(auxKey);
    expect(groupIds(auxViewModel)).toEqual(['group-b']);
    expect(
      auxViewModel?.groups[0].tabs.map((tab) => [tab.panelId, tab.kind]),
    ).toEqual([
      ['panel-b', 'terminal'],
      ['panel-extra', 'file-diff'],
    ]);
    expect(auxViewModel?.groups[0].activePanelId).toBe('panel-extra');
    expect(auxViewModel?.activeGroupId).toBe('group-b');

    // The aux layout is a real layout: it can split further.
    expect(store().splitGroup(auxKey, 'group-b', 'right')).not.toBeNull();
    expect(getPanelLayoutViewModel(auxKey)?.groups).toHaveLength(2);
  });

  test('rejects unknown layouts/groups, taken target keys, and the last group', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);

    expect(
      store().extractGroupToLayout('project/none', 'group-a', auxKey),
    ).toBe(false);
    expect(store().extractGroupToLayout(key, 'group-none', auxKey)).toBe(false);
    expect(store().extractGroupToLayout(key, 'group-a', key)).toBe(false);

    // Take the target key, then attempt to reuse it.
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(store().extractGroupToLayout(key, 'group-a', auxKey)).toBe(false);

    // group-a is now the source's last group: extraction must be rejected.
    const otherAuxKey = makeAuxPanelLayoutKey(key, 'aux-2');
    expect(store().extractGroupToLayout(key, 'group-a', otherAuxKey)).toBe(
      false,
    );
    expect(groupIds(getPanelLayoutViewModel(key))).toEqual(['group-a']);
  });
});

describe('adoptLayoutTabs (Phase 8 merge-back)', () => {
  test('center-docks every source tab into the MRU group and disposes the source', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);

    // Split inside the aux layout with a seeded tab so multiple source
    // groups are adopted in leaf order (unseeded splits are empty now).
    const cloneGroupId = store().splitGroup(auxKey, 'group-b', 'right', {
      kind: 'file-diff',
      panelId: 'panel-aux-file',
      instance: { fileTabId: 'file-aux' },
    });
    expect(cloneGroupId).not.toBeNull();

    // Make group-c the most-recently-active group of the main layout.
    store().focusGroup(key, 'group-c');

    expect(store().adoptLayoutTabs(auxKey, key)).toBe(true);

    // The aux layout is gone.
    expect(getPanelLayoutViewModel(auxKey)).toBeNull();
    expect(store().layouts[auxKey]).toBeUndefined();

    // group-c received panel-b plus the clone tab; the source layout's
    // active tab (the clone, focused by splitGroup) is now active.
    const viewModel = getPanelLayoutViewModel(key);
    const groupC = viewModel?.groups.find(
      (group) => group.groupId === 'group-c',
    );
    expect(groupC).toBeDefined();
    const tabIds = (groupC?.tabs ?? []).map((tab) => tab.panelId);
    expect(tabIds[0]).toBe('panel-c');
    expect(tabIds).toContain('panel-b');
    expect(tabIds).toHaveLength(3);
    expect(groupC?.activePanelId).not.toBe('panel-c');
    expect(viewModel?.activeGroupId).toBe('group-c');
  });

  test('rejects unknown layouts and identical keys', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    expect(store().adoptLayoutTabs(key, key)).toBe(false);
    expect(store().adoptLayoutTabs('project/none', key)).toBe(false);
    expect(store().adoptLayoutTabs(key, 'project/none')).toBe(false);
  });

  test('drops colliding panel ids and instance keys defensively', () => {
    const key = nextKey();
    const otherKey = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    // A second layout FAMILY legally reuses the same panel ids and instance
    // bindings (uniqueness is per family). Adopting its tabs into `key` must
    // drop every collision instead of duplicating panels — `addTab` can no
    // longer manufacture an in-family collision, so a foreign family is the
    // remaining source of duplicates.
    store().initializeLayout(otherKey, TWO_GROUPS);

    expect(store().adoptLayoutTabs(otherKey, key)).toBe(true);
    expect(store().layouts[otherKey]).toBeUndefined();
    const viewModel = getPanelLayoutViewModel(key);
    const allPanelIds = (viewModel?.groups ?? []).flatMap((group) =>
      group.tabs.map((tab) => tab.panelId),
    );
    expect(allPanelIds.filter((id) => id === 'panel-a')).toHaveLength(1);
    expect(allPanelIds.filter((id) => id === 'panel-b')).toHaveLength(1);
  });

  test('uses split sizing when a recreated group has a non-positive size hint', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-zero-size');
    store().initializeLayout(key, TWO_GROUPS);
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);

    expect(
      store().adoptLayoutTabs(auxKey, key, {
        preferredGroupId: 'group-b',
        fallbackAnchorGroupId: 'group-a',
        fallbackDirection: 'right',
        fallbackSize: 0,
      }),
    ).toBe(true);

    const layout = store().layouts[key];
    const restoredView = layout.leafViews.get('group-b');
    expect(restoredView).toBeDefined();
    if (restoredView === undefined) return;
    expect(layout.grid.getViewSize(restoredView).width).toBeGreaterThan(0);
  });
});

describe('collapse persistence and auto-expand', () => {
  test('collapsed state round-trips through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS); // horizontal: group-a | group-b
    store().collapseGroup(key, 'group-a');
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) {
      return;
    }
    const leafA = findLeafInFile(file, 'group-a');
    expect(leafA?.collapsed?.edge).toBe('left');
    expect(leafA?.collapsed?.expandedSize).toBeGreaterThan(0);

    const parsed: unknown = JSON.parse(JSON.stringify(file));
    expect(store().restoreLayout(key, parsed)).toBe(true);
    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed?.edge).toBe('left');
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
    expect(view?.maximumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
  });

  test('structurally stale collapsed flags are dropped on restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) {
      return;
    }

    // Claim BOTH leaves collapsed — sequentially illegal (a grid must always
    // keep at least one expandable leaf); the second claim must drop on
    // restore. Rebuilt immutably from the typed original, then JSON
    // round-tripped once at the end to mirror a real persisted read.
    const leaves: ISerializedPanelLeafNode[] = [];
    collectLeavesInNode(file.grid.root, leaves);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    let mangledRoot = file.grid.root;
    leaves.forEach((leaf, index) => {
      const collapsed: PanelCollapsedState = {
        edge: index === 0 ? 'left' : 'right',
        expandedSize: 300,
      };
      mangledRoot = withLeafCollapsed(mangledRoot, leaf.groupId, collapsed);
    });
    const mangledFile: SerializablePanelLayoutFile = {
      ...file,
      grid: { ...file.grid, root: mangledRoot },
    };

    const parsed: unknown = JSON.parse(JSON.stringify(mangledFile));
    expect(store().restoreLayout(key, parsed)).toBe(true);
    const layout = store().layouts[key];
    const collapsedCount = Object.values(layout.groups).filter(
      (group) => group.collapsed !== undefined,
    ).length;
    expect(collapsedCount).toBe(1);
  });

  test('addTab into a collapsed group auto-expands it', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS); // terminal already lives in group-b
    store().collapseGroup(key, 'group-a');
    const panelId = store().addTab(key, 'group-a', 'file-diff', {
      instance: { fileTabId: 'file-collapsed' },
    });
    expect(panelId).not.toBeNull();
    expect(store().layouts[key].groups['group-a'].collapsed).toBeUndefined();
  });

  test('background addTab preserves a collapsed group and its constraints', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    const before = store().layouts[key].groups['group-a'];

    const panelId = store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-background',
      instance: { fileTabId: 'file-background' },
      activate: false,
    });

    expect(panelId).toBe('panel-background');
    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed).toEqual(before.collapsed);
    expect(layout.groups['group-a'].activePanelId).toBe(before.activePanelId);
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
    expect(view?.maximumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
  });

  test('closing one tab in a collapsed group preserves collapsed constraints', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const extraPanelId = store().addTab(key, 'group-a', 'file-diff', {
      panelId: 'panel-extra',
      instance: { fileTabId: 'file-extra' },
    });
    expect(extraPanelId).toBe('panel-extra');
    expect(store().collapseGroup(key, 'group-a')).toBe(true);

    store().closeTab(key, 'group-a', 'panel-a');

    const layout = store().layouts[key];
    expect(layout.groups['group-a'].tabs.map((tab) => tab.panelId)).toEqual([
      'panel-extra',
    ]);
    expect(layout.groups['group-a'].collapsed?.edge).toBe('left');
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
    expect(view?.maximumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
  });

  test('movePanel onto a collapsed group auto-expands it and docks as a tab', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().collapseGroup(key, 'group-a');
    const sourcePanel = store().layouts[key].groups['group-b'].tabs[0].panelId;
    store().movePanel(key, sourcePanel, 'group-a', 'center');
    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    expect(
      layout.groups['group-a'].tabs.some((t) => t.panelId === sourcePanel),
    ).toBe(true);
    // The engine view must actually un-pin, not just the metadata.
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(view?.maximumWidth).toBe(Number.POSITIVE_INFINITY);
  });

  test('adoptLayoutTabs into a collapsed receiving group auto-expands it', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    // Make group-a the MRU (receiving) group, then collapse it. Main layout
    // is now group-a | group-c, so group-a collapses toward 'left'.
    store().focusGroup(key, 'group-a');
    expect(store().collapseGroup(key, 'group-a')).toBe(true);

    expect(store().adoptLayoutTabs(auxKey, key)).toBe(true);
    const layout = store().layouts[key];
    // Merge-back must expand the collapsed receiver in the same transaction:
    // metadata cleared AND the live view's constraints reset (no divergence).
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(view?.maximumWidth).toBe(Number.POSITIVE_INFINITY);
    expect(
      layout.groups['group-a'].tabs.some((t) => t.panelId === 'panel-b'),
    ).toBe(true);
  });

  test('arrangeGroups(even) expands all collapsed groups first', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().collapseGroup(key, 'group-a');
    store().arrangeGroups(key, 'even');
    const layout = store().layouts[key];
    expect(
      Object.values(layout.groups).every((g) => g.collapsed === undefined),
    ).toBe(true);
  });

  test('closing the only sibling leaves a collapsed sole survivor auto-expanded', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS); // horizontal: group-a | group-b
    expect(store().collapseGroup(key, 'group-a')).toBe(true);

    store().closeGroup(key, 'group-b');

    const layout = store().layouts[key];
    expect(Object.keys(layout.groups)).toEqual(['group-a']);
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(DEFAULT_PANEL_LEAF_MINIMUM_WIDTH);
    expect(view?.maximumWidth).toBe(Number.POSITIVE_INFINITY);
  });

  test('closing a group that promotes a stale-axis collapsed sibling auto-expands it', () => {
    const key = nextKey();
    // Root-H [ V[chat(top), terminal(bottom)], activity ] — the real default
    // worktree layout shape (lib/panels/default-layout.ts). Chat is the top
    // half of the vertical pair, so it can only collapse toward 'top'.
    store().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: CHAT_A_INSTANCE,
        },
        {
          kind: 'activity-section',
          groupId: 'group-activity',
          panelId: 'panel-activity',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    });
    const terminalGroupId = store().splitGroup(key, 'group-chat', 'down', {
      kind: 'terminal',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    });
    expect(terminalGroupId).toBe('group-terminal');

    expect(store().collapseGroup(key, 'group-chat')).toBe(true);
    expect(store().layouts[key].groups['group-chat'].collapsed?.edge).toBe(
      'top',
    );

    // Closing the chat group's vertical sibling collapses the (now
    // single-child) vertical branch away, promoting chat directly into the
    // horizontal root — its collapse axis (height) no longer matches its new
    // parent's orientation (horizontal), so the claim must be dropped.
    store().closeGroup(key, 'group-terminal');

    const layout = store().layouts[key];
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    const view = layout.leafViews.get('group-chat');
    expect(view?.minimumHeight).toBe(DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT);
    expect(view?.maximumHeight).toBe(Number.POSITIVE_INFINITY);
  });

  test('root-edge insertion preserves a collapse when its new inner position has sibling support', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS); // horizontal: a | b | c
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    expect(store().layouts[key].groups['group-a'].collapsed?.edge).toBe('left');

    const sourcePanelId =
      store().layouts[key].groups['group-b'].tabs[0].panelId;
    // Dropping a panel onto the grid's own left root edge inserts a new
    // leftmost group, bumping the previously left-adjacent collapsed group-a
    // inward. It now has a full-edge expanded sibling, so the existing bar
    // remains legal even though it no longer touches the workspace border.
    expect(store().movePanelToRootEdge(key, sourcePanelId, 'left')).toBe(true);

    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed?.edge).toBe('left');
    const view = layout.leafViews.get('group-a');
    expect(view?.minimumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
    expect(view?.maximumWidth).toBe(PANEL_COLLAPSED_BAR_SIZE);
  });
});

describe('browser panel instance contract', () => {
  test('addTab refuses Browser panels in auxiliary layouts', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const auxKey = `${key}#aux:window-1`;
    store().restoreLayout(auxKey, store().serializeLayout(key));

    expect(
      store().addTab(auxKey, 'group-a', 'browser', {
        instance: { browserId: 'browser-aux' },
      }),
    ).toBeNull();
  });

  test('addTab refuses an unbound Browser panel', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    expect(store().addTab(key, 'group-a', 'browser')).toBeNull();
    expect(
      store().addTab(key, 'group-a', 'browser', {
        instance: { browserId: '' },
      }),
    ).toBeNull();
    expect(
      store().addTab(key, 'group-a', 'browser', {
        instance: { browserId: '   ' },
      }),
    ).toBeNull();
  });

  test('allows multiple Browser panels with distinct ids, rejects duplicates family-wide', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    const first = store().addTab(key, 'group-a', 'browser', {
      instance: { browserId: 'b1' },
    });
    expect(first).not.toBeNull();
    // Repeatable: a SECOND Browser panel with a different id is fine, even
    // in another group.
    const second = store().addTab(key, 'group-b', 'browser', {
      instance: { browserId: 'b2' },
    });
    expect(second).not.toBeNull();
    // A duplicate binding is rejected anywhere in the layout family (not
    // just the same group).
    expect(
      store().addTab(key, 'group-b', 'browser', {
        instance: { browserId: 'b1' },
      }),
    ).toBeNull();

    // Duplicate rejection extends across the family's aux layouts too.
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(
      store().addTab(key, 'group-a', 'browser', {
        instance: { browserId: 'b2' },
      }),
    ).toBeNull();
  });

  test('restoreLayout rejects unbound Browser entries and duplicate bindings', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-b', 'browser', {
      panelId: 'panel-browser-b1',
      instance: { browserId: 'b1' },
    });
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) throw new Error('expected file');

    // A bound layout round-trips.
    const freshKey = nextKey();
    expect(store().restoreLayout(freshKey, file)).toBe(true);

    // Stripping the binding makes the file a rejected legacy shape.
    const unbound = JSON.parse(JSON.stringify(file)) as typeof file;
    const strip = (node: ISerializedPanelNode): void => {
      if (node.type === 'leaf') {
        for (const panel of node.panels as Array<
          ISerializedPanelEntry & { instance?: Record<string, string> }
        >) {
          if (panel.kind === 'browser') delete panel.instance;
        }
        return;
      }
      for (const child of node.children) strip(child);
    };
    strip(unbound.grid.root);
    expect(store().restoreLayout(nextKey(), unbound)).toBe(false);

    // Duplicating the binding onto a second entry is rejected too.
    const duplicated = JSON.parse(JSON.stringify(file)) as typeof file;
    const duplicate = (node: ISerializedPanelNode): void => {
      if (node.type === 'leaf') {
        const browserEntry = node.panels.find(
          (panel) => panel.kind === 'browser',
        );
        if (browserEntry !== undefined) {
          (node.panels as ISerializedPanelEntry[]).push({
            ...browserEntry,
            panelId: 'panel-browser-duplicate',
          });
        }
        return;
      }
      for (const child of node.children) duplicate(child);
    };
    duplicate(duplicated.grid.root);
    expect(store().restoreLayout(nextKey(), duplicated)).toBe(false);
  });

  test('fixed topology rejects structural operations but permits selection, resize, and maximize', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    setPanelLayoutFixedTopology(key, true);
    try {
      expect(store().splitGroup(key, 'group-a', 'right')).toBeNull();
      expect(store().movePanel(key, 'panel-a', 'group-b', 'center')).toBe(
        false,
      );
      expect(store().closeGroup(key, 'group-b')).toBe(false);
      store().maximizeGroup(key, 'group-a', true);
      expect(store().layouts[key]?.maximizedGroupId).toBe('group-a');
      expect(store().layouts[key]?.grid.hasMaximizedView()).toBe(true);
      store().maximizeGroup(key, 'group-a', false);
      expect(store().layouts[key]?.maximizedGroupId).toBeNull();
      store().selectTab(key, 'group-a', 'panel-a');
      expect(store().layouts[key]?.activeGroupId).toBe('group-a');
      store().resizeGroup(key, 'group-a', { width: 350, height: 600 });
      expect(store().serializeLayout(key)).not.toBeNull();
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });

  test('fixed topology allows any tab kind in Side Panel and Bottom Drawer but only Chat in Chat', () => {
    const key = nextKey();
    store().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          groupId: 'group-chat',
          panelId: 'chat',
          kind: 'chat',
        },
        { groupId: 'group-extras' },
        { groupId: 'group-terminal' },
      ],
    });
    setPanelLayoutFixedTopology(key, true);
    try {
      expect(
        store().addTab(key, 'group-extras', 'terminal', {
          panelId: 'terminal-side',
          instance: { terminalId: 't-side' },
        }),
      ).toBe('terminal-side');
      expect(
        store().addTab(key, 'group-terminal', 'browser', {
          panelId: 'browser-bottom',
          instance: { browserId: 'b-bottom' },
        }),
      ).toBe('browser-bottom');
      expect(
        store().addTab(key, 'group-terminal', 'chat', {
          panelId: 'chat-bottom',
          instance: { chatTabId: 'c-bottom' },
        }),
      ).toBe('chat-bottom');
      expect(
        store().addTab(key, 'group-chat', 'browser', {
          panelId: 'browser-chat',
          instance: { browserId: 'b-chat' },
        }),
      ).toBeNull();
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });
});

describe('pipeline-execution panel instance contract', () => {
  const RUN_1 = { executionId: 'run-1' } as const;
  const RUN_2 = { executionId: 'run-2' } as const;

  function runEntry(
    panelId: string,
    instance?: Readonly<Record<string, string>>,
  ): ISerializedPanelEntry {
    return {
      panelId,
      kind: 'pipeline-execution',
      ...(instance !== undefined ? { instance } : {}),
    };
  }

  function singleLeafFile(
    groupId: string,
    panels: readonly ISerializedPanelEntry[],
    activePanelId: string | null = panels[0]?.panelId ?? null,
  ): SerializablePanelLayoutFile {
    return {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 600,
          children: [
            { type: 'leaf', groupId, panels, activePanelId, size: 600 },
          ],
        },
        orientation: 1,
        width: 900,
        height: 600,
      },
      activeGroupId: groupId,
      mostRecentActiveGroupIds: [groupId],
    };
  }

  function tabsOf(key: string, groupId: string): readonly string[] {
    return (store().layouts[key]?.groups[groupId]?.tabs ?? []).map(
      (tab) => tab.panelId,
    );
  }

  test('keys identity on the bound executionId', () => {
    expect(
      getPanelInstanceKey({ kind: 'pipeline-execution', instance: RUN_1 }),
    ).toBe('pipeline-execution:run-1');
    // Job selection and breadcrumbs never enter the key: they are view state.
    expect(getPanelInstanceKey({ kind: 'pipeline-execution' })).toBe(
      'pipeline-execution:',
    );
  });

  test('addTab requires exactly one trimmed, bounded executionId', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    const invalidInstances: readonly (
      | Readonly<Record<string, string>>
      | undefined
    )[] = [
      undefined,
      {},
      { executionId: '' },
      { executionId: '  run-1' },
      { executionId: 'run-1', jobId: 'job-1' },
    ];
    for (const instance of invalidInstances) {
      expect(
        store().addTab(key, 'group-a', 'pipeline-execution', {
          ...(instance !== undefined ? { instance } : {}),
        }),
      ).toBeNull();
    }
    expect(store().layouts[key]).toBe(before);

    expect(
      store().addTab(key, 'group-a', 'pipeline-execution', {
        panelId: 'panel-pipeline-run-1',
        instance: RUN_1,
      }),
    ).toBe('panel-pipeline-run-1');
  });

  test('distinct runs coexist, one binding per run across the family, aux windows allowed', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'pipeline-execution', { instance: RUN_1 }),
    ).not.toBeNull();
    expect(
      store().addTab(key, 'group-b', 'pipeline-execution', { instance: RUN_2 }),
    ).not.toBeNull();
    expect(
      store().addTab(key, 'group-b', 'pipeline-execution', { instance: RUN_1 }),
    ).toBeNull();

    // Unlike Browser panels, a run panel may live in an auxiliary window.
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(
      findPanelByInstanceKey(key, 'pipeline-execution:run-2')?.layoutKey,
    ).toBe(auxKey);
    expect(
      store().addTab(auxKey, 'group-b', 'pipeline-execution', {
        instance: { executionId: 'run-3' },
      }),
    ).not.toBeNull();
    expect(
      store().addTab(auxKey, 'group-b', 'pipeline-execution', {
        instance: RUN_1,
      }),
    ).toBeNull();
  });

  test('round-trips a bound run tab through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-b', 'pipeline-execution', {
      panelId: 'panel-pipeline-run-1',
      title: 'Pipeline run',
      instance: RUN_1,
    });
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) return;

    const freshKey = nextKey();
    expect(
      store().restoreLayout(freshKey, JSON.parse(JSON.stringify(file))),
    ).toBe(true);
    expect(
      findPanelByInstanceKey(freshKey, 'pipeline-execution:run-1'),
    ).toEqual({
      layoutKey: freshKey,
      groupId: 'group-b',
      panelId: 'panel-pipeline-run-1',
    });
  });

  test('restore drops an unbound run tab instead of rejecting the layout', () => {
    const key = nextKey();
    const file = singleLeafFile(
      'group-runs',
      [
        runEntry('panel-unbound'),
        runEntry('panel-pipeline-run-1', RUN_1),
        { panelId: 'panel-chat', kind: 'chat', instance: CHAT_A_INSTANCE },
      ],
      'panel-unbound',
    );

    expect(store().restoreLayout(key, file)).toBe(true);
    expect(tabsOf(key, 'group-runs')).toEqual([
      'panel-pipeline-run-1',
      'panel-chat',
    ]);
    // The dangling active id falls back to the first surviving tab.
    expect(store().layouts[key]?.groups['group-runs']?.activePanelId).toBe(
      'panel-pipeline-run-1',
    );
  });

  test('restore keeps the first of duplicated run bindings in one file', () => {
    const key = nextKey();
    const file: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 600,
          children: [
            {
              type: 'leaf',
              groupId: 'group-first',
              panels: [runEntry('panel-pipeline-run-1', RUN_1)],
              activePanelId: 'panel-pipeline-run-1',
              size: 300,
            },
            {
              type: 'leaf',
              groupId: 'group-second',
              // Same deterministic panel id: dropped before the panel-id
              // uniqueness check could reject the whole file.
              panels: [
                runEntry('panel-pipeline-run-1', RUN_1),
                runEntry('panel-pipeline-run-2', RUN_2),
              ],
              activePanelId: 'panel-pipeline-run-1',
              size: 300,
            },
          ],
        },
        orientation: 1,
        width: 900,
        height: 600,
      },
      activeGroupId: 'group-first',
      mostRecentActiveGroupIds: ['group-first', 'group-second'],
    };

    expect(store().restoreLayout(key, file)).toBe(true);
    expect(tabsOf(key, 'group-first')).toEqual(['panel-pipeline-run-1']);
    expect(tabsOf(key, 'group-second')).toEqual(['panel-pipeline-run-2']);
  });

  test('restore dedups a run bound in both the main layout and a popped-out window (main first)', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    // Relaunch order (persistence bridge): the main grid restores first,
    // then each popped-out entry restores under its own aux key.
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [runEntry('panel-pipeline-run-1', RUN_1)]),
      ),
    ).toBe(true);
    expect(
      store().restoreLayout(
        auxKey,
        singleLeafFile('group-aux', [
          runEntry('panel-aux-run-1', RUN_1),
          runEntry('panel-pipeline-run-2', RUN_2),
        ]),
      ),
    ).toBe(true);

    expect(tabsOf(key, 'group-main')).toEqual(['panel-pipeline-run-1']);
    expect(tabsOf(auxKey, 'group-aux')).toEqual(['panel-pipeline-run-2']);
    expect(findPanelByInstanceKey(key, 'pipeline-execution:run-1')).toEqual({
      layoutKey: key,
      groupId: 'group-main',
      panelId: 'panel-pipeline-run-1',
    });

    // Re-restoring a layout never treats its own tabs as a conflict.
    const auxFile = store().serializeLayout(auxKey);
    expect(auxFile).not.toBeNull();
    expect(store().restoreLayout(auxKey, auxFile)).toBe(true);
    expect(tabsOf(auxKey, 'group-aux')).toEqual(['panel-pipeline-run-2']);
  });

  test('other kinds keep their restore behavior', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    // An unbound chat still rejects the whole file (legacy fallback trigger)…
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [{ panelId: 'panel-chat', kind: 'chat' }]),
      ),
    ).toBe(false);
    // …a duplicated chat binding within one file still rejects it…
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [
          { panelId: 'panel-chat-1', kind: 'chat', instance: CHAT_A_INSTANCE },
          { panelId: 'panel-chat-2', kind: 'chat', instance: CHAT_A_INSTANCE },
        ]),
      ),
    ).toBe(false);
    expect(store().layouts[key]).toBeUndefined();
    // …and the cross-family check applies to run panels only.
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [
          { panelId: 'panel-chat', kind: 'chat', instance: CHAT_A_INSTANCE },
        ]),
      ),
    ).toBe(true);
    expect(
      store().restoreLayout(
        auxKey,
        singleLeafFile('group-aux', [
          {
            panelId: 'panel-aux-chat',
            kind: 'chat',
            instance: CHAT_A_INSTANCE,
          },
        ]),
      ),
    ).toBe(true);
    expect(tabsOf(auxKey, 'group-aux')).toEqual(['panel-aux-chat']);
  });
});

describe('subagent panel kinds', () => {
  const SUB_1 = {
    rootChatId: 'chat-root',
    subagentId: 'delegation-1',
    subagentKind: 'managed',
  } as const;
  const SUB_2 = {
    rootChatId: 'chat-root',
    subagentId: 'toolu_2',
    subagentKind: 'claude-native',
  } as const;
  const SUB_1_KEY = 'subagent-chat:chat-root/delegation-1';

  function subagentEntry(
    panelId: string,
    instance?: Readonly<Record<string, string>>,
  ): ISerializedPanelEntry {
    return {
      panelId,
      kind: 'subagent-chat',
      ...(instance !== undefined ? { instance } : {}),
    };
  }

  function singleLeafFile(
    groupId: string,
    panels: readonly ISerializedPanelEntry[],
    activePanelId: string | null = panels[0]?.panelId ?? null,
  ): SerializablePanelLayoutFile {
    return {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 600,
          children: [
            { type: 'leaf', groupId, panels, activePanelId, size: 600 },
          ],
        },
        orientation: 1,
        width: 900,
        height: 600,
      },
      activeGroupId: groupId,
      mostRecentActiveGroupIds: [groupId],
    };
  }

  function tabsOf(key: string, groupId: string): readonly string[] {
    return (store().layouts[key]?.groups[groupId]?.tabs ?? []).map(
      (tab) => tab.panelId,
    );
  }

  test('keys subagent-chat identity on the root chat and subagent ids only', () => {
    expect(
      getPanelInstanceKey({ kind: 'subagent-chat', instance: SUB_1 }),
    ).toBe(SUB_1_KEY);
    // The subagent kind is a property of the binding, not its identity.
    expect(
      getPanelInstanceKey({
        kind: 'subagent-chat',
        instance: { ...SUB_1, subagentKind: 'codex-native' },
      }),
    ).toBe(SUB_1_KEY);
    // Encoding keeps ids containing the separator from colliding.
    expect(
      getPanelInstanceKey({
        kind: 'subagent-chat',
        instance: {
          rootChatId: 'a/b',
          subagentId: 'c',
          subagentKind: 'managed',
        },
      }),
    ).not.toBe(
      getPanelInstanceKey({
        kind: 'subagent-chat',
        instance: {
          rootChatId: 'a',
          subagentId: 'b/c',
          subagentKind: 'managed',
        },
      }),
    );
    expect(getPanelInstanceKey({ kind: 'subagents' })).toBe('subagents');
    expect(isSingletonPanelKind('subagents')).toBe(true);
    expect(isSingletonPanelKind('subagent-chat')).toBe(false);
  });

  test('the Subagents panel is a family-wide singleton', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    expect(store().addTab(key, 'group-a', 'subagents')).not.toBeNull();
    expect(store().addTab(key, 'group-b', 'subagents')).toBeNull();
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(store().addTab(auxKey, 'group-b', 'subagents')).toBeNull();
  });

  test('addTab requires exactly the three-key subagent binding', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];
    const invalidInstances: readonly (
      | Readonly<Record<string, string>>
      | undefined
    )[] = [
      undefined,
      {},
      { rootChatId: 'chat-root', subagentId: 'delegation-1' },
      { ...SUB_1, subagentKind: 'other' },
      { ...SUB_1, subagentId: ' delegation-1' },
      { ...SUB_1, extra: 'x' },
    ];
    for (const instance of invalidInstances) {
      expect(
        store().addTab(key, 'group-a', 'subagent-chat', {
          ...(instance !== undefined ? { instance } : {}),
        }),
      ).toBeNull();
    }
    expect(store().layouts[key]).toBe(before);
    expect(
      store().addTab(key, 'group-a', 'subagent-chat', {
        panelId: 'panel-subagent-1',
        instance: SUB_1,
      }),
    ).toBe('panel-subagent-1');
  });

  test('distinct subagents coexist, one binding per subagent across the family, aux windows allowed', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'subagent-chat', { instance: SUB_1 }),
    ).not.toBeNull();
    expect(
      store().addTab(key, 'group-b', 'subagent-chat', { instance: SUB_2 }),
    ).not.toBeNull();
    // Same (rootChatId, subagentId) under another subagent kind is a duplicate.
    expect(
      store().addTab(key, 'group-b', 'subagent-chat', {
        instance: { ...SUB_1, subagentKind: 'codex-native' },
      }),
    ).toBeNull();
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(
      store().addTab(auxKey, 'group-b', 'subagent-chat', { instance: SUB_1 }),
    ).toBeNull();
    expect(
      store().addTab(auxKey, 'group-b', 'subagent-chat', {
        instance: { ...SUB_1, subagentId: 'delegation-3' },
      }),
    ).not.toBeNull();
  });

  test('round-trips both kinds through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-a', 'subagents', { panelId: 'panel-subagents' });
    store().addTab(key, 'group-b', 'subagent-chat', {
      panelId: 'panel-subagent-1',
      title: 'Research agent',
      instance: SUB_1,
    });
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) return;

    const freshKey = nextKey();
    expect(
      store().restoreLayout(freshKey, JSON.parse(JSON.stringify(file))),
    ).toBe(true);
    expect(findPanelByInstanceKey(freshKey, SUB_1_KEY)).toEqual({
      layoutKey: freshKey,
      groupId: 'group-b',
      panelId: 'panel-subagent-1',
    });
    expect(findPanelByInstanceKey(freshKey, 'subagents')?.panelId).toBe(
      'panel-subagents',
    );
    const restored = store().layouts[freshKey]?.groups['group-b']?.tabs.find(
      (tab) => tab.panelId === 'panel-subagent-1',
    );
    expect(restored?.title).toBe('Research agent');
    expect(restored?.instance).toEqual(SUB_1);
  });

  test('restore drops malformed and duplicate subagent-chat tabs instead of rejecting the layout', () => {
    const key = nextKey();
    const file = singleLeafFile(
      'group-subagents',
      [
        subagentEntry('panel-unbound'),
        subagentEntry('panel-subagent-1', SUB_1),
        subagentEntry('panel-subagent-dup', {
          ...SUB_1,
          subagentKind: 'codex-native',
        }),
        { panelId: 'panel-chat', kind: 'chat', instance: CHAT_A_INSTANCE },
      ],
      'panel-unbound',
    );
    expect(store().restoreLayout(key, file)).toBe(true);
    expect(tabsOf(key, 'group-subagents')).toEqual([
      'panel-subagent-1',
      'panel-chat',
    ]);
    expect(store().layouts[key]?.groups['group-subagents']?.activePanelId).toBe(
      'panel-subagent-1',
    );
  });

  test('restore dedups a subagent bound in both the main layout and a popped-out window (main first)', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-1');
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [
          subagentEntry('panel-subagent-1', SUB_1),
        ]),
      ),
    ).toBe(true);
    expect(
      store().restoreLayout(
        auxKey,
        singleLeafFile('group-aux', [
          subagentEntry('panel-aux-subagent-1', SUB_1),
          subagentEntry('panel-subagent-2', SUB_2),
        ]),
      ),
    ).toBe(true);
    expect(tabsOf(key, 'group-main')).toEqual(['panel-subagent-1']);
    expect(tabsOf(auxKey, 'group-aux')).toEqual(['panel-subagent-2']);
  });

  test('a second Subagents panel in one file still rejects it (singleton rule)', () => {
    const key = nextKey();
    expect(
      store().restoreLayout(
        key,
        singleLeafFile('group-main', [
          { panelId: 'panel-subagents-1', kind: 'subagents' },
          { panelId: 'panel-subagents-2', kind: 'subagents' },
        ]),
      ),
    ).toBe(false);
  });
});

// The read-before-mutate sample two hosts share. It exists because both the
// shared grid surface and the desktop aux window must know whether THEIR
// gesture revealed a collapsed group, and both "Full screen" and a tab drop
// expand it inside the same transaction — so the flag has to be read first.
// Restating that at each call site left two files to keep in lockstep by hand.
describe('readPanelGroupRevealState', () => {
  it('reports a collapsed group and the tab the reveal would expose', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-b')).toBe(true);

    expect(readPanelGroupRevealState(key, 'group-b')).toEqual({
      collapsed: true,
      activePanelId: 'panel-b',
    });
  });

  it('reports an expanded group as not collapsed', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(readPanelGroupRevealState(key, 'group-b')).toEqual({
      collapsed: false,
      activePanelId: 'panel-b',
    });
  });

  it('is a safe no-op sample for an unknown layout or group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(readPanelGroupRevealState(key, 'group-missing')).toEqual({
      collapsed: false,
    });
    expect(readPanelGroupRevealState('no-such-layout', 'group-b')).toEqual({
      collapsed: false,
    });
  });
});

describe('plan panel instance contract', () => {
  test('derives per-plan instance keys for both plan kinds', () => {
    expect(
      getPanelInstanceKey({ kind: 'plan', instance: { planId: 'plan-1' } }),
    ).toBe('plan:plan-1');
    expect(
      getPanelInstanceKey({
        kind: 'plan-diagram',
        instance: { planId: 'plan-1' },
      }),
    ).toBe('plan-diagram:plan-1');
    // Unbound descriptors degrade to the bare `${kind}:` key.
    expect(getPanelInstanceKey({ kind: 'plan' })).toBe('plan:');
    expect(getPanelInstanceKey({ kind: 'plan-diagram' })).toBe('plan-diagram:');
  });

  test('addTab refuses plan panels without a non-empty planId', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const before = store().layouts[key];

    for (const kind of ['plan', 'plan-diagram'] as const) {
      expect(store().addTab(key, 'group-a', kind)).toBeNull();
      expect(
        store().addTab(key, 'group-a', kind, { instance: { planId: '' } }),
      ).toBeNull();
      expect(
        store().addTab(key, 'group-a', kind, { instance: { planId: '   ' } }),
      ).toBeNull();
    }
    expect(store().layouts[key]).toBe(before);
  });

  test('keeps one panel per plan per kind across the layout family', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-plan');
    store().initializeLayout(key, TWO_GROUPS);

    // A plan's document and diagram coexist; so do different plans.
    expect(
      store().addTab(key, 'group-a', 'plan', {
        panelId: 'panel-plan-1',
        instance: { planId: 'plan-1' },
      }),
    ).toBe('panel-plan-1');
    expect(
      store().addTab(key, 'group-b', 'plan-diagram', {
        panelId: 'panel-plan-diagram-1',
        instance: { planId: 'plan-1' },
      }),
    ).toBe('panel-plan-diagram-1');
    expect(
      store().addTab(key, 'group-a', 'plan', {
        panelId: 'panel-plan-2',
        instance: { planId: 'plan-2' },
      }),
    ).toBe('panel-plan-2');

    // The same plan twice is refused in any group.
    expect(
      store().addTab(key, 'group-b', 'plan', {
        instance: { planId: 'plan-1' },
      }),
    ).toBeNull();
    expect(
      store().addTab(key, 'group-a', 'plan-diagram', {
        instance: { planId: 'plan-1' },
      }),
    ).toBeNull();

    // …and across the family once a group lives in an aux window.
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(
      store().addTab(key, 'group-a', 'plan-diagram', {
        instance: { planId: 'plan-1' },
      }),
    ).toBeNull();
    expect(
      store().addTab(auxKey, 'group-b', 'plan', {
        instance: { planId: 'plan-2' },
      }),
    ).toBeNull();
    expect(findPanelByInstanceKey(key, 'plan-diagram:plan-1')).toEqual({
      layoutKey: auxKey,
      groupId: 'group-b',
      panelId: 'panel-plan-diagram-1',
    });
  });

  test('keys a plan instance by its trimmed planId', () => {
    for (const kind of ['plan', 'plan-diagram'] as const) {
      expect(
        getPanelInstanceKey({ kind, instance: { planId: ' plan-1 ' } }),
      ).toBe(getPanelInstanceKey({ kind, instance: { planId: 'plan-1' } }));
    }
  });

  test('a padded planId and the same planId share one plan panel', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'plan', {
        panelId: 'panel-plan-padded',
        instance: { planId: ' plan-1 ' },
      }),
    ).toBe('panel-plan-padded');

    expect(
      store().addTab(key, 'group-b', 'plan', {
        instance: { planId: 'plan-1' },
      }),
    ).toBeNull();
    // The panel saved with the padded id is found by the trimmed key.
    expect(findPanelByInstanceKey(key, 'plan:plan-1')).toEqual({
      layoutKey: key,
      groupId: 'group-a',
      panelId: 'panel-plan-padded',
    });
  });

  test('round-trips plan panels through serialize/restore', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-a', 'plan', {
      panelId: 'panel-plan-1',
      title: 'Ship the thing',
      instance: { planId: 'plan-1' },
    });
    const file = store().serializeLayout(key);
    expect(file).not.toBeNull();
    if (file === null) return;

    const restoredKey = nextKey();
    expect(
      store().restoreLayout(restoredKey, JSON.parse(JSON.stringify(file))),
    ).toBe(true);
    const planTab = store()
      .layouts[restoredKey].viewModel.groups.flatMap((group) => group.tabs)
      .find((tab) => tab.kind === 'plan');
    expect(planTab).toEqual({
      panelId: 'panel-plan-1',
      kind: 'plan',
      title: 'Ship the thing',
      instance: { planId: 'plan-1' },
    });
  });
});

describe('pruneInvalidBoundPanelEntries', () => {
  function planEntry(
    panelId: string,
    kind: 'plan' | 'plan-diagram',
    planId?: string,
  ): ISerializedPanelEntry {
    return planId === undefined
      ? { panelId, kind }
      : { panelId, kind, instance: { planId } };
  }

  function planLeaf(
    groupId: string,
    panels: readonly ISerializedPanelEntry[],
    activePanelId: string | null = panels[0]?.panelId ?? null,
  ): ISerializedPanelLeafNode {
    return { type: 'leaf', groupId, panels, activePanelId, size: 300 };
  }

  function popped(
    windowId: string,
    root: ISerializedPanelNode,
  ): SerializedPoppedPanelWindow {
    return {
      windowId,
      grid: { root, orientation: 0, width: 640, height: 480 },
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      sourceGroupId: 'group-chat',
    };
  }

  function layoutFile(
    leaves: readonly ISerializedPanelLeafNode[],
    poppedOut?: readonly SerializedPoppedPanelWindow[],
  ): SerializablePanelLayoutFile {
    const base: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        root: { type: 'branch', size: 600, children: [...leaves] },
        orientation: 1,
        width: 900,
        height: 600,
      },
      activeGroupId: leaves[0]?.groupId ?? 'group-chat',
      mostRecentActiveGroupIds: leaves.map((leaf) => leaf.groupId),
    };
    return poppedOut === undefined ? base : { ...base, poppedOut };
  }

  function mainLeaves(
    file: SerializablePanelLayoutFile,
  ): ISerializedPanelLeafNode[] {
    const root = file.grid.root;
    return root.type === 'branch'
      ? root.children.flatMap((child) => (child.type === 'leaf' ? [child] : []))
      : [root];
  }

  const CHAT_LEAF = planLeaf('group-chat', [
    { panelId: 'panel-chat', kind: 'chat', instance: { chatTabId: 'chat-1' } },
  ]);

  test('returns the same file when nothing needs pruning', () => {
    const file = layoutFile(
      [
        CHAT_LEAF,
        planLeaf('group-plan', [
          planEntry('panel-plan-1', 'plan', 'plan-1'),
          planEntry('panel-plan-diagram-1', 'plan-diagram', 'plan-1'),
          planEntry('panel-plan-2', 'plan', 'plan-2'),
        ]),
      ],
      [popped('aux-1', planLeaf('group-aux', [planEntry('p3', 'plan', 'p3')]))],
    );
    expect(pruneInvalidBoundPanelEntries(file)).toBe(file);
  });

  test('drops unbound, blank, and duplicate plan entries in the main grid', () => {
    const file = layoutFile([
      CHAT_LEAF,
      planLeaf(
        'group-plan',
        [
          planEntry('panel-plan-unbound', 'plan'),
          planEntry('panel-plan-blank', 'plan-diagram', '  '),
          planEntry('panel-plan-1', 'plan', 'plan-1'),
          planEntry('panel-plan-1-dup', 'plan', 'plan-1'),
        ],
        'panel-plan-1-dup',
      ),
      planLeaf('group-other', [
        planEntry('panel-plan-1-dup-2', 'plan', 'plan-1'),
      ]),
    ]);

    const pruned = pruneInvalidBoundPanelEntries(file);
    expect(pruned).not.toBe(file);
    const [chat, plan, other] = mainLeaves(pruned);
    // Untouched leaves keep their identity.
    expect(chat).toBe(CHAT_LEAF);
    expect(plan.panels.map((entry) => entry.panelId)).toEqual(['panel-plan-1']);
    // The pruned active tab falls back to the first surviving tab…
    expect(plan.activePanelId).toBe('panel-plan-1');
    // …and a leaf left empty survives with no active tab (geometry kept).
    expect(other.panels).toEqual([]);
    expect(other.activePanelId).toBeNull();
    expect(pruned.grid.width).toBe(900);
    expect(pruned.activeGroupId).toBe(file.activeGroupId);
    expect(pruned.mostRecentActiveGroupIds).toEqual(
      file.mostRecentActiveGroupIds,
    );
  });

  test('keeps an active tab that survived pruning', () => {
    const file = layoutFile([
      planLeaf(
        'group-plan',
        [
          planEntry('panel-plan-unbound', 'plan'),
          planEntry('panel-plan-1', 'plan', 'plan-1'),
          planEntry('panel-plan-2', 'plan', 'plan-2'),
        ],
        'panel-plan-2',
      ),
    ]);
    const [plan] = mainLeaves(pruneInvalidBoundPanelEntries(file));
    expect(plan.panels.map((entry) => entry.panelId)).toEqual([
      'panel-plan-1',
      'panel-plan-2',
    ]);
    expect(plan.activePanelId).toBe('panel-plan-2');
  });

  test('main-grid entries win over popped-out duplicates; emptied windows drop', () => {
    const keptWindow = popped(
      'aux-kept',
      planLeaf('group-aux-kept', [
        planEntry('panel-aux-dup', 'plan', 'plan-1'),
        planEntry('panel-aux-diagram', 'plan-diagram', 'plan-1'),
      ]),
    );
    const emptiedWindow = popped(
      'aux-emptied',
      planLeaf('group-aux-emptied', [
        planEntry('panel-aux-diagram-dup', 'plan-diagram', 'plan-1'),
        planEntry('panel-aux-unbound', 'plan'),
      ]),
    );
    const untouchedWindow = popped(
      'aux-untouched',
      planLeaf('group-aux-untouched', [
        { panelId: 'panel-aux-terminal', kind: 'terminal' },
      ]),
    );
    const file = layoutFile(
      [
        CHAT_LEAF,
        planLeaf('group-plan', [planEntry('panel-plan-1', 'plan', 'plan-1')]),
      ],
      [keptWindow, emptiedWindow, untouchedWindow],
    );

    const pruned = pruneInvalidBoundPanelEntries(file);
    // The main grid had nothing to prune.
    expect(pruned.grid).toBe(file.grid);
    expect(pruned.poppedOut?.map((entry) => entry.windowId)).toEqual([
      'aux-kept',
      'aux-untouched',
    ]);
    const kept = pruned.poppedOut?.[0];
    expect(kept?.bounds).toEqual(keptWindow.bounds);
    expect(kept?.grid.root).toEqual(
      planLeaf('group-aux-kept', [
        planEntry('panel-aux-diagram', 'plan-diagram', 'plan-1'),
      ]),
    );
    expect(pruned.poppedOut?.[1]).toBe(untouchedWindow);
  });

  test('omits poppedOut when every popped-out window was emptied', () => {
    const file = layoutFile(
      [planLeaf('group-plan', [planEntry('panel-plan-1', 'plan', 'plan-1')])],
      [
        popped(
          'aux-dup',
          planLeaf('group-aux', [planEntry('panel-dup', 'plan', 'plan-1')]),
        ),
      ],
    );
    const pruned = pruneInvalidBoundPanelEntries(file);
    expect(pruned.poppedOut).toBeUndefined();
    expect(pruned.grid).toBe(file.grid);
  });

  test('treats a padded planId as a duplicate of the same planId', () => {
    const file = layoutFile([
      planLeaf('group-plan', [
        planEntry('panel-plan-padded', 'plan', ' plan-1 '),
        planEntry('panel-plan-1', 'plan', 'plan-1'),
        planEntry('panel-diagram-1', 'plan-diagram', 'plan-1'),
        planEntry('panel-diagram-padded', 'plan-diagram', 'plan-1 '),
      ]),
    ]);

    const [plan] = mainLeaves(pruneInvalidBoundPanelEntries(file));
    expect(plan.panels.map((entry) => entry.panelId)).toEqual([
      'panel-plan-padded',
      'panel-diagram-1',
    ]);
  });

  test('never prunes non-plan kinds (restoreLayout still rejects those files)', () => {
    const duplicateChat = layoutFile([
      CHAT_LEAF,
      planLeaf('group-dup', [
        {
          panelId: 'panel-chat-dup',
          kind: 'chat',
          instance: { chatTabId: 'chat-1' },
        },
        { panelId: 'panel-file-unbound', kind: 'file-diff' },
      ]),
    ]);
    expect(pruneInvalidBoundPanelEntries(duplicateChat)).toBe(duplicateChat);
    expect(store().restoreLayout(nextKey(), duplicateChat)).toBe(false);
  });

  test('makes a file with bad plan entries restorable without losing other groups', () => {
    const file = layoutFile(
      [
        CHAT_LEAF,
        planLeaf('group-plan', [
          planEntry('panel-plan-unbound', 'plan'),
          planEntry('panel-plan-1', 'plan', 'plan-1'),
          planEntry('panel-plan-1-dup', 'plan', 'plan-1'),
        ]),
      ],
      [
        popped(
          'aux-dup',
          planLeaf('group-aux', [planEntry('panel-aux-dup', 'plan', 'plan-1')]),
        ),
      ],
    );
    // Unpruned, the whole file is rejected (all-or-nothing restore).
    expect(store().restoreLayout(nextKey(), file)).toBe(false);

    const key = nextKey();
    expect(
      store().restoreLayout(key, pruneInvalidBoundPanelEntries(file)),
    ).toBe(true);
    const viewModel = getPanelLayoutViewModel(key);
    expect(groupIds(viewModel)).toEqual(['group-chat', 'group-plan']);
    expect(
      viewModel?.groups.flatMap((group) =>
        group.tabs.map((tab) => tab.panelId),
      ),
    ).toEqual(['panel-chat', 'panel-plan-1']);
  });

  test('exposes the prunable kinds', () => {
    expect([...PRUNABLE_BOUND_PANEL_KINDS].sort()).toEqual([
      'plan',
      'plan-diagram',
    ]);
  });
});

describe('sanitizeRawPlanPanelBindings', () => {
  const VALID_CHAT_PANEL = {
    panelId: 'panel-chat',
    kind: 'chat',
    instance: { chatTabId: 'chat-1' },
  };
  const VALID_PLAN_PANEL = {
    panelId: 'panel-plan-good',
    kind: 'plan',
    instance: { planId: 'plan-good' },
  };

  function rawLeaf(
    groupId: string,
    panels: ReadonlyArray<Record<string, unknown>>,
    activePanelId: string | null,
  ): Record<string, unknown> {
    return { type: 'leaf', groupId, panels, activePanelId, size: 300 };
  }

  function rawLayout(
    root: Record<string, unknown>,
    poppedOut?: ReadonlyArray<Record<string, unknown>>,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      version: 1,
      grid: { root, orientation: 1, width: 900, height: 600 },
      activeGroupId: 'group-chat',
      mostRecentActiveGroupIds: ['group-chat'],
    };
    return poppedOut === undefined ? base : { ...base, poppedOut };
  }

  /** Narrows the leaf-typed root of a migrated file, or fails the test. */
  function requireLeafRoot(
    file: SerializablePanelLayoutFile,
  ): ISerializedPanelLeafNode {
    const root = file.grid.root;
    if (root.type !== 'leaf') {
      throw new Error('Expected a leaf root');
    }
    return root;
  }

  test('returns the exact same reference when there is nothing to sanitize', () => {
    const raw = rawLayout(
      rawLeaf('group-chat', [VALID_CHAT_PANEL, VALID_PLAN_PANEL], 'panel-chat'),
    );
    expect(sanitizeRawPlanPanelBindings(raw)).toBe(raw);
  });

  test('never throws and passes non-object input through unchanged', () => {
    for (const garbage of [null, undefined, 42, 'nope', [], true]) {
      expect(() => sanitizeRawPlanPanelBindings(garbage)).not.toThrow();
      expect(sanitizeRawPlanPanelBindings(garbage)).toBe(garbage);
    }
  });

  test('never throws on a deeply malformed grid tree', () => {
    const garbageInputs: unknown[] = [
      {
        version: 1,
        grid: {
          root: {
            type: 'leaf',
            groupId: 'g',
            panels: 'not-an-array',
            activePanelId: 1,
            size: 'x',
          },
        },
        poppedOut: 'not-an-array',
      },
      { version: 1, grid: null },
      { version: 1, grid: {} },
      {
        version: 1,
        grid: { root: { type: 'branch', children: 'not-an-array' } },
      },
      {
        version: 1,
        grid: { root: { type: 'leaf', panels: [null, 1, 'x', []] } },
      },
      { version: 1, grid: { root: {} }, poppedOut: [null, 1, 'x', {}] },
    ];
    for (const garbage of garbageInputs) {
      expect(() => sanitizeRawPlanPanelBindings(garbage)).not.toThrow();
    }
  });

  test('drops a plan entry with a non-string planId (instance: { planId: 42 })', () => {
    const badPanel = {
      panelId: 'panel-plan-bad',
      kind: 'plan',
      instance: { planId: 42 },
    };
    const raw = rawLayout(
      rawLeaf('group-plan', [badPanel, VALID_PLAN_PANEL], 'panel-plan-bad'),
    );
    expect(migratePanelLayout(raw)).toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    expect(sanitized).not.toBe(raw);
    const migrated = migratePanelLayout(sanitized);
    expect(migrated).not.toBeNull();
    if (migrated === null) return;
    const root = requireLeafRoot(migrated);
    expect(root.panels.map((panel) => panel.panelId)).toEqual([
      'panel-plan-good',
    ]);
    // The dropped panel was active; the survivor takes over.
    expect(root.activePanelId).toBe('panel-plan-good');
  });

  test('drops a plan-diagram entry with an over-length planId', () => {
    const badPanel = {
      panelId: 'panel-plan-diagram-bad',
      kind: 'plan-diagram',
      instance: { planId: 'p'.repeat(PANEL_INSTANCE_VALUE_MAX_LENGTH + 1) },
    };
    const raw = rawLayout(
      rawLeaf('group-plan', [VALID_PLAN_PANEL, badPanel], 'panel-plan-good'),
    );
    expect(migratePanelLayout(raw)).toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    const migrated = migratePanelLayout(sanitized);
    expect(migrated).not.toBeNull();
    if (migrated === null) return;
    const root = requireLeafRoot(migrated);
    expect(root.panels.map((panel) => panel.panelId)).toEqual([
      'panel-plan-good',
    ]);
    expect(root.activePanelId).toBe('panel-plan-good');
  });

  test('drops a plan entry whose instance is not a plain object', () => {
    const badPanel = {
      panelId: 'panel-plan-bad-shape',
      kind: 'plan',
      instance: 'plan-1',
    };
    const raw = rawLayout(
      rawLeaf(
        'group-plan',
        [badPanel, VALID_PLAN_PANEL],
        'panel-plan-bad-shape',
      ),
    );
    expect(migratePanelLayout(raw)).toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    const migrated = migratePanelLayout(sanitized);
    expect(migrated).not.toBeNull();
    if (migrated === null) return;
    const root = requireLeafRoot(migrated);
    expect(root.panels.map((panel) => panel.panelId)).toEqual([
      'panel-plan-good',
    ]);
  });

  test('drops a plan entry with no instance / blank planId even when shape-valid', () => {
    const raw = rawLayout(
      rawLeaf(
        'group-plan',
        [
          { panelId: 'panel-plan-unbound', kind: 'plan' },
          {
            panelId: 'panel-plan-blank',
            kind: 'plan',
            instance: { planId: '  ' },
          },
          VALID_PLAN_PANEL,
        ],
        'panel-plan-unbound',
      ),
    );
    // Shape-valid (an absent/blank instance never fails the protocol
    // validator), so this one is NOT the whole-file-rejection case — but the
    // raw sanitizer still prunes it pre-migration for consistency with
    // `pruneInvalidBoundPanelEntries`'s post-migration contract check.
    expect(migratePanelLayout(raw)).not.toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    const migrated = migratePanelLayout(sanitized);
    expect(migrated).not.toBeNull();
    if (migrated === null) return;
    const root = requireLeafRoot(migrated);
    expect(root.panels.map((panel) => panel.panelId)).toEqual([
      'panel-plan-good',
    ]);
  });

  test('never touches a malformed non-plan entry (still rejected by migratePanelLayout)', () => {
    const badChatPanel = {
      panelId: 'panel-chat-bad',
      kind: 'chat',
      instance: { chatTabId: 42 },
    };
    const raw = rawLayout(
      rawLeaf('group-chat', [badChatPanel, VALID_PLAN_PANEL], 'panel-chat-bad'),
    );
    expect(migratePanelLayout(raw)).toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    expect(sanitized).toBe(raw);
    expect(migratePanelLayout(sanitized)).toBeNull();
  });

  test('recurses into branch children and drops a popped-out window left with zero panels', () => {
    const raw = rawLayout(
      {
        type: 'branch',
        size: 900,
        children: [
          rawLeaf('group-chat', [VALID_CHAT_PANEL], 'panel-chat'),
          rawLeaf(
            'group-plan',
            [
              {
                panelId: 'panel-plan-bad',
                kind: 'plan',
                instance: { planId: 42 },
              },
            ],
            'panel-plan-bad',
          ),
        ],
      },
      [
        {
          windowId: 'aux-1',
          grid: {
            root: rawLeaf(
              'group-aux',
              [
                {
                  panelId: 'panel-aux-bad',
                  kind: 'plan-diagram',
                  instance: { planId: 42 },
                },
              ],
              'panel-aux-bad',
            ),
            orientation: 0,
            width: 400,
            height: 300,
          },
          bounds: { x: 0, y: 0, width: 400, height: 300 },
          sourceGroupId: 'group-chat',
        },
      ],
    );
    expect(migratePanelLayout(raw)).toBeNull();

    const sanitized = sanitizeRawPlanPanelBindings(raw);
    const migrated = migratePanelLayout(sanitized);
    expect(migrated).not.toBeNull();
    if (migrated === null) return;
    // The bad plan panel's leaf survives empty (matches
    // `pruneInvalidBoundPanelEntries`'s "leaf keeps its geometry" contract).
    const root = migrated.grid.root;
    expect(root.type).toBe('branch');
    if (root.type !== 'branch') return;
    const planLeaf = root.children.find(
      (child) => child.type === 'leaf' && child.groupId === 'group-plan',
    );
    expect(planLeaf?.type === 'leaf' ? planLeaf.panels : null).toEqual([]);
    // The whole popped-out window was emptied and is dropped.
    expect(migrated.poppedOut).toBeUndefined();
  });
});

describe('chat group restriction', () => {
  afterEach(() => {
    setPanelLayoutChatGroup(null);
  });

  function tabsOf(key: string, groupId: string): string[] {
    return (
      store()
        .layouts[key]?.viewModel.groups.find(
          (group) => group.groupId === groupId,
        )
        ?.tabs.map((tab) => tab.panelId) ?? []
    );
  }

  test('a chat added to another group lands in the chat group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    setPanelLayoutChatGroup('group-a');

    const panelId = store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-2',
      instance: { chatTabId: 'chat-2' },
    });

    expect(panelId).toBe('panel-chat-2');
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a', 'panel-chat-2']);
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b']);
    // Other kinds still go where they are asked to.
    store().addTab(key, 'group-b', 'file-diff', {
      panelId: 'panel-diff',
      instance: { fileTabId: 'file-x' },
    });
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b', 'panel-diff']);
  });

  test('a chat cannot move or split out of the chat group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    setPanelLayoutChatGroup('group-a');

    expect(store().movePanel(key, 'panel-a', 'group-b', 'center')).toBe(false);
    expect(store().movePanel(key, 'panel-a', 'group-a', 'right')).toBe(false);
    expect(store().movePanelToRootEdge(key, 'panel-a', 'left')).toBe(false);
    expect(groupIds(store().layouts[key].viewModel)).toEqual([
      'group-a',
      'group-b',
      'group-c',
    ]);
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a']);
    // Non-chat tabs still move freely, including into the chat group.
    expect(store().movePanel(key, 'panel-b', 'group-a', 'center')).toBe(true);
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a', 'panel-b']);
  });

  test('moves chats a layout already keeps elsewhere into the chat group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    store().addTab(key, 'group-c', 'chat', {
      panelId: 'panel-chat-c',
      instance: { chatTabId: 'chat-c' },
    });
    // Without the restriction nothing moves.
    expect(store().relocateChatTabsToChatGroup(key)).toBe(false);

    setPanelLayoutChatGroup('group-a');
    expect(store().relocateChatTabsToChatGroup(key)).toBe(true);

    expect(tabsOf(key, 'group-a')).toEqual([
      'panel-a',
      'panel-chat-b',
      'panel-chat-c',
    ]);
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b']);
    expect(tabsOf(key, 'group-c')).toEqual(['panel-c']);
    expect(store().relocateChatTabsToChatGroup(key)).toBe(false);
  });

  test('a group left empty closes, unless the topology is fixed', () => {
    const open = nextKey();
    store().initializeLayout(open, TWO_GROUPS);
    store().closeTab(open, 'group-b', 'panel-b');
    store().addTab(open, 'group-a', 'terminal', { panelId: 'panel-t' });
    store().movePanel(open, 'panel-t', 'group-a', 'right');
    const strayGroup = groupIdContainingPanel(
      store().layouts[open].viewModel,
      'panel-t',
    );
    expect(strayGroup).toBeDefined();
    store().addTab(open, strayGroup ?? '', 'chat', {
      panelId: 'panel-chat-x',
      instance: { chatTabId: 'chat-x' },
    });
    store().closeTab(open, strayGroup ?? '', 'panel-t');
    setPanelLayoutChatGroup('group-a');

    store().relocateChatTabsToChatGroup(open);
    expect(groupIds(store().layouts[open].viewModel)).toEqual(['group-a']);
    expect(tabsOf(open, 'group-a')).toEqual(['panel-a', 'panel-chat-x']);

    setPanelLayoutChatGroup(null);
    const fixed = nextKey();
    store().initializeLayout(fixed, TWO_GROUPS);
    store().addTab(fixed, 'group-b', 'chat', {
      panelId: 'panel-chat-y',
      instance: { chatTabId: 'chat-y' },
    });
    store().closeTab(fixed, 'group-b', 'panel-b');
    setPanelLayoutFixedTopology(fixed, true);
    setPanelLayoutChatGroup('group-a');
    try {
      store().relocateChatTabsToChatGroup(fixed);
      expect(groupIds(store().layouts[fixed].viewModel)).toEqual([
        'group-a',
        'group-b',
      ]);
      expect(tabsOf(fixed, 'group-b')).toEqual([]);
      expect(tabsOf(fixed, 'group-a')).toEqual(['panel-a', 'panel-chat-y']);
    } finally {
      setPanelLayoutFixedTopology(fixed, false);
    }
  });

  test('relocating keeps the focused chat selected', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    store().focusGroup(key, 'group-b');
    setPanelLayoutChatGroup('group-a');

    expect(store().relocateChatTabsToChatGroup(key)).toBe(true);

    const viewModel = store().layouts[key].viewModel;
    expect(viewModel.activeGroupId).toBe('group-a');
    expect(
      viewModel.groups.find((group) => group.groupId === 'group-a')
        ?.activePanelId,
    ).toBe('panel-chat-b');
  });

  test('relocating the focused chat into a collapsed chat group expands it', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    store().focusGroup(key, 'group-b');
    setPanelLayoutChatGroup('group-a');

    expect(store().relocateChatTabsToChatGroup(key)).toBe(true);

    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.groups['group-a'].activePanelId).toBe('panel-chat-b');
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b']);
  });

  test('relocating the focused chat exits another maximized group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    store().maximizeGroup(key, 'group-b', true);
    setPanelLayoutChatGroup('group-a');

    expect(store().relocateChatTabsToChatGroup(key)).toBe(true);

    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
    expect(layout.activeGroupId).toBe('group-a');
  });

  test('a main layout that lost its chat group gets it back', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    // Moving the only chat out closes the chat group.
    expect(store().movePanel(key, 'panel-a', 'group-b', 'center')).toBe(true);
    expect(groupIds(store().layouts[key].viewModel)).toEqual([
      'group-b',
      'group-c',
    ]);
    setPanelLayoutChatGroup('group-a');

    expect(store().relocateChatTabsToChatGroup(key)).toBe(true);

    expect(groupIds(store().layouts[key].viewModel)).toContain('group-a');
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a']);
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b']);
    // The restriction applies again.
    expect(store().movePanel(key, 'panel-a', 'group-a', 'right')).toBe(false);
    expect(store().movePanel(key, 'panel-a', 'group-b', 'center')).toBe(false);
  });

  test('an auxiliary layout never gets a chat group', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-no-chat-group');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    store().addTab(auxKey, 'group-b', 'chat', {
      panelId: 'panel-chat-aux',
      instance: { chatTabId: 'chat-aux' },
    });
    setPanelLayoutChatGroup('group-a');

    expect(store().relocateChatTabsToChatGroup(auxKey)).toBe(false);
    expect(groupIds(store().layouts[auxKey].viewModel)).toEqual(['group-b']);
  });

  test('without the restriction chats go wherever they are asked', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b', 'panel-chat-b']);
    expect(store().movePanel(key, 'panel-a', 'group-c', 'center')).toBe(true);
    expect(tabsOf(key, 'group-c')).toEqual(['panel-c', 'panel-a']);
  });

  test('merged-back chats return to the chat group', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-chat');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    // The auxiliary layout has no chat group, so its chat stays put there.
    setPanelLayoutChatGroup('group-a');
    store().addTab(auxKey, 'group-b', 'chat', {
      panelId: 'panel-chat-aux',
      instance: { chatTabId: 'chat-aux' },
    });
    expect(tabsOf(auxKey, 'group-b')).toEqual(['panel-b', 'panel-chat-aux']);
    store().focusGroup(key, 'group-c');

    expect(store().adoptLayoutTabs(auxKey, key)).toBe(true);

    expect(tabsOf(key, 'group-a')).toEqual(['panel-a', 'panel-chat-aux']);
    expect(tabsOf(key, 'group-c')).toEqual(['panel-c', 'panel-b']);
    expect(getPanelLayoutViewModel(key)?.activeGroupId).toBe('group-a');
  });

  test('a merged-back focused chat exits another maximized group', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-chat-maximized');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    setPanelLayoutChatGroup('group-a');
    store().addTab(auxKey, 'group-b', 'chat', {
      panelId: 'panel-chat-aux',
      instance: { chatTabId: 'chat-aux' },
    });
    store().maximizeGroup(key, 'group-c', true);

    expect(store().adoptLayoutTabs(auxKey, key)).toBe(true);

    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.groups['group-a'].activePanelId).toBe('panel-chat-aux');
  });

  test('merging back a chat-only window leaves no empty recreated group', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-chat-only');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    setPanelLayoutChatGroup('group-a');
    store().addTab(auxKey, 'group-b', 'chat', {
      panelId: 'panel-chat-aux',
      instance: { chatTabId: 'chat-aux' },
    });
    store().closeTab(auxKey, 'group-b', 'panel-b');
    expect(tabsOf(auxKey, 'group-b')).toEqual(['panel-chat-aux']);

    expect(
      store().adoptLayoutTabs(auxKey, key, {
        preferredGroupId: 'group-b',
        fallbackAnchorGroupId: 'group-c',
        fallbackDirection: 'right',
      }),
    ).toBe(true);

    expect(groupIds(store().layouts[key].viewModel)).toEqual([
      'group-a',
      'group-c',
    ]);
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a', 'panel-chat-aux']);
    expect(getPanelLayoutViewModel(key)?.activeGroupId).toBe('group-a');
  });

  test('a new chat redirected to the chat group exits another maximized group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-b', true);
    setPanelLayoutChatGroup('group-a');

    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-new',
      instance: { chatTabId: 'chat-new' },
    });

    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(getPanelGridController(key)?.grid.hasMaximizedView()).toBe(false);
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.groups['group-a'].activePanelId).toBe('panel-chat-new');
  });

  test('a new chat redirected into a collapsed chat group expands it', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    expect(store().collapseGroup(key, 'group-a')).toBe(true);
    setPanelLayoutChatGroup('group-a');

    store().addTab(key, 'group-c', 'chat', {
      panelId: 'panel-chat-new',
      instance: { chatTabId: 'chat-new' },
    });

    const layout = store().layouts[key];
    expect(layout.groups['group-a'].collapsed).toBeUndefined();
    expect(layout.activeGroupId).toBe('group-a');
  });

  test('a chat added without activating leaves the maximized group alone', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-b', true);
    setPanelLayoutChatGroup('group-a');

    store().addTab(key, 'group-b', 'chat', {
      panelId: 'panel-chat-quiet',
      instance: { chatTabId: 'chat-quiet' },
      activate: false,
    });

    const layout = store().layouts[key];
    expect(tabsOf(key, 'group-a')).toEqual(['panel-a', 'panel-chat-quiet']);
    expect(layout.maximizedGroupId).toBe('group-b');
    expect(layout.groups['group-a'].activePanelId).toBe('panel-a');
  });

  test('a merged-back chat whose receiving group is the chat group shows', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-into-chat-group');
    store().initializeLayout(key, THREE_GROUPS);
    store().extractGroupToLayout(key, 'group-b', auxKey);
    setPanelLayoutChatGroup('group-a');
    store().addTab(auxKey, 'group-b', 'chat', {
      panelId: 'panel-chat-aux',
      instance: { chatTabId: 'chat-aux' },
    });
    store().maximizeGroup(key, 'group-c', true);

    expect(
      store().adoptLayoutTabs(auxKey, key, { preferredGroupId: 'group-a' }),
    ).toBe(true);

    const layout = store().layouts[key];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-a');
    expect(layout.groups['group-a'].activePanelId).toBe('panel-chat-aux');
  });

  test('drop and menu predicates refuse exactly what the moves refuse', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().addTab(key, 'group-a', 'chat', {
      panelId: 'panel-chat-2',
      instance: { chatTabId: 'chat-2' },
    });
    setPanelLayoutChatGroup('group-a');

    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      expect(store().canMovePanelToRootEdge(key, 'panel-a', edge)).toBe(false);
      expect(store().canMovePanel(key, 'panel-a', 'group-a', edge)).toBe(false);
      expect(store().canMovePanel(key, 'panel-a', 'group-b', edge)).toBe(false);
    }
    expect(store().canMovePanel(key, 'panel-a', 'group-b', 'center')).toBe(
      false,
    );
    expect(store().canMovePanel(key, 'panel-a', 'group-a', 'center')).toBe(
      true,
    );
    // Other kinds keep every affordance.
    expect(store().canMovePanelToRootEdge(key, 'panel-b', 'left')).toBe(true);
    expect(store().canMovePanel(key, 'panel-b', 'group-a', 'center')).toBe(
      true,
    );
    expect(store().canMovePanel(key, 'panel-b', 'group-c', 'right')).toBe(true);

    setPanelLayoutChatGroup(null);
    expect(store().canMovePanelToRootEdge(key, 'panel-a', 'left')).toBe(true);
    expect(store().canMovePanel(key, 'panel-a', 'group-b', 'center')).toBe(
      true,
    );
  });

  test('a chat never seeds a split or replaces a tab outside the chat group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    setPanelLayoutChatGroup('group-a');

    expect(
      store().splitGroup(key, 'group-b', 'right', {
        kind: 'chat',
        panelId: 'panel-chat-split',
        instance: { chatTabId: 'chat-split' },
      }),
    ).toBeNull();
    expect(
      store().replaceTab(key, 'group-b', 'panel-b', {
        panelId: 'panel-chat-replace',
        kind: 'chat',
        instance: { chatTabId: 'chat-replace' },
      }),
    ).toBe(false);
    expect(groupIds(store().layouts[key].viewModel)).toEqual([
      'group-a',
      'group-b',
      'group-c',
    ]);
    expect(tabsOf(key, 'group-b')).toEqual(['panel-b']);
    // In the chat group a chat still replaces a chat.
    expect(
      store().replaceTab(key, 'group-a', 'panel-a', {
        panelId: 'panel-chat-replace',
        kind: 'chat',
        instance: { chatTabId: 'chat-replace' },
      }),
    ).toBe(true);
  });
});

describe('excluded panel kinds', () => {
  afterEach(() => {
    setPanelLayoutExcludedKinds([]);
  });

  test('refuses new tabs of an excluded kind and closes existing ones', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-b', 'activity-section', {
      panelId: 'panel-activity',
    });
    expect(
      store().layouts[key].groups['group-b'].tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-b', 'panel-activity']);
    // Nothing is excluded yet.
    expect(store().removeExcludedKindTabs(key)).toBe(false);

    setPanelLayoutExcludedKinds(['activity-section']);
    expect(store().removeExcludedKindTabs(key)).toBe(true);
    expect(
      store().layouts[key].groups['group-b'].tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-b']);
    expect(store().layouts[key].groups['group-b'].activePanelId).toBe(
      'panel-b',
    );

    expect(
      store().addTab(key, 'group-b', 'activity-section', {
        panelId: 'panel-activity-2',
      }),
    ).toBeNull();
    expect(store().removeExcludedKindTabs(key)).toBe(false);
  });

  test('keeps a fixed group the removal empties, even its protected tab', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().addTab(key, 'group-b', 'activity-section', {
      panelId: 'panel-activity',
    });
    store().closeTab(key, 'group-b', 'panel-b');
    setPanelLayoutFixedTopology(key, true);
    setPanelLayoutExcludedKinds(['activity-section']);
    try {
      // A fixed topology refuses to close Activity by hand.
      store().closeTab(key, 'group-b', 'panel-activity');
      expect(store().layouts[key].groups['group-b'].tabs).toHaveLength(1);

      expect(store().removeExcludedKindTabs(key)).toBe(true);
      expect(groupIds(store().layouts[key].viewModel)).toEqual([
        'group-a',
        'group-b',
      ]);
      expect(store().layouts[key].groups['group-b'].tabs).toEqual([]);
    } finally {
      setPanelLayoutFixedTopology(key, false);
    }
  });
});

describe('cost panel instance contract', () => {
  function breakdownEntry(
    panelId: string,
    chatId?: string,
  ): ISerializedPanelEntry {
    return {
      panelId,
      kind: 'session-breakdown',
      ...(chatId !== undefined ? { instance: { chatId } } : {}),
    };
  }

  function singlePanelFile(
    groupId: string,
    panels: readonly ISerializedPanelEntry[],
  ): SerializablePanelLayoutFile {
    const activePanelId = panels[0]?.panelId ?? null;
    return {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 600,
          children: [
            { type: 'leaf', groupId, panels, activePanelId, size: 600 },
          ],
        },
        orientation: 1,
        width: 900,
        height: 600,
      },
      activeGroupId: groupId,
      mostRecentActiveGroupIds: [groupId],
    };
  }

  function tabsOf(key: string, groupId: string): readonly string[] {
    return (store().layouts[key]?.groups[groupId]?.tabs ?? []).map(
      (tab) => tab.panelId,
    );
  }

  test('keys session breakdowns by chat id', () => {
    expect(
      getPanelInstanceKey({
        kind: 'session-breakdown',
        instance: { chatId: 'chat-1' },
      }),
    ).toBe('session-breakdown:chat-1');
    expect(
      getPanelInstanceKey({
        kind: 'session-breakdown',
        instance: { chatId: 'chat-2' },
      }),
    ).not.toBe(
      getPanelInstanceKey({
        kind: 'session-breakdown',
        instance: { chatId: 'chat-1' },
      }),
    );
    expect(isSingletonPanelKind('session-breakdown')).toBe(false);
    expect(isSingletonPanelKind('cost')).toBe(true);
  });

  test('refuses a duplicate chat binding across main and auxiliary layouts', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-breakdown');
    store().initializeLayout(key, TWO_GROUPS);
    expect(
      store().addTab(key, 'group-a', 'session-breakdown', {
        panelId: 'panel-breakdown-chat-1',
        instance: { chatId: 'chat-1' },
      }),
    ).toBe('panel-breakdown-chat-1');
    expect(
      store().addTab(key, 'group-b', 'session-breakdown', {
        instance: { chatId: 'chat-1' },
      }),
    ).toBeNull();
    expect(store().extractGroupToLayout(key, 'group-a', auxKey)).toBe(true);
    expect(
      store().addTab(auxKey, 'group-a', 'session-breakdown', {
        instance: { chatId: 'chat-1' },
      }),
    ).toBeNull();
    expect(
      store().addTab(auxKey, 'group-a', 'session-breakdown', {
        instance: { chatId: 'chat-2' },
      }),
    ).not.toBeNull();
  });

  test('restore keeps valid breakdowns and drops unbound and duplicate tabs', () => {
    const key = nextKey();
    expect(
      store().restoreLayout(
        key,
        singlePanelFile('group-breakdown', [
          breakdownEntry('panel-unbound'),
          breakdownEntry('panel-breakdown-1', 'chat-1'),
          breakdownEntry('panel-breakdown-duplicate', 'chat-1'),
          { panelId: 'panel-chat', kind: 'chat', instance: CHAT_A_INSTANCE },
        ]),
      ),
    ).toBe(true);
    expect(tabsOf(key, 'group-breakdown')).toEqual([
      'panel-breakdown-1',
      'panel-chat',
    ]);
  });

  test('Cost is a singleton across groups and auxiliary layouts', () => {
    const key = nextKey();
    const auxKey = makeAuxPanelLayoutKey(key, 'aux-cost');
    store().initializeLayout(key, TWO_GROUPS);
    expect(store().addTab(key, 'group-a', 'cost')).not.toBeNull();
    expect(store().addTab(key, 'group-b', 'cost')).toBeNull();
    expect(store().extractGroupToLayout(key, 'group-b', auxKey)).toBe(true);
    expect(store().addTab(auxKey, 'group-b', 'cost')).toBeNull();
  });
});
