import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import {
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  subscribeLiveBackgroundTasks,
} from '../../../agents/session-manager';
import {
  clearBackgroundProcessTracker,
  listTrackedBackgroundProcesses,
  recordBackgroundProcessChatEvent,
} from '../../background-process-tracker';
import {
  clearPortalBackgroundProcessFingerprints,
  emitPortalBackgroundProcessProjection,
  listPortalBackgroundProcessEntitiesForWorktree,
  projectPortalBackgroundProcessEntities,
  startPortalBackgroundProcessProjection,
} from '../bg-processes-adapter';

jest.mock('../../../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(),
  subscribeLiveBackgroundTasks: jest.fn(),
}));

const target = {
  workspaceLocalId: 'workspace-1',
  worktreeLocalId: 'worktree-1',
};

function seedProcess(id: string, status = 'running'): void {
  const timestamp = id === 'tool-b' ? 200 : 100;
  // Only a backgrounded registration creates a tracked process; a terminal
  // notification then settles it.
  recordBackgroundProcessChatEvent(
    { ...target, chatId: 'chat-1' },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: `task-${id}`,
      tool_use_id: id,
      description: `Process ${id}`,
      is_backgrounded: true,
    },
    timestamp,
  );
  if (status !== 'running') {
    recordBackgroundProcessChatEvent(
      { ...target, chatId: 'chat-1' },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${id}`,
        tool_use_id: id,
        status,
        description: `Process ${id}`,
      },
      timestamp,
    );
  }
}

describe('background-process portal adapter', () => {
  beforeEach(() => {
    clearBackgroundProcessTracker();
    clearPortalBackgroundProcessFingerprints();
    jest.mocked(getLiveBackgroundTasksForChat).mockReset();
    jest.mocked(listLiveBackgroundTaskOwners).mockReset();
    jest.mocked(subscribeLiveBackgroundTasks).mockReset();
  });

  it('maps empty, multiple, and status-varied rows in stable localId order', () => {
    expect(projectPortalBackgroundProcessEntities(target, [])).toEqual([]);
    seedProcess('tool-b', 'failed');
    seedProcess('tool-a');

    expect(
      projectPortalBackgroundProcessEntities(
        target,
        listTrackedBackgroundProcesses(target),
      ),
    ).toMatchObject([
      { localId: 'tool-a', status: 'running' },
      { localId: 'tool-b', status: 'failed' },
    ]);
  });

  it('gates, fingerprints, emits removals, and seeds from snapshots', () => {
    seedProcess('tool-a');
    const emit = jest.fn<void, [PortalEventEnvelope]>();
    emitPortalBackgroundProcessProjection(target, {
      portalActive: () => false,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();

    const snapshot = listPortalBackgroundProcessEntitiesForWorktree(target);
    expect(snapshot).toHaveLength(1);
    emitPortalBackgroundProcessProjection(target, {
      portalActive: () => true,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();

    clearBackgroundProcessTracker();
    seedProcess('tool-b');
    emitPortalBackgroundProcessProjection(target, {
      portalActive: () => true,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0].payload).toMatchObject({
      entities: [{ entityType: 'background_process', localId: 'tool-b' }],
      removed: [{ entityType: 'background_process', localId: 'tool-a' }],
    });

    emitPortalBackgroundProcessProjection(target, {
      portalActive: () => true,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('seeds live owners at start and reconciles notifications after one microtask', async () => {
    const seededTask: ActivityLiveBgTask = {
      taskId: 'seeded-task',
      taskType: 'local_agent',
      description: 'Already running',
    };
    const notifiedTask: ActivityLiveBgTask = {
      taskId: 'notified-task',
      taskType: 'local_bash',
      description: 'New task',
    };
    jest.mocked(listLiveBackgroundTaskOwners).mockReturnValue([
      {
        sessionKey: 'workspace-seed/worktree-seed/chat-seed',
        projectId: 'workspace-seed',
        worktreeId: 'worktree-seed',
        chatId: 'chat-seed',
        liveTasks: [seededTask],
      },
    ]);
    jest
      .mocked(getLiveBackgroundTasksForChat)
      .mockImplementation((projectId, worktreeId, chatId) => {
        if (
          projectId === 'workspace-seed' &&
          worktreeId === 'worktree-seed' &&
          chatId === 'chat-seed'
        ) {
          return [seededTask];
        }
        if (
          projectId === 'workspace-notified' &&
          worktreeId === 'worktree-notified' &&
          chatId === 'chat-notified'
        ) {
          return [notifiedTask];
        }
        return undefined;
      });

    startPortalBackgroundProcessProjection();

    const seededTarget = {
      workspaceLocalId: 'workspace-seed',
      worktreeLocalId: 'worktree-seed',
      chatId: 'chat-seed',
    };
    expect(listTrackedBackgroundProcesses(seededTarget)).toEqual([
      expect.objectContaining({
        taskId: 'seeded-task',
        kind: 'agent',
        status: 'running',
      }),
    ]);
    expect(listLiveBackgroundTaskOwners).toHaveBeenCalledTimes(1);

    const listener = jest.mocked(subscribeLiveBackgroundTasks).mock
      .calls[0]?.[0];
    expect(listener).toBeDefined();
    listener?.('workspace-notified/worktree-notified/chat-notified');
    const notifiedTarget = {
      workspaceLocalId: 'workspace-notified',
      worktreeLocalId: 'worktree-notified',
      chatId: 'chat-notified',
    };
    expect(listTrackedBackgroundProcesses(notifiedTarget)).toEqual([]);

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(listTrackedBackgroundProcesses(notifiedTarget)).toEqual([
      expect.objectContaining({
        taskId: 'notified-task',
        kind: 'bash',
        status: 'running',
      }),
    ]);
    expect(getLiveBackgroundTasksForChat).toHaveBeenCalledWith(
      'workspace-notified',
      'worktree-notified',
      'chat-notified',
    );
  });
});
