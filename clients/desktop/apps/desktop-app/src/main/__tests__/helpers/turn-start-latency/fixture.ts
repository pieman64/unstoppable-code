import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import type {
  ChatCommandEnvelope,
  ChatCoreMutation,
  McpQuestionAnswer,
  PersistedChatMessage,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../../../lib/chat-storage-v2';
import type { ChatMigrationEntry } from '../../../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../../../lib/chat-transcript-log';
import type { ProviderEventInput } from '../../../services/chat-state-service';
import { ChatStateService } from '../../../services/chat-state-service';
import { ChatStateV2Repository } from '../../../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../../../services/chat-state-contracts';

export const TURN_START_SCOPE: ChatScopeKey = {
  projectId: 'turn-start-latency-workspace',
  worktreeId: 'turn-start-latency-worktree',
};
export const SMALL_CHAT_ID = 'turn-start-small-chat';
export const LARGE_CHAT_ID = 'turn-start-large-chat';
export const SMALL_HISTORY_ROW_COUNT = 100;
export const LARGE_HISTORY_ROW_COUNT = 25_000;
const HISTORY_TEXT_LENGTH = 1_688;
const BASE_TIME = 1_792_000_000_000;

export interface TurnStartSnapshot {
  bytes: Buffer;
  locatorOffsets: Map<string, { offset: number; end: number }>;
}

export interface TurnStartFixture {
  readonly historyIdsByChatId: Map<string, string[]>;
  readonly repository: ChatStateV2Repository;
  readonly service: ChatStateService;
  readonly storage: ChatStorageV2;
  readonly transcript: ChatTranscriptLog;
  dispose(): Promise<void>;
  readTurnSnapshot(chatId: string): Promise<TurnStartSnapshot>;
  startTurn(chatId: string, turnNumber: number): Promise<void>;
  startOwnTurnAsyncAnswer(chatId: string, turnNumber: number): Promise<void>;
}

function historyRow(chatId: string, rowNumber: number): PersistedChatMessage {
  return {
    id: `${chatId}-history-${String(rowNumber).padStart(5, '0')}`,
    role: 'assistant',
    timestamp: BASE_TIME + rowNumber,
    blocks: [{ type: 'text', text: 'x'.repeat(HISTORY_TEXT_LENGTH) }],
  };
}

async function* historyRows(
  chatId: string,
  count: number,
  ids: string[],
): AsyncGenerator<PersistedChatMessage> {
  for (let rowNumber = 0; rowNumber < count; rowNumber += 1) {
    const row = historyRow(chatId, rowNumber);
    ids.push(row.id);
    yield await Promise.resolve(row);
  }
}

function requireApplied(outcome: string, operation: string): void {
  if (outcome !== 'applied')
    throw new Error(`${operation} was not applied: ${outcome}`);
}

function promptMessage(
  userMessageId: string,
  text: string,
): PersistedChatMessage {
  return {
    id: userMessageId,
    role: 'user',
    timestamp: Date.now(),
    inputMode: 'typed',
    blocks: [{ type: 'text', text }],
  };
}

function providerInput(
  chatId: string,
  userMessageId: string,
  mutationId: string,
  data: Record<string, unknown>,
): ProviderEventInput {
  return {
    ...TURN_START_SCOPE,
    chatId,
    mutationId,
    providerType: 'claude',
    turnUserMessageId: userMessageId,
    data,
  };
}

async function ingestApplied(
  service: ChatStateService,
  input: ProviderEventInput,
  operation: string,
): Promise<void> {
  const applied = await service.ingestProviderEvent(input);
  if (!applied) throw new Error(`${operation} was not applied`);
}

export async function createTurnStartFixture(): Promise<TurnStartFixture> {
  const root = await mkdtemp(join(tmpdir(), 'turn-start-latency-'));
  const paths = {
    tabs: join(root, 'chats', 'scope.json'),
    archives: join(root, 'chat-archives', 'scope.json'),
    journal: join(root, 'chat-journals', 'scope.jsonl'),
  };
  const storage = ChatStorageV2.fromLegacyPaths(paths);
  const repository = new ChatStateV2Repository({
    resolvePaths: (): typeof paths => paths,
  });
  const historyIdsByChatId = new Map<string, string[]>();
  const smallIds: string[] = [];
  const largeIds: string[] = [];
  historyIdsByChatId.set(SMALL_CHAT_ID, smallIds);
  historyIdsByChatId.set(LARGE_CHAT_ID, largeIds);
  let now = BASE_TIME;
  let generatedId = 0;
  const service = new ChatStateService({
    repository,
    now: (): number => now,
    createId: (): string => `turn-start-generated-${++generatedId}`,
    dispatch: (): Promise<void> => Promise.resolve(),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    recordDiagnostic: (): void => undefined,
  });

  try {
    await storage.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: {
          activeTabId: SMALL_CHAT_ID,
          runtimeByChatId: {},
        },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: {
              id: SMALL_CHAT_ID,
              title: 'Small transcript',
              createdAt: '2026-10-16',
              providerType: 'claude',
              model: 'claude-opus-4-6',
            },
            messages: historyRows(
              SMALL_CHAT_ID,
              SMALL_HISTORY_ROW_COUNT,
              smallIds,
            ),
          });
          yield await Promise.resolve({
            metadata: {
              id: LARGE_CHAT_ID,
              title: 'Large transcript',
              createdAt: '2026-10-16',
              providerType: 'claude',
              model: 'claude-opus-4-6',
            },
            messages: historyRows(
              LARGE_CHAT_ID,
              LARGE_HISTORY_ROW_COUNT,
              largeIds,
            ),
          });
        })(),
      }),
    );
    const transcript = new ChatTranscriptLog(
      join(storage.directory, 'transcripts'),
    );

    const startTurn = async (
      chatId: string,
      turnNumber: number,
      asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
    ): Promise<void> => {
      now += 1;
      const userMessageId = asyncAnswer
        ? `answer-answer-${turnNumber}-${chatId}`
        : `user-turn-${turnNumber}-${chatId}`;
      const commandId = asyncAnswer
        ? `answer-${turnNumber}-${chatId}`
        : `send-${turnNumber}-${chatId}`;
      const text = asyncAnswer
        ? formatAskUserAnswers(asyncAnswer.answers)
        : `Latency measurement ${turnNumber}`;
      if (!asyncAnswer) {
        const envelope: ChatCommandEnvelope<{
          type: 'chat.send_message';
          chatId: string;
          userMessageId: string;
          text: string;
        }> = {
          schemaVersion: 1,
          commandId,
          ...TURN_START_SCOPE,
          command: { type: 'chat.send_message', chatId, userMessageId, text },
        };
        const result = await service.command(envelope);
        requireApplied(result.outcome, 'Immediate prompt precommit');
      }

      await ingestApplied(
        service,
        providerInput(chatId, userMessageId, `${commandId}:user-prompt`, {
          type: 'canopy_user_prompt',
          original_text: text,
          canopy_turn_user_message_id: userMessageId,
          provider: 'claude',
          ...(asyncAnswer
            ? { canopy_async_question_id: asyncAnswer.questionId }
            : {}),
          canopy_persisted_messages: [promptMessage(userMessageId, text)],
        }),
        'canopy_user_prompt provider event',
      );
      await ingestApplied(
        service,
        providerInput(chatId, userMessageId, `${commandId}:assistant`, {
          type: 'assistant',
          uuid: `${commandId}:assistant`,
          canopy_turn_user_message_id: userMessageId,
          message: {
            id: `assistant-${turnNumber}-${chatId}`,
            content: [{ type: 'text', text: 'A completed turn.' }],
          },
        }),
        'Provider assistant event',
      );
      await ingestApplied(
        service,
        providerInput(chatId, userMessageId, `${commandId}:result`, {
          type: 'result',
          subtype: 'success',
          result: 'A completed turn.',
          canopy_turn_user_message_id: userMessageId,
        }),
        'Provider terminal result event',
      );
    };

    const startOwnTurnAsyncAnswer = async (
      chatId: string,
      turnNumber: number,
    ): Promise<void> => {
      const questionId = `async-question-${turnNumber}-${chatId}`;
      const question: PersistedPendingQuestion = {
        delivery: 'async',
        requestId: questionId,
        chatId,
        questions: [
          {
            id: 'choice',
            question: 'Which option?',
            options: ['Continue'],
          },
        ],
      };
      const questionMutation: ChatCoreMutation = {
        type: 'pending_question.upserted',
        question,
      };
      await repository.transact(TURN_START_SCOPE, [questionMutation], {
        source: 'provider',
        chatIds: [chatId],
      });
      const answers: McpQuestionAnswer[] = [
        {
          questionId: 'choice',
          question: 'Which option?',
          selectedOptions: ['Continue'],
        },
      ];
      const answerResult = await service.command({
        schemaVersion: 1,
        commandId: `answer-${turnNumber}-${chatId}`,
        ...TURN_START_SCOPE,
        command: {
          type: 'chat.answer_question',
          chatId,
          questionId,
          answers,
        },
      });
      requireApplied(answerResult.outcome, 'Own-turn async answer');
      await startTurn(chatId, turnNumber, { questionId, answers });
    };

    const readTurnSnapshot = async (
      chatId: string,
    ): Promise<TurnStartSnapshot> => {
      const jsonlPath = join(
        storage.directory,
        'transcripts',
        `${chatId}.jsonl`,
      );
      const bytes = await readFile(jsonlPath);
      const ids = new Set(historyIdsByChatId.get(chatId) ?? []);
      const locatorDir = join(
        storage.directory,
        'transcripts',
        'message-index',
        chatId,
      );
      const locatorOffsets = new Map<string, { offset: number; end: number }>();
      for (const filename of await readdir(locatorDir)) {
        if (!filename.endsWith('.json')) continue;
        const text = await readFile(join(locatorDir, filename), 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('messageId' in parsed) ||
          typeof parsed.messageId !== 'string' ||
          !('offset' in parsed) ||
          typeof parsed.offset !== 'number' ||
          !('end' in parsed) ||
          typeof parsed.end !== 'number'
        ) {
          throw new Error(`Invalid transcript locator ${filename}`);
        }
        if (ids.has(parsed.messageId))
          locatorOffsets.set(parsed.messageId, {
            offset: parsed.offset,
            end: parsed.end,
          });
      }
      return { bytes, locatorOffsets };
    };

    const dispose = async (): Promise<void> => {
      try {
        await service.drain();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    return {
      historyIdsByChatId,
      repository,
      service,
      storage,
      transcript,
      dispose,
      readTurnSnapshot,
      startTurn: (chatId, turnNumber): Promise<void> =>
        startTurn(chatId, turnNumber),
      startOwnTurnAsyncAnswer,
    };
  } catch (error) {
    await service.drain();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
