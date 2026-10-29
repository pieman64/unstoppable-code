/**
 * Unit tests for the browser-panel activation bridge: routing exact-ID
 * `requestBrowserPanel` requests into the panel layout store (select the
 * existing bound panel anywhere in the family, else add a bound panel beside
 * the origin chat / to the active group, queueing until the worktree layout
 * is available) and into explicit browser activation.
 *
 * The layout store is mocked at the module boundary — the bridge's contract
 * is which store operations it dispatches, not grid mechanics (covered by
 * panelLayoutStore.test.ts).
 */
import {
  activateBoundBrowserPanel,
  cancelQueuedBrowserActivation,
  initBrowserPanelActivation,
  isBrowserActivationPending,
  resetBrowserPanelActivationForTests,
} from '../browser-panel-activation';
import type { RemoteControlContext } from '@canopy/desktop-shared/types';
import {
  requestBrowserPanel,
  subscribeBrowserPanelActivation,
} from '@/lib/browserPanelActivation';

interface MockLayoutStore {
  layouts: Record<
    string,
    {
      activeGroupId: string | null;
      mruGroupIds?: string[];
      groups?: Record<
        string,
        {
          activePanelId?: string | null;
          tabs: Array<{
            kind: string;
            panelId: string;
            instance?: { browserId?: string };
          }>;
        }
      >;
    }
  >;
  selectTab: jest.Mock;
  focusGroup: jest.Mock;
  addTab: jest.Mock;
  ensureGroupExpanded: jest.Mock;
  serializeLayout: jest.Mock;
  collapseGroup: jest.Mock;
  expandGroup: jest.Mock;
  splitGroup: jest.Mock;
  closeGroup: jest.Mock;
}

const mockStore: MockLayoutStore = {
  layouts: {},
  selectTab: jest.fn(),
  focusGroup: jest.fn(),
  addTab: jest.fn(),
  ensureGroupExpanded: jest.fn(),
  serializeLayout: jest.fn(),
  collapseGroup: jest.fn(),
  expandGroup: jest.fn(),
  splitGroup: jest.fn(),
  closeGroup: jest.fn(),
};

const mockFindPanelByInstanceKey = jest.fn();
let layoutSubscriber: ((state: { layouts: unknown }) => void) | null = null;

jest.mock('@/stores/panelLayoutStore', () => ({
  usePanelLayoutStore: {
    getState: (): unknown => mockStore,
    subscribe: (
      listener: (state: { layouts: unknown }) => void,
    ): (() => void) => {
      layoutSubscriber = listener;
      return (): void => {
        layoutSubscriber = null;
      };
    },
  },
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  getPanelInstanceKey: (descriptor: {
    kind: string;
    instance?: Record<string, string>;
  }): string =>
    descriptor.kind === 'browser'
      ? `browser:${descriptor.instance?.browserId ?? ''}`
      : `${descriptor.kind}:${Object.values(descriptor.instance ?? {})[0] ?? ''}`,
  findPanelByInstanceKey: (worktreeKey: string, instanceKey: string): unknown =>
    mockFindPanelByInstanceKey(worktreeKey, instanceKey),
}));

// The side-group placement is shared code that reads the layout store from
// its own package, so the same fake store has to stand in there too.
jest.mock('@canopy/ui-app/code/panels/panel-layout-store', (): unknown =>
  jest.requireMock('@/stores/panelLayoutStore'),
);

const mockSetActiveBrowser = jest.fn().mockResolvedValue(undefined);
let mockPinnedBrowserId: string | null = null;
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): unknown => ({ setActiveBrowser: mockSetActiveBrowser }),
  },
  selectBrowserHandoff: (): unknown =>
    mockPinnedBrowserId === null ? null : { browserId: mockPinnedBrowserId },
}));

const mockRevealPanel = jest.fn();
jest.mock('../panel-reveal', () => ({
  revealPanel: (...args: unknown[]): unknown => mockRevealPanel(...args),
}));

jest.mock('../browser-panel-identity', () => ({
  browserPanelIdFor: (browserId: string): string =>
    `panel-browser-${browserId}`,
}));

const REMOTE_CONTEXT: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'device-b',
  name: 'Studio',
  platform: 'darwin',
};
const mockReadRemoteControlContext = jest.fn(
  (): RemoteControlContext => ({ mode: 'local' }),
);
jest.mock('@/stores/remoteControlStore', () => ({
  readRemoteControlContext: (): RemoteControlContext =>
    mockReadRemoteControlContext(),
}));

function notifyLayoutsChanged(): void {
  layoutSubscriber?.({ layouts: { ...mockStore.layouts } });
}

describe('browser-panel activation bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPinnedBrowserId = null;
    mockStore.layouts = {};
    mockStore.serializeLayout.mockReturnValue(null);
    mockStore.collapseGroup.mockReturnValue(false);
    resetBrowserPanelActivationForTests();
    initBrowserPanelActivation();
  });

  it('selects, focuses, and activates an already-bound panel (exact id)', async () => {
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-x',
      panelId: 'panel-browser-b1',
    });
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-x' } };

    await requestBrowserPanel('p1', 'w1', 'b1');

    expect(mockFindPanelByInstanceKey).toHaveBeenCalledWith(
      'p1/w1',
      'browser:b1',
    );
    expect(mockStore.ensureGroupExpanded).toHaveBeenCalledWith(
      'p1/w1',
      'group-x',
    );
    expect(mockStore.selectTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-x',
      'panel-browser-b1',
    );
    expect(mockStore.focusGroup).toHaveBeenCalledWith('p1/w1', 'group-x');
    expect(mockStore.addTab).not.toHaveBeenCalled();
    // Activation is explicit: the revealed browser becomes the active one.
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
    // Reveal-path guard: expand before select.
    expect(
      mockStore.ensureGroupExpanded.mock.invocationCallOrder[0],
    ).toBeLessThan(mockStore.selectTab.mock.invocationCallOrder[0]);
  });

  it('leaves an already-bound panel and the active group untouched for background agent steering', async () => {
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-browser',
      panelId: 'panel-browser-b1',
    });
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };

    await requestBrowserPanel('p1', 'w1', 'b1', undefined, { focus: false });

    expect(mockStore.ensureGroupExpanded).not.toHaveBeenCalled();
    expect(mockStore.selectTab).not.toHaveBeenCalled();
    expect(mockStore.focusGroup).not.toHaveBeenCalled();
    expect(mockStore.addTab).not.toHaveBeenCalled();
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('keeps a pinned handoff browser active during background agent steering', async () => {
    mockPinnedBrowserId = 'b-handoff';
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-browser',
      panelId: 'panel-browser-b1',
    });
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };

    await requestBrowserPanel('p1', 'w1', 'b1', undefined, { focus: false });
    expect(mockSetActiveBrowser).not.toHaveBeenCalled();

    // An explicit foreground request still wins over the pin.
    await requestBrowserPanel('p1', 'w1', 'b1');
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('keeps the add-tab fallback non-activating for background presentation', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };
    mockStore.addTab
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('panel-fallback');
    await requestBrowserPanel('p1', 'w1', 'b1', undefined, { focus: false });
    expect(mockStore.addTab).toHaveBeenCalledTimes(2);
    expect(mockStore.addTab).toHaveBeenNthCalledWith(
      1,
      'p1/w1',
      'group-chat',
      'browser',
      expect.objectContaining({ activate: false }),
    );
    expect(mockStore.addTab).toHaveBeenNthCalledWith(
      2,
      'p1/w1',
      'group-chat',
      'browser',
      expect.objectContaining({ activate: false }),
    );
  });

  it('declines instead of queueing when queue is false, so focus never lands later', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);

    await expect(
      requestBrowserPanel('p1', 'w-late', 'b1', undefined, {
        focus: true,
        queue: false,
      }),
    ).resolves.toBe(false);
    expect(isBrowserActivationPending('b1')).toBe(false);

    mockStore.layouts = { 'p1/w-late': { activeGroupId: 'group-a' } };
    notifyLayoutsChanged();

    expect(mockStore.addTab).not.toHaveBeenCalled();
    expect(mockStore.focusGroup).not.toHaveBeenCalled();
  });

  it('activates a moved Browser panel from its post-move location', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-destination',
        groups: {
          'group-destination': {
            activePanelId: 'panel-browser-b1',
            tabs: [
              {
                kind: 'browser',
                panelId: 'panel-browser-b1',
                instance: { browserId: 'b1' },
              },
            ],
          },
        },
      },
    };

    activateBoundBrowserPanel('p1', 'w1', null, 'panel-browser-b1');

    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('adds a BOUND browser tab to the active group when none is open', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1');

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
    expect(mockStore.selectTab).not.toHaveBeenCalled();
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('places a content-panel request in the most recently used chat group, not the active group', async () => {
    // The Open button lives in a Scripts panel in its own group; clicking it
    // makes that group active. Content placement must not put the browser
    // there: it follows the pipeline-run rule (MRU chat group).
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-scripts',
        mruGroupIds: ['group-scripts', 'group-chat'],
        groups: {
          'group-scripts': {
            tabs: [{ kind: 'scripts', panelId: 'panel-scripts' }],
          },
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
        },
      },
    };
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await expect(
      requestBrowserPanel('p1', 'w1', 'b1', undefined, {
        placement: 'content-panel',
      }),
    ).resolves.toBe(true);

    expect(mockStore.addTab).toHaveBeenCalledTimes(1);
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
    expect(mockRevealPanel).toHaveBeenCalledWith({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-browser-b1',
    });
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('reveals an already-bound panel in place for a content-panel request', async () => {
    const location = {
      layoutKey: 'p1/w1:aux-1',
      groupId: 'group-browser',
      panelId: 'panel-browser-b1',
    };
    mockFindPanelByInstanceKey.mockReturnValue(location);
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-scripts' } };

    await requestBrowserPanel('p1', 'w1', 'b1', undefined, {
      placement: 'content-panel',
    });

    expect(mockRevealPanel).toHaveBeenCalledWith(location);
    expect(mockStore.addTab).not.toHaveBeenCalled();
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('adds a missing browser panel without selecting or focusing it for background agent steering', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', undefined, { focus: false });

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      'browser',
      expect.objectContaining({
        instance: { browserId: 'b1' },
        activate: false,
      }),
    );
    expect(mockStore.focusGroup).not.toHaveBeenCalled();
    expect(mockSetActiveBrowser).toHaveBeenCalledWith('p1', 'w1', 'b1');
  });

  it('splits beside the originating chat when adding a bound panel', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
        },
      },
    };
    mockStore.splitGroup.mockReturnValue('group-browser-side');
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', 'chat-1');

    expect(mockStore.splitGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      'right',
    );
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-browser-side',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
  });

  it('restores the active chat group after a background browser split', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
        },
      },
    };
    mockStore.splitGroup.mockReturnValue('group-browser-side');
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', 'chat-1', { focus: false });

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-browser-side',
      'browser',
      expect.objectContaining({ activate: false }),
    );
    expect(mockStore.focusGroup).toHaveBeenCalledWith('p1/w1', 'group-chat');
  });

  it('collapses a full-height right rail before creating a browser sibling', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
          'group-activity': {
            tabs: [{ kind: 'activity-section', panelId: 'panel-activity' }],
          },
        },
      },
    };
    mockStore.serializeLayout.mockReturnValue({
      grid: {
        orientation: 1,
        root: {
          type: 'branch',
          children: [
            { type: 'leaf', groupId: 'group-chat' },
            { type: 'leaf', groupId: 'group-activity' },
          ],
        },
      },
    });
    mockStore.collapseGroup.mockReturnValue(true);
    mockStore.splitGroup.mockReturnValue('group-browser-side');
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', 'chat-1');

    expect(mockStore.collapseGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-activity',
    );
    expect(mockStore.collapseGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mockStore.splitGroup.mock.invocationCallOrder[0],
    );
    expect(mockStore.expandGroup).not.toHaveBeenCalled();
  });

  it('restores the right rail when browser insertion fails after splitting', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
          'group-activity': {
            tabs: [{ kind: 'activity-section', panelId: 'panel-activity' }],
          },
        },
      },
    };
    mockStore.serializeLayout.mockReturnValue({
      grid: {
        orientation: 1,
        root: {
          type: 'branch',
          children: [
            { type: 'leaf', groupId: 'group-chat' },
            { type: 'leaf', groupId: 'group-activity' },
          ],
        },
      },
    });
    mockStore.collapseGroup.mockReturnValue(true);
    mockStore.splitGroup.mockReturnValue('group-browser-side');
    mockStore.addTab.mockReturnValue(null);

    await expect(requestBrowserPanel('p1', 'w1', 'b1', 'chat-1')).resolves.toBe(
      false,
    );

    expect(mockStore.closeGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-browser-side',
    );
    expect(mockStore.expandGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-activity',
      { focus: false },
    );
  });

  it('reuses an existing file side panel beside the originating chat', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-files', 'group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
          'group-files': {
            tabs: [{ kind: 'file-diff', panelId: 'panel-file' }],
          },
        },
      },
    };
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', 'chat-1');

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-files',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
    expect(mockStore.splitGroup).not.toHaveBeenCalled();
  });

  it('reuses an existing browser sibling when opened from another chat', async () => {
    mockFindPanelByInstanceKey.mockReturnValueOnce(null).mockReturnValueOnce({
      layoutKey: 'p1/w1',
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        mruGroupIds: ['group-browser', 'group-chat'],
        groups: {
          'group-chat': {
            tabs: [{ kind: 'chat', panelId: 'panel-chat' }],
          },
          'group-browser': {
            tabs: [
              {
                kind: 'browser',
                panelId: 'panel-browser-existing',
                instance: { browserId: 'existing' },
              },
            ],
          },
        },
      },
    };
    mockStore.addTab.mockReturnValue('panel-browser-b1');

    await requestBrowserPanel('p1', 'w1', 'b1', 'chat-2');

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-browser',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
    expect(mockStore.splitGroup).not.toHaveBeenCalled();
  });

  it('queues requests until the worktree layout is available, keeping the id pending', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);

    const activation = requestBrowserPanel('p1', 'w-late', 'b1');

    // Nothing dispatched yet; the target id stays activation-pending so the
    // lifecycle coordinator cannot reap the session mid-queue.
    expect(mockStore.addTab).not.toHaveBeenCalled();
    expect(isBrowserActivationPending('b1')).toBe(true);

    // The layout appears → the queued request flushes.
    mockStore.layouts = { 'p1/w-late': { activeGroupId: 'group-a' } };
    mockStore.addTab.mockReturnValue('panel-browser-b1');
    notifyLayoutsChanged();

    await activation;

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w-late',
      'group-a',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b1' } }),
    );
    expect(isBrowserActivationPending('b1')).toBe(false);
  });

  it('never places a queued request whose session was destroyed before the layout appeared', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);

    const activation = requestBrowserPanel('p1', 'w-late', 'b-gone');
    const other = requestBrowserPanel('p1', 'w-late', 'b-kept');
    cancelQueuedBrowserActivation('b-gone');

    await expect(activation).resolves.toBe(false);
    expect(isBrowserActivationPending('b-gone')).toBe(false);

    mockStore.layouts = { 'p1/w-late': { activeGroupId: 'group-a' } };
    mockStore.addTab.mockReturnValue('panel-browser-b-kept');
    notifyLayoutsChanged();

    await expect(other).resolves.toBe(true);
    expect(mockStore.addTab).toHaveBeenCalledTimes(1);
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w-late',
      'group-a',
      'browser',
      expect.objectContaining({ instance: { browserId: 'b-kept' } }),
    );
  });

  it('fails and releases a queued request when the layout never becomes available', async () => {
    jest.useFakeTimers();
    try {
      mockFindPanelByInstanceKey.mockReturnValue(null);

      const activation = requestBrowserPanel('p1', 'w-missing', 'b1');

      expect(isBrowserActivationPending('b1')).toBe(true);
      jest.advanceTimersByTime(10_000);

      await expect(activation).resolves.toBe(false);
      expect(isBrowserActivationPending('b1')).toBe(false);

      mockStore.layouts = { 'p1/w-missing': { activeGroupId: 'group-a' } };
      notifyLayoutsChanged();

      expect(mockStore.addTab).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports insertion failure without destroying the target', async () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };
    mockStore.addTab.mockReturnValue(null);

    const activated = await requestBrowserPanel('p1', 'w1', 'b1');

    // Insertion failed: no activation claim and no destruction — rollback of
    // freshly created sessions is the creating caller's responsibility.
    expect(mockSetActiveBrowser).not.toHaveBeenCalled();
    expect(isBrowserActivationPending('b1')).toBe(false);
    expect(activated).toBe(false);
  });

  describe('in a window that shows another computer', () => {
    // The in-app browser is blocked there (`browserCreate` does not tunnel),
    // so a placed Browser tab could never render and would be saved into the
    // other computer's layout.
    afterEach(() => {
      mockReadRemoteControlContext.mockReturnValue({ mode: 'local' });
    });

    it('declines placement without adding a Browser tab or notifying the grid', async () => {
      mockReadRemoteControlContext.mockReturnValue(REMOTE_CONTEXT);
      mockFindPanelByInstanceKey.mockReturnValue(null);
      mockStore.layouts = {
        'p1/w1': {
          activeGroupId: 'group-chat',
          mruGroupIds: ['group-chat'],
          groups: {
            'group-chat': { tabs: [{ kind: 'chat', panelId: 'panel-chat' }] },
          },
        },
      };
      mockStore.addTab.mockReturnValue('panel-browser-b1');
      const listener = jest.fn();
      const unsubscribe = subscribeBrowserPanelActivation(listener);
      try {
        await expect(
          requestBrowserPanel('p1', 'w1', 'b1', undefined, {
            placement: 'content-panel',
          }),
        ).resolves.toBe(false);
      } finally {
        unsubscribe();
      }

      expect(listener).not.toHaveBeenCalled();
      expect(mockStore.addTab).not.toHaveBeenCalled();
      expect(mockSetActiveBrowser).not.toHaveBeenCalled();
      expect(isBrowserActivationPending('b1')).toBe(false);
    });

    it('never replays a queued request into a remote window', async () => {
      mockFindPanelByInstanceKey.mockReturnValue(null);
      const activation = requestBrowserPanel('p1', 'w-late', 'b1');
      expect(isBrowserActivationPending('b1')).toBe(true);

      mockReadRemoteControlContext.mockReturnValue(REMOTE_CONTEXT);
      mockStore.layouts = { 'p1/w-late': { activeGroupId: 'group-a' } };
      mockStore.addTab.mockReturnValue('panel-browser-b1');
      notifyLayoutsChanged();

      await expect(activation).resolves.toBe(false);
      expect(mockStore.addTab).not.toHaveBeenCalled();
      expect(isBrowserActivationPending('b1')).toBe(false);
    });

    it('still places Browser panels in a window that shows this computer', async () => {
      mockFindPanelByInstanceKey.mockReturnValue(null);
      mockStore.layouts = { 'p1/w1': { activeGroupId: 'group-chat' } };
      mockStore.addTab.mockReturnValue('panel-browser-b1');

      await expect(requestBrowserPanel('p1', 'w1', 'b1')).resolves.toBe(true);
      expect(mockStore.addTab).toHaveBeenCalledTimes(1);
    });
  });
});
