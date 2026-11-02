import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import type {
  ArchivedChatEntry,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../chat-state-service';
import { ChatTurnStateHandoff } from '../chat-turn-state-handoff';
import { getChatTurnOwnership } from '../chat-turn-ownership';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import { getChatQueueService } from '../chat-queue-service';
import { subscribePortalCanonicalTurnTimers } from '../../portal/canonical-turn-timer-projection';
import * as mainProcessLogging from '../../lib/main-process-logging';

const SCOPE = {
  projectId: 'canonical-project',
  worktreeId: 'canonical-worktree',
};
const CHAT_ID = 'canonical-chat';
const ANCHOR = 'canonical-message';
const TURN = 'canonical-turn';

jest.mock('../../agents/claude-turn-lifecycle', () => ({
  requestBackgroundSnapshot: (): void => undefined,
}));

function lifecycle(
  sequence: number,
  type: 'TurnStarted' | 'TurnEnded',
  anchor = ANCHOR,
  turnId = TURN,
  outcome: 'completed' | 'cancelled' = 'completed',
): Extract<ChatTurnLifecycleEvent, { type: 'TurnStarted' | 'TurnEnded' }> {
  const shared = {
    version: 1 as const,
    provider: 'claude' as const,
    ...SCOPE,
    chatId: CHAT_ID,
    sequence,
    eventId: `canonical-${type}-${sequence}`,
    turnId,
    origin: 'user' as const,
    binding: 'bound' as const,
    submissionIds: [],
    userMessageIds: [anchor],
    providerUserMessageUuids: [],
  };
  return type === 'TurnStarted'
    ? {
        ...shared,
        observedAtMs: 1_000,
        type,
        phase: 'start',
        startedAtMs: 1_000,
      }
    : {
        ...shared,
        observedAtMs: 1_500,
        type,
        endedAtMs: 1_500,
        outcome,
        source: 'result',
      };
}

describe('canonical root turns in the chat state service', () => {
  let directory: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;
  const options = {
    inputSession: (): Promise<undefined> => Promise.resolve(undefined),
    now: (): number => 2_000,
    recordDiagnostic: (): void => undefined,
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'canopy-canonical-root-turn-'));
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    service = new ChatStateService({
      repository,
      inputSession: (): Promise<undefined> => Promise.resolve(undefined),
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
    });
    getChatTurnOwnership().resetScopesForTests();
    resetChatStateServiceForTests(service);
    getChatQueueService().resetForTests();
    await service.command({
      schemaVersion: 1,
      commandId: 'create-canonical-chat',
      ...SCOPE,
      command: {
        type: 'chat.create_tab',
        tabId: CHAT_ID,
        title: 'Canonical turn',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      },
    });
  });

  afterEach(async () => {
    resetChatStateServiceForTests();
    getChatQueueService().resetForTests();
    await repository.drainAll();
    rmSync(directory, { recursive: true, force: true });
  });

  async function flushTurnState(): Promise<void> {
    const handoff: unknown = Reflect.get(service, 'turnHandoff');
    if (!(handoff instanceof ChatTurnStateHandoff))
      throw new Error('Chat state service did not create its turn handoff');
    await handoff.flushAll();
  }

  async function chat(): Promise<{
    messages: PersistedChatMessage[];
    status: string | undefined;
  }> {
    const state = await repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    return {
      messages:
        state.tabsFile.tabs.find((tab) => tab.id === CHAT_ID)?.messages ?? [],
      status: state.runtimeByChatId[CHAT_ID]?.status,
    };
  }

  function timers(messages: PersistedChatMessage[]): PersistedChatMessage[] {
    return messages.filter((message) =>
      message.blocks.some((block) => block.type === 'turn_timer'),
    );
  }

  async function prompt(): Promise<void> {
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'canonical-prompt',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: ANCHOR,
        canopy_persisted_messages: [
          {
            id: ANCHOR,
            role: 'user',
            timestamp: 900,
            blocks: [{ type: 'text', text: 'Investigate' }],
          },
        ],
      },
    });
  }

  describe('committed approval pauses', () => {
    async function pause(
      type: 'PauseOpened' | 'PauseClosed',
      ownerId: string,
      atMs: number,
      ownerKind: 'approval' | 'question' = 'approval',
    ): Promise<void> {
      await service.commitTurnPause({
        ...SCOPE,
        chatId: CHAT_ID,
        type,
        ownerId,
        ownerKind,
        atMs,
      });
    }

    async function timer(): Promise<
      Extract<PersistedChatMessage['blocks'][number], { type: 'turn_timer' }>
    > {
      const rows = timers((await chat()).messages);
      expect(rows).toHaveLength(1);
      const block = rows[0]?.blocks.find(
        (block) => block.type === 'turn_timer',
      );
      if (!block || block.type !== 'turn_timer')
        throw new Error('Missing canonical timer');
      return block;
    }

    beforeEach(async () => {
      await prompt();
      service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    });

    it('commits three sequential waits without provider content, retaining one timer and original start', async () => {
      for (let step = 0; step < 3; step++) {
        const owner = `approval-${step}`;
        const openedAt = 1_100 + step * 400;
        await pause('PauseOpened', owner, openedAt);
        expect(await timer()).toMatchObject({
          turnId: TURN,
          startedAt: 1_000,
          pausedAt: openedAt,
          resumedAt: null,
        });
        expect((await timer()).accumulatedPausedDurationMs ?? 0).toBe(
          step * 200,
        );
        await pause('PauseClosed', owner, openedAt + 200);
        expect(await timer()).toMatchObject({
          turnId: TURN,
          startedAt: 1_000,
          resumedAt: openedAt + 200,
          accumulatedPausedDurationMs: (step + 1) * 200,
        });
        // Replayed observations and a delayed content transaction must not
        // reapply a closed interval or replace this logical turn's timer.
        await pause('PauseClosed', owner, openedAt + 200);
        await pause('PauseOpened', owner, openedAt);
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: ANCHOR,
          mutationId: `approval-content-${step}`,
          data: {
            type: 'assistant',
            message: {
              id: `approval-message-${step}`,
              content: [{ type: 'text', text: 'Continuing' }],
            },
          },
        });
        expect(await timer()).toMatchObject({
          startedAt: 1_000,
          resumedAt: openedAt + 200,
          accumulatedPausedDurationMs: (step + 1) * 200,
        });
      }
      const ended = lifecycle(2, 'TurnEnded');
      if (ended.type !== 'TurnEnded')
        throw new Error('Expected terminal event');
      service.observeTurnLifecycle({
        ...ended,
        observedAtMs: 2_300,
        endedAtMs: 2_300,
      });
      await flushTurnState();
      const completed = await timer();
      expect(completed).toMatchObject({
        startedAt: 1_000,
        completedAt: 2_300,
        accumulatedPausedDurationMs: 600,
      });
      expect(
        (completed.completedAt ?? 0) -
          (completed.startedAt ?? 0) -
          (completed.accumulatedPausedDurationMs ?? 0),
      ).toBe(700);
    });

    it('releases only its owner and counts the union of overlapping waits', async () => {
      await pause('PauseOpened', 'approval', 1_100);
      await pause('PauseOpened', 'question', 1_200, 'question');
      await pause('PauseClosed', 'approval', 1_300);
      expect(await timer()).toMatchObject({ pausedAt: 1_100, resumedAt: null });
      await pause('PauseClosed', 'question', 1_400, 'question');
      expect(await timer()).toMatchObject({
        resumedAt: 1_400,
        accumulatedPausedDurationMs: 300,
      });
    });

    it('does not reopen a terminal turn when an answer or observation arrives late', async () => {
      await pause('PauseOpened', 'approval', 1_100);
      service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
      await flushTurnState();
      const completed = await timer();
      await pause('PauseClosed', 'approval', 1_600);
      await pause('PauseOpened', 'approval', 1_700);
      expect(await timer()).toEqual(completed);
    });

    it('refuses a pause whose canonical timer cannot be committed', async () => {
      await flushTurnState();
      await repository.transactWith(
        SCOPE,
        () => [{ type: 'tab.removed', tabId: CHAT_ID }],
        { source: 'migration' },
      );
      await expect(pause('PauseOpened', 'approval', 1_100)).rejects.toThrow(
        'Canonical turn pause could not be committed',
      );
    });

    it('propagates a transaction failure and can durably release its queued owner', async () => {
      await flushTurnState();
      jest
        .spyOn(repository, 'transactWith')
        .mockRejectedValueOnce(new Error('pause commit failed'));
      await expect(pause('PauseOpened', 'approval', 1_100)).rejects.toThrow(
        'pause commit failed',
      );
      await pause('PauseClosed', 'approval', 1_300);
      expect(await timer()).toMatchObject({
        startedAt: 1_000,
        resumedAt: 1_300,
        accumulatedPausedDurationMs: 200,
      });
    });
  });

  describe('an ended turn whose frames trail the next start', () => {
    const NEXT = 'next-message';
    const NEXT_TURN = 'next-turn';

    function frame(
      turnUserMessageId: string,
      mutationId: string,
      data: Record<string, unknown>,
    ): Parameters<ChatStateService['ingestProviderEvent']>[0] {
      return {
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId,
        mutationId,
        data: { ...data, canopy_turn_user_message_id: turnUserMessageId },
      };
    }

    function reply(
      turnUserMessageId: string,
      id: string,
      text: string,
    ): ReturnType<typeof frame> {
      return frame(turnUserMessageId, id, {
        type: 'assistant',
        uuid: id,
        message: { id: `${id}-message`, content: [{ type: 'text', text }] },
      });
    }

    function result(
      turnUserMessageId: string,
      id: string,
    ): ReturnType<typeof frame> {
      return frame(turnUserMessageId, id, {
        type: 'result',
        is_error: false,
        result: 'Done',
      });
    }

    /**
     * Lifecycle is published when a frame is received and frames are admitted
     * later, so the next turn's start can commit before this turn's last frames.
     */
    async function endWhileNextStarts(): Promise<void> {
      await prompt();
      service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
      await flushTurnState();
      service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
      service.observeTurnLifecycle(
        lifecycle(3, 'TurnStarted', NEXT, NEXT_TURN),
      );
      await flushTurnState();
    }

    it("keeps the ended turn's trailing output and result", async () => {
      await endWhileNextStarts();

      await expect(
        service.ingestProviderEvent(
          reply(ANCHOR, 'trailing', 'Trailing output'),
        ),
      ).resolves.toBe(true);
      await expect(
        service.ingestProviderEvent(result(ANCHOR, 'trailing-result')),
      ).resolves.toBe(true);

      const state = await chat();
      expect(JSON.stringify(state.messages)).toContain('Trailing output');
      // The next turn keeps running.
      expect(state.status).toBe('streaming');
    });

    it("records the trailing result as the ended turn's, not the next turn's", async () => {
      await endWhileNextStarts();
      await service.ingestProviderEvent(result(ANCHOR, 'trailing-result'));
      service.observeTurnLifecycle(lifecycle(4, 'TurnEnded', NEXT, NEXT_TURN));
      await flushTurnState();

      // The next turn's own frames still trail its end until its terminal.
      await expect(
        service.ingestProviderEvent(
          reply(NEXT, 'next-trailing', 'Next output'),
        ),
      ).resolves.toBe(true);
      await expect(
        service.ingestProviderEvent(result(NEXT, 'next-result')),
      ).resolves.toBe(true);
      expect(JSON.stringify((await chat()).messages)).toContain('Next output');
    });
  });

  describe('delayed root terminal after an autonomous wake', () => {
    function reducedTurnIds(): unknown {
      const reduced: unknown = Reflect.get(service, 'reducedRootTerminals');
      if (!(reduced instanceof Map))
        throw new Error('Missing reduced terminal state');
      return reduced.get(
        JSON.stringify([SCOPE.projectId, SCOPE.worktreeId, CHAT_ID]),
      );
    }

    async function terminal(
      mutationId = 'delayed-original-terminal',
      executionId?: string,
    ): Promise<boolean> {
      return service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ANCHOR,
        mutationId,
        data: {
          type: 'result',
          subtype: 'success',
          result: 'Original done',
          canopy_turn_user_message_id: ANCHOR,
          ...(executionId ? { canopy_execution_turn_id: executionId } : {}),
        },
      });
    }

    function execution(
      sequence: number,
      type: 'TurnStarted' | 'TurnEnded',
      id: string,
      origin: 'autonomous' | 'restart' = 'autonomous',
      userMessageIds: string[] = [],
    ): void {
      service.observeTurnLifecycle({
        ...lifecycle(sequence, type, userMessageIds[0] ?? ANCHOR, id),
        origin,
        binding: userMessageIds.length > 0 ? 'bound' : 'unbound',
        userMessageIds,
      });
    }

    async function originalTurn(
      outcome: 'completed' | 'cancelled' = 'completed',
    ): Promise<void> {
      await prompt();
      service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
      await flushTurnState();
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ANCHOR,
        mutationId: 'original-init',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: 'session',
          canopy_turn_user_message_id: ANCHOR,
        },
      });
      await reply('original-output', 'Original output');
      service.observeTurnLifecycle(
        lifecycle(2, 'TurnEnded', ANCHOR, TURN, outcome),
      );
      await flushTurnState();
    }

    async function wakeOutput(
      id = 'wake-output',
      ownerId = ANCHOR,
    ): Promise<boolean> {
      return service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ownerId,
        mutationId: id,
        data: {
          type: 'assistant',
          uuid: id,
          message: {
            id: `${id}-message`,
            content: [{ type: 'text', text: 'Wake completed' }],
          },
        },
      });
    }

    it.each(['before', 'during', 'after'])(
      'keeps wake output admissible when the original terminal arrives %s the wake',
      async (order) => {
        await originalTurn();
        if (order === 'before') await terminal();

        execution(3, 'TurnStarted', 'wake-turn');
        await flushTurnState();
        if (order === 'during') await terminal();

        execution(4, 'TurnEnded', 'wake-turn');
        await flushTurnState();
        if (order === 'after') await terminal();

        expect(reducedTurnIds()).toEqual(new Set([TURN]));
        const admitted = await wakeOutput();
        const state = await chat();
        expect(admitted).toBe(true);
        expect(state.status).toBe('completed');
        expect(JSON.stringify(state.messages)).toContain('Wake completed');
        expect(timers(state.messages)).toEqual([
          expect.objectContaining({
            id: `${TURN}:timer`,
            blocks: [expect.objectContaining({ completedAt: 1_500 })],
          }),
          expect.objectContaining({
            id: 'wake-turn:timer',
            blocks: [expect.objectContaining({ completedAt: 1_500 })],
          }),
        ]);
      },
    );

    it('keeps the newest of multiple ended wakes open after duplicate old terminals', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'first-wake');
      execution(4, 'TurnEnded', 'first-wake');
      execution(5, 'TurnStarted', 'second-wake');
      execution(6, 'TurnEnded', 'second-wake');
      await flushTurnState();

      expect(await terminal()).toBe(true);
      await terminal('duplicate-original-terminal');
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages).map((message) => message.id)).toEqual([
        `${TURN}:timer`,
        'first-wake:timer',
        'second-wake:timer',
      ]);
      expect(
        timers(state.messages).every((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'turn_timer' && block.completedAt !== null,
          ),
        ),
      ).toBe(true);
    });

    it('does not settle a bound execution when an explicit marker contradicts the input tag', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'other-root', 'restart', ['other-input']);
      execution(4, 'TurnEnded', 'other-root', 'restart', ['other-input']);
      await flushTurnState();

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await terminal('contradictory-terminal', 'other-root');
        expect(warning).toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.objectContaining({ mutationId: 'contradictory-terminal' }),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toBeUndefined();
      expect(await wakeOutput('other-output', 'other-input')).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it.each([
      ['during', []],
      ['after', []],
      ['after', ['picked-up-input']],
    ])(
      'fences a marked Codex provider-owned wake whose own terminal carries the anchor tag %s its end (picked up %j)',
      async (order, pickedUp) => {
        await originalTurn();
        await terminal();
        execution(3, 'TurnStarted', 'wake-turn', 'autonomous', pickedUp);
        await flushTurnState();
        const outputOwner = pickedUp[0] ?? ANCHOR;
        expect(await wakeOutput('wake-output', outputOwner)).toBe(true);
        const wakeTerminal = (): Promise<boolean> =>
          service.ingestProviderEvent({
            ...SCOPE,
            chatId: CHAT_ID,
            // A provider-owned run is tagged with its execution anchor.
            turnUserMessageId: ANCHOR,
            mutationId: 'wake-own-terminal',
            data: {
              type: 'codex',
              canopy_turn_user_message_id: ANCHOR,
              canopy_execution_turn_id: 'wake-turn',
              event: {
                type: 'turn.completed',
                thread_id: 'session',
                turn_id: 'wake-turn',
              },
            },
          });

        const warning = jest
          .spyOn(mainProcessLogging, 'logMainProcessWarn')
          .mockImplementation((): void => undefined);
        try {
          if (order === 'during') expect(await wakeTerminal()).toBe(true);
          execution(4, 'TurnEnded', 'wake-turn', 'autonomous', pickedUp);
          await flushTurnState();
          if (order === 'after') expect(await wakeTerminal()).toBe(true);
          expect(warning).not.toHaveBeenCalledWith(
            '[chat-state] Root terminal attribution ambiguous',
            expect.anything(),
          );
        } finally {
          warning.mockRestore();
        }
        expect(reducedTurnIds()).toEqual(new Set([TURN, 'wake-turn']));
        expect(await wakeOutput('late-wake-output', outputOwner)).toBe(false);
        const state = await chat();
        expect(state.status).toBe('completed');
        expect(
          JSON.stringify(state.messages).split('Wake completed'),
        ).toHaveLength(2);
        expect(timers(state.messages).map((message) => message.id)).toEqual([
          `${TURN}:timer`,
          'wake-turn:timer',
        ]);
      },
    );

    it('keeps the resumed root open when a cancelled root terminal arrives late', async () => {
      await originalTurn('cancelled');
      execution(3, 'TurnStarted', 'resumed-root', 'restart', [ANCHOR]);
      execution(4, 'TurnEnded', 'resumed-root', 'restart', [ANCHOR]);
      await flushTurnState();

      expect(await terminal('cancelled-root-terminal', TURN)).toBe(true);
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages).map((message) => message.id)).toEqual([
        `${TURN}:timer`,
        'resumed-root:timer',
      ]);
    });

    it('records reused input ownership as ambiguous without an execution marker', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'reused-root', 'restart', [ANCHOR]);
      execution(4, 'TurnEnded', 'reused-root', 'restart', [ANCHOR]);
      await flushTurnState();

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await terminal('ambiguous-reused-terminal');
        expect(warning).toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.objectContaining({ mutationId: 'ambiguous-reused-terminal' }),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toBeUndefined();
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it('does not infer unique ownership from incomplete timers after reload', async () => {
      await prompt();
      service.observeTurnLifecycle({
        ...lifecycle(1, 'TurnStarted'),
        userMessageIds: [ANCHOR, 'reused-secondary'],
      });
      service.observeTurnLifecycle({
        ...lifecycle(2, 'TurnEnded'),
        userMessageIds: [ANCHOR, 'reused-secondary'],
      });
      await flushTurnState();
      execution(3, 'TurnStarted', 'reused-root', 'restart', [
        'reused-secondary',
      ]);
      execution(4, 'TurnEnded', 'reused-root', 'restart', ['reused-secondary']);
      await flushTurnState();
      service = new ChatStateService({ repository, ...options });
      resetChatStateServiceForTests(service);

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: 'reused-secondary',
          mutationId: 'reloaded-secondary-terminal',
          data: {
            type: 'result',
            result: 'Original done',
            canopy_turn_user_message_id: 'reused-secondary',
          },
        });
        expect(warning).toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.objectContaining({
            mutationId: 'reloaded-secondary-terminal',
          }),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toBeUndefined();
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: 'reused-secondary',
        mutationId: 'marked-reloaded-secondary-terminal',
        data: {
          type: 'result',
          result: 'Original done',
          canopy_turn_user_message_id: 'reused-secondary',
          canopy_execution_turn_id: TURN,
        },
      });
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput('reused-root-output', 'reused-secondary')).toBe(
        true,
      );
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it('loads paged-out ownership before matching a reused secondary input', async () => {
      await prompt();
      service.observeTurnLifecycle({
        ...lifecycle(1, 'TurnStarted'),
        userMessageIds: [ANCHOR, 'paged-secondary'],
      });
      service.observeTurnLifecycle({
        ...lifecycle(2, 'TurnEnded'),
        userMessageIds: [ANCHOR, 'paged-secondary'],
      });
      await flushTurnState();
      let sequence = 3;
      for (let index = 0; index < 65; index++) {
        execution(sequence++, 'TurnStarted', `past-wake-${index}`);
        execution(sequence++, 'TurnEnded', `past-wake-${index}`);
      }
      await flushTurnState();
      await repository.transactWith(
        SCOPE,
        () =>
          Array.from({ length: 501 }, (_, index) => ({
            type: 'message.upserted' as const,
            chatId: CHAT_ID,
            message: {
              id: `history-padding-${index}`,
              role: 'system' as const,
              timestamp: 1_600 + index,
              blocks: [{ type: 'text' as const, text: 'History' }],
            },
          })),
        { source: 'migration', mutationId: 'page-original-owner' },
      );
      execution(sequence++, 'TurnStarted', 'reused-root', 'restart', [
        'paged-secondary',
      ]);
      execution(sequence, 'TurnEnded', 'reused-root', 'restart', [
        'paged-secondary',
      ]);
      await flushTurnState();
      const window = await repository.getState(SCOPE, { chatIds: [CHAT_ID] });
      expect(
        window.tabsFile.tabs
          .find((tab) => tab.id === CHAT_ID)
          ?.messages.some((message) => message.id === `${TURN}:timer`),
      ).toBe(false);

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: 'paged-secondary',
          mutationId: 'paged-secondary-terminal',
          data: {
            type: 'result',
            result: 'Original done',
            canopy_turn_user_message_id: 'paged-secondary',
          },
        });
        expect(warning).toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.objectContaining({ mutationId: 'paged-secondary-terminal' }),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toBeUndefined();
      expect(await wakeOutput('paged-root-output', 'paged-secondary')).toBe(
        true,
      );
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(67);
    });

    it('retains a reduced terminal fence through receipt hydration', async () => {
      await originalTurn();
      service = new ChatStateService({ repository, ...options });
      resetChatStateServiceForTests(service);
      await terminal('reloaded-original-terminal', TURN);
      expect(reducedTurnIds()).toEqual(new Set([TURN]));

      service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
      await flushTurnState();
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput('late-original-output')).toBe(false);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(timers(state.messages)).toHaveLength(1);
      expect(JSON.stringify(state.messages)).not.toContain('Wake completed');
    });

    it('uses a retained secondary input ID after a newer autonomous turn ends', async () => {
      await prompt();
      service.observeTurnLifecycle({
        ...lifecycle(1, 'TurnStarted'),
        userMessageIds: [ANCHOR, 'merged-steer'],
      });
      service.observeTurnLifecycle({
        ...lifecycle(2, 'TurnEnded'),
        userMessageIds: [ANCHOR, 'merged-steer'],
      });
      await flushTurnState();
      execution(3, 'TurnStarted', 'wake-turn');
      execution(4, 'TurnEnded', 'wake-turn');
      await flushTurnState();

      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: 'merged-steer',
        mutationId: 'steer-owned-terminal',
        data: {
          type: 'result',
          result: 'Steer completed',
          canopy_turn_user_message_id: 'merged-steer',
        },
      });
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it('settles a truly untagged legacy terminal with one execution', async () => {
      await originalTurn();
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'single-legacy-terminal',
        data: { type: 'result', result: 'Done' },
      });
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(timers(state.messages)).toEqual([
        expect.objectContaining({
          id: `${TURN}:timer`,
          blocks: [expect.objectContaining({ completedAt: 1_500 })],
        }),
      ]);
      expect(await wakeOutput('later-output')).toBe(false);
    });

    it('leaves two ended executions unsettled for an untagged legacy terminal', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'wake-turn');
      execution(4, 'TurnEnded', 'wake-turn');
      await flushTurnState();
      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          mutationId: 'ambiguous-legacy-terminal',
          data: { type: 'result', result: 'Unknown owner' },
        });
        expect(warning).toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.objectContaining({ mutationId: 'ambiguous-legacy-terminal' }),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toBeUndefined();
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it('keeps the wake open across a durable reload before the old terminal', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'wake-turn');
      execution(4, 'TurnEnded', 'wake-turn');
      await flushTurnState();
      service = new ChatStateService({ repository, ...options });
      resetChatStateServiceForTests(service);

      expect(await terminal()).toBe(true);
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });

    it('attributes a tagged unmarked terminal after reload with many older ended turns', async () => {
      await originalTurn();
      let sequence = 3;
      for (let index = 0; index < 65; index++) {
        execution(sequence++, 'TurnStarted', `earlier-wake-${index}`);
        execution(sequence++, 'TurnEnded', `earlier-wake-${index}`);
      }
      execution(sequence++, 'TurnStarted', 'codex-root', 'restart', [
        'codex-input',
      ]);
      execution(sequence, 'TurnEnded', 'codex-root', 'restart', [
        'codex-input',
      ]);
      await flushTurnState();
      expect(
        (await repository.getState(SCOPE, { chatIds: [CHAT_ID] })).tabsFile
          .tabs[0]?.rootTurnInputIds,
      ).toMatchObject({
        [TURN]: [ANCHOR],
        'earlier-wake-0': [],
        'codex-root': ['codex-input'],
      });
      const diagnostic = jest.fn();
      service = new ChatStateService({
        repository,
        ...options,
        recordDiagnostic: diagnostic,
      });
      resetChatStateServiceForTests(service);

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: 'codex-input',
          mutationId: 'codex-unmarked-terminal',
          data: {
            type: 'codex',
            canopy_turn_user_message_id: 'codex-input',
            event: {
              type: 'turn.completed',
              thread_id: 'session',
              turn_id: 'native-codex-turn',
            },
          },
        });
        expect(warning).not.toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.anything(),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toEqual(new Set(['codex-root']));
      expect(await wakeOutput('late-codex-output', 'codex-input')).toBe(false);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          chatEventDropReason: 'settled_turn_rejected',
        }),
      );
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).not.toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(67);
    });

    it('attributes a uniquely tagged unmarked terminal past turns that predate input retention', async () => {
      await originalTurn();
      let sequence = 3;
      for (let index = 0; index < 65; index++) {
        execution(sequence++, 'TurnStarted', `earlier-wake-${index}`);
        execution(sequence++, 'TurnEnded', `earlier-wake-${index}`);
      }
      await flushTurnState();
      // Turns that ended before input retention shipped have no entry.
      await repository.transactWith(
        SCOPE,
        () => [
          {
            type: 'tab.metadata_patched' as const,
            tabId: CHAT_ID,
            patch: { rootTurnInputIds: null },
          },
        ],
        { source: 'migration', mutationId: 'predate-input-retention' },
      );
      execution(sequence++, 'TurnStarted', 'codex-root', 'restart', [
        'codex-input',
      ]);
      execution(sequence, 'TurnEnded', 'codex-root', 'restart', [
        'codex-input',
      ]);
      await flushTurnState();
      const retained = (
        await repository.getState(SCOPE, { chatIds: [CHAT_ID] })
      ).tabsFile.tabs[0]?.rootTurnInputIds;
      expect(retained).toMatchObject({ 'codex-root': ['codex-input'] });
      expect(retained).not.toHaveProperty([TURN]);
      expect(retained).not.toHaveProperty(['earlier-wake-0']);
      service = new ChatStateService({ repository, ...options });
      resetChatStateServiceForTests(service);

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        await service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: 'codex-input',
          mutationId: 'codex-terminal-past-legacy-turns',
          data: {
            type: 'codex',
            canopy_turn_user_message_id: 'codex-input',
            event: {
              type: 'turn.completed',
              thread_id: 'session',
              turn_id: 'native-codex-turn',
            },
          },
        });
        expect(warning).not.toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.anything(),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toEqual(new Set(['codex-root']));
      expect(await wakeOutput('late-codex-output', 'codex-input')).toBe(false);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).not.toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(67);
    });

    it('fences a resumed Codex root by its execution ID when it shares the stopped input', async () => {
      await originalTurn('cancelled');
      execution(3, 'TurnStarted', 'resumed-root', 'restart', [ANCHOR]);
      execution(4, 'TurnEnded', 'resumed-root', 'restart', [ANCHOR]);
      await flushTurnState();
      const codexTerminal = (
        mutationId: string,
        executionId: string,
      ): Promise<boolean> =>
        service.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: ANCHOR,
          mutationId,
          data: {
            type: 'codex',
            canopy_turn_user_message_id: ANCHOR,
            canopy_execution_turn_id: executionId,
            event: {
              type: 'turn.completed',
              thread_id: 'session',
              turn_id: executionId,
            },
          },
        });

      const warning = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation((): void => undefined);
      try {
        expect(await codexTerminal('late-stopped-terminal', TURN)).toBe(true);
        expect(reducedTurnIds()).toEqual(new Set([TURN]));
        expect(await wakeOutput('resumed-output')).toBe(true);

        await codexTerminal('resumed-terminal', 'resumed-root');
        await codexTerminal('duplicate-resumed-terminal', 'resumed-root');
        expect(warning).not.toHaveBeenCalledWith(
          '[chat-state] Root terminal attribution ambiguous',
          expect.anything(),
        );
      } finally {
        warning.mockRestore();
      }
      expect(reducedTurnIds()).toEqual(new Set([TURN, 'resumed-root']));
      expect(await wakeOutput('late-resumed-output')).toBe(false);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(
        JSON.stringify(state.messages).split('Wake completed'),
      ).toHaveLength(2);
      expect(timers(state.messages).map((message) => message.id)).toEqual([
        `${TURN}:timer`,
        'resumed-root:timer',
      ]);
    });

    it('restores a committed root terminal fence after service reconstruction', async () => {
      await originalTurn();
      await terminal('durable-terminal');
      expect(reducedTurnIds()).toEqual(new Set([TURN]));
      const compatibility = await service.getCompatibilityTabs(SCOPE);
      await service.replaceCompatibilityTabs(
        SCOPE,
        {
          ...compatibility,
          tabs: compatibility.tabs.map(
            ({
              rootTurnInputIds: _inputIds,
              reducedRootTerminalTurnIds: _reducedTurnIds,
              ...tab
            }) => {
              void _inputIds;
              void _reducedTurnIds;
              return tab;
            },
          ),
        },
        { changedTabIds: [CHAT_ID] },
      );
      await repository.drainAll();
      repository = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(directory, 'chats.json'),
          archives: join(directory, 'archives.json'),
          journal: join(directory, 'journal.jsonl'),
        }),
      });
      service = new ChatStateService({ repository, ...options });
      resetChatStateServiceForTests(service);

      await terminal('duplicate-after-reconstruction');
      expect(await wakeOutput('late-after-reconstruction')).toBe(false);
      const state = await chat();
      expect(JSON.stringify(state.messages)).not.toContain('Wake completed');
      expect(state.status).toBe('completed');
      expect(timers(state.messages)).toHaveLength(1);
      expect(
        (await repository.getState(SCOPE, { chatIds: [CHAT_ID] })).tabsFile
          .tabs[0]?.reducedRootTerminalTurnIds,
      ).toEqual([TURN]);
    });

    it('does not attribute a child terminal to the open root', async () => {
      await originalTurn();
      execution(3, 'TurnStarted', 'wake-turn');
      execution(4, 'TurnEnded', 'wake-turn');
      await flushTurnState();
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ANCHOR,
        mutationId: 'child-result',
        data: {
          type: 'codex',
          canopy_turn_user_message_id: ANCHOR,
          event: {
            type: 'turn.completed',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
          },
        },
      });
      expect(reducedTurnIds()).toBeUndefined();
      expect(await wakeOutput()).toBe(true);
      const state = await chat();
      expect(state.status).toBe('completed');
      expect(JSON.stringify(state.messages)).toContain('Wake completed');
      expect(timers(state.messages)).toHaveLength(2);
    });
  });

  it('opens and closes the root timer from turn lifecycle, not from prompt or result events', async () => {
    await prompt();
    expect(timers((await chat()).messages)).toEqual([]);

    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    await flushTurnState();
    const started = await chat();
    expect(timers(started.messages)).toEqual([
      expect.objectContaining({
        id: `${TURN}:timer`,
        blocks: [expect.objectContaining({ turnId: TURN, completedAt: null })],
      }),
    ]);
    expect(started.status).toBe('streaming');

    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'canonical-reply',
      data: {
        type: 'assistant',
        uuid: 'canonical-reply',
        canopy_turn_user_message_id: ANCHOR,
        message: {
          id: 'canonical-reply-message',
          content: [{ type: 'text', text: 'Found it' }],
        },
      },
    });
    expect(JSON.stringify((await chat()).messages)).toContain('Found it');

    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'canonical-result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        canopy_turn_user_message_id: ANCHOR,
      },
    });
    const afterResult = await chat();
    expect(timers(afterResult.messages)).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ completedAt: null })],
      }),
    ]);
    expect(afterResult.status).toBe('streaming');

    service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
    await flushTurnState();
    const ended = await chat();
    expect(timers(ended.messages)).toEqual([
      expect.objectContaining({
        id: `${TURN}:timer`,
        blocks: [expect.objectContaining({ completedAt: 1_500 })],
      }),
    ]);
    expect(ended.status).toBe('completed');

    // A late root frame cannot revive the settled turn or reopen its timer.
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'canonical-late',
      data: {
        type: 'assistant',
        uuid: 'canonical-late',
        canopy_turn_user_message_id: ANCHOR,
        message: {
          id: 'canonical-late-message',
          content: [{ type: 'text', text: 'Late text' }],
        },
      },
    });
    const late = await chat();
    expect(late.status).toBe('completed');
    expect(timers(late.messages)).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ completedAt: 1_500 })],
      }),
    ]);
  });

  it('commits a turn whose anchor is not in the transcript, appending its timer', async () => {
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted', 'missing-anchor'));
    await flushTurnState();
    const started = await chat();
    expect(started.status).toBe('streaming');
    expect(timers(started.messages)).toEqual([
      expect.objectContaining({
        blocks: [expect.objectContaining({ userMessageId: 'missing-anchor' })],
      }),
    ]);
  });

  async function settleTurn(): Promise<void> {
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    await flushTurnState();
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'settle-reply',
      data: {
        type: 'assistant',
        uuid: 'settle-reply',
        canopy_turn_user_message_id: ANCHOR,
        message: {
          id: 'settle-reply-message',
          content: [{ type: 'text', text: 'Found it' }],
        },
      },
    });
    service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
    await flushTurnState();
  }

  it('acknowledges each commit with the timer rows it wrote', async () => {
    const missing: string[] = [];
    let carried = 0;
    const unsubscribe = service.onTurnStateCommitted((commit) => {
      for (const effect of commit.effects ?? []) {
        if (!('timerId' in effect)) continue;
        if (
          (commit.timerMessages ?? []).some((row) => row.id === effect.timerId)
        )
          carried += 1;
        else missing.push(`${effect.type}:${effect.timerId}`);
      }
    });
    try {
      await settleTurn();
      // A start that rides a provider event's commit.
      service.observeTurnLifecycle(
        lifecycle(3, 'TurnStarted', ANCHOR, 'second-turn'),
      );
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ANCHOR,
        mutationId: 'second-reply',
        data: {
          type: 'assistant',
          uuid: 'second-reply',
          canopy_turn_user_message_id: ANCHOR,
          message: {
            id: 'second-reply-message',
            content: [{ type: 'text', text: 'Again' }],
          },
        },
      });
      await flushTurnState();
    } finally {
      unsubscribe();
    }
    expect(missing).toEqual([]);
    expect(carried).toBeGreaterThanOrEqual(3);
  });

  it('publishes a turn timer to the Portal from each commit', async () => {
    const frames: unknown[] = [];
    const unsubscribe = subscribePortalCanonicalTurnTimers((event): void => {
      const payload: unknown = event.payload;
      if (typeof payload !== 'object' || payload === null) return;
      const message: unknown = Reflect.get(payload, 'message');
      if (typeof message !== 'object' || message === null) return;
      const messageId: unknown = Reflect.get(message, 'messageId');
      const status: unknown = Reflect.get(message, 'status');
      frames.push({ type: event.type, messageId, status });
    });
    try {
      await settleTurn();
    } finally {
      unsubscribe();
    }
    expect(frames).toEqual([
      {
        type: 'portal.chat.event',
        messageId: `${TURN}:timer`,
        status: 'streaming',
      },
      {
        type: 'portal.chat.event',
        messageId: `${TURN}:timer`,
        status: 'complete',
      },
    ]);
  });

  it("carries an Auto-routed turn's model chip on its live Portal timer (turn-state phase 43f)", async () => {
    await service.command({
      schemaVersion: 1,
      commandId: 'auto-route-canonical-turn',
      ...SCOPE,
      command: {
        type: 'chat.set_model',
        tabId: CHAT_ID,
        model: 'sonnet',
        providerType: 'claude',
        preserveModelSelectionMode: true,
        autoRoutedMessageId: ANCHOR,
      },
    });
    const routed: unknown[] = [];
    const unsubscribe = subscribePortalCanonicalTurnTimers((event): void => {
      const payload: unknown = event.payload;
      if (typeof payload !== 'object' || payload === null) return;
      const message: unknown = Reflect.get(payload, 'message');
      if (typeof message !== 'object' || message === null) return;
      const parts: unknown = Reflect.get(message, 'parts');
      if (!Array.isArray(parts)) return;
      const list: unknown[] = parts;
      for (const part of list) {
        if (typeof part !== 'object' || part === null) continue;
        const data: unknown = Reflect.get(part, 'data');
        if (typeof data === 'object' && data !== null)
          routed.push(Reflect.get(data, 'autoRoutedModel'));
      }
    });
    try {
      await settleTurn();
    } finally {
      unsubscribe();
    }
    expect(routed).toEqual(['sonnet', 'sonnet']);
  });

  it('keeps a durably settled turn settled when a revival arrives before receipt state loads', async () => {
    await settleTurn();
    expect((await chat()).status).toBe('completed');

    // A fresh service over the same storage has no receipt state yet.
    service = new ChatStateService({ repository, ...options });
    resetChatStateServiceForTests(service);
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'revival',
      data: {
        type: 'assistant',
        uuid: 'revival',
        canopy_turn_revival: true,
        canopy_turn_user_message_id: ANCHOR,
        message: {
          id: 'revival-message',
          content: [{ type: 'text', text: 'Revived?' }],
        },
      },
    });
    expect((await chat()).status).toBe('completed');
  });

  it('commits every turn of one snapshot, including one whose anchor is not in the transcript', async () => {
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
    service.observeTurnLifecycle(
      lifecycle(3, 'TurnStarted', 'missing-anchor', 'unanchored-turn'),
    );
    await flushTurnState();
    expect(timers((await chat()).messages)).toEqual([
      expect.objectContaining({
        id: `${TURN}:timer`,
        blocks: [expect.objectContaining({ completedAt: 1_500 })],
      }),
      expect.objectContaining({
        id: 'unanchored-turn:timer',
        blocks: [expect.objectContaining({ completedAt: null })],
      }),
    ]);
  });

  async function reply(mutationId: string, text: string): Promise<void> {
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId,
      data: {
        type: 'assistant',
        uuid: mutationId,
        canopy_turn_user_message_id: ANCHOR,
        message: {
          id: `${mutationId}-message`,
          content: [{ type: 'text', text }],
        },
      },
    });
  }

  it("admits a turn's own output delivered after its end receipt, until its root terminal event", async () => {
    // Provider adapters report the end before that turn's output reaches the
    // state service; with slow commits the turn is already settled here.
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
    await flushTurnState();
    expect((await chat()).status).toBe('completed');

    await reply('delivered-late', 'Delivered late');
    expect(JSON.stringify((await chat()).messages)).toContain('Delivered late');

    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'root-result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        canopy_turn_user_message_id: ANCHOR,
      },
    });
    await reply('after-terminal', 'After terminal');
    const after = await chat();
    expect(JSON.stringify(after.messages)).not.toContain('After terminal');
    expect(after.status).toBe('completed');
  });

  it('admits revival content only once a canonical turn starts', async () => {
    await settleTurn();
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'settled-result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        canopy_turn_user_message_id: ANCHOR,
      },
    });
    const revival = (mutationId: string, text: string): Promise<unknown> =>
      service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: ANCHOR,
        mutationId,
        data: {
          type: 'assistant',
          uuid: mutationId,
          canopy_turn_revival: true,
          canopy_turn_user_message_id: ANCHOR,
          message: {
            id: `${mutationId}-message`,
            content: [{ type: 'text', text }],
          },
        },
      });
    // A revival flag is not a turn: with none current, the content rejects.
    await revival('unowned-revival', 'Unowned revival');
    expect(JSON.stringify((await chat()).messages)).not.toContain(
      'Unowned revival',
    );

    service.observeTurnLifecycle(
      lifecycle(3, 'TurnStarted', ANCHOR, 'wake-turn'),
    );
    await flushTurnState();
    await revival('owned-revival', 'Owned revival');
    expect(JSON.stringify((await chat()).messages)).toContain('Owned revival');
  });

  it('admits subsequent old-dispatch output after a wake starts without init', async () => {
    await settleTurn();
    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'settled-before-wake',
      data: {
        type: 'result',
        subtype: 'success',
        result: 'First turn done',
        canopy_turn_user_message_id: ANCHOR,
      },
    });

    const wakeStart = lifecycle(3, 'TurnStarted', ANCHOR, 'wake-execution');
    if (wakeStart.type !== 'TurnStarted')
      throw new Error('Expected a wake start');
    service.observeTurnLifecycle({
      ...wakeStart,
      origin: 'autonomous',
      binding: 'pending',
      userMessageIds: [],
    });
    await flushTurnState();

    const ingestWakeOutput = (
      mutationId: string,
      text: string,
      turnUserMessageId?: string,
    ): Promise<boolean> =>
      service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId,
        ...(turnUserMessageId ? { turnUserMessageId } : {}),
        data: {
          type: 'assistant',
          uuid: mutationId,
          message: {
            id: `${mutationId}-message`,
            content: [{ type: 'text', text }],
          },
        },
      });
    expect(await ingestWakeOutput('wake-revival', 'Wake resumed')).toBe(true);
    expect(
      await ingestWakeOutput('wake-followup', 'Wake continued', ANCHOR),
    ).toBe(true);
    const state = await chat();
    expect(JSON.stringify(state.messages)).toContain('Wake resumed');
    expect(JSON.stringify(state.messages)).toContain('Wake continued');
    expect(timers(state.messages).map((timer) => timer.id)).toContain(
      'wake-execution:timer',
    );
  });

  it('rejects output delivered after a stopped turn ended', async () => {
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    service.observeTurnLifecycle(
      lifecycle(2, 'TurnEnded', ANCHOR, TURN, 'cancelled'),
    );
    await flushTurnState();
    await reply('after-stop', 'After stop');
    expect(JSON.stringify((await chat()).messages)).not.toContain('After stop');
  });

  it('keeps a running canonical turn streaming when the host queue rewrites runtime', async () => {
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    await flushTurnState();
    // The host gate can be released while the provider's turn still runs.
    await service.reconcileHostQueue(
      { ...SCOPE, chatId: CHAT_ID },
      ['queued-row'],
      false,
    );
    expect((await chat()).status).toBe('streaming');
  });

  it('fences later output only once the root terminal commits', async () => {
    await prompt();
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted'));
    service.observeTurnLifecycle(lifecycle(2, 'TurnEnded'));
    await flushTurnState();
    const terminal = {
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: ANCHOR,
      mutationId: 'fenced-result',
      data: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        canopy_turn_user_message_id: ANCHOR,
      },
    };
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementationOnce((scope, build, transactionOptions) =>
        transactWith(
          scope,
          async (current, revision, context) => {
            await build(current, revision, context);
            throw new Error('write failed');
          },
          transactionOptions,
        ),
      );
    await expect(service.ingestProviderEvent(terminal)).rejects.toThrow(
      'write failed',
    );
    // The terminal never committed, so the turn's own output still lands.
    await reply('before-terminal', 'Before terminal');
    expect(JSON.stringify((await chat()).messages)).toContain(
      'Before terminal',
    );

    await service.ingestProviderEvent(terminal);
    await reply('after-fence', 'After fence');
    expect(JSON.stringify((await chat()).messages)).not.toContain(
      'After fence',
    );
  });

  it('settles a canonical starting left by a dispatch once its turn ended', async () => {
    const ownership = getChatTurnOwnership();
    const scope = { ...SCOPE, chatId: CHAT_ID };
    const dispatch = ownership.registerDispatchOwner(scope, {
      token: Symbol('dispatch'),
      userMessageId: ANCHOR,
    });
    await prompt();
    // Without a root receipt the turn never binds, so the dispatch stays
    // awaiting its start (35c4 binds dispatches when their turn starts).
    const unbound = { binding: 'unbound' as const, userMessageIds: [] };
    service.observeTurnLifecycle({
      ...lifecycle(1, 'TurnStarted'),
      ...unbound,
    });
    service.observeTurnLifecycle({ ...lifecycle(2, 'TurnEnded'), ...unbound });
    await flushTurnState();
    expect((await chat()).status).toBe('starting');
    ownership.removeDispatchOwner(
      scope,
      dispatch.token,
      dispatch.operationEpoch,
    );
    await service.reconcileHostQueue(scope, [], false);
    expect((await chat()).status).toBe('completed');
  });

  it("admits a live dispatch's output when a merged steer bound the turn", async () => {
    getChatTurnOwnership().registerDispatchOwner(
      { ...SCOPE, chatId: CHAT_ID },
      { token: Symbol('dispatch'), userMessageId: ANCHOR },
    );
    await prompt();
    // The provider echoed only the steer, so the turn binds to it.
    service.observeTurnLifecycle(lifecycle(1, 'TurnStarted', 'merged-steer'));
    await flushTurnState();
    await reply('dispatch-output', 'Dispatch output');
    expect(JSON.stringify((await chat()).messages)).toContain(
      'Dispatch output',
    );
  });

  describe('un-archive authority', () => {
    async function archiveSettledChat(): Promise<void> {
      await settleTurn();
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'enable-auto-archive',
        data: { type: 'canopy_set_auto_archive_requested', enabled: true },
      });
      await service.command({
        schemaVersion: 1,
        commandId: 'auto-archive',
        ...SCOPE,
        command: {
          type: 'chat.archive_tab',
          tabId: CHAT_ID,
          keepSession: true,
        },
      });
    }

    async function archived(): Promise<ArchivedChatEntry | undefined> {
      const state = await repository.getState(SCOPE, {
        chatIds: [CHAT_ID],
        fullTranscript: true,
      });
      return state.archivesFile.archived.find(
        (entry) => entry.tab.id === CHAT_ID,
      );
    }

    /** A wake's start, observed after the archive at 2 000. */
    function wakeStart(
      origin: 'autonomous' | 'restart' = 'autonomous',
    ): ChatTurnLifecycleEvent {
      const start = lifecycle(3, 'TurnStarted', ANCHOR, 'wake-turn');
      if (start.type !== 'TurnStarted') throw new Error('Expected a start');
      return {
        ...start,
        origin,
        binding: 'unbound',
        userMessageIds: [],
        observedAtMs: 3_000,
        startedAtMs: 3_000,
      };
    }

    async function wakeReply(): Promise<void> {
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'wake-reply',
        data: {
          type: 'assistant',
          uuid: 'wake-reply',
          message: {
            id: 'wake-reply-message',
            content: [{ type: 'text', text: 'Woke up' }],
          },
        },
      });
    }

    it('fences the archive with its incarnation and the turn it closed', async () => {
      await archiveSettledChat();
      const fence = (await archived())?.turnFence;
      expect(fence).toMatchObject({
        version: 1,
        archivedAtMs: 2_000,
        closedTurnId: TURN,
      });
      expect(typeof fence?.archiveEpoch).toBe('string');
    });

    it('keeps the fence across a compatibility rewrite and a reopen', async () => {
      await archiveSettledChat();
      const fence = (await archived())?.turnFence;
      expect(fence).toBeDefined();
      const compatibility = await service.getCompatibilityArchives(SCOPE, {
        chatIds: [CHAT_ID],
        fullTranscript: true,
      });
      // A compatibility file carries no fence.
      await service.replaceCompatibilityArchives(
        SCOPE,
        {
          ...compatibility,
          archived: compatibility.archived.map(
            ({ turnFence: _turnFence, ...entry }) => {
              void _turnFence;
              return entry;
            },
          ),
        },
        { authoritative: true },
      );
      expect((await archived())?.turnFence).toEqual(fence);

      await repository.drainAll();
      const reopened = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(directory, 'chats.json'),
          archives: join(directory, 'archives.json'),
          journal: join(directory, 'journal.jsonl'),
        }),
      });
      const state = await reopened.getState(SCOPE, { chatIds: [CHAT_ID] });
      expect(state.archivesFile.archived[0]?.turnFence).toEqual(fence);
      await reopened.drainAll();
    });

    it('keeps root content with no fresh canonical start archived', async () => {
      await archiveSettledChat();
      await wakeReply();
      expect((await chat()).messages).toEqual([]);
      expect(JSON.stringify((await archived())?.tab.messages)).toContain(
        'Woke up',
      );
    });

    it('restores the chat with its wake turn from a fresh start after the archive', async () => {
      await archiveSettledChat();
      service.observeTurnLifecycle(wakeStart());
      // The fallback commit runs before the wake's content arrives.
      await flushTurnState();
      await wakeReply();
      const restored = await chat();
      expect(await archived()).toBeUndefined();
      expect(restored.status).toBe('streaming');
      expect(JSON.stringify(restored.messages)).toContain('Woke up');
      expect(timers(restored.messages).map((row) => row.id)).toContain(
        'wake-turn:timer',
      );
    });

    it('keeps a staged fresh start across an archive-only update', async () => {
      await archiveSettledChat();
      service.observeTurnLifecycle(wakeStart());
      await flushTurnState();
      // A child frame only updates the archived transcript.
      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'archived-child-frame',
        data: {
          type: 'assistant',
          parent_tool_use_id: 'child-1',
          message: {
            id: 'archived-child-message',
            content: [{ type: 'text', text: 'Child output' }],
          },
        },
      });
      expect(await archived()).toBeDefined();
      await wakeReply();
      expect(await archived()).toBeUndefined();
      expect((await chat()).status).toBe('streaming');
    });

    it('keeps a restarted execution from restoring the chat', async () => {
      await archiveSettledChat();
      service.observeTurnLifecycle(wakeStart('restart'));
      await flushTurnState();
      await wakeReply();
      expect(await archived()).toBeDefined();
    });

    it('restores a legacy archive only from a host prompt', async () => {
      await archiveSettledChat();
      const entry = await archived();
      if (!entry) throw new Error('Missing archive entry');
      const { turnFence: _fence, ...legacy } = entry;
      void _fence;
      await repository.transactWith(
        SCOPE,
        () => [{ type: 'archive.upserted', entry: legacy }],
        { source: 'migration', mutationId: 'legacy-archive' },
      );
      service.observeTurnLifecycle(wakeStart());
      await flushTurnState();
      await wakeReply();
      expect(await archived()).toBeDefined();

      await service.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: 'next-prompt',
        mutationId: 'host-prompt',
        data: {
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'next-prompt',
          canopy_persisted_messages: [
            {
              id: 'next-prompt',
              role: 'user',
              timestamp: 4_000,
              blocks: [{ type: 'text', text: 'Back again' }],
            },
          ],
        },
      });
      expect(await archived()).toBeUndefined();
    });
  });
});
