import {
  clearBackgroundProcessTracker,
  listTrackedBackgroundProcesses,
  reconcileBackgroundProcessLiveSet,
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

  it('correlates an unflagged Agent use with its live task', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'agent-1',
              name: 'Agent',
              input: { description: 'Investigate', prompt: '…' },
            },
          ],
        },
      },
      100,
    );

    reconcileBackgroundProcessLiveSet(
      target,
      [
        {
          taskId: 't1',
          toolUseId: 'agent-1',
          taskType: 'local_agent',
          description: 'Investigate',
        },
      ],
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        toolUseId: 'agent-1',
        kind: 'agent',
        description: 'Investigate',
        startedAt: 100,
        updatedAt: 200,
        lastDescription: 'Investigate',
        taskId: 't1',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('tracks a Monitor tool use under the bash kind', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'monitor-1',
              name: 'Monitor',
              input: {
                command: 'tail -f build.log',
                description: 'Build log errors',
                timeout_ms: 300000,
              },
            },
          ],
        },
      },
      100,
    );

    reconcileBackgroundProcessLiveSet(
      target,
      [
        {
          taskId: 't1',
          toolUseId: 'monitor-1',
          taskType: 'local_bash',
          description: 'Build log errors',
        },
      ],
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'monitor-1',
        kind: 'bash',
        taskId: 't1',
        status: 'running',
      }),
    ]);
  });

  it('creates task-only live rows with task-type kinds and safe descriptions', () => {
    reconcileBackgroundProcessLiveSet(
      target,
      [
        {
          taskId: 'bash-task',
          taskType: 'local_bash',
          description: 'Run tests',
        },
        { taskId: 'unknown-task', taskType: 'future_type' },
        { taskId: '' },
      ],
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'bash-task',
          kind: 'bash',
          description: 'Run tests',
          startedAt: 200,
          updatedAt: 200,
          status: 'running',
          canStop: true,
        }),
        expect.objectContaining({
          id: 'unknown-task',
          kind: 'task',
          description: 'Background task',
        }),
      ]),
    );
  });

  it('settles only previously reported live tasks when they leave the set or session', () => {
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'leaves-set' }, { taskId: 'session-gone' }],
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'session-gone' }],
      200,
    );
    reconcileBackgroundProcessLiveSet(target, undefined, 300);

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'leaves-set',
          status: 'completed',
          summary: 'Background process completed',
          canStop: false,
          updatedAt: 200,
        }),
        expect.objectContaining({
          taskId: 'session-gone',
          status: 'completed',
          summary: 'Background process completed',
          canStop: false,
          updatedAt: 300,
        }),
      ]),
    );
  });

  it('lets a later terminal notification win over either live-set ordering', () => {
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'remove-first' }],
      100,
    );
    reconcileBackgroundProcessLiveSet(target, [], 200);
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'remove-first',
        status: 'stopped',
        summary: 'Stopped when the chat was archived',
      },
      300,
    );

    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'notify-first' }],
      400,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'notify-first',
        status: 'stopped',
        summary: 'Stopped when the chat was archived',
      },
      500,
    );
    reconcileBackgroundProcessLiveSet(target, [], 600);

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'remove-first',
          status: 'stopped',
          summary: 'Stopped when the chat was archived',
        }),
        expect.objectContaining({
          taskId: 'notify-first',
          status: 'stopped',
          summary: 'Stopped when the chat was archived',
        }),
      ]),
    );
  });

  it('settles a removed live agent without touching an unreported Bash task', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'bash-queued',
              name: 'Bash',
              input: { run_in_background: true, description: 'Build' },
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
              tool_use_id: 'bash-queued',
              content: { task_id: 'never-reported' },
            },
          ],
        },
      },
      150,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'reported-agent' }],
      200,
    );
    reconcileBackgroundProcessLiveSet(target, [], 300);

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'never-reported',
          status: 'running',
        }),
        expect.objectContaining({
          taskId: 'reported-agent',
          status: 'completed',
        }),
      ]),
    );
  });

  it('runs a resumed Codex child again when its task returns to the live set', () => {
    const child = { taskId: 'codex-thread-1', taskType: 'local_agent' };
    reconcileBackgroundProcessLiveSet(target, [child], 100);
    // Turn t1 ends: the child leaves the live set.
    reconcileBackgroundProcessLiveSet(target, [], 200);
    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'codex-thread-1',
        status: 'completed',
      }),
    ]);

    // Turn t2 starts on the same thread, so the same task id.
    reconcileBackgroundProcessLiveSet(target, [child], 300);

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'codex-thread-1',
        status: 'running',
        canStop: true,
        updatedAt: 300,
      }),
    ]);
  });

  it('keeps a row a notification ended while its task is still listed', () => {
    reconcileBackgroundProcessLiveSet(target, [{ taskId: 'ending' }], 100);
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'ending',
        status: 'completed',
        summary: 'Done',
      },
      150,
    );
    // A snapshot published before the session dropped the task.
    reconcileBackgroundProcessLiveSet(target, [{ taskId: 'ending' }], 160);

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({ taskId: 'ending', status: 'completed' }),
    ]);
  });

  it('does not resurrect a reconciled completed row on a late async tool result', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'late-agent',
              name: 'Agent',
              input: { description: 'Research' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'late-task', toolUseId: 'late-agent' }],
      200,
    );
    reconcileBackgroundProcessLiveSet(target, [], 300);
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'late-agent',
              content: JSON.stringify({
                task_id: 'late-task',
                status: 'async_launched',
              }),
            },
          ],
        },
      },
      400,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({ status: 'completed', canStop: false }),
    ]);
  });

  it('lets an error result fail a live row and preserves that terminal status on removal', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'error-agent',
              name: 'Agent',
              input: { description: 'Inspect' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'error-task', toolUseId: 'error-agent' }],
      200,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'error-agent',
              content: 'Provider failed',
              is_error: true,
            },
          ],
        },
      },
      300,
    );
    reconcileBackgroundProcessLiveSet(target, [], 400);

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'error-task',
        status: 'failed',
        canStop: false,
      }),
    ]);
  });

  it('recognizes async Agent result text but ignores unrelated foreground results', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'async-agent',
              name: 'Agent',
              input: { description: 'Inspect code' },
            },
            {
              type: 'tool_use',
              id: 'async-task',
              name: 'Task',
              input: { description: 'Run task' },
            },
            {
              type: 'tool_use',
              id: 'foreground-bash',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            {
              type: 'tool_use',
              id: 'foreground-read',
              name: 'Read',
              input: { file_path: 'secret.txt' },
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
              tool_use_id: 'async-agent',
              content: [
                {
                  type: 'text',
                  text: 'Async agent launched successfully. agentId: agent-1',
                },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'async-task',
              content: 'Async agent launched successfully. agentId: task-1',
            },
            {
              type: 'tool_result',
              tool_use_id: 'foreground-bash',
              content: 'pwd output',
            },
            {
              type: 'tool_result',
              tool_use_id: 'foreground-read',
              content: 'file contents',
            },
          ],
        },
      },
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'async-agent',
          kind: 'agent',
          description: 'Inspect code',
          status: 'running',
        }),
        expect.objectContaining({
          id: 'async-task',
          kind: 'task',
          description: 'Run task',
          status: 'running',
        }),
      ]),
    );
    expect(listTrackedBackgroundProcesses(target)).toHaveLength(2);
  });

  it('merges duplicate task and tool-use identities into the tool-use-owned row', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'duplicate-use',
              name: 'Bash',
              input: { run_in_background: true, description: 'Build' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'duplicate-task' }],
      200,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'duplicate-task', toolUseId: 'duplicate-use' }],
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'duplicate-use',
        toolUseId: 'duplicate-use',
        kind: 'bash',
        description: 'Build',
        startedAt: 100,
        taskId: 'duplicate-task',
        status: 'running',
      }),
    ]);
  });

  it('merges duplicate rows for a task_started edge as well as a live snapshot', () => {
    const otherChat = { ...target, chatId: 'duplicate-event-chat' };
    recordBackgroundProcessChatEvent(
      otherChat,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'event-use',
              name: 'Bash',
              input: { run_in_background: true, description: 'Build' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      otherChat,
      [{ taskId: 'event-task' }],
      200,
    );
    recordBackgroundProcessChatEvent(
      otherChat,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'event-task',
        tool_use_id: 'event-use',
        is_backgrounded: true,
      },
      300,
    );

    expect(listTrackedBackgroundProcesses(otherChat)).toEqual([
      expect.objectContaining({
        id: 'event-use',
        toolUseId: 'event-use',
        taskId: 'event-task',
        status: 'running',
      }),
    ]);
  });

  it('preserves terminal evidence when duplicate task and tool-use rows merge', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'terminal-use',
              name: 'Bash',
              input: { run_in_background: true, description: 'Build' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'terminal-task' }],
      200,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'terminal-task',
        status: 'stopped',
        summary: 'Stopped by provider',
      },
      250,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'terminal-task', toolUseId: 'terminal-use' }],
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'terminal-use',
        taskId: 'terminal-task',
        status: 'stopped',
        summary: 'Stopped by provider',
        canStop: false,
      }),
    ]);
  });

  it('keeps the first learned task id and settles by its remembered tool use', () => {
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'first-task', toolUseId: 'first-use' }],
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'later-task', toolUseId: 'first-use' }],
      200,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({ taskId: 'first-task', status: 'running' }),
    ]);

    reconcileBackgroundProcessLiveSet(target, [], 300);

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        taskId: 'first-task',
        status: 'completed',
        summary: 'Background process completed',
      }),
    ]);
  });

  it('does not settle another chat row with the same task id', () => {
    const otherChat = { ...target, chatId: 'other-chat' };
    reconcileBackgroundProcessLiveSet(
      otherChat,
      [{ taskId: 'same-task' }],
      100,
    );
    reconcileBackgroundProcessLiveSet(target, [{ taskId: 'same-task' }], 100);
    reconcileBackgroundProcessLiveSet(target, [], 200);

    expect(
      listTrackedBackgroundProcesses(target).filter(
        (process) => process.chatId === target.chatId,
      ),
    ).toEqual([
      expect.objectContaining({ taskId: 'same-task', status: 'completed' }),
    ]);
    expect(
      listTrackedBackgroundProcesses(otherChat).filter(
        (process) => process.chatId === otherChat.chatId,
      ),
    ).toEqual([
      expect.objectContaining({ taskId: 'same-task', status: 'running' }),
    ]);
  });

  it('leaves queued rows untouched and does not notify for no-op reconciliations', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'still-queued',
              name: 'Bash',
              input: { run_in_background: true, description: 'Not launched' },
            },
          ],
        },
      },
      100,
    );
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundProcessTracker(listener);

    reconcileBackgroundProcessLiveSet(target, [], 200);
    reconcileBackgroundProcessLiveSet(target, undefined, 300);

    const processes = listTrackedBackgroundProcesses(target);
    expect(processes).toEqual([
      expect.objectContaining({
        id: 'still-queued',
        status: 'queued',
        canStop: false,
      }),
    ]);
    expect(processes[0]).not.toHaveProperty('taskId');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('adopts the real tool-use id onto a row first seen from an ID-only live task', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_real',
              name: 'Agent',
              input: { description: 'Investigate', prompt: 'Look around' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'agent-task', taskType: 'local_agent' }],
      200,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-task',
        tool_use_id: 'toolu_real',
        is_backgrounded: true,
      },
      300,
    );

    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'agent-task',
        toolUseId: 'toolu_real',
        taskId: 'agent-task',
        kind: 'agent',
        description: 'Investigate',
        startedAt: 100,
        status: 'running',
      }),
    ]);
  });

  it('joins a text async-launch acknowledgement to the ID-only live row for its agent', () => {
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ack',
              name: 'Agent',
              input: { description: 'Investigate', prompt: 'Look around' },
            },
          ],
        },
      },
      100,
    );
    reconcileBackgroundProcessLiveSet(
      target,
      [{ taskId: 'abc123', taskType: 'local_agent' }],
      150,
    );
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ack',
              content: [
                {
                  type: 'text',
                  text: 'Async agent launched successfully.\nagentId: abc123 (internal ID)',
                },
              ],
            },
          ],
        },
      },
      200,
    );
    reconcileBackgroundProcessLiveSet(target, [], 300);
    recordBackgroundProcessChatEvent(
      target,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'abc123',
        status: 'completed',
      },
      400,
    );

    const processes = listTrackedBackgroundProcesses(target);
    expect(processes).toHaveLength(1);
    expect(processes[0]).toEqual(
      expect.objectContaining({
        taskId: 'abc123',
        toolUseId: 'toolu_ack',
        kind: 'agent',
        status: 'completed',
        canStop: false,
      }),
    );
  });

  it('does not notify when a progress-only reconciliation repeats the same membership', () => {
    const live = [
      {
        taskId: 'steady-task',
        toolUseId: 'steady-tool',
        taskType: 'local_agent',
        description: 'Steady agent',
      },
    ];
    reconcileBackgroundProcessLiveSet(target, live, 100);
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundProcessTracker(listener);

    reconcileBackgroundProcessLiveSet(
      target,
      [{ ...live[0], usage: { totalTokens: 10 } }],
      200,
    );

    expect(listener).not.toHaveBeenCalled();
    expect(listTrackedBackgroundProcesses(target)).toEqual([
      expect.objectContaining({
        id: 'steady-tool',
        status: 'running',
        updatedAt: 100,
      }),
    ]);
    unsubscribe();
  });
});
