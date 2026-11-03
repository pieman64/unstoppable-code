// CAN-4742: a Home first send is shown before dispatch. Its echo, turn bridge
// and title stay renderer-only, survive canonical refreshes, and never
// overwrite a generated or user-assigned title.
import { initClaudeModels } from '@canopy/desktop-shared/types';
import {
  applyCanonicalChanges,
  preserveRendererOnlyTabFields,
} from '../canonical-changes';
import { toPersistedTab } from '../persisted-tabs';
import {
  failProvisionalFirstSendOnTab,
  handOffProvisionalFirstSendToQueue,
  isProvisionalFirstSendAdmissionPending,
  presentProvisionalFirstSendOnTab,
  reconcileProvisionalTerminalFirstSend,
  retryFailedProvisionalFirstSendOnTab,
  startingTurnUserMessageId,
  withdrawProvisionalFirstSendFromTab,
} from '../provisional-first-send';
import { createEmptyTab } from '../tab-utils';
import {
  toActiveComposerView,
  toActiveTranscriptView,
} from '@/components/chat/types';
import { presentedMessages } from '../optimistic-presentation';
import { getLockedHarness, getLockedProvider } from '@/lib/chatProviderLock';
import type { ChatTab } from '../types';

beforeAll(() => {
  initClaudeModels([
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
  ]);
});

const input = {
  userMessageId: 'msg-home-1',
  submittedAt: 1_000,
  text: 'Why is the deck empty?',
};

function starter(overrides: Partial<ChatTab> = {}): ChatTab {
  return { ...createEmptyTab(), id: 'chat', ...overrides };
}

function presented(overrides: Partial<ChatTab> = {}): ChatTab {
  const tab = presentProvisionalFirstSendOnTab(starter(overrides), input);
  if (!tab) throw new Error('expected the starter to accept the first send');
  return tab;
}

it('adopts attachment-only terminal imports and keeps terminal matching metadata renderer-only', () => {
  const initial = presentProvisionalFirstSendOnTab(starter(), {
    ...input,
    text: '',
    attachmentPaths: ['submitted.png'],
  });
  if (!initial?.provisionalFirstSend) throw new Error('Missing first send');
  const imported: ChatTab['messages'][number] = {
    id: 'terminal-user',
    role: 'user',
    timestamp: 2000,
    blocks: [{ type: 'text', text: '[Image attached]' }],
    attachmentPaths: ['imported.png'],
  };
  const tab = {
    ...initial,
    provisionalFirstSend: {
      ...initial.provisionalFirstSend,
      terminalPromptText: 'Attachment instructions',
    },
    messages: [...initial.messages, imported],
  };
  const next = reconcileProvisionalTerminalFirstSend(tab, [imported]);
  expect(
    next.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  ).toEqual(['terminal-user']);
  expect(next.pendingUserMessages).toBeUndefined();
  expect(presentedMessages(next)[0].timestamp).toBe(input.submittedAt);
  const serialized = JSON.stringify(toPersistedTab(next));
  expect(serialized).not.toContain('terminalPromptText');
  expect(serialized).not.toContain('terminalUserMessageId');
});

it('adopts terminal imports when image rewriting retains a source reference', () => {
  const initial = presentProvisionalFirstSendOnTab(starter(), {
    ...input,
    attachmentPaths: ['/worktree/screenshot.png'],
  });
  if (!initial?.provisionalFirstSend) throw new Error('Missing first send');
  const imported: ChatTab['messages'][number] = {
    id: 'terminal-user',
    role: 'user',
    timestamp: 2000,
    blocks: [
      {
        type: 'text',
        text: `System note\n\n${input.text}\n\n/worktree/source.ts`,
      },
    ],
    attachmentPaths: ['imported.png'],
  };
  const tab = {
    ...initial,
    provisionalFirstSend: {
      ...initial.provisionalFirstSend,
      terminalPromptText: `System note\n\n${input.text}\n\n/worktree/source.ts\n/worktree/screenshot.png`,
    },
    messages: [...initial.messages, imported],
  };
  const next = reconcileProvisionalTerminalFirstSend(tab, [imported]);
  expect(
    next.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  ).toEqual(['terminal-user']);
  expect(next.pendingUserMessages).toBeUndefined();
});

it.each(['delta', 'snapshot'])(
  'adopts the terminal user during canonical %s publication before the raw event',
  (publication) => {
    const initial = presented();
    if (!initial.provisionalFirstSend) throw new Error('Missing first send');
    const tab: ChatTab = {
      ...initial,
      provisionalFirstSend: {
        ...initial.provisionalFirstSend,
        terminalPromptText: input.text,
      },
    };
    const imported: ChatTab['messages'][number] = {
      id: 'canonical-terminal-user',
      role: 'user',
      timestamp: 2000,
      blocks: [{ type: 'text', text: input.text }],
    };
    const canonical =
      publication === 'delta'
        ? applyCanonicalChanges(
            {
              chatState: { tabs: [tab], activeTabId: tab.id },
              archives: [],
              runtimeByChatId: {},
              pendingQuestions: {},
            },
            [{ type: 'message.upserted', chatId: tab.id, message: imported }],
            { projectId: 'project', worktreeId: 'worktree' },
          ).chatState.tabs[0]
        : preserveRendererOnlyTabFields(tab, starter({ messages: [imported] }));
    const assertAdopted = (next: ChatTab): void => {
      expect(
        next.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
      ).toEqual([imported.id]);
      expect(next.pendingUserMessages).toBeUndefined();
      expect(next.pendingTurn?.userMessageId).toBe(imported.id);
      expect(presentedMessages(next)[0].timestamp).toBe(input.submittedAt);
    };
    assertAdopted(canonical);
    assertAdopted(reconcileProvisionalTerminalFirstSend(canonical, [imported]));
    const timer: ChatTab['messages'][number] = {
      id: 'canonical-timer',
      role: 'system',
      timestamp: 2000,
      blocks: [{ type: 'turn_timer', startedAt: 2000, completedAt: null }],
    };
    const timed = applyCanonicalChanges(
      {
        chatState: { tabs: [canonical], activeTabId: tab.id },
        archives: [],
        runtimeByChatId: {},
        pendingQuestions: {},
      },
      [{ type: 'message.upserted', chatId: tab.id, message: timer }],
      { projectId: 'project', worktreeId: 'worktree' },
    ).chatState.tabs[0];
    expect(timed.pendingTurn).toBeUndefined();
    expect(
      presentedMessages(timed).filter((message) =>
        message.blocks.some((block) => block.type === 'turn_timer'),
      ),
    ).toHaveLength(1);
  },
);

it.each(['queued', 'preparing', 'custom-title'])(
  'retires the host-queued first send on its canonical cancellation (%s)',
  (timing) => {
    const initial = presented();
    const owned =
      timing === 'preparing'
        ? initial
        : handOffProvisionalFirstSendToQueue(initial, input.userMessageId);
    const tab: ChatTab = {
      ...owned,
      ...(timing === 'custom-title'
        ? { title: 'My title', customTitle: 'My title' }
        : {}),
      queuedMessages: [
        { text: input.text, origin: 'desktop', hostQueueEntryId: 'host-row' },
      ],
      pendingQueueMessages: [
        {
          userMessageId: input.userMessageId,
          previousHostIds: [],
          message: { text: input.text },
        },
      ],
    };
    const cancelled = applyCanonicalChanges(
      {
        chatState: { tabs: [tab], activeTabId: tab.id },
        archives: [],
        runtimeByChatId: {
          [tab.id]: { status: 'streaming', queuedMessageIds: ['host-row'] },
        },
        pendingQuestions: {},
      },
      [
        {
          type: 'runtime.patched',
          chatId: tab.id,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
        {
          type: 'message.removed',
          chatId: tab.id,
          messageId: input.userMessageId,
        },
      ],
      { projectId: 'project', worktreeId: 'worktree' },
    ).chatState.tabs[0];
    expect(cancelled.provisionalFirstSend).toBeUndefined();
    expect(cancelled.title).toBe(
      timing === 'custom-title' ? 'My title' : 'New Chat',
    );
    expect(cancelled.pendingQueueMessages?.length ?? 0).toBe(0);
    expect(cancelled.queuedMessages).toHaveLength(0);
    // A late successful queue callback must not resurrect cancelled ownership.
    expect(
      handOffProvisionalFirstSendToQueue(cancelled, input.userMessageId),
    ).toBe(cancelled);
  },
);

it('refuses an empty draft, a busy chat, and a chat with a queued row', () => {
  expect(
    presentProvisionalFirstSendOnTab(starter(), { ...input, text: '  ' }),
  ).toBeNull();
  expect(
    presentProvisionalFirstSendOnTab(starter({ status: 'streaming' }), input),
  ).toBeNull();
  expect(
    presentProvisionalFirstSendOnTab(
      starter({ queuedMessages: [{ text: 'queued' }] }),
      input,
    ),
  ).toBeNull();
});

it('keeps the owned question title over a placeholder canonical refresh', () => {
  const previous = presented();
  const refreshed = preserveRendererOnlyTabFields(
    previous,
    starter({ title: 'New Chat' }),
  );

  expect(refreshed.title).toBe('Why is the deck empty?');
  expect(refreshed.messages.map((message) => message.id)).toEqual([
    'msg-home-1',
  ]);
  expect(refreshed.pendingTurn?.userMessageId).toBe('msg-home-1');
  expect(refreshed.provisionalFirstSend?.userMessageId).toBe('msg-home-1');
});

it('lets a generated or user-assigned title win', () => {
  const previous = presented();

  expect(
    preserveRendererOnlyTabFields(
      previous,
      starter({ title: 'Deck debugging' }),
    ).title,
  ).toBe('Deck debugging');
  expect(
    preserveRendererOnlyTabFields(
      previous,
      starter({ title: 'New Chat', customTitle: 'My title' }),
    ).title,
  ).toBe('New Chat');
});

it('keeps the queued first send titled after the queue handoff', () => {
  const queued = handOffProvisionalFirstSendToQueue(
    presented(),
    input.userMessageId,
  );
  const refreshed = preserveRendererOnlyTabFields(
    queued,
    starter({ title: 'New Chat' }),
  );

  expect(queued.messages).toEqual([]);
  expect(queued.pendingTurn).toBeUndefined();
  expect(refreshed.title).toBe('Why is the deck empty?');
  expect(startingTurnUserMessageId(refreshed)).toBeUndefined();
});

it('restores the prior title on withdrawal only while the patch is owned', () => {
  expect(
    withdrawProvisionalFirstSendFromTab(presented(), input.userMessageId).title,
  ).toBe('New Chat');

  const renamed = { ...presented(), title: 'Renamed' };
  expect(
    withdrawProvisionalFirstSendFromTab(renamed, input.userMessageId).title,
  ).toBe('Renamed');
});

it('withdraws nothing for another submission', () => {
  const tab = presented();
  expect(withdrawProvisionalFirstSendFromTab(tab, 'msg-other')).toBe(tab);
});

it('never persists the unsent echo or its provisional title', () => {
  const persisted = toPersistedTab(presented());

  expect(persisted.messages).toEqual([]);
  expect(persisted.title).toBe('New Chat');
  expect(persisted).not.toHaveProperty('provisionalFirstSend');
});

it('shows the starting status until the send queues or the chat errors', () => {
  expect(startingTurnUserMessageId(presented())).toBe('msg-home-1');
  expect(
    startingTurnUserMessageId({ ...presented(), status: 'error' }),
  ).toBeUndefined();
  expect(startingTurnUserMessageId(starter())).toBeUndefined();
});

it('presents a send to a worktree still setting up as a sent, starting turn', () => {
  // Main holds the send until the setup finishes; the renderer shows it sent.
  const tab = presented();
  const view = toActiveTranscriptView(tab);
  expect(view.queuedMessages).toEqual([]);
  expect(view.startingTurnUserMessageId).toBe(input.userMessageId);
  expect(view.messages.map((message) => message.id)).toEqual([
    input.userMessageId,
    tab.pendingTurn?.timerMessage.id,
  ]);
});

describe('a canonical starting turn the renderer did not present', () => {
  const userMessage = {
    id: 'msg-held',
    role: 'user' as const,
    timestamp: 5_000,
    blocks: [{ type: 'text' as const, text: 'Fix the deck' }],
  };
  const runtime = {
    status: 'starting' as const,
    activeTurn: { userMessageId: 'msg-held', startedAt: 5_000 },
  };

  it('marks the held prompt starting and gives it a timer slot', () => {
    const tab = starter({ messages: [userMessage], status: 'streaming' });
    const view = toActiveTranscriptView(tab, runtime);
    expect(view.startingTurnUserMessageId).toBe('msg-held');
    expect(view.startingTurnPresentationKey).toBeUndefined();
    expect(view.messages.map((message) => message.id)).toEqual([
      'msg-held',
      'msg-held:starting-timer',
    ]);
    expect(view.messages[1]?.blocks).toEqual([
      { type: 'turn_timer', startedAt: 5_000, completedAt: null },
    ]);
    // The projection keeps its identity while nothing changes.
    expect(toActiveTranscriptView(tab, runtime).messages).toBe(view.messages);
  });

  it('adds no timer when the canonical turn already has one', () => {
    const timer = {
      id: 'timer-held',
      role: 'system' as const,
      timestamp: 5_000,
      blocks: [
        { type: 'turn_timer' as const, startedAt: 5_000, completedAt: null },
      ],
    };
    const tab = starter({ messages: [userMessage, timer] });
    const view = toActiveTranscriptView(tab, runtime);
    expect(view.messages.map((message) => message.id)).toEqual([
      'msg-held',
      'timer-held',
    ]);
    expect(view.startingTurnUserMessageId).toBe('msg-held');
  });

  it('is not starting once the turn streams or the chat errors', () => {
    const tab = starter({ messages: [userMessage] });
    expect(
      toActiveTranscriptView(tab, { ...runtime, status: 'streaming' })
        .startingTurnUserMessageId,
    ).toBeUndefined();
    expect(
      toActiveTranscriptView({ ...tab, status: 'error' }, runtime)
        .startingTurnUserMessageId,
    ).toBeUndefined();
  });

  it('renders one bubble when the provisional send is the held turn (D11)', () => {
    const tab = presented();
    const view = toActiveTranscriptView(tab, {
      status: 'starting',
      activeTurn: { userMessageId: input.userMessageId, startedAt: 1_200 },
    });
    expect(view.startingTurnUserMessageId).toBe(input.userMessageId);
    expect(view.startingTurnPresentationKey).toBe(input.userMessageId);
    expect(
      view.messages.filter((message) => message.id === input.userMessageId),
    ).toHaveLength(1);
    expect(
      view.messages.filter((message) =>
        message.blocks.some((block) => block.type === 'turn_timer'),
      ),
    ).toHaveLength(1);
  });
});

it('presents an attachment-only submission without inventing question text', () => {
  const tab = presentProvisionalFirstSendOnTab(starter(), {
    ...input,
    text: '',
    attachmentPaths: ['/attachments/diagram.png'],
  });
  expect(tab?.messages[0]?.attachmentPaths).toEqual([
    '/attachments/diagram.png',
  ]);
  expect(tab?.pendingTurn?.userMessageId).toBe(input.userMessageId);
  expect(tab?.title).toBe('New Chat');
});

it('keeps preparation idle with a submission guard instead of exposing Stop', () => {
  const view = toActiveComposerView(presented());
  expect(view.status).toBe('idle');
  expect(view).toHaveProperty('firstSendPreparing', true);
});

it('does not lock Home settings to a provider before the first send is adopted', () => {
  const tab = presented({ providerType: 'claude', executionHarness: 'claude' });
  expect(getLockedProvider(tab)).toBeUndefined();
  expect(getLockedHarness(tab)).toBeUndefined();
  const record = tab.provisionalFirstSend;
  if (!record) throw new Error('Expected first-send ownership');
  expect(
    getLockedHarness({
      ...tab,
      provisionalFirstSend: { ...record, phase: 'dispatched' },
    }),
  ).toBe('claude');
  expect(getLockedHarness({ ...tab, pendingUserMessages: undefined })).toBe(
    'claude',
  );
});

it('never persists a queued provisional title override', () => {
  const queued = handOffProvisionalFirstSendToQueue(
    presented(),
    input.userMessageId,
  );
  expect(toPersistedTab(queued).title).toBe('New Chat');
});

it('does not roll a canonical acknowledgement title back on a late withdrawal', () => {
  const tab = presented();
  const acknowledged = preserveRendererOnlyTabFields(tab, {
    ...starter(),
    messages: tab.messages,
  });
  const withdrawn = withdrawProvisionalFirstSendFromTab(
    acknowledged,
    input.userMessageId,
  );
  expect(withdrawn.messages).toEqual(tab.messages);
  expect(withdrawn.title).toBe(input.text);
});

it('retains the submission time when a canonical timer replaces the bridge', () => {
  const previous = presented();
  const next = preserveRendererOnlyTabFields(previous, {
    ...starter(),
    messages: [
      ...previous.messages,
      {
        id: 'canonical-timer',
        role: 'system',
        timestamp: 5000,
        blocks: [{ type: 'turn_timer', startedAt: 5000, completedAt: null }],
      },
    ],
  });
  expect(next.pendingTurn).toBeUndefined();
  expect(
    presentedMessages(next).find((message) => message.id === 'canonical-timer')
      ?.blocks[0],
  ).toMatchObject({ startedAt: input.submittedAt });
  expect(
    next.messages.find((message) => message.id === 'canonical-timer')
      ?.blocks[0],
  ).toMatchObject({ startedAt: 5000 });
});

describe('a first send whose model was refused (CAN-5021)', () => {
  const failure = {
    failureId: 'failure-1',
    model: 'claude-sonnet-4-6',
    message:
      'Sonnet 4.6 couldn’t be used to start this chat. Choose another model.',
  };

  function failed(): ChatTab {
    return failProvisionalFirstSendOnTab(
      presented(),
      input.userMessageId,
      input.userMessageId,
      failure,
    );
  }

  it('keeps the prompt and title, ends the starting turn, and projects the failure', () => {
    const tab = failed();

    expect(tab.provisionalFirstSend?.phase).toBe('failed');
    expect(tab.messages.map((message) => message.id)).toEqual([
      input.userMessageId,
    ]);
    expect(tab.title).toBe(input.text);
    expect(tab.pendingTurn).toBeUndefined();
    expect(startingTurnUserMessageId(tab)).toBeUndefined();
    const view = toActiveTranscriptView(tab);
    expect(toActiveComposerView(tab).failedFirstSend).toEqual({
      userMessageId: input.userMessageId,
      failureId: failure.failureId,
      message: failure.message,
    });
    expect(view.startingTurnUserMessageId).toBeUndefined();
    expect(view.messages.map((message) => message.id)).toEqual([
      input.userMessageId,
    ]);
  });

  it('keeps the unsent prompt out of the persisted transcript and keeps the model picker unlocked', () => {
    const tab = failed();

    const persisted = toPersistedTab(tab);
    expect(persisted.messages).toEqual([]);
    expect(persisted.title).toBe('New Chat');
    expect(getLockedProvider(tab)).toBeUndefined();
  });

  it('allows drafting a deliberate replacement without leaving the old recovery actionable', () => {
    const tab = failed();
    expect(toActiveComposerView(tab).firstSendPreparing).toBe(false);
  });

  it('holds admission so a separate composer send cannot start beside it', () => {
    expect(isProvisionalFirstSendAdmissionPending(failed())).toBe(true);
  });

  it('never fails a dispatched, claimed, or replaced attempt', () => {
    const tab = presented();
    const record = tab.provisionalFirstSend;
    if (!record) throw new Error('expected a presented first send');
    const dispatched: ChatTab = {
      ...tab,
      provisionalFirstSend: { ...record, phase: 'dispatched' },
    };
    const claimed: ChatTab = {
      ...tab,
      provisionalFirstSend: { ...record, dispatchClaimed: true },
    };

    for (const candidate of [dispatched, claimed]) {
      expect(
        failProvisionalFirstSendOnTab(
          candidate,
          input.userMessageId,
          input.userMessageId,
          failure,
        ),
      ).toBe(candidate);
    }
    expect(
      failProvisionalFirstSendOnTab(
        tab,
        input.userMessageId,
        'an-earlier-attempt',
        failure,
      ),
    ).toBe(tab);
  });

  it('a withdrawal for an unrelated failure leaves the failed prompt in place', () => {
    const tab = failed();

    expect(withdrawProvisionalFirstSendFromTab(tab, input.userMessageId)).toBe(
      tab,
    );
  });

  it('claims one retry in place under a new attempt, with the same message', () => {
    const tab = failed();

    const retrying = retryFailedProvisionalFirstSendOnTab(
      tab,
      input.userMessageId,
      failure.failureId,
      'attempt-2',
    );

    expect(retrying.provisionalFirstSend).toMatchObject({
      phase: 'preparing',
      attemptId: 'attempt-2',
      userMessageId: input.userMessageId,
      submittedAt: input.submittedAt,
    });
    expect(retrying.provisionalFirstSend?.failure).toBeUndefined();
    expect(retrying.messages).toBe(tab.messages);
    expect(startingTurnUserMessageId(retrying)).toBe(input.userMessageId);
    // The failure is consumed: a second press claims nothing.
    expect(
      retryFailedProvisionalFirstSendOnTab(
        retrying,
        input.userMessageId,
        failure.failureId,
        'attempt-3',
      ),
    ).toBe(retrying);
    // Only the current attempt can fail again.
    expect(
      failProvisionalFirstSendOnTab(
        retrying,
        input.userMessageId,
        input.userMessageId,
        failure,
      ),
    ).toBe(retrying);
    expect(
      failProvisionalFirstSendOnTab(
        retrying,
        input.userMessageId,
        'attempt-2',
        { ...failure, failureId: 'failure-2' },
      ).provisionalFirstSend?.failure?.failureId,
    ).toBe('failure-2');
  });
});
