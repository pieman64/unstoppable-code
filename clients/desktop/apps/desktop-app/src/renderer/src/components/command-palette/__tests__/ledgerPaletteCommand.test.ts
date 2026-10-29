/** @jest-environment jsdom */

// The "Open Feed panel" palette command: offered only while the Ledger is on and a
// task is selected, it shows the selected scope's Ledger panel, adding it to
// the active group the first time and focusing it after that.

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { buildBaseCommands, type PaletteCommand } from '../paletteCommands';

const SELECTION = { projectId: 'project-a', worktreeId: 'wt-1' };
const WORKTREE_KEY = makeWorktreePanelKey(
  SELECTION.projectId,
  SELECTION.worktreeId,
);
const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
  containerSize: { width: 800, height: 600 },
};

const originalFlags = useFeatureFlagsStore.getState().snapshot;

function setLedgerFlag(enabled: boolean): void {
  useFeatureFlagsStore.setState({
    snapshot: {
      ...originalFlags,
      values: {
        ...originalFlags.values,
        [CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key]: enabled,
      },
    },
  });
}

function ledgerCommand(): PaletteCommand | undefined {
  return buildBaseCommands(SELECTION).find(
    (command) => command.commandKey === 'open-ledger-panel',
  );
}

function ledgerTabs(): number {
  const layout = usePanelLayoutStore.getState().layouts[WORKTREE_KEY];
  return Object.values(layout?.groups ?? {}).flatMap((group) =>
    group.tabs.filter((tab) => tab.kind === 'ledger'),
  ).length;
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'overview' });
  useChatStore.setState({ selectedWorktree: SELECTION });
  usePanelLayoutStore.getState().initializeLayout(WORKTREE_KEY, ONE_GROUP);
});

afterEach(() => {
  useFeatureFlagsStore.setState({ snapshot: originalFlags });
  const state = usePanelLayoutStore.getState();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

test('is not offered while the Ledger is off', () => {
  setLedgerFlag(false);
  expect(ledgerCommand()).toBeUndefined();
});

test('adds the Ledger panel once, then shows the one it added', async () => {
  setLedgerFlag(true);
  const command = ledgerCommand();
  expect(command).toMatchObject({
    title: 'Open Feed panel',
    category: 'panels',
  });

  await expect(Promise.resolve(command?.execute())).resolves.toEqual({
    closePalette: true,
  });
  expect(useNavigationStore.getState().activePage).toBe('main');
  expect(ledgerTabs()).toBe(1);

  await expect(Promise.resolve(command?.execute())).resolves.toEqual({
    closePalette: true,
  });
  expect(ledgerTabs()).toBe(1);
});
