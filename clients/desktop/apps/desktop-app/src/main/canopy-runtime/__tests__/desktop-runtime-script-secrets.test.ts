import type * as CanopyPaths from '@canopy/execution-engine/canopy-paths';
import type * as NodePath from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { join } from 'node:path';
import log from 'electron-log/main.js';
import { executionSecretFingerprints } from '@canopy/core-runtime/node/execution-secrets';
import type { WorkerScriptExecuteParams } from '@canopy/protocol/canopy-core';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ScriptDescriptor,
  type UserEnvironmentEntry,
} from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import {
  registerSecretsEnvInjector,
  registerUserEnvironmentInjector,
} from '@canopy/execution-engine/pipelines/config-paths';

let mockRoot: string;
jest.mock('@canopy/execution-engine/canopy-paths', () => {
  const actual = jest.requireActual<typeof CanopyPaths>(
    '@canopy/execution-engine/canopy-paths',
  );
  const path = jest.requireActual<typeof NodePath>('node:path');
  return {
    ...actual,
    getEnvironmentConfigFilePath: (): string =>
      path.join(mockRoot, 'fixtures', 'environments.json'),
  };
});
jest.mock('../../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../../lib/github-pat-env', () => ({
  readGitHubPatForExecution: jest.fn(),
}));
jest.mock('../../lib/linear-auth', () => ({ resolveLinearToken: jest.fn() }));
jest.mock('../../shared-containers/run-env-store', () => ({
  readSharedContainerRunEnvironment: jest.fn(),
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));

import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { createWorkerScriptAdapter } from '../worker-script-adapter';
import { runDesktopScript, cancelScriptRuns } from '../../lib/script-execution';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../../lib/user-environment-runtime';
import { getDesktopExecutionSecrets } from '../../execution-secrets/owner';
import { readEnvironmentConfig } from '../../lib/user-environment-store';
import { readGitHubPatForExecution } from '../../lib/github-pat-env';
import { readSharedContainerRunEnvironment } from '../../shared-containers/run-env-store';
import * as paths from '../../lib/paths';

const canaries = [
  'secret-canary-env-7f3a',
  'secret-canary-pat-91c2',
  'secret-canary-run-55d0',
];
let runtime: DesktopCanopyDispatcher;
let operations: CoreOperationAdapter;
let captured: WorkerScriptExecuteParams[];
let beforeWorker: () => void;
let logs: unknown[][];
let inWorker: boolean;
let config = createDefaultEnvironmentConfig('2026-11-05T00:00:00.000Z');
let runValues: UserEnvironmentEntry[];
const originalEnv = process.env;

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function command(): string {
  return `${quote(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.env))'`;
}
function descriptor(key: string): ScriptDescriptor {
  return {
    scriptKey: key,
    scriptName: key,
    label: 'Secrets fixture',
    command: command(),
    lifecycle: 'custom',
    target: 'project',
  };
}
function scan(): void {
  for (const dir of ['ledger', 'logs']) {
    for (const name of readdirSync(join(mockRoot, dir))) {
      if (dir === 'logs' && !name.endsWith('.json')) continue;
      const bytes = readFileSync(join(mockRoot, dir, name));
      for (const canary of canaries)
        expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
  }
  for (const canary of canaries)
    expect(inspect(logs, { depth: null })).not.toContain(canary);
}
function parsedEnv(output: string): Record<string, unknown> {
  const line = output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing environment output');
  return Object.fromEntries(Object.entries(value));
}
async function run(
  key: string,
  shared = false,
): Promise<Record<string, unknown>> {
  inWorker = false;
  const result = await runDesktopScript({
    projectId: shared ? SHARED_CONTAINER_VIEWER_PROJECT_ID : 'workspace',
    worktreeId: 'worktree',
    context: shared
      ? {
          kind: 'shared-container',
          repoId: 'repo',
          environmentKeys: ['DECLARED', 'EMPTY', 'GH_TOKEN', 'PATH'],
        }
      : { kind: 'project' },
    script: descriptor(key),
    invocation: 'manual-run',
    command: command(),
    shell: { mac: 'bash', linux: 'bash' },
    timeoutSeconds: 10,
    interactive: false,
    runId: key,
  });
  expect(result.response.success).toBe(true);
  return parsedEnv(result.response.output);
}
beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'desktop-script-secrets-'));
  for (const name of ['ledger', 'logs', 'checkout', 'fixtures', 'home'])
    mkdirSync(join(mockRoot, name));
  process.env = {
    NODE_ENV: 'test',
    HOME: join(mockRoot, 'home'),
    USER: 'fixture',
    PATH: originalEnv.PATH,
    SHELL: '/bin/bash',
    TMPDIR: originalEnv.TMPDIR,
  };
  logs = [];
  captured = [];
  inWorker = false;
  beforeWorker = (): void => undefined;
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
    variables: [
      { key: 'SECRET_KEY', value: canaries[0], secret: true },
      { key: 'EMPTY', value: '', secret: true },
      { key: 'PUBLIC_KEY', value: 'public' },
    ],
  });
  config.globalRuntimes.canopy = 'secrets';
  writeFileSync(
    join(mockRoot, 'fixtures', 'environments.json'),
    JSON.stringify({ version: 2, data: config }),
  );
  jest.mocked(readEnvironmentConfig).mockImplementation(() => {
    if (inWorker)
      expect(new Error().stack).toContain('/execution-secrets/reader');
    return Promise.resolve({ data: config, encryptionAvailable: true });
  });
  jest.mocked(readGitHubPatForExecution).mockImplementation(() => {
    if (inWorker)
      expect(new Error().stack).toContain('/execution-secrets/reader');
    return canaries[1];
  });
  runValues = [
    { key: 'DECLARED', value: canaries[2], secret: true },
    { key: 'EMPTY', value: '', secret: true },
    { key: 'UNDECLARED', value: 'omit', secret: true },
    { key: 'GH_TOKEN', value: canaries[1], secret: true },
    { key: 'PATH', value: '/forbidden', secret: true },
  ];
  jest.mocked(readSharedContainerRunEnvironment).mockImplementation(() => {
    if (inWorker)
      expect(new Error().stack).toContain('/execution-secrets/reader');
    return Promise.resolve(runValues);
  });
  jest
    .spyOn(paths, 'getWorktreeDir')
    .mockReturnValue(join(mockRoot, 'checkout'));
  jest
    .spyOn(paths, 'getSharedContainerRunRepoDir')
    .mockReturnValue(join(mockRoot, 'checkout'));
  jest
    .spyOn(paths, 'getWorktreeDataDir')
    .mockReturnValue(join(mockRoot, 'checkout'));
  jest
    .spyOn(paths, 'resolveScriptRunDir')
    .mockReturnValue(join(mockRoot, 'logs'));
  invalidateUserEnvironmentInjectionCache();
  initializeUserEnvironmentRuntime();
  registerSecretsEnvInjector(() => ({ GH_TOKEN: canaries[1] }));
  operations = createCoreOperationAdapter({
    ledgerPath: (): string => join(mockRoot, 'ledger', 'operations.sqlite'),
  });
  const adapter = createWorkerScriptAdapter();
  const execute = adapter.instructions['worker.script.execute'];
  adapter.instructions['worker.script.execute'] = (
    params,
    context,
  ): ReturnType<typeof execute> => {
    captured.push(params);
    beforeWorker();
    inWorker = true;
    jest.mocked(readEnvironmentConfig).mockClear();
    jest.mocked(readGitHubPatForExecution).mockClear();
    jest.mocked(readSharedContainerRunEnvironment).mockClear();
    return execute(params, context);
  };
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    workerScriptAdapter: adapter,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  try {
    await runtime.shutdown();
    scan();
  } finally {
    invalidateUserEnvironmentInjectionCache();
    process.env = originalEnv;
    jest.restoreAllMocks();
    rmSync(mockRoot, { recursive: true, force: true });
  }
});

afterAll(() => {
  registerSecretsEnvInjector(null);
  registerUserEnvironmentInjector(null);
});

it('a script run receives its secrets only by redeeming its bindings', async () => {
  const env = await run('project');
  expect(env.SECRET_KEY).toBe(canaries[0]);
  expect(env.GH_TOKEN).toBe(canaries[1]);
  expect(env.EMPTY).toBe('');
  expect(env.PUBLIC_KEY).toBe('public');
  const params = captured[0];
  if (!params) throw new Error('Missing dispatch');
  expect(params.secrets?.length).toBeGreaterThan(0);
  const [parent] = (
    await operations.service.list({ kinds: ['core.script.run'], limit: 10 })
  ).items;
  if (!parent) throw new Error('Missing operation');
  const [delegation] = await runtime.localWorker.listDelegations(
    parent.operationId,
  );
  expect(delegation?.secrets).toEqual(
    executionSecretFingerprints(params.secrets),
  );
  expect(readEnvironmentConfig).toHaveBeenCalledTimes(1);
  expect(readGitHubPatForExecution).toHaveBeenCalledTimes(1);
});
it('a shared-container run gets only its declared values', async () => {
  const env = await run('shared', true);
  expect(env.DECLARED).toBe(canaries[2]);
  expect(env.EMPTY).toBe('');
  expect(env.UNDECLARED).toBeUndefined();
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.SECRET_KEY).toBeUndefined();
  expect(env.PATH).not.toBe('/forbidden');
  expect(readSharedContainerRunEnvironment).toHaveBeenCalledTimes(1);
  expect(readEnvironmentConfig).not.toHaveBeenCalled();
  expect(readGitHubPatForExecution).not.toHaveBeenCalled();
});
it('a removed value refuses the run before it is logged', async () => {
  beforeWorker = (): void => {
    config.environments = config.environments.filter(
      (environment) => environment.id !== 'secrets',
    );
  };
  const started = jest.fn();
  await expect(
    runDesktopScript(
      {
        projectId: 'workspace',
        worktreeId: 'worktree',
        context: { kind: 'project' },
        script: descriptor('removed'),
        invocation: 'manual-run',
        command: command(),
        timeoutSeconds: 10,
        interactive: false,
        runId: 'removed',
      },
      { observer: { onProcessStarted: started } },
    ),
  ).rejects.toMatchObject({
    payload: { code: 'worker.executionSecret.unavailable' },
  });
  expect(started).not.toHaveBeenCalled();
  expect(readdirSync(join(mockRoot, 'logs'))).toEqual([]);
  const [child] = (
    await operations.service.list({
      kinds: ['worker.script.execute'],
      limit: 10,
    })
  ).items;
  expect(child?.error?.code).toBe('worker.executionSecret.unavailable');
});
it('no secret value reaches the ledger, run records or logs', async () => {
  await run('scan-project');
  await run('scan-shared', true);
  inWorker = false;
  jest
    .mocked(readSharedContainerRunEnvironment)
    .mockRejectedValueOnce(new Error(canaries[2]));
  const error: unknown = await run('unreadable-shared', true).catch(
    (error: unknown): unknown => error,
  );
  expect(error).toMatchObject({
    payload: { code: 'worker.executionSecret.unavailable' },
  });
  expect(inspect(error, { depth: null })).not.toContain(canaries[2]);
  scan();
});

it('refuses an unreadable environment before dispatch', async () => {
  jest
    .mocked(readEnvironmentConfig)
    .mockRejectedValueOnce(new Error(canaries[0]));
  await expect(run('unreadable-environment')).rejects.toMatchObject({
    payload: { code: 'worker.executionSecret.unavailable' },
  });
  expect(captured).toEqual([]);
});

it('stops a launch while binding discovery is pending', async () => {
  const stage = jest.spyOn(getDesktopExecutionSecrets(), 'stage');
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  jest.mocked(readEnvironmentConfig).mockImplementationOnce(() => {
    entered?.();
    return new Promise((resolve) => {
      release = (): void =>
        resolve({ data: config, encryptionAvailable: true });
    });
  });
  const started = jest.fn();
  const launch = runDesktopScript(
    {
      projectId: 'workspace',
      worktreeId: 'worktree',
      context: { kind: 'project' },
      script: descriptor('pending-discovery'),
      invocation: 'manual-run',
      command: command(),
      timeoutSeconds: 10,
      interactive: false,
      runId: 'pending-discovery',
    },
    { observer: { onProcessStarted: started } },
  );
  await waiting;
  const stopped = await cancelScriptRuns({
    projectId: 'workspace',
    worktreeId: 'worktree',
    scriptKey: 'pending-discovery',
    runId: 'pending-discovery',
  });
  release?.();
  const result = await launch;
  expect(started).not.toHaveBeenCalled();
  expect(captured).toEqual([]);
  expect(result.response.success).toBe(false);
  expect(stage).not.toHaveBeenCalled();
  expect(result.logRef).toBeNull();
  expect(readdirSync(join(mockRoot, 'logs'))).toEqual([]);
  expect(stopped.stopped.map((run) => run.executionId)).toContain(
    'pending-discovery',
  );
});
