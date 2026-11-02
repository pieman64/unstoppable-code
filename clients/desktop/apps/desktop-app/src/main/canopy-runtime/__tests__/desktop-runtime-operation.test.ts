import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    domain: 'pipeline',
    kinds: ['core.pipeline.run'],
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
      kind: 'core.pipeline.run',
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
  // among them) and CAN-5517's fetch and pull.
  it('carries the local worker execution without opening the ledger', async () => {
    const { dispatcher } = runtime();
    try {
      expect([...dispatcher.localWorker.operations].sort()).toEqual([
        'worker.filesystem.entry.copy',
        'worker.filesystem.entry.delete',
        'worker.filesystem.entry.move',
        'worker.git.branch.create',
        'worker.git.branch.delete',
        'worker.git.branch.rename',
        'worker.git.checkout',
        'worker.git.fetch',
        'worker.git.pull',
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
});
