import { createHash, randomUUID } from 'node:crypto';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import {
  CardStateV2Schema,
  type TranscriptContentField,
} from '@canopy/protocol/canopy-core';
import {
  DELEGATION_REGISTRY_MAX_ID_LENGTH,
  DELEGATION_REGISTRY_MAX_ERROR_LENGTH,
  DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
  DELEGATION_REGISTRY_MAX_CURSOR_LENGTH,
  DELEGATION_REGISTRY_MAX_PAGE_LIMIT,
  type DelegationTranscriptRegistryIdentity,
  type DelegationTranscriptAnswer,
  type DelegationTranscriptChange,
  type DelegationTranscriptCardStateRequest,
  type DelegationTranscriptContentRange,
  type DelegationTranscriptPort,
  type DelegationTranscriptPortErrorCode,
  type DelegationTranscriptPortResult,
  type DelegationTranscriptReceipt,
  type DelegationTranscriptSettleRequest,
  type DelegationTranscriptSettleResult,
  type DelegationTranscriptResultsPage,
  type DelegationTranscriptRegistryPageRequest,
  type DelegationTranscriptGenerationRegistration,
  type DelegationTranscriptGenerationEntry,
  type DelegationTranscriptResultRequest,
  type DelegationTranscriptResultEntry,
  type DelegationTranscriptReceiptAppendResult,
  type DelegationTranscriptReceiptEntry,
  type DelegationTranscriptReceiptIdentity,
  type DelegationTranscriptGenerationRequest,
  type DelegationTranscriptGeneration,
  type DelegationTranscriptGenerationsPage,
  type DelegationTranscriptResultAnswerRequest,
  type DelegationTranscriptSettlementKeyRequest,
  type DelegationTranscriptRowsPage,
  type DelegationTranscriptStreamState,
  type DelegationTranscriptTarget,
} from './transcript-port';

import { isDelegationStopReason } from '@canopy/protocol/delegation';
import { validateDelegationReceiptEntry } from './receipt-reply';
import {
  canonicalDelegationJson,
  delegationTranscriptSettlementDigest,
} from './settlement-identity';
import {
  canonicalCardState,
  chooseSettlementCardDraft,
  prepareCardStateUpdate,
} from './card-state-rules';

interface InMemoryDelegationTranscriptOwnerScope {
  owns(target: DelegationTranscriptTarget): boolean;
  ownsChat?(chatId: string): boolean;
}

interface StoredStream {
  state: DelegationTranscriptStreamState;
  readonly rows: Map<string, DelegationChildRow>;
  readonly openRows: Map<string, DelegationChildRow>;
  readonly finalRows: DelegationChildRow[];
  readonly admissions: Map<
    string,
    { streamRevision: number; mutationKey: string }
  >;
  contentRevision: number | null;
}

interface StoredCursor {
  readonly targetKey: string;
  readonly streamRevision: number;
  readonly endIndex: number;
}

interface StoredRegistry {
  readonly generations: Map<number, DelegationTranscriptGenerationEntry>;
  readonly results: Map<number, DelegationTranscriptResultEntry>;
  readonly keys: Map<string, DelegationTranscriptResultEntry>;
  readonly byGeneration: Map<number, DelegationTranscriptResultEntry>;
  lastResultIndex: number;
}

interface RegistryCursor {
  readonly scope: string;
  readonly kind: 'results' | 'generations';
  readonly highWater: number;
  readonly position: number;
  /** Generation pages fence results at the last index of their first page. */
  readonly resultHighWater: number;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 512;
const MIN_CONTENT_RANGE_LIMIT = 4;
const MAX_CONTENT_RANGE_LIMIT = 65_536;

function success<T>(value: T): DelegationTranscriptPortResult<T> {
  return { ok: true, value };
}

function failure<T>(
  code: DelegationTranscriptPortErrorCode,
  message: string,
  retryable = false,
  storedItemRevision?: number,
  storedLastResultIndex?: number,
): DelegationTranscriptPortResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(storedItemRevision === undefined ? {} : { storedItemRevision }),
      ...(storedLastResultIndex === undefined ? {} : { storedLastResultIndex }),
    },
  };
}

function canceled<T>(
  signal?: AbortSignal,
): DelegationTranscriptPortResult<T> | undefined {
  return signal?.aborted
    ? failure('storage_failure', 'The transcript operation was aborted.', true)
    : undefined;
}

function clone<T>(value: T): T {
  const copied = structuredClone(value);
  // Native structuredClone can return objects from a different realm (notably
  // the Jest VM). Rehome JSON containers so the canonical encoder sees plain
  // objects; values, key order and UTF-16 code units remain unchanged.
  function rehome(current: unknown): void {
    if (Array.isArray(current)) {
      Object.setPrototypeOf(current, Array.prototype);
      current.forEach(rehome);
    } else if (isRecord(current)) {
      Object.setPrototypeOf(current, Object.prototype);
      Object.values(current).forEach(rehome);
    }
  }
  rehome(copied);
  return copied;
}

function stageStream(stream: StoredStream): StoredStream {
  return {
    state: clone(stream.state),
    rows: new Map(stream.rows),
    openRows: new Map(stream.openRows),
    finalRows: [...stream.finalRows],
    admissions: new Map(stream.admissions),
    contentRevision: stream.contentRevision,
  };
}

function receiptKey(input: DelegationTranscriptReceiptIdentity): string {
  return JSON.stringify([input.receiptKind, input.key]);
}

function targetKey(target: DelegationTranscriptTarget): string {
  return JSON.stringify([
    target.kind,
    target.chatId,
    target.delegationId,
    target.runGeneration,
  ]);
}

function owns(
  scope: InMemoryDelegationTranscriptOwnerScope,
  target: DelegationTranscriptTarget,
): boolean {
  try {
    return scope.owns(target);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logicalRowJson(row: DelegationChildRow): string | undefined {
  try {
    const encoded = canonicalDelegationJson(row);
    return typeof encoded === 'string' ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function logicalRowsEqual(
  left: DelegationChildRow,
  right: DelegationChildRow,
): boolean {
  const leftJson = logicalRowJson(left);
  const rightJson = logicalRowJson(right);
  return leftJson !== undefined && leftJson === rightJson;
}

function hasStorageFields(row: DelegationChildRow): boolean {
  if (Reflect.has(row, 'blocksRef')) return true;
  return row.blocks.some(
    (block) =>
      Reflect.has(block, 'outputTruncated') ||
      Reflect.has(block, 'textRef') ||
      Reflect.has(block, 'inputRef') ||
      Reflect.has(block, 'fullOutputRef') ||
      Reflect.has(block, 'partialTextRef') ||
      Reflect.has(block, 'finalTextRef'),
  );
}

function validRow(row: DelegationChildRow): boolean {
  if (
    !isRecord(row) ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    !Number.isSafeInteger(row.itemRevision) ||
    row.itemRevision < 0 ||
    typeof row.final !== 'boolean' ||
    typeof row.timestamp !== 'number' ||
    !Number.isFinite(row.timestamp) ||
    !Array.isArray(row.blocks) ||
    !row.blocks.every(isRecord)
  ) {
    return false;
  }
  return (
    row.delegationSequence === undefined ||
    (Number.isSafeInteger(row.delegationSequence) &&
      row.delegationSequence >= 0)
  );
}

function compareRows(
  left: DelegationChildRow,
  right: DelegationChildRow,
): number {
  const leftSequence = left.delegationSequence ?? 0;
  const rightSequence = right.delegationSequence ?? 0;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function invalidRange<T>(): DelegationTranscriptPortResult<T> {
  return failure('invalid_request', 'The transcript content range is invalid.');
}

function fieldText(
  block: DelegationChildRow['blocks'][number],
  field: TranscriptContentField,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(block, field)) return undefined;
  const value: unknown = Reflect.get(block, field);
  return typeof value === 'string' ? value : undefined;
}

function byteRange(
  bytes: Buffer,
  encoding: 'utf8' | 'utf16le',
  offset: number,
  limit: number,
): DelegationTranscriptPortResult<DelegationTranscriptContentRange> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < MIN_CONTENT_RANGE_LIMIT ||
    limit > MAX_CONTENT_RANGE_LIMIT
  )
    return invalidRange();
  if (offset > bytes.length) return invalidRange();
  if (encoding === 'utf8') {
    if (offset < bytes.length && isUtf8ContinuationByte(bytes[offset])) {
      return invalidRange();
    }
  } else {
    if (offset % 2 !== 0) return invalidRange();
    if (
      offset >= 2 &&
      offset < bytes.length &&
      isHighSurrogate(bytes.readUInt16LE(offset - 2)) &&
      isLowSurrogate(bytes.readUInt16LE(offset))
    ) {
      return invalidRange();
    }
  }

  let end = Math.min(offset + limit, bytes.length);
  if (encoding === 'utf8') {
    while (
      end > offset &&
      end < bytes.length &&
      isUtf8ContinuationByte(bytes[end])
    ) {
      end -= 1;
    }
  } else {
    end -= (end - offset) % 2;
    if (
      end - offset >= 2 &&
      end < bytes.length &&
      isHighSurrogate(bytes.readUInt16LE(end - 2)) &&
      isLowSurrogate(bytes.readUInt16LE(end))
    ) {
      end -= 2;
    }
  }
  const returnedBytes = bytes.subarray(offset, end);
  return success({
    text: returnedBytes.toString(encoding),
    ...(end < bytes.length ? { nextOffset: end } : {}),
    byteLength: bytes.length,
    encoding,
  });
}

function registryKey(input: DelegationTranscriptRegistryIdentity): string {
  return JSON.stringify([input.chatId, input.delegationId]);
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATION_REGISTRY_MAX_ID_LENGTH
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function onlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedEntry(value: unknown): boolean {
  try {
    return (
      Buffer.byteLength(canonicalDelegationJson(value), 'utf8') <=
      DELEGATION_REGISTRY_MAX_ENTRY_BYTES
    );
  } catch {
    return false;
  }
}

function validRegistration(
  input: DelegationTranscriptGenerationRegistration,
): boolean {
  return (
    Number.isSafeInteger(input.runGeneration) &&
    input.runGeneration >= 1 &&
    Number.isSafeInteger(input.createdAt) &&
    (input.store === 'stream' || input.store === 'legacy') &&
    (input.executionMode === 'background' ||
      input.executionMode === 'foreground') &&
    isRecord(input.origin) &&
    onlyKeys(input.origin, ['kind', 'anchorMessageId', 'authoredItemId']) &&
    ['launch', 'follow_up', 'resume', 'continuation'].includes(
      input.origin.kind,
    ) &&
    (input.origin.anchorMessageId === undefined ||
      validId(input.origin.anchorMessageId)) &&
    (input.origin.authoredItemId === undefined ||
      validId(input.origin.authoredItemId)) &&
    onlyKeys(input, [
      'chatId',
      'delegationId',
      'runGeneration',
      'createdAt',
      'store',
      'origin',
      'executionMode',
    ]) &&
    boundedEntry(input)
  );
}

function validSettlement(input: DelegationTranscriptSettleRequest): boolean {
  const outcome = input.outcome;
  if (
    !validId(input.settlementKey) ||
    !Number.isSafeInteger(input.resultIndex) ||
    !isRecord(outcome) ||
    !onlyKeys(outcome, [
      'status',
      'error',
      'usage',
      'stopReason',
      'startedAt',
      'finishedAt',
    ]) ||
    ![
      'completed',
      'failed',
      'cancelled',
      'deadline_exceeded',
      'interrupted',
    ].includes(outcome.status) ||
    !Number.isSafeInteger(outcome.finishedAt) ||
    (outcome.startedAt !== undefined &&
      !Number.isSafeInteger(outcome.startedAt))
  )
    return false;
  if (outcome.error !== undefined) {
    const error = outcome.error;
    if (
      !isRecord(error) ||
      !onlyKeys(error, ['code', 'message', 'retryable']) ||
      ![
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
      ].includes(error.code) ||
      typeof error.message !== 'string' ||
      error.message.length > DELEGATION_REGISTRY_MAX_ERROR_LENGTH ||
      typeof error.retryable !== 'boolean'
    )
      return false;
  }
  if (
    outcome.stopReason !== undefined &&
    !isDelegationStopReason(outcome.stopReason)
  )
    return false;
  if (
    outcome.usage !== undefined &&
    (!isRecord(outcome.usage) ||
      !onlyKeys(outcome.usage, [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ]) ||
      !Object.entries(outcome.usage).every(
        ([key, value]) =>
          typeof value === 'number' &&
          value >= 0 &&
          (key === 'costUsd'
            ? Number.isFinite(value)
            : Number.isSafeInteger(value)),
      ))
  )
    return false;
  return (
    Array.isArray(input.finalChanges) &&
    input.finalChanges.every(
      (change: DelegationTranscriptChange) =>
        change !== null &&
        typeof change === 'object' &&
        validRow(change.row) &&
        !hasStorageFields(change.row),
    ) &&
    (input.answer === null ||
      (isRecord(input.answer) &&
        (input.answer.role === 'final' || input.answer.role === 'partial') &&
        (('text' in input.answer &&
          onlyKeys(input.answer, ['role', 'text']) &&
          typeof input.answer.text === 'string') ||
          ('lost' in input.answer &&
            onlyKeys(input.answer, ['role', 'lost']) &&
            isRecord(input.answer.lost) &&
            onlyKeys(input.answer.lost, ['sha256', 'length']) &&
            typeof input.answer.lost.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(input.answer.lost.sha256) &&
            positiveInteger(input.answer.lost.length))))) &&
    (input.openRows === undefined ||
      input.openRows === 'reject' ||
      input.openRows === 'finalize')
  );
}

/** In-memory implementation for tests and the manually driven development broker. */
/* eslint-disable @typescript-eslint/require-await -- The port contract is asynchronous; this in-memory implementation resolves synchronously. */
export class InMemoryDelegationTranscriptPort implements DelegationTranscriptPort {
  protected readonly streams = new Map<string, StoredStream>();
  private readonly cursors = new Map<string, StoredCursor>();
  protected readonly registries = new Map<string, StoredRegistry>();
  private readonly registryCursors = new Map<string, RegistryCursor>();
  private readonly receipts = new Map<
    string,
    Map<string, DelegationTranscriptReceiptEntry>
  >();
  protected readonly answers = new Map<
    string,
    { bytes: Buffer; encoding: 'utf8' | 'utf16le' }
  >();

  public constructor(
    private readonly ownerScope: InMemoryDelegationTranscriptOwnerScope,
  ) {}

  public async appendReceipt(
    input: DelegationTranscriptReceiptEntry,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptReceiptAppendResult>
  > {
    const allowed = this.receiptAccess(input.chatId, signal);
    if (!allowed.ok) return allowed;
    const checked = validateDelegationReceiptEntry(input);
    if (!checked.ok) return failure('invalid_request', checked.reason);
    const entry = clone(checked.entry);
    const key = receiptKey(entry);
    let receipts = this.receipts.get(entry.chatId);
    const existing = receipts?.get(key);
    if (existing !== undefined)
      return canonicalDelegationJson(existing) ===
        canonicalDelegationJson(entry)
        ? success({ entry: clone(existing), replayed: true })
        : failure(
            'conflict',
            'The receipt key already names different content.',
          );
    if (receipts === undefined) {
      receipts = new Map();
      this.receipts.set(entry.chatId, receipts);
    }
    receipts.set(key, entry);
    return success({ entry: clone(entry), replayed: false });
  }

  public async receipt(
    input: DelegationTranscriptReceiptIdentity,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceiptEntry>> {
    const allowed = this.receiptAccess(input.chatId, signal);
    if (!allowed.ok) return allowed;
    if (
      !['command', 'stop', 'stop_outcome'].includes(input.receiptKind) ||
      typeof input.key !== 'string' ||
      !(input.receiptKind === 'stop_outcome'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            input.key,
          )
        : /^[0-9a-f]{64}$/.test(input.key))
    )
      return failure('invalid_request', 'The receipt identity is invalid.');
    const entry = this.receipts.get(input.chatId)?.get(receiptKey(input));
    return entry === undefined
      ? failure('not_found', 'The receipt was not found.')
      : success(clone(entry));
  }

  public async resultBySettlementKey(
    input: DelegationTranscriptSettlementKeyRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    if (!validId(input.settlementKey))
      return failure('invalid_request', 'The settlement key is invalid.');
    const entry = this.registries
      .get(registryKey(input))
      ?.keys.get(input.settlementKey);
    return entry === undefined
      ? failure('not_found', 'The result was not found.')
      : success(clone(entry));
  }

  public async resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    if (!positiveInteger(input.runGeneration))
      return failure('invalid_request', 'The generation is invalid.');
    const entry = this.registries
      .get(registryKey(input))
      ?.byGeneration.get(input.runGeneration);
    return entry === undefined
      ? failure('not_found', 'The result was not found.')
      : success(clone(entry));
  }

  /** Trusted host lifecycle hook; drops this chat's complete memory namespace. */
  public removeChat(chatId: string): void {
    this.receipts.delete(chatId);
    const registryPrefix = `${JSON.stringify([chatId]).slice(0, -1)},`;
    this.registries.forEach((_registry, key) => {
      if (key.startsWith(registryPrefix)) this.registries.delete(key);
    });
    this.streams.forEach((stream, key) => {
      if (stream.state.target.chatId === chatId) {
        this.streams.delete(key);
        this.cursors.forEach((cursor, cursorKey) => {
          if (cursor.targetKey === key) this.cursors.delete(cursorKey);
        });
      }
    });
    this.registryCursors.forEach((cursor, key) => {
      if (cursor.scope.startsWith(registryPrefix))
        this.registryCursors.delete(key);
    });
    const retainedAnswers = new Set<string>();
    this.registries.forEach((registry) => {
      registry.results.forEach((result) => {
        if (result.answer.kind === 'body')
          retainedAnswers.add(result.answer.ref.artifactId);
      });
    });
    this.answers.forEach((_answer, key) => {
      if (!retainedAnswers.has(key)) this.answers.delete(key);
    });
  }

  private receiptAccess(
    chatId: string,
    signal?: AbortSignal,
  ): DelegationTranscriptPortResult<undefined> {
    const aborted = canceled<undefined>(signal);
    if (aborted !== undefined) return aborted;
    let allowed = false;
    try {
      allowed = this.ownerScope.ownsChat?.(chatId) === true;
    } catch {
      // Missing and failing ownership predicates both fail closed.
    }
    if (!allowed)
      return failure(
        'unauthorized',
        'This chat is outside the captured owner scope.',
      );
    if (!validId(chatId))
      return failure(
        'invalid_request',
        'The receipt chat identity is invalid.',
      );
    return success(undefined);
  }

  public async open(
    input: { readonly target: DelegationTranscriptTarget },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    const aborted = canceled<DelegationTranscriptStreamState>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }

    const key = targetKey(input.target);
    const existing = this.streams.get(key);
    if (existing !== undefined) return success(clone(existing.state));

    const state: DelegationTranscriptStreamState = {
      target: clone(input.target),
      status: 'open',
      streamRevision: 0,
      openedAt: Date.now(),
      latestRowTimestamp: null,
    };
    this.streams.set(key, {
      state,
      rows: new Map<string, DelegationChildRow>(),
      openRows: new Map<string, DelegationChildRow>(),
      finalRows: [],
      admissions: new Map(),
      contentRevision: null,
    });
    return success(clone(state));
  }

  public async appendChanges(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly mutationKey: string;
      readonly changes: readonly DelegationTranscriptChange[];
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceipt>> {
    const aborted = canceled<DelegationTranscriptReceipt>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    if (input.mutationKey.length === 0 || input.changes.length === 0) {
      return failure(
        'invalid_request',
        'An admission needs a mutation key and at least one row.',
      );
    }

    const key = targetKey(input.target);
    const stream = this.streams.get(key);
    if (stream === undefined)
      return failure('not_found', 'The transcript stream is not open.');

    return this.admit(input, stream);
  }

  private admit(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly mutationKey: string;
      readonly changes: readonly DelegationTranscriptChange[];
    },
    stream: StoredStream,
  ): DelegationTranscriptPortResult<DelegationTranscriptReceipt> {
    const seenIds = new Set<string>();
    const preparedRows: DelegationChildRow[] = [];
    for (const change of input.changes) {
      const row = change.row;
      if (!validRow(row) || hasStorageFields(row)) {
        return failure(
          'invalid_request',
          'Transcript rows must be valid logical rows with inline bodies.',
        );
      }
      if (seenIds.has(row.id)) {
        return failure(
          'invalid_request',
          'An admission may change an item only once.',
        );
      }
      seenIds.add(row.id);
      try {
        if (logicalRowJson(row) === undefined)
          return failure(
            'invalid_request',
            'Transcript rows must contain logical JSON values.',
          );
        const copied = clone(row);
        if (logicalRowJson(copied) === undefined) {
          return failure(
            'invalid_request',
            'Transcript rows must contain logical JSON values.',
          );
        }
        preparedRows.push(copied);
      } catch {
        return failure(
          'invalid_request',
          'Transcript rows must be safely copyable logical values.',
        );
      }
    }

    const updates: DelegationChildRow[] = [];
    const itemVersions: DelegationTranscriptReceipt['items'][number][] = [];
    for (const row of preparedRows) {
      const stored = stream.rows.get(row.id);
      if (stored === undefined) {
        if (row.itemRevision !== 0) {
          return failure(
            'stale_identity',
            'A new child item must start at revision zero.',
          );
        }
        updates.push(row);
        itemVersions.push({
          id: row.id,
          itemRevision: row.itemRevision,
          final: row.final,
        });
        continue;
      }

      if (
        row.itemRevision === stored.itemRevision &&
        logicalRowsEqual(row, stored)
      ) {
        itemVersions.push({
          id: row.id,
          itemRevision: row.itemRevision,
          final: row.final,
        });
        continue;
      }
      if (stored.final) {
        return failure(
          'conflict',
          'A finalized child item cannot be changed.',
          false,
          stored.itemRevision,
        );
      }
      if (row.delegationSegment !== stored.delegationSegment) {
        return failure(
          'conflict',
          'A child item cannot change its delegation segment.',
          false,
          stored.itemRevision,
        );
      }
      if (row.itemRevision === stored.itemRevision) {
        return failure(
          'conflict',
          'The stored child revision has different content.',
          false,
          stored.itemRevision,
        );
      }
      if (row.itemRevision !== stored.itemRevision + 1) {
        return failure(
          'stale_identity',
          'A child item revision is stale or gapped.',
          true,
          stored.itemRevision,
        );
      }
      updates.push(row);
      itemVersions.push({
        id: row.id,
        itemRevision: row.itemRevision,
        final: row.final,
      });
    }

    const replayed = updates.length === 0;
    let receiptRevision = stream.state.streamRevision;
    let receiptKey = input.mutationKey;
    if (replayed) {
      let commonKey: string | undefined;
      let sameKey = true;
      receiptRevision = 0;
      for (const row of preparedRows) {
        const admission = stream.admissions.get(row.id);
        if (admission === undefined)
          return failure(
            'unsupported_format',
            'The item has no original admission metadata.',
          );
        receiptRevision = Math.max(receiptRevision, admission.streamRevision);
        if (commonKey === undefined) commonKey = admission.mutationKey;
        else if (commonKey !== admission.mutationKey) sameKey = false;
      }
      if (sameKey && commonKey !== undefined) receiptKey = commonKey;
    } else {
      if (stream.state.status === 'settled')
        return failure(
          'conflict',
          'A settled transcript cannot admit new content.',
        );
      if (!Number.isSafeInteger(stream.state.streamRevision + 1)) {
        return failure(
          'storage_failure',
          'The transcript stream revision is exhausted.',
          true,
        );
      }
      for (const row of updates) {
        stream.rows.set(row.id, row);
        if (row.final) stream.openRows.delete(row.id);
        else stream.openRows.set(row.id, row);
        if (row.final) stream.finalRows.push(row);
        stream.admissions.set(row.id, {
          streamRevision: stream.state.streamRevision + 1,
          mutationKey: input.mutationKey,
        });
      }
      stream.state = {
        ...stream.state,
        target: clone(stream.state.target),
        status: stream.state.status,
        streamRevision: stream.state.streamRevision + 1,
        latestRowTimestamp: updates.reduce<number | null>(
          (latest, row) =>
            latest === null ? row.timestamp : Math.max(latest, row.timestamp),
          stream.state.latestRowTimestamp,
        ),
      };
      receiptRevision = stream.state.streamRevision;
    }

    return success({
      target: clone(input.target),
      mutationKey: receiptKey,
      streamRevision: receiptRevision,
      items: clone(itemVersions),
      replayed,
    });
  }

  public async flush(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    const aborted = canceled<DelegationTranscriptStreamState>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    if (
      !Number.isSafeInteger(input.streamRevision) ||
      input.streamRevision < 0
    ) {
      return failure(
        'invalid_request',
        'The requested stream revision is invalid.',
      );
    }
    const stream = this.streams.get(targetKey(input.target));
    if (stream === undefined)
      return failure('not_found', 'The transcript stream is not open.');
    if (input.streamRevision > stream.state.streamRevision) {
      return failure(
        'stale_identity',
        'The requested stream revision has not been admitted.',
        true,
      );
    }
    return success(clone(stream.state));
  }

  public async updateCardState(
    input: DelegationTranscriptCardStateRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    const aborted = canceled<DelegationTranscriptStreamState>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target))
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    if (
      input.target.kind !== 'delegation' ||
      !validId(input.target.chatId) ||
      !validId(input.target.delegationId) ||
      !Number.isSafeInteger(input.target.runGeneration) ||
      input.target.runGeneration < 1 ||
      !Number.isSafeInteger(input.cardRevision) ||
      input.cardRevision < 0
    )
      return failure(
        'invalid_request',
        'The card-state publication is invalid.',
      );
    const stream = this.streams.get(targetKey(input.target));
    if (stream === undefined)
      return failure('not_found', 'The transcript stream is not open.');
    const prepared = prepareCardStateUpdate(
      stream.state.cardState,
      stream.state.status === 'settled',
      input.cardRevision,
      input.cardDraft,
    );
    if (!prepared.ok) return prepared;
    if (prepared.value.replayed) return success(clone(stream.state));
    if (!Number.isSafeInteger(stream.state.streamRevision + 1))
      return failure('invalid_request', 'The stream revision is exhausted.');
    stream.state = {
      ...stream.state,
      streamRevision: stream.state.streamRevision + 1,
      cardState: clone(prepared.value.cardState),
    };
    return success(clone(stream.state));
  }

  public async settle(
    input: DelegationTranscriptSettleRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptSettleResult>> {
    const aborted = canceled<DelegationTranscriptSettleResult>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    if (
      !validId(input.target.chatId) ||
      !validId(input.target.delegationId) ||
      !Number.isSafeInteger(input.target.runGeneration) ||
      input.target.runGeneration < 1 ||
      !validSettlement(input)
    ) {
      return failure('invalid_request', 'The settlement metadata is invalid.');
    }
    let digest: string;
    try {
      digest = delegationTranscriptSettlementDigest(input);
    } catch {
      return failure(
        'invalid_request',
        'The settlement must contain unique logical JSON rows.',
      );
    }
    const registry = this.registry(input.target);
    const existing = registry.keys.get(input.settlementKey);
    if (existing !== undefined) {
      return existing.settlementDigest === digest
        ? success(this.settleResult(input.target, existing, true))
        : failure(
            'conflict',
            'The settlement key already names different content.',
          );
    }
    const key = targetKey(input.target);
    const stream = this.streams.get(key);
    if (stream === undefined)
      return failure('not_found', 'The transcript stream is not open.');
    if (stream.state.status === 'settled')
      return failure('conflict', 'The transcript is already settled.');
    const last = registry.lastResultIndex;
    if (last === Number.MAX_SAFE_INTEGER)
      return failure('invalid_request', 'The result index is exhausted.');
    if (input.resultIndex < 1 || (last !== 0 && input.resultIndex !== last + 1))
      return failure(
        'conflict',
        'The result index is not consecutive.',
        false,
        undefined,
        last,
      );
    if (!Number.isSafeInteger(stream.state.streamRevision + 1))
      return failure('invalid_request', 'The stream revision is exhausted.');

    const chosen = chooseSettlementCardDraft(stream.state.cardState, input);
    if (!chosen.ok) return chosen;

    // Every mutation below is staged. No await occurs between validation and
    // publication: synchronous memory operations serialize each delegation (and
    // its targets) on the JS event loop without a re-entrant asynchronous lock.
    let staged = stageStream(stream);
    if (input.finalChanges.length > 0) {
      const admission = this.admit(
        {
          target: input.target,
          mutationKey: input.settlementKey,
          changes: input.finalChanges,
        },
        staged,
      );
      if (!admission.ok) return admission;
    }
    if (input.openRows === 'finalize' && staged.openRows.size > 0) {
      const automatic: DelegationTranscriptChange[] = [];
      for (const row of Array.from(staged.openRows.values())) {
        if (!Number.isSafeInteger(row.itemRevision + 1))
          return failure('invalid_request', 'The item revision is exhausted.');
        automatic.push({
          row: { ...row, itemRevision: row.itemRevision + 1, final: true },
        });
      }
      // The first admission is a dry run. Admit the combined set once so every
      // changed row gets the same P8 revision and raw settlement key.
      staged = stageStream(stream);
      const admission = this.admit(
        {
          target: input.target,
          mutationKey: input.settlementKey,
          changes: [...input.finalChanges, ...automatic],
        },
        staged,
      );
      if (!admission.ok) return admission;
    }
    if (staged.openRows.size > 0)
      return failure('conflict', 'A transcript with open items cannot settle.');
    const revision = stream.state.streamRevision + 1;
    staged.state = {
      ...staged.state,
      status: 'settled',
      streamRevision: revision,
    };
    staged.contentRevision = revision;
    const body =
      input.answer === null ||
      !('text' in input.answer) ||
      input.answer.text === ''
        ? undefined
        : ({
            encoding: hasLoneSurrogate(input.answer.text) ? 'utf16le' : 'utf8',
            text: input.answer.text,
          } satisfies { encoding: 'utf8' | 'utf16le'; text: string });
    let answer: DelegationTranscriptAnswer;
    let bytes: Buffer | undefined;
    if (input.answer === null) answer = { kind: 'none' };
    else if ('lost' in input.answer)
      answer = { kind: 'lost', role: input.answer.role, ...input.answer.lost };
    else if (body === undefined)
      answer = { kind: 'empty', role: input.answer.role };
    else {
      bytes = Buffer.from(body.text, body.encoding);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      answer = {
        kind: 'body',
        role: input.answer.role,
        byteLength: bytes.length,
        encoding: body.encoding,
        sha256,
        ref: {
          version: 1,
          artifactId: sha256,
          byteLength: bytes.length,
          sha256,
          encoding: body.encoding === 'utf8' ? 'utf-8' : 'utf-16le',
          mediaType: 'text/plain',
        },
      };
    }
    const physical = createHash('sha256');
    for (const row of staged.finalRows)
      physical.update(`${JSON.stringify(row)}\n`, 'utf8');
    const result: DelegationTranscriptResultEntry = {
      version: 1,
      kind: 'result',
      resultIndex: input.resultIndex,
      runGeneration: input.target.runGeneration,
      settlementKey: input.settlementKey,
      settlementDigest: digest,
      outcome: clone(input.outcome),
      answer,
      settlement: {
        streamRevision: revision,
        contentRevision: revision,
        finalItemCount: staged.finalRows.length,
        finalItemsDigest: physical.digest('hex'),
      },
    };
    const canonical = canonicalCardState(input, answer);
    const cardState = CardStateV2Schema.safeParse({
      ...chosen.value,
      canonical,
    });
    if (!cardState.success)
      return failure(
        'invalid_request',
        'The canonical card state exceeds its bound.',
      );
    staged.state = { ...staged.state, cardState: cardState.data };
    if (!boundedEntry(result))
      return failure(
        'invalid_request',
        'The result entry exceeds its metadata bound.',
      );
    if (answer.kind === 'body' && bytes !== undefined)
      this.answers.set(answer.ref.artifactId, {
        bytes,
        encoding: answer.encoding,
      });
    this.streams.set(key, staged);
    registry.results.set(result.resultIndex, result);
    registry.lastResultIndex = result.resultIndex;
    registry.keys.set(result.settlementKey, result);
    registry.byGeneration.set(result.runGeneration, result);
    return success(this.settleResult(input.target, result, false));
  }

  public async page(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
      readonly cursor?: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptRowsPage>> {
    const aborted = canceled<DelegationTranscriptRowsPage>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    if (
      !Number.isSafeInteger(input.streamRevision) ||
      input.streamRevision < 0 ||
      (input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > MAX_PAGE_LIMIT))
    ) {
      return failure(
        'invalid_request',
        'The transcript page request is invalid.',
      );
    }

    const key = targetKey(input.target);
    const pinned = this.pinnedStream(input.target, input.streamRevision);
    if (!pinned.ok) return pinned;
    const stream = pinned.value;
    const revision = stream.contentRevision ?? stream.state.streamRevision;

    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const orderedRows = Array.from(stream.rows.values()).sort(compareRows);
    let endIndex = orderedRows.length;
    if (input.cursor !== undefined) {
      const cursor = this.cursors.get(input.cursor);
      if (
        cursor === undefined ||
        cursor.targetKey !== key ||
        cursor.streamRevision !== revision
      ) {
        return failure(
          'invalid_request',
          'The transcript cursor does not belong to this pinned stream.',
        );
      }
      endIndex = cursor.endIndex;
    }

    const startIndex = Math.max(0, endIndex - limit);
    const nextCursor =
      startIndex > 0 ? this.createCursor(key, revision, startIndex) : undefined;
    return success({
      rows: clone(orderedRows.slice(startIndex, endIndex)),
      streamRevision: revision,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    });
  }

  public async message(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
      readonly messageId: string;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationChildRow>> {
    const aborted = canceled<DelegationChildRow>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    const streamResult = this.pinnedStream(input.target, input.streamRevision);
    if (!streamResult.ok) return streamResult;
    const row = streamResult.value.rows.get(input.messageId);
    return row === undefined
      ? failure('not_found', 'The child transcript row was not found.')
      : success(clone(row));
  }

  public async contentRange(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
      readonly messageId: string;
      readonly blockOrdinal: number;
      readonly field: TranscriptContentField;
      readonly offset: number;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptContentRange>> {
    const aborted = canceled<DelegationTranscriptContentRange>(signal);
    if (aborted !== undefined) return aborted;
    if (!owns(this.ownerScope, input.target)) {
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    }
    if (
      !Number.isSafeInteger(input.blockOrdinal) ||
      input.blockOrdinal < 0 ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < MIN_CONTENT_RANGE_LIMIT ||
      input.limit > MAX_CONTENT_RANGE_LIMIT
    ) {
      return invalidRange();
    }

    const streamResult = this.pinnedStream(input.target, input.streamRevision);
    if (!streamResult.ok) return streamResult;
    const row = streamResult.value.rows.get(input.messageId);
    if (row === undefined)
      return failure('not_found', 'The child transcript row was not found.');
    const block = row.blocks[input.blockOrdinal];
    if (block === undefined)
      return failure('not_found', 'The child transcript block was not found.');
    const text = fieldText(block, input.field);
    if (text === undefined)
      return failure('not_found', 'The child transcript field was not found.');

    return byteRange(
      Buffer.from(text, hasLoneSurrogate(text) ? 'utf16le' : 'utf8'),
      hasLoneSurrogate(text) ? 'utf16le' : 'utf8',
      input.offset,
      input.limit,
    );
  }

  public async resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultsPage>> {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    const registry = this.registry(input);
    const entries = Array.from(registry.results.values());
    const page = this.registryPage(
      input,
      'results',
      entries,
      registry.lastResultIndex,
    );
    if (!page.ok) return page;
    return success({
      results: clone(page.value.entries),
      ...(page.value.cursor === undefined ? {} : { cursor: page.value.cursor }),
    });
  }

  public async registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationEntry>
  > {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    if (!validRegistration(input))
      return failure('invalid_request', 'The generation metadata is invalid.');
    const registry = this.registry(input);
    const entry: DelegationTranscriptGenerationEntry = {
      ...clone(input),
      version: 1,
      kind: 'generation',
    };
    const existing = registry.generations.get(input.runGeneration);
    if (existing !== undefined)
      return canonicalDelegationJson(existing) ===
        canonicalDelegationJson(entry)
        ? success(clone(existing))
        : failure('conflict', 'The generation already has different metadata.');
    if (!boundedEntry(entry))
      return failure(
        'invalid_request',
        'The generation entry exceeds its metadata bound.',
      );
    registry.generations.set(input.runGeneration, entry);
    return success(clone(entry));
  }

  public async result(
    input: DelegationTranscriptResultRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    if (!positiveInteger(input.resultIndex))
      return failure('invalid_request', 'The result index is invalid.');
    const entry = this.registry(input).results.get(input.resultIndex);
    return entry === undefined
      ? failure('not_found', 'The result was not found.')
      : success(clone(entry));
  }

  public async generation(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptGeneration>> {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    if (
      !(Number.isSafeInteger(input.runGeneration) && input.runGeneration >= 1)
    )
      return failure('invalid_request', 'The generation is invalid.');
    const registry = this.registry(input);
    const entry = registry.generations.get(input.runGeneration);
    return entry === undefined
      ? failure('not_found', 'The generation was not found.')
      : success(this.projectGeneration(entry, registry));
  }

  public async generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationsPage>
  > {
    const allowed = this.registryAccess(input, signal);
    if (!allowed.ok) return allowed;
    const registry = this.registry(input);
    const page = this.registryPage(
      input,
      'generations',
      Array.from(registry.generations.values()),
      registry.lastResultIndex,
    );
    if (!page.ok) return page;
    return success({
      generations: page.value.entries.map((entry) =>
        this.projectGeneration(entry, registry, page.value.resultHighWater),
      ),
      ...(page.value.cursor === undefined ? {} : { cursor: page.value.cursor }),
    });
  }

  public async resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptContentRange>> {
    const result = await this.result(input, signal);
    if (!result.ok) return result;
    const answer = result.value.answer;
    switch (answer.kind) {
      case 'none':
        return failure('not_found', 'The result has no answer.');
      case 'lost':
        return failure(
          'answer_unavailable',
          'The result answer is unavailable.',
        );
      case 'empty':
        return byteRange(Buffer.alloc(0), 'utf8', input.offset, input.limit);
      case 'body': {
        const body = this.answers.get(answer.ref.artifactId);
        if (body === undefined)
          return failure('corruption', 'The result answer body is missing.');
        // Bytes are shared by digest; their encoding belongs to the result.
        return byteRange(
          body.bytes,
          answer.encoding,
          input.offset,
          input.limit,
        );
      }
    }
  }

  private registry(
    input: DelegationTranscriptRegistryIdentity,
  ): StoredRegistry {
    const key = registryKey(input);
    let registry = this.registries.get(key);
    if (registry === undefined) {
      registry = {
        generations: new Map(),
        results: new Map(),
        keys: new Map(),
        byGeneration: new Map(),
        lastResultIndex: 0,
      };
      this.registries.set(key, registry);
    }
    return registry;
  }

  private registryAccess(
    input: DelegationTranscriptRegistryIdentity & {
      readonly runGeneration?: number;
    },
    signal?: AbortSignal,
  ): DelegationTranscriptPortResult<undefined> {
    const aborted = canceled<undefined>(signal);
    if (aborted !== undefined) return aborted;
    if (
      !owns(this.ownerScope, {
        kind: 'delegation',
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration ?? 1,
      })
    )
      return failure(
        'unauthorized',
        'This transcript target is outside the captured owner scope.',
      );
    if (!validId(input.chatId) || !validId(input.delegationId))
      return failure('invalid_request', 'The registry identity is invalid.');
    return success(undefined);
  }

  private settleResult(
    target: DelegationTranscriptTarget,
    result: DelegationTranscriptResultEntry,
    replayed: boolean,
  ): DelegationTranscriptSettleResult {
    return clone({
      result,
      settlement: {
        target,
        settlementKey: result.settlementKey,
        streamRevision: result.settlement.streamRevision,
        contentRevision: result.settlement.contentRevision,
        finalItemCount: result.settlement.finalItemCount,
        replayed,
      },
    });
  }

  private projectGeneration(
    entry: DelegationTranscriptGenerationEntry,
    registry: StoredRegistry,
    resultHighWater = registry.lastResultIndex,
  ): DelegationTranscriptGeneration {
    const result = registry.byGeneration.get(entry.runGeneration);
    const stream = this.streams.get(
      targetKey({
        kind: 'delegation',
        chatId: entry.chatId,
        delegationId: entry.delegationId,
        runGeneration: entry.runGeneration,
      }),
    );
    return clone({
      entry,
      stream:
        stream === undefined || entry.store === 'legacy'
          ? null
          : { ...stream.state, contentRevision: stream.contentRevision },
      result:
        result !== undefined && result.resultIndex <= resultHighWater
          ? result
          : null,
    });
  }

  private registryPage<T>(
    input: DelegationTranscriptRegistryPageRequest,
    kind: RegistryCursor['kind'],
    entries: readonly T[],
    lastResultIndex: number,
  ): DelegationTranscriptPortResult<{
    entries: readonly T[];
    cursor?: string;
    resultHighWater: number;
  }> {
    if (
      !positiveInteger(input.limit) ||
      input.limit > DELEGATION_REGISTRY_MAX_PAGE_LIMIT
    )
      return failure('invalid_request', 'The registry page limit is invalid.');
    const scope = registryKey(input);
    let highWater = entries.length;
    let position = 0;
    let resultHighWater = lastResultIndex;
    if (input.cursor !== undefined) {
      const cursor = this.registryCursors.get(input.cursor);
      if (
        input.cursor.length > DELEGATION_REGISTRY_MAX_CURSOR_LENGTH ||
        cursor === undefined ||
        cursor.kind !== kind ||
        cursor.scope !== scope ||
        cursor.position < 0 ||
        cursor.position >= cursor.highWater ||
        cursor.highWater > entries.length
      )
        return failure(
          'invalid_request',
          'The registry cursor is invalid for this scope.',
        );
      highWater = cursor.highWater;
      position = cursor.position;
      resultHighWater = cursor.resultHighWater;
    }
    const end = Math.min(highWater, position + input.limit);
    let cursor: string | undefined;
    if (end < highWater) {
      cursor = randomUUID();
      this.registryCursors.set(cursor, {
        scope,
        kind,
        highWater,
        position: end,
        resultHighWater,
      });
    }
    return success({
      entries: entries.slice(position, end),
      ...(cursor === undefined ? {} : { cursor }),
      resultHighWater,
    });
  }

  private pinnedStream(
    target: DelegationTranscriptTarget,
    streamRevision: number,
  ): DelegationTranscriptPortResult<StoredStream> {
    if (!Number.isSafeInteger(streamRevision) || streamRevision < 0) {
      return failure(
        'invalid_request',
        'The pinned stream revision is invalid.',
      );
    }
    const stream = this.streams.get(targetKey(target));
    if (stream === undefined)
      return failure('not_found', 'The transcript stream is not open.');
    if (
      streamRevision > stream.state.streamRevision ||
      (stream.contentRevision === null
        ? streamRevision !== stream.state.streamRevision
        : streamRevision < stream.contentRevision)
    ) {
      return failure(
        'stale_identity',
        'The transcript stream moved after it was observed.',
        true,
      );
    }
    return success(stream);
  }

  private createCursor(
    target: string,
    streamRevision: number,
    endIndex: number,
  ): string {
    const cursor = randomUUID();
    this.cursors.set(cursor, { targetKey: target, streamRevision, endIndex });
    return cursor;
  }
}
/* eslint-enable @typescript-eslint/require-await */
