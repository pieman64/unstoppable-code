import type {
  ExecutionState,
  JobResult,
  MaterializedJob,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { normalizePipeline } from '@canopy/pipeline-interop';
import type { PipelineRunExecutionState } from '@canopy/ui-app';
import { hasRerunReplayData } from '@canopy/ui-shared/lib';
import {
  mergePipelineRunRowEvent,
  toPipelineRunRowState,
} from '../pipelineRunRowState';

const AUTHORED_RUN_SENTINEL = 'authored-run-secret-sentinel';
const MATERIALIZED_RUN_SENTINEL = 'materialized-run-secret-sentinel';
const RESOLVED_RUN_SENTINEL = 'resolved-run-secret-sentinel';
const STEP_OUTPUT_SENTINEL = 'step-output-secret-sentinel';
const LOG_TAIL_SENTINEL = 'log-tail-secret-sentinel';
const RERUN_TEXT_SENTINEL = 'rerun-text-secret-sentinel';

interface FixtureOptions {
  eventName?: NonNullable<ExecutionState['event_name']>;
  inputsPersisted?: boolean;
  replayText?: string;
  status?: ExecutionState['status'];
}

function createMaterializedJob(
  pipelineJobs: ReturnType<typeof normalizePipeline>['jobs'],
  logicalJobId: string,
  physicalJobId: string,
): MaterializedJob {
  const job = pipelineJobs[logicalJobId];
  if (!job) {
    throw new Error(`Missing fixture job ${logicalJobId}`);
  }
  return {
    ...job,
    steps: job.steps.map((step) => ({
      ...step,
      run: MATERIALIZED_RUN_SENTINEL,
    })),
    physical_job_id: physicalJobId,
    logical_job_id: logicalJobId,
  };
}

function createJobResult(
  status: JobResult['status'],
  stepStatus: StepResult['status'],
): JobResult {
  return {
    status,
    steps: {
      compile: {
        status: stepStatus,
        outputs: { artifact: STEP_OUTPUT_SENTINEL },
        dynamic_env: {},
        resolved_run: RESOLVED_RUN_SENTINEL,
        log_file: LOG_TAIL_SENTINEL,
      },
    },
    outputs: { summary: STEP_OUTPUT_SENTINEL },
  };
}

function createExecutionState(options: FixtureOptions = {}): ExecutionState {
  const pipelineSnapshot = normalizePipeline({
    name: 'Pipeline row projection fixture',
    on: 'dispatch',
    jobs: {
      build: {
        name: 'Build artifacts',
        steps: [{ id: 'compile', run: AUTHORED_RUN_SENTINEL }],
      },
      deploy: {
        needs: 'build',
        steps: [{ id: 'release', run: AUTHORED_RUN_SENTINEL }],
      },
    },
  });
  const eventName = options.eventName ?? 'task_ready';
  const replayText = Object.prototype.hasOwnProperty.call(options, 'replayText')
    ? options.replayText
    : RERUN_TEXT_SENTINEL;
  const eventData: NonNullable<
    NonNullable<ExecutionState['rerun_context']>['event_data']
  > = {};
  if (replayText === undefined) {
    if (eventName === 'plan_ready' || eventName === 'task_ready') {
      // Keep exercising legacy/malformed persisted payloads with missing text.
      Reflect.set(eventData, eventName, {});
    }
  } else if (eventName === 'plan_ready') {
    eventData.plan_ready = { plan_text: replayText };
  } else if (eventName === 'task_ready') {
    eventData.task_ready = { task_text: replayText };
  }
  const rerunContext: NonNullable<ExecutionState['rerun_context']> = {
    event_data: eventData,
  };
  const macBuildId = 'build-variant-macos';
  const linuxBuildId = 'build-variant-linux';

  const state: ExecutionState = {
    version: 10,
    id: 'execution-row-fixture',
    pipeline_id: 'pipeline-row-fixture',
    pipeline_snapshot: pipelineSnapshot,
    status: options.status ?? 'running',
    jobs: {
      [macBuildId]: createJobResult('success', 'success'),
      [linuxBuildId]: createJobResult('running', 'failure'),
      deploy: createJobResult('pending', 'pending'),
    },
    job_definitions: {
      [macBuildId]: createMaterializedJob(
        pipelineSnapshot.jobs,
        'build',
        macBuildId,
      ),
      [linuxBuildId]: createMaterializedJob(
        pipelineSnapshot.jobs,
        'build',
        linuxBuildId,
      ),
      deploy: createMaterializedJob(pipelineSnapshot.jobs, 'deploy', 'deploy'),
    },
    job_groups: {
      build: {
        job_id: 'build',
        kind: 'matrix',
        expansion: 'expanded',
        variant_job_ids: [macBuildId, linuxBuildId],
        status: 'running',
        started_at: '2026-10-24T10:00:00.000Z',
        resolved_max_parallel: 2,
      },
      deploy: {
        job_id: 'deploy',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['deploy'],
        status: 'pending',
      },
    },
    started_at: '2026-10-24T10:00:00.000Z',
    cwd: '/tmp/pipeline-row-fixture',
    env: {},
    inputs: {},
    ...(options.inputsPersisted === undefined
      ? {}
      : { inputs_persisted: options.inputsPersisted }),
    event_name: eventName,
    rerun_context: rerunContext,
    planId: 'plan-row-fixture',
    rerun_source_id: 'rerun-source-fixture',
    trigger_source: {
      kind: 'hook',
      hook_key: 'fixture-hook',
      hook_label: 'Fixture hook',
      trigger_name: 'fixture:event',
      target: 'project',
      action_index: 0,
      triggered_at: '2026-10-24T10:00:00.000Z',
    },
    status_reasons: [
      {
        id: 'reason-fixture',
        kind: 'provider_usage_limit',
        code: 'rate_limit',
        provider: 'claude',
        detected_at: '2026-10-24T10:01:00.000Z',
        resets_at: '2026-10-24T11:00:00.000Z',
        diagnostic_message: 'diagnostic-message-secret-sentinel',
        source: {
          job_id: macBuildId,
          step_id: 'compile',
          attempt: 1,
          iteration: 1,
        },
      },
    ],
    pending_pauses: [
      {
        id: 'pause-fixture',
        kind: 'input',
        job_id: macBuildId,
        logical_job_id: 'build',
        step_id: 'compile',
        attempt: 1,
        iteration: 1,
        detected_at: '2026-10-24T10:01:00.000Z',
        request: {
          title: 'Input title',
          message: 'Input message',
          fields: [
            {
              key: 'unsafe-field',
              label: 'Unsafe field',
              type: 'string',
              default: STEP_OUTPUT_SENTINEL,
            },
          ],
        },
      },
    ],
  };

  Reflect.set(
    state.jobs[macBuildId].steps.compile,
    'log_tail',
    LOG_TAIL_SENTINEL,
  );
  return state;
}

describe('pipeline run row state projection', () => {
  it('retains the narrow row whitelist without scripts, output, logs, or replay text', () => {
    const state = createExecutionState({ inputsPersisted: true });
    const originalState = structuredClone(state);

    const row = toPipelineRunRowState(state);
    const serializedRow = JSON.stringify(row);

    expect(state).toEqual(originalState);
    for (const sentinel of [
      AUTHORED_RUN_SENTINEL,
      MATERIALIZED_RUN_SENTINEL,
      RESOLVED_RUN_SENTINEL,
      STEP_OUTPUT_SENTINEL,
      LOG_TAIL_SENTINEL,
      RERUN_TEXT_SENTINEL,
      'diagnostic-message-secret-sentinel',
    ]) {
      expect(serializedRow).not.toContain(sentinel);
    }
    expect(row).toMatchObject({
      id: state.id,
      status: state.status,
      planId: state.planId,
      rerun_source_id: state.rerun_source_id,
      event_name: state.event_name,
      inputs_persisted: true,
      trigger_source: state.trigger_source,
      pipeline_snapshot: {
        jobs: {
          build: {
            name: 'Build artifacts',
            needs: [],
            steps: [{ id: 'compile' }],
          },
          deploy: { needs: ['build'], steps: [{ id: 'release' }] },
        },
      },
      jobs: {
        'build-variant-macos': {
          status: 'success',
          steps: { compile: { status: 'success' } },
        },
        'build-variant-linux': {
          status: 'running',
          steps: { compile: { status: 'failure' } },
        },
        deploy: {
          status: 'pending',
          steps: { compile: { status: 'pending' } },
        },
      },
      job_groups: {
        build: {
          kind: 'matrix',
          status: 'running',
          variant_job_ids: ['build-variant-macos', 'build-variant-linux'],
          started_at: '2026-10-24T10:00:00.000Z',
          resolved_max_parallel: 2,
        },
      },
      status_reasons: [
        {
          id: 'reason-fixture',
          kind: 'provider_usage_limit',
          code: 'rate_limit',
          provider: 'claude',
          resets_at: '2026-10-24T11:00:00.000Z',
        },
      ],
      pending_pauses: [
        {
          id: 'pause-fixture',
          kind: 'input',
          job_id: 'build-variant-macos',
          logical_job_id: 'build',
          step_id: 'compile',
          request: {
            title: 'Input title',
            message: 'Input message',
            fields: [],
          },
        },
      ],
      rerun_context: {
        event_data: { task_ready: { task_text: '1' } },
      },
    });
    expect(row.job_groups.build.variant_job_ids).toEqual([
      'build-variant-macos',
      'build-variant-linux',
    ]);
    expect(row.pending_pauses?.[0].request?.fields).toEqual([]);
    expect(row.status_reasons?.[0]).not.toHaveProperty('diagnostic_message');

    const x: PipelineRunExecutionState = row;
    expect(x.jobs['build-variant-linux'].steps.compile.status).toBe('failure');
  });

  it('preserves replay eligibility for every persisted-input and replay-text state', () => {
    const persistedValues = [false, true, undefined];
    const replayTexts = [undefined, '', '   ', 'non-empty replay text'];

    const eventNames: NonNullable<ExecutionState['event_name']>[] = [
      'task_ready',
      'plan_ready',
    ];
    for (const eventName of eventNames) {
      for (const inputsPersisted of persistedValues) {
        for (const replayText of replayTexts) {
          const fullState = createExecutionState({
            eventName,
            inputsPersisted,
            replayText,
          });
          const row = toPipelineRunRowState(fullState);

          expect(hasRerunReplayData(row)).toBe(hasRerunReplayData(fullState));
          expect(row.inputs_persisted).toBe(inputsPersisted);
          const replayMarker =
            eventName === 'task_ready'
              ? row.rerun_context?.event_data?.task_ready?.task_text
              : row.rerun_context?.event_data?.plan_ready?.plan_text;
          expect(replayMarker).toBe(
            replayText === undefined
              ? undefined
              : replayText.length === 0
                ? ''
                : '1',
          );
        }
      }
    }
  });

  it('overlays a definition-less event onto an existing row and ignores it without a row', () => {
    const original = createExecutionState({ inputsPersisted: true });
    const existing = toPipelineRunRowState(original);
    const incoming = createExecutionState({
      status: 'paused',
      inputsPersisted: false,
    });
    incoming.jobs['build-variant-macos'].status = 'failure';
    incoming.jobs['build-variant-macos'].steps.compile.status = 'failure';
    incoming.job_groups.build.status = 'failure';
    incoming.pending_pauses = [
      {
        id: 'event-pause',
        kind: 'action',
        job_id: 'build-variant-linux',
        logical_job_id: 'build',
        step_id: 'compile',
        attempt: 2,
        iteration: 1,
        detected_at: '2026-10-24T10:02:00.000Z',
      },
    ];
    Reflect.deleteProperty(incoming, 'job_definitions');
    Reflect.deleteProperty(incoming.pipeline_snapshot, 'jobs');

    const merged = mergePipelineRunRowEvent(existing, incoming);

    expect(merged).toMatchObject({
      status: 'paused',
      inputs_persisted: false,
      pipeline_snapshot: { jobs: { build: { steps: [{ id: 'compile' }] } } },
      jobs: {
        'build-variant-macos': {
          status: 'failure',
          steps: { compile: { status: 'failure' } },
        },
      },
      job_groups: { build: { status: 'failure' } },
      pending_pauses: [
        {
          id: 'event-pause',
          kind: 'action',
          job_id: 'build-variant-linux',
          logical_job_id: 'build',
          step_id: 'compile',
        },
      ],
    });
    expect(mergePipelineRunRowEvent(undefined, incoming)).toBeUndefined();
  });
});
