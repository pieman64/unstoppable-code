/** @jest-environment jsdom */

// Panel command layer (doc 12 §1) — availability predicates and dispatch
// through the panel layout store, exercised against the REAL store so the
// commands' contracts (active-group targeting, no-op safety) are verified
// end to end. The palette and global shortcuts both consume exactly this
// surface via `runPanelCommand`.

import {
  makeWorktreePanelKey,
  setPanelLayoutChatGroup,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '../panel-layout-store';
import {
  findEditableSafePanelShortcut,
  isPanelCommandAvailable,
  matchesPanelShortcutBinding,
  PANEL_COMMANDS,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
  selectAdjacentPanelTab,
  type PanelCommandId,
  type PanelShortcutBinding,
} from '../panel-commands';
import { registerPanelTabSelectionHandler } from '../panel-tab-selection';
import type { ShortcutEventLike } from '../../../find/shortcut-target';

let mockIsMac = false;

jest.mock('@canopy/ui-shared/lib/shortcut-platform', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@canopy/ui-shared/lib/shortcut-platform',
  );
  return { ...actual, isMacPlatform: (): boolean => mockIsMac };
});

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `commands-${keyCounter}`);
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

const THREE_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
    { kind: 'browser', groupId: 'group-c', panelId: 'panel-c' },
  ],
  containerSize: { width: 900, height: 600 },
};

const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
  containerSize: { width: 800, height: 600 },
};

const ALL_COMMAND_IDS: PanelCommandId[] = PANEL_COMMANDS.map(
  (command) => command.id,
);

const TAB_CYCLE_IDS: PanelCommandId[] = [
  'panel-select-next-tab',
  'panel-select-previous-tab',
];

const MULTI_GROUP_ONLY_IDS: PanelCommandId[] = ALL_COMMAND_IDS.filter(
  (id) =>
    id !== 'panel-split-right' &&
    id !== 'panel-split-down' &&
    !TAB_CYCLE_IDS.includes(id),
);

/** One chat group holding chats a, b, c in that order, with a active. */
function initThreeTabGroup(key: string): void {
  store().initializeLayout(key, THREE_GROUPS);
  store().addTab(key, 'group-a', 'chat', {
    panelId: 'panel-a2',
    instance: { chatTabId: 'chat-a2' },
    activate: false,
  });
  store().addTab(key, 'group-a', 'chat', {
    panelId: 'panel-a3',
    instance: { chatTabId: 'chat-a3' },
    activate: false,
  });
}

function activePanelOf(key: string, groupId: string): string | null {
  return (
    store().layouts[key]?.viewModel.groups.find(
      (group) => group.groupId === groupId,
    )?.activePanelId ?? null
  );
}

function activeGroupId(key: string): string | null {
  return store().layouts[key]?.viewModel.activeGroupId ?? null;
}

function groupIds(key: string): string[] {
  return (store().layouts[key]?.viewModel.groups ?? []).map(
    (group) => group.groupId,
  );
}

afterEach(() => {
  const state = store();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

describe('availability', () => {
  test('every command is unavailable without a worktree key or layout', () => {
    for (const id of ALL_COMMAND_IDS) {
      expect(isPanelCommandAvailable(id, null)).toBe(false);
      expect(isPanelCommandAvailable(id, 'project/none')).toBe(false);
    }
  });

  test('single-group layouts allow splits only', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    expect(isPanelCommandAvailable('panel-split-right', key)).toBe(true);
    expect(isPanelCommandAvailable('panel-split-down', key)).toBe(true);
    for (const id of MULTI_GROUP_ONLY_IDS) {
      expect(isPanelCommandAvailable(id, key)).toBe(false);
    }
  });

  test('multi-group layouts allow every group command', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    for (const id of ALL_COMMAND_IDS) {
      expect(isPanelCommandAvailable(id, key)).toBe(
        !TAB_CYCLE_IDS.includes(id),
      );
    }
  });

  test('tab cycling needs an active group with at least two tabs', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    for (const id of TAB_CYCLE_IDS) {
      expect(isPanelCommandAvailable(id, key)).toBe(false);
    }

    // A command split leaves the new, EMPTY group active.
    expect(runPanelCommand('panel-split-right', key)).toBe(true);
    for (const id of TAB_CYCLE_IDS) {
      expect(isPanelCommandAvailable(id, key)).toBe(false);
    }

    const multiTabKey = nextKey();
    initThreeTabGroup(multiTabKey);
    for (const id of TAB_CYCLE_IDS) {
      expect(isPanelCommandAvailable(id, multiTabKey)).toBe(true);
    }
  });
});

describe('runPanelCommand dispatch', () => {
  test('returns false and mutates nothing for an unknown layout', () => {
    expect(runPanelCommand('panel-split-right', 'project/none')).toBe(false);
  });

  test('returns false for unavailable commands instead of no-op success', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    expect(runPanelCommand('panel-close-group', key)).toBe(false);
    expect(groupIds(key)).toEqual(['group-a']);
  });

  test('panel-split-right splits the ACTIVE group and focuses the clone', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().focusGroup(key, 'group-b');

    expect(runPanelCommand('panel-split-right', key)).toBe(true);

    const ids = groupIds(key);
    expect(ids).toHaveLength(4);
    const newGroupId = ids.find(
      (id) => !['group-a', 'group-b', 'group-c'].includes(id),
    );
    expect(newGroupId).toBeDefined();
    expect(activeGroupId(key)).toBe(newGroupId);
    // Per-entity split decision: an unseeded split creates an EMPTY group
    // (cloning the active tab would duplicate an entity binding).
    const newGroup = store().layouts[key].viewModel.groups.find(
      (group) => group.groupId === newGroupId,
    );
    expect(newGroup?.tabs).toEqual([]);
    expect(newGroup?.activePanelId).toBeNull();
  });

  test('panel-focus-next/previous-group cycle the stable group order with wrap', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(runPanelCommand('panel-focus-next-group', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-b');
    expect(runPanelCommand('panel-focus-next-group', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-c');
    expect(runPanelCommand('panel-focus-next-group', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-a');

    expect(runPanelCommand('panel-focus-previous-group', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-c');
  });

  test('panel-focus-group-left/right follow grid geometry and no-op at edges', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(runPanelCommand('panel-focus-group-right', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-b');
    expect(runPanelCommand('panel-focus-group-right', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-c');

    // No group to the right of the rightmost — safe no-op, focus unchanged.
    expect(runPanelCommand('panel-focus-group-right', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-c');

    expect(runPanelCommand('panel-focus-group-left', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-b');

    // Row layout: no group above or below — safe no-ops.
    expect(runPanelCommand('panel-focus-group-up', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-b');
    expect(runPanelCommand('panel-focus-group-down', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-b');
  });

  test('directional focus is inert while a group is maximized', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    expect(runPanelCommand('panel-focus-group-right', key)).toBe(true);
    expect(activeGroupId(key)).toBe('group-a');
  });

  test('panel-move-to-next-group docks the active tab on the next group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(runPanelCommand('panel-move-to-next-group', key)).toBe(true);

    // panel-a moved into group-b; the emptied group-a was closed.
    expect(groupIds(key)).toEqual(['group-b', 'group-c']);
    const groupB = store().layouts[key].viewModel.groups.find(
      (group) => group.groupId === 'group-b',
    );
    expect(groupB?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-b',
      'panel-a',
    ]);
    expect(groupB?.activePanelId).toBe('panel-a');
    expect(activeGroupId(key)).toBe('group-b');
  });

  test('panel-move-to-next-group is not offered for a chat kept in the chat group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    setPanelLayoutChatGroup('group-a');
    try {
      expect(isPanelCommandAvailable('panel-move-to-next-group', key)).toBe(
        false,
      );
      expect(runPanelCommand('panel-move-to-next-group', key)).toBe(false);
      store().focusGroup(key, 'group-b');
      expect(isPanelCommandAvailable('panel-move-to-next-group', key)).toBe(
        true,
      );
    } finally {
      setPanelLayoutChatGroup(null);
    }
  });

  test('panel-toggle-maximize maximizes then restores the active group', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    expect(runPanelCommand('panel-toggle-maximize', key)).toBe(true);
    expect(store().layouts[key].maximizedGroupId).toBe('group-a');

    expect(runPanelCommand('panel-toggle-maximize', key)).toBe(true);
    expect(store().layouts[key].maximizedGroupId).toBeNull();
  });

  test('panel-close-group closes the active group and MRU-focuses a survivor', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().focusGroup(key, 'group-b');

    expect(runPanelCommand('panel-close-group', key)).toBe(true);
    expect(groupIds(key)).toEqual(['group-a', 'group-c']);
    // MRU: group-a was active before group-b.
    expect(activeGroupId(key)).toBe('group-a');
  });

  test('panel-even-sizes exits a maximized layout', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);
    store().maximizeGroup(key, 'group-a', true);

    expect(runPanelCommand('panel-even-sizes', key)).toBe(true);
    expect(store().layouts[key].maximizedGroupId).toBeNull();
  });
});

describe('tab cycling', () => {
  test('next and previous cycle the active group in strip order with wrap', () => {
    const key = nextKey();
    initThreeTabGroup(key);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a');

    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a2');
    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a3');
    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a');

    expect(runPanelCommand('panel-select-previous-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a3');
    expect(runPanelCommand('panel-select-previous-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a2');

    // Only the active group's selection moves.
    expect(activeGroupId(key)).toBe('group-a');
    expect(activePanelOf(key, 'group-b')).toBe('panel-b');
    expect(activePanelOf(key, 'group-c')).toBe('panel-c');
  });

  test('the cycle follows the rendered strip, where pinned tabs lead', () => {
    const key = nextKey();
    initThreeTabGroup(key);
    store().setTabPinned(key, 'group-a', 'panel-a3', true);

    // Strip order is now a3 (pinned), a, a2.
    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a2');
    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a3');
    expect(runPanelCommand('panel-select-previous-tab', key)).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a2');
  });

  test('a tab selection handler registered by the surface replaces the bare store select', () => {
    const key = nextKey();
    initThreeTabGroup(key);
    const selections: string[] = [];
    const unregister = registerPanelTabSelectionHandler(
      key,
      (groupId: string, panelId: string): void => {
        selections.push(`${groupId}/${panelId}`);
        store().selectTab(key, groupId, panelId);
      },
    );
    try {
      expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
      expect(selections).toEqual(['group-a/panel-a2']);
    } finally {
      unregister();
    }

    // Unregistered: the command falls back to the store.
    expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
    expect(selections).toEqual(['group-a/panel-a2']);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a3');
  });

  test('selectAdjacentPanelTab cycles from a given tab of a given group, wrapping', () => {
    const key = nextKey();
    initThreeTabGroup(key);
    // Another group is active, as when focus sits in a native browser page
    // whose click never reached the layout.
    store().focusGroup(key, 'group-b');

    expect(
      selectAdjacentPanelTab(
        key,
        { groupId: 'group-a', panelId: 'panel-a3' },
        'next',
      ),
    ).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a');
    expect(activeGroupId(key)).toBe('group-a');

    expect(
      selectAdjacentPanelTab(
        key,
        { groupId: 'group-a', panelId: 'panel-a' },
        'previous',
      ),
    ).toBe(true);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a3');
  });

  test('selectAdjacentPanelTab is a no-op for a missing tab or a single-tab group', () => {
    const key = nextKey();
    initThreeTabGroup(key);

    expect(
      selectAdjacentPanelTab(
        key,
        { groupId: 'group-a', panelId: 'missing' },
        'next',
      ),
    ).toBe(false);
    expect(
      selectAdjacentPanelTab(
        key,
        { groupId: 'group-b', panelId: 'panel-b' },
        'next',
      ),
    ).toBe(false);
    expect(
      selectAdjacentPanelTab(
        'project/no-layout',
        { groupId: 'group-a', panelId: 'panel-a' },
        'next',
      ),
    ).toBe(false);
    expect(activePanelOf(key, 'group-a')).toBe('panel-a');
  });

  test('a stale unregister does not remove a newer handler for the same layout', () => {
    const key = nextKey();
    initThreeTabGroup(key);
    const calls: string[] = [];
    const unregisterFirst = registerPanelTabSelectionHandler(key, (): void => {
      calls.push('first');
    });
    const unregisterSecond = registerPanelTabSelectionHandler(key, (): void => {
      calls.push('second');
    });
    unregisterFirst();
    try {
      expect(runPanelCommand('panel-select-next-tab', key)).toBe(true);
      expect(calls).toEqual(['second']);
    } finally {
      unregisterSecond();
    }
  });
});

describe('shortcut bindings', () => {
  function platformsOf(binding: PanelShortcutBinding): ('mac' | 'other')[] {
    return binding.platform === undefined
      ? ['mac', 'other']
      : [binding.platform];
  }

  test('every command has a binding on each platform and every binding names a command', () => {
    for (const id of ALL_COMMAND_IDS) {
      const bindings = PANEL_SHORTCUT_BINDINGS.filter(
        (binding) => binding.id === id,
      );
      const platforms = new Set(bindings.flatMap(platformsOf));
      expect({ id, platforms: [...platforms].sort() }).toEqual({
        id,
        platforms: ['mac', 'other'],
      });
    }
    for (const binding of PANEL_SHORTCUT_BINDINGS) {
      expect(ALL_COMMAND_IDS).toContain(binding.id);
    }
  });

  test('no two bindings on one platform share a chord but name different commands', () => {
    const owners = new Map<string, PanelCommandId>();
    for (const binding of PANEL_SHORTCUT_BINDINGS) {
      for (const platform of platformsOf(binding)) {
        const chord = [
          platform,
          binding.code ?? binding.key.toLowerCase(),
          binding.shift === true ? 'shift' : '',
          binding.alt === true ? 'alt' : '',
        ].join('|');
        const owner = owners.get(chord);
        expect({ chord, id: owner ?? binding.id }).toEqual({
          chord,
          id: binding.id,
        });
        owners.set(chord, binding.id);
      }
    }
  });

  test('Ctrl+Shift+] and Ctrl+Shift+[ stay unbound outside macOS', () => {
    for (const binding of PANEL_SHORTCUT_BINDINGS) {
      if (
        binding.shift === true &&
        (binding.code === 'BracketRight' || binding.code === 'BracketLeft')
      ) {
        expect(binding.platform).toBe('mac');
      }
    }
  });

  test('alt is only combined with arrow keys (macOS Option composes characters)', () => {
    for (const binding of PANEL_SHORTCUT_BINDINGS) {
      if (binding.alt === true) {
        expect(binding.key.startsWith('Arrow')).toBe(true);
      }
    }
  });
});

describe('matchesPanelShortcutBinding', () => {
  function event(overrides: Partial<ShortcutEventLike>): ShortcutEventLike {
    return {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      key: '',
      metaKey: false,
      shiftKey: false,
      ...overrides,
    };
  }

  function matchedIds(shortcut: ShortcutEventLike): PanelCommandId[] {
    return PANEL_SHORTCUT_BINDINGS.filter((binding) =>
      matchesPanelShortcutBinding(shortcut, binding),
    ).map((binding) => binding.id);
  }

  afterEach(() => {
    mockIsMac = false;
  });

  test('macOS matches ⌘⇧] and ⌘⇧[ by physical key, whatever the shifted character', () => {
    mockIsMac = true;
    expect(
      matchedIds(
        event({
          code: 'BracketRight',
          key: '}',
          shiftKey: true,
          metaKey: true,
        }),
      ),
    ).toEqual(['panel-select-next-tab']);
    expect(
      matchedIds(
        event({ code: 'BracketLeft', key: '{', shiftKey: true, metaKey: true }),
      ),
    ).toEqual(['panel-select-previous-tab']);
    // ⌘] without Shift stays the group chord.
    expect(
      matchedIds(event({ code: 'BracketRight', key: ']', metaKey: true })),
    ).toEqual(['panel-focus-next-group']);
    // Ctrl+Tab belongs to Windows and Linux only.
    expect(matchedIds(event({ key: 'Tab', ctrlKey: true }))).toEqual([]);
  });

  test('Windows and Linux match Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+PageDown/PageUp', () => {
    expect(matchedIds(event({ key: 'Tab', ctrlKey: true }))).toEqual([
      'panel-select-next-tab',
    ]);
    expect(
      matchedIds(event({ key: 'Tab', ctrlKey: true, shiftKey: true })),
    ).toEqual(['panel-select-previous-tab']);
    expect(matchedIds(event({ key: 'PageDown', ctrlKey: true }))).toEqual([
      'panel-select-next-tab',
    ]);
    expect(matchedIds(event({ key: 'PageUp', ctrlKey: true }))).toEqual([
      'panel-select-previous-tab',
    ]);
    // The macOS bracket pair is not mapped to Ctrl+Shift+] here.
    expect(
      matchedIds(
        event({
          code: 'BracketRight',
          key: '}',
          shiftKey: true,
          ctrlKey: true,
        }),
      ),
    ).toEqual([]);
  });

  test('findEditableSafePanelShortcut finds only the tab-cycle chords', () => {
    expect(
      findEditableSafePanelShortcut(event({ key: 'Tab', ctrlKey: true }))?.id,
    ).toBe('panel-select-next-tab');
    expect(
      findEditableSafePanelShortcut(event({ key: 'PageUp', ctrlKey: true }))
        ?.id,
    ).toBe('panel-select-previous-tab');
    // Other panel chords and readline chords are not editable-safe.
    expect(
      findEditableSafePanelShortcut(event({ key: '\\', ctrlKey: true })),
    ).toBeUndefined();
    expect(
      findEditableSafePanelShortcut(event({ key: 'r', ctrlKey: true })),
    ).toBeUndefined();

    mockIsMac = true;
    expect(
      findEditableSafePanelShortcut(
        event({ code: 'BracketLeft', key: '{', shiftKey: true, metaKey: true }),
      )?.id,
    ).toBe('panel-select-previous-tab');
    expect(
      findEditableSafePanelShortcut(event({ key: 'Tab', ctrlKey: true })),
    ).toBeUndefined();
  });

  test('composition, Alt, and Ctrl+Meta together never match the tab chords', () => {
    mockIsMac = true;
    const mac = event({
      code: 'BracketRight',
      key: '}',
      shiftKey: true,
      metaKey: true,
    });
    expect(matchedIds({ ...mac, isComposing: true })).toEqual([]);
    expect(matchedIds({ ...mac, altKey: true })).toEqual([]);
    expect(matchedIds({ ...mac, ctrlKey: true })).toEqual([]);

    mockIsMac = false;
    const other = event({ key: 'Tab', ctrlKey: true });
    expect(matchedIds({ ...other, isComposing: true })).toEqual([]);
    expect(matchedIds({ ...other, altKey: true })).toEqual([]);
    expect(matchedIds({ ...other, metaKey: true })).toEqual([]);
  });

  test('bindings without code keep matching by key on every platform', () => {
    expect(matchedIds(event({ key: '\\', ctrlKey: true }))).toEqual([
      'panel-split-right',
    ]);
    mockIsMac = true;
    expect(matchedIds(event({ key: '\\', metaKey: true }))).toEqual([
      'panel-split-right',
    ]);
  });
});
