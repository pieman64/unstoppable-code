import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';
import type {
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import type {
  ChatIndexEntry,
  ChatMigrationEntry,
} from '../../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../../lib/chat-transcript-log';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { collectMemoryQueryContext } from '../query-context';

const PROJECT_ID = 'memory-query-project';
const WORKTREE_ID = 'memory-query-worktree';
const CHAT_ID = 'memory-query-large-chat';
const LARGE_TRANSCRIPT_ROW_COUNT = 25_000;

function transcriptFixture(): {
  body: string;
  committedDigest: string;
  committedByteLength: number;
  latestHuman: { ordinal: number; offset: number };
  offsets: Array<{ ordinal: number; offset: number }>;
} {
  const rows: string[] = [];
  const offsets: Array<{ ordinal: number; offset: number }> = [];
  let latestHuman = { ordinal: 0, offset: 0 };
  let committedByteLength = 0;
  for (let row = 0; row < LARGE_TRANSCRIPT_ROW_COUNT; row += 1) {
    const messageId = `history-${String(row).padStart(5, '0')}`;
    const timestamp = 1_792_000_000_000 + row;
    const message: PersistedChatMessage =
      row % 2 === 0
        ? {
            id: messageId,
            role: 'user',
            timestamp,
            inputMode: 'typed',
            blocks: [
              {
                type: 'text',
                text: row < 4 ? `Eligible human prompt ${row}` : 'yes',
              },
            ],
          }
        : {
            id: messageId,
            role: 'assistant',
            timestamp,
            blocks: [{ type: 'text', text: 'assistant history' }],
          };
    if (row % TRANSCRIPT_PAGE_SIZE === 0)
      offsets.push({ ordinal: row, offset: committedByteLength });
    if (message.role === 'user')
      latestHuman = { ordinal: row, offset: committedByteLength };
    const serialized = JSON.stringify(message);
    rows.push(serialized);
    committedByteLength += Buffer.byteLength(serialized, 'utf8') + 1;
  }
  const body = `${rows.join('\n')}\n`;
  return {
    body,
    committedDigest: createHash('sha256').update(body).digest('hex'),
    committedByteLength,
    latestHuman,
    offsets,
  };
}

describe('collectMemoryQueryContext transcript paging', () => {
  it('bounds rows read from a 25,000-row V2 transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-query-context-'));
    const paths = {
      tabs: join(root, 'chats', 'scope.json'),
      archives: join(root, 'chat-archives', 'scope.json'),
      journal: join(root, 'chat-journals', 'scope.jsonl'),
    };
    const storage = ChatStorageV2.fromLegacyPaths(paths);
    let service: ChatStateService | undefined;

    try {
      // First create a small valid V2 scope, then write its real indexed
      // transcript log directly. Queried pages still go through the V2 log.
      await storage.migrate(() =>
        Promise.resolve({
          revision: 0,
          index: { activeTabId: CHAT_ID, runtimeByChatId: {} },
          recovery: {
            receipts: [],
            mutationIds: [],
            removedTabIds: [],
            removedArchiveEntryIds: [],
            removedMessageIds: [],
          },
          chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
            await Promise.resolve();
            yield* [];
          })(),
        }),
      );
      const fixture = transcriptFixture();
      const transcriptChatDirectory = join(storage.directory, 'transcripts');
      await mkdir(transcriptChatDirectory, { recursive: true });
      await writeFile(
        join(transcriptChatDirectory, `${CHAT_ID}.jsonl`),
        fixture.body,
        'utf8',
      );
      const sparseIndex = {
        version: 3,
        format: 'complete-message-jsonl-v1',
        committedMessageCount: LARGE_TRANSCRIPT_ROW_COUNT,
        committedByteLength: fixture.committedByteLength,
        committedDigest: fixture.committedDigest,
        transcriptRevision: LARGE_TRANSCRIPT_ROW_COUNT,
        hasActiveSidecar: false,
        offsets: fixture.offsets,
        latestHuman: fixture.latestHuman,
        reducerFrame: {
          version: 1,
          messageCount: LARGE_TRANSCRIPT_ROW_COUNT,
          timers: [],
          cards: [],
          toolUses: [],
          pendingResults: [],
        },
      };
      const sparseIndexChecksum = createHash('sha256')
        .update(JSON.stringify(sparseIndex))
        .digest('hex');
      await writeFile(
        join(transcriptChatDirectory, `${CHAT_ID}.index.json`),
        JSON.stringify({ ...sparseIndex, checksum: sparseIndexChecksum }),
        'utf8',
      );
      const transcript = new ChatTranscriptLog(
        join(storage.directory, 'transcripts'),
        undefined,
        { readOnly: true },
      );
      const transcriptDescriptor = await transcript.descriptor(CHAT_ID);
      const emptyIndexes = await storage.indexes();
      const largeChat: ChatIndexEntry = {
        id: CHAT_ID,
        title: 'Large V2 transcript',
        createdAt: '2026-10-16T00:00:00.000Z',
        providerType: 'claude',
        model: 'claude-opus-4-6',
        transcript: transcriptDescriptor,
      };
      await writeFile(
        join(storage.directory, 'live-index.json'),
        JSON.stringify({ ...emptyIndexes.live, tabs: [largeChat] }),
        'utf8',
      );
      service = new ChatStateService({
        repository: new ChatStateV2Repository({
          resolvePaths: (): typeof paths => paths,
        }),
        dispatch: (): Promise<void> => Promise.resolve(),
        onInputPickup: (): Promise<void> => Promise.resolve(),
        authorizeSend: (): Promise<void> => Promise.resolve(),
        cleanupSession: (): Promise<void> => Promise.resolve(),
        recordDiagnostic: (): void => undefined,
      });
      resetChatStateServiceForTests(service);

      const latestHumanMessage: PersistedChatMessage = {
        id: 'history-24998',
        role: 'user',
        timestamp: 1_792_000_024_998,
        inputMode: 'typed',
        blocks: [{ type: 'text', text: 'yes' }],
      };
      jest.spyOn(service, 'getCompatibilityTabs').mockResolvedValue({
        version: 1,
        revision: LARGE_TRANSCRIPT_ROW_COUNT,
        activeTabId: CHAT_ID,
        tabs: [
          {
            id: CHAT_ID,
            title: 'Large V2 transcript',
            createdAt: '2026-10-16T00:00:00.000Z',
            providerType: 'claude',
            model: 'claude-opus-4-6',
            messages: [],
            transcriptWindow: {
              before: LARGE_TRANSCRIPT_ROW_COUNT - TRANSCRIPT_PAGE_SIZE,
              totalMessages: LARGE_TRANSCRIPT_ROW_COUNT,
              transcriptRevision: LARGE_TRANSCRIPT_ROW_COUNT,
              latestHumanMessage,
            },
          } satisfies PersistedChatTab,
        ],
      } satisfies ChatTabsFile);

      let rowsRead = 0;
      const pageSpy = jest
        .spyOn(service, 'getTranscriptPage')
        .mockImplementation(async (request) => {
          const page = await transcript.page(
            request.chatId,
            request.before,
            request,
          );
          rowsRead += page.messages.length;
          return page;
        });

      const context = await collectMemoryQueryContext({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        currentUserMessageId: 'history-24998',
      });

      expect(context.recentUserMessages).toEqual([]);
      expect(pageSpy.mock.calls.length).toBeGreaterThan(0);
      expect(pageSpy.mock.calls.length).toBeLessThanOrEqual(3);
      expect(rowsRead).toBeLessThanOrEqual(1_500);

      const controller = new AbortController();
      pageSpy.mockClear();
      pageSpy.mockImplementation(async (request) => {
        const page = await transcript.page(
          request.chatId,
          request.before,
          request,
        );
        controller.abort();
        return page;
      });
      await collectMemoryQueryContext({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        currentUserMessageId: 'history-24998',
        signal: controller.signal,
      });
      expect(pageSpy).toHaveBeenCalledTimes(1);
      pageSpy.mockRestore();
    } finally {
      resetChatStateServiceForTests();
      await service?.drain();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
