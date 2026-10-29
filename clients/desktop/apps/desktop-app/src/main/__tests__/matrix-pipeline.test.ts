jest.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executePipeline,
  prepareMatrixJobRetryState,
  prepareMatrixVariantCancellation,
  prepareRetryState,
  retryMatrixJobExecution,
  resumePipeline,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/types';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

describe('matrix pipeline execution', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-matrix-'));
    runtime = createRuntime(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs static variants as physical jobs and merges outputs by index', async () => {
    const handle = await executePipeline(
      {
        name: 'Static matrix',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { value: ['first', 'second'] } },
            env: { VALUE: '${{ matrix.value }}' },
            outputs: { value: '${{ steps.emit.outputs.value }}' },
            steps: [
              {
                id: 'emit',
                shell: 'node',
                run: "import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, `value=${process.env.VALUE}\\n`, 'utf8');",
              },
            ],
          },
          consume: {
            needs: 'build',
            env: {
              VALUE: '${{ needs.build.outputs.value }}',
              CHILDREN: '${{ toJson(needs.build.children) }}',
            },
            steps: [
              {
                id: 'check',
                shell: 'node',
                run: "const children = JSON.parse(process.env.CHILDREN); if (process.env.VALUE !== 'second' || children.length !== 2 || children[0].matrix.value !== 'first' || children[1].outputs.value !== 'second') process.exit(9)",
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'static-matrix',
        executionId: 'static-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.version).toBe(10);
    expect(state.job_groups.build.variant_job_ids).toEqual([
      '__matrix__build__0',
      '__matrix__build__1',
    ]);
    expect(state.jobs.__matrix__build__0.outputs.value).toBe('first');
    expect(state.jobs.__matrix__build__1.outputs.value).toBe('second');
    expect(state.jobs.consume.status).toBe('success');
  });

  it('expands dynamic matrices from dependency outputs', async () => {
    const handle = await executePipeline(
      {
        name: 'Dynamic matrix',
        on: 'dispatch',
        jobs: {
          prepare: {
            outputs: { matrix: '${{ steps.emit.outputs.matrix }}' },
            steps: [
              {
                id: 'emit',
                shell: 'node',
                run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'matrix={"target":["one","two"]}\\n', 'utf8');`,
              },
            ],
          },
          build: {
            needs: 'prepare',
            strategy: {
              matrix: '${{ parseJson(needs.prepare.outputs.matrix) }}',
            },
            steps: [{ id: 'run', run: 'echo ${{ matrix.target }}' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'dynamic-matrix',
        executionId: 'dynamic-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.job_groups.build.expansion).toBe('expanded');
    expect(state.job_groups.build.variant_job_ids).toHaveLength(2);
  });

  it('combines dynamic axes, include, and exclude fields atomically', async () => {
    const handle = await executePipeline(
      {
        name: 'Dynamic matrix fields',
        on: 'dispatch',
        jobs: {
          prepare: {
            outputs: {
              targets: '${{ steps.emit.outputs.targets }}',
              additions: '${{ steps.emit.outputs.additions }}',
              exclusions: '${{ steps.emit.outputs.exclusions }}',
            },
            steps: [
              {
                id: 'emit',
                shell: 'node',
                run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'targets=["one","two"]\\nadditions=[{"target":"three","flavor":"extra"}]\\nexclusions=[{"target":"two"}]\\n', 'utf8');`,
              },
            ],
          },
          build: {
            needs: 'prepare',
            strategy: {
              matrix: {
                target: '${{ parseJson(needs.prepare.outputs.targets) }}',
                flavor: ['base'],
                include: '${{ parseJson(needs.prepare.outputs.additions) }}',
                exclude: '${{ parseJson(needs.prepare.outputs.exclusions) }}',
              },
            },
            steps: [{ id: 'run', run: 'echo ${{ matrix.target }}' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'dynamic-matrix-fields',
        executionId: 'dynamic-matrix-fields-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.job_groups.build.variant_job_ids).toEqual([
      '__matrix__build__0',
      '__matrix__build__1',
    ]);
    expect(state.job_definitions.__matrix__build__0.matrix?.values).toEqual({
      target: 'one',
      flavor: 'base',
    });
    expect(state.job_definitions.__matrix__build__1.matrix?.values).toEqual({
      target: 'three',
      flavor: 'extra',
    });
  });

  it('fails an invalid dynamic expansion without persisting partial variants', async () => {
    const handle = await executePipeline(
      {
        name: 'Invalid dynamic matrix',
        on: 'dispatch',
        jobs: {
          prepare: {
            outputs: { targets: '${{ steps.emit.outputs.targets }}' },
            steps: [
              {
                id: 'emit',
                shell: 'node',
                run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'targets={"not":"an array"}\\n', 'utf8');`,
              },
            ],
          },
          build: {
            needs: 'prepare',
            strategy: {
              matrix: {
                target: '${{ parseJson(needs.prepare.outputs.targets) }}',
              },
            },
            steps: [{ run: 'echo unreachable' }],
          },
          cleanup: {
            needs: 'build',
            if: 'always()',
            steps: [{ run: 'echo cleanup' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'invalid-dynamic-matrix',
        executionId: 'invalid-dynamic-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('failure');
    expect(state.job_groups.build).toMatchObject({
      expansion: 'failure',
      status: 'failure',
      variant_job_ids: [],
    });
    expect(state.job_groups.build.error).toContain(
      'strategy.matrix.target must be an array',
    );
    expect(state.jobs.cleanup.status).toBe('success');

    const retried = prepareRetryState(state);
    expect(retried.job_groups.build).toMatchObject({
      expansion: 'pending',
      status: 'pending',
      variant_job_ids: [],
    });
    expect(retried.job_groups.build.error).toBeUndefined();
    expect(retried.jobs.cleanup.status).toBe('pending');
  });

  it('skips dynamic expansion when a dependency has failed', async () => {
    const handle = await executePipeline(
      {
        name: 'Skipped dynamic matrix',
        on: 'dispatch',
        jobs: {
          prepare: {
            steps: [{ id: 'fail', run: 'exit 1' }],
          },
          build: {
            needs: 'prepare',
            strategy: {
              matrix: '${{ parseJson(needs.prepare.outputs.matrix) }}',
            },
            steps: [{ run: 'echo unreachable' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'skipped-dynamic-matrix',
        executionId: 'skipped-dynamic-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('failure');
    expect(state.job_groups.build).toMatchObject({
      expansion: 'pending',
      status: 'skipped',
      variant_job_ids: [],
    });
    expect(state.job_groups.build.error).toBeUndefined();
  });

  it('skips dynamic expansion when a non-matrix condition is false', async () => {
    const handle = await executePipeline(
      {
        name: 'Conditionally skipped dynamic matrix',
        on: 'dispatch',
        jobs: {
          build: {
            if: 'false',
            strategy: {
              matrix: '${{ parseJson(inputs.missing) }}',
            },
            steps: [{ run: 'echo unreachable' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'condition-skipped-dynamic-matrix',
        executionId: 'condition-skipped-dynamic-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.job_groups.build).toMatchObject({
      expansion: 'pending',
      status: 'skipped',
      variant_job_ids: [],
    });
    expect(state.job_groups.build.error).toBeUndefined();
  });

  it('ignores quoted physical-context words before dynamic expansion', async () => {
    const handle = await executePipeline(
      {
        name: 'Quoted condition dynamic matrix',
        on: {
          dispatch: {
            inputs: {
              mode: { type: 'string', default: 'matrix' },
              label: { type: 'string', default: 'job' },
            },
          },
        },
        jobs: {
          build: {
            if: 'inputs.mode != \'matrix\' && inputs.label != "job"',
            strategy: {
              matrix: '${{ parseJson(inputs.missing) }}',
            },
            steps: [{ run: 'echo unreachable' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'quoted-condition-dynamic-matrix',
        executionId: 'quoted-condition-dynamic-matrix-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.job_groups.build).toMatchObject({
      expansion: 'pending',
      status: 'skipped',
      variant_job_ids: [],
    });
    expect(state.job_groups.build.error).toBeUndefined();
  });

  it('reopens physical matrix variants and downstream jobs for whole-run retry', async () => {
    const handle = await executePipeline(
      {
        name: 'Matrix retry cone',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { result: ['pass', 'fail'] } },
            env: { RESULT: '${{ matrix.result }}' },
            steps: [
              {
                shell: 'node',
                run: "if (process.env.RESULT === 'fail') process.exit(1)",
              },
            ],
          },
          deploy: {
            needs: 'build',
            steps: [{ run: 'echo deploy' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'matrix-retry-cone',
        executionId: 'matrix-retry-cone-execution',
        runtime,
      },
    );
    const failed = await handle.waitForCompletion();
    expect(failed.status).toBe('failure');
    expect(failed.jobs.deploy.status).toBe('skipped');

    const retried = prepareRetryState(failed);

    expect(retried.jobs.__matrix__build__0.status).toBe('pending');
    expect(retried.jobs.__matrix__build__1.status).toBe('pending');
    expect(retried.jobs.deploy.status).toBe('pending');
    expect(retried.job_groups.build.status).toBe('pending');
    expect(retried.job_groups.deploy.status).toBe('pending');
  });

  it('allows multiple paused variants and resumes them atomically', async () => {
    const request = JSON.stringify({
      title: 'Approve',
      fields: [
        {
          key: 'decision',
          label: 'Decision',
          type: 'choice',
          options: ['yes'],
        },
      ],
    });
    const handle = await executePipeline(
      {
        name: 'Parallel pauses',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { item: ['one', 'two'] },
              max_parallel: 1,
              fail_fast: false,
            },
            steps: [
              {
                id: 'approval',
                shell: 'node',
                run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'CANOPY_INPUT_REQUEST=${request}\\nCANOPY_PAUSE=true\\n', 'utf8');`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'parallel-pauses',
        executionId: 'parallel-pauses-execution',
        runtime,
      },
    );
    const paused = await handle.waitForCompletion();
    if (paused.status !== 'paused') {
      throw new Error(
        paused.error ??
          JSON.stringify({ jobs: paused.jobs, groups: paused.job_groups }),
      );
    }
    expect(paused.status).toBe('paused');
    expect(paused.pending_pauses).toHaveLength(2);

    const resumed = await resumePipeline('parallel-pauses-execution', {
      cwd: tempDir,
      runtime,
      pauseResponses: paused.pending_pauses.map((checkpoint) => ({
        checkpoint_id: checkpoint.id,
        job_id: checkpoint.job_id,
        step_id: checkpoint.step_id,
        answers: { decision: 'yes' },
      })),
    });
    const completed = await resumed.waitForCompletion();
    expect(completed.status).toBe('success');
    expect(completed.pending_pauses).toEqual([]);
  });

  it('enforces max_parallel and fail_fast within one matrix group', async () => {
    const handle = await executePipeline(
      {
        name: 'Matrix controls',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: {
              matrix: { variant: ['fail', 'slow', 'queued'] },
              max_parallel: 2,
              fail_fast: true,
            },
            env: { VARIANT: '${{ matrix.variant }}' },
            steps: [
              {
                id: 'run',
                shell: 'node',
                run: `const delay = process.env.VARIANT === 'fail' ? 25 : 2_000; await new Promise((resolve) => setTimeout(resolve, delay)); if (process.env.VARIANT === 'fail') process.exit(7);`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'matrix-controls',
        executionId: 'matrix-controls-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('failure');
    expect(state.jobs.__matrix__build__0.status).toBe('failure');
    expect(state.jobs.__matrix__build__1.status).toBe('cancelled');
    expect(state.jobs.__matrix__build__2.status).toBe('cancelled');
  });

  it('keeps a matrix failure visible while continue_on_error prevents fail-fast', async () => {
    const handle = await executePipeline(
      {
        name: 'Matrix continue on error',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: {
              matrix: { variant: ['allowed_failure', 'pass'] },
              fail_fast: true,
            },
            continue_on_error: '${{ matrix.variant == "allowed_failure" }}',
            env: { VARIANT: '${{ matrix.variant }}' },
            steps: [
              {
                id: 'run',
                shell: 'node',
                run: `if (process.env.VARIANT === 'allowed_failure') process.exit(7)`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'matrix-continue-on-error',
        executionId: 'matrix-continue-on-error-execution',
        runtime,
      },
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.jobs.__matrix__build__0).toMatchObject({
      status: 'failure',
      outcome: 'failure',
      conclusion: 'success',
    });
    expect(state.jobs.__matrix__build__1.status).toBe('success');
    expect(state.job_groups.build).toMatchObject({
      status: 'failure',
      outcome: 'failure',
      conclusion: 'success',
    });
  });

  it('retries failed variants without resetting successful siblings', async () => {
    const handle = await executePipeline(
      {
        name: 'Targeted matrix retry',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: {
              matrix: { value: ['pass', 'fail'] },
              fail_fast: false,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'check',
                shell: 'node',
                run: "if (process.env.VALUE === 'fail') process.exit(4)",
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'targeted-matrix-retry',
        executionId: 'targeted-matrix-retry-execution',
        runtime,
      },
    );
    const failed = await handle.waitForCompletion();
    const prepared = prepareMatrixJobRetryState(failed, {
      executionId: failed.id,
      jobId: 'build',
      mode: 'failed',
    });
    expect(prepared.status).toBe('pending');
    expect(prepared.jobs.__matrix__build__0.status).toBe('success');
    expect(prepared.jobs.__matrix__build__1).toMatchObject({
      status: 'pending',
      retry_count: 1,
      steps: { check: { status: 'pending' } },
    });
    expect(failed.job_definitions.__matrix__build__1.env.VALUE).toBe('fail');
    expect(prepared.job_definitions.__matrix__build__1.env.VALUE).toBe(
      '${{ matrix.value }}',
    );
  });

  it('rejects expansion retry for migrated groups without a dynamic strategy', async () => {
    const handle = await executePipeline(
      {
        name: 'Legacy expansion retry',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { value: ['one'] } },
            steps: [{ run: 'exit 1' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'legacy-expansion-retry',
        executionId: 'legacy-expansion-retry-execution',
        runtime,
      },
    );
    const legacy = structuredClone(await handle.waitForCompletion());
    delete legacy.pipeline_snapshot.jobs.build.strategy;
    legacy.job_groups.build.expansion = 'failure';
    legacy.job_groups.build.error = 'Legacy foreach expansion failed';

    expect(() =>
      prepareMatrixJobRetryState(legacy, {
        executionId: legacy.id,
        jobId: 'build',
        mode: 'expansion',
      }),
    ).toThrow('does not have a dynamic matrix expansion to retry');
  });

  it('fails a migrated pending expansion instead of spinning during retry', async () => {
    const handle = await executePipeline(
      {
        name: 'Migrated pending matrix',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { value: ['one'] } },
            steps: [{ run: 'exit 1' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'migrated-pending-matrix',
        executionId: 'migrated-pending-matrix-execution',
        runtime,
      },
    );
    const legacy = structuredClone(await handle.waitForCompletion());
    delete legacy.pipeline_snapshot.jobs.build.strategy;
    legacy.job_groups.build.expansion = 'pending';
    legacy.job_groups.build.status = 'failure';
    legacy.job_groups.build.outcome = 'failure';
    legacy.job_groups.build.conclusion = 'failure';
    legacy.job_groups.build.error = 'Legacy foreach expansion failed';
    await saveExecutionState(legacy, runtime.executionsDir);

    const retry = await retryMatrixJobExecution(
      {
        executionId: legacy.id,
        jobId: 'build',
        mode: 'all',
      },
      { cwd: tempDir, runtime },
    );
    const completed = await retry.waitForCompletion();

    expect(completed.status).toBe('failure');
    expect(completed.job_groups.build).toMatchObject({
      expansion: 'failure',
      status: 'failure',
    });
    expect(completed.job_groups.build.error).toContain(
      'has no dynamic matrix strategy',
    );
  });

  it('does not run a matrix variant cancelled while waiting for a slot', async () => {
    const cancelledMarkerPath = path.join(tempDir, 'cancelled-variant-ran');
    const laterMarkerPath = path.join(tempDir, 'later-variant-ran');
    let resolveQueuedState: (state: ExecutionState) => void = () => undefined;
    const queuedState = new Promise<ExecutionState>((resolve) => {
      resolveQueuedState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Cancel queued matrix variant',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['running', 'cancelled', 'later'] },
              max_parallel: 1,
              fail_fast: false,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                run: `if [ "$VALUE" = running ]; then sleep 0.5; elif [ "$VALUE" = cancelled ]; then touch "${cancelledMarkerPath}"; else touch "${laterMarkerPath}"; fi`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'cancel-queued-matrix-variant',
        executionId: 'cancel-queued-matrix-variant-execution',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'running' &&
            event.state.jobs.__matrix__review__1?.status === 'pending' &&
            event.state.jobs.__matrix__review__2?.status === 'pending'
          ) {
            resolveQueuedState(event.state);
          }
        },
      },
    );
    await queuedState;
    if (!handle.cancelMatrixVariant) {
      throw new Error('Expected live matrix cancellation support');
    }
    await handle.cancelMatrixVariant('review', '__matrix__review__1');
    const completed = await handle.waitForCompletion();

    expect(completed.jobs.__matrix__review__1.status).toBe('cancelled');
    expect(completed.jobs.__matrix__review__2.status).toBe('success');
    expect(fs.existsSync(cancelledMarkerPath)).toBe(false);
    expect(fs.existsSync(laterMarkerPath)).toBe(true);
  });

  it('keeps live matrix resumes within max_parallel', async () => {
    const lockPath = path.join(tempDir, 'matrix-concurrency.lock');
    let resolveConcurrentState: (state: ExecutionState) => void = () =>
      undefined;
    const concurrentState = new Promise<ExecutionState>((resolve) => {
      resolveConcurrentState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Live matrix max parallel',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['first', 'second'] },
              max_parallel: 1,
              fail_fast: false,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'pause_or_hold',
                run: `if [ "$VALUE" = first ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; else touch "${lockPath}"; sleep 0.5; rm "${lockPath}"; fi`,
              },
              {
                id: 'verify_bound',
                run: `test ! -e "${lockPath}"`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'live-matrix-max-parallel',
        executionId: 'live-matrix-max-parallel-execution',
        initiationSource: 'user',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'paused' &&
            event.state.jobs.__matrix__review__1?.status === 'running'
          ) {
            resolveConcurrentState(event.state);
          }
        },
      },
    );
    const running = await concurrentState;
    const reasonId = running.status_reasons.find(
      (reason) => reason.source.job_id === '__matrix__review__0',
    )?.id;
    if (!reasonId || !handle.resumePaused) {
      throw new Error('Expected a live matrix pause reason');
    }
    await expect(
      handle.resumePaused(['123e4567-e89b-42d3-a456-426614174099']),
    ).rejects.toThrow('is stale or does not belong to execution');
    await handle.resumePaused([reasonId], undefined, 'automation');
    const completed = await handle.waitForCompletion();
    expect(completed.status).toBe('success');
    expect(completed.initiation_source).toBe('automation');
    expect(completed.jobs.__matrix__review__0.status).toBe('success');
    expect(completed.jobs.__matrix__review__1.status).toBe('success');
  });

  it('rejects a live input-required resume without matching answers', async () => {
    let resolveConcurrentState: (state: ExecutionState) => void = () =>
      undefined;
    const concurrentState = new Promise<ExecutionState>((resolve) => {
      resolveConcurrentState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Live matrix input validation',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['input', 'slow'] },
              max_parallel: 2,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'pause_or_hold',
                run: [
                  'if [ "$VALUE" = input ]; then',
                  `  printf '%s\n' 'CANOPY_INPUT_REQUEST={"fields":[{"key":"scope","label":"Scope","type":"string","required":true}]}' >> "$CANOPY_OUTPUT"`,
                  '  echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
                  'else',
                  '  sleep 0.5',
                  'fi',
                ].join('\n'),
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'live-matrix-input-validation',
        executionId: 'live-matrix-input-validation-execution',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'paused' &&
            event.state.jobs.__matrix__review__1?.status === 'running'
          ) {
            resolveConcurrentState(event.state);
          }
        },
      },
    );
    const running = await concurrentState;
    const inputReason = running.status_reasons.find(
      (reason) => reason.kind === 'input_required',
    );
    const checkpoint = running.pending_pauses.find(
      (candidate) => candidate.kind === 'input',
    );
    if (!inputReason || !checkpoint || !handle.resumePaused) {
      throw new Error('Expected a live input checkpoint');
    }

    await expect(handle.resumePaused([inputReason.id])).rejects.toThrow(
      'execution is waiting for input answers',
    );
    expect(handle.getState().jobs[checkpoint.job_id].status).toBe('paused');

    await handle.resumePaused(
      [inputReason.id],
      [
        {
          checkpoint_id: checkpoint.id,
          job_id: checkpoint.job_id,
          step_id: checkpoint.step_id,
          answers: { scope: 'desktop' },
        },
      ],
    );
    expect((await handle.waitForCompletion()).status).toBe('success');
  });

  it('applies fail-fast when a paused matrix variant fails after live resume', async () => {
    let resolvePausedState: (state: ExecutionState) => void = () => undefined;
    const pausedWithSibling = new Promise<ExecutionState>((resolve) => {
      resolvePausedState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Live matrix fail fast',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['fail', 'slow', 'queued'] },
              max_parallel: 3,
              fail_fast: true,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'pause_or_hold',
                run: 'if [ "$VALUE" = fail ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; else sleep 5; fi',
              },
              {
                id: 'fail_after_resume',
                run: 'if [ "$VALUE" = fail ]; then exit 7; fi',
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'live-matrix-fail-fast',
        executionId: 'live-matrix-fail-fast-execution',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'paused' &&
            event.state.jobs.__matrix__review__1?.status === 'running'
          ) {
            resolvePausedState(event.state);
          }
        },
      },
    );
    const running = await pausedWithSibling;
    const reasonId = running.status_reasons.find(
      (reason) => reason.source.job_id === '__matrix__review__0',
    )?.id;
    if (!reasonId || !handle.resumePaused) {
      throw new Error('Expected a live matrix pause reason');
    }
    await handle.resumePaused([reasonId]);
    const completed = await handle.waitForCompletion();
    expect(completed.status).toBe('failure');
    expect(completed.jobs.__matrix__review__0.status).toBe('failure');
    expect(completed.jobs.__matrix__review__1.status).toBe('cancelled');
    expect(completed.jobs.__matrix__review__2.status).toBe('cancelled');
  }, 10_000);

  it('does not resume a matrix variant cancelled by fail-fast', async () => {
    const handle = await executePipeline(
      {
        name: 'Fail fast clears cancelled pause metadata',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['fail', 'pause'] },
              max_parallel: 2,
              fail_fast: true,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'fail_or_pause',
                run: 'if [ "$VALUE" = pause ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; else sleep 0.3; exit 7; fi',
              },
            ],
          },
          hold: {
            steps: [
              {
                id: 'pause',
                run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'fail-fast-clears-cancelled-pause',
        executionId: 'fail-fast-clears-cancelled-pause-execution',
        runtime,
      },
    );
    const paused = await handle.waitForCompletion();
    const cancelledVariantId = '__matrix__review__1';
    const holdReason = paused.status_reasons.find(
      (reason) => reason.source.job_id === 'hold',
    );
    if (paused.status !== 'paused' || !holdReason) {
      throw new Error(
        paused.error ??
          JSON.stringify({
            status: paused.status,
            reasons: paused.status_reasons,
          }),
      );
    }

    expect(paused.jobs[cancelledVariantId].status).toBe('cancelled');
    expect(
      paused.pending_pauses.some(
        (checkpoint) => checkpoint.job_id === cancelledVariantId,
      ),
    ).toBe(false);
    expect(
      paused.status_reasons.some(
        (reason) => reason.source.job_id === cancelledVariantId,
      ),
    ).toBe(false);
    expect(
      paused.jobs[cancelledVariantId].steps.fail_or_pause.pause_requested,
    ).toBeUndefined();

    const resumed = await resumePipeline(paused.id, {
      cwd: tempDir,
      runtime,
      statusReasonIds: [holdReason.id],
    });
    const completed = await resumed.waitForCompletion();
    expect(completed.status).toBe('failure');
    expect(completed.jobs[cancelledVariantId].status).toBe('cancelled');
  });

  it('aborts and settles sibling variants before reporting a worker error', async () => {
    const markerPath = path.join(tempDir, 'late-sibling-output.txt');
    const handle = await executePipeline(
      {
        name: 'Settle matrix worker errors',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { behavior: [false, 'invalid'] },
              max_parallel: 2,
            },
            continue_on_error: '${{ matrix.behavior }}',
            steps: [
              {
                id: 'slow',
                shell: 'node',
                run: `import fs from 'node:fs'; await new Promise((resolve) => setTimeout(resolve, 800)); fs.writeFileSync(${JSON.stringify(markerPath)}, 'finished', 'utf8');`,
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'settle-matrix-worker-errors',
        executionId: 'settle-matrix-worker-errors-execution',
        runtime,
      },
    );

    await expect(handle.waitForCompletion()).rejects.toThrow(
      'continue_on_error must resolve to a boolean',
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('cancels cleanly while a live matrix resume waits for a slot', async () => {
    let resolveConcurrentState: (state: ExecutionState) => void = () =>
      undefined;
    const concurrentState = new Promise<ExecutionState>((resolve) => {
      resolveConcurrentState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Cancel live matrix slot waiter',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['first', 'second'] },
              max_parallel: 1,
              fail_fast: false,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'pause_or_hold',
                run: 'if [ "$VALUE" = first ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; else sleep 5; fi',
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'cancel-live-matrix-slot-waiter',
        executionId: 'cancel-live-matrix-slot-waiter-execution',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'paused' &&
            event.state.jobs.__matrix__review__1?.status === 'running'
          ) {
            resolveConcurrentState(event.state);
          }
        },
      },
    );
    const running = await concurrentState;
    const reasonId = running.status_reasons.find(
      (reason) => reason.source.job_id === '__matrix__review__0',
    )?.id;
    if (!reasonId || !handle.resumePaused) {
      throw new Error('Expected a live matrix pause reason');
    }
    await handle.resumePaused([reasonId]);

    const cancelled = await handle.cancel();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.pending_pauses).toEqual([]);
    expect(cancelled.status_reasons).toEqual([]);
    expect(cancelled.jobs.__matrix__review__0.status).toBe('cancelled');
    expect(cancelled.jobs.__matrix__review__1.status).toBe('cancelled');
    expect(cancelled.job_groups.review.status).toBe('cancelled');
  });

  it('clears live matrix variant status reasons when cancelling', async () => {
    let resolveConcurrentState: (state: ExecutionState) => void = () =>
      undefined;
    const concurrentState = new Promise<ExecutionState>((resolve) => {
      resolveConcurrentState = resolve;
    });
    const handle = await executePipeline(
      {
        name: 'Live matrix cancellation',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['first', 'second'] },
              max_parallel: 2,
              fail_fast: false,
            },
            env: { VALUE: '${{ matrix.value }}' },
            steps: [
              {
                id: 'pause_or_hold',
                run: 'if [ "$VALUE" = first ]; then echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"; else sleep 0.5; fi',
              },
            ],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'live-matrix-cancellation',
        executionId: 'live-matrix-cancellation-execution',
        runtime,
        onEvent: (event) => {
          if (
            event.state.jobs.__matrix__review__0?.status === 'paused' &&
            event.state.jobs.__matrix__review__1?.status === 'running'
          ) {
            resolveConcurrentState(event.state);
          }
        },
      },
    );
    await concurrentState;
    if (!handle.cancelMatrixVariant) {
      throw new Error('Expected live matrix cancellation support');
    }
    const cancelled = await handle.cancelMatrixVariant(
      'review',
      '__matrix__review__0',
    );
    expect(
      cancelled.status_reasons.some(
        (reason) => reason.source.job_id === '__matrix__review__0',
      ),
    ).toBe(false);
    expect(
      cancelled.pending_pauses.some(
        (checkpoint) => checkpoint.job_id === '__matrix__review__0',
      ),
    ).toBe(false);
    await handle.waitForCompletion();
  });

  it('cancels one paused variant without clearing sibling checkpoints', async () => {
    const pauseStep = {
      id: 'approval',
      shell: 'node' as const,
      run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'CANOPY_PAUSE=true\\n', 'utf8');`,
    };
    const handle = await executePipeline(
      {
        name: 'Targeted matrix cancellation',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: {
              matrix: { value: ['first', 'second'] },
              fail_fast: false,
            },
            steps: [pauseStep],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'targeted-matrix-cancel',
        executionId: 'targeted-matrix-cancel-execution',
        runtime,
      },
    );
    const paused = await handle.waitForCompletion();
    if (paused.status !== 'paused') {
      throw new Error(
        paused.error ??
          JSON.stringify({ jobs: paused.jobs, groups: paused.job_groups }),
      );
    }
    const cancelled = prepareMatrixVariantCancellation(
      structuredClone(paused),
      {
        executionId: paused.id,
        jobId: 'review',
        variantJobId: '__matrix__review__0',
      },
    );
    expect(cancelled.jobs.__matrix__review__0.status).toBe('cancelled');
    expect(cancelled.jobs.__matrix__review__1.status).toBe('paused');
    expect(
      cancelled.pending_pauses.map((checkpoint) => checkpoint.job_id),
    ).toEqual(['__matrix__review__1']);
  });

  it('collects simultaneous pauses from independent fixed jobs', async () => {
    const pauseStep = {
      id: 'approval',
      shell: 'node' as const,
      run: `import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'CANOPY_PAUSE=true\\n', 'utf8');`,
    };
    const handle = await executePipeline(
      {
        name: 'Fixed parallel pauses',
        on: 'dispatch',
        jobs: {
          first: { steps: [pauseStep] },
          second: { steps: [pauseStep] },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'fixed-parallel-pauses',
        executionId: 'fixed-parallel-pauses-execution',
        runtime,
      },
    );
    const paused = await handle.waitForCompletion();
    if (paused.status !== 'paused') {
      throw new Error(
        paused.error ??
          JSON.stringify({ jobs: paused.jobs, groups: paused.job_groups }),
      );
    }
    expect(
      paused.pending_pauses.map((checkpoint) => checkpoint.job_id),
    ).toEqual(['first', 'second']);

    await expect(
      resumePipeline('fixed-parallel-pauses-execution', {
        cwd: tempDir,
        runtime,
        pauseResponses: [
          {
            checkpoint_id: 'stale-checkpoint',
            job_id: 'first',
            step_id: 'approval',
          },
        ],
      }),
    ).rejects.toThrow('no longer pending');

    const firstResume = await resumePipeline(
      'fixed-parallel-pauses-execution',
      {
        cwd: tempDir,
        runtime,
        pauseResponses: [
          {
            checkpoint_id: paused.pending_pauses[0].id,
            job_id: paused.pending_pauses[0].job_id,
            step_id: paused.pending_pauses[0].step_id,
          },
        ],
      },
    );
    const stillPaused = await firstResume.waitForCompletion();
    expect(stillPaused.status).toBe('paused');
    expect(
      stillPaused.pending_pauses.map((checkpoint) => checkpoint.job_id),
    ).toEqual(['second']);

    const resumed = await resumePipeline('fixed-parallel-pauses-execution', {
      cwd: tempDir,
      runtime,
      pauseResponses: [
        {
          checkpoint_id: stillPaused.pending_pauses[0].id,
          job_id: stillPaused.pending_pauses[0].job_id,
          step_id: stillPaused.pending_pauses[0].step_id,
        },
      ],
    });
    expect((await resumed.waitForCompletion()).status).toBe('success');
  });
});
