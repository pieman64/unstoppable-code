import type {
  ApprovalRequestEvent,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import {
  closeTimersForRemovedApprovals,
  hydratePendingApprovalsFromFile,
  reconcileLivePendingApprovals,
  removePendingApprovalsForChats,
  toPersistedPendingApprovals,
} from '../pending-approvals';
import { toPersistedTabs } from '../persisted-tabs';
import {
  hasPendingPromptForLiveTab,
  restoreStreamingTabs,
} from '../session-restore';
import { emptyWorktreeChat } from '../tab-utils';
import type {
  ChatMessage,
  ChatTab,
  PendingQuestion,
  WorktreeChatState,
} from '../types';

function makeTab(overrides?: Partial<ChatTab>): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    ...overrides,
  };
}

function makeState(tabs: ChatTab[]): WorktreeChatState {
  return { ...emptyWorktreeChat(), tabs, activeTabId: tabs[0]?.id ?? '' };
}

function makeEvent(
  overrides?: Partial<ApprovalRequestEvent>,
): ApprovalRequestEvent {
  return {
    requestId: 'req-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'claude',
    title: 'Run command',
    details: { kind: 'command', command: 'rm -rf build' },
    ...overrides,
  };
}

describe('toPersistedPendingApprovals', () => {
  it('persists only pendings for existing chat ids in this project/worktree', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const pendingApprovals: Record<string, ApprovalRequestEvent> = {
      'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-1' }),
      // Different chat id, not in this worktree's tabs.
      'req-2': makeEvent({ requestId: 'req-2', chatId: 'chat-missing' }),
      // Different worktree entirely.
      'req-3': makeEvent({
        requestId: 'req-3',
        chatId: 'chat-1',
        worktreeId: 'other-worktree',
      }),
    };

    const persisted = toPersistedPendingApprovals(
      'project-1',
      'worktree-1',
      state,
      pendingApprovals,
    );

    expect(persisted).toEqual([
      {
        requestId: 'req-1',
        chatId: 'chat-1',
        event: pendingApprovals['req-1'],
      },
    ]);
  });

  it('returns undefined when nothing is persistable', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const persisted = toPersistedPendingApprovals(
      'project-1',
      'worktree-1',
      state,
      {
        'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-missing' }),
      },
    );
    expect(persisted).toBeUndefined();
  });
});

describe('hydratePendingApprovalsFromFile', () => {
  it('skips pending approvals for chat ids that no longer exist', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const file = {
      version: 1,
      tabs: [],
      activeTabId: 'chat-1',
      pendingApprovals: [
        {
          requestId: 'req-1',
          chatId: 'chat-1',
          event: makeEvent({ requestId: 'req-1', chatId: 'chat-1' }),
        },
        {
          requestId: 'req-2',
          chatId: 'chat-gone',
          event: makeEvent({ requestId: 'req-2', chatId: 'chat-gone' }),
        },
      ],
    };

    const hydrated = hydratePendingApprovalsFromFile(
      file,
      'project-1',
      'worktree-1',
      state,
    );

    expect(Object.keys(hydrated)).toEqual(['req-1']);
    expect(hydrated['req-1'].chatId).toBe('chat-1');
  });

  it('returns an empty record when pendingApprovals is absent', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const file: ChatTabsFile = {
      version: 1,
      tabs: [],
      activeTabId: 'chat-1',
    };

    expect(
      hydratePendingApprovalsFromFile(file, 'project-1', 'worktree-1', state),
    ).toEqual({});
  });

  it('ignores malformed persisted entries', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const file: ChatTabsFile = {
      version: 1,
      tabs: [],
      activeTabId: 'chat-1',
      // Malformed entry missing required fields.
      pendingApprovals: [{ requestId: 'req-1' }],
    };

    expect(
      hydratePendingApprovalsFromFile(file, 'project-1', 'worktree-1', state),
    ).toEqual({});
  });

  it('restores a persisted browser upload approval and rejects one without its files', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const upload = makeEvent({
      title: 'Upload report.csv to https://upload.example?',
      details: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        files: [{ displayPath: 'exports/report.csv', sizeBytes: 8 }],
      },
    });
    const file = (event: unknown): ChatTabsFile =>
      JSON.parse(
        JSON.stringify({
          version: 1,
          tabs: [],
          activeTabId: 'chat-1',
          pendingApprovals: [{ requestId: 'req-1', chatId: 'chat-1', event }],
        }),
      ) as ChatTabsFile;

    expect(
      hydratePendingApprovalsFromFile(
        file(upload),
        'project-1',
        'worktree-1',
        state,
      ),
    ).toEqual({ 'req-1': upload });
    expect(
      hydratePendingApprovalsFromFile(
        file({ ...upload, details: { kind: 'browser-upload', origin: 'x' } }),
        'project-1',
        'worktree-1',
        state,
      ),
    ).toEqual({});
  });

  it('restores a persisted file request and rejects one without its multiple flag', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const request = makeEvent({
      title: 'Choose a file for upload.example',
      details: {
        kind: 'browser-file-request',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        purpose: 'Your résumé',
        multiple: true,
      },
    });
    const file = (event: unknown): ChatTabsFile =>
      JSON.parse(
        JSON.stringify({
          version: 1,
          tabs: [],
          activeTabId: 'chat-1',
          pendingApprovals: [{ requestId: 'req-1', chatId: 'chat-1', event }],
        }),
      ) as ChatTabsFile;

    expect(
      hydratePendingApprovalsFromFile(
        file(request),
        'project-1',
        'worktree-1',
        state,
      ),
    ).toEqual({ 'req-1': request });
    expect(
      hydratePendingApprovalsFromFile(
        file({
          ...request,
          details: { kind: 'browser-file-request', origin: 'x' },
        }),
        'project-1',
        'worktree-1',
        state,
      ),
    ).toEqual({});
  });

  it('ignores entries whose nested approval event is incomplete', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const file = {
      version: 1,
      tabs: [],
      activeTabId: 'chat-1',
      pendingApprovals: [
        {
          requestId: 'req-1',
          chatId: 'chat-1',
          event: {
            requestId: 'req-1',
            chatId: 'chat-1',
            title: 'Missing provider and details',
          },
        },
      ],
    };

    expect(
      hydratePendingApprovalsFromFile(file, 'project-1', 'worktree-1', state),
    ).toEqual({});
  });
});

describe('removePendingApprovalsForChats', () => {
  it('removes only pendings that match the project/worktree/chat ids', () => {
    const pendingApprovals: Record<string, ApprovalRequestEvent> = {
      'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-1' }),
      'req-2': makeEvent({ requestId: 'req-2', chatId: 'chat-2' }),
      'req-3': makeEvent({
        requestId: 'req-3',
        chatId: 'chat-1',
        worktreeId: 'other-worktree',
      }),
    };

    const next = removePendingApprovalsForChats(
      pendingApprovals,
      'project-1',
      'worktree-1',
      ['chat-1'],
    );

    expect(Object.keys(next).sort()).toEqual(['req-2', 'req-3']);
  });

  it('returns the same reference when nothing matches', () => {
    const pendingApprovals: Record<string, ApprovalRequestEvent> = {
      'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-1' }),
    };
    const next = removePendingApprovalsForChats(
      pendingApprovals,
      'project-1',
      'worktree-1',
      ['chat-unrelated'],
    );
    expect(next).toBe(pendingApprovals);
  });
});

describe('reconcileLivePendingApprovals', () => {
  it('restores a live event that the renderer did not persist', () => {
    const event = makeEvent({ requestId: 'missed' });
    expect(
      reconcileLivePendingApprovals(
        {},
        [event],
        'project-1',
        'worktree-1',
        makeState([makeTab({ id: 'chat-1' })]),
      ),
    ).toEqual({
      pendingApprovals: { missed: event },
      removedStaleApprovals: false,
    });
  });

  it('filters stale and out-of-scope live events', () => {
    const stale = makeEvent({ requestId: 'stale' });
    const live = makeEvent({ requestId: 'live' });
    const result = reconcileLivePendingApprovals(
      { stale },
      [live, makeEvent({ requestId: 'other', worktreeId: 'other-worktree' })],
      'project-1',
      'worktree-1',
      makeState([makeTab({ id: 'chat-1' })]),
    );

    expect(result).toEqual({
      pendingApprovals: { live },
      removedStaleApprovals: true,
    });
  });
});

describe('closeTimersForRemovedApprovals', () => {
  it('closes a paused turn timer when its persisted approval is no longer live', () => {
    const tab = makeTab({
      messages: [
        {
          id: 'timer-1',
          role: 'system',
          timestamp: 1_000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1_000,
              pausedAt: 2_000,
              resumedAt: null,
              completedAt: null,
            },
          ],
        },
      ],
    });

    const tabs = closeTimersForRemovedApprovals(
      [tab],
      { stale: { chatId: tab.id } },
      {},
    );

    expect(tabs[0].messages[0].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: 2_000,
    });
  });

  it('preserves paused timers for approvals that are still live', () => {
    const tab = makeTab({
      messages: [
        {
          id: 'timer-1',
          role: 'system',
          timestamp: 1_000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1_000,
              pausedAt: 2_000,
              resumedAt: null,
              completedAt: null,
            },
          ],
        },
      ],
    });

    const tabs = [tab];
    expect(
      closeTimersForRemovedApprovals(
        tabs,
        { live: { chatId: tab.id } },
        { live: makeEvent({ requestId: 'live' }) },
      ),
    ).toBe(tabs);
    expect(tab.messages[0].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
  });
});

describe('full-save pendingApprovals preservation', () => {
  // Guards the flushWorktreeTabs / archive-restore / adhoc-migrate style
  // full-overwrite saves: any toPersistedTabs call made with the full option
  // set must carry live pending approvals into the written file, or the
  // overwrite silently wipes them from disk for the whole worktree.
  it('toPersistedTabs with the full option set writes pendingApprovals', () => {
    const state = makeState([makeTab({ id: 'chat-1' })]);
    const pending = makeEvent({ requestId: 'req-1', chatId: 'chat-1' });

    const file = toPersistedTabs(state, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pendingQuestions: {},
      pendingApprovals: { 'req-1': pending },
    });

    expect(file.pendingApprovals).toEqual([
      { requestId: 'req-1', chatId: 'chat-1', event: pending },
    ]);
  });
});

describe('restoreStreamingTabs pending-approval preservation', () => {
  function messagesWithOpenToolUse(): ChatMessage[] {
    return [
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_pending',
            toolName: 'Bash',
            input: '{"command":"rm -rf build"}',
            timestamp: 1,
          },
        ],
      },
    ];
  }

  it('keeps the open tool_use block intact when the chat has a pending approval', () => {
    const tab = makeTab({ id: 'chat-1', messages: messagesWithOpenToolUse() });

    const { tabs } = restoreStreamingTabs([tab], { activeChatIds: [] }, 1_000, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pendingQuestions: {},
      pendingApprovals: {
        'req-1': makeEvent({
          requestId: 'req-1',
          chatId: 'chat-1',
          toolUseId: 'toolu_pending',
        }),
      },
    });

    // Preserved: no synthetic 'Cancelled' tool_result appended, status idle.
    expect(tabs[0].status).toBe('idle');
    expect(
      tabs[0].messages.flatMap((msg) =>
        msg.blocks.filter((block) => block.type === 'tool_result'),
      ),
    ).toEqual([]);
  });

  it('closes the open tool_use block when no pending approval exists', () => {
    const tab = makeTab({ id: 'chat-1', messages: messagesWithOpenToolUse() });

    const { tabs } = restoreStreamingTabs([tab], { activeChatIds: [] }, 1_000, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pendingQuestions: {},
      pendingApprovals: {},
    });

    expect(
      tabs[0].messages.flatMap((msg) =>
        msg.blocks.filter((block) => block.type === 'tool_result'),
      ),
    ).not.toEqual([]);
  });
});

describe('hasPendingPromptForLiveTab', () => {
  // The live `verifyStreamingTabs` poll (chat/slices/events.ts) uses this
  // helper to decide whether to skip force-closing a streaming tab that has
  // dropped out of `activeChatIds` once the restore grace window elapses.
  function makePendingQuestion(
    overrides?: Partial<PendingQuestion>,
  ): PendingQuestion {
    return {
      requestId: 'question-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      questions: [{ question: 'Pick one', header: 'Choose', options: [] }],
      ...overrides,
    };
  }

  it('returns true when the chat has a pending tool-approval prompt', () => {
    const tab = makeTab({ id: 'chat-1' });

    expect(
      hasPendingPromptForLiveTab(tab, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pendingQuestions: {},
        pendingApprovals: {
          'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-1' }),
        },
      }),
    ).toBe(true);
  });

  it('returns true when the chat has a pending ask-user question', () => {
    const tab = makeTab({ id: 'chat-1' });

    expect(
      hasPendingPromptForLiveTab(tab, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pendingQuestions: { 'question-1': makePendingQuestion() },
        pendingApprovals: {},
      }),
    ).toBe(true);
  });

  it('returns false when neither a pending approval nor a pending question exists for the chat', () => {
    const tab = makeTab({ id: 'chat-1' });

    expect(
      hasPendingPromptForLiveTab(tab, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pendingQuestions: {},
        pendingApprovals: {},
      }),
    ).toBe(false);
  });

  it('returns false when the pending approval belongs to a different chat', () => {
    const tab = makeTab({ id: 'chat-1' });

    expect(
      hasPendingPromptForLiveTab(tab, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pendingQuestions: {},
        pendingApprovals: {
          'req-1': makeEvent({ requestId: 'req-1', chatId: 'chat-other' }),
        },
      }),
    ).toBe(false);
  });
});
