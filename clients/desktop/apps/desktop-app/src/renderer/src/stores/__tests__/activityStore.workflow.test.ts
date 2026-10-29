import type {
  AgentAuditEntry,
  BackgroundProcess,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '../activityStore';

const RECEIPT = `Workflow launched in background. Task ID: whh8c9i0g
Summary: Audit how Canopy desktop interacts with git
Transcript dir: /home/u/.claude/projects/-p/sess/subagents/workflows/wf_48dd5689-0a8
Script file: /home/u/.claude/projects/-p/sess/workflows/scripts/git-ci-audit-wf_48dd5689-0a8.js
Run ID: wf_48dd5689-0a8
You will be notified when it completes.`;

const SCRIPT = `export const meta = { name: 'git-ci-audit', description: 'Audit git' }`;

function getProcesses(
  projectId: string,
  worktreeId: string,
): BackgroundProcess[] {
  return (
    useActivityStore.getState().bgProcesses[`${projectId}/${worktreeId}`] ?? []
  );
}

let loadHistoryMock: jest.Mock;
let loadTranscriptMock: jest.Mock;
let startOutputPollingMock: jest.Mock;
let stopOutputPollingMock: jest.Mock;

function installApiMock(): void {
  loadHistoryMock = jest.fn().mockResolvedValue({ entries: [] });
  loadTranscriptMock = jest.fn().mockResolvedValue({ type: 'not_available' });
  startOutputPollingMock = jest.fn().mockResolvedValue(undefined);
  stopOutputPollingMock = jest.fn().mockResolvedValue(undefined);

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        activity: {
          startOutputPolling: startOutputPollingMock,
          stopOutputPolling: stopOutputPollingMock,
        },
        observability: {
          loadHistory: loadHistoryMock,
          loadTranscript: loadTranscriptMock,
        },
      },
    },
  });
}

function makeWorktreeChatEntry(
  overrides: Partial<AgentAuditEntry> = {},
): AgentAuditEntry {
  const base: AgentAuditEntry = {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat',
    startedAt: '2026-07-02T17:12:11.909Z',
    completedAt: '2026-07-02T17:13:11.909Z',
    durationMs: 60_000,
    totalCostUsd: 0,
    tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {},
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    hasTranscript: true,
  };
  return { ...base, ...overrides };
}

describe('activityStore workflow tracking', () => {
  beforeEach(() => {
    installApiMock();
    useActivityStore.setState({ bgProcesses: {}, toolUses: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a workflow-kind process from a Workflow tool_use + receipt', () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      'Workflow',
      JSON.stringify({ script: SCRIPT }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      RECEIPT,
      false,
      2000,
    );

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    const wf = processes[0];
    expect(wf.kind).toBe('workflow');
    expect(wf.description).toBe('git-ci-audit');
    expect(wf.taskId).toBe('whh8c9i0g');
    expect(wf.runId).toBe('wf_48dd5689-0a8');
    expect(wf.transcriptDir).toBe(
      '/home/u/.claude/projects/-p/sess/subagents/workflows/wf_48dd5689-0a8',
    );
    expect(wf.status).toBe('running');
  });

  it('reconstructs the workflow process from persisted messages', () => {
    // Typed to the exact `reconstructFromMessages` `tabs` parameter type (the
    // structural `tabs[].messages[].blocks[]` subset the method reads) instead
    // of the full `ChatTab` shape, so the fixture stays valid without an `as`
    // cast.
    const tabs: Parameters<
      ReturnType<typeof useActivityStore.getState>['reconstructFromMessages']
    >[2] = [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'toolu_1',
                toolName: 'Workflow',
                input: JSON.stringify({ script: SCRIPT }),
              },
              {
                type: 'tool_result',
                toolUseId: 'toolu_1',
                output: RECEIPT,
                isError: false,
              },
            ],
          },
        ],
      },
    ];

    useActivityStore.getState().reconstructFromMessages('proj', 'wt', tabs);

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    expect(processes[0].kind).toBe('workflow');
    expect(processes[0].runId).toBe('wf_48dd5689-0a8');
  });

  it('preserves terminal background-process state across message reconstruction', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      'Bash',
      JSON.stringify({
        command: 'sleep 60',
        description: 'Sleep briefly',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      JSON.stringify({
        status: 'async_launched',
        task_id: 'task-1',
        output_file: '/private/tmp/task-1.output',
      }),
      false,
      2000,
    );
    store.handleSdkSystemEvent(
      'proj',
      'wt',
      'chat-1',
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        status: 'stopped',
        summary: 'Stopped by user',
      },
      3000,
    );

    store.reconstructFromMessages('proj', 'wt', [
      {
        id: 'chat-1',
        messages: [
          {
            timestamp: 1000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'toolu_1',
                toolName: 'Bash',
                input: JSON.stringify({
                  command: 'sleep 60',
                  description: 'Sleep briefly',
                  run_in_background: true,
                }),
              },
              {
                type: 'tool_result',
                toolUseId: 'toolu_1',
                output: JSON.stringify({
                  status: 'async_launched',
                  task_id: 'task-1',
                  output_file: '/private/tmp/task-1.output',
                }),
                isError: false,
              },
            ],
          },
        ],
      },
    ]);

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    expect(processes[0].status).toBe('stopped');
    expect(processes[0].canStop).toBe(false);

    jest.advanceTimersByTime(2100);
    await Promise.resolve();
  });

  it('reconciles stale running processes from observability task notifications', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      'Agent',
      JSON.stringify({
        prompt: 'Fix review comments',
        description: 'Address review comments',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      JSON.stringify({
        status: 'async_launched',
        agentId: 'agent-1',
        output_file: '/private/tmp/agent-1.output',
      }),
      false,
      2000,
    );

    loadHistoryMock.mockResolvedValue({
      entries: [makeWorktreeChatEntry()],
    });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-1',
          tool_use_id: 'toolu_1',
          status: 'completed',
          output_file: '/private/tmp/agent-1.output',
          summary: 'Agent finished',
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    expect(processes[0].status).toBe('completed');
    expect(processes[0].summary).toBe('Agent finished');
    expect(processes[0].canStop).toBe(false);
    expect(startOutputPollingMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'agent-1',
      outputFile: '/private/tmp/agent-1.output',
    });

    jest.advanceTimersByTime(2100);
    await Promise.resolve();

    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'agent-1',
    });
    jest.useRealTimers();
  });

  it('reconciles stale running processes from observability task updates', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      'Agent',
      JSON.stringify({
        prompt: 'Read package metadata',
        description: 'General-purpose research demo',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      JSON.stringify({
        status: 'async_launched',
        agentId: 'agent-1',
        output_file: '/private/tmp/agent-1.output',
      }),
      false,
      2000,
    );
    store.handleSdkSystemEvent(
      'proj',
      'wt',
      'chat-1',
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'agent-1',
        tool_use_id: 'toolu_1',
        description: 'Reading package.json',
      },
      3000,
    );

    loadHistoryMock.mockResolvedValue({
      entries: [makeWorktreeChatEntry()],
    });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'system',
          subtype: 'task_updated',
          task_id: 'agent-1',
          patch: {
            status: 'completed',
            end_time: 4000,
          },
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    expect(processes[0].status).toBe('completed');
    expect(processes[0].lastDescription).toBe('Reading package.json');
    expect(processes[0].canStop).toBe(false);

    jest.advanceTimersByTime(2100);
    await Promise.resolve();

    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'agent-1',
    });
    jest.useRealTimers();
  });

  it('reconciles stale running bash processes from notification results', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_bash',
      'Bash',
      JSON.stringify({
        command: 'sleep 5 && echo "done"',
        description: 'Background process example: sleep and echo',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_bash',
      'Command running in background with ID: bash-1. Output is being written to: /private/tmp/bash-1.output. You will be notified when it completes. To check interim output, use Read on that file path.',
      false,
      2000,
    );

    loadHistoryMock.mockResolvedValue({
      entries: [makeWorktreeChatEntry()],
    });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result:
            '**Background process completed!**\n\n- **Background Bash**: Slept for 5 seconds, echoed completion message (exit code 0)',
          origin: { kind: 'task-notification' },
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    const processes = getProcesses('proj', 'wt');
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({
      kind: 'bash',
      taskId: 'bash-1',
      outputFile: '/private/tmp/bash-1.output',
      status: 'completed',
      summary: 'Background process completed',
      canStop: false,
    });

    jest.advanceTimersByTime(2100);
    await Promise.resolve();

    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'bash-1',
    });
    jest.useRealTimers();
  });

  it('completes missing tasks from live background task snapshots', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    for (const suffix of ['one', 'two']) {
      store.handleToolUseBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        'Bash',
        JSON.stringify({
          command: `run-${suffix}`,
          description: `Run task ${suffix}`,
          run_in_background: true,
        }),
        1000,
      );
      store.handleToolResultBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        JSON.stringify({
          status: 'async_launched',
          task_id: `task-${suffix}`,
          output_file: `/private/tmp/task-${suffix}.output`,
        }),
        false,
        2000,
      );
    }

    store.handleSdkSystemEvent(
      'proj',
      'wt',
      'chat-1',
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{}],
      },
      2500,
    );
    expect(getProcesses('proj', 'wt')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-one', status: 'running' }),
        expect.objectContaining({ taskId: 'task-two', status: 'running' }),
      ]),
    );

    store.handleSdkSystemEvent(
      'proj',
      'wt',
      'chat-1',
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          {
            task_id: 'task-two',
            task_type: 'local_bash',
            description: 'Run task two',
          },
        ],
      },
      3000,
    );

    expect(getProcesses('proj', 'wt')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-one',
          status: 'completed',
          canStop: false,
        }),
        expect.objectContaining({
          taskId: 'task-two',
          status: 'running',
          canStop: true,
        }),
      ]),
    );

    jest.advanceTimersByTime(2100);
    await Promise.resolve();
    expect(stopOutputPollingMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      taskId: 'task-one',
    });
  });

  it('uses ordered task snapshots without completing tasks launched later', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    for (const suffix of ['one', 'two']) {
      store.handleToolUseBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        'Bash',
        JSON.stringify({
          command: `run-${suffix}`,
          run_in_background: true,
        }),
        1000,
      );
      store.handleToolResultBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        JSON.stringify({
          status: 'async_launched',
          task_id: `task-${suffix}`,
          output_file: `/private/tmp/task-${suffix}.output`,
        }),
        false,
        2000,
      );
    }

    loadHistoryMock.mockResolvedValue({ entries: [makeWorktreeChatEntry()] });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'task-one' }],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-one',
          tool_use_id: 'toolu_one',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'task-two' }],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-two',
          tool_use_id: 'toolu_two',
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    expect(getProcesses('proj', 'wt')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-one', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-two', status: 'running' }),
      ]),
    );
  });

  it('reconciles raw user task notifications by task id', async () => {
    jest.useFakeTimers();
    const store = useActivityStore.getState();
    for (const suffix of ['one', 'two']) {
      store.handleToolUseBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        'Bash',
        JSON.stringify({ command: `run-${suffix}`, run_in_background: true }),
        1000,
      );
      store.handleToolResultBlock(
        'proj',
        'wt',
        'chat-1',
        `toolu_${suffix}`,
        JSON.stringify({
          status: 'async_launched',
          task_id: `task-${suffix}`,
        }),
        false,
        2000,
      );
    }

    loadHistoryMock.mockResolvedValue({ entries: [makeWorktreeChatEntry()] });
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({
          type: 'user',
          origin: { kind: 'task-notification' },
          message: {
            role: 'user',
            content:
              '<task-notification>\n<task-id>task-one</task-id>\n<status>completed</status>\n</task-notification>',
          },
        }),
      ],
      truncation: { truncated: false, maxBytes: 1000, storedBytes: 100 },
      injectedPrompts: [],
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    expect(getProcesses('proj', 'wt')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-one', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-two', status: 'running' }),
      ]),
    );
  });

  it('loads observability transcripts with bounded concurrency', async () => {
    const store = useActivityStore.getState();
    store.handleToolUseBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      'Agent',
      JSON.stringify({
        prompt: 'Fix review comments',
        description: 'Address review comments',
        run_in_background: true,
      }),
      1000,
    );
    store.handleToolResultBlock(
      'proj',
      'wt',
      'chat-1',
      'toolu_1',
      JSON.stringify({
        status: 'async_launched',
        agentId: 'agent-1',
        output_file: '/private/tmp/agent-1.output',
      }),
      false,
      2000,
    );

    loadHistoryMock.mockResolvedValue({
      entries: Array.from({ length: 10 }, (_, index) =>
        makeWorktreeChatEntry({
          id: `entry-${index}`,
          startedAt: `2026-07-02T17:${String(index).padStart(2, '0')}:11.909Z`,
        }),
      ),
    });

    let activeLoads = 0;
    let maxActiveLoads = 0;
    loadTranscriptMock.mockImplementation(async () => {
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
      return { type: 'not_available' };
    });

    await store.reconcileBackgroundProcessesFromObservability('proj', 'wt', [
      'chat-1',
    ]);

    expect(loadTranscriptMock).toHaveBeenCalledTimes(10);
    expect(maxActiveLoads).toBeLessThanOrEqual(6);
  });
});
