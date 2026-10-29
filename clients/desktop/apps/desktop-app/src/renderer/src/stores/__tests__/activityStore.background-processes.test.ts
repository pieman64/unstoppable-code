import type {
  AgentAuditEntry,
  BackgroundProcess,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '../activityStore';

const PROJECT = 'proj';
const WORKTREE = 'wt';
const KEY = `${PROJECT}/${WORKTREE}`;

let startOutputPollingMock: jest.Mock;
let stopOutputPollingMock: jest.Mock;
let listLiveBgTasksMock: jest.Mock;
let loadHistoryMock: jest.Mock;
let loadTranscriptMock: jest.Mock;

function installApiMock(
  options: { withLiveBgTasks?: boolean } = { withLiveBgTasks: true },
): void {
  startOutputPollingMock = jest.fn().mockResolvedValue(undefined);
  stopOutputPollingMock = jest.fn().mockResolvedValue(undefined);
  listLiveBgTasksMock = jest.fn().mockResolvedValue({ chats: {} });
  loadHistoryMock = jest.fn().mockResolvedValue({ entries: [] });
  loadTranscriptMock = jest.fn().mockResolvedValue({ type: 'not_available' });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        activity: {
          startOutputPolling: startOutputPollingMock,
          stopOutputPolling: stopOutputPollingMock,
          ...(options.withLiveBgTasks
            ? { listLiveBgTasks: listLiveBgTasksMock }
            : {}),
        },
        observability: {
          loadHistory: loadHistoryMock,
          loadTranscript: loadTranscriptMock,
        },
      },
    },
  });
}

function getProcesses(): BackgroundProcess[] {
  return useActivityStore.getState().bgProcesses[KEY] ?? [];
}

type ReconstructTabs = Parameters<
  ReturnType<typeof useActivityStore.getState>['reconstructFromMessages']
>[2];

function makeWorktreeChatEntry(
  overrides: Partial<AgentAuditEntry> = {},
): AgentAuditEntry {
  const base: AgentAuditEntry = {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat',
    startedAt: '2026-09-21T17:12:11.909Z',
    completedAt: '2026-09-21T17:13:11.909Z',
    durationMs: 60_000,
    totalCostUsd: 0,
    tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {},
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId: 'chat-1',
    hasTranscript: true,
  };
  return { ...base, ...overrides };
}

/** Launch a background Bash the way a real chat does: tool_use then result. */
function launchBackgroundBash(
  options: {
    chatId?: string;
    toolUseId?: string;
    taskId?: string;
    outputFile?: string;
    command?: string;
    description?: string;
    withResult?: boolean;
  } = {},
): void {
  const chatId = options.chatId ?? 'chat-1';
  const toolUseId = options.toolUseId ?? 'toolu_bg';
  const store = useActivityStore.getState();
  store.handleToolUseBlock(
    PROJECT,
    WORKTREE,
    chatId,
    toolUseId,
    'Bash',
    JSON.stringify({
      command: options.command ?? 'npm run dev',
      description: options.description ?? options.command ?? 'npm run dev',
      run_in_background: true,
    }),
    1000,
  );
  if (options.withResult === false) return;
  store.handleToolResultBlock(
    PROJECT,
    WORKTREE,
    chatId,
    toolUseId,
    JSON.stringify({
      status: 'async_launched',
      task_id: options.taskId ?? 'task-1',
      ...(options.outputFile === undefined
        ? { output_file: '/tmp/task-1.output' }
        : { output_file: options.outputFile }),
    }),
    false,
    2000,
  );
}

beforeEach(() => {
  // The delayed output-stop timer is real work the store schedules; faking
  // timers keeps it out of the next test and out of Jest's teardown.
  jest.useFakeTimers();
  installApiMock();
  // Also drops the module-level per-chat session-id and timer bookkeeping.
  useActivityStore.getState().cleanupWorktree(PROJECT, WORKTREE);
  useActivityStore.setState({ bgProcesses: {}, toolUses: {} });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('activityStore background-only task tracking', () => {
  it('ignores a foreground task_started that owns no background process', () => {
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'fg-task',
        tool_use_id: 'toolu_fg',
        description: 'Explore the repo',
        is_backgrounded: false,
      },
      3000,
    );

    expect(getProcesses()).toEqual([]);
  });

  it('creates a process for a backgrounded task_started', () => {
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bg-task',
        tool_use_id: 'toolu_bg',
        description: 'Resumed subagent',
        is_backgrounded: true,
      },
      3000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'bg-task',
        toolUseId: 'toolu_bg',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('never creates a process from task_progress alone', () => {
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'fg-task',
        tool_use_id: 'toolu_fg',
        description: 'Reading files',
      },
      3000,
    );

    expect(getProcesses()).toEqual([]);
  });

  it('drops ambient task events', () => {
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'watcher-task',
        tool_use_id: 'toolu_watcher',
        description: 'Live update watcher',
        is_backgrounded: true,
        ambient: true,
      },
      3000,
    );

    expect(getProcesses()).toEqual([]);
  });

  it('keeps updating an existing background process from its own task events', () => {
    launchBackgroundBash({ taskId: 'task-1' });
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'toolu_bg',
        description: 'Serving on 5173',
      },
      3000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        status: 'running',
        lastDescription: 'Serving on 5173',
      }),
    ]);
  });

  it('uses the provider task id for control while retaining the poller id', () => {
    launchBackgroundBash({
      taskId: 'receipt-task',
      outputFile: '/tmp/a.output',
    });

    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'provider-task',
        tool_use_id: 'toolu_bg',
        is_backgrounded: true,
      },
      3000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'provider-task',
        outputTaskId: 'receipt-task',
      }),
    ]);
    expect(startOutputPollingMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: 'receipt-task' }),
    );
  });

  it('stops output polling with the receipt task id after provider adoption', () => {
    launchBackgroundBash({
      taskId: 'receipt-task',
      outputFile: '/tmp/a.output',
    });
    const store = useActivityStore.getState();
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'provider-task',
        tool_use_id: 'toolu_bg',
        is_backgrounded: true,
      },
      3000,
    );
    stopOutputPollingMock.mockClear();

    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_stop',
      'TaskStop',
      JSON.stringify({ task_id: 'provider-task' }),
      4000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_stop',
      JSON.stringify({ task_id: 'provider-task', status: 'stopped' }),
      false,
      5000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'provider-task',
        outputTaskId: 'receipt-task',
        status: 'stopped',
      }),
    ]);
    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'receipt-task',
    });
  });

  it('tracks a foreground Bash that gets moved to the background on timeout', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_fg_bash',
      'Bash',
      JSON.stringify({
        command: 'npm run build',
        description: 'Build the app',
      }),
      1000,
    );
    // Registered in the foreground: no card yet.
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bash-9',
        tool_use_id: 'toolu_fg_bash',
        description: 'Build the app',
        is_backgrounded: false,
      },
      2000,
    );
    expect(getProcesses()).toEqual([]);

    // The 120s timeout moves it to the background.
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bash-9',
        patch: { is_backgrounded: true },
      },
      3000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        kind: 'bash',
        toolUseId: 'toolu_fg_bash',
        taskId: 'bash-9',
        command: 'npm run build',
        description: 'Build the app',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('picks up the output file of a Bash the timeout moved to the background', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_fg_bash',
      'Bash',
      JSON.stringify({
        command: 'npm run build',
        description: 'Build the app',
      }),
      1000,
    );
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bash-9',
        tool_use_id: 'toolu_fg_bash',
        description: 'Build the app',
        is_backgrounded: false,
      },
      1500,
    );
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bash-9',
        patch: { is_backgrounded: true },
      },
      2000,
    );
    startOutputPollingMock.mockClear();
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_fg_bash',
      'Command did not complete within its 120s timeout and was moved to the background (ID: bash-9). Output is being written to: /tmp/bash-9.output. You will be notified when it completes.',
      false,
      3000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'bash-9',
        outputFile: '/tmp/bash-9.output',
        status: 'running',
      }),
    ]);
    expect(startOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'bash-9',
      outputFile: '/tmp/bash-9.output',
    });
  });

  it('keeps normalizing terminal task_updated patches', () => {
    launchBackgroundBash({ taskId: 'task-1' });
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { status: 'completed', end_time: 4000 },
      },
      4000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'completed', canStop: false }),
    ]);
  });

  it('does not let a nested subagent task event rewrite the outer process identity', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_outer',
      'Agent',
      JSON.stringify({
        prompt: 'Review the diff',
        description: 'Review the diff',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_outer',
      JSON.stringify({ status: 'async_launched', agentId: 'agent-outer' }),
      false,
      2000,
    );

    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-inner',
        tool_use_id: 'toolu_inner',
        parent_tool_use_id: 'toolu_outer',
        description: 'Nested subagent',
        is_backgrounded: true,
      },
      3000,
    );
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-inner',
        parent_tool_use_id: 'toolu_outer',
        status: 'completed',
        summary: 'Nested subagent finished',
      },
      4000,
    );

    const outer = getProcesses().find(
      (process) => process.toolUseId === 'toolu_outer',
    );
    expect(outer).toMatchObject({
      taskId: 'agent-outer',
      status: 'running',
    });
    expect(outer?.summary).toBeUndefined();
  });
});

/**
 * Main emits one of these through the normal chat event path for every task
 * still live when a chat's CLI process ends, whatever ended it.
 */
function sendSessionEndedNotification(
  taskId: string,
  toolUseId: string,
  timestamp: number,
): void {
  useActivityStore.getState().handleSdkSystemEvent(
    PROJECT,
    WORKTREE,
    'chat-1',
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: toolUseId,
      status: 'stopped',
      reason: 'session_ended',
      summary: 'Session ended before this task finished',
      canopy_synthetic: true,
    },
    timestamp,
  );
}

describe('activityStore session-ended notifications', () => {
  it('lets a re-registered background task come back to running', () => {
    launchBackgroundBash({ taskId: 'task-1' });
    const store = useActivityStore.getState();
    sendSessionEndedNotification('task-1', 'toolu_bg', 4000);
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu_bg',
        description: 'Resumed',
        is_backgrounded: true,
      },
      5000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'running', canStop: true }),
    ]);
  });

  it('keeps a terminal process terminal when a stale foreground task event arrives', () => {
    launchBackgroundBash({ taskId: 'task-1' });
    const store = useActivityStore.getState();
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'toolu_bg',
        status: 'completed',
        summary: 'Dev server exited',
      },
      4000,
    );
    store.handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'toolu_bg',
        description: 'Still going',
      },
      5000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'completed', canStop: false }),
    ]);
  });

  it('applies the synthetic session-ended notification from main', async () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    sendSessionEndedNotification('task-1', 'toolu_bg', 6000);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        status: 'stopped',
        canStop: false,
        summary: 'Session ended before this task finished',
      }),
    ]);

    jest.advanceTimersByTime(2100);
    await Promise.resolve();
    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
    });
  });
});

describe('activityStore reconstruction', () => {
  const bashToolUseBlock = {
    type: 'tool_use',
    toolUseId: 'toolu_bg',
    toolName: 'Bash',
    input: JSON.stringify({
      command: 'npm run dev',
      description: 'npm run dev',
      run_in_background: true,
    }),
  };

  it('does not force a queued process to running', () => {
    const tabs: ReconstructTabs = [
      {
        id: 'chat-1',
        messages: [{ timestamp: 1000, blocks: [bashToolUseBlock] }],
      },
    ];

    useActivityStore
      .getState()
      .reconstructFromMessages(PROJECT, WORKTREE, tabs);

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'queued', canStop: false }),
    ]);
  });

  it('carries forward learned identity for non-terminal processes', () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    useActivityStore.getState().appendBgProcessOutput({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
      outputFile: '/tmp/a.output',
      lines: ['listening on 5173'],
    });

    useActivityStore.getState().reconstructFromMessages(PROJECT, WORKTREE, [
      {
        id: 'chat-1',
        messages: [{ timestamp: 1000, blocks: [bashToolUseBlock] }],
      },
    ]);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        outputFile: '/tmp/a.output',
        outputLines: ['listening on 5173'],
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('preserves the provider task id when reconstruction sees a different receipt id', () => {
    launchBackgroundBash({
      taskId: 'receipt-task',
      outputFile: '/tmp/receipt-task.output',
    });
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'provider-task',
        tool_use_id: 'toolu_bg',
        is_backgrounded: true,
      },
      3000,
    );

    useActivityStore.getState().reconstructFromMessages(PROJECT, WORKTREE, [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1000,
            blocks: [
              bashToolUseBlock,
              {
                type: 'tool_result',
                toolUseId: 'toolu_bg',
                output: JSON.stringify({
                  status: 'async_launched',
                  task_id: 'receipt-task',
                  output_file: '/tmp/receipt-task.output',
                }),
                isError: false,
              },
            ],
          },
        ],
      },
    ]);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'provider-task',
        outputTaskId: 'receipt-task',
        status: 'running',
      }),
    ]);
  });

  it('adopts the live provider task id when liveness matches a reconstructed receipt', async () => {
    launchBackgroundBash({
      taskId: 'receipt-task',
      outputFile: '/tmp/receipt-task.output',
      command: 'npm run dev',
      description: 'Run development server',
    });
    listLiveBgTasksMock.mockResolvedValue({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [
            {
              taskId: 'provider-task',
              toolUseId: 'toolu_bg',
              description: 'npm run dev',
            },
          ],
        },
      },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'provider-task',
        outputTaskId: 'receipt-task',
        advisorDescription: 'Bash',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('restores a live task separately when another chat reuses its task id', async () => {
    launchBackgroundBash({
      chatId: 'chat-1',
      toolUseId: 'toolu_chat_1',
      taskId: 'shared-task',
    });
    listLiveBgTasksMock.mockResolvedValue({
      chats: {
        'chat-2': {
          sessionActive: true,
          liveTasks: [
            {
              taskId: 'shared-task',
              toolUseId: 'toolu_chat_2',
              description: 'Task from chat 2',
            },
          ],
        },
      },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcessLiveness(PROJECT, WORKTREE, ['chat-2']);

    expect(getProcesses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: 'chat-1',
          taskId: 'shared-task',
          toolUseId: 'toolu_chat_1',
        }),
        expect.objectContaining({
          chatId: 'chat-2',
          taskId: 'shared-task',
          toolUseId: 'toolu_chat_2',
        }),
      ]),
    );
    expect(getProcesses()).toHaveLength(2);
  });

  it('stops processes whose chat has no live session', async () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    startOutputPollingMock.mockClear();
    stopOutputPollingMock.mockClear();
    listLiveBgTasksMock.mockResolvedValue({ chats: {} });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        status: 'stopped',
        canStop: false,
        summary: 'Ended before completion was recorded',
      }),
    ]);
    expect(startOutputPollingMock).not.toHaveBeenCalled();
    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
    });
  });

  it('keeps a live task running and resumes its output polling', async () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    startOutputPollingMock.mockClear();
    listLiveBgTasksMock.mockResolvedValue({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [{ taskId: 'task-1' }],
        },
      },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'running', canStop: true }),
    ]);
    expect(startOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
      outputFile: '/tmp/a.output',
    });
  });

  it('stops a task that is absent from the live set of an active session', async () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    listLiveBgTasksMock.mockResolvedValue({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [{ taskId: 'task-other' }],
        },
      },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-1',
          status: 'stopped',
          canStop: false,
        }),
        expect.objectContaining({
          taskId: 'task-other',
          status: 'running',
          canStop: true,
        }),
      ]),
    );
  });

  it('leaves a task-less process alone while its chat session is live', async () => {
    launchBackgroundBash({ withResult: false });
    listLiveBgTasksMock.mockResolvedValue({
      chats: { 'chat-1': { sessionActive: true, liveTasks: [] } },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'queued' }),
    ]);
    expect(getProcesses()[0].taskId).toBeUndefined();
  });

  it('restores an event-only process from the live-task snapshot', async () => {
    listLiveBgTasksMock.mockResolvedValue({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [
            {
              taskId: 'task-event',
              toolUseId: 'toolu_event',
              description: 'Run the dev server',
            },
          ],
        },
      },
    });

    await useActivityStore
      .getState()
      .resolveBackgroundProcessLiveness(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'task-event',
        toolUseId: 'toolu_event',
        description: 'Run the dev server',
        advisorDescription: 'Task',
        status: 'running',
        canStop: true,
      }),
    ]);
  });

  it('prefers the observability proof over the live-set fallback', async () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    loadHistoryMock.mockResolvedValue({ entries: [makeWorktreeChatEntry()] });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'toolu_bg',
          status: 'completed',
          summary: 'Dev server exited',
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });
    listLiveBgTasksMock.mockResolvedValue({ chats: {} });

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        status: 'completed',
        summary: 'Dev server exited',
      }),
    ]);
  });

  it('falls back to resuming polling when the live-task bridge is absent', async () => {
    installApiMock({ withLiveBgTasks: false });
    useActivityStore.setState({ bgProcesses: {}, toolUses: {} });
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    startOutputPollingMock.mockClear();

    await useActivityStore
      .getState()
      .resolveBackgroundProcesses(PROJECT, WORKTREE, ['chat-1']);

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'running' }),
    ]);
    expect(startOutputPollingMock).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
      outputFile: '/tmp/a.output',
    });
  });

  it('resolves reconstructed processes after rebuilding them', () => {
    const resolveSpy = jest
      .spyOn(useActivityStore.getState(), 'resolveBackgroundProcesses')
      .mockResolvedValue(undefined);

    try {
      useActivityStore.getState().reconstructFromMessages(PROJECT, WORKTREE, [
        {
          id: 'chat-1',
          messages: [{ timestamp: 1000, blocks: [bashToolUseBlock] }],
        },
      ]);

      expect(resolveSpy).toHaveBeenCalledWith(PROJECT, WORKTREE, ['chat-1']);
    } finally {
      resolveSpy.mockRestore();
    }
  });
});

describe('activityStore background output routing', () => {
  it('ignores output for an unknown task instead of inventing a card', () => {
    useActivityStore.getState().appendBgProcessOutput({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'ghost-task',
      outputFile: '/tmp/ghost.output',
      lines: ['still running'],
    });

    expect(getProcesses()).toEqual([]);
  });

  it('does not capture a sentence-ending period as part of the output path', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Bash',
      JSON.stringify({ command: 'npm run dev', run_in_background: true }),
      1000,
    );
    // A launch receipt truncated right after the path: the period belongs to
    // the sentence, never to the filename.
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Command running in background with ID: task-1. Output is being written to: /tmp/task-1.output.',
      false,
      2000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        outputFile: '/tmp/task-1.output',
      }),
    ]);
  });

  it('matches output by output file when the task id is not known yet', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Bash',
      JSON.stringify({ command: 'npm run dev', run_in_background: true }),
      1000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Command running in background. Output is being written to: /tmp/a.output',
      false,
      2000,
    );

    store.appendBgProcessOutput({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
      outputFile: '/tmp/a.output',
      lines: ['listening on 5173'],
    });

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        toolUseId: 'toolu_bg',
        taskId: 'task-1',
        outputLines: ['listening on 5173'],
      }),
    ]);
  });
});

describe('activityStore background result parsing', () => {
  it('does not inspect ordinary tool output when no process owns it', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_read',
      'Read',
      JSON.stringify({ file_path: '/tmp/untrusted.txt' }),
      1000,
    );
    const content = {
      toJSON: (): never => {
        throw new Error('ordinary tool output was parsed');
      },
    };

    expect(() =>
      store.handleToolResultBlock(
        PROJECT,
        WORKTREE,
        'chat-1',
        'toolu_read',
        content,
        false,
        2000,
      ),
    ).not.toThrow();
    expect(getProcesses()).toEqual([]);
  });

  it('does not fail a process because a result mentions a status mid-sentence', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Bash',
      JSON.stringify({ command: 'npm run dev', run_in_background: true }),
      1000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Note that the previous run had status: failed, so watch the log. Command running in background with ID: task-1. Output is being written to: /tmp/task-1.output. You will be notified when it completes.',
      false,
      2000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ taskId: 'task-1', status: 'running' }),
    ]);
  });

  it('still fails on a JSON status field', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Bash',
      JSON.stringify({ command: 'npm run dev', run_in_background: true }),
      1000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      JSON.stringify({ status: 'failed', task_id: 'task-1' }),
      false,
      2000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('still fails on a line-leading status token', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'Bash',
      JSON.stringify({ command: 'npm run dev', run_in_background: true }),
      1000,
    );
    store.handleToolResultBlock(
      PROJECT,
      WORKTREE,
      'chat-1',
      'toolu_bg',
      'task_id: task-1\nstatus: failed\n',
      false,
      2000,
    );

    expect(getProcesses()).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });
});

describe('activityStore process end time', () => {
  function notify(
    subtype: 'task_notification' | 'task_started',
    timestamp: number,
  ): void {
    useActivityStore.getState().handleSdkSystemEvent(
      PROJECT,
      WORKTREE,
      'chat-1',
      {
        type: 'system',
        subtype,
        task_id: 'task-1',
        tool_use_id: 'toolu_bg',
        ...(subtype === 'task_notification'
          ? { status: 'completed' }
          : { is_backgrounded: true }),
      },
      timestamp,
    );
  }

  it('records when a process ends and keeps it through later output', () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    expect(getProcesses()[0]?.endedAt).toBeUndefined();

    notify('task_notification', 5000);
    jest.setSystemTime(9000);
    useActivityStore.getState().appendBgProcessOutput({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: 'chat-1',
      taskId: 'task-1',
      outputFile: '/tmp/a.output',
      lines: ['drained after the end'],
    });
    useActivityStore.getState().reconstructFromMessages(PROJECT, WORKTREE, [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'toolu_bg',
                toolName: 'Bash',
                input: JSON.stringify({
                  command: 'npm run dev',
                  run_in_background: true,
                }),
              },
            ],
          },
        ],
      },
    ]);

    expect(getProcesses()).toEqual([
      expect.objectContaining({
        status: 'completed',
        updatedAt: 9000,
        endedAt: 5000,
      }),
    ]);
  });

  it('clears the end time when the process runs again', () => {
    launchBackgroundBash({ taskId: 'task-1', outputFile: '/tmp/a.output' });
    notify('task_notification', 5000);
    notify('task_started', 6000);
    expect(getProcesses()[0]).toMatchObject({ status: 'running' });
    expect(getProcesses()[0]?.endedAt).toBeUndefined();

    notify('task_notification', 8000);
    expect(getProcesses()[0]).toMatchObject({
      status: 'completed',
      endedAt: 8000,
    });
  });
});
