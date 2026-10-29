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
  isPanelCommandAvailable,
  PANEL_COMMANDS,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
  type PanelCommandId,
} from '../panel-commands';

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

const MULTI_GROUP_ONLY_IDS: PanelCommandId[] = ALL_COMMAND_IDS.filter(
  (id) => id !== 'panel-split-right' && id !== 'panel-split-down',
);

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

  test('multi-group layouts allow every command', () => {
    const key = nextKey();
    store().initializeLayout(key, THREE_GROUPS);

    for (const id of ALL_COMMAND_IDS) {
      expect(isPanelCommandAvailable(id, key)).toBe(true);
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

describe('shortcut bindings', () => {
  test('every command has exactly one default binding and vice versa', () => {
    expect(PANEL_SHORTCUT_BINDINGS.map((binding) => binding.id).sort()).toEqual(
      [...ALL_COMMAND_IDS].sort(),
    );
  });

  test('alt is only combined with arrow keys (macOS Option composes characters)', () => {
    for (const binding of PANEL_SHORTCUT_BINDINGS) {
      if (binding.alt === true) {
        expect(binding.key.startsWith('Arrow')).toBe(true);
      }
    }
  });
});
