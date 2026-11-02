import { createHash } from 'node:crypto';
import { canonicalDelegationJson } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import type {
  DelegationTranscriptContentRange,
  DelegationTranscriptGeneration,
  DelegationTranscriptGenerationRequest,
  DelegationTranscriptRegistryIdentity,
  DelegationTranscriptRegistryPageRequest,
  DelegationTranscriptResultAnswerRequest,
  DelegationTranscriptResultEntry,
  DelegationTranscriptResultRequest,
  DelegationTranscriptReceiptIdentity,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { TranscriptStreamDescriptor } from '@canopy/protocol/canopy-core';
import type {
  DelegationAdmissionRequest,
  DelegationRegistryCheckpointReader,
  DelegationRegistryCheckpoint,
  DelegationRegistryCursor,
  DelegationRegistryCursorContext,
  DelegationSettlementKeyRequest,
} from './delegation-registry-api';
import { DelegationRegistryOperationError } from './delegation-registry-error';
import type { DelegationRegistryStore } from './delegation-registry-store';

export interface DelegationRegistryReaderOptions {
  readonly store: DelegationRegistryStore;
  readonly readDescriptor: (
    target: DelegationTranscriptTarget,
  ) => Promise<TranscriptStreamDescriptor | undefined>;
  readonly readAnswerRange: (
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ) => Promise<DelegationTranscriptContentRange>;
}

function failure(
  code: 'invalid_request' | 'not_found' | 'answer_unavailable',
  message: string,
): never {
  throw new DelegationRegistryOperationError({
    code,
    message,
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeIdentity(context: DelegationRegistryCursorContext): string {
  return createHash('sha256')
    .update(canonicalDelegationJson(context), 'utf8')
    .digest('hex');
}

function encodeCursor(cursor: DelegationRegistryCursor): string {
  return Buffer.from(canonicalDelegationJson(cursor), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  value: string,
  identity: DelegationTranscriptRegistryIdentity,
  kind: 'results' | 'generations',
  context: DelegationRegistryCursorContext,
): DelegationRegistryCursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    return failure('invalid_request', 'Invalid or oversized registry cursor');
  let encoded: Buffer;
  let parsed: unknown;
  try {
    encoded = Buffer.from(value, 'base64url');
    if (encoded.toString('base64url') !== value)
      return failure('invalid_request', 'Non-canonical registry cursor');
    parsed = JSON.parse(encoded.toString('utf8'));
  } catch {
    return failure('invalid_request', 'Invalid registry cursor');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 6 ||
    parsed.version !== 1 ||
    typeof parsed.scopeIdentity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.scopeIdentity) ||
    !isRecord(parsed.identity) ||
    Object.keys(parsed.identity).length !== 2 ||
    typeof parsed.identity.chatId !== 'string' ||
    typeof parsed.identity.delegationId !== 'string' ||
    parsed.identity.chatId !== identity.chatId ||
    parsed.identity.delegationId !== identity.delegationId ||
    parsed.kind !== kind ||
    typeof parsed.position !== 'number' ||
    !Number.isSafeInteger(parsed.position) ||
    parsed.position < 0 ||
    typeof parsed.highWater !== 'number' ||
    !Number.isSafeInteger(parsed.highWater) ||
    parsed.highWater < 0 ||
    parsed.scopeIdentity !== scopeIdentity(context)
  )
    return failure(
      'invalid_request',
      'Registry cursor does not match its scope',
    );
  const canonical = canonicalDelegationJson(parsed);
  if (canonical !== encoded.toString('utf8'))
    return failure('invalid_request', 'Non-canonical registry cursor payload');
  return {
    version: 1,
    scopeIdentity: parsed.scopeIdentity,
    identity: {
      chatId: parsed.identity.chatId,
      delegationId: parsed.identity.delegationId,
    },
    kind,
    position: parsed.position,
    highWater: parsed.highWater,
  };
}

function validatePageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    failure('invalid_request', 'Registry page limit is invalid');
}

function pageCursor(
  input: DelegationTranscriptRegistryPageRequest,
  context: DelegationRegistryCursorContext,
  kind: 'results' | 'generations',
  currentHighWater: number,
): DelegationRegistryCursor {
  const cursor: DelegationRegistryCursor = input.cursor
    ? decodeCursor(input.cursor, input, kind, context)
    : {
        version: 1,
        scopeIdentity: scopeIdentity(context),
        identity: { chatId: input.chatId, delegationId: input.delegationId },
        kind,
        position: 0,
        highWater: currentHighWater,
      };
  if (cursor.highWater > currentHighWater)
    failure(
      'invalid_request',
      'Registry cursor is newer than current high-water',
    );
  return cursor;
}

export function createDelegationRegistryReader(
  options: DelegationRegistryReaderOptions,
): DelegationRegistryCheckpointReader {
  const { store } = options;

  async function readGeneration(
    input: DelegationTranscriptGenerationRequest,
    capturedHighWater?: number,
  ): Promise<DelegationTranscriptGeneration | undefined> {
    const entry = await store.generationEntry({
      chatId: input.chatId,
      delegationId: input.delegationId,
      runGeneration: input.runGeneration,
    });
    if (!entry) return undefined;
    const target: DelegationTranscriptTarget = {
      kind: 'delegation',
      chatId: input.chatId,
      delegationId: input.delegationId,
      runGeneration: input.runGeneration,
    };
    const resultRead =
      capturedHighWater === undefined
        ? store.resultByGeneration({
            chatId: input.chatId,
            delegationId: input.delegationId,
            runGeneration: input.runGeneration,
          })
        : store.resultByGenerationAtHighWater(
            { chatId: input.chatId, delegationId: input.delegationId },
            input.runGeneration,
            capturedHighWater,
          );
    const [descriptor, result] = await Promise.all([
      options.readDescriptor(target),
      resultRead,
    ]);
    return {
      entry,
      stream: descriptor
        ? {
            target,
            status: descriptor.status,
            streamRevision: descriptor.streamRevision,
            openedAt: descriptor.openedAt ?? null,
            latestRowTimestamp: descriptor.latestRowTimestamp,
            // Current, like the other stream fields: only the result is fenced.
            contentRevision: descriptor.settleReceipt?.streamRevision ?? null,
            cardState: descriptor.cardState,
          }
        : null,
      result: result ?? null,
    };
  }

  async function resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: DelegationRegistryCursorContext,
  ): Promise<{
    readonly results: readonly DelegationTranscriptResultEntry[];
    readonly cursor?: string;
  }> {
    validatePageLimit(input.limit);
    const identity = { chatId: input.chatId, delegationId: input.delegationId };
    const highWater = await store.highWater(identity);
    const cursor = pageCursor(input, context, 'results', highWater.highWater);
    const page = await store.readPage(
      identity,
      'results',
      cursor.position,
      cursor.highWater,
      input.limit,
    );
    const nextCursor = page.hasMore
      ? encodeCursor({ ...cursor, position: page.position })
      : undefined;
    return {
      results: page.entries,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  async function generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: DelegationRegistryCursorContext,
  ): Promise<{
    readonly generations: readonly DelegationTranscriptGeneration[];
    readonly cursor?: string;
  }> {
    validatePageLimit(input.limit);
    const identity = { chatId: input.chatId, delegationId: input.delegationId };
    const highWater = await store.highWater(identity);
    const cursor = pageCursor(
      input,
      context,
      'generations',
      highWater.highWater,
    );
    const page = await store.readPage(
      identity,
      'generations',
      cursor.position,
      cursor.highWater,
      input.limit,
    );
    const generations: DelegationTranscriptGeneration[] = [];
    for (const entry of page.entries) {
      const generation = await readGeneration(
        {
          chatId: input.chatId,
          delegationId: input.delegationId,
          runGeneration: entry.runGeneration,
        },
        cursor.highWater,
      );
      if (generation) generations.push(generation);
    }
    const nextCursor = page.hasMore
      ? encodeCursor({ ...cursor, position: page.position })
      : undefined;
    return { generations, ...(nextCursor ? { cursor: nextCursor } : {}) };
  }

  return {
    result: (input: DelegationTranscriptResultRequest) => store.result(input),
    resultBySettlementKey: (input: DelegationSettlementKeyRequest) =>
      store.resultBySettlementKey(input),
    resultByGeneration: (input: DelegationTranscriptGenerationRequest) =>
      store.resultByGeneration(input),
    receipt: (input: DelegationTranscriptReceiptIdentity) =>
      store.receipt(input),
    generation: readGeneration,
    resultsPage,
    generationsPage,
    resultAnswerRange: async (
      input: DelegationTranscriptResultAnswerRequest,
      signal?: AbortSignal,
    ): Promise<DelegationTranscriptContentRange> => {
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 0
      )
        return failure('invalid_request', 'Invalid answer range');
      const entry = await store.result({
        chatId: input.chatId,
        delegationId: input.delegationId,
        resultIndex: input.resultIndex,
      });
      if (!entry) return failure('not_found', 'Delegation result not found');
      if (entry.answer.kind === 'lost')
        return failure(
          'answer_unavailable',
          'Delegation answer is unavailable',
        );
      if (entry.answer.kind === 'empty') {
        // Same byte rules as contentRange, over zero bytes.
        if (input.offset !== 0 || input.limit < 4 || input.limit > 65_536)
          return failure('invalid_request', 'Invalid answer range');
        return { text: '', byteLength: 0, encoding: 'utf8' };
      }
      if (entry.answer.kind !== 'body')
        return failure('not_found', 'Delegation result has no answer body');
      return options.readAnswerRange(input, signal);
    },
    itemAdmission: (input: DelegationAdmissionRequest) =>
      store.itemAdmission(input),
    highWater: (input: DelegationRegistryCheckpoint['identity']) =>
      store.highWater(input),
    answerReferences: (chatId: string) => store.answerReferences(chatId),
  };
}
