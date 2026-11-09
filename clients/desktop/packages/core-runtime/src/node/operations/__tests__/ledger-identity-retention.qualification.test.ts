import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { createCoreOperationHandlers, OperationService } from '..';
import {
  OPERATION_LEDGER_COMPACTION_BATCH_SIZE,
  OPERATION_LEDGER_COMPACTION_INTERVAL,
  OperationLedger,
  type OperationAcceptRequest,
  type OperationLedgerRetentionResult,
} from '../ledger';

const DAY = 24 * 60 * 60 * 1_000;
const RETRY_WINDOW = DAY;
const RETENTION = 3 * DAY;
const DIGEST = `sha256:${'0'.repeat(64)}`;
const context: CanopyHandlerContext = {
  requestId: 'r',
  caller: {
    principalId: 'p',
    clientInstanceId: 'c',
    authorityId: 'a',
    interfaceKind: 'desktop',
    grants: [],
  },
  metadata: {},
  signal: new AbortController().signal,
};

let dir: string;
let now: number;
let ledger: OperationLedger;
let retention: OperationLedgerRetentionResult[];

function base(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: 'core.helper.run',
    status: 'running',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

function accepted(request: OperationAcceptRequest): string {
  const result = ledger.accept(request);
  if (result.status !== 'accepted') throw new Error('Expected a new operation');
  return result.operation.operationId;
}

interface HelperTree {
  root: string;
  child: string;
  delegationId: string;
  helperRunId: string;
}

/** A helper run as `core-helper-runs.ts` and `local-worker.ts` record it. */
function helperTree(
  options: {
    keyedRoot?: boolean;
    settleChild?: boolean;
    leaveDelegationUnsettled?: boolean;
  } = {},
): HelperTree {
  ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
  const lease = ledger.acquireLease(
    IN_PROCESS_WORKER_TARGET.targetId,
    IN_PROCESS_LEASE_TERMS,
  );
  const root = accepted(
    base(
      options.keyedRoot === true
        ? {
            receipt: {
              caller: 'local-user',
              idempotencyKey: randomUUID(),
              fingerprint: 'params',
            },
          }
        : {},
    ),
  );
  const delegationId = randomUUID();
  const helperRunId = randomUUID();
  const { result } = ledger.acceptDispatch(
    {
      kind: 'worker.agent.helper.run',
      status: 'queued',
      receipt: {
        caller: `core.delegation:${root}`,
        idempotencyKey: helperRunId,
        fingerprint: DIGEST,
      },
      origin: { kind: 'delegation', sourceId: root },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
      parentOperationId: root,
      runtimeDelegationId: delegationId,
    },
    {
      delegationId,
      targetId: lease.targetId,
      leaseId: lease.leaseId,
      operation: {
        name: 'worker.agent.helper.run',
        version: 1,
        idempotency: 'keyed',
      },
      idempotencyKey: helperRunId,
      executorKey: delegationId,
      activation: { delivery: 'inline-parameters', digest: DIGEST },
      secrets: [],
    },
  );
  ledger.markDispatched(delegationId);
  if (options.leaveDelegationUnsettled === true) {
    ledger.finish(result.operation.operationId, {
      status: 'completed',
      outcome: { title: 'done' },
    });
    ledger.markDelegation(delegationId, 'unreachable');
  } else if (options.settleChild !== false) {
    ledger.settleDispatch(delegationId, {
      status: 'completed',
      outcome: { title: 'done' },
      resolution: 'reply',
    });
  }
  ledger.finish(root, { status: 'completed', outcome: { title: 'done' } });
  return {
    root,
    child: result.operation.operationId,
    delegationId,
    helperRunId,
  };
}

function exists(operationId: string): boolean {
  return ledger.get(operationId) !== null;
}

/** Past the horizon, outcomes expired, then one retention batch. */
function ageAndPrune(days = 4): void {
  now += days * DAY;
  ledger.compact();
  ledger.compact({ pruneIdentities: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-retention-'));
  now = Date.parse('2026-11-08T10:00:00.000Z');
  retention = [];
  ledger = OperationLedger.open(
    join(dir, 'operations', 'operation-ledger.sqlite'),
    {
      clock: () => now,
      retryWindowMs: RETRY_WINDOW,
      identityRetentionMs: RETENTION,
      onIdentityRetention: (result): void => {
        retention.push(result);
      },
    },
  );
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('operation ledger identity retention (CAN-5721)', () => {
  it('deletes a settled unkeyed helper-run tree past the horizon, with its dispatch and events', () => {
    const tree = helperTree();
    const floor = ledger.eventsResumableFrom();
    ageAndPrune();
    expect(exists(tree.root)).toBe(false);
    expect(exists(tree.child)).toBe(false);
    expect(ledger.getDelegation(tree.delegationId)).toBeNull();
    expect(
      ledger
        .eventsAfter(0)
        .filter(
          (event) =>
            event.operation.operationId === tree.root ||
            event.operation.operationId === tree.child,
        ),
    ).toEqual([]);
    expect(ledger.eventsResumableFrom()).toBeGreaterThanOrEqual(floor);
    expect(retention).toEqual([{ status: 'pruned', operations: 2 }]);
  });

  it('answers core.operation.get not found and leaves a deleted tree out of core.operation.list', async () => {
    const tree = helperTree();
    const kept = helperTree({ keyedRoot: true });
    ageAndPrune();
    const service = new OperationService({
      openLedger: (): OperationLedger => ledger,
    });
    const handlers = createCoreOperationHandlers(service);
    await expect(
      handlers.queries['core.operation.get'](
        { operationId: tree.root },
        context,
      ),
    ).rejects.toBeInstanceOf(CanopyOperationError);
    const page = await handlers.queries['core.operation.list'](
      { kinds: ['core.helper.run'] },
      context,
    );
    expect(page.items.map((item) => item.operationId)).toEqual([kept.root]);
  });

  it('uses an index for tree lookups, built off the open path on ledgers that predate it and never replaced by a scan', () => {
    const plan = (): string =>
      ledger.connection
        .prepare(
          `EXPLAIN QUERY PLAN
            SELECT operation_id FROM operations WHERE root_operation_id = ?`,
        )
        .all('root')
        .map((row) => String(row.detail))
        .join('\n');
    const retentionIndexes = (): string[] =>
      ledger.connection
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
            AND name IN ('operations_by_root', 'operations_roots_by_kind')
            ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name));
    expect(plan()).toContain('operations_by_root');
    expect(retentionIndexes()).toHaveLength(2);
    const tree = helperTree();
    ledger.connection.exec('DROP INDEX operations_by_root');
    ledger.connection.exec('DROP INDEX operations_roots_by_kind');
    ledger.close();
    ledger = OperationLedger.open(
      join(dir, 'operations', 'operation-ledger.sqlite'),
      {
        clock: () => now,
        retryWindowMs: RETRY_WINDOW,
        identityRetentionMs: RETENTION,
        onIdentityRetention: (result): void => {
          retention.push(result);
        },
      },
    );
    expect(plan()).not.toContain('operations_by_root');
    expect(retentionIndexes()).toEqual([]);
    ageAndPrune();
    expect(plan()).toContain('operations_by_root');
    expect(retentionIndexes()).toEqual([
      'operations_by_root',
      'operations_roots_by_kind',
    ]);
    expect(exists(tree.root)).toBe(true);
    expect(retention.map((result) => result.status)).toEqual(['indexed']);
    ledger.compact({ pruneIdentities: true });
    expect(exists(tree.root)).toBe(false);
  });

  it('never deletes in the compaction that runs at open', () => {
    const tree = helperTree();
    now += 4 * DAY;
    ledger.compact();
    ledger.compact();
    expect(exists(tree.root)).toBe(true);
    expect(exists(tree.child)).toBe(true);
    expect(retention).toEqual([]);
  });

  it('deletes through the compaction every write batch triggers, at most one batch at a time', () => {
    const trees = Array.from(
      { length: OPERATION_LEDGER_COMPACTION_BATCH_SIZE + 1 },
      () => helperTree(),
    );
    now += 4 * DAY;
    ledger.compact();
    ledger.compact();
    for (let i = 0; i < OPERATION_LEDGER_COMPACTION_INTERVAL; i += 1)
      accepted(base({ kind: 'core.pipeline.run', status: 'queued' }));
    expect(trees.filter((tree) => exists(tree.root))).toHaveLength(1);
    expect(retention).toContainEqual({
      status: 'pruned',
      operations: 2 * OPERATION_LEDGER_COMPACTION_BATCH_SIZE,
    });
  });

  it('runs a batch whose write count lands inside a dispatch transaction once it commits', () => {
    const old = helperTree();
    now += 4 * DAY;
    ledger.compact();
    ledger.compact();
    accepted(base({ kind: 'core.pipeline.run', status: 'queued' }));
    for (let i = 0; i < OPERATION_LEDGER_COMPACTION_INTERVAL; i += 1)
      helperTree();
    expect(exists(old.root)).toBe(false);
    expect(exists(old.child)).toBe(false);
  });

  it('keeps a tree inside the horizon', () => {
    const tree = helperTree();
    ageAndPrune(2);
    expect(exists(tree.root)).toBe(true);
    expect(exists(tree.child)).toBe(true);
  });

  it('keeps a keyed root, whose receipt a caller could still replay', () => {
    const tree = helperTree({ keyedRoot: true });
    ageAndPrune();
    expect(exists(tree.root)).toBe(true);
    expect(exists(tree.child)).toBe(true);
  });

  it('keeps hook-chat start claims, which must never be re-created', () => {
    const receipt = {
      caller: 'core.initiatedWork.hookChat',
      idempotencyKey: 'hook-chat-claim-1',
      fingerprint: 'claim',
    };
    const claim = accepted(
      base({ kind: 'core.initiatedWork.hookChat', receipt }),
    );
    ledger.finish(claim, { status: 'completed', outcome: { chatId: 'c1' } });
    ageAndPrune();
    expect(exists(claim)).toBe(true);
    expect(
      ledger.lookupReceipt('core.initiatedWork.hookChat', receipt).status,
    ).toBe('replay-expired');
  });

  it('keeps cancelled queued hook entries, which must never come back', () => {
    for (const kind of [
      'core.initiatedWork.queuedHookChat',
      'core.initiatedWork.queuedHookPipeline',
    ]) {
      const receipt = {
        caller: 'core.initiatedWork.hookQueue',
        idempotencyKey: `${kind}-entry-1`,
        fingerprint: 'entry',
      };
      const entry = accepted(base({ kind, status: 'queued', receipt }));
      ledger.finish(entry, { status: 'cancelled' });
      ageAndPrune();
      expect(exists(entry)).toBe(true);
      expect(ledger.lookupReceipt(kind, receipt).status).toBe('replay-expired');
    }
  });

  it('keeps a tree whose dispatch is unsettled', () => {
    const tree = helperTree({ leaveDelegationUnsettled: true });
    ageAndPrune();
    expect(exists(tree.root)).toBe(true);
    expect(ledger.getDelegation(tree.delegationId)?.state).toBe('unreachable');
  });

  it('keeps a tree with one non-terminal row', () => {
    const tree = helperTree({ settleChild: false });
    ageAndPrune();
    expect(exists(tree.root)).toBe(true);
    expect(ledger.get(tree.child)?.status).toBe('running');
  });

  it('keeps a tree with one row finished inside the horizon', () => {
    const tree = helperTree({ settleChild: false });
    now += 2 * DAY;
    ledger.settleDispatch(tree.delegationId, {
      status: 'completed',
      outcome: { title: 'late' },
      resolution: 'reply',
    });
    ageAndPrune(2);
    expect(exists(tree.root)).toBe(true);
    expect(exists(tree.child)).toBe(true);
  });

  it('never replays a deleted helper run into a second side effect', () => {
    const tree = helperTree();
    ageAndPrune();
    const lease = ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    const delegationId = randomUUID();
    let refused: unknown = null;
    try {
      ledger.acceptDispatch(
        {
          kind: 'worker.agent.helper.run',
          status: 'queued',
          receipt: {
            caller: `core.delegation:${tree.root}`,
            idempotencyKey: tree.helperRunId,
            fingerprint: DIGEST,
          },
          origin: { kind: 'delegation', sourceId: tree.root },
          owner: { kind: 'principal', id: 'local-user' },
          scope: { workspaceId: 'alpha', worktreeId: 'main' },
          parentOperationId: tree.root,
          runtimeDelegationId: delegationId,
        },
        {
          delegationId,
          targetId: lease.targetId,
          leaseId: lease.leaseId,
          operation: {
            name: 'worker.agent.helper.run',
            version: 1,
            idempotency: 'keyed',
          },
          idempotencyKey: tree.helperRunId,
          executorKey: delegationId,
          activation: { delivery: 'inline-parameters', digest: DIGEST },
          secrets: [],
        },
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ refusal: 'unknown-parent' });
    expect(ledger.getDelegation(delegationId)).toBeNull();
    expect(
      ledger.list({ kinds: ['worker.agent.helper.run'], limit: 10 }).items,
    ).toEqual([]);
  });
});
