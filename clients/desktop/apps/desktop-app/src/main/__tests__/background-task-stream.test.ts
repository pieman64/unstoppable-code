const mockEmitSessionEndedBackgroundTaskNotification = jest.fn();
jest.mock('../lib/session-ended-background-tasks', () => ({
  get emitSessionEndedBackgroundTaskNotification(): typeof mockEmitSessionEndedBackgroundTaskNotification {
    return mockEmitSessionEndedBackgroundTaskNotification;
  },
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const mockWakeLockAcquire = jest.fn();
const mockWakeLockRelease = jest.fn();
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    get acquire(): typeof mockWakeLockAcquire {
      return mockWakeLockAcquire;
    },
    get release(): typeof mockWakeLockRelease {
      return mockWakeLockRelease;
    },
  })),
}));

jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../lib/bg-output-poller', () => ({
  flushAndStopOutputPollingForSession: jest.fn().mockResolvedValue(undefined),
  stopAllOutputPolling: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../auth/provider-auth-state', () => ({
  peekProviderNativeAuthAvailability: jest.fn(() => ({ ollama: true })),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn().mockResolvedValue(false),
}));

import type { AgentSession } from '../agents/types';
import {
  applyE2eIngestedLiveBackgroundTaskEvent,
  destroySession,
  destroySessionsByModel,
  destroySessionsByProvider,
  getLiveBackgroundTaskSnapshot,
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  markSessionTeardownCause,
  recordSessionEvent,
  registerSession,
  resetSessionLiveBackgroundTasks,
  subscribeLiveBackgroundTasks,
  unregisterSession,
} from '../agents/session-manager';
import * as sessionManagerExports from '../agents/session-manager';
import { flushAndStopOutputPollingForSession } from '../lib/bg-output-poller';
import { logMainProcessWarn } from '../lib/main-process-logging';

const mockLogMainProcessWarn = jest.mocked(logMainProcessWarn);

function isUnknownFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function invokeSessionManagerExport(name: string, ...args: unknown[]): unknown {
  const exported: unknown = Reflect.get(sessionManagerExports, name);
  if (!isUnknownFunction(exported)) return undefined;
  return exported(...args);
}

function createSession(): AgentSession {
  return {
    sendMessage: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    setApprovalMode: jest.fn().mockResolvedValue(undefined),
    setThinkingLevel: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  };
}

function startSession(key: string): void {
  registerSession(key, createSession(), new AbortController(), 'claude');
}

function startCodexSession(key: string): void {
  registerSession(key, createSession(), new AbortController(), 'codex');
}

function e2eEvent(chatId: string, data: unknown): void {
  applyE2eIngestedLiveBackgroundTaskEvent('p', 'w', chatId, data);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('live background task stream reduction', () => {
  it('publishes revisioned Codex snapshots through the existing live-task stream', () => {
    const scope = { projectId: 'p', worktreeId: 'w', chatId: 'codex-stream' };
    const key = 'p/w/codex-stream';
    startCodexSession(key);
    recordSessionEvent(key, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'provider-task',
      task_type: 'local_workflow',
      is_backgrounded: true,
    });
    const token = invokeSessionManagerExport(
      'registerCodexBackgroundOwner',
      scope,
    );
    const listener = jest.fn();
    const stopListening = subscribeLiveBackgroundTasks(listener);

    try {
      const firstSnapshot = {
        revision: 1,
        tasks: [
          {
            taskId: 'codex-child',
            taskType: 'local_agent',
            description: 'Codex child thread',
            toolUseId: 'toolu-child',
          },
        ],
      };
      expect(
        invokeSessionManagerExport(
          'replaceCodexLiveBackgroundTasks',
          token,
          firstSnapshot,
        ),
      ).toBe(true);
      expect(getLiveBackgroundTasksForChat('p', 'w', 'codex-stream')).toEqual([
        expect.objectContaining({
          taskId: 'provider-task',
          taskType: 'local_workflow',
        }),
        expect.objectContaining({
          taskId: 'codex-child',
          taskType: 'local_agent',
          description: 'Codex child thread',
          toolUseId: 'toolu-child',
          status: 'running',
        }),
      ]);
      const owner = listLiveBackgroundTaskOwners().find(
        (candidate) => candidate.sessionKey === key,
      );
      expect(
        owner?.liveTasks.some((task) => task.taskId === 'codex-child'),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(key);

      expect(
        invokeSessionManagerExport('replaceCodexLiveBackgroundTasks', token, {
          ...firstSnapshot,
          revision: 2,
        }),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        invokeSessionManagerExport('replaceCodexLiveBackgroundTasks', token, {
          revision: 2,
          tasks: [],
        }),
      ).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);

      expect(
        invokeSessionManagerExport('replaceCodexLiveBackgroundTasks', token, {
          revision: 3,
          tasks: [
            {
              taskId: 'codex-child',
              taskType: 'local_agent',
              description: 'Updated child metadata',
              toolUseId: 'toolu-child',
            },
          ],
        }),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);

      expect(
        invokeSessionManagerExport('replaceCodexLiveBackgroundTasks', token, {
          revision: 4,
          tasks: [],
        }),
      ).toBe(true);
      expect(getLiveBackgroundTasksForChat('p', 'w', 'codex-stream')).toEqual([
        expect.objectContaining({ taskId: 'provider-task' }),
      ]);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(
        invokeSessionManagerExport('retireCodexLiveBackgroundTasks', token),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      stopListening();
    }
  });

  it('admits background task types without an is_backgrounded flag', () => {
    startSession('p/w/task-types');
    recordSessionEvent('p/w/task-types', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-agent',
            name: 'Agent',
            input: {},
          },
        ],
      },
    });
    recordSessionEvent('p/w/task-types', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-agent',
            content: 'Running in the background',
          },
        ],
      },
    });
    recordSessionEvent('p/w/task-types', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task',
      task_type: 'local_agent',
      is_backgrounded: true,
      tool_use_id: 'toolu-agent',
    });
    // A child frame can arrive after the spawning parent turn has completed.
    recordSessionEvent('p/w/task-types', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task',
      parent_tool_use_id: 'toolu-agent',
      description: 'Working in the child session',
    });
    for (const [taskId, taskType] of [
      ['workflow-task', 'local_workflow'],
      ['remote-task', 'remote_agent'],
      ['teammate-task', 'in_process_teammate'],
    ]) {
      recordSessionEvent('p/w/task-types', {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        task_type: taskType,
        is_backgrounded: false,
      });
    }

    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['task-types']?.liveTasks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'agent-task',
          taskType: 'local_agent',
        }),
        expect.objectContaining({
          taskId: 'workflow-task',
          taskType: 'local_workflow',
        }),
        expect.objectContaining({
          taskId: 'remote-task',
          taskType: 'remote_agent',
        }),
        expect.objectContaining({
          taskId: 'teammate-task',
          taskType: 'in_process_teammate',
        }),
      ]),
    );

    recordSessionEvent('p/w/task-types', {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-task',
      status: 'completed',
    });
    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['task-types']?.liveTasks.map(
        (task) => task.taskId,
      ),
    ).not.toContain('agent-task');
  });

  it('keeps typed and ID-only snapshot members and metadata across replacement', () => {
    startSession('p/w/snapshot');
    recordSessionEvent('p/w/snapshot', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'typed-task',
      task_type: 'local_workflow',
      workflow_name: 'verify',
      description: 'Verify the change',
      spawn_depth: 2,
      is_backgrounded: true,
    });
    recordSessionEvent('p/w/snapshot', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'typed-task',
          task_type: 'local_workflow',
          workflow_name: 'verify',
          is_backgrounded: false,
        },
        { task_id: 'legacy-task' },
      ],
    });

    expect(getLiveBackgroundTaskSnapshot('p', 'w').snapshot?.liveTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'typed-task',
          taskType: 'local_workflow',
          workflowName: 'verify',
          description: 'Verify the change',
          spawnDepth: 2,
          isBackgrounded: false,
        }),
        { taskId: 'legacy-task' },
      ]),
    );

    resetSessionLiveBackgroundTasks('p/w/snapshot');
    recordSessionEvent('p/w/snapshot', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'typed-task',
          task_type: 'local_workflow',
          workflow_name: 'verify',
        },
        { task_id: 'legacy-task' },
      ],
    });
    expect(getLiveBackgroundTaskSnapshot('p', 'w').snapshot?.liveTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'typed-task',
          taskType: 'local_workflow',
          workflowName: 'verify',
        }),
        { taskId: 'legacy-task' },
      ]),
    );
  });

  it('handles level-before-edge and edge-before-level orderings', () => {
    startSession('p/w/level-first');
    recordSessionEvent('p/w/level-first', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'level-task', task_type: 'local_agent' }],
    });
    recordSessionEvent('p/w/level-first', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'level-task',
      task_type: 'local_agent',
      is_backgrounded: true,
    });
    startSession('p/w/edge-first');
    recordSessionEvent('p/w/edge-first', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'edge-task',
      task_type: 'local_workflow',
    });
    recordSessionEvent('p/w/edge-first', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'edge-task' }],
    });

    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['level-first']?.liveTasks,
    ).toEqual([
      expect.objectContaining({
        taskId: 'level-task',
        taskType: 'local_agent',
      }),
    ]);
    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['edge-first']?.liveTasks,
    ).toEqual([
      expect.objectContaining({
        taskId: 'edge-task',
        taskType: 'local_workflow',
      }),
    ]);
  });

  it('keeps background Bash and promoted Bash tasks live through parent results', () => {
    startSession('p/w/warbler');
    recordSessionEvent('p/w/warbler', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'background-bash',
      task_type: 'local_bash',
      is_backgrounded: true,
      description: 'Run the build watcher',
    });
    recordSessionEvent('p/w/warbler', { type: 'result', subtype: 'success' });
    recordSessionEvent('p/w/warbler', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'auto-background-bash',
      task_type: 'local_bash',
      is_backgrounded: false,
      tool_use_id: 'toolu_auto_bash',
      description: 'Run the test watcher',
    });
    recordSessionEvent('p/w/warbler', {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'auto-background-bash',
      patch: { is_backgrounded: true },
    });
    recordSessionEvent('p/w/warbler', { type: 'result', subtype: 'success' });

    expect(
      getLiveBackgroundTaskSnapshot('p', 'w').warbler?.liveTasks.map(
        (task) => task.taskId,
      ),
    ).toEqual(['background-bash', 'auto-background-bash']);
    recordSessionEvent('p/w/warbler', {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'background-bash',
      status: 'completed',
    });
    expect(getLiveBackgroundTaskSnapshot('p', 'w').warbler?.liveTasks).toEqual([
      expect.objectContaining({ taskId: 'auto-background-bash' }),
    ]);

    resetSessionLiveBackgroundTasks('p/w/warbler');
    expect(getLiveBackgroundTaskSnapshot('p', 'w').warbler?.liveTasks).toEqual(
      [],
    );
    recordSessionEvent('p/w/warbler', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'auto-background-bash' }],
    });
    expect(getLiveBackgroundTaskSnapshot('p', 'w').warbler?.liveTasks).toEqual([
      { taskId: 'auto-background-bash' },
    ]);
  });

  it('keeps the foreground tool correlation when a snapshot lists the task before its promotion', () => {
    startSession('p/w/promoted');
    recordSessionEvent('p/w/promoted', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'dev-server',
      task_type: 'local_bash',
      is_backgrounded: false,
      tool_use_id: 'toolu_dev_server',
      description: 'Start the dev server',
    });
    recordSessionEvent('p/w/promoted', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'dev-server', task_type: 'local_bash' }],
    });
    recordSessionEvent('p/w/promoted', {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'dev-server',
      patch: { is_backgrounded: true },
    });

    expect(getLiveBackgroundTaskSnapshot('p', 'w').promoted?.liveTasks).toEqual(
      [
        expect.objectContaining({
          taskId: 'dev-server',
          toolUseId: 'toolu_dev_server',
          description: 'Start the dev server',
          isBackgrounded: true,
        }),
      ],
    );
  });

  it('updates statuses, progress phase, summary, and usage until a terminal event', () => {
    startSession('p/w/progress');
    recordSessionEvent('p/w/progress', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'progress-task',
          task_type: 'local_workflow',
          workflow_name: 'build',
          status: 'pending',
        },
      ],
    });
    recordSessionEvent('p/w/progress', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'progress-task',
      description: 'Running tests',
      summary: 'Three suites complete',
      usage: { total_tokens: 123, tool_uses: 4, duration_ms: 900 },
    });
    for (const status of ['pending', 'running', 'paused', 'running']) {
      recordSessionEvent('p/w/progress', {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'progress-task',
        patch: { status },
      });
    }

    expect(getLiveBackgroundTaskSnapshot('p', 'w').progress?.liveTasks).toEqual(
      [
        {
          taskId: 'progress-task',
          taskType: 'local_workflow',
          workflowName: 'build',
          status: 'running',
          phase: 'Running tests',
          summary: 'Three suites complete',
          usage: { totalTokens: 123, toolUses: 4, durationMs: 900 },
        },
      ],
    );
    recordSessionEvent('p/w/progress', {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'progress-task',
      patch: { status: 'completed' },
    });
    expect(getLiveBackgroundTaskSnapshot('p', 'w').progress?.liveTasks).toEqual(
      [],
    );
  });

  it('retains a workflow after its parent result and reports progress through crash teardown', async () => {
    startSession('p/w/beaver');
    recordSessionEvent('p/w/beaver', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_workflow',
            name: 'Workflow',
            input: { workflow: 'verify' },
          },
        ],
      },
    });
    recordSessionEvent('p/w/beaver', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'workflow-run',
      task_type: 'local_workflow',
      workflow_name: 'verify',
      tool_use_id: 'toolu_workflow',
      description: 'Verify the change',
    });
    recordSessionEvent('p/w/beaver', { type: 'result', subtype: 'success' });
    recordSessionEvent('p/w/beaver', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'workflow-run',
      description: 'Running focused tests',
      summary: 'Two tests complete',
      usage: { total_tokens: 150, tool_uses: 7, duration_ms: 1200 },
    });
    recordSessionEvent('p/w/beaver', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'workflow-run',
      description: 'Collecting results',
      usage: { total_tokens: 200 },
    });

    expect(getLiveBackgroundTaskSnapshot('p', 'w').beaver?.liveTasks).toEqual([
      {
        taskId: 'workflow-run',
        toolUseId: 'toolu_workflow',
        description: 'Verify the change',
        taskType: 'local_workflow',
        workflowName: 'verify',
        phase: 'Collecting results',
        summary: 'Two tests complete',
        usage: { totalTokens: 200, toolUses: 7, durationMs: 1200 },
      },
    ]);

    markSessionTeardownCause('p/w/beaver', 'crash');
    await destroySession('p', 'w', 'beaver');
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'beaver' },
      expect.objectContaining({ taskId: 'workflow-run', stopCause: 'crash' }),
    );
  });

  it('reduces status updates and retained usage for the E2E ingress owner', () => {
    e2eEvent('e2e-status', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'e2e-status-task',
          task_type: 'remote_agent',
          status: 'pending',
          usage: { total_tokens: 12, tool_uses: 1, duration_ms: 200 },
        },
      ],
    });
    for (const status of ['pending', 'running', 'paused', 'running']) {
      e2eEvent('e2e-status', {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'e2e-status-task',
        patch: { status },
      });
    }

    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['e2e-status']?.liveTasks,
    ).toEqual([
      {
        taskId: 'e2e-status-task',
        taskType: 'remote_agent',
        status: 'running',
        usage: { totalTokens: 12, toolUses: 1, durationMs: 200 },
      },
    ]);
  });

  it('treats unknown task types as background work and warns once per session', () => {
    startSession('p/w/unknown');
    const event = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'unknown-task',
      task_type: 'new_provider_task',
      prompt: 'Do not log provider content',
    };
    recordSessionEvent('p/w/unknown', event);
    recordSessionEvent('p/w/unknown', { ...event, task_id: 'unknown-task-2' });

    expect(
      getLiveBackgroundTaskSnapshot('p', 'w').unknown?.liveTasks.map(
        (task) => task.taskId,
      ),
    ).toEqual(['unknown-task', 'unknown-task-2']);
    expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogMainProcessWarn.mock.calls)).not.toContain(
      'Do not log provider content',
    );
  });

  it('bounds provider-supplied display metadata', () => {
    startSession('p/w/bounded');
    recordSessionEvent('p/w/bounded', {
      type: 'system',
      subtype: 'task_started',
      task_id: 'bounded-task',
      task_type: 'local_workflow',
      workflow_name: 'w'.repeat(700),
      description: 'd'.repeat(700),
    });
    recordSessionEvent('p/w/bounded', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'bounded-task',
      description: 'p'.repeat(700),
      summary: 's'.repeat(700),
    });

    const task = getLiveBackgroundTaskSnapshot('p', 'w').bounded?.liveTasks[0];
    expect(task?.taskType).toHaveLength(14);
    expect(task?.workflowName).toHaveLength(500);
    expect(task?.description).toHaveLength(500);
    expect(task?.phase).toHaveLength(500);
    expect(task?.summary).toHaveLength(500);
  });

  it('notifies production and E2E listeners best-effort on changes and reset', async () => {
    const listener = jest.fn();
    const stopListening = subscribeLiveBackgroundTasks(listener);
    const stopThrowingListener = subscribeLiveBackgroundTasks((): never => {
      throw new Error('listener failed');
    });
    try {
      startSession('p/w/subscriber');
      recordSessionEvent('p/w/subscriber', {
        type: 'system',
        subtype: 'task_started',
        task_id: 'subscribed-task',
        task_type: 'local_workflow',
      });
      recordSessionEvent('p/w/subscriber', {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'subscribed-task',
        description: 'metadata changed',
      });
      expect(listener).toHaveBeenCalledWith('p/w/subscriber');
      const productionCalls = listener.mock.calls.length;

      e2eEvent('e2e-subscriber', {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'e2e-task', task_type: 'local_agent' }],
      });
      expect(listener).toHaveBeenCalledWith('p/w/e2e-subscriber');
      expect(listener.mock.calls.length).toBeGreaterThan(productionCalls);
      resetSessionLiveBackgroundTasks('p/w/e2e-subscriber');
      expect(listener).toHaveBeenLastCalledWith('p/w/e2e-subscriber');

      expect(() =>
        recordSessionEvent('p/w/subscriber', {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'subscribed-task',
          summary: 'listener exceptions are isolated',
        }),
      ).not.toThrow();
      expect(
        getLiveBackgroundTaskSnapshot('p', 'w').subscriber?.liveTasks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'subscribed-task',
            summary: 'listener exceptions are isolated',
          }),
        ]),
      );
      resetSessionLiveBackgroundTasks('p/w/subscriber');
      expect(listener).toHaveBeenCalledWith('p/w/subscriber');
      const resetCalls = listener.mock.calls.length;
      await destroySession('p', 'w', 'subscriber');
      expect(listener.mock.calls.length).toBeGreaterThan(resetCalls);
    } finally {
      stopListening();
      stopThrowingListener();
    }
  });

  it.each([
    'stop',
    'recycle',
    'archive',
    'crash',
    'external_signal',
    'session_ended',
  ] as const)('emits the first teardown cause (%s)', async (cause) => {
    const key = `p/w/cause-${cause}`;
    startSession(key);
    recordSessionEvent(key, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'task-with-cause' }],
    });
    markSessionTeardownCause(key, cause);
    markSessionTeardownCause(key, 'stop');

    await destroySession('p', 'w', `cause-${cause}`);

    expect(mockEmitSessionEndedBackgroundTaskNotification.mock.calls).toEqual(
      expect.arrayContaining([
        [
          { projectId: 'p', worktreeId: 'w', chatId: `cause-${cause}` },
          expect.objectContaining({
            taskId: 'task-with-cause',
            stopCause: cause,
          }),
        ],
      ]),
    );
  });

  it('consumes a cause at process reset and does not duplicate teardown output', async () => {
    startSession('p/w/reset-cause');
    recordSessionEvent('p/w/reset-cause', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'reset-task' }],
    });
    markSessionTeardownCause('p/w/reset-cause', 'crash');
    resetSessionLiveBackgroundTasks('p/w/reset-cause');
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'reset-cause' },
      expect.objectContaining({ taskId: 'reset-task', stopCause: 'crash' }),
    );

    recordSessionEvent('p/w/reset-cause', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'next-process-task' }],
    });
    await destroySession('p', 'w', 'reset-cause');
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'reset-cause' },
      expect.objectContaining({
        taskId: 'next-process-task',
        stopCause: 'session_ended',
      }),
    );
    const emittedCount =
      mockEmitSessionEndedBackgroundTaskNotification.mock.calls.length;
    await destroySession('p', 'w', 'reset-cause');
    expect(
      mockEmitSessionEndedBackgroundTaskNotification,
    ).toHaveBeenCalledTimes(emittedCount);
  });

  it('marks sessions recycled when provider or model teardown is requested', async () => {
    startSession('p/w/provider-recycle');
    recordSessionEvent('p/w/provider-recycle', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'provider-task' }],
    });
    await destroySessionsByProvider('claude');
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'provider-recycle' },
      expect.objectContaining({
        taskId: 'provider-task',
        stopCause: 'recycle',
      }),
    );

    registerSession(
      'p/w/model-recycle',
      createSession(),
      new AbortController(),
      'claude',
      'model-for-recycle',
    );
    recordSessionEvent('p/w/model-recycle', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'model-task' }],
    });
    await destroySessionsByModel('model-for-recycle');
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'model-recycle' },
      expect.objectContaining({ taskId: 'model-task', stopCause: 'recycle' }),
    );
  });

  it('treats a direct session replacement as a recycle', () => {
    startSession('p/w/register-replacement');
    recordSessionEvent('p/w/register-replacement', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'replaced-task' }],
    });
    registerSession(
      'p/w/register-replacement',
      createSession(),
      new AbortController(),
      'claude',
    );

    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'register-replacement',
      },
      expect.objectContaining({
        taskId: 'replaced-task',
        stopCause: 'recycle',
      }),
    );
    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['register-replacement']
        ?.liveTasks,
    ).toEqual([]);
  });

  it("ends a displaced session's tasks once, at registration, before its destroy() settles (CAN-4833)", async () => {
    const key = 'p/w/displaced-slow-exit';
    let finishDestroy = (): void => undefined;
    const displaced = {
      ...createSession(),
      destroy: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDestroy = resolve;
          }),
      ),
    };
    registerSession(key, displaced, new AbortController(), 'claude');
    recordSessionEvent(key, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'displaced-task' }],
    });

    registerSession(key, createSession(), new AbortController(), 'claude');
    recordSessionEvent(key, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'successor-task' }],
    });

    expect(displaced.destroy).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionEndedBackgroundTaskNotification.mock.calls).toEqual([
      [
        { projectId: 'p', worktreeId: 'w', chatId: 'displaced-slow-exit' },
        expect.objectContaining({
          taskId: 'displaced-task',
          stopCause: 'recycle',
        }),
      ],
    ]);

    finishDestroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      mockEmitSessionEndedBackgroundTaskNotification,
    ).toHaveBeenCalledTimes(1);
    expect(
      getLiveBackgroundTaskSnapshot('p', 'w')['displaced-slow-exit']?.liveTasks,
    ).toEqual([expect.objectContaining({ taskId: 'successor-task' })]);
  });

  it('does not let an old teardown flush clear a replacement session', async () => {
    const oldSession = createSession();
    registerSession('p/w/race', oldSession, new AbortController(), 'claude');
    recordSessionEvent('p/w/race', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'old-task' }],
    });
    markSessionTeardownCause('p/w/race', 'recycle');

    let releaseFlush: (() => void) | undefined;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    jest
      .mocked(flushAndStopOutputPollingForSession)
      .mockReturnValueOnce(flushGate);
    const oldTeardown = destroySession('p', 'w', 'race');
    await Promise.resolve();
    await Promise.resolve();

    startSession('p/w/race');
    recordSessionEvent('p/w/race', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'replacement-task', task_type: 'remote_agent' }],
    });
    const replacementBeforeRelease = getLiveBackgroundTaskSnapshot('p', 'w')
      .race?.liveTasks;
    releaseFlush?.();
    await oldTeardown;

    expect(getLiveBackgroundTaskSnapshot('p', 'w').race?.liveTasks).toEqual(
      replacementBeforeRelease,
    );
    expect(getLiveBackgroundTaskSnapshot('p', 'w').race?.liveTasks).toEqual([
      { taskId: 'replacement-task', taskType: 'remote_agent' },
    ]);
    expect(mockEmitSessionEndedBackgroundTaskNotification).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'race' },
      expect.objectContaining({ taskId: 'old-task', stopCause: 'recycle' }),
    );
  });
});

describe('live background task owner inventory', () => {
  it('returns per-chat tasks from real and E2E owners with scope isolation', () => {
    e2eEvent('shared-chat', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'e2e-task', task_type: 'local_bash' }],
    });
    e2eEvent('e2e-only', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'e2e-only-task', task_type: 'local_agent' }],
    });
    startSession('p/w/shared-chat');
    startSession('p/w/empty-real-chat');
    startSession('p/other-worktree/isolated-chat');
    startSession('other-project/w/shared-chat');
    recordSessionEvent('p/w/shared-chat', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'real-task', task_type: 'local_workflow' }],
    });

    expect(getLiveBackgroundTasksForChat('p', 'w', 'shared-chat')).toEqual([
      { taskId: 'real-task', taskType: 'local_workflow' },
    ]);
    expect(getLiveBackgroundTasksForChat('p', 'w', 'e2e-only')).toEqual([
      { taskId: 'e2e-only-task', taskType: 'local_agent' },
    ]);
    expect(
      getLiveBackgroundTasksForChat('p', 'other-worktree', 'isolated-chat'),
    ).toEqual([]);
    expect(
      getLiveBackgroundTasksForChat('other-project', 'w', 'shared-chat'),
    ).toEqual([]);
    expect(
      getLiveBackgroundTasksForChat('p', 'w', 'missing-chat'),
    ).toBeUndefined();

    const owners = listLiveBackgroundTaskOwners();
    expect(owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: 'p/w/shared-chat',
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'shared-chat',
          liveTasks: [{ taskId: 'real-task', taskType: 'local_workflow' }],
        }),
        expect.objectContaining({
          sessionKey: 'p/w/e2e-only',
          liveTasks: [{ taskId: 'e2e-only-task', taskType: 'local_agent' }],
        }),
        expect.objectContaining({
          sessionKey: 'p/w/empty-real-chat',
          liveTasks: [],
        }),
      ]),
    );
    expect(
      owners.filter((owner) => owner.sessionKey === 'p/w/shared-chat'),
    ).toHaveLength(1);
  });

  it('notifies when a real session shadows an E2E owner and when it is removed', () => {
    e2eEvent('owner-fallback', {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'fallback-task', task_type: 'local_agent' }],
    });
    const listener = jest.fn();
    const stopListening = subscribeLiveBackgroundTasks(listener);
    try {
      startSession('p/w/owner-fallback');
      expect(listener).toHaveBeenCalledWith('p/w/owner-fallback');
      expect(getLiveBackgroundTasksForChat('p', 'w', 'owner-fallback')).toEqual(
        [],
      );

      listener.mockClear();
      unregisterSession('p/w/owner-fallback');
      expect(listener).toHaveBeenCalledWith('p/w/owner-fallback');
      expect(getLiveBackgroundTasksForChat('p', 'w', 'owner-fallback')).toEqual(
        [{ taskId: 'fallback-task', taskType: 'local_agent' }],
      );
    } finally {
      stopListening();
    }
  });

  it('notifies when a session entry is removed', () => {
    startSession('p/w/remove-notification');
    const listener = jest.fn();
    const stopListening = subscribeLiveBackgroundTasks(listener);
    try {
      unregisterSession('p/w/remove-notification');
      expect(listener).toHaveBeenCalledWith('p/w/remove-notification');
    } finally {
      stopListening();
    }
  });
});
