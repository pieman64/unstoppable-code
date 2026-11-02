import type {
  ExecutionEvent,
  PipelinePauseCheckpoint,
  PipelineStatusReason,
} from '@canopy/desktop-shared/types/pipeline';
import { getPipelineNotificationClass } from '@canopy/desktop-shared/pipelines/get-notification-class';

const INPUT_REASON: PipelineStatusReason = {
  id: 'reason-1',
  kind: 'input_required',
  code: 'input_requested',
  detected_at: '2026-06-02T00:00:01.000Z',
  source: { job_id: 'job', step_id: 'step', attempt: 0, iteration: 1 },
};

const INPUT_PAUSE: PipelinePauseCheckpoint = {
  id: 'pause-1',
  kind: 'input',
  job_id: 'job',
  logical_job_id: 'job',
  step_id: 'step',
  attempt: 0,
  iteration: 1,
  detected_at: '2026-06-02T00:00:01.000Z',
};

function makePausedEvent({
  statusReasons = [],
  pendingPauses = [],
  omit = [],
}: {
  statusReasons?: PipelineStatusReason[];
  pendingPauses?: PipelinePauseCheckpoint[];
  omit?: Array<'status_reasons' | 'pending_pauses'>;
}): ExecutionEvent {
  const event: ExecutionEvent = {
    executionId: 'exec-1',
    type: 'execution.paused',
    timestamp: '2026-06-02T00:00:01.000Z',
    state: {
      version: 1,
      id: 'exec-1',
      pipeline_id: 'pipe-1',
      pipeline_snapshot: { name: 'Deploy', scope: ['directory'], jobs: {} },
      status: 'paused',
      jobs: {},
      job_definitions: {},
      job_groups: {},
      started_at: '2026-06-02T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
      status_reasons: statusReasons,
      pending_pauses: pendingPauses,
    },
  };
  // Events that skip load-time migration can lack these fields entirely.
  for (const field of omit) Reflect.deleteProperty(event.state, field);
  return event;
}

describe('getPipelineNotificationClass for paused runs', () => {
  it.each([
    ['no status reasons', { omit: ['status_reasons'] as const }],
    ['no pause checkpoints', { omit: ['pending_pauses'] as const }],
    ['neither field', { omit: ['status_reasons', 'pending_pauses'] as const }],
  ])('treats a pause with %s as routine', (_label, { omit }) => {
    expect(
      getPipelineNotificationClass(makePausedEvent({ omit: [...omit] })),
    ).toBe('routine');
  });

  it('treats an attention reason as attention without pause checkpoints', () => {
    expect(
      getPipelineNotificationClass(
        makePausedEvent({
          statusReasons: [INPUT_REASON],
          omit: ['pending_pauses'],
        }),
      ),
    ).toBe('attention');
  });

  it('treats an input checkpoint as attention without status reasons', () => {
    expect(
      getPipelineNotificationClass(
        makePausedEvent({
          pendingPauses: [INPUT_PAUSE],
          omit: ['status_reasons'],
        }),
      ),
    ).toBe('attention');
  });
});
