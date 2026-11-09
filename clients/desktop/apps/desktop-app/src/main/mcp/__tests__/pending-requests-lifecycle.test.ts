import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
} from '../../chat-waits/desktop-chat-waits';
import {
  clearAskUserRequestCancellation,
  createPendingRequest,
  hasPendingRequestForSession,
  hasPendingRequestsForSession,
  isAskUserRequestCancelled,
  isPendingRequestOpen,
  rejectAllForSession,
  rejectRequest,
  resolveRequest,
} from '../pending-requests';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const SCOPE = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const ANSWERS: McpQuestionAnswer[] = [
  { question: 'Pick one', selectedOptions: ['A'] },
];

describe('pending-requests over the chat wait lifecycle', () => {
  beforeEach(() => {
    resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('every pending-requests export delegates to the core lifecycle', async () => {
    const answered = createPendingRequest('q-answer', 'session-A', {
      scope: SCOPE,
    });
    expect(getDesktopChatWaits().scopeOf('q-answer')).toEqual({
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(hasPendingRequestForSession('session-A')).toBe(true);
    expect(hasPendingRequestsForSession('session-A')).toBe(true);
    expect(isPendingRequestOpen('q-answer')).toBe(true);
    expect(resolveRequest('q-answer', ANSWERS)).toBe(true);
    await expect(answered).resolves.toEqual(ANSWERS);
    expect(hasPendingRequestForSession('session-A')).toBe(false);

    const cancelled = createPendingRequest('q-cancel', 'session-A');
    expect(rejectRequest('q-cancel', 'ask_user_cancelled')).toBe(true);
    await expect(cancelled).rejects.toThrow('ask_user_cancelled');
    expect(isAskUserRequestCancelled('q-cancel')).toBe(true);
    clearAskUserRequestCancellation('q-cancel');
    expect(isAskUserRequestCancelled('q-cancel')).toBe(false);

    const lifecycle = getDesktopChatWaits();
    const settledStatuses: string[] = [];
    lifecycle.observe({
      opened: () => undefined,
      settled: (wait) => settledStatuses.push(`${wait.waitId}:${wait.status}`),
    });
    const persistence = createPendingRequest('q-persist', 'session-A');
    expect(rejectRequest('q-persist', 'ask_user_persistence_failed')).toBe(
      true,
    );
    await expect(persistence).rejects.toThrow('ask_user_persistence_failed');
    expect(settledStatuses).toEqual(['q-persist:failed']);
    expect(isAskUserRequestCancelled('q-persist')).toBe(false);

    const destroyed = createPendingRequest('q-destroy', 'session-B');
    rejectAllForSession('session-B');
    await expect(destroyed).rejects.toThrow('session_destroyed');

    jest.useFakeTimers();
    const onTimeout = jest.fn();
    const timedOut = createPendingRequest('q-timeout', 'session-C', {
      timeoutMs: 1000,
      onTimeout,
    });
    jest.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await expect(timedOut).rejects.toThrow('ask_user_timeout');
  });

  it('fail mode rejects a question with no client', async () => {
    resetDesktopChatWaitsForTest({ noClientMode: 'fail' });
    const pending = createPendingRequest('q-no-client', 'session-A', {
      scope: SCOPE,
    });
    await expect(pending).rejects.toThrow('ask_user_no_client');
    expect(isPendingRequestOpen('q-no-client')).toBe(false);
  });
});
