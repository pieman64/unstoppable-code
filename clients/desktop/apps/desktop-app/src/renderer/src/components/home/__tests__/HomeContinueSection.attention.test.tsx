/**
 * @jest-environment jsdom
 *
 * Home Continue ranks waiting questions and unread results above the Last
 * viewed destination and opens each row's exact chat (CAN-4958).
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { ChatTab, WorktreeChatState } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';

import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { isResumePending } from '@/lib/resume-lifecycle';
import { decidePresentation } from '@/lib/release-highlights/presentation-gate';
import { HomeContinueSection } from '../HomeContinueSection';

import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

/** Opens the section's ••• menu and picks Hide section. */
function clickHideSection(root: ParentNode = document): void {
  const trigger = root.querySelector<HTMLButtonElement>(
    '[data-testid^="home-section-more-"]',
  );
  if (!trigger) throw new Error('Missing section menu');
  trigger.focus();
  act(() => trigger.click());
  const menu = document.getElementById(
    trigger.getAttribute('aria-controls') ?? '',
  );
  const hide = menu?.querySelector<HTMLElement>(
    '[data-testid^="home-section-hide-"]',
  );
  if (!hide) throw new Error('Missing Hide section');
  act(() => hide.click());
}

jest.mock('@/hooks/useContextScopedWorkspaces', () => {
  const isInContext = (): boolean => true;
  return {
    useContextScopedWorkspaces: (): { isInContext: () => boolean } => ({
      isInContext,
    }),
  };
});

// Context switches can complete asynchronously; `defer` holds the open until
// a test runs it.
const mockContextSwitch: {
  defer: boolean;
  fail: boolean;
  pending: (() => void)[];
} = {
  defer: false,
  fail: false,
  pending: [],
};
jest.mock('@/lib/contextScope', () => ({
  openInWorkspaceContextAsync: async (
    _workspaceId: string,
    open: () => void | Promise<void>,
  ): Promise<void> => {
    if (!mockContextSwitch.defer) {
      await open();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      mockContextSwitch.pending.push((): void => {
        if (mockContextSwitch.fail) {
          reject(new Error('context switch rejected'));
          return;
        }
        void Promise.resolve(open()).then(resolve, reject);
      });
    });
  },
}));

jest.mock('@/lib/chatPanelReveal', () => ({
  requestChatPanelReveal: jest.fn(),
}));

function tab(overrides: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: `Chat ${overrides.id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-24T12:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    proposalMode: 'optional',
    lastAcceptedUserMessageId: 'u',
    turnEnds: { u: { outcome: 'completed', endedAt: 100 } },
    ...overrides,
  };
}

function worktree(...tabs: ChatTab[]): WorktreeChatState {
  return { activeTabId: tabs[0]?.id ?? null, tabs };
}

const workspace: SidebarItem = {
  type: 'single-repo',
  id: 'ws',
  name: 'Workspace',
  repoPath: '/repo',
  color: '#000000',
  collapsed: false,
  order: 0,
  worktrees: ['a', 'b', 'c'].map((id) => ({
    id,
    branchName: `feature/${id}`,
    createdAt: '2026-10-24T12:00:00.000Z',
    label: `Worktree ${id.toUpperCase()}`,
  })),
};

const selectWorktree = jest.fn();
const switchTab = jest.fn();
const realChatActions = useChatStore.getState();

function rowOrder(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-attention-kind], [data-testid="home-resume-details"]',
    ),
  ).map((element) =>
    element.dataset.testid === 'home-resume-details'
      ? 'last-viewed'
      : `${element.dataset.attentionKind}:${element.dataset.chatId}`,
  );
}

describe('HomeContinueSection attention rows', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    selectWorktree.mockReset();
    switchTab.mockReset();
    mockContextSwitch.defer = false;
    mockContextSwitch.fail = false;
    mockContextSwitch.pending = [];
    jest.mocked(requestChatPanelReveal).mockReset();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: jest.fn().mockResolvedValue([]) },
    });

    useProjectsStore.setState({ projects: [workspace] });
    useStartupResumeStore.setState({
      offer: { kind: 'worktree', projectId: 'ws', worktreeId: 'a' },
    });
    useChatStore.setState({
      selectWorktree,
      loadTabs: jest.fn().mockResolvedValue(undefined),
      switchTab,
      worktreeChats: {
        'ws/a': worktree(tab({ id: 'a1' })),
        'ws/b': worktree(tab({ id: 'b0' }), tab({ id: 'b1', title: 'Deploy' })),
        'ws/c': worktree(
          tab({ id: 'c0' }),
          tab({ id: 'c1', unread: true, lastEventAt: 2 }),
          tab({ id: 'c2', unread: true, lastEventAt: 1 }),
        ),
      },
      unreadWorktreeKeys: new Set(['ws/c']),
      pendingQuestions: {
        'q-1': {
          requestId: 'q-1',
          projectId: 'ws',
          worktreeId: 'b',
          chatId: 'b1',
          questions: [],
        },
      },
      pendingApprovals: {},
      persistedWorktreeBadges: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
      pendingQuestions: {},
    });
  });

  async function render(isPageVariant = true): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, {
          interruptedActive: false,
          isPageVariant,
        }),
      );
      await Promise.resolve();
    });
  }

  it('clears advisor visibility while Continue is hidden and restores it on reopen', async () => {
    await render();
    expect(
      useCurrentUiStateStore.getState().slices['home.continueAttention'],
    ).toBeDefined();
    clickHideSection(container);
    expect(
      container.querySelector('[data-testid="home-resume-card"]'),
    ).toBeNull();
    expect(
      useCurrentUiStateStore.getState().slices['home.continueAttention'],
    ).toBeUndefined();
    expect(
      useCurrentUiStateStore.getState().slices[
        'home.interruptedSessionsBanner'
      ],
    ).toBeUndefined();
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Show Continue')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="home-resume-card"]'),
    ).not.toBeNull();
    expect(
      useCurrentUiStateStore.getState().slices['home.continueAttention'],
    ).toBeDefined();
  });

  it('ranks the question, then unread results, then Last viewed', async () => {
    await render();

    expect(rowOrder(container)).toEqual([
      'question:b1',
      'unread:c1',
      'unread:c2',
      'last-viewed',
    ]);
    const questionRow = container.querySelector(
      '[data-testid="home-continue-question-row"]',
    );
    expect(questionRow?.textContent).toContain(
      'Deploy is waiting for your answer',
    );
    expect(questionRow?.textContent).toContain('Worktree B · Workspace');
    expect(
      container.querySelector('[data-testid="home-continue-unread-summary"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="home-resume-button"]')
        ?.textContent,
    ).toContain('Last viewed: Worktree A');
  });

  it('opens the exact chat tab without resolving the question', async () => {
    await render();
    act(() => useNavigationStore.setState({ activePage: 'home' }));

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-continue-question-row"] button',
        )
        ?.click();
    });

    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(selectWorktree).toHaveBeenCalledWith('ws', 'b', {
      deferTabLoad: true,
    });
    expect(switchTab).toHaveBeenCalledWith('b1', {
      projectId: 'ws',
      worktreeId: 'b',
    });
    expect(requestChatPanelReveal).toHaveBeenCalledWith('ws', 'b', 'b1');
    expect(useChatStore.getState().pendingQuestions['q-1']).toBeDefined();
    expect(
      container.querySelector('[data-testid="home-continue-question-row"]'),
    ).not.toBeNull();
  });

  it.each([
    ['Last viewed', 'success'],
    ['Last viewed', 'failure'],
    ['cold unread', 'success'],
    ['cold unread', 'failure'],
  ])(
    'keeps %s pending through foreground tab loading and cleans up on %s',
    async (entry, outcome) => {
      const before = useChatStore.getState();
      let settle = (): void => {};
      const loading = new Promise<void>((resolve, reject) => {
        settle = (): void => {
          if (outcome === 'failure') reject(new Error('tab load failed'));
          else resolve();
        };
      });
      const loadTabs = jest.fn(() => loading);
      Object.assign(window.api, {
        github: {
          setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
          requestFastRefresh: jest.fn().mockResolvedValue(undefined),
        },
        savePreferences: jest.fn().mockResolvedValue(undefined),
      });
      useChatStore.setState({
        selectWorktree: realChatActions.selectWorktree,
        loadTabs,
        approvalDefaultsCache: { ws: 'ask' },
        selectedWorktree: null,
      });
      if (entry === 'cold unread') {
        useChatStore.setState({
          worktreeChats: {},
          persistedWorktreeBadges: {
            'ws/a': {
              version: 2,
              updatedAt: '2026-10-24T12:00:00.000Z',
              unreadChats: [{ chatId: 'a1', title: 'Persisted' }],
              approvalChats: [],
              needsHydration: false,
            },
          },
        });
      }
      try {
        await render();
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              entry === 'Last viewed'
                ? '[data-testid="home-resume-button"]'
                : '[data-testid="home-continue-unread-row"] button',
            )
            ?.click();
          await Promise.resolve();
        });
        expect(loadTabs).toHaveBeenCalledTimes(1);
        expect(useChatStore.getState().selectedWorktree).toEqual({
          projectId: 'ws',
          worktreeId: 'a',
        });
        // An armed return-to-Home milestone must still wait after its quiet
        // deadline while this actual Continue load has not settled.
        expect(
          decidePresentation({
            blockers: isResumePending() ? ['resume-pending'] : [],
            deferred: true,
            milestoneArmed: true,
            lastInteractionAt: 0,
            now: 2_001,
          }),
        ).toEqual({ action: 'wait' });
        await act(async () => {
          settle();
          await loading.catch(() => undefined);
        });
        expect(isResumePending()).toBe(false);
      } finally {
        await act(async () => {
          settle();
          await loading.catch(() => undefined);
          useChatStore.setState(before);
        });
      }
    },
  );

  it('reads only the requested result when another unread tab was active', async () => {
    const before = useChatStore.getState();
    Object.assign(window.api, {
      github: {
        setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
        requestFastRefresh: jest.fn().mockResolvedValue(undefined),
      },
      savePreferences: jest.fn().mockResolvedValue(undefined),
    });
    useNavigationStore.setState({ activePage: 'home' });
    useChatStore.setState({
      selectWorktree: realChatActions.selectWorktree,
      switchTab: realChatActions.switchTab,
      loadTabs: jest.fn().mockResolvedValue(undefined),
      approvalDefaultsCache: { ws: 'ask' },
      tabDiscoveryLoading: new Set(['c1', 'c2']),
      selectedWorktree: { projectId: 'ws', worktreeId: 'a' },
      worktreeChats: {
        ...before.worktreeChats,
        'ws/c': worktree(
          tab({ id: 'c1', unread: true, lastEventAt: 2 }),
          tab({ id: 'c2', unread: true, lastEventAt: 1 }),
        ),
      },
    });
    try {
      await render();
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-chat-id="c2"] button')
          ?.click();
      });
      const chats = useChatStore.getState().worktreeChats['ws/c'];
      expect(chats?.activeTabId).toBe('c2');
      expect(chats?.tabs.find((entry) => entry.id === 'c2')?.unread).toBe(
        false,
      );
      expect(chats?.tabs.find((entry) => entry.id === 'c1')?.unread).toBe(true);
      expect(useChatStore.getState().unreadWorktreeKeys.has('ws/c')).toBe(true);
    } finally {
      act(() => useChatStore.setState(before));
    }
  });

  it('opens nothing for a chat that disappeared before the open ran', async () => {
    await render();
    mockContextSwitch.defer = true;
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-continue-question-row"] button',
        )
        ?.click();
    });
    expect(mockContextSwitch.pending).toHaveLength(1);
    // The open stays pending through the context switch (CAN-5006).
    expect(isResumePending()).toBe(true);

    act(() =>
      useChatStore.setState({
        worktreeChats: {
          ...useChatStore.getState().worktreeChats,
          'ws/b': worktree(tab({ id: 'b0' })),
        },
      }),
    );
    act(() => mockContextSwitch.pending.forEach((open) => open()));
    await act(async () => {
      await Promise.resolve();
    });

    expect(selectWorktree).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
    expect(isResumePending()).toBe(false);
  });

  it('clears a failed pending context switch without navigating', async () => {
    await render();
    mockContextSwitch.defer = true;
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-continue-question-row"] button',
        )
        ?.click();
    });
    expect(mockContextSwitch.pending).toHaveLength(1);
    // The open stays pending through the context switch (CAN-5006).
    expect(isResumePending()).toBe(true);

    mockContextSwitch.fail = true;
    act(() => mockContextSwitch.pending.forEach((open) => open()));
    await act(async () => {
      await Promise.resolve();
    });

    expect(selectWorktree).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
    expect(isResumePending()).toBe(false);
  });

  it.each(['hidden', 'unloaded'])(
    'opens nothing when its target becomes %s during context navigation',
    async (change) => {
      await render();
      mockContextSwitch.defer = true;
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-continue-question-row"] button',
          )
          ?.click(),
      );
      act(() => {
        if (change === 'hidden') {
          useProjectsStore.setState({
            projects: [
              {
                ...workspace,
                worktrees: workspace.worktrees.map((entry) =>
                  entry.id === 'b' ? { ...entry, hidden: true } : entry,
                ),
              },
            ],
          });
        } else {
          useChatStore.setState({ worktreeChats: {} });
        }
      });
      act(() => mockContextSwitch.pending.forEach((open) => open()));
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(switchTab).not.toHaveBeenCalled();
    },
  );

  it('suppresses Last viewed while attention targets its worktree, and restores it', async () => {
    act(() =>
      useStartupResumeStore.setState({
        offer: { kind: 'worktree', projectId: 'ws', worktreeId: 'b' },
      }),
    );
    await render();
    expect(
      container.querySelector('[data-testid="home-resume-details"]'),
    ).toBeNull();
    expect(useStartupResumeStore.getState().offer).not.toBeNull();

    act(() => useChatStore.setState({ pendingQuestions: {} }));
    expect(
      container.querySelector('[data-testid="home-resume-details"]'),
    ).not.toBeNull();
  });

  it('tells App Advisor Last viewed is gone once Show more reveals its worktree', async () => {
    act(() =>
      useChatStore.setState({
        worktreeChats: {
          'ws/a': worktree(tab({ id: 'a1', unread: true, lastEventAt: 1 })),
          'ws/b': worktree(
            tab({ id: 'b0' }),
            tab({ id: 'b1', title: 'Deploy' }),
          ),
          'ws/c': worktree(
            ...[10, 9, 8, 7].map((at) =>
              tab({ id: `c${at}`, unread: true, lastEventAt: at }),
            ),
          ),
        },
        unreadWorktreeKeys: new Set(['ws/a', 'ws/c']),
      }),
    );
    await render();
    const advisor = (): unknown =>
      useCurrentUiStateStore.getState().slices['home.continueAttention'];
    expect(rowOrder(container)).toHaveLength(6);
    expect(rowOrder(container).at(-1)).toBe('last-viewed');
    expect(advisor()).toMatchObject({ lastViewedVisible: true });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-continue-show-more"]',
        )
        ?.click(),
    );
    expect(rowOrder(container)).not.toContain('last-viewed');
    expect(advisor()).toMatchObject({ lastViewedVisible: false });
  });

  it('collapses Getting started for attention alone and behaves as before without it', async () => {
    act(() => useStartupResumeStore.setState({ offer: null }));
    await render();

    act(() =>
      useChatStore.setState({
        pendingQuestions: {},
        unreadWorktreeKeys: new Set(),
      }),
    );
    expect(
      container.querySelector('[data-testid="home-resume-card"]'),
    ).toBeNull();
  });

  it('keeps its rows when streamed content changes no attention field', async () => {
    await render();
    const before = container.querySelector(
      '[data-testid="home-continue-question-row"]',
    );

    act(() => {
      const chats = useChatStore.getState().worktreeChats;
      const b = chats['ws/b'];
      if (!b) throw new Error('fixture missing');
      useChatStore.setState({
        worktreeChats: {
          ...chats,
          'ws/b': {
            ...b,
            tabs: b.tabs.map((candidate) =>
              candidate.id === 'b0'
                ? { ...candidate, status: 'streaming' as const }
                : candidate,
            ),
          },
        },
      });
    });

    expect(
      container.querySelector('[data-testid="home-continue-question-row"]'),
    ).toBe(before);
  });
});
