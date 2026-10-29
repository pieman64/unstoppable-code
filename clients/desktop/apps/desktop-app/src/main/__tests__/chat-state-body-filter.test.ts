import type {
  ChatInterestDeclaration,
  ChatStateChange,
  ChatStateChangedEvent,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { filterChatStateBodies } from '../ipc/chat-state-body-filter';

const focused = { projectId: 'p', worktreeId: 'w', chatId: 'focused' };
const warm = { ...focused, chatId: 'warm' };
const interest: ChatInterestDeclaration = {
  focused: [focused],
  warm: [warm],
  acceptsMessagesOmitted: true,
};

function upsert(
  chatId: string,
  role: PersistedChatMessage['role'] = 'assistant',
): ChatStateChange {
  return {
    type: 'message.upserted',
    chatId,
    message: { id: `${chatId}-${role}`, role, blocks: [], timestamp: 1 },
  };
}

function event(changes: ChatStateChange[]): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: 'commit-9',
    occurredAt: '2026-10-13T00:00:00.000Z',
    projectId: 'p',
    worktreeId: 'w',
    baseRevision: 8,
    revision: 9,
    changes,
  };
}

const retained: ChatStateChange[] = [
  upsert('background', 'user'),
  { type: 'message.removed', chatId: 'background', messageId: 'cancelled' },
  {
    type: 'transcript.updated',
    chatId: 'background',
    reset: true,
    transcript: {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 10,
      transcriptRevision: 9,
      hasActiveSidecar: false,
      messageCount: 1,
    },
  },
  {
    type: 'runtime.patched',
    chatId: 'background',
    runtime: { status: 'queued', queuedMessageIds: ['queued'] },
  },
  {
    type: 'tab.upserted',
    tab: {
      id: 'background',
      title: 'Background',
      messages: [],
      createdAt: '2026-10-13T00:00:00.000Z',
    },
  },
  { type: 'tab.removed', tabId: 'background' },
  {
    type: 'tab.metadata_patched',
    tabId: 'background',
    patch: { title: 'New title' },
  },
  { type: 'tab.order_changed', tabIds: ['background'] },
  { type: 'tab.active_changed', activeTabId: 'background' },
  {
    type: 'pending_question.upserted',
    question: { chatId: 'background', requestId: 'q', questions: [] },
  },
  { type: 'pending_question.removed', chatId: 'background', requestId: 'q' },
  {
    type: 'archive.upserted',
    archive: {
      chatId: 'background',
      title: 'Archived',
      turnCount: 1,
      archivedAt: '2026-10-13',
      createdAt: '2026-10-13',
      restorable: true,
      unread: true,
    },
  },
  { type: 'archive.removed', archiveEntryId: 'archive', chatId: 'background' },
  {
    type: 'archive.read_state_changed',
    archiveEntryId: 'archive',
    chatId: 'background',
    unread: false,
  },
];

describe('filterChatStateBodies', () => {
  it('delivers every body to a window that declared interest without the marker capability', () => {
    // A remote controller on a build from before `messages.omitted`.
    const olderBuild: ChatInterestDeclaration = {
      focused: [focused],
      warm: [warm],
    };
    const committed: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'older-build',
      occurredAt: '2026-10-15T00:00:00.000Z',
      projectId: 'p',
      worktreeId: 'w',
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: 'messages.replaced',
          chatId: 'background',
          messages: [],
          removedMessageIds: [],
        },
      ],
    };
    expect(filterChatStateBodies(olderBuild, committed)).toBe(committed);
  });

  it('fails open with the same object without a declaration', () => {
    const committed = event([upsert('background')]);
    expect(filterChatStateBodies(undefined, committed)).toBe(committed);
  });

  it.each(['focused', 'warm'])(
    'keeps %s bodies with the same object',
    (chatId) => {
      const committed = event([
        upsert(chatId),
        {
          type: 'messages.replaced',
          chatId,
          messages: [],
          removedMessageIds: [],
        },
      ]);
      expect(filterChatStateBodies(interest, committed)).toBe(committed);
    },
  );

  it.each(['assistant', 'system'] satisfies PersistedChatMessage['role'][])(
    'omits background %s bodies',
    (role) => {
      expect(
        filterChatStateBodies(interest, event([upsert('background', role)]))
          .changes,
      ).toEqual([{ type: 'messages.omitted', chatId: 'background' }]);
    },
  );

  it('omits background tool-result rows', () => {
    const committed = event([
      {
        type: 'message.upserted',
        chatId: 'background',
        message: {
          id: 'tool-result',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 'tool',
              toolName: 'Read',
              output: 'body',
              isError: false,
            },
          ],
        },
      },
    ]);
    expect(filterChatStateBodies(interest, committed).changes).toEqual([
      { type: 'messages.omitted', chatId: 'background' },
    ]);
  });

  it.each(retained.map((change) => [change.type, change] as const))(
    'keeps %s unchanged off screen',
    (_type, change) => {
      const committed = event([change]);
      expect(filterChatStateBodies(interest, committed)).toBe(committed);
    },
  );

  it('keeps metadata and user rows, appends one marker per affected chat, and preserves the revision envelope', () => {
    const committed = event([
      upsert('cold-a'),
      ...retained,
      upsert('focused'),
      upsert('cold-a', 'system'),
      {
        type: 'messages.replaced',
        chatId: 'cold-b',
        messages: [],
        removedMessageIds: ['old'],
      },
      upsert('cold-b', 'assistant'),
    ]);
    const originalChanges = [...committed.changes];
    expect(filterChatStateBodies(interest, committed)).toEqual({
      ...committed,
      changes: [
        ...retained,
        upsert('focused'),
        { type: 'messages.omitted', chatId: 'cold-a' },
        { type: 'messages.omitted', chatId: 'cold-b' },
      ],
    });
    expect(committed.changes).toEqual(originalChanges);
  });

  it.each([
    { projectId: 'other', worktreeId: 'w' },
    { projectId: 'p', worktreeId: 'other' },
  ])('matches the full scope, not just chat id: %j', (scope) => {
    const committed = { ...event([upsert('focused')]), ...scope };
    expect(filterChatStateBodies(interest, committed).changes).toEqual([
      { type: 'messages.omitted', chatId: 'focused' },
    ]);
  });

  it('returns the same empty event and replaces declaration identity independently', () => {
    const empty = event([]);
    expect(filterChatStateBodies(interest, empty)).toBe(empty);
    const committed = event([upsert('focused')]);
    expect(
      filterChatStateBodies(
        { focused: [], warm: [], acceptsMessagesOmitted: true },
        committed,
      ).changes,
    ).toEqual([{ type: 'messages.omitted', chatId: 'focused' }]);
    expect(filterChatStateBodies(interest, committed)).toBe(committed);
  });
});
