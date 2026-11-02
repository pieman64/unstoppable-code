import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCoreMutation,
  ChatStateChange,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../../lib/chat-transcript-log';
import {
  ChatStateService,
  type ChatStateServiceOptions,
  type ProviderEventInput,
} from '../chat-state-service';

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const SERVICE_TIMESTAMP = 1_786_104_000_000;

interface ServiceFixture {
  directory: string;
  repository: ChatStateV2Repository;
  service: ChatStateService;
  transcriptLog: ChatTranscriptLog;
}

function createServiceFixture(): ServiceFixture {
  const directory = mkdtempSync(join(tmpdir(), 'chat-state-turn-start-'));
  const paths = {
    tabs: join(directory, 'chats.json'),
    archives: join(directory, 'archives.json'),
    journal: join(directory, 'journal.jsonl'),
  };
  const repository = new ChatStateV2Repository({
    resolvePaths: (): typeof paths => paths,
  });
  const storage = ChatStorageV2.fromLegacyPaths(paths);
  const transcriptLog = new ChatTranscriptLog(
    join(storage.directory, 'transcripts'),
  );
  const submit: NonNullable<ChatStateServiceOptions['submit']> = async (
    _request,
    _origin,
    beforeImmediateDispatch,
  ): Promise<void> => {
    const ownTurnAdmission = {
      cancelledBeforeDispatch: false,
      startsTurn: true,
    };
    await beforeImmediateDispatch(ownTurnAdmission);
  };
  const service = new ChatStateService({
    repository,
    now: (): number => SERVICE_TIMESTAMP,
    createId: (): string => 'generated-id',
    submit,
    authorizeSend: (): Promise<undefined> => Promise.resolve(undefined),
    cleanupSession: (): Promise<undefined> => Promise.resolve(undefined),
    recordDiagnostic: (): void => undefined,
  });
  return { directory, repository, service, transcriptLog };
}

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

async function createChat(fixture: ServiceFixture): Promise<void> {
  await fixture.service.command(
    envelope('create-chat', {
      type: 'chat.create_tab',
      tabId: CHAT_ID,
      title: 'Turn start',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    }),
  );
}

async function disposeFixture(fixture: ServiceFixture): Promise<void> {
  await fixture.repository.drainAll();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function userMessage(
  id: string,
  timestamp: number,
  text: string,
): PersistedChatMessage {
  return {
    id,
    role: 'user',
    timestamp,
    userMessageSource: 'human',
    inputMode: 'typed',
    blocks: [{ type: 'text', text }],
  };
}

function tabFor(
  state: Awaited<ReturnType<ChatStateV2Repository['getState']>>,
): PersistedChatTab {
  const tab = state.tabsFile.tabs.find((candidate) => candidate.id === CHAT_ID);
  if (!tab) throw new Error(`Missing chat ${CHAT_ID}`);
  return tab;
}

function promptEvent(
  message: PersistedChatMessage,
  mutationId: string,
  asyncQuestionId?: string,
): ProviderEventInput {
  return {
    ...SCOPE,
    chatId: CHAT_ID,
    mutationId,
    turnUserMessageId: message.id,
    data: {
      type: 'canopy_user_prompt',
      canopy_turn_user_message_id: message.id,
      ...(asyncQuestionId ? { canopy_async_question_id: asyncQuestionId } : {}),
      canopy_persisted_messages: [message],
    },
  };
}

describe('chat state service turn-start transcript handling', () => {
  let fixture: ServiceFixture;

  beforeEach(() => {
    fixture = createServiceFixture();
  });

  afterEach(async () => {
    await disposeFixture(fixture);
  });

  it('relocates a committed off-page queued prompt with a prompt-relocation rewrite', async () => {
    await createChat(fixture);
    const originalPrompt = userMessage(
      'queued-offpage',
      1,
      'Queued before later turns',
    );
    const laterHuman = userMessage('later-human', 2, 'A later turn');
    const history: PersistedChatMessage[] = [
      originalPrompt,
      laterHuman,
      ...Array.from(
        { length: 510 },
        (_, index): PersistedChatMessage => ({
          id: `history-${index}`,
          role: 'assistant',
          timestamp: index + 3,
          blocks: [{ type: 'text', text: `History ${index}` }],
        }),
      ),
    ];
    const seed: ChatCoreMutation[] = [
      {
        type: 'messages.replaced',
        chatId: CHAT_ID,
        messages: history,
        removedMessageIds: [],
      },
    ];
    await fixture.repository.transact(SCOPE, seed, {
      source: 'import',
      mutationId: 'seed-offpage-history',
      fullTranscript: true,
    });
    const bounded = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
    });
    expect(
      tabFor(bounded).messages.some(({ id }) => id === originalPrompt.id),
    ).toBe(false);

    const transactions = jest.spyOn(fixture.repository, 'transactWith');
    await fixture.service.ingestProviderEvent(
      promptEvent(
        {
          id: originalPrompt.id,
          role: 'user',
          timestamp: SERVICE_TIMESTAMP + 100,
          inputMode: 'typed',
          blocks: [{ type: 'text', text: 'Queued before later turns' }],
        },
        'prompt-offpage-relocation',
      ),
    );

    expect(transactions.mock.calls.at(-1)?.[2]).toMatchObject({
      chatIds: [CHAT_ID],
      fullTranscript: true,
      rewriteReason: 'prompt_relocation',
    });
    const relocated = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const relocatedMessages = tabFor(relocated).messages;
    expect(
      relocatedMessages.filter(({ id }) => id === originalPrompt.id),
    ).toHaveLength(1);
    expect(relocatedMessages[relocatedMessages.length - 1]).toMatchObject({
      id: originalPrompt.id,
      timestamp: originalPrompt.timestamp,
      userMessageSource: 'human',
    });
  }, 20_000);

  it('uses a bounded state read to detect an active nonlast prompt relocation', async () => {
    await createChat(fixture);
    const prompt = userMessage('active-prompt', 10, 'Active prompt');
    const activeTail: PersistedChatMessage = {
      id: 'active-tail',
      role: 'assistant',
      timestamp: 11,
      blocks: [{ type: 'text', text: 'Output after the active prompt' }],
    };
    const seed: ChatCoreMutation[] = [
      {
        type: 'runtime.patched',
        chatId: CHAT_ID,
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurn: { userMessageId: prompt.id, startedAt: prompt.timestamp },
        },
      },
    ];
    await fixture.repository.transact(SCOPE, seed, {
      source: 'provider',
      mutationId: 'seed-active-prompt',
    });
    await fixture.transcriptLog.writeActive(CHAT_ID, [prompt, activeTail]);
    await expect(
      fixture.repository.locateMessage(SCOPE, CHAT_ID, prompt.id),
    ).resolves.toBe('active');

    const boundedRead = jest.spyOn(fixture.repository, 'getState');
    const transactions = jest.spyOn(fixture.repository, 'transactWith');
    await fixture.service.ingestProviderEvent(
      promptEvent(
        {
          ...prompt,
          timestamp: SERVICE_TIMESTAMP + 100,
          blocks: [{ type: 'text', text: 'Active prompt' }],
        },
        'prompt-active-relocation',
      ),
    );

    expect(boundedRead).toHaveBeenCalledWith(SCOPE, { chatIds: [CHAT_ID] });
    expect(transactions.mock.calls.at(-1)?.[2]).toMatchObject({
      chatIds: [CHAT_ID],
      fullTranscript: true,
      rewriteReason: 'prompt_relocation',
    });
    const relocated = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    expect(tabFor(relocated).messages.map(({ id }) => id)).toEqual([
      activeTail.id,
      prompt.id,
    ]);
  });

  it('does not patch a precommitted ordinary prompt when host fields and key order differ', async () => {
    await createChat(fixture);
    await fixture.service.command(
      envelope('ordinary-send', {
        type: 'chat.send_message',
        chatId: CHAT_ID,
        userMessageId: 'ordinary-prompt',
        text: 'Ordinary prompt',
      }),
    );
    const before = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const canonicalBefore = tabFor(before).messages.find(
      ({ id }) => id === 'ordinary-prompt',
    );
    if (!canonicalBefore)
      throw new Error('Missing precommitted ordinary prompt');

    const transactions = jest.spyOn(fixture.repository, 'transactWith');
    const changes: ChatStateChange[] = [];
    const unsubscribe = fixture.service.subscribe((event) => {
      changes.push(...event.changes);
    });
    await fixture.service.ingestProviderEvent(
      promptEvent(
        {
          id: 'ordinary-prompt',
          role: 'user',
          timestamp: SERVICE_TIMESTAMP + 100,
          inputMode: 'typed',
          blocks: [{ type: 'text', text: 'Ordinary prompt' }],
        },
        'ordinary-prompt-event',
      ),
    );
    unsubscribe();

    expect(
      changes.filter(
        (change) =>
          change.type === 'message.upserted' &&
          change.message.id === 'ordinary-prompt',
      ),
    ).toEqual([]);
    const eventOptions = transactions.mock.calls.at(-1)?.[2];
    expect(eventOptions?.fullTranscript).not.toBe(true);
    expect(eventOptions?.rewriteReason).toBeUndefined();
    const after = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    expect(
      tabFor(after).messages.find(({ id }) => id === 'ordinary-prompt'),
    ).toEqual(canonicalBefore);
  });

  it('precommits an own-turn async answer as a turn start without rewriting its prompt event', async () => {
    await createChat(fixture);
    await fixture.service.upsertPendingQuestion(SCOPE, {
      requestId: 'async-own-turn',
      chatId: CHAT_ID,
      delivery: 'async',
      questions: [{ id: 'scope', question: 'Which scope?', options: ['Full'] }],
    });
    await fixture.service.command(
      envelope('async-answer-command', {
        type: 'chat.answer_question',
        chatId: CHAT_ID,
        questionId: 'async-own-turn',
        answers: [
          {
            questionId: 'scope',
            question: 'Which scope?',
            selectedOptions: ['Full'],
          },
        ],
      }),
    );
    const before = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const answerMessageId = 'answer-async-answer-command';
    const canonicalAnswer = tabFor(before).messages.find(
      ({ id }) => id === answerMessageId,
    );
    if (!canonicalAnswer) throw new Error('Missing precommitted async answer');
    expect(canonicalAnswer.blocks[0]).toMatchObject({
      type: 'text',
      asyncQuestionAnswer: {
        requestId: 'async-own-turn',
        startsTurn: true,
        answers: [
          {
            questionId: 'scope',
            question: 'Which scope?',
            selectedOptions: ['Full'],
          },
        ],
      },
    });
    expect(canonicalAnswer.blocks[0]).not.toHaveProperty('steering');
    expect(before.tabsFile.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'async-own-turn',
        answerUserMessageId: answerMessageId,
        answeredAt: SERVICE_TIMESTAMP,
      }),
    ]);

    const transactions = jest.spyOn(fixture.repository, 'transactWith');
    const changes: ChatStateChange[] = [];
    const unsubscribe = fixture.service.subscribe((event) => {
      changes.push(...event.changes);
    });
    await fixture.service.ingestProviderEvent(
      promptEvent(
        {
          id: answerMessageId,
          role: 'user',
          timestamp: SERVICE_TIMESTAMP + 100,
          inputMode: 'typed',
          blocks: [{ type: 'text', text: 'Q: Which scope?\nA: Full' }],
        },
        'async-own-turn-prompt-event',
        'async-own-turn',
      ),
    );
    unsubscribe();

    expect(
      changes.filter(
        (change) =>
          change.type === 'message.upserted' &&
          change.message.id === answerMessageId,
      ),
    ).toEqual([]);
    const eventOptions = transactions.mock.calls.at(-1)?.[2];
    expect(eventOptions?.fullTranscript).not.toBe(true);
    expect(eventOptions?.rewriteReason).toBeUndefined();
    const after = await fixture.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    expect(
      tabFor(after).messages.find(({ id }) => id === answerMessageId),
    ).toEqual(canonicalAnswer);
  });
});
