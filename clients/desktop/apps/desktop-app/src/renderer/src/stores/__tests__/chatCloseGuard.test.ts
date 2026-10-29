/**
 * The shared "can this chat close?" predicate used by `closeTab`/`closeTabs`,
 * the tab context menu, the tab ×, and every panel close path.
 */
import type { ChatTab } from '../chat/types';
import {
  DELEGATES_BLOCK_CLOSE_NOTICE,
  getChatTabCloseBlocker,
  isChatTabBusy,
  isChatTabTurnActive,
  notifyDelegatesBlockClose,
} from '../chat/close-guard';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '../delegationActivityStore';
import { useGitHubStore } from '../githubStore';

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-28T00:00:00.000Z',
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

function setLiveDelegates(chatId: string, live: number, queued = 0): void {
  useDelegationActivityStore.getState().applyActivity({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId,
    live,
    queued,
  });
}

const originalAddToast = useGitHubStore.getState().addToast;

beforeEach(() => {
  useGitHubStore.setState({
    toasts: [],
    notifications: [],
    addToast: originalAddToast,
  });
});

afterEach(() => {
  resetDelegationActivityStoreForTests();
});

describe('chat close guard', () => {
  it('lets an idle chat and every file tab close', () => {
    expect(getChatTabCloseBlocker(makeTab(), 'proj', 'wt')).toBeNull();
    setLiveDelegates('file-1', 1);
    expect(
      getChatTabCloseBlocker(
        makeTab({ id: 'file-1', kind: 'file', status: 'streaming' }),
        'proj',
        'wt',
      ),
    ).toBeNull();
  });

  it.each([
    ['streaming', makeTab({ status: 'streaming' })],
    ['queued', makeTab({ queuedMessages: [{ text: 'Next' }] })],
    ['pending plan exit', makeTab({ pendingPlanExit: { plan: 'Plan' } })],
  ])('keeps a %s chat open for its own turn', (_name, tab) => {
    expect(isChatTabTurnActive(tab)).toBe(true);
    expect(getChatTabCloseBlocker(tab, 'proj', 'wt')).toBe('active');
  });

  it('lets a lone queued hook placeholder close', () => {
    const tab = makeTab({
      queuedHookPlaceholder: true,
      queuedMessages: [{ text: 'Hook prompt', queuedHookQueueId: 'queue-1' }],
    });
    expect(isChatTabBusy(tab, 'proj', 'wt')).toBe(false);
  });

  it('keeps an idle chat with live delegates open, even with only queued delegations', () => {
    setLiveDelegates('chat-1', 0, 1);
    const tab = makeTab();

    expect(isChatTabTurnActive(tab)).toBe(false);
    expect(getChatTabCloseBlocker(tab, 'proj', 'wt')).toBe('delegates');
    // Scoped to the chat's own worktree.
    expect(getChatTabCloseBlocker(tab, 'proj', 'other')).toBeNull();

    setLiveDelegates('chat-1', 0, 0);
    expect(isChatTabBusy(tab, 'proj', 'wt')).toBe(false);
  });

  it('reports its own turn before delegates', () => {
    setLiveDelegates('chat-1', 1);
    expect(
      getChatTabCloseBlocker(makeTab({ status: 'streaming' }), 'proj', 'wt'),
    ).toBe('active');
  });

  it('shows the refusal notice once while it is on screen', () => {
    // The toast's auto-dismiss timer must not outlive the test.
    jest.useFakeTimers();
    notifyDelegatesBlockClose();
    notifyDelegatesBlockClose();

    const toasts = useGitHubStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      message: DELEGATES_BLOCK_CLOSE_NOTICE,
      type: 'info',
      meta: { forceInApp: true, suppressOsNotification: true },
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
