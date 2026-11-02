/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { WindowSendResult } from '../lib/window-send';
import { resolveRequest } from '../mcp/pending-requests';

const upsertPendingQuestion = jest.fn().mockResolvedValue(undefined);
const consumePendingQuestion = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    upsertPendingQuestion,
    consumePendingQuestion,
  }),
}));

const observability = {
  pauseChatTurn: jest.fn(),
  recordSessionDiagnostic: jest.fn(),
  resumeChatTurn: jest.fn(),
};
jest.mock('../observability', () => ({
  getObservabilityService: () => observability,
}));

const attentionMark = jest.fn();
const attentionClear = jest.fn();
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: () => ({
    mark: attentionMark,
    clear: attentionClear,
  }),
}));

const sendDetailed = jest.fn<WindowSendResult, unknown[]>(() => ({
  delivered: true,
}));
const send = jest.fn<boolean, unknown[]>(() => true);
jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: (...args: unknown[]): WindowSendResult =>
    sendDetailed(...args),
  sendToWindow: (...args: unknown[]): boolean => send(...args),
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('requestAnswersFromRenderer cancellation', () => {
  beforeEach(() => {
    sendDetailed.mockClear();
    send.mockClear();
    upsertPendingQuestion.mockReset().mockResolvedValue(undefined);
    consumePendingQuestion.mockReset().mockResolvedValue(undefined);
    observability.pauseChatTurn.mockClear();
    observability.recordSessionDiagnostic.mockClear();
    observability.resumeChatTurn.mockClear();
    attentionMark.mockClear();
    attentionClear.mockClear();
  });

  it('does not persist or publish a question when the supplied signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestAnswersFromRenderer({
        sessionKey: 's',
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        questions: [{ question: 'Q', options: ['a'] }],
        getWindow: () => null,
        signal: controller.signal,
      }),
    ).rejects.toThrow('ask_user_cancelled');

    expect(upsertPendingQuestion).not.toHaveBeenCalled();
    expect(consumePendingQuestion).not.toHaveBeenCalled();
    expect(sendDetailed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects promptly when aborted during durable upsert and consumes only after upsert settles', async () => {
    let finishUpsert: (() => void) | undefined;
    let reportUpsertStarted: (() => void) | undefined;
    const upsertStarted = new Promise<void>((resolve) => {
      reportUpsertStarted = resolve;
    });
    upsertPendingQuestion.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUpsert = resolve;
          reportUpsertStarted?.();
        }),
    );
    const controller = new AbortController();
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      signal: controller.signal,
    });
    await upsertStarted;
    let rejectedBeforeUpsertSettled = false;
    void promise.catch((error: unknown) => {
      rejectedBeforeUpsertSettled =
        error instanceof Error && error.message === 'ask_user_cancelled';
    });

    controller.abort();
    await flushMicrotasks();

    expect(rejectedBeforeUpsertSettled).toBe(true);
    expect(sendDetailed).not.toHaveBeenCalled();
    expect(consumePendingQuestion).not.toHaveBeenCalled();

    finishUpsert?.();
    await expect(promise).rejects.toThrow('ask_user_cancelled');
    await flushMicrotasks();

    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(sendDetailed).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );
  });

  it('does not publish after cancellation in the request-created callback', async () => {
    const controller = new AbortController();
    let requestId = '';
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      signal: controller.signal,
      onRequestCreated: (created) => {
        requestId = created;
        controller.abort();
      },
    });

    await expect(promise).rejects.toThrow('ask_user_cancelled');
    await flushMicrotasks();

    expect(requestId).not.toBe('');
    expect(
      resolveRequest(requestId, [{ question: 'Q', selectedOptions: ['a'] }]),
    ).toBe(false);
    expect(upsertPendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(sendDetailed).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );
  });

  it('fences the waiter synchronously and does not expire before blocked consumption, including composed signals', async () => {
    let finishConsume: (() => void) | undefined;
    consumePendingQuestion.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConsume = resolve;
        }),
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal]);
    let requestId = '';
    let reportCardPublished: (() => void) | undefined;
    const cardPublished = new Promise<void>((resolve) => {
      reportCardPublished = resolve;
    });
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      signal,
      onRequestCreated: (created) => {
        requestId = created;
      },
      onAwaitingUser: () => reportCardPublished?.(),
    });
    await cardPublished;
    expect(requestId).not.toBe('');
    expect(sendDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpAskUser,
      expect.objectContaining({ requestId }),
    );
    let rejectedBeforeConsumeSettled = false;
    void promise.catch((error: unknown) => {
      rejectedBeforeConsumeSettled =
        error instanceof Error && error.message === 'ask_user_cancelled';
    });

    controller.abort();
    const lateAnswerAccepted = resolveRequest(requestId, [
      { question: 'Q', selectedOptions: ['a'] },
    ]);
    await flushMicrotasks();

    const rejectedPromptly = rejectedBeforeConsumeSettled;
    expect(send).not.toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );

    finishConsume?.();
    await expect(promise).rejects.toThrow('ask_user_cancelled');
    await flushMicrotasks();

    expect(rejectedPromptly).toBe(true);
    expect(lateAnswerAccepted).toBe(false);
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );
  });
});
