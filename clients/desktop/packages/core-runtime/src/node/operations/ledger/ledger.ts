import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  CanopyJsonValueSchema,
  CanopyWorkspaceScopeSchema,
  DelegationLeaseRecordSchema,
  DelegationRecordSchema,
  ExecutionTargetRecordSchema,
  UNSETTLED_DELEGATION_STATES,
  OperationCancellationSchema,
  OperationEventTypeSchema,
  OperationFailureSchema,
  OperationOriginSchema,
  OperationOwnerSchema,
  OperationRecordSchema,
  OperationRestartSchema,
  OperationStatusSchema,
  isTerminalOperationStatus,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type CanopyWorkspaceScope,
  type DelegationDispatchInput,
  type DelegationLeaseRecord,
  type DelegationLeaseTerms,
  type DelegationRecord,
  type DelegationResolution,
  type ExecutionTargetRecord,
  type ExecutionTargetRegistration,
  type OperationCancellation,
  type OperationEventType,
  type OperationOrigin,
  type OperationOwner,
  type OperationRecord,
  type OperationRestart,
  type OperationStatus,
  type OperationTerminalStatus,
} from '@canopy/protocol/canopy-core';

import { KEYED_RECEIPT_RETRY_WINDOW_MS } from '../../../kernel/keyed-receipt';
import { openOperationLedgerDatabase } from './database';
import { OperationLedgerError, OperationLedgerRefusedError } from './errors';

export const OPERATION_LEDGER_COMPACTION_BATCH_SIZE = 100;
export const OPERATION_LEDGER_COMPACTION_INTERVAL = 100;
export const OPERATION_LEDGER_EVENTS_PAGE_MAX = 500;

export type OperationNonTerminalStatus = Exclude<
  OperationStatus,
  OperationTerminalStatus
>;

/**
 * A keyed request's identity. The operation kind completes the key, as the
 * operation name does for a W5 receipt.
 */
export interface OperationReceiptInput {
  caller: string;
  idempotencyKey: string;
  /** A digest of the request parameters the key is bound to. */
  fingerprint: string;
}

export interface OperationAcceptRequest {
  kind: string;
  /** `running` when the domain starts the work as soon as it is accepted. */
  status?: 'queued' | 'running';
  receipt?: OperationReceiptInput;
  origin: OperationOrigin;
  owner: OperationOwner;
  scope?: CanopyWorkspaceScope;
  parentOperationId?: string;
  authorityId?: string | null;
  executionTargetId?: string | null;
  runtimeDelegationId?: string | null;
}

export interface OperationLedgerEvent {
  sequence: number;
  event: OperationEventType;
  previousStatus: OperationStatus | null;
  occurredAt: string;
  operation: OperationRecord;
}

export interface OperationChange {
  operation: OperationRecord;
  /** Null when the call changed nothing. */
  event: OperationLedgerEvent | null;
}

export type OperationReceiptLookup =
  | { status: 'none' }
  | { status: 'key-reused' }
  | {
      status: 'in-progress' | 'replay' | 'replay-expired';
      operation: OperationRecord;
    };

export type OperationAcceptResult =
  | {
      status: 'accepted';
      operation: OperationRecord;
      event: OperationLedgerEvent;
    }
  | {
      status: 'in-progress' | 'replay' | 'replay-expired';
      operation: OperationRecord;
    };

/** A dispatch and its child operation, changed in one transaction. */
export interface DelegationChange {
  delegation: DelegationRecord;
  /** The child operation's change; its event is null when it changed nothing. */
  change: OperationChange;
}

export interface OperationListQuery {
  scope?: CanopyWorkspaceScope;
  statuses?: readonly OperationStatus[];
  kinds?: readonly string[];
  parentOperationId?: string;
  limit: number;
  /** The last item of the previous page; pages run newest first. */
  after?: { createdAt: string; operationId: string };
}

export interface OperationListPage {
  items: OperationRecord[];
  next: { createdAt: string; operationId: string } | null;
}

export interface OperationLedgerOptions {
  openBusyTimeoutMs?: number;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  retryWindowMs?: number;
}

const SCOPE_COLUMNS = [
  ['organizationId', 'organization_id'],
  ['workspaceId', 'workspace_id'],
  ['worktreeId', 'worktree_id'],
  ['chatId', 'chat_id'],
  ['executionId', 'execution_id'],
  ['repoId', 'repo_id'],
  ['authorityId', 'authority_id'],
  ['targetId', 'execution_target_id'],
] as const satisfies ReadonlyArray<
  readonly [keyof CanopyWorkspaceScope, string]
>;

type Row = Record<string, SQLInputValue>;

function asInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new OperationLedgerError(
    'STORAGE_UNAVAILABLE',
    'Unexpected column value.',
  );
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new OperationLedgerError(
    'STORAGE_UNAVAILABLE',
    'Unexpected column value.',
  );
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asInteger(value);
}

/**
 * JSON columns hold values this ledger wrote from validated input. They are
 * parsed again on read, so a damaged row fails loudly instead of leaking.
 */
function parseColumn<T>(schema: { parse(value: unknown): T }, text: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'An operation record is unreadable.',
      error,
    );
  }
}

function parseNullableColumn<T>(
  schema: { parse(value: unknown): T },
  text: string | null,
): T | null {
  return text === null ? null : parseColumn(schema, text);
}

function asStatus(value: unknown): OperationStatus {
  return parseColumn(OperationStatusSchema, JSON.stringify(asText(value)));
}

function toRecord(row: Row): OperationRecord {
  const completedAt = asNullableText(row.completed_at);
  return {
    operationId: asText(row.operation_id),
    kind: asText(row.kind),
    status: asStatus(row.status),
    revision: asInteger(row.revision),
    parentOperationId: asNullableText(row.parent_operation_id),
    rootOperationId: asText(row.root_operation_id),
    authorityId: asNullableText(row.authority_id),
    executionTargetId: asNullableText(row.execution_target_id),
    runtimeDelegationId: asNullableText(row.runtime_delegation_id),
    scope: parseColumn(CanopyWorkspaceScopeSchema, asText(row.scope_json)),
    origin: parseColumn(OperationOriginSchema, asText(row.origin_json)),
    owner: parseColumn(OperationOwnerSchema, asText(row.owner_json)),
    receipt: {
      idempotencyKey: asNullableText(row.idempotency_key),
      acceptedAt: asText(row.created_at),
      outcome:
        completedAt === null
          ? 'pending'
          : asInteger(row.outcome_expired) === 1
            ? 'expired'
            : 'recorded',
    },
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    completedAt,
    progress: asNullableNumber(row.progress),
    outcome: parseNullableColumn(
      CanopyJsonValueSchema,
      asNullableText(row.outcome_json),
    ),
    error: parseNullableColumn(
      OperationFailureSchema,
      asNullableText(row.error_json),
    ),
    cancellation: parseNullableColumn(
      OperationCancellationSchema,
      asNullableText(row.cancellation_json),
    ),
    restart: parseNullableColumn(
      OperationRestartSchema,
      asNullableText(row.restart_json),
    ),
  };
}

function toEvent(row: Row): OperationLedgerEvent {
  const previous = asNullableText(row.previous_status);
  return {
    sequence: asInteger(row.sequence),
    event: parseColumn(
      OperationEventTypeSchema,
      JSON.stringify(asText(row.event)),
    ),
    previousStatus: previous === null ? null : asStatus(previous),
    occurredAt: asText(row.occurred_at),
    operation: parseColumn(OperationRecordSchema, asText(row.record_json)),
  };
}

/** Changes a write makes to one operation row. */
interface OperationPatch {
  status?: OperationStatus;
  progress?: number | null;
  outcome?: CanopyJsonValue | null;
  error?: CanopyErrorPayload | null;
  cancellation?: OperationCancellation | null;
  restart?: OperationRestart | null;
  /** Whether this process now runs the operation. */
  claim?: boolean;
}

/**
 * The durable operation ledger (CAN-4130): one record per unit of accepted
 * work, whichever domain runs it, with its lineage, origin, accountable
 * owner, retry receipt, cancellation intent, restart reconciliation and
 * terminal outcome, plus an ordered log of lifecycle events.
 *
 * Acceptance commits the record and its idempotency key in one SQLite
 * transaction before the caller acknowledges anything, so a retry after a
 * lost acknowledgement finds the record instead of starting the work again.
 * Records carry the run epoch of the process that last ran them; a later
 * process lists the others as interrupted and reconciles them by their
 * domain's restart class.
 *
 * Synchronous, on one exclusively held connection.
 */
export class OperationLedger {
  readonly ledgerId: string;
  /** This process's run; records it runs carry it. */
  readonly runEpoch: string;
  private writesSinceCompaction = 0;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => number,
    private readonly retryWindowMs: number,
  ) {
    this.ledgerId = this.meta('ledger_id');
    this.runEpoch = randomUUID();
  }

  static open(
    databasePath: string,
    options: OperationLedgerOptions = {},
  ): OperationLedger {
    const retryWindowMs =
      options.retryWindowMs ?? KEYED_RECEIPT_RETRY_WINDOW_MS;
    if (!Number.isFinite(retryWindowMs) || retryWindowMs < 0)
      throw new RangeError(
        'The operation retry window must be finite and nonnegative.',
      );
    return new OperationLedger(
      openOperationLedgerDatabase(databasePath, options.openBusyTimeoutMs),
      options.clock ?? Date.now,
      retryWindowMs,
    );
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** The connection, for an online backup taken by the same writer. */
  get connection(): DatabaseSync {
    return this.db;
  }

  get(operationId: string): OperationRecord | null {
    const row = this.row(operationId);
    return row ? toRecord(row) : null;
  }

  /**
   * What a keyed request should do before any effect: replay a finished
   * operation's outcome, observe one still in progress, or refuse a key
   * reused with other parameters.
   */
  lookupReceipt(
    kind: string,
    receipt: OperationReceiptInput,
  ): OperationReceiptLookup {
    const row = this.db
      .prepare(
        `SELECT * FROM operations
          WHERE caller = ? AND kind = ? AND idempotency_key = ?`,
      )
      .get(receipt.caller, kind, receipt.idempotencyKey);
    if (!row) return { status: 'none' };
    if (asText(row.fingerprint) !== receipt.fingerprint)
      return { status: 'key-reused' };
    let operation = toRecord(row);
    if (!isTerminalOperationStatus(operation.status))
      return { status: 'in-progress', operation };
    // Compaction runs in batches; a receipt past its window is expired here
    // too, so an idle ledger never replays an outcome it should have dropped.
    if (
      operation.receipt.outcome === 'recorded' &&
      operation.completedAt !== null &&
      Date.parse(operation.completedAt) < this.clock() - this.retryWindowMs
    ) {
      const id = operation.operationId;
      this.transaction(() => this.expireOutcomes([id]));
      operation = this.get(id) ?? operation;
    }
    return {
      status:
        operation.receipt.outcome === 'expired' ? 'replay-expired' : 'replay',
      operation,
    };
  }

  /**
   * Accept work. In one transaction: a keyed request whose key is already
   * held returns that operation instead (its recorded outcome, or the work
   * still in progress); otherwise the record, its receipt and a `queued` or
   * `started` event are committed together.
   */
  accept(request: OperationAcceptRequest): OperationAcceptResult {
    const result = this.transaction((): OperationAcceptResult => {
      if (request.receipt) {
        const lookup = this.lookupReceipt(request.kind, request.receipt);
        if (lookup.status === 'key-reused')
          throw new OperationLedgerRefusedError(
            'key-reused',
            'This request was already made with different details.',
          );
        if (lookup.status !== 'none') return lookup;
      }
      let rootOperationId: string | null = null;
      if (request.parentOperationId !== undefined) {
        const parent = this.get(request.parentOperationId);
        if (!parent)
          throw new OperationLedgerRefusedError(
            'unknown-parent',
            'The parent operation does not exist.',
            { parentOperationId: request.parentOperationId },
          );
        if (isTerminalOperationStatus(parent.status) || parent.cancellation)
          throw new OperationLedgerRefusedError(
            'invalid-state',
            'The parent operation is finished or being cancelled.',
            { parentOperationId: parent.operationId, status: parent.status },
          );
        rootOperationId = parent.rootOperationId;
      }
      const operationId = randomUUID();
      const now = this.now();
      const status = request.status ?? 'queued';
      const scope = request.scope ?? {};
      const columns: Row = {
        operation_id: operationId,
        kind: request.kind,
        status,
        revision: 1,
        parent_operation_id: request.parentOperationId ?? null,
        root_operation_id: rootOperationId ?? operationId,
        authority_id: request.authorityId ?? scope.authorityId ?? null,
        execution_target_id:
          request.executionTargetId ?? scope.targetId ?? null,
        runtime_delegation_id: request.runtimeDelegationId ?? null,
        scope_json: JSON.stringify(scope),
        organization_id: scope.organizationId ?? null,
        workspace_id: scope.workspaceId ?? null,
        worktree_id: scope.worktreeId ?? null,
        chat_id: scope.chatId ?? null,
        execution_id: scope.executionId ?? null,
        repo_id: scope.repoId ?? null,
        origin_json: JSON.stringify(request.origin),
        owner_json: JSON.stringify(request.owner),
        caller: request.receipt?.caller ?? null,
        idempotency_key: request.receipt?.idempotencyKey ?? null,
        fingerprint: request.receipt?.fingerprint ?? null,
        run_epoch: this.runEpoch,
        created_at: now,
        updated_at: now,
      };
      const names = Object.keys(columns);
      this.db
        .prepare(
          `INSERT INTO operations (${names.join(', ')})
           VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...names.map((name) => columns[name]));
      const operation = this.require(operationId);
      return {
        status: 'accepted',
        operation,
        event: this.recordEvent(
          operation,
          status === 'running' ? 'started' : 'queued',
          null,
        ),
      };
    });
    if (result.status === 'accepted') this.afterWrite();
    return result;
  }

  /**
   * Move unfinished work between `queued`, `running` and `paused`. The
   * process that moves it takes it over (its run epoch).
   */
  transition(
    operationId: string,
    status: OperationNonTerminalStatus,
    options: { expectedRevision?: number; restart?: OperationRestart } = {},
  ): OperationChange {
    return this.write(operationId, options.expectedRevision, (current) => {
      this.requireUnfinished(current);
      if (current.status === status && !options.restart) return null;
      return {
        patch: {
          status,
          claim: true,
          ...(options.restart ? { restart: options.restart } : {}),
        },
        event:
          status === 'running'
            ? current.status === 'paused'
              ? 'resumed'
              : 'started'
            : status,
      };
    });
  }

  /** Record progress; no lifecycle event. */
  reportProgress(operationId: string, progress: number): OperationRecord {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1)
      throw new RangeError('Progress must be between 0 and 1.');
    return this.write(operationId, undefined, (current) => {
      this.requireUnfinished(current);
      return { patch: { progress }, event: null };
    }).operation;
  }

  /**
   * Record the terminal outcome. Finishing again with the same status is a
   * no-op; any other change to a finished operation is refused.
   */
  finish(
    operationId: string,
    terminal: {
      status: OperationTerminalStatus;
      outcome?: CanopyJsonValue;
      error?: CanopyErrorPayload;
      restart?: OperationRestart;
    },
  ): OperationChange {
    return this.write(operationId, undefined, (current) => {
      if (isTerminalOperationStatus(current.status)) {
        if (current.status === terminal.status) return null;
        this.requireUnfinished(current);
      }
      return {
        patch: {
          status: terminal.status,
          outcome:
            terminal.status === 'completed' ? (terminal.outcome ?? null) : null,
          error: terminal.status === 'failed' ? (terminal.error ?? null) : null,
          ...(terminal.restart ? { restart: terminal.restart } : {}),
        },
        event: terminal.status,
      };
    });
  }

  /**
   * Record that someone asked to cancel unfinished work, before the owning
   * domain is told. A repeated request, or one for finished work, changes
   * nothing.
   */
  requestCancel(
    operationId: string,
    cancellation: OperationCancellation,
    options: { expectedRevision?: number } = {},
  ): OperationChange {
    return this.write(operationId, options.expectedRevision, (current) => {
      if (isTerminalOperationStatus(current.status) || current.cancellation)
        return null;
      return { patch: { cancellation }, event: 'cancelRequested' };
    });
  }

  /** The owning domain refused a recorded cancellation; drop the intent. */
  withdrawCancel(operationId: string): OperationChange {
    return this.write(operationId, undefined, (current) => {
      if (isTerminalOperationStatus(current.status) || !current.cancellation)
        return null;
      return { patch: { cancellation: null }, event: 'cancelRefused' };
    });
  }

  /**
   * Record how a restart left interrupted work: still unfinished (paused,
   * waiting for its domain) or finished. Writes one `reconciled` event.
   */
  reconcile(
    operationId: string,
    result:
      | { status: 'paused'; restart: OperationRestart; claim: boolean }
      | {
          status: OperationTerminalStatus;
          restart: OperationRestart;
          error?: CanopyErrorPayload;
        },
  ): OperationChange {
    return this.write(operationId, undefined, (current) => {
      this.requireUnfinished(current);
      if (result.status === 'paused')
        return {
          patch: {
            status: 'paused',
            restart: result.restart,
            claim: result.claim,
          },
          event: 'reconciled',
        };
      return {
        patch: {
          status: result.status,
          restart: result.restart,
          error: result.status === 'failed' ? (result.error ?? null) : null,
          outcome: null,
        },
        event: 'reconciled',
      };
    });
  }

  /**
   * Register an execution target, or confirm the registered row matches.
   * A target's identity never changes once registered.
   */
  registerTarget(target: ExecutionTargetRegistration): ExecutionTargetRecord {
    return this.transaction(() => {
      const existing = this.getTarget(target.targetId);
      if (existing) {
        const registered = ExecutionTargetRecordSchema.parse({
          ...target,
          registeredAt: existing.registeredAt,
        });
        if (JSON.stringify(registered) !== JSON.stringify(existing))
          throw new OperationLedgerRefusedError(
            'invalid-state',
            'This execution target is registered differently.',
            { targetId: target.targetId },
          );
        return existing;
      }
      const record = ExecutionTargetRecordSchema.parse({
        ...target,
        registeredAt: this.now(),
      });
      this.db
        .prepare(
          `INSERT INTO execution_targets (target_id, record_json, registered_at)
           VALUES (?, ?, ?)`,
        )
        .run(record.targetId, JSON.stringify(record), record.registeredAt);
      return record;
    });
  }

  getTarget(targetId: string): ExecutionTargetRecord | null {
    const text = this.db
      .prepare('SELECT record_json FROM execution_targets WHERE target_id = ?')
      .get(targetId)?.record_json;
    return text === undefined
      ? null
      : parseColumn(ExecutionTargetRecordSchema, asText(text));
  }

  /**
   * This run's delegation lease on a registered target, acquired on first
   * use. Leases earlier runs held end with them: they are released, and
   * their unsettled dispatches settle as the restart left their children.
   */
  acquireLease(
    targetId: string,
    terms: DelegationLeaseTerms,
  ): DelegationLeaseRecord {
    return this.transaction(() => {
      if (!this.getTarget(targetId))
        throw new OperationLedgerRefusedError(
          'not-found',
          'This execution target is not registered.',
          { targetId },
        );
      const now = this.now();
      const earlier = this.db
        .prepare(
          `SELECT record_json FROM delegation_leases
            WHERE target_id = ? AND run_epoch != ? AND released_at IS NULL`,
        )
        .all(targetId, this.runEpoch)
        .map((row) =>
          parseColumn(DelegationLeaseRecordSchema, asText(row.record_json)),
        );
      for (const lease of earlier) {
        this.writeLease({
          ...lease,
          releasedAt: now,
          releaseReason: 'process-ended',
        });
        for (const delegation of this.unsettledDelegations(lease.leaseId)) {
          const child = this.require(delegation.childOperationId);
          this.writeDelegation({
            ...delegation,
            state: isTerminalOperationStatus(child.status)
              ? child.status
              : 'unreachable',
            resolution: 'restart',
            settledAt: isTerminalOperationStatus(child.status) ? now : null,
            updatedAt: now,
          });
        }
      }
      const held = this.db
        .prepare(
          `SELECT record_json FROM delegation_leases
            WHERE target_id = ? AND run_epoch = ?`,
        )
        .get(targetId, this.runEpoch)?.record_json;
      if (held !== undefined)
        return parseColumn(DelegationLeaseRecordSchema, asText(held));
      const lease = DelegationLeaseRecordSchema.parse({
        leaseId: randomUUID(),
        targetId,
        ...terms,
        runEpoch: this.runEpoch,
        acquiredAt: now,
        expiresAt:
          terms.ttlMs === null
            ? null
            : new Date(this.clock() + terms.ttlMs).toISOString(),
        releasedAt: null,
        releaseReason: null,
      });
      this.db
        .prepare(
          `INSERT INTO delegation_leases
             (lease_id, target_id, run_epoch, acquired_at, record_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          lease.leaseId,
          lease.targetId,
          lease.runEpoch,
          lease.acquiredAt,
          JSON.stringify(lease),
        );
      return lease;
    });
  }

  getLease(leaseId: string): DelegationLeaseRecord | null {
    const text = this.db
      .prepare('SELECT record_json FROM delegation_leases WHERE lease_id = ?')
      .get(leaseId)?.record_json;
    return text === undefined
      ? null
      : parseColumn(DelegationLeaseRecordSchema, asText(text));
  }

  /**
   * Accept a delegated child operation and record its dispatch in one
   * transaction, before anything is sent to the target. A retry with the
   * child's receipt key returns the recorded child and its dispatch.
   */
  acceptDispatch(
    request: OperationAcceptRequest & {
      parentOperationId: string;
      runtimeDelegationId: string;
    },
    dispatch: DelegationDispatchInput,
  ): { result: OperationAcceptResult; delegation: DelegationRecord } {
    return this.transaction(() => {
      if (request.runtimeDelegationId !== dispatch.delegationId)
        throw new RangeError('The child must name its own delegation.');
      const lease = this.getLease(dispatch.leaseId);
      if (
        !lease ||
        lease.targetId !== dispatch.targetId ||
        lease.runEpoch !== this.runEpoch ||
        lease.releasedAt !== null
      )
        throw new OperationLedgerRefusedError(
          'invalid-state',
          'The delegation lease is not held by this run.',
          { leaseId: dispatch.leaseId },
        );
      const result = this.accept({
        ...request,
        executionTargetId: dispatch.targetId,
      });
      if (result.status !== 'accepted') {
        const recorded = this.delegationForChild(result.operation.operationId);
        if (!recorded)
          throw new OperationLedgerRefusedError(
            'invalid-state',
            'This operation was not dispatched.',
            { operationId: result.operation.operationId },
          );
        return { result, delegation: recorded };
      }
      const now = this.now();
      const delegation = DelegationRecordSchema.parse({
        ...dispatch,
        parentOperationId: request.parentOperationId,
        childOperationId: result.operation.operationId,
        rootOperationId: result.operation.rootOperationId,
        state: 'prepared',
        resolution: null,
        createdAt: now,
        dispatchedAt: null,
        settledAt: null,
        updatedAt: now,
      });
      this.db
        .prepare(
          `INSERT INTO delegations
             (delegation_id, parent_operation_id, child_operation_id,
              target_id, lease_id, state, record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          delegation.delegationId,
          delegation.parentOperationId,
          delegation.childOperationId,
          delegation.targetId,
          delegation.leaseId,
          delegation.state,
          JSON.stringify(delegation),
        );
      return { result, delegation };
    });
  }

  /** The prepared dispatch goes to its target; its child starts running. */
  markDispatched(delegationId: string): DelegationChange {
    return this.transaction(() => {
      const delegation = this.requireDelegation(delegationId);
      if (delegation.state !== 'prepared')
        throw new OperationLedgerRefusedError(
          'invalid-state',
          'This dispatch was already sent.',
          { delegationId, state: delegation.state },
        );
      const change = this.transition(delegation.childOperationId, 'running');
      const now = this.now();
      return {
        delegation: this.writeDelegation({
          ...delegation,
          state: 'dispatched',
          dispatchedAt: now,
          updatedAt: now,
        }),
        change,
      };
    });
  }

  /** The reply is unknown, or the target cannot be asked for it. */
  markDelegation(
    delegationId: string,
    state: 'reconciling' | 'unreachable',
  ): DelegationRecord {
    return this.transaction(() => {
      const delegation = this.requireDelegation(delegationId);
      if (
        !UNSETTLED_DELEGATION_STATES.some(
          (unsettled) => unsettled === delegation.state,
        )
      )
        throw new OperationLedgerRefusedError(
          'invalid-state',
          'This dispatch has already settled.',
          { delegationId, state: delegation.state },
        );
      if (delegation.state === state) return delegation;
      return this.writeDelegation({
        ...delegation,
        state,
        updatedAt: this.now(),
      });
    });
  }

  /**
   * Settle a dispatch and finish its child in one transaction. A child that
   * already finished, cancelled by its domain for instance, keeps its own
   * terminal state and the dispatch mirrors it.
   */
  settleDispatch(
    delegationId: string,
    settlement: {
      status: OperationTerminalStatus;
      outcome?: CanopyJsonValue;
      error?: CanopyErrorPayload;
      resolution: DelegationResolution;
    },
  ): DelegationChange {
    return this.transaction(() => {
      const delegation = this.requireDelegation(delegationId);
      const { resolution, ...terminal } = settlement;
      const current = this.require(delegation.childOperationId);
      const change = isTerminalOperationStatus(current.status)
        ? { operation: current, event: null }
        : this.finish(delegation.childOperationId, terminal);
      const status = change.operation.status;
      if (!isTerminalOperationStatus(status))
        throw new OperationLedgerError(
          'STORAGE_UNAVAILABLE',
          'A settled dispatch left its child unfinished.',
        );
      if (
        !UNSETTLED_DELEGATION_STATES.some(
          (unsettled) => unsettled === delegation.state,
        )
      )
        return { delegation, change };
      const now = this.now();
      return {
        delegation: this.writeDelegation({
          ...delegation,
          state: status,
          resolution,
          settledAt: now,
          updatedAt: now,
        }),
        change,
      };
    });
  }

  getDelegation(delegationId: string): DelegationRecord | null {
    const text = this.db
      .prepare('SELECT record_json FROM delegations WHERE delegation_id = ?')
      .get(delegationId)?.record_json;
    return text === undefined
      ? null
      : parseColumn(DelegationRecordSchema, asText(text));
  }

  delegationForChild(childOperationId: string): DelegationRecord | null {
    const text = this.db
      .prepare(
        'SELECT record_json FROM delegations WHERE child_operation_id = ?',
      )
      .get(childOperationId)?.record_json;
    return text === undefined
      ? null
      : parseColumn(DelegationRecordSchema, asText(text));
  }

  /** A parent's dispatches, oldest first. */
  listDelegations(parentOperationId: string): DelegationRecord[] {
    return this.db
      .prepare(
        `SELECT record_json FROM delegations WHERE parent_operation_id = ?
          ORDER BY rowid`,
      )
      .all(parentOperationId)
      .map((row) =>
        parseColumn(DelegationRecordSchema, asText(row.record_json)),
      );
  }

  private unsettledDelegations(leaseId: string): DelegationRecord[] {
    return this.db
      .prepare(
        `SELECT record_json FROM delegations
          WHERE lease_id = ? AND state IN (${UNSETTLED_DELEGATION_STATES.map(() => '?').join(', ')})
          ORDER BY rowid`,
      )
      .all(leaseId, ...UNSETTLED_DELEGATION_STATES)
      .map((row) =>
        parseColumn(DelegationRecordSchema, asText(row.record_json)),
      );
  }

  private requireDelegation(delegationId: string): DelegationRecord {
    const delegation = this.getDelegation(delegationId);
    if (!delegation)
      throw new OperationLedgerRefusedError(
        'not-found',
        'This dispatch does not exist.',
        { delegationId },
      );
    return delegation;
  }

  private writeDelegation(delegation: DelegationRecord): DelegationRecord {
    const record = DelegationRecordSchema.parse(delegation);
    this.db
      .prepare(
        `UPDATE delegations SET state = ?, record_json = ?
          WHERE delegation_id = ?`,
      )
      .run(record.state, JSON.stringify(record), record.delegationId);
    return record;
  }

  private writeLease(lease: DelegationLeaseRecord): void {
    const record = DelegationLeaseRecordSchema.parse(lease);
    this.db
      .prepare(
        `UPDATE delegation_leases SET released_at = ?, record_json = ?
          WHERE lease_id = ?`,
      )
      .run(record.releasedAt, JSON.stringify(record), record.leaseId);
  }

  /** Unfinished direct children, oldest first. */
  listActiveChildren(operationId: string): OperationRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM operations
          WHERE parent_operation_id = ?
            AND status IN ('queued', 'running', 'paused')
          ORDER BY rowid`,
      )
      .all(operationId)
      .map(toRecord);
  }

  /** Unfinished work last run by an earlier process, oldest first. */
  listInterrupted(): OperationRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM operations
          WHERE status IN ('queued', 'running', 'paused') AND run_epoch != ?
          ORDER BY rowid`,
      )
      .all(this.runEpoch)
      .map(toRecord);
  }

  /** Unfinished work of these kinds, oldest first. */
  listUnfinished(kinds: readonly string[]): OperationRecord[] {
    if (kinds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT * FROM operations
          WHERE status IN ('queued', 'running', 'paused')
            AND kind IN (${kinds.map(() => '?').join(', ')})
          ORDER BY rowid`,
      )
      .all(...kinds)
      .map(toRecord);
  }

  list(query: OperationListQuery): OperationListPage {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [field, column] of SCOPE_COLUMNS) {
      const value = query.scope?.[field];
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      values.push(value);
    }
    if (query.scope?.operationId !== undefined) {
      where.push('operation_id = ?');
      values.push(query.scope.operationId);
    }
    if (query.statuses?.length) {
      where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
      values.push(...query.statuses);
    }
    if (query.kinds?.length) {
      where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
      values.push(...query.kinds);
    }
    if (query.parentOperationId !== undefined) {
      where.push('parent_operation_id = ?');
      values.push(query.parentOperationId);
    }
    if (query.after) {
      where.push('(created_at, operation_id) < (?, ?)');
      values.push(query.after.createdAt, query.after.operationId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM operations
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC, operation_id DESC
          LIMIT ?`,
      )
      .all(...values, query.limit + 1);
    const items = rows.slice(0, query.limit).map(toRecord);
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > query.limit && last
          ? { createdAt: last.createdAt, operationId: last.operationId }
          : null,
    };
  }

  /** The newest event sequence; 0 before the first event. */
  eventsHead(): number {
    const row = this.db
      .prepare(
        `SELECT seq FROM sqlite_sequence WHERE name = 'operation_events'`,
      )
      .get();
    return row ? asInteger(row.seq) : 0;
  }

  /** A cursor at or after this sequence can resume without a gap. */
  eventsResumableFrom(): number {
    return Number(this.meta('events_pruned_through'));
  }

  eventsAfter(
    sequence: number,
    limit = OPERATION_LEDGER_EVENTS_PAGE_MAX,
  ): OperationLedgerEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM operation_events WHERE sequence > ?
          ORDER BY sequence LIMIT ?`,
      )
      .all(sequence, limit)
      .map(toEvent);
  }

  /**
   * One bounded batch, at open and every 100 writes: outcomes finished
   * longer ago than the retry window are dropped, and so are their events.
   * Identities, receipts and terminal states are never removed. Unfinished
   * work is ineligible.
   */
  compact(): number {
    const cutoff = new Date(this.clock() - this.retryWindowMs).toISOString();
    const expired = this.transaction(() => {
      const ids = this.db
        .prepare(
          `SELECT operation_id FROM operations
            WHERE completed_at IS NOT NULL AND outcome_expired = 0
              AND completed_at < ?
            ORDER BY completed_at, operation_id LIMIT ?`,
        )
        .all(cutoff, OPERATION_LEDGER_COMPACTION_BATCH_SIZE)
        .map((row) => asText(row.operation_id));
      if (ids.length === 0) return 0;
      this.expireOutcomes(ids);
      return ids.length;
    });
    this.writesSinceCompaction = 0;
    return expired;
  }

  /** Drop these finished operations' outcomes and their events. */
  private expireOutcomes(ids: readonly string[]): void {
    const list = ids.map(() => '?').join(', ');
    this.db
      .prepare(
        `UPDATE operations SET outcome_json = NULL, outcome_expired = 1
          WHERE operation_id IN (${list})`,
      )
      .run(...ids);
    // A cursor below any deleted event would miss it on resume, so the
    // resumable floor is the newest deleted sequence, not the end of a
    // contiguous gap.
    const pruned = this.db
      .prepare(
        `SELECT MAX(sequence) AS sequence FROM operation_events
          WHERE operation_id IN (${list})`,
      )
      .get(...ids)?.sequence;
    this.db
      .prepare(`DELETE FROM operation_events WHERE operation_id IN (${list})`)
      .run(...ids);
    if (pruned !== null && pruned !== undefined)
      this.db
        .prepare(
          `UPDATE operation_meta SET value = ?
            WHERE key = 'events_pruned_through' AND CAST(value AS INTEGER) < ?`,
        )
        .run(String(asInteger(pruned)), asInteger(pruned));
  }

  private write(
    operationId: string,
    expectedRevision: number | undefined,
    decide: (
      current: OperationRecord,
    ) => { patch: OperationPatch; event: OperationEventType | null } | null,
  ): OperationChange {
    const result = this.transaction((): OperationChange => {
      const current = this.require(operationId);
      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      )
        throw new OperationLedgerRefusedError(
          'revision-conflict',
          'This operation changed since it was read.',
          { operationId, currentRevision: current.revision },
        );
      const decision = decide(current);
      if (!decision) return { operation: current, event: null };
      const { patch } = decision;
      const now = this.now();
      const sets: string[] = ['revision = revision + 1', 'updated_at = ?'];
      const values: SQLInputValue[] = [now];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        values.push(patch.status);
        if (isTerminalOperationStatus(patch.status)) {
          sets.push('completed_at = ?');
          values.push(now);
        }
      }
      if (patch.progress !== undefined) {
        sets.push('progress = ?');
        values.push(patch.progress);
      }
      if (patch.outcome !== undefined) {
        sets.push('outcome_json = ?');
        values.push(
          patch.outcome === null ? null : JSON.stringify(patch.outcome),
        );
      }
      const json = [
        ['error', 'error_json'],
        ['cancellation', 'cancellation_json'],
        ['restart', 'restart_json'],
      ] as const;
      for (const [field, column] of json) {
        const value = patch[field];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value === null ? null : JSON.stringify(value));
      }
      if (patch.claim) {
        sets.push('run_epoch = ?');
        values.push(this.runEpoch);
      }
      this.db
        .prepare(
          `UPDATE operations SET ${sets.join(', ')} WHERE operation_id = ?`,
        )
        .run(...values, operationId);
      const operation = this.require(operationId);
      return {
        operation,
        event:
          decision.event === null
            ? null
            : this.recordEvent(operation, decision.event, current.status),
      };
    });
    if (result.event) this.afterWrite();
    return result;
  }

  private recordEvent(
    operation: OperationRecord,
    event: OperationEventType,
    previousStatus: OperationStatus | null,
  ): OperationLedgerEvent {
    const sequence = asInteger(
      this.db
        .prepare(
          `INSERT INTO operation_events
             (operation_id, event, previous_status, occurred_at, record_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          event,
          previousStatus,
          operation.updatedAt,
          JSON.stringify(operation),
        ).lastInsertRowid,
    );
    return {
      sequence,
      event,
      previousStatus,
      occurredAt: operation.updatedAt,
      operation,
    };
  }

  private requireUnfinished(current: OperationRecord): void {
    if (isTerminalOperationStatus(current.status))
      throw new OperationLedgerRefusedError(
        'invalid-state',
        'This operation has already finished.',
        { operationId: current.operationId, status: current.status },
      );
  }

  private row(operationId: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM operations WHERE operation_id = ?')
      .get(operationId);
  }

  private require(operationId: string): OperationRecord {
    const row = this.row(operationId);
    if (!row)
      throw new OperationLedgerRefusedError(
        'not-found',
        'This operation does not exist.',
        { operationId },
      );
    return toRecord(row);
  }

  private meta(key: string): string {
    return asText(
      this.db.prepare('SELECT value FROM operation_meta WHERE key = ?').get(key)
        ?.value,
    );
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private afterWrite(): void {
    this.writesSinceCompaction += 1;
    if (this.writesSinceCompaction >= OPERATION_LEDGER_COMPACTION_INTERVAL)
      this.compact();
  }

  private transaction<T>(run: () => T): T {
    // A step of a larger transaction commits with it.
    if (this.db.isTransaction) return run();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
