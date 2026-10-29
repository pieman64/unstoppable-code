// Phase 12: committed message changes use main's TODOs from
// `transcript.updated` instead of re-deriving them over every loaded message.
// The projected tab must be identical to the previous behavior (derive, then
// overwrite with main's values), and main's fold must equal the renderer
// derivation on a fully loaded transcript.
import { foldTranscriptTodoState } from '@canopy/agent-transcript';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import type {
  ChatStateChange,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import {
  deriveCurrentTaskTodosFromMessages,
  deriveCurrentTodosFromMessages,
} from '@/lib/transcript-parser';
import {
  applyCanonicalChanges,
  type CanonicalScopeProjection,
} from '../canonical-changes';
import { fromPersistedTab } from '../persisted-tabs';

beforeAll(() => {
  initClaudeModels([
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
  ]);
});

const ctx = { projectId: 'proj', worktreeId: 'wt' };

function todoWrite(id: string, items: string[]): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        toolUseId: `todo-${id}`,
        toolName: 'TodoWrite',
        input: JSON.stringify({
          todos: items.map((content, index) => ({
            content,
            status: index === 0 ? 'in_progress' : 'pending',
            activeForm: content,
          })),
        }),
      },
    ],
    timestamp: 2,
  };
}

function taskCreate(id: string, subject: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        toolUseId: `task-${id}`,
        toolName: 'TaskCreate',
        input: JSON.stringify({ subject, description: subject }),
      },
    ],
    timestamp: 3,
  };
}

const history: PersistedChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text: 'plan it' }],
    timestamp: 1,
  },
  todoWrite('t1', ['first', 'second']),
  taskCreate('k1', 'task one'),
];

/** Main's descriptor TODOs: the same fold `ChatTranscriptLog` keeps. */
function descriptorFor(
  messages: PersistedChatMessage[],
  revision: number,
): TranscriptDescriptor {
  const folded = messages.reduce(foldTranscriptTodoState, {});
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: messages.length,
    committedByteLength: 1,
    transcriptRevision: revision,
    hasActiveSidecar: false,
    messageCount: messages.length,
    todos: folded.todos,
    taskTodos: folded.taskTodos,
  };
}

function projection(): CanonicalScopeProjection {
  const persisted: PersistedChatTab = {
    id: 'chat',
    title: 'Chat',
    messages: history,
    createdAt: '2026-10-01T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
    transcript: descriptorFor(history, 1),
  };
  return {
    chatState: { tabs: [fromPersistedTab(persisted)], activeTabId: 'chat' },
    archives: [],
    runtimeByChatId: {},
    pendingQuestions: {},
  };
}

/** The pre-phase-12 result: each change list applied on its own, so the
 * message change derives TODOs and the descriptor update overwrites them. */
function applySeparately(
  start: CanonicalScopeProjection,
  changes: ChatStateChange[],
): CanonicalScopeProjection {
  return changes.reduce(
    (current, change) => applyCanonicalChanges(current, [change], ctx),
    start,
  );
}

function withTodoProjectionCounter<T>(run: () => T): {
  result: T;
  todoProjections: number;
} {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value: true,
  });
  globalThis.__CANOPY_TRANSCRIPT_PERF__ = {
    schemaVersion: 2,
    startedAt: performance.now(),
    stages: {},
    counters: {},
    correlations: [],
  };
  try {
    const result = run();
    const stage = globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.todo_projection;
    return { result, todoProjections: stage?.count ?? 0 };
  } finally {
    delete globalThis.__CANOPY_TRANSCRIPT_PERF__;
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: false,
    });
  }
}

describe('applyCanonicalChanges TODO projection', () => {
  it("uses main's TODOs when the commit carries transcript.updated", () => {
    const appended = todoWrite('t2', ['third']);
    const messages = [...history, appended];
    const changes: ChatStateChange[] = [
      { type: 'message.upserted', chatId: 'chat', message: appended },
      {
        type: 'transcript.updated',
        chatId: 'chat',
        transcript: descriptorFor(messages, 2),
        reset: false,
      },
    ];

    const batched = withTodoProjectionCounter(() =>
      applyCanonicalChanges(projection(), changes, ctx),
    );
    const reference = applySeparately(projection(), changes);

    expect(batched.todoProjections).toBe(0);
    expect(batched.result).toStrictEqual(reference);
    const tab = batched.result.chatState.tabs[0];
    expect(tab.currentTodos?.map((item) => item.content)).toEqual(['third']);
    expect(tab.currentTaskTodos?.map((item) => item.content)).toEqual([
      'task one',
    ]);
  });

  it('keeps the renderer derivation when no descriptor update follows', () => {
    const appended = taskCreate('k2', 'task two');
    const changes: ChatStateChange[] = [
      { type: 'message.upserted', chatId: 'chat', message: appended },
    ];

    const applied = withTodoProjectionCounter(() =>
      applyCanonicalChanges(projection(), changes, ctx),
    );

    expect(applied.todoProjections).toBe(1);
    const tab = applied.result.chatState.tabs[0];
    expect(tab.currentTaskTodos?.map((item) => item.content)).toEqual([
      'task one',
      'task two',
    ]);
  });

  it('derives for a chat whose descriptor update is for another chat or earlier', () => {
    const appended = todoWrite('t3', ['only']);
    const changes: ChatStateChange[] = [
      {
        type: 'transcript.updated',
        chatId: 'chat',
        transcript: descriptorFor(history, 2),
        reset: false,
      },
      { type: 'message.upserted', chatId: 'chat', message: appended },
      {
        type: 'transcript.updated',
        chatId: 'other-chat',
        transcript: descriptorFor([], 1),
        reset: false,
      },
    ];

    const applied = withTodoProjectionCounter(() =>
      applyCanonicalChanges(projection(), changes, ctx),
    );

    expect(applied.todoProjections).toBe(1);
    expect(applied.result).toStrictEqual(
      applySeparately(projection(), changes),
    );
    expect(
      applied.result.chatState.tabs[0].currentTodos?.map(
        (item) => item.content,
      ),
    ).toEqual(['only']);
  });

  it('matches the renderer derivation over a fully loaded transcript', () => {
    const transcripts: PersistedChatMessage[][] = [
      [],
      history,
      [...history, todoWrite('t2', ['a', 'b', 'c'])],
      [...history, taskCreate('k2', 'two'), todoWrite('t2', [])],
      [
        ...history,
        {
          ...todoWrite('sub', ['nested']),
          parentToolUseId: 'agent-1',
        },
      ],
    ];
    for (const messages of transcripts) {
      const folded = descriptorFor(messages, 1);
      expect(folded.todos).toEqual(deriveCurrentTodosFromMessages(messages));
      expect(folded.taskTodos).toEqual(
        deriveCurrentTaskTodosFromMessages(messages),
      );
    }
  });
});
