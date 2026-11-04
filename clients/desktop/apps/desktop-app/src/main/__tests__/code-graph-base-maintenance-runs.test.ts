import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeGraphBuildCanceledError,
  codeGraphBuildFailedError,
  codeGraphBuildTimedOutError,
} from '@canopy/core-runtime/node/code-graph';
import { InitiatedWorkEngine } from '@canopy/core-runtime/node/initiated-work';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_INITIATED_WORK_RUN_KIND,
  WorkerCodeGraphBuildParamsSchema,
  parseInitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): null => null,
}));

import {
  cancelCodeGraphBaseMaintenance,
  runCodeGraphBaseMaintenance,
  setBaseMaintenanceRuntimeForTests,
  type BaseMaintenanceRun,
  type BaseMaintenanceRuntime,
} from '../code-graph/base-maintenance-runs';

interface Dispatch {
  name: string;
  params: unknown;
  idempotencyKey: string | undefined;
}

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;
let dispatches: Dispatch[];
let build: jest.Mock<Promise<unknown>, [unknown]>;

function bases(
  ...outcomes: Array<'built' | 'failed' | 'timed_out' | 'unavailable'>
): unknown {
  return {
    kind: 'workspace_base',
    repositories: outcomes.map((outcome, index) => ({
      repositoryId: `repo-${index}`,
      outcome,
    })),
  };
}

function useRuntime(): void {
  const instruction = (
    name: string,
    params: unknown,
    options: { metadata?: { idempotencyKey?: string } },
  ): Promise<unknown> => {
    dispatches.push({
      name,
      params,
      idempotencyKey: options.metadata?.idempotencyKey,
    });
    return build(params);
  };
  const runtime = {
    instruction,
    initiatedWork: engine,
  } as unknown as BaseMaintenanceRuntime;
  setBaseMaintenanceRuntimeForTests(runtime);
}

function maintenance(
  overrides: Partial<BaseMaintenanceRun> = {},
): BaseMaintenanceRun {
  return {
    workspaceId: 'project-1',
    repositoryCount: 2,
    available: () => true,
    stopped: () => false,
    ...overrides,
  };
}

async function runs(): Promise<OperationRecord[]> {
  const page = await operations.list({
    kinds: [CORE_INITIATED_WORK_RUN_KIND],
    limit: 50,
  });
  return page.items;
}

async function onlyRun(): Promise<OperationRecord> {
  const all = await runs();
  expect(all).toHaveLength(1);
  const [run] = all;
  if (run === undefined) throw new Error('No run was recorded.');
  return run;
}

function recordOf(
  run: OperationRecord,
): ReturnType<typeof parseInitiatedWorkRunRecord> {
  return parseInitiatedWorkRunRecord(run.outcome ?? run.error?.details);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'code-graph-base-maintenance-runs-'));
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  engine = new InitiatedWorkEngine({ operations });
  dispatches = [];
  build = jest
    .fn<Promise<unknown>, [unknown]>()
    .mockResolvedValue(bases('built', 'built'));
  useRuntime();
});

afterEach(() => {
  setBaseMaintenanceRuntimeForTests(null);
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('code-graph base maintenance as initiated work', () => {
  it("records an accepted run and dispatches the workspace's bases in maintenance mode", async () => {
    await expect(runCodeGraphBaseMaintenance(maintenance())).resolves.toBe(
      'succeeded',
    );

    const run = await onlyRun();
    expect(run.status).toBe('completed');
    expect(run.origin).toEqual({
      kind: 'system',
      sourceId: 'code-graph.base-maintenance',
      context: { trigger: 'maintenance', repositoryCount: 2 },
    });
    expect(run.owner.kind).toBe('system');
    expect(run.scope).toEqual({ workspaceId: 'project-1' });
    const record = recordOf(run);
    expect(record?.disposition).toBe('ran');
    expect(record?.result?.status).toBe('succeeded');
    expect(record?.gates.map(({ gate, decision }) => [gate, decision])).toEqual(
      [
        ['pause', 'passed'],
        ['deletionFence', 'passed'],
        ['busyTarget', 'passed'],
      ],
    );

    expect(dispatches).toEqual([
      {
        name: 'worker.codeGraph.build',
        params: {
          graphScope: {
            kind: 'workspace_base',
            workspaceId: 'project-1',
            background: { trigger: 'maintenance' },
          },
        },
        idempotencyKey: run.operationId,
      },
    ]);
    expect(
      WorkerCodeGraphBuildParamsSchema.safeParse(dispatches[0]?.params).success,
    ).toBe(true);
  });

  it.each([
    ['failed', bases('built', 'failed')],
    ['timedOut', bases('built', 'timed_out')],
    ['stopped', bases('built', 'unavailable')],
  ] as const)(
    'records the run as %s from its base outcomes',
    async (status, result) => {
      build.mockResolvedValueOnce(result);

      await expect(runCodeGraphBaseMaintenance(maintenance())).resolves.toBe(
        status,
      );
      expect(recordOf(await onlyRun())?.result?.status).toBe(status);
    },
  );

  it('records a skipped run and builds nothing when the code graph is off', async () => {
    await expect(
      runCodeGraphBaseMaintenance(maintenance({ available: () => false })),
    ).resolves.toBe('skipped');

    const record = recordOf(await onlyRun());
    expect(record?.disposition).toBe('skipped');
    expect(record?.gates.at(-1)).toEqual(
      expect.objectContaining({ gate: 'pause', decision: 'skipped' }),
    );
    expect(dispatches).toEqual([]);
  });

  it('records a skipped run when the base manager is shutting down', async () => {
    await expect(
      runCodeGraphBaseMaintenance(maintenance({ stopped: () => true })),
    ).resolves.toBe('skipped');

    const record = recordOf(await onlyRun());
    expect(record?.gates.at(-1)).toEqual(
      expect.objectContaining({ gate: 'deletionFence', decision: 'skipped' }),
    );
    expect(dispatches).toEqual([]);
  });

  it.each([
    ['failed', codeGraphBuildFailedError('build_error')],
    ['timedOut', codeGraphBuildTimedOutError()],
    ['stopped', codeGraphBuildCanceledError()],
  ] as const)(
    'records maintenance the worker refused as %s',
    async (status, refusal) => {
      build.mockRejectedValueOnce(refusal);

      await expect(runCodeGraphBaseMaintenance(maintenance())).resolves.toBe(
        status,
      );
      expect(recordOf(await onlyRun())?.result?.status).toBe(status);
    },
  );

  it('records the shutdown cancel on a live run', async () => {
    let resolveBuild: (value: unknown) => void = () => undefined;
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }),
    );

    const outcome = runCodeGraphBaseMaintenance(maintenance());
    while (build.mock.calls.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    cancelCodeGraphBaseMaintenance('The app is shutting down.');
    resolveBuild(bases('unavailable', 'unavailable'));

    await expect(outcome).resolves.toBe('cancelled');
    const run = await onlyRun();
    expect(run.status).toBe('cancelled');
    expect(run.cancellation?.reason).toBe('The app is shutting down.');
  });

  it('starts nothing and records nothing without an accepting runtime', async () => {
    setBaseMaintenanceRuntimeForTests(null);

    await expect(runCodeGraphBaseMaintenance(maintenance())).resolves.toBe(
      'not-started',
    );
    expect(await runs()).toEqual([]);
    expect(dispatches).toEqual([]);
  });
});
