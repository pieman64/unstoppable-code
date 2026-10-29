import type {
  WorkflowAgentProgress,
  WorkflowRunState,
  BackgroundProcess,
} from '@canopy/desktop-shared/types';
import type { WorkflowRunLocation } from '../workflow-run-launches';
import {
  hasLiveWorkflowProcess,
  terminalWorkflowRunStatus,
  workflowAgentInputState,
  workflowRunStatus,
  workflowRunSubagentInput,
} from '../workflow-run-inputs';

const NOW = 1_800_000_000_000;
const TRANSCRIPT_DIR = '/private/worktree/session/subagents/workflows/run-1';

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: 'run-1',
    status: 'running',
    phases: [],
    agents: [],
    ...overrides,
  };
}

function process(
  overrides: Partial<BackgroundProcess> = {},
): BackgroundProcess {
  return {
    id: 'process-1',
    chatId: 'chat-1',
    toolUseId: 'tool-1',
    toolName: 'Workflow',
    kind: 'workflow',
    description: 'Workflow run',
    status: 'running',
    startedAt: NOW - 1_000,
    updatedAt: NOW,
    outputLines: [],
    canStop: false,
    ...overrides,
  };
}

describe('terminalWorkflowRunStatus', () => {
  it.each([
    ['completed', 'completed'],
    ['COMPLETED', 'completed'],
    ['failed', 'failed'],
    ['ERROR', 'failed'],
    ['cancelled', 'interrupted'],
    ['Canceled', 'interrupted'],
    ['stopped', 'interrupted'],
    ['KILLED', 'interrupted'],
    ['running', null],
    [undefined, null],
  ])('maps %s to %s', (input, expected) => {
    expect(terminalWorkflowRunStatus(input)).toBe(expected);
  });
});

describe('hasLiveWorkflowProcess', () => {
  it('matches queued or running processes by run, tool use, or task id', () => {
    const processes = [
      process({ status: 'queued', runId: 'run-1' }),
      process({ status: 'running', taskId: 'task-1' }),
      process({ status: 'running', outputTaskId: 'task-2' }),
      process({ status: 'running', toolUseId: 'tool-1' }),
    ];

    expect(
      hasLiveWorkflowProcess(processes, {
        runId: 'run-1',
        taskId: 'other-task',
        toolUseId: 'other-tool',
      }),
    ).toBe(true);
    expect(
      hasLiveWorkflowProcess(processes, {
        runId: 'other-run',
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      hasLiveWorkflowProcess(processes, {
        runId: 'other-run',
        taskId: 'task-2',
      }),
    ).toBe(true);
    expect(
      hasLiveWorkflowProcess(processes, {
        runId: 'other-run',
        toolUseId: 'tool-1',
      }),
    ).toBe(true);
    expect(
      hasLiveWorkflowProcess(
        [process({ status: 'completed', runId: 'run-1' })],
        { runId: 'run-1' },
      ),
    ).toBe(false);
  });
});

describe('workflowRunStatus', () => {
  it('prefers a terminal run state over a live background process', () => {
    expect(
      workflowRunStatus(runState({ status: 'completed' }), {
        liveProcess: true,
        now: NOW,
      }),
    ).toBe('completed');
  });

  it('uses a live process when the run state is non-terminal', () => {
    expect(workflowRunStatus(runState(), { liveProcess: true, now: NOW })).toBe(
      'running',
    );
  });

  it('keeps a run active for recent activity and interrupts a quiet run', () => {
    expect(
      workflowRunStatus(runState({ lastActivityAt: NOW - 29 * 60_000 }), {
        liveProcess: false,
        now: NOW,
      }),
    ).toBe('running');
    expect(
      workflowRunStatus(runState({ lastActivityAt: NOW - 31 * 60_000 }), {
        liveProcess: false,
        now: NOW,
      }),
    ).toBe('interrupted');
    expect(workflowRunStatus(null, { liveProcess: false, now: NOW })).toBe(
      'interrupted',
    );
  });
});

describe('workflowAgentInputState', () => {
  it.each([
    ['queued', 'queued'],
    ['PENDING', 'queued'],
    ['waiting', 'queued'],
    ['running', 'running'],
    ['in_progress', 'running'],
    ['InProgress', 'running'],
    ['active', 'running'],
    ['done', 'completed'],
    ['SUCCESS', 'completed'],
    ['succeeded', 'completed'],
    ['error', 'failed'],
    ['FAILURE', 'failed'],
    ['canceled', 'cancelled'],
    ['aborted', 'cancelled'],
    ['interrupted', 'interrupted'],
    ['future-state', 'running'],
  ])('maps %s to %s', (input, expected) => {
    expect(workflowAgentInputState(input)).toBe(expected);
  });
});

describe('workflowRunSubagentInput', () => {
  const location: WorkflowRunLocation = {
    runId: 'run-1',
    transcriptDir: TRANSCRIPT_DIR,
    toolUseId: 'tool-1',
    name: 'Launch name',
    launchedAt: NOW - 10_000,
  };

  it('maps run and agent data, falls back to the launch name, and omits unsafe ids', () => {
    const mappedAgent: WorkflowAgentProgress = {
      index: 0,
      label: 'Builder',
      phaseIndex: 0,
      phaseTitle: 'Implement',
      agentId: 'agent_1-2',
      agentType: 'worker',
      model: 'claude-opus-4',
      state: 'done',
      promptPreview: 'Implement the change',
      startedAt: NOW - 5_000,
      settledAt: NOW - 1_000,
      tokens: 42,
      toolCalls: 3,
      durationMs: 4_000,
    };
    const unsafeAgent: WorkflowAgentProgress = {
      index: 1,
      label: 'Unsafe',
      phaseIndex: 0,
      phaseTitle: 'Implement',
      agentId: 'agent/path',
      agentType: 'worker',
      state: 'running',
    };
    const state = runState({
      workflowName: '  \t ',
      phases: [{ title: 'Implement', detail: 'Private detail' }],
      agents: [mappedAgent, unsafeAgent],
    });

    const result = workflowRunSubagentInput(location, state, 'completed');

    expect(result).toEqual({
      runId: 'run-1',
      name: 'Launch name',
      status: 'completed',
      startedAt: location.launchedAt,
      settledAt: NOW - 1_000,
      phases: [{ title: 'Implement' }],
      agents: [
        {
          agentId: 'agent_1-2',
          label: 'Builder',
          phaseTitle: 'Implement',
          state: 'completed',
          modelLabel: 'claude-opus-4',
          prompt: 'Implement the change',
          startedAt: NOW - 5_000,
          settledAt: NOW - 1_000,
          tokens: 42,
          toolCalls: 3,
          durationMs: 4_000,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(TRANSCRIPT_DIR);
    expect(JSON.stringify(result)).not.toContain('Private detail');
  });

  it('settles a run at its recorded duration, not its last agent', () => {
    const startedAt = NOW - 60_000;
    const state = runState({
      startedAt,
      durationMs: 60_000,
      agents: [
        {
          index: 0,
          label: 'Quick',
          phaseIndex: 0,
          phaseTitle: '',
          agentId: 'quick-agent',
          agentType: 'worker',
          state: 'done',
          startedAt,
          settledAt: startedAt + 10_000,
        },
      ],
    });

    const result = workflowRunSubagentInput(location, state, 'completed');

    expect(result.settledAt).toBe(startedAt + 60_000);
  });

  it('trims the state name and omits optional keys for missing values', () => {
    const state = runState({
      workflowName: '  State name  ',
      durationMs: 7_000,
      agents: [
        {
          index: 0,
          label: 'Minimal',
          phaseIndex: 0,
          phaseTitle: '',
          agentId: 'minimal-agent',
          agentType: 'worker',
          state: 'unknown',
        },
      ],
    });

    const result = workflowRunSubagentInput(location, state, 'failed');

    expect(result.name).toBe('State name');
    expect(result.settledAt).toBe(location.launchedAt + 7_000);
    expect(result.agents[0]).toEqual({
      agentId: 'minimal-agent',
      label: 'Minimal',
      state: 'running',
    });
    expect(result.agents[0]).not.toHaveProperty('phaseTitle');
    expect(result.agents[0]).not.toHaveProperty('modelLabel');
    expect(result.agents[0]).not.toHaveProperty('prompt');
    expect(result.agents[0]).not.toHaveProperty('settledAt');
  });

  it('does not set a settled time while the run is still running', () => {
    const state = runState({
      startedAt: NOW - 5_000,
      durationMs: 4_000,
    });

    const result = workflowRunSubagentInput(location, state, 'running');

    expect(result).not.toHaveProperty('settledAt');
  });

  it('returns empty phases and agents for an unloaded state', () => {
    const result = workflowRunSubagentInput(location, null, 'interrupted');

    expect(result.phases).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.name).toBe('Launch name');
  });
});
