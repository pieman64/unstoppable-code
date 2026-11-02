import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import {
  resolveAttentionLanding,
  type AttentionLandingInput,
} from '../attention-landing';
import type {
  ChatMessage,
  ChatTab,
  PendingPlanExit,
  PendingQuestion,
} from '../types';

const PROJECT = 'project-1';
const WORKTREE = 'worktree-1';

function tab(overrides: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: 'Chat',
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
    ...overrides,
  };
}

function message(timestamp: number): ChatMessage {
  return {
    id: `m-${String(timestamp)}`,
    role: 'assistant',
    timestamp,
    blocks: [],
  };
}

function question(
  chatId: string,
  overrides: Partial<PendingQuestion> = {},
): PendingQuestion {
  return {
    requestId: `q-${chatId}`,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId,
    questions: [],
    ...overrides,
  };
}

function approval(chatId: string): ApprovalRequestEvent {
  return {
    requestId: `a-${chatId}`,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId,
    provider: 'claude',
    title: 'Run tests',
    details: { kind: 'command', command: 'npm test' },
  };
}

function planExit(chatId: string): PendingPlanExit {
  return {
    requestId: `p-${chatId}`,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId,
    source: 'claude',
    toolInput: {},
  };
}

function resolve(
  overrides: Partial<AttentionLandingInput> & {
    tabs: readonly ChatTab[];
    activeTabId: string | undefined;
  },
): string | null {
  return resolveAttentionLanding({
    projectId: PROJECT,
    worktreeId: WORKTREE,
    hiddenChatTabIds: new Set(),
    pendingQuestions: {},
    pendingApprovals: {},
    pendingPlanExits: {},
    ...overrides,
  }).tabId;
}

function byRequest<T extends { requestId: string }>(
  ...entries: T[]
): Record<string, T> {
  return Object.fromEntries(entries.map((entry) => [entry.requestId, entry]));
}

describe('resolveAttentionLanding tab choice', () => {
  const quiet = tab({ id: 'quiet' });
  const asking = tab({ id: 'asking' });
  const approving = tab({ id: 'approving' });
  const planning = tab({ id: 'planning' });

  it('keeps the persisted tab when nothing needs the user', () => {
    expect(
      resolve({ tabs: [quiet, tab({ id: 'other' })], activeTabId: 'quiet' }),
    ).toBeNull();
  });

  it('lands on an unanswered question ahead of every other tier', () => {
    expect(
      resolve({
        tabs: [quiet, approving, planning, asking],
        activeTabId: 'quiet',
        pendingQuestions: byRequest(question('asking')),
        pendingApprovals: byRequest(approval('approving')),
        pendingPlanExits: byRequest(planExit('planning')),
      }),
    ).toBe('asking');
  });

  it('ranks a tool approval over a plan review, and a plan review over unread', () => {
    const unread = tab({ id: 'unread', unread: true });
    expect(
      resolve({
        tabs: [quiet, unread, planning, approving],
        activeTabId: 'quiet',
        pendingApprovals: byRequest(approval('approving')),
        pendingPlanExits: byRequest(planExit('planning')),
      }),
    ).toBe('approving');
    expect(
      resolve({
        tabs: [quiet, unread, tab({ id: 'planning', pendingPlanExit: {} })],
        activeTabId: 'quiet',
      }),
    ).toBe('planning');
  });

  it('keeps an active tab that is in the winning tier', () => {
    const second = tab({ id: 'second' });
    expect(
      resolve({
        tabs: [asking, second],
        activeTabId: 'second',
        pendingQuestions: byRequest(
          question('asking'),
          question('second', { requestId: 'q-2' }),
        ),
      }),
    ).toBeNull();
  });

  it('takes the first waiting tab in strip order otherwise', () => {
    const first = tab({ id: 'first' });
    const second = tab({ id: 'second' });
    expect(
      resolve({
        tabs: [quiet, first, second],
        activeTabId: 'quiet',
        pendingQuestions: byRequest(
          question('second'),
          question('first', { requestId: 'q-1' }),
        ),
      }),
    ).toBe('first');
  });

  it('never lets an active unread tab outrank a question on another tab', () => {
    expect(
      resolve({
        tabs: [tab({ id: 'read-me', unread: true }), asking],
        activeTabId: 'read-me',
        pendingQuestions: byRequest(question('asking')),
      }),
    ).toBe('asking');
  });

  it('keeps an active unread tab within the unread tier', () => {
    expect(
      resolve({
        tabs: [
          tab({ id: 'old', unread: true, messages: [message(100)] }),
          tab({ id: 'new', unread: true, messages: [message(900)] }),
        ],
        activeTabId: 'old',
      }),
    ).toBeNull();
  });

  it('lands on the newest unread tab by its latest message, not its last', () => {
    expect(
      resolve({
        tabs: [
          quiet,
          // Out of order: the latest message is not the final element.
          tab({
            id: 'newest',
            unread: true,
            messages: [message(900), message(200)],
          }),
          tab({ id: 'older', unread: true, messages: [message(500)] }),
        ],
        activeTabId: 'quiet',
      }),
    ).toBe('newest');
  });

  it('falls back to the last live event, then creation time, with invalid times oldest', () => {
    expect(
      resolve({
        tabs: [
          quiet,
          tab({ id: 'event', unread: true, lastEventAt: 2_000 }),
          tab({
            id: 'created',
            unread: true,
            createdAt: '1970-01-01T00:00:01.500Z',
          }),
          tab({
            id: 'invalid',
            unread: true,
            createdAt: 'not a date',
            messages: [message(Number.NaN)],
          }),
        ],
        activeTabId: 'quiet',
      }),
    ).toBe('event');
    expect(
      resolve({
        tabs: [
          quiet,
          tab({
            id: 'created',
            unread: true,
            createdAt: '2026-01-01T00:00:00Z',
          }),
          tab({ id: 'invalid', unread: true, createdAt: 'not a date' }),
        ],
        activeTabId: 'quiet',
      }),
    ).toBe('created');
  });

  it('breaks a time tie by the later strip position', () => {
    expect(
      resolve({
        tabs: [
          quiet,
          tab({ id: 'left', unread: true, messages: [message(500)] }),
          tab({ id: 'right', unread: true, messages: [message(500)] }),
        ],
        activeTabId: 'quiet',
      }),
    ).toBe('right');
  });

  it('never targets hidden chats or file tabs', () => {
    expect(
      resolve({
        tabs: [
          quiet,
          tab({ id: 'hidden' }),
          tab({ id: 'file', kind: 'file', unread: true }),
        ],
        activeTabId: 'quiet',
        hiddenChatTabIds: new Set(['hidden']),
        pendingQuestions: byRequest(question('hidden')),
      }),
    ).toBeNull();
  });

  it('ignores answered questions, other scopes, and absent chats', () => {
    expect(
      resolve({
        tabs: [quiet, asking],
        activeTabId: 'quiet',
        pendingQuestions: byRequest(
          question('asking', { answeredAt: 1 }),
          question('asking', { requestId: 'other-worktree', worktreeId: 'w2' }),
          question('gone', { requestId: 'absent' }),
        ),
        pendingApprovals: {
          other: { ...approval('asking'), requestId: 'other', projectId: 'p2' },
        },
        pendingPlanExits: byRequest(planExit('gone')),
      }),
    ).toBeNull();
  });

  it('still lands on a dismissed question that is unanswered', () => {
    expect(
      resolve({
        tabs: [quiet, asking],
        activeTabId: 'quiet',
        pendingQuestions: byRequest(question('asking', { dismissedAt: 5 })),
      }),
    ).toBe('asking');
  });

  it('preserves a saved file tab when no chat needs attention', () => {
    expect(
      resolve({
        tabs: [quiet, tab({ id: 'file', kind: 'file' })],
        activeTabId: 'file',
      }),
    ).toBeNull();
  });

  it.each(['approval', 'plan'] as const)(
    'retains the active chat within the winning %s tier',
    (tier) => {
      expect(
        resolve({
          tabs: [quiet, approving, planning],
          activeTabId: 'planning',
          pendingApprovals:
            tier === 'approval'
              ? byRequest(approval('approving'), approval('planning'))
              : {},
          pendingPlanExits:
            tier === 'plan'
              ? byRequest(planExit('approving'), planExit('planning'))
              : {},
        }),
      ).toBeNull();
    },
  );

  it('lands even when the persisted active tab no longer exists', () => {
    expect(
      resolve({
        tabs: [quiet, asking],
        activeTabId: 'deleted',
        pendingQuestions: byRequest(question('asking')),
      }),
    ).toBe('asking');
    expect(resolve({ tabs: [quiet], activeTabId: 'deleted' })).toBeNull();
  });
});

describe('resolveAttentionLanding', () => {
  const base = {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    hiddenChatTabIds: new Set<string>(),
    pendingQuestions: {},
    pendingApprovals: {},
    pendingPlanExits: {},
  };
  const quiet = tab({ id: 'quiet' });
  const asking = tab({ id: 'asking' });

  it('reports no attention for a quiet worktree', () => {
    expect(
      resolveAttentionLanding({
        ...base,
        tabs: [quiet, asking],
        activeTabId: 'quiet',
      }),
    ).toEqual({ tabId: null, attended: false });
  });

  it('reports attention when the active tab already is the target', () => {
    expect(
      resolveAttentionLanding({
        ...base,
        tabs: [quiet, asking],
        activeTabId: 'asking',
        pendingQuestions: byRequest(question('asking')),
      }),
    ).toEqual({ tabId: null, attended: true });
    expect(
      resolveAttentionLanding({
        ...base,
        tabs: [tab({ id: 'unread', unread: true }), quiet],
        activeTabId: 'unread',
      }),
    ).toEqual({ tabId: null, attended: true });
  });

  it('reports the tab it switches to', () => {
    expect(
      resolveAttentionLanding({
        ...base,
        tabs: [quiet, asking],
        activeTabId: 'quiet',
        pendingQuestions: byRequest(question('asking')),
      }),
    ).toEqual({ tabId: 'asking', attended: true });
  });
});
