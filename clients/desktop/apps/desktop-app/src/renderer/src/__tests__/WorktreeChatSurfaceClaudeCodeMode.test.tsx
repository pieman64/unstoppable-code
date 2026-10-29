import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX, ReactNode } from 'react';
import { CanopyClientProvider } from '@canopy/app-state';
import {
  APP_ADVISOR_PROJECT_ID,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type * as ClaudeTerminalStoreModule from '@/stores/claudeTerminalStore';
import { WorktreeChatSurface } from '@/components/chat/WorktreeChatSurface';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockSetChatInterfaceMode = jest.fn();
let mockChatState: Record<string, unknown>;
let mockTransientRetryState: {
  provider: 'claude';
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  exhausted: boolean;
} | null;
let mockOnboardingState: {
  visible: boolean;
  queueStatus: 'loading' | 'has-rows' | 'exhausted';
} = { visible: false, queueStatus: 'loading' };

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector(mockChatState),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => mockChatState),
}));

jest.mock('@/stores/claudeTerminalStore', () => {
  const actual = jest.requireActual<typeof ClaudeTerminalStoreModule>(
    '@/stores/claudeTerminalStore',
  );
  return {
    useClaudeTerminalStore: (selector: (state: unknown) => unknown): unknown =>
      selector({ byChat: {} }),
    resolveChatInterfaceSurface: actual.resolveChatInterfaceSurface,
    isAutoTerminalSurfaceActive: actual.isAutoTerminalSurfaceActive,
  };
});

jest.mock('@/stores/automationsStore', () => ({
  useAutomationsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      activities: [],
      createActivity: jest.fn(),
      updateActivity: jest.fn(),
      runNow: jest.fn(),
    }),
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ projects: [] }),
}));

jest.mock('@/stores/transientRetryBannerStore', () => ({
  useTransientRetryState: (): typeof mockTransientRetryState =>
    mockTransientRetryState,
}));

jest.mock('@/stores/onboardingSuggestionSurfacesStore', () => {
  const useOnboardingSuggestionSurfaces = Object.assign(
    (selector: (state: typeof mockOnboardingState) => unknown): unknown =>
      selector(mockOnboardingState),
    {
      setState: (
        update:
          | Partial<typeof mockOnboardingState>
          | ((
              state: typeof mockOnboardingState,
            ) => Partial<typeof mockOnboardingState>),
      ): void => {
        mockOnboardingState = {
          ...mockOnboardingState,
          ...(typeof update === 'function'
            ? update(mockOnboardingState)
            : update),
        };
      },
    },
  );
  return { useOnboardingSuggestionSurfaces };
});

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({
    interfaceModeControl,
    targetOverride,
  }: {
    interfaceModeControl?: { mode: string };
    targetOverride?: unknown;
  }): JSX.Element => (
    <div
      data-testid="chat-input"
      data-target-override={JSON.stringify(targetOverride)}
    >
      {/* The composer offers the modes in its + menu. */}
      {interfaceModeControl ? (
        <span
          data-testid="composer-interface-modes"
          data-mode={interfaceModeControl.mode}
        />
      ) : null}
    </div>
  ),
}));

jest.mock('@/components/chat/ChatContent', () => ({
  ChatContent: ({
    emptyStateCenter,
    emptyStateSuggestions,
    allowCursor,
  }: {
    emptyStateCenter?: ReactNode;
    emptyStateSuggestions?: ReactNode;
    allowCursor?: boolean;
  }): JSX.Element => (
    <div
      data-testid="chat-content"
      data-has-onboarding={emptyStateCenter ? 'true' : 'false'}
      data-has-suggestions={emptyStateSuggestions ? 'true' : 'false'}
      data-allow-cursor={allowCursor ? 'true' : 'false'}
    >
      {emptyStateCenter}
      {emptyStateSuggestions}
    </div>
  ),
}));

jest.mock('@/hooks/useCanopyDesktopSuggestedPromptsEnabled', () => ({
  useCanopyDesktopSuggestedPromptsEnabled: (): boolean => true,
}));

jest.mock('@/hooks/useResolvedChatPluginSelections', () => ({
  useResolvedChatPluginSelections: (): Record<string, never> => ({}),
}));

jest.mock('@/hooks/useBlueprintCatalog', () => ({
  useBlueprintCatalog: (): { blueprints: never[] } => ({ blueprints: [] }),
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: (
    selector: (state: { chatProjects: never[] }) => unknown,
  ): unknown => selector({ chatProjects: [] }),
}));

jest.mock('@/components/suggestions/useSuggestedPrompts', () => ({
  useSuggestedPrompts: (): {
    prompts: { id: string; text: string; pluginName: string }[];
  } => ({
    prompts: [
      {
        id: 'example',
        text: 'Old example prompt',
        pluginName: 'Example',
      },
    ],
  }),
}));

jest.mock('@/components/suggestions/SuggestedPromptChips', () => ({
  SuggestedPromptChips: (): JSX.Element => (
    <div data-testid="suggested-prompt-chips" />
  ),
}));

jest.mock('@/components/chat/ClaudeCodeTerminalExperience', () => ({
  ClaudeCodeTerminalExperience: (): JSX.Element => (
    <div data-testid="claude-code-experience" />
  ),
}));

const mockedUseCurrentUiStateReporter = jest.mocked(useCurrentUiStateReporter);

function mockCanopyClient(): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: true,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
  };
  return {
    capabilities,
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

const sharedClient = mockCanopyClient();

function buildChatState(
  tabOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeDefaultPlugins: {},
    composerTextPresent: {},
    runtimeByChatId: {},
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Claude chat',
            providerType: 'claude',
            interfaceMode: 'claude-code',
            status: 'idle',
            planMode: false,
            thinkingLevel: 'high',
            messages: [],
            queuedMessages: [],
            ...tabOverrides,
          },
        ],
      },
    },
    scheduledSendModalOpen: false,
    setChatInterfaceMode: mockSetChatInterfaceMode,
    clearQueuedMessage: jest.fn(),
    forceQueuedMessage: jest.fn(),
    setEditingQueuedMessage: jest.fn(),
    saveEditedQueuedMessage: jest.fn(),
    sendMessage: jest.fn(),
    cancelSession: jest.fn(),
    resetToPoint: jest.fn(),
    pendingPlanExits: {},
    pendingEditorSelections: {},
  };
}

function renderSurface(): string {
  return renderToStaticMarkup(
    <CanopyClientProvider client={sharedClient}>
      <WorktreeChatSurface chatTabId="chat" visible isActivePanel />
    </CanopyClientProvider>,
  );
}

function renderCoworkSurface(): string {
  const worktreeSelection = {
    projectId: 'cowork-project',
    worktreeId: 'home',
  };
  return renderToStaticMarkup(
    <CanopyClientProvider client={sharedClient}>
      <WorktreeChatSurface
        chatTabId="chat"
        worktreeSelection={worktreeSelection}
        visible
        isActivePanel
      />
    </CanopyClientProvider>,
  );
}

function renderAppAdvisorSurface(): string {
  return renderToStaticMarkup(
    <CanopyClientProvider client={sharedClient}>
      <WorktreeChatSurface
        chatTabId="chat"
        worktreeSelection={{
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry',
        }}
        visible
        isActivePanel
      />
    </CanopyClientProvider>,
  );
}

function codexTab(title: string): Record<string, unknown> {
  return {
    id: 'chat',
    title,
    providerType: 'codex',
    interfaceMode: 'canopy',
    status: 'idle',
    planMode: false,
    thinkingLevel: 'high',
    messages: [],
    queuedMessages: [],
  };
}

describe('WorktreeChatSurface Cursor permission', () => {
  beforeAll((): void => {
    initAgentModels([]);
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
    initCodexModels([]);
  });
  beforeEach(() => {
    mockChatState = {
      ...buildChatState({ providerType: 'codex', interfaceMode: 'canopy' }),
      worktreeChats: {
        [`${APP_ADVISOR_PROJECT_ID}/entry`]: {
          activeTabId: 'chat',
          tabs: [codexTab('Advisor chat')],
        },
        'cowork-project/home': {
          activeTabId: 'chat',
          tabs: [codexTab('Cowork chat')],
        },
      },
    };
    registerCoworkWorkspaceIds(['cowork-project']);
  });
  afterEach(() => registerCoworkWorkspaceIds([]));

  it('lets App Advisor and Cowork chats opt into Cursor', () => {
    expect(renderAppAdvisorSurface()).toContain('data-allow-cursor="true"');
    expect(renderCoworkSurface()).toContain('data-allow-cursor="true"');
  });
});

describe('WorktreeChatSurface Claude Code mode (per-tab surface)', () => {
  beforeAll((): void => {
    initAgentModels([]);
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
    initCodexModels([]);
    initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
  });

  beforeEach(() => {
    mockChatState = buildChatState();
    mockSetChatInterfaceMode.mockReset();
    mockedUseCurrentUiStateReporter.mockClear();
    mockTransientRetryState = null;
    useOnboardingSuggestionSurfaces.setState({
      visible: false,
      queueStatus: 'loading',
    });
    registerCoworkWorkspaceIds(['cowork-project']);
  });

  afterEach(() => registerCoworkWorkspaceIds([]));

  it('renders the terminal experience for claude-code mode without the retired chat-stack chrome', () => {
    const html = renderSurface();

    expect(html).toContain('data-testid="claude-code-experience"');
    expect(html).toContain('data-testid="chat-interface-mode-toggle"');
    // The chat panel no longer hosts PrStatusBar / ChatTabBar / the terminal
    // drawer — those live in WorktreeTopBar and the 'terminal' panel kind.
    expect(html).not.toContain('data-testid="pr-status-bar"');
    expect(html).not.toContain('data-testid="chat-tab-bar"');
    expect(html).not.toContain('data-testid="terminal-drawer"');
  });

  it('does not mount the terminal experience while the hosting panel is hidden', () => {
    const html = renderToStaticMarkup(
      <CanopyClientProvider client={sharedClient}>
        <WorktreeChatSurface chatTabId="chat" visible={false} isActivePanel />
      </CanopyClientProvider>,
    );
    expect(html).not.toContain('data-testid="claude-code-experience"');
    // The mode toggle stays available so the user can switch back.
    expect(html).toContain('data-testid="chat-interface-mode-toggle"');
  });

  it.each([
    ['default Claude fallback', { providerType: undefined, model: undefined }],
    [
      'Claude model fallback',
      { providerType: undefined, model: 'claude-sonnet-4-6' },
    ],
  ])(
    'offers the modes in the composer and reports them as available for %s',
    (_label, tabOverrides) => {
      mockChatState = buildChatState({
        ...tabOverrides,
        interfaceMode: 'canopy',
      });

      const html = renderSurface();

      // The Canopy surface offers the modes in the composer's + menu, not a
      // floating toggle.
      expect(html).toContain('data-testid="composer-interface-modes"');
      expect(html).toContain('data-mode="canopy"');
      expect(html).not.toContain('data-testid="chat-interface-mode-toggle"');
      const chatReport = mockedUseCurrentUiStateReporter.mock.calls.find(
        ([slice]) => slice === 'chat.activeTab',
      )?.[1];
      expect(chatReport).toMatchObject({
        chatId: 'chat',
        interfaceMode: 'canopy',
        interfaceToggleDisabled: 'none',
      });
    },
  );

  it('routes the production native composer to the panel-bound chat tab', () => {
    mockChatState = buildChatState({ interfaceMode: 'canopy' });

    const html = renderSurface();

    expect(html).toContain('data-testid="chat-input"');
    expect(html).toContain(
      'data-target-override="{&quot;projectId&quot;:&quot;project&quot;,&quot;worktreeId&quot;:&quot;worktree&quot;,&quot;chatId&quot;:&quot;chat&quot;}"',
    );
  });

  it('replaces Work-chat example prompts with the active getting-started checklist', () => {
    mockChatState = {
      ...buildChatState({ providerType: 'codex', interfaceMode: 'canopy' }),
      worktreeChats: {
        'cowork-project/home': {
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'New chat',
              providerType: 'codex',
              interfaceMode: 'canopy',
              status: 'idle',
              planMode: false,
              thinkingLevel: 'high',
              messages: [],
              queuedMessages: [],
            },
          ],
        },
      },
    };
    useOnboardingSuggestionSurfaces.setState({
      visible: true,
      queueStatus: 'has-rows',
    });

    const html = renderCoworkSurface();

    expect(html).toContain('data-has-onboarding="true"');
    expect(html).toContain('data-testid="chat-onboarding-checklist-host"');
    expect(html).toContain('data-has-suggestions="false"');
    expect(html).not.toContain('data-testid="suggested-prompt-chips"');
  });

  it('returns Work-chat example prompts after the checklist is exhausted', () => {
    mockChatState = {
      ...buildChatState({ providerType: 'codex', interfaceMode: 'canopy' }),
      worktreeChats: {
        'cowork-project/home': {
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'New chat',
              providerType: 'codex',
              interfaceMode: 'canopy',
              status: 'idle',
              planMode: false,
              thinkingLevel: 'high',
              messages: [],
              queuedMessages: [],
            },
          ],
        },
      },
    };
    useOnboardingSuggestionSurfaces.setState({
      visible: true,
      queueStatus: 'exhausted',
    });

    const html = renderCoworkSurface();

    expect(html).toContain('data-has-onboarding="false"');
    expect(html).toContain('data-has-suggestions="true"');
    expect(html).toContain('data-testid="suggested-prompt-chips"');
  });

  it('keeps the mode toggle hidden for explicit non-Claude chats', () => {
    mockChatState = buildChatState({
      providerType: 'codex',
      interfaceMode: 'canopy',
    });

    const html = renderSurface();

    expect(html).not.toContain('data-testid="chat-interface-mode-toggle"');
    expect(html).not.toContain('data-testid="composer-interface-modes"');
    const chatReport = mockedUseCurrentUiStateReporter.mock.calls.find(
      ([slice]) => slice === 'chat.activeTab',
    )?.[1];
    expect(chatReport).toMatchObject({
      chatId: 'chat',
      interfaceToggleDisabled: 'hidden',
    });
  });

  it('reports the active transient retry banner state to App Advisor', () => {
    mockTransientRetryState = {
      provider: 'claude',
      attempt: 2,
      maxAttempts: 5,
      nextRetryAt: 60_000,
      exhausted: false,
    };

    renderSurface();

    const chatReport = mockedUseCurrentUiStateReporter.mock.calls.find(
      ([slice]) => slice === 'chat.activeTab',
    )?.[1];
    expect(chatReport).toMatchObject({
      chatId: 'chat',
      transientRetry: {
        provider: 'claude',
        attempt: 2,
        maxAttempts: 5,
        nextRetryAt: 60_000,
        exhausted: false,
      },
    });
  });

  it('does not report the chat.activeTab slice for a non-active tab surface', () => {
    const state = buildChatState({ interfaceMode: 'canopy' });
    const worktreeChats = state.worktreeChats as Record<
      string,
      { activeTabId: string }
    >;
    worktreeChats['project/worktree'].activeTabId = 'other-tab';
    mockChatState = state;

    renderSurface();

    expect(
      mockedUseCurrentUiStateReporter.mock.calls.find(
        ([slice]) => slice === 'chat.activeTab',
      ),
    ).toBeUndefined();
  });

  it('renders nothing when the selection is the standalone-chat pseudo-project', () => {
    mockChatState = {
      ...buildChatState(),
      selectedWorktree: {
        projectId: 'standalone-chat',
        worktreeId: 'default',
      },
      worktreeChats: {
        'standalone-chat/default': {
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'Standalone chat',
              providerType: 'codex',
              interfaceMode: 'canopy',
              status: 'idle',
              planMode: false,
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  content: 'Standalone transcript must not render here',
                  timestamp: '2026-05-22T00:00:00.000Z',
                },
              ],
              queuedMessages: [],
            },
          ],
        },
      },
    };

    const html = renderSurface();
    expect(html).toBe('');
  });
});
