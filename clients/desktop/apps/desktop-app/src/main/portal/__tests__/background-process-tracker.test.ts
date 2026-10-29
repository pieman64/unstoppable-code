import {
  clearBackgroundProcessTracker,
  listTrackedBackgroundProcesses,
  recordBackgroundProcessChatEvent,
  subscribeBackgroundProcessTracker,
} from '../background-process-tracker';

const target = {
  workspaceLocalId: 'workspace-1',
  worktreeLocalId: 'worktree-1',
  chatId: 'chat-1',
};

describe('background-process tracker', () => {
  beforeEach(() => {
    clearBackgroundProcessTracker();
  });

  it('tracks the renderer event path from queued through running and completed', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundProcessTracker(listener);
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: {
                run_in_background: true,
                description: 'Build project',
              },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: { task_id: 'task-1', status: 'async_launched' },
            },
          ],
        },
      },
      200,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        summary: 'Build passed',
      },
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        taskId: 'task-1',
        kind: 'bash',
        description: 'Build project',
        status: 'completed',
        startedAt: 100,
        updatedAt: 300,
        summary: 'Build passed',
        canStop: false,
      }),
    ]);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('ignores foreground tools and maps terminal status varieties', () => {
    recordBackgroundProcessChatEvent(target, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'foreground',
            name: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
    });
    // A terminal notification only settles a task that is already tracked as
    // background work, so register one first.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-stopped',
        description: 'Long build',
        is_backgrounded: true,
      },
      300,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-stopped',
        status: 'cancelled',
      },
      400,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'task-stopped',
        status: 'stopped',
        canStop: false,
      }),
    ]);
  });

  it('tracks the Windows PowerShell tool under the bash kind', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-ps',
              name: 'PowerShell',
              input: {
                run_in_background: true,
                description: 'Build project',
              },
            },
          ],
        },
      },
      100,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'tool-ps',
        kind: 'bash',
        description: 'Build project',
      }),
    ]);
  });

  it('never projects the raw command and keeps queued rows unstoppable', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-cmd',
              name: 'Bash',
              input: {
                run_in_background: true,
                command: 'curl -H "Authorization: Bearer secret" https://x',
              },
            },
          ],
        },
      },
      100,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        description: 'Bash',
        status: 'queued',
        canStop: false,
      }),
    ]);
    expect(
      JSON.stringify(listTrackedBackgroundProcesses(target)),
    ).not.toContain('secret');
  });

  it('does not resurrect a terminal process on late non-terminal events', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-late',
        is_backgrounded: true,
      },
      50,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-late',
        status: 'completed',
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-late',
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'task-late',
        status: 'completed',
        canStop: false,
      }),
    ]);
  });

  it('maps an is_error tool result to failed and unstoppable', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-err',
              name: 'Bash',
              input: { run_in_background: true, description: 'Long build' },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-err',
              content: { task_id: 'task-err' },
              is_error: true,
            },
          ],
        },
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-err',
        status: 'failed',
        canStop: false,
      }),
    ]);

    // A late non-terminal tool_result must not resurrect the failed row.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-err',
              content: { task_id: 'task-err', status: 'async_launched' },
            },
          ],
        },
      },
      300,
    );
    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({ status: 'failed', canStop: false }),
    ]);
  });

  it('caps retained terminal processes per worktree', () => {
    for (let index = 0; index < 60; index += 1) {
      recordBackgroundProcessChatEvent(
        target,
        {
          type: 'system',
          subtype: 'task_started',
          task_id: `task-${index}`,
          is_backgrounded: true,
        },
        index,
      );
      recordBackgroundProcessChatEvent(
        target,
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: `task-${index}`,
          status: 'completed',
        },
        index,
      );
    }

    const processes = listTrackedBackgroundProcesses(target);
    expect(processes.length).toBeLessThanOrEqual(50);
    // The newest rows survive; the oldest terminal rows are evicted.
    expect(processes.some((process) => process.taskId === 'task-59')).toBe(
      true,
    );
    expect(processes.some((process) => process.taskId === 'task-0')).toBe(
      false,
    );
  });

  it('never creates a process for a foreground task or a bare progress edge', () => {
    // The SDK emits task_started/task_progress for FOREGROUND tasks too.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-foreground',
        tool_use_id: 'tool-foreground',
        description: 'Run tests',
        is_backgrounded: false,
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-progress-only',
        description: 'Still working',
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([]);
  });

  it('creates a process for a backgrounded task_started', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundProcessTracker(listener);

    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-bg',
        description: 'Watch the build',
        is_backgrounded: true,
      },
      100,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'task-bg',
        status: 'running',
        lastDescription: 'Watch the build',
        canStop: true,
      }),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('settles tasks omitted from an authoritative replacement snapshot', () => {
    for (const taskId of ['task-a', 'task-b']) {
      recordBackgroundProcessChatEvent(
        target,
        {
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          is_backgrounded: true,
        },
        100,
      );
    }

    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-b' }],
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-a', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-b', status: 'running' }),
      ]),
    );
  });

  it('drops ambient tasks, which are not activity', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-ambient',
        description: 'Watch files for changes',
        is_backgrounded: true,
        ambient: true,
      },
      100,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([]);
  });

  it('updates a tool-use-created process when task_started omits is_backgrounded', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-wf',
              name: 'Workflow',
              input: { description: 'Spec workflow' },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-wf',
        tool_use_id: 'tool-wf',
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'tool-wf',
        kind: 'workflow',
        taskId: 'task-wf',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('tracks a foreground Bash that task_updated moves to the background', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-timeout',
              name: 'Bash',
              input: { command: 'npm run build', description: 'Build project' },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-timeout',
        tool_use_id: 'tool-timeout',
        is_backgrounded: false,
      },
      200,
    );
    expect(listTrackedBackgroundProcesses(target)).toEqual([]);

    // The foreground call outlived its timeout; the move to the background
    // arrives as a patch that carries no tool_use_id.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-timeout',
        patch: { is_backgrounded: true },
      },
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'tool-timeout',
        toolUseId: 'tool-timeout',
        taskId: 'task-timeout',
        kind: 'bash',
        description: 'Build project',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('settles a tracked process from a terminal task_updated patch', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-patch',
        is_backgrounded: true,
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-patch',
        patch: { status: 'killed' },
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'task-patch',
        status: 'stopped',
        canStop: false,
      }),
    ]);
  });

  it('revives a stopped task when it is re-registered in the background', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-resumed',
        is_backgrounded: true,
      },
      100,
    );
    // The chat's CLI process went away under the live task.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-resumed',
        status: 'stopped',
        reason: 'session_ended',
        summary: 'Stopped when the chat session ended',
        canopy_synthetic: true,
      },
      200,
    );

    // A foreground progress edge must not unwedge the stopped row.
    recordBackgroundProcessChatEvent(
      target,
      { type: 'system', subtype: 'task_progress', task_id: 'task-resumed' },
      300,
    );
    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({ taskId: 'task-resumed', status: 'stopped' }),
    ]);

    // A resumed subagent is always re-registered in the background.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-resumed',
        is_backgrounded: true,
      },
      400,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'task-resumed',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('accepts the synthetic session-ended notification as terminal', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-ended',
              name: 'Bash',
              input: { run_in_background: true, description: 'Long build' },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-ended',
              content: { task_id: 'task-ended', status: 'async_launched' },
            },
          ],
        },
      },
      200,
    );

    // Minted by main/lib/session-ended-background-tasks.ts when the owning
    // provider session goes away without a terminal bookend.
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-ended',
        tool_use_id: 'tool-ended',
        status: 'stopped',
        reason: 'session_ended',
        summary: 'Stopped when the chat session ended',
        canopy_synthetic: true,
      },
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-ended',
        taskId: 'task-ended',
        status: 'stopped',
        summary: 'Stopped when the chat session ended',
        canStop: false,
      }),
    ]);
  });

  it('never adopts a nested subagent task id through parent_tool_use_id', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-outer',
              name: 'Task',
              input: { run_in_background: true, description: 'Review agent' },
            },
          ],
        },
      },
      100,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-outer',
              content: { task_id: 'task-outer', status: 'async_launched' },
            },
          ],
        },
      },
      200,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-inner',
        parent_tool_use_id: 'tool-outer',
        status: 'completed',
        summary: 'Inner subagent done',
      },
      300,
    );

    const processes = listTrackedBackgroundProcesses(target);
    expect(processes).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-outer',
        taskId: 'task-outer',
        status: 'running',
        canStop: true,
      }),
    ]);
    expect(processes[0]?.summary).toBeUndefined();
  });
});
