import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import type {
  ClaudeLifecycleEvent,
  SpawnedBy,
} from '@canopy/protocol/canopy-core';
import {
  activeDelegationCount,
  queuedDelegationCount,
} from '../delegation/activity';
import {
  getLiveBackgroundTasksForChat,
  getSessionProviderType,
  getSessionExecutionHarness,
} from '../session-manager';
import { subscribeBackgroundWork } from '../background-work';
import {
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../provider-turn-lifecycle';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  ClaudeEventTaskTracker,
  ClaudeTurnBindingTracker,
  isClaudeTaskEventResult,
  readClaudeStartedCommandUuid,
  readClaudeWakeCause,
  getClaudeTurnLifecycleProducer,
  releaseClaudeTurnLifecycleProducer,
  requestBackgroundSnapshot,
  setClaudeTurnLifecycleClockForTests,
  setClaudeTurnLifecycleSink,
  type ClaudeTurnStartedFields,
} from '../claude-turn-lifecycle';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../background-work', () => ({
  subscribeBackgroundWork: jest.fn(),
}));

jest.mock('../delegation/activity', () => ({
  activeDelegationCount: jest.fn(() => 0),
  parseDelegationSessionKey: (
    sessionKey: string,
  ): { projectId: string; worktreeId: string; chatId: string } | null => {
    const parts = sessionKey.split('/');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const [projectId, worktreeId, chatId] = parts;
    return { projectId, worktreeId, chatId };
  },
  queuedDelegationCount: jest.fn(() => 0),
}));

jest.mock('../session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(() => []),
  getSessionProviderType: jest.fn(() => 'claude'),
  getSessionExecutionHarness: jest.fn(() => undefined),
}));

const scope = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const sessionKey = 'project/worktree/chat';
const backgroundProviders = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
] as const;
const backgroundTestScopes: Array<{
  projectId: string;
  worktreeId: string;
  chatId: string;
}> = [];

function createBackgroundScope(chatId: string): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  const backgroundScope = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
  };
  backgroundTestScopes.push(backgroundScope);
  return backgroundScope;
}

function backgroundSessionKey(scope: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`;
}

function startedFields(turnId: string): ClaudeTurnStartedFields {
  return {
    turnId,
    origin: 'autonomous' as const,
    binding: 'pending' as const,
    submissionIds: [],
    userMessageIds: [],
    providerUserMessageUuids: [],
    phase: 'start' as const,
    startedAtMs: 10,
  };
}

describe('Claude turn lifecycle producer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setClaudeTurnLifecycleSink(null);
    setClaudeTurnLifecycleClockForTests(() => 1234);
  });

  afterEach(() => {
    setClaudeTurnLifecycleSink(null);
    setClaudeTurnLifecycleClockForTests(null);
    releaseClaudeTurnLifecycleProducer(scope);
  });

  it('stamps ordered events per chat and returns one producer for the chat', () => {
    const events: ClaudeLifecycleEvent[] = [];
    setClaudeTurnLifecycleSink((event) => events.push(event));
    const producer = getClaudeTurnLifecycleProducer(scope);

    expect(getClaudeTurnLifecycleProducer({ ...scope })).toBe(producer);
    producer.turnStarted(startedFields('turn-1'));
    producer.sessionState({ state: 'running', source: 'provider' });

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.eventId)).toHaveLength(2);
    expect(events[0]).toMatchObject({
      version: 1,
      provider: 'claude',
      ...scope,
      observedAtMs: 1234,
    });
    const otherChat: ClaudeLifecycleEvent[] = [];
    setClaudeTurnLifecycleSink((event) => otherChat.push(event));
    getClaudeTurnLifecycleProducer({ ...scope, chatId: 'other' }).sessionState({
      state: 'idle',
      source: 'result-fallback',
    });
    expect(otherChat[0]?.sequence).toBe(1);
    releaseClaudeTurnLifecycleProducer({ ...scope, chatId: 'other' });
  });

  it('catches and reports a throwing sink without throwing to its caller', () => {
    setClaudeTurnLifecycleSink(() => {
      throw new Error('sink failed');
    });

    expect(() =>
      getClaudeTurnLifecycleProducer(scope).turnStarted(startedFields('turn')),
    ).not.toThrow();
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('Lifecycle sink failed'),
      expect.any(Error),
    );
  });

  it('drops invalid events and reports the validation failure once', () => {
    const events: ClaudeLifecycleEvent[] = [];
    setClaudeTurnLifecycleSink((event) => events.push(event));
    const producer = getClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleClockForTests(() => Number.NaN);

    producer.turnStarted(startedFields('invalid'));
    producer.turnStarted(startedFields('also-invalid'));

    expect(events).toEqual([]);
    expect(logMainProcessWarn).toHaveBeenCalledTimes(1);
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid provider-neutral lifecycle event'),
      expect.anything(),
    );
  });

  it('does not publish or buffer events while no sink is registered', () => {
    const isolatedScope = {
      ...scope,
      chatId: 'no-sink-chat',
    };
    const producer = getClaudeTurnLifecycleProducer(isolatedScope);
    producer.turnStarted(startedFields('dropped'));
    const events: ClaudeLifecycleEvent[] = [];
    setClaudeTurnLifecycleSink((event) => events.push(event));
    producer.turnStarted(startedFields('published'));

    expect(events).toHaveLength(1);
    const published = events[0];
    if (published?.type !== 'TurnStarted')
      throw new Error('Expected the published TurnStarted event');
    expect(published.turnId).toBe('published');
    expect(published.sequence).toBe(2);
    releaseClaudeTurnLifecycleProducer(isolatedScope);
  });
});

describe('Claude turn binding tracker', () => {
  it('binds an ordinary yielded send observed at command start', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('command-uuid', {
      submissionId: 'submission-1',
      userMessageId: 'message-1',
      kind: 'ordinary',
    });
    expect(tracker.openTurn('turn-1')).toEqual({
      turnId: 'turn-1',
      binding: 'pending',
      origin: 'autonomous',
      submissionIds: [],
      userMessageIds: [],
      providerUserMessageUuids: [],
    });

    expect(tracker.observeCommandStarted('command-uuid')).toMatchObject({
      turnId: 'turn-1',
      binding: 'bound',
      origin: 'user',
      submissionIds: ['submission-1'],
      userMessageIds: ['message-1'],
      providerUserMessageUuids: ['command-uuid'],
    });
  });

  it('resolves plural UUIDs and de-duplicates aliases for one submission', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('managed-alias-a', {
      submissionId: 'managed-submission',
      userMessageId: 'managed-message',
      kind: 'ordinary',
    });
    tracker.registerYielded('managed-alias-b', {
      submissionId: 'managed-submission',
      userMessageId: 'managed-message',
      kind: 'ordinary',
    });
    tracker.openTurn('turn-managed');

    expect(
      tracker.observeUserMessageUuids([
        'unknown-uuid',
        'managed-alias-a',
        'managed-alias-b',
      ]),
    ).toMatchObject({
      turnId: 'turn-managed',
      binding: 'bound',
      submissionIds: ['managed-submission'],
      userMessageIds: ['managed-message'],
      providerUserMessageUuids: [
        'unknown-uuid',
        'managed-alias-a',
        'managed-alias-b',
      ],
    });
  });

  it('seals a wake without correlated evidence as unbound', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.openTurn('wake-turn');
    tracker.observeUserMessageUuids(['unmatched-provider-uuid']);

    expect(
      tracker.sealAtResult({ originKind: 'autonomous', resultIndex: 4 }),
    ).toEqual({
      turnId: 'wake-turn',
      origin: 'autonomous',
      binding: 'unbound',
      submissionIds: [],
      userMessageIds: [],
      providerUserMessageUuids: ['unmatched-provider-uuid'],
      providerOriginKind: 'autonomous',
      resultIndex: 4,
    });
  });

  it("records a wake's cause from the task notification that started it", () => {
    const tracker = new ClaudeTurnBindingTracker();
    expect(
      tracker.openTurn('wake-turn', { taskId: 'task-1', toolUseId: 'tool-1' }),
    ).toMatchObject({
      origin: 'autonomous',
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
    });
    expect(tracker.sealAtResult({})).toMatchObject({
      origin: 'autonomous',
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
    });
  });

  it('holds a wake cause while a yielded send may bind the turn', () => {
    const cause = { taskId: 'task-1', toolUseId: 'tool-1' };
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('prompt-uuid', {
      submissionId: 'prompt',
      userMessageId: 'prompt-message',
      kind: 'ordinary',
    });
    expect(tracker.openTurn('prompt-turn', cause)).not.toHaveProperty(
      'spawnedBy',
    );
    expect(tracker.observeUserMessageUuids(['prompt-uuid'])).toMatchObject({
      origin: 'user',
    });
    expect(tracker.sealAtResult({})).not.toHaveProperty('spawnedBy');

    // A wake the send never binds still gets its cause, at its seal.
    tracker.registerYielded('queued-uuid', {
      submissionId: 'queued',
      kind: 'ordinary',
    });
    expect(tracker.openTurn('wake-turn', cause)).not.toHaveProperty(
      'spawnedBy',
    );
    expect(tracker.sealAtResult({})).toMatchObject({
      origin: 'autonomous',
      binding: 'unbound',
      spawnedBy: cause,
    });
  });

  it('reads a wake cause only from a root task notification that ended the task', () => {
    const notification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      status: 'completed',
      summary: 'Ran the tests',
    };
    expect(readClaudeWakeCause(notification)).toEqual({
      taskId: 'task-1',
      toolUseId: 'tool-1',
    });
    expect(
      readClaudeWakeCause({ ...notification, tool_use_id: undefined }),
    ).toEqual({ taskId: 'task-1' });
    expect(
      readClaudeWakeCause({ ...notification, parent_tool_use_id: 'agent-1' }),
    ).toBeUndefined();
    expect(
      readClaudeWakeCause({ ...notification, ambient: true }),
    ).toBeUndefined();
    expect(
      readClaudeWakeCause({ ...notification, subtype: 'task_started' }),
    ).toBeUndefined();
    expect(
      readClaudeWakeCause({ ...notification, status: 'running' }),
    ).toBeUndefined();
  });

  it('reads the command a root command_lifecycle frame reports started', () => {
    const started = {
      type: 'command_lifecycle',
      command_uuid: 'command-1',
      state: 'started',
    };
    expect(readClaudeStartedCommandUuid(started)).toBe('command-1');
    expect(
      readClaudeStartedCommandUuid({ ...started, state: 'queued' }),
    ).toBeUndefined();
    expect(
      readClaudeStartedCommandUuid({ ...started, parent_tool_use_id: 'agent' }),
    ).toBeUndefined();
    expect(
      readClaudeStartedCommandUuid({ ...started, type: 'system' }),
    ).toBeUndefined();
  });

  it('gives an uncaused autonomous turn the event cause it seals with', () => {
    const cause: SpawnedBy = {
      taskId: 'task-1',
      toolUseId: 'tool-1',
      event: true,
    };
    const tracker = new ClaudeTurnBindingTracker();
    tracker.openTurn('event-turn');
    expect(tracker.sealAtResult({}, cause)).toMatchObject({
      origin: 'autonomous',
      spawnedBy: cause,
    });

    // A finished task's cause stays.
    tracker.openTurn('wake-turn', { taskId: 'task-2' });
    expect(tracker.sealAtResult({}, cause)?.spawnedBy).toEqual({
      taskId: 'task-2',
    });

    // A prompt or steer that bound the turn, or a restart, takes no cause.
    tracker.registerYielded('steer-uuid', {
      submissionId: 'steer-submission',
      kind: 'steer',
    });
    tracker.openTurn('steered-turn');
    tracker.observeCommandStarted('steer-uuid');
    expect(tracker.sealAtResult({}, cause)).not.toHaveProperty('spawnedBy');
    tracker.openTurn('restarted-turn');
    tracker.markRestart();
    expect(tracker.sealAtResult({}, cause)).not.toHaveProperty('spawnedBy');
  });

  it('reads an event wake only from a task-notification result without a subkind', () => {
    const result = {
      type: 'result',
      origin: { kind: 'task-notification', producer: 'session-task' },
    };
    expect(isClaudeTaskEventResult(result)).toBe(true);
    expect(
      isClaudeTaskEventResult({
        ...result,
        origin: { kind: 'task-notification', subkind: 'scheduled-trigger' },
      }),
    ).toBe(false);
    expect(
      isClaudeTaskEventResult({ ...result, origin: { kind: 'human' } }),
    ).toBe(false);
    expect(isClaudeTaskEventResult({ type: 'result' })).toBe(false);
  });

  describe('ClaudeEventTaskTracker', () => {
    const monitorCall = (
      id: string,
      name = 'Monitor',
      parent: string | null = null,
    ): Record<string, unknown> => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input: {} }] },
    });
    const taskStarted = (
      taskId: string,
      toolUseId: string,
    ): Record<string, unknown> => ({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description: 'Watch the logs',
      task_type: 'local_bash',
    });

    it('names the one live task a Monitor call started', () => {
      const tasks = new ClaudeEventTaskTracker();
      tasks.observe(monitorCall('monitor-tool'));
      tasks.observe(taskStarted('monitor-task', 'monitor-tool'));
      // A Bash task doesn't report events.
      tasks.observe(monitorCall('bash-tool', 'Bash'));
      tasks.observe(taskStarted('bash-task', 'bash-tool'));

      expect(tasks.eventCause()).toEqual({
        taskId: 'monitor-task',
        toolUseId: 'monitor-tool',
        event: true,
      });
    });

    it('names no task when several Monitor tasks, or none, are live', () => {
      const tasks = new ClaudeEventTaskTracker();
      expect(tasks.eventCause()).toEqual({ event: true });
      tasks.observe(monitorCall('tool-1'));
      tasks.observe(taskStarted('task-1', 'tool-1'));
      tasks.observe(monitorCall('tool-2'));
      tasks.observe(taskStarted('task-2', 'tool-2'));
      expect(tasks.eventCause()).toEqual({ event: true });

      tasks.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-2',
        status: 'stopped',
      });
      expect(tasks.eventCause()).toMatchObject({ taskId: 'task-1' });

      // The level signal replaces the live set.
      tasks.observe({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      });
      expect(tasks.eventCause()).toEqual({ event: true });
      tasks.observe({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-1' }],
      });
      expect(tasks.eventCause()).toMatchObject({ taskId: 'task-1' });
    });

    // The structured result a CronCreate / CronDelete call reports.
    const cronCall = (
      id: string,
      name: 'CronCreate' | 'CronDelete',
      input: Record<string, unknown>,
    ): Record<string, unknown> => ({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    const cronResult = (
      toolUseId: string,
      result: Record<string, unknown>,
    ): Record<string, unknown> => ({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }],
      },
      tool_use_result: result,
    });

    it('names the one live cron job as a scheduled cause, and forgets a fired one-shot', () => {
      const tasks = new ClaudeEventTaskTracker();
      expect(tasks.scheduledCause()).toBeUndefined();
      tasks.observe(
        cronCall('cron-tool', 'CronCreate', {
          cron: '0 9 * * *',
          prompt: 'Check the deploy',
          recurring: false,
        }),
      );
      tasks.observe(
        cronResult('cron-tool', {
          id: 'job-1',
          humanSchedule: 'Every day at 9:00',
          recurring: false,
        }),
      );
      expect(tasks.scheduledCause()).toEqual({
        toolUseId: 'cron-tool',
        scheduled: true,
      });
      // A one-shot job deletes itself once it fires.
      expect(tasks.scheduledCause()).toBeUndefined();
    });

    it('keeps a recurring job, names none of several, and drops a deleted one', () => {
      const tasks = new ClaudeEventTaskTracker();
      for (const [tool, job] of [
        ['cron-1', 'job-1'],
        ['cron-2', 'job-2'],
      ]) {
        tasks.observe(
          cronCall(tool, 'CronCreate', { cron: '*/5 * * * *', prompt: tool }),
        );
        tasks.observe(cronResult(tool, { id: job, recurring: true }));
      }
      expect(tasks.scheduledCause()).toEqual({ scheduled: true });
      tasks.observe(cronCall('delete-tool', 'CronDelete', { id: 'job-2' }));
      tasks.observe(cronResult('delete-tool', { id: 'job-2' }));
      expect(tasks.scheduledCause()).toEqual({
        toolUseId: 'cron-1',
        scheduled: true,
      });
      expect(tasks.scheduledCause()).toEqual({
        toolUseId: 'cron-1',
        scheduled: true,
      });
      // A new CLI process loses the session's jobs.
      tasks.resetLiveTasks();
      expect(tasks.scheduledCause()).toBeUndefined();
    });

    it("ignores a failed CronCreate and a subagent's cron calls", () => {
      const tasks = new ClaudeEventTaskTracker();
      tasks.observe(
        cronCall('cron-tool', 'CronCreate', { cron: 'bad', prompt: 'x' }),
      );
      tasks.observe(cronResult('cron-tool', { error: 'Invalid cron' }));
      tasks.observe({
        ...cronCall('nested-tool', 'CronCreate', { cron: '* * * * *' }),
        parent_tool_use_id: 'agent-tool',
      });
      tasks.observe({
        ...cronResult('nested-tool', { id: 'nested-job' }),
        parent_tool_use_id: 'agent-tool',
      });
      expect(tasks.scheduledCause()).toBeUndefined();
    });

    it("ignores a subagent's Monitor calls and tasks", () => {
      const tasks = new ClaudeEventTaskTracker();
      tasks.observe(monitorCall('nested-tool', 'Monitor', 'agent-tool'));
      tasks.observe(taskStarted('nested-task', 'nested-tool'));
      tasks.observe(monitorCall('root-tool'));
      tasks.observe({
        ...taskStarted('root-task', 'root-tool'),
        parent_tool_use_id: 'agent-tool',
      });
      expect(tasks.eventCause()).toEqual({ event: true });
    });
  });

  it('keeps a steer folded into an autonomous turn autonomous', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('steer-uuid', {
      submissionId: 'steer-submission',
      userMessageId: 'steer-message',
      kind: 'steer',
    });
    tracker.openTurn('autonomous-turn');

    expect(tracker.observeCommandStarted('steer-uuid')).toMatchObject({
      turnId: 'autonomous-turn',
      binding: 'bound',
      origin: 'autonomous',
      submissionIds: ['steer-submission'],
    });
    expect(tracker.sealAtResult({})?.origin).toBe('autonomous');
  });

  it('marks the open turn as a restart', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.openTurn('restart-turn');

    tracker.markRestart();

    expect(tracker.current()).toMatchObject({
      turnId: 'restart-turn',
      origin: 'restart',
    });
    expect(tracker.sealAtResult({})?.origin).toBe('restart');
  });

  it('returns binding updates for the same turn and ignores evidence after sealing', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('user-uuid', {
      submissionId: 'submission-1',
      userMessageId: 'message-1',
      kind: 'ordinary',
    });
    tracker.openTurn('stable-turn-id');

    expect(tracker.observeUserMessageUuids(['user-uuid'])).toMatchObject({
      turnId: 'stable-turn-id',
      binding: 'bound',
      origin: 'user',
    });
    const finalBinding = tracker.sealAtResult({ resultIndex: 7 });
    expect(finalBinding).toMatchObject({
      turnId: 'stable-turn-id',
      binding: 'bound',
      resultIndex: 7,
    });
    expect(tracker.observeCommandStarted('late-uuid')).toBeUndefined();
    expect(tracker.current()).toEqual(finalBinding);
  });

  it('never binds an unrelated queued send by position', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('queued-send-uuid', {
      submissionId: 'queued-submission',
      userMessageId: 'queued-message',
      kind: 'ordinary',
    });
    tracker.openTurn('wake-turn');

    expect(tracker.observeCommandStarted('provider-only-uuid')).toMatchObject({
      turnId: 'wake-turn',
      binding: 'pending',
      origin: 'autonomous',
      submissionIds: [],
      userMessageIds: [],
      providerUserMessageUuids: ['provider-only-uuid'],
    });
    expect(tracker.sealAtResult({})?.binding).toBe('unbound');
  });

  it('drops a consumed send at its seal, so a late echo cannot bind a later turn', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('consumed-uuid', {
      submissionId: 'consumed-submission',
      kind: 'ordinary',
    });
    tracker.registerYielded('waiting-uuid', {
      submissionId: 'waiting-submission',
      kind: 'ordinary',
    });
    tracker.openTurn('turn-1');
    tracker.observeCommandStarted('consumed-uuid');
    tracker.sealAtResult({});

    tracker.openTurn('turn-2');
    expect(tracker.observeUserMessageUuids(['consumed-uuid'])).toMatchObject({
      binding: 'pending',
      submissionIds: [],
    });
    expect(tracker.observeCommandStarted('waiting-uuid')).toMatchObject({
      binding: 'bound',
      submissionIds: ['waiting-submission'],
    });
  });

  it('keeps the alias map bounded when yielded sends are never consumed', () => {
    const tracker = new ClaudeTurnBindingTracker();
    for (let index = 0; index < 300; index += 1) {
      tracker.registerYielded(`withdrawn-${index}`, {
        submissionId: `withdrawn-submission-${index}`,
        kind: 'ordinary',
      });
    }
    tracker.openTurn('turn-1');
    expect(tracker.observeCommandStarted('withdrawn-0')).toMatchObject({
      binding: 'pending',
    });
    expect(tracker.observeCommandStarted('withdrawn-299')).toMatchObject({
      binding: 'bound',
      submissionIds: ['withdrawn-submission-299'],
    });
  });
});

describe('Claude background-set publisher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setClaudeTurnLifecycleSink(null);
    jest
      .mocked(subscribeBackgroundWork)
      .mockImplementation((): (() => void) => () => undefined);
    jest.mocked(getSessionProviderType).mockReturnValue('claude');
    jest.mocked(getSessionExecutionHarness).mockReturnValue(undefined);
    jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue([]);
    jest.mocked(activeDelegationCount).mockReturnValue(0);
    jest.mocked(queuedDelegationCount).mockReturnValue(0);
  });

  afterEach(() => {
    setClaudeTurnLifecycleSink(null);
    releaseClaudeTurnLifecycleProducer(scope);
    for (const provider of backgroundProviders) {
      releaseTurnLifecycleProducer(provider, scope);
      for (const backgroundScope of backgroundTestScopes)
        releaseTurnLifecycleProducer(provider, backgroundScope);
    }
    backgroundTestScopes.length = 0;
  });

  it('publishes a native-only replacement set', () => {
    const events: ClaudeLifecycleEvent[] = [];
    const nativeTask: ActivityLiveBgTask = {
      taskId: 'native-task',
      taskType: 'agent',
      toolUseId: 'tool-use',
    };
    jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue([nativeTask]);
    jest.mocked(subscribeBackgroundWork).mockImplementation((listener) => {
      listener(sessionKey);
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));

    expect(events[0]).toMatchObject({
      type: 'BackgroundSet',
      semantics: 'replace',
      native: [{ id: 'native-task', taskType: 'agent', toolUseId: 'tool-use' }],
      managed: { live: 0, queued: 0 },
    });
  });

  it('publishes a provider-neutral BackgroundSet for Codex sessions', () => {
    const events: ClaudeLifecycleEvent[] = [];
    jest.mocked(getSessionProviderType).mockReturnValue('codex');
    jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue([
      {
        taskId: 'codex-child',
        taskType: 'local_agent',
        toolUseId: 'toolu-child',
      },
    ]);
    jest.mocked(activeDelegationCount).mockReturnValue(2);
    jest.mocked(queuedDelegationCount).mockReturnValue(1);
    jest.mocked(subscribeBackgroundWork).mockImplementation((listener) => {
      listener(sessionKey);
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'BackgroundSet',
      provider: 'codex',
      semantics: 'replace',
      native: [
        {
          id: 'codex-child',
          taskType: 'local_agent',
          toolUseId: 'toolu-child',
        },
      ],
      managed: { live: 2, queued: 1 },
    });
  });

  it.each(['claude', 'codex'] as const)(
    "publishes an Ollama session's background set under its %s harness",
    (harness) => {
      const backgroundScope = createBackgroundScope(`ollama-${harness}`);
      const events: ClaudeLifecycleEvent[] = [];
      let listener: ((key: string) => void) | undefined;
      // Ollama names the model's provider; its lifecycle runs under its harness.
      jest.mocked(getSessionProviderType).mockReturnValue('ollama');
      jest.mocked(getSessionExecutionHarness).mockReturnValue(harness);
      jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
        listener = callback;
        return (): void => undefined;
      });

      setClaudeTurnLifecycleSink((event) => events.push(event));
      listener?.(backgroundSessionKey(backgroundScope));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'BackgroundSet',
        provider: harness,
        chatId: backgroundScope.chatId,
      });
    },
  );

  it.each(backgroundProviders)(
    'publishes live background changes for %s sessions',
    (provider) => {
      const backgroundScope = createBackgroundScope(`live-${provider}`);
      const events: ClaudeLifecycleEvent[] = [];
      let listener: ((key: string) => void) | undefined;
      jest.mocked(getSessionProviderType).mockReturnValue(provider);
      jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
        listener = callback;
        return (): void => undefined;
      });

      setClaudeTurnLifecycleSink((event) => events.push(event));
      listener?.(backgroundSessionKey(backgroundScope));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'BackgroundSet',
        provider,
        projectId: backgroundScope.projectId,
        worktreeId: backgroundScope.worktreeId,
        chatId: backgroundScope.chatId,
        semantics: 'replace',
      });
    },
  );

  it.each(backgroundProviders)(
    'publishes synchronous replacement snapshots under supplied provider %s',
    (provider) => {
      const backgroundScope = createBackgroundScope(`snapshot-${provider}`);
      const events: ClaudeLifecycleEvent[] = [];
      const nativeTask: ActivityLiveBgTask = {
        taskId: 'snapshot-task',
        taskType: 'agent',
      };
      jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue([nativeTask]);
      jest.mocked(activeDelegationCount).mockReturnValue(2);
      jest.mocked(queuedDelegationCount).mockReturnValue(1);
      setClaudeTurnLifecycleSink((event) => events.push(event));

      requestBackgroundSnapshot({ ...backgroundScope, provider });
      requestBackgroundSnapshot({ ...backgroundScope, provider });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'BackgroundSet',
        provider,
        projectId: backgroundScope.projectId,
        worktreeId: backgroundScope.worktreeId,
        chatId: backgroundScope.chatId,
        semantics: 'replace',
        native: [{ id: 'snapshot-task', taskType: 'agent' }],
        managed: { live: 2, queued: 1 },
      });
      expect(events[1]).toMatchObject({
        type: 'BackgroundSet',
        provider,
        semantics: 'replace',
        native: [{ id: 'snapshot-task', taskType: 'agent' }],
        managed: { live: 2, queued: 1 },
      });
      expect(activeDelegationCount).toHaveBeenLastCalledWith(
        backgroundSessionKey(backgroundScope),
      );
      expect(queuedDelegationCount).toHaveBeenLastCalledWith(
        backgroundSessionKey(backgroundScope),
      );
      expect(getSessionProviderType).not.toHaveBeenCalled();
    },
  );

  it('keeps publishing a chat-owned delegation after its provider session ends', () => {
    const backgroundScope = createBackgroundScope('outliving-delegation');
    const events: ClaudeLifecycleEvent[] = [];
    let listener: ((key: string) => void) | undefined;
    const key = backgroundSessionKey(backgroundScope);
    jest.mocked(getSessionProviderType).mockReturnValue('copilot');
    jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
      listener = callback;
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));
    listener?.(key);
    jest.mocked(getSessionProviderType).mockReturnValue(undefined);
    jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue(undefined);
    jest.mocked(activeDelegationCount).mockReturnValue(1);
    jest.mocked(queuedDelegationCount).mockReturnValue(2);
    listener?.(key);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'BackgroundSet',
      provider: 'copilot',
      projectId: backgroundScope.projectId,
      worktreeId: backgroundScope.worktreeId,
      chatId: backgroundScope.chatId,
      semantics: 'replace',
      native: [],
      managed: { live: 1, queued: 2 },
    });
    expect(activeDelegationCount).toHaveBeenLastCalledWith(key);
    expect(queuedDelegationCount).toHaveBeenLastCalledWith(key);
  });

  it('does not publish a sessionless background change without a remembered provider', () => {
    const backgroundScope = createBackgroundScope('unknown-sessionless');
    const events: ClaudeLifecycleEvent[] = [];
    let listener: ((key: string) => void) | undefined;
    jest.mocked(getSessionProviderType).mockReturnValue(undefined);
    jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
      listener = callback;
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));
    listener?.(backgroundSessionKey(backgroundScope));

    expect(events).toEqual([]);
  });

  it('evicts the least-recently-used chat provider after 256 remembered chats', () => {
    const events: ClaudeLifecycleEvent[] = [];
    const rememberedScopes = Array.from({ length: 256 }, (_, index) =>
      createBackgroundScope(`lru-${index}`),
    );
    const recentScope = rememberedScopes[0];
    const oldestUntouchedScope = rememberedScopes[1];
    if (!recentScope || !oldestUntouchedScope)
      throw new Error('Expected the provider LRU fixture scopes');
    const newScope = createBackgroundScope('lru-newest');
    let listener: ((key: string) => void) | undefined;
    jest.mocked(getSessionProviderType).mockReturnValue('cursor');
    jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
      listener = callback;
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));
    for (const backgroundScope of rememberedScopes)
      listener?.(backgroundSessionKey(backgroundScope));

    jest.mocked(getSessionProviderType).mockReturnValue(undefined);
    listener?.(backgroundSessionKey(recentScope));
    jest.mocked(getSessionProviderType).mockReturnValue('copilot');
    listener?.(backgroundSessionKey(newScope));
    const eventCountAfterEviction = events.length;
    jest.mocked(getSessionProviderType).mockReturnValue(undefined);
    listener?.(backgroundSessionKey(recentScope));
    expect(events).toHaveLength(eventCountAfterEviction + 1);
    expect(events[events.length - 1]).toMatchObject({
      type: 'BackgroundSet',
      provider: 'cursor',
      chatId: recentScope.chatId,
    });

    const eventCountBeforeOldest = events.length;
    listener?.(backgroundSessionKey(oldestUntouchedScope));
    expect(events).toHaveLength(eventCountBeforeOldest);
  });

  it('does nothing for an explicit snapshot when no lifecycle sink is installed', () => {
    const backgroundScope = createBackgroundScope('no-sink');

    requestBackgroundSnapshot({ ...backgroundScope, provider: 'claude' });

    expect(getLiveBackgroundTasksForChat).not.toHaveBeenCalled();
    expect(activeDelegationCount).not.toHaveBeenCalled();
    expect(queuedDelegationCount).not.toHaveBeenCalled();
  });

  it('isolates a throwing lifecycle sink from explicit snapshots', () => {
    const backgroundScope = createBackgroundScope('throwing-sink');
    const providerError = new Error('sink failed');
    setClaudeTurnLifecycleSink(() => {
      throw providerError;
    });

    expect(() =>
      requestBackgroundSnapshot({ ...backgroundScope, provider: 'codex' }),
    ).not.toThrow();
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('Lifecycle sink failed'),
      providerError,
    );
  });

  it('publishes delegation-only changes', () => {
    const events: ClaudeLifecycleEvent[] = [];
    jest.mocked(activeDelegationCount).mockReturnValue(2);
    jest.mocked(queuedDelegationCount).mockReturnValue(1);
    jest.mocked(subscribeBackgroundWork).mockImplementation((listener) => {
      listener(sessionKey);
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));

    expect(events[0]).toMatchObject({
      type: 'BackgroundSet',
      native: [],
      managed: { live: 2, queued: 1 },
    });
  });

  it('publishes mixed native and delegation activity', () => {
    const events: ClaudeLifecycleEvent[] = [];
    jest
      .mocked(getLiveBackgroundTasksForChat)
      .mockReturnValue([{ taskId: 'native-task', taskType: 'workflow' }]);
    jest.mocked(activeDelegationCount).mockReturnValue(1);
    jest.mocked(queuedDelegationCount).mockReturnValue(3);
    jest.mocked(subscribeBackgroundWork).mockImplementation((listener) => {
      listener(sessionKey);
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));

    expect(events[0]).toMatchObject({
      type: 'BackgroundSet',
      native: [{ id: 'native-task', taskType: 'workflow' }],
      managed: { live: 1, queued: 3 },
    });
  });

  it('publishes an empty replacement after the final native and managed work ends', () => {
    const events: ClaudeLifecycleEvent[] = [];
    let listener: ((key: string) => void) | undefined;
    jest.mocked(subscribeBackgroundWork).mockImplementation((callback) => {
      listener = callback;
      return (): void => undefined;
    });
    setClaudeTurnLifecycleSink((event) => events.push(event));

    jest
      .mocked(getLiveBackgroundTasksForChat)
      .mockReturnValue([{ taskId: 'native-task' }]);
    jest.mocked(activeDelegationCount).mockReturnValue(1);
    jest.mocked(queuedDelegationCount).mockReturnValue(1);
    listener?.(sessionKey);
    jest.mocked(getLiveBackgroundTasksForChat).mockReturnValue([]);
    jest.mocked(activeDelegationCount).mockReturnValue(0);
    jest.mocked(queuedDelegationCount).mockReturnValue(0);
    listener?.(sessionKey);
    setClaudeTurnLifecycleSink(null);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'BackgroundSet',
      native: [],
      managed: { live: 0, queued: 0 },
    });
  });

  it('ignores changes for providers without a turn-lifecycle producer', () => {
    const events: ClaudeLifecycleEvent[] = [];
    jest.mocked(getSessionProviderType).mockReturnValue('ollama');
    jest.mocked(subscribeBackgroundWork).mockImplementation((listener) => {
      listener(sessionKey);
      return (): void => undefined;
    });

    setClaudeTurnLifecycleSink((event) => events.push(event));

    expect(events).toEqual([]);
  });

  it('subscribes once while a sink is registered and unsubscribes when it is cleared', () => {
    const unsubscribe = jest.fn();
    jest.mocked(subscribeBackgroundWork).mockReturnValue(unsubscribe);

    setClaudeTurnLifecycleSink(() => undefined);
    setClaudeTurnLifecycleSink(() => undefined);
    expect(subscribeBackgroundWork).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    setClaudeTurnLifecycleSink(null);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('starts and stops while a provider-neutral sink is registered', () => {
    const unsubscribe = jest.fn();
    jest.mocked(subscribeBackgroundWork).mockReturnValue(unsubscribe);

    setTurnLifecycleSink(() => undefined);
    setClaudeTurnLifecycleSink(() => undefined);
    expect(subscribeBackgroundWork).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    setTurnLifecycleSink(null);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
