/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatRuntimeState,
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import * as resolveWorktree from '../lib/resolve-worktree';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { stopChatTurn } from '../lib/chat-turn-stop';
import {
  observeTurn,
  turnEnded,
  turnStarted,
} from './helpers/turn-lifecycle-events';

jest.mock('@canopy/agent-transcript/transcript-storage', () => ({
  ...jest.requireActual<object>('@canopy/agent-transcript/transcript-storage'),
  TRANSCRIPT_PAGE_SIZE: 20,
}));
jest.mock('../observability', () => ({
  getObservabilityService: () => ({ observeSteeringInput: jest.fn() }),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: () => ({ getState: () => undefined }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: () => Promise.resolve(),
}));
jest.mock('../lib/chat-turn-cancel', () => ({
  // Stop reads the cancel outcome (turn-state phase 43e).
  cancelChatTurn: async () => ({ outcome: 'interrupted' }),
  captureChatTurnStop: (target: unknown) => ({
    target,
    session: undefined,
    fence: undefined,
  }),
}));
jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
}));
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: { cancelActiveReload: jest.fn() },
}));
jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: () => [],
}));
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: () => ({
    beginInputHydration: () => () => undefined,
    getWorktreeSnapshots: () => [],
    isTurnActive: () => false,
    onTurnTerminal: jest.fn(),
    releaseInputOwnership: () => undefined,
  }),
}));

jest.setTimeout(60_000);

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const PAUSED_CHAT_ID = 'paused-chat';
const TURN = 'long-turn';
const STARTED_AT = 1_790_795_411_486;
const SETTLED_AT = STARTED_AT + 2_000;
const STORE_SCOPE = 'scope';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function trackRoot(root: string): void {
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
}

function trackService(service: ChatStateService): () => Promise<void> {
  let drained = false;
  const drain = async (): Promise<void> => {
    if (drained) return;
    try {
      await service.drain();
    } finally {
      drained = true;
    }
  };
  cleanups.push(drain);
  return drain;
}

function trackRepository(repo: ChatStateV2Repository): void {
  let drained = false;
  cleanups.push(async () => {
    if (drained) return;
    drained = true;
    await repo.drainAll();
  });
}

function message(
  id: string,
  role: PersistedChatMessage['role'] = 'assistant',
  blocks: PersistedChatBlock[] = [{ type: 'text', text: id }],
  timestamp = STARTED_AT,
): PersistedChatMessage {
  return { id, role, timestamp, blocks };
}

function openTimerMessage(id = 'timer-row'): PersistedChatMessage {
  return message(id, 'system', [
    { type: 'turn_timer', startedAt: STARTED_AT, completedAt: null },
  ]);
}

function settledTimerMessage(id = 'settled-timer-row'): PersistedChatMessage {
  return message(id, 'system', [
    {
      type: 'turn_timer',
      startedAt: STARTED_AT,
      completedAt: SETTLED_AT,
    },
  ]);
}

function pausedTimerMessage(id = 'paused-timer-row'): PersistedChatMessage {
  return message(id, 'system', [
    {
      type: 'turn_timer',
      startedAt: STARTED_AT,
      pausedAt: STARTED_AT + 1_000,
      completedAt: null,
    },
  ]);
}

function promptMessage(id = TURN): PersistedChatMessage {
  return message(id, 'user', [{ type: 'text', text: 'Work' }], STARTED_AT);
}

function openToolMessage(): PersistedChatMessage {
  return message('open-tool-row', 'assistant', [
    { type: 'tool_use', toolUseId: 'open-tool', toolName: 'Bash', input: '{}' },
  ]);
}

function completedSpawnRows(): PersistedChatMessage[] {
  return [
    message('completed-spawn-row', 'assistant', [
      {
        type: 'tool_use',
        toolUseId: 'completed-spawn',
        toolName: 'Task',
        input: '{}',
      },
    ]),
    message('completed-spawn-result-row', 'system', [
      {
        type: 'tool_result',
        toolUseId: 'completed-spawn',
        toolName: 'Task',
        output: 'Spawn completed',
        isError: false,
      },
    ]),
  ];
}

function trailingRows(count = 28): PersistedChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`tail-${index}`));
}

function longActiveTurn(): PersistedChatMessage[] {
  return [
    promptMessage(),
    openTimerMessage(),
    openToolMessage(),
    ...completedSpawnRows(),
    ...trailingRows(),
  ];
}

function longSettledTurn(): PersistedChatMessage[] {
  return [promptMessage(), settledTimerMessage(), ...trailingRows()];
}

function pausedIdleTurn(): PersistedChatMessage[] {
  return [
    promptMessage('paused-turn'),
    pausedTimerMessage(),
    ...trailingRows(),
  ];
}

function asyncRows<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (index >= values.length)
            return Promise.resolve({ done: true, value: undefined });
          const value = values[index];
          index += 1;
          if (value === undefined) throw new Error('Missing seed row');
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function legacyPaths(root: string) {
  return {
    tabs: join(root, 'chats', `${STORE_SCOPE}.json`),
    archives: join(root, 'archives', `${STORE_SCOPE}.json`),
    journal: join(root, 'journals', `${STORE_SCOPE}.jsonl`),
  };
}

function repository(root: string): ChatStateV2Repository {
  return new ChatStateV2Repository({ resolvePaths: () => legacyPaths(root) });
}

function streamingRuntime(): ChatRuntimeState {
  return {
    status: 'streaming',
    activeTurn: { userMessageId: TURN, startedAt: STARTED_AT },
    queuedMessageIds: [],
  };
}

function completedRuntime(): ChatRuntimeState {
  return {
    status: 'completed',
    queuedMessageIds: [],
    lastActivityAt: SETTLED_AT,
  };
}

async function migrateStore(
  root: string,
  chats: ReadonlyArray<{
    id: string;
    messages: PersistedChatMessage[];
  }>,
  runtimeByChatId: Record<string, ChatRuntimeState>,
  activeTabId: string,
): Promise<void> {
  const store = new ChatStorageV2(root, STORE_SCOPE);
  const entries: ChatMigrationEntry[] = chats.map((chat) => ({
    metadata: {
      id: chat.id,
      title: chat.id,
      createdAt: new Date(STARTED_AT).toISOString(),
      providerType: 'claude',
    },
    messages: asyncRows(chat.messages),
  }));
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId, runtimeByChatId },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: asyncRows(entries),
    }),
  );
}

async function patchRuntime(
  repo: ChatStateV2Repository,
  chatId: string,
  runtime: ChatRuntimeState,
): Promise<void> {
  await repo.transact(SCOPE, [{ type: 'runtime.patched', chatId, runtime }], {
    source: 'automation',
    chatIds: [chatId],
  });
}

function createService(
  repo: ChatStateV2Repository,
  now: () => number,
): ChatStateService {
  return new ChatStateService({
    repository: repo,
    now,
    createId: () => 'event-id',
    dispatch: async () => undefined,
    onInputPickup: async () => undefined,
    authorizeSend: async () => undefined,
    cleanupSession: async () => undefined,
    recordDiagnostic: jest.fn(),
    inputSession: async () => undefined,
  });
}

async function messagesFor(
  repo: ChatStateV2Repository,
  chatId: string,
): Promise<PersistedChatMessage[]> {
  const messages: PersistedChatMessage[] = [];
  // This is a test-only post-commit oracle; production provider events keep
  // their bounded page/reducer-frame read and never request full history.
  await repo.consumeTranscript(SCOPE, chatId, false, async (rows) => {
    for await (const row of rows) messages.push(row);
  });
  return messages;
}

function findTimer(
  messages: readonly PersistedChatMessage[],
  id: string,
): PersistedChatBlock | undefined {
  const row = messages.find((candidate) => candidate.id === id);
  return row?.blocks.find((block) => block.type === 'turn_timer');
}

function timerRows(
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  return messages.filter((row) =>
    row.blocks.some((block) => block.type === 'turn_timer'),
  );
}

function toolResults(
  messages: readonly PersistedChatMessage[],
  toolUseId: string,
): Extract<PersistedChatBlock, { type: 'tool_result' }>[] {
  const results: Extract<PersistedChatBlock, { type: 'tool_result' }>[] = [];
  for (const row of messages)
    for (const block of row.blocks)
      if (block.type === 'tool_result' && block.toolUseId === toolUseId)
        results.push(block);
  return results;
}

function transcriptPath(root: string, chatId = CHAT_ID): string {
  return join(
    root,
    'chat-storage-v2',
    STORE_SCOPE,
    'transcripts',
    `${chatId}.jsonl`,
  );
}

function transcriptLineForMessage(contents: string, messageId: string): string {
  const line = contents.split('\n').find((candidate) => {
    if (candidate.length === 0) return false;
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed !== 'object' || parsed === null) return false;
    return Reflect.get(parsed, 'id') === messageId;
  });
  if (!line) throw new Error(`Missing committed transcript row ${messageId}`);
  return line;
}

function configureDefaultRepositoryPaths(root: string): void {
  const paths = legacyPaths(root);
  jest
    .spyOn(resolveWorktree, 'resolveChatTabsFilePath')
    .mockImplementation(() => paths.tabs);
  jest
    .spyOn(resolveWorktree, 'resolveChatArchivesFilePath')
    .mockImplementation(() => paths.archives);
  jest
    .spyOn(resolveWorktree, 'resolveChatJournalFilePath')
    .mockImplementation(() => paths.journal);
}

describe('provider reducer frames and restart repair', () => {
  it('settles a Stop against its timer, tool rows and a completed spawn result outside the page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-frame-stop-'));
    trackRoot(root);
    const now = { value: STARTED_AT + 10_000 };
    // The turn's timer comes from its canonical start, not the seed.
    const seed = longActiveTurn().filter((row) => row.id !== 'timer-row');
    await migrateStore(
      root,
      [{ id: CHAT_ID, messages: seed }],
      {
        [CHAT_ID]: completedRuntime(),
      },
      CHAT_ID,
    );
    const repo = repository(root);
    await patchRuntime(repo, CHAT_ID, streamingRuntime());
    const service = createService(repo, () => now.value);
    const drainService = trackService(service);
    const turnTimer = 'long-turn-execution:timer';
    await observeTurn(
      service,
      turnStarted(
        { ...SCOPE, chatId: CHAT_ID },
        {
          sequence: 1,
          turnId: 'long-turn-execution',
          atMs: STARTED_AT,
          userMessageIds: [TURN],
        },
      ),
    );

    const page = await repo.page(SCOPE, CHAT_ID);
    const pageIds = page.messages.map((row) => row.id);
    expect(pageIds).not.toContain('open-tool-row');
    expect(pageIds).not.toContain('completed-spawn-row');
    expect(pageIds).not.toContain('completed-spawn-result-row');
    expect(page.latestHumanMessage?.id).toBe(TURN);

    // A live session reports its abort-fallback end while Stop cancels it.
    await observeTurn(
      service,
      turnEnded(
        { ...SCOPE, chatId: CHAT_ID },
        {
          sequence: 2,
          turnId: 'long-turn-execution',
          atMs: now.value,
          userMessageIds: [TURN],
          outcome: 'cancelled',
          source: 'abort-fallback',
        },
      ),
    );
    resetChatStateServiceForTests(service);
    let stoppedByUser: Awaited<ReturnType<typeof stopChatTurn>>;
    try {
      stoppedByUser = await stopChatTurn({ ...SCOPE, chatId: CHAT_ID });
    } finally {
      resetChatStateServiceForTests();
    }
    expect(stoppedByUser).toEqual({
      type: 'result',
      is_error: false,
      result: 'Cancelled',
    });

    const stopped = await messagesFor(repo, CHAT_ID);
    expect(findTimer(stopped, turnTimer)).toMatchObject({
      type: 'turn_timer',
      completedAt: now.value,
    });
    expect(toolResults(stopped, 'open-tool')).toHaveLength(1);
    expect(toolResults(stopped, 'open-tool')[0]).toMatchObject({
      output: 'Cancelled',
      isError: false,
    });
    expect(toolResults(stopped, 'completed-spawn')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'completed-spawn',
        toolName: 'Task',
        output: 'Spawn completed',
        isError: false,
      },
    ]);
    expect((await repo.getState(SCOPE)).runtimeByChatId[CHAT_ID]).toMatchObject(
      { status: 'cancelled' },
    );

    await drainService();
    const reopened = repository(root);
    trackRepository(reopened);
    const persisted = await messagesFor(reopened, CHAT_ID);
    expect(findTimer(persisted, turnTimer)).toMatchObject({
      completedAt: now.value,
    });
    expect(toolResults(persisted, 'open-tool')).toHaveLength(1);
    expect(toolResults(persisted, 'completed-spawn')).toHaveLength(1);
  });

  it('repairs a fresh instance idempotently without interrupting a paused idle timer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-frame-restart-'));
    trackRoot(root);
    const now = { value: STARTED_AT + 10_000 };
    await migrateStore(
      root,
      [
        { id: CHAT_ID, messages: longActiveTurn() },
        { id: PAUSED_CHAT_ID, messages: pausedIdleTurn() },
      ],
      {
        [CHAT_ID]: completedRuntime(),
        [PAUSED_CHAT_ID]: { status: 'idle', queuedMessageIds: [] },
      },
      CHAT_ID,
    );
    const seedRepo = repository(root);
    await patchRuntime(seedRepo, CHAT_ID, streamingRuntime());
    await seedRepo.drainAll();
    const pausedBytesBefore = transcriptLineForMessage(
      readFileSync(transcriptPath(root, PAUSED_CHAT_ID), 'utf8'),
      'paused-timer-row',
    );
    configureDefaultRepositoryPaths(root);
    const service = new ChatStateService({
      now: () => now.value,
      inputSession: async () => undefined,
      recordDiagnostic: jest.fn(),
    });
    const drainService = trackService(service);

    const firstRepair = await service.getState(SCOPE);
    expect(firstRepair.runtimeByChatId[CHAT_ID]).toMatchObject({
      status: 'interrupted',
    });
    expect(firstRepair.runtimeByChatId[PAUSED_CHAT_ID]).toMatchObject({
      status: 'idle',
    });
    const firstRepairRevision = firstRepair.revision;
    const repeatedRepair = await service.getState(SCOPE);
    expect(repeatedRepair.revision).toBe(firstRepairRevision);
    expect(repeatedRepair.runtimeByChatId[CHAT_ID]).toMatchObject({
      status: 'interrupted',
    });

    await drainService();
    const reopened = repository(root);
    trackRepository(reopened);
    const repaired = await messagesFor(reopened, CHAT_ID);
    // Restart repair closes the timer at the turn's last observed activity,
    // not at detection, so the downtime is not counted as turn time.
    expect(findTimer(repaired, 'timer-row')).toMatchObject({
      type: 'turn_timer',
      completedAt: STARTED_AT,
    });
    expect(toolResults(repaired, 'open-tool')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'open-tool',
        toolName: 'Bash',
        output: 'Interrupted by app restart',
        isError: true,
        interruption: { reason: 'app_restart', at: STARTED_AT },
      },
    ]);
    expect(toolResults(repaired, 'completed-spawn')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'completed-spawn',
        toolName: 'Task',
        output: 'Spawn completed',
        isError: false,
      },
    ]);
    const paused = await messagesFor(reopened, PAUSED_CHAT_ID);
    expect(findTimer(paused, 'paused-timer-row')).toEqual(
      pausedIdleTurn()[1]?.blocks[0],
    );
    expect(
      transcriptLineForMessage(
        readFileSync(transcriptPath(root, PAUSED_CHAT_ID), 'utf8'),
        'paused-timer-row',
      ),
    ).toBe(pausedBytesBefore);
    expect(toolResults(repaired, 'open-tool')).toHaveLength(1);
  });

  it('keeps a committed settled timer byte-for-byte and gives each continuation its own timer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-frame-continuation-'));
    trackRoot(root);
    const now = { value: STARTED_AT + 30_000 };
    const oldTimer = settledTimerMessage();
    await migrateStore(
      root,
      [{ id: CHAT_ID, messages: longSettledTurn() }],
      {
        [CHAT_ID]: completedRuntime(),
      },
      CHAT_ID,
    );
    const repo = repository(root);
    const service = createService(repo, () => now.value);
    trackService(service);
    const originalTimerLine = transcriptLineForMessage(
      readFileSync(transcriptPath(root), 'utf8'),
      oldTimer.id,
    );
    const page = await repo.page(SCOPE, CHAT_ID);
    expect(page.messages.map((row) => row.id)).not.toContain(oldTimer.id);

    const ingest = (mutationId: string, data: Record<string, unknown>) =>
      service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId,
        data,
      });
    let lifecycleSequence = 0;
    const wakeLifecycle = (type: 'start' | 'end', turnId: string) => {
      const fields = {
        sequence: ++lifecycleSequence,
        turnId,
        atMs: now.value,
      };
      const chat = { ...SCOPE, chatId: CHAT_ID };
      return observeTurn(
        service,
        type === 'start' ? turnStarted(chat, fields) : turnEnded(chat, fields),
      );
    };
    const firstWakeAt = now.value;
    await wakeLifecycle('start', 'wake-one');
    await ingest('wake-one', {
      type: 'assistant',
      uuid: 'wake-one',
      message: { id: 'wake-one', content: [{ type: 'text', text: 'Woke' }] },
    });

    now.value += 3_000;
    const firstCompletionAt = now.value;
    await wakeLifecycle('end', 'wake-one');
    await ingest('result-one', {
      type: 'result',
      subtype: 'success',
      result: 'Done',
    });

    now.value += 7_000;
    const secondWakeAt = now.value;
    await wakeLifecycle('start', 'wake-two');
    await ingest('wake-two', {
      type: 'assistant',
      uuid: 'wake-two',
      message: {
        id: 'wake-two',
        content: [{ type: 'text', text: 'Woke again' }],
      },
    });
    now.value += 3_000;
    const secondCompletionAt = now.value;
    await wakeLifecycle('end', 'wake-two');
    await ingest('result-two', {
      type: 'result',
      subtype: 'success',
      result: 'Done again',
    });

    const messages = await messagesFor(repo, CHAT_ID);
    expect(timerRows(messages)).toHaveLength(3);
    expect(findTimer(messages, oldTimer.id)).toEqual(oldTimer.blocks[0]);
    const [, firstContinuation, secondContinuation] = timerRows(messages);
    expect(firstContinuation?.id).toBe('wake-one:timer');
    expect(findTimer(messages, 'wake-one:timer')).toMatchObject({
      type: 'turn_timer',
      startedAt: firstWakeAt,
      completedAt: firstCompletionAt,
    });
    expect(secondContinuation?.id).toBe('wake-two:timer');
    expect(findTimer(messages, 'wake-two:timer')).toMatchObject({
      type: 'turn_timer',
      startedAt: secondWakeAt,
      completedAt: secondCompletionAt,
    });
    expect(
      transcriptLineForMessage(
        readFileSync(transcriptPath(root), 'utf8'),
        oldTimer.id,
      ),
    ).toBe(originalTimerLine);
  });
});
