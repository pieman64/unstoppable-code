/** @jest-environment jsdom */

/**
 * panelWindowsStore — the layout side of the Phase 8 pull-out/merge-back
 * lifecycle. The desktop panel registry is mocked to its `canPopOut` flags
 * (the real registry mounts heavy surface components), and `window.open` is
 * mocked per test (jsdom has no real window management). The DOM/window
 * side (`AuxPanelWindow`) is covered by the Electron pull-out spec.
 */
import type { PanelKind, SerializedPoppedPanelWindow } from '@canopy/protocol';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { DefaultLayoutDescriptor } from '../panelLayoutStore';
import {
  getPanelLayoutViewModel,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '../panelLayoutStore';
import {
  getAuxWindowSourceLabel,
  usePanelWindowsStore,
} from '../panelWindowsStore';

jest.mock('@/lib/panels/registry', () => ({
  getPanelDefinition: (kind: string): { canPopOut: boolean } => ({
    canPopOut: kind !== 'browser',
  }),
}));

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `worktree-windows-${keyCounter}`);
}

function layoutStore(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function windowsStore(): ReturnType<typeof usePanelWindowsStore.getState> {
  return usePanelWindowsStore.getState();
}

const TWO_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
  ],
  containerSize: { width: 900, height: 600 },
};

interface FakeChildWindow {
  closed: boolean;
  close: jest.Mock;
  focus: jest.Mock;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
}

function makeFakeChildWindow(): FakeChildWindow {
  const child: FakeChildWindow = {
    closed: false,
    close: jest.fn((): void => {
      child.closed = true;
    }),
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  return child;
}

interface WindowOpenCall {
  url?: string | URL;
  target?: string;
  features?: string;
}

/**
 * Installs a `window.open` mock returning `child` (or null) and returns the
 * captured call list. The fake is structurally sufficient for the store
 * (which only holds the handle and calls `close()` on rollback); the
 * `unknown` bridge matches the repo's test posture for window fakes.
 */
function mockWindowOpen(child: FakeChildWindow | null): {
  calls: WindowOpenCall[];
} {
  const capture: { calls: WindowOpenCall[] } = { calls: [] };
  const handle: Window | null =
    child === null ? null : (child as unknown as Window);
  const impl: typeof window.open = (url?, target?, features?) => {
    capture.calls.push({ url, target, features });
    return handle;
  };
  jest.spyOn(window, 'open').mockImplementation(impl);
  return capture;
}

afterEach(() => {
  jest.restoreAllMocks();
  // Drop aux records without running merge-back semantics.
  usePanelWindowsStore.setState({ auxWindows: {} });
  const state = layoutStore();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

describe('popOutGroup', () => {
  test('opens the child window, extracts the group, and records the aux window', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const child = makeFakeChildWindow();
    const openCapture = mockWindowOpen(child);

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) {
      return;
    }
    expect(openCapture.calls).toHaveLength(1);
    expect(openCapture.calls[0]).toEqual({
      url: 'about:blank',
      target: `canopy-panel-aux:${auxWindowId}`,
      features: 'width=900,height=600',
    });

    // Record shape.
    const record = windowsStore().auxWindows[auxWindowId];
    expect(record).toBeDefined();
    expect(record.worktreeKey).toBe(key);
    expect(record.sourceGroupId).toBe('group-b');
    expect(record.returnTarget).toEqual({
      anchorGroupId: 'group-a',
      direction: 'right',
      size: 450,
    });
    expect(record.status).toBe('open');
    expect(record.layoutKey).toBe(makeAuxPanelLayoutKey(key, auxWindowId));

    // Layouts moved: group-b left the main layout, aux layout holds it.
    expect(
      getPanelLayoutViewModel(key)?.groups.map((group) => group.groupId),
    ).toEqual(['group-a']);
    expect(
      getPanelLayoutViewModel(record.layoutKey)?.groups.map(
        (group) => group.groupId,
      ),
    ).toEqual(['group-b']);
  });

  test('uses the expanded size when a collapsed group is popped out', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const layout = layoutStore().layouts[key];
    const view = layout.leafViews.get('group-b');
    expect(view).toBeDefined();
    if (view === undefined) return;
    const expandedWidth = layout.grid.getViewSize(view).width;
    expect(layoutStore().collapseGroup(key, 'group-b')).toBe(true);
    expect(layoutStore().layouts[key].groups['group-b'].collapsed).toEqual({
      edge: 'right',
      expandedSize: expandedWidth,
    });
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;

    expect(windowsStore().auxWindows[auxWindowId].returnTarget?.size).toBe(
      expandedWidth,
    );
  });

  test('omits a non-positive captured return size', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const layout = layoutStore().layouts[key];
    jest
      .spyOn(layout.grid, 'getViewSize')
      .mockReturnValueOnce({ width: 0, height: 0 });
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;

    expect(windowsStore().auxWindows[auxWindowId].returnTarget).toEqual({
      anchorGroupId: 'group-a',
      direction: 'right',
    });
  });

  test('rejects groups containing a window-bound (browser) tab', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    layoutStore().addTab(key, 'group-b', 'browser', {
      instance: { browserId: 'browser-pop' },
    });
    const openCapture = mockWindowOpen(makeFakeChildWindow());

    expect(windowsStore().popOutGroup(key, 'group-b')).toBeNull();
    expect(openCapture.calls).toHaveLength(0);
    expect(getPanelLayoutViewModel(key)?.groups).toHaveLength(2);
  });

  test('rejects the last remaining group and unknown layouts/groups', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
      containerSize: { width: 800, height: 600 },
    });
    const openCapture = mockWindowOpen(makeFakeChildWindow());

    expect(windowsStore().popOutGroup(key, 'group-a')).toBeNull();
    expect(windowsStore().popOutGroup(key, 'group-none')).toBeNull();
    expect(windowsStore().popOutGroup('project/none', 'group-a')).toBeNull();
    expect(openCapture.calls).toHaveLength(0);
  });

  test('mutates nothing when window.open is denied (returns null)', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(null);

    expect(windowsStore().popOutGroup(key, 'group-b')).toBeNull();
    expect(getPanelLayoutViewModel(key)?.groups).toHaveLength(2);
    expect(Object.keys(windowsStore().auxWindows)).toHaveLength(0);
  });

  test('disposes all aux windows for a deleted worktree without merge-back', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const child = makeFakeChildWindow();
    mockWindowOpen(child);

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) {
      return;
    }
    const layoutKey = windowsStore().auxWindows[auxWindowId].layoutKey;

    windowsStore().disposeWorktreeAuxWindows(key);

    expect(child.close).toHaveBeenCalledTimes(1);
    expect(windowsStore().auxWindows[auxWindowId]).toBeUndefined();
    expect(layoutStore().layouts[layoutKey]).toBeUndefined();
    expect(
      getPanelLayoutViewModel(key)?.groups.map((group) => group.groupId),
    ).toEqual(['group-a']);
  });
});

describe('popOutPanel', () => {
  test('moves only the clicked tab and returns it to its original group', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    layoutStore().addTab(key, 'group-a', 'chat', {
      panelId: 'panel-extra',
      instance: { chatTabId: 'chat-extra' },
    });
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutPanel(
      key,
      'group-a',
      'panel-extra',
    );
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;

    expect(
      getPanelLayoutViewModel(key)
        ?.groups.find((group) => group.groupId === 'group-a')
        ?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-a']);
    expect(
      getPanelLayoutViewModel(
        windowsStore().auxWindows[auxWindowId].layoutKey,
      )?.groups[0].tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-extra']);

    windowsStore().mergeBack(auxWindowId);
    expect(
      getPanelLayoutViewModel(key)
        ?.groups.find((group) => group.groupId === 'group-a')
        ?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-a', 'panel-extra']);
  });

  test('preserves an empty source leaf when its only tab moves out', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutPanel(key, 'group-b', 'panel-b');
    expect(auxWindowId).not.toBeNull();
    expect(
      getPanelLayoutViewModel(key)?.groups.find(
        (group) => group.groupId === 'group-b',
      )?.tabs,
    ).toEqual([]);
  });
});

/** A persisted single-group popped-out entry (Phase 9 restore input). */
function makePoppedEntry(
  overrides: Partial<{
    windowId: string;
    kind: PanelKind;
    activeGroupId: string | undefined;
  }> = {},
): SerializedPoppedPanelWindow {
  const kind: PanelKind = overrides.kind ?? 'terminal';
  // Instance-bound kinds carry a binding so the entry satisfies the per-kind
  // instance contract and never collides with the fixture layout's tabs.
  const instance: Readonly<Record<string, string>> | undefined =
    kind === 'chat'
      ? { chatTabId: 'chat-popped' }
      : kind === 'file-diff'
        ? { fileTabId: 'file-popped' }
        : kind === 'browser'
          ? { browserId: 'browser-popped' }
          : undefined;
  const base: SerializedPoppedPanelWindow = {
    windowId: overrides.windowId ?? 'aux-restored-1',
    grid: {
      root: {
        type: 'leaf',
        groupId: 'group-popped',
        panels: [
          {
            panelId: 'panel-popped',
            kind,
            ...(instance !== undefined ? { instance } : {}),
          },
        ],
        activePanelId: 'panel-popped',
        size: 500,
      },
      orientation: 1,
      width: 800,
      height: 500,
    },
    bounds: { x: 10, y: 20, width: 800, height: 500 },
    sourceGroupId: 'group-b',
  };
  return overrides.activeGroupId !== undefined
    ? { ...base, activeGroupId: overrides.activeGroupId }
    : base;
}

describe('restorePoppedWindow', () => {
  test('re-opens the OS window at persisted bounds and rebuilds the aux layout', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const child = makeFakeChildWindow();
    const openCapture = mockWindowOpen(child);

    const outcome = windowsStore().restorePoppedWindow(key, makePoppedEntry());
    expect(outcome).toBe('opened');

    // The window opened with the persisted bounds in the features string and
    // the entry's stable window id in the frame name.
    expect(openCapture.calls).toHaveLength(1);
    expect(openCapture.calls[0]).toEqual({
      url: 'about:blank',
      target: 'canopy-panel-aux:aux-restored-1',
      features: 'left=10,top=20,width=800,height=500',
    });

    // The record was registered without startup focus stealing.
    const record = windowsStore().auxWindows['aux-restored-1'];
    expect(record).toBeDefined();
    expect(record.worktreeKey).toBe(key);
    expect(record.sourceGroupId).toBe('group-b');
    expect(record.focusOnOpen).toBe(false);
    expect(record.status).toBe('open');

    // The aux layout was rebuilt from the persisted grid.
    const auxViewModel = getPanelLayoutViewModel(record.layoutKey);
    expect(auxViewModel?.groups.map((group) => group.groupId)).toEqual([
      'group-popped',
    ]);
    expect(auxViewModel?.groups[0].tabs.map((tab) => tab.panelId)).toEqual([
      'panel-popped',
    ]);
    // The main layout is untouched.
    expect(getPanelLayoutViewModel(key)?.groups).toHaveLength(2);
  });

  test('merges the persisted tabs back into the worktree layout when the open is denied', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(null);

    // A chat-bound entry: a popped-out `terminal` would collide with the
    // fixture layout's terminal singleton and be defensively dropped by the
    // merge-back's family instance-key dedupe.
    const outcome = windowsStore().restorePoppedWindow(
      key,
      makePoppedEntry({ kind: 'chat' }),
    );
    expect(outcome).toBe('merged-back');

    // No record, no orphaned aux layout — the tabs landed in the main layout.
    expect(Object.keys(windowsStore().auxWindows)).toHaveLength(0);
    const viewModel = getPanelLayoutViewModel(key);
    const allPanelIds = viewModel?.groups.flatMap((group) =>
      group.tabs.map((tab) => tab.panelId),
    );
    expect(allPanelIds).toContain('panel-popped');
    expect(Object.keys(layoutStore().layouts)).toHaveLength(1);
  });

  test('merges back (without opening a window) when a persisted tab is no longer poppable', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const openCapture = mockWindowOpen(makeFakeChildWindow());

    const outcome = windowsStore().restorePoppedWindow(
      key,
      makePoppedEntry({ kind: 'browser' }),
    );
    expect(outcome).toBe('merged-back');
    expect(openCapture.calls).toHaveLength(0);
    const allPanelIds = getPanelLayoutViewModel(key)?.groups.flatMap((group) =>
      group.tabs.map((tab) => tab.panelId),
    );
    expect(allPanelIds).toContain('panel-popped');
  });

  test('skips unknown worktree layouts and duplicate window ids', () => {
    const key = nextKey();
    const openCapture = mockWindowOpen(makeFakeChildWindow());

    // Unknown worktree layout.
    expect(windowsStore().restorePoppedWindow(key, makePoppedEntry())).toBe(
      'skipped',
    );
    expect(openCapture.calls).toHaveLength(0);

    // Duplicate: restoring the same entry twice registers once.
    layoutStore().initializeLayout(key, TWO_GROUPS);
    expect(windowsStore().restorePoppedWindow(key, makePoppedEntry())).toBe(
      'opened',
    );
    expect(windowsStore().restorePoppedWindow(key, makePoppedEntry())).toBe(
      'skipped',
    );
    expect(Object.keys(windowsStore().auxWindows)).toHaveLength(1);
  });
});

describe('mergeBack / handleChildWindowClosed', () => {
  test('adopts the aux tabs back into the worktree layout and drops the record', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) {
      return;
    }
    const { layoutKey } = windowsStore().auxWindows[auxWindowId];

    windowsStore().mergeBack(auxWindowId);

    expect(windowsStore().auxWindows[auxWindowId]).toBeUndefined();
    expect(getPanelLayoutViewModel(layoutKey)).toBeNull();
    const viewModel = getPanelLayoutViewModel(key);
    expect(viewModel?.groups).toHaveLength(2);
    const restored = viewModel?.groups.find(
      (group) => group.groupId === 'group-b',
    );
    expect(restored?.tabs.map((tab) => tab.panelId)).toEqual(['panel-b']);
    expect(restored?.activePanelId).toBe('panel-b');
  });

  test('handleChildWindowClosed runs the same merge-back semantics idempotently', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) {
      return;
    }

    windowsStore().handleChildWindowClosed(auxWindowId);
    // Repeat calls (pagehide + close-poll both firing) are no-ops.
    windowsStore().handleChildWindowClosed(auxWindowId);
    windowsStore().mergeBack(auxWindowId);

    const viewModel = getPanelLayoutViewModel(key);
    expect(
      viewModel?.groups
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.panelId === 'panel-b'),
    ).toHaveLength(1);
  });

  test('disposes the orphaned aux layout when the worktree layout is gone', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) {
      return;
    }
    const { layoutKey } = windowsStore().auxWindows[auxWindowId];

    // Worktree archived while popped out.
    layoutStore().disposeLayout(key);

    windowsStore().mergeBack(auxWindowId);
    expect(windowsStore().auxWindows[auxWindowId]).toBeUndefined();
    expect(getPanelLayoutViewModel(layoutKey)).toBeNull();
  });
});

describe('focusAuxWindowForLayout', () => {
  test('brings the already-open window rendering a layout to the front', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const child = makeFakeChildWindow();
    const openCapture = mockWindowOpen(child);
    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;
    const { layoutKey } = windowsStore().auxWindows[auxWindowId];

    expect(windowsStore().focusAuxWindowForLayout(layoutKey)).toBe(true);
    expect(child.focus).toHaveBeenCalledTimes(1);
    // Focusing never opens another window.
    expect(openCapture.calls).toHaveLength(1);
  });

  test('refuses unknown layouts, merging records, and closed windows', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    const child = makeFakeChildWindow();
    mockWindowOpen(child);
    const auxWindowId = windowsStore().popOutGroup(key, 'group-b');
    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;
    const record = windowsStore().auxWindows[auxWindowId];

    expect(windowsStore().focusAuxWindowForLayout(key)).toBe(false);
    expect(windowsStore().focusAuxWindowForLayout(`${key}#aux:missing`)).toBe(
      false,
    );

    usePanelWindowsStore.setState({
      auxWindows: { [auxWindowId]: { ...record, status: 'merging' } },
    });
    expect(windowsStore().focusAuxWindowForLayout(record.layoutKey)).toBe(
      false,
    );

    usePanelWindowsStore.setState({ auxWindows: { [auxWindowId]: record } });
    child.closed = true;
    expect(windowsStore().focusAuxWindowForLayout(record.layoutKey)).toBe(
      false,
    );
    expect(child.focus).not.toHaveBeenCalled();
  });

  test('pops a pipeline run tab out like any React-rendered panel', () => {
    const key = nextKey();
    layoutStore().initializeLayout(key, TWO_GROUPS);
    expect(
      layoutStore().addTab(key, 'group-a', 'pipeline-execution', {
        panelId: 'panel-pipeline-run-1',
        instance: { executionId: 'run-1' },
      }),
    ).toBe('panel-pipeline-run-1');
    mockWindowOpen(makeFakeChildWindow());

    const auxWindowId = windowsStore().popOutPanel(
      key,
      'group-a',
      'panel-pipeline-run-1',
    );

    expect(auxWindowId).not.toBeNull();
    if (auxWindowId === null) return;
    const { layoutKey } = windowsStore().auxWindows[auxWindowId];
    expect(
      getPanelLayoutViewModel(layoutKey)?.groups.flatMap((group) =>
        group.tabs.map((tab) => tab.panelId),
      ),
    ).toEqual(['panel-pipeline-run-1']);
  });
});

describe('getAuxWindowSourceLabel', () => {
  const projects: SidebarItem[] = [
    {
      type: 'single-repo',
      id: 'proj-1',
      name: 'Canopy',
      repoPath: '/repo',
      color: '#aabbcc',
      collapsed: false,
      order: 0,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/panels',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'wt-2',
          branchName: 'fix/thing',
          createdAt: '2026-07-01T00:00:00.000Z',
          label: 'My renamed worktree',
        },
      ],
    },
  ];

  test('prefixes the project name and uses the branch name by default', () => {
    expect(getAuxWindowSourceLabel('proj-1/wt-1', projects)).toBe(
      'Canopy · feature/panels',
    );
  });

  test('prefers the user-set worktree label over the branch name', () => {
    expect(getAuxWindowSourceLabel('proj-1/wt-2', projects)).toBe(
      'Canopy · My renamed worktree',
    );
  });

  test('falls back to the worktree id inside a known project', () => {
    expect(getAuxWindowSourceLabel('proj-1/wt-gone', projects)).toBe(
      'Canopy · wt-gone',
    );
  });

  test('degrades to raw ids for unknown projects and malformed keys', () => {
    expect(getAuxWindowSourceLabel('other/wt-1', projects)).toBe('wt-1');
    expect(getAuxWindowSourceLabel('no-separator', projects)).toBe(
      'no-separator',
    );
    expect(getAuxWindowSourceLabel('', projects)).toBe('');
  });
});
