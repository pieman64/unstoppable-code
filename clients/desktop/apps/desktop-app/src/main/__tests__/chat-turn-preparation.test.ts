import {
  stopTurnForAuthFailure,
  takePendingAuthResumesForGitHub,
  readPendingAuthResume,
} from '../lib/auth-failure-turn-stop';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';
import {
  beginChatTurnPreparation,
  cancelChatTurn,
} from '../lib/chat-turn-cancel';
import { cancelChatTurnPreparations } from '../lib/chat-turn-preparation';

jest.mock('../agents/session-manager', () => ({
  drainChatSessionEvents: (): Promise<void> => Promise.resolve(),
  suppressCodexAuthenticationRecovery: (): void => undefined,
  getSession: (): undefined => undefined,
  getSessionProviderType: (): undefined => undefined,
  markSessionForNextTurnRecreation: (): void => undefined,
}));
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): {
    invalidatePendingInputOperations: () => void;
  } => ({
    invalidatePendingInputOperations: (): void => undefined,
  }),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    inputDelivery: {
      stop: (target: unknown, cancel: () => Promise<void>) => Promise<void>;
    };
  } => ({
    inputDelivery: {
      stop: (_target, cancel): Promise<void> => cancel(),
    },
  }),
}));

const chat = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'message-1',
};

describe('beginChatTurnPreparation', () => {
  it('inherits a Stop that reached an enclosing preparation before this one began', () => {
    const handoff = beginChatTurnPreparation(chat);
    handoff.cancelled = true;

    const turn = beginChatTurnPreparation(chat);
    expect(turn.cancelled).toBe(true);

    turn.finish();
    handoff.finish();
  });

  it('does not cancel an independent newer send while a stopped dispatch unwinds', () => {
    const stopped = beginChatTurnPreparation(chat);
    stopped.cancelled = true;

    const newer = beginChatTurnPreparation({
      ...chat,
      userMessageId: 'message-2',
    });
    expect(newer.cancelled).toBe(false);

    newer.finish();
    stopped.finish();
  });

  it('does not leak a finished Stop into a later send or another chat', () => {
    const handoff = beginChatTurnPreparation(chat);
    handoff.cancelled = true;
    const otherChat = beginChatTurnPreparation({ ...chat, chatId: 'chat-2' });
    expect(otherChat.cancelled).toBe(false);
    otherChat.finish();
    handoff.finish();

    const next = beginChatTurnPreparation(chat);
    expect(next.cancelled).toBe(false);
    next.finish();
  });
});

describe('cancelChatTurnPreparations', () => {
  it("cancels the chat's preparations and settles each owned turn once", async () => {
    const settled: string[] = [];
    const held = beginChatTurnPreparation({
      ...chat,
      onCancel: (): Promise<void> => {
        settled.push('message-1');
        return Promise.resolve();
      },
    });
    const otherChat = beginChatTurnPreparation({
      ...chat,
      chatId: 'chat-2',
      onCancel: (): Promise<void> => {
        settled.push('chat-2');
        return Promise.resolve();
      },
    });

    await cancelChatTurnPreparations(chat);
    await cancelChatTurnPreparations(chat);

    expect(held.cancelled).toBe(true);
    expect(otherChat.cancelled).toBe(false);
    expect(settled).toEqual(['message-1']);
    held.finish();
    otherChat.finish();
  });

  it('leaves a preparation begun while settling to a later Stop', async () => {
    let begunDuringStop:
      | ReturnType<typeof beginChatTurnPreparation>
      | undefined;
    const held = beginChatTurnPreparation({
      ...chat,
      onCancel: (): Promise<void> => {
        begunDuringStop = beginChatTurnPreparation({
          ...chat,
          userMessageId: 'message-2',
        });
        return Promise.resolve();
      },
    });

    await cancelChatTurnPreparations(chat);

    expect(begunDuringStop?.cancelled).toBe(false);
    begunDuringStop?.finish();
    held.finish();
  });

  it('is reached by the ordinary Stop', async () => {
    const preparation = beginChatTurnPreparation(chat);

    await cancelChatTurn(chat);

    expect(preparation.cancelled).toBe(true);
    preparation.finish();
  });
});

it('a user Stop cancels the pending GitHub continuation', async () => {
  await stopTurnForAuthFailure({
    target: chat,
    event: {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tool-1',
      failure: {
        dependencyClass: 'integration',
        dependencyId: 'integration:github',
        displayName: 'GitHub',
        failureClass: 'unauthenticated',
        recovery: { kind: 'github_login' },
      },
    },
    toolName: 'mcp__github__list_issues',
    initiationSource: 'user',
    getWindow: () => null,
  });
  expect(readPendingAuthResume(chat)).not.toBeNull();
  await cancelChatTurn(chat);
  expect(takePendingAuthResumesForGitHub()).toEqual([]);
});
