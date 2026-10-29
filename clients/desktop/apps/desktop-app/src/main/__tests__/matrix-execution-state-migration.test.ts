jest.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInitialState,
  loadExecutionState,
  normalizePipeline,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/executor/types';

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected record fixture');
  }
  return value;
}

describe('execution state v7 matrix migration', () => {
  let rootDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-v7-migration-'));
    runtime = {
      // Pipeline fixtures do not enforce an org model policy.
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: path.join(rootDir, 'executions'),
      tempRootDir: path.join(rootDir, 'tmp'),
      bundledActionsDir: path.join(rootDir, 'actions'),
      getProjectActionsDir: (repoPath: string): string => repoPath,
      getProjectPipelinesDir: (repoPath: string): string => repoPath,
    };
    fs.mkdirSync(runtime.executionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('flattens nested foreach children into physical jobs and preserves artifact lookup', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Legacy execution',
        on: 'dispatch',
        jobs: {
          process: { steps: [{ id: 'run', run: 'echo run' }] },
        },
      }),
      { cwd: rootDir, pipelineId: 'legacy', runtime },
      'legacy-execution',
    );
    const raw = requireRecord(structuredClone(state));
    raw.version = 7;
    delete raw.job_definitions;
    delete raw.job_groups;
    delete raw.pending_pauses;
    const pipelineSnapshot = requireRecord(raw.pipeline_snapshot);
    const snapshotJobs = requireRecord(pipelineSnapshot.jobs);
    const snapshot = requireRecord(snapshotJobs.process);
    snapshot.foreach = [{ target: 'alpha' }, { target: 'beta' }];
    raw.status = 'failure';
    const jobs = requireRecord(raw.jobs);
    jobs.process = {
      status: 'failure',
      outcome: 'failure',
      conclusion: 'failure',
      steps: {},
      outputs: {},
      children: [
        {
          id: 'child-000000',
          index: 0,
          item: { target: 'alpha' },
          name: 'Alpha',
          status: 'success',
          outcome: 'success',
          conclusion: 'success',
          steps: {
            run: {
              status: 'success',
              outcome: 'success',
              conclusion: 'success',
              outputs: {},
              dynamic_env: {},
            },
          },
          outputs: {},
        },
        {
          id: 'child-000001',
          index: 1,
          item: { target: 'beta' },
          name: 'Beta',
          status: 'failure',
          outcome: 'failure',
          conclusion: 'failure',
          steps: {
            run: {
              status: 'failure',
              outcome: 'failure',
              conclusion: 'failure',
              outputs: {},
              dynamic_env: {},
            },
          },
          outputs: {},
        },
      ],
    };

    fs.writeFileSync(
      path.join(runtime.executionsDir, `${state.id}.json`),
      JSON.stringify(raw),
      'utf8',
    );

    const migrated = await loadExecutionState(state.id, runtime.executionsDir);

    expect(migrated?.version).toBe(10);
    expect(migrated?.job_groups.process).toMatchObject({
      kind: 'matrix',
      variant_job_ids: ['__matrix__process__0', '__matrix__process__1'],
      legacy_foreach_v7: true,
    });
    expect(migrated?.jobs.__matrix__process__0.status).toBe('success');
    expect(migrated?.job_definitions.__matrix__process__1).toMatchObject({
      logical_job_id: 'process',
      matrix: {
        index: 1,
        total: 2,
        values: { item: { target: 'beta' }, index: 1 },
      },
      artifact_locator: {
        job_id: 'process',
        matrix_child_id: 'child-000001',
      },
    });
    expect(
      Reflect.has(migrated?.pipeline_snapshot.jobs.process ?? {}, 'foreach'),
    ).toBe(false);
  });

  it('keeps an unmaterialized legacy fan-out inspectable as an explicit expansion failure', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Legacy unmaterialized execution',
        on: 'dispatch',
        jobs: {
          process: { steps: [{ id: 'run', run: 'echo run' }] },
        },
      }),
      { cwd: rootDir, pipelineId: 'legacy-pending', runtime },
      'legacy-pending-execution',
    );
    const raw = requireRecord(structuredClone(state));
    raw.version = 7;
    delete raw.job_definitions;
    delete raw.job_groups;
    delete raw.pending_pauses;
    const pipelineSnapshot = requireRecord(raw.pipeline_snapshot);
    const snapshotJobs = requireRecord(pipelineSnapshot.jobs);
    const snapshot = requireRecord(snapshotJobs.process);
    snapshot.foreach_expression = '${{ parseJson(inputs.items) }}';
    raw.status = 'failure';
    const jobs = requireRecord(raw.jobs);
    const processJob = requireRecord(jobs.process);
    processJob.status = 'failure';
    processJob.outcome = 'failure';
    processJob.conclusion = 'failure';

    fs.writeFileSync(
      path.join(runtime.executionsDir, `${state.id}.json`),
      JSON.stringify(raw),
      'utf8',
    );

    const migrated = await loadExecutionState(state.id, runtime.executionsDir);

    expect(migrated?.version).toBe(10);
    expect(migrated?.jobs).toEqual({});
    expect(migrated?.job_definitions).toEqual({});
    expect(migrated?.job_groups.process).toMatchObject({
      kind: 'matrix',
      expansion: 'failure',
      variant_job_ids: [],
      status: 'failure',
      legacy_foreach_v7: true,
      error:
        'Legacy foreach expansion was not materialized before migration. Convert the source pipeline to strategy.matrix and start a new execution.',
    });
  });

  it('keeps missing legacy single-job results out of the physical state', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Legacy execution with a missing result',
        on: 'dispatch',
        jobs: {
          present: { steps: [{ id: 'run', run: 'echo present' }] },
          missing: { steps: [{ id: 'run', run: 'echo missing' }] },
        },
      }),
      { cwd: rootDir, pipelineId: 'legacy-missing-result', runtime },
      'legacy-missing-result-execution',
    );
    const raw = requireRecord(structuredClone(state));
    raw.version = 7;
    delete raw.job_definitions;
    delete raw.job_groups;
    delete raw.pending_pauses;
    const jobs = requireRecord(raw.jobs);
    delete jobs.missing;

    fs.writeFileSync(
      path.join(runtime.executionsDir, `${state.id}.json`),
      JSON.stringify(raw),
      'utf8',
    );

    const migrated = await loadExecutionState(state.id, runtime.executionsDir);

    expect(migrated?.version).toBe(10);
    expect(migrated?.jobs.present).toBeDefined();
    expect(migrated?.job_definitions.present).toBeDefined();
    expect(migrated?.jobs.missing).toBeUndefined();
    expect(migrated?.job_definitions.missing).toBeUndefined();
    expect(migrated?.job_groups.missing).toMatchObject({
      kind: 'single',
      expansion: 'expanded',
      variant_job_ids: [],
      status: 'failure',
    });
  });
});
