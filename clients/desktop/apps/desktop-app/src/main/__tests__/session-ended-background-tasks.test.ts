const appendFinalizedChatTranscriptRecord = jest
  .fn()
  .mockResolvedValue(undefined);
const recordBackgroundProcessChatEvent = jest.fn();
const sendToAllWindows = jest.fn();
const logMainProcessError = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get appendFinalizedChatTranscriptRecord(): typeof appendFinalizedChatTranscriptRecord {
      return appendFinalizedChatTranscriptRecord;
    },
  })),
}));

jest.mock('../portal/background-process-tracker', () => ({
  get recordBackgroundProcessChatEvent(): typeof recordBackgroundProcessChatEvent {
    return recordBackgroundProcessChatEvent;
  },
}));

jest.mock('../lib/window-send', () => ({
  get sendToAllWindows(): typeof sendToAllWindows {
    return sendToAllWindows;
  },
}));

jest.mock('../lib/main-process-logging', () => ({
  get logMainProcessError(): typeof logMainProcessError {
    return logMainProcessError;
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  SESSION_ENDED_TASK_NOTIFICATION_REASON,
  SESSION_ENDED_TASK_NOTIFICATION_SUMMARY,
  buildSessionEndedTaskNotification,
  emitSessionEndedBackgroundTaskNotification,
} from '../lib/session-ended-background-tasks';

const target = { projectId: 'p1', worktreeId: 'w1', chatId: 'c1' };

beforeEach(() => {
  jest.clearAllMocks();
  appendFinalizedChatTranscriptRecord.mockResolvedValue(undefined);
});

describe('buildSessionEndedTaskNotification', () => {
  it('builds a terminal stopped notification the renderer already understands', () => {
    expect(buildSessionEndedTaskNotification({ taskId: 'task-1' })).toEqual({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'stopped',
      reason: SESSION_ENDED_TASK_NOTIFICATION_REASON,
      summary: SESSION_ENDED_TASK_NOTIFICATION_SUMMARY,
      canopy_stop_cause: 'session_ended',
      canopy_synthetic: true,
    });
  });

  it.each([
    ['stop', 'Stopped when the chat was stopped'],
    ['recycle', 'Stopped when the provider session was recycled'],
    ['archive', 'Stopped when the chat was archived'],
    ['crash', 'Stopped when the provider process crashed'],
    ['external_signal', 'Stopped when the provider process exited'],
    ['session_ended', 'Stopped when the chat session ended'],
  ] as const)(
    'records the %s stop cause and uses a matching summary',
    (cause, summary) => {
      const task = { taskId: 'task-1', stopCause: cause };
      expect(buildSessionEndedTaskNotification(task)).toMatchObject({
        reason: 'session_ended',
        summary,
        canopy_stop_cause: cause,
        canopy_synthetic: true,
      });
    },
  );

  it('carries the correlated tool use and description when they are known', () => {
    expect(
      buildSessionEndedTaskNotification({
        taskId: 'task-1',
        toolUseId: 'toolu_1',
        description: 'Run the dev server',
      }),
    ).toMatchObject({
      task_id: 'task-1',
      tool_use_id: 'toolu_1',
      description: 'Run the dev server',
    });
  });

  it('accepts task-specific terminal copy for an already-finished stop', () => {
    expect(
      buildSessionEndedTaskNotification(
        { taskId: 'task-1' },
        {
          reason: 'already_finished',
          summary: 'This task had already finished',
        },
      ),
    ).toMatchObject({
      reason: 'already_finished',
      summary: 'This task had already finished',
    });
  });
});

describe('emitSessionEndedBackgroundTaskNotification', () => {
  it('delivers one notification to observability, the portal tracker, and the renderer', () => {
    emitSessionEndedBackgroundTaskNotification(target, {
      taskId: 'task-1',
      toolUseId: 'toolu_1',
    });

    const expected = buildSessionEndedTaskNotification({
      taskId: 'task-1',
      toolUseId: 'toolu_1',
    });

    expect(appendFinalizedChatTranscriptRecord).toHaveBeenCalledWith(
      'p1',
      'w1',
      'c1',
      expected,
    );
    expect(recordBackgroundProcessChatEvent).toHaveBeenCalledWith(
      { workspaceLocalId: 'p1', worktreeLocalId: 'w1', chatId: 'c1' },
      expected,
    );
    expect(sendToAllWindows).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'c1',
      data: expected,
    });
  });

  it('still reaches the remaining consumers when one side channel throws', async () => {
    appendFinalizedChatTranscriptRecord.mockRejectedValueOnce(
      new Error('sidecar unavailable'),
    );
    recordBackgroundProcessChatEvent.mockImplementation(() => {
      throw new Error('tracker unavailable');
    });

    expect(() =>
      emitSessionEndedBackgroundTaskNotification(target, { taskId: 'task-1' }),
    ).not.toThrow();

    expect(sendToAllWindows).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(logMainProcessError).toHaveBeenCalledTimes(2);
  });
});
