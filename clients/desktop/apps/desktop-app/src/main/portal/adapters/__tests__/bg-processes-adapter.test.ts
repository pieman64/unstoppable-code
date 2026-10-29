import type { PortalEventEnvelope } from '@canopy/desktop-shared/types';
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
} from '../bg-processes-adapter';

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
});
