/**
 * @jest-environment jsdom
 *
 * Early access keeps new chat tabs in the main chat group and new Activity
 * tabs out of the panels (it has its own card). A layout the user already
 * has keeps its chats and Activity tabs where they are, whether early access
 * turns on with it open or it loads while early access is on. Off, chats go
 * wherever they are asked, as before.
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import type * as ZustandModule from 'zustand';

import {
  ensureEarlyAccessPanelRulesSync,
  resetEarlyAccessPanelRulesSyncForTest,
} from '../early-access-panel-rules';

jest.mock('@/stores/experimentalFeaturesStore', () => {
  const { create } = jest.requireActual<typeof ZustandModule>('zustand');
  const useExperimentalFeaturesStore = create<{ enabled: boolean }>(() => ({
    enabled: false,
  }));
  return {
    useExperimentalFeaturesStore,
    ensureExperimentalFeaturesSubscription: (): void => undefined,
  };
});

const KEY = makeWorktreePanelKey('project', 'worktree');

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-a',
      instance: { chatTabId: 'chat-a' },
    },
    {
      kind: 'chat',
      groupId: 'group-extras',
      panelId: 'panel-chat-b',
      instance: { chatTabId: 'chat-b' },
    },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-term' },
  ],
  containerSize: { width: 1200, height: 800 },
};

function tabsOf(groupId: string): string[] {
  return (
    usePanelLayoutStore
      .getState()
      .layouts[KEY]?.viewModel.groups.find((group) => group.groupId === groupId)
      ?.tabs.map((tab) => tab.panelId) ?? []
  );
}

afterEach(() => {
  resetEarlyAccessPanelRulesSyncForTest();
  const state = usePanelLayoutStore.getState();
  for (const key of Object.keys(state.layouts)) state.disposeLayout(key);
  setTestEarlyAccessFeatures({ enabled: false });
});

describe('early access panel rules', () => {
  it('leaves existing chats in place and routes new ones when early access turns on', () => {
    ensureEarlyAccessPanelRulesSync();
    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
    expect(tabsOf('group-extras')).toEqual(['panel-chat-b']);

    setTestEarlyAccessFeatures({ enabled: true });

    expect(tabsOf('group-chat')).toEqual(['panel-chat-a']);
    expect(tabsOf('group-extras')).toEqual(['panel-chat-b']);
    expect(tabsOf('group-terminal')).toEqual(['panel-term']);
    // New chats asked for in the drawer land in the chat group.
    usePanelLayoutStore.getState().addTab(KEY, 'group-terminal', 'chat', {
      panelId: 'panel-chat-c',
      instance: { chatTabId: 'chat-c' },
    });
    expect(tabsOf('group-chat')).toEqual(['panel-chat-a', 'panel-chat-c']);
    expect(tabsOf('group-terminal')).toEqual(['panel-term']);
  });

  it('leaves the chats of a layout that loads while early access is on', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    ensureEarlyAccessPanelRulesSync();

    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);

    expect(tabsOf('group-chat')).toEqual(['panel-chat-a']);
    expect(tabsOf('group-extras')).toEqual(['panel-chat-b']);
  });

  it('leaves chats where they are while early access is off', () => {
    ensureEarlyAccessPanelRulesSync();
    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
    usePanelLayoutStore.getState().addTab(KEY, 'group-terminal', 'chat', {
      panelId: 'panel-chat-c',
      instance: { chatTabId: 'chat-c' },
    });

    expect(tabsOf('group-chat')).toEqual(['panel-chat-a']);
    expect(tabsOf('group-extras')).toEqual(['panel-chat-b']);
    expect(tabsOf('group-terminal')).toEqual(['panel-term', 'panel-chat-c']);
  });

  it('keeps existing Activity tabs and refuses new ones while early access is on', () => {
    ensureEarlyAccessPanelRulesSync();
    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
    usePanelLayoutStore
      .getState()
      .addTab(KEY, 'group-extras', 'activity-section', {
        panelId: 'panel-activity',
      });
    expect(tabsOf('group-extras')).toEqual(['panel-chat-b', 'panel-activity']);

    setTestEarlyAccessFeatures({ enabled: true });

    expect(tabsOf('group-extras')).toEqual(['panel-chat-b', 'panel-activity']);
    expect(
      usePanelLayoutStore
        .getState()
        .addTab(KEY, 'group-terminal', 'activity-section', {
          panelId: 'panel-activity-2',
        }),
    ).toBeNull();

    setTestEarlyAccessFeatures({ enabled: false });
    usePanelLayoutStore
      .getState()
      .closeTab(KEY, 'group-extras', 'panel-activity');
    expect(
      usePanelLayoutStore
        .getState()
        .addTab(KEY, 'group-terminal', 'activity-section', {
          panelId: 'panel-activity-3',
        }),
    ).toBe('panel-activity-3');
  });

  it('keeps Activity tabs in a shared-container viewer, which has no card', () => {
    const viewerKey = makeWorktreePanelKey(
      'shared-container-viewer',
      'container-1',
    );
    setTestEarlyAccessFeatures({ enabled: true });
    ensureEarlyAccessPanelRulesSync();
    usePanelLayoutStore.getState().initializeLayout(viewerKey, {
      ...LAYOUT,
      groups: [
        ...LAYOUT.groups,
        {
          kind: 'activity-section',
          groupId: 'group-activity',
          panelId: 'panel-activity',
        },
      ],
    });

    const groups =
      usePanelLayoutStore.getState().layouts[viewerKey]?.viewModel.groups ?? [];
    expect(
      groups.find((group) => group.groupId === 'group-activity')?.tabs,
    ).toHaveLength(1);
    // A viewer layout without one can still add it.
    const otherViewerKey = makeWorktreePanelKey(
      'shared-container-viewer',
      'container-2',
    );
    usePanelLayoutStore.getState().initializeLayout(otherViewerKey, LAYOUT);
    expect(
      usePanelLayoutStore
        .getState()
        .addTab(otherViewerKey, 'group-terminal', 'activity-section', {
          panelId: 'panel-activity-2',
        }),
    ).toBe('panel-activity-2');
  });

  it('lifts the restriction when early access turns off', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    ensureEarlyAccessPanelRulesSync();
    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);

    setTestEarlyAccessFeatures({ enabled: false });
    usePanelLayoutStore.getState().addTab(KEY, 'group-terminal', 'chat', {
      panelId: 'panel-chat-d',
      instance: { chatTabId: 'chat-d' },
    });

    expect(tabsOf('group-terminal')).toEqual(['panel-term', 'panel-chat-d']);
  });
});
