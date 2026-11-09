import {
  IPC_CHANNELS,
  type McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import { resetDesktopChatWaitsForTest } from '../../chat-waits/desktop-chat-waits';
import {
  isPendingRequestOpen,
  rejectAllForSession,
  resolveRequest,
} from '../../mcp/pending-requests';
import { sendToWindow, sendToWindowDetailed } from '../../lib/window-send';
import { requestAnswersFromRenderer } from '../session-runtime';

const upsertPendingQuestion = jest.fn((): Promise<void> => Promise.resolve());
const consumePendingQuestion = jest.fn((): Promise<void> => Promise.resolve());

jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    upsertPendingQuestion,
    consumePendingQuestion,
  }),
}));
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: jest.fn(),
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));
jest.mock('../../services/attention-tracker', () => ({
  getAttentionTracker: (): unknown => ({ mark: jest.fn(), clear: jest.fn() }),
}));

const sendToWindowMock = jest.mocked(sendToWindow);
const sendToWindowDetailedMock = jest.mocked(sendToWindowDetailed);
const ANSWERS: McpQuestionAnswer[] = [
  { question: 'Pick one', selectedOptions: ['A'] },
];

function ask(options: {
  signal?: AbortSignal;
  askUserTimeoutMs?: number;
}): Promise<McpQuestionAnswer[]> {
  return requestAnswersFromRenderer({
    sessionKey: 'session-A',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    questions: [{ question: 'Pick one', options: ['A'] }],
    getWindow: () => null,
    ...options,
  });
}

async function untilDelivered(): Promise<string> {
  for (
    let i = 0;
    i < 100 && sendToWindowDetailedMock.mock.calls.length === 0;
    i++
  ) {
    await Promise.resolve();
  }
  const [, request] = upsertPendingQuestion.mock.calls[0] as unknown as [
    unknown,
    { requestId: string },
  ];
  return request.requestId;
}

function expiredRequestIds(): unknown[] {
  return sendToWindowMock.mock.calls
    .filter(([, channel]) => channel === IPC_CHANNELS.mcpExpireAskUser)
    .map(([, , payload]) => payload);
}

describe('requestAnswersFromRenderer on the chat wait lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('abort, timeout and session teardown each remove the pending record exactly once', async () => {
    const controller = new AbortController();
    const aborted = ask({ signal: controller.signal });
    const abortedId = await untilDelivered();
    const abortRejection =
      expect(aborted).rejects.toThrow('ask_user_cancelled');
    controller.abort();
    await abortRejection;
    await Promise.resolve();
    await Promise.resolve();
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion.mock.calls[0]).toContain(abortedId);
    expect(expiredRequestIds()).toEqual([{ requestId: abortedId }]);

    jest.clearAllMocks();
    jest.useFakeTimers();
    const timedOut = ask({ askUserTimeoutMs: 1000 });
    const timedOutId = await untilDelivered();
    const timeoutRejection =
      expect(timedOut).rejects.toThrow('ask_user_timeout');
    await jest.advanceTimersByTimeAsync(1000);
    await timeoutRejection;
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion.mock.calls[0]).toContain(timedOutId);
    expect(expiredRequestIds()).toEqual([{ requestId: timedOutId }]);
    jest.useRealTimers();

    jest.clearAllMocks();
    const torndown = ask({});
    const torndownId = await untilDelivered();
    rejectAllForSession('session-A');
    await expect(torndown).rejects.toThrow('session_destroyed');
    expect(consumePendingQuestion).toHaveBeenCalledTimes(1);
    expect(consumePendingQuestion.mock.calls[0]).toContain(torndownId);
  });

  it('a question with no window still waits', async () => {
    sendToWindowDetailedMock.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    const pending = ask({});
    const requestId = await untilDelivered();
    expect(sendToWindowDetailedMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.mcpAskUser,
      expect.objectContaining({ requestId }),
    );
    expect(isPendingRequestOpen(requestId)).toBe(true);
    expect(resolveRequest(requestId, ANSWERS)).toBe(true);
    await expect(pending).resolves.toEqual(ANSWERS);
  });

  it('in fail mode a question with no client is refused before anything is persisted', async () => {
    resetDesktopChatWaitsForTest({ noClientMode: 'fail' });
    await expect(ask({})).rejects.toThrow('ask_user_no_client');
    expect(upsertPendingQuestion).not.toHaveBeenCalled();
  });
});
