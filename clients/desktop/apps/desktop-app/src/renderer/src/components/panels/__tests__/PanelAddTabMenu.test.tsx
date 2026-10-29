/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

/**
 * PanelAddTabMenu — exercises the desktop add-panel menu against the REAL
 * chat and panel layout stores (chat-panel-sync.test.ts posture): the
 * leading "New chat" entry, its target-group panel placement, and the
 * viewport clamp applied after the open-time measurement.
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelKind } from '@canopy/protocol';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';

import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useBrowserStore } from '@/stores/browserStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { PanelAddTabMenu } from '../PanelAddTabMenu';
import { listAddablePanels } from '@/lib/panels/registry';
import { __resetTerminalShellProfilesForTests } from '@/lib/terminalShellProfiles';
import * as terminalFocusIntent from '@/lib/terminal-focus-intent';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { ipcTerminalClient } from '@/client/ipc-terminal-client';
import type * as PlanPanelOpenModule from '@/lib/panels/plan-panel-open';
import { openPlanPanel } from '@/lib/panels/plan-panel-open';
import type * as SubagentPanelOpenModule from '@/lib/panels/subagent-panel-open';
import { openSubagentsPanel } from '@/lib/panels/subagent-panel-open';
import {
  READ_WRITE_WORKSPACE_ACCESS,
  WorkspaceAccessContext,
  type WorkspaceAccess,
} from '@/lib/workspace-access';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

// The Plans submenu delegates open/reveal to openPlanPanel (covered by
// plan-panel-open.test.ts); here it only has to receive the right intent.
jest.mock('@/lib/panels/plan-panel-open', () => ({
  ...jest.requireActual<typeof PlanPanelOpenModule>(
    '@/lib/panels/plan-panel-open',
  ),
  openPlanPanel: jest.fn(),
}));

// Selecting Subagents delegates open/reveal to the panel opener; this suite
// verifies that the menu supplies the owner and exact group intent.
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  ...jest.requireActual<typeof SubagentPanelOpenModule>(
    '@/lib/panels/subagent-panel-open',
  ),
  openSubagentsPanel: jest.fn(),
}));

// Isolate the registry import graph (pulled in via listAddablePanels) from
// the heavy real components — same stub set as registry.test.tsx.
jest.mock('@/components/chat/WorktreeChatSurface', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    WorktreeChatSurface: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-chat-surface' }),
    ),
  };
});
jest.mock('@/components/chat/DesktopSharedFileViewer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    DesktopSharedFileViewer: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-file-viewer-panel' }),
    ),
  };
});
jest.mock('@/components/terminal/TerminalPanelSurface', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    TerminalPanelSurface: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-terminal-surface' }),
    ),
  };
});
jest.mock('@/components/activity/SharedActivityPanelAdapter', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    SharedActivityPanelAdapter: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-activity-panel' }),
    ),
  };
});
jest.mock('@/components/activity/activity-sections', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  const sections = [
    {
      id: 'summary',
      title: 'Summary',
      surfaces: ['worktree'],
      icon: react.createElement('svg', {
        'data-testid': 'mock-section-summary-icon',
      }),
      render: jest.fn((): unknown =>
        react.createElement('div', { 'data-testid': 'mock-section-summary' }),
      ),
    },
    {
      id: 'memory',
      title: 'Memory',
      icon: react.createElement('svg'),
      render: jest.fn((): null => null),
    },
    {
      id: 'notes',
      title: 'Notes',
      icon: react.createElement('svg', {
        'data-testid': 'mock-section-notes-icon',
      }),
      render: jest.fn((): unknown =>
        react.createElement('div', { 'data-testid': 'mock-section-notes' }),
      ),
    },
    {
      // Code-only, like the real Plans section (never offered in Cowork).
      id: 'plans',
      title: 'Plans',
      surfaces: ['worktree'],
      icon: react.createElement('svg', {
        'data-testid': 'mock-section-plans-icon',
      }),
      render: jest.fn((): unknown =>
        react.createElement('div', { 'data-testid': 'mock-section-plans' }),
      ),
    },
    {
      id: 'background-processes',
      title: 'Agent background processes',
      render: jest.fn((): unknown =>
        react.createElement('div', {
          'data-testid': 'mock-section-background-processes',
        }),
      ),
    },
  ];
  return {
    ACTIVITY_SECTIONS: sections,
    getActivitySectionDefinition: (sectionId: string): unknown =>
      sections.find((section) => section.id === sectionId),
    getActivitySectionsForSurface: (surface: string): unknown[] =>
      sections.filter(
        (section) =>
          section.surfaces === undefined || section.surfaces.includes(surface),
      ),
  };
});
jest.mock('@/components/activity/FilesTreeTab', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    FilesTreeTab: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-files-tree-tab' }),
    ),
  };
});
jest.mock('@/components/browser/BrowserPanelSurface', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    BrowserPanelSurface: jest.fn((): unknown =>
      react.createElement('div', {
        'data-testid': 'mock-browser-panel-surface',
      }),
    ),
  };
});
jest.mock('@/components/panels/usage/UsagePanel', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    UsagePanel: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-usage-panel' }),
    ),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const COWORK_WORKSPACE_ID = 'cowork-workspace-1';
const COWORK_ENTRY_ID = 'entry-1';
const COWORK_KEY = `${COWORK_WORKSPACE_ID}/${COWORK_ENTRY_ID}`;
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');

const openPlanPanelMock = jest.mocked(openPlanPanel);
const openSubagentsPanelMock = jest.mocked(openSubagentsPanel);

function makePlan(
  id: string,
  title: string,
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return {
    id,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title,
    content: `# ${title}`,
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

const originalCreateTab = useChatStore.getState().createTab;

function makeChatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat One',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

/** Fake createTab: appends a fresh chat tab and makes it active (the exact
 * semantics the menu's New Chat handler relies on), without the real
 * action's IPC/persistence baggage. */
const createTabMock = jest.fn(
  (target?: { projectId: string; worktreeId: string }): void => {
    if (!target) return;
    const key = `${target.projectId}/${target.worktreeId}`;
    useChatStore.setState((state) => {
      const wc = state.worktreeChats[key] ?? { tabs: [], activeTabId: '' };
      const tab = makeChatTab({ id: 'chat-new', title: 'New Chat' });
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { tabs: [...wc.tabs, tab], activeTabId: tab.id },
        },
      };
    });
  },
);

const TWO_GROUP_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
  ],
  containerSize: { width: 1200, height: 800 },
};

describe('PanelAddTabMenu', () => {
  let container: HTMLDivElement;
  let root: Root;
  let disposeTerminalClient: (() => void) | undefined;
  const onSelect = jest.fn();
  const onClose = jest.fn();

  beforeEach(() => {
    disposeTerminalClient = bindTerminalClient(ipcTerminalClient);
    __resetTerminalShellProfilesForTests();
    terminalFocusIntent.__resetTerminalFocusIntentForTests();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      createTab: createTabMock,
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [KEY]: { tabs: [makeChatTab()], activeTabId: 'chat-1' },
      },
    });
    usePanelLayoutStore.getState().initializeLayout(KEY, TWO_GROUP_LAYOUT);
    openSubagentsPanelMock.mockResolvedValue({ status: 'failed' });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    disposeTerminalClient?.();
    const panelState = usePanelLayoutStore.getState();
    for (const key of Object.keys(panelState.layouts)) {
      panelState.disposeLayout(key);
    }
    useChatStore.setState({
      createTab: originalCreateTab,
      selectedWorktree: null,
      worktreeChats: {},
    });
    registerCoworkWorkspaceIds([]);
    useWorkspaceLayoutModeStore.setState({ entries: {} });
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    setTestEarlyAccessFeatures({ enabled: false });
    openPlanPanelMock.mockReset();
    openSubagentsPanelMock.mockReset();
    createTabMock.mockClear();
    onSelect.mockClear();
    onClose.mockClear();
  });

  function render(
    groupId = 'group-terminal',
    worktreeKey = KEY,
    excludeKinds?: readonly PanelKind[],
    access: WorkspaceAccess = READ_WRITE_WORKSPACE_ACCESS,
  ): void {
    act(() => {
      root.render(
        <WorkspaceAccessContext.Provider value={access}>
          <div className="canopy-panel-add-tab-root">
            <button type="button" data-testid="panel-add-test-trigger">
              Add
            </button>
            <PanelAddTabMenu
              groupId={groupId}
              worktreeKey={worktreeKey}
              onSelect={onSelect}
              onClose={onClose}
              excludeKinds={excludeKinds}
            />
          </div>
        </WorkspaceAccessContext.Provider>,
      );
    });
  }

  /** Usage is a submenu row: open its flyout before asserting its entries. */
  function openUsageSubmenu(): void {
    const trigger = menuElement().querySelector(
      '[data-testid="panel-add-menu-usage-submenu"]',
    );
    if (!(trigger instanceof HTMLElement)) {
      throw new Error('usage submenu trigger not rendered');
    }
    act(() => {
      trigger.click();
    });
  }

  function openTerminalSubmenu(): void {
    const trigger = menuElement().querySelector(
      '[data-testid="panel-add-menu-terminal-submenu"]',
    );
    if (!(trigger instanceof HTMLElement)) {
      throw new Error('terminal submenu trigger not rendered');
    }
    act(() => {
      trigger.click();
    });
  }

  /** Automations mirrors Usage: open its flyout before asserting entries. */
  function openAutomationsSubmenu(): void {
    const trigger = menuElement().querySelector(
      '[data-testid="panel-add-menu-automations-submenu"]',
    );
    if (!(trigger instanceof HTMLElement)) {
      throw new Error('automations submenu trigger not rendered');
    }
    act(() => {
      trigger.click();
    });
  }

  function menuElement(): HTMLElement {
    // The menu portals into `document.body` (escaping the grid leaf's
    // clipping/stacking context), so query the document, not the container.
    const menu = document.querySelector('[data-testid="panel-add-menu"]');
    if (!(menu instanceof HTMLElement)) {
      throw new Error('menu not rendered');
    }
    return menu;
  }

  it('renders the New Chat entry as the first menu item', () => {
    render();
    const items = menuElement().querySelectorAll('[role="menuitem"]');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('data-testid')).toBe(
      'panel-add-menu-item-new-chat',
    );
  });

  it('opens Subagents in the menu group through its worktree opener', () => {
    render();
    const subagentsRow = menuElement().querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-subagents"]',
    );
    expect(subagentsRow).not.toBeNull();

    act(() => {
      subagentsRow?.click();
    });

    expect(openSubagentsPanelMock).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      { intent: { groupId: 'group-terminal', layoutKey: KEY } },
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the owner worktree and auxiliary layout for a popped-out menu', () => {
    usePanelLayoutStore.getState().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'group-aux-terminal',
          panelId: 'panel-aux-terminal',
        },
      ],
      containerSize: { width: 900, height: 600 },
    });
    render('group-aux-terminal', AUX_KEY);
    const subagentsRow = menuElement().querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-subagents"]',
    );

    act(() => {
      subagentsRow?.click();
    });

    expect(openSubagentsPanelMock).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      { intent: { groupId: 'group-aux-terminal', layoutKey: AUX_KEY } },
    );
  });

  it('keeps the complete add-panel catalog available in Minimal', () => {
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: {
          mode: 'minimal',
          status: 'ready',
          requestId: 1,
        },
      },
    });

    render();

    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-new-chat"]',
      ),
    ).not.toBeNull();
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-browser"]',
      ),
    ).not.toBeNull();
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-terminal-submenu"]',
      ),
    ).not.toBeNull();
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-usage-submenu"]',
      ),
    ).not.toBeNull();
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-automations-submenu"]',
      ),
    ).not.toBeNull();
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-activity-group"]',
      ),
    ).not.toBeNull();
  });

  it('never offers a pipeline run row, with or without an open run panel', () => {
    function expectNoPipelineRunRow(): void {
      expect(
        document.querySelector(
          '[data-testid^="panel-add-menu-item-pipeline-execution"]',
        ),
      ).toBeNull();
      const labels = Array.from(
        menuElement().querySelectorAll('[role="menuitem"]'),
        (item) => item.textContent?.trim() ?? '',
      );
      expect(labels).not.toContain('Pipeline run');
    }

    // `singleton: false` keeps the kind out of the catalog itself, not just
    // out of this menu's rendering.
    expect(
      listAddablePanels(KEY, true).map((entry) => entry.kind),
    ).not.toContain('pipeline-execution');
    render();
    openUsageSubmenu();
    openAutomationsSubmenu();
    expectNoPipelineRunRow();

    act(() => {
      root.render(<></>);
    });
    expect(
      usePanelLayoutStore
        .getState()
        .addTab(KEY, 'group-terminal', 'pipeline-execution', {
          instance: { executionId: 'run-1' },
        }),
    ).not.toBeNull();
    expect(
      listAddablePanels(KEY, true).map((entry) => entry.kind),
    ).not.toContain('pipeline-execution');
    render();
    expectNoPipelineRunRow();
  });

  it('offers detected terminal profiles once and badges the default shell', async () => {
    const previousApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({
          disabledTerminalShellProfileIds: [],
          terminalPresets: [],
        }),
        terminal: {
          listProfiles: jest.fn().mockResolvedValue([
            { id: 'default', label: 'zsh', isDefault: true },
            { id: 'bash', label: 'bash', isDefault: false },
          ]),
        },
      },
    });
    try {
      await act(async () => {
        render();
        await Promise.resolve();
      });
      openTerminalSubmenu();
      const terminalRows = Array.from(
        document.querySelectorAll(
          '[role="menuitem"][data-testid^="panel-add-menu-item-terminal"]',
        ),
      );
      expect(terminalRows.map((row) => row.textContent)).toEqual([
        'zshDefault',
        'bash',
      ]);
      expect(
        document.querySelectorAll(
          '[data-testid="panel-add-menu-item-terminal-default-badge"]',
        ),
      ).toHaveLength(1);
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('passes a preset command into terminal spawn instead of visibly writing it afterward', async () => {
    const previousApi = window.api;
    const session = {
      id: 'terminal-preset',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
    };
    const spawn = jest.fn().mockResolvedValue(session);
    const write = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({
          disabledTerminalShellProfileIds: [],
          terminalPresets: [
            {
              id: 'preset-1',
              name: 'Yolo Codex',
              terminalProfileId: 'default',
              command: 'codex --yolo',
              enabled: true,
            },
          ],
        }),
        terminal: {
          listProfiles: jest
            .fn()
            .mockResolvedValue([
              { id: 'default', label: 'zsh', isDefault: true },
            ]),
          spawn,
          write,
          kill: jest.fn().mockResolvedValue(undefined),
          saveWorktreeState: jest.fn().mockResolvedValue(undefined),
        },
      },
    });
    try {
      await act(async () => {
        render();
        await Promise.resolve();
      });
      openTerminalSubmenu();
      const presetRow = document.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-terminal-preset"]',
      );
      await act(async () => {
        presetRow?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalProfileId: 'default',
          initialCommand: 'codex --yolo',
        }),
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      useTerminalStore
        .getState()
        .removeTerminal(PROJECT_ID, WORKTREE_ID, session.id);
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('shows terminal launch progress only on the selected preset', async () => {
    const previousApi = window.api;
    let resolveSpawn:
      | ((session: {
          id: string;
          projectId: string;
          worktreeId: string;
          shell: string;
          shellBasename: string;
          cwd: string;
          createdAt: number;
        }) => void)
      | undefined;
    const spawn = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({
          disabledTerminalShellProfileIds: [],
          terminalPresets: [
            {
              id: 'preset-copilot',
              name: 'Copilot',
              terminalProfileId: 'zsh',
              command: 'copilot --yolo',
              enabled: true,
            },
            {
              id: 'preset-opencode',
              name: 'OpenCode',
              terminalProfileId: 'zsh',
              command: 'opencode --yolo',
              enabled: true,
            },
          ],
        }),
        terminal: {
          listProfiles: jest
            .fn()
            .mockResolvedValue([{ id: 'zsh', label: 'zsh', isDefault: true }]),
          spawn,
          kill: jest.fn().mockResolvedValue(undefined),
          saveWorktreeState: jest.fn().mockResolvedValue(undefined),
        },
      },
    });

    try {
      await act(async () => {
        render();
        await Promise.resolve();
      });
      openTerminalSubmenu();
      const presetRows = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="panel-add-menu-item-terminal-preset"]',
        ),
      );
      expect(presetRows).toHaveLength(2);

      act(() => {
        presetRows[0]?.click();
      });

      expect(presetRows[0]?.getAttribute('aria-busy')).toBe('true');
      expect(presetRows[1]?.getAttribute('aria-busy')).not.toBe('true');

      await act(async () => {
        resolveSpawn?.({
          id: 'terminal-preset',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('uses only the current color mode image for a themed preset icon', async () => {
    const previousApi = window.api;
    document.documentElement.classList.add('dark');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({
          disabledTerminalShellProfileIds: [],
          terminalPresets: [
            {
              id: 'preset-themed',
              name: 'Custom TUI',
              terminalProfileId: 'zsh',
              command: 'lazygit',
              enabled: true,
              icon: {
                kind: 'image',
                lightDataUrl: 'data:image/png;base64,bGlnaHQ=',
                darkDataUrl: 'data:image/png;base64,ZGFyaw==',
              },
            },
          ],
        }),
        terminal: {
          listProfiles: jest
            .fn()
            .mockResolvedValue([{ id: 'zsh', label: 'zsh', isDefault: true }]),
        },
      },
    });
    try {
      await act(async () => {
        render();
        await Promise.resolve();
      });
      openTerminalSubmenu();
      const icon = document.querySelector<HTMLImageElement>(
        '[data-testid="panel-add-menu-item-terminal-preset-icon"] img',
      );
      expect(icon?.getAttribute('src')).toBe('data:image/png;base64,ZGFyaw==');
      expect(
        document.querySelectorAll(
          '[data-testid="panel-add-menu-item-terminal-preset-icon"] img',
        ),
      ).toHaveLength(1);
    } finally {
      document.documentElement.classList.remove('dark');
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('marks a failed terminal binding before killing and removing it', async () => {
    const previousApi = window.api;
    const order: string[] = [];
    const kill = jest.fn(() => {
      order.push('kill');
      return Promise.resolve(undefined);
    });
    const session = {
      id: 'terminal-new',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
    };
    const mark = jest
      .spyOn(useTerminalActivityStore.getState(), 'markUserInitiatedClose')
      .mockImplementation(() => {
        order.push('mark');
      });
    const remove = jest
      .spyOn(useTerminalStore.getState(), 'removeTerminal')
      .mockImplementation(() => {
        order.push('remove');
      });
    const clearFocusRequest = jest.spyOn(
      terminalFocusIntent,
      'clearTerminalFocusRequest',
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({
          disabledTerminalShellProfileIds: [],
          terminalPresets: [],
        }),
        terminal: {
          listProfiles: jest
            .fn()
            .mockResolvedValue([
              { id: 'default', label: 'zsh', isDefault: true },
            ]),
          spawn: jest.fn().mockResolvedValue(session),
          kill,
        },
      },
    });
    try {
      await act(async () => {
        render('missing-group');
        await Promise.resolve();
      });
      openTerminalSubmenu();
      const terminalRow = document.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-terminal"]',
      );
      await act(async () => {
        terminalRow?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mark).toHaveBeenCalledWith('terminal-new');
      expect(kill).toHaveBeenCalledWith({ terminalId: 'terminal-new' });
      expect(remove).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKTREE_ID,
        'terminal-new',
      );
      expect(order).toEqual(['mark', 'kill', 'remove']);
      expect(clearFocusRequest).toHaveBeenCalledWith('terminal-new');
    } finally {
      mark.mockRestore();
      remove.mockRestore();
      clearFocusRequest.mockRestore();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: previousApi,
      });
    }
  });

  it('New Chat creates a chat tab and places its bound panel in the TARGET group', () => {
    render('group-terminal');
    const newChat = menuElement().querySelector(
      '[data-testid="panel-add-menu-item-new-chat"]',
    );
    expect(newChat).not.toBeNull();

    act(() => {
      if (newChat instanceof HTMLElement) {
        newChat.click();
      }
    });

    expect(createTabMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    // The bound panel landed in the clicked `+` button's group with the
    // deterministic sync-bridge panel id — NOT in the MRU chat group the
    // sync bridge would have picked on its microtask sweep.
    const location = findPanelByInstanceKey(KEY, 'chat:chat-new');
    expect(location).not.toBeNull();
    expect(location?.groupId).toBe('group-terminal');
    expect(location?.panelId).toBe('panel-chat-chat-new');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers chats in every group while early access is off', () => {
    render('group-terminal');
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-new-chat"]',
      ),
    ).not.toBeNull();
  });

  it('early access offers chats only in the main chat group', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    render('group-terminal');
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-new-chat"]',
      ),
    ).toBeNull();
    expect(
      menuElement().querySelector('[data-testid^="panel-add-menu-item-chat"]'),
    ).toBeNull();
    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    render('group-chat');
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-new-chat"]',
      ),
    ).not.toBeNull();
  });

  it('File creates an EMPTY file tab and places its bound panel in the TARGET group', () => {
    render('group-terminal');
    const newFile = menuElement().querySelector(
      '[data-testid="panel-add-menu-item-new-file"]',
    );
    expect(newFile).not.toBeNull();
    expect(newFile?.textContent).toContain('File');
    expect(newFile?.textContent).not.toContain('New File');

    act(() => {
      if (newFile instanceof HTMLElement) {
        newFile.click();
      }
    });

    const wc = useChatStore.getState().worktreeChats[KEY];
    const fileTab = wc.tabs.find((tab) => tab.kind === 'file');
    expect(fileTab).toBeDefined();
    expect(fileTab?.filePath).toBe('');
    expect(fileTab?.title).toBe('Open file');
    expect(wc.activeTabId).toBe(fileTab?.id);

    const location = findPanelByInstanceKey(KEY, `file-diff:${fileTab?.id}`);
    expect(location).not.toBeNull();
    expect(location?.groupId).toBe('group-terminal');
    expect(location?.panelId).toBe(`panel-file-${fileTab?.id}`);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers the five usage variants inside the Usage submenu', () => {
    render();
    const trigger = menuElement().querySelector(
      '[data-testid="panel-add-menu-usage-submenu"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('Usage');
    openUsageSubmenu();

    const group = document.body.querySelector(
      '[data-testid="panel-add-menu-usage-group"]',
    );
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Usage');
    for (const variant of ['all', 'active-chat', 'codex', 'claude', 'cursor']) {
      expect(
        group?.querySelector(
          `[data-testid="panel-add-menu-item-usage-${variant}"]`,
        ),
      ).not.toBeNull();
    }
  });

  it('offers a pinned Cursor usage panel', () => {
    render();
    openUsageSubmenu();
    const cursor = document.body.querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-usage-cursor"]',
    );
    expect(cursor).not.toBeNull();
    act(() => cursor?.click());
    expect(onSelect).toHaveBeenCalledWith('usage', {
      instance: { variant: 'cursor' },
      title: 'Usage (Cursor)',
    });
  });

  it('updates the Cursor usage menu entry when the rollout flag changes', () => {
    const originalFlags = useFeatureFlagsStore.getState().snapshot;
    render();
    openUsageSubmenu();
    const cursorSelector = '[data-testid="panel-add-menu-item-usage-cursor"]';
    expect(document.body.querySelector(cursorSelector)).not.toBeNull();
    try {
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: {
              ...originalFlags.values,
              'canopy-desktop-cursor-harness': false,
            },
          },
        }),
      );
      expect(document.body.querySelector(cursorSelector)).toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="panel-add-menu-item-usage-codex"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => useFeatureFlagsStore.setState({ snapshot: originalFlags }));
    }
  });

  it('offers the Feed panel only while the Ledger is on', () => {
    const originalFlags = useFeatureFlagsStore.getState().snapshot;
    const ledgerSelector = '[data-testid="panel-add-menu-item-ledger"]';
    try {
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: { ...originalFlags.values, 'canopy-ledger-enabled': true },
          },
        }),
      );
      render();
      const ledger = document.body.querySelector<HTMLElement>(ledgerSelector);
      expect(ledger).not.toBeNull();
      expect(ledger?.textContent).toContain('Feed');

      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: { ...originalFlags.values, 'canopy-ledger-enabled': false },
          },
        }),
      );
      expect(document.body.querySelector(ledgerSelector)).toBeNull();
    } finally {
      act(() => useFeatureFlagsStore.setState({ snapshot: originalFlags }));
    }
  });

  it('selecting the Ledger adds the singleton panel without a binding', () => {
    const originalFlags = useFeatureFlagsStore.getState().snapshot;
    try {
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: { ...originalFlags.values, 'canopy-ledger-enabled': true },
          },
        }),
      );
      render();
      const ledger = document.body.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-ledger"]',
      );
      act(() => ledger?.click());
      expect(onSelect).toHaveBeenCalledWith('ledger', undefined);
    } finally {
      act(() => useFeatureFlagsStore.setState({ snapshot: originalFlags }));
    }
  });

  it('updates the Copilot usage menu entry when the rollout flag changes', () => {
    const originalFlags = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...originalFlags,
        values: {
          ...originalFlags.values,
          'canopy-desktop-copilot-harness': true,
        },
      },
    });
    render();
    openUsageSubmenu();
    const copilotSelector = '[data-testid="panel-add-menu-item-usage-copilot"]';
    expect(document.body.querySelector(copilotSelector)).not.toBeNull();
    try {
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: {
              ...originalFlags.values,
              'canopy-desktop-copilot-harness': false,
            },
          },
        }),
      );
      expect(document.body.querySelector(copilotSelector)).toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="panel-add-menu-item-usage-codex"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => useFeatureFlagsStore.setState({ snapshot: originalFlags }));
    }
  });

  it('selecting a usage variant passes its instance binding and title', () => {
    render();
    openUsageSubmenu();
    const codex = document.body.querySelector(
      '[data-testid="panel-add-menu-item-usage-codex"]',
    );
    expect(codex).not.toBeNull();
    act(() => {
      if (codex instanceof HTMLElement) {
        codex.click();
      }
    });
    expect(onSelect).toHaveBeenCalledWith('usage', {
      instance: { variant: 'codex' },
      title: 'Usage (Codex)',
    });
  });

  it('drops a usage variant already open from the add menu', () => {
    usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'usage', {
      panelId: 'panel-usage-all',
      title: 'Usage',
      instance: { variant: 'all' },
    });
    render();
    openUsageSubmenu();
    expect(
      document.body.querySelector(
        '[data-testid="panel-add-menu-item-usage-all"]',
      ),
    ).toBeNull();
    // The other variants remain offerable.
    expect(
      document.body.querySelector(
        '[data-testid="panel-add-menu-item-usage-codex"]',
      ),
    ).not.toBeNull();
  });

  it('offers every usage variant in Cowork while filtering Code-only activity cards', () => {
    registerCoworkWorkspaceIds([COWORK_WORKSPACE_ID]);
    usePanelLayoutStore
      .getState()
      .initializeLayout(COWORK_KEY, TWO_GROUP_LAYOUT);

    render('group-terminal', COWORK_KEY);

    const menu = menuElement();
    openUsageSubmenu();
    for (const variant of ['all', 'active-chat', 'codex', 'claude', 'cursor']) {
      expect(
        document.body.querySelector(
          `[data-testid="panel-add-menu-item-usage-${variant}"]`,
        ),
      ).not.toBeNull();
    }
    expect(
      menu.querySelector(
        '[data-testid="panel-add-menu-item-activity-card-summary"]',
      ),
    ).toBeNull();
    expect(
      menu.querySelector(
        '[data-testid="panel-add-menu-item-activity-card-notes"]',
      ),
    ).not.toBeNull();
  });

  it('offers the four automations variants inside the Automations submenu', () => {
    render();
    const trigger = menuElement().querySelector(
      '[data-testid="panel-add-menu-automations-submenu"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('Automations');
    openAutomationsSubmenu();

    const group = document.body.querySelector(
      '[data-testid="panel-add-menu-automations-group"]',
    );
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Automations');
    for (const variant of ['full', 'upcoming', 'overview', 'completed']) {
      expect(
        group?.querySelector(
          `[data-testid="panel-add-menu-item-automations-${variant}"]`,
        ),
      ).not.toBeNull();
    }
  });

  it('selecting an automations variant passes its instance binding and title', () => {
    render();
    openAutomationsSubmenu();
    const upcoming = document.body.querySelector(
      '[data-testid="panel-add-menu-item-automations-upcoming"]',
    );
    expect(upcoming).not.toBeNull();
    act(() => {
      if (upcoming instanceof HTMLElement) {
        upcoming.click();
      }
    });
    expect(onSelect).toHaveBeenCalledWith('automations', {
      instance: { variant: 'upcoming' },
      title: 'Automations (Upcoming)',
    });
  });

  it('drops an automations variant already open from the add menu', () => {
    usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'automations', {
      panelId: 'panel-automations-full',
      title: 'Automations',
      instance: { variant: 'full' },
    });
    render();
    openAutomationsSubmenu();
    expect(
      document.body.querySelector(
        '[data-testid="panel-add-menu-item-automations-full"]',
      ),
    ).toBeNull();
    // The other three variants remain offerable.
    expect(
      document.body.querySelector(
        '[data-testid="panel-add-menu-item-automations-overview"]',
      ),
    ).not.toBeNull();
  });

  it.each(['code', 'cowork'])(
    'opens Memory from the primary menu in %s',
    (surface) => {
      const key = surface === 'cowork' ? COWORK_KEY : KEY;
      if (surface === 'cowork') {
        registerCoworkWorkspaceIds([COWORK_WORKSPACE_ID]);
        usePanelLayoutStore.getState().initializeLayout(key, TWO_GROUP_LAYOUT);
      }
      render('group-terminal', key);
      const memory = menuElement().querySelector<HTMLButtonElement>(
        '[data-testid="panel-add-menu-item-activity-card-memory"]',
      );
      expect(memory).not.toBeNull();
      expect(
        memory?.closest('[data-testid="panel-add-menu-activity-group"]'),
      ).toBeNull();
      act(() => memory?.click());
      expect(onSelect).toHaveBeenCalledWith('activity-card', {
        instance: { sectionId: 'memory' },
        title: 'Memory',
      });
    },
  );

  it('offers every automations variant in Cowork', () => {
    registerCoworkWorkspaceIds([COWORK_WORKSPACE_ID]);
    usePanelLayoutStore
      .getState()
      .initializeLayout(COWORK_KEY, TWO_GROUP_LAYOUT);

    render('group-terminal', COWORK_KEY);
    openAutomationsSubmenu();
    for (const variant of ['full', 'upcoming', 'overview', 'completed']) {
      expect(
        document.body.querySelector(
          `[data-testid="panel-add-menu-item-automations-${variant}"]`,
        ),
      ).not.toBeNull();
    }
  });

  it('groups activity section cards under an Activity section header', () => {
    render();
    const group = menuElement().querySelector(
      '[data-testid="panel-add-menu-activity-group"]',
    );
    expect(group).not.toBeNull();
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-label')).toBe('Activity');
    expect(
      group?.querySelector('.canopy-panel-chrome-menu-label')?.textContent,
    ).toBe('Activity');
    expect(
      group
        ?.querySelector('.canopy-panel-chrome-menu-label')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      group?.querySelector(
        '[data-testid="panel-add-menu-item-activity-card-summary"]',
      ),
    ).not.toBeNull();
  });

  it('renders each activity section entry with its own section icon', () => {
    render();
    const menu = menuElement();
    const summaryItem = menu.querySelector(
      '[data-testid="panel-add-menu-item-activity-card-summary"]',
    );
    const notesItem = menu.querySelector(
      '[data-testid="panel-add-menu-item-activity-card-notes"]',
    );
    // Each entry surfaces its section's own icon (not the generic glyph).
    expect(
      summaryItem?.querySelector('[data-testid="mock-section-summary-icon"]'),
    ).not.toBeNull();
    expect(
      notesItem?.querySelector('[data-testid="mock-section-notes-icon"]'),
    ).not.toBeNull();
  });

  it('labels section entries with the registry title and stores it', () => {
    render();
    const item = menuElement().querySelector<HTMLButtonElement>(
      '[data-testid="panel-add-menu-item-activity-card-background-processes"]',
    );
    expect(
      menuElement().querySelector(
        '[data-testid="panel-add-menu-item-activity-card-background-processes-label"]',
      )?.textContent,
    ).toBe('Agent background processes');
    act(() => item?.click());
    expect(onSelect).toHaveBeenCalledWith('activity-card', {
      instance: { sectionId: 'background-processes' },
      title: 'Agent background processes',
    });
  });

  it('early access leaves Activity out: its sections open from the Activity card', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    try {
      render();
      const menu = menuElement();
      expect(
        menu.querySelector(
          '[data-testid="panel-add-menu-item-activity-card-background-processes"]',
        ),
      ).toBeNull();
      expect(
        menu.querySelector(
          '[data-testid="panel-add-menu-item-activity-card-summary"]',
        ),
      ).toBeNull();
      expect(
        menu.querySelector(
          '[data-testid="panel-add-menu-item-activity-section"]',
        ),
      ).toBeNull();
      expect(menu.textContent).not.toContain('Activity');
    } finally {
      resetExperimentalFeaturesStoreForTest();
    }
  });

  it('keeps every action at 32px with a fixed icon rail and one-line truncating labels', () => {
    render();
    const menu = menuElement();
    const row = menu.querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-activity-card-background-processes"]',
    );
    const icon = menu.querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-activity-card-background-processes-icon"]',
    );
    const label = menu.querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-activity-card-background-processes-label"]',
    );

    expect(row?.className).toContain('h-8');
    expect(row?.className).toContain('rounded-md');
    // The action-menu rows: small text, quiet tertiary icons.
    expect(row?.className).toContain('text-xs');
    expect(icon?.className).toContain('fg-tertiary');
    expect(icon?.className).toContain('h-4');
    expect(icon?.className).toContain('w-4');
    expect(icon?.className).toContain('shrink-0');
    expect(label?.textContent).toBe('Agent background processes');
    for (const token of [
      'min-w-0',
      'flex-1',
      'overflow-hidden',
      'text-ellipsis',
      'whitespace-nowrap',
    ]) {
      expect(label?.className).toContain(token);
    }
    const scrollViewport = menu.querySelector<HTMLElement>(
      '[data-floating-menu-scroll-viewport="true"]',
    );
    expect(scrollViewport?.className).toContain(
      'canopy-floating-menu-scroll-viewport',
    );
    expect(menu.className).not.toContain('scrollbar-gutter');
  });

  it('skips section labels and dividers during navigation and returns focus on Escape', () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-add-test-trigger"]',
    );
    const menu = menuElement();
    trigger?.focus();

    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    expect(document.activeElement?.textContent).toBe(
      'Agent background processes',
    );

    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  describe('Plans entry (plans list card and open-or-reveal tracked plans)', () => {
    const ROADMAP = makePlan('plan-roadmap', 'Roadmap', {
      updatedAt: '2026-06-03T00:00:00.000Z',
    });
    const IMPORTER = makePlan('plan-importer', 'Importer rewrite', {
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    const ARCHIVED = makePlan('plan-archived', 'Old notes', {
      hidden: true,
    });

    function seedPlans(
      plans: readonly TrackedPlanData[],
      key: string = KEY,
    ): void {
      useActivityStore.setState((state) => ({
        trackedPlans: { ...state.trackedPlans, [key]: [...plans] },
        trackedPlanInventoryLoaded: {
          ...state.trackedPlanInventoryLoaded,
          [key]: true,
        },
      }));
    }

    function plansTrigger(): HTMLElement | null {
      return menuElement().querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-plans-submenu"]',
      );
    }

    function openPlansSubmenu(): HTMLElement {
      const trigger = plansTrigger();
      if (trigger === null) {
        throw new Error('plans submenu trigger not rendered');
      }
      act(() => {
        trigger.click();
      });
      const group = document.body.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-plans-group"]',
      );
      if (group === null) {
        throw new Error('plans submenu did not open');
      }
      return group;
    }

    const PLANS_CARD_TEST_ID = 'panel-add-menu-item-activity-card-plans';

    /** Every row and divider in the open submenu, in document order. */
    function submenuItems(): (string | null)[] {
      return Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid="panel-add-menu-plans-group"] [role="menuitem"], [data-testid="panel-add-menu-plans-group"] [role="separator"]',
        ),
      ).map((item) =>
        item.getAttribute('role') === 'separator'
          ? 'separator'
          : item.getAttribute('data-testid'),
      );
    }

    /** The plan rows of the open submenu (the pinned All plans row aside). */
    function planEntries(): { testId: string | null; label: string }[] {
      return Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid="panel-add-menu-plans-group"] [role="menuitem"]',
        ),
      )
        .filter(
          (item) => item.getAttribute('data-testid') !== PLANS_CARD_TEST_ID,
        )
        .map((item) => ({
          testId: item.getAttribute('data-testid'),
          label: item.textContent ?? '',
        }));
    }

    /** The plain top-level Plans row (no visible plan to nest). */
    function plansRow(): HTMLElement | null {
      return menuElement().querySelector<HTMLElement>(
        `[data-testid="${PLANS_CARD_TEST_ID}"]`,
      );
    }

    /** Adds the plans list card to `layoutKey`/`groupId`, then a later tab. */
    function openPlansCard(layoutKey: string, groupId: string): void {
      const store = usePanelLayoutStore.getState();
      store.addTab(layoutKey, groupId, 'activity-card', {
        panelId: 'panel-plans-card',
        title: 'Plans',
        instance: { sectionId: 'plans' },
      });
      store.addTab(layoutKey, groupId, 'activity-card', {
        panelId: 'panel-notes-card',
        title: 'Notes',
        instance: { sectionId: 'notes' },
      });
    }

    it('no longer lists the plans card in the Activity section', () => {
      seedPlans([]);
      render();
      const activity = menuElement().querySelector(
        '[data-testid="panel-add-menu-activity-group"]',
      );
      expect(activity).not.toBeNull();
      expect(
        activity?.querySelector(`[data-testid="${PLANS_CARD_TEST_ID}"]`),
      ).toBeNull();
      expect(
        menuElement().querySelectorAll(`[data-testid="${PLANS_CARD_TEST_ID}"]`),
      ).toHaveLength(1);
    });

    it('offers a plain Plans row after Terminal when no plan is tracked', () => {
      seedPlans([]);
      render();

      expect(plansTrigger()).toBeNull();
      const row = plansRow();
      expect(row?.getAttribute('role')).toBe('menuitem');
      expect(row?.textContent).toBe('Plans');
      // Its own section: the plans divider, right after the Terminal submenu.
      const divider = menuElement().querySelector(
        '[data-testid="panel-add-menu-plans-divider"]',
      );
      expect(divider?.nextElementSibling).toBe(row);
      const terminal = menuElement().querySelector(
        '[data-testid="panel-add-menu-terminal-submenu"]',
      );
      expect(terminal).not.toBeNull();
      expect(
        terminal !== null && divider !== null
          ? terminal.compareDocumentPosition(divider) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
    });

    it('opens the plans list card in the menu group from the plain row', () => {
      seedPlans([]);
      render('group-chat');
      act(() => plansRow()?.click());

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith('activity-card', {
        instance: { sectionId: 'plans' },
        title: 'Plans',
      });
      expect(openPlanPanelMock).not.toHaveBeenCalled();
    });

    it('reveals an open plans list card instead of adding a duplicate', () => {
      seedPlans([]);
      openPlansCard(KEY, 'group-chat');
      render('group-terminal');

      const row = plansRow();
      expect(row).not.toBeNull();
      act(() => row?.click());

      expect(onSelect).not.toHaveBeenCalled();
      // A top-level row also closes through the floating menu itself.
      expect(onClose).toHaveBeenCalled();
      const layout = usePanelLayoutStore.getState().layouts[KEY];
      expect(layout?.groups['group-chat']?.activePanelId).toBe(
        'panel-plans-card',
      );
      expect(layout?.activeGroupId).toBe('group-chat');
      const plansCards = Object.values(layout?.groups ?? {}).flatMap((group) =>
        group.tabs.filter((tab) => tab.instance?.sectionId === 'plans'),
      );
      expect(plansCards.map((tab) => tab.panelId)).toEqual([
        'panel-plans-card',
      ]);
    });

    it('lists All plans, a divider, then the visible plans in plan-list order', () => {
      seedPlans([ROADMAP, IMPORTER, ARCHIVED]);
      render();

      expect(plansRow()).toBeNull();
      const trigger = plansTrigger();
      expect(trigger?.textContent).toContain('Plans');
      const group = openPlansSubmenu();
      expect(group.getAttribute('aria-label')).toBe('Plans');
      expect(submenuItems()).toEqual([
        PLANS_CARD_TEST_ID,
        'separator',
        'panel-add-menu-item-plan-plan-roadmap',
        'panel-add-menu-item-plan-plan-importer',
      ]);
      expect(
        group.querySelector(`[data-testid="${PLANS_CARD_TEST_ID}"]`)
          ?.textContent,
      ).toBe('All plans');
      expect(planEntries()).toEqual([
        { testId: 'panel-add-menu-item-plan-plan-roadmap', label: 'Roadmap' },
        {
          testId: 'panel-add-menu-item-plan-plan-importer',
          label: 'Importer rewrite',
        },
      ]);
      expect(
        document.body.querySelector(
          '[data-testid="panel-add-menu-item-plan-plan-archived"]',
        ),
      ).toBeNull();
    });

    it('opens the plans list card from All plans and closes the menu', () => {
      seedPlans([ROADMAP]);
      render('group-chat');
      const group = openPlansSubmenu();
      act(() =>
        group
          .querySelector<HTMLElement>(`[data-testid="${PLANS_CARD_TEST_ID}"]`)
          ?.click(),
      );

      expect(onSelect).toHaveBeenCalledWith('activity-card', {
        instance: { sectionId: 'plans' },
        title: 'Plans',
      });
      expect(openPlanPanelMock).not.toHaveBeenCalled();
    });

    it('reveals a plans list card open in an auxiliary window from All plans', () => {
      seedPlans([ROADMAP]);
      usePanelLayoutStore.getState().initializeLayout(AUX_KEY, {
        orientation: 'horizontal',
        groups: [
          { kind: 'terminal', groupId: 'group-aux', panelId: 'panel-aux' },
        ],
        containerSize: { width: 800, height: 600 },
      });
      openPlansCard(AUX_KEY, 'group-aux');
      render('group-terminal');
      const group = openPlansSubmenu();
      act(() =>
        group
          .querySelector<HTMLElement>(`[data-testid="${PLANS_CARD_TEST_ID}"]`)
          ?.click(),
      );

      expect(onSelect).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      const aux = usePanelLayoutStore.getState().layouts[AUX_KEY];
      expect(aux?.groups['group-aux']?.activePanelId).toBe('panel-plans-card');
      expect(
        usePanelLayoutStore.getState().layouts[KEY]?.groups['group-terminal']
          ?.tabs,
      ).toHaveLength(1);
    });

    it('keeps listing a plan whose panel is already open', () => {
      seedPlans([ROADMAP, IMPORTER]);
      usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'plan', {
        panelId: 'panel-plan-plan-roadmap',
        title: 'Roadmap',
        instance: { planId: 'plan-roadmap' },
      });
      render();
      openPlansSubmenu();

      expect(planEntries().map((entry) => entry.testId)).toEqual([
        'panel-add-menu-item-plan-plan-roadmap',
        'panel-add-menu-item-plan-plan-importer',
      ]);
    });

    it('opens or reveals the chosen plan in the menu group and closes the menu', () => {
      seedPlans([ROADMAP, IMPORTER]);
      render('group-chat');
      openPlansSubmenu();

      const importer = document.body.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-plan-plan-importer"]',
      );
      act(() => importer?.click());

      expect(openPlanPanelMock).toHaveBeenCalledTimes(1);
      expect(openPlanPanelMock).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        'plan-importer',
        { intent: { groupId: 'group-chat', layoutKey: KEY } },
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('lists the owning worktree plans in an auxiliary window and targets that window', () => {
      seedPlans([ROADMAP]);
      usePanelLayoutStore.getState().initializeLayout(AUX_KEY, {
        orientation: 'horizontal',
        groups: [
          { kind: 'terminal', groupId: 'group-aux', panelId: 'panel-aux' },
        ],
        containerSize: { width: 800, height: 600 },
      });
      render('group-aux', AUX_KEY);
      openPlansSubmenu();

      const roadmap = document.body.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-plan-plan-roadmap"]',
      );
      act(() => roadmap?.click());

      expect(openPlanPanelMock).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        'plan-roadmap',
        { intent: { groupId: 'group-aux', layoutKey: AUX_KEY } },
      );
    });

    it('updates titles and visibility while the menu is open', () => {
      seedPlans([ROADMAP, IMPORTER]);
      render();
      openPlansSubmenu();

      act(() => {
        seedPlans([{ ...ROADMAP, title: 'Roadmap v2' }, IMPORTER]);
      });
      expect(planEntries().map((entry) => entry.label)).toEqual([
        'Roadmap v2',
        'Importer rewrite',
      ]);

      act(() => {
        seedPlans([
          { ...ROADMAP, title: 'Roadmap v2', hidden: true },
          IMPORTER,
        ]);
      });
      expect(planEntries().map((entry) => entry.label)).toEqual([
        'Importer rewrite',
      ]);

      act(() => {
        seedPlans([
          { ...ROADMAP, title: 'Roadmap v2', hidden: false },
          IMPORTER,
        ]);
      });
      expect(planEntries().map((entry) => entry.label)).toEqual([
        'Roadmap v2',
        'Importer rewrite',
      ]);
    });

    it('becomes the plain row once every plan is hidden, and a submenu again on unhide', () => {
      seedPlans([ROADMAP]);
      render();
      expect(plansTrigger()).not.toBeNull();
      expect(plansRow()).toBeNull();

      act(() => {
        seedPlans([{ ...ROADMAP, hidden: true }]);
      });
      expect(plansTrigger()).toBeNull();
      expect(plansRow()?.textContent).toBe('Plans');
      expect(
        menuElement().querySelector(
          '[data-testid="panel-add-menu-plans-divider"]',
        ),
      ).not.toBeNull();

      act(() => {
        seedPlans([{ ...ROADMAP, hidden: false }]);
      });
      expect(plansTrigger()).not.toBeNull();
      expect(plansRow()).toBeNull();
    });

    it('shows the plain row when the surface excludes plan panels', () => {
      seedPlans([ROADMAP]);
      render('group-terminal', KEY, ['plan']);
      expect(plansTrigger()).toBeNull();
      expect(plansRow()?.textContent).toBe('Plans');
    });

    it('omits the whole entry when the surface excludes activity cards', () => {
      seedPlans([ROADMAP]);
      render('group-terminal', KEY, ['activity-card']);
      expect(plansTrigger()).toBeNull();
      expect(plansRow()).toBeNull();
      expect(
        menuElement().querySelector(
          '[data-testid="panel-add-menu-plans-divider"]',
        ),
      ).toBeNull();
    });

    it('omits the whole entry when access disallows the plans section', () => {
      seedPlans([ROADMAP]);
      render('group-terminal', KEY, undefined, {
        mode: 'read-only',
        reason: 'shared-container',
        containerType: 'COWORK_WORK_ENTRY',
        runAllowed: false,
      });
      expect(plansTrigger()).toBeNull();
      expect(plansRow()).toBeNull();
    });

    it('keeps the entry for a read-only code share, which allows plans', () => {
      seedPlans([]);
      render('group-terminal', KEY, undefined, {
        mode: 'read-only',
        reason: 'shared-container',
        containerType: 'CODE_WORKTREE',
        runAllowed: false,
      });
      expect(plansRow()?.textContent).toBe('Plans');
    });

    it('omits the whole entry in Cowork, which has no plans section', () => {
      registerCoworkWorkspaceIds([COWORK_WORKSPACE_ID]);
      usePanelLayoutStore
        .getState()
        .initializeLayout(COWORK_KEY, TWO_GROUP_LAYOUT);
      seedPlans(
        [
          makePlan('plan-cowork', 'Cowork plan', {
            projectId: COWORK_WORKSPACE_ID,
            worktreeId: COWORK_ENTRY_ID,
          }),
        ],
        COWORK_KEY,
      );
      render('group-terminal', COWORK_KEY);
      expect(plansTrigger()).toBeNull();
      expect(plansRow()).toBeNull();
      expect(
        menuElement().querySelector(
          '[data-testid="panel-add-menu-plans-divider"]',
        ),
      ).toBeNull();
    });

    it('loads the plan inventory once when it has not loaded yet', async () => {
      const originalLoad = useActivityStore.getState().loadTrackedPlans;
      const loadTrackedPlans = jest.fn(
        (projectId: string, worktreeId: string): Promise<void> => {
          useActivityStore.setState((state) => ({
            trackedPlans: {
              ...state.trackedPlans,
              [`${projectId}/${worktreeId}`]: [ROADMAP],
            },
          }));
          return Promise.resolve();
        },
      );
      useActivityStore.setState({ loadTrackedPlans });
      try {
        await act(async () => {
          render();
          await Promise.resolve();
        });
        expect(loadTrackedPlans).toHaveBeenCalledTimes(1);
        expect(loadTrackedPlans).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
        // The listed plans arrive through the store without reopening.
        openPlansSubmenu();
        expect(planEntries().map((entry) => entry.label)).toEqual(['Roadmap']);

        // A later re-render of the open menu does not load again.
        await act(async () => {
          render();
          await Promise.resolve();
        });
        expect(loadTrackedPlans).toHaveBeenCalledTimes(1);
      } finally {
        useActivityStore.setState({ loadTrackedPlans: originalLoad });
      }
    });

    it('does not reload an inventory that has already loaded', async () => {
      const originalLoad = useActivityStore.getState().loadTrackedPlans;
      const loadTrackedPlans = jest.fn((): Promise<void> => Promise.resolve());
      useActivityStore.setState({ loadTrackedPlans });
      try {
        seedPlans([ROADMAP]);
        await act(async () => {
          render();
          await Promise.resolve();
        });
        expect(loadTrackedPlans).not.toHaveBeenCalled();
      } finally {
        useActivityStore.setState({ loadTrackedPlans: originalLoad });
      }
    });
  });

  describe('Browser row (repeatable, placed before its session exists)', () => {
    const openBrowser = jest.fn();
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    const addToast = jest.fn();
    const originalBrowserActions = {
      openBrowser: useBrowserStore.getState().openBrowser,
      destroyBrowser: useBrowserStore.getState().destroyBrowser,
      setActiveBrowser: useBrowserStore.getState().setActiveBrowser,
    };
    const originalAddToast = useGitHubStore.getState().addToast;

    beforeEach(() => {
      // The backend session is still being created throughout.
      openBrowser.mockReset().mockReturnValue({
        browserId: 'browser-new',
        ready: new Promise(() => undefined),
      });
      destroyBrowser.mockClear();
      setActiveBrowser.mockClear();
      addToast.mockClear();
      useBrowserStore.setState({
        openBrowser,
        destroyBrowser,
        setActiveBrowser,
      });
      useGitHubStore.setState({ addToast });
    });

    afterEach(() => {
      useBrowserStore.setState(originalBrowserActions);
      useGitHubStore.setState({ addToast: originalAddToast });
    });

    function browserRow(): HTMLElement {
      const row = menuElement().querySelector(
        '[data-testid="panel-add-menu-item-browser"]',
      );
      if (!(row instanceof HTMLElement)) {
        throw new Error('browser row not rendered');
      }
      return row;
    }

    it('always offers exactly one normal Browser row, even when Browser panels exist', () => {
      usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'browser', {
        panelId: 'panel-browser-existing',
        instance: { browserId: 'browser-existing' },
      });
      render();
      const rows = menuElement().querySelectorAll(
        '[data-testid="panel-add-menu-item-browser"]',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toBe('Browser');
    });

    it('inserts the bound panel and closes without waiting for the session', async () => {
      render('group-terminal');

      await act(async () => {
        browserRow().click();
        await Promise.resolve();
      });

      expect(openBrowser).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
      const location = findPanelByInstanceKey(KEY, 'browser:browser-new');
      expect(location).not.toBeNull();
      expect(location?.groupId).toBe('group-terminal');
      expect(location?.panelId).toBe('panel-browser-browser-new');
      expect(setActiveBrowser).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKTREE_ID,
        'browser-new',
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(destroyBrowser).not.toHaveBeenCalled();
    });

    it('on bind failure discards ONLY the opened session and keeps the menu usable', async () => {
      // A colliding binding makes the addTab (and its fallback) fail.
      usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'browser', {
        panelId: 'panel-browser-browser-new',
        instance: { browserId: 'browser-new' },
      });
      render('group-terminal');

      await act(async () => {
        browserRow().click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(destroyBrowser).toHaveBeenCalledTimes(1);
      expect(destroyBrowser).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKTREE_ID,
        'browser-new',
      );
      expect(addToast).toHaveBeenCalledWith(
        'Unable to open Browser',
        'error',
        undefined,
        expect.objectContaining({ worktreeId: WORKTREE_ID }),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect((browserRow() as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('uses fixed collision-aware placement without a legacy clamp transform', () => {
    render();
    expect(menuElement().style.position).toBe('fixed');
    expect(menuElement().style.transform).toBe('');
  });

  it('flips and shifts the shared surface when the preferred side collides', () => {
    const rectSpy = jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(900, 700, 200, 100));
    const widthSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(200);
    const heightSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(100);
    const scrollHeightSpy = jest
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(100);
    try {
      render();
      const menu = menuElement();
      expect(menu.dataset.placement).toMatch(/^top-/);
      expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(
        window.innerWidth - 8,
      );
      expect(menu.style.transformOrigin).toMatch(/^bottom /);
    } finally {
      rectSpy.mockRestore();
      widthSpy.mockRestore();
      heightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    }
  });
});
