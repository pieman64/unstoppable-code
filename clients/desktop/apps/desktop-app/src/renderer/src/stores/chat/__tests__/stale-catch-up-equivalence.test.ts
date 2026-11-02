/** @jest-environment jsdom */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ChatStateChange,
  ChatStateChangedEvent,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import {
  computeTurnSummary,
  groupIntoTurns,
  type TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';
import { deriveCurrentTodosFromMessages } from '@/lib/transcript-parser';
import { useChatStore } from '../../chatStore';
import { registerChatStoreApi } from '../store-ref';
import { fromPersistedTab } from '../persisted-tabs';
import { applyCanonicalChanges } from '../canonical-changes';
import {
  catchUpStaleChat,
  recordStaleChatCatchUpChanges,
} from '../stale-catch-up';
import { presentedMessages } from '../optimistic-presentation';
import type { ChatState } from '../state';

const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
const message = (
  id: string,
  role: PersistedChatMessage['role'],
  text: string,
): PersistedChatMessage => ({
  id,
  role,
  timestamp: 1,
  blocks: [{ type: 'text', text }],
});

function toTurnMessages(rows: readonly PersistedChatMessage[]): TurnMessage[] {
  type PersistedToolUse = Extract<
    PersistedChatMessage['blocks'][number],
    { type: 'tool_use' }
  >;
  type PersistedToolResult = Extract<
    PersistedChatMessage['blocks'][number],
    { type: 'tool_result' }
  >;

  const toolUses = new Map<string, PersistedToolUse>();
  const toolResults = new Map<string, PersistedToolResult>();
  for (const row of rows) {
    for (const block of row.blocks) {
      if (block.type === 'tool_use') toolUses.set(block.toolUseId, block);
      if (block.type === 'tool_result') toolResults.set(block.toolUseId, block);
    }
  }
  for (const result of toolResults.values()) {
    const toolUse = toolUses.get(result.toolUseId);
    if (!toolUse || toolUse.toolName !== result.toolName)
      throw new Error(
        `Cannot project tool_result for unmatched tool use ${result.toolUseId}`,
      );
  }

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    timestamp: row.timestamp,
    blocks: row.blocks.flatMap((block): TurnMessage['blocks'] => {
      switch (block.type) {
        case 'text':
          return [block];
        case 'tool_use': {
          const result = toolResults.get(block.toolUseId);
          return result ? [{ ...block, result: { ...result } }] : [block];
        }
        case 'tool_result':
          // Results live on their matching TurnBlock tool_use, not as rows.
          return [];
        case 'turn_timer':
          return [block];
        default:
          throw new Error(
            `Unsupported persisted chat block type: ${block.type}`,
          );
      }
    }),
  }));
}
const user = message('user', 'user', 'Do the work');
const timer: PersistedChatMessage = {
  id: 'timer',
  role: 'system',
  timestamp: 2,
  blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: 100 }],
};
const tools: PersistedChatMessage = {
  id: 'tools',
  role: 'assistant',
  timestamp: 3,
  blocks: [
    {
      type: 'tool_use',
      toolUseId: 'read',
      toolName: 'Read',
      input: JSON.stringify({ file_path: 'src/file.ts' }),
    },
    {
      type: 'tool_use',
      toolUseId: 'todo',
      toolName: 'TodoWrite',
      input: JSON.stringify({
        todos: [{ content: 'Verify catch-up', status: 'completed' }],
      }),
    },
  ],
};
const result: PersistedChatMessage = {
  id: 'result',
  role: 'user',
  timestamp: 4,
  blocks: [
    {
      type: 'tool_result',
      toolUseId: 'read',
      toolName: 'Read',
      output: 'file contents',
      isError: false,
    },
    {
      type: 'tool_result',
      toolUseId: 'todo',
      toolName: 'TodoWrite',
      output: 'updated',
      isError: false,
    },
  ],
};
const final = message('answer', 'assistant', 'Work complete');
const finalRows = [user, timer, tools, result, final];

/** Exactly main's declared-background transform: user upserts and removals
 * survive, non-user upserts/replacements become one trailing marker per chat. */
function filter(event: ChatStateChangedEvent): ChatStateChangedEvent {
  const omitted = new Set<string>();
  const changes = event.changes.filter((change) => {
    if (
      (change.type === 'message.upserted' && change.message.role !== 'user') ||
      change.type === 'messages.replaced'
    ) {
      omitted.add(change.chatId);
      return false;
    }
    return true;
  });
  for (const chatId of Array.from(omitted))
    changes.push({ type: 'messages.omitted', chatId });
  return { ...event, changes };
}

function event(
  revision: number,
  changes: ChatStateChange[],
  rows: PersistedChatMessage[],
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    occurredAt: '2026-10-15',
    ...target,
    baseRevision: revision - 1,
    revision,
    changes: [
      ...changes,
      {
        type: 'transcript.updated',
        chatId: 'chat',
        transcript: {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: rows.length,
          committedByteLength: 100,
          transcriptRevision: revision,
          hasActiveSidecar: false,
          todos: deriveCurrentTodosFromMessages(rows),
        },
        reset: false,
      },
    ],
  };
}

function store(): UseBoundStore<StoreApi<ChatState>> {
  return create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': {
        activeTabId: 'chat',
        tabs: [
          fromPersistedTab({
            id: 'chat',
            title: 'Chat',
            createdAt: 'now',
            messages: [],
          }),
        ],
      },
    },
    chatStateSync: { 'p/w': { phase: 'live', revision: 0 } },
  }));
}

function apply(
  storeApi: ReturnType<typeof store>,
  event: ChatStateChangedEvent,
): void {
  storeApi.setState((state) => {
    const next = applyCanonicalChanges(
      {
        chatState: state.worktreeChats['p/w'],
        runtimeByChatId: state.runtimeByChatId,
        archives: [],
        pendingQuestions: {},
      },
      event.changes,
      target,
    );
    recordStaleChatCatchUpChanges(event);
    return {
      worktreeChats: { 'p/w': next.chatState },
      runtimeByChatId: next.runtimeByChatId,
    };
  });
}

const newestPage: TranscriptPage = {
  view: 'turns',
  messages: finalRows,
  transcriptRevision: 7,
  totalMessages: finalRows.length,
  messageOrdinals: Object.fromEntries(
    finalRows.map((row, index) => [row.id, index]),
  ),
  turns: [
    {
      id: user.id,
      start: 0,
      end: finalRows.length,
      complete: true,
      summary: computeTurnSummary(toTurnMessages(finalRows)),
      finalMessageIds: [final.id],
    },
  ],
};

afterEach(() => registerChatStoreApi(useChatStore));

it('filtered delivery plus catch-up equals full delivery: ordered rows, pairing, TODOs, and turn frames after rewind and removal', async () => {
  const reference = store();
  const background = store();
  const discarded = message('discarded', 'assistant', 'This branch is rewound');
  const removed = message('removed', 'assistant', 'Remove this row');
  const events = [
    event(
      1,
      [{ type: 'message.upserted', chatId: 'chat', message: user }],
      [user],
    ),
    event(
      2,
      [{ type: 'message.upserted', chatId: 'chat', message: discarded }],
      [user, discarded],
    ),
    event(
      3,
      [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [user, timer],
          removedMessageIds: ['discarded'],
        },
      ],
      [user, timer],
    ),
    event(
      4,
      [{ type: 'message.upserted', chatId: 'chat', message: tools }],
      [user, timer, tools],
    ),
    event(
      5,
      [{ type: 'message.upserted', chatId: 'chat', message: result }],
      [user, timer, tools, result],
    ),
    event(
      6,
      [{ type: 'message.upserted', chatId: 'chat', message: removed }],
      [user, timer, tools, result, removed],
    ),
    event(
      7,
      [
        { type: 'message.removed', chatId: 'chat', messageId: removed.id },
        { type: 'message.upserted', chatId: 'chat', message: final },
      ],
      finalRows,
    ),
  ];
  for (const committed of events) {
    apply(reference, committed);
    apply(background, filter(committed));
  }
  expect(
    background.getState().worktreeChats['p/w'].tabs[0].transcriptStale,
  ).toBe(true);
  const getTranscriptPage = jest.fn(() => Promise.resolve(newestPage));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage } },
  });
  registerChatStoreApi(background);
  await catchUpStaleChat(target, () => Promise.resolve());
  const expected = reference.getState().worktreeChats['p/w'].tabs[0];
  const actual = background.getState().worktreeChats['p/w'].tabs[0];
  expect(actual.messages).toEqual(expected.messages);
  expect(actual.messages.map((row) => row.id)).toEqual(
    finalRows.map((row) => row.id),
  );
  expect(actual.currentTodos).toEqual(expected.currentTodos);
  expect(actual.currentTodos).toHaveLength(1);
  expect(groupIntoTurns(toTurnMessages(presentedMessages(actual)))).toEqual(
    groupIntoTurns(toTurnMessages(presentedMessages(expected))),
  );
  expect(actual.transcriptWindow?.turns).toEqual(newestPage.turns);
  const uses = actual.messages.flatMap((row) =>
    row.blocks.flatMap((block) =>
      block.type === 'tool_use' ? [block.toolUseId] : [],
    ),
  );
  const results = actual.messages.flatMap((row) =>
    row.blocks.flatMap((block) =>
      block.type === 'tool_result' ? [block.toolUseId] : [],
    ),
  );
  expect(uses).toEqual(['read', 'todo']);
  expect(results).toEqual(uses);
  expect(actual.transcriptStale).toBeUndefined();
  expect(getTranscriptPage).toHaveBeenCalledTimes(1);
});

it('background queue cancellation leaves neither a sent nor pending ghost row', () => {
  const background = store();
  const queued = message('queued-user', 'user', 'Cancel me');
  background.setState((state) => ({
    worktreeChats: {
      'p/w': {
        ...state.worktreeChats['p/w'],
        tabs: [
          {
            ...state.worktreeChats['p/w'].tabs[0],
            pendingUserMessages: [queued],
            queuedMessages: [
              {
                text: 'Cancel me',
                origin: 'desktop',
                hostQueueEntryId: 'queue-entry',
              },
            ],
          },
        ],
      },
    },
    runtimeByChatId: {
      chat: { status: 'queued', queuedMessageIds: ['queue-entry'] },
    },
  }));
  apply(
    background,
    filter(
      event(
        1,
        [{ type: 'message.upserted', chatId: 'chat', message: queued }],
        [queued],
      ),
    ),
  );
  apply(
    background,
    filter(
      event(
        2,
        [
          { type: 'message.removed', chatId: 'chat', messageId: queued.id },
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'idle', queuedMessageIds: [] },
          },
        ],
        [],
      ),
    ),
  );
  const tab = background.getState().worktreeChats['p/w'].tabs[0];
  expect(presentedMessages(tab)).toEqual([]);
  expect(tab.pendingUserMessages).toBeUndefined();
  expect(tab.pendingQueueMessages).toBeUndefined();
  expect(tab.queuedMessages).toEqual([]);
});
