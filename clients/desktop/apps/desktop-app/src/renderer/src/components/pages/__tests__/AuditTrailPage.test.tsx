/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

import { act, type ReactNode } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { createRoot, type Root } from 'react-dom/client';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type AgentAuditEntry,
} from '@canopy/desktop-shared/types';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { AuditTrailPage } from '../AuditTrailPage';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

const initialize = jest.fn<Promise<void>, []>();
const refreshHistory = jest.fn<Promise<void>, [request?: unknown]>();
const loadMoreHistory = jest.fn<Promise<void>, []>();
const loadTranscript = jest.fn();
const selectWorktree = jest.fn();
const ensureSelectedWorktreeTabsLoaded = jest.fn();
const switchTab = jest.fn();
const loadTabsForTarget = jest.fn<Promise<void>, [string, string]>();
const navigate = jest.fn();
const openPipelineExecutionFromUi = jest.fn<
  Promise<{ status: string }>,
  [request: unknown]
>(() => Promise.resolve({ status: 'applied' }));
const savePreferences = jest.fn<Promise<void>, [Record<string, unknown>]>();
const switchChatProject = jest.fn<Promise<boolean>, [string]>();
const selectChat = jest.fn();
let historyEntries: AgentAuditEntry[] = [];
/**
 * Live worktree chat tabs, keyed `${projectId}/${worktreeId}`. Archived chats
 * are absent from this map, which is how the Inspect handler tells a live tab
 * from an archived transcript.
 */
let worktreeChats: Record<string, { tabs: { id: string }[] }> = {};

const mockEntry: AgentAuditEntry = {
  id: 'entry-1',
  eventType: 'worktree_chat',
  status: 'success',
  provider: 'codex',
  label: 'Codex turn',
  startedAt: '2026-06-18T12:00:00.000Z',
  completedAt: '2026-06-18T12:00:10.000Z',
  durationMs: 10_000,
  model: 'gpt-5.3-codex-spark',
  tokens: {
    input: 10,
    output: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  observedCost: {
    status: 'unpriced',
    reason: 'model_not_priced',
    currency: 'usd',
    components: [],
  },
  messageCount: 1,
  assistantMessageCount: 1,
  toolUseCount: 0,
  toolCounts: {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  },
  subAgentCount: 0,
  hasTranscript: true,
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      initialize,
      refreshHistory,
      loadMoreHistory,
      loadTranscript,
      historyEntries,
      loadingHistory: false,
      nextCursor: undefined,
      activeHistoryRequest: null,
    }),
}));

jest.mock('@/stores/activityStore', () => ({
  useActivityStore: {
    getState: (): Record<string, unknown> => ({
      setPanelExpanded: jest.fn(),
    }),
  },
}));
jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn(),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): Record<string, unknown> => ({
      selectWorktree,
      ensureSelectedWorktreeTabsLoaded,
      switchTab,
      loadTabsForTarget,
      worktreeChats,
    }),
  },
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT:
    'canopy:worktree-chat-open-archive-transcript',
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): Record<string, unknown> => ({
      navigate,
    }),
  },
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUi(request),
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): Record<string, unknown> => ({
      switchChatProject,
      selectChat,
    }),
  },
}));

jest.mock('@/lib/providerUi', () => ({
  AgentProviderIcon: (): ReactNode => null,
}));

jest.mock('@/components/chat/TranscriptViewer', () => ({
  TranscriptViewer: (): ReactNode => <div data-testid="transcript-viewer" />,
}));

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

beforeAll(() => {
  class MockIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: MockIntersectionObserver,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appAdvisor: { openWindow: jest.fn() },
      observability: { loadHistory: jest.fn() },
      savePreferences,
    },
  });
});

beforeEach(() => {
  historyEntries = [mockEntry];
  worktreeChats = {};
  initialize.mockResolvedValue(undefined);
  refreshHistory.mockResolvedValue(undefined);
  loadMoreHistory.mockResolvedValue(undefined);
  ensureSelectedWorktreeTabsLoaded.mockResolvedValue(true);
  loadTabsForTarget.mockResolvedValue(undefined);
  savePreferences.mockResolvedValue(undefined);
  switchChatProject.mockResolvedValue(true);
  loadTranscript.mockResolvedValue({
    type: 'success',
    lines: [],
    providerHint: 'codex',
    truncation: { truncated: false, maxBytes: 0 },
    injectedPrompts: [],
  });
});

afterEach(() => {
  document.body.replaceChildren();
  jest.clearAllMocks();
});

describe('AuditTrailPage', () => {
  test('renders current chat audit labels for filters and persisted entries', async () => {
    historyEntries = [
      {
        ...mockEntry,
        id: 'worktree-entry',
        eventType: 'worktree_chat',
        label: 'Worktree chat',
      },
      {
        ...mockEntry,
        id: 'standalone-entry',
        eventType: 'standalone_chat',
        label: 'Standalone chat',
      },
      {
        ...mockEntry,
        id: 'summary-entry',
        eventType: 'chat_summary',
        label: 'Cowork Summary',
      },
    ];

    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    // The Event filter is a quiet dropdown after the search; its menu
    // lists every event type by its current label.
    const eventFilter = container.querySelector<HTMLButtonElement>(
      '[data-testid="audit-trail-event-type-filter"]',
    );
    expect(eventFilter?.textContent).toBe('All events');
    act(() => eventFilter?.click());
    const eventMenu = document.querySelector(
      '[data-testid="audit-trail-event-type-filter-menu"]',
    );
    expect(eventMenu?.textContent).toContain('Code chat');
    expect(eventMenu?.textContent).toContain('Cowork chat');
    expect(eventMenu?.textContent).not.toContain('Code Cowork');
    expect(eventMenu?.textContent).not.toContain('Standalone Cowork');
    act(() => eventFilter?.click());

    // Rows only: the filter options above carry the same labels.
    const entryList = container.querySelector(
      '[data-testid="audit-entry-list"]',
    );
    expect(entryList?.textContent).toContain('Code chat');
    expect(entryList?.textContent).toContain('Cowork chat');
    expect(entryList?.textContent).not.toContain('Code Chat');
    expect(container.textContent).toContain('Chat summary');
    expect(container.textContent).not.toContain('Worktree chat');
    expect(container.textContent).not.toContain('Standalone chat');
    expect(container.textContent).not.toContain('Cowork Summary');
  });

  test('filters from the page search row: the search, then three quiet dropdowns', async () => {
    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });
    const row = container.querySelector(
      '[data-testid="audit-trail-search-row"]',
    );
    expect(row?.hasAttribute('data-page-search-row')).toBe(true);
    // No native controls are left on the page.
    expect(container.querySelector('select')).toBeNull();
    const controls = row?.querySelector('[data-page-search-controls]');
    expect(row?.lastElementChild).toBe(controls);
    expect(
      Array.from(controls?.children ?? [], (child) =>
        child.getAttribute('data-testid'),
      ),
    ).toEqual([
      'audit-trail-provider-filter',
      'audit-trail-status-filter',
      'audit-trail-event-type-filter',
    ]);
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="audit-trail-search"]',
    );
    expect(search?.getAttribute('placeholder')).toBe('Search the audit trail');
    expect(
      search?.closest('[data-search-field]')?.getAttribute('data-search-field'),
    ).toBe('md');

    const provider = container.querySelector<HTMLButtonElement>(
      '[data-testid="audit-trail-provider-filter"]',
    );
    expect(provider?.textContent).toBe('All providers');
    act(() => provider?.click());
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="audit-trail-provider-filter-option-codex"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(provider?.textContent).toBe('Codex');
    expect(refreshHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  test('renders Orchestrator entries recorded under the former name with the current label', async () => {
    historyEntries = [
      {
        ...mockEntry,
        id: 'orchestrator-entry',
        eventType: 'app_advisor',
        label: 'App Advisor',
      },
    ];

    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const entryList = container.querySelector(
      '[data-testid="audit-entry-list"]',
    );
    expect(entryList?.textContent).toContain(ORCHESTRATOR_LABEL);
    expect(entryList?.textContent).not.toContain('App Advisor');
  });

  test('renders a static computed duration for a finished entry', async () => {
    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const duration = container.querySelector<HTMLElement>(
      '[data-testid="audit-duration-entry-1"]',
    );
    // startedAt → completedAt span is 10s; computed, not read from durationMs.
    expect(duration?.textContent).toBe('10s');
  });

  test('records the audit entry list in session replay', async () => {
    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const list = container.querySelector('[data-testid="audit-entry-list"]');
    expect(list).not.toBeNull();
    expect(list?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      container.querySelector('[data-testid="audit-entry-entry-1"]'),
    ).not.toBeNull();
    expect(list?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  test('renders an AI Credits badge only for routed entries', async () => {
    historyEntries = [
      { ...mockEntry, id: 'routed-entry', aiCreditsRouted: true },
      {
        ...mockEntry,
        id: 'org-routed-entry',
        aiCreditsRouted: true,
        modelGatewayRouted: true,
      },
      { ...mockEntry, id: 'native-entry', aiCreditsRouted: undefined },
    ];

    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="audit-ai-credits-badge-routed-entry"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="audit-ai-credits-badge-native-entry"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="audit-ai-credits-badge-org-routed-entry"]',
      ),
    ).toBeNull();
  });

  test('ticks the duration once per second for a running entry', async () => {
    jest.useFakeTimers();
    let root: Root | null = null;
    try {
      jest.setSystemTime(new Date('2026-06-18T12:00:05.000Z'));
      historyEntries = [
        {
          ...mockEntry,
          id: 'running-entry',
          status: 'running',
          startedAt: '2026-06-18T12:00:00.000Z',
          completedAt: undefined,
          durationMs: undefined,
        },
      ];

      const rendered = render(<AuditTrailPage />);
      root = rendered.root;

      await act(async () => {
        await Promise.resolve();
      });

      const selector = '[data-testid="audit-duration-running-entry"]';
      expect(
        rendered.container.querySelector<HTMLElement>(selector)?.textContent,
      ).toBe('5s');

      act(() => {
        // advanceTimersByTime moves the fake clock, so Date.now() advances too.
        jest.advanceTimersByTime(3000);
      });

      expect(
        rendered.container.querySelector<HTMLElement>(selector)?.textContent,
      ).toBe('8s');
    } finally {
      act(() => {
        root?.unmount();
      });
      jest.useRealTimers();
    }
  });

  test('uses the latest history entry for transcript duration updates', async () => {
    jest.useFakeTimers();
    let root: Root | null = null;
    try {
      jest.setSystemTime(new Date('2026-06-18T12:00:05.000Z'));
      historyEntries = [
        {
          ...mockEntry,
          id: 'running-entry',
          status: 'running',
          startedAt: '2026-06-18T12:00:00.000Z',
          completedAt: undefined,
          durationMs: undefined,
        },
      ];

      const rendered = render(<AuditTrailPage />);
      root = rendered.root;

      await act(async () => {
        await Promise.resolve();
      });

      const transcriptButton =
        rendered.container.querySelector<HTMLButtonElement>(
          '[data-testid="audit-transcript-button-running-entry"]',
        );
      expect(transcriptButton).not.toBeNull();

      await act(async () => {
        transcriptButton?.click();
        await Promise.resolve();
      });

      historyEntries = [
        {
          ...historyEntries[0],
          status: 'success',
          completedAt: '2026-06-18T12:00:10.000Z',
          durationMs: 10_000,
        },
      ];

      act(() => {
        jest.setSystemTime(new Date('2026-06-18T12:00:15.000Z'));
        root?.render(<AuditTrailPage />);
      });

      const modal = document.querySelector<HTMLElement>(
        '[data-testid="audit-transcript-modal"]',
      );
      expect(
        modal?.querySelector<HTMLElement>(
          '[data-testid="audit-duration-running-entry"]',
        )?.textContent,
      ).toBe('10s');
    } finally {
      act(() => {
        root?.unmount();
      });
      jest.useRealTimers();
    }
  });

  test('labels restored organization memory separately from plan instructions', async () => {
    loadTranscript.mockResolvedValue({
      type: 'success',
      lines: [],
      providerHint: 'cursor',
      truncation: { truncated: false, maxBytes: 0 },
      injectedPrompts: [
        {
          provider: 'cursor',
          kind: 'org_memory',
          applicationCondition: 'org_memory_enabled_for_turn',
          text: 'Release checklist',
        },
      ],
    });
    const { container, root } = render(<AuditTrailPage />);
    try {
      await act(async () => {
        await Promise.resolve();
      });
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="audit-transcript-button-entry-1"]',
      );
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      const prompts = document.querySelector(
        '[data-testid="audit-transcript-injected-prompts"]',
      );
      expect(prompts?.textContent).toContain('Organization memory');
      expect(prompts?.textContent).not.toContain(
        'Plan mode developer instructions',
      );
      // Session replay records the dialog frame but keeps the injected
      // prompt text itself out of the recording.
      const promptText = Array.from(
        prompts?.querySelectorAll('pre') ?? [],
      ).find((node) => node.textContent === 'Release checklist');
      expect(promptText?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        true,
      );
      expect(
        document
          .querySelector('[data-testid="audit-transcript-modal"]')
          ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  test('shows unpriced Codex cost reason in transcript details', async () => {
    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const transcriptButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="audit-transcript-button-entry-1"]',
    );
    expect(transcriptButton).not.toBeNull();

    await act(async () => {
      transcriptButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Cost');
    expect(container.textContent).toContain(
      'Cost unavailable: no published API pricing basis for this Codex model.',
    );
  });

  async function openTranscriptDetails(
    container: HTMLElement,
    entryId: string,
  ): Promise<HTMLElement | null> {
    const transcriptButton = container.querySelector<HTMLButtonElement>(
      `[data-testid="audit-transcript-button-${entryId}"]`,
    );
    expect(transcriptButton).not.toBeNull();
    await act(async () => {
      transcriptButton?.click();
      await Promise.resolve();
    });
    return document.querySelector<HTMLElement>(
      '[data-testid="audit-transcript-modal"]',
    );
  }

  test('shows requested Ultra fast with an unreported actual tier and keeps its cost unpriced', async () => {
    historyEntries = [
      {
        ...mockEntry,
        id: 'ultra-entry',
        model: 'gpt-6-astra',
        serviceTier: 'ultrafast',
        // A stale flat Standard estimate must not surface beside the explicit
        // unpriced outcome.
        totalCostUsd: 0.014225,
        observedCost: {
          status: 'unpriced',
          reason: 'unsupported_service_tier',
          currency: 'usd',
          model: 'gpt-6-astra',
          serviceTier: 'ultrafast',
          components: [],
        },
      },
    ];
    const { container, root } = render(<AuditTrailPage />);
    try {
      await act(async () => {
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="audit-cost-ultra-entry"]')
          ?.textContent,
      ).toBe('Cost unavailable: pricing data has no rates for Ultra fast.');

      const modal = await openTranscriptDetails(container, 'ultra-entry');
      const speed = modal?.querySelector(
        '[data-testid="audit-transcript-requested-speed"]',
      );
      expect(speed?.textContent).toContain('Requested Ultra fast');
      expect(speed?.textContent).toContain('Actual tier unreported');
      expect(
        modal?.querySelector('[data-testid="audit-transcript-cost"]')
          ?.textContent,
      ).toContain(
        'Cost unavailable: pricing data has no rates for Ultra fast.',
      );
      expect(modal?.textContent).not.toContain('$');
    } finally {
      act(() => root.unmount());
    }
  });

  test('omits the requested speed for a Regular turn', async () => {
    historyEntries = [{ ...mockEntry, serviceTier: 'default' }];
    const { container, root } = render(<AuditTrailPage />);
    try {
      await act(async () => {
        await Promise.resolve();
      });

      const modal = await openTranscriptDetails(container, 'entry-1');
      expect(modal).not.toBeNull();
      expect(
        modal?.querySelector(
          '[data-testid="audit-transcript-requested-speed"]',
        ),
      ).toBeNull();
      expect(modal?.textContent).not.toContain('Requested');
    } finally {
      act(() => root.unmount());
    }
  });

  test('hydrates pipeline-editor tabs before selecting an audit-linked chat', async () => {
    historyEntries = [
      {
        ...mockEntry,
        id: 'pipeline-editor-entry',
        eventType: 'pipeline_editor',
        label: 'Pipeline Editor turn',
        linkTarget: {
          page: 'pipelines',
          kind: 'pipeline-editor',
          chatId: 'pipeline-chat-1',
        },
      },
    ];
    const openAssistantListener = jest.fn();
    window.addEventListener(
      'canopy:pipelines-open-assistant',
      openAssistantListener,
    );
    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const inspectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Inspect'));
    expect(inspectButton).toBeDefined();

    await act(async () => {
      inspectButton?.click();
      await Promise.resolve();
    });

    expect(navigate).toHaveBeenCalledWith('workflows-library');
    expect(openAssistantListener).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({
      pipelineChatPanelVisible: true,
    });
    expect(loadTabsForTarget).toHaveBeenCalledWith(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
    );
    expect(switchTab).toHaveBeenCalledWith('pipeline-chat-1', {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    });
    expect(loadTabsForTarget.mock.invocationCallOrder[0]).toBeLessThan(
      switchTab.mock.invocationCallOrder[0],
    );
    window.removeEventListener(
      'canopy:pipelines-open-assistant',
      openAssistantListener,
    );
  });

  test('Inspect on a cowork standalone-chat entry switches to the cowork project id', async () => {
    const coworkWorkspaceId = 'cowork-acme-workspace';
    historyEntries = [
      {
        ...mockEntry,
        id: 'cowork-standalone-entry',
        eventType: 'standalone_chat',
        label: 'Cowork chat',
        linkTarget: {
          page: 'chat',
          kind: 'standalone-chat',
          projectId: coworkWorkspaceId,
          worktreeId: 'home',
          chatId: 'cowork-chat-1',
        },
      },
    ];

    const { container } = render(<AuditTrailPage />);

    await act(async () => {
      await Promise.resolve();
    });

    const inspectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Inspect'));
    expect(inspectButton).toBeDefined();

    await act(async () => {
      inspectButton?.click();
      await Promise.resolve();
    });

    expect(switchChatProject).toHaveBeenCalledWith(coworkWorkspaceId);
    expect(switchChatProject).not.toHaveBeenCalledWith('home');
    expect(selectChat).toHaveBeenCalledWith('cowork-chat-1');
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  test('Inspect on a pipeline step entry opens its run through the panel opener', async () => {
    historyEntries = [
      {
        ...mockEntry,
        id: 'pipeline-step-entry',
        eventType: 'pipeline_agent_turn',
        label: 'Pipeline agent turn',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        linkTarget: {
          page: 'main',
          kind: 'pipeline-execution',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          // A child run id: it opens as its own panel.
          pipelineExecutionId: 'child-run-1',
        },
      },
    ];

    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });
    const inspectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Inspect'));
    expect(inspectButton).toBeDefined();
    await act(async () => {
      inspectButton?.click();
      await Promise.resolve();
    });

    // The run's own record decides its owner; the entry scope is not a hint
    // and nothing selects a worktree or expands Activity here.
    expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'child-run-1',
    });
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  /**
   * Handoff summaries generated from the archive flow ("Summarize") link back
   * to a chat that the flow deliberately leaves archived. `switchTab` sets
   * `activeTabId` unconditionally and persists it, so calling it with an
   * archived id both fails to open the chat and leaves the worktree pointing
   * at a tab that no longer exists.
   */
  async function clickInspect(container: HTMLElement): Promise<void> {
    const inspectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Inspect'));
    expect(inspectButton).toBeDefined();
    await act(async () => {
      inspectButton?.click();
      await Promise.resolve();
    });
  }

  const handoffEntry: AgentAuditEntry = {
    ...mockEntry,
    id: 'handoff-entry',
    eventType: 'chat_handoff_summary',
    label: 'Chat Handoff Summary (Archive)',
    linkTarget: {
      page: 'main',
      kind: 'worktree-chat',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'source-chat-1',
    },
  };

  test('Inspect on a worktree-chat entry switches to the live source tab', async () => {
    historyEntries = [handoffEntry];
    worktreeChats = {
      'project-1/worktree-1': { tabs: [{ id: 'source-chat-1' }] },
    };
    const archiveListener = jest.fn<void, [Event]>();
    window.addEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      archiveListener,
    );

    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });
    await clickInspect(container);

    expect(navigate).toHaveBeenCalledWith('main');
    expect(switchTab).toHaveBeenCalledWith('source-chat-1', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(archiveListener).not.toHaveBeenCalled();

    window.removeEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      archiveListener,
    );
  });

  test('Inspect on a plan-linked entry opens the Plan panel beside its chat, then the chat', async () => {
    const openPlan = jest.mocked(openTrackedPlan);
    openPlan.mockResolvedValue({ status: 'unavailable' });
    historyEntries = [
      {
        ...handoffEntry,
        id: 'plan-entry',
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          chatId: 'source-chat-1',
        },
      },
    ];
    worktreeChats = {
      'project-1/worktree-1': { tabs: [{ id: 'source-chat-1' }] },
    };

    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });
    const inspect = container.querySelector<HTMLButtonElement>(
      '[data-testid="audit-inspect-button-plan-entry"]',
    );
    expect(inspect).not.toBeNull();
    await act(async () => {
      inspect?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).toHaveBeenCalledWith('main');
    expect(selectWorktree).toHaveBeenCalledWith('project-1', 'worktree-1');
    // The entry already selected the worktree, so the opener only places
    // the panel, beside the entry's chat.
    expect(openPlan).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'worktree-1', planId: 'plan-1' },
      { navigate: false, origin: { chatTabId: 'source-chat-1' } },
    );
    expect(switchTab).toHaveBeenCalledWith('source-chat-1', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(openPlan.mock.invocationCallOrder[0]).toBeLessThan(
      switchTab.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test('renders no Inspect for an entry without a link', async () => {
    historyEntries = [{ ...mockEntry, id: 'unlinked-entry' }];

    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="audit-inspect-button-unlinked-entry"]',
      ),
    ).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Inspect'),
      ),
    ).toBe(false);
    expect(openTrackedPlan).not.toHaveBeenCalled();
  });

  test('Inspect on an archive-origin handoff entry opens the archive transcript instead of persisting a dead tab id', async () => {
    historyEntries = [handoffEntry];
    // The source chat was archived, so it is absent from the live tab list.
    worktreeChats = {
      'project-1/worktree-1': { tabs: [{ id: 'some-other-chat' }] },
    };
    const archiveListener = jest.fn<void, [Event]>();
    window.addEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      archiveListener,
    );
    const rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
      });

    const { container } = render(<AuditTrailPage />);
    await act(async () => {
      await Promise.resolve();
    });
    await clickInspect(container);

    expect(navigate).toHaveBeenCalledWith('main');
    // The archived id must never reach switchTab — that is what persists a
    // nonexistent activeTabId.
    expect(switchTab).not.toHaveBeenCalled();
    expect(archiveListener).toHaveBeenCalledTimes(1);
    const event = archiveListener.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event instanceof CustomEvent ? event.detail : undefined).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'source-chat-1',
    });

    rafSpy.mockRestore();
    window.removeEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      archiveListener,
    );
  });
});
