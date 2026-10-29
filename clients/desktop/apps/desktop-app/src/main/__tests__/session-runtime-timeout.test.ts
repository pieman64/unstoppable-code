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

const sendDetailed = jest.fn((): WindowSendResult => ({ delivered: true }));
const send = jest.fn((): boolean => true);
jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: (...args: unknown[]): WindowSendResult =>
    sendDetailed(...args),
  sendToWindow: (...args: unknown[]): boolean => send(...args),
}));

describe('requestAnswersFromRenderer ask-user timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sendDetailed.mockClear();
    send.mockClear();
    upsertPendingQuestion.mockClear();
    consumePendingQuestion.mockReset().mockResolvedValue(undefined);
    observability.pauseChatTurn.mockClear();
    observability.recordSessionDiagnostic.mockClear();
    observability.resumeChatTurn.mockClear();
    attentionMark.mockClear();
    attentionClear.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('rejects with ask_user_timeout and emits the expire event', async () => {
    let requestId = '';
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      askUserTimeoutMs: 1000,
      onRequestCreated: (created) => {
        requestId = created;
      },
    });
    await Promise.resolve();
    expect(attentionMark).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      state: 'needs_input',
      reason: 'ask_user',
      sourceId: `ask-user:${requestId}`,
      detail: 'Q',
    });
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toThrow('ask_user_timeout');
    const expireCall = send.mock.calls.find(
      (c: unknown[]) => c[1] === IPC_CHANNELS.mcpExpireAskUser,
    );
    expect(expireCall).toBeDefined();
    expect(upsertPendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion).toHaveBeenCalled();
    expect(attentionClear).toHaveBeenCalledWith(
      'p',
      'w',
      'c',
      `ask-user:${requestId}`,
    );
  });

  it('commits timeout consumption before emitting the expire event', async () => {
    let finishConsume: (() => void) | undefined;
    consumePendingQuestion.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConsume = resolve;
        }),
    );
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      askUserTimeoutMs: 1000,
    });
    const rejection = expect(promise).rejects.toThrow('ask_user_timeout');

    jest.advanceTimersByTime(1001);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );

    finishConsume?.();
    await rejection;
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
  });

  it('commits abort consumption before emitting the expire event', async () => {
    let finishConsume: (() => void) | undefined;
    consumePendingQuestion.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConsume = resolve;
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
    const rejection = expect(promise).rejects.toThrow('ask_user_cancelled');

    controller.abort();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );

    finishConsume?.();
    await rejection;
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpExpireAskUser,
      expect.anything(),
    );
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
  });

  it('keeps the main-owned question answerable when no renderer is available', async () => {
    sendDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'window_unavailable',
    });
    let requestId = '';
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      onRequestCreated: (created) => {
        requestId = created;
      },
    });

    await Promise.resolve();
    expect(requestId).not.toBe('');
    expect(
      resolveRequest(requestId, [{ question: 'Q', selectedOptions: ['a'] }]),
    ).toBe(true);
    await expect(promise).resolves.toEqual([
      { question: 'Q', selectedOptions: ['a'] },
    ]);
    expect(upsertPendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
  });

  it('returns an answered question and resumes the turn when cleanup fails', async () => {
    consumePendingQuestion.mockRejectedValueOnce(new Error('scope disposed'));
    let requestId = '';
    const promise = requestAnswersFromRenderer({
      sessionKey: 's',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [{ question: 'Q', options: ['a'] }],
      getWindow: () => null,
      onRequestCreated: (created) => {
        requestId = created;
      },
    });

    await Promise.resolve();
    expect(
      resolveRequest(requestId, [{ question: 'Q', selectedOptions: ['a'] }]),
    ).toBe(true);
    await expect(promise).resolves.toEqual([
      { question: 'Q', selectedOptions: ['a'] },
    ]);
    expect(observability.resumeChatTurn).toHaveBeenCalledWith('p', 'w', 'c');
  });
});
