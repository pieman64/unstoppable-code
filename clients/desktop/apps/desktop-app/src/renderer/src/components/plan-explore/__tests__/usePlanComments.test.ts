/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PlanCommentThread,
  SaveTrackedPlanCommentsRequest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  planViewKey,
  resetPlanViewStoreForTests,
  usePlanViewStore,
} from '@/stores/planViewStore';
import {
  composePlanCommentSubmitHiddenContext,
  composePlanCommentSubmitMessage,
  PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT,
  usePlanComments,
  type PlanCommentSubmitHiddenContext,
  type PlanCommentSubmitOutcome,
  type UsePlanComments,
} from '../usePlanComments';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function thread(
  overrides: Partial<PlanCommentThread> & {
    id: string;
    anchor: PlanCommentThread['anchor'];
  },
): PlanCommentThread {
  return {
    status: 'open',
    createdAt: '2026-06-06T00:00:00.000Z',
    anchorState: 'matched',
    comments: [
      {
        id: `${overrides.id}-c1`,
        author: 'user',
        body: 'Please tighten this',
        createdAt: '2026-06-06T00:00:00.000Z',
        staged: true,
      },
    ],
    ...overrides,
  };
}

describe('composePlanCommentSubmitMessage', () => {
  it('returns an empty string when there is nothing staged', () => {
    const resolved = thread({
      id: 't-resolved',
      status: 'resolved',
      anchor: { quote: 'Phase one', source: 'document' },
    });
    expect(composePlanCommentSubmitMessage([resolved])).toBe('');
  });

  it('includes a teammate (remote) comment, attributed by name (CAN-393)', () => {
    const remoteThread: PlanCommentThread = {
      id: 't-remote',
      status: 'open',
      createdAt: '2026-06-06T00:00:00.000Z',
      anchorState: 'matched',
      anchor: { quote: '', unanchored: true },
      comments: [
        {
          id: 't-remote-c1',
          author: 'remote',
          remoteAuthor: { userId: 'u-2', displayName: 'Bob' },
          body: 'Can we split this phase?',
          createdAt: '2026-06-06T00:01:00.000Z',
        },
      ],
    };
    const message = composePlanCommentSubmitMessage([remoteThread]);
    expect(message).toContain('Comment thread t-remote');
    expect(message).toContain('Comment (from Bob): Can we split this phase?');
  });

  it('omits a teammate comment already submitted to chat (CAN-393)', () => {
    const remoteThread: PlanCommentThread = {
      id: 't-remote-done',
      status: 'open',
      createdAt: '2026-06-06T00:00:00.000Z',
      anchorState: 'matched',
      anchor: { quote: '', unanchored: true },
      comments: [
        {
          id: 't-remote-done-c1',
          author: 'remote',
          remoteAuthor: { userId: 'u-2', displayName: 'Bob' },
          body: 'Already handled',
          createdAt: '2026-06-06T00:01:00.000Z',
          submittedToChat: true,
        },
      ],
    };
    expect(composePlanCommentSubmitMessage([remoteThread])).toBe('');
  });

  it('renders an Exact plan markdown block for a document thread', () => {
    const message = composePlanCommentSubmitMessage([
      thread({
        id: 't-doc',
        anchor: {
          quote: '- [ ] Build the parser',
          renderedText: 'Build the parser',
          lineStart: 12,
          lineEnd: 12,
          headingPath: ['Phase 1'],
          source: 'document',
        },
      }),
    ]);

    expect(message).toContain('Comment thread t-doc in section "Phase 1"');
    expect(message).not.toContain('<system_instruction>');
    expect(message).toContain('Highlighted text: "Build the parser"');
    expect(message).toContain('Exact plan markdown excerpt:');
    expect(message).toContain('```markdown');
    expect(message).toContain('- [ ] Build the parser');
  });

  it('renders a diagram thread naming the diagram + node, with heading and quote', () => {
    const message = composePlanCommentSubmitMessage([
      thread({
        id: 't-seq',
        anchor: {
          source: 'diagram',
          diagramKind: 'sequence',
          planNodeId: 'node-3',
          renderedText: 'Parse the AST',
          quote: '## Parse the AST\nWalk the tree',
          headingPath: ['Phase 2', 'Parsing'],
        },
      }),
    ]);

    expect(message).toContain(
      'Comment on the sequence diagram node "Parse the AST" (thread t-seq) in section "Phase 2 › Parsing"',
    );
    expect(message).toContain('Plan anchor: Phase 2 › Parsing');
    expect(message).toContain('Exact plan markdown:');
    expect(message).toContain('## Parse the AST');
    expect(message).toContain('Comment: Please tighten this');
  });

  it('omits the markdown block for a diagram node with no quote (logic diagram)', () => {
    const message = composePlanCommentSubmitMessage([
      thread({
        id: 't-logic',
        anchor: {
          source: 'diagram',
          diagramKind: 'logicDiff',
          planNodeId: 'logic-7',
          renderedText: 'Auth middleware',
          quote: '',
          unanchored: true,
        },
      }),
    ]);

    expect(message).toContain(
      'Comment on the logic diagram node "Auth middleware" (thread t-logic)',
    );
    expect(message).not.toContain('Exact plan markdown');
    expect(message).not.toContain('```markdown');
    expect(message).not.toContain('Plan anchor:');
    expect(message).toContain('Comment: Please tighten this');
  });

  it('names a data model diagram node and omits the markdown block when unanchored', () => {
    const message = composePlanCommentSubmitMessage([
      thread({
        id: 't-data-model',
        anchor: {
          source: 'diagram',
          diagramKind: 'dataModelDiff',
          planNodeId: 'entity-user',
          renderedText: 'User',
          quote: '',
          unanchored: true,
        },
      }),
    ]);

    expect(message).toContain(
      'Comment on the data model diagram node "User" (thread t-data-model)',
    );
    expect(message).not.toContain('Exact plan markdown');
    expect(message).not.toContain('```markdown');
    expect(message).toContain('Comment: Please tighten this');
  });

  it('numbers multiple staged threads and reports the count', () => {
    const message = composePlanCommentSubmitMessage([
      thread({
        id: 't-doc',
        anchor: { quote: 'A passage', source: 'document' },
      }),
      thread({
        id: 't-seq',
        anchor: {
          source: 'diagram',
          diagramKind: 'sequence',
          planNodeId: 'n1',
          renderedText: 'A node',
          quote: '',
          unanchored: true,
        },
      }),
    ]);

    expect(message).toContain('I have 2 comment threads on the plan.');
    expect(message).toContain('1. Comment thread t-doc');
    expect(message).toContain(
      '2. Comment on the sequence diagram node "A node"',
    );
  });

  it('tells the owning worktree chat to use the file-comment tools', () => {
    const hiddenContext = composePlanCommentSubmitHiddenContext();

    expect(hiddenContext).toEqual({
      kind: 'file-comment-instructions',
      text: PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT,
    });
    expect(hiddenContext.text).toMatch(
      /^<system_instruction>.*<\/system_instruction>$/,
    );
    expect(hiddenContext.text).toContain(
      'on a tracked plan, not a source file',
    );
    expect(hiddenContext.text).toContain('GetFileComments');
    expect(hiddenContext.text).toContain('RespondToFileComment');
    expect(hiddenContext.text).toContain(
      'discussing the plan does not by itself ask you to implement it',
    );
    expect(hiddenContext.text).not.toMatch(
      /\bRespondToComment\b|GetPlanComments/,
    );
  });

  it('names the plan by title and id for the owning worktree chat', () => {
    const threads = [
      thread({
        id: 't-doc',
        anchor: { quote: 'A passage', source: 'document' },
      }),
    ];

    const message = composePlanCommentSubmitMessage(threads, {
      planId: 'plan-7',
      title: 'Importer plan',
    });

    expect(message.split('\n')[0]).toBe(
      'I have 1 comment thread on the plan "Importer plan" (plan plan-7).',
    );
    expect(message).toContain('1. Comment thread t-doc');
    expect(
      composePlanCommentSubmitMessage(threads, {
        planId: 'plan-7',
        title: ' ',
      }).split('\n')[0],
    ).toBe('I have 1 comment thread on the plan "Plan" (plan plan-7).');
  });
});

describe('usePlanComments shared plan controller', () => {
  const KEY = planViewKey('proj-1', 'wt-1', 'plan-1');
  let saveCommentsMock: jest.Mock<
    Promise<null>,
    [SaveTrackedPlanCommentsRequest]
  >;
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const views: Record<string, UsePlanComments> = {};

  function makePlan(commentThreads?: PlanCommentThread[]): TrackedPlanData {
    return {
      id: 'plan-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      source: 'claude',
      title: 'Plan',
      content: '# Plan\n\nBody',
      reviewStatus: 'pending',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [],
      linkedExecutionIds: [],
      ...(commentThreads ? { commentThreads } : {}),
    };
  }

  function View({
    name,
    plan,
  }: {
    name: string;
    plan: TrackedPlanData;
  }): JSX.Element | null {
    views[name] = usePlanComments(plan);
    return null;
  }

  /** Render one or two views of the same plan (a takeover and a panel). */
  function renderViews(plans: {
    first?: TrackedPlanData;
    second?: TrackedPlanData;
  }): void {
    act(() => {
      root?.render(
        createElement(
          'div',
          null,
          plans.first
            ? createElement(View, { name: 'first', plan: plans.first })
            : null,
          plans.second
            ? createElement(View, { name: 'second', plan: plans.second })
            : null,
        ),
      );
    });
  }

  function view(name: string): UsePlanComments {
    const current = views[name];
    if (!current) {
      throw new Error(`Expected view ${name} to be rendered`);
    }
    return current;
  }

  function lastSavedThreads(): PlanCommentThread[] {
    const request = saveCommentsMock.mock.lastCall?.[0];
    if (!request) {
      throw new Error('Expected a saveComments request');
    }
    return request.commentThreads;
  }

  function remoteThread(): PlanCommentThread {
    return {
      id: 'thread-remote',
      status: 'open',
      createdAt: '2026-06-06T00:00:00.000Z',
      anchorState: 'matched',
      anchor: { quote: '', unanchored: true },
      comments: [
        {
          id: 'remote-1',
          author: 'remote',
          remoteAuthor: { userId: 'u-2', displayName: 'Ada' },
          body: 'Can we split this?',
          createdAt: '2026-06-06T00:01:00.000Z',
        },
      ],
    };
  }

  beforeEach(() => {
    resetPlanViewStoreForTests();
    for (const name of Object.keys(views)) {
      delete views[name];
    }
    saveCommentsMock = jest
      .fn<Promise<null>, [SaveTrackedPlanCommentsRequest]>()
      .mockResolvedValue(null);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { activity: { plans: { saveComments: saveCommentsMock } } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
  });

  it('shares threads between two views of one plan', () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan, second: plan });

    act(() => {
      view('first').addDocumentComment({ quote: 'Body' }, 'From the takeover');
    });

    for (const name of ['first', 'second']) {
      expect(view(name).threads.map((thread) => thread.id)).toHaveLength(2);
      expect(view(name).stagedCount).toBe(2);
    }
    expect(view('second').threads[1]?.comments[0]?.body).toBe(
      'From the takeover',
    );
  });

  it('keeps sequential edits from two views', () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan, second: plan });

    act(() => {
      view('first').addNodeComment({
        diagramKind: 'sequence',
        nodeId: 'node-1',
        title: 'Parse',
        body: 'Diagram note',
      });
    });
    act(() => {
      view('second').addReply('thread-remote', 'Panel reply');
    });

    const saved = lastSavedThreads();
    expect(saved.map((thread) => thread.id)).toHaveLength(2);
    expect(saved[0]?.comments.map((comment) => comment.body)).toEqual([
      'Can we split this?',
      'Panel reply',
    ]);
    expect(saved[1]?.anchor.source).toBe('diagram');
    expect(view('first').threads).toBe(view('second').threads);
  });

  it('delivers inbound persisted threads to both views', () => {
    const plan = makePlan([]);
    renderViews({ first: plan, second: plan });

    const updated = makePlan([remoteThread()]);
    renderViews({ first: updated, second: updated });

    for (const name of ['first', 'second']) {
      expect(view(name).threads.map((thread) => thread.id)).toEqual([
        'thread-remote',
      ]);
      expect(view(name).stagedCount).toBe(1);
    }
  });

  function submitSend(): jest.Mock<
    Promise<boolean>,
    [string, PlanCommentSubmitHiddenContext]
  > {
    return jest
      .fn<Promise<boolean>, [string, PlanCommentSubmitHiddenContext]>()
      .mockResolvedValue(true);
  }

  /** A send that stays in flight until the test settles it. */
  function heldSend(): {
    readonly send: jest.Mock<
      Promise<boolean>,
      [string, PlanCommentSubmitHiddenContext]
    >;
    readonly resolve: (sent: boolean) => void;
    readonly reject: (error: Error) => void;
  } {
    const settle: {
      resolve: (sent: boolean) => void;
      reject: (error: Error) => void;
    } = { resolve: () => undefined, reject: () => undefined };
    const send = jest.fn(
      (): Promise<boolean> =>
        new Promise<boolean>((resolve, reject) => {
          settle.resolve = resolve;
          settle.reject = reject;
        }),
    );
    return {
      send,
      resolve: (sent): void => settle.resolve(sent),
      reject: (error): void => settle.reject(error),
    };
  }

  it('acknowledges only the snapshot submitted', async () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan, second: plan });
    act(() => {
      view('first').addDocumentComment({ quote: 'Body' }, 'Draft to edit');
    });
    const draftThreadId = view('first').threads[1]?.id ?? '';
    const draftCommentId =
      view('first').threads[1]?.comments[0]?.id ?? 'missing';

    const held = heldSend();
    let submitting: Promise<PlanCommentSubmitOutcome> =
      Promise.resolve('empty');
    act(() => {
      submitting = view('first').submit(held.send);
    });
    expect(held.send).toHaveBeenCalledTimes(1);

    // While the send is in flight: another view adds a comment and the
    // draft that was submitted is edited. Neither may be acknowledged.
    act(() => {
      view('second').addDocumentComment({ quote: 'Body' }, 'Added mid-submit');
      view('second').editStagedComment(
        draftThreadId,
        draftCommentId,
        'Edited mid-submit',
      );
    });

    const outcome = await act(async () => {
      held.resolve(true);
      return submitting;
    });

    expect(outcome).toBe('sent');
    const threads = view('second').threads;
    const remote = threads[0]?.comments[0];
    expect(remote?.submittedToChat).toBe(true);
    expect(threads[1]?.comments[0]).toMatchObject({
      body: 'Edited mid-submit',
      staged: true,
    });
    expect(threads[2]?.comments[0]).toMatchObject({
      body: 'Added mid-submit',
      staged: true,
    });
    expect(view('first').stagedCount).toBe(2);
    expect(lastSavedThreads()).toHaveLength(3);
    expect(usePlanViewStore.getState().entries[KEY]?.submitting).toBe(false);
  });

  it('hands the owning worktree chat a message that names the plan', async () => {
    renderViews({ first: makePlan([remoteThread()]) });
    const send = submitSend();

    const outcome = await act(async () => view('first').submit(send));

    expect(outcome).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const [message, hiddenContext] = send.mock.calls[0] ?? [];
    expect(message?.split('\n')[0]).toBe(
      'I have 1 comment thread on the plan "Plan" (plan plan-1).',
    );
    expect(message).toContain('Comment (from Ada): Can we split this?');
    expect(hiddenContext).toEqual({
      kind: 'file-comment-instructions',
      text: PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT,
    });
    expect(view('first').stagedCount).toBe(0);
    expect(lastSavedThreads()[0]?.comments[0]?.submittedToChat).toBe(true);
  });

  it('refuses a second submit of the plan while one is in flight', async () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan, second: plan });
    const held = heldSend();
    let first: Promise<PlanCommentSubmitOutcome> = Promise.resolve('empty');
    act(() => {
      first = view('first').submit(held.send);
    });

    const second = submitSend();
    const busy = await act(async () => view('second').submit(second));

    expect(busy).toBe('busy');
    expect(second).not.toHaveBeenCalled();
    expect(usePlanViewStore.getState().entries[KEY]?.submitting).toBe(true);

    const outcome = await act(async () => {
      held.resolve(true);
      return first;
    });
    expect(outcome).toBe('sent');
    expect(held.send).toHaveBeenCalledTimes(1);
    expect(usePlanViewStore.getState().entries[KEY]?.submitting).toBe(false);
  });

  it('acknowledges nothing when the send throws, and a retry still submits', async () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan });
    act(() => {
      view('first').addDocumentComment({ quote: 'Body' }, 'Local draft');
    });
    const saveCount = saveCommentsMock.mock.calls.length;
    const held = heldSend();
    let submitting: Promise<PlanCommentSubmitOutcome> =
      Promise.resolve('empty');
    act(() => {
      submitting = view('first').submit(held.send);
    });

    const outcome = await act(async () => {
      held.reject(new Error('dispatch refused'));
      return submitting;
    });

    expect(outcome).toBe('rejected');
    expect(view('first').stagedCount).toBe(2);
    expect(view('first').threads[0]?.comments[0]?.submittedToChat).toBe(
      undefined,
    );
    expect(view('first').threads[1]?.comments[0]?.staged).toBe(true);
    expect(saveCommentsMock.mock.calls).toHaveLength(saveCount);
    expect(usePlanViewStore.getState().entries[KEY]).toMatchObject({
      refs: 1,
      submitting: false,
    });

    const retry = submitSend();
    const retried = await act(async () => view('first').submit(retry));

    expect(retried).toBe('sent');
    const [message] = retry.mock.calls[0] ?? [];
    expect(message).toContain('Can we split this?');
    expect(message).toContain('Local draft');
    expect(view('first').stagedCount).toBe(0);
  });

  it('leaves pending comments untouched when the send is rejected', async () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan });
    const saveCount = saveCommentsMock.mock.calls.length;

    const outcome = await act(async () =>
      view('first').submit(() => Promise.resolve(false)),
    );

    expect(outcome).toBe('rejected');
    expect(view('first').stagedCount).toBe(1);
    expect(saveCommentsMock.mock.calls).toHaveLength(saveCount);
  });

  it('sends nothing when no comment is pending', async () => {
    renderViews({ first: makePlan([]) });
    const send = submitSend();

    const outcome = await act(async () => view('first').submit(send));

    expect(outcome).toBe('empty');
    expect(send).not.toHaveBeenCalled();
    expect(usePlanViewStore.getState().entries[KEY]).toMatchObject({
      refs: 1,
      submitting: false,
    });
  });

  it('releases the shared entry when the last view unmounts', () => {
    const plan = makePlan([remoteThread()]);
    renderViews({ first: plan, second: plan });
    expect(usePlanViewStore.getState().entries[KEY]?.refs).toBe(2);

    renderViews({ first: plan });
    expect(usePlanViewStore.getState().entries[KEY]?.refs).toBe(1);

    renderViews({});
    expect(usePlanViewStore.getState().entries[KEY]).toBeUndefined();
  });
});
