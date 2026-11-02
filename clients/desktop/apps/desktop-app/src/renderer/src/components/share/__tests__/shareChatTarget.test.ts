/**
 * @jest-environment jsdom
 *
 * CAN-5219: Use in this chat writes only into the chat a share landing
 * opened over, only while that chat's composer is the one on screen, and
 * never twice for one offer.
 */
import {
  INSERT_CHAT_TEXT_EVENT,
  isInsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { toastLifetimeMs, useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  captureShareChatTarget,
  insertSkillInvocation,
  offerUseInChat,
  type ShareChatInsertOutcome,
  type ShareChatTarget,
} from '../shareChatTarget';

const KEY = 'project/worktree';
const TARGET: ShareChatTarget = {
  projectId: 'project',
  worktreeId: 'worktree',
  tabId: 'chat-a',
};

function makeTab(over: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...over,
  };
}

function seedChat(
  activeTabId: string,
  tabs: ChatTab[] = [makeTab({ id: 'chat-a' }), makeTab({ id: 'chat-b' })],
  lastActiveEditableChatId?: string,
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      [KEY]: {
        activeTabId,
        tabs,
        ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
      },
    },
  });
}

/** A composer for `tabId`: appends what it is asked to and acknowledges. */
function mountComposer(tabId: string, received: string[]): () => void {
  const handler = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('targetTabId' in detail) ||
      detail.targetTabId !== tabId ||
      !('text' in detail) ||
      typeof detail.text !== 'string'
    ) {
      return;
    }
    received.push(detail.text);
    if (isInsertChatTextDetail(detail)) detail.markHandled?.();
  };
  document.addEventListener(INSERT_CHAT_TEXT_EVENT, handler);
  return (): void => {
    document.removeEventListener(INSERT_CHAT_TEXT_EVENT, handler);
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const id of ['chat-a', 'chat-b']) {
    const composer = document.createElement('div');
    composer.dataset.chatComposerTabId = id;
    composer.innerHTML =
      '<div data-chat-textarea contenteditable="true"></div>';
    composer.getClientRects = (): DOMRectList =>
      Object.assign([new DOMRect()], { item: (): DOMRect => new DOMRect() });
    document.body.appendChild(composer);
  }

  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    canopyPortalOpen: false,
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
  });
  useGitHubStore.setState({ toasts: [], notifications: [] });
  seedChat('chat-a');
});

describe('captureShareChatTarget', () => {
  it('rejects a selected chat whose composer is not mounted', () => {
    document
      .querySelectorAll('[data-chat-composer-tab-id]')
      .forEach((node) => node.remove());
    expect(captureShareChatTarget()).toBeNull();
  });

  it('rejects a mounted but hidden composer', () => {
    document
      .querySelectorAll<HTMLElement>('[data-chat-composer-tab-id]')
      .forEach((node) => {
        node.getClientRects = (): DOMRectList =>
          Object.assign([], { item: (): null => null });
      });
    expect(captureShareChatTarget()).toBeNull();
  });

  it('captures the active editable chat on the worktree chat page', () => {
    expect(captureShareChatTarget()).toEqual(TARGET);
  });

  it.each([
    ['Home', (): void => useNavigationStore.setState({ activePage: 'home' })],
    [
      'Customize',
      (): void => useNavigationStore.setState({ activePage: 'plugins' }),
    ],
    [
      'Settings',
      (): void => useNavigationStore.setState({ settingsOpen: true }),
    ],
    [
      'no worktree',
      (): void => useChatStore.setState({ selectedWorktree: null }),
    ],
    ['no chat state', (): void => useChatStore.setState({ worktreeChats: {} })],
    ['a missing tab', (): void => seedChat('chat-gone')],
    [
      'a read-only tab',
      (): void =>
        seedChat('chat-a', [makeTab({ id: 'chat-a', readOnly: true })]),
    ],
  ])('captures nothing over %s', (_where, arrange) => {
    arrange();
    expect(captureShareChatTarget()).toBeNull();
  });

  it('never substitutes the remembered chat behind a file tab', () => {
    seedChat(
      'file-1',
      [makeTab({ id: 'chat-a' }), makeTab({ id: 'file-1', kind: 'file' })],
      'chat-a',
    );
    expect(captureShareChatTarget()).toBeNull();
  });
});

describe('insertSkillInvocation', () => {
  it('appends the invocation, with a trailing space, to the targeted composer only', () => {
    const intoA: string[] = [];
    const intoB: string[] = [];
    const unmountA = mountComposer('chat-a', intoA);
    const unmountB = mountComposer('chat-b', intoB);

    expect(insertSkillInvocation(TARGET, 'incident-triage-2')).toBe('inserted');

    expect(intoA).toEqual(['/incident-triage-2 ']);
    expect(intoB).toEqual([]);
    unmountA();
    unmountB();
  });

  it('reports a request no composer accepted', () => {
    expect(insertSkillInvocation(TARGET, 'incident-triage')).toBe('unhandled');
  });

  it('does not write into a chat the user moved to', () => {
    const intoB: string[] = [];
    const unmount = mountComposer('chat-b', intoB);
    seedChat('chat-b');

    expect(insertSkillInvocation(TARGET, 'incident-triage')).toBe('stale');
    expect(intoB).toEqual([]);
    unmount();
  });

  it('writes nothing for a name that cannot be invoked', () => {
    const intoA: string[] = [];
    const unmount = mountComposer('chat-a', intoA);
    expect(insertSkillInvocation(TARGET, '')).toBe('invalid');
    expect(intoA).toEqual([]);
    unmount();
  });
});

describe('offerUseInChat', () => {
  function offeredAction(): { label: string; onClick: () => unknown } {
    const action = useGitHubStore.getState().toasts.at(-1)?.meta?.action;
    if (!action) throw new Error('no action offered');
    return action;
  }

  it('offers the action on a lasting success notice and stages once', () => {
    const stage = jest.fn((): ShareChatInsertOutcome => 'inserted');
    offerUseInChat({ message: 'Skill installed.', target: TARGET, stage });

    const toast = useGitHubStore.getState().toasts.at(-1);
    expect(toast?.message).toBe('Skill installed.');
    expect(toast?.type).toBe('success');
    expect(toast?.meta?.keepUntilDismissed).toBe(true);
    const action = offeredAction();
    expect(action.label).toBe('Use in this chat');

    action.onClick();
    action.onClick();
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('keeps the actionable notice available until explicitly dismissed', () => {
    offerUseInChat({
      message: 'Skill installed.',
      target: TARGET,
      stage: () => 'inserted',
    });
    const toast = useGitHubStore.getState().toasts.at(-1);
    if (!toast) throw new Error('no toast');
    expect(toastLifetimeMs(toast)).toBe(0);
  });

  it('withdraws the old offer when a new review opens', () => {
    const stage = jest.fn((): ShareChatInsertOutcome => 'inserted');
    offerUseInChat({ message: 'Skill installed.', target: TARGET, stage });
    const action = offeredAction();
    useNavigationStore
      .getState()
      .openShareInstall(
        { entity: 'skill', externalId: 'new', intent: 'install' },
        'deep-link',
      );
    action.onClick();
    expect(stage).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('withdraws the offer when the user leaves the chat', () => {
    const stage = jest.fn((): ShareChatInsertOutcome => 'inserted');
    offerUseInChat({ message: 'Skill installed.', target: TARGET, stage });
    const action = offeredAction();

    seedChat('chat-b');

    expect(useGitHubStore.getState().toasts).toEqual([]);
    action.onClick();
    expect(stage).not.toHaveBeenCalled();
  });

  it('says so when the chat could not take the skill', async () => {
    const stage = jest.fn((): ShareChatInsertOutcome => 'unhandled');
    offerUseInChat({ message: 'Skill installed.', target: TARGET, stage });

    await offeredAction().onClick();

    const notice = useGitHubStore.getState().toasts.at(-1);
    expect(notice?.type).toBe('warning');
    expect(notice?.message).toBe(
      'Couldn’t add the skill to the chat. Type / in a chat to use it.',
    );
  });
});
