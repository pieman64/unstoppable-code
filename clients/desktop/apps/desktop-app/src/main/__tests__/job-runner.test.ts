jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import * as stepRunner from '@canopy/desktop-shared/node/pipelines/executor/step-runner';
import {
  INPUT_REQUEST_OUTPUT_KEY,
  JOB_RESTART_OUTPUT_KEY,
  PAUSE_OUTPUT_KEY,
  REPORT_OUTPUT_KEY,
} from '@canopy/desktop-shared/node/pipelines/executor/step-runner';
import { runJob } from '@canopy/desktop-shared/node/pipelines/executor/job-runner';
import type {
  JobResult,
  NormalizedJob,
  NormalizedPipeline,
  StepResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';

function createJobResult(job: NormalizedJob): JobResult {
  return {
    status: 'pending',
    outputs: {},
    retry_count: 0,
    retry_history: [],
    iteration_count: 0,
    steps: Object.fromEntries(
      job.steps.map((step) => [
        step.id,
        {
          status: 'pending',
          outputs: {},
          dynamic_env: {},
        },
      ]),
    ),
  };
}

describe('job-runner', () => {
  const mockRunStep = jest.spyOn(stepRunner, 'runStep');
  const pipeline: NormalizedPipeline = {
    name: 'Test',
    scope: ['directory'],
    jobs: {},
  };

  beforeEach(() => {
    mockRunStep.mockReset();
  });

  function createJob(partial?: Partial<NormalizedJob>): NormalizedJob {
    return {
      name: 'build',
      needs: [],
      timeout_minutes: 360,
      max_retries: 0,
      max_iterations: 0,
      continue_on_error: false,
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'second',
          run: 'second',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
      ...partial,
    };
  }

  function successResult(
    id: string,
    outputs: Record<string, string> = {},
    dynamicEnv: Record<string, string> = {},
    partial: Partial<StepResult> = {},
  ): StepResult {
    return {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { ...outputs, id },
      dynamic_env: dynamicEnv,
      started_at: partial.started_at,
      completed_at: partial.completed_at,
      exit_code: partial.exit_code,
      error: partial.error,
      log_file: partial.log_file,
      log_format_hint: partial.log_format_hint,
      agent_provider: partial.agent_provider,
      agent_model: partial.agent_model,
    };
  }

  function failureResult(partial: Partial<StepResult> = {}): StepResult {
    return {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      started_at: partial.started_at,
      completed_at: partial.completed_at,
      exit_code: partial.exit_code,
      error: partial.error,
      log_file: partial.log_file,
      log_format_hint: partial.log_format_hint,
      agent_provider: partial.agent_provider,
      agent_model: partial.agent_model,
    };
  }

  it('runs steps sequentially and supports conditional skip', async () => {
    const job = createJob({
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'second',
          if: "steps.first.outputs.flag == 'go'",
          run: 'second',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockResolvedValueOnce(successResult('first', { flag: 'go' }));
    mockRunStep.mockResolvedValueOnce(successResult('second'));

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(mockRunStep).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
  });

  it('passes only resources bound to the current logical step', async () => {
    const job = createJob();
    mockRunStep.mockResolvedValueOnce(successResult('first'));
    mockRunStep.mockResolvedValueOnce(successResult('second'));

    await runJob({
      executionId: 'exec-package',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
      pipelinePackageBindings: [
        { jobId: 'build', stepId: 'first', resourceIds: ['resource-1'] },
      ],
      pipelinePackageOverlay: {
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        resources: [
          {
            virtualSourceId: 'pipeline-package:resource-1',
            resourceId: 'resource-1',
            provider: 'claude',
            rootPath: '/package/resource-1',
            kind: 'standalone_skill',
            displayName: 'Resource 1',
            invocationKeys: [],
          },
          {
            virtualSourceId: 'pipeline-package:resource-2',
            resourceId: 'resource-2',
            provider: 'claude',
            rootPath: '/package/resource-2',
            kind: 'standalone_skill',
            displayName: 'Resource 2',
            invocationKeys: [],
          },
        ],
      },
    });

    expect(
      mockRunStep.mock.calls[0]?.[0].pipelinePackageOverlay?.resources,
    ).toEqual([expect.objectContaining({ resourceId: 'resource-1' })]);
    expect(
      mockRunStep.mock.calls[1]?.[0].pipelinePackageOverlay,
    ).toBeUndefined();
  });

  it('persists the running step log file before step completion', async () => {
    const job = createJob({
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    const jobResult = createJobResult(job);
    const snapshots: Array<{
      status: JobResult['status'];
      stepStatus: StepResult['status'];
      logFile: string | undefined;
      resolvedRun: string | undefined;
    }> = [];
    const saveState = jest.fn().mockImplementation(() => {
      snapshots.push({
        status: jobResult.status,
        stepStatus: jobResult.steps.first.status,
        logFile: jobResult.steps.first.log_file,
        resolvedRun: jobResult.steps.first.resolved_run,
      });
      return Promise.resolve();
    });
    mockRunStep.mockResolvedValueOnce(successResult('first'));

    await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult,
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState,
    });

    expect(saveState).toHaveBeenCalled();
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.status === 'running' &&
          snapshot.stepStatus === 'running' &&
          snapshot.logFile?.includes('build--first.log') === true &&
          snapshot.resolvedRun === 'first',
      ),
    ).toBe(true);
  });

  it('supports step and job continue_on_error', async () => {
    const stepContinueJob = createJob({
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: true,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'second',
          run: 'second',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockResolvedValueOnce({
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
    });
    mockRunStep.mockResolvedValueOnce(successResult('second'));

    const stepContinueResult = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job: stepContinueJob,
      jobResult: createJobResult(stepContinueJob),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(stepContinueResult.steps.first.conclusion).toBe('success');
    expect(stepContinueResult.steps.first.outcome).toBe('failure');

    mockRunStep.mockReset();
    const jobContinueJob = createJob({ continue_on_error: true });
    mockRunStep.mockResolvedValueOnce(successResult('first'));
    mockRunStep.mockResolvedValueOnce({
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
    });

    const jobContinueResult = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job: jobContinueJob,
      jobResult: createJobResult(jobContinueJob),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(jobContinueResult.status).toBe('failure');
    expect(jobContinueResult.outcome).toBe('failure');
    expect(jobContinueResult.conclusion).toBe('success');
  });

  it('exhausts retries before applying job continue_on_error', async () => {
    const attempts: number[] = [];
    const job = createJob({
      continue_on_error: true,
      max_retries: 2,
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockImplementation((options) => {
      attempts.push(options.attempt ?? -1);
      return Promise.resolve(failureResult());
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(attempts).toEqual([0, 1, 2]);
    expect(result.status).toBe('failure');
    expect(result.outcome).toBe('failure');
    expect(result.conclusion).toBe('success');
    expect(result.retry_count).toBe(2);
    expect(result.retry_history?.map((entry) => entry.attempt)).toEqual([0, 1]);
  });

  it('succeeds on retry even with continue_on_error set', async () => {
    const attempts: number[] = [];
    const job = createJob({
      continue_on_error: true,
      max_retries: 2,
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockImplementation((options) => {
      attempts.push(options.attempt ?? -1);
      if (options.attempt === 0) {
        return Promise.resolve(failureResult());
      }

      return Promise.resolve(successResult('first'));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(attempts).toEqual([0, 1]);
    expect(result.status).toBe('success');
    expect(result.outcome).toBe('success');
    expect(result.conclusion).toBe('success');
    expect(result.retry_count).toBe(1);
    expect(result.retry_history).toHaveLength(1);
    expect(result.retry_history?.[0]).toMatchObject({
      attempt: 0,
      conclusion: 'failure',
      outcome: 'failure',
    });
  });

  it('rehydrates prior step outputs and dynamic env when resuming', async () => {
    const job = createJob({
      outputs: {
        from_first: '${{ steps.first.outputs.value }}',
      },
    });
    const jobResult = createJobResult(job);
    jobResult.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { value: 'one' },
      dynamic_env: { VERSION: '1' },
    };
    mockRunStep.mockImplementation((options) => {
      expect(options.env.VERSION).toBe('1');
      return Promise.resolve(successResult('second'));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult,
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.outputs).toEqual({ from_first: 'one' });
    expect(result.status).toBe('success');
  });

  it('retries failed jobs from the first step and exposes retry context', async () => {
    const job = createJob({
      max_retries: 1,
      outputs: {
        retry: '${{ job.retry_count }}',
        retried: '${{ job.is_retry }}',
        max: '${{ job.max_retries }}',
      },
    });
    const callOrder: string[] = [];

    mockRunStep.mockImplementation((options) => {
      callOrder.push(`${options.step.id}:${options.attempt}`);

      if (options.attempt === 0) {
        expect(options.env.CANOPY_JOB_IS_RETRY).toBe('false');
        expect(options.env.CANOPY_JOB_RETRY_COUNT).toBe('0');
        expect(options.env.CANOPY_JOB_MAX_RETRIES).toBe('1');
        expect(options.env.CANOPY_JOB_ITERATION).toBe('1');
        expect(options.env.CANOPY_JOB_MAX_ITERATIONS).toBe('1');
        expect(options.jobContext).toEqual({
          is_retry: false,
          retry_count: 0,
          max_retries: 1,
        });

        return Promise.resolve({
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          outputs: {},
          dynamic_env: {},
        });
      }

      expect(options.env.CANOPY_JOB_IS_RETRY).toBe('true');
      expect(options.env.CANOPY_JOB_RETRY_COUNT).toBe('1');
      expect(options.env.CANOPY_JOB_MAX_RETRIES).toBe('1');
      expect(options.env.CANOPY_JOB_ITERATION).toBe('1');
      expect(options.env.CANOPY_JOB_MAX_ITERATIONS).toBe('1');
      expect(options.jobContext).toEqual({
        is_retry: true,
        retry_count: 1,
        max_retries: 1,
      });

      return Promise.resolve(successResult(options.step.id));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(callOrder).toEqual(['first:0', 'first:1', 'second:1']);
    expect(result.status).toBe('success');
    expect(result.retry_count).toBe(1);
    expect(result.retry_history).toHaveLength(1);
    expect(result.retry_history?.[0]).toMatchObject({
      attempt: 0,
      conclusion: 'failure',
      outcome: 'failure',
    });
    expect(result.retry_history?.[0].steps.first.outcome).toBe('failure');
    expect(result.outputs).toEqual({
      retry: '1',
      retried: 'true',
      max: '1',
    });
  });

  it('passes pipeline inputs into step expressions and runtime env', async () => {
    const job = createJob({
      outputs: {
        enabled: '${{ inputs.enabled }}',
      },
      steps: [
        {
          id: 'conditional',
          if: 'inputs.enabled',
          run: '${{ inputs.message }}',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep.mockImplementation((options) => {
      expect(options.step.run).toBe('hello');
      expect(options.env.INPUT_MESSAGE).toBe('hello');
      expect(options.env.INPUT_ENABLED).toBe('true');
      return Promise.resolve(successResult('conditional'));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {
        message: 'hello',
        enabled: true,
      },
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.outputs).toEqual({ enabled: 'true' });
  });

  it('restarts jobs without incrementing retry history when requested by a step', async () => {
    const job = createJob({
      max_iterations: 2,
      steps: [
        {
          id: 'pick',
          run: 'pick',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'finish',
          run: 'finish',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    const callOrder: string[] = [];

    mockRunStep.mockImplementation((options) => {
      callOrder.push(`${options.step.id}:${options.attempt}`);
      if (options.step.id === 'pick' && callOrder.length === 1) {
        return Promise.resolve(
          successResult(options.step.id, {
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          }),
        );
      }
      return Promise.resolve(successResult(options.step.id));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(callOrder).toEqual(['pick:0', 'pick:0', 'finish:0']);
    expect(result.status).toBe('success');
    expect(result.retry_count).toBe(0);
    expect(result.retry_history).toHaveLength(0);
    expect(result.iteration_count).toBe(2);
  });

  it('passes iteration env vars into step runtime for iterative jobs', async () => {
    const job = createJob({
      max_iterations: 2,
      steps: [
        {
          id: 'loop',
          run: 'loop',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    const seenIterations: string[] = [];

    mockRunStep.mockImplementation((options) => {
      seenIterations.push(
        `${options.env.CANOPY_JOB_ITERATION}/${options.env.CANOPY_JOB_MAX_ITERATIONS}`,
      );

      if (seenIterations.length === 1) {
        return Promise.resolve(
          successResult(options.step.id, {
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          }),
        );
      }

      return Promise.resolve(successResult(options.step.id));
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) =>
          `${repoPath}/.canopy/pipelines`,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(seenIterations).toEqual(['1/2', '2/2']);
  });

  it('populates iteration_history with step snapshots on each restart', async () => {
    const job = createJob({
      max_iterations: 3,
      steps: [
        {
          id: 'pick',
          run: 'pick',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep
      .mockResolvedValueOnce(
        successResult(
          'pick',
          {
            artifact: 'iter-1',
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T10:00:00.000Z',
            completed_at: '2026-03-26T10:00:01.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        successResult(
          'pick',
          {
            artifact: 'iter-2',
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T10:00:02.000Z',
            completed_at: '2026-03-26T10:00:03.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        successResult(
          'pick',
          { artifact: 'iter-3' },
          {},
          {
            started_at: '2026-03-26T10:00:04.000Z',
            completed_at: '2026-03-26T10:00:05.000Z',
          },
        ),
      );

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) =>
          `${repoPath}/.canopy/pipelines`,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(result.iteration_count).toBe(3);
    expect(result.iteration_history).toHaveLength(2);
    expect(result.iteration_history?.map((entry) => entry.iteration)).toEqual([
      1, 2,
    ]);
    expect(result.iteration_history?.[0].steps.pick.outputs).toEqual({
      artifact: 'iter-1',
      id: 'pick',
    });
    expect(result.iteration_history?.[1].steps.pick.outputs).toEqual({
      artifact: 'iter-2',
      id: 'pick',
    });
    expect(result.iteration_history?.[0].started_at).toBeTruthy();
    expect(result.iteration_history?.[0].completed_at).toBeTruthy();
    expect(result.iteration_history?.[1].started_at).toBeTruthy();
    expect(result.iteration_history?.[1].completed_at).toBeTruthy();
  });

  it('iteration_history entries have deep-cloned steps', async () => {
    const job = createJob({
      max_iterations: 2,
      steps: [
        {
          id: 'pick',
          run: 'pick',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep
      .mockResolvedValueOnce(
        successResult(
          'pick',
          {
            artifact: 'snapshot',
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          { VERSION: '1' },
          {
            started_at: '2026-03-26T11:00:00.000Z',
            completed_at: '2026-03-26T11:00:01.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        successResult(
          'pick',
          { artifact: 'final' },
          { VERSION: '2' },
          {
            started_at: '2026-03-26T11:00:02.000Z',
            completed_at: '2026-03-26T11:00:03.000Z',
          },
        ),
      );

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) =>
          `${repoPath}/.canopy/pipelines`,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    result.steps.pick.outputs.artifact = 'mutated';
    result.steps.pick.dynamic_env.VERSION = 'mutated';

    expect(result.iteration_history?.[0].steps.pick.outputs.artifact).toBe(
      'snapshot',
    );
    expect(result.iteration_history?.[0].steps.pick.dynamic_env.VERSION).toBe(
      '1',
    );
  });

  it('carries iteration_history into retry snapshots and resets for fresh retry', async () => {
    const job = createJob({
      max_retries: 1,
      max_iterations: 2,
      steps: [
        {
          id: 'pick',
          run: 'pick',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep
      .mockResolvedValueOnce(
        successResult(
          'pick',
          {
            artifact: 'iter-1',
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T12:00:00.000Z',
            completed_at: '2026-03-26T12:00:01.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        failureResult({
          started_at: '2026-03-26T12:00:02.000Z',
          completed_at: '2026-03-26T12:00:03.000Z',
        }),
      )
      .mockResolvedValueOnce(
        successResult(
          'pick',
          { artifact: 'retry-success' },
          {},
          {
            started_at: '2026-03-26T12:00:04.000Z',
            completed_at: '2026-03-26T12:00:05.000Z',
          },
        ),
      );

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) =>
          `${repoPath}/.canopy/pipelines`,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(result.retry_history).toHaveLength(1);
    expect(result.retry_history?.[0].iteration_history).toHaveLength(1);
    expect(result.retry_history?.[0].iteration_history?.[0].iteration).toBe(1);
    expect(
      result.retry_history?.[0].iteration_history?.[0].steps.pick.outputs,
    ).toEqual({
      artifact: 'iter-1',
      id: 'pick',
    });
    expect(result.iteration_history).toBeUndefined();
    expect(result.iteration_count).toBe(1);
  });

  it('ignores restart requests at max_iterations after a retry', async () => {
    const job = createJob({
      max_retries: 1,
      max_iterations: 2,
      steps: [
        {
          id: 'loop',
          run: 'loop',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep
      .mockResolvedValueOnce(
        failureResult({
          started_at: '2026-03-26T12:30:00.000Z',
          completed_at: '2026-03-26T12:30:01.000Z',
        }),
      )
      .mockResolvedValueOnce(
        successResult(
          'loop',
          {
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T12:30:02.000Z',
            completed_at: '2026-03-26T12:30:03.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        successResult(
          'loop',
          {
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T12:30:04.000Z',
            completed_at: '2026-03-26T12:30:05.000Z',
          },
        ),
      )
      .mockResolvedValueOnce(
        successResult(
          'loop',
          {
            [JOB_RESTART_OUTPUT_KEY]: 'true',
          },
          {},
          {
            started_at: '2026-03-26T12:30:06.000Z',
            completed_at: '2026-03-26T12:30:07.000Z',
          },
        ),
      );

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) =>
          `${repoPath}/.canopy/pipelines`,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(result.conclusion).toBe('success');
    expect(result.retry_history).toHaveLength(1);
    expect(result.retry_history?.[0].attempt).toBe(0);
    expect(result.iteration_count).toBe(2);
    expect(result.iteration_history).toHaveLength(1);
    expect(result.steps.loop.error).toBeUndefined();
    expect(result.steps.loop.outputs).toEqual({ id: 'loop' });
    expect(mockRunStep).toHaveBeenCalledTimes(3);
  });

  it('ignores restart requests once max_iterations is reached', async () => {
    const job = createJob({
      max_iterations: 2,
      steps: [
        {
          id: 'loop',
          run: 'loop',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });

    mockRunStep.mockImplementation(() =>
      Promise.resolve({
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        outputs: {
          [JOB_RESTART_OUTPUT_KEY]: 'true',
        },
        dynamic_env: {},
      }),
    );

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(result.conclusion).toBe('success');
    expect(result.iteration_count).toBe(2);
    expect(result.iteration_history).toHaveLength(1);
    expect(result.steps.loop.error).toBeUndefined();
    expect(result.steps.loop.outputs).toEqual({});
  });

  it('marks a job paused and leaves later steps pending', async () => {
    const job = createJob();
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        artifact: 'dist/app.js',
        [PAUSE_OUTPUT_KEY]: 'true',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('paused');
    expect(result.steps.first.outputs).toEqual({ artifact: 'dist/app.js' });
    expect(result.steps.second.status).toBe('pending');
    expect(mockRunStep).toHaveBeenCalledTimes(1);
  });

  it('captures an input request on the paused step and strips reserved keys', async () => {
    const job = createJob();
    const request = {
      message: 'Edit answers',
      fields: [{ key: 'scope', label: 'Scope', type: 'string' }],
    };
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        artifact: 'dist/app.js',
        [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify(request),
        [PAUSE_OUTPUT_KEY]: 'true',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('paused');
    expect(result.steps.first.input_request).toEqual(request);
    expect(result.steps.first.outputs).toEqual({ artifact: 'dist/app.js' });
    expect(
      result.steps.first.outputs[INPUT_REQUEST_OUTPUT_KEY],
    ).toBeUndefined();
    expect(result.steps.first.outputs[PAUSE_OUTPUT_KEY]).toBeUndefined();
  });

  it('fails malformed input requests instead of pausing formlessly', async () => {
    const job = createJob();
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        [INPUT_REQUEST_OUTPUT_KEY]: '{"fields":"nope"}',
        [PAUSE_OUTPUT_KEY]: 'true',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('failure');
    expect(result.steps.first.status).toBe('failure');
    expect(result.steps.first.error).toBe(
      'request-input metadata failed validation',
    );
    expect(result.steps.first.input_request).toBeUndefined();
    expect(result.steps.first.outputs).toEqual({});
  });

  it('captures report outputs on a successful step and strips reserved keys', async () => {
    const job = createJob({
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        artifact: 'dist/app.js',
        [REPORT_OUTPUT_KEY]: '/tmp/report.md',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.steps.first.outputs).toEqual({ artifact: 'dist/app.js' });
    expect(result.steps.first.report_outputs).toEqual({
      report_file: '/tmp/report.md',
    });
    expect(result.report_outputs).toEqual({
      report_file: '/tmp/report.md',
    });
  });

  it('captures report outputs before pausing the job', async () => {
    const job = createJob({
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        artifact: 'dist/app.js',
        [REPORT_OUTPUT_KEY]: '/tmp/report.md',
        [PAUSE_OUTPUT_KEY]: 'true',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('paused');
    expect(result.steps.first.outputs).toEqual({ artifact: 'dist/app.js' });
    expect(result.steps.first.report_outputs).toEqual({
      report_file: '/tmp/report.md',
    });
    expect(result.report_outputs).toEqual({
      report_file: '/tmp/report.md',
    });
  });

  it('strips the pause control output before saving state', async () => {
    const job = createJob();
    const snapshots: JobResult[] = [];
    const jobResult = createJobResult(job);
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        artifact: 'dist/app.js',
        [PAUSE_OUTPUT_KEY]: '1',
      },
      dynamic_env: { VERSION: '1.2.3' },
    });

    await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult,
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockImplementation(() => {
        snapshots.push(JSON.parse(JSON.stringify(jobResult)) as JobResult);
        return Promise.resolve();
      }),
    });

    expect(snapshots).not.toHaveLength(0);
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.steps.first.outputs[PAUSE_OUTPUT_KEY] !== undefined,
      ),
    ).toBe(false);
    expect(snapshots[snapshots.length - 1]?.steps.first.outputs).toEqual({
      artifact: 'dist/app.js',
    });
  });

  it('does not create retry history for an intentional pause', async () => {
    const job = createJob({ max_retries: 2 });
    mockRunStep.mockResolvedValueOnce({
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {
        [PAUSE_OUTPUT_KEY]: 'true',
      },
      dynamic_env: {},
    });

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('paused');
    expect(result.retry_count).toBe(0);
    expect(result.retry_history).toEqual([]);
    expect(mockRunStep).toHaveBeenCalledTimes(1);
  });

  it('clears stale report outputs when a job restarts', async () => {
    const job = createJob({
      max_iterations: 2,
      steps: [
        {
          id: 'first',
          run: 'first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'second',
          run: 'second',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    });
    mockRunStep
      .mockResolvedValueOnce({
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        outputs: {
          [REPORT_OUTPUT_KEY]: '/tmp/stale-report.md',
          [JOB_RESTART_OUTPUT_KEY]: 'true',
        },
        dynamic_env: {},
      })
      .mockResolvedValueOnce(successResult('first'))
      .mockResolvedValueOnce(successResult('second'));

    const result = await runJob({
      executionId: 'exec-1',
      jobId: 'build',
      pipeline,
      job,
      jobResult: createJobResult(job),
      cwd: process.cwd(),
      env: {},
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: process.cwd(),
        tempRootDir: process.cwd(),
        bundledActionsDir: process.cwd(),
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      },
      needs: {},
      inputs: {},
      signal: new AbortController().signal,
      saveState: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('success');
    expect(result.report_outputs).toBeUndefined();
  });
});
