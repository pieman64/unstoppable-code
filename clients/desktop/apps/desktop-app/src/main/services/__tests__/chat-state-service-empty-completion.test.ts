import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE } from '@canopy/desktop-shared/types';
import type { TurnEnded, TurnStarted } from '@canopy/protocol/canopy-core';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../chat-state-service';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import { getChatQueueService } from '../chat-queue-service';
import {
  flushTurnState,
  observeTurn,
  turnEnded,
  turnStarted,
} from '../../__tests__/helpers/turn-lifecycle-events';

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT = { ...SCOPE, chatId: 'chat-1' };
const NOW = 1_786_104_000_000;

const turn = (
  userMessageId: string,
): typeof CHAT & { userMessageId: string } => ({
  ...CHAT,
  userMessageId,
});

describe('a turn that ended with an empty completion', () => {
  let directory: string;
  let repository: ChatStateV2Repository;
  let target: ChatStateService;
  let sequence = 0;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-state-empty-completion-'));
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
    target = new ChatStateService({
      repository,
      now: (): number => NOW,
      createId: (): string => 'event-id',
      authorizeSend: (): Promise<undefined> => Promise.resolve(undefined),
      cleanupSession: (): Promise<undefined> => Promise.resolve(undefined),
      recordDiagnostic: jest.fn(),
    });
    jest
      .spyOn(getChatQueueService(), 'holdsUserMessage')
      .mockReturnValue(false);
    await expect(
      target.command({
        schemaVersion: 1,
        commandId: 'create-1',
        ...SCOPE,
        command: {
          type: 'chat.create_tab',
          tabId: CHAT.chatId,
          title: 'Empty completion',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        },
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetChatStateServiceForTests();
    getChatQueueService().resetForTests();
    await repository.drainAll();
    rmSync(directory, { recursive: true, force: true });
  });

  function lifecycle(
    type: 'start' | 'end',
    userMessageId: string,
  ): TurnStarted | TurnEnded {
    const fields = {
      sequence: ++sequence,
      turnId: `turn-${userMessageId}`,
      atMs: NOW,
      userMessageIds: [userMessageId],
    };
    return type === 'start'
      ? turnStarted(CHAT, fields)
      : turnEnded(CHAT, { ...fields, outcome: 'completed' });
  }

  async function startTurn(userMessageId: string): Promise<void> {
    await target.ingestProviderEvent({
      ...CHAT,
      mutationId: `${userMessageId}:user-prompt`,
      turnUserMessageId: userMessageId,
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: userMessageId,
        canopy_persisted_messages: [
          {
            id: userMessageId,
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: `Run ${userMessageId}` }],
          },
        ],
      },
    });
    await observeTurn(target, lifecycle('start', userMessageId));
    await target.ingestProviderEvent({
      ...CHAT,
      mutationId: `${userMessageId}:accepted`,
      turnUserMessageId: userMessageId,
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: userMessageId,
      },
    });
  }

  async function reply(userMessageId: string): Promise<void> {
    await target.ingestProviderEvent({
      ...CHAT,
      mutationId: `${userMessageId}:reply`,
      turnUserMessageId: userMessageId,
      data: {
        type: 'assistant',
        message: {
          id: `${userMessageId}-reply`,
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      },
    });
  }

  async function result(userMessageId: string): Promise<void> {
    await target.ingestProviderEvent({
      ...CHAT,
      mutationId: `${userMessageId}:result`,
      turnUserMessageId: userMessageId,
      data: { type: 'result', is_error: false, result: 'Completed' },
    });
  }

  /** The provider's result and the canonical end, in each order they commit. */
  const orders = {
    'the canonical end commits before the result': async (
      id: string,
    ): Promise<void> => {
      await observeTurn(target, lifecycle('end', id));
      await result(id);
    },
    'the canonical end commits with the result': async (
      id: string,
    ): Promise<void> => {
      target.observeTurnLifecycle(lifecycle('end', id));
      await result(id);
      await flushTurnState(target);
    },
    'the result is reduced before the canonical end': async (
      id: string,
    ): Promise<void> => {
      await result(id);
      await observeTurn(target, lifecycle('end', id));
    },
  };

  async function completeTurn(userMessageId: string): Promise<void> {
    await reply(userMessageId);
    await orders['the canonical end commits before the result'](userMessageId);
  }

  async function runtimeError(): Promise<string | undefined> {
    return (await target.getState(SCOPE)).runtimeByChatId[CHAT.chatId]?.error
      ?.code;
  }

  it.each(Object.entries(orders))(
    'reports it failed when %s, and after a follow-up',
    async (_order, settle) => {
      await startTurn('user-empty');
      await settle('user-empty');
      await expect(runtimeError()).resolves.toBe('empty_completion');
      await expect(target.turnOutcome(turn('user-empty'))).resolves.toBe(
        'failed',
      );
      await expect(
        target.settledTurn(turn('user-empty')),
      ).resolves.toMatchObject({
        outcome: 'failed',
        userMessageId: 'user-empty',
      });

      await startTurn('user-next');
      await completeTurn('user-next');
      await expect(target.turnOutcome(turn('user-empty'))).resolves.toBe(
        'failed',
      );
      await expect(
        target.settledTurn(turn('user-empty')),
      ).resolves.toMatchObject({ outcome: 'failed' });
      await expect(target.turnOutcome(turn('user-next'))).resolves.toBe(
        'completed',
      );
    },
  );

  it('reports it completed once late output recovers it', async () => {
    await startTurn('user-empty');
    await orders['the canonical end commits before the result']('user-empty');
    await expect(target.turnOutcome(turn('user-empty'))).resolves.toBe(
      'failed',
    );

    await target.ingestProviderEvent({
      ...CHAT,
      mutationId: 'user-empty:late-output',
      turnUserMessageId: 'user-empty',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [
          {
            id: 'late-assistant',
            role: 'assistant',
            timestamp: NOW + 1,
            blocks: [{ type: 'text', text: 'Recovered output' }],
          },
        ],
      },
    });
    await expect(runtimeError()).resolves.toBeUndefined();
    await expect(target.turnOutcome(turn('user-empty'))).resolves.toBe(
      'completed',
    );
    await expect(target.settledTurn(turn('user-empty'))).resolves.toMatchObject(
      { outcome: 'completed' },
    );

    await startTurn('user-next');
    await completeTurn('user-next');
    await expect(target.turnOutcome(turn('user-empty'))).resolves.toBe(
      'completed',
    );
  });

  it('still reports an ordinary completion as completed', async () => {
    await startTurn('user-done');
    await completeTurn('user-done');
    await expect(runtimeError()).resolves.toBeUndefined();
    await expect(target.turnOutcome(turn('user-done'))).resolves.toBe(
      'completed',
    );
    await expect(target.settledTurn(turn('user-done'))).resolves.toMatchObject({
      outcome: 'completed',
    });
  });
});
