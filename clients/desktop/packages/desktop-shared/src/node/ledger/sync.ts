import {
  LedgerOpaqueIdSchema,
  type LedgerSyncState,
} from '@canopy/protocol/canopy-core';
import {
  LEDGER_SYNC_LIMITS,
  LedgerScopeAudienceSchema,
  LedgerSyncEventKindSchema,
  type LedgerScopeAudience,
} from '@canopy/protocol/ledger-sync';

import { LedgerStoreError } from './errors';
import { parseLedgerInput, parseStoredRecord } from './records';
import { parseLedgerIdInput } from './registrations';
import {
  rowInteger,
  rowNullableText,
  rowText,
  type LedgerSqlRow,
} from './rows';
import {
  LEDGER_SYNC_REPAIR_REASONS,
  type LedgerAcknowledgeOutboxInput,
  type LedgerOutboxEventRecord,
  type LedgerReadOutboxInput,
  type LedgerRebindAccountInput,
  type LedgerRecordMirrorAudienceInput,
  type LedgerScopeRecord,
  type LedgerScopeSyncRecord,
  type LedgerSetScopeRepairInput,
  type LedgerSyncRepairReason,
} from './types';

/*
 * The store's sync bookkeeping. It records what the mirror acknowledged and
 * confirmed, and reports each revision's state from that alone. Whether a
 * scope may sync at all is the host's decision, not kept here.
 */

const SEQUENCE_TEXT = /^(0|[1-9][0-9]{0,15})$/;

/** A scope's sync bookkeeping as stored. */
export interface LedgerStoredScopeSync {
  /** Highest scope sequence the mirror acknowledged. */
  readonly acknowledged: number;
  readonly mirrorAudience: LedgerScopeAudience | null;
  readonly audienceConfirmedAt: string | null;
  readonly repairReason: LedgerSyncRepairReason | null;
}

/** A scope with no stored row: nothing acknowledged, confirmed or broken. */
export const LEDGER_UNSYNCED_SCOPE: LedgerStoredScopeSync = {
  acknowledged: 0,
  mirrorAudience: null,
  audienceConfirmedAt: null,
  repairReason: null,
};

function repairReason(value: string | null): LedgerSyncRepairReason | null {
  if (value === null) return null;
  const reason = LEDGER_SYNC_REPAIR_REASONS.find(
    (candidate: LedgerSyncRepairReason): boolean => candidate === value,
  );
  if (reason === undefined) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_scope_sync',
    });
  }
  return reason;
}

export function scopeSyncFromRow(row: LedgerSqlRow): LedgerStoredScopeSync {
  const audience = rowNullableText(row, 'mirror_audience_json');
  return {
    acknowledged: rowInteger(row, 'acknowledged_sequence'),
    mirrorAudience:
      audience === null
        ? null
        : parseStoredRecord(LedgerScopeAudienceSchema, audience),
    audienceConfirmedAt: rowNullableText(row, 'audience_confirmed_at'),
    repairReason: repairReason(rowNullableText(row, 'repair_reason')),
  };
}

export function toScopeSyncRecord(
  scope: LedgerScopeRecord,
  sync: LedgerStoredScopeSync,
): LedgerScopeSyncRecord {
  return {
    scope,
    acknowledgedSequence: String(sync.acknowledged),
    mirrorAudience: sync.mirrorAudience,
    audienceConfirmedAt: sync.audienceConfirmedAt,
    repairReason: sync.repairReason,
  };
}

export function outboxEventFromRow(row: LedgerSqlRow): LedgerOutboxEventRecord {
  const entryRevision = row.entry_revision;
  return {
    eventId: rowText(row, 'event_id'),
    scopeSequence: String(rowInteger(row, 'scope_sequence')),
    kind: parseStoredKind(rowText(row, 'kind')),
    entryId: rowNullableText(row, 'entry_id'),
    entryRevision:
      entryRevision === null || entryRevision === undefined
        ? null
        : rowInteger(row, 'entry_revision'),
    occurredAt: rowText(row, 'occurred_at'),
    payloadHash: rowText(row, 'payload_hash'),
    payloadJson: rowText(row, 'payload_json'),
  };
}

function parseStoredKind(value: string): LedgerOutboxEventRecord['kind'] {
  const parsed = LedgerSyncEventKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_outbox_event',
    });
  }
  return parsed.data;
}

/**
 * Where the revision committed at `sequence` stands, from what the store
 * knows. A scope first used signed out never uploads. Otherwise a revision is
 * mirrored once the mirror acknowledged its sequence; until then it waits,
 * or needs repair when the scope stopped syncing. The host narrows `pending`
 * by its own policy.
 */
export function ledgerSyncStateAt(
  accountId: string | null,
  sequence: number,
  sync: LedgerStoredScopeSync,
): LedgerSyncState {
  if (accountId === null) return 'local_only';
  if (sequence <= sync.acknowledged) return 'mirrored';
  return sync.repairReason === null ? 'pending' : 'repair_needed';
}

function parseSequence(value: unknown, field: string): number {
  if (typeof value === 'string' && SEQUENCE_TEXT.test(value)) {
    const sequence = Number(value);
    if (Number.isSafeInteger(sequence)) return sequence;
  }
  throw new LedgerStoreError('INVALID_INPUT', { field });
}

export interface LedgerOutboxRead {
  readonly ledgerId: string;
  readonly afterSequence: number;
  readonly limit: number;
  /** Null for no byte budget. */
  readonly maxPayloadBytes: number | null;
}

export function parseReadOutboxInput(
  input: LedgerReadOutboxInput,
): LedgerOutboxRead {
  const limit: unknown = input.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LEDGER_SYNC_LIMITS.pushEventsMax
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'limit',
      limit: LEDGER_SYNC_LIMITS.pushEventsMax,
    });
  }
  const maxPayloadBytes: unknown = input.maxPayloadBytes;
  if (
    maxPayloadBytes !== undefined &&
    (typeof maxPayloadBytes !== 'number' ||
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes < 1)
  ) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'maxPayloadBytes' });
  }
  return {
    ledgerId: parseLedgerIdInput(input.ledgerId),
    afterSequence: parseSequence(input.afterSequence, 'afterSequence'),
    limit,
    maxPayloadBytes: maxPayloadBytes ?? null,
  };
}

/**
 * The leading events whose payloads fit the byte budget. The first event
 * always travels, so one large event cannot stall the scope.
 */
export function takeOutboxBatch(
  events: readonly LedgerOutboxEventRecord[],
  maxPayloadBytes: number | null,
): LedgerOutboxEventRecord[] {
  if (maxPayloadBytes === null) return [...events];
  const batch: LedgerOutboxEventRecord[] = [];
  let bytes = 0;
  for (const event of events) {
    bytes += Buffer.byteLength(event.payloadJson, 'utf8');
    if (batch.length > 0 && bytes > maxPayloadBytes) break;
    batch.push(event);
  }
  return batch;
}

export function parseAcknowledgeOutboxInput(
  input: LedgerAcknowledgeOutboxInput,
): { readonly ledgerId: string; readonly sequence: number } {
  return {
    ledgerId: parseLedgerIdInput(input.ledgerId),
    sequence: parseSequence(input.sequence, 'sequence'),
  };
}

export function parseMirrorAudienceInput(
  input: LedgerRecordMirrorAudienceInput,
): { readonly ledgerId: string; readonly audience: LedgerScopeAudience } {
  return {
    ledgerId: parseLedgerIdInput(input.ledgerId),
    audience: parseLedgerInput(
      LedgerScopeAudienceSchema,
      input.audience,
      'audience',
    ),
  };
}

export function parseScopeRepairInput(input: LedgerSetScopeRepairInput): {
  readonly ledgerId: string;
  readonly reason: LedgerSyncRepairReason | null;
} {
  const reason: unknown = input.reason;
  if (
    reason !== null &&
    !LEDGER_SYNC_REPAIR_REASONS.some(
      (candidate: LedgerSyncRepairReason): boolean => candidate === reason,
    )
  ) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'reason' });
  }
  return {
    ledgerId: parseLedgerIdInput(input.ledgerId),
    reason: input.reason,
  };
}

export function parseRebindAccountInput(input: LedgerRebindAccountInput): {
  readonly fromAccountId: string;
  readonly toAccountId: string;
} {
  const fromAccountId = parseLedgerInput(
    LedgerOpaqueIdSchema,
    input.fromAccountId,
    'fromAccountId',
  );
  const toAccountId = parseLedgerInput(
    LedgerOpaqueIdSchema,
    input.toAccountId,
    'toAccountId',
  );
  if (fromAccountId === toAccountId) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'toAccountId' });
  }
  return { fromAccountId, toAccountId };
}
