/** @jest-environment jsdom */

// Palette adapter for the panel command layer (doc 12 §1): listing follows
// the layout view-model's availability, and execution dispatches through the
// panel layout store against the selected worktree's ACTIVE group.

import { COMMAND_DEFINITIONS } from '@/lib/keyboardShortcuts';
import { PANEL_COMMANDS } from '@/lib/panels/commands';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { buildPanelCommands, type PaletteCommand } from '../paletteCommands';

const SELECTION = { projectId: 'project-a', worktreeId: 'wt-1' };
const WORKTREE_KEY = makeWorktreePanelKey(
  SELECTION.projectId,
  SELECTION.worktreeId,
);

const TWO_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
  ],
  containerSize: { width: 900, height: 600 },
};

const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
  containerSize: { width: 800, height: 600 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function viewModel(): ReturnType<typeof store>['layouts'][string]['viewModel'] {
  return store().layouts[WORKTREE_KEY].viewModel;
}

function buildForCurrentLayout(): PaletteCommand[] {
  return buildPanelCommands(
    SELECTION,
    store().layouts[WORKTREE_KEY]?.viewModel ?? null,
  );
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'overview' });
  useChatStore.setState({ selectedWorktree: SELECTION });
});

afterEach(() => {
  const state = store();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

describe('buildPanelCommands listing', () => {
  test('returns nothing without a selection or a layout view-model', () => {
    expect(buildPanelCommands(null, null)).toEqual([]);
    expect(buildPanelCommands(SELECTION, null)).toEqual([]);
  });

  test('lists only available commands for a single-group layout', () => {
    store().initializeLayout(WORKTREE_KEY, ONE_GROUP);

    const commandKeys = buildForCurrentLayout().map(
      (command) => command.commandKey,
    );
    expect(commandKeys.sort()).toEqual([
      'panel-split-down',
      'panel-split-right',
    ]);
  });

  test('lists every panel command for a multi-group layout, with definitions', () => {
    store().initializeLayout(WORKTREE_KEY, TWO_GROUPS);

    const commands = buildForCurrentLayout();
    expect(commands.map((command) => command.commandKey).sort()).toEqual(
      PANEL_COMMANDS.map((command) => command.id).sort(),
    );

    // Each palette entry carries its shared COMMAND_DEFINITIONS copy.
    for (const command of commands) {
      const definition = COMMAND_DEFINITIONS.find(
        (entry) => entry.id === command.id,
      );
      expect(definition).toBeDefined();
      expect(command.title).toBe(definition?.title);
      expect(command.category).toBe('panels');
    }
  });
});

describe('buildPanelCommands execution', () => {
  test('navigates to main and runs the op against the active group', async () => {
    store().initializeLayout(WORKTREE_KEY, TWO_GROUPS);

    const split = buildForCurrentLayout().find(
      (command) => command.commandKey === 'panel-split-right',
    );
    expect(split).toBeDefined();

    await expect(Promise.resolve(split?.execute())).resolves.toEqual({
      closePalette: true,
    });
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(viewModel().groups).toHaveLength(3);
  });

  test('reports unavailability instead of closing when the selection is gone', async () => {
    store().initializeLayout(WORKTREE_KEY, TWO_GROUPS);
    const close = buildForCurrentLayout().find(
      (command) => command.commandKey === 'panel-close-group',
    );
    expect(close).toBeDefined();

    useChatStore.setState({ selectedWorktree: null });
    const result = await Promise.resolve(close?.execute());
    expect(result?.closePalette).toBe(false);
    expect(result?.error).toBeTruthy();
    expect(viewModel().groups).toHaveLength(2);
  });

  test('re-validates availability at dispatch time against fresh state', async () => {
    store().initializeLayout(WORKTREE_KEY, TWO_GROUPS);
    const close = buildForCurrentLayout().find(
      (command) => command.commandKey === 'panel-close-group',
    );
    expect(close).toBeDefined();

    // The layout shrank to one group after the palette listed the command.
    store().closeGroup(WORKTREE_KEY, 'group-b');

    const result = await Promise.resolve(close?.execute());
    expect(result?.closePalette).toBe(false);
    expect(result?.error).toBeTruthy();
    expect(viewModel().groups).toHaveLength(1);
  });
});
