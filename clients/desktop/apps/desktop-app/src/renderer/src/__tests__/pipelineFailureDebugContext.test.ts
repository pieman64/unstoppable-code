import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import {
  buildPipelineFailureDebugPrompt,
  type PipelineFailureDebugContextOptions,
} from '../lib/pipelineFailureDebugContext';

type ReadStepLog = PipelineFailureDebugContextOptions['readStepLog'];
type ReadReportFile = PipelineFailureDebugContextOptions['readReportFile'];

function createState(): ExecutionState {
  const buildDefinition = {
    name: 'Build job',
    needs: [],
    timeout_minutes: 360,
    max_retries: 1,
    max_iterations: 2,
    continue_on_error: false,
    physical_job_id: 'build',
    logical_job_id: 'build',
    steps: [
      {
        id: 'setup',
        name: 'Setup',
        uses: 'builtin/agent-prompt',
        shell: 'bash' as const,
        with: {
          prompt: 'short prompt',
          api_key: 'snapshot-secret',
        },
        env: { NORMAL_ENV: 'ok', TOKEN_VALUE: 'secret' },
        continue_on_error: false,
        timeout_minutes: 360,
        skip_on_missing_action: false,
      },
      {
        id: 'test',
        name: 'Test',
        run: 'npm test',
        shell: 'bash' as const,
        continue_on_error: false,
        timeout_minutes: 360,
        skip_on_missing_action: false,
      },
    ],
  };
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-debug',
    pipeline_snapshot: {
      name: 'Debug Pipeline',
      jobs: {
        build: {
          name: 'Build job',
          needs: [],
          timeout_minutes: 360,
          max_retries: 1,
          max_iterations: 2,
          continue_on_error: false,
          steps: [
            {
              id: 'setup',
              name: 'Setup',
              uses: 'builtin/agent-prompt',
              shell: 'bash',
              with: {
                prompt: 'short prompt',
                api_key: 'snapshot-secret',
              },
              env: { NORMAL_ENV: 'ok', TOKEN_VALUE: 'secret' },
              continue_on_error: false,
              timeout_minutes: 360,
              skip_on_missing_action: false,
            },
            {
              id: 'test',
              name: 'Test',
              run: 'npm test',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 360,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    },
    status: 'failure',
    jobs: {
      build: {
        status: 'failure',
        outputs: {},
        retry_count: 1,
        iteration_count: 2,
        report_outputs: {
          report_file: '/tmp/pipeline-executions/exec-1/report.md',
        },
        retry_history: [
          {
            attempt: 0,
            status: 'failure',
            steps: {
              setup: {
                status: 'failure',
                outputs: {
                  transcript_file:
                    '/tmp/pipeline-executions/exec-1/logs/setup-transcript.jsonl',
                  nested_token: 'secret-output',
                },
                dynamic_env: {},
                exit_code: 1,
                error: 'setup failed',
                log_file: '/tmp/pipeline-executions/exec-1/logs/setup-a0.log',
              },
              test: { status: 'pending', outputs: {}, dynamic_env: {} },
            },
          },
        ],
        iteration_history: [
          {
            iteration: 1,
            status: 'failure',
            steps: {
              setup: { status: 'success', outputs: {}, dynamic_env: {} },
              test: {
                status: 'success',
                outputs: { value: 'iteration output' },
                dynamic_env: {},
                exit_code: 5,
                log_file: '/tmp/pipeline-executions/exec-1/logs/test-i1.log',
              },
            },
          },
        ],
        steps: {
          setup: { status: 'success', outputs: {}, dynamic_env: {} },
          test: {
            status: 'failure',
            outputs: {
              report_file: '/tmp/pipeline-executions/exec-1/report.md',
              password: 'output-password',
            },
            dynamic_env: {},
            exit_code: 2,
            error: 'tests failed',
            log_file: '/tmp/pipeline-executions/exec-1/logs/test-current.log',
            report_outputs: {
              report_file: '/tmp/pipeline-executions/exec-1/report.md',
              report_json_file: '/tmp/pipeline-executions/exec-1/report.json',
            },
          },
        },
      },
    },
    job_definitions: { build: buildDefinition },
    job_groups: {
      build: {
        job_id: 'build',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['build'],
        status: 'failure',
      },
    },
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-05-08T10:00:00.000Z',
    completed_at: '2026-05-08T10:01:00.000Z',
    cwd: '/repo',
    repo_path: '/repo',
    project_id: 'project-1',
    worktree_id: 'worktree-1',
    parent_execution_id: 'parent-1',
    parent_step_id: 'parent-step',
    parent_attempt: 2,
    parent_iteration: 3,
    rerun_source_id: 'rerun-1',
    env: {
      PATH: '/bin',
      API_TOKEN: 'secret-token',
    },
    inputs: {
      safe: 'value',
      password: 'input-password',
      long: 'x'.repeat(1_050),
    },
    inputs_persisted: true,
    event_name: 'dispatch',
    event_data: {
      plan_ready: {
        plan_path: '/tmp/plan.md',
        planId: 'plan-token-secret',
      },
    },
    error: 'top level failure',
    report_outputs: {
      report_file: '/tmp/pipeline-executions/exec-1/report.md',
      report_json_file: '/tmp/pipeline-executions/exec-1/report.json',
    },
  };
}

function createReadStepLog(): jest.MockedFunction<ReadStepLog> {
  return jest.fn().mockResolvedValue({
    success: true,
    data: {
      lines: Array.from(
        { length: 250 },
        (_value, index) => `log-line-${String(index + 1).padStart(3, '0')}`,
      ),
    },
  });
}

function createReadReportFile(): jest.MockedFunction<ReadReportFile> {
  return jest
    .fn()
    .mockResolvedValueOnce({
      success: true,
      data: { content: 'text report', filePath: '/tmp/report.md' },
    })
    .mockResolvedValueOnce({
      success: true,
      data: {
        content: '{"ok":false,"token":"json-secret"}',
        filePath: '/tmp/report.json',
      },
    });
}

describe('buildPipelineFailureDebugPrompt', () => {
  it('builds a bounded redacted prompt with failed attempts, reports, and logs', async () => {
    const state = createState();
    Object.defineProperty(state.inputs, 'cycle', {
      enumerable: true,
      value: state.inputs,
    });
    const readStepLog = createReadStepLog();
    const readReportFile = createReadReportFile();

    const result = await buildPipelineFailureDebugPrompt(state, {
      readStepLog,
      readReportFile,
    });

    expect(result.failedStepCount).toBe(3);
    expect(result.includedReportKinds).toEqual(['text', 'json']);
    expect(result.prompt).toContain(
      'Please debug this failed Canopy pipeline run.',
    );
    expect(result.prompt).toContain('- execution id: exec-1');
    expect(result.prompt).toContain('- pipeline id: pipeline-debug');
    expect(result.prompt).toContain('- pipeline name: Debug Pipeline');
    expect(result.prompt).toContain('- cwd: /repo');
    expect(result.prompt).toContain('- repo path: /repo');
    expect(result.prompt).toContain('- project id: project-1');
    expect(result.prompt).toContain('- worktree id: worktree-1');
    expect(result.prompt).toContain('- parent execution id: parent-1');
    expect(result.prompt).toContain('- rerun source id: rerun-1');
    expect(result.prompt).toContain('Attempt 1 (failure)');
    expect(result.prompt).toContain('Attempt 2 / Iteration 1');
    expect(result.prompt).toContain('Attempt 2 / Iteration 2 (current)');
    expect(result.prompt).toContain(
      '/tmp/pipeline-executions/exec-1/report.md',
    );
    expect(result.prompt).toContain(
      '/tmp/pipeline-executions/exec-1/logs/test-current.log',
    );
    expect(result.prompt).toContain('[redacted]');
    expect(result.prompt).not.toContain('secret-token');
    expect(result.prompt).not.toContain('json-secret');
    expect(result.prompt).not.toContain('input-password');
    expect(result.prompt).not.toContain('output-password');
    expect(result.prompt).toContain('[truncated 50 characters]');
    expect(result.prompt).toContain('[cycle]');
    expect(result.prompt).toContain('[showing last 200 of 250 lines]');
    expect(result.prompt).not.toContain('log-line-001');
    expect(result.prompt).toContain('log-line-250');
    expect(readReportFile).toHaveBeenNthCalledWith(1, 'exec-1', 'text');
    expect(readReportFile).toHaveBeenNthCalledWith(2, 'exec-1', 'json');
    expect(readStepLog).toHaveBeenCalledWith({
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'setup',
      attempt: 0,
      iteration: undefined,
      logFilePath: '/tmp/pipeline-executions/exec-1/logs/setup-a0.log',
    });
  });

  it('omits env values to avoid leaking credentials with non-standard key names', async () => {
    const state = createState();
    state.env = {
      DATABASE_URL: 'postgres://user:pw@host/db',
      MY_DEPLOY_KEY: 'super-secret-deploy',
      PATH: '/bin',
    };
    const readStepLog = createReadStepLog();
    const readReportFile = createReadReportFile();

    const result = await buildPipelineFailureDebugPrompt(state, {
      readStepLog,
      readReportFile,
    });

    expect(result.prompt).toContain(
      'Environment values are omitted from this prompt',
    );

    // Key names should appear in the listing.
    expect(result.prompt).toContain('DATABASE_URL');
    expect(result.prompt).toContain('MY_DEPLOY_KEY');
    expect(result.prompt).toContain('PATH');

    // Values must not be inlined anywhere in the prompt.
    expect(result.prompt).not.toContain('postgres://user:pw@host/db');
    expect(result.prompt).not.toContain('super-secret-deploy');
    expect(result.prompt).not.toContain('### env\n```json');
  });

  it('keeps the newest log tail content when truncating long logs', async () => {
    const state = createState();
    state.jobs.build.retry_history = [];
    state.jobs.build.iteration_history = [];
    state.jobs.build.retry_count = 0;
    state.jobs.build.iteration_count = 1;
    state.jobs.build.steps.setup = {
      status: 'success',
      outputs: {},
      dynamic_env: {},
    };
    state.jobs.build.steps.test = {
      status: 'failure',
      outputs: {},
      dynamic_env: {},
      exit_code: 2,
      log_file: '/tmp/pipeline-executions/exec-1/logs/test-current.log',
    };
    const readStepLog: jest.MockedFunction<ReadStepLog> = jest
      .fn()
      .mockResolvedValue({
        success: true,
        data: {
          lines: [`old-${'x'.repeat(20_000)}`, 'newest-tail-line'],
        },
      });
    const readReportFile = createReadReportFile();

    const result = await buildPipelineFailureDebugPrompt(state, {
      readStepLog,
      readReportFile,
    });

    expect(result.prompt).toContain('[truncated ');
    expect(result.prompt).toContain('characters from the front]');
    expect(result.prompt).toContain('newest-tail-line');
  });

  it('keeps successful report kinds and logs read failures inline', async () => {
    const state = createState();
    const readStepLog: jest.MockedFunction<ReadStepLog> = jest
      .fn()
      .mockRejectedValueOnce(new Error('missing log'))
      .mockResolvedValue({
        success: true,
        data: { lines: ['ok'] },
      });
    const readReportFile: jest.MockedFunction<ReadReportFile> = jest
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'no text' })
      .mockResolvedValueOnce({
        success: true,
        data: { content: '{"ok":true}', filePath: '/tmp/report.json' },
      });

    const result = await buildPipelineFailureDebugPrompt(state, {
      readStepLog,
      readReportFile,
    });

    expect(result.includedReportKinds).toEqual(['json']);
    expect(result.prompt).toContain('Report read note: no text');
    expect(result.prompt).toContain('log read failed: missing log');
  });

  it('describes the default selection when no failed step is recorded', async () => {
    const state = createState();
    state.jobs.build.retry_history = [];
    state.jobs.build.iteration_history = [];
    state.jobs.build.retry_count = 0;
    state.jobs.build.iteration_count = 1;
    state.jobs.build.steps.setup = {
      status: 'success',
      outputs: {},
      dynamic_env: {},
    };
    state.jobs.build.steps.test = {
      status: 'success',
      outputs: {},
      dynamic_env: {},
    };
    const readStepLog = createReadStepLog();
    const readReportFile = createReadReportFile();

    const result = await buildPipelineFailureDebugPrompt(state, {
      readStepLog,
      readReportFile,
    });

    expect(result.failedStepCount).toBe(0);
    expect(result.prompt).toContain('No failed step instance was recorded.');
    expect(result.prompt).toContain('- job id: build');
    expect(result.prompt).toContain('- step id: test');
    expect(result.prompt).toContain('Top-level error: top level failure');
    expect(readStepLog).not.toHaveBeenCalled();
  });
});
