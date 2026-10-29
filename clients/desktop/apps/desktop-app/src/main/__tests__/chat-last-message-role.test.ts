import type {
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import {
  chatLastMessageRole,
  lastConversationalRole,
  type ChatLastMessageRole,
} from '../lib/chat-last-message-role';
import { readChatLastMessageRole } from '../lib/chat-tabs-reader';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';

let storageRoot = 'storage-a';
jest.mock('../lib/resolve-worktree', () => ({
  resolveChatTabsFilePath: (project: string, worktree: string): string =>
    `${storageRoot}/${project}/${worktree}`,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { consumeTranscriptPreview: typeof preview } => ({
    consumeTranscriptPreview: preview,
  }),
}));
type Preview = (
  scope: { projectId: string; worktreeId: string },
  chatId: string,
  consume: (
    messages: AsyncIterable<PersistedChatMessage>,
    descriptor: TranscriptDescriptor,
    read: { committedIncluded: boolean },
  ) => Promise<ChatLastMessageRole | undefined>,
) => Promise<ChatLastMessageRole | undefined>;
const preview = jest.fn<ReturnType<Preview>, Parameters<Preview>>();
const descriptor: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 3,
  committedByteLength: 100,
  transcriptRevision: 1,
  hasActiveSidecar: false,
  messageCount: 3,
};
const row = (
  role: PersistedChatMessage['role'],
  id = role,
): PersistedChatMessage => ({ id, role, timestamp: 1, blocks: [] });
const tab = (transcript?: TranscriptDescriptor): PersistedChatTab => ({
  id: 'chat-1',
  title: 'Chat',
  createdAt: '2026-10-01T00:00:00Z',
  messages: [row('assistant')],
  ...(transcript ? { transcript } : {}),
});
async function* rows(
  messages: PersistedChatMessage[],
): AsyncGenerator<PersistedChatMessage> {
  yield* await Promise.resolve(messages);
}
function recover(
  messages: PersistedChatMessage[],
  captured = descriptor,
): void {
  preview.mockImplementation((_scope, _id, consume) =>
    consume(rows(messages), captured, { committedIncluded: true }),
  );
}

beforeEach(() => {
  preview.mockReset();
  storageRoot = 'storage-a';
});

it('ignores trailing system/tool output rows, empty and system-only histories', () => {
  expect(
    lastConversationalRole([row('assistant'), row('user'), row('system')]),
  ).toBe('user');
  expect(
    lastConversationalRole([row('user'), row('assistant'), row('system')]),
  ).toBe('assistant');
  expect(lastConversationalRole([])).toBeUndefined();
  expect(lastConversationalRole([row('system')])).toBeUndefined();
  expect(chatLastMessageRole(tab(descriptor))).toBeUndefined();
  expect(
    chatLastMessageRole(tab({ ...descriptor, lastMessageRole: 'user' })),
  ).toBe('user');
  expect(chatLastMessageRole(tab())).toBe('assistant');
});

it('coalesces legacy recovery, preserves inputs and uses canonical active ordering', async () => {
  recover([row('user'), row('assistant'), row('system')]);
  const input = Object.freeze(tab(Object.freeze({ ...descriptor })));
  const before = JSON.stringify(input);
  expect(
    await Promise.all([
      readChatLastMessageRole('workspace', 'tree', input),
      readChatLastMessageRole('workspace', 'tree', input),
    ]),
  ).toEqual(['assistant', 'assistant']);
  expect(preview).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(input)).toBe(before);
});

it('bounds old histories and leaves unresolved reads retryable', async () => {
  recover([row('assistant')]);
  expect(
    await readChatLastMessageRole(
      'workspace',
      'tree',
      tab({ ...descriptor, messageCount: 501 }),
    ),
  ).toBeUndefined();
  expect(preview).not.toHaveBeenCalled();
  preview.mockRejectedValueOnce(new Error('temporarily unavailable'));
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBeUndefined();
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBe('assistant');
  recover([row('system')]);
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBeUndefined();
  recover([row('user')]);
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBe('user');
});

it('does not reuse a role after revision or storage/session changes', async () => {
  recover([row('assistant')]);
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBe('assistant');
  recover([row('user')], { ...descriptor, transcriptRevision: 2 });
  expect(
    await readChatLastMessageRole(
      'workspace',
      'tree',
      tab({ ...descriptor, transcriptRevision: 2 }),
    ),
  ).toBe('user');
  storageRoot = 'storage-b';
  recover([row('system')]);
  expect(
    await readChatLastMessageRole('workspace', 'tree', tab(descriptor)),
  ).toBeUndefined();
  expect(preview).toHaveBeenCalledTimes(3);
});

it('validates additive roles without rejecting old indexes', () => {
  const indexes = (role?: unknown): unknown => ({
    live: {
      version: 2,
      revision: 0,
      activeTabId: 'chat-1',
      runtimeByChatId: {},
      tabs: [
        {
          id: 'chat-1',
          transcript: {
            ...descriptor,
            ...(role === undefined ? {} : { lastMessageRole: role }),
          },
        },
      ],
    },
    archive: { version: 2, revision: 0, archived: [] },
    recovery: {
      version: 2,
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
  });
  for (const role of [undefined, 'user', 'assistant'])
    expect(() => assertChatStorageIndexes(indexes(role))).not.toThrow();
  for (const role of ['system', 'tool', null, 5])
    expect(() => assertChatStorageIndexes(indexes(role))).toThrow(
      'Invalid or duplicate chat index entry',
    );
});
