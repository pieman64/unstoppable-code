/**
 * @jest-environment jsdom
 */
import type {
  WorkflowAgentProgress,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import {
  subscribeWorkflowRunProgress,
  workflowProgressFromRun,
} from '../workflow-progress';

const PHASES = ['Plan', 'Review', 'Report'];

/** A live-journal agent: phases numbered from 0, titled as the run's. */
function agent(
  over: Partial<WorkflowAgentProgress> &
    Pick<WorkflowAgentProgress, 'index' | 'label' | 'state' | 'phaseIndex'>,
): WorkflowAgentProgress {
  return {
    phaseTitle: PHASES[over.phaseIndex] ?? '',
    agentId: `agent-${String(over.index)}`,
    agentType: 'general-purpose',
    ...over,
  };
}

function run(over: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: 'wf_1',
    status: 'running',
    phases: [{ title: 'Plan' }, { title: 'Review' }, { title: 'Report' }],
    agents: [
      agent({ index: 0, label: 'Planner', state: 'done', phaseIndex: 0 }),
      agent({
        index: 1,
        label: 'Header copy',
        state: 'running',
        phaseIndex: 1,
        lastToolSummary: 'Reading header.tsx',
      }),
      agent({ index: 2, label: 'Error copy', state: 'queued', phaseIndex: 1 }),
      agent({ index: 3, label: 'Summary', state: 'error', phaseIndex: 2 }),
    ],
    ...over,
  };
}

describe('workflowProgressFromRun', () => {
  it('reports the phase its running agents are in, and every agent', () => {
    expect(workflowProgressFromRun(run())).toEqual({
      phaseTitle: 'Review',
      phaseIndex: 1,
      phaseCount: 3,
      agents: [
        { id: 'agent-0', label: 'Planner', state: 'done', activity: null },
        {
          id: 'agent-1',
          label: 'Header copy',
          state: 'running',
          activity: 'Reading header.tsx',
        },
        { id: 'agent-2', label: 'Error copy', state: 'queued', activity: null },
        { id: 'agent-3', label: 'Summary', state: 'failed', activity: null },
      ],
    });
  });

  it('falls back to the last phase reached once nothing runs', () => {
    const settled = run({
      status: 'completed',
      agents: run().agents.map((item) => ({ ...item, state: 'done' })),
    });
    expect(workflowProgressFromRun(settled)).toMatchObject({
      phaseTitle: 'Report',
      phaseIndex: 2,
    });
    expect(workflowProgressFromRun(run({ agents: [] }))).toMatchObject({
      phaseTitle: null,
      phaseIndex: null,
      phaseCount: 3,
      agents: [],
    });
  });

  it('reads phases by title, then by the 1-based index run states persist', () => {
    // A finished run's persisted state numbers its phases from 1.
    const persisted = run({
      agents: run().agents.map((item) => ({
        ...item,
        phaseIndex: item.phaseIndex + 1,
      })),
    });
    expect(workflowProgressFromRun(persisted)).toMatchObject({
      phaseTitle: 'Review',
      phaseIndex: 1,
      phaseCount: 3,
    });
    const untitled = run({
      agents: persisted.agents.map((item) => ({ ...item, phaseTitle: '' })),
    });
    expect(workflowProgressFromRun(untitled)).toMatchObject({
      phaseTitle: 'Review',
      phaseIndex: 1,
    });
  });
});

describe('subscribeWorkflowRunProgress', () => {
  const readWorkflowRun = jest.fn<
    Promise<WorkflowRunState | null>,
    [unknown]
  >();

  beforeEach(() => {
    jest.useFakeTimers();
    readWorkflowRun.mockReset();
    Reflect.set(window, 'api', { activity: { readWorkflowRun } });
  });

  afterEach(() => {
    jest.useRealTimers();
    Reflect.deleteProperty(window, 'api');
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('polls while subscribed and stops when unsubscribed', async () => {
    readWorkflowRun.mockResolvedValue(run());
    const onProgress = jest.fn();
    const unsubscribe = subscribeWorkflowRunProgress(
      '/runs/wf_1',
      'wf_1',
      onProgress,
    );
    await flush();
    expect(readWorkflowRun).toHaveBeenCalledWith({
      transcriptDir: '/runs/wf_1',
      runId: 'wf_1',
    });
    expect(onProgress).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);

    unsubscribe();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the run has ended', async () => {
    readWorkflowRun.mockResolvedValue(run({ status: 'completed' }));
    const onProgress = jest.fn();
    subscribeWorkflowRunProgress('/runs/wf_1', 'wf_1', onProgress);
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(readWorkflowRun).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
