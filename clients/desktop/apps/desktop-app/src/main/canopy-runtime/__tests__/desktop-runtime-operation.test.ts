import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitiatedWorkExecution } from '@canopy/core-runtime/node/initiated-work';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

// CAN-4130: the desktop dispatcher serves core.operation.* in process over
// the durable operation ledger, which it opens only on first use.

const caller = (
  clientInstanceId: string,
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId,
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-operations-'));
  ledgerPath = join(dir, 'operations', 'operation-ledger.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runtime(): {
  adapter: ReturnType<typeof createCoreOperationAdapter>;
  dispatcher: ReturnType<typeof createDesktopRuntime>;
} {
  const adapter = createCoreOperationAdapter({ ledgerPath: () => ledgerPath });
  adapter.service.registerDomain({
    domain: 'example',
    kinds: ['core.example.run'],
    restartClass: 'lost',
    cancel: () => Promise.resolve('cancelled'),
  });
  return {
    adapter,
    dispatcher: createDesktopRuntime({
      operationAdapter: adapter,
      shutdownTimeoutMs: 25,
    }),
  };
}

describe('desktop dispatcher core.operation.*', () => {
  it('opens no ledger until an operation is used', async () => {
    const { dispatcher } = runtime();
    await dispatcher.shutdown();
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('denies a caller without the operation grant before the handler runs', async () => {
    const { dispatcher } = runtime();
    try {
      await expect(
        dispatcher.query(
          'core.operation.list',
          {},
          { caller: caller('window-1', ['core.operation.cancel']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.instruction(
          'core.operation.cancel',
          { operationId: 'op', reason: 'Stop' },
          { caller: caller('window-1', ['core.operation.read']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('lets one window observe work another started, cancel it, and find it after a restart', async () => {
    const first = runtime();
    const { operation } = await first.adapter.service.admit({
      kind: 'core.example.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'window-1' },
      owner: { kind: 'principal', id: 'local-desktop-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
      receipt: {
        caller: 'local-desktop-user',
        idempotencyKey: 'run-1',
        fingerprint: 'params',
      },
    });
    const read = { caller: caller('window-2', ['core.operation.read']) };
    try {
      await expect(
        first.dispatcher.query(
          'core.operation.get',
          { operationId: operation.operationId },
          read,
        ),
      ).resolves.toMatchObject({
        operation: { status: 'running', receipt: { idempotencyKey: 'run-1' } },
      });
      await expect(
        first.dispatcher.instruction(
          'core.operation.cancel',
          { operationId: operation.operationId, reason: 'Stop' },
          { caller: caller('window-2', ['core.operation.cancel']) },
        ),
      ).resolves.toMatchObject({
        outcome: 'cancelled',
        operation: { status: 'cancelled' },
      });
    } finally {
      await first.dispatcher.shutdown();
    }

    // Shutdown released the writer, so the next launch opens the ledger.
    const second = runtime();
    try {
      const listed = await second.dispatcher.query(
        'core.operation.list',
        {},
        read,
      );
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        operationId: operation.operationId,
        status: 'cancelled',
        cancellation: { requestedBy: 'local-desktop-user' },
      });
    } finally {
      await second.dispatcher.shutdown();
    }
  });

  // CAN-4132: the builtin local worker's dispatch records come with the
  // runtime. Its worker instructions are CAN-4108's Git branch changes, the
  // entry instructions (CAN-5502; file.write and directory.create are not
  // among them), CAN-5517's fetch and pull, and CAN-4143's script runs.
  it('carries the local worker execution without opening the ledger', async () => {
    const { dispatcher } = runtime();
    try {
      expect([...dispatcher.localWorker.operations].sort()).toEqual([
        'worker.codeGraph.build',
        'worker.codeGraph.build.cancel',
        'worker.codeGraph.buildQueue.update',
        'worker.codeGraph.builds.cancel',
        'worker.codeGraph.snapshot.import',
        'worker.filesystem.entry.copy',
        'worker.filesystem.entry.delete',
        'worker.filesystem.entry.move',
        'worker.git.branch.create',
        'worker.git.branch.delete',
        'worker.git.branch.rename',
        'worker.git.checkout',
        'worker.git.fetch',
        'worker.git.pull',
        'worker.pipeline.execution.cancel',
        'worker.pipeline.execution.resume',
        'worker.pipeline.execution.retry',
        'worker.pipeline.execution.start',
        'worker.pipeline.hostRequest.respond',
        'worker.pipeline.matrixJob.retry',
        'worker.pipeline.matrixVariant.cancel',
        'worker.pipeline.recovery.checkpoint',
        'worker.pipeline.recovery.sweep',
        'worker.script.execute',
        'worker.script.execution.cancel',
      ]);
      await expect(
        dispatcher.localWorker.dispatch({
          parentOperationId: 'parent',
          operation: 'worker.example.write',
          params: {},
          idempotencyKey: 'step-1',
        }),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      await dispatcher.shutdown();
    }
  });

  // CAN-4144: hook firings are initiated-work runs another client can see
  // and cancel through core.operation.*.
  it('lets another window observe and cancel an initiated-work run', async () => {
    const { dispatcher } = runtime();
    try {
      let signal: AbortSignal | null = null;
      const run = dispatcher.initiatedWork.submit<string>({
        origin: { kind: 'hook', sourceId: 'project:pr:create' },
        owner: { kind: 'organization', id: 'org-1' },
        scope: { workspaceId: 'alpha', worktreeId: 'main' },
        targetKey: 'alpha/main/project',
        gates: [],
        execute: (control) =>
          new Promise<InitiatedWorkExecution<string>>((resolve) => {
            signal = control.signal;
            control.signal.addEventListener('abort', () =>
              resolve({
                value: 'stopped',
                result: { status: 'failed', exitCode: null, durationMs: 1 },
              }),
            );
          }),
      });
      const read = { caller: caller('window-2', ['core.operation.read']) };
      let listed = await dispatcher.query('core.operation.list', {}, read);
      for (let attempt = 0; listed.items[0]?.status !== 'running'; attempt++) {
        if (attempt > 50) throw new Error('the run never started');
        await new Promise((resolve) => setImmediate(resolve));
        listed = await dispatcher.query('core.operation.list', {}, read);
      }
      const [operation] = listed.items;
      expect(operation).toMatchObject({
        kind: 'core.initiatedWork.run',
        origin: { kind: 'hook', sourceId: 'project:pr:create' },
      });
      const watching = await dispatcher.openStream(
        'core.operation.events',
        {
          operationIds: [operation?.operationId ?? ''],
          cursor: listed.eventsCursor,
        },
        read,
      );
      const seen: string[] = [];
      watching.onFrame((frame) => {
        if (frame.kind === 'item')
          seen.push(`${frame.item.event}:${frame.item.operation.status}`);
      });
      await expect(
        dispatcher.instruction(
          'core.operation.cancel',
          { operationId: operation?.operationId ?? '', reason: 'Stop' },
          { caller: caller('window-2', ['core.operation.cancel']) },
        ),
      ).resolves.toMatchObject({ outcome: 'requested' });
      expect(signal).not.toBeNull();
      await expect(run).resolves.toMatchObject({
        disposition: 'ran',
        cancelled: true,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual(['cancelRequested:running', 'cancelled:cancelled']);
      watching.close();
      await expect(
        dispatcher.query(
          'core.operation.get',
          { operationId: operation?.operationId ?? '' },
          read,
        ),
      ).resolves.toMatchObject({
        operation: {
          status: 'cancelled',
          cancellation: { requestedBy: 'local-desktop-user', reason: 'Stop' },
        },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });
});
