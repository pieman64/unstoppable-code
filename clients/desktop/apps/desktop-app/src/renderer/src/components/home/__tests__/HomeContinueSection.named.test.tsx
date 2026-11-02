/**
 * @jest-environment jsdom
 *
 * A single interrupted entry is named on the Continue row, and a Last viewed
 * offer for the same worktree merges into it (CAN-4895).
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItem,
  UsageLimitedChatSessionItem,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import { openAutomationRunDestination } from '@/components/automations/resolveAutomationRunDestination';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useChatStore } from '@/stores/chatStore';
import type { ChatTab } from '@/stores/chat/types';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
import { useObservabilityStore } from '@/stores/observabilityStore';

import { useProjectsStore } from '@/stores/projectsStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { initChatPanelReveal } from '@/lib/panels/chat-panel-activation';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { HomeContinueSection } from '../HomeContinueSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/hooks/useContextScopedWorkspaces', () => {
  const isInContext = (): boolean => true;
  return {
    useContextScopedWorkspaces: (): { isInContext: () => boolean } => ({
      isInContext,
    }),
  };
});

const mockContextSwitches: string[] = [];

jest.mock('@/lib/contextScope', () => ({
  openInWorkspaceContextAsync: async (
    workspaceId: string,
    open: () => void | Promise<unknown>,
  ): Promise<void> => {
    mockContextSwitches.push(workspaceId);
    await open();
  },
}));

jest.mock('@/components/automations/resolveAutomationRunDestination', () => ({
  ...jest.requireActual<object>(
    '@/components/automations/resolveAutomationRunDestination',
  ),
  openAutomationRunDestination: jest.fn(),
}));

const workspace: Extract<SidebarItem, { type: 'single-repo' }> = {
  type: 'single-repo',
  id: 'ws',
  name: 'Workspace',
  repoPath: '/repo',
  color: '#000000',
  collapsed: false,
  order: 0,
  worktrees: ['a', 'b'].map((id) => ({
    id,
    branchName: `feature/${id}`,
    createdAt: '2026-10-24T12:00:00.000Z',
    label: `Worktree ${id.toUpperCase()}`,
  })),
};

function chat(
  chatId: string,
  overrides: Partial<UsageLimitedChatSessionItem> = {},
): UsageLimitedChatSessionItem {
  return {
    kind: 'chat',
    projectId: 'ws',
    worktreeId: 'a',
    chatId,
    provider: 'claude',
    chatTitle: `Chat ${chatId}`,
    detectedAt: 1,
    worktreeName: 'registry-name',
    resumeReason: 'app_shutdown',
    ...overrides,
  };
}

function group(
  ...sessions: UsageLimitedSessionGroup['sessions']
): UsageLimitedSessionGroup {
  return {
    groupId: 'ws',
    groupKind: 'workspace',
    workspaceId: 'ws',
    workspaceName: 'Registry workspace',
    sessions,
  };
}

const listSessionsMock = jest.fn<Promise<UsageLimitedSessionGroup[]>, []>();
const hydrateChatScopeRevisioned =
  useChatStore.getState().hydrateChatScopeRevisioned;

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  act(() => {
    byTestId(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function seedActiveChat(
  title: string,
  chatId = 'different-active-tab',
  names: Pick<ChatTab, 'description' | 'customTitle'> = {},
): void {
  const tab: ChatTab = {
    id: chatId,
    title,
    ...names,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-24T12:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false, speed: 'standard' },
    fastModeExplicit: false,
    proposalMode: 'optional',
  };
  useChatStore.setState({
    worktreeChats: { 'ws/a': { activeTabId: tab.id, tabs: [tab] } },
  });
}

describe('HomeContinueSection named interrupted session', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    initChatPanelReveal();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mockContextSwitches.length = 0;
    jest.mocked(openAutomationRunDestination).mockReset().mockResolvedValue({
      ok: true,
    });
    listSessionsMock.mockReset().mockResolvedValue([group(chat('c1'))]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: listSessionsMock },
    });
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      hydrated: false,
      loading: false,
      error: null,
    });
    useUsageLimitResumePromptStore.getState().close();
    useHomeInterruptedSessionsBannerStore.setState({
      dismissedSignature: null,
    });
    useObservabilityStore.setState({ usage: { updatedAt: '', providers: [] } });

    useProjectsStore.setState({ projects: [workspace] });
    useChatStore.setState({ worktreeChats: {}, hydrateChatScopeRevisioned });
    useStartupResumeStore.setState({
      offer: { kind: 'worktree', projectId: 'ws', worktreeId: 'a' },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    usePanelLayoutStore
      .getState()
      .disposeLayout(makeWorktreePanelKey('ws', 'a'));
    jest.restoreAllMocks();
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, {
          interruptedActive: true,
          isPageVariant: true,
        }),
      );
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  }

  it('merges a matching Last viewed offer into one named row', async () => {
    await render();
    expect(byTestId('home-interrupted-sessions-details')?.textContent).toBe(
      'Resume Chat c1 Interrupted · Worktree A · Workspace',
    );
    expect(byTestId('home-resume-details')).toBeNull();
    // The offer itself is still live, so Getting started keeps its trim.
  });

  it('names a single entry without a Last viewed offer and keeps normal trim', async () => {
    useStartupResumeStore.setState({ offer: null });
    await render();
    expect(byTestId('home-interrupted-sessions-title')?.textContent).toBe(
      'Chat c1',
    );
  });

  it('opens the exact chat without resuming it', async () => {
    seedActiveChat('Different active chat');
    await render();
    click('home-interrupted-sessions-open');
    expect(mockContextSwitches).toEqual(['ws']);
    expect(openAutomationRunDestination).toHaveBeenCalledWith({
      kind: 'worktree-chat',
      projectId: 'ws',
      worktreeId: 'a',
      chatId: 'c1',
    });
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  it.each([true, false])(
    'reveals an already-active collapsed chat only when Open succeeds (%s)',
    async (ok) => {
      seedActiveChat('Chat c1', 'c1');
      const key = makeWorktreePanelKey('ws', 'a');
      const panels = usePanelLayoutStore.getState();
      panels.initializeLayout(key, {
        orientation: 'horizontal',
        groups: [
          {
            kind: 'chat',
            groupId: 'group-chat',
            panelId: 'panel-chat-c1',
            instance: { chatTabId: 'c1' },
          },
          { kind: 'terminal', groupId: 'group-terminal', panelId: 'terminal' },
        ],
        containerSize: { width: 1200, height: 800 },
      });
      expect(panels.collapseGroup(key, 'group-chat')).toBe(true);
      jest
        .mocked(openAutomationRunDestination)
        .mockResolvedValue(
          ok ? { ok: true } : { ok: false, error: 'Chat unavailable' },
        );
      await render();
      await act(async () => {
        click('home-interrupted-sessions-open');
        await Promise.resolve();
      });
      const layout = usePanelLayoutStore.getState().layouts[key];
      expect(layout.groups['group-chat'].collapsed === undefined).toBe(ok);
      if (ok) expect(layout.activeGroupId).toBe('group-chat');
      expect(useChatStore.getState().worktreeChats['ws/a']?.activeTabId).toBe(
        'c1',
      );
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    },
  );

  it('keeps a display-only rename dismissed', async () => {
    await render();
    click('home-interrupted-sessions-dismiss');
    listSessionsMock.mockResolvedValue([
      group(chat('c1', { chatTitle: 'Renamed task' })),
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(byTestId('home-interrupted-sessions-banner')).toBeNull();
    expect(byTestId('home-resume-chat-title')?.textContent).toBe(
      'Renamed task',
    );
  });

  it('shows the active title without an interrupted entry', async () => {
    seedActiveChat('Existing active title');
    listSessionsMock.mockResolvedValue([]);
    await render();
    expect(byTestId('home-resume-chat-title')?.textContent).toBe(
      'Existing active title',
    );
  });

  it('prefetches an unhydrated Last viewed scope without selecting it', async () => {
    listSessionsMock.mockResolvedValue([]);
    const selection = useChatStore.getState().selectedWorktree;
    const hydrate = jest
      .spyOn(useChatStore.getState(), 'hydrateChatScopeRevisioned')
      .mockImplementation(() => {
        seedActiveChat('Persisted resumed title');
        return Promise.resolve<'installed'>('installed');
      });
    await render();
    expect(hydrate).toHaveBeenCalledWith('ws', 'a', { speculative: true });
    expect(byTestId('home-resume-chat-title')?.textContent).toBe(
      'Persisted resumed title',
    );
    expect(useChatStore.getState().selectedWorktree).toBe(selection);
    expect(useStartupResumeStore.getState().offer).not.toBeNull();
  });

  it('does not repeat a fallback primary title as secondary text', async () => {
    seedActiveChat('Worktree A');
    listSessionsMock.mockResolvedValue([]);
    await render();
    expect(byTestId('home-resume-destination')?.textContent).toBe('Worktree A');
    expect(byTestId('home-resume-chat-title')).toBeNull();
  });

  it('restores Last viewed with the chat title after a dismissal', async () => {
    await render();
    click('home-interrupted-sessions-dismiss');
    expect(byTestId('home-interrupted-sessions-banner')).toBeNull();
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    expect(byTestId('home-resume-destination')?.textContent).toBe('Worktree A');
    expect(byTestId('home-resume-chat-title')?.textContent).toBe('Chat c1');
  });

  it('keeps Last viewed for an interrupted chat in another worktree', async () => {
    listSessionsMock.mockResolvedValue([
      group(chat('c1', { worktreeId: 'b' })),
    ]);
    await render();
    expect(byTestId('home-interrupted-sessions-context')?.textContent).toBe(
      'Interrupted · Worktree B · Workspace',
    );
    expect(byTestId('home-resume-details')).not.toBeNull();
    expect(byTestId('home-resume-chat-title')).toBeNull();
  });

  it('neither merges nor opens a chat whose workspace is unknown', async () => {
    listSessionsMock.mockResolvedValue([
      group(chat('c1', { projectId: 'gone', worktreeName: 'a' })),
    ]);
    await render();
    // The registry worktree name is only the raw id here, so it is left out.
    expect(byTestId('home-interrupted-sessions-context')?.textContent).toBe(
      'Interrupted · Registry workspace',
    );
    expect(byTestId('home-interrupted-sessions-open')).toBeNull();
    expect(byTestId('home-resume-details')).not.toBeNull();
  });

  it('names a blank chat with its existing display fallback', async () => {
    listSessionsMock.mockResolvedValue([group(chat('c1', { chatTitle: ' ' }))]);
    await render();
    expect(byTestId('home-interrupted-sessions-details')?.textContent).toBe(
      'Resume Untitled chat Interrupted · Worktree A · Workspace',
    );
    expect(byTestId('home-resume-details')).toBeNull();
  });

  it('opens a current cowork target without merging Last viewed', async () => {
    const cowork: SidebarItem = {
      type: 'cowork',
      id: 'cowork',
      name: 'Cowork',
      color: '#000000',
      collapsed: false,
      order: 1,
    };
    useProjectsStore.setState({ projects: [workspace, cowork] });
    listSessionsMock.mockResolvedValue([
      group(
        chat('c1', {
          projectId: 'cowork',
          worktreeId: 'entry-1',
          worktreeName: '',
        }),
      ),
    ]);
    await render();
    expect(byTestId('home-interrupted-sessions-open')).not.toBeNull();
    expect(byTestId('home-resume-details')).not.toBeNull();
    click('home-interrupted-sessions-open');
    expect(mockContextSwitches).toEqual(['cowork']);
    expect(openAutomationRunDestination).toHaveBeenCalledWith({
      kind: 'worktree-chat',
      projectId: 'cowork',
      worktreeId: 'entry-1',
      chatId: 'c1',
    });
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
  });

  it('does not offer Open for an empty chat identity', async () => {
    listSessionsMock.mockResolvedValue([group(chat(''))]);
    await render();
    expect(byTestId('home-interrupted-sessions-open')).toBeNull();
    expect(byTestId('home-resume-details')).not.toBeNull();
  });

  it.each(['Release', ' '])(
    'names workflow %p without an Open action',
    async (pipelineName) => {
      listSessionsMock.mockResolvedValue([
        group({
          kind: 'pipeline',
          executionId: 'exec-1',
          statusReasonIds: ['r1'],
          pipelineName,
          detectedAt: 1,
          pausedStepCount: 1,
          modelLabels: [],
          otherBlockingReasonCount: 0,
        }),
      ]);
      await render();
      expect(byTestId('home-interrupted-sessions-details')?.textContent).toBe(
        `Resume ${pipelineName.trim() || 'Untitled workflow'} Interrupted · Workflow · Registry workspace`,
      );
      expect(byTestId('home-interrupted-sessions-open')).toBeNull();
      expect(byTestId('home-resume-details')).not.toBeNull();
    },
  );

  describe('with several interrupted entries', () => {
    it('uses the active title when none of the interrupted chats match', async () => {
      seedActiveChat('Existing active title');
      listSessionsMock.mockResolvedValue([
        group(chat('c1', { worktreeId: 'b' }), chat('c2', { worktreeId: 'b' })),
      ]);
      await render();
      expect(byTestId('home-resume-chat-title')?.textContent).toBe(
        'Existing active title',
      );
    });
    it('keeps the count row and names the one matching chat on Last viewed', async () => {
      listSessionsMock.mockResolvedValue([
        group(chat('c1'), chat('c2', { worktreeId: 'b' })),
      ]);
      await render();
      expect(byTestId('home-interrupted-sessions-details')?.textContent).toBe(
        'Resume 2 interrupted chats',
      );
      expect(byTestId('home-resume-details')).not.toBeNull();
      expect(byTestId('home-resume-chat-title')?.textContent).toBe('Chat c1');
    });

    it('does not pick among several chats in the Last viewed worktree', async () => {
      seedActiveChat('Existing active title');
      listSessionsMock.mockResolvedValue([group(chat('c1'), chat('c2'))]);
      await render();
      expect(byTestId('home-resume-details')).not.toBeNull();
      expect(byTestId('home-resume-chat-title')?.textContent).toBe(
        'Existing active title',
      );
    });
  });

  describe('naming an unlabeled Last viewed worktree (CAN-5008)', () => {
    function useWorktreeA(branchName: string, label?: string): void {
      useProjectsStore.setState({
        projects: [
          {
            ...workspace,
            worktrees: [
              {
                id: 'a',
                branchName,
                createdAt: '2026-10-24T12:00:00.000Z',
                ...(label === undefined ? {} : { label }),
              },
            ],
          },
        ],
      });
    }

    function resumeRow(): Record<string, string | undefined> {
      return {
        destination: byTestId('home-resume-destination')?.textContent ?? '',
        chatTitle: byTestId('home-resume-chat-title')?.textContent,
        worktreeName: byTestId('home-resume-worktree-name')?.textContent,
        context: byTestId('home-resume-destination')?.nextElementSibling
          ?.textContent,
      };
    }

    beforeEach(() => {
      listSessionsMock.mockResolvedValue([]);
    });

    it.each<[string, string, string | undefined, string | null, object]>([
      [
        'a named branch with a titled chat',
        'checkout-form-labels',
        undefined,
        'Label checkout form inputs',
        {
          destination: 'Label checkout form inputs',
          worktreeName: 'checkout-form-labels',
          context: 'checkout-form-labels · Workspace',
        },
      ],
      [
        'a named branch without a title',
        'checkout-form-labels',
        undefined,
        null,
        { destination: 'checkout-form-labels', context: 'Workspace' },
      ],
      [
        'a default branch with a titled chat',
        'a',
        undefined,
        'Label checkout form inputs',
        { destination: 'Label checkout form inputs', context: 'Workspace' },
      ],
      [
        'a default branch without a title',
        'a',
        undefined,
        null,
        { destination: 'New Task', context: 'Workspace' },
      ],
      [
        'a labeled worktree',
        'checkout-form-labels',
        'Storefront fixes',
        'Label checkout form inputs',
        {
          destination: 'Storefront fixes',
          chatTitle: 'Label checkout form inputs',
          context: 'Label checkout form inputs · Workspace',
        },
      ],
    ])('names %s', async (_case, branchName, label, title, expected) => {
      useWorktreeA(branchName, label);
      if (title !== null) seedActiveChat(title);
      await render();
      expect(resumeRow()).toEqual({
        chatTitle: undefined,
        worktreeName: undefined,
        ...expected,
      });
    });

    it('updates the destination as tabs hydrate and titles change, keeping the offer', async () => {
      useWorktreeA('checkout-form-labels');
      const hydrate = jest
        .spyOn(useChatStore.getState(), 'hydrateChatScopeRevisioned')
        .mockResolvedValue('installed');
      await render();
      expect(hydrate).toHaveBeenCalled();
      expect(resumeRow().destination).toBe('checkout-form-labels');

      act(() => seedActiveChat('Label checkout form inputs'));
      expect(resumeRow()).toMatchObject({
        destination: 'Label checkout form inputs',
        worktreeName: 'checkout-form-labels',
      });

      act(() => seedActiveChat('Renamed checkout task'));
      expect(resumeRow().destination).toBe('Renamed checkout task');
      expect(useStartupResumeStore.getState().offer).toEqual({
        kind: 'worktree',
        projectId: 'ws',
        worktreeId: 'a',
      });
    });

    it('updates label and branch context when worktree details change', async () => {
      useWorktreeA('checkout-form-labels');
      seedActiveChat('Label checkout form inputs');
      await render();

      act(() => useWorktreeA('renamed-branch', 'Checkout fixes'));
      expect(resumeRow()).toEqual({
        destination: 'Checkout fixes',
        chatTitle: 'Label checkout form inputs',
        worktreeName: undefined,
        context: 'Label checkout form inputs · Workspace',
      });

      act(() => useWorktreeA('renamed-branch', '  '));
      expect(resumeRow()).toMatchObject({
        destination: 'Label checkout form inputs',
        worktreeName: 'renamed-branch',
      });
    });

    it.each(['workspace', 'worktree'])(
      'omits Last viewed when the offered %s details are missing',
      async (missing) => {
        useProjectsStore.setState({
          projects:
            missing === 'workspace' ? [] : [{ ...workspace, worktrees: [] }],
        });
        await render();
        expect(byTestId('home-resume-details')).toBeNull();
        expect(useStartupResumeStore.getState().offer).toEqual({
          kind: 'worktree',
          projectId: 'ws',
          worktreeId: 'a',
        });
      },
    );

    it('keeps the Cowork Last viewed destination and workspace context', async () => {
      useProjectsStore.setState({
        projects: [
          {
            type: 'cowork',
            id: 'cowork',
            name: 'Notes',
            color: '#000000',
            collapsed: false,
            order: 0,
          },
        ],
      });
      useStartupResumeStore.setState({
        offer: { kind: 'cowork', workspaceId: 'cowork' },
      });
      await render();
      expect(resumeRow()).toEqual({
        destination: 'Cowork chat',
        chatTitle: undefined,
        worktreeName: undefined,
        context: 'Notes',
      });
    });

    it('names the chat as its tab does, not by its placeholder title', async () => {
      useWorktreeA('checkout-form-labels');
      seedActiveChat('New Chat', 'active', {
        description: 'Label checkout form inputs',
      });
      await render();
      expect(resumeRow()).toMatchObject({
        destination: 'Label checkout form inputs',
        worktreeName: 'checkout-form-labels',
      });

      act(() =>
        seedActiveChat('New Chat', 'active', {
          description: 'Label checkout form inputs',
          customTitle: 'Checkout labels',
        }),
      );
      expect(resumeRow().destination).toBe('Checkout labels');
    });

    it('prefers the sole interrupted chat title over a different active title', async () => {
      useWorktreeA('checkout-form-labels');
      seedActiveChat('Active title');
      listSessionsMock.mockResolvedValue([group(chat('c1'))]);
      await render();
      click('home-interrupted-sessions-dismiss');
      expect(resumeRow()).toMatchObject({
        destination: 'Chat c1',
        worktreeName: 'checkout-form-labels',
        chatTitle: undefined,
      });
    });

    it('falls back to the active title for a blank interrupted title', async () => {
      useWorktreeA('checkout-form-labels');
      seedActiveChat('Active title');
      listSessionsMock.mockResolvedValue([
        group(chat('c1', { chatTitle: '  ' })),
      ]);
      await render();
      click('home-interrupted-sessions-dismiss');
      expect(resumeRow().destination).toBe('Active title');
    });

    it.each([
      ['several interrupted chats in the worktree', [chat('c1'), chat('c2')]],
      [
        'an interrupted chat in another worktree',
        [chat('c1', { worktreeId: 'b' })],
      ],
    ])('uses the active title with %s', async (_case, sessions) => {
      useWorktreeA('checkout-form-labels');
      seedActiveChat('Active title');
      listSessionsMock.mockResolvedValue([group(...sessions)]);
      await render();
      expect(resumeRow().destination).toBe('Active title');
    });
  });
});
