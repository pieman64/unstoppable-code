import {
  buildContinueSectionModel,
  continueAttentionStatus,
  continueAttentionSubject,
  countContinueAttentionByKind,
  isLastViewedMergedIntoInterrupted,
  isLastViewedSuppressed,
  rankContinueAttention,
  resolveLastViewedNames,
  sameContinueAttentionItems,
  type ContinueAttentionItem,
  type ContinueAttentionKind,
} from '../continue-attention';

function chatItem(
  kind: ContinueAttentionKind,
  chatId: string,
  overrides: Partial<ContinueAttentionItem> & {
    worktreeId?: string;
    workspaceId?: string;
  } = {},
): ContinueAttentionItem {
  const { worktreeId = 'wt-1', workspaceId = 'ws-1', ...rest } = overrides;
  return {
    kind,
    target: { kind: 'chat', workspaceId, worktreeId, chatId },
    workspaceName: 'Workspace',
    worktreeName: `Worktree ${worktreeId}`,
    chatTitle: `Chat ${chatId}`,
    ...rest,
  };
}

function ids(items: readonly ContinueAttentionItem[]): string[] {
  return items.map((item) =>
    item.target.kind === 'chat'
      ? `${item.kind}:${item.target.worktreeId}/${item.target.chatId}`
      : `${item.kind}:${item.target.worktreeId}`,
  );
}

describe('rankContinueAttention', () => {
  it('orders by kind priority, then newest event, then identity', () => {
    const ranked = rankContinueAttention([
      chatItem('unread', 'u-old', { eventAt: 1 }),
      chatItem('plan-review', 'p', { eventAt: 5 }),
      chatItem('unread', 'u-new', { eventAt: 9 }),
      chatItem('tool-approval', 'a', { eventAt: 2 }),
      chatItem('question', 'q-b'),
      chatItem('question', 'q-a'),
    ]);

    expect(ids(ranked)).toEqual([
      'question:wt-1/q-a',
      'question:wt-1/q-b',
      'tool-approval:wt-1/a',
      'plan-review:wt-1/p',
      'unread:wt-1/u-new',
      'unread:wt-1/u-old',
    ]);
  });

  it('sorts missing or invalid timestamps after known ones', () => {
    const ranked = rankContinueAttention([
      chatItem('unread', 'missing'),
      chatItem('unread', 'nan', { eventAt: Number.NaN }),
      chatItem('unread', 'known', { eventAt: 3 }),
    ]);

    expect(ids(ranked)[0]).toBe('unread:wt-1/known');
  });

  it('keeps one row per chat, choosing its highest-priority kind', () => {
    const ranked = rankContinueAttention([
      chatItem('unread', 'c', { eventAt: 10 }),
      chatItem('tool-approval', 'c', { eventAt: 1 }),
      chatItem('question', 'c', { eventAt: 2 }),
    ]);

    expect(ids(ranked)).toEqual(['question:wt-1/c']);
  });

  it('keeps the newest of duplicate records of the same kind', () => {
    const ranked = rankContinueAttention([
      chatItem('question', 'c', { eventAt: 1, chatTitle: 'old' }),
      chatItem('question', 'c', { eventAt: 4, chatTitle: 'new' }),
      chatItem('question', 'c', { chatTitle: 'unknown' }),
    ]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.chatTitle).toBe('new');
  });

  it('does not merge the same chat id in different worktrees', () => {
    const ranked = rankContinueAttention([
      chatItem('question', 'chat-1', { worktreeId: 'wt-a' }),
      chatItem('question', 'chat-1', { worktreeId: 'wt-b' }),
    ]);

    expect(ranked).toHaveLength(2);
  });

  it('falls through to the next kind as higher-priority attention resolves', () => {
    const all = [
      chatItem('question', 'c'),
      chatItem('tool-approval', 'c'),
      chatItem('plan-review', 'c'),
      chatItem('unread', 'c'),
    ];
    const kinds = [0, 1, 2, 3].map(
      (resolved) => rankContinueAttention(all.slice(resolved))[0]?.kind,
    );

    expect(kinds).toEqual([
      'question',
      'tool-approval',
      'plan-review',
      'unread',
    ]);
  });
});

describe('buildContinueSectionModel', () => {
  const unread = ['a', 'b', 'c', 'd', 'e'].map((chatId, index) =>
    chatItem('unread', chatId, { eventAt: 10 - index, completed: true }),
  );

  it('shows every unread row when the host has no overflow destination', () => {
    const model = buildContinueSectionModel({ attention: unread });

    expect(model.unread).toHaveLength(5);
    expect(model.unreadOverflowCount).toBe(0);
  });

  it('caps unread rows only behind an overflow destination', () => {
    const model = buildContinueSectionModel({
      attention: unread,
      hasUnreadOverflowDestination: true,
    });

    expect(ids(model.unread)).toEqual([
      'unread:wt-1/a',
      'unread:wt-1/b',
      'unread:wt-1/c',
    ]);
    expect(model.unreadTotal).toBe(5);
    expect(model.unreadOverflowCount).toBe(2);
  });

  it('shows every needs-input row regardless of count', () => {
    const questions = ['a', 'b', 'c', 'd', 'e'].map((chatId) =>
      chatItem('question', chatId),
    );
    const model = buildContinueSectionModel({
      attention: questions,
      hasUnreadOverflowDestination: true,
    });

    expect(model.needsInput).toHaveLength(5);
  });

  it('is invisible with no attention, no interrupted row, and no Last viewed', () => {
    expect(buildContinueSectionModel({ attention: [] }).visible).toBe(false);
    expect(
      buildContinueSectionModel({ attention: [], interruptedVisible: true })
        .visible,
    ).toBe(true);
  });

  it('suppresses Last viewed while attention targets the same worktree, reversibly', () => {
    const lastViewed = {
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      destinationName: 'Main',
      workspaceName: 'Workspace',
    };
    const suppressed = buildContinueSectionModel({
      attention: [chatItem('question', 'q')],
      lastViewed,
    });
    const restored = buildContinueSectionModel({ attention: [], lastViewed });
    const otherWorktree = buildContinueSectionModel({
      attention: [chatItem('question', 'q', { worktreeId: 'wt-2' })],
      lastViewed,
    });

    expect(suppressed.lastViewedVisible).toBe(false);
    expect(suppressed.visible).toBe(true);
    expect(restored.lastViewedVisible).toBe(true);
    expect(otherWorktree.lastViewedVisible).toBe(true);
  });

  it('never suppresses a non-worktree Last viewed destination', () => {
    expect(
      isLastViewedSuppressed(
        {
          workspaceId: 'ws-1',
          destinationName: 'Cowork chat',
          workspaceName: 'Workspace',
        },
        [chatItem('question', 'q')],
      ),
    ).toBe(false);
  });
});

describe('merging Last viewed into a named interrupted row', () => {
  const lastViewed = {
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    destinationName: 'Main',
    workspaceName: 'Workspace',
  };

  it('merges only a visible row targeting the same workspace and worktree', () => {
    const model = (
      interruptedTarget: { workspaceId: string; worktreeId: string } | null,
      interruptedVisible = true,
    ): boolean =>
      buildContinueSectionModel({
        attention: [],
        lastViewed,
        interruptedVisible,
        interruptedTarget,
      }).lastViewedVisible;

    expect(model({ workspaceId: 'ws-1', worktreeId: 'wt-1' })).toBe(false);
    // The same worktree id in another workspace is a different worktree.
    expect(model({ workspaceId: 'ws-2', worktreeId: 'wt-1' })).toBe(true);
    expect(model({ workspaceId: 'ws-1', worktreeId: 'wt-2' })).toBe(true);
    // Aggregate, pipeline, cowork, and App Advisor rows carry no target.
    expect(model(null)).toBe(true);
    // A dismissed row no longer stands in for Last viewed.
    expect(model({ workspaceId: 'ws-1', worktreeId: 'wt-1' }, false)).toBe(
      true,
    );
  });

  it('never merges a non-worktree Last viewed destination', () => {
    expect(
      isLastViewedMergedIntoInterrupted(
        {
          workspaceId: 'ws-1',
          destinationName: 'Cowork chat',
          workspaceName: 'Workspace',
        },
        { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        true,
      ),
    ).toBe(false);
  });

  it('never merges empty identities', () => {
    for (const target of [
      { workspaceId: '', worktreeId: 'wt-1' },
      { workspaceId: 'ws-1', worktreeId: '' },
    ]) {
      expect(
        isLastViewedMergedIntoInterrupted(
          { ...lastViewed, ...target },
          target,
          true,
        ),
      ).toBe(false);
    }
  });

  it('composes with attention suppression', () => {
    const model = buildContinueSectionModel({
      attention: [chatItem('question', 'q')],
      lastViewed,
      interruptedVisible: true,
      interruptedTarget: { workspaceId: 'ws-1', worktreeId: 'wt-2' },
    });
    expect(model.lastViewedVisible).toBe(false);
    expect(model.needsInput).toHaveLength(1);
    expect(model.visible).toBe(true);
  });
});

describe('Continue copy', () => {
  it('describes each kind without claiming unproven completion', () => {
    expect(continueAttentionStatus(chatItem('question', 'c'))).toBe(
      'is waiting for your answer',
    );
    expect(continueAttentionStatus(chatItem('tool-approval', 'c'))).toBe(
      'is waiting for your approval',
    );
    expect(continueAttentionStatus(chatItem('plan-review', 'c'))).toBe(
      'has a plan for you to review',
    );
    expect(
      continueAttentionStatus(chatItem('unread', 'c', { completed: true })),
    ).toBe('finished');
    expect(continueAttentionStatus(chatItem('unread', 'c'))).toBe(
      'has unread updates',
    );
  });

  it('names the worktree for fallbacks and untitled chats', () => {
    const fallback: ContinueAttentionItem = {
      kind: 'unread',
      target: { kind: 'worktree', workspaceId: 'ws', worktreeId: 'wt' },
      workspaceName: 'Workspace',
      worktreeName: 'feature',
      completed: true,
    };

    expect(continueAttentionSubject(fallback)).toBe('feature');
    expect(continueAttentionStatus(fallback)).toBe('has unread updates');
    expect(
      continueAttentionSubject(chatItem('unread', 'c', { chatTitle: '' })),
    ).toBe('Worktree wt-1');
  });
});

describe('sameContinueAttentionItems and counts', () => {
  it('compares field-wise', () => {
    const left = [chatItem('question', 'c', { eventAt: 1 })];

    expect(
      sameContinueAttentionItems(left, [
        chatItem('question', 'c', { eventAt: 1 }),
      ]),
    ).toBe(true);
    expect(
      sameContinueAttentionItems(left, [
        chatItem('question', 'c', { eventAt: 2 }),
      ]),
    ).toBe(false);
  });

  it('counts deduplicated rows by kind', () => {
    expect(
      countContinueAttentionByKind([
        chatItem('question', 'a'),
        chatItem('unread', 'a'),
        chatItem('unread', 'b'),
      ]),
    ).toEqual({ question: 1, 'tool-approval': 0, 'plan-review': 0, unread: 1 });
  });
});

describe('resolveLastViewedNames', () => {
  const fallbackName = 'New Task';

  it.each([
    [
      'labeled, titled chat',
      { worktreeLabel: 'Checkout', chatTitle: 'Fix form', branchName: 'fix' },
      { destinationName: 'Checkout', chatTitle: 'Fix form' },
    ],
    [
      'labeled, no usable title',
      { worktreeLabel: 'Checkout', chatTitle: ' ', branchName: 'fix' },
      { destinationName: 'Checkout' },
    ],
    [
      'unlabeled named branch, titled chat',
      { chatTitle: 'Fix form', branchName: 'fix-form' },
      { destinationName: 'Fix form', worktreeName: 'fix-form' },
    ],
    [
      'unlabeled named branch, no usable title',
      { branchName: 'fix-form' },
      { destinationName: 'fix-form' },
    ],
    [
      'unlabeled default branch, titled chat',
      { chatTitle: 'Fix form' },
      { destinationName: 'Fix form' },
    ],
    [
      'unlabeled default branch, no usable title',
      { chatTitle: '' },
      { destinationName: fallbackName },
    ],
  ])('names a %s', (_case, input, expected) => {
    expect(resolveLastViewedNames({ ...input, fallbackName })).toEqual(
      expected,
    );
  });

  it('trims candidates and treats whitespace as absent', () => {
    expect(
      resolveLastViewedNames({
        worktreeLabel: '   ',
        chatTitle: '  Fix form  ',
        branchName: ' fix-form ',
        fallbackName,
      }),
    ).toEqual({ destinationName: 'Fix form', worktreeName: 'fix-form' });
    expect(
      resolveLastViewedNames({ branchName: '\t', fallbackName: ' New Task ' }),
    ).toEqual({ destinationName: 'New Task' });
  });

  it('never repeats the destination as secondary text', () => {
    // A label equal to the title must not switch on the branch segment.
    expect(
      resolveLastViewedNames({
        worktreeLabel: 'Fix form',
        chatTitle: 'Fix form',
        branchName: 'fix-form',
        fallbackName,
      }),
    ).toEqual({ destinationName: 'Fix form' });
    expect(
      resolveLastViewedNames({
        chatTitle: 'fix-form',
        branchName: 'fix-form',
        fallbackName,
      }),
    ).toEqual({ destinationName: 'fix-form' });
  });
});
