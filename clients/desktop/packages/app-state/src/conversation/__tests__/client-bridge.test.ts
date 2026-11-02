import type {
  ConversationPresentation,
  ConversationPresentationRow,
  ConversationProjectedMessage,
} from '@canopy/app-core/conversation';
import {
  createConversationHostClientBridge,
  type ConversationHostBridgeTarget,
} from '../client-bridge';

interface Recorded {
  readonly messages: unknown[];
  readonly starts: Array<{
    chatId: string;
    userMessageId: string;
    canonicalUserMessageId: string;
    startedAtMs?: number;
    hostOwnsTimer?: boolean;
  }>;
  readonly settles: Array<{ chatId: string; status: 'complete' | 'failed' }>;
  readonly resets: string[];
}

function target(): ConversationHostBridgeTarget & Recorded {
  const messages: unknown[] = [];
  const starts: Recorded['starts'] = [];
  const settles: Recorded['settles'] = [];
  const resets: string[] = [];
  return {
    messages,
    starts,
    settles,
    resets,
    emitChatMessage(payload): void {
      messages.push(payload);
    },
    startTurn(
      chatId,
      userMessageId,
      canonicalUserMessageId,
      startedAtMs,
      hostOwnsTimer,
    ): void {
      starts.push({
        chatId,
        userMessageId,
        canonicalUserMessageId,
        ...(startedAtMs === undefined ? {} : { startedAtMs }),
        ...(hostOwnsTimer === undefined ? {} : { hostOwnsTimer }),
      });
    },
    settleTurn(chatId, status): void {
      settles.push({ chatId, status });
    },
    resetStream(chatId): void {
      resets.push(chatId);
    },
  };
}

function projected(
  id: string,
  role: ConversationProjectedMessage['role'],
  content: string,
): ConversationProjectedMessage {
  return {
    scope: 'worktree',
    localChatId: 'cloud:chat-1',
    localMessageId: id,
    canonicalMessageId: id.startsWith('optimistic:') ? 'core-user' : id,
    clientRequestId: role === 'user' ? 'request-1' : undefined,
    workspaceLocalId: 'cloud:workspace-1',
    worktreeLocalId: 'cloud:worktree-1',
    role,
    status: 'complete',
    content,
    presentationOrder: role === 'user' ? 0 : role === 'assistant' ? 1 : 2,
    occurredAt: '2026-09-16T10:00:00.000Z',
    turnId: 'turn-1',
  };
}

function row(
  message: ConversationProjectedMessage,
): ConversationPresentationRow {
  return {
    canonical: { id: message.canonicalMessageId },
    projected: [message],
  };
}

function view(
  transcript: readonly ConversationPresentationRow[],
  running = true,
): ConversationPresentation {
  return {
    hostStatus: 'ready',
    binding: {
      accountKey: 'account-1',
      authGeneration: 'auth-1',
      localChatId: 'cloud:chat-1',
      externalChatId: 'chat-1',
      workspaceLocalId: 'cloud:workspace-1',
      worktreeLocalId: 'cloud:worktree-1',
    },
    sessionStatus: running ? 'RUNNING' : 'COMPLETED',
    transcript,
    activeExecution: running
      ? {
          turnId: 'turn-1',
          userMessageId: 'core-user',
          startedAtMs: 1_758_023_100_000,
        }
      : null,
  };
}

describe('conversation host client bridge', () => {
  test('passes projected system messages through and marks the host-owned timer', () => {
    const recorded = target();
    const bridge = createConversationHostClientBridge(recorded);
    const user = row(projected('optimistic:user-1', 'user', 'hello'));
    const timer = row({
      ...projected('optimistic:user-1:turn-timer', 'system', ''),
      parts: [
        {
          kind: 'turn_timer',
          data: {
            startedAt: 1_758_023_100_000,
            completedAt: null,
            pausedAt: null,
            resumedAt: null,
            accumulatedPausedDurationMs: 0,
          },
        },
      ],
      status: 'streaming',
    });

    bridge.apply(view([user, timer]));

    expect(recorded.messages.at(-1)).toMatchObject({
      message: { role: 'system', status: 'streaming' },
    });
    expect(recorded.starts).toEqual([
      expect.objectContaining({ hostOwnsTimer: true }),
    ]);
  });

  test('emits canonical deltas and mirrors canonical turn liveness', () => {
    const recorded = target();
    const bridge = createConversationHostClientBridge(recorded);
    const user = row(projected('optimistic:user-1', 'user', 'hello'));
    const assistant = row(projected('assistant-1', 'assistant', 'working'));
    const first = view([user, assistant]);

    bridge.apply(first);
    bridge.apply(first);

    expect(recorded.messages).toHaveLength(2);
    // The canonical id lets the target match the receipt's Auto pick.
    expect(recorded.starts).toEqual([
      {
        chatId: 'cloud:chat-1',
        userMessageId: 'optimistic:user-1',
        canonicalUserMessageId: 'core-user',
        startedAtMs: 1_758_023_100_000,
        hostOwnsTimer: true,
      },
    ]);
    expect(recorded.settles).toEqual([]);

    const assistantProjection = assistant.projected[0];
    if (assistantProjection === undefined) {
      throw new Error('Expected an assistant projection');
    }
    const updated = view([
      user,
      row({
        ...assistantProjection,
        content: 'done',
      }),
    ]);
    bridge.apply(updated);
    const activeExecution = updated.activeExecution;
    if (activeExecution === null) throw new Error('Expected an active turn');
    bridge.apply({
      ...updated,
      activeExecution: {
        ...activeExecution,
        turnId: 'turn-2',
        userMessageId: 'core-user-2',
      },
    });
    bridge.apply(view(updated.transcript, false));

    expect(recorded.messages).toHaveLength(3);
    expect(recorded.starts).toEqual([
      {
        chatId: 'cloud:chat-1',
        userMessageId: 'optimistic:user-1',
        canonicalUserMessageId: 'core-user',
        startedAtMs: 1_758_023_100_000,
        hostOwnsTimer: true,
      },
      {
        chatId: 'cloud:chat-1',
        userMessageId: 'core-user-2',
        canonicalUserMessageId: 'core-user-2',
        startedAtMs: 1_758_023_100_000,
        hostOwnsTimer: true,
      },
    ]);
    expect(recorded.settles).toEqual([
      { chatId: 'cloud:chat-1', status: 'complete' },
      { chatId: 'cloud:chat-1', status: 'complete' },
    ]);
  });

  test('a rebuilt bridge replays the current view once without stale timers', () => {
    const current = view(
      [row(projected('assistant-1', 'assistant', 'done'))],
      false,
    );
    const firstTarget = target();
    const first = createConversationHostClientBridge(firstTarget);
    first.apply(current);
    first.apply(current);
    const replacementTarget = target();
    const replacement = createConversationHostClientBridge(replacementTarget);
    replacement.apply(current);
    replacement.apply(current);

    expect(firstTarget.messages).toHaveLength(1);
    expect(replacementTarget.messages).toHaveLength(1);
    expect(firstTarget.starts).toHaveLength(0);
    expect(replacementTarget.starts).toHaveLength(0);
    expect(replacementTarget.settles).toHaveLength(0);
  });

  test('a rebuilt bridge reopens a running turn with the same canonical start', () => {
    const current = view([
      row(projected('optimistic:user-1', 'user', 'hello')),
    ]);
    const firstTarget = target();
    createConversationHostClientBridge(firstTarget).apply(current);
    const replacementTarget = target();
    createConversationHostClientBridge(replacementTarget).apply(current);

    expect(firstTarget.starts).toEqual(replacementTarget.starts);
    expect(replacementTarget.starts).toEqual([
      {
        chatId: 'cloud:chat-1',
        userMessageId: 'optimistic:user-1',
        canonicalUserMessageId: 'core-user',
        startedAtMs: 1_758_023_100_000,
        hostOwnsTimer: true,
      },
    ]);
  });

  test('attributes unattributed user messages to the shared-chat owner', () => {
    const recorded = target();
    const bridge = createConversationHostClientBridge(recorded, {
      fallbackUserAuthor: {
        userId: 'owner',
        name: 'Owner User',
        image: 'https://example.com/owner.png',
      },
    });

    bridge.apply(
      view([row(projected('optimistic:user-1', 'user', 'owner prompt'))]),
    );

    expect(recorded.messages[0]).toMatchObject({
      message: {
        clientRequestId: 'request-1',
        author: {
          userId: 'owner',
          name: 'Owner User',
          image: 'https://example.com/owner.png',
        },
      },
    });
  });

  test('keeps an explicit turn author instead of the shared-chat fallback', () => {
    const recorded = target();
    const bridge = createConversationHostClientBridge(recorded, {
      fallbackUserAuthor: { userId: 'owner', name: 'Owner User' },
    });
    const message = projected('optimistic:user-1', 'user', 'teammate prompt');

    bridge.apply(
      view([
        row({
          ...message,
          author: { userId: 'teammate', name: 'Teammate User' },
        }),
      ]),
    );

    expect(recorded.messages[0]).toMatchObject({
      message: {
        author: { userId: 'teammate', name: 'Teammate User' },
      },
    });
  });

  test('discards an active local timer on reset without reporting completion', () => {
    const recorded = target();
    const bridge = createConversationHostClientBridge(recorded);
    bridge.apply(view([row(projected('assistant-1', 'assistant', 'working'))]));

    bridge.reset();

    expect(recorded.resets).toEqual(['cloud:chat-1']);
    expect(recorded.settles).toEqual([]);
  });

  test.each(['revoked', 'error'] as const)(
    'resets active streaming when the host becomes %s',
    (hostStatus) => {
      const recorded = target();
      const bridge = createConversationHostClientBridge(recorded);
      const active = view([
        row(projected('assistant-1', 'assistant', 'working')),
      ]);
      bridge.apply(active);

      bridge.apply({ ...active, hostStatus });

      expect(recorded.resets).toEqual(['cloud:chat-1']);
      expect(recorded.starts).toHaveLength(1);
    },
  );

  test('requests hydration replacement when a canonical projected row disappears', () => {
    const recorded = target();
    const onTranscriptReplaced = jest.fn();
    const bridge = createConversationHostClientBridge(recorded, {
      onTranscriptReplaced,
    });
    const user = row(projected('optimistic:user-1', 'user', 'hello'));
    const assistant = row(projected('assistant-1', 'assistant', 'working'));
    bridge.apply(view([user, assistant]));

    bridge.apply(view([user]));

    expect(onTranscriptReplaced).toHaveBeenCalledWith('cloud:chat-1');
  });

  test('emits a queued user once when its turn starts without replacing the transcript', () => {
    const recorded = target();
    const onTranscriptReplaced = jest.fn();
    const bridge = createConversationHostClientBridge(recorded, {
      onTranscriptReplaced,
    });
    const user = row(projected('optimistic:user-1', 'user', 'hello'));
    const queued = view([], false);

    bridge.apply(queued);
    bridge.apply(view([user]));
    bridge.apply(view([user]));

    expect(recorded.messages).toHaveLength(1);
    expect(recorded.messages[0]).toMatchObject({
      message: { presentationOrder: 0 },
    });
    expect(recorded.starts).toEqual([
      {
        chatId: 'cloud:chat-1',
        userMessageId: 'optimistic:user-1',
        canonicalUserMessageId: 'core-user',
        startedAtMs: 1_758_023_100_000,
        hostOwnsTimer: true,
      },
    ]);
    expect(onTranscriptReplaced).not.toHaveBeenCalled();
  });
});
