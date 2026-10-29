/** @jest-environment jsdom */

import { type PanelLayoutViewModel } from '@canopy/ui-shared/panels';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
  setPanelLayoutChatGroup,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { splitGroupMovingActiveTab } from '../split-active-tab';

const CHAT_A_INSTANCE = { chatTabId: 'chat-a' } as const;

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

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `split-active-${keyCounter}`);
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function groupContaining(
  viewModel: PanelLayoutViewModel,
  panelId: string,
): string | undefined {
  return viewModel.groups.find((group) =>
    group.tabs.some((tab) => tab.panelId === panelId),
  )?.groupId;
}

afterEach(() => {
  setPanelLayoutChatGroup(null);
  const state = store();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

describe('splitGroupMovingActiveTab', () => {
  test('moves the active tab into the new split when another tab stays behind', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    store().addTab(key, 'group-a', 'terminal', { panelId: 'panel-b' });

    splitGroupMovingActiveTab(key, 'group-a', 'right');

    const viewModel = getPanelLayoutViewModel(key);
    expect(viewModel).not.toBeNull();
    if (viewModel === null) return;

    const source = viewModel.groups.find(
      (group) => group.groupId === 'group-a',
    );
    expect(source?.tabs.map((tab) => tab.panelId)).toEqual(['panel-a']);
    const movedGroupId = groupContaining(viewModel, 'panel-b');
    expect(movedGroupId).toBeDefined();
    expect(movedGroupId).not.toBe('group-a');
    expect(viewModel.activeGroupId).toBe(movedGroupId);
  });

  test('keeps the existing empty-split behavior for a single-tab group', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    splitGroupMovingActiveTab(key, 'group-a', 'right');

    const viewModel = getPanelLayoutViewModel(key);
    expect(viewModel).not.toBeNull();
    if (viewModel === null) return;

    expect(viewModel.groups).toHaveLength(2);
    expect(
      viewModel.groups
        .find((group) => group.groupId === 'group-a')
        ?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-a']);
    expect(
      viewModel.groups.find((group) => group.groupId !== 'group-a')?.tabs,
    ).toEqual([]);
  });

  test('a chat kept in the chat group stays put and the split opens empty', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    store().addTab(key, 'group-a', 'chat', {
      panelId: 'panel-chat-2',
      instance: { chatTabId: 'chat-2' },
    });
    setPanelLayoutChatGroup('group-a');

    splitGroupMovingActiveTab(key, 'group-a', 'right');

    const viewModel = getPanelLayoutViewModel(key);
    expect(viewModel).not.toBeNull();
    if (viewModel === null) return;
    expect(viewModel.groups).toHaveLength(2);
    expect(
      viewModel.groups
        .find((group) => group.groupId === 'group-a')
        ?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-a', 'panel-chat-2']);
    expect(
      viewModel.groups.find((group) => group.groupId !== 'group-a')?.tabs,
    ).toEqual([]);
  });
});
