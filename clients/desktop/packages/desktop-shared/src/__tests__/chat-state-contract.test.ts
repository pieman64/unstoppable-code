import {
  type ChatCommand,
  type ChatCommandEnvelope,
  type ChatCommandResult,
  type ChatCoreMutation,
  type ChatJournalRecord,
  type ChatRuntimeState,
  type ChatStateChange,
  type ChatStateChangedEvent,
  type ChatStateSnapshot,
  type ChatStateLoadError,
  type PersistedChatMessage,
} from '../types';
import { mergePersistedMessagesById } from '../persisted-chat-state';

function assertNever(value: never): never {
  throw new Error(`Unexpected discriminant: ${JSON.stringify(value)}`);
}

function commandType(command: ChatCommand): string {
  switch (command.type) {
    case 'chat.create_tab':
    case 'chat.create_file_tab':
    case 'chat.close_tabs':
    case 'chat.activate_tab':
    case 'chat.reorder_tabs':
    case 'chat.close_tab':
    case 'chat.patch_tab_settings':
    case 'chat.mark_read':
    case 'chat.mark_unread':
    case 'chat.dismiss_attention':
    case 'chat.send_message':
    case 'chat.edit_queued_message':
    case 'chat.cancel_queued_message':
    case 'chat.force_queued_message':
    case 'chat.answer_question':
    case 'chat.dismiss_question':
    case 'chat.archive_tab':
    case 'chat.restore_archive':
    case 'chat.mark_archive_read':
    case 'chat.mark_all_archives_read':
    case 'chat.fork_tab':
    case 'chat.reset_to_point':
    case 'chat.import_session':
    case 'chat.set_scheduled_send_draft':
    case 'chat.commit_terminal_initial_prompt':
    case 'chat.set_model':
    case 'chat.set_approval_mode':
    case 'chat.move_queued_message':
    case 'chat.steer_queued_message':
    case 'chat.input_delivery_action':
      return command.type;
    default:
      return assertNever(command);
  }
}

function mutationType(mutation: ChatCoreMutation): string {
  switch (mutation.type) {
    case 'tab.created':
    case 'tab.metadata_patched':
    case 'tab.removed':
    case 'tab.order_changed':
    case 'tab.active_changed':
    case 'message.upserted':
    case 'message.removed':
    case 'messages.replaced':
    case 'pending_question.upserted':
    case 'pending_question.removed':
    case 'runtime.patched':
    case 'archive.upserted':
    case 'archive.removed':
    case 'archive.read_state_changed':
      return mutation.type;
    default:
      return assertNever(mutation);
  }
}

function changeType(change: ChatStateChange): string {
  switch (change.type) {
    case 'delegation.card_state_updated':
    case 'transcript.updated':
    case 'tab.upserted':
    case 'tab.removed':
    case 'tab.metadata_patched':
    case 'tab.order_changed':
    case 'tab.active_changed':
    case 'message.upserted':
    case 'message.removed':
    case 'messages.replaced':
    case 'messages.omitted':
    case 'pending_question.upserted':
    case 'pending_question.removed':
    case 'runtime.patched':
    case 'archive.upserted':
    case 'archive.removed':
    case 'archive.read_state_changed':
      return change.type;
    default:
      return assertNever(change);
  }
}

function jsonRoundTrip(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

describe('revisioned chat state transport contracts', () => {
  const runtime: ChatRuntimeState = {
    status: 'streaming',
    activeTurn: { userMessageId: 'message-1', startedAt: 1 },
    queuedMessageIds: ['message-2'],
    lastActivityAt: 2,
  };

  const command: ChatCommand = {
    type: 'chat.send_message',
    chatId: 'chat-1',
    userMessageId: 'message-1',
    text: 'hello',
    inputMode: 'typed',
  };

  const envelope: ChatCommandEnvelope<ChatCommand> = {
    schemaVersion: 1,
    commandId: 'command-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    expectedRevision: 3,
    command,
  };

  const snapshot: ChatStateSnapshot = {
    schemaVersion: 1,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision: 4,
    tabsFile: {
      version: 1,
      revision: 4,
      tabs: [],
      activeTabId: '',
    },
    archives: [],
    runtimeByChatId: { 'chat-1': runtime },
    queue: [],
  };

  const event: ChatStateChangedEvent = {
    schemaVersion: 1,
    eventId: 'project-1:worktree-1:4',
    occurredAt: '2026-08-07T00:00:00.000Z',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    baseRevision: 3,
    revision: 4,
    changes: [{ type: 'tab.order_changed', tabIds: [] }],
  };

  const journal: ChatJournalRecord = {
    v: 1,
    revision: 4,
    mutationId: 'mutation-1',
    occurredAt: '2026-08-07T00:00:00.000Z',
    source: 'renderer-command',
    mutations: [{ type: 'tab.order_changed', tabIds: [] }],
    commandResult: {
      commandId: 'command-1',
      revision: 4,
      outcome: 'applied',
      entityId: 'chat-1',
    },
  };

  const result: ChatCommandResult = {
    commandId: 'command-1',
    revision: 4,
    outcome: 'already_applied',
    entityId: 'chat-1',
  };

  const loadError: ChatStateLoadError = {
    name: 'ChatStateLoadError',
    code: 'recovery_error',
    message: 'Chat state could not be recovered.',
    retryable: false,
  };

  it('keeps command, mutation, and projection discriminants exhaustive', () => {
    const firstMutation = journal.mutations[0];
    const firstChange = event.changes[0];
    if (!firstMutation || !firstChange) {
      throw new Error('Expected contract fixtures to contain one entry.');
    }
    expect(commandType(command)).toBe('chat.send_message');
    expect(mutationType(firstMutation)).toBe('tab.order_changed');
    expect(changeType(firstChange)).toBe('tab.order_changed');
  });

  it.each([
    ['envelope', envelope],
    ['snapshot', snapshot],
    ['event', event],
    ['runtime', runtime],
    ['journal', journal],
    ['result', result],
    ['load error', loadError],
  ])(
    'round-trips %s through JSON without changing its value',
    (_name, value) => {
      expect(jsonRoundTrip(value)).toEqual(value);
    },
  );

  it('allows user-selected routing fields but excludes main-owned fields', () => {
    const userSelectableFields: Array<keyof typeof command> = [
      'providerType',
      'model',
    ];
    const authoritativeFields: Array<keyof typeof command> = [
      // @ts-expect-error session identity is canonical state, not send input
      'sdkSessionId',
      // @ts-expect-error transcript snapshots are never renderer input
      'messages',
    ];
    expect(userSelectableFields).toHaveLength(2);
    expect(authoritativeFields).toHaveLength(2);
  });

  it('marks a chat unread manually only with a literal true flag', () => {
    const manual: ChatCommand = {
      type: 'chat.mark_unread',
      chatId: 'chat-1',
      manual: true,
    };
    const automatic: ChatCommand = {
      type: 'chat.mark_unread',
      chatId: 'chat-1',
    };
    const notManual: ChatCommand = {
      type: 'chat.mark_unread',
      chatId: 'chat-1',
      // @ts-expect-error an automatic mark omits the flag rather than sending false
      manual: false,
    };
    const readWithFlag: ChatCommand = {
      type: 'chat.mark_read',
      chatId: 'chat-1',
      // @ts-expect-error only chat.mark_unread carries the manual flag
      manual: true,
    };
    expect(commandType(manual)).toBe('chat.mark_unread');
    expect(jsonRoundTrip(manual)).toEqual(manual);
    expect(jsonRoundTrip(automatic)).toEqual(automatic);
    expect([notManual, readWithFlag]).toHaveLength(2);
  });
});

describe('compatibility transcript merging', () => {
  const message = (id: string, text: string): PersistedChatMessage => ({
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  });

  it('reuses the canonical transcript when the compatibility snapshot adds no ids', () => {
    const canonical = [message('message-1', 'canonical')];
    const incoming = [message('message-1', 'stale')];

    expect(mergePersistedMessagesById(canonical, incoming)).toBe(canonical);
  });

  it('copies before appending incoming-only messages', () => {
    const canonical = [message('message-1', 'canonical')];
    const incoming = [
      message('message-1', 'stale'),
      message('message-2', 'incoming'),
    ];

    const merged = mergePersistedMessagesById(canonical, incoming);

    expect(merged).not.toBe(canonical);
    expect(merged).toEqual([
      message('message-1', 'canonical'),
      message('message-2', 'incoming'),
    ]);
    expect(canonical).toEqual([message('message-1', 'canonical')]);
  });
});
