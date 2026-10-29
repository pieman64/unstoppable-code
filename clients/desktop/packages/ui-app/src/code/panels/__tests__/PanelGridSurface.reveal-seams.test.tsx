/** @jest-environment jsdom */

/**
 * Locks the shared surface's REVEAL-GESTURE host seams, which desktop hangs
 * terminal auto-start off.
 *
 * Two contracts:
 *  - `onExpandGroup` fires only when a gesture actually reveals a collapsed
 *    group — the expand branch of `onCollapseGroup`, and "Full screen" on a
 *    collapsed group (which expands it in the same transaction). It must NOT
 *    fire on collapse, nor on maximizing an already-visible group.
 *  - `onSelectTab` and `onExpandGroupToTab` keep firing `onSelectPanel` with
 *    the revealed panel id. That is the existing seam tab-select auto-start
 *    rides on, so it is locked here rather than left implicit.
 *
 * The real `PanelGridHost` is mocked out: this asserts on the
 * `PanelIntentCallbacks` object the surface builds, not on grid rendering.
 */
import type { PanelGridHost } from '@canopy/ui-shared/components/panels';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PanelIntentCallbacks,
  PanelTabModel,
} from '@canopy/ui-shared/panels';

const capturedCallbacks: PanelIntentCallbacks[] = [];
const capturedHosts: Parameters<typeof PanelGridHost>[0][] = [];

jest.mock('@canopy/ui-shared/components/panels', () => ({
  ...jest.requireActual<object>('@canopy/ui-shared/components/panels'),
  PanelGridHost: (props: Parameters<typeof PanelGridHost>[0]): JSX.Element => {
    capturedHosts.push(props);
    capturedCallbacks.push(props.callbacks);
    return <div data-testid="mock-panel-grid-host" />;
  },
}));

import {
  PanelGridSurface,
  type PanelGridSurfaceServices,
} from '../PanelGridSurface';
import { DEFAULT_PANEL_HOST_STATE } from '../panel-contexts';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '../panel-layout-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project';
const CHAT_GROUP = 'group-chat';
const TERMINAL_GROUP = 'group-terminal';

/**
 * Two groups: collapse and maximize both require more than one leaf view, so
 * a single-group layout cannot exercise either gesture.
 */
const TWO_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'vertical',
  groups: [
    {
      kind: 'chat',
      groupId: CHAT_GROUP,
      panelId: 'panel-chat',
      instance: { chatTabId: 'chat-a' },
    },
    {
      kind: 'terminal',
      groupId: TERMINAL_GROUP,
      panelId: 'panel-terminal',
    },
  ],
  containerSize: { width: 800, height: 600 },
};

let keyCounter = 0;
let roots: Root[] = [];

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function noop(): void {}

function makeServices(
  overrides: Partial<PanelGridSurfaceServices>,
): PanelGridSurfaceServices {
  return {
    renderPanelContent: (): null => null,
    renderTabIcon: (): null => null,
    renderCollapsedTabIcon: (): null => null,
    renderTabLabel: (tab: PanelTabModel): string => tab.panelId,
    getTabTitle: (tab: PanelTabModel): string => tab.panelId,
    renderTabTooltip: (): null => null,
    renderTabTrailing: (): null => null,
    ensureLayout: (): Promise<void> => Promise.resolve(),
    activateBoundBrowserPanel: noop,
    onBrowserViewBoundsInvalidated: noop,
    onPopOutGroup: noop,
    onCloseTab: noop,
    onCloseTabs: noop,
    renderAddTabMenu: (): null => null,
    ...overrides,
  };
}

/**
 * Mounts the surface against a freshly seeded two-group layout and returns
 * the intent callbacks it handed the grid host, plus that layout's key.
 */
function mountSurface(overrides: Partial<PanelGridSurfaceServices>): {
  callbacks: PanelIntentCallbacks;
  key: string;
} {
  keyCounter += 1;
  const worktreeId = `reveal-seams-${keyCounter}`;
  const key = makeWorktreePanelKey(PROJECT_ID, worktreeId);
  store().initializeLayout(key, TWO_GROUPS);

  capturedCallbacks.length = 0;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <PanelGridSurface
        projectId={PROJECT_ID}
        worktreeId={worktreeId}
        hostState={DEFAULT_PANEL_HOST_STATE}
        services={makeServices(overrides)}
      />,
    );
  });

  const callbacks = capturedCallbacks.at(-1);
  if (callbacks === undefined) {
    throw new Error('PanelGridHost never received intent callbacks');
  }
  return { callbacks, key };
}

function isCollapsed(key: string, groupId: string): boolean {
  return store().layouts[key]?.groups[groupId]?.collapsed !== undefined;
}

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots = [];
  jest.clearAllMocks();
});

describe('PanelGridSurface onExpandGroup reveal seam', () => {
  it('fires on the expand branch of onCollapseGroup', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(true);
    onExpandGroup.mockClear();

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, false);
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
    expect(onExpandGroup).toHaveBeenCalledTimes(1);
    expect(onExpandGroup).toHaveBeenCalledWith(
      key,
      TERMINAL_GROUP,
      'panel-terminal',
    );
  });

  it('does not fire on the collapse branch of onCollapseGroup', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(true);
    expect(onExpandGroup).not.toHaveBeenCalled();
  });

  it('fires when maximizing a collapsed group, which expands it', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    onExpandGroup.mockClear();

    act(() => {
      callbacks.onMaximizeGroup(TERMINAL_GROUP, true);
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
    expect(onExpandGroup).toHaveBeenCalledTimes(1);
    expect(onExpandGroup).toHaveBeenCalledWith(
      key,
      TERMINAL_GROUP,
      'panel-terminal',
    );
  });

  it('does not fire when maximizing an already-visible group', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);

    act(() => {
      callbacks.onMaximizeGroup(TERMINAL_GROUP, true);
    });
    act(() => {
      callbacks.onMaximizeGroup(TERMINAL_GROUP, false);
    });

    expect(onExpandGroup).not.toHaveBeenCalled();
  });

  // A tab drop on a collapsed branch bar expands the target group through
  // this same callback (`PanelBranchCollapsedBar`'s `onDrop`), but the drop is
  // the gesture: the dropped tab becomes active, so nothing the group already
  // held was revealed. Firing the seam there queued a reveal side effect for a
  // panel that never becomes active — and therefore never claims it — leaving
  // it to fire on a later PASSIVE activation (CAN-2309).
  it('does not fire for the incidental expand of a tab drop', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    onExpandGroup.mockClear();

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, false, { gesture: 'move' });
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
    expect(onExpandGroup).not.toHaveBeenCalled();
  });

  it('treats an explicit reveal gesture option the same as the default', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    onExpandGroup.mockClear();

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, false, { gesture: 'reveal' });
    });

    expect(onExpandGroup).toHaveBeenCalledWith(
      key,
      TERMINAL_GROUP,
      'panel-terminal',
    );
  });

  // Symmetry with the maximize case above: expanding a group that is already
  // visible reveals nothing, so it is not a reveal gesture. Unreachable from
  // the chrome today (every expand affordance renders only for a collapsed
  // group), which is exactly why the intent needs pinning — otherwise the
  // next reader sees a no-op branch and deletes it.
  it('does not fire when expanding an already-visible group', () => {
    const onExpandGroup = jest.fn();
    const { callbacks, key } = mountSurface({ onExpandGroup });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, false);
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
    expect(onExpandGroup).not.toHaveBeenCalled();
  });

  it('is optional — omitting it leaves expand working', () => {
    const { callbacks, key } = mountSurface({});

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, false);
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
  });
});

describe('PanelGridSurface onSelectPanel reveal seam', () => {
  it('fires for an explicit tab selection', () => {
    const onSelectPanel = jest.fn();
    const { callbacks, key } = mountSurface({ onSelectPanel });

    act(() => {
      callbacks.onSelectTab(TERMINAL_GROUP, 'panel-terminal');
    });

    expect(onSelectPanel).toHaveBeenCalledWith(
      key,
      TERMINAL_GROUP,
      'panel-terminal',
    );
  });

  it('fires for expand-to-tab with the revealed panel id', () => {
    const onSelectPanel = jest.fn();
    const { callbacks, key } = mountSurface({ onSelectPanel });

    act(() => {
      callbacks.onCollapseGroup?.(TERMINAL_GROUP, true);
    });
    onSelectPanel.mockClear();

    act(() => {
      callbacks.onExpandGroupToTab?.(TERMINAL_GROUP, 'panel-terminal');
    });

    expect(isCollapsed(key, TERMINAL_GROUP)).toBe(false);
    expect(onSelectPanel).toHaveBeenCalledWith(
      key,
      TERMINAL_GROUP,
      'panel-terminal',
    );
  });
});

it('passes host tab intent through without changing its identity', () => {
  const onTabIntent = jest.fn();
  mountSurface({ onTabIntent });
  expect(capturedHosts.at(-1)?.onTabIntent).toBe(onTabIntent);
});
