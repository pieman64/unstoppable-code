import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import log from 'electron-log/main.js';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { WorkerPipelineExecutionStartParams } from '@canopy/protocol/canopy-core';
import { executionSecretFingerprints } from '@canopy/core-runtime/node/execution-secrets';
import { forkGoldenUtilityProcess } from './harness';
import {
  createPipelineGoldenWorld,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';
import { waitForExecution } from './executions';

const mockForkUtilityProcess = (): unknown => forkGoldenUtilityProcess();
jest.mock('electron', () => ({
  ...jest.requireActual<object>('electron'),
  utilityProcess: { fork: (): unknown => mockForkUtilityProcess() },
}));
jest.mock('../../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../../lib/github-pat-env', () => ({
  readGitHubPatForExecution: jest.fn(),
}));
jest.mock('../../lib/linear-auth', () => ({ resolveLinearToken: jest.fn() }));

import { readEnvironmentConfig } from '../../lib/user-environment-store';
import { readGitHubPatForExecution } from '../../lib/github-pat-env';
import { resolveLinearToken } from '../../lib/linear-auth';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import { createWorkerPipelineAdapter } from '../../canopy-runtime/worker-pipeline-adapter';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import { resetDesktopExecutionSecretsForTests } from '../../execution-secrets/owner';
import * as host from '../../pipelines/pipeline-worker-host';

jest.setTimeout(120_000);
const canaries = [
  'secret-canary-env-7f3a',
  'secret-canary-pat-91c2',
  'secret-canary-linear-cd44',
  'secret-canary-env-new-88f0',
];
let world: GoldenWorld;
let runtime: DesktopCanopyDispatcher;
let operations: CoreOperationAdapter;
let executionsDir: string;
let logs: unknown[][] = [];
const starts: WorkerPipelineExecutionStartParams[] = [];
let config = createDefaultEnvironmentConfig('2026-11-05T00:00:00.000Z');
let lastPaused: ExecutionState;

function compose(): void {
  operations = createCoreOperationAdapter({
    ledgerPath: (): string => join(world.root, 'ledger', 'operations.sqlite'),
  });
  const adapter = createWorkerPipelineAdapter();
  const start = adapter.instructions['worker.pipeline.execution.start'];
  adapter.instructions['worker.pipeline.execution.start'] = (
    params,
    context,
  ): ReturnType<typeof start> => {
    starts.push(params);
    return start(params, context);
  };
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    workerPipelineAdapter: adapter,
  });
  setDesktopCanopyRuntime(runtime);
}

function scanDirectory(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scanDirectory(path);
    else {
      const bytes = readFileSync(path);
      for (const canary of canaries)
        expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
  }
}
function scan(): void {
  scanDirectory(join(world.root, 'ledger'));
  scanDirectory(executionsDir);
  for (const canary of canaries)
    expect(inspect(logs, { depth: null })).not.toContain(canary);
}
const linearName = brandEnvName('LINEAR_API_KEY');
function yaml(paused: boolean): string {
  return `pipeline:
  name: Secret fixture ${paused}
  on: dispatch
  jobs:
    run:
      steps:
        - id: before
          run: |
            printf '%s\\n' "$SECRET_KEY" "$${linearName}" "$GH_TOKEN" > "$OBSERVED"
            printf '%s\\n' "$SECRET_KEY" "$${linearName}" "$GH_TOKEN"
${
  paused
    ? `        - id: ask
          run: |
            echo 'CANOPY_INPUT_REQUEST={"title":"Approve","fields":[{"key":"approved","label":"Approved","type":"boolean","required":true}]}' >> "$CANOPY_OUTPUT"
            echo 'CANOPY_PAUSE=true' >> "$CANOPY_OUTPUT"
        - id: after
          run: |
            printf '%s\\n' "$SECRET_KEY" "$${linearName}" "$GH_TOKEN" > "$AFTER"
            printf '%s\\n' "$SECRET_KEY" "$${linearName}" "$GH_TOKEN"
`
    : ''
}`;
}
async function run(name: string, paused = false): Promise<ExecutionState> {
  const source = yaml(paused);
  const pipelineId = await world.saveUserPipeline(source, name);
  const { startPipelineExecutionFromMain } =
    await import('../../pipelines/pipeline-handlers');
  const result = await startPipelineExecutionFromMain({
    pipeline: parsePipelineText(source),
    options: {
      pipelineId,
      cwd: world.worktreePath,
      scope: 'worktree',
      projectId: GOLDEN_WORKSPACE_ID,
      worktreeId: GOLDEN_WORKTREE_ID,
      target: {
        scope: 'worktree',
        workspace_id: GOLDEN_WORKSPACE_ID,
        worktree_id: GOLDEN_WORKTREE_ID,
        path: world.worktreePath,
        created: false,
      },
      env: {
        OBSERVED: join(world.root, `${name}.env`),
        AFTER: join(world.root, `${name}-after.env`),
      },
    },
    getWindow: () => null,
  });
  if (!result.success) throw new Error(result.error);
  const state = await waitForExecution(executionsDir, result.data.id, [
    paused ? 'paused' : 'success',
  ]);
  const { getActiveExecutionHandle } =
    await import('../../pipelines/pipeline-execution-registry');
  await getActiveExecutionHandle(state.id)?.waitForCompletion();
  return state;
}

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(world.root, 'ledger'));
  logs = [];
  for (const name of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    jest.spyOn(console, name).mockImplementation((...args: unknown[]): void => {
      logs.push(args);
    });
    jest.spyOn(log, name).mockImplementation((...args: unknown[]): void => {
      logs.push(args);
    });
  }
  const now = '2026-11-05T00:00:00.000Z';
  config = createDefaultEnvironmentConfig(now);
  config.environments.push({
    id: 'secrets',
    name: 'Secrets',
    parentId: null,
    isDefault: false,
    uiMode: 'key-value',
    createdAt: now,
    updatedAt: now,
    variables: [{ key: 'SECRET_KEY', value: canaries[0], secret: true }],
  });
  config.globalRuntimes.pipeline = 'secrets';
  jest
    .mocked(readEnvironmentConfig)
    .mockImplementation(() =>
      Promise.resolve({ data: config, encryptionAvailable: true }),
    );
  jest.mocked(readGitHubPatForExecution).mockReturnValue(canaries[1]);
  jest.mocked(resolveLinearToken).mockResolvedValue(canaries[2]);
  compose();
  const { createElectronExecutionRuntime } =
    await import('../../pipelines/execution-runtime');
  executionsDir = createElectronExecutionRuntime().executionsDir;
});
afterAll(async () => {
  try {
    const { shutdownPipelineProcessHost } =
      await import('../../pipelines/process-host-runner');
    await shutdownPipelineProcessHost();
    await runtime.shutdown();
    scan();
  } finally {
    setDesktopCanopyRuntime(null);
    jest.restoreAllMocks();
    await world.dispose();
  }
});

it('a pipeline step receives its secrets only through the redeemed launch', async () => {
  const staged = jest.spyOn(host, 'stagePipelineLaunch');
  const state = await run('start');
  expect(
    readFileSync(join(world.root, 'start.env'), 'utf8').trim().split('\n'),
  ).toEqual([canaries[0], canaries[2], canaries[1]]);
  expect(staged.mock.calls.at(-1)?.[1].options.secretEnv).toBeUndefined();
  const params = starts.at(-1);
  expect(params?.secrets).toHaveLength(3);
  const parent = (
    await operations.service.list({ kinds: ['core.pipeline.run'], limit: 100 })
  ).items.find((item) => item.scope.executionId === state.id);
  if (!parent) throw new Error('Missing pipeline operation');
  const [delegation] = await runtime.localWorker.listDelegations(
    parent.operationId,
  );
  expect(delegation?.secrets).toEqual(
    executionSecretFingerprints(params?.secrets),
  );
  scan();
});
it('a resume after a restart redeems a new lease and sees the current value', async () => {
  const state = await run('restart', true);
  await runtime.shutdown();
  resetDesktopExecutionSecretsForTests();
  config.environments
    .find((env) => env.id === 'secrets')
    ?.variables.splice(0, 1, {
      key: 'SECRET_KEY',
      value: canaries[3],
      secret: true,
    });
  compose();
  const { resumePipelineExecutionFromMain } =
    await import('../../pipelines/pipeline-resume-service');
  const pause = state.pending_pauses[0];
  if (!pause) throw new Error('Missing pause');
  await resumePipelineExecutionFromMain({
    executionId: state.id,
    initiationSource: 'user',
    getWindow: () => null,
    pauseResponses: [
      {
        checkpoint_id: pause.id,
        job_id: pause.job_id,
        step_id: pause.step_id,
        answers: { approved: true },
      },
    ],
  });
  await waitForExecution(executionsDir, state.id, ['success']);
  expect(
    readFileSync(join(world.root, 'restart-after.env'), 'utf8')
      .trim()
      .split('\n'),
  ).toEqual([canaries[3], canaries[2], canaries[1]]);
  lastPaused = await run('no-grant', true);
  scan();
});
it('a control with no staged lease is refused before the executor runs', async () => {
  const { buildPipelineSecretBindings } =
    await import('../../execution-secrets/bindings');
  const bindings = await buildPipelineSecretBindings({
    workspaceId: GOLDEN_WORKSPACE_ID,
  });
  const path = join(executionsDir, `${lastPaused.id}.json`);
  const before = readFileSync(path);
  const launch = jest.fn();
  const requestId = 'resume-no-grant';
  const staged = host.stagePipelineControl(requestId, launch);
  const result = await runtime.pipelineRuns.control({
    control: {
      operation: 'worker.pipeline.execution.resume',
      params: {
        requestId,
        executionId: lastPaused.id,
        initiationSource: 'user',
        secrets: bindings,
      },
    },
    origin: { kind: 'client', sourceId: 'fixture' },
    owner: { kind: 'principal', id: 'fixture' },
  });
  staged.take();
  expect(result.status).toBe('failed');
  if (result.status !== 'completed')
    expect(result.error?.code).toBe('worker.executionSecret.notGranted');
  expect(launch).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before);
});
it('no secret value reaches the ledger, run records or logs', () => {
  scan();
  const outputFiles = readdirSync(executionsDir, { recursive: true }).filter(
    (file): file is string => typeof file === 'string' && file.endsWith('.log'),
  );
  expect(outputFiles.length).toBeGreaterThan(0);
  expect(
    outputFiles.some((file) =>
      readFileSync(join(executionsDir, file), 'utf8').includes('***'),
    ),
  ).toBe(true);
});
