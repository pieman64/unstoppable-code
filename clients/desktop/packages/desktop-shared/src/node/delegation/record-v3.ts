import {
  CardStateDraftSchema,
  type CardStateDraft,
} from '@canopy/protocol/canopy-core';
import { createHash } from 'node:crypto';
import {
  AGENT_DELEGATION_INPUT_LIMITS,
  DELEGATION_APPLY_FAILURE_LIMITS,
  DELEGATION_APPLY_FAILURE_REASONS,
  DELEGATION_APPLY_ISSUE_REASONS,
  DELEGATION_CAPABILITY_KINDS,
  DELEGATION_CAPABILITY_LIMITS,
  DELEGATION_CAPABILITY_SOURCES,
  DELEGATION_CAPABILITY_SKIP_REASONS,
  isDelegationStopReason,
  isDelegationStoppedBy,
  parseAgentDelegationSpawnRequest,
  type AgentDelegationSnapshot,
  type AgentDelegationError,
  type AgentDelegationErrorCode,
  type AgentDelegationStatus,
  type AgentDelegationUsage,
  type DelegateSettledStatus,
} from '@canopy/protocol/delegation';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import {
  DELEGATION_CAPABILITY_GRANT_LIMITS,
  isDelegationCapabilityId,
} from './capability-grant';
import {
  DelegationReadMetadataError,
  validateDelegationRecordReadMetadata,
  type DelegationRecordIdentity,
  type DelegationRecordReadMetadata,
} from './record-read-metadata';
import {
  validateDelegationReceiptEntry,
  type DelegationReceiptReplyV1,
} from './receipt-reply';
import {
  canonicalDelegationJson,
  delegationTranscriptSettlementDigest,
} from './settlement-identity';
import {
  delegationControlSchema,
  delegationHistorySchema,
  delegationMessageAuthorSchema,
  delegationResultsSchema,
  isStoredSnapshot,
} from './storage';
import type {
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptReceipt,
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptSettlementOutcome,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptTarget,
} from './transcript-port';
import type {
  StoredDelegationControl,
  StoredDelegationLegacy,
  StoredDelegationMessageReceipt,
  StoredDelegateOutput,
} from './broker';

const MAX_PREVIEW_CHARACTERS = 4096;
const MAX_LEGACY_TEXT_CHARACTERS = 16 * 1024 * 1024;
const MAX_RECEIPTS = 64;
export const MAX_V3_LATEST_RECEIPT_ITEMS = 64;
export const MAX_V3_LATEST_RECEIPT_BYTES = 16 * 1024;
const MAX_APPLY_FILES = 2048;
const MAX_LEGACY_APPLY_CONTENT_CHARACTERS = 65_536;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATUSES: readonly AgentDelegationStatus[] = [
  'pending',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
];
const SETTLED_STATUSES: readonly DelegateSettledStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
];
const ERROR_CODES: readonly AgentDelegationErrorCode[] = [
  'invalid_request',
  'capability_unavailable',
  'route_unavailable',
  'auth_required',
  'interaction_required',
  'policy_blocked',
  'capacity_exceeded',
  'parent_unavailable',
  'launch_uncertain',
  'runtime_error',
  'apply_failed',
  'terminated_by_parent',
];

/** State without transcript history; text fields are preview-bounded by codec. */
type StoredDelegationV3State = Omit<
  StoredDelegationLegacy['state'],
  'transcript'
>;

/** The operational control is current metadata, not a second replay snapshot. */
export type StoredDelegationV3Control = Omit<
  StoredDelegationControl,
  'firstOutcome' | 'firstError'
>;

/** Fixed, read-only legacy material retained when a record is promoted. */
export type LegacyDelegationPrefix = Pick<
  StoredDelegationLegacy,
  | 'history'
  | 'results'
  | 'control'
  | 'controls'
  | 'userMessageReceipts'
  | 'stopRequested'
  | 'stopRequests'
>;

export type V3CommandReceiptEntry = Omit<
  DelegationTranscriptReceiptEntry,
  'receiptKind' | 'reply'
> & {
  readonly receiptKind: 'command';
  readonly reply: Extract<
    DelegationReceiptReplyV1,
    { readonly kind: 'command' }
  >;
};

export type V3StopReceiptEntry = Omit<
  DelegationTranscriptReceiptEntry,
  'receiptKind' | 'reply'
> & {
  readonly receiptKind: 'stop';
  readonly reply: Extract<DelegationReceiptReplyV1, { readonly kind: 'stop' }>;
};

export type V3StopOutcomeEntry = Omit<
  DelegationTranscriptReceiptEntry,
  'receiptKind' | 'reply'
> & {
  readonly receiptKind: 'stop_outcome';
  readonly reply: Extract<
    DelegationReceiptReplyV1,
    { readonly kind: 'stop_outcome' }
  >;
};

/**
 * D10: bounded, append-only acknowledgement windows plus the active stop slot.
 * Only an admitted resume (an `ok` first acknowledgement) clears `stopFence`,
 * in the same commit as that acknowledgement; a refused or failed-first resume
 * keeps it. New operations take `nextV3ReceiptAdmissionTime`, so a clearing
 * resume is strictly later than every stop it clears.
 */
export interface V3ReceiptState {
  readonly commandReceipts: readonly V3CommandReceiptEntry[];
  readonly stopReceipts: readonly V3StopReceiptEntry[];
  readonly activeStop?: {
    readonly operationId: string;
    readonly runGeneration: number | null;
    readonly admittedAt: number;
    readonly pendingTerminalOutcome?: V3StopOutcomeEntry;
  };
  readonly stopFence?: {
    readonly operationId: string;
    readonly status: 'accepted' | 'completed' | 'failed';
  };
}

/** A newly admitted operation's time: after every receipt in both windows. */
export function nextV3ReceiptAdmissionTime(
  receipts: Pick<V3ReceiptState, 'commandReceipts' | 'stopReceipts'>,
  now: number,
): number {
  let latest = -1;
  for (const receipt of receipts.commandReceipts)
    latest = Math.max(latest, receipt.admittedAt);
  for (const receipt of receipts.stopReceipts)
    latest = Math.max(latest, receipt.admittedAt);
  return Math.max(now, latest + 1);
}

export type StoredDelegationV3Registration = Pick<
  DelegationTranscriptGenerationRegistration,
  'runGeneration' | 'createdAt' | 'origin' | 'executionMode'
> & { readonly store: 'stream' };

export type StoredDelegationV3Answer =
  | 'none'
  | { readonly role: 'final' | 'partial'; readonly empty: true }
  | {
      readonly role: 'final' | 'partial';
      readonly sha256: string;
      readonly length: number;
    };

export interface StoredDelegationV3Settling {
  readonly runGeneration: number;
  readonly settlementKey: string;
  readonly assertedResultIndex: number;
  readonly outcome: DelegationTranscriptSettlementOutcome;
  readonly answer: StoredDelegationV3Answer;
  readonly expectedSettlementDigest: string;
}

/** Notification metadata only; answer bodies remain in the transcript store. */
export interface StoredDelegationV3ResultLocator {
  readonly resultIndex: number;
  readonly runGeneration: number;
  readonly status: StoredDelegateOutput['status'];
  readonly settledAt: number;
  readonly stopReason?: StoredDelegateOutput['stopReason'];
  /** Set once `onSettled` returned; absent means restart re-notifies. */
  readonly notified?: true;
}

export interface StoredCardPublication {
  readonly runGeneration: number;
  readonly cardRevision: number;
  readonly promptAmended: boolean;
  readonly draft: Omit<CardStateDraft, 'prompt'>;
}

/**
 * Version 3 keeps current execution metadata and previews bounded while old
 * history stays under one immutable prefix. It deliberately has no transcript,
 * history, result-body array, or body-bearing firstOutcome in the current part.
 */
export type StoredDelegationV3 = Omit<
  StoredDelegationLegacy,
  | 'version'
  | 'state'
  | 'history'
  | 'results'
  | 'control'
  | 'controls'
  | 'userMessageReceipts'
  | 'stopRequested'
  | 'stopRequests'
> & {
  readonly version: 3;
  readonly state: StoredDelegationV3State;
  readonly control?: StoredDelegationV3Control;
  readonly readMetadata: DelegationRecordReadMetadata;
  readonly latestReceipt?: DelegationTranscriptReceipt;
  readonly latestResult?: StoredDelegationV3ResultLocator;
  readonly settling?: StoredDelegationV3Settling;
  readonly registration: StoredDelegationV3Registration;
  readonly receipts: V3ReceiptState;
  readonly legacyPrefix?: LegacyDelegationPrefix;
  readonly cardPublication?: StoredCardPublication;
};

/** D5 settlement key. Its canonical JSON shape is a versioned identity. */
export function delegationSettlementKey(
  chatId: string,
  delegationId: string,
  runGeneration: number,
): string {
  return createHash('sha256')
    .update(
      canonicalDelegationJson([
        'canopy.delegation.settlement.v1',
        chatId,
        delegationId,
        runGeneration,
      ]),
      'utf8',
    )
    .digest('hex');
}

/** D9 target-only stop identity; reason text is intentionally excluded. */
export function delegationStopRequestHash(delegationId: string): string {
  return createHash('sha256')
    .update(
      canonicalDelegationJson({ v: 1, operation: 'stop', delegationId }),
      'utf8',
    )
    .digest('hex');
}

/** Strict v3 decoder. Existing v1/v2 records stay on their existing codec. */
export function decodeStoredDelegationV3(value: unknown): StoredDelegationV3 {
  if (!isStoredDelegationV3(value))
    throw new DelegationReadMetadataError('Invalid delegation record');
  return value;
}

/** Stable JSON encoding; JSON.stringify preserves the frozen prefix verbatim. */
export function encodeStoredDelegationV3(record: StoredDelegationV3): string {
  const checked = decodeStoredDelegationV3(record);
  const encoded = JSON.stringify(checked);
  if (encoded === undefined)
    throw new DelegationReadMetadataError('Invalid delegation record');
  return encoded;
}

/** v1/v2 never acquire a capsule by projection or recovery. */
export function readMetadataOfRecord(
  record: unknown,
): DelegationRecordReadMetadata | undefined {
  if (!isRecord(record))
    throw new DelegationReadMetadataError('Invalid delegation record');
  if (record.version === 1 || record.version === 2) return undefined;
  if (record.version !== 3)
    throw new DelegationReadMetadataError('Invalid delegation record version');
  return decodeStoredDelegationV3(record).readMetadata;
}

/** Metadata projection for records that already crossed the strict decoder. */
export function readMetadataOfValidatedRecord(
  record: StoredDelegationLegacy | StoredDelegationV3,
): DelegationRecordReadMetadata | undefined {
  return record.version === 3 ? record.readMetadata : undefined;
}

/** Historical enumeration, recovery and old-key replay only. */
export function legacyPrefixView(
  record: StoredDelegationLegacy | StoredDelegationV3,
): LegacyDelegationPrefix {
  if (record.version === 3) return record.legacyPrefix ?? {};
  return {
    ...(record.history === undefined ? {} : { history: record.history }),
    ...(record.results === undefined ? {} : { results: record.results }),
    ...(record.control === undefined ? {} : { control: record.control }),
    ...(record.controls === undefined ? {} : { controls: record.controls }),
    ...(record.userMessageReceipts === undefined
      ? {}
      : { userMessageReceipts: record.userMessageReceipts }),
    ...(record.stopRequested === undefined
      ? {}
      : { stopRequested: record.stopRequested }),
    ...(record.stopRequests === undefined
      ? {}
      : { stopRequests: record.stopRequests }),
  };
}

/** A legacy record's retained current transcript; v3 keeps it in the stream. */
export function legacyCurrentTranscript(
  record: StoredDelegationLegacy | StoredDelegationV3,
): NonNullable<StoredDelegationLegacy['state']['transcript']> {
  return record.version === 3 ? [] : (record.state.transcript ?? []);
}

/** Last activity: the v3 capsule (D7) or the legacy record's own maximum. */
export function delegationRecordLastActivityAt(
  record: StoredDelegationLegacy | StoredDelegationV3,
): number {
  if (record.version === 3) return record.readMetadata.lastActivityAt;
  let lastActivityAt = Math.max(
    record.createdAt,
    record.state.startedAt ?? record.createdAt,
    record.state.finishedAt ?? record.createdAt,
    record.control?.occurredAt ?? record.createdAt,
  );
  for (const control of record.controls ?? [])
    lastActivityAt = Math.max(lastActivityAt, control.occurredAt ?? 0);
  for (const item of record.state.transcript ?? [])
    lastActivityAt = Math.max(lastActivityAt, item.occurredAt);
  for (const transcript of record.history ?? [])
    for (const item of transcript.transcript)
      lastActivityAt = Math.max(lastActivityAt, item.occurredAt);
  return lastActivityAt;
}

export interface DelegationCurrentStopRequest {
  readonly operationId: string;
  readonly operation: 'stop';
  readonly runGeneration?: number | null;
  readonly status: 'accepted' | 'completed' | 'failed';
}

export interface CurrentStopPolicy {
  readonly stopRequested?:
    | NonNullable<StoredDelegationLegacy['stopRequested']>
    | DelegationCurrentStopRequest;
  readonly stopFence?: V3ReceiptState['stopFence'];
}

/** Current stop policy is independent of the frozen legacy prefix. */
export function currentStopPolicy(
  record: StoredDelegationLegacy | StoredDelegationV3,
): CurrentStopPolicy {
  if (record.version !== 3)
    return record.stopRequested === undefined
      ? {}
      : { stopRequested: record.stopRequested };

  const active = record.receipts.activeStop;
  const fence = record.receipts.stopFence;
  const stopRequested: DelegationCurrentStopRequest | undefined = active
    ? {
        operationId: active.operationId,
        operation: 'stop',
        runGeneration: active.runGeneration,
        status: active.pendingTerminalOutcome?.reply.status ?? 'accepted',
      }
    : fence
      ? {
          operationId: fence.operationId,
          operation: 'stop',
          status: fence.status,
        }
      : undefined;
  return {
    ...(stopRequested === undefined ? {} : { stopRequested }),
    ...(fence === undefined ? {} : { stopFence: fence }),
  };
}

function isStoredDelegationV3(value: unknown): value is StoredDelegationV3 {
  if (!isRecord(value) || !isCanonicalJson(value)) return false;
  if (
    !hasExactKeys(
      value,
      [
        'version',
        'parent',
        'task',
        'callKey',
        'requestHash',
        'createdAt',
        'state',
        'launch',
        'delivery',
        'readMetadata',
        'registration',
        'receipts',
      ],
      [
        'depth',
        'parentDelegationId',
        'parentRunGeneration',
        'parentDescription',
        'transcriptRevision',
        'notificationOnly',
        'deliveryId',
        'resumeSessionId',
        'spawnIdentity',
        'workspaceDiscarded',
        'authorityRevoked',
        'interruptedGeneration',
        'appliedFiles',
        'applyJournal',
        'applyLeases',
        'executionCwd',
        'inheritedCwd',
        'isolationBaseCwd',
        'isolationRevision',
        'isolationReady',
        'workspaceObservation',
        'route',
        'capabilityGrant',
        'admission',
        'deadlineAt',
        'control',
        'latestReceipt',
        'latestResult',
        'settling',
        'legacyPrefix',
        'cardPublication',
      ],
    ) ||
    value.version !== 3 ||
    !isParentContext(value.parent) ||
    !isCurrentState(value.state) ||
    !isLaunchRecord(value.launch) ||
    !isDeliveryState(value.delivery) ||
    !isHash(value.callKey) ||
    !isHash(value.requestHash) ||
    !isTimestamp(value.createdAt) ||
    !isTask(value.task) ||
    !isV3LegacyMetadata(value) ||
    (Object.prototype.hasOwnProperty.call(value, 'cardPublication') &&
      !isCardPublication(
        value.cardPublication,
        value.state.runGeneration,
        value.task.prompt,
      )) ||
    !isRegistration(value.registration) ||
    !isV3ReceiptState(
      value.receipts,
      value.parent.chatId,
      value.state.delegationId,
      value.state.runGeneration,
    ) ||
    (value.control !== undefined && !isV3Control(value.control)) ||
    (value.latestReceipt !== undefined &&
      !isLatestReceipt(
        value.latestReceipt,
        value.parent.chatId,
        value.state.delegationId,
        value.state.runGeneration,
      )) ||
    (value.latestResult !== undefined &&
      !isLatestResult(value.latestResult, value.state.runGeneration)) ||
    (value.settling !== undefined &&
      !isSettling(
        value.settling,
        value.parent.chatId,
        value.state.delegationId,
        value.state.runGeneration,
      )) ||
    (value.legacyPrefix !== undefined && !isLegacyPrefix(value.legacyPrefix))
  )
    return false;

  const parsedTask = parseAgentDelegationSpawnRequest(value.task);
  if (
    !parsedTask.ok ||
    parsedTask.value.executionMode !== value.registration.executionMode ||
    value.launch.delegationId !== value.state.delegationId ||
    value.launch.runGeneration !== value.state.runGeneration ||
    value.registration.runGeneration !== value.state.runGeneration ||
    !isLaunchAndCallKeyConsistent(value.launch, value.callKey) ||
    !isRouteModelConsistent(parsedTask.value, value.route) ||
    !isDeadlineAfterCreatedAt(value.deadlineAt, value.createdAt) ||
    !isLaunchTerminalConsistent(value.launch) ||
    !isConsistentStopState(value.state)
  )
    return false;

  const identity: DelegationRecordIdentity = {
    parent: { chatId: value.parent.chatId },
    state: {
      delegationId: value.state.delegationId,
      runGeneration: value.state.runGeneration,
    },
  };
  let readMetadata: DelegationRecordReadMetadata;
  try {
    readMetadata = validateDelegationRecordReadMetadata(
      identity,
      value.readMetadata,
    );
  } catch {
    return false;
  }
  if (
    readMetadata.current.store !== 'stream' ||
    readMetadata.settling?.runGeneration !== value.settling?.runGeneration ||
    value.registration.store !== 'stream'
  )
    return false;

  return (
    isValidHistoricalPrefix(
      value.legacyPrefix,
      value.state.delegationId,
      value.state.runGeneration,
    ) &&
    isValidStreamProgress(
      value.legacyPrefix,
      value.latestResult,
      value.settling,
      value.registration,
      value.state.runGeneration,
    ) &&
    isValidReceiptRelationships(
      value.receipts,
      value.control,
      value.state.delegationId,
      value.state.runGeneration,
    )
  );
}

function isCardPublication(
  value: unknown,
  runGeneration: number,
  prompt: string,
): value is StoredCardPublication {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['runGeneration', 'cardRevision', 'promptAmended', 'draft'],
      [],
    ) ||
    value.runGeneration !== runGeneration ||
    !isPositive(value.cardRevision) ||
    typeof value.promptAmended !== 'boolean' ||
    !isRecord(value.draft) ||
    Object.prototype.hasOwnProperty.call(value.draft, 'prompt')
  )
    return false;
  return CardStateDraftSchema.safeParse({
    ...value.draft,
    ...(value.promptAmended ? { prompt } : {}),
  }).success;
}

function isParentContext(
  value: unknown,
): value is StoredDelegationLegacy['parent'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'harnessId',
        'projectId',
        'worktreeId',
        'chatId',
        'sessionKey',
        'turnId',
        'toolCallId',
        'runtimeGeneration',
        'depth',
      ],
      [
        'userMessageId',
        'controlAuthor',
        'parentDelegationId',
        'parentRunGeneration',
        'parentDescription',
      ],
    )
  )
    return false;
  if (
    !isLabel(value.harnessId) ||
    !isLabel(value.projectId) ||
    !isLabel(value.worktreeId) ||
    !isLabel(value.chatId) ||
    !isLabel(value.sessionKey) ||
    !isLabel(value.turnId) ||
    !isLabel(value.toolCallId) ||
    !isPositive(value.runtimeGeneration) ||
    !isCounter(value.depth) ||
    value.depth > 9 ||
    (value.userMessageId !== undefined && !isLabel(value.userMessageId)) ||
    (value.controlAuthor !== undefined &&
      value.controlAuthor !== 'user' &&
      value.controlAuthor !== 'agent') ||
    (value.parentDelegationId !== undefined &&
      !isLabel(value.parentDelegationId)) ||
    (value.parentRunGeneration !== undefined &&
      !isPositive(value.parentRunGeneration)) ||
    (value.parentDescription !== undefined &&
      !isLabel(value.parentDescription, 200))
  )
    return false;
  return value.depth === 0
    ? value.parentDelegationId === undefined &&
        value.parentRunGeneration === undefined
    : value.parentDelegationId !== undefined &&
        value.parentRunGeneration !== undefined;
}

function isCurrentState(value: unknown): value is StoredDelegationV3State {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'delegationId',
        'runGeneration',
        'sequence',
        'status',
        'outputTruncated',
      ],
      [
        'nativeSessionId',
        'startedAt',
        'finishedAt',
        'partialText',
        'finalText',
        'approvalPending',
        'error',
        'usage',
        'stopReason',
        'cancelledByUser',
        'stoppedBy',
      ],
    ) ||
    !isUuid(value.delegationId) ||
    !isPositive(value.runGeneration) ||
    !isCounter(value.sequence) ||
    !isStatus(value.status) ||
    typeof value.outputTruncated !== 'boolean' ||
    (value.nativeSessionId !== undefined && !isLabel(value.nativeSessionId)) ||
    (value.startedAt !== undefined && !isTimestamp(value.startedAt)) ||
    (value.finishedAt !== undefined && !isTimestamp(value.finishedAt)) ||
    (value.partialText !== undefined &&
      !isBoundedText(value.partialText, MAX_PREVIEW_CHARACTERS)) ||
    (value.finalText !== undefined &&
      !isBoundedText(value.finalText, MAX_PREVIEW_CHARACTERS)) ||
    (value.approvalPending !== undefined &&
      typeof value.approvalPending !== 'boolean') ||
    (value.error !== undefined && !isBoundedDelegationError(value.error)) ||
    (value.usage !== undefined && !isUsage(value.usage)) ||
    (value.stopReason !== undefined &&
      !isDelegationStopReason(value.stopReason)) ||
    (value.cancelledByUser !== undefined &&
      typeof value.cancelledByUser !== 'boolean') ||
    (value.stoppedBy !== undefined && !isDelegationStoppedBy(value.stoppedBy))
  )
    return false;
  return true;
}

function isTask(value: unknown): value is StoredDelegationLegacy['task'] {
  const result = parseAgentDelegationSpawnRequest(value);
  return result.ok;
}

function isLaunchRecord(
  value: unknown,
): value is StoredDelegationLegacy['launch'] {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['version', 'delegationId', 'launchKey', 'runGeneration', 'phase'],
      ['nativeSessionId', 'terminalStatus'],
    ) &&
    value.version === 1 &&
    isUuid(value.delegationId) &&
    isHash(value.launchKey) &&
    isPositive(value.runGeneration) &&
    (value.phase === 'reserved' ||
      value.phase === 'starting' ||
      value.phase === 'identified' ||
      value.phase === 'interrupted' ||
      value.phase === 'settled') &&
    (value.nativeSessionId === undefined || isLabel(value.nativeSessionId)) &&
    (value.terminalStatus === undefined ||
      isSettledStatus(value.terminalStatus))
  );
}

function isDeliveryState(
  value: unknown,
): value is StoredDelegationLegacy['delivery'] {
  if (!isRecord(value)) return false;
  if (value.status === 'unclaimed') return hasExactKeys(value, ['status']);
  if (
    value.status === 'queued' ||
    value.status === 'dispatching' ||
    value.status === 'uncertain'
  )
    return (
      hasExactKeys(value, ['status', 'channel']) &&
      (value.channel === 'foreground' || value.channel === 'background')
    );
  if (value.status === 'acknowledged')
    return (
      hasExactKeys(value, ['status', 'channel', 'receiptId']) &&
      (value.channel === 'foreground' || value.channel === 'background') &&
      isUuid(value.receiptId)
    );
  return (
    value.status === 'suppressed' &&
    hasExactKeys(value, ['status', 'reason']) &&
    (value.reason === 'parent_gone' ||
      value.reason === 'user_cancelled' ||
      value.reason === 'automatic_delivery_removed')
  );
}

/** Validate every inherited, retained v1/v2 metadata field without widening it. */
function isV3LegacyMetadata(value: Record<string, unknown>): boolean {
  return (
    (value.depth === undefined ||
      (isCounter(value.depth) && value.depth >= 1 && value.depth <= 10)) &&
    (value.parentDelegationId === undefined ||
      isLabel(value.parentDelegationId)) &&
    (value.parentRunGeneration === undefined ||
      isPositive(value.parentRunGeneration)) &&
    (value.parentDescription === undefined ||
      isBoundedString(value.parentDescription, 200)) &&
    (value.transcriptRevision === undefined ||
      isCounter(value.transcriptRevision)) &&
    (value.notificationOnly === undefined ||
      typeof value.notificationOnly === 'boolean') &&
    (value.deliveryId === undefined || isUuid(value.deliveryId)) &&
    (value.resumeSessionId === undefined || isLabel(value.resumeSessionId)) &&
    (value.spawnIdentity === undefined ||
      isSpawnIdentity(value.spawnIdentity)) &&
    (value.workspaceDiscarded === undefined ||
      typeof value.workspaceDiscarded === 'boolean') &&
    (value.authorityRevoked === undefined ||
      typeof value.authorityRevoked === 'boolean') &&
    (value.interruptedGeneration === undefined ||
      isCounter(value.interruptedGeneration)) &&
    (value.appliedFiles === undefined || isAppliedFiles(value.appliedFiles)) &&
    (value.applyJournal === undefined || isApplyJournal(value.applyJournal)) &&
    (value.applyLeases === undefined || isApplyLeases(value.applyLeases)) &&
    (value.executionCwd === undefined ||
      isBoundedString(value.executionCwd, 4096)) &&
    (value.inheritedCwd === undefined ||
      isBoundedString(value.inheritedCwd, 4096)) &&
    (value.isolationBaseCwd === undefined ||
      isBoundedString(value.isolationBaseCwd, 4096)) &&
    (value.isolationRevision === undefined ||
      (typeof value.isolationRevision === 'string' &&
        value.isolationRevision.length <= 64)) &&
    (value.isolationReady === undefined ||
      typeof value.isolationReady === 'boolean') &&
    (value.workspaceObservation === undefined ||
      isWorkspaceObservation(value.workspaceObservation)) &&
    (value.route === undefined || isAgentRoute(value.route)) &&
    (value.capabilityGrant === undefined ||
      isCapabilityGrant(value.capabilityGrant)) &&
    (value.admission === undefined || isAdmission(value.admission)) &&
    (value.deadlineAt === undefined || isCounter(value.deadlineAt))
  );
}

function isSpawnIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['key', 'hash']) &&
    isHash(value.key) &&
    isHash(value.hash)
  );
}

function isAppliedFiles(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_APPLY_FILES &&
    value.every(
      (file: unknown) =>
        isRecord(file) &&
        hasExactKeys(file, ['path', 'delegate']) &&
        isPath(file.path) &&
        isHash(file.delegate),
    )
  );
}

function isApplyJournal(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['operationId', 'root', 'files'], ['store']) &&
    isUuid(value.operationId) &&
    isBoundedString(value.root, 4096) &&
    (value.store === undefined || isBoundedString(value.store, 4096)) &&
    Array.isArray(value.files) &&
    value.files.length <= MAX_APPLY_FILES &&
    value.files.every(isApplyJournalFile)
  );
}

function isApplyJournalFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ['path', 'beforeBlob', 'afterBlob']))
    return (
      isPath(value.path) &&
      isNullableHash(value.beforeBlob) &&
      isNullableHash(value.afterBlob)
    );
  return (
    hasExactKeys(value, ['path', 'before', 'after']) &&
    isPath(value.path) &&
    isLegacyApplyContent(value.before) &&
    isLegacyApplyContent(value.after)
  );
}

function isLegacyApplyContent(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= MAX_LEGACY_APPLY_CONTENT_CHARACTERS)
  );
}

function isApplyLeases(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_APPLY_FILES &&
    value.every(
      (lease: unknown) =>
        isRecord(lease) &&
        hasExactKeys(lease, ['path', 'parent', 'delegate']) &&
        isPath(lease.path) &&
        isHash(lease.parent) &&
        isHash(lease.delegate),
    )
  );
}

function isWorkspaceObservation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'consistency',
      'headRevision',
      'dirty',
      'observedAt',
    ]) &&
    value.consistency === 'live_shared_worktree' &&
    (value.headRevision === null ||
      (typeof value.headRevision === 'string' &&
        REVISION_PATTERN.test(value.headRevision))) &&
    (value.dirty === null || typeof value.dirty === 'boolean') &&
    isTimestamp(value.observedAt)
  );
}

function isAgentRoute(
  value: unknown,
): value is NonNullable<StoredDelegationLegacy['route']> {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'selectedModelId',
        'runtimeModelId',
        'harnessId',
        'runtimeKind',
        'runnerRegistrationId',
        'runtimeVersion',
        'adapterVersion',
        'modelSource',
        'providerType',
        'assignmentRevision',
        'billingAuthority',
        'aiCreditsRouted',
        'capabilities',
        'supportedThinkingLevels',
        'capabilitySnapshotHash',
        'capabilityGeneration',
        'policyRevision',
      ],
      [
        'selectedModelLabel',
        'runtimeModelLabel',
        'routeId',
        'requestedThinkingLevel',
        'effectiveThinkingLevel',
        'authAccountKey',
        'agentOverlay',
        'capabilityOverlay',
      ],
    ) ||
    ![
      'selectedModelId',
      'runtimeModelId',
      'harnessId',
      'runtimeKind',
      'runnerRegistrationId',
      'runtimeVersion',
      'adapterVersion',
      'modelSource',
      'providerType',
      'assignmentRevision',
      'billingAuthority',
      'capabilitySnapshotHash',
      'policyRevision',
    ].every((key) => isLabel(value[key])) ||
    typeof value.aiCreditsRouted !== 'boolean' ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 64 ||
    !value.capabilities.every((entry: unknown) => isLabel(entry)) ||
    !Array.isArray(value.supportedThinkingLevels) ||
    value.supportedThinkingLevels.length > THINKING_LEVELS.length ||
    !value.supportedThinkingLevels.every(isThinkingLevel) ||
    !isPositive(value.capabilityGeneration) ||
    (value.selectedModelLabel !== undefined &&
      !isLabel(value.selectedModelLabel)) ||
    (value.runtimeModelLabel !== undefined &&
      !isLabel(value.runtimeModelLabel)) ||
    (value.routeId !== undefined && !isLabel(value.routeId)) ||
    (value.requestedThinkingLevel !== undefined &&
      !isThinkingLevel(value.requestedThinkingLevel)) ||
    (value.effectiveThinkingLevel !== undefined &&
      !isThinkingLevel(value.effectiveThinkingLevel)) ||
    (value.authAccountKey !== undefined && !isLabel(value.authAccountKey)) ||
    (value.agentOverlay !== undefined && !isAgentOverlay(value.agentOverlay)) ||
    (value.capabilityOverlay !== undefined &&
      !isCapabilityOverlay(value.capabilityOverlay))
  )
    return false;
  return true;
}

function isAgentOverlay(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        'agentDefinitionId',
        'agentDefinitionRevision',
        'agentDefinitionHash',
        'pluginProjectionHash',
        'artifact',
      ],
      ['systemPromptAppend'],
    ) &&
    isLabel(value.agentDefinitionId) &&
    isLabel(value.agentDefinitionRevision) &&
    isHash(value.agentDefinitionHash) &&
    isHash(value.pluginProjectionHash) &&
    (value.systemPromptAppend === undefined ||
      isBoundedText(value.systemPromptAppend, 1_048_576)) &&
    isRecord(value.artifact) &&
    hasExactKeys(value.artifact, [
      'artifactId',
      'formatVersion',
      'manifestHash',
    ]) &&
    isHash(value.artifact.artifactId) &&
    (value.artifact.formatVersion === 1 ||
      value.artifact.formatVersion === 2) &&
    isHash(value.artifact.manifestHash)
  );
}

function isCapabilityOverlay(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['capabilityProjectionHash', 'artifact']) &&
    isHash(value.capabilityProjectionHash) &&
    isRecord(value.artifact) &&
    hasExactKeys(value.artifact, [
      'artifactId',
      'formatVersion',
      'manifestHash',
    ]) &&
    isHash(value.artifact.artifactId) &&
    value.artifact.formatVersion === 3 &&
    isHash(value.artifact.manifestHash)
  );
}

function isCapabilityGrant(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'inherit',
      'explicit',
      'discovery',
      'loaded',
      'skipped',
      'overlayHash',
      'summary',
    ]) &&
    typeof value.inherit === 'boolean' &&
    Array.isArray(value.explicit) &&
    value.explicit.length <= DELEGATION_CAPABILITY_GRANT_LIMITS.explicit &&
    value.explicit.every(isDelegationCapabilityId) &&
    typeof value.discovery === 'boolean' &&
    Array.isArray(value.loaded) &&
    value.loaded.length <= DELEGATION_CAPABILITY_GRANT_LIMITS.loaded &&
    value.loaded.every(isDelegationCapabilityId) &&
    Array.isArray(value.skipped) &&
    value.skipped.length <= DELEGATION_CAPABILITY_GRANT_LIMITS.skipped &&
    value.skipped.every(isSkippedGrant) &&
    isHash(value.overlayHash) &&
    isCapabilitySummary(value.summary)
  );
}

function isSkippedGrant(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'reason']) &&
    isDelegationCapabilityId(value.id) &&
    DELEGATION_CAPABILITY_SKIP_REASONS.some((reason) => reason === value.reason)
  );
}

function isCapabilitySummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['inherit', 'discovery', 'items', 'skipped'],
      ['omittedItems', 'omittedSkipped'],
    ) &&
    typeof value.inherit === 'boolean' &&
    typeof value.discovery === 'boolean' &&
    Array.isArray(value.items) &&
    value.items.length <= DELEGATION_CAPABILITY_LIMITS.summaryItems &&
    value.items.every(isCapabilitySummaryItem) &&
    Array.isArray(value.skipped) &&
    value.skipped.length <= DELEGATION_CAPABILITY_LIMITS.summarySkipped &&
    value.skipped.every(isCapabilitySummarySkipped) &&
    (value.omittedItems === undefined || isCounter(value.omittedItems)) &&
    (value.omittedSkipped === undefined || isCounter(value.omittedSkipped))
  );
}

function isCapabilitySummaryItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'name', 'source']) &&
    isCapabilityKind(value.kind) &&
    isCapabilityName(value.name) &&
    DELEGATION_CAPABILITY_SOURCES.some((source) => source === value.source)
  );
}

function isCapabilitySummarySkipped(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'name', 'reason']) &&
    isCapabilityKind(value.kind) &&
    isCapabilityName(value.name) &&
    DELEGATION_CAPABILITY_SKIP_REASONS.some((reason) => reason === value.reason)
  );
}

function isCapabilityKind(value: unknown): boolean {
  return DELEGATION_CAPABILITY_KINDS.some((kind) => kind === value);
}

function isCapabilityName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATION_CAPABILITY_LIMITS.nameCharacters &&
    !/[\0\r\n]/.test(value)
  );
}

function isThinkingLevel(value: unknown): boolean {
  return THINKING_LEVELS.some((level) => level === value);
}

function isAdmission(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['runGeneration', 'state', 'queuedAt'],
      ['grantedAt'],
    ) &&
    isPositive(value.runGeneration) &&
    (value.state === 'waiting' || value.state === 'granted') &&
    isTimestamp(value.queuedAt) &&
    (value.grantedAt === undefined || isTimestamp(value.grantedAt))
  );
}

function isLaunchAndCallKeyConsistent(
  launch: StoredDelegationLegacy['launch'],
  callKey: string,
): boolean {
  return launch.launchKey === callKey;
}

function isRouteModelConsistent(
  task: StoredDelegationLegacy['task'],
  route: unknown,
): boolean {
  return (
    route === undefined ||
    (isAgentRoute(route) && task.modelId === route.selectedModelId)
  );
}

function isDeadlineAfterCreatedAt(
  deadlineAt: unknown,
  createdAt: number,
): boolean {
  return (
    deadlineAt === undefined ||
    (isTimestamp(deadlineAt) && deadlineAt > createdAt)
  );
}

function isLaunchTerminalConsistent(
  launch: StoredDelegationLegacy['launch'],
): boolean {
  return (launch.phase === 'settled') === (launch.terminalStatus !== undefined);
}

function isConsistentStopState(value: StoredDelegationV3State): boolean {
  return (
    (value.stopReason === undefined
      ? value.cancelledByUser === undefined
      : value.cancelledByUser === (value.stopReason === 'user_cancelled')) &&
    (value.stopReason !== 'deadline_exceeded' ||
      value.status === 'deadline_exceeded') &&
    (value.stopReason === undefined ||
      value.stopReason === 'deadline_exceeded' ||
      value.status === 'cancelled') &&
    (value.stoppedBy === undefined ||
      value.stopReason === 'ancestor_stopped' ||
      value.stopReason ===
        (value.stoppedBy.kind === 'user'
          ? 'user_cancelled'
          : 'stopped_by_parent'))
  );
}

function isRegistration(
  value: unknown,
): value is StoredDelegationV3Registration {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'runGeneration',
      'createdAt',
      'store',
      'origin',
      'executionMode',
    ]) ||
    !isPositive(value.runGeneration) ||
    !isTimestamp(value.createdAt) ||
    value.store !== 'stream' ||
    (value.executionMode !== 'background' &&
      value.executionMode !== 'foreground') ||
    !isRecord(value.origin) ||
    !hasExactKeys(
      value.origin,
      ['kind'],
      ['anchorMessageId', 'authoredItemId'],
    ) ||
    (value.origin.kind !== 'launch' &&
      value.origin.kind !== 'follow_up' &&
      value.origin.kind !== 'resume' &&
      value.origin.kind !== 'continuation') ||
    (value.origin.anchorMessageId !== undefined &&
      !isBoundedString(value.origin.anchorMessageId, 256)) ||
    (value.origin.authoredItemId !== undefined &&
      !isBoundedString(value.origin.authoredItemId, 256))
  )
    return false;
  return true;
}

function isV3Control(value: unknown): value is StoredDelegationV3Control {
  return (
    isControl(value, false) &&
    !Object.prototype.hasOwnProperty.call(value, 'firstOutcome') &&
    !Object.prototype.hasOwnProperty.call(value, 'firstError')
  );
}

function isLegacyControl(value: unknown): value is StoredDelegationControl {
  return isControl(value, true);
}

function isControl(value: unknown, legacy: boolean): boolean {
  const required = ['operationId', 'key', 'requestHash', 'operation', 'status'];
  const optional = [
    'occurredAt',
    'sender',
    'message',
    'permissions',
    'steeringDelivery',
    'error',
    'applyFailure',
    ...(legacy ? ['firstOutcome', 'firstError'] : []),
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, required, optional) ||
    !delegationControlSchema.safeParse(value).success
  )
    return false;
  if (
    !isUuid(value.operationId) ||
    !isHash(value.key) ||
    !isHash(value.requestHash) ||
    !isControlOperation(value.operation) ||
    (value.status !== 'accepted' &&
      value.status !== 'completed' &&
      value.status !== 'failed') ||
    (value.occurredAt !== undefined && !isTimestamp(value.occurredAt)) ||
    (value.sender !== undefined &&
      !delegationMessageAuthorSchema.safeParse(value.sender).success) ||
    (value.message !== undefined &&
      !isBoundedText(
        value.message,
        AGENT_DELEGATION_INPUT_LIMITS.promptCharacters,
      )) ||
    (value.permissions !== undefined && !isPermissions(value.permissions)) ||
    (value.steeringDelivery !== undefined &&
      !isSteeringDelivery(value.steeringDelivery)) ||
    (value.error !== undefined && !isBoundedText(value.error, 512)) ||
    (value.applyFailure !== undefined && !isApplyFailure(value.applyFailure))
  )
    return false;
  if (!legacy) return true;
  return (
    (value.firstOutcome === undefined ||
      isLegacySnapshot(value.firstOutcome)) &&
    (value.firstError === undefined || isDelegationError(value.firstError))
  );
}

function isPermissions(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['writePaths']) &&
    Array.isArray(value.writePaths) &&
    value.writePaths.length <= 64 &&
    value.writePaths.every(
      (path: unknown) =>
        typeof path === 'string' && path.length > 0 && path.length <= 4095,
    )
  );
}

function isSteeringDelivery(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    hasExactKeys(value, ['kind', 'attemptId'], ['providerTurnId']) &&
    value.kind === 'accepted'
  )
    return (
      isLabel(value.attemptId) &&
      (value.providerTurnId === undefined || isLabel(value.providerTurnId))
    );
  return (
    hasExactKeys(value, ['kind', 'attemptId', 'reason'], ['fallback']) &&
    (value.kind === 'rejected' || value.kind === 'unknown') &&
    isLabel(value.attemptId) &&
    isBoundedText(value.reason, 4096) &&
    (value.fallback === undefined || value.fallback === 'ordinary')
  );
}

function isApplyFailure(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reason', 'issues', 'guidance'], ['omittedIssues']) ||
    !DELEGATION_APPLY_FAILURE_REASONS.some(
      (reason) => reason === value.reason,
    ) ||
    !Array.isArray(value.issues) ||
    value.issues.length > DELEGATION_APPLY_FAILURE_LIMITS.issues ||
    (value.omittedIssues !== undefined && !isCounter(value.omittedIssues)) ||
    !isBoundedText(
      value.guidance,
      DELEGATION_APPLY_FAILURE_LIMITS.guidanceCharacters,
    )
  )
    return false;
  return value.issues.every(isApplyFailureIssue);
}

function isApplyFailureIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['path', 'reason'],
      ['parentDiff', 'parentDiffTruncated'],
    ) &&
    isPath(value.path) &&
    DELEGATION_APPLY_ISSUE_REASONS.some((reason) => reason === value.reason) &&
    (value.parentDiff === undefined ||
      isBoundedText(
        value.parentDiff,
        DELEGATION_APPLY_FAILURE_LIMITS.diffBytes,
      )) &&
    (value.parentDiffTruncated === undefined ||
      typeof value.parentDiffTruncated === 'boolean')
  );
}

function isLegacySnapshot(value: unknown): value is AgentDelegationSnapshot {
  return isStoredSnapshot(value);
}

function isLegacyPrefix(value: unknown): value is LegacyDelegationPrefix {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      [
        'history',
        'results',
        'control',
        'controls',
        'userMessageReceipts',
        'stopRequested',
        'stopRequests',
      ],
    )
  )
    return false;
  if (
    (value.history !== undefined &&
      !delegationHistorySchema.safeParse(value.history).success) ||
    (value.results !== undefined &&
      !delegationResultsSchema.safeParse(value.results).success) ||
    (value.control !== undefined && !isLegacyControl(value.control)) ||
    (value.controls !== undefined &&
      (!Array.isArray(value.controls) ||
        value.controls.length > MAX_RECEIPTS ||
        !value.controls.every(isLegacyControl))) ||
    (value.userMessageReceipts !== undefined &&
      (!Array.isArray(value.userMessageReceipts) ||
        !value.userMessageReceipts.every(isLegacyMessageReceipt))) ||
    (value.stopRequested !== undefined &&
      !isLegacyStopRequest(value.stopRequested)) ||
    (value.stopRequests !== undefined &&
      (!Array.isArray(value.stopRequests) ||
        value.stopRequests.length > MAX_RECEIPTS ||
        !value.stopRequests.every(isLegacyStopRequest)))
  )
    return false;
  return true;
}

function isValidHistoricalPrefix(
  value: unknown,
  delegationId: string,
  currentRunGeneration: number,
): boolean {
  if (value === undefined) return true;
  if (!isLegacyPrefix(value)) return false;
  let previousHistoryGeneration = 0;
  for (const transcript of value.history ?? []) {
    if (
      transcript.delegationId !== delegationId ||
      transcript.runGeneration >= currentRunGeneration ||
      transcript.runGeneration <= previousHistoryGeneration ||
      transcript.snapshot.delegationId !== delegationId ||
      (transcript.snapshot.runGeneration !== undefined &&
        transcript.snapshot.runGeneration !== transcript.runGeneration)
    )
      return false;
    previousHistoryGeneration = transcript.runGeneration;
  }
  for (const result of value.results ?? []) {
    if (result.runGeneration >= currentRunGeneration) return false;
  }
  const controls = [
    ...(value.control === undefined ? [] : [value.control]),
    ...(value.controls ?? []),
  ];
  if (
    controls.some(
      (control) =>
        control.firstOutcome !== undefined &&
        (control.firstOutcome.delegationId !== delegationId ||
          (control.firstOutcome.runGeneration !== undefined &&
            control.firstOutcome.runGeneration > currentRunGeneration)),
    ) ||
    (value.userMessageReceipts ?? []).some(
      (receipt) => receipt.delegationId !== delegationId,
    ) ||
    (value.stopRequested?.runGeneration !== undefined &&
      value.stopRequested.runGeneration >= currentRunGeneration) ||
    (value.stopRequests ?? []).some(
      (request) =>
        request.runGeneration !== undefined &&
        request.runGeneration >= currentRunGeneration,
    )
  )
    return false;
  return true;
}

function isValidStreamProgress(
  legacyPrefix: unknown,
  latestResult: StoredDelegationV3ResultLocator | undefined,
  settling: StoredDelegationV3Settling | undefined,
  registration: StoredDelegationV3Registration,
  currentRunGeneration: number,
): boolean {
  const prefix = legacyPrefix === undefined ? {} : legacyPrefix;
  if (!isLegacyPrefix(prefix)) return false;
  let historicalGeneration = 0;
  for (const transcript of prefix.history ?? [])
    historicalGeneration = Math.max(
      historicalGeneration,
      transcript.runGeneration,
    );
  for (const result of prefix.results ?? [])
    historicalGeneration = Math.max(historicalGeneration, result.runGeneration);
  const controls = [
    ...(prefix.control === undefined ? [] : [prefix.control]),
    ...(prefix.controls ?? []),
  ];
  for (const control of controls) {
    if (control.firstOutcome?.runGeneration !== undefined)
      historicalGeneration = Math.max(
        historicalGeneration,
        control.firstOutcome.runGeneration,
      );
  }
  if (prefix.stopRequested?.runGeneration !== undefined)
    historicalGeneration = Math.max(
      historicalGeneration,
      prefix.stopRequested.runGeneration,
    );
  for (const request of prefix.stopRequests ?? []) {
    if (request.runGeneration !== undefined)
      historicalGeneration = Math.max(
        historicalGeneration,
        request.runGeneration,
      );
  }
  const frozenResultCount = prefix.results?.length ?? 0;
  if (registration.runGeneration <= historicalGeneration) return false;
  if (
    latestResult !== undefined &&
    (latestResult.runGeneration <= historicalGeneration ||
      latestResult.resultIndex <= frozenResultCount)
  )
    return false;
  if (settling === undefined) return true;
  const expectedIndex = (latestResult?.resultIndex ?? frozenResultCount) + 1;
  return (
    settling.runGeneration === registration.runGeneration &&
    settling.runGeneration === currentRunGeneration &&
    (latestResult === undefined ||
      latestResult.runGeneration < settling.runGeneration) &&
    settling.assertedResultIndex === expectedIndex
  );
}

function isLegacyMessageReceipt(
  value: unknown,
): value is StoredDelegationMessageReceipt {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'operationId',
      'key',
      'requestHash',
      'delegationId',
      'operation',
      'error',
    ]) &&
    isUuid(value.operationId) &&
    isHash(value.key) &&
    isHash(value.requestHash) &&
    isLabel(value.delegationId) &&
    (value.operation === 'follow_up' ||
      value.operation === 'steer' ||
      value.operation === 'interrupt') &&
    isDelegationError(value.error)
  );
}

function isLegacyStopRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['operationId', 'status'], ['key', 'runGeneration']) &&
    isUuid(value.operationId) &&
    (value.key === undefined || isHash(value.key)) &&
    (value.runGeneration === undefined || isPositive(value.runGeneration)) &&
    (value.status === 'accepted' ||
      value.status === 'completed' ||
      value.status === 'failed')
  );
}

function isLatestResult(
  value: unknown,
  currentRunGeneration: number,
): value is StoredDelegationV3ResultLocator {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['resultIndex', 'runGeneration', 'status', 'settledAt'],
      ['stopReason', 'notified'],
    ) &&
    (value.notified === undefined || value.notified === true) &&
    isPositive(value.resultIndex) &&
    isPositive(value.runGeneration) &&
    value.runGeneration <= currentRunGeneration &&
    isSettledStatus(value.status) &&
    isTimestamp(value.settledAt) &&
    (value.stopReason === undefined || isDelegationStopReason(value.stopReason))
  );
}

function isLatestReceipt(
  value: unknown,
  chatId: string,
  delegationId: string,
  runGeneration: number,
): value is DelegationTranscriptReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'target',
      'mutationKey',
      'streamRevision',
      'items',
      'replayed',
    ]) ||
    !isTarget(value.target, chatId, delegationId, runGeneration) ||
    !isBoundedString(value.mutationKey, 4096) ||
    !isPositive(value.streamRevision) ||
    typeof value.replayed !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_V3_LATEST_RECEIPT_ITEMS
  )
    return false;
  const uniqueIds = new Set<string>();
  const validItems = value.items.every(
    (item: unknown) =>
      isRecord(item) &&
      hasExactKeys(item, ['id', 'itemRevision', 'final']) &&
      isBoundedString(item.id, 256) &&
      isCounter(item.itemRevision) &&
      typeof item.final === 'boolean' &&
      !uniqueIds.has(item.id) &&
      (uniqueIds.add(item.id), true),
  );
  return (
    validItems &&
    Buffer.byteLength(canonicalDelegationJson(value), 'utf8') <=
      MAX_V3_LATEST_RECEIPT_BYTES
  );
}

function isSettling(
  value: unknown,
  chatId: string,
  delegationId: string,
  currentRunGeneration: number,
): value is StoredDelegationV3Settling {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'runGeneration',
      'settlementKey',
      'assertedResultIndex',
      'outcome',
      'answer',
      'expectedSettlementDigest',
    ]) ||
    value.runGeneration !== currentRunGeneration ||
    !isPositive(value.runGeneration) ||
    !isPositive(value.assertedResultIndex) ||
    !isHash(value.settlementKey) ||
    !isSettlementOutcome(value.outcome) ||
    !isSettlingAnswer(value.answer) ||
    !isHash(value.expectedSettlementDigest) ||
    value.settlementKey !==
      delegationSettlementKey(chatId, delegationId, currentRunGeneration)
  )
    return false;

  const answer: DelegationTranscriptSettleRequest['answer'] =
    value.answer === 'none'
      ? null
      : 'empty' in value.answer
        ? { role: value.answer.role, text: '' }
        : {
            role: value.answer.role,
            lost: {
              sha256: value.answer.sha256,
              length: value.answer.length,
            },
          };
  const request: DelegationTranscriptSettleRequest = {
    target: {
      kind: 'delegation',
      chatId,
      delegationId,
      runGeneration: currentRunGeneration,
    },
    settlementKey: value.settlementKey,
    resultIndex: value.assertedResultIndex,
    outcome: value.outcome,
    finalChanges: [],
    answer,
    openRows: 'finalize',
  };
  try {
    return (
      delegationTranscriptSettlementDigest(request) ===
      value.expectedSettlementDigest
    );
  } catch {
    return false;
  }
}

function isSettlingAnswer(value: unknown): value is StoredDelegationV3Answer {
  if (value === 'none') return true;
  if (!isRecord(value)) return false;
  if (value.role !== 'final' && value.role !== 'partial') return false;
  if (value.empty === true) return hasExactKeys(value, ['role', 'empty']);
  return (
    hasExactKeys(value, ['role', 'sha256', 'length']) &&
    isHash(value.sha256) &&
    isPositive(value.length)
  );
}

function isSettlementOutcome(
  value: unknown,
): value is DelegationTranscriptSettlementOutcome {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['status', 'finishedAt'],
      ['error', 'usage', 'stopReason', 'startedAt'],
    ) &&
    isSettledStatus(value.status) &&
    isTimestamp(value.finishedAt) &&
    (value.error === undefined || isSettlementError(value.error)) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.stopReason === undefined ||
      isDelegationStopReason(value.stopReason)) &&
    (value.startedAt === undefined || isTimestamp(value.startedAt))
  );
}

function isSettlementError(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message', 'retryable']) &&
    isErrorCode(value.code) &&
    isBoundedText(value.message, MAX_PREVIEW_CHARACTERS) &&
    typeof value.retryable === 'boolean'
  );
}

function isV3ReceiptState(
  value: unknown,
  chatId: string,
  delegationId: string,
  currentRunGeneration: number,
): value is V3ReceiptState {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['commandReceipts', 'stopReceipts'],
      ['activeStop', 'stopFence'],
    ) ||
    !Array.isArray(value.commandReceipts) ||
    value.commandReceipts.length > MAX_RECEIPTS ||
    !value.commandReceipts.every((entry: unknown) =>
      isReceiptEntry(
        entry,
        'command',
        chatId,
        delegationId,
        currentRunGeneration,
      ),
    ) ||
    !hasUniqueReceiptKeys(value.commandReceipts) ||
    !Array.isArray(value.stopReceipts) ||
    value.stopReceipts.length > MAX_RECEIPTS ||
    !value.stopReceipts.every((entry: unknown) =>
      isReceiptEntry(entry, 'stop', chatId, delegationId, currentRunGeneration),
    )
  )
    return false;
  if (!hasUniqueReceiptKeys(value.stopReceipts)) return false;
  if (
    value.activeStop !== undefined &&
    (!isActiveStop(value.activeStop, chatId, delegationId) ||
      (value.activeStop.runGeneration !== null &&
        value.activeStop.runGeneration > currentRunGeneration))
  )
    return false;
  return value.stopFence === undefined || isStopFence(value.stopFence);
}

function isValidReceiptRelationships(
  receipts: V3ReceiptState,
  control: StoredDelegationV3Control | undefined,
  delegationId: string,
  currentRunGeneration: number,
): boolean {
  const active = receipts.activeStop;
  const fence = receipts.stopFence;
  if (active !== undefined) {
    if (fence === undefined || fence.operationId !== active.operationId)
      return false;
    const pendingStatus = active.pendingTerminalOutcome?.reply.status;
    if (
      pendingStatus === undefined
        ? fence.status !== 'accepted'
        : fence.status !== 'accepted' && fence.status !== pendingStatus
    )
      return false;
    if (
      receipts.stopReceipts.some(
        (receipt) =>
          receipt.operationId === active.operationId &&
          (receipt.operation !== 'stop' ||
            receipt.runGeneration !== active.runGeneration),
      )
    )
      return false;
  } else if (fence === undefined && receipts.stopReceipts.length > 0) {
    const latestStopAdmission = receipts.stopReceipts.reduce(
      (latest, receipt) => Math.max(latest, receipt.admittedAt),
      0,
    );
    const explicitResume = receipts.commandReceipts.some(
      (receipt) =>
        receipt.operation === 'resume' &&
        receipt.reply.kind === 'command' &&
        receipt.reply.ack.ok &&
        receipt.admittedAt > latestStopAdmission,
    );
    if (!explicitResume) return false;
  }
  if (control === undefined) return true;
  return receipts.commandReceipts.some(
    (receipt) =>
      receipt.key === control.key &&
      receipt.operationId === control.operationId &&
      receipt.operation === control.operation &&
      receipt.requestHash === control.requestHash &&
      receipt.delegationId === delegationId &&
      (receipt.runGeneration === null ||
        receipt.runGeneration <= currentRunGeneration),
  );
}

function isReceiptEntry(
  value: unknown,
  kind: 'command' | 'stop' | 'stop_outcome',
  chatId: string,
  delegationId: string,
  currentRunGeneration: number,
): value is DelegationTranscriptReceiptEntry {
  const validation = validateDelegationReceiptEntry(value);
  if (
    !validation.ok ||
    validation.entry.receiptKind !== kind ||
    validation.entry.chatId !== chatId ||
    validation.entry.delegationId !== delegationId ||
    (validation.entry.runGeneration !== null &&
      validation.entry.runGeneration > currentRunGeneration)
  )
    return false;
  const entry = validation.entry;
  if (entry.reply.kind === 'command') {
    if (!entry.reply.ack.ok) return true;
    const snapshot = entry.reply.ack.snapshot;
    return (
      snapshot.delegationId === entry.delegationId &&
      (snapshot.runGeneration === undefined ||
        snapshot.runGeneration === entry.runGeneration) &&
      (snapshot.control === undefined ||
        (snapshot.control.operationId === entry.operationId &&
          snapshot.control.operation === entry.operation))
    );
  }
  if (entry.reply.kind === 'stop')
    return entry.reply.runGeneration === entry.runGeneration;
  return entry.reply.runGeneration === entry.runGeneration;
}

function hasUniqueReceiptKeys(value: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const receipt of value) {
    if (!isRecord(receipt) || typeof receipt.key !== 'string') return false;
    if (seen.has(receipt.key)) return false;
    seen.add(receipt.key);
  }
  return true;
}

function isActiveStop(
  value: unknown,
  chatId: string,
  delegationId: string,
): value is NonNullable<V3ReceiptState['activeStop']> {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['operationId', 'runGeneration', 'admittedAt'],
      ['pendingTerminalOutcome'],
    ) ||
    !isUuid(value.operationId) ||
    (value.runGeneration !== null && !isPositive(value.runGeneration)) ||
    !isTimestamp(value.admittedAt)
  )
    return false;
  if (value.pendingTerminalOutcome === undefined) return true;
  const validation = validateDelegationReceiptEntry(
    value.pendingTerminalOutcome,
  );
  return (
    validation.ok &&
    validation.entry.receiptKind === 'stop_outcome' &&
    validation.entry.chatId === chatId &&
    validation.entry.delegationId === delegationId &&
    validation.entry.operation === 'stop' &&
    validation.entry.key === value.operationId &&
    validation.entry.operationId === value.operationId &&
    validation.entry.requestHash === null &&
    validation.entry.runGeneration === value.runGeneration &&
    validation.entry.admittedAt === value.admittedAt &&
    validation.entry.reply.kind === 'stop_outcome' &&
    validation.entry.reply.runGeneration === value.runGeneration
  );
}

function isStopFence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['operationId', 'status']) &&
    isUuid(value.operationId) &&
    (value.status === 'accepted' ||
      value.status === 'completed' ||
      value.status === 'failed')
  );
}

function isTarget(
  value: unknown,
  chatId: string,
  delegationId: string,
  runGeneration: number,
): value is DelegationTranscriptTarget {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'chatId', 'delegationId', 'runGeneration']) &&
    value.kind === 'delegation' &&
    value.chatId === chatId &&
    value.delegationId === delegationId &&
    value.runGeneration === runGeneration
  );
}

function isDelegationError(value: unknown): value is AgentDelegationError {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message', 'retryable'], ['apply']) &&
    isErrorCode(value.code) &&
    isBoundedText(value.message, MAX_LEGACY_TEXT_CHARACTERS) &&
    typeof value.retryable === 'boolean' &&
    (value.apply === undefined || isApplyFailure(value.apply))
  );
}

function isBoundedDelegationError(
  value: unknown,
): value is AgentDelegationError {
  return (
    isDelegationError(value) && value.message.length <= MAX_PREVIEW_CHARACTERS
  );
}

function isErrorCode(value: unknown): value is AgentDelegationErrorCode {
  return (
    typeof value === 'string' && ERROR_CODES.some((code) => code === value)
  );
}

function isUsage(value: unknown): value is AgentDelegationUsage {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ],
    )
  )
    return false;
  return Object.entries(value).every(([key, entry]) =>
    key === 'costUsd'
      ? typeof entry === 'number' && Number.isFinite(entry) && entry >= 0
      : isCounter(entry),
  );
}

function isControlOperation(value: unknown): boolean {
  return (
    value === 'follow_up' ||
    value === 'resume' ||
    value === 'steer' ||
    value === 'interrupt' ||
    value === 'apply' ||
    value === 'discard'
  );
}

function isStatus(value: unknown): value is AgentDelegationStatus {
  return (
    typeof value === 'string' && STATUSES.some((status) => status === value)
  );
}

function isSettledStatus(value: unknown): value is DelegateSettledStatus {
  return (
    typeof value === 'string' &&
    SETTLED_STATUSES.some((status) => status === value)
  );
}

function isCanonicalJson(value: unknown): boolean {
  try {
    canonicalDelegationJson(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)),
    )
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

function isLabel(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/.test(value)
  );
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4095;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is number {
  return isCounter(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isCounter(value) && value > 0;
}
