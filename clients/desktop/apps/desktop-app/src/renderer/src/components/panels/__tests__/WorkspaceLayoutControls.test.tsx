/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceLayoutControls } from '../WorkspaceLayoutControls';
import {
  makeWorktreePanelKey,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { consumePendingTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { DEFAULT_TERMINAL_GROUP_ID } from '@/lib/panels/panel-group-ids';

import { setWorkspacePanelLayoutMode } from '@/lib/panels/workspace-layout-mode-actions';
import type * as LayoutModeActions from '@/lib/panels/workspace-layout-mode-actions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

jest.mock('@/stores/panelWindowsStore', () => ({
  usePanelWindowsStore: {
    getState: (): {
      auxWindows: Record<string, never>;
      disposeWorktreeAuxWindows: jest.Mock;
      focusAuxWindowForLayout: () => boolean;
    } => ({
      auxWindows: {},
      disposeWorktreeAuxWindows: jest.fn(),
      // No auxiliary windows exist, so there is never one to focus.
      focusAuxWindowForLayout: (): boolean => false,
    }),
  },
}));

jest.mock('@/lib/panels/default-layout-save', () => ({
  saveCurrentLayoutAsDefault: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/panels/workspace-layout-mode-actions', () => ({
  ...jest.requireActual<typeof LayoutModeActions>(
    '@/lib/panels/workspace-layout-mode-actions',
  ),
  setWorkspacePanelLayoutMode: jest.fn(),
}));
const mockSetWorkspacePanelLayoutMode = jest.mocked(
  setWorkspacePanelLayoutMode,
);

const PROJECT_ID = 'project-layout-controls';
const WORKTREE_ID = 'worktree-layout-controls';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

describe('WorkspaceLayoutControls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({}),
        onPreferencesSynced: jest.fn(() => jest.fn()),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: {
          mode: 'minimal',
          status: 'ready',
          requestId: 1,
        },
      },
    });
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'vertical',
      groups: [
        { groupId: 'group-chat', panelId: 'chat', kind: 'chat' },
        {
          groupId: 'group-extras',
          panelId: 'activity',
          kind: 'activity-section',
        },
        { groupId: 'group-terminal', panelId: 'terminal', kind: 'terminal' },
      ],
    });
    setPanelLayoutFixedTopology(KEY, true);
    expect(
      usePanelLayoutStore.getState().collapseGroup(KEY, 'group-terminal'),
    ).toBe(true);
  });

  afterEach(() => {
    // Drain anything a toggle queued so it cannot leak into a sibling test.
    while (
      consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID, KEY, 'terminal') !==
      null
    ) {
      /* drain */
    }
    act(() => root.unmount());
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
    container.remove();
    setPanelLayoutFixedTopology(KEY, false);
    usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
    useWorkspaceLayoutModeStore.setState({ entries: {} });
    setTestEarlyAccessFeatures({ enabled: false });
    mockSetWorkspacePanelLayoutMode.mockReset();
  });

  test('top-bar Bottom Drawer toggle expands a collapsed terminal group', () => {
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-layout-terminal-toggle"]',
    );
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());

    expect(
      usePanelLayoutStore.getState().layouts[KEY]?.groups['group-terminal']
        ?.collapsed,
    ).toBeUndefined();
  });

  test('a toggle action follows its displayed expansion state during terminal sync', () => {
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-layout-terminal-toggle"]',
    );
    expect(toggle?.getAttribute('aria-label')).toBe('Toggle bottom drawer');

    act(() => {
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-terminal');
      toggle?.click();
    });

    expect(
      usePanelLayoutStore.getState().layouts[KEY]?.groups['group-terminal']
        ?.collapsed,
    ).toBeUndefined();
  });

  // The minimal-mode Bottom Drawer toggle is the most-used reveal gesture of
  // the set, and it does NOT route through the shared surface's
  // `onExpandGroup` seam — it drives the store directly, so it needs its own
  // coverage that the auto-start request is queued for the revealed panel.
  test('Bottom Drawer expand queues a targeted spawn for the unbound terminal', () => {
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-layout-terminal-toggle"]',
        )
        ?.click(),
    );

    expect(
      consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID, KEY, 'terminal'),
    ).toEqual(
      expect.objectContaining({
        layoutKey: KEY,
        panelId: 'terminal',
        mode: 'ensure',
      }),
    );
  });

  test('Bottom Drawer collapse queues nothing', () => {
    usePanelLayoutStore.getState().expandGroup(KEY, 'group-terminal');
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-layout-terminal-toggle"]',
        )
        ?.click(),
    );

    expect(
      usePanelLayoutStore.getState().layouts[KEY]?.groups['group-terminal']
        ?.collapsed,
    ).toBeDefined();
    expect(
      consumePendingTerminalSpawn(PROJECT_ID, WORKTREE_ID, KEY, 'terminal'),
    ).toBeNull();
  });

  // `toggleTerminal`'s OTHER branch: with no terminal tab at all it bypasses
  // `setGroupCollapsed` entirely and issues the request itself. That request
  // must be targeted and stamped like every other panel-shaped gesture — an
  // untargeted one is claimable by any terminal surface in the layout and is
  // retained forever, so one left unclaimed fires on a later PASSIVE
  // activation (CAN-2309).
  test('the no-tab fallback queues a targeted, expiring spawn', () => {
    // Re-seed without a terminal tab so `terminalHasTab` is false.
    usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'vertical',
      groups: [
        { groupId: 'group-chat', panelId: 'chat', kind: 'chat' },
        {
          groupId: DEFAULT_TERMINAL_GROUP_ID,
          panelId: 'activity',
          kind: 'activity-section',
        },
      ],
    });

    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-layout-terminal-toggle"]',
        )
        ?.click(),
    );

    const layout = usePanelLayoutStore.getState().layouts[KEY];
    const created = Object.values(layout?.groups ?? {})
      .flatMap((group) => group.tabs ?? [])
      .find((tab) => tab.kind === 'terminal');
    expect(created).toBeDefined();

    const request = consumePendingTerminalSpawn(
      PROJECT_ID,
      WORKTREE_ID,
      KEY,
      created?.panelId,
    );
    expect(request).not.toBeNull();
    expect(request?.panelId).toBe(created?.panelId);
    expect(typeof request?.requestedAt).toBe('number');
  });

  function renderPanelToggles(): {
    side: HTMLButtonElement | null;
    bottom: HTMLButtonElement | null;
  } {
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
    return {
      side: container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-layout-side-panel-toggle"]',
      ),
      bottom: container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-layout-terminal-toggle"]',
      ),
    };
  }

  test('early access presses and highlights the toggles of visible panels', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    const { side, bottom } = renderPanelToggles();

    // Side Panel is open, Bottom Drawer is collapsed.
    expect(side?.getAttribute('aria-pressed')).toBe('true');
    expect(bottom?.getAttribute('aria-pressed')).toBe('false');
    expect(
      side
        ?.closest('[data-highlight-pressed]')
        ?.getAttribute('data-highlight-pressed'),
    ).toBe('true');

    act(() => bottom?.click());
    expect(bottom?.getAttribute('aria-pressed')).toBe('true');
    act(() => side?.click());
    expect(side?.getAttribute('aria-pressed')).toBe('false');
    // The inset layout pulls the controls 1px toward the window edge.
    expect(container.firstElementChild?.classList.contains('-mr-px')).toBe(
      true,
    );
  });

  test('early access names each toggle for its panel, not the next action', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    const { side, bottom } = renderPanelToggles();

    expect(side?.getAttribute('aria-label')).toBe('Toggle side panel');
    expect(bottom?.getAttribute('aria-label')).toBe('Toggle bottom drawer');
    act(() => side?.click());
    act(() => bottom?.click());
    expect(side?.getAttribute('aria-label')).toBe('Toggle side panel');
    expect(bottom?.getAttribute('aria-label')).toBe('Toggle bottom drawer');
  });

  test('highlights visible panels without a Labs opt-in', () => {
    const { side, bottom } = renderPanelToggles();

    expect(side?.getAttribute('aria-pressed')).toBe('true');
    expect(bottom?.getAttribute('aria-pressed')).toBe('false');
    expect(
      side
        ?.closest('[data-highlight-pressed]')
        ?.getAttribute('data-highlight-pressed'),
    ).toBe('true');
    expect(side?.getAttribute('aria-label')).toBe('Toggle side panel');
    expect(bottom?.getAttribute('aria-label')).toBe('Toggle bottom drawer');
    expect(container.firstElementChild?.classList.contains('-mr-px')).toBe(
      true,
    );
  });

  test('puts the Side Panel toggle after the terminal without a Labs opt-in', () => {
    const { side, bottom } = renderPanelToggles();

    expect(side).not.toBeNull();
    expect(bottom).not.toBeNull();
    if (side === null || bottom === null) return;
    expect(
      bottom.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('early access puts the Side Panel toggle after the terminal toggle', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    const { side, bottom } = renderPanelToggles();

    expect(side).not.toBeNull();
    expect(bottom).not.toBeNull();
    if (side === null || bottom === null) return;
    expect(
      bottom.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  async function pickModeFromMenu(mode: 'minimal' | 'advanced'): Promise<void> {
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="worktree-top-save-layout-default"]',
        )
        ?.click(),
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-testid="workspace-layout-mode-${mode}"]`,
        )
        ?.click();
      await Promise.resolve();
    });
  }

  test('early access: the mode picked in the menu becomes the default for new worktrees', async () => {
    setTestEarlyAccessFeatures({ enabled: true });
    mockSetWorkspacePanelLayoutMode.mockResolvedValue(true);
    const savePreferences = jest.fn().mockResolvedValue({});
    Object.assign(window.api, { savePreferences });

    await pickModeFromMenu('advanced');

    expect(mockSetWorkspacePanelLayoutMode).toHaveBeenCalledWith(
      KEY,
      'advanced',
    );
    expect(savePreferences).toHaveBeenCalledWith({
      workspaceDefaultLayoutMode: 'advanced',
    });
  });

  test('early access: a failed switch leaves the default for new worktrees alone', async () => {
    setTestEarlyAccessFeatures({ enabled: true });
    mockSetWorkspacePanelLayoutMode.mockResolvedValue(false);
    const savePreferences = jest.fn().mockResolvedValue({});
    Object.assign(window.api, { savePreferences });

    await pickModeFromMenu('advanced');

    expect(mockSetWorkspacePanelLayoutMode).toHaveBeenCalled();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  test('remembers an explicitly selected workspace mode without a Labs opt-in', async () => {
    mockSetWorkspacePanelLayoutMode.mockResolvedValue(true);
    const savePreferences = jest.fn().mockResolvedValue({});
    Object.assign(window.api, { savePreferences });

    await pickModeFromMenu('advanced');

    expect(mockSetWorkspacePanelLayoutMode).toHaveBeenCalled();
    expect(savePreferences).toHaveBeenCalledWith({
      workspaceDefaultLayoutMode: 'advanced',
    });
  });

  test('saving the default layout closes the menu and returns focus to its trigger', () => {
    // Save is an Advanced-only action.
    useWorkspaceLayoutModeStore.setState({
      entries: { [KEY]: { mode: 'advanced', status: 'ready', requestId: 1 } },
    });
    act(() => {
      root.render(
        <WorkspaceLayoutControls
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-top-save-layout-default"]',
    );
    act(() => trigger?.click());
    const save = document.querySelector<HTMLButtonElement>(
      '[data-testid="save-layout-default-item"]',
    );
    expect(save).not.toBeNull();
    save?.focus();
    act(() => save?.click());

    expect(
      document.querySelector('[data-testid="save-layout-default-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('does not re-render for shallow-equivalent mode and layout entries', () => {
    const onRender = jest.fn();
    act(() => {
      root.render(
        <Profiler id="workspace-layout-controls" onRender={onRender}>
          <WorkspaceLayoutControls
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
          />
        </Profiler>,
      );
    });
    const initialRenderCount = onRender.mock.calls.length;

    act(() => {
      useWorkspaceLayoutModeStore.setState((state) => ({
        entries: {
          ...state.entries,
          [KEY]: { ...state.entries[KEY] },
        },
      }));
      usePanelLayoutStore.setState((state) => ({
        layouts: {
          ...state.layouts,
          [KEY]: { ...state.layouts[KEY] },
        },
      }));
    });

    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
  });
});
