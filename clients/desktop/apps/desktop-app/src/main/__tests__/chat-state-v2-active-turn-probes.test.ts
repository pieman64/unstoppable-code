import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type { TurnStarted } from '@canopy/protocol/canopy-core';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as ChatQueueServiceModule from '../services/chat-queue-service';
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCoreMutation,
} from '@canopy/desktop-shared/types';
import {
  initModelAliases,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  TranscriptStreamStore,
  type ChatTranscriptLog,
} from '../lib/chat-transcript-log';
import {
  ChatQueueService,
  getChatQueueService,
} from '../services/chat-queue-service';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatTurnStateHandoff } from '../services/chat-turn-state-handoff';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

jest.mock('../observability', () => ({
  getObservabilityService: (): { observeSteeringInput: jest.Mock } => ({
    observeSteeringInput: jest.fn(),
  }),
}));
jest.mock('../services/chat-queue-service', () => {
  const actual = jest.requireActual<typeof ChatQueueServiceModule>(
    '../services/chat-queue-service',
  );
  return { ...actual, getChatQueueService: jest.fn() };
});
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): { getState: () => undefined } => ({
    getState: (): undefined => undefined,
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../agents/claude-turn-lifecycle', () => ({
  requestBackgroundSnapshot: (): void => undefined,
}));

jest.setTimeout(60_000);

const SCOPE = {
  projectId: 'workspace-active-probes',
  worktreeId: 'active-probes',
};
const CHAT_ID = 'active-turn-chat';
const TURN_ID = 'active-turn-user';
const FIRST_ROW_ID = 'active-turn-assistant-0';
const ROW_COUNT = 2_048;
const NOW = 1_791_072_000_000;
const PER_EVENT_BUDGET = 20;

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

/** The turn's canonical start, as the Cursor adapter reports it. */
function turnStarted(): TurnStarted {
  return {
    version: 1,
    provider: 'cursor',
    ...SCOPE,
    chatId: CHAT_ID,
    sequence: 1,
    eventId: 'active-turn-started',
    observedAtMs: NOW,
    turnId: 'active-turn',
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds: [TURN_ID],
    providerUserMessageUuids: [],
    type: 'TurnStarted',
    phase: 'start',
    startedAtMs: NOW,
  };
}

async function flushTurnState(service: ChatStateService): Promise<void> {
  const handoff: unknown = Reflect.get(service, 'turnHandoff');
  if (!(handoff instanceof ChatTurnStateHandoff))
    throw new Error('Chat state service did not create its turn handoff');
  await handoff.flushAll();
}

function fixtureRow(index: number): PersistedChatMessage {
  return {
    id: `active-turn-assistant-${String(index)}`,
    role: 'assistant',
    timestamp: NOW + index,
    blocks: [{ type: 'text', text: `active row ${String(index)}` }],
  };
}

function pathText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.pathname;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

describe('ChatStateV2 active-turn filesystem probes', () => {
  it('keeps one active-row change within a constant committed-locator and load budget', async () => {
    initModelAliases({});
    initOllamaModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    jest.mocked(getChatQueueService).mockReturnValue(new ChatQueueService());

    const testStartedAt = performance.now();
    const directory = mkdtempSync(join(tmpdir(), 'canopy-active-probes-'));
    const paths = {
      tabs: join(directory, 'chats.json'),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.jsonl'),
    };
    let repositoryId = 0;
    const repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
      now: (): number => NOW,
      createId: (): string => `repository-event-${String(++repositoryId)}`,
    });
    let eventId = 0;
    const target = new ChatStateService({
      repository,
      now: (): number => NOW,
      createId: (): string => `event-${String(++eventId)}`,
      dispatch: (): Promise<void> => Promise.resolve(),
      onInputPickup: (): Promise<void> => Promise.resolve(),
      authorizeSend: (): Promise<void> => Promise.resolve(),
      cleanupSession: (): Promise<void> => Promise.resolve(),
      recordDiagnostic: jest.fn(),
    });
    getChatTurnOwnership().resetScopesForTests();
    resetChatStateServiceForTests(target);

    let readFileSpy: jest.SpyInstance | undefined;
    let statSpy: jest.SpyInstance | undefined;
    let loadDescriptor: PropertyDescriptor | undefined;
    let loadSpy: jest.Mock<Promise<unknown>, [string, boolean?]> | undefined;
    let activeRowCount = 0;
    let locatorReadFileCalls = 0;
    let locatorDirectoryStatCalls = 0;
    let transcriptLoadCalls = 0;
    let eventMs = 0;
    let eventApplied = false;

    try {
      const created = await target.command(
        envelope('create-active-turn', {
          type: 'chat.create_tab',
          tabId: CHAT_ID,
          title: 'Active turn filesystem probe',
          providerType: 'cursor',
          model: 'cursor-auto',
        }),
      );
      const started = await target.command(
        envelope('send-active-turn', {
          type: 'chat.send_message',
          chatId: CHAT_ID,
          userMessageId: TURN_ID,
          text: 'Generate a long deterministic active turn',
        }),
      );
      target.observeTurnLifecycle(turnStarted());
      await flushTurnState(target);
      const firstRowApplied = await target.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: TURN_ID,
        mutationId: 'first-active-row',
        providerType: 'cursor',
        data: {
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          messageId: FIRST_ROW_ID,
          timestamp: NOW,
          revision: 1,
          patches: [
            {
              index: 0,
              block: { type: 'text', text: 'active row 0' },
            },
          ],
        },
      });
      const remainingRows: ChatCoreMutation[] = Array.from(
        { length: ROW_COUNT - 1 },
        (_, offset): ChatCoreMutation => ({
          type: 'message.upserted',
          chatId: CHAT_ID,
          message: fixtureRow(offset + 1),
        }),
      );
      await repository.transact(SCOPE, remainingRows, {
        source: 'provider',
        chatIds: [CHAT_ID],
        mutationId: 'seed-active-turn-rows',
      });

      const storage = ChatStorageV2.fromLegacyPaths(paths);
      const canonical = await repository.getState(SCOPE, {
        chatIds: [CHAT_ID],
      });
      expect(created.outcome).toBe('applied');
      expect(started.outcome).toBe('applied');
      expect(firstRowApplied).toBe(true);
      expect(canonical.runtimeByChatId[CHAT_ID]).toMatchObject({
        status: 'streaming',
        activeTurn: { userMessageId: TURN_ID },
      });

      const locatorDirectory = join(
        storage.directory,
        'transcripts',
        'message-index',
        CHAT_ID,
      );
      const fsPromises =
        jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
      const originalReadFile = fsPromises.readFile;
      const originalStat = fsPromises.stat;
      readFileSpy = jest
        .spyOn(fsPromises, 'readFile')
        .mockImplementation(async (...args) => {
          const file = pathText(args[0]);
          if (
            file?.startsWith(`${locatorDirectory}${sep}`) &&
            file.endsWith('.json')
          )
            locatorReadFileCalls += 1;
          return originalReadFile(...args);
        });
      statSpy = jest
        .spyOn(fsPromises, 'stat')
        .mockImplementation(async (...args) => {
          if (pathText(args[0]) === locatorDirectory)
            locatorDirectoryStatCalls += 1;
          return originalStat(...args);
        });

      // `load` is private and deliberately has no production test hook. Wrap
      // the base store's configurable prototype descriptor, which the chat
      // log inherits, for this measured window,
      // preserving the original function and restoring the exact descriptor.
      loadDescriptor = Object.getOwnPropertyDescriptor(
        TranscriptStreamStore.prototype,
        'load',
      );
      const originalLoad: unknown = loadDescriptor?.value;
      if (!loadDescriptor || typeof originalLoad !== 'function')
        throw new Error(
          'ChatTranscriptLog.load prototype method is unavailable',
        );
      loadSpy = jest.fn(function (
        this: ChatTranscriptLog,
        chatId: string,
        rebuildLocators?: boolean,
      ): Promise<unknown> {
        transcriptLoadCalls += 1;
        return Promise.resolve(
          Reflect.apply(originalLoad, this, [chatId, rebuildLocators]),
        );
      });
      Object.defineProperty(TranscriptStreamStore.prototype, 'load', {
        ...loadDescriptor,
        value: loadSpy,
      });

      const changedRow = fixtureRow(ROW_COUNT - 1);
      const eventStartedAt = performance.now();
      eventApplied = await target.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: TURN_ID,
        mutationId: 'change-one-active-row',
        providerType: 'cursor',
        data: {
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          messageId: changedRow.id,
          timestamp: changedRow.timestamp,
          revision: 1,
          patches: [
            {
              index: 0,
              block: { type: 'text', text: 'one changed active row' },
            },
          ],
        },
      });
      eventMs = performance.now() - eventStartedAt;
      const rowChangeEvent = {
        locatorReadFileCalls,
        locatorDirectoryStatCalls,
        transcriptLoadCalls,
        eventMs,
      };
      // The delta journal holds the turn's active rows in the writer, not in
      // `<chat>.active.json`, so count them through the repository, after the
      // measured window so the read neither warms nor inflates its counts.
      activeRowCount = await repository.consumeTranscript(
        SCOPE,
        CHAT_ID,
        false,
        async (messages): Promise<number> => {
          let count = 0;
          for await (const message of messages)
            if (message.id.startsWith('active-turn-assistant-')) count += 1;
          return count;
        },
      );
      const lastRow = await repository.locateMessage(
        SCOPE,
        CHAT_ID,
        changedRow.id,
      );

      // Log the evidence before budget assertions so a red run records the
      // exact real-filesystem counts, rather than only Jest's first failure.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          activeRowCount,
          lastRow,
          rowChangeEvent,
          totalMs: performance.now() - testStartedAt,
        }),
      );

      expect(eventApplied).toBe(true);
      expect(rowChangeEvent.locatorReadFileCalls).toBeLessThanOrEqual(
        PER_EVENT_BUDGET,
      );
      expect(rowChangeEvent.locatorDirectoryStatCalls).toBeLessThanOrEqual(
        PER_EVENT_BUDGET,
      );
      expect(rowChangeEvent.transcriptLoadCalls).toBeLessThanOrEqual(
        PER_EVENT_BUDGET,
      );
      expect(eventMs).toBeLessThan(60_000);
      expect(lastRow).toBe('active');
      expect(activeRowCount).toBeGreaterThanOrEqual(2_000);
    } finally {
      resetChatStateServiceForTests();
      readFileSpy?.mockRestore();
      statSpy?.mockRestore();
      if (loadDescriptor)
        Object.defineProperty(
          TranscriptStreamStore.prototype,
          'load',
          loadDescriptor,
        );
      await repository.drainAll();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
