import { iterateAsync } from './cooperative-json';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { ChatStorageV2 } from './chat-storage-v2';
import {
  ChatStateV2Backend,
  type ChatReadSelection,
} from '../services/chat-state-v2-backend';
import { LegacyChatInput } from './legacy-chat-input';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentProviderType,
  PersistedChatMessage,
  StandaloneArchiveSnapshotFile,
  StandaloneChatMetaFile,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceChatHistoryConversationFilePath,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistorySummaryFilePath,
} from './paths';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isErrnoException, isRecord } from './type-guards';

function isArchiveSnapshotFile(
  value: unknown,
): value is StandaloneArchiveSnapshotFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.projectId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.archivedAt === 'string' &&
    isRecord(value.tab)
  );
}

function isStandaloneChatMetaFile(
  value: unknown,
): value is StandaloneChatMetaFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    typeof value.description === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function extractTextBlocks(message: PersistedChatMessage): string[] {
  return message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text.trim())
    .filter(Boolean);
}

export function buildArchiveConversationText(
  messages: PersistedChatMessage[],
): string {
  return messages
    .map((message) => {
      const text = extractTextBlocks(message).join('\n');
      if (!text) return null;
      const role =
        message.role === 'user'
          ? 'User'
          : message.role === 'assistant'
            ? 'Assistant'
            : 'System';
      return `${role}: ${text}`;
    })
    .filter((value): value is string => typeof value === 'string')
    .join('\n\n');
}

async function sourceHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) {
    if (!Buffer.isBuffer(bytes))
      throw new Error('Archive stream must contain bytes');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Legacy history gets the same manifest, continuous log and artifact closure
 * as live chats. Missing and corrupt archives remain distinct outcomes. */
export async function getStandaloneHistoryStorage(
  projectId: string,
  chatId: string,
  historyRootDir?: string,
): Promise<ChatStorageV2 | null> {
  const filePath = historyRootDir
    ? join(historyRootDir, chatId, 'conversation.json')
    : getWorkspaceChatHistoryConversationFilePath(
        resolveCoworkWorkspaceId(projectId),
        chatId,
      );
  const store = new ChatStorageV2(dirname(filePath), chatId, [filePath]);
  if ((await store.authority()) === 'v1') {
    try {
      await stat(filePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  let input: LegacyChatInput | undefined;
  let scratch: string | undefined;
  try {
    await store.migrate(async () => {
      const digest = await sourceHash(filePath);
      // Spill scratch lives in the OS temp dir, never beside the archive:
      // a scratch directory left inside `chat-history/{chatId}/` would
      // outlive the migration as an empty stray.
      scratch = await mkdtemp(join(tmpdir(), 'canopy-history-migration-'));
      input = await LegacyChatInput.create(scratch);
      const parsed = await input.snapshot(filePath);
      if (
        !isArchiveSnapshotFile(parsed) ||
        parsed.chatId !== chatId ||
        parsed.tab.id !== chatId ||
        !Array.isArray(parsed.tab.messages)
      )
        throw new Error(`Invalid standalone archive snapshot: ${filePath}`);
      const rows = input.messages(parsed.tab.messages);
      if (rows.duplicateIds)
        throw new Error('Duplicate standalone archive message identity');
      const metadata = { ...parsed.tab };
      Reflect.deleteProperty(metadata, 'messages');
      return {
        revision: 0,
        index: { activeTabId: '', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        assertUnchanged: async (): Promise<void> => {
          if ((await sourceHash(filePath)) !== digest)
            throw new Error('Archive changed during migration');
        },
        chats: iterateAsync([
          {
            metadata,
            archive: { archivedAt: parsed.archivedAt, turnCount: 0 },
            messages: rows.iterate(),
          },
        ]),
      };
    });
    return store;
  } finally {
    await input?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** Catalog projection of one archived cowork chat: metadata only, no rows. */
export interface StandaloneArchiveListing {
  archivedAt: string;
  title: string;
  createdAt: string;
  providerType?: AgentProviderType;
  messageCount: number;
}

/**
 * Read-only listing for bulk callers (history index rebuild, retention
 * gating). It never admits or migrates the archive: a v2 archive answers from
 * its archive index, a legacy `conversation.json` is parsed with the message
 * rows spilled to temp scratch. Missing archives are `null`; corrupt ones
 * throw so callers cannot mistake damage for absence.
 */
export async function readArchiveListing(
  projectId: string,
  chatId: string,
): Promise<StandaloneArchiveListing | null> {
  const filePath = getWorkspaceChatHistoryConversationFilePath(
    resolveCoworkWorkspaceId(projectId),
    chatId,
  );
  const store = new ChatStorageV2(dirname(filePath), chatId, [filePath]);
  if ((await store.authority()) === 'v2') {
    const { archive } = await store.indexes();
    const entry = archive.archived.find((entry) => entry.tab.id === chatId);
    if (!entry) throw new Error('Standalone archive index is missing its chat');
    return {
      archivedAt: entry.archivedAt,
      title: entry.tab.title,
      createdAt: entry.tab.createdAt,
      ...(entry.tab.providerType
        ? { providerType: entry.tab.providerType }
        : {}),
      messageCount: entry.tab.transcript.messageCount ?? 0,
    };
  }
  try {
    await stat(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'canopy-history-listing-'));
  let input: LegacyChatInput | undefined;
  try {
    input = await LegacyChatInput.create(scratch);
    const parsed = await input.snapshot(filePath);
    if (
      !isArchiveSnapshotFile(parsed) ||
      parsed.chatId !== chatId ||
      parsed.tab.id !== chatId ||
      !Array.isArray(parsed.tab.messages)
    )
      throw new Error(`Invalid standalone archive snapshot: ${filePath}`);
    return {
      archivedAt: parsed.archivedAt,
      title: parsed.tab.title,
      createdAt: parsed.tab.createdAt,
      ...(parsed.tab.providerType
        ? { providerType: parsed.tab.providerType }
        : {}),
      messageCount:
        parsed.tab.transcript?.messageCount ??
        input.messages(parsed.tab.messages).size,
    };
  } finally {
    await input?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function readArchiveSnapshot(
  projectId: string,
  chatId: string,
  selection: ChatReadSelection = {},
): Promise<StandaloneArchiveSnapshotFile | null> {
  return readArchiveSnapshotForIndex(projectId, chatId, selection);
}

export async function readArchiveSnapshotForIndex(
  projectId: string,
  chatId: string,
  selection: ChatReadSelection = {},
): Promise<StandaloneArchiveSnapshotFile | null> {
  const store = await getStandaloneHistoryStorage(projectId, chatId);
  if (!store) return null;
  const state = await new ChatStateV2Backend(store).state(selection);
  const entry = state.archivesFile.archived.find(
    (entry) => entry.tab.id === chatId,
  );
  if (!entry) throw new Error('Standalone archive index is missing its chat');
  return {
    version: 1,
    projectId,
    chatId,
    archivedAt: entry.archivedAt,
    tab: entry.tab,
  };
}

export async function readArchiveMeta(
  projectId: string,
  chatId: string,
): Promise<StandaloneChatMetaFile | null> {
  try {
    return await readArchiveMetaForIndex(projectId, chatId);
  } catch {
    return null;
  }
}

/** Strict metadata reader used when a failed read must preserve indexed data. */
export async function readArchiveMetaForIndex(
  projectId: string,
  chatId: string,
): Promise<StandaloneChatMetaFile | null> {
  const filePath = getWorkspaceChatHistoryMetaFilePath(
    resolveCoworkWorkspaceId(projectId),
    chatId,
  );
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isStandaloneChatMetaFile(parsed)) {
    throw new Error(`Invalid standalone chat metadata: ${filePath}`);
  }
  return parsed;
}

export async function writeArchiveSnapshot(
  projectId: string,
  chatId: string,
  snapshot: StandaloneArchiveSnapshotFile,
): Promise<void> {
  const filePath = getWorkspaceChatHistoryConversationFilePath(
    resolveCoworkWorkspaceId(projectId),
    chatId,
  );
  const store = await getStandaloneHistoryStorage(projectId, chatId);
  if (!store) {
    const target = new ChatStorageV2(dirname(filePath), chatId, [filePath]);
    const { messages, ...metadata } = snapshot.tab;
    await target.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: '', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: iterateAsync([
          {
            metadata,
            archive: {
              archivedAt: snapshot.archivedAt,
              turnCount: messages.filter((message) => message.role === 'user')
                .length,
            },
            messages: iterateAsync(messages),
          },
        ]),
      }),
    );
    return;
  }
  await new ChatStateV2Backend(store).transact(
    () => [
      {
        type: 'archive.upserted',
        entry: {
          tab: snapshot.tab,
          archivedAt: snapshot.archivedAt,
          turnCount: snapshot.tab.messages.filter(
            (message) => message.role === 'user',
          ).length,
        },
        replaceTranscript: true,
      },
    ],
    { source: 'import', fullTranscript: true },
  );
}

export async function readArchiveSummary(
  projectId: string,
  chatId: string,
): Promise<string> {
  try {
    return await readFile(
      getWorkspaceChatHistorySummaryFilePath(
        resolveCoworkWorkspaceId(projectId),
        chatId,
      ),
      'utf8',
    );
  } catch {
    return 'Summary not available.';
  }
}
