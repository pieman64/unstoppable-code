import { DelegationRegistryOperationError } from '../../lib/chat-delta-journal/delegation-registry-error';
import type { DelegationRegistryOperations } from '../../lib/chat-delta-journal/delegation-registry-api';
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
} from '../../lib/chat-delta-journal/format';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { decodeChatTranscriptReadCursor } from '../../lib/chat-transcript-read-cursor';
import type {
  DelegationChildRow,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import {
  isPersistedToolOutputReference,
  isTranscriptBlocksReference,
} from '@canopy/agent-transcript/transcript-storage';
import type {
  TranscriptContentField,
  CardState,
  TranscriptStreamDescriptor,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import { TranscriptTargetSchema } from '@canopy/protocol/canopy-core';
import {
  type DelegationTranscriptChange,
  type DelegationTranscriptCardStateRequest,
  type DelegationTranscriptContentRange,
  type DelegationTranscriptPort,
  type DelegationTranscriptPortError,
  type DelegationTranscriptPortErrorCode,
  type DelegationTranscriptPortResult,
  type DelegationTranscriptReceipt,
  type DelegationTranscriptSettleRequest,
  type DelegationTranscriptSettleResult,
  type DelegationTranscriptResultsPage,
  type DelegationTranscriptRegistryPageRequest,
  type DelegationTranscriptGenerationRegistration,
  type DelegationTranscriptGenerationEntry,
  type DelegationTranscriptGeneration,
  type DelegationTranscriptGenerationRequest,
  type DelegationTranscriptGenerationsPage,
  type DelegationTranscriptResultEntry,
  type DelegationTranscriptReceiptAppendResult,
  type DelegationTranscriptReceiptEntry,
  type DelegationTranscriptReceiptIdentity,
  type DelegationTranscriptResultRequest,
  type DelegationTranscriptResultAnswerRequest,
  type DelegationTranscriptSettlementKeyRequest,
  type DelegationTranscriptRowsPage,
  type DelegationTranscriptStreamState,
  type DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';

/**
 * B2's metadata-only reader seam. Parent cards come from the stored point-row
 * reader, not the descriptor overlay; registry access never reads row bodies.
 */
export interface DelegationRecordReadPort {
  generation(
    scope: ChatScopeKey,
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptGeneration | undefined>;
  resultByGeneration(
    scope: ChatScopeKey,
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined>;
  generationsPage(
    scope: ChatScopeKey,
    input: DelegationTranscriptRegistryPageRequest,
  ): Promise<DelegationTranscriptGenerationsPage>;
  getChildStreamState(
    scope: ChatScopeKey,
    target: DelegationTranscriptTarget,
  ): Promise<DelegationRecordReadStreamState | undefined>;
  readStoredParentMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined>;
}

export interface DelegationRecordReadStreamState {
  readonly cardState?: CardState | null;
  readonly target: DelegationTranscriptTarget;
  readonly status: 'open' | 'settled';
  readonly streamRevision: number;
  readonly openedAt?: number;
  readonly latestRowTimestamp?: number | null;
}

/** The narrow, lazy ChatStateService surface used by the repository port. */
export interface RepositoryDelegationTranscriptChatState {
  appendDelegationReceipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['appendDelegationReceipt']>
  ): ReturnType<DelegationRegistryOperations['appendDelegationReceipt']>;
  receipt(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['receipt']>
  ): ReturnType<DelegationRegistryOperations['receipt']>;
  result(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['result']>
  ): ReturnType<DelegationRegistryOperations['result']>;
  resultBySettlementKey(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultBySettlementKey']>
  ): ReturnType<DelegationRegistryOperations['resultBySettlementKey']>;
  resultByGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultByGeneration']>
  ): ReturnType<DelegationRegistryOperations['resultByGeneration']>;
  generation(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generation']>
  ): ReturnType<DelegationRegistryOperations['generation']>;
  resultsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultsPage']>
  ): ReturnType<DelegationRegistryOperations['resultsPage']>;
  generationsPage(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['generationsPage']>
  ): ReturnType<DelegationRegistryOperations['generationsPage']>;
  resultAnswerRange(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['resultAnswerRange']>
  ): ReturnType<DelegationRegistryOperations['resultAnswerRange']>;
  itemAdmission(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['itemAdmission']>
  ): ReturnType<DelegationRegistryOperations['itemAdmission']>;
  registerGeneration(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['registerGeneration']>
  ): ReturnType<DelegationRegistryOperations['registerGeneration']>;
  updateCardState(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['updateCardState']>
  ): ReturnType<DelegationRegistryOperations['updateCardState']>;
  settleDelegationResult(
    scope: ChatScopeKey,
    ...args: Parameters<DelegationRegistryOperations['settleDelegationResult']>
  ): ReturnType<DelegationRegistryOperations['settleDelegationResult']>;

  withChildStreamTarget<T>(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    operation: () => Promise<T>,
  ): Promise<T>;
  openChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor>;
  getChildStreamState(
    scope: ChatScopeKey,
    target: TranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined>;
  commitChildStream(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    mutationKey: string,
    rows: readonly DelegationChildRow[],
  ): Promise<{
    applied: boolean;
    revision: number;
    descriptor: TranscriptStreamDescriptor;
  }>;
  getChildStreamMessage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    messageId: string,
    streamRevision: number,
  ): Promise<DelegationChildRow | undefined>;
  getChildStreamPage(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    cursor?: string,
    limit?: number,
  ): Promise<{
    rows: readonly DelegationChildRow[];
    streamRevision: number;
    cursor?: string;
  }>;
  readChildStreamContent(
    scope: ChatScopeKey,
    target: TranscriptTarget,
    streamRevision: number,
    messageId: string,
    blockOrdinal: number,
    field: TranscriptContentField,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptContentRange>;
}

interface ClassifiedChanges {
  readonly rowsToCommit: readonly DelegationChildRow[];
  readonly items: DelegationTranscriptReceipt['items'];
  readonly replayed: boolean;
}

class TranscriptPortOperationError extends Error {
  public constructor(
    public readonly code: DelegationTranscriptPortErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly storedItemRevision?: number,
  ) {
    super(message);
  }
}

function success<T>(value: T): DelegationTranscriptPortResult<T> {
  return { ok: true, value };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  return errorCodeOf(error) === 'ABORT_ERR';
}

function toPortError(error: unknown): DelegationTranscriptPortError {
  if (error instanceof DelegationRegistryOperationError)
    return structuredClone(error.failure);
  if (error instanceof TranscriptPortOperationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.storedItemRevision === undefined
        ? {}
        : { storedItemRevision: error.storedItemRevision }),
    };
  }

  const message = messageOf(error);
  const cause: unknown =
    error instanceof Error ? Reflect.get(error, 'cause') : undefined;
  if (
    error instanceof ChatStorageNewerFormatError ||
    cause instanceof ChatStorageNewerFormatError
  )
    return { code: 'unsupported_format', message, retryable: false };
  if (isAbortError(error))
    return { code: 'storage_failure', message, retryable: true };
  // These child overlay messages are caller-visible classifications, even
  // when the journal wraps them in its integrity-error class.
  if (message.includes('Final child row is immutable'))
    return { code: 'conflict', message, retryable: false };
  if (
    message.includes('Child item revision is stale or gapped') ||
    message.includes('New child item revision must be zero')
  )
    return { code: 'stale_identity', message, retryable: false };
  if (message.includes('Duplicate child row in effect'))
    return { code: 'invalid_request', message, retryable: false };
  if (
    !(error instanceof ChatDeltaJournalIntegrityError) &&
    (message === 'Invalid child row' ||
      message === 'Invalid child row finality')
  )
    return { code: 'invalid_request', message, retryable: false };
  if (errorCodeOf(error) === 'ENOENT')
    return { code: 'not_found', message, retryable: false };
  if (error instanceof ChatDeltaJournalIntegrityError)
    return {
      code: 'corruption',
      message,
      retryable: false,
    };
  if (
    (error instanceof Error &&
      error.name === 'ChildStreamUnsupportedFormatError') ||
    message.includes('Stream registration requires format 4') ||
    message.includes('Child writes require format 4') ||
    message.includes('enabled format-4 storage') ||
    message.includes('format 4 is disabled') ||
    message.includes('format 2') ||
    message.includes('format 3')
  )
    return { code: 'unsupported_format', message, retryable: false };
  if (
    message.includes('Settled child stream is immutable') ||
    message.includes(
      'reuses an applied mutation with different child content',
    ) ||
    message.includes('repeats part of an applied mutation')
  )
    return { code: 'conflict', message, retryable: false };
  if (
    message.includes('Tool output artifact failed integrity validation') ||
    /unexpected end of tool output artifact|transcript (?:block|artifact).*integrity|integrity validation/i.test(
      message,
    )
  )
    return { code: 'corruption', message, retryable: false };
  if (
    /unknown child stream|transcript message not found|missing parent|parent chat not found/i.test(
      message,
    )
  )
    return { code: 'not_found', message, retryable: false };
  if (/transcript field has no stored body/i.test(message))
    return { code: 'not_found', message, retryable: false };
  if (/unknown chat:/i.test(message))
    return { code: 'unauthorized', message, retryable: false };
  if (
    /unauthorized|not authorized|outside.*scope|foreign target|child stream parent was deleted/i.test(
      message,
    )
  )
    return { code: 'unauthorized', message, retryable: false };
  if (/stale .*cursor|stream revision is stale/i.test(message))
    return { code: 'stale_identity', message, retryable: false };
  if (
    /invalid (?:tool output|transcript|child stream|block|page|cursor|delegation)/i.test(
      message,
    ) ||
    message.includes('splits a UTF-8 character') ||
    message.includes('splits a UTF-16 code unit')
  )
    return { code: 'invalid_request', message, retryable: false };

  const code = errorCodeOf(error);
  if (code !== undefined && /^E[A-Z0-9]+$/.test(code))
    return { code: 'storage_failure', message, retryable: true };
  return { code: 'storage_failure', message, retryable: true };
}

function runPortOperation<T>(
  operation: () => Promise<T>,
): Promise<DelegationTranscriptPortResult<T>> {
  return operation().then(success, (error: unknown) => ({
    ok: false,
    error: toPortError(error),
  }));
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested))
      return Object.fromEntries(
        Object.entries(nested).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    return nested;
  });
  if (json === undefined) throw new Error('Transcript row is not JSON data');
  return json;
}

function sameTarget(
  left: DelegationTranscriptTarget,
  right: DelegationTranscriptTarget,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameLogicalRow(
  left: DelegationChildRow,
  right: DelegationChildRow,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hasReference(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (
    isPersistedToolOutputReference(value) ||
    isTranscriptBlocksReference(value)
  )
    return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.some((child) => hasReference(child, seen));
  // References and their preparation markers are storage-only metadata.
  if (
    Object.getOwnPropertyNames(value).some(
      (key) => key.endsWith('Ref') || key === 'outputTruncated',
    )
  )
    return true;
  const entries = Object.entries(value);
  for (const [, child] of entries) {
    const nested: unknown = child;
    if (hasReference(nested, seen)) return true;
  }
  return false;
}

function validateTarget(
  target: DelegationTranscriptTarget,
): DelegationTranscriptTarget {
  const parsed = TranscriptTargetSchema.safeParse(target);
  if (
    !parsed.success ||
    parsed.data.kind !== 'delegation' ||
    typeof target.chatId !== 'string' ||
    target.chatId.length === 0 ||
    typeof target.delegationId !== 'string' ||
    target.delegationId.length === 0 ||
    !Number.isSafeInteger(target.runGeneration) ||
    target.runGeneration < 1
  )
    throw new TranscriptPortOperationError(
      'invalid_request',
      'Invalid delegation transcript target.',
    );
  return parsed.data;
}

function cloneLogicalRow(row: DelegationChildRow): DelegationChildRow {
  try {
    canonicalJson(row);
  } catch {
    throw new TranscriptPortOperationError(
      'invalid_request',
      'A child row must be JSON data.',
    );
  }
  return structuredClone(row);
}

function validateChanges(
  mutationKey: string,
  changes: readonly DelegationTranscriptChange[],
): readonly DelegationChildRow[] {
  if (typeof mutationKey !== 'string' || mutationKey.length === 0)
    throw new TranscriptPortOperationError(
      'invalid_request',
      'A mutation key is required.',
    );
  if (!Array.isArray(changes) || changes.length === 0)
    throw new TranscriptPortOperationError(
      'invalid_request',
      'At least one child row change is required.',
    );
  const typedChanges: readonly DelegationTranscriptChange[] = changes;
  const seen = new Set<string>();
  const rows: DelegationChildRow[] = [];
  for (const change of typedChanges) {
    if (typeof change !== 'object' || change === null)
      throw new TranscriptPortOperationError(
        'invalid_request',
        'Invalid child row change.',
      );
    const row = change.row;
    if (
      typeof row !== 'object' ||
      row === null ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      (row.role !== 'user' &&
        row.role !== 'assistant' &&
        row.role !== 'system') ||
      typeof row.timestamp !== 'number' ||
      !Number.isFinite(row.timestamp) ||
      !Array.isArray(row.blocks) ||
      (row.parentBlockId !== undefined &&
        typeof row.parentBlockId !== 'string') ||
      (row.delegationSequence !== undefined &&
        (!Number.isSafeInteger(row.delegationSequence) ||
          row.delegationSequence < 0)) ||
      (Object.prototype.hasOwnProperty.call(row, 'delegationSegment') &&
        typeof row.delegationSegment !== 'string') ||
      !Number.isSafeInteger(row.itemRevision) ||
      row.itemRevision < 0 ||
      typeof row.final !== 'boolean'
    )
      throw new TranscriptPortOperationError(
        'invalid_request',
        'Invalid logical child row.',
      );
    if (seen.has(row.id))
      throw new TranscriptPortOperationError(
        'invalid_request',
        'An admission cannot change the same child item twice.',
      );
    seen.add(row.id);
    if (hasReference(row, new WeakSet<object>()))
      throw new TranscriptPortOperationError(
        'invalid_request',
        'Child row changes must contain logical inline bodies without storage metadata.',
      );
    rows.push(cloneLogicalRow(row));
  }
  return rows;
}

function stateFromDescriptor(
  target: DelegationTranscriptTarget,
  descriptor: TranscriptStreamDescriptor,
): DelegationTranscriptStreamState {
  if (!sameTarget(target, descriptor.target))
    throw new TranscriptPortOperationError(
      'corruption',
      'The child stream descriptor target did not match its registration.',
    );
  return {
    target: structuredClone(target),
    status: descriptor.status,
    streamRevision: descriptor.streamRevision,
    openedAt: descriptor.openedAt ?? null,
    latestRowTimestamp: descriptor.latestRowTimestamp,
    cardState: descriptor.cardState,
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new TranscriptPortOperationError(
      'storage_failure',
      'The delegation transcript operation was aborted.',
      true,
    );
}

function segmentChanged(
  stored: DelegationChildRow,
  incoming: DelegationChildRow,
): boolean {
  return stored.delegationSegment !== incoming.delegationSegment;
}

export class RepositoryDelegationTranscriptPort implements DelegationTranscriptPort {
  private readonly scope: ChatScopeKey;

  public constructor(
    private readonly chatState: RepositoryDelegationTranscriptChatState,
    scope: ChatScopeKey,
  ) {
    this.scope = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    };
  }

  public open(
    input: { readonly target: DelegationTranscriptTarget },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      assertNotAborted(signal);
      const descriptor = await this.chatState.openChildStream(
        this.scope,
        target,
      );
      assertNotAborted(signal);
      return stateFromDescriptor(target, descriptor);
    });
  }

  public appendReceipt(
    input: DelegationTranscriptReceiptEntry,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptReceiptAppendResult>
  > {
    return runPortOperation(async () => {
      assertNotAborted(signal);
      const result = await this.chatState.appendDelegationReceipt(
        this.scope,
        structuredClone(input),
      );
      assertNotAborted(signal);
      return structuredClone(result);
    });
  }

  public receipt(
    input: DelegationTranscriptReceiptIdentity,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceiptEntry>> {
    return runPortOperation(async () => {
      assertNotAborted(signal);
      const entry = await this.chatState.receipt(
        this.scope,
        structuredClone(input),
      );
      assertNotAborted(signal);
      if (entry === undefined)
        throw new TranscriptPortOperationError(
          'not_found',
          'The receipt was not found.',
        );
      return structuredClone(entry);
    });
  }

  public appendChanges(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly mutationKey: string;
      readonly changes: readonly DelegationTranscriptChange[];
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptReceipt>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      const rows = validateChanges(input.mutationKey, input.changes);
      assertNotAborted(signal);
      return this.chatState.withChildStreamTarget(
        this.scope,
        target,
        async (): Promise<DelegationTranscriptReceipt> => {
          assertNotAborted(signal);
          const descriptor = await this.chatState.getChildStreamState(
            this.scope,
            target,
          );
          if (descriptor === undefined)
            throw new TranscriptPortOperationError(
              'not_found',
              'The delegation transcript stream was not found.',
            );
          const state = stateFromDescriptor(target, descriptor);
          const classified = await this.classifyChanges(
            target,
            descriptor,
            rows,
            signal,
          );
          assertNotAborted(signal);
          if (classified.rowsToCommit.length === 0)
            return this.originalReceipt(
              target,
              input.mutationKey,
              rows,
              classified.items,
              signal,
            );
          if (descriptor.status === 'settled')
            throw new TranscriptPortOperationError(
              'conflict',
              'A settled child stream is immutable.',
            );

          const committed = await this.chatState.commitChildStream(
            this.scope,
            target,
            input.mutationKey,
            classified.rowsToCommit,
          );
          assertNotAborted(signal);
          const nextState = stateFromDescriptor(target, committed.descriptor);
          if (committed.applied) {
            if (nextState.streamRevision <= state.streamRevision)
              throw new TranscriptPortOperationError(
                'corruption',
                'A durable child admission did not advance its stream revision.',
              );
            return {
              target: structuredClone(target),
              mutationKey: input.mutationKey,
              streamRevision: nextState.streamRevision,
              items: classified.items,
              replayed: false,
            };
          }
          if (
            await this.areRowsIdentical(
              target,
              committed.descriptor,
              rows,
              signal,
            )
          )
            return this.originalReceipt(
              target,
              input.mutationKey,
              rows,
              classified.items,
              signal,
            );
          throw new TranscriptPortOperationError(
            'conflict',
            'The child stream changed while the admission was being committed.',
          );
        },
      );
    });
  }

  public flush(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      if (
        !Number.isSafeInteger(input.streamRevision) ||
        input.streamRevision < 0
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid child stream revision.',
        );
      assertNotAborted(signal);
      return this.chatState.withChildStreamTarget(
        this.scope,
        target,
        async (): Promise<DelegationTranscriptStreamState> => {
          assertNotAborted(signal);
          const descriptor = await this.chatState.getChildStreamState(
            this.scope,
            target,
          );
          if (descriptor === undefined)
            throw new TranscriptPortOperationError(
              'not_found',
              'The delegation transcript stream was not found.',
            );
          const state = stateFromDescriptor(target, descriptor);
          if (input.streamRevision > state.streamRevision)
            throw new TranscriptPortOperationError(
              'stale_identity',
              'The requested child stream revision has not been admitted.',
            );
          assertNotAborted(signal);
          return state;
        },
      );
    });
  }

  public updateCardState(
    input: DelegationTranscriptCardStateRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      validateRegistryIdentity(target);
      assertNotAborted(signal);
      const state = await this.chatState.updateCardState(this.scope, {
        ...input,
        target,
      });
      assertNotAborted(signal);
      return structuredClone(state);
    });
  }

  public settle(
    input: DelegationTranscriptSettleRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptSettleResult>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      validateRegistryIdentity(target);
      validateResultIndex(input.resultIndex);
      if (
        typeof input.settlementKey !== 'string' ||
        input.settlementKey.length === 0 ||
        input.settlementKey.length > 256 ||
        !Array.isArray(input.finalChanges)
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid delegation settlement request.',
        );
      // Empty finalChanges is valid; non-empty changes obey ordinary logical-row rules.
      const finalRows =
        input.finalChanges.length === 0
          ? []
          : validateChanges(input.settlementKey, input.finalChanges);
      const request = structuredClone({
        ...input,
        target,
        finalChanges: finalRows.map((row) => ({ row })),
      });
      assertNotAborted(signal);
      const settled = await this.chatState.settleDelegationResult(
        this.scope,
        request,
      );
      assertNotAborted(signal);
      return structuredClone(settled);
    });
  }

  public page(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
      readonly cursor?: string;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptRowsPage>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      validatePinnedRevision(input.streamRevision);
      const limit = input.limit ?? 100;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 512 ||
        (input.cursor !== undefined &&
          (typeof input.cursor !== 'string' || input.cursor.length === 0))
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid child transcript page limit.',
        );
      assertNotAborted(signal);
      return this.chatState.withChildStreamTarget(
        this.scope,
        target,
        async (): Promise<DelegationTranscriptRowsPage> => {
          assertNotAborted(signal);
          const revision = await this.requirePinnedRevision(
            target,
            input.streamRevision,
          );
          if (input.cursor !== undefined) {
            try {
              const cursor = decodeChatTranscriptReadCursor(
                input.cursor,
                'stream',
                {
                  ...this.scope,
                  chatId: target.chatId,
                  target,
                },
              );
              if (cursor.revision !== revision)
                throw new Error('Cursor belongs to another stream revision');
            } catch {
              throw new TranscriptPortOperationError(
                'invalid_request',
                'Invalid child transcript cursor.',
              );
            }
          }
          const page = await this.chatState.getChildStreamPage(
            this.scope,
            target,
            revision,
            input.cursor,
            limit,
          );
          assertPageRevision(revision, page.streamRevision);
          assertNotAborted(signal);
          return structuredClone(page);
        },
      );
    });
  }

  public message(
    input: {
      readonly target: DelegationTranscriptTarget;
      readonly streamRevision: number;
      readonly messageId: string;
    },
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationChildRow>> {
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      validatePinnedRevision(input.streamRevision);
      if (typeof input.messageId !== 'string' || input.messageId.length === 0)
        throw new TranscriptPortOperationError(
          'invalid_request',
          'A message id is required.',
        );
      assertNotAborted(signal);
      return this.chatState.withChildStreamTarget(
        this.scope,
        target,
        async (): Promise<DelegationChildRow> => {
          assertNotAborted(signal);
          const revision = await this.requirePinnedRevision(
            target,
            input.streamRevision,
          );
          const row = await this.chatState.getChildStreamMessage(
            this.scope,
            target,
            input.messageId,
            revision,
          );
          if (row === undefined)
            throw new TranscriptPortOperationError(
              'not_found',
              'The transcript message was not found.',
            );
          assertNotAborted(signal);
          return structuredClone(row);
        },
      );
    });
  }

  public contentRange(
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
    return runPortOperation(async () => {
      const target = validateTarget(input.target);
      validatePinnedRevision(input.streamRevision);
      if (
        typeof input.messageId !== 'string' ||
        input.messageId.length === 0 ||
        !Number.isSafeInteger(input.blockOrdinal) ||
        input.blockOrdinal < 0 ||
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 4 ||
        input.limit > 65_536
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid transcript content range.',
        );
      assertNotAborted(signal);
      return this.chatState.withChildStreamTarget(
        this.scope,
        target,
        async (): Promise<DelegationTranscriptContentRange> => {
          assertNotAborted(signal);
          const revision = await this.requirePinnedRevision(
            target,
            input.streamRevision,
          );
          const content = await this.chatState.readChildStreamContent(
            this.scope,
            target,
            revision,
            input.messageId,
            input.blockOrdinal,
            input.field,
            input.offset,
            input.limit,
            signal,
          );
          assertNotAborted(signal);
          return content;
        },
      );
    });
  }

  public resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultsPage>> {
    return runPortOperation(async () => {
      validateRegistryPage(input);
      assertNotAborted(signal);
      const result = await this.chatState.resultsPage(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      assertNotAborted(signal);
      return structuredClone(result);
    });
  }

  public registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationEntry>
  > {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      validateTarget({
        kind: 'delegation',
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration,
      });
      assertNotAborted(signal);
      const result = await this.chatState.registerGeneration(
        this.scope,
        structuredClone({
          chatId: input.chatId,
          delegationId: input.delegationId,
          runGeneration: input.runGeneration,
          createdAt: input.createdAt,
          store: input.store,
          executionMode: input.executionMode,
          origin: input.origin,
        }),
      );
      assertNotAborted(signal);
      return structuredClone(result.entry);
    });
  }

  public result(
    input: DelegationTranscriptResultRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      validateResultIndex(input.resultIndex);
      assertNotAborted(signal);
      const result = await this.chatState.result(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        resultIndex: input.resultIndex,
      });
      assertNotAborted(signal);
      if (result === undefined)
        throw new TranscriptPortOperationError(
          'not_found',
          'The delegation result was not found.',
        );
      return structuredClone(result);
    });
  }

  public resultBySettlementKey(
    input: DelegationTranscriptSettlementKeyRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      if (
        typeof input.settlementKey !== 'string' ||
        input.settlementKey.length < 1 ||
        input.settlementKey.length > 256
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid delegation settlement key.',
        );
      assertNotAborted(signal);
      const result = await this.chatState.resultBySettlementKey(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        settlementKey: input.settlementKey,
      });
      assertNotAborted(signal);
      if (result === undefined)
        throw new TranscriptPortOperationError(
          'not_found',
          'The delegation result was not found.',
        );
      return structuredClone(result);
    });
  }

  public resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptResultEntry>> {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      validateTarget({
        kind: 'delegation',
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration,
      });
      assertNotAborted(signal);
      const result = await this.chatState.resultByGeneration(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration,
      });
      assertNotAborted(signal);
      if (result === undefined)
        throw new TranscriptPortOperationError(
          'not_found',
          'The delegation result was not found.',
        );
      return structuredClone(result);
    });
  }

  public generation(
    input: DelegationTranscriptGenerationRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptGeneration>> {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      validateTarget({
        kind: 'delegation',
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration,
      });
      assertNotAborted(signal);
      const result = await this.chatState.generation(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: input.runGeneration,
      });
      assertNotAborted(signal);
      if (result === undefined)
        throw new TranscriptPortOperationError(
          'not_found',
          'The delegation generation was not found.',
        );
      return structuredClone(result);
    });
  }

  public generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    signal?: AbortSignal,
  ): Promise<
    DelegationTranscriptPortResult<DelegationTranscriptGenerationsPage>
  > {
    return runPortOperation(async () => {
      validateRegistryPage(input);
      assertNotAborted(signal);
      const result = await this.chatState.generationsPage(this.scope, {
        chatId: input.chatId,
        delegationId: input.delegationId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      assertNotAborted(signal);
      return structuredClone(result);
    });
  }

  public resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptPortResult<DelegationTranscriptContentRange>> {
    return runPortOperation(async () => {
      validateRegistryIdentity(input);
      validateResultIndex(input.resultIndex);
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 4 ||
        input.limit > 65_536
      )
        throw new TranscriptPortOperationError(
          'invalid_request',
          'Invalid delegation answer range.',
        );
      assertNotAborted(signal);
      const result = await this.chatState.resultAnswerRange(
        this.scope,
        {
          chatId: input.chatId,
          delegationId: input.delegationId,
          resultIndex: input.resultIndex,
          offset: input.offset,
          limit: input.limit,
        },
        signal,
      );
      assertNotAborted(signal);
      return structuredClone(result);
    });
  }

  private async originalReceipt(
    target: DelegationTranscriptTarget,
    mutationKey: string,
    rows: readonly DelegationChildRow[],
    items: DelegationTranscriptReceipt['items'],
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptReceipt> {
    let streamRevision = 0;
    let commonKey: string | undefined;
    let sameKey = true;
    for (const row of rows) {
      assertNotAborted(signal);
      const admission = await this.chatState.itemAdmission(this.scope, {
        target,
        messageId: row.id,
        itemRevision: row.itemRevision,
      });
      assertNotAborted(signal);
      if (admission === undefined)
        throw new TranscriptPortOperationError(
          'unsupported_format',
          'Original child admission metadata is unavailable.',
        );
      streamRevision = Math.max(
        streamRevision,
        admission.admittingStreamRevision,
      );
      if (commonKey === undefined) commonKey = admission.mutationKey;
      else if (commonKey !== admission.mutationKey) sameKey = false;
    }
    return {
      target: structuredClone(target),
      mutationKey: sameKey && commonKey !== undefined ? commonKey : mutationKey,
      streamRevision,
      items,
      replayed: true,
    };
  }

  private async classifyChanges(
    target: DelegationTranscriptTarget,
    descriptor: TranscriptStreamDescriptor,
    rows: readonly DelegationChildRow[],
    signal?: AbortSignal,
  ): Promise<ClassifiedChanges> {
    const rowsToCommit: DelegationChildRow[] = [];
    let replayed = true;
    for (const row of rows) {
      assertNotAborted(signal);
      const stored = await this.chatState.getChildStreamMessage(
        this.scope,
        target,
        row.id,
        descriptor.streamRevision,
      );
      assertNotAborted(signal);
      if (stored === undefined) {
        if (descriptor.status === 'settled')
          throw new TranscriptPortOperationError(
            'conflict',
            'A settled child stream is immutable.',
          );
        if (row.itemRevision !== 0)
          throw new TranscriptPortOperationError(
            'stale_identity',
            'A new child item revision must be zero.',
          );
        replayed = false;
        rowsToCommit.push(row);
        continue;
      }
      if (stored.id !== row.id)
        throw new TranscriptPortOperationError(
          'corruption',
          'The child row lookup returned a different item.',
        );
      if (
        row.itemRevision === stored.itemRevision &&
        sameLogicalRow(row, stored)
      )
        continue;
      if (stored.final)
        throw new TranscriptPortOperationError(
          'conflict',
          'A final child item is immutable.',
          false,
          stored.itemRevision,
        );
      if (segmentChanged(stored, row))
        throw new TranscriptPortOperationError(
          'conflict',
          'A child item cannot change its delegation segment.',
          false,
          stored.itemRevision,
        );
      if (row.itemRevision === stored.itemRevision)
        throw new TranscriptPortOperationError(
          'conflict',
          'The child item revision has different logical content.',
          false,
          stored.itemRevision,
        );
      if (row.itemRevision !== stored.itemRevision + 1)
        throw new TranscriptPortOperationError(
          'stale_identity',
          'The child item revision is stale or gapped.',
          false,
          stored.itemRevision,
        );
      if (descriptor.status === 'settled')
        throw new TranscriptPortOperationError(
          'conflict',
          'A settled child stream is immutable.',
        );
      replayed = false;
      rowsToCommit.push(row);
    }
    return {
      rowsToCommit,
      replayed,
      items: rows.map((row) => ({
        id: row.id,
        itemRevision: row.itemRevision,
        final: row.final,
      })),
    };
  }

  private async areRowsIdentical(
    target: DelegationTranscriptTarget,
    descriptor: TranscriptStreamDescriptor,
    rows: readonly DelegationChildRow[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const row of rows) {
      assertNotAborted(signal);
      const stored = await this.chatState.getChildStreamMessage(
        this.scope,
        target,
        row.id,
        descriptor.streamRevision,
      );
      if (stored === undefined || !sameLogicalRow(stored, row)) return false;
    }
    return true;
  }

  private async requirePinnedRevision(
    target: DelegationTranscriptTarget,
    streamRevision: number,
  ): Promise<number> {
    const descriptor = await this.chatState.getChildStreamState(
      this.scope,
      target,
    );
    if (descriptor === undefined)
      throw new TranscriptPortOperationError(
        'not_found',
        'The delegation transcript stream was not found.',
      );
    stateFromDescriptor(target, descriptor);
    const revision =
      descriptor.status === 'settled'
        ? descriptor.settleReceipt?.streamRevision
        : descriptor.streamRevision;
    if (revision === undefined)
      throw new TranscriptPortOperationError(
        'corruption',
        'A settled stream has no settlement receipt.',
      );
    if (streamRevision < revision || streamRevision > descriptor.streamRevision)
      throw new TranscriptPortOperationError(
        'stale_identity',
        'The child stream moved since the pinned revision was observed.',
      );
    return revision;
  }
}

function validatePinnedRevision(streamRevision: number): void {
  if (!Number.isSafeInteger(streamRevision) || streamRevision < 0)
    throw new TranscriptPortOperationError(
      'invalid_request',
      'Invalid pinned child stream revision.',
    );
}

function assertPageRevision(expected: number, actual: number): void {
  if (actual !== expected)
    throw new TranscriptPortOperationError(
      'stale_identity',
      'The child stream moved while the page was read.',
    );
}

function validateRegistryIdentity(input: {
  readonly chatId: string;
  readonly delegationId: string;
}): void {
  for (const id of [input.chatId, input.delegationId])
    if (typeof id !== 'string' || id.length === 0 || id.length > 256)
      throw new TranscriptPortOperationError(
        'invalid_request',
        'Invalid delegation registry identity.',
      );
}

function validateResultIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 1)
    throw new TranscriptPortOperationError(
      'invalid_request',
      'Invalid delegation result index.',
    );
}

function validateRegistryPage(
  input: DelegationTranscriptRegistryPageRequest,
): void {
  validateRegistryIdentity(input);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' ||
        input.cursor.length === 0 ||
        input.cursor.length > 2048))
  )
    throw new TranscriptPortOperationError(
      'invalid_request',
      'Invalid delegation registry page request.',
    );
}
