/** @jest-environment jsdom */

/**
 * Browser panel ⇄ session lifecycle coordinator tests, against the REAL
 * panel layout store: every committed close path permanently destroys
 * exactly the removed panel's session, while move / reorder / pin /
 * collapse / maximize / tab switch / layout teardown never destroy.
 */
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { useBrowserStore } from '@/stores/browserStore';
import {
  discardOpenedBrowser,
  findBrowserPanelBindings,
  flushBrowserPanelSyncForTests,
  handleBrowserDestroyedEvent,
  initBrowserPanelSync,
  requestBrowserSessionDestruction,
  resetBrowserPanelSyncForTests,
} from '../browser-panel-sync';

jest.mock('../browser-panel-activation', () => ({
  isBrowserActivationPending: jest.fn(() => false),
}));
jest.mock('../browser-panel-identity', () => ({
  isRecoveryBrowserId: (browserId: string): boolean =>
    browserId === 'browser-hydration-recovery',
}));

import { isBrowserActivationPending } from '../browser-panel-activation';

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `sync-worktree-${keyCounter}`);
}

function layoutWithBrowsers(browserIds: string[]): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      ...browserIds.map((browserId, index) => ({
        kind: 'browser' as const,
        groupId: `group-browser-${index}`,
        panelId: `panel-browser-${browserId}`,
        instance: { browserId },
      })),
    ],
    containerSize: { width: 1200, height: 700 },
  };
}

const destroyBrowser = jest.fn().mockResolvedValue(undefined);
const dropBrowserSession = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  destroyBrowser.mockReset().mockResolvedValue(undefined);
  dropBrowserSession.mockReset();
  resetBrowserPanelSyncForTests();
  (isBrowserActivationPending as jest.Mock).mockReturnValue(false);
  useBrowserStore.setState({
    worktrees: {},
    destroyBrowser,
    dropBrowserSession,
  });
});

afterEach(() => {
  resetBrowserPanelSyncForTests();
});

async function settle(): Promise<void> {
  flushBrowserPanelSyncForTests();
  await Promise.resolve();
}

describe('browser-panel-sync', () => {
  it('destroys exactly the closed panel session (direct close)', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1', 'b2']));
    initBrowserPanelSync();

    usePanelLayoutStore
      .getState()
      .closeTab(key, 'group-browser-0', 'panel-browser-b1');
    await settle();

    expect(destroyBrowser).toHaveBeenCalledTimes(1);
    expect(destroyBrowser).toHaveBeenCalledWith(
      'project',
      `sync-worktree-${keyCounter}`,
      'b1',
    );
  });

  it('retries a material backend destruction failure while the panel stays closed', async () => {
    jest.useFakeTimers();
    try {
      const key = nextKey();
      usePanelLayoutStore
        .getState()
        .initializeLayout(key, layoutWithBrowsers(['b1']));
      initBrowserPanelSync();
      destroyBrowser
        .mockRejectedValueOnce(new Error('browser-state write failed'))
        .mockResolvedValueOnce(undefined);

      usePanelLayoutStore
        .getState()
        .closeTab(key, 'group-browser-0', 'panel-browser-b1');
      await settle();
      await Promise.resolve();
      expect(destroyBrowser).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(destroyBrowser).toHaveBeenCalledTimes(2);
      expect(destroyBrowser).toHaveBeenLastCalledWith(
        'project',
        `sync-worktree-${keyCounter}`,
        'b1',
      );
    } finally {
      resetBrowserPanelSyncForTests();
      jest.useRealTimers();
    }
  });

  it('retries a failed create rollback even when no layout family is mounted', async () => {
    jest.useFakeTimers();
    try {
      destroyBrowser
        .mockRejectedValueOnce(new Error('browser-state write failed'))
        .mockResolvedValueOnce(undefined);

      requestBrowserSessionDestruction('project', 'unmounted-worktree', 'b1');
      await Promise.resolve();
      await Promise.resolve();
      expect(destroyBrowser).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(destroyBrowser).toHaveBeenCalledTimes(2);
      expect(destroyBrowser).toHaveBeenLastCalledWith(
        'project',
        'unmounted-worktree',
        'b1',
      );
    } finally {
      resetBrowserPanelSyncForTests();
      jest.useRealTimers();
    }
  });

  it('destroys every session removed by a batch close', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers([]));
    // Two browser tabs in ONE group so Close All targets both.
    usePanelLayoutStore.getState().addTab(key, 'group-chat', 'browser', {
      panelId: 'panel-browser-b1',
      instance: { browserId: 'b1' },
    });
    usePanelLayoutStore.getState().addTab(key, 'group-chat', 'browser', {
      panelId: 'panel-browser-b2',
      instance: { browserId: 'b2' },
    });
    initBrowserPanelSync();

    usePanelLayoutStore
      .getState()
      .closeTabs(key, 'group-chat', ['panel-browser-b1', 'panel-browser-b2']);
    await settle();

    expect(destroyBrowser).toHaveBeenCalledTimes(2);
    const destroyed = (
      destroyBrowser.mock.calls as Array<[string, string, string]>
    )
      .map((call) => call[2])
      .sort();
    expect(destroyed).toEqual(['b1', 'b2']);
  });

  it('destroys sessions of a closed group', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1']));
    initBrowserPanelSync();

    usePanelLayoutStore.getState().closeGroup(key, 'group-browser-0');
    await settle();

    expect(destroyBrowser).toHaveBeenCalledWith(
      'project',
      `sync-worktree-${keyCounter}`,
      'b1',
    );
  });

  it('preserves sessions on move / reorder / pin / collapse / maximize / tab switch', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1', 'b2']));
    initBrowserPanelSync();
    const store = usePanelLayoutStore.getState;

    // Atomic inter-group transfer.
    store().movePanel(key, 'panel-browser-b1', 'group-browser-1', 'center');
    await settle();
    // Reorder within the group.
    store().reorderTab(key, 'group-browser-1', 'panel-browser-b1', 0);
    await settle();
    // Pin.
    store().setTabPinned(key, 'group-browser-1', 'panel-browser-b1', true);
    await settle();
    // Tab switch (hides the other browser tab of the group).
    store().selectTab(key, 'group-browser-1', 'panel-browser-b2');
    await settle();
    // Maximize another group.
    store().maximizeGroup(key, 'group-chat', true);
    await settle();
    store().maximizeGroup(key, 'group-chat', false);
    await settle();

    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('ignores whole-layout teardown (worktree unmount / cache eviction)', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1']));
    initBrowserPanelSync();

    usePanelLayoutStore.getState().disposeLayout(key);
    await settle();

    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('re-binding after teardown does not misread the fresh layout as closes', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1']));
    initBrowserPanelSync();
    usePanelLayoutStore.getState().disposeLayout(key);
    await settle();

    // Layout returns (restore) with a DIFFERENT set of bound browsers.
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b2']));
    await settle();

    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('never destroys ids mid-activation or the recovery placeholder', async () => {
    const key = nextKey();
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'browser',
          groupId: 'group-a',
          panelId: 'panel-pending',
          instance: { browserId: 'b-pending' },
        },
        {
          kind: 'browser',
          groupId: 'group-b',
          panelId: 'panel-recovery',
          instance: { browserId: 'browser-hydration-recovery' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 1200, height: 700 },
    });
    initBrowserPanelSync();
    (isBrowserActivationPending as jest.Mock).mockImplementation(
      (browserId: string) => browserId === 'b-pending',
    );

    usePanelLayoutStore.getState().closeTab(key, 'group-a', 'panel-pending');
    usePanelLayoutStore.getState().closeTab(key, 'group-b', 'panel-recovery');
    await settle();

    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('finds the panels bound to a browser and skips unbound tabs', () => {
    const key = nextKey();
    const layout = layoutWithBrowsers(['b-lookup']);
    usePanelLayoutStore.getState().initializeLayout(key, {
      ...layout,
      groups: [
        ...layout.groups,
        // A browser tab still waiting for its session binding.
        {
          kind: 'browser',
          groupId: 'group-browser-pending',
          panelId: 'panel-browser-pending',
        },
      ],
    });

    expect(findBrowserPanelBindings('b-lookup')).toEqual([
      {
        layoutKey: key,
        groupId: 'group-browser-0',
        panelId: 'panel-browser-b-lookup',
      },
    ]);
    expect(findBrowserPanelBindings('b-unbound')).toEqual([]);
  });

  it('handles independent destroyed events without re-issuing a destroy', async () => {
    const key = nextKey();
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1']));
    initBrowserPanelSync();
    useBrowserStore.setState({
      worktrees: {
        [key]: {
          browserOrder: ['b1'],
          activeBrowserId: 'b1',
          browsers: {
            b1: { id: 'b1' } as never,
          },
          live: new Set(['b1']),
          hydrated: true,
        },
      },
    });

    handleBrowserDestroyedEvent('b1');
    await settle();

    // The bound panel was removed…
    const layout = usePanelLayoutStore.getState().layouts[key];
    const stillBound = Object.values(layout.groups).some((group) =>
      group.tabs.some((tab) => tab.instance?.browserId === 'b1'),
    );
    expect(stillBound).toBe(false);
    // …the local session dropped, and NO destroy loop back to the backend.
    expect(dropBrowserSession).toHaveBeenCalledWith(
      'project',
      `sync-worktree-${keyCounter}`,
      'b1',
    );
    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('discards an opened tab: destroys its session once and removes its panel', async () => {
    const key = nextKey();
    const worktreeId = `sync-worktree-${keyCounter}`;
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1', 'b2']));
    initBrowserPanelSync();

    await discardOpenedBrowser('project', worktreeId, 'b1');
    await settle();

    const layout = usePanelLayoutStore.getState().layouts[key];
    const bound = Object.values(layout.groups).flatMap((group) =>
      group.tabs.map((tab) => tab.instance?.browserId),
    );
    expect(bound).not.toContain('b1');
    expect(bound).toContain('b2');
    // Exactly one destroy: removing the panel does not loop a second one.
    expect(destroyBrowser).toHaveBeenCalledTimes(1);
    expect(destroyBrowser).toHaveBeenCalledWith('project', worktreeId, 'b1');
  });

  it('hands a failed discard of a placed tab to the normal close retry', async () => {
    const key = nextKey();
    const worktreeId = `sync-worktree-${keyCounter}`;
    usePanelLayoutStore
      .getState()
      .initializeLayout(key, layoutWithBrowsers(['b1']));
    initBrowserPanelSync();
    destroyBrowser
      .mockRejectedValueOnce(new Error('browser-state write failed'))
      .mockResolvedValueOnce(undefined);

    await discardOpenedBrowser('project', worktreeId, 'b1');
    await settle();
    await Promise.resolve();

    const layout = usePanelLayoutStore.getState().layouts[key];
    expect(
      Object.values(layout.groups).some((group) =>
        group.tabs.some((tab) => tab.instance?.browserId === 'b1'),
      ),
    ).toBe(false);
    // The panel close retries destruction.
    expect(destroyBrowser).toHaveBeenCalledTimes(2);
    expect(dropBrowserSession).not.toHaveBeenCalled();
  });
});
