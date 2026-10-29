/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PANEL_KINDS } from '@canopy/protocol';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { PANEL_KIND_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import type { PanelContentProps } from '@canopy/ui-shared/panels';
import {
  DESKTOP_PANEL_DEFINITIONS,
  getPanelDefinition,
  listAddablePanels,
  renderPanelContent,
} from '../registry';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { WorktreeChatSurface } from '@/components/chat/WorktreeChatSurface';
import { DesktopSharedFileViewer } from '@/components/chat/DesktopSharedFileViewer';
import { TerminalPanelSurface } from '@/components/terminal/TerminalPanelSurface';
import { SharedActivityPanelAdapter } from '@/components/activity/SharedActivityPanelAdapter';
import { ACTIVITY_SECTIONS } from '@/components/activity/activity-sections';
import { FilesTreeTab } from '@/components/activity/FilesTreeTab';
import { BrowserPanelSurface } from '@/components/browser/BrowserPanelSurface';
import {
  PlanDiagramPanelHost,
  PlanPanelHost,
} from '@/components/plan-explore/PlanPanelHost';
import { DesktopSubagentsPanelHost } from '@/components/subagents/DesktopSubagentsPanelHost';
import { DesktopSubagentChatPanelHost } from '@/components/subagents/DesktopSubagentChatPanelHost';
import {
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { PanelWorktreeContext } from '../panel-worktree-context';
import {
  DEFAULT_PANEL_HOST_STATE,
  PanelHostContext,
  type PanelHostState,
} from '../panel-host-context';

// Isolate the registry wrappers from the heavy real components (Slate, xterm,
// native browser panes): each stub renders a stable test id and lets the test
// assert the props the wrapper wired up, mirroring the sibling
// FileViewerPanelHost.test.tsx pattern.
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
// Stub the section registration source: real ids/titles for two
// representative sections, light render stubs that surface the threaded
// worktree binding. Keeps the heavy section containers (MCP detection,
// dispatch modal, diff viewer) out of this suite.
jest.mock('@/components/activity/activity-sections', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  const sections = [
    {
      id: 'summary',
      title: 'Summary',
      render: jest.fn(
        (props: { projectId: string; worktreeId: string }): unknown =>
          react.createElement('div', {
            'data-testid': 'mock-section-summary',
            'data-project-id': props.projectId,
            'data-worktree-id': props.worktreeId,
          }),
      ),
    },
    {
      id: 'changed-files',
      title: 'Changed Files',
      render: jest.fn((): unknown =>
        react.createElement('div', {
          'data-testid': 'mock-section-changed-files',
        }),
      ),
    },
  ];
  return {
    ACTIVITY_SECTIONS: sections,
    getActivitySectionDefinition: (sectionId: string): unknown =>
      sections.find((section) => section.id === sectionId),
    getActivitySectionsForSurface: (): unknown => sections,
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

const mockPipelinePanelProps = jest.fn();
jest.mock('@/components/panels/pipeline/PipelineExecutionPanel', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PipelineExecutionPanel: (props: Record<string, unknown>): unknown => {
      mockPipelinePanelProps(props);
      return react.createElement('div', {
        'data-testid': 'mock-pipeline-panel',
      });
    },
  };
});

jest.mock('@/components/plan-explore/PlanPanelHost', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PlanPanelHost: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-plan-panel-host' }),
    ),
    PlanDiagramPanelHost: jest.fn((): unknown =>
      react.createElement('div', {
        'data-testid': 'mock-plan-diagram-panel-host',
      }),
    ),
  };
});

jest.mock('@/components/subagents/DesktopSubagentsPanelHost', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    DesktopSubagentsPanelHost: jest.fn((): unknown =>
      react.createElement('div', {
        'data-testid': 'mock-subagents-panel-host',
      }),
    ),
  };
});

jest.mock('@/components/subagents/DesktopSubagentChatPanelHost', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    DesktopSubagentChatPanelHost: jest.fn((): unknown =>
      react.createElement('div', {
        'data-testid': 'mock-subagent-chat-panel-host',
      }),
    ),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/**
 * Overrides `document.visibilityState` and announces it, the way a minimized
 * window reports itself. Returns a restore that announces the reset.
 */
function forceDocumentVisibility(state: 'visible' | 'hidden'): () => void {
  act(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return (): void => {
    act(() => {
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
}

const NON_BROWSER_KINDS = [
  'chat',
  'file-diff',
  'terminal',
  'activity-section',
  'file-explorer',
  'activity-card',
  'pipeline-execution',
  'plan',
  'plan-diagram',
  'subagents',
  'subagent-chat',
  'cost',
  'session-breakdown',
];

function contentProps(
  kind: string,
  overrides: Partial<PanelContentProps> = {},
): PanelContentProps {
  return {
    panelId: `panel-${kind}`,
    kind,
    isActive: true,
    isVisible: true,
    ...overrides,
  };
}

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
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

function selectWorktree(): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    worktreeChats: {
      'project-1/worktree-1': {
        activeTabId: 'chat-1',
        tabs: [makeTab()],
      },
    },
  });
}

describe('desktop panel content registry', () => {
  let container: HTMLDivElement;
  let root: Root;
  const loadTabsForTarget = jest.fn(() => Promise.resolve());

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      selectedWorktree: null,
      worktreeChats: {},
      loadTabsForTarget,
    });
    useCurrentUiStateStore.setState({ slices: {} });
    useFileTabUiStore.setState({
      fileTreeVisibleByTabId: {},
      fileTreeModeByTabId: {},
      fileTreeRevealedPathByTabId: {},
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    setTestEarlyAccessFeatures({ enabled: false });
  });

  function renderKind(
    props: PanelContentProps,
    hostState: PanelHostState = DEFAULT_PANEL_HOST_STATE,
  ): void {
    act(() => {
      root.render(
        <PanelHostContext.Provider value={hostState}>
          {renderPanelContent(props)}
        </PanelHostContext.Provider>,
      );
    });
  }

  /** Renders inside an async act so lazily loaded hosts resolve first. */
  async function renderSettled(node: ReactNamespace.ReactNode): Promise<void> {
    await act(async () => {
      root.render(node);
      await Promise.resolve();
    });
  }

  describe('definitions', () => {
    it('registers a coherent definition for every wire panel kind', () => {
      for (const kind of PANEL_KINDS) {
        const definition = DESKTOP_PANEL_DEFINITIONS[kind];
        expect(definition).toBeDefined();
        expect(definition.kind).toBe(kind);
        expect(definition.title.length).toBeGreaterThan(0);
        expect(definition.icon).toBeDefined();
        expect(typeof definition.canPopOut).toBe('boolean');
        expect(typeof definition.isWindowBound).toBe('boolean');
        // Window-bound content must never be poppable.
        if (definition.isWindowBound) {
          expect(definition.canPopOut).toBe(false);
        }
        expect(getPanelDefinition(kind)).toBe(definition);
      }
      expect(Object.keys(DESKTOP_PANEL_DEFINITIONS).sort()).toEqual(
        [...PANEL_KINDS].sort(),
      );
    });

    it('draws the diagram glyph for diagram kinds without a Labs opt-in', () => {
      // The connected-nodes glyph (`ChangeDiagramIcon`).
      const connectorsGlyph = 'data-glyph="network"';
      for (const kind of ['change-diagram', 'plan-diagram'] as const) {
        act(() => {
          setTestEarlyAccessFeatures({ enabled: false });
          root.render(DESKTOP_PANEL_DEFINITIONS[kind].icon);
        });
        expect(container.querySelector('svg')).not.toBeNull();
        expect(container.innerHTML).toContain(connectorsGlyph);
        act(() => {
          setTestEarlyAccessFeatures({
            enabled: true,
            hydrated: true,
          });
        });
        expect(container.innerHTML).toContain(connectorsGlyph);
      }
    });

    it('marks browser window-bound and not poppable; all other kinds poppable', () => {
      expect(DESKTOP_PANEL_DEFINITIONS.browser.canPopOut).toBe(false);
      expect(DESKTOP_PANEL_DEFINITIONS.browser.isWindowBound).toBe(true);
      for (const kind of NON_BROWSER_KINDS) {
        const definition = getPanelDefinition(
          PANEL_KINDS.find((candidate) => candidate === kind) ?? 'chat',
        );
        expect(definition.canPopOut).toBe(true);
        expect(definition.isWindowBound).toBe(false);
      }
    });
  });

  describe('browser add-menu gating', () => {
    const worktreeKey = 'project-1/worktree-browser';
    const browserEntries = (): unknown[] =>
      listAddablePanels(worktreeKey, false, false, false).filter(
        (entry) => entry.kind === 'browser',
      );

    it('offers Browser in a window that shows this computer', () => {
      expect(browserEntries()).toHaveLength(1);
    });

    it('does not offer Browser in a window that shows another computer', () => {
      const hadApi = Object.prototype.hasOwnProperty.call(window, 'api');
      const api: unknown = Reflect.get(window, 'api');
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...(typeof api === 'object' ? api : {}),
          remoteControl: {
            getContext: (): unknown => ({
              mode: 'remote',
              deviceId: 'device-b',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      });
      try {
        expect(browserEntries()).toEqual([]);
      } finally {
        if (hadApi) {
          Object.defineProperty(window, 'api', {
            configurable: true,
            value: api,
          });
        } else {
          Reflect.deleteProperty(window, 'api');
        }
      }
    });
  });

  describe('cost panel definitions and add-menu gating', () => {
    it('registers Cost as a singleton and Session breakdown as a repeatable panel', () => {
      expect(DESKTOP_PANEL_DEFINITIONS.cost.title).toBe('Cost');
      expect(DESKTOP_PANEL_DEFINITIONS.cost.singleton).toBe(true);
      expect(DESKTOP_PANEL_DEFINITIONS.cost.canPopOut).toBe(true);
      expect(DESKTOP_PANEL_DEFINITIONS.cost.isWindowBound).toBe(false);
      expect(DESKTOP_PANEL_DEFINITIONS['session-breakdown'].title).toBe(
        'Session breakdown',
      );
      expect(DESKTOP_PANEL_DEFINITIONS['session-breakdown'].singleton).toBe(
        false,
      );
      expect(DESKTOP_PANEL_DEFINITIONS['session-breakdown'].canPopOut).toBe(
        true,
      );
      expect(DESKTOP_PANEL_DEFINITIONS['session-breakdown'].isWindowBound).toBe(
        false,
      );
    });

    it('offers both kinds with Early access off and deduplicates each binding', () => {
      const worktreeKey = 'project-1/worktree-1';
      const store = usePanelLayoutStore.getState();
      store.initializeLayout(worktreeKey, {
        orientation: 'horizontal',
        groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-chat' }],
        containerSize: { width: 800, height: 600 },
      });
      useChatStore.setState({
        worktreeChats: {
          [worktreeKey]: {
            activeTabId: 'chat-1',
            tabs: [
              makeTab({ id: 'chat-1', title: 'First chat' }),
              makeTab({ id: 'chat-2', title: 'Second chat' }),
              makeTab({ id: 'file-1', kind: 'file', title: 'File tab' }),
            ],
          },
        },
      });

      try {
        expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);
        const available = listAddablePanels(worktreeKey, false, false, false);
        expect(available).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'cost', label: 'Cost' }),
            expect.objectContaining({
              kind: 'session-breakdown',
              instance: { chatId: 'chat-1' },
              label: 'First chat',
            }),
            expect.objectContaining({
              kind: 'session-breakdown',
              instance: { chatId: 'chat-2' },
              label: 'Second chat',
            }),
          ]),
        );
        expect(
          available.filter((entry) => entry.kind === 'session-breakdown'),
        ).toHaveLength(2);

        expect(store.addTab(worktreeKey, 'group-a', 'cost')).not.toBeNull();
        expect(
          store.addTab(worktreeKey, 'group-a', 'session-breakdown', {
            instance: { chatId: 'chat-1' },
            title: 'First chat',
          }),
        ).not.toBeNull();
        const afterOpen = listAddablePanels(worktreeKey, false, false, false);
        expect(afterOpen.map((entry) => entry.kind)).not.toContain('cost');
        expect(
          afterOpen
            .filter((entry) => entry.kind === 'session-breakdown')
            .map((entry) => entry.instance?.chatId),
        ).toEqual(['chat-2']);
      } finally {
        store.disposeLayout(worktreeKey);
        useChatStore.setState({ worktreeChats: {} });
      }
    });
  });

  describe('pipeline-execution', () => {
    it('is a repeatable, poppable, non-window-bound kind', () => {
      const definition = DESKTOP_PANEL_DEFINITIONS['pipeline-execution'];
      expect(definition.title).toBe('Pipeline run');
      expect(definition.singleton).toBe(false);
      expect(definition.canPopOut).toBe(true);
      expect(definition.isWindowBound).toBe(false);
    });

    it('mounts nothing and reads no run data until the tab is first shown', async () => {
      const pipelineReads: string[] = [];
      const pipelinesSpy = new Proxy(
        {},
        {
          get: (_target, property): undefined => {
            pipelineReads.push(String(property));
            return undefined;
          },
        },
      );
      Object.defineProperty(window, 'pipelines', {
        configurable: true,
        value: pipelinesSpy,
      });
      try {
        selectWorktree();
        renderKind(
          contentProps('pipeline-execution', {
            isVisible: false,
            instance: { executionId: 'run-1' },
          }),
        );
        await act(async () => {
          await import('@/components/panels/pipeline/PipelineExecutionPanel');
        });

        const frame = container.querySelector(
          '[data-testid="panel-content-pipeline-execution"]',
        );
        expect(frame?.getAttribute('data-panel-id')).toBe(
          'panel-pipeline-execution',
        );
        // A background tab of a restored layout: no host, no reads.
        expect(frame?.childElementCount).toBe(0);
        expect(mockPipelinePanelProps).not.toHaveBeenCalled();
        expect(pipelineReads).toEqual([]);

        renderKind(
          contentProps('pipeline-execution', {
            isVisible: true,
            instance: { executionId: 'run-1' },
          }),
        );
        await act(async () => {
          await import('@/components/panels/pipeline/PipelineExecutionPanel');
        });
        expect(
          container.querySelector('[data-testid="mock-pipeline-panel"]'),
        ).not.toBeNull();
        expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
          expect.objectContaining({
            panelId: 'panel-pipeline-execution',
            executionId: 'run-1',
            owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
            visible: true,
          }),
        );

        // Hidden again, the host stays mounted and is told it is not visible.
        renderKind(
          contentProps('pipeline-execution', {
            isVisible: false,
            instance: { executionId: 'run-1' },
          }),
        );
        expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ visible: false }),
        );
      } finally {
        Reflect.deleteProperty(window, 'pipelines');
      }
    });

    it('owns its run through the panel owner, not the selected worktree', async () => {
      selectWorktree();
      act(() => {
        root.render(
          <PanelWorktreeContext.Provider
            value={{ projectId: 'cowork-1', worktreeId: 'entry-7' }}
          >
            {renderPanelContent(
              contentProps('pipeline-execution', {
                instance: { executionId: 'run-9' },
              }),
            )}
          </PanelWorktreeContext.Provider>,
        );
      });
      await act(async () => {
        await import('@/components/panels/pipeline/PipelineExecutionPanel');
      });
      expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          executionId: 'run-9',
          owner: { projectId: 'cowork-1', worktreeId: 'entry-7' },
        }),
      );
    });

    it.each([
      ['a hidden host page', { hostVisible: false, documentHidden: false }],
      ['a hidden document', { hostVisible: true, documentHidden: true }],
    ])(
      'is not visible behind %s even when its tab is',
      async (_label, { hostVisible, documentHidden }) => {
        selectWorktree();
        const restoreVisibility = documentHidden
          ? forceDocumentVisibility('hidden')
          : (): void => {};
        try {
          renderKind(
            contentProps('pipeline-execution', {
              isVisible: true,
              instance: { executionId: 'run-1' },
            }),
            { ...DEFAULT_PANEL_HOST_STATE, visible: hostVisible },
          );
          await act(async () => {
            await import('@/components/panels/pipeline/PipelineExecutionPanel');
          });
          // Never shown yet, so nothing mounted at all.
          expect(mockPipelinePanelProps).not.toHaveBeenCalled();
        } finally {
          restoreVisibility();
        }
      },
    );

    it('follows its document: hidden suspends and visible resumes', async () => {
      selectWorktree();
      renderKind(
        contentProps('pipeline-execution', {
          instance: { executionId: 'run-1' },
        }),
      );
      await act(async () => {
        await import('@/components/panels/pipeline/PipelineExecutionPanel');
      });
      expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true }),
      );
      const restore = forceDocumentVisibility('hidden');
      try {
        expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ visible: false }),
        );
      } finally {
        restore();
      }
      expect(mockPipelinePanelProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true }),
      );
    });

    it('renders an inline notice for a tab missing its run binding', () => {
      selectWorktree();
      renderKind(contentProps('pipeline-execution'));
      const notice = container.querySelector(
        '[data-testid="panel-pipeline-execution-unbound"]',
      );
      expect(notice?.textContent).toContain('missing its run');
      expect(mockPipelinePanelProps).not.toHaveBeenCalled();
    });
  });

  describe('plan panel definitions', () => {
    it('registers poppable, repeatable plan and plan diagram kinds', () => {
      expect(DESKTOP_PANEL_DEFINITIONS.plan.title).toBe('Plan');
      expect(DESKTOP_PANEL_DEFINITIONS['plan-diagram'].title).toBe(
        'Plan diagram',
      );
      for (const kind of ['plan', 'plan-diagram'] as const) {
        const definition = DESKTOP_PANEL_DEFINITIONS[kind];
        expect(definition.canPopOut).toBe(true);
        expect(definition.isWindowBound).toBe(false);
        expect(definition.singleton).toBe(false);
      }
    });

    it('never offers plan kinds in the generic add-panel catalog', () => {
      const worktreeKey = 'project-1/worktree-1';
      usePanelLayoutStore.getState().initializeLayout(worktreeKey, {
        orientation: 'horizontal',
        groups: [
          {
            kind: 'chat',
            groupId: 'group-chat',
            panelId: 'panel-chat',
            instance: { chatTabId: 'chat-1' },
          },
        ],
      });
      try {
        const kinds = listAddablePanels(worktreeKey, false).map(
          (entry) => entry.kind,
        );
        expect(kinds).not.toContain('plan');
        expect(kinds).not.toContain('plan-diagram');
      } finally {
        usePanelLayoutStore.getState().disposeLayout(worktreeKey);
      }
    });
  });

  describe('subagent panel definitions', () => {
    it('registers poppable, non-window-bound subagent panel kinds', () => {
      const subagents = DESKTOP_PANEL_DEFINITIONS.subagents;
      const subagentChat = DESKTOP_PANEL_DEFINITIONS['subagent-chat'];
      expect(subagents.title).toBe('Subagents');
      expect(subagents.singleton).toBe(true);
      expect(subagents.canPopOut).toBe(true);
      expect(subagents.isWindowBound).toBe(false);
      expect(subagentChat.title).toBe('Subagent');
      expect(subagentChat.singleton).toBe(false);
      expect(subagentChat.canPopOut).toBe(true);
      expect(subagentChat.isWindowBound).toBe(false);
    });

    it('always offers one Subagents row, including in auxiliary layouts', () => {
      const worktreeKey = 'project-1/worktree-1';
      const auxLayoutKey = makeAuxPanelLayoutKey(worktreeKey, 'aux-1');
      const store = usePanelLayoutStore.getState();
      store.initializeLayout(worktreeKey, {
        orientation: 'horizontal',
        groups: [
          { kind: 'terminal', groupId: 'group-main', panelId: 'panel-main' },
        ],
        containerSize: { width: 1200, height: 800 },
      });
      store.initializeLayout(auxLayoutKey, {
        orientation: 'horizontal',
        groups: [
          { kind: 'terminal', groupId: 'group-aux', panelId: 'panel-aux' },
        ],
        containerSize: { width: 900, height: 600 },
      });

      try {
        expect(
          store.addTab(worktreeKey, 'group-main', 'subagents'),
        ).not.toBeNull();
        for (const layoutKey of [worktreeKey, auxLayoutKey]) {
          const entries = listAddablePanels(layoutKey, false);
          expect(entries.filter((entry) => entry.kind === 'subagents')).toEqual(
            [
              expect.objectContaining({
                kind: 'subagents',
                label: 'Subagents',
              }),
            ],
          );
          expect(entries.map((entry) => entry.kind)).not.toContain(
            'subagent-chat',
          );
        }
      } finally {
        store.disposeLayout(worktreeKey);
        store.disposeLayout(auxLayoutKey);
      }
    });

    it('lazily renders the Subagents host in the panel scope with the visibility gate', async () => {
      selectWorktree();
      await renderSettled(
        renderPanelContent(contentProps('subagents', { isActive: false })),
      );
      expect(
        container.querySelector(
          '[data-testid="panel-content-subagents"] [data-testid="mock-subagents-panel-host"]',
        ),
      ).not.toBeNull();
      expect(jest.mocked(DesktopSubagentsPanelHost).mock.calls[0][0]).toEqual({
        scope: { projectId: 'project-1', worktreeId: 'worktree-1' },
        isVisible: true,
        isActive: false,
      });
    });

    it('never loads a subagent host for a tab that has not been shown', async () => {
      selectWorktree();
      await renderSettled(
        renderPanelContent(contentProps('subagents', { isVisible: false })),
      );
      await renderSettled(
        renderPanelContent(
          contentProps('subagent-chat', {
            isVisible: false,
            instance: {
              rootChatId: 'chat-1',
              subagentId: 'delegate-1',
              subagentKind: 'managed',
            },
          }),
        ),
      );
      expect(jest.mocked(DesktopSubagentsPanelHost)).not.toHaveBeenCalled();
      expect(jest.mocked(DesktopSubagentChatPanelHost)).not.toHaveBeenCalled();
    });

    it('lazily renders the subagent chat host bound to its instance', async () => {
      selectWorktree();
      await renderSettled(
        renderPanelContent(
          contentProps('subagent-chat', {
            instance: {
              rootChatId: 'chat-1',
              subagentId: 'delegate-1',
              subagentKind: 'managed',
            },
          }),
        ),
      );
      expect(
        container.querySelector(
          '[data-testid="panel-content-subagent-chat"] [data-testid="mock-subagent-chat-panel-host"]',
        ),
      ).not.toBeNull();
      expect(
        jest.mocked(DesktopSubagentChatPanelHost).mock.calls[0][0],
      ).toEqual({
        scope: { projectId: 'project-1', worktreeId: 'worktree-1' },
        rootChatId: 'chat-1',
        subagentId: 'delegate-1',
        subagentKind: 'managed',
        panelId: 'panel-subagent-chat',
        isVisible: true,
        isActive: true,
      });
    });

    it('renders the missing-binding state for an unbound subagent chat', () => {
      selectWorktree();
      for (const instance of [
        undefined,
        { rootChatId: 'chat-1', subagentId: ' ', subagentKind: 'managed' },
        { rootChatId: 'chat-1', subagentId: 'x', subagentKind: 'other' },
      ]) {
        renderKind(contentProps('subagent-chat', instance ? { instance } : {}));
        expect(
          container.querySelector('[data-testid="panel-missing-binding"]')
            ?.textContent,
        ).toContain('This subagent chat is missing its subagent');
      }
      expect(jest.mocked(DesktopSubagentChatPanelHost)).not.toHaveBeenCalled();
    });
  });

  describe('renderPanelContent with no selected worktree', () => {
    it.each([...PANEL_KINDS])(
      'renders a neutral empty state for %s without throwing',
      (kind) => {
        renderKind(contentProps(kind));
        expect(
          container.querySelector(`[data-testid="panel-content-${kind}"]`),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="panel-empty-state"]'),
        ).not.toBeNull();
      },
    );
  });

  describe('session-replay classification (CAN-3119)', () => {
    it.each([...PANEL_KINDS])(
      'applies the %s classification on the panel frame',
      (kind) => {
        renderKind(contentProps(kind));
        const frame = container.querySelector(
          `[data-testid="panel-content-${kind}"]`,
        );
        expect(frame).not.toBeNull();
        expect(frame?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
          PANEL_KIND_REPLAY_PRIVACY[kind] === 'blocked',
        );
      },
    );

    it('blocks a content panel and leaves a reviewed panel recorded', () => {
      renderKind(contentProps('terminal'));
      expect(
        container
          .querySelector('[data-testid="panel-content-terminal"]')
          ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
      ).toBe(true);
      renderKind(contentProps('chat'));
      expect(
        container
          .querySelector('[data-testid="panel-content-chat"]')
          ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
      ).toBe(false);
    });
  });

  describe('renderPanelContent with a selected worktree', () => {
    beforeEach(() => {
      selectWorktree();
    });

    it('chat renders ONE bound tab surface (instance.chatTabId), no terminal drawer', () => {
      renderKind(contentProps('chat', { instance: { chatTabId: 'chat-1' } }));
      expect(
        container.querySelector('[data-testid="mock-chat-surface"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="mock-terminal-surface"]'),
      ).toBeNull();
      const props = jest.mocked(WorktreeChatSurface).mock.calls[0][0];
      expect(props.chatTabId).toBe('chat-1');
      expect(props.visible).toBe(true);
      expect(props.isActivePanel).toBe(true);
    });

    it('chat shows the loading spinner while the bound worktree chats hydrate', () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
        worktreeChats: {},
      });

      renderKind(contentProps('chat', { instance: { chatTabId: 'chat-1' } }));

      expect(
        container.querySelector('[data-testid="panel-binding-loading"]'),
      ).not.toBeNull();
      expect(container.textContent).not.toContain(
        'This chat is no longer open',
      );
      expect(jest.mocked(WorktreeChatSurface)).not.toHaveBeenCalled();
    });

    it('chat leaves its stable panel frame mounted without mounting a hidden chat surface', () => {
      renderKind(
        contentProps('chat', {
          instance: { chatTabId: 'chat-1' },
          isVisible: false,
        }),
      );
      expect(
        container.querySelector('[data-testid="panel-content-chat"]'),
      ).not.toBeNull();
      expect(jest.mocked(WorktreeChatSurface)).not.toHaveBeenCalled();
    });

    it('chat forwards panel active state to the bound surface (Cmd+F search gating)', () => {
      renderKind(
        contentProps('chat', {
          instance: { chatTabId: 'chat-1' },
          isActive: false,
        }),
      );
      const props = jest.mocked(WorktreeChatSurface).mock.calls[0][0];
      expect(props.isActivePanel).toBe(false);
    });

    it('chat renders a neutral state when the instance binding is missing or the tab is gone', () => {
      renderKind(contentProps('chat'));
      expect(
        container.querySelector('[data-testid="panel-missing-binding"]'),
      ).not.toBeNull();
      expect(jest.mocked(WorktreeChatSurface)).not.toHaveBeenCalled();

      renderKind(
        contentProps('chat', { instance: { chatTabId: 'deleted-tab' } }),
      );
      expect(
        container.querySelector('[data-testid="panel-missing-binding"]'),
      ).not.toBeNull();
      expect(jest.mocked(WorktreeChatSurface)).not.toHaveBeenCalled();
    });

    it('file-diff renders ONE bound file via FileViewerPanel (instance.fileTabId)', () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'file-1',
            tabs: [
              makeTab(),
              makeTab({
                id: 'file-1',
                kind: 'file',
                filePath: '/tmp/example.ts',
                fileViewMode: 'diff',
                recheckAfterWorktreeSetup: true,
              }),
            ],
          },
        },
      });
      renderKind(
        contentProps('file-diff', {
          instance: { fileTabId: 'file-1', filePath: '/tmp/example.ts' },
        }),
      );
      expect(
        container.querySelector('[data-testid="mock-file-viewer-panel"]'),
      ).not.toBeNull();
      const props = jest.mocked(DesktopSharedFileViewer).mock.calls[0][0];
      expect(props.tabId).toBe('file-1');
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
      expect(props.filePath).toBe('/tmp/example.ts');
      expect(props.viewMode).toBe('diff');
      expect(props.active).toBe(true);
      expect(props.recheckAfterWorktreeSetup).toBe(true);
    });

    it('reports the active file tab embedded-tree visibility to App Advisor', () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'file-1',
            tabs: [
              makeTab(),
              makeTab({
                id: 'file-1',
                kind: 'file',
                filePath: '/tmp/example.ts',
                fileViewMode: 'raw',
              }),
            ],
          },
        },
      });
      useFileTabUiStore.setState({
        fileTreeVisibleByTabId: { 'file-1': true },
      });

      renderKind(
        contentProps('file-diff', {
          instance: { fileTabId: 'file-1', filePath: '/tmp/example.ts' },
        }),
      );

      expect(
        useCurrentUiStateStore.getState().slices['files.activeTab'],
      ).toMatchObject({
        tabId: 'file-1',
        fileTreeVisible: true,
      });
    });

    it('wires the embedded tree current file and consumes its initial reveal once', () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'file-1',
            tabs: [
              makeTab(),
              makeTab({
                id: 'file-1',
                kind: 'file',
                filePath: '/tmp/example.ts',
                fileViewMode: 'raw',
              }),
            ],
          },
        },
      });
      useFileTabUiStore.setState({
        fileTreeVisibleByTabId: { 'file-1': true },
      });

      renderKind(
        contentProps('file-diff', {
          instance: { fileTabId: 'file-1', filePath: '/tmp/example.ts' },
        }),
      );

      const filesTreeTabMock = jest.mocked(FilesTreeTab);
      const firstProps =
        filesTreeTabMock.mock.calls[filesTreeTabMock.mock.calls.length - 1][0];
      expect(firstProps).toMatchObject({
        uiStateScope: 'file-tab:file-1',
      });
      expect(firstProps.currentFilePath).toBe('/tmp/example.ts');
      expect(firstProps.revealCurrentFileInitially).toBe(true);

      act(() => {
        firstProps.onCurrentFileInitialReveal?.('/tmp/example.ts');
      });

      expect(useFileTabUiStore.getState().fileTreeRevealedPathByTabId).toEqual({
        'file-1': '/tmp/example.ts',
      });
      const updatedProps =
        filesTreeTabMock.mock.calls[filesTreeTabMock.mock.calls.length - 1][0];
      expect(updatedProps.revealCurrentFileInitially).toBe(false);
    });

    it('file-diff renders a neutral state when the bound file tab is gone', () => {
      renderKind(
        contentProps('file-diff', { instance: { fileTabId: 'gone' } }),
      );
      expect(
        container.querySelector('[data-testid="panel-missing-binding"]'),
      ).not.toBeNull();
      expect(jest.mocked(DesktopSharedFileViewer)).not.toHaveBeenCalled();
    });

    it('file-diff shows the loading spinner while the bound worktree chats hydrate', () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
        worktreeChats: {},
      });

      renderKind(
        contentProps('file-diff', { instance: { fileTabId: 'file-1' } }),
      );

      expect(
        container.querySelector('[data-testid="panel-binding-loading"]'),
      ).not.toBeNull();
      expect(container.textContent).not.toContain(
        'This file is no longer open',
      );
      expect(jest.mocked(DesktopSharedFileViewer)).not.toHaveBeenCalled();
    });

    it('file-diff reloads its panel owner after background chat state unloads', () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-2' },
        worktreeChats: {},
      });

      act(() => {
        root.render(
          <PanelWorktreeContext.Provider
            value={{ projectId: 'project-1', worktreeId: 'worktree-1' }}
          >
            {renderPanelContent(
              contentProps('file-diff', {
                instance: { fileTabId: 'file-1' },
              }),
            )}
          </PanelWorktreeContext.Provider>,
        );
      });

      expect(loadTabsForTarget).toHaveBeenCalledWith('project-1', 'worktree-1');
      expect(
        container.querySelector('[data-testid="panel-binding-loading"]'),
      ).not.toBeNull();
    });

    it('terminal binds the panel surface to exactly one terminal session', () => {
      renderKind(
        contentProps('terminal', {
          isVisible: false,
          instance: { terminalId: 'terminal-1' },
        }),
      );
      expect(
        container.querySelector('[data-testid="mock-terminal-surface"]'),
      ).not.toBeNull();
      const props = jest.mocked(TerminalPanelSurface).mock.calls[0][0];
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
      expect(props.terminalId).toBe('terminal-1');
      expect(props.panelId).toBe('panel-terminal');
    });

    it('uses the panel owner worktree instead of the global selected worktree when provided', () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-2' },
      });

      act(() => {
        root.render(
          <PanelWorktreeContext.Provider
            value={{ projectId: 'project-1', worktreeId: 'worktree-1' }}
          >
            {renderPanelContent(contentProps('terminal'))}
          </PanelWorktreeContext.Provider>,
        );
      });

      const props = jest.mocked(TerminalPanelSurface).mock.calls[0][0];
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
    });

    it('activity-section renders the shared adapter bound to the selected worktree', () => {
      renderKind(contentProps('activity-section'));
      expect(
        container.querySelector('[data-testid="mock-activity-panel"]'),
      ).not.toBeNull();
      expect(jest.mocked(SharedActivityPanelAdapter)).toHaveBeenCalled();
      expect(jest.mocked(SharedActivityPanelAdapter).mock.calls[0][0]).toEqual({
        worktreeSelection: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
    });

    it('file-explorer renders the standalone FilesTreeTab bound to the selected worktree', () => {
      renderKind(contentProps('file-explorer'));
      expect(
        container.querySelector('[data-testid="mock-files-tree-tab"]'),
      ).not.toBeNull();
      const props = jest.mocked(FilesTreeTab).mock.calls[0][0];
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
      expect(props).not.toHaveProperty('uiStateScope');
    });

    it('file-explorer stays hidden when the page-level host is hidden', () => {
      renderKind(contentProps('file-explorer', { isVisible: true }), {
        ...DEFAULT_PANEL_HOST_STATE,
        visible: false,
      });

      const props = jest.mocked(FilesTreeTab).mock.calls[0][0];
      expect(props.isVisible).toBe(false);
    });

    it('activity-card resolves instance.sectionId and renders the bare section without card chrome', () => {
      renderKind(
        contentProps('activity-card', { instance: { sectionId: 'summary' } }),
      );
      // The section content renders directly inside the padded card
      // container — no sortable/panel-section wrapper, no drag handle.
      const cardBody = container.querySelector(
        '[data-testid="activity-card-section-summary"]',
      );
      expect(cardBody).not.toBeNull();
      expect(
        container.querySelector('[data-testid="mock-section-summary"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-testid="drag-handle"]')).toBeNull();
      const summarySection = jest.mocked(ACTIVITY_SECTIONS[0].render).mock
        .calls[0][0];
      expect(summarySection).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });

    it('activity-card renders every registered section id', () => {
      for (const section of ACTIVITY_SECTIONS) {
        act(() => {
          root.render(
            renderPanelContent(
              contentProps('activity-card', {
                instance: { sectionId: section.id },
              }),
            ),
          );
        });
        expect(
          container.querySelector(
            `[data-testid="activity-card-section-${section.id}"]`,
          ),
        ).not.toBeNull();
      }
    });

    it('activity-card renders a neutral empty state for unknown or missing section ids', () => {
      renderKind(
        contentProps('activity-card', { instance: { sectionId: 'bogus' } }),
      );
      expect(
        container.querySelector(
          '[data-testid="activity-card-unknown-section"]',
        ),
      ).not.toBeNull();

      act(() => {
        root.render(renderPanelContent(contentProps('activity-card')));
      });
      expect(
        container.querySelector(
          '[data-testid="activity-card-unknown-section"]',
        ),
      ).not.toBeNull();
    });

    it('browser renders ONE bound BrowserPanelSurface (instance.browserId), forwarding visibility', () => {
      renderKind(
        contentProps('browser', {
          isVisible: false,
          instance: { browserId: 'browser-1' },
        }),
      );
      expect(
        container.querySelector('[data-testid="mock-browser-panel-surface"]'),
      ).not.toBeNull();
      const props = jest.mocked(BrowserPanelSurface).mock.calls[0][0];
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
      expect(props.browserId).toBe('browser-1');
      expect(props.visible).toBe(false);
    });

    it('browser stays hidden when its grid tab is active but the page-level host is hidden', () => {
      renderKind(
        contentProps('browser', {
          isVisible: true,
          instance: { browserId: 'browser-1' },
        }),
        {
          ...DEFAULT_PANEL_HOST_STATE,
          visible: false,
        },
      );

      const props = jest.mocked(BrowserPanelSurface).mock.calls[0][0];
      expect(props.visible).toBe(false);
    });

    it.each([
      ['plan', PlanPanelHost, 'mock-plan-panel-host'],
      ['plan-diagram', PlanDiagramPanelHost, 'mock-plan-diagram-panel-host'],
    ] as const)(
      '%s lazily renders its host bound to instance.planId',
      async (kind, host, testId) => {
        await renderSettled(
          renderPanelContent(
            contentProps(kind, {
              isActive: false,
              instance: { planId: '  plan-1  ' },
            }),
          ),
        );
        expect(
          container.querySelector(`[data-testid="panel-content-${kind}"]`),
        ).not.toBeNull();
        expect(
          container.querySelector(`[data-testid="${testId}"]`),
        ).not.toBeNull();
        expect(jest.mocked(host).mock.calls[0][0]).toEqual({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          panelId: `panel-${kind}`,
          isActive: false,
          isVisible: true,
        });
      },
    );

    it('plan hosts follow the panel owner worktree and the page-level host visibility', async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-2' },
      });
      await renderSettled(
        <PanelHostContext.Provider
          value={{ ...DEFAULT_PANEL_HOST_STATE, visible: false }}
        >
          <PanelWorktreeContext.Provider
            value={{ projectId: 'project-1', worktreeId: 'worktree-1' }}
          >
            {renderPanelContent(
              contentProps('plan', { instance: { planId: 'plan-1' } }),
            )}
          </PanelWorktreeContext.Provider>
        </PanelHostContext.Provider>,
      );
      const props = jest.mocked(PlanPanelHost).mock.calls[0][0];
      expect(props.projectId).toBe('project-1');
      expect(props.worktreeId).toBe('worktree-1');
      expect(props.isVisible).toBe(false);
    });

    it.each(['plan', 'plan-diagram'])(
      '%s without a plan binding renders the missing state, not a host',
      (kind) => {
        for (const instance of [undefined, { planId: '   ' }]) {
          renderKind(contentProps(kind, instance ? { instance } : {}));
          expect(
            container.querySelector('[data-testid="panel-missing-binding"]')
              ?.textContent,
          ).toContain('This plan panel is missing its plan');
        }
        expect(jest.mocked(PlanPanelHost)).not.toHaveBeenCalled();
        expect(jest.mocked(PlanDiagramPanelHost)).not.toHaveBeenCalled();
      },
    );

    it('browser without a bound id is a contract error (never falls back to the active browser)', () => {
      renderKind(contentProps('browser', { isVisible: true }));
      expect(
        container.querySelector('[data-testid="mock-browser-panel-surface"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="panel-browser-unbound"]'),
      ).not.toBeNull();
    });
  });

  describe('unknown kinds', () => {
    it('renders an inline error box instead of throwing', () => {
      renderKind(contentProps('bogus-kind'));
      const errorBox = container.querySelector(
        '[data-testid="panel-unknown-kind"]',
      );
      expect(errorBox).not.toBeNull();
      expect(errorBox?.textContent).toContain('bogus-kind');
      expect(errorBox?.getAttribute('role')).toBe('alert');
    });
  });
});
