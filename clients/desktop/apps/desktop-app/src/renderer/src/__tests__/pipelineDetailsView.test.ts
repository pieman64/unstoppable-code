import type {
  ExecutionState,
  PipelineAdvisorSnapshot,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import {
  buildEventInputs,
  getPresentJobStatuses,
  shouldPromoteAdvisor,
  isStepDefaultExpanded,
  JOB_STATUS_ORDER,
} from '@/lib/pipelineDetailsView';

function state(statuses: string[]): ExecutionState {
  const jobs: ExecutionState['jobs'] = {};
  statuses.forEach((s, i) => {
    jobs[`j${i}`] = {
      status: s,
      steps: {},
      outputs: {},
    } as ExecutionState['jobs'][string];
  });
  return { jobs } as ExecutionState;
}

describe('getPresentJobStatuses', () => {
  it('returns only present statuses with counts, in canonical order', () => {
    const result = getPresentJobStatuses(
      state(['failure', 'success', 'success']),
    );
    expect(result).toEqual([
      { status: 'success', count: 2 },
      { status: 'failure', count: 1 },
    ]);
  });
  it('orders by JOB_STATUS_ORDER', () => {
    const result = getPresentJobStatuses(
      state(['success', 'running', 'queued']),
    );
    expect(result.map((r) => r.status)).toEqual(
      JOB_STATUS_ORDER.filter((s) =>
        ['success', 'running', 'queued'].includes(s),
      ),
    );
  });
});

describe('shouldPromoteAdvisor', () => {
  it('promotes when health is not the healthy status', () => {
    const snap = {
      latestReport: { health: { status: 'degraded' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(true);
  });
  it('promotes when health is watch', () => {
    const snap = {
      latestReport: { health: { status: 'watch' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(true);
  });
  it('promotes when health is blocked', () => {
    const snap = {
      latestReport: { health: { status: 'blocked' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(true);
  });
  it("does not promote when health is 'complete'", () => {
    const snap = {
      latestReport: { health: { status: 'complete' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(false);
  });
  it("does not promote when health is 'unknown'", () => {
    const snap = {
      latestReport: { health: { status: 'unknown' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(false);
  });
  it('does not promote when healthy', () => {
    const snap = {
      latestReport: { health: { status: 'healthy' } },
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(false);
  });
  it('does not promote when there is no report', () => {
    expect(shouldPromoteAdvisor(undefined)).toBe(false);
  });
  it('does not promote when latestReport is absent', () => {
    const snap = {
      latestReport: undefined,
    } as unknown as PipelineAdvisorSnapshot;
    expect(shouldPromoteAdvisor(snap)).toBe(false);
  });
});

describe('buildEventInputs', () => {
  it('flattens scalar inputs to strings', () => {
    const execution = {
      inputs: { A: '1', count: 2, enabled: true },
    } as unknown as ExecutionState;
    expect(buildEventInputs(execution)).toEqual({
      A: '1',
      count: '2',
      enabled: 'true',
    });
  });
  it('adds plan_path from plan_ready event data', () => {
    const execution = {
      inputs: { A: '1' },
      event_data: { plan_ready: { plan_path: '/tmp/plan.md' } },
    } as unknown as ExecutionState;
    expect(buildEventInputs(execution)).toEqual({
      A: '1',
      plan_path: '/tmp/plan.md',
    });
  });
  it('adds task_path and plan_path from task_ready event data', () => {
    const execution = {
      inputs: {},
      event_data: {
        task_ready: { task_path: '/tmp/task.md', plan_path: '/tmp/plan.md' },
      },
    } as unknown as ExecutionState;
    expect(buildEventInputs(execution)).toEqual({
      task_path: '/tmp/task.md',
      plan_path: '/tmp/plan.md',
    });
  });
});

describe('isStepDefaultExpanded', () => {
  it('expands running steps', () => {
    expect(isStepDefaultExpanded({ status: 'running' } as StepResult)).toBe(
      true,
    );
  });
  it('collapses non-running steps', () => {
    expect(isStepDefaultExpanded({ status: 'success' } as StepResult)).toBe(
      false,
    );
    expect(isStepDefaultExpanded(undefined)).toBe(false);
  });
});
