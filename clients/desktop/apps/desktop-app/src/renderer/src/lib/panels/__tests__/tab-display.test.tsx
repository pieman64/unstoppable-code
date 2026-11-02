/**
 * @jest-environment jsdom
 */
import { earlyAccessTitle } from '@/lib/earlyAccessTitles';
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

/**
 * Panel tab display titles — guards the friendly-title fallback: the layout
 * store's view model falls back to the raw kind id when a tab carries no
 * instance title (singleton kinds never do), and the display layer must
 * resolve that to the registry definition's friendly title instead of
 * leaking 'terminal' / 'browser' / 'file-explorer' into the tab strip.
 */
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { act, isValidElement, type JSX, type ReactNode } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PANEL_KINDS, type PanelKind } from '@canopy/protocol';
import type {
  PanelIntentCallbacks,
  PanelTabModel,
} from '@canopy/ui-shared/panels';
import {
  BarChart4BarsIcon,
  PipelineIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { CostIcon } from '@canopy/ui-shared/icons/AppIcons';
import { AgentIcon } from '@canopy/ui-shared/icons';
import {
  PANEL_TAB_BUSY_ATTRIBUTE,
  PanelCollapsedBar,
  PanelTabStyleProvider,
} from '@canopy/ui-shared/components/panels';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandName,
  QueryMap,
  Unsubscribe,
} from '@canopy/app-core';
import { createFileViewerStore } from '@canopy/app-state';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { useTerminalRunning } from '@/hooks/useTerminalRunning';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useBrowserStore } from '@/stores/browserStore';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  patchPipelinePanelUi,
  resetPipelinePanelUiStoreForTests,
} from '@/stores/pipelinePanelUiStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { PanelWorktreeContext } from '../panel-worktree-context';
import {
  panelTabDisplayTitle,
  renderPanelCollapsedTabIcon,
  renderPanelTabIcon,
  renderPanelTabLabel,
  renderPanelTabTooltip,
  renderPanelTabTrailing,
  renderPanelTabAttention,
} from '../tab-display';

// Isolate the registry import graph from the heavy real components (Slate,
// xterm, native browser panes) — same stub set as registry.test.tsx; this
// suite only consumes the definitions' titles/icons.
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
      icon: react.createElement('svg', {
        'data-testid': 'mock-section-summary-icon',
      }),
      render: jest.fn((): unknown =>
        react.createElement('div', { 'data-testid': 'mock-section-summary' }),
      ),
    },
    {
      id: 'changed-files',
      title: 'Changed Files',
      icon: react.createElement('svg'),
      render: jest.fn((): unknown => null),
    },
    {
      id: 'pipeline-runs',
      title: 'Workflow runs',
      icon: react.createElement('svg'),
      render: jest.fn((): unknown => null),
    },
  ];
  return {
    ACTIVITY_SECTIONS: sections,
    getActivitySectionDefinition: (sectionId: string): unknown =>
      sections.find((section) => section.id === sectionId),
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

// The terminal panel tab's trailing running dot reads live worktree state.
jest.mock('@/hooks/useTerminalRunning', () => ({
  useTerminalRunning: jest.fn(() => false),
}));
jest.mock('@/stores/terminalActivityStore', () => ({
  useTerminalActivityStore: jest.fn(() => false),
}));
jest.mock('@/components/chat/useWorktreeChatSurfaceState', () => ({
  useWorktreeChatSelection: jest.fn(() => ({
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  })),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/** The expected friendly registry title per kind (registry.tsx). */
const KIND_TITLES: Record<PanelKind, string> = {
  chat: 'Chat',
  'file-diff': 'Files',
  'change-diagram': 'Change Diagram',
  terminal: 'Terminal',
  'activity-section': 'Activity',
  browser: 'Browser',
  'file-explorer': 'File Explorer',
  'activity-card': 'Activity card',
  usage: 'Usage',
  automations: 'Automations',
  'pipeline-execution': 'Workflow run',
  plan: 'Plan',
  'plan-diagram': 'Plan diagram',
  'chat-visuals': 'Chat visuals',
  subagents: 'Subagents',
  'subagent-chat': 'Subagent',
  ledger: 'Feed',
  cost: 'Cost',
  'session-breakdown': 'Session breakdown',
  'new-tab': 'New tab',
};

/** A view-model-shaped tab with NO instance title: `title` is the raw kind
 * id, exactly what panelLayoutStore's deriveViewModel falls back to. */
function untitledTab(kind: PanelKind): PanelTabModel {
  return { panelId: `panel-${kind}`, kind, title: kind };
}

/** A panel tab bound to a chat tab id (the shape panelLayoutStore emits for
 * chat panels). */
function boundChatPanelTab(chatTabId: string): PanelTabModel {
  return {
    panelId: 'panel-chat',
    kind: 'chat',
    title: 'Chat',
    instance: { chatTabId },
  };
}

/** Minimal chat tab, mirroring the store's ChatTab shape (no casts). */
function makeChatTab(overrides: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
    id: overrides.id,
  };
}

const NOOP_PANEL_INTENT_CALLBACKS: PanelIntentCallbacks = {
  onSelectTab: jest.fn(),
  onCloseTab: jest.fn(),
  onCloseGroup: jest.fn(),
  onSplitGroup: jest.fn(),
  onMaximizeGroup: jest.fn(),
  onFocusGroup: jest.fn(),
  onMovePanel: jest.fn(),
};

describe('panelTabDisplayTitle', () => {
  it.each([...PANEL_KINDS])(
    'resolves an untitled %s tab to its registry title',
    (kind) => {
      expect(panelTabDisplayTitle(untitledTab(kind))).toBe(
        earlyAccessTitle(KIND_TITLES[kind]),
      );
    },
  );

  it('keeps instance titles untouched', () => {
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-1',
        kind: 'chat',
        title: 'Fix the flaky test',
      }),
    ).toBe('Fix the flaky test');
  });

  it('resolves an empty title to the registry title', () => {
    expect(
      panelTabDisplayTitle({ panelId: 'panel-1', kind: 'terminal', title: '' }),
    ).toBe('Terminal');
  });

  it('uses the subagent-chat instance title and falls back when it is blank', () => {
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-subagent-chat',
        kind: 'subagent-chat',
        title: 'Inspect the repository',
        instance: {
          rootChatId: 'root-chat',
          subagentId: 'subagent-1',
          subagentKind: 'managed',
        },
      }),
    ).toBe('Inspect the repository');
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-subagent-chat',
        kind: 'subagent-chat',
        title: '   ',
      }),
    ).toBe('Subagent');
  });

  it('passes unknown kinds through (corrupt/forward-versioned layouts)', () => {
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-1',
        kind: 'bogus-kind',
        title: 'bogus-kind',
      }),
    ).toBe('bogus-kind');
  });
});

describe('Cost panel tab display', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({ worktreeChats: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      useChatStore.setState({ worktreeChats: {} });
    });
    container.remove();
  });

  it('uses Cost and the Cost icon for the scope panel', () => {
    expect(panelTabDisplayTitle(untitledTab('cost'))).toBe('Cost');
    const icon = renderPanelTabIcon(untitledTab('cost'));
    expect(isValidElement(icon)).toBe(true);
    if (isValidElement(icon)) {
      expect(icon.type).toBe(CostIcon);
    }
  });

  it('uses the live chat name, Statistics icon and Session breakdown tooltip', () => {
    const tab: PanelTabModel = {
      panelId: 'panel-session-breakdown-chat-1',
      kind: 'session-breakdown',
      title: 'Stored chat name',
      instance: { chatId: 'chat-1' },
    };
    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [
              makeChatTab({
                id: 'chat-1',
                title: 'Chat title',
                description: 'Current chat name',
              }),
            ],
          },
        },
      });
    });

    // The plain title feeds accessible names and tooltips, which session
    // replay records as written, so it never carries the chat's name.
    expect(panelTabDisplayTitle(tab)).toBe('Session breakdown');
    expect(renderPanelTabTooltip(tab)).toBe('Session breakdown');
    const icon = renderPanelTabIcon(tab);
    expect(isValidElement(icon)).toBe(true);
    if (isValidElement(icon)) {
      expect(icon.type).toBe(BarChart4BarsIcon);
    }

    act(() => {
      root.render(<>{renderPanelTabLabel(tab)}</>);
    });
    expect(container.textContent).toBe('Current chat name');
    // The tab is named after its chat, so session replay masks the name.
    expect(container.querySelector('.ph-mask')?.textContent).toBe(
      'Current chat name',
    );
  });

  it('shows the stored chat name, masked, when the chat is not loaded', () => {
    const tab: PanelTabModel = {
      panelId: 'panel-session-breakdown-chat-2',
      kind: 'session-breakdown',
      title: 'Stored chat name',
      instance: { chatId: 'missing-chat' },
    };
    expect(panelTabDisplayTitle(tab)).toBe('Session breakdown');
    act(() => {
      root.render(<>{renderPanelTabLabel(tab)}</>);
    });
    expect(container.querySelector('.ph-mask')?.textContent).toBe(
      'Stored chat name',
    );
  });

  it('keeps the chat name out of every attribute of a collapsed tab', () => {
    const tab: PanelTabModel = {
      panelId: 'panel-session-breakdown-chat-1',
      kind: 'session-breakdown',
      title: 'Private launch plan',
      instance: { chatId: 'chat-1' },
    };
    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab({ id: 'chat-1', title: 'Private launch plan' })],
          },
        },
      });
    });
    act(() => {
      root.render(
        <PanelCollapsedBar
          group={{
            groupId: 'g1',
            tabs: [tab],
            activePanelId: tab.panelId,
            collapsed: { edge: 'right' },
          }}
          edge="right"
          isActiveGroup={false}
          hasMultipleGroups
          callbacks={NOOP_PANEL_INTENT_CALLBACKS}
          getTabTitle={panelTabDisplayTitle}
          renderTabIcon={renderPanelTabIcon}
          renderTabTooltip={renderPanelTabTooltip}
        />,
      );
    });
    const button = container.querySelector(
      '[data-testid="panel-collapsed-tab-panel-session-breakdown-chat-1"]',
    );
    expect(button?.getAttribute('aria-label')).toBe('Session breakdown');
    expect(container.innerHTML).not.toContain('Private launch plan');
  });
});

describe('early-access sentence-case names', () => {
  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
  });

  const storedChangeDiagram: PanelTabModel = {
    panelId: 'change-diagram-p/w',
    kind: 'change-diagram',
    // Layouts persist the Title Case name.
    title: 'Change Diagram',
  };
  const changedFilesCard: PanelTabModel = {
    panelId: 'panel-card',
    kind: 'activity-card',
    title: 'Changed Files',
    instance: { sectionId: 'changed-files' },
  };

  it('uses sentence case without a Labs opt-in', () => {
    expect(panelTabDisplayTitle(untitledTab('file-explorer'))).toBe(
      'File explorer',
    );
    expect(panelTabDisplayTitle(storedChangeDiagram)).toBe('Change diagram');
    expect(panelTabDisplayTitle(changedFilesCard)).toBe('Changed files');
    expect(renderPanelTabLabel(changedFilesCard)).toBe('Changed files');
  });

  it('shows default and stored default names in sentence case with early access on', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    expect(panelTabDisplayTitle(untitledTab('file-explorer'))).toBe(
      'File explorer',
    );
    expect(panelTabDisplayTitle(storedChangeDiagram)).toBe('Change diagram');
    expect(renderPanelTabLabel(storedChangeDiagram)).toBe('Change diagram');
    expect(panelTabDisplayTitle(changedFilesCard)).toBe('Changed files');
    expect(renderPanelTabLabel(changedFilesCard)).toBe('Changed files');
  });

  it('shows a stored former default name under its new name (CAN-4651)', () => {
    // Layouts saved before the rename persist the old default titles.
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-pipeline-run-1',
        kind: 'pipeline-execution',
        title: 'Pipeline run',
        instance: { executionId: 'run-1' },
      }),
    ).toBe('Workflow run');
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-card',
        kind: 'activity-card',
        title: 'Pipeline runs',
        instance: { sectionId: 'pipeline-runs' },
      }),
    ).toBe('Workflow runs');
  });

  it('leaves own titles untouched with early access on', () => {
    setTestEarlyAccessFeatures({ enabled: true });
    expect(
      panelTabDisplayTitle({
        panelId: 'panel-1',
        kind: 'terminal',
        title: 'Change Diagram',
      }),
    ).toBe('Change Diagram');
  });
});

describe('renderPanelTabLabel friendly-kind fallback', () => {
  it.each(['terminal', 'browser', 'file-explorer', 'activity-section'])(
    'renders the registry title for an untitled unbound %s tab',
    (kind) => {
      const panelKind = PANEL_KINDS.find((candidate) => candidate === kind);
      expect(panelKind).toBeDefined();
      if (panelKind === undefined) {
        return;
      }
      expect(renderPanelTabLabel(untitledTab(panelKind))).toBe(
        earlyAccessTitle(KIND_TITLES[panelKind]),
      );
    },
  );

  it('renders the registry title for unbound chat/file-diff tabs (no instance)', () => {
    expect(renderPanelTabLabel(untitledTab('chat'))).toBe('Chat');
    expect(renderPanelTabLabel(untitledTab('file-diff'))).toBe('Files');
  });

  it('activity-card resolves the section title, else the registry title', () => {
    expect(
      renderPanelTabLabel({
        panelId: 'panel-1',
        kind: 'activity-card',
        title: 'activity-card',
        instance: { sectionId: 'summary' },
      }),
    ).toBe('Summary');
    expect(renderPanelTabLabel(untitledTab('activity-card'))).toBe(
      'Activity card',
    );
  });

  describe('bound tabs whose chat tab is not loaded', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    it('falls back to the friendly title, never the raw kind id', () => {
      const chatLabel = renderPanelTabLabel({
        panelId: 'panel-1',
        kind: 'chat',
        title: 'chat',
        instance: { chatTabId: 'missing-tab' },
      });
      const fileLabel = renderPanelTabLabel({
        panelId: 'panel-2',
        kind: 'file-diff',
        title: 'file-diff',
        instance: { fileTabId: 'missing-file' },
      });
      act(() => {
        root.render(
          <>
            <span data-testid="chat-label">{chatLabel}</span>
            <span data-testid="file-label">{fileLabel}</span>
          </>,
        );
      });
      expect(
        container.querySelector('[data-testid="chat-label"]')?.textContent,
      ).toBe('Chat');
      expect(
        container.querySelector('[data-testid="file-label"]')?.textContent,
      ).toBe('Files');
    });
  });
});

describe('renderPanelTabIcon activity-card section icon', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the bound section icon for an activity-card tab', () => {
    act(() => {
      root.render(
        <>
          {renderPanelTabIcon({
            panelId: 'panel-1',
            kind: 'activity-card',
            title: 'activity-card',
            instance: { sectionId: 'summary' },
          })}
        </>,
      );
    });
    expect(
      container.querySelector('[data-testid="mock-section-summary-icon"]'),
    ).not.toBeNull();
  });

  it('falls back to the generic activity-card icon for unknown/missing sections', () => {
    act(() => {
      root.render(
        <>
          {renderPanelTabIcon({
            panelId: 'panel-1',
            kind: 'activity-card',
            title: 'activity-card',
            instance: { sectionId: 'does-not-exist' },
          })}
          {renderPanelTabIcon(untitledTab('activity-card'))}
        </>,
      );
    });
    // The section-specific icon never renders for an unknown/missing section.
    expect(
      container.querySelector('[data-testid="mock-section-summary-icon"]'),
    ).toBeNull();
    // The generic registry glyph still renders so the tab is never icon-less.
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('subagent panel tab icons', () => {
  it.each(['subagents', 'subagent-chat'] as const)(
    'uses AgentIcon for %s tabs',
    (kind) => {
      const icon = renderPanelTabIcon(untitledTab(kind));
      if (!isValidElement(icon)) {
        throw new Error(`expected ${kind} to have an icon`);
      }
      expect(icon.type).toBe(AgentIcon);
    },
  );
});

describe('pipeline-execution run tabs', () => {
  const runTab: PanelTabModel = {
    panelId: 'panel-pipeline-run-1',
    kind: 'pipeline-execution',
    title: 'Workflow run',
    instance: { executionId: 'run-1' },
  };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetPipelinePanelUiStoreForTests();
  });

  function renderLabel(tab: PanelTabModel): string {
    act(() => {
      root.render(<>{renderPanelTabLabel(tab)}</>);
    });
    return container.textContent ?? '';
  }

  it('labels a run tab with its instance title, else the registry title', () => {
    expect(renderLabel(runTab)).toBe('Workflow run');
    expect(panelTabDisplayTitle(untitledTab('pipeline-execution'))).toBe(
      'Workflow run',
    );
    expect(renderLabel({ ...runTab, title: 'Nightly build' })).toBe(
      'Nightly build',
    );
  });

  it("shows the run's name live once its panel learned it", () => {
    expect(renderLabel(runTab)).toBe('Workflow run');
    act(() => {
      patchPipelinePanelUi(
        'project-1/worktree-1::panel-pipeline-run-1',
        'run-1',
        {
          title: 'Release build',
        },
      );
    });
    expect(container.textContent).toBe('Release build');
    expect(panelTabDisplayTitle(runTab)).toBe('Release build');
    // The same deterministic panel id bound to another run never borrows it.
    expect(
      panelTabDisplayTitle({ ...runTab, instance: { executionId: 'run-2' } }),
    ).toBe('Workflow run');
  });

  it('uses the app pipeline icon the Pipeline runs section uses', () => {
    const icon = renderPanelTabIcon(runTab);
    expect(isValidElement(icon) ? icon.type : null).toBe(PipelineIcon);
    expect(renderPanelTabTooltip(runTab)).toBeNull();
  });
});

describe('renderPanelTabTrailing terminal running dot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('lifts the running indicator onto the terminal panel tab when running', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(true);
    act(() => {
      root.render(<>{renderPanelTabTrailing(untitledTab('terminal'))}</>);
    });
    const dot = container.querySelector(
      '[data-testid="panel-tab-terminal-running"]',
    );
    expect(dot).not.toBeNull();
    // Named as an image, so assistive technology announces `Running`.
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('Running');
  });

  it('reads terminal running state from the panel owner worktree when provided', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(true);
    act(() => {
      root.render(
        <PanelWorktreeContext.Provider
          value={{ projectId: 'owner-project', worktreeId: 'owner-worktree' }}
        >
          {renderPanelTabTrailing(untitledTab('terminal'))}
        </PanelWorktreeContext.Provider>,
      );
    });
    expect(useTerminalActivityStore).toHaveBeenCalled();
    expect(useTerminalRunning).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="panel-tab-terminal-running"]'),
    ).not.toBeNull();
  });

  it('renders no dot when the worktree has no running terminal', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(false);
    act(() => {
      root.render(<>{renderPanelTabTrailing(untitledTab('terminal'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-terminal-running"]'),
    ).toBeNull();
  });
});

/** A panel tab bound to one browser session (the layout store's shape). */
function boundBrowserPanelTab(browserId: string): PanelTabModel {
  return {
    panelId: `panel-browser-${browserId}`,
    kind: 'browser',
    title: 'browser',
    instance: { browserId },
  };
}

function browserSnapshot(
  browserId: string,
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: browserId,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local App',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

/** Seeds one worktree bucket holding the given sessions. */
function seedBrowserSessions(
  snapshots: BrowserSessionSnapshot[],
  liveIds: string[] = snapshots.map((snapshot) => snapshot.id),
): void {
  useBrowserStore.setState({
    worktrees: {
      'project-1/worktree-1': {
        browserOrder: snapshots.map((snapshot) => snapshot.id),
        activeBrowserId: snapshots[0]?.id ?? null,
        browsers: Object.fromEntries(
          snapshots.map((snapshot) => [snapshot.id, snapshot]),
        ),
        live: new Set(liveIds),
        hydrated: true,
      },
    },
  });
}

describe('browser tab identity (label / favicon / tooltip)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useBrowserStore.setState({ worktrees: {} });
  });

  it('resolves the label as trimmed page title → URL → Browser', () => {
    seedBrowserSessions([
      browserSnapshot('b1', { title: '  Local App  ' }),
      browserSnapshot('b2', { title: '   ', url: 'http://localhost:4000/' }),
      browserSnapshot('b3', { title: '', url: '' }),
    ]);
    act(() => {
      root.render(
        <>
          <span data-testid="l1">
            {renderPanelTabLabel(boundBrowserPanelTab('b1'))}
          </span>
          <span data-testid="l2">
            {renderPanelTabLabel(boundBrowserPanelTab('b2'))}
          </span>
          <span data-testid="l3">
            {renderPanelTabLabel(boundBrowserPanelTab('b3'))}
          </span>
        </>,
      );
    });
    expect(container.querySelector('[data-testid="l1"]')?.textContent).toBe(
      'Local App',
    );
    expect(container.querySelector('[data-testid="l2"]')?.textContent).toBe(
      'http://localhost:4000/',
    );
    expect(container.querySelector('[data-testid="l3"]')?.textContent).toBe(
      'Browser',
    );
  });

  it('getTabTitle exposes the full live title for accessible names', () => {
    seedBrowserSessions([browserSnapshot('b1', { title: 'Full Page Title' })]);
    expect(panelTabDisplayTitle(boundBrowserPanelTab('b1'))).toBe(
      'Full Page Title',
    );
    // Unknown session degrades to the plain kind title.
    expect(panelTabDisplayTitle(boundBrowserPanelTab('missing'))).toBe(
      'Browser',
    );
  });

  it('renders the favicon when present, the globe when missing, and resets error state on change', () => {
    seedBrowserSessions([
      browserSnapshot('b1', { faviconUrl: 'https://x.test/favicon.ico' }),
    ]);
    act(() => {
      root.render(<>{renderPanelTabIcon(boundBrowserPanelTab('b1'))}</>);
    });
    const favicon = container.querySelector(
      '[data-testid="panel-tab-browser-favicon-b1"]',
    );
    expect(favicon).not.toBeNull();
    expect(favicon?.getAttribute('src')).toBe('https://x.test/favicon.ico');

    // Broken favicon → never a broken image; fail closed to the globe.
    act(() => {
      favicon?.dispatchEvent(new Event('error', { bubbles: false }));
    });
    expect(
      container.querySelector('[data-testid="panel-tab-browser-favicon-b1"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="panel-tab-browser-globe-b1"]'),
    ).not.toBeNull();

    // A NEW favicon source resets the error latch and renders again.
    act(() => {
      seedBrowserSessions([
        browserSnapshot('b1', { faviconUrl: 'https://x.test/next.ico' }),
      ]);
    });
    expect(
      container
        .querySelector('[data-testid="panel-tab-browser-favicon-b1"]')
        ?.getAttribute('src'),
    ).toBe('https://x.test/next.ico');
  });

  it('renders the globe for sessions without a favicon', () => {
    seedBrowserSessions([browserSnapshot('b1')]);
    act(() => {
      root.render(<>{renderPanelTabIcon(boundBrowserPanelTab('b1'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-browser-globe-b1"]'),
    ).not.toBeNull();
  });

  it('renders one rich-tooltip row: globe + `Browser · title`', () => {
    seedBrowserSessions([
      browserSnapshot('b1', {
        title: 'A very long page title that stays on one tooltip line',
      }),
    ]);
    act(() => {
      root.render(<>{renderPanelTabTooltip(boundBrowserPanelTab('b1'))}</>);
    });
    const tooltip = container.querySelector(
      '[data-testid="panel-tab-browser-tooltip-b1"]',
    );
    expect(tooltip).not.toBeNull();
    expect(
      tooltip?.querySelector('.canopy-panel-tab-rich-tooltip-title')
        ?.textContent,
    ).toBe('A very long page title that stays on one tooltip line');
    expect(
      tooltip?.querySelector('.canopy-panel-tab-rich-tooltip-subtitle')
        ?.textContent,
    ).toBe('Browser');
    expect(
      tooltip?.querySelector('.canopy-panel-tab-rich-tooltip-separator')
        ?.textContent,
    ).toBe(' · ');
    expect(tooltip?.textContent).toBe(
      'Browser · A very long page title that stays on one tooltip line',
    );
    expect(
      tooltip?.querySelector('.canopy-panel-tab-rich-tooltip-subtitle svg'),
    ).not.toBeNull();
  });

  it('returns null tooltips for non-browser kinds (simple tooltip retained)', () => {
    expect(renderPanelTabTooltip(untitledTab('terminal'))).toBeNull();
    expect(renderPanelTabTooltip(untitledTab('chat'))).toBeNull();
    expect(renderPanelTabTooltip(untitledTab('browser'))).toBeNull();
  });
});

describe('renderPanelTabTrailing browser loading dot (per-browser)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useBrowserStore.setState({ worktrees: {} });
  });

  it('shows the activity dot only for the EXACT loading browser', () => {
    seedBrowserSessions([
      browserSnapshot('b1', { loading: true }),
      browserSnapshot('b2', { loading: false }),
    ]);
    act(() => {
      root.render(
        <>
          {renderPanelTabTrailing(boundBrowserPanelTab('b1'))}
          {renderPanelTabTrailing(boundBrowserPanelTab('b2'))}
        </>,
      );
    });
    const dot = container.querySelector(
      '[data-testid="panel-tab-browser-loading-b1"]',
    );
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('Loading');
    // Another browser's loading never lights up an unrelated tab.
    expect(
      container.querySelector('[data-testid="panel-tab-browser-loading-b2"]'),
    ).toBeNull();
  });

  it('renders no dot while the session is still being set up', () => {
    seedBrowserSessions([browserSnapshot('b1', { loading: true })]);
    useBrowserStore.setState({ openingBrowserIds: { b1: true } });
    try {
      act(() => {
        root.render(<>{renderPanelTabTrailing(boundBrowserPanelTab('b1'))}</>);
      });
      expect(
        container.querySelector('[data-testid="panel-tab-browser-loading-b1"]'),
      ).toBeNull();

      // Once the session exists, its page load shows the dot as usual.
      act(() => {
        useBrowserStore.setState({ openingBrowserIds: {} });
      });
      expect(
        container.querySelector('[data-testid="panel-tab-browser-loading-b1"]'),
      ).not.toBeNull();
    } finally {
      useBrowserStore.setState({ openingBrowserIds: {} });
    }
  });

  it('renders no dot for a loading session without a live view (restored/inert)', () => {
    seedBrowserSessions([browserSnapshot('b1', { loading: true })], []);
    act(() => {
      root.render(<>{renderPanelTabTrailing(boundBrowserPanelTab('b1'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-browser-loading-b1"]'),
    ).toBeNull();
  });
});

describe('renderPanelCollapsedTabIcon activity tint', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('tints and pulses the collapsed terminal icon while running', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(true);
    act(() => {
      root.render(<>{renderPanelCollapsedTabIcon(untitledTab('terminal'))}</>);
    });
    const active = container.querySelector(
      '[data-testid="panel-collapsed-terminal-active"]',
    );
    expect(active).not.toBeNull();
    expect(active?.className).toContain('animate-pulse');
    expect(active?.className).toContain('fg-info');
  });

  it('reads collapsed terminal activity from the panel owner worktree', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(true);
    act(() => {
      root.render(
        <PanelWorktreeContext.Provider
          value={{ projectId: 'owner-project', worktreeId: 'owner-worktree' }}
        >
          {renderPanelCollapsedTabIcon(untitledTab('terminal'))}
        </PanelWorktreeContext.Provider>,
      );
    });
    expect(useTerminalActivityStore).toHaveBeenCalled();
    expect(useTerminalRunning).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="panel-collapsed-terminal-active"]',
      ),
    ).not.toBeNull();
  });

  it('renders the plain collapsed terminal icon when idle', () => {
    jest.mocked(useTerminalActivityStore).mockReturnValue(false);
    act(() => {
      root.render(<>{renderPanelCollapsedTabIcon(untitledTab('terminal'))}</>);
    });
    expect(
      container.querySelector(
        '[data-testid="panel-collapsed-terminal-active"]',
      ),
    ).toBeNull();
  });

  it('tints and pulses the collapsed browser icon only while ITS browser loads', () => {
    seedBrowserSessions([
      browserSnapshot('b1', { loading: true }),
      browserSnapshot('b2', { loading: false }),
    ]);
    act(() => {
      root.render(
        <>
          {renderPanelCollapsedTabIcon(boundBrowserPanelTab('b1'))}
          {renderPanelCollapsedTabIcon(boundBrowserPanelTab('b2'))}
        </>,
      );
    });
    const active = container.querySelector(
      '[data-testid="panel-collapsed-browser-active-b1"]',
    );
    expect(active).not.toBeNull();
    expect(active?.className).toContain('animate-pulse');
    expect(active?.className).toContain('fg-info');
    // Another browser's loading may not make this one pulse.
    expect(
      container.querySelector(
        '[data-testid="panel-collapsed-browser-active-b2"]',
      ),
    ).toBeNull();
    // The collapsed icon shares the favicon/globe treatment.
    expect(
      container.querySelector('[data-testid="panel-tab-browser-globe-b2"]'),
    ).not.toBeNull();
  });
});

describe('panel chat tab unread indicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ worktreeChats: {} });
  });

  function bindChatTab(tab: ChatTab): void {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
  }

  it('marks the leading provider icon with the unread testid when unread', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', unread: true }));
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    const icon = container.querySelector(
      '[data-testid="panel-tab-unread-chat-1"]',
    );
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-unread')).toBe('true');
    expect(icon?.getAttribute('aria-label')).toBe('Unread chat tab');
    expect(icon?.getAttribute('title')).toBe('Unread chat tab');
    expect(icon?.querySelector('.fg-info')).not.toBeNull();
    expect(icon?.querySelector('.fg-warning')).toBeNull();
  });

  it('keeps the unread hook on the leading icon while streaming', () => {
    bindChatTab(
      makeChatTab({ id: 'chat-1', status: 'streaming', unread: true }),
    );
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    const icon = container.querySelector(
      '[data-testid="panel-tab-unread-chat-1"]',
    );
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-unread')).toBe('true');
    expect(icon?.getAttribute('aria-label')).toBe('Unread chat tab');
    expect(icon?.querySelector('.fg-info')).not.toBeNull();
    expect(icon?.querySelector('.fg-warning')).toBeNull();
  });

  it('keeps the unread hook on the leading icon while awaiting approval', () => {
    bindChatTab(
      makeChatTab({ id: 'chat-1', pendingPlanExit: {}, unread: true }),
    );
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    const icon = container.querySelector(
      '[data-testid="panel-tab-unread-chat-1"]',
    );
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-unread')).toBe('true');
    expect(icon?.getAttribute('aria-label')).toBe('Unread chat tab');
    expect(icon?.querySelector('.fg-info')).not.toBeNull();
    expect(icon?.querySelector('.fg-warning')).toBeNull();
  });

  it('omits the unread testid on the icon when the tab is read', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', unread: false }));
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-unread-chat-1"]'),
    ).toBeNull();
  });

  it('uses a neutral chat icon when provider metadata is not available yet', () => {
    bindChatTab(
      makeChatTab({
        id: 'chat-1',
        model: undefined,
        providerType: undefined,
      }),
    );
    useChatStore.setState({ modelDefaults: null });

    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });

    expect(
      container.querySelector(
        'svg[data-app-icon="true"].shrink-0.fg-secondary',
      ),
    ).not.toBeNull();
    expect(container.querySelector('path[d^="m3.127 10.604"]')).toBeNull();
  });

  it('uses a neutral chat icon for stale persisted model ids', () => {
    bindChatTab(
      makeChatTab({
        id: 'chat-1',
        model: 'retired-model',
        providerType: undefined,
      }),
    );
    useChatStore.setState({ modelDefaults: null });

    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });

    expect(
      container.querySelector(
        'svg[data-app-icon="true"].shrink-0.fg-secondary',
      ),
    ).not.toBeNull();
    expect(container.querySelector('path[d^="m3.127 10.604"]')).toBeNull();
  });

  it('renders no separate trailing unread dot for an unread chat tab', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', unread: true }));
    act(() => {
      root.render(<>{renderPanelTabTrailing(boundChatPanelTab('chat-1'))}</>);
    });
    // The unread state lives on the leading icon now; the trailing seam must
    // not re-introduce the redundant dot.
    expect(
      container.querySelector('[data-testid="panel-tab-unread-chat-1"]'),
    ).toBeNull();
    expect(container.querySelector('.bg-warning')).toBeNull();
  });

  // A `fill` tab bar (early access): the leading icon is only the provider
  // glyph or the spinner, and the states sit on the tab's right.
  describe('in a fill tab bar', () => {
    // Renders inside a fill tab bar's style, as the bar provides it.
    function inFillBar(node: ReactNode): JSX.Element {
      return <PanelTabStyleProvider value="fill">{node}</PanelTabStyleProvider>;
    }

    function renderIconAndTrailing(): void {
      act(() => {
        root.render(
          inFillBar(
            <>
              {renderPanelTabIcon(boundChatPanelTab('chat-1'))}
              {renderPanelTabTrailing(boundChatPanelTab('chat-1'))}
            </>,
          ),
        );
      });
    }

    it('keeps the unread hook on the leading icon and shows a dot on the right', () => {
      bindChatTab(makeChatTab({ id: 'chat-1', unread: true }));
      renderIconAndTrailing();
      const icon = container.querySelector(
        '[data-testid="panel-tab-unread-chat-1"]',
      );
      expect(icon?.getAttribute('data-unread')).toBe('true');
      expect(icon?.getAttribute('aria-label')).toBe('Unread chat tab');
      // A dot on the tab's right, not a tinted icon.
      expect(icon?.querySelector('.fg-info')).toBeNull();
      expect(
        container
          .querySelector('[data-testid="panel-tab-unread-dot-chat-1"]')
          ?.classList.contains('bg-fg-info'),
      ).toBe(true);
    });

    it('shows a plan waiting for review as the orange needs-input dot', () => {
      bindChatTab(
        makeChatTab({ id: 'chat-1', pendingPlanExit: {}, unread: true }),
      );
      renderIconAndTrailing();
      const dot = container.querySelector(
        '[data-testid="panel-tab-plan-review-chat-1"]',
      );
      expect(dot?.getAttribute('aria-label')).toBe('Plan waiting for review');
      expect(dot?.classList.contains('bg-fg-warning')).toBe(true);
      // The leading icon stays the provider glyph, with the unread hook.
      expect(
        container
          .querySelector('[data-testid="panel-tab-unread-chat-1"]')
          ?.querySelector('.fg-info'),
      ).toBeNull();
    });

    it('shows a tool approval as the same dot on the right', () => {
      bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle' }));
      try {
        act(() => {
          useChatStore.setState({
            pendingApprovals: {
              r1: {
                requestId: 'r1',
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                chatId: 'chat-1',
                provider: 'claude',
                title: 'Run tests',
                details: { kind: 'command', command: 'npm test' },
              },
            },
          });
        });
        act(() => {
          root.render(
            inFillBar(
              <>{renderPanelTabTrailing(boundChatPanelTab('chat-1'))}</>,
            ),
          );
        });
        expect(
          container
            .querySelector('[data-testid="panel-tab-tool-approval-chat-1"]')
            ?.classList.contains('bg-fg-warning'),
        ).toBe(true);
      } finally {
        act(() => {
          useChatStore.setState({ pendingApprovals: {} });
        });
      }
    });

    it('lets the provider glyph inherit the tab ink', () => {
      bindChatTab(
        makeChatTab({
          id: 'chat-1',
          model: undefined,
          providerType: undefined,
        }),
      );
      useChatStore.setState({ modelDefaults: null });
      act(() => {
        root.render(
          inFillBar(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>),
        );
      });
      const glyph = container.querySelector(
        'svg[data-app-icon="true"].shrink-0',
      );
      expect(glyph).not.toBeNull();
      expect(glyph?.getAttribute('class') ?? '').not.toMatch(/\bfg-/);
    });

    it('shows the read-only lock as the 14px app glyph', () => {
      bindChatTab(makeChatTab({ id: 'chat-1', readOnly: true }));
      act(() => {
        root.render(
          inFillBar(<>{renderPanelTabTrailing(boundChatPanelTab('chat-1'))}</>),
        );
      });
      const lock = container.querySelector('[aria-label="Read-only"]');
      expect(lock?.getAttribute('title')).toBe('Read-only');
      expect(lock?.querySelector('svg')?.style.width).toBe('14px');
    });

    it('keeps the classic icon states outside a fill tab bar (a collapsed strip)', () => {
      bindChatTab(makeChatTab({ id: 'chat-1', pendingPlanExit: {} }));
      act(() => {
        // The collapsed icon strip draws the icon with no tab bar around it.
        root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
      });
      expect(container.querySelector('svg')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="panel-tab-plan-review-chat-1"]'),
      ).toBeNull();
    });
  });
});

describe('panel chat tab question marker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({
      worktreeChats: {},
      pendingQuestions: {},
      pendingApprovals: {},
    });
  });

  function bindChatTab(tab: ChatTab): void {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
  }

  function setQuestions(
    entries: { requestId: string; chatId?: string; answeredAt?: number }[],
  ): void {
    act(() => {
      useChatStore.setState({
        pendingQuestions: Object.fromEntries(
          entries.map(({ requestId, chatId = 'chat-1', answeredAt }) => [
            requestId,
            {
              requestId,
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId,
              questions: [],
              ...(answeredAt === undefined ? {} : { answeredAt }),
            },
          ]),
        ),
      });
    });
  }

  function marker(): Element | null {
    return container.querySelector('[data-testid="panel-tab-question-chat-1"]');
  }

  function renderClassic(): void {
    act(() => {
      root.render(
        <>
          {renderPanelTabIcon(boundChatPanelTab('chat-1'))}
          {renderPanelTabTrailing(boundChatPanelTab('chat-1'))}
        </>,
      );
    });
  }

  function renderFill(): void {
    act(() => {
      root.render(
        <PanelTabStyleProvider value="fill">
          {renderPanelTabIcon(boundChatPanelTab('chat-1'))}
          {renderPanelTabTrailing(boundChatPanelTab('chat-1'))}
          {renderPanelTabAttention(boundChatPanelTab('chat-1'))}
        </PanelTabStyleProvider>,
      );
    });
  }

  it("shows the marker in a classic tab's leading slot, over the working spinner", () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'streaming' }));
    setQuestions([{ requestId: 'q1' }]);
    renderClassic();
    expect(marker()?.getAttribute('role')).toBe('img');
    expect(marker()?.getAttribute('aria-label')).toBe('Question waiting');
    expect(container.querySelector(`[${PANEL_TAB_BUSY_ATTRIBUTE}]`)).toBeNull();
    // The classic leading slot is hidden from assistive technology, so the
    // trailing seam names the question once.
    expect(
      container.querySelector('[data-testid="panel-tab-question-label-chat-1"]')
        ?.textContent,
    ).toBe('Question waiting');
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it('outranks a tool approval and a plan review in a classic tab', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', pendingPlanExit: {} }));
    act(() => {
      useChatStore.setState({
        pendingApprovals: {
          r1: {
            requestId: 'r1',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            provider: 'claude',
            title: 'Run tests',
            details: { kind: 'command', command: 'npm test' },
          },
        },
      });
    });
    setQuestions([{ requestId: 'q1' }]);
    renderClassic();
    expect(marker()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="panel-tab-tool-approval-chat-1"]'),
    ).toBeNull();
  });

  it("shows one marker on a fill tab's right in place of the needs-input dots", () => {
    bindChatTab(
      makeChatTab({
        id: 'chat-1',
        status: 'streaming',
        pendingPlanExit: {},
        unread: true,
      }),
    );
    setQuestions([{ requestId: 'q1' }]);
    renderFill();
    expect(
      container.querySelectorAll('[data-testid^="panel-tab-question-chat-1"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="panel-tab-plan-review-chat-1"]'),
    ).toBeNull();
    // Unread stays its own indicator; no busy spinner while the question waits.
    expect(
      container.querySelector('[data-testid="panel-tab-unread-dot-chat-1"]'),
    ).not.toBeNull();
    expect(container.querySelector(`[${PANEL_TAB_BUSY_ATTRIBUTE}]`)).toBeNull();
  });

  it('keeps the marker until the last question is answered', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', pendingPlanExit: {} }));
    setQuestions([{ requestId: 'q1' }, { requestId: 'q2' }]);
    renderFill();
    expect(marker()).not.toBeNull();

    setQuestions([{ requestId: 'q1', answeredAt: 1 }, { requestId: 'q2' }]);
    expect(marker()).not.toBeNull();

    setQuestions([
      { requestId: 'q1', answeredAt: 1 },
      { requestId: 'q2', answeredAt: 2 },
    ]);
    expect(marker()).toBeNull();
    // The next applicable state returns.
    expect(
      container.querySelector('[data-testid="panel-tab-plan-review-chat-1"]'),
    ).not.toBeNull();
  });

  it('ignores questions from other chats or worktrees', () => {
    bindChatTab(makeChatTab({ id: 'chat-1' }));
    setQuestions([{ requestId: 'q1', chatId: 'chat-2' }]);
    act(() => {
      useChatStore.setState((state) => ({
        pendingQuestions: {
          ...state.pendingQuestions,
          q3: {
            requestId: 'q3',
            projectId: 'project-1',
            worktreeId: 'worktree-2',
            chatId: 'chat-1',
            questions: [],
          },
        },
      }));
    });
    renderClassic();
    expect(marker()).toBeNull();
  });
});

describe('panel chat tab busy marker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ worktreeChats: {} });
  });

  function bindChatTab(tab: ChatTab): void {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
  }

  function busyMarker(): Element | null {
    return container.querySelector(`[${PANEL_TAB_BUSY_ATTRIBUTE}]`);
  }

  it('marks the streaming leading icon busy so hovering keeps the spinner', () => {
    // The tab bar hides the leading icon on hover and reveals the close button
    // in that same slot. A streaming tab opts out of that swap through this
    // marker, so the live spinner survives the hover.
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'streaming' }));
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    expect(busyMarker()).not.toBeNull();
    expect(busyMarker()?.getAttribute(PANEL_TAB_BUSY_ATTRIBUTE)).toBe('true');
  });

  it('keeps the busy marker on the same node as the unread hook', () => {
    bindChatTab(
      makeChatTab({ id: 'chat-1', status: 'streaming', unread: true }),
    );
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    expect(
      container
        .querySelector('[data-testid="panel-tab-unread-chat-1"]')
        ?.getAttribute(PANEL_TAB_BUSY_ATTRIBUTE),
    ).toBe('true');
  });

  it('omits the busy marker when the tab is idle', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle' }));
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    expect(busyMarker()).toBeNull();
  });

  it('shows the background spinner for an idle chat with live delegates', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle' }));
    try {
      act(() => {
        useDelegationActivityStore.getState().applyActivity({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          live: 0,
          queued: 1,
        });
      });
      act(() => {
        root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
      });
      // Delegates block close, so the busy marker still withholds it.
      expect(busyMarker()).not.toBeNull();
      // The only spinner is the quiet background glyph.
      const glyph = container.querySelector(
        '[role="img"][aria-label="1 background task running"]',
      );
      expect(glyph?.querySelector('[aria-label="Thinking"]')).toBeInstanceOf(
        HTMLElement,
      );
      expect(
        container.querySelectorAll('[aria-label="Thinking"]'),
      ).toHaveLength(1);

      // Back to the idle icon once the delegates finish.
      act(() => {
        useDelegationActivityStore.getState().applyActivity({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          live: 0,
          queued: 0,
        });
      });
      expect(busyMarker()).toBeNull();
    } finally {
      resetDelegationActivityStoreForTests();
    }
  });

  it("keeps an unread chat's unread ink on its background spinner", () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle', unread: true }));
    try {
      act(() => {
        useLiveBackgroundTaskStore.getState().applyPush({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sessionActive: true,
          liveTasks: [{ taskId: 'dev-server', taskType: 'local_bash' }],
        });
      });
      act(() => {
        root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
      });
      const spinner = container
        .querySelector('[role="img"][aria-label="1 background task running"]')
        ?.querySelector('[aria-label="Thinking"]');
      expect(spinner).toBeInstanceOf(HTMLElement);
      expect(spinner?.className).toContain(
        OPERATIONAL_STATUS_COLORS.unread.foreground,
      );
    } finally {
      resetLiveBackgroundTaskStoreForTests();
    }
  });

  it('shows a shell-only chat as background work without withholding close', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle' }));
    try {
      act(() => {
        useLiveBackgroundTaskStore.getState().applyPush({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          sessionActive: true,
          liveTasks: [{ taskId: 'dev-server', taskType: 'local_bash' }],
        });
      });
      act(() => {
        root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
      });
      expect(
        container.querySelector('[aria-label="1 background task running"]'),
      ).not.toBeNull();
      // Shells don't block close (D8).
      expect(busyMarker()).toBeNull();
    } finally {
      resetLiveBackgroundTaskStoreForTests();
    }
  });

  it('keeps the approval glyph over the delegate spinner while a prompt waits', () => {
    bindChatTab(makeChatTab({ id: 'chat-1', status: 'idle' }));
    try {
      act(() => {
        useDelegationActivityStore.getState().applyActivity({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          live: 1,
          queued: 0,
        });
        useChatStore.setState({
          pendingApprovals: {
            r1: {
              requestId: 'r1',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              provider: 'claude',
              title: 'Run tests',
              details: { kind: 'command', command: 'npm test' },
            },
          },
        });
      });
      act(() => {
        root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
      });
      expect(busyMarker()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="panel-tab-tool-approval-chat-1"]',
        ),
      ).not.toBeNull();
    } finally {
      useChatStore.setState({ pendingApprovals: {} });
      resetDelegationActivityStoreForTests();
    }
  });

  it('omits the busy marker while awaiting plan approval', () => {
    // Plan approval replaces the spinner with a static glyph — no live work is
    // running, so the tab keeps the ordinary hover close-swap.
    bindChatTab(
      makeChatTab({ id: 'chat-1', status: 'streaming', pendingPlanExit: {} }),
    );
    act(() => {
      root.render(<>{renderPanelTabIcon(boundChatPanelTab('chat-1'))}</>);
    });
    expect(busyMarker()).toBeNull();
  });
});

describe('renderPanelTabTrailing file dirty marker (shared session)', () => {
  const DESKTOP_CAPS: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: false,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
  };
  const REQUEST = {
    projectId: 'p',
    worktreeId: 'w',
    fileRootLocalId: 'repo-1',
    relativePath: 'src/a.ts',
  };

  function makeClient(): CanopyClient {
    const filePreview: QueryMap['file.read']['result'] = {
      workspaceLocalId: 'p',
      worktreeLocalId: 'w',
      fileRootLocalId: 'repo-1',
      path: 'src/a.ts',
      content: 'baseline',
      size: 8,
      version: 'v1',
      truncated: false,
      modifiedAt: '2026-07-01T00:00:00.000Z',
    };
    return {
      capabilities: DESKTOP_CAPS,
      query: jest.fn().mockResolvedValue(filePreview),
      command<K extends CommandName>(name: K): Promise<never> {
        return Promise.reject(new Error(`no command responder for ${name}`));
      },
      subscribe(): Unsubscribe {
        return (): void => {};
      },
    };
  }

  function boundFilePanelTab(fileTabId: string): PanelTabModel {
    return {
      panelId: 'panel-file',
      kind: 'file-diff',
      title: 'a.ts',
      instance: { fileTabId },
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  let detach: () => void;
  let store: ReturnType<typeof createFileViewerStore>;
  let fileKey: string;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    store = createFileViewerStore(makeClient());
    detach = desktopFileSessionController.attachStore(store, {
      onSaveCommitted: () => {},
    });
    fileKey = desktopFileSessionController.registerTab('file-1', REQUEST);
    await store.getState().openFile(REQUEST);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    desktopFileSessionController.releaseTab('file-1');
    detach();
  });

  it('shows and hides the panel-tab-dirty marker with the shared session dirty state', () => {
    act(() => {
      store.getState().updateContent(fileKey, 'edited');
    });
    act(() => {
      root.render(<>{renderPanelTabTrailing(boundFilePanelTab('file-1'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-dirty-file-1"]'),
    ).not.toBeNull();

    // Reverting exactly to the preview content clears the projection.
    act(() => {
      store.getState().updateContent(fileKey, 'baseline');
    });
    act(() => {
      root.render(<>{renderPanelTabTrailing(boundFilePanelTab('file-1'))}</>);
    });
    expect(
      container.querySelector('[data-testid="panel-tab-dirty-file-1"]'),
    ).toBeNull();
  });
});
