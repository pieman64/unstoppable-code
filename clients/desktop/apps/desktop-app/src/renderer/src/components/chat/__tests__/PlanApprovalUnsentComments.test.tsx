/**
 * @jest-environment jsdom
 *
 * The composer's plan-approval prompt warns about the waiting plan's unsent
 * comments and sends them through the Plan panel tray's own submit path. The
 * stores, eligibility, snapshot acknowledgement, and dispatch are real; only
 * the chat send, the comment save IPC, and the panel reveal are stubbed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChatActivePlanContext,
  ChatSendMessageRequest,
  PlanCommentThread,
  SaveTrackedPlanCommentsRequest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { resetPlanViewStoreForTests } from '@/stores/planViewStore';
import {
  usePlanComments,
  type UsePlanComments,
} from '@/components/plan-explore/usePlanComments';
import { PLAN_COMMENTS_SEND_REJECTED_MESSAGE } from '@/components/plan-explore/usePlanPanelCommentSubmit';
import {
  PlanApprovalPromptWithComments,
  type PlanApprovalCommentsTarget,
} from '../PlanApprovalUnsentComments';

jest.mock('@/lib/panels/plan-panel-open', () => ({
  revealWorktreeChatPanel: jest.fn(() => true),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT = 'proj-1';
const WORKTREE = 'wt-1';
const LIST_KEY = `${PROJECT}/${WORKTREE}`;

type SendOptions = {
  hiddenContext?: ChatSendMessageRequest['hiddenContext'];
  activePlan?: ChatActivePlanContext;
  onDispatchAccepted?: () => void;
};

interface SentMessage {
  readonly text: string;
  readonly target: { projectId: string; worktreeId: string; chatId: string };
  readonly options: SendOptions;
}

function chatTab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
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
  };
}

function comment(
  id: string,
  overrides: Partial<PlanCommentThread['comments'][number]> = {},
): PlanCommentThread['comments'][number] {
  return {
    id,
    author: 'user',
    body: `Note ${id}`,
    createdAt: '2026-06-06T00:00:00.000Z',
    staged: true,
    ...overrides,
  };
}

function thread(
  id: string,
  comments: PlanCommentThread['comments'],
  status: PlanCommentThread['status'] = 'open',
): PlanCommentThread {
  return {
    id,
    status,
    createdAt: '2026-06-06T00:00:00.000Z',
    anchorState: 'matched',
    anchor: { quote: '', unanchored: true },
    comments,
  };
}

function makePlan(
  id: string,
  commentThreads: PlanCommentThread[],
): TrackedPlanData {
  return {
    id,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    source: 'claude',
    title: `Plan ${id}`,
    content: '# Plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    commentThreads,
  };
}

function target(planId: string): PlanApprovalCommentsTarget {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    planId,
    chatId: 'chat-plan',
  };
}

describe('PlanApprovalPromptWithComments', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: SentMessage[];
  let sendMessage: jest.Mock;
  let ensureTrackedPlanLoaded: jest.Mock;
  let refreshComments: jest.Mock;
  let tray: UsePlanComments | null;
  let implement: jest.Mock;
  let addToast: jest.Mock;

  /** The Plan panel tray's controller for the same plan. */
  function Tray({ plan }: { plan: TrackedPlanData }): null {
    tray = usePlanComments(plan);
    return null;
  }

  function render(
    promptTarget: PlanApprovalCommentsTarget | null,
    trayPlan?: TrackedPlanData,
  ): void {
    act(() => {
      root.render(
        <>
          <PlanApprovalPromptWithComments
            target={promptTarget}
            options={[
              {
                label: 'Yes, implement this plan',
                onSelect: implement,
                testId: 'chat-plan-implement',
              },
            ]}
            onClose={jest.fn()}
          >
            <textarea data-testid="note" />
          </PlanApprovalPromptWithComments>
          {trayPlan ? <Tray plan={trayPlan} /> : null}
        </>,
      );
    });
  }

  function setPlans(plans: TrackedPlanData[]): void {
    act(() => {
      useActivityStore.setState({
        trackedPlans: { [LIST_KEY]: plans },
      });
    });
  }

  function notice(): string | null {
    return (
      container.querySelector('[data-testid="chat-plan-send-comments"]')
        ?.textContent ?? null
    );
  }

  function sendButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-plan-send-comments"]',
    );
    if (!button) throw new Error('Missing unsent comments row');
    return button;
  }

  /** Lets queued microtasks and the save IPC settle. */
  async function flush(): Promise<void> {
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });
  }

  /** Holds each send until the test accepts it. */
  function holdSends(): Array<() => void> {
    const pending: Array<() => void> = [];
    sendMessage.mockImplementation(
      (
        text: string,
        _files: unknown,
        sendTarget: SentMessage['target'],
        _mode: unknown,
        options: SendOptions,
      ) => {
        sent.push({ text, target: sendTarget, options });
        pending.push(() => options.onDispatchAccepted?.());
        return Promise.resolve();
      },
    );
    return pending;
  }

  beforeEach(() => {
    resetPlanViewStoreForTests();
    sent = [];
    tray = null;
    implement = jest.fn();
    sendMessage = jest.fn(
      (
        text: string,
        _files: unknown,
        sendTarget: SentMessage['target'],
        _mode: unknown,
        options: SendOptions,
      ) => {
        sent.push({ text, target: sendTarget, options });
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );
    ensureTrackedPlanLoaded = jest.fn(() => new Promise<boolean>(() => {}));
    refreshComments = jest.fn().mockResolvedValue(null);
    useChatStore.setState({
      worktreeChats: {
        [LIST_KEY]: {
          // Another editable chat is active; the comments still go to the
          // chat waiting on the plan.
          tabs: [chatTab('chat-other'), chatTab('chat-plan')],
          activeTabId: 'chat-other',
        },
      },
      switchTab: jest.fn(),
      sendMessage,
    });
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
      ensureTrackedPlanLoaded,
    });
    addToast = jest.fn();
    useGitHubStore.setState({ addToast });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        activity: {
          plans: {
            refreshComments,
            saveComments: jest
              .fn<Promise<null>, [SaveTrackedPlanCommentsRequest]>()
              .mockResolvedValue(null),
          },
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('counts the comments the tray would submit', () => {
    const plan = makePlan('plan-1', [
      // Two drafts in one thread count as two comments.
      thread('t-own', [comment('own-1'), comment('own-2')]),
      thread('t-remote', [
        comment('remote-1', {
          author: 'remote',
          staged: false,
          remoteAuthor: { userId: 'u-2', displayName: 'Ada' },
        }),
      ]),
      thread('t-resolved', [comment('resolved-1')], 'resolved'),
      thread('t-sent', [
        comment('sent-1', { staged: false, submittedToChat: true }),
      ]),
    ]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    expect(tray?.stagedCount).toBe(3);
    expect(notice()).toContain('Address 3 comments first');
    // A warning, not a gate.
    const implementRow = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-plan-implement"]',
    );
    expect(implementRow?.disabled).toBe(false);
    // Implementing anyway leaves every comment unsent.
    act(() => implementRow?.click());
    expect(implement).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(tray?.stagedCount).toBe(3);
    expect(notice()).toContain('Address 3 comments first');
  });

  it('pulls newer teammate comments for the composer without opening the Plan panel', async () => {
    const plan: TrackedPlanData = {
      ...makePlan('plan-1', []),
      share: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
        shareScope: 'team',
        teamId: 'team-1',
        syncStatus: 'synced',
      },
    };
    refreshComments.mockImplementation(() => {
      useActivityStore.getState().upsertTrackedPlan({
        ...plan,
        commentThreads: [
          thread('t-remote', [
            comment('remote-new', {
              author: 'remote',
              staged: false,
              body: 'Please include a timeout',
              remoteAuthor: { userId: 'u-2', displayName: 'Ada' },
            }),
          ]),
        ],
      });
      return Promise.resolve(null);
    });
    setPlans([plan]);
    render(target(plan.id));
    await flush();

    expect(notice()).toContain('Address 1 comment first');
    act(() => sendButton().click());
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Please include a timeout');
    expect(notice()).toBeNull();
  });

  it('follows tray edits, and shows nothing without unsent comments', () => {
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    expect(notice()).toContain('Address 1 comment first');
    act(() => tray?.deleteStagedComment('t-own', 'own-1'));
    expect(notice()).toBeNull();
    act(() =>
      tray?.addDocumentComment({ quote: 'Body', source: 'document' }, 'Again'),
    );
    expect(notice()).toContain('Address 1 comment first');
  });

  it('waits for a late plan without remounting the text row', () => {
    render(target('plan-1'));
    const note = container.querySelector('[data-testid="note"]');
    expect(note).not.toBeNull();
    expect(notice()).toBeNull();
    expect(ensureTrackedPlanLoaded).toHaveBeenCalledWith(
      PROJECT,
      WORKTREE,
      'plan-1',
    );
    setPlans([makePlan('plan-1', [thread('t-own', [comment('own-1')])])]);
    expect(notice()).toContain('Address 1 comment first');
    expect(container.querySelector('[data-testid="note"]')).toBe(note);
  });

  it('shows no notice without a target', () => {
    setPlans([makePlan('plan-1', [thread('t-own', [comment('own-1')])])]);
    render(null);
    expect(notice()).toBeNull();
    expect(container.querySelector('[data-testid="note"]')).not.toBeNull();
  });

  it("sends the tray's handoff to the waiting chat and clears what was sent", async () => {
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    act(() => sendButton().click());
    await flush();

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message?.target).toEqual({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-plan',
    });
    expect(message?.text).toContain('Note own-1');
    expect(message?.options.activePlan).toEqual({ planId: 'plan-1' });
    expect(message?.options.hiddenContext).toEqual(
      expect.objectContaining({ kind: 'file-comment-instructions' }),
    );
    expect(notice()).toBeNull();
    expect(tray?.stagedCount).toBe(0);
    expect(implement).not.toHaveBeenCalled();
  });

  it('keeps comments unsent and reports a refused send', async () => {
    sendMessage.mockImplementation(() =>
      Promise.reject(new Error('dispatch failed')),
    );
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    act(() => sendButton().click());
    await flush();

    expect(notice()).toContain('Address 1 comment first');
    expect(sendButton().disabled).toBe(false);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      PLAN_COMMENTS_SEND_REJECTED_MESSAGE,
      'error',
      undefined,
      expect.objectContaining({ projectId: PROJECT, worktreeId: WORKTREE }),
    );
  });

  it('refuses rather than redirecting when the waiting chat is gone', async () => {
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render({ ...target('plan-1'), chatId: 'chat-closed' }, plan);
    act(() => sendButton().click());
    await flush();

    expect(sent).toHaveLength(0);
    expect(notice()).toContain('Address 1 comment first');
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('keeps a synchronously thrown send retryable without losing the draft', async () => {
    sendMessage.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    act(() => sendButton().click());
    await flush();
    expect(notice()).toContain('Address 1 comment first');
    expect(sendButton().disabled).toBe(false);
    expect(addToast).toHaveBeenCalledTimes(1);
    act(() => sendButton().click());
    await flush();
    expect(sent).toHaveLength(1);
    expect(notice()).toBeNull();
    expect(tray?.stagedCount).toBe(0);
  });

  it('isolates the same plan id across worktrees and receives remote updates', () => {
    const first = makePlan('plan-1', [thread('first', [comment('one')])]);
    const second = {
      ...makePlan('plan-1', [
        thread('second', [comment('two'), comment('three')]),
      ]),
      worktreeId: 'wt-2',
    };
    useActivityStore.setState({
      trackedPlans: { [LIST_KEY]: [first], [`${PROJECT}/wt-2`]: [second] },
    });
    render(target('plan-1'));
    expect(notice()).toContain('Address 1 comment first');
    render({ ...target('plan-1'), worktreeId: 'wt-2' });
    expect(notice()).toContain('Address 2 comments first');
    act(() =>
      useActivityStore.setState({
        trackedPlans: {
          [LIST_KEY]: [first],
          [`${PROJECT}/wt-2`]: [{ ...second, commentThreads: [] }],
        },
      }),
    );
    expect(notice()).toBeNull();
    render(target('plan-1'));
    expect(notice()).toContain('Address 1 comment first');
  });

  it('shares one in-flight send with the tray and keeps later comments unsent', async () => {
    const accept = holdSends();
    const plan = makePlan('plan-1', [thread('t-own', [comment('own-1')])]);
    setPlans([plan]);
    render(target('plan-1'), plan);
    act(() => sendButton().click());
    await flush();

    expect(sendButton().textContent).toBe('Sending…');
    expect(sendButton().disabled).toBe(true);
    // The tray cannot start a second handoff of the same plan.
    await expect(tray?.submit(() => Promise.resolve(true))).resolves.toBe(
      'busy',
    );

    act(() =>
      tray?.addDocumentComment({ quote: 'Body', source: 'document' }, 'Later'),
    );
    act(() => accept[0]?.());
    await flush();

    expect(sent).toHaveLength(1);
    expect(notice()).toContain('Address 1 comment first');
    expect(sendButton().textContent).toBe('Address 1 comment first');
    expect(tray?.threads.flatMap((entry) => entry.comments)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'own-1', staged: false }),
        expect.objectContaining({ body: 'Later', staged: true }),
      ]),
    );
  });

  it("does not let a send that settles after a plan switch touch the new plan's comments", async () => {
    const accept = holdSends();
    const first = makePlan('plan-1', [thread('t-1', [comment('one-1')])]);
    const second = makePlan('plan-2', [
      thread('t-2', [comment('two-1'), comment('two-2')]),
    ]);
    setPlans([first, second]);
    render(target('plan-1'));
    act(() => sendButton().click());
    await flush();

    render(target('plan-2'), second);
    expect(notice()).toContain('Address 2 comments first');
    expect(sendButton().disabled).toBe(false);

    act(() => accept[0]?.());
    await flush();

    expect(notice()).toContain('Address 2 comments first');
    expect(tray?.stagedCount).toBe(2);
  });
});
