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
  cancelScheduledCodeGraphBuilds,
  setScheduledCodeGraphBuildRuntimeForTests,
  startScheduledCodeGraphBuild,
  type ScheduledCodeGraphBuild,
  type ScheduledCodeGraphBuildRuntime,
} from '../code-graph/scheduled-builds';

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
  } as unknown as ScheduledCodeGraphBuildRuntime;
  setScheduledCodeGraphBuildRuntimeForTests(runtime);
}

function scheduled(
  overrides: Partial<ScheduledCodeGraphBuild> = {},
): ScheduledCodeGraphBuild {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    trigger: 'refresh',
    refreshSource: 'diff-stats',
    observedFingerprint: 'a'.repeat(64),
    observedFingerprintMs: 12,
    available: () => true,
    canceled: () => false,
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
  dir = mkdtempSync(join(tmpdir(), 'code-graph-scheduled-builds-'));
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  engine = new InitiatedWorkEngine({ operations });
  dispatches = [];
  build = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
    kind: 'worktree',
  });
  useRuntime();
});

afterEach(() => {
  setScheduledCodeGraphBuildRuntimeForTests(null);
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduled code-graph builds as initiated work', () => {
  it('records an accepted build and dispatches a background worker.codeGraph.build', async () => {
    const onStarted = jest.fn();

    await expect(
      startScheduledCodeGraphBuild(scheduled({ onStarted })),
    ).resolves.toBe('succeeded');

    const run = await onlyRun();
    expect(run.status).toBe('completed');
    expect(run.origin).toEqual({
      kind: 'system',
      sourceId: 'code-graph.scheduler',
      context: { trigger: 'refresh', refreshSource: 'diff-stats' },
    });
    expect(run.owner.kind).toBe('system');
    expect(run.scope).toEqual({
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
    });
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
    expect(onStarted).toHaveBeenCalledTimes(1);

    expect(dispatches).toEqual([
      {
        name: 'worker.codeGraph.build',
        params: {
          graphScope: {
            kind: 'worktree',
            workspaceId: 'project-1',
            worktreeId: 'worktree-1',
            mode: 'incremental',
            background: {
              trigger: 'refresh',
              observedFingerprint: { value: 'a'.repeat(64), observedMs: 12 },
            },
          },
        },
        idempotencyKey: run.operationId,
      },
    ]);
    // The request is one the operation accepts.
    expect(
      WorkerCodeGraphBuildParamsSchema.safeParse(dispatches[0]?.params).success,
    ).toBe(true);
  });

  it('records a skipped run and builds nothing when the code graph is off', async () => {
    const onStarted = jest.fn();

    await expect(
      startScheduledCodeGraphBuild(
        scheduled({ available: () => false, onStarted }),
      ),
    ).resolves.toBe('skipped');

    const run = await onlyRun();
    expect(run.status).toBe('completed');
    const record = recordOf(run);
    expect(record?.disposition).toBe('skipped');
    expect(record?.gates.at(-1)).toEqual(
      expect.objectContaining({ gate: 'pause', decision: 'skipped' }),
    );
    expect(dispatches).toEqual([]);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('records a skipped run when cleanup canceled the worktree after its fingerprint read', async () => {
    await expect(
      startScheduledCodeGraphBuild(scheduled({ canceled: () => true })),
    ).resolves.toBe('skipped');

    const record = recordOf(await onlyRun());
    expect(record?.disposition).toBe('skipped');
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
    'records a build the worker refused as %s',
    async (status, refusal) => {
      build.mockRejectedValueOnce(refusal);

      await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
        status,
      );

      const run = await onlyRun();
      expect(run.status).toBe('completed');
      const record = recordOf(run);
      expect(record?.result?.status).toBe(status);
      expect(record?.disposition).toBe(
        status === 'stopped' ? 'skipped' : 'ran',
      );
    },
  );

  it('records the scheduler cancel on the run', async () => {
    let rejectBuild: (error: unknown) => void = () => undefined;
    build.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectBuild = reject;
        }),
    );

    const outcome = startScheduledCodeGraphBuild(scheduled());
    while (build.mock.calls.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    cancelScheduledCodeGraphBuilds(
      'project-1',
      'worktree-1',
      "This worktree's graph builds were canceled.",
    );
    // The scheduler's own cancel stops the worker build.
    rejectBuild(codeGraphBuildCanceledError());

    await expect(outcome).resolves.toBe('cancelled');
    const run = await onlyRun();
    expect(run.status).toBe('cancelled');
    expect(run.cancellation?.reason).toBe(
      "This worktree's graph builds were canceled.",
    );
    expect(dispatches.map(({ name }) => name)).toEqual([
      'worker.codeGraph.build',
    ]);
  });

  it("ends a run another client cancelled once its build settles, leaving the worker's queue alone", async () => {
    let resolveBuild: (value: unknown) => void = () => undefined;
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }),
    );

    const outcome = startScheduledCodeGraphBuild(scheduled());
    while (build.mock.calls.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const run = await onlyRun();
    await operations.cancel(run.operationId, {
      requestedBy: 'another-client',
      reason: 'Not now.',
    });
    // The worker may share this build with other callers for the worktree.
    resolveBuild({ kind: 'worktree' });

    await expect(outcome).resolves.toBe('cancelled');
    expect((await onlyRun()).status).toBe('cancelled');
    expect(dispatches.map(({ name }) => name)).toEqual([
      'worker.codeGraph.build',
    ]);
  });

  it('starts nothing and records nothing without an accepting runtime', async () => {
    setScheduledCodeGraphBuildRuntimeForTests(null);

    await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
      'not-started',
    );

    expect(await runs()).toEqual([]);
    expect(dispatches).toEqual([]);
  });
});
