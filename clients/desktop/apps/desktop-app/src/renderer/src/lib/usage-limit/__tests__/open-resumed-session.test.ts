/** @jest-environment jsdom */
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ResumeQueueEntry,
  type ResumeQueueSnapshot,
  type UsageLimitedSessionTarget,
} from '@canopy/desktop-shared/types';
import {
  openAutomationRunDestination,
  type OpenAutomationRunDestinationResult,
} from '@/components/automations/resolveAutomationRunDestination';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import {
  RESUME_DESTINATION_ERROR,
  directResumeEntry,
  openResumeQueueEntry,
  resumeQueueEntryDestination,
  resumeQueueEntryDestinationLabel,
  soleResumedChatEntry,
  usageLimitedChatDestination,
} from '../open-resumed-session';
import type * as AutomationRunDestinationModule from '@/components/automations/resolveAutomationRunDestination';

jest.mock('@/components/automations/resolveAutomationRunDestination', () => ({
  ...jest.requireActual<typeof AutomationRunDestinationModule>(
    '@/components/automations/resolveAutomationRunDestination',
  ),
  openAutomationRunDestination: jest.fn(),
}));

const chatTarget: UsageLimitedSessionTarget = {
  kind: 'chat',
  projectId: 'ws-a',
  worktreeId: 'wt',
  chatId: 'c1',
};

function entry(
  overrides: Partial<ResumeQueueEntry> & Pick<ResumeQueueEntry, 'id'>,
): ResumeQueueEntry {
  return {
    createdAt: 1,
    status: 'waiting',
    target: chatTarget,
    title: 'One',
    workspaceName: 'Workspace A',
    interruptionId: `interruption-${overrides.id}`,
    ...overrides,
  };
}

function queue(
  entries: ResumeQueueEntry[],
  extra: Partial<ResumeQueueSnapshot> = {},
): ResumeQueueSnapshot {
  return { version: 1, revision: 1, paused: false, entries, ...extra };
}

describe('resumeQueueEntryDestination', () => {
  it.each<ResumeQueueEntry['status']>([
    'waiting',
    'resuming',
    'failed',
    'stopped',
    'skipped',
  ])('opens a %s chat without turn focus', (status) => {
    expect(resumeQueueEntryDestination(entry({ id: 'e1', status }))).toEqual({
      kind: 'worktree-chat',
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
    });
  });

  it('does not treat a resumed queue id as a message id', () => {
    expect(
      resumeQueueEntryDestination(entry({ id: 'e1', status: 'resumed' })),
    ).toEqual({
      kind: 'worktree-chat',
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
    });
  });

  it('maps App Advisor chats to their own destination', () => {
    expect(
      resumeQueueEntryDestination(
        entry({
          id: 'e1',
          status: 'resumed',
          target: { ...chatTarget, projectId: APP_ADVISOR_PROJECT_ID },
        }),
      ),
    ).toEqual({ kind: 'app-advisor-chat', chatId: 'c1' });
  });

  it('maps standalone chats to their cowork workspace', () => {
    expect(
      resumeQueueEntryDestination(
        entry({
          id: 'e1',
          target: {
            kind: 'chat',
            projectId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: 'cowork-ws',
            chatId: 'c1',
          },
        }),
      ),
    ).toEqual({ kind: 'cowork-chat', workspaceId: 'cowork-ws', chatId: 'c1' });
  });

  it('maps pipelines to their execution, whatever their status', () => {
    const pipeline = entry({
      id: 'p1',
      status: 'resumed',
      target: { kind: 'pipeline', executionId: 'exec-1', statusReasonIds: [] },
    });
    expect(resumeQueueEntryDestination(pipeline)).toEqual({
      kind: 'pipeline-execution',
      executionId: 'exec-1',
    });
    expect(resumeQueueEntryDestinationLabel(pipeline)).toBe('Open run');
    expect(resumeQueueEntryDestinationLabel(entry({ id: 'e1' }))).toBe(
      'Open chat',
    );
  });
});

describe('usageLimitedChatDestination', () => {
  it('does not require an unused worktree identity for App Advisor', () => {
    expect(
      usageLimitedChatDestination({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: '',
        chatId: 'advisor-chat',
      }),
    ).toEqual({ kind: 'app-advisor-chat', chatId: 'advisor-chat' });
  });

  it('maps worktree, cowork, and App Advisor chats without a turn', () => {
    expect(
      usageLimitedChatDestination({
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
      }),
    ).toEqual({
      kind: 'worktree-chat',
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
    });
    expect(
      usageLimitedChatDestination({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'cowork-ws',
        chatId: 'c1',
      }),
    ).toEqual({ kind: 'cowork-chat', workspaceId: 'cowork-ws', chatId: 'c1' });
    expect(
      usageLimitedChatDestination({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'wt',
        chatId: 'c1',
      }),
    ).toEqual({ kind: 'app-advisor-chat', chatId: 'c1' });
  });
});

describe('openResumeQueueEntry', () => {
  const open = jest.mocked(openAutomationRunDestination);
  beforeEach(() => open.mockReset());

  it('passes through a successful or explained result', async () => {
    open.mockResolvedValueOnce({ ok: true });
    await expect(openResumeQueueEntry(entry({ id: 'e1' }))).resolves.toEqual({
      ok: true,
    });
    open.mockResolvedValueOnce({ ok: false, error: 'Gone.' });
    await expect(openResumeQueueEntry(entry({ id: 'e1' }))).resolves.toEqual({
      ok: false,
      error: 'Gone.',
    });
  });

  it.each(['ordinary-resume-message', 'queue-entry-id'])(
    'reveals the accepted turn %s rather than assuming the queue identity',
    async (acceptedId) => {
      const loadTabs = jest.fn().mockResolvedValue({
        version: 1,
        tabs: [
          { id: 'c1', messages: [], lastAcceptedUserMessageId: acceptedId },
        ],
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { chat: { loadTabs } },
      });
      open.mockResolvedValue({ ok: true });
      await expect(
        openResumeQueueEntry(
          entry({ id: 'queue-entry-id', status: 'resumed' }),
        ),
      ).resolves.toEqual({ ok: true });
      expect(loadTabs).toHaveBeenCalledWith({
        projectId: 'ws-a',
        worktreeId: 'wt',
      });
      expect(open).toHaveBeenCalledWith({
        kind: 'worktree-chat',
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
        userMessageId: acceptedId,
      });
    },
  );

  it('reads the current Work Entry for a migrated standalone queue target', async () => {
    const tabsFile = {
      tabs: [
        {
          id: 'c1',
          messages: [],
          lastAcceptedUserMessageId: 'accepted-resume',
        },
      ],
    };
    const loadTabs = jest.fn().mockResolvedValue(tabsFile);
    const resolveChat = jest
      .fn()
      .mockResolvedValue({ entryId: 'current-entry', archivedInEntryId: null });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { loadTabs }, workEntries: { resolveChat } },
    });
    open.mockResolvedValue({ ok: true });
    await openResumeQueueEntry(
      entry({
        id: 'random-queue-id',
        status: 'resumed',
        target: {
          kind: 'chat',
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-project',
          chatId: 'c1',
        },
      }),
    );
    expect(resolveChat).toHaveBeenCalledWith({
      projectId: 'cowork-project',
      chatId: 'c1',
    });
    expect(loadTabs).toHaveBeenCalledWith({
      projectId: 'cowork-project',
      worktreeId: 'current-entry',
    });
    expect(open).toHaveBeenCalledWith({
      kind: 'cowork-chat',
      workspaceId: 'cowork-project',
      chatId: 'c1',
      userMessageId: 'accepted-resume',
    });
  });

  it('uses the latest user turn for legacy chats without an acceptance receipt', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chat: {
          loadTabs: jest.fn().mockResolvedValue({
            tabs: [
              {
                id: 'c1',
                messages: [
                  { id: 'resume-message', role: 'user' },
                  { id: 'completed-reply', role: 'assistant' },
                ],
              },
            ],
          }),
        },
      },
    });
    open.mockResolvedValue({ ok: true });
    await openResumeQueueEntry(
      entry({ id: 'random-queue-id', status: 'resumed' }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: 'resume-message' }),
    );
  });

  it('retains the retry route when the accepted-turn read rejects', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chat: {
          loadTabs: jest.fn().mockRejectedValue(new Error('unavailable')),
        },
      },
    });
    await expect(
      openResumeQueueEntry(entry({ id: 'random-queue-id', status: 'resumed' })),
    ).resolves.toEqual({ ok: false, error: RESUME_DESTINATION_ERROR });
    expect(open).not.toHaveBeenCalled();
    expect(useResumeQueueStore.getState().pendingNavigationCount).toBe(0);
  });

  it('turns a rejected navigation into visible feedback', async () => {
    open.mockRejectedValueOnce(new Error('boom'));
    await expect(openResumeQueueEntry(entry({ id: 'e1' }))).resolves.toEqual({
      ok: false,
      error: RESUME_DESTINATION_ERROR,
    });
  });

  it('retains pending navigation state until overlapping destinations settle', async () => {
    let finishFirst: (
      result: OpenAutomationRunDestinationResult,
    ) => void = () => undefined;
    let finishSecond: (
      result: OpenAutomationRunDestinationResult,
    ) => void = () => undefined;
    open.mockReturnValueOnce(
      new Promise<OpenAutomationRunDestinationResult>((resolve) => {
        finishFirst = resolve;
      }),
    );
    open.mockReturnValueOnce(
      new Promise<OpenAutomationRunDestinationResult>((resolve) => {
        finishSecond = resolve;
      }),
    );
    const first = openResumeQueueEntry(entry({ id: 'e1' }));
    const second = openResumeQueueEntry(entry({ id: 'e2' }));
    expect(useResumeQueueStore.getState().pendingNavigationCount).toBe(2);
    finishFirst({ ok: true });
    await first;
    expect(useResumeQueueStore.getState().pendingNavigationCount).toBe(1);
    finishSecond({ ok: false, error: 'Gone.' });
    await second;
    expect(useResumeQueueStore.getState().pendingNavigationCount).toBe(0);
  });
});

describe('directResumeEntry', () => {
  const waiting = entry({ id: 'e1' });

  it.each<ResumeQueueEntry['status']>(['waiting', 'resuming', 'resumed'])(
    'returns the matching %s entry',
    (status) => {
      const match = entry({ id: 'e1', status });
      expect(directResumeEntry(queue([match]), [chatTarget])).toBe(match);
    },
  );

  it('ignores completed historical entries for other sessions', () => {
    const history = entry({
      id: 'old',
      status: 'resumed',
      target: { ...chatTarget, chatId: 'c0' },
    });
    expect(directResumeEntry(queue([history, waiting]), [chatTarget])).toBe(
      waiting,
    );
  });

  it.each<[string, ResumeQueueSnapshot, UsageLimitedSessionTarget[]]>([
    ['several targets', queue([waiting]), [chatTarget, chatTarget]],
    [
      'a pipeline',
      queue([waiting]),
      [{ kind: 'pipeline', executionId: 'x', statusReasonIds: [] }],
    ],
    ['a paused queue', queue([waiting], { paused: true }), [chatTarget]],
    ['a queue error', queue([waiting], { error: 'Failed' }), [chatTarget]],
    ['no match', queue([]), [chatTarget]],
    [
      'a failed match',
      queue([entry({ id: 'e1', status: 'failed' })]),
      [chatTarget],
    ],
    [
      'a failed sibling',
      queue([
        waiting,
        entry({
          id: 'e2',
          status: 'failed',
          target: { ...chatTarget, chatId: 'c2' },
        }),
      ]),
      [chatTarget],
    ],
    [
      'another pending entry',
      queue([
        waiting,
        entry({ id: 'e2', target: { ...chatTarget, chatId: 'c2' } }),
      ]),
      [chatTarget],
    ],
    [
      'an ambiguous match',
      queue([waiting, entry({ id: 'e2', status: 'resumed' })]),
      [chatTarget],
    ],
    [
      'a match on another worktree',
      queue([entry({ id: 'e1', target: { ...chatTarget, worktreeId: 'x' } })]),
      [chatTarget],
    ],
  ])('returns null for %s', (_label, snapshot, targets) => {
    expect(directResumeEntry(snapshot, targets)).toBeNull();
  });
});

describe('soleResumedChatEntry', () => {
  const resumed = entry({ id: 'e1', status: 'resumed' });

  it('returns the only resumed chat, despite failed or stopped siblings', () => {
    expect(
      soleResumedChatEntry(
        queue([
          resumed,
          entry({ id: 'e2', status: 'failed' }),
          entry({ id: 'e3', status: 'stopped' }),
        ]),
      ),
    ).toBe(resumed);
  });

  it('returns null for zero or several resumed entries, or a lone pipeline', () => {
    expect(soleResumedChatEntry(queue([]))).toBeNull();
    expect(
      soleResumedChatEntry(
        queue([resumed, entry({ id: 'e2', status: 'resumed' })]),
      ),
    ).toBeNull();
    expect(
      soleResumedChatEntry(
        queue([
          entry({
            id: 'p1',
            status: 'resumed',
            target: { kind: 'pipeline', executionId: 'x', statusReasonIds: [] },
          }),
        ]),
      ),
    ).toBeNull();
  });
});
