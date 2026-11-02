import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '../../../registry';
import { OPERATION_ERROR_CODES, OperationErrorSchema } from '../operations';
import {
  CoreOperationCancelParamsSchema,
  CoreOperationEventsParamsSchema,
  CoreOperationListParamsSchema,
  OperationRecordSchema,
  isTerminalOperationStatus,
  type OperationRecord,
} from '../schemas';

const record: OperationRecord = {
  operationId: 'op-1',
  kind: 'core.pipeline.run',
  status: 'failed',
  revision: 3,
  parentOperationId: null,
  rootOperationId: 'op-1',
  authorityId: null,
  executionTargetId: 'in_process_worker',
  runtimeDelegationId: null,
  scope: { workspaceId: 'alpha', worktreeId: 'main' },
  origin: { kind: 'hook', sourceId: 'hook-1', occurrenceKey: 'push:abc' },
  owner: { kind: 'organization', id: 'org-1' },
  receipt: {
    idempotencyKey: 'run-1',
    acceptedAt: '2026-10-27T10:00:00.000Z',
    outcome: 'recorded',
  },
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:05:00.000Z',
  completedAt: '2026-10-27T10:05:00.000Z',
  progress: null,
  outcome: null,
  error: {
    kind: 'failed_precondition',
    code: 'core.operation.interrupted',
    message: 'A restart interrupted this operation.',
    retry: { kind: 'never' },
  },
  cancellation: null,
  restart: {
    class: 'lost',
    disposition: 'lost',
    reconciledAt: '2026-10-27T10:05:00.000Z',
  },
};

describe('core.operation contracts', () => {
  it('registers four core-only operations behind the read and cancel grants', () => {
    expect(CANOPY_QUERY_DEFINITIONS['core.operation.get']).toMatchObject({
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.operation.read'],
    });
    expect(CANOPY_QUERY_DEFINITIONS['core.operation.list']).toMatchObject({
      requiredGrants: ['core.operation.read'],
    });
    expect(
      CANOPY_INSTRUCTION_DEFINITIONS['core.operation.cancel'],
    ).toMatchObject({
      idempotency: 'inherent',
      requiredGrants: ['core.operation.cancel'],
    });
    expect(CANOPY_STREAM_DEFINITIONS['core.operation.events']).toMatchObject({
      requiredGrants: ['core.operation.read'],
    });
  });

  it('carries owner, receipt and restart fields and rejects unknown ones', () => {
    expect(OperationRecordSchema.parse(record)).toEqual(record);
    expect(
      OperationRecordSchema.safeParse({ ...record, host: '/Users/x' }).success,
    ).toBe(false);
    for (const kind of ['pipeline.run', 'core.core.run', 'worker.worker.step'])
      expect(OperationRecordSchema.safeParse({ ...record, kind }).success).toBe(
        false,
      );
    expect(
      OperationRecordSchema.safeParse({
        ...record,
        error: { ...record.error, code: 'core.core.interrupted' },
      }).success,
    ).toBe(false);
    expect(
      OperationRecordSchema.safeParse({
        ...record,
        receipt: { ...record.receipt, outcome: 'lost' },
      }).success,
    ).toBe(false);
  });

  it('bounds requests and never accepts caller identity in params', () => {
    expect(
      CoreOperationListParamsSchema.safeParse({ pageSize: 501 }).success,
    ).toBe(false);
    expect(
      CoreOperationCancelParamsSchema.safeParse({
        operationId: 'op-1',
        reason: 'Stop',
        requestedBy: 'someone',
      }).success,
    ).toBe(false);
    expect(
      CoreOperationEventsParamsSchema.safeParse({
        operationIds: [],
      }).success,
    ).toBe(false);
  });

  it('declares typed error codes', () => {
    for (const code of Object.values(OPERATION_ERROR_CODES))
      expect(
        OperationErrorSchema.safeParse({
          kind: 'failed_precondition',
          message: 'x',
          code,
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      OperationErrorSchema.safeParse({
        kind: 'failed_precondition',
        message: 'x',
        code: 'core.pipeline.other',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });

  it('classifies terminal statuses', () => {
    expect(
      (
        [
          'queued',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled',
        ] as const
      ).filter(isTerminalOperationStatus),
    ).toEqual(['completed', 'failed', 'cancelled']);
  });
});
