import type { ExecutionEvent } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { getToastType } from '@canopy/desktop-shared/pipelines/get-toast-type';

function makeEvent(
  overrides: Partial<ExecutionEvent> & {
    type: ExecutionEvent['type'];
    status?: ExecutionEvent['state']['status'];
  },
): ExecutionEvent {
  const { type, status = 'success', ...rest } = overrides;

  const base: ExecutionEvent = {
    executionId: 'exec-1',
    type,
    timestamp: new Date().toISOString(),
    state: {
      version: 1,
      id: 'exec-1',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: {
        name: 'test-pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status,
      jobs: {},
      job_definitions: {},
      job_groups: {},
      started_at: new Date().toISOString(),
      cwd: '/tmp',
      env: {},
      inputs: {},
      pending_pauses: [],
      status_reasons: [],
    },
    ...rest,
  };

  return base;
}

describe('getToastType', () => {
  it('returns error for execution.failed', () => {
    const event = makeEvent({ type: 'execution.failed', status: 'failure' });
    expect(getToastType(event)).toBe('error');
  });

  it('returns success for execution.completed with success status', () => {
    const event = makeEvent({ type: 'execution.completed', status: 'success' });
    expect(getToastType(event)).toBe('success');
  });

  it('returns error for execution.completed with failure status', () => {
    const event = makeEvent({ type: 'execution.completed', status: 'failure' });
    expect(getToastType(event)).toBe('error');
  });

  it('returns warning for execution.paused', () => {
    const event = makeEvent({ type: 'execution.paused', status: 'paused' });
    expect(getToastType(event)).toBe('warning');
  });

  it('returns null for execution.completed with paused status', () => {
    const event = makeEvent({ type: 'execution.completed', status: 'paused' });
    expect(getToastType(event)).toBeNull();
  });

  it('returns null for execution.completed with cancelled status', () => {
    const event = makeEvent({
      type: 'execution.completed',
      status: 'cancelled',
    });
    expect(getToastType(event)).toBeNull();
  });

  it('returns null for child pipeline completion', () => {
    const event = makeEvent({ type: 'execution.completed', status: 'success' });
    event.state.parent_execution_id = 'parent-exec-1';
    expect(getToastType(event)).toBeNull();
  });

  it('returns null for child pipeline failure', () => {
    const event = makeEvent({ type: 'execution.failed', status: 'failure' });
    event.state.parent_execution_id = 'parent-exec-1';
    expect(getToastType(event)).toBeNull();
  });

  it('returns null for non-terminal event types', () => {
    expect(getToastType(makeEvent({ type: 'execution.started' }))).toBeNull();
    expect(getToastType(makeEvent({ type: 'execution.updated' }))).toBeNull();
    expect(getToastType(makeEvent({ type: 'execution.cancelled' }))).toBeNull();
  });
});
