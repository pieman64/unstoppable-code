import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PersistedToolOutputReferenceSchema,
  type PersistedToolOutputReference,
} from '@canopy/protocol/canopy-core';
import { validateDelegationReceiptEntry } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import {
  registryOwnerKey,
  registryOwnerDirectory,
  registryEffectIdentity,
  type RegistryIdentity,
} from './delegation-registry-owner';
import { canonicalDelegationJson } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import {
  DELEGATION_REGISTRY_MAX_CACHED_DELEGATIONS,
  DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
  DELEGATION_REGISTRY_MAX_ID_LENGTH,
  type DelegationTranscriptContentRange,
  type DelegationTranscriptGeneration,
  type DelegationTranscriptGenerationEntry,
  type DelegationTranscriptGenerationRequest,
  type DelegationTranscriptRegistryIdentity,
  type DelegationTranscriptReceiptEntry,
  type DelegationTranscriptReceiptIdentity,
  type DelegationTranscriptResultAnswerRequest,
  type DelegationTranscriptResultEntry,
  type DelegationTranscriptResultRequest,
  type DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { assertTranscriptIdentity } from '../chat-transcript-artifacts';
import { fsyncDirectory } from '../fsync-directory';
import {
  delegationRegistryJsonFits,
  type DelegationAdmissionRequest,
  type DelegationItemAdmissionMetadata,
  type DelegationRegistryCheckpoint,
  type DelegationRegistryCursorContext,
  type DelegationRegistryJournalEffect,
  type DelegationSettlementKeyRequest,
} from './delegation-registry-api';
import { DelegationRegistryOperationError } from './delegation-registry-error';

const SEGMENT_ENTRY_LIMIT = 64;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_SEGMENT_BYTES =
  SEGMENT_ENTRY_LIMIT * (DELEGATION_REGISTRY_MAX_ENTRY_BYTES + 1024);
const EMPTY_DIGEST = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

interface SegmentRecord {
  readonly version: 1;
  readonly sequence: number;
  readonly effect: DelegationRegistryJournalEffect;
  readonly previousDigest: string;
  readonly entriesSha256: string;
}

interface RegistryHead {
  readonly version: 1;
  readonly identity?: DelegationTranscriptRegistryIdentity;
  readonly owner?: Extract<RegistryIdentity, { kind: 'chat_receipts' }>;
  readonly highWater: number;
  readonly entriesSha256: string;
  readonly lastResultIndex?: number;
  readonly resultCount: number;
  readonly generationCount: number;
  readonly admissionCount: number;
  readonly currentSegmentBytes: number;
}

/** An identity's appended entries, durable in its segments, before its head. */
interface StagedAppend {
  readonly identity: RegistryIdentity;
  readonly directory: string;
  readonly appendedEffects: readonly DelegationRegistryJournalEffect[];
  readonly nextHead: RegistryHead;
}

interface ChatManifest {
  readonly version: 1;
  readonly chatId: string;
  readonly revision: number;
  readonly digest: string;
}

interface Locator {
  readonly version: 1;
  readonly sequence: number;
  readonly segment: number;
  readonly offset: number;
  readonly length: number;
}

type RegistryIndexCategory =
  | 'result'
  | 'settlement'
  | 'result-generation'
  | 'result-ordinal'
  | 'generation'
  | 'generation-ordinal'
  | 'admission'
  | 'receipt';

interface PendingOverlay {
  readonly identity: RegistryIdentity;
  readonly effects: DelegationRegistryJournalEffect[];
  readonly byGeneration: Map<number, DelegationTranscriptGenerationEntry>;
  readonly resultsByIndex: Map<number, DelegationTranscriptResultEntry>;
  readonly resultsBySettlement: Map<string, DelegationTranscriptResultEntry>;
  readonly resultsByGeneration: Map<number, DelegationTranscriptResultEntry>;
  readonly resultsByGenerationSequence: Map<
    number,
    {
      readonly entry: DelegationTranscriptResultEntry;
      readonly sequence: number;
    }
  >;
  readonly admissions: Map<string, DelegationItemAdmissionMetadata>;
  readonly receipts: Map<string, DelegationTranscriptReceiptEntry>;
  readonly resultOrdinals: Array<{
    readonly entry: DelegationTranscriptResultEntry;
    readonly sequence: number;
  }>;
  readonly generationOrdinals: Array<{
    readonly entry: DelegationTranscriptGenerationEntry;
    readonly sequence: number;
  }>;
  highWater: number;
  entriesSha256: string;
  lastResultIndex?: number;
}

function isLocator(value: unknown): value is Locator {
  return (
    isRecord(value) &&
    exactKeys(value, ['version', 'sequence', 'segment', 'offset', 'length']) &&
    value.version === 1 &&
    isSafeCount(value.sequence) &&
    isSafeCount(value.segment) &&
    isSafeCount(value.offset) &&
    isSafeCount(value.length) &&
    value.sequence > 0 &&
    value.segment === Math.floor((value.sequence - 1) / SEGMENT_ENTRY_LIMIT) &&
    value.length > 0 &&
    value.length <= DELEGATION_REGISTRY_MAX_ENTRY_BYTES + 1024 &&
    value.offset + value.length <= MAX_SEGMENT_BYTES
  );
}

function isSegmentRecord(
  value: unknown,
  chatId: string,
): value is SegmentRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'sequence',
      'effect',
      'previousDigest',
      'entriesSha256',
    ]) ||
    value.version !== 1 ||
    !isSafeCount(value.sequence) ||
    value.sequence < 1 ||
    !isRecord(value.effect) ||
    typeof value.previousDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.previousDigest) ||
    typeof value.entriesSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.entriesSha256)
  )
    return false;
  try {
    validateEffect(value.effect, chatId);
    return (
      sha256(
        `${value.previousDigest}\n${canonicalDelegationJson(value.effect)}`,
      ) === value.entriesSha256
    );
  } catch {
    return false;
  }
}

export interface DelegationRegistryStoreOptions {
  /** Read-only journal tail. Effects already appended to this store are ignored. */
  readonly pendingEffects?: (
    chatId: string,
  ) =>
    | Iterable<DelegationRegistryJournalEffect>
    | AsyncIterable<DelegationRegistryJournalEffect>;
}

export interface DelegationRegistryPageSlice<T> {
  readonly entries: readonly T[];
  readonly position: number;
  readonly highWater: number;
  readonly hasMore: boolean;
}

function fail(
  code:
    | 'invalid_request'
    | 'conflict'
    | 'not_found'
    | 'unsupported_format'
    | 'storage_failure'
    | 'corruption',
  message: string,
): never {
  throw new DelegationRegistryOperationError({
    code,
    message,
    retryable: code === 'storage_failure',
  });
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATION_REGISTRY_MAX_ID_LENGTH
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DELEGATION_REGISTRY_MAX_CACHED_DELEGATIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function identityKey(identity: RegistryIdentity): string {
  return registryOwnerKey(identity);
}

function identityDigest(identity: RegistryIdentity): string {
  return registryOwnerDirectory(identity);
}

function chatRoot(root: string, chatId: string): string {
  validateChatId(chatId);
  return join(root, 'delegations', chatId, 'registry');
}

function identityRoot(root: string, identity: RegistryIdentity): string {
  validateIdentity(identity);
  return join(chatRoot(root, identity.chatId), identityDigest(identity));
}

function validateChatId(chatId: unknown): asserts chatId is string {
  if (typeof chatId !== 'string') fail('invalid_request', 'Invalid chat ID');
  try {
    assertTranscriptIdentity(chatId);
  } catch {
    fail('invalid_request', 'Invalid chat ID');
  }
}

function validateIdentity(
  identity: unknown,
): asserts identity is RegistryIdentity {
  if (isRecord(identity) && identity.kind === 'chat_receipts') {
    if (!exactKeys(identity, ['kind', 'chatId']) || !isId(identity.chatId))
      fail('invalid_request', 'Invalid receipts owner identity');
    validateChatId(identity.chatId);
    return;
  }
  if (
    !isRecord(identity) ||
    !exactKeys(identity, ['chatId', 'delegationId']) ||
    !isId(identity.chatId) ||
    !isId(identity.delegationId)
  )
    fail('invalid_request', 'Invalid delegation registry identity');
  validateChatId(identity.chatId);
}

function requestIdentity(
  value: unknown,
  keys: readonly string[],
): DelegationTranscriptRegistryIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, keys) ||
    !isId(value.chatId) ||
    !isId(value.delegationId)
  )
    fail('invalid_request', 'Invalid delegation registry request identity');
  validateChatId(value.chatId);
  return { chatId: value.chatId, delegationId: value.delegationId };
}

function validateTarget(
  target: unknown,
  chatId: string,
): asserts target is DelegationTranscriptTarget {
  if (
    !isRecord(target) ||
    !exactKeys(target, ['kind', 'chatId', 'delegationId', 'runGeneration']) ||
    target.kind !== 'delegation' ||
    target.chatId !== chatId ||
    !isId(target.delegationId) ||
    !isSafeCount(target.runGeneration)
  )
    fail('invalid_request', 'Invalid registry target');
}

function validateGenerationEntry(
  value: unknown,
): asserts value is DelegationTranscriptGenerationEntry {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'kind',
      'chatId',
      'delegationId',
      'runGeneration',
      'createdAt',
      'store',
      'origin',
      'executionMode',
    ]) ||
    value.version !== 1 ||
    value.kind !== 'generation' ||
    !isId(value.chatId) ||
    !isId(value.delegationId) ||
    !isSafeCount(value.runGeneration) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    (value.store !== 'stream' && value.store !== 'legacy') ||
    (value.executionMode !== 'background' &&
      value.executionMode !== 'foreground') ||
    !isRecord(value.origin) ||
    !['launch', 'follow_up', 'resume', 'continuation'].includes(
      String(value.origin.kind),
    ) ||
    !exactKeys(value.origin, ['kind', 'anchorMessageId', 'authoredItemId']) ||
    (value.origin.anchorMessageId !== undefined &&
      !isId(value.origin.anchorMessageId)) ||
    (value.origin.authoredItemId !== undefined &&
      !isId(value.origin.authoredItemId))
  )
    fail('invalid_request', 'Invalid delegation generation entry');
}

function validateResultEntry(
  value: unknown,
): asserts value is DelegationTranscriptResultEntry {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'kind',
      'resultIndex',
      'runGeneration',
      'settlementKey',
      'settlementDigest',
      'outcome',
      'answer',
      'settlement',
    ]) ||
    value.version !== 1 ||
    value.kind !== 'result' ||
    !isSafeCount(value.resultIndex) ||
    value.resultIndex < 1 ||
    !isSafeCount(value.runGeneration) ||
    !isId(value.settlementKey) ||
    typeof value.settlementDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.settlementDigest) ||
    !isRecord(value.outcome) ||
    !isRecord(value.answer) ||
    !isRecord(value.settlement)
  )
    fail('invalid_request', 'Invalid delegation result entry');
  const outcome = value.outcome;
  if (
    !exactKeys(outcome, [
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
    ].includes(String(outcome.status)) ||
    typeof outcome.finishedAt !== 'number' ||
    !Number.isFinite(outcome.finishedAt) ||
    (outcome.startedAt !== undefined &&
      (typeof outcome.startedAt !== 'number' ||
        !Number.isFinite(outcome.startedAt)))
  )
    fail('invalid_request', 'Invalid delegation result outcome');
  if (
    outcome.error !== undefined &&
    (!isRecord(outcome.error) ||
      !exactKeys(outcome.error, ['code', 'message', 'retryable']) ||
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
      ].includes(String(outcome.error.code)) ||
      typeof outcome.error.message !== 'string' ||
      outcome.error.message.length > 4096 ||
      typeof outcome.error.retryable !== 'boolean')
  )
    fail('invalid_request', 'Invalid delegation result error');
  if (outcome.usage !== undefined) {
    if (
      !isRecord(outcome.usage) ||
      !exactKeys(outcome.usage, [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ])
    )
      fail('invalid_request', 'Invalid delegation result usage');
    for (const [key, amount] of Object.entries(outcome.usage)) {
      if (
        typeof amount !== 'number' ||
        amount < 0 ||
        (key === 'costUsd'
          ? !Number.isFinite(amount)
          : !Number.isSafeInteger(amount))
      )
        fail('invalid_request', 'Invalid delegation result usage');
    }
  }
  if (
    outcome.stopReason !== undefined &&
    (typeof outcome.stopReason !== 'string' ||
      ![
        'parent_cancelled',
        'user_cancelled',
        'deadline_exceeded',
        'shutdown',
        'policy_revoked',
        'stopped_by_parent',
        'ancestor_stopped',
      ].includes(outcome.stopReason))
  )
    fail('invalid_request', 'Invalid delegation stop reason');
  const settlement = value.settlement;
  if (
    !exactKeys(settlement, [
      'streamRevision',
      'contentRevision',
      'finalItemCount',
      'finalItemsDigest',
    ]) ||
    !isSafeCount(settlement.streamRevision) ||
    !isSafeCount(settlement.contentRevision) ||
    !isSafeCount(settlement.finalItemCount) ||
    typeof settlement.finalItemsDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(settlement.finalItemsDigest)
  )
    fail('invalid_request', 'Invalid delegation result settlement');
  const answer = value.answer;
  if (typeof answer.kind !== 'string')
    fail('invalid_request', 'Invalid delegation answer');
  if (answer.kind === 'none') {
    if (!exactKeys(answer, ['kind']))
      fail('invalid_request', 'Invalid empty delegation answer');
  } else if (answer.kind === 'empty') {
    if (
      !exactKeys(answer, ['kind', 'role']) ||
      (answer.role !== 'final' && answer.role !== 'partial')
    )
      fail('invalid_request', 'Invalid delegation answer');
  } else if (answer.kind === 'lost') {
    if (
      !exactKeys(answer, ['kind', 'role', 'sha256', 'length']) ||
      (answer.role !== 'final' && answer.role !== 'partial') ||
      !isSafeCount(answer.length) ||
      answer.length < 1 ||
      typeof answer.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(answer.sha256)
    )
      fail('invalid_request', 'Invalid delegation answer');
  } else if (answer.kind === 'body') {
    if (
      !exactKeys(answer, [
        'kind',
        'role',
        'byteLength',
        'encoding',
        'sha256',
        'ref',
      ]) ||
      (answer.role !== 'final' && answer.role !== 'partial') ||
      !isSafeCount(answer.byteLength) ||
      answer.byteLength < 1 ||
      (answer.encoding !== 'utf8' && answer.encoding !== 'utf16le') ||
      typeof answer.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(answer.sha256) ||
      !PersistedToolOutputReferenceSchema.safeParse(answer.ref).success
    )
      fail('invalid_request', 'Invalid delegation answer');
  } else {
    fail('invalid_request', 'Invalid delegation answer');
  }
  if (answer.kind === 'body') {
    const reference = PersistedToolOutputReferenceSchema.safeParse(answer.ref);
    if (
      !reference.success ||
      reference.data.byteLength !== answer.byteLength ||
      reference.data.sha256 !== answer.sha256 ||
      reference.data.encoding !==
        (answer.encoding === 'utf8' ? 'utf-8' : 'utf-16le')
    )
      fail(
        'invalid_request',
        'Delegation answer body does not match its persisted reference',
      );
  }
  let fits: boolean;
  try {
    fits = delegationRegistryJsonFits(value);
  } catch {
    return fail('invalid_request', 'Invalid delegation result JSON');
  }
  if (!fits)
    fail('invalid_request', 'Delegation registry entry exceeds size limit');
}

function validateEffect(
  value: unknown,
  chatId: string,
): asserts value is DelegationRegistryJournalEffect {
  if (!isRecord(value) || typeof value.kind !== 'string')
    fail('invalid_request', 'Invalid delegation registry effect');
  if (value.kind === 'delegation-generation') {
    if (!exactKeys(value, ['kind', 'identity', 'entry']))
      fail('invalid_request', 'Invalid generation effect');
    if (
      !isRecord(value.identity) ||
      !exactKeys(value.identity, ['chatId', 'delegationId'])
    )
      fail('invalid_request', 'Invalid generation identity');
    if (!isId(value.identity.chatId) || !isId(value.identity.delegationId))
      fail('invalid_request', 'Invalid generation identity');
    validateChatId(value.identity.chatId);
    validateGenerationEntry(value.entry);
    if (
      value.identity.chatId !== chatId ||
      value.entry.chatId !== chatId ||
      value.identity.delegationId !== value.entry.delegationId
    )
      fail('invalid_request', 'Generation effect identity mismatch');
  } else if (value.kind === 'delegation-result') {
    if (!exactKeys(value, ['kind', 'target', 'entry']))
      fail('invalid_request', 'Invalid result effect');
    validateTarget(value.target, chatId);
    validateResultEntry(value.entry);
    if (value.entry.runGeneration !== value.target.runGeneration)
      fail(
        'invalid_request',
        'Delegation result generation does not match its target',
      );
  } else if (value.kind === 'child-admission') {
    if (
      !exactKeys(value, ['kind', 'target', 'items']) ||
      !Array.isArray(value.items) ||
      value.items.length === 0
    )
      fail('invalid_request', 'Invalid child admission effect');
    validateTarget(value.target, chatId);
    const seen = new Set<string>();
    for (const item of value.items) {
      if (
        !isRecord(item) ||
        !exactKeys(item, [
          'id',
          'itemRevision',
          'admittingStreamRevision',
          'mutationKey',
        ]) ||
        !isId(item.id) ||
        !isSafeCount(item.itemRevision) ||
        !isSafeCount(item.admittingStreamRevision) ||
        !isId(item.mutationKey)
      )
        fail('invalid_request', 'Invalid child admission metadata');
      const key = `${item.id}\0${item.itemRevision}`;
      if (seen.has(key))
        fail('invalid_request', 'Duplicate child admission metadata');
      seen.add(key);
    }
  } else if (value.kind === 'delegation-receipt') {
    if (
      !exactKeys(value, ['kind', 'owner', 'entry']) ||
      !isRecord(value.owner) ||
      !exactKeys(value.owner, ['kind', 'chatId']) ||
      value.owner.kind !== 'chat_receipts' ||
      value.owner.chatId !== chatId
    )
      fail('invalid_request', 'Invalid delegation receipt owner');
    const validated = validateDelegationReceiptEntry(value.entry);
    if (!validated.ok || validated.entry.chatId !== chatId)
      fail('invalid_request', 'Invalid delegation receipt entry');
  } else {
    fail('unsupported_format', 'Unknown delegation registry effect');
  }
  let fits: boolean;
  try {
    fits = delegationRegistryJsonFits(value);
  } catch {
    return fail('invalid_request', 'Invalid delegation registry JSON');
  }
  if (!fits)
    fail('invalid_request', 'Delegation registry entry exceeds size limit');
}

function headMatchesOwner(
  value: Record<string, unknown>,
  identity: RegistryIdentity,
): boolean {
  if ('kind' in identity)
    return (
      isRecord(value.owner) &&
      exactKeys(value.owner, ['kind', 'chatId']) &&
      value.owner.kind === 'chat_receipts' &&
      value.owner.chatId === identity.chatId
    );
  return (
    isRecord(value.identity) &&
    exactKeys(value.identity, ['chatId', 'delegationId']) &&
    value.identity.chatId === identity.chatId &&
    value.identity.delegationId === identity.delegationId
  );
}

function assertHead(
  value: unknown,
  identity: RegistryIdentity,
): asserts value is RegistryHead {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      ...('kind' in identity ? ['owner'] : ['identity']),
      'highWater',
      'entriesSha256',
      'lastResultIndex',
      'resultCount',
      'generationCount',
      'admissionCount',
      'currentSegmentBytes',
    ]) ||
    value.version !== 1 ||
    !headMatchesOwner(value, identity) ||
    !isSafeCount(value.highWater) ||
    typeof value.entriesSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.entriesSha256) ||
    !isSafeCount(value.resultCount) ||
    !isSafeCount(value.generationCount) ||
    !isSafeCount(value.admissionCount) ||
    ('kind' in identity &&
      (value.resultCount !== 0 ||
        value.generationCount !== 0 ||
        value.admissionCount !== 0 ||
        value.lastResultIndex !== undefined)) ||
    !isSafeCount(value.currentSegmentBytes) ||
    value.currentSegmentBytes > MAX_SEGMENT_BYTES ||
    (value.highWater === 0 && value.currentSegmentBytes !== 0) ||
    (value.highWater > 0 && value.currentSegmentBytes === 0) ||
    (value.lastResultIndex !== undefined &&
      (!isSafeCount(value.lastResultIndex) || value.lastResultIndex < 1))
  )
    fail('corruption', 'Invalid delegation registry high-water metadata');
}

/** mkdir -p, then make each created directory's entry durable in its parent. */
async function mkdirDurable(path: string): Promise<void> {
  const first = await mkdir(path, { recursive: true });
  if (first === undefined) return;
  for (let directory = path; ; directory = dirname(directory)) {
    await fsyncDirectory(dirname(directory));
    if (directory === first || dirname(directory) === directory) return;
  }
}

async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  await mkdirDurable(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    await fsyncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function writeRebuildable(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (info.size > MAX_METADATA_BYTES)
      fail('corruption', 'Registry metadata exceeds size limit');
    const parsed: unknown = JSON.parse(utf8.decode(await readFile(path)));
    return parsed;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof DelegationRegistryOperationError) throw error;
    fail('corruption', 'Invalid registry metadata');
  }
}

function segmentPath(directory: string, segment: number): string {
  return join(
    directory,
    'segments',
    `segment-${String(segment).padStart(8, '0')}.jsonl`,
  );
}

function indexPath(directory: string, category: string, key: string): string {
  return join(directory, 'index', category, `${key}.json`);
}

function effectIdentity(
  effect: DelegationRegistryJournalEffect,
): RegistryIdentity {
  return registryEffectIdentity(effect);
}

function receiptLocatorKey(entry: DelegationTranscriptReceiptIdentity): string {
  return `${entry.receiptKind}-${sha256(entry.key)}`;
}

function headOwnerFields(
  identity: RegistryIdentity,
): Pick<RegistryHead, 'identity' | 'owner'> {
  return 'kind' in identity ? { owner: identity } : { identity };
}

function effectForResult(
  effect: DelegationRegistryJournalEffect,
): effect is Extract<
  DelegationRegistryJournalEffect,
  { kind: 'delegation-result' }
> {
  return effect.kind === 'delegation-result';
}

function resultLocatorKey(resultIndex: number): string {
  return String(resultIndex).padStart(16, '0');
}

function settlementLocatorKey(settlementKey: string): string {
  return sha256(settlementKey);
}

function generationLocatorKey(runGeneration: number): string {
  return String(runGeneration).padStart(16, '0');
}

function admissionLocatorKey(
  runGeneration: number,
  itemId: string,
  itemRevision: number,
): string {
  return `${generationLocatorKey(runGeneration)}-${sha256(itemId)}-${String(itemRevision).padStart(16, '0')}`;
}

function sameGenerationIdentity(
  left: DelegationTranscriptGenerationEntry,
  right: DelegationTranscriptGenerationEntry,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.delegationId === right.delegationId &&
    left.runGeneration === right.runGeneration
  );
}

/**
 * Append-only per-chat / per-delegation registry journal. Segments are bounded
 * to 64 entries; point locators and high-water metadata are independently
 * replaceable and rebuildable from those segments.
 */
export class DelegationRegistryStore {
  private readonly heads = new Map<string, RegistryHead>();
  private readonly locks = new Map<string, Promise<void>>();
  /** Authoritative until checkpoint; deliberately separate from the 64-head cache. */
  private readonly overlays = new Map<string, PendingOverlay>();
  private readonly replayLoads = new Map<string, Promise<void>>();
  private readonly indexed = new Map<string, true>();
  private readonly ephemeralIndexes = new Map<string, Map<string, Locator>>();

  public constructor(
    public readonly transcriptsRoot: string,
    private readonly options: DelegationRegistryStoreOptions = {},
  ) {}

  /** Drops every cached entry of a chat whose registry tree was removed. */
  public forgetChat(chatId: string): void {
    const caches: ReadonlyArray<{
      keys(): IterableIterator<string>;
      delete(key: string): boolean;
    }> = [this.heads, this.overlays, this.indexed, this.ephemeralIndexes];
    for (const cache of caches)
      for (const key of Array.from(cache.keys())) {
        const owner: unknown = JSON.parse(key);
        if (
          Array.isArray(owner) &&
          ((owner.length === 2 && owner[0] === chatId) ||
            (owner.length === 3 &&
              owner[0] === '#owner' &&
              owner[1] === 'chat_receipts' &&
              owner[2] === chatId))
        )
          cache.delete(key);
      }
    this.replayLoads.delete(chatId);
  }

  private remember(key: string, head: RegistryHead): void {
    this.heads.delete(key);
    this.heads.set(key, head);
    while (this.heads.size > DELEGATION_REGISTRY_MAX_CACHED_DELEGATIONS) {
      const oldest = this.heads.keys().next().value;
      if (oldest === undefined) break;
      this.heads.delete(oldest);
    }
  }

  private async loadHead(identity: RegistryIdentity): Promise<RegistryHead> {
    const key = identityKey(identity);
    const cached = this.heads.get(key);
    if (cached) {
      this.remember(key, cached);
      return cached;
    }
    const directory = identityRoot(this.transcriptsRoot, identity);
    const parsed = await readJson(join(directory, 'head.json'));
    if (parsed === undefined) {
      try {
        const names = await readdir(join(directory, 'segments'));
        if (names.length > 0)
          fail('corruption', 'Registry segments have no high-water metadata');
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
      const initial: RegistryHead = {
        version: 1,
        ...headOwnerFields(identity),
        highWater: 0,
        entriesSha256: EMPTY_DIGEST,
        resultCount: 0,
        generationCount: 0,
        admissionCount: 0,
        currentSegmentBytes: 0,
      };
      this.remember(key, initial);
      return initial;
    }
    assertHead(parsed, identity);
    this.remember(key, parsed);
    return parsed;
  }

  private overlay(identity: RegistryIdentity): PendingOverlay {
    const key = identityKey(identity);
    const existing = this.overlays.get(key);
    if (existing) {
      this.overlays.delete(key);
      this.overlays.set(key, existing);
      return existing;
    }
    const created: PendingOverlay = {
      identity,
      effects: [],
      byGeneration: new Map(),
      resultsByIndex: new Map(),
      resultsBySettlement: new Map(),
      resultsByGeneration: new Map(),
      resultsByGenerationSequence: new Map(),
      admissions: new Map(),
      receipts: new Map(),
      resultOrdinals: [],
      generationOrdinals: [],
      highWater: 0,
      entriesSha256: EMPTY_DIGEST,
    };
    this.overlays.set(key, created);
    return created;
  }

  private addOverlayEffect(
    overlay: PendingOverlay,
    effect: DelegationRegistryJournalEffect,
    head: RegistryHead,
  ): void {
    if (effect.kind === 'delegation-receipt') {
      const known = overlay.receipts.get(receiptLocatorKey(effect.entry));
      if (known) {
        if (
          canonicalDelegationJson(known) !==
          canonicalDelegationJson(effect.entry)
        )
          fail('conflict', 'Conflicting receipt in registry overlay');
        return;
      }
    }
    if (effect.kind === 'delegation-generation') {
      const existing = overlay.byGeneration.get(effect.entry.runGeneration);
      if (existing) {
        if (!sameGenerationIdentity(existing, effect.entry))
          fail(
            'conflict',
            'Conflicting generation in delegation registry overlay',
          );
        return;
      }
    } else if (effect.kind === 'delegation-result') {
      const existing =
        overlay.resultsByIndex.get(effect.entry.resultIndex) ??
        overlay.resultsBySettlement.get(effect.entry.settlementKey) ??
        overlay.resultsByGeneration.get(effect.entry.runGeneration);
      if (existing) {
        if (
          canonicalDelegationJson(existing) !==
          canonicalDelegationJson(effect.entry)
        )
          fail('conflict', 'Conflicting result in delegation registry overlay');
        return;
      }
    }
    if (effect.kind === 'child-admission') {
      let allKnown = effect.items.length > 0;
      for (const item of effect.items) {
        const key = admissionLocatorKey(
          effect.target.runGeneration,
          item.id,
          item.itemRevision,
        );
        const known = overlay.admissions.get(key);
        if (
          known &&
          canonicalDelegationJson(known) !== canonicalDelegationJson(item)
        )
          fail(
            'conflict',
            'Conflicting item admission in delegation registry overlay',
          );
        if (!known) allKnown = false;
      }
      if (allKnown) return;
    }
    if (overlay.highWater === 0) {
      overlay.highWater = head.highWater;
      overlay.entriesSha256 = head.entriesSha256;
      overlay.lastResultIndex = head.lastResultIndex;
    }
    const sequence = overlay.highWater + 1;
    overlay.effects.push(effect);
    overlay.highWater = sequence;
    overlay.entriesSha256 = sha256(
      `${overlay.entriesSha256}\n${canonicalDelegationJson(effect)}`,
    );
    if (effect.kind === 'delegation-generation') {
      overlay.byGeneration.set(effect.entry.runGeneration, effect.entry);
      overlay.generationOrdinals.push({ entry: effect.entry, sequence });
    } else if (effect.kind === 'delegation-result') {
      overlay.resultsByIndex.set(effect.entry.resultIndex, effect.entry);
      overlay.resultsBySettlement.set(effect.entry.settlementKey, effect.entry);
      overlay.resultsByGeneration.set(effect.entry.runGeneration, effect.entry);
      overlay.resultsByGenerationSequence.set(effect.entry.runGeneration, {
        entry: effect.entry,
        sequence,
      });
      overlay.lastResultIndex = effect.entry.resultIndex;
      overlay.resultOrdinals.push({ entry: effect.entry, sequence });
    } else if (effect.kind === 'delegation-receipt') {
      overlay.receipts.set(receiptLocatorKey(effect.entry), effect.entry);
    } else {
      for (const item of effect.items)
        overlay.admissions.set(
          admissionLocatorKey(
            effect.target.runGeneration,
            item.id,
            item.itemRevision,
          ),
          item,
        );
    }
  }

  private async loadPendingChat(chatId: string): Promise<void> {
    if (!this.options.pendingEffects) return;
    const cached = this.replayLoads.get(chatId);
    if (cached) {
      this.replayLoads.delete(chatId);
      this.replayLoads.set(chatId, cached);
      await cached;
      return;
    }
    const loading: Promise<void> = (async (): Promise<void> => {
      for await (const effect of this.options.pendingEffects?.(chatId) ?? []) {
        validateEffect(effect, chatId);
        await this.overlayEffect(chatId, effect);
      }
    })();
    rememberBounded(this.replayLoads, chatId, loading);
    try {
      await loading;
    } catch (error) {
      if (this.replayLoads.get(chatId) === loading)
        this.replayLoads.delete(chatId);
      throw error;
    }
  }

  private async pendingFor(
    identity: RegistryIdentity,
  ): Promise<readonly DelegationRegistryJournalEffect[]> {
    await this.loadPendingChat(identity.chatId);
    return this.overlays.get(identityKey(identity))?.effects ?? [];
  }

  private async overlayOne(
    chatId: string,
    effect: DelegationRegistryJournalEffect,
  ): Promise<void> {
    await this.pendingFor(effectIdentity(effect));
    await this.overlayEffect(chatId, effect);
  }

  private async overlayEffect(
    chatId: string,
    effect: DelegationRegistryJournalEffect,
  ): Promise<void> {
    const identity = effectIdentity(effect);
    const overlay = this.overlay(identity);
    const head = await this.loadHead(identity);
    if (effect.kind === 'delegation-receipt') {
      const known =
        overlay.receipts.get(receiptLocatorKey(effect.entry)) ??
        (await this.readByLocator(
          identity,
          'receipt',
          receiptLocatorKey(effect.entry),
          head,
        ));
      if (known) {
        if (
          canonicalDelegationJson(known) !==
          canonicalDelegationJson(effect.entry)
        )
          fail('conflict', 'Receipt identity conflicts with stored entry');
        return;
      }
    }
    if (effect.kind === 'delegation-generation') {
      const queuedEntry = overlay.byGeneration.get(effect.entry.runGeneration);
      if (queuedEntry) {
        if (!sameGenerationIdentity(queuedEntry, effect.entry))
          fail('conflict', 'Generation conflicts with pending registry entry');
        return;
      }
      const existing = await this.readByLocator(
        identity,
        'generation',
        generationLocatorKey(effect.entry.runGeneration),
        head,
      );
      if (existing) {
        if (!sameGenerationIdentity(existing, effect.entry))
          fail(
            'conflict',
            'Generation registration conflicts with stored entry',
          );
        return;
      }
    } else if (effect.kind === 'delegation-result') {
      const queuedResult =
        overlay.resultsByIndex.get(effect.entry.resultIndex) ??
        overlay.resultsBySettlement.get(effect.entry.settlementKey) ??
        overlay.resultsByGeneration.get(effect.entry.runGeneration);
      if (queuedResult) {
        if (
          canonicalDelegationJson(queuedResult) !==
          canonicalDelegationJson(effect.entry)
        )
          fail(
            'conflict',
            'Delegation result conflicts with pending registry entry',
          );
        return;
      }
      const byIndex = await this.readByLocator(
        identity,
        'result',
        resultLocatorKey(effect.entry.resultIndex),
        head,
      );
      const bySettlement = await this.readByLocator(
        identity,
        'settlement',
        settlementLocatorKey(effect.entry.settlementKey),
        head,
      );
      const byGeneration = await this.readByLocator(
        identity,
        'result-generation',
        generationLocatorKey(effect.entry.runGeneration),
        head,
      );
      const prior = byIndex ?? bySettlement ?? byGeneration;
      if (prior) {
        if (
          canonicalDelegationJson(prior) !==
          canonicalDelegationJson(effect.entry)
        )
          fail(
            'conflict',
            'Delegation result identity conflicts with stored entry',
          );
        return;
      }
      const lastResultIndex = overlay.lastResultIndex ?? head.lastResultIndex;
      if (
        lastResultIndex !== undefined &&
        effect.entry.resultIndex !== lastResultIndex + 1
      )
        fail(
          'conflict',
          'Delegation result index is not the next stored result',
        );
    } else if (effect.kind === 'child-admission') {
      let storedCount = 0;
      for (const item of effect.items) {
        const indexKey = admissionLocatorKey(
          effect.target.runGeneration,
          item.id,
          item.itemRevision,
        );
        const queuedItem = overlay.admissions.get(indexKey);
        if (queuedItem) {
          if (
            canonicalDelegationJson(queuedItem) !==
            canonicalDelegationJson(item)
          )
            fail(
              'conflict',
              'Child admission conflicts with pending registry entry',
            );
          continue;
        }
        const existing = await this.readByLocator(
          identity,
          'admission',
          indexKey,
          head,
        );
        if (existing) {
          if (
            canonicalDelegationJson(existing) !== canonicalDelegationJson(item)
          )
            fail(
              'conflict',
              'Child admission metadata conflicts with stored entry',
            );
          storedCount += 1;
        }
      }
      if (storedCount === effect.items.length && effect.items.length > 0)
        return;
      if (storedCount > 0)
        fail('conflict', 'Partial child-admission checkpoint conflict');
    }
    this.addOverlayEffect(overlay, effect, head);
  }

  private async serialize<T>(
    identity: RegistryIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = identityKey(identity);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => barrier);
    this.locks.set(key, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  /** Holds every identity's lock, taken in one fixed order. */
  private serializeAll<T>(
    identities: readonly RegistryIdentity[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const [first, ...rest] = [...identities].sort((left, right) =>
      identityKey(left).localeCompare(identityKey(right)),
    );
    return first === undefined
      ? operation()
      : this.serialize(first, () => this.serializeAll(rest, operation));
  }

  private async getLocator(
    identity: RegistryIdentity,
    category: string,
    key: string,
    head: RegistryHead,
  ): Promise<Locator | undefined> {
    const directory = identityRoot(this.transcriptsRoot, identity);
    let parsed: unknown;
    try {
      parsed = await readJson(indexPath(directory, category, key));
    } catch {
      parsed = undefined;
    }
    if (isLocator(parsed) && parsed.sequence <= head.highWater) return parsed;
    const memoryIndex = await this.readOnlyIndex(identity, head);
    return memoryIndex.get(`${category}:${key}`);
  }

  private async readOnlyIndex(
    identity: RegistryIdentity,
    head: RegistryHead,
  ): Promise<Map<string, Locator>> {
    const key = identityKey(identity);
    const cached = this.ephemeralIndexes.get(key);
    if (cached) {
      this.ephemeralIndexes.delete(key);
      this.ephemeralIndexes.set(key, cached);
      return cached;
    }
    const index = new Map<string, Locator>();
    if (head.highWater > 0) {
      const directory = identityRoot(this.transcriptsRoot, identity);
      let previousDigest = EMPTY_DIGEST;
      let expectedSequence = 1;
      let resultOrdinal = 0;
      let generationOrdinal = 0;
      for (let segment = 0; expectedSequence <= head.highWater; segment += 1) {
        const bytes = await readFile(segmentPath(directory, segment)).catch(
          () => fail('corruption', 'Missing committed registry segment'),
        );
        if (bytes.length > MAX_SEGMENT_BYTES)
          fail('corruption', 'Registry segment exceeds bounded size');
        let text: string;
        try {
          text = utf8.decode(bytes);
        } catch {
          return fail('corruption', 'Invalid registry segment UTF-8');
        }
        const lines = text.split('\n');
        lines.pop();
        let offset = 0;
        for (const line of lines) {
          if (expectedSequence > head.highWater) break;
          const lineBytes = Buffer.from(`${line}\n`, 'utf8');
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return fail(
              'corruption',
              'Invalid committed registry segment JSON',
            );
          }
          if (
            !isSegmentRecord(value, identity.chatId) ||
            value.sequence !== expectedSequence ||
            value.previousDigest !== previousDigest ||
            identityKey(effectIdentity(value.effect)) !== key
          )
            fail(
              'corruption',
              'Committed registry segment sequence or digest mismatch',
            );
          const locator: Locator = {
            version: 1,
            sequence: expectedSequence,
            segment,
            offset,
            length: lineBytes.length,
          };
          const effect = value.effect;
          if (effect.kind === 'delegation-receipt') {
            const receiptKey = `receipt:${receiptLocatorKey(effect.entry)}`;
            if (index.has(receiptKey))
              fail('corruption', 'Duplicate receipt in committed registry');
            index.set(receiptKey, locator);
          }
          if (effect.kind === 'delegation-generation') {
            index.set(
              `generation:${generationLocatorKey(effect.entry.runGeneration)}`,
              locator,
            );
            index.set(
              `generation-ordinal:${String(generationOrdinal).padStart(16, '0')}`,
              locator,
            );
            generationOrdinal += 1;
          } else if (effect.kind === 'delegation-result') {
            index.set(
              `result:${resultLocatorKey(effect.entry.resultIndex)}`,
              locator,
            );
            index.set(
              `settlement:${settlementLocatorKey(effect.entry.settlementKey)}`,
              locator,
            );
            index.set(
              `result-generation:${generationLocatorKey(effect.entry.runGeneration)}`,
              locator,
            );
            index.set(
              `result-ordinal:${String(resultOrdinal).padStart(16, '0')}`,
              locator,
            );
            resultOrdinal += 1;
          } else if (effect.kind === 'child-admission') {
            for (const item of effect.items)
              index.set(
                `admission:${admissionLocatorKey(effect.target.runGeneration, item.id, item.itemRevision)}`,
                locator,
              );
          }
          previousDigest = value.entriesSha256;
          expectedSequence += 1;
          offset += lineBytes.length;
        }
      }
      if (
        expectedSequence !== head.highWater + 1 ||
        previousDigest !== head.entriesSha256 ||
        resultOrdinal !== head.resultCount ||
        generationOrdinal !== head.generationCount
      )
        fail(
          'corruption',
          'Registry index rebuild found an inconsistent high-water',
        );
    }
    this.ephemeralIndexes.set(key, index);
    while (
      this.ephemeralIndexes.size > DELEGATION_REGISTRY_MAX_CACHED_DELEGATIONS
    ) {
      const oldest = this.ephemeralIndexes.keys().next().value;
      if (oldest === undefined) break;
      this.ephemeralIndexes.delete(oldest);
    }
    return index;
  }

  private async readRecord(
    identity: RegistryIdentity,
    locator: Locator,
  ): Promise<SegmentRecord> {
    const directory = identityRoot(this.transcriptsRoot, identity);
    const path = segmentPath(directory, locator.segment);
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return fail('corruption', 'Missing delegation registry segment');
    }
    try {
      const bytes = Buffer.alloc(locator.length);
      const { bytesRead } = await handle.read(
        bytes,
        0,
        bytes.length,
        locator.offset,
      );
      if (bytesRead !== locator.length || bytes[bytes.length - 1] !== 10)
        fail('corruption', 'Truncated delegation registry record');
      let parsed: unknown;
      try {
        parsed = JSON.parse(utf8.decode(bytes.subarray(0, bytes.length - 1)));
      } catch {
        return fail('corruption', 'Invalid delegation registry record JSON');
      }
      if (
        !isSegmentRecord(parsed, identity.chatId) ||
        parsed.sequence !== locator.sequence ||
        identityKey(effectIdentity(parsed.effect)) !== identityKey(identity)
      )
        fail('corruption', 'Invalid delegation registry record');
      return parsed;
    } finally {
      await handle.close();
    }
  }

  private async writeLocator(
    directory: string,
    category: string,
    key: string,
    locator: Locator,
  ): Promise<void> {
    await writeRebuildable(
      indexPath(directory, category, key),
      Buffer.from(`${JSON.stringify(locator)}\n`, 'utf8'),
    );
  }

  private async appendBatch(
    chatId: string,
    identity: RegistryIdentity,
    effects: readonly DelegationRegistryJournalEffect[],
  ): Promise<void> {
    if (effects.length === 0) return;
    for (const effect of effects) validateEffect(effect, chatId);
    await this.serialize(identity, async () => {
      const staged = await this.stageAppend(identity, effects);
      if (staged) await this.publishStaged(chatId, [staged]);
    });
  }

  /**
   * Make an identity's new entries durable in its segments and index them,
   * without publishing its head. Undefined when every effect is stored.
   */
  private async stageAppend(
    identity: RegistryIdentity,
    effects: readonly DelegationRegistryJournalEffect[],
  ): Promise<StagedAppend | undefined> {
    const directory = identityRoot(this.transcriptsRoot, identity);
    let nextHead = await this.loadHead(identity);
    await this.rebuildIndexes(identity, nextHead);
    const indexedEffects: Array<{
      effect: DelegationRegistryJournalEffect;
      locator: Locator;
      resultOrdinal: number;
      generationOrdinal: number;
    }> = [];
    const segmentChunks = new Map<
      number,
      { offset: number; chunks: Buffer[]; length: number }
    >();
    const appendedEffects: DelegationRegistryJournalEffect[] = [];

    for (const effect of effects) {
      if (effect.kind === 'delegation-receipt') {
        const prior = await this.readByLocator(
          identity,
          'receipt',
          receiptLocatorKey(effect.entry),
          nextHead,
        );
        if (prior) {
          if (
            canonicalDelegationJson(prior) !==
            canonicalDelegationJson(effect.entry)
          )
            fail('conflict', 'Receipt identity conflicts with stored entry');
          continue;
        }
      }
      if (effect.kind === 'delegation-generation') {
        const existing = await this.readByLocator(
          identity,
          'generation',
          generationLocatorKey(effect.entry.runGeneration),
          nextHead,
        );
        if (existing) {
          if (!sameGenerationIdentity(existing, effect.entry))
            fail(
              'conflict',
              'Generation registration conflicts with stored entry',
            );
          continue;
        }
      } else if (effectForResult(effect)) {
        const byIndex = await this.readByLocator(
          identity,
          'result',
          resultLocatorKey(effect.entry.resultIndex),
          nextHead,
        );
        const bySettlement = await this.readByLocator(
          identity,
          'settlement',
          settlementLocatorKey(effect.entry.settlementKey),
          nextHead,
        );
        const byGeneration = await this.readByLocator(
          identity,
          'result-generation',
          generationLocatorKey(effect.entry.runGeneration),
          nextHead,
        );
        const prior = byIndex ?? bySettlement ?? byGeneration;
        if (prior) {
          if (
            canonicalDelegationJson(prior) !==
            canonicalDelegationJson(effect.entry)
          )
            fail(
              'conflict',
              'Delegation result identity conflicts with stored entry',
            );
          continue;
        }
        if (
          nextHead.lastResultIndex !== undefined &&
          effect.entry.resultIndex !== nextHead.lastResultIndex + 1
        )
          fail(
            'conflict',
            'Delegation result index is not the next stored result',
          );
      } else if (effect.kind === 'child-admission') {
        let storedCount = 0;
        for (const item of effect.items) {
          const key = admissionLocatorKey(
            effect.target.runGeneration,
            item.id,
            item.itemRevision,
          );
          const existing = await this.readByLocator(
            identity,
            'admission',
            key,
            nextHead,
          );
          if (!existing) continue;
          if (
            canonicalDelegationJson(existing) !== canonicalDelegationJson(item)
          )
            fail(
              'conflict',
              'Child admission metadata conflicts with stored entry',
            );
          storedCount += 1;
        }
        if (storedCount === effect.items.length) continue;
        if (storedCount > 0)
          fail('conflict', 'Partial child-admission checkpoint conflict');
      }

      const sequence = nextHead.highWater + 1;
      const segment = Math.floor((sequence - 1) / SEGMENT_ENTRY_LIMIT);
      let segmentBatch = segmentChunks.get(segment);
      if (!segmentBatch) {
        const previousSegment =
          nextHead.highWater === 0
            ? -1
            : Math.floor((nextHead.highWater - 1) / SEGMENT_ENTRY_LIMIT);
        const offset =
          segment === previousSegment ? nextHead.currentSegmentBytes : 0;
        segmentBatch = { offset, chunks: [], length: 0 };
        segmentChunks.set(segment, segmentBatch);
      }
      const previousDigest = nextHead.entriesSha256;
      const entriesSha256 = sha256(
        `${previousDigest}\n${canonicalDelegationJson(effect)}`,
      );
      const record: SegmentRecord = {
        version: 1,
        sequence,
        effect,
        previousDigest,
        entriesSha256,
      };
      const line = Buffer.from(`${canonicalDelegationJson(record)}\n`, 'utf8');
      if (line.length > DELEGATION_REGISTRY_MAX_ENTRY_BYTES + 1024)
        fail(
          'invalid_request',
          'Delegation registry record exceeds segment limit',
        );
      const offset = segmentBatch.offset + segmentBatch.length;
      segmentBatch.chunks.push(line);
      segmentBatch.length += line.length;
      indexedEffects.push({
        effect,
        locator: {
          version: 1,
          sequence,
          segment,
          offset,
          length: line.length,
        },
        resultOrdinal: nextHead.resultCount,
        generationOrdinal: nextHead.generationCount,
      });
      appendedEffects.push(effect);
      nextHead = {
        version: 1,
        ...headOwnerFields(identity),
        highWater: sequence,
        entriesSha256,
        lastResultIndex: effectForResult(effect)
          ? effect.entry.resultIndex
          : nextHead.lastResultIndex,
        resultCount: nextHead.resultCount + (effectForResult(effect) ? 1 : 0),
        generationCount:
          nextHead.generationCount +
          (effect.kind === 'delegation-generation' ? 1 : 0),
        admissionCount:
          nextHead.admissionCount +
          (effect.kind === 'child-admission' ? effect.items.length : 0),
        currentSegmentBytes: offset + line.length,
      };
    }

    if (indexedEffects.length === 0) return undefined;
    // Segments never exist without a head: a crash before the final head
    // leaves high-water 0, and recovery replays the journal over it.
    const publishedHead = await this.loadHead(identity);
    if (publishedHead.highWater === 0)
      await writeAtomic(
        join(directory, 'head.json'),
        Buffer.from(`${JSON.stringify(publishedHead)}\n`, 'utf8'),
      );
    await mkdirDurable(join(directory, 'segments'));
    let createdSegment = false;
    for (const [segment, batch] of Array.from(segmentChunks.entries())) {
      const path = segmentPath(directory, segment);
      await truncate(path, batch.offset).catch((error: unknown) => {
        if (isRecord(error) && error.code === 'ENOENT') {
          createdSegment = true;
          return;
        }
        throw error;
      });
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.write(Buffer.concat(batch.chunks));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    // A head may reference a new segment only once its entry is durable.
    if (createdSegment) await fsyncDirectory(join(directory, 'segments'));
    for (const indexed of indexedEffects)
      await this.indexEffect(
        directory,
        indexed.effect,
        indexed.locator,
        indexed.resultOrdinal,
        indexed.generationOrdinal,
      );
    return { identity, directory, appendedEffects, nextHead };
  }

  /**
   * Publish staged appends of one chat: its manifest once, then each head.
   * The manifest is never behind a published head, so a replay that finds
   * an effect already stored never leaves the snapshot digest unchanged.
   * A crash after the manifest folds the replayed effects in again, as a
   * crash between one identity's manifest and head always could.
   */
  private async publishStaged(
    chatId: string,
    staged: readonly StagedAppend[],
  ): Promise<void> {
    await this.updateManifest(
      chatId,
      staged.flatMap(({ identity, appendedEffects }) =>
        appendedEffects.map((effect) => ({ identity, effect })),
      ),
    );
    const settled = await Promise.allSettled(
      staged.map(async ({ identity, directory, nextHead }) => {
        await writeAtomic(
          join(directory, 'head.json'),
          Buffer.from(`${JSON.stringify(nextHead)}\n`, 'utf8'),
        );
        this.remember(identityKey(identity), nextHead);
      }),
    );
    for (const result of settled)
      if (result.status === 'rejected') throw result.reason;
  }

  private async indexEffect(
    directory: string,
    effect: DelegationRegistryJournalEffect,
    locator: Locator,
    resultOrdinal: number,
    generationOrdinal: number,
  ): Promise<void> {
    if (effect.kind === 'delegation-receipt') {
      await this.writeLocator(
        directory,
        'receipt',
        receiptLocatorKey(effect.entry),
        locator,
      );
      return;
    }
    if (effect.kind === 'delegation-generation') {
      await Promise.all([
        this.writeLocator(
          directory,
          'generation',
          generationLocatorKey(effect.entry.runGeneration),
          locator,
        ),
        this.writeLocator(
          directory,
          'generation-ordinal',
          String(generationOrdinal).padStart(16, '0'),
          locator,
        ),
      ]);
      return;
    }
    if (effectForResult(effect)) {
      await Promise.all([
        this.writeLocator(
          directory,
          'result',
          resultLocatorKey(effect.entry.resultIndex),
          locator,
        ),
        this.writeLocator(
          directory,
          'settlement',
          settlementLocatorKey(effect.entry.settlementKey),
          locator,
        ),
        this.writeLocator(
          directory,
          'result-generation',
          generationLocatorKey(effect.entry.runGeneration),
          locator,
        ),
        this.writeLocator(
          directory,
          'result-ordinal',
          String(resultOrdinal).padStart(16, '0'),
          locator,
        ),
      ]);
      return;
    }
    if (effect.kind === 'child-admission') {
      await Promise.all(
        effect.items.map((item) => {
          const key = admissionLocatorKey(
            effect.target.runGeneration,
            item.id,
            item.itemRevision,
          );
          return this.writeLocator(directory, 'admission', key, locator);
        }),
      );
    }
  }

  private async updateManifest(
    chatId: string,
    effects: ReadonlyArray<{
      readonly identity: RegistryIdentity;
      readonly effect: DelegationRegistryJournalEffect;
    }>,
  ): Promise<void> {
    const path = join(chatRoot(this.transcriptsRoot, chatId), 'manifest.json');
    const value = await readJson(path);
    let previous = EMPTY_DIGEST;
    let revision = 0;
    if (value !== undefined) {
      if (
        !isRecord(value) ||
        !exactKeys(value, ['version', 'chatId', 'revision', 'digest']) ||
        value.version !== 1 ||
        value.chatId !== chatId ||
        !isSafeCount(value.revision) ||
        typeof value.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.digest)
      )
        fail('corruption', 'Invalid delegation registry manifest');
      previous = value.digest;
      revision = value.revision;
    }
    let digest = previous;
    for (const { identity, effect } of effects)
      digest = sha256(
        `${digest}\n${canonicalDelegationJson({ identity, effect })}`,
      );
    const manifest: ChatManifest = {
      version: 1,
      chatId,
      revision: revision + effects.length,
      digest,
    };
    await writeAtomic(
      path,
      Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
    );
  }

  private async readByLocator(
    identity: RegistryIdentity,
    category: 'receipt',
    key: string,
    head: RegistryHead,
  ): Promise<DelegationTranscriptReceiptEntry | undefined>;
  private async readByLocator(
    identity: RegistryIdentity,
    category: 'result' | 'settlement' | 'result-generation' | 'result-ordinal',
    key: string,
    head: RegistryHead,
  ): Promise<DelegationTranscriptResultEntry | undefined>;
  private async readByLocator(
    identity: RegistryIdentity,
    category: 'generation' | 'generation-ordinal',
    key: string,
    head: RegistryHead,
  ): Promise<DelegationTranscriptGenerationEntry | undefined>;
  private async readByLocator(
    identity: RegistryIdentity,
    category: 'admission',
    key: string,
    head: RegistryHead,
  ): Promise<DelegationItemAdmissionMetadata | undefined>;
  private async readByLocator(
    identity: RegistryIdentity,
    category: RegistryIndexCategory,
    key: string,
    head: RegistryHead,
  ): Promise<
    | DelegationTranscriptResultEntry
    | DelegationTranscriptGenerationEntry
    | DelegationItemAdmissionMetadata
    | DelegationTranscriptReceiptEntry
    | undefined
  > {
    const locator = await this.getLocator(identity, category, key, head);
    if (!locator) return undefined;
    const record = await this.readRecord(identity, locator);
    if (record.effect.kind === 'delegation-receipt') {
      if (category !== 'receipt') return undefined;
      if (receiptLocatorKey(record.effect.entry) !== key)
        fail('corruption', 'Receipt locator identity mismatch');
      return record.effect.entry;
    }
    if (record.effect.kind === 'delegation-generation') {
      if (category === 'generation' || category === 'generation-ordinal')
        return record.effect.entry;
      return undefined;
    }
    if (record.effect.kind === 'delegation-result') {
      if (
        category === 'result' ||
        category === 'settlement' ||
        category === 'result-generation' ||
        category === 'result-ordinal'
      )
        return record.effect.entry;
      return undefined;
    }
    if (record.effect.kind === 'child-admission') {
      const bits = key.split('-');
      const runGeneration = Number(bits[0]);
      const hash = bits[1];
      const revision = Number(bits[2]);
      if (record.effect.target.runGeneration !== runGeneration)
        return undefined;
      const item = record.effect.items.find(
        (candidate) =>
          sha256(candidate.id) === hash && candidate.itemRevision === revision,
      );
      return item;
    }
    return undefined;
  }

  private async rebuildIndexes(
    identity: RegistryIdentity,
    head: RegistryHead,
  ): Promise<void> {
    const identityKeyValue = identityKey(identity);
    if (this.indexed.has(identityKeyValue)) return;
    const directory = identityRoot(this.transcriptsRoot, identity);
    const indexDirectory = join(directory, 'index');
    try {
      await stat(indexDirectory);
      rememberBounded(this.indexed, identityKeyValue, true);
      return;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    if (head.highWater === 0) {
      rememberBounded(this.indexed, identityKeyValue, true);
      return;
    }
    let previousDigest = EMPTY_DIGEST;
    let expectedSequence = 1;
    let resultsSeen = 0;
    let generationsSeen = 0;
    for (let segment = 0; expectedSequence <= head.highWater; segment += 1) {
      const bytes = await readFile(segmentPath(directory, segment)).catch(() =>
        fail('corruption', 'Missing delegation registry segment'),
      );
      if (bytes.length > MAX_SEGMENT_BYTES)
        fail('corruption', 'Registry segment exceeds bounded size');
      const lines = bytes.toString('utf8').split('\n');
      lines.pop();
      let offset = 0;
      for (const line of lines) {
        const lineBytes = Buffer.from(`${line}\n`, 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return fail('corruption', 'Invalid registry segment JSON');
        }
        if (
          !isSegmentRecord(parsed, identity.chatId) ||
          parsed.sequence !== expectedSequence ||
          parsed.previousDigest !== previousDigest ||
          identityKey(effectIdentity(parsed.effect)) !== identityKey(identity)
        )
          fail('corruption', 'Registry segment sequence or digest gap');
        const nextDigest = parsed.entriesSha256;
        const locator: Locator = {
          version: 1,
          sequence: expectedSequence,
          segment,
          offset,
          length: lineBytes.length,
        };
        await this.indexEffect(
          directory,
          parsed.effect,
          locator,
          resultsSeen,
          generationsSeen,
        );
        if (parsed.effect.kind === 'delegation-result') resultsSeen += 1;
        if (parsed.effect.kind === 'delegation-generation')
          generationsSeen += 1;
        previousDigest = nextDigest;
        expectedSequence += 1;
        offset += lineBytes.length;
        if (expectedSequence > head.highWater) break;
      }
    }
    if (
      expectedSequence !== head.highWater + 1 ||
      previousDigest !== head.entriesSha256 ||
      resultsSeen !== head.resultCount ||
      generationsSeen !== head.generationCount
    )
      fail('corruption', 'Delegation registry high-water digest mismatch');
    rememberBounded(this.indexed, identityKeyValue, true);
  }

  public async append(
    chatId: string,
    effects: readonly DelegationRegistryJournalEffect[],
  ): Promise<void> {
    validateChatId(chatId);
    if (this.options.pendingEffects && effects.length > 0)
      fail('invalid_request', 'A replay-overlay registry store is read-only');
    for (const effect of effects) validateEffect(effect, chatId);
    for (const effect of effects) await this.overlayOne(chatId, effect);
  }

  public async checkpoint(
    checkpoint: DelegationRegistryCheckpoint,
  ): Promise<DelegationRegistryCheckpoint> {
    await this.assertCheckpoint(checkpoint);
    const key = identityKey(checkpoint.identity);
    const pending = this.overlays.get(key)?.effects ?? [];
    if (pending.length === 0) return checkpoint;
    const initialHead = await this.loadHead(checkpoint.identity);
    try {
      await this.appendBatch(
        checkpoint.identity.chatId,
        checkpoint.identity,
        pending,
      );
    } catch (error) {
      await this.retainUncommitted(checkpoint.identity, pending, initialHead);
      throw error;
    }
    this.overlays.delete(key);
    await this.writeCheckpointFile(checkpoint);
    return checkpoint;
  }

  /**
   * Checkpoint several identities of one chat together: their segments and
   * indexes in parallel, the chat manifest once, then their heads (see
   * `publishStaged`). Validation and failure handling match `checkpoint`.
   */
  public async checkpointChat(
    checkpoints: readonly DelegationRegistryCheckpoint[],
  ): Promise<void> {
    const chatId = checkpoints[0]?.identity.chatId;
    const work: Array<{
      checkpoint: DelegationRegistryCheckpoint;
      pending: DelegationRegistryJournalEffect[];
      initialHead: RegistryHead;
    }> = [];
    for (const checkpoint of checkpoints) {
      await this.assertCheckpoint(checkpoint);
      if (checkpoint.identity.chatId !== chatId)
        fail('invalid_request', 'Registry checkpoints must share a chat');
      const pending =
        this.overlays.get(identityKey(checkpoint.identity))?.effects ?? [];
      if (pending.length === 0) continue;
      for (const effect of pending)
        validateEffect(effect, checkpoint.identity.chatId);
      work.push({
        checkpoint,
        pending,
        initialHead: await this.loadHead(checkpoint.identity),
      });
    }
    if (chatId === undefined || work.length === 0) return;
    try {
      await this.serializeAll(
        work.map(({ checkpoint }) => checkpoint.identity),
        async () => {
          const settled = await Promise.allSettled(
            work.map(({ checkpoint, pending }) =>
              this.stageAppend(checkpoint.identity, pending),
            ),
          );
          const staged: StagedAppend[] = [];
          // Every identity has stopped writing before a failure propagates.
          for (const result of settled) {
            if (result.status === 'rejected') throw result.reason;
            if (result.value) staged.push(result.value);
          }
          if (staged.length) await this.publishStaged(chatId, staged);
        },
      );
    } catch (error) {
      for (const { checkpoint, pending, initialHead } of work)
        await this.retainUncommitted(checkpoint.identity, pending, initialHead);
      throw error;
    }
    for (const { checkpoint } of work)
      this.overlays.delete(identityKey(checkpoint.identity));
    const written = await Promise.allSettled(
      work.map(({ checkpoint }) => this.writeCheckpointFile(checkpoint)),
    );
    for (const result of written)
      if (result.status === 'rejected') throw result.reason;
  }

  private async assertCheckpoint(
    checkpoint: DelegationRegistryCheckpoint,
  ): Promise<void> {
    if (this.options.pendingEffects)
      fail('invalid_request', 'A replay-overlay registry store is read-only');
    validateIdentity(checkpoint.identity);
    if (
      !isSafeCount(checkpoint.highWater) ||
      typeof checkpoint.entriesSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checkpoint.entriesSha256)
    )
      fail('invalid_request', 'Invalid delegation registry checkpoint');
    const current = await this.highWater(checkpoint.identity);
    if (
      current.highWater !== checkpoint.highWater ||
      current.entriesSha256 !== checkpoint.entriesSha256
    )
      fail(
        'conflict',
        'Delegation registry checkpoint does not match stored high-water',
      );
  }

  /** After a failed checkpoint, keep only the effects its head did not take. */
  private async retainUncommitted(
    identity: RegistryIdentity,
    pending: readonly DelegationRegistryJournalEffect[],
    initialHead: RegistryHead,
  ): Promise<void> {
    const currentHead = await this.loadHead(identity);
    const committed = currentHead.highWater - initialHead.highWater;
    if (committed <= 0) return;
    const remaining = pending.slice(committed);
    const overlay = this.overlays.get(identityKey(identity));
    if (!overlay) return;
    overlay.effects.length = 0;
    overlay.byGeneration.clear();
    overlay.resultsByIndex.clear();
    overlay.resultsBySettlement.clear();
    overlay.resultsByGeneration.clear();
    overlay.resultsByGenerationSequence.clear();
    overlay.admissions.clear();
    overlay.receipts.clear();
    overlay.resultOrdinals.length = 0;
    overlay.generationOrdinals.length = 0;
    overlay.highWater = 0;
    overlay.entriesSha256 = EMPTY_DIGEST;
    overlay.lastResultIndex = undefined;
    for (const effect of remaining)
      this.addOverlayEffect(overlay, effect, currentHead);
  }

  private async writeCheckpointFile(
    checkpoint: DelegationRegistryCheckpoint,
  ): Promise<void> {
    const directory = identityRoot(this.transcriptsRoot, checkpoint.identity);
    await mkdir(directory, { recursive: true });
    await writeAtomic(
      join(directory, 'checkpoint.json'),
      Buffer.from(`${JSON.stringify(checkpoint)}\n`, 'utf8'),
    );
  }

  public async receipt(
    input: DelegationTranscriptReceiptIdentity,
  ): Promise<DelegationTranscriptReceiptEntry | undefined> {
    if (!isRecord(input)) fail('invalid_request', 'Invalid receipt identity');
    validateChatId(input.chatId);
    if (
      !['command', 'stop', 'stop_outcome'].includes(input.receiptKind) ||
      typeof input.key !== 'string' ||
      !(
        input.receiptKind === 'stop_outcome'
          ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
          : /^[a-f0-9]{64}$/
      ).test(input.key)
    )
      fail('invalid_request', 'Invalid receipt identity');
    const identity: RegistryIdentity = {
      kind: 'chat_receipts',
      chatId: input.chatId,
    };
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    return (
      this.overlays
        .get(identityKey(identity))
        ?.receipts.get(receiptLocatorKey(input)) ??
      this.readByLocator(identity, 'receipt', receiptLocatorKey(input), head)
    );
  }

  public async highWater(
    identity: DelegationRegistryCheckpoint['identity'],
  ): Promise<DelegationRegistryCheckpoint> {
    validateIdentity(identity);
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const overlay = this.overlays.get(identityKey(identity));
    if (!overlay || overlay.effects.length === 0)
      return {
        identity,
        highWater: head.highWater,
        entriesSha256: head.entriesSha256,
      };
    return {
      identity,
      highWater: overlay.highWater,
      entriesSha256: overlay.entriesSha256,
    };
  }

  public async lastResultIndex(
    identity: DelegationTranscriptRegistryIdentity,
  ): Promise<number | undefined> {
    validateIdentity(identity);
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    return (
      this.overlays.get(identityKey(identity))?.lastResultIndex ??
      head.lastResultIndex
    );
  }

  public async result(
    input: DelegationTranscriptResultRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    const identity = requestIdentity(input, [
      'chatId',
      'delegationId',
      'resultIndex',
    ]);
    if (!isSafeCount(input.resultIndex) || input.resultIndex < 1)
      fail('invalid_request', 'Invalid result index');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const pending = this.overlays
      .get(identityKey(identity))
      ?.resultsByIndex.get(input.resultIndex);
    if (pending) return pending;
    return this.readByLocator(
      identity,
      'result',
      resultLocatorKey(input.resultIndex),
      head,
    );
  }

  public async resultBySettlementKey(
    input: DelegationSettlementKeyRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    const identity = requestIdentity(input, [
      'chatId',
      'delegationId',
      'settlementKey',
    ]);
    if (!isId(input.settlementKey))
      fail('invalid_request', 'Invalid settlement key');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const pending = this.overlays
      .get(identityKey(identity))
      ?.resultsBySettlement.get(input.settlementKey);
    if (pending) return pending;
    return this.readByLocator(
      identity,
      'settlement',
      settlementLocatorKey(input.settlementKey),
      head,
    );
  }

  public async resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    const identity = requestIdentity(input, [
      'chatId',
      'delegationId',
      'runGeneration',
    ]);
    if (!isSafeCount(input.runGeneration))
      fail('invalid_request', 'Invalid run generation');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const pending = this.overlays
      .get(identityKey(identity))
      ?.resultsByGeneration.get(input.runGeneration);
    if (pending) return pending;
    return this.readByLocator(
      identity,
      'result-generation',
      generationLocatorKey(input.runGeneration),
      head,
    );
  }

  public async resultByGenerationAtHighWater(
    identity: RegistryIdentity,
    runGeneration: number,
    highWater: number,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    validateIdentity(identity);
    if (!isSafeCount(runGeneration) || !isSafeCount(highWater))
      fail('invalid_request', 'Invalid registry snapshot lookup');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const overlay = this.overlays.get(identityKey(identity));
    const pending = overlay?.resultsByGenerationSequence.get(runGeneration);
    if (pending)
      return pending.sequence <= highWater ? pending.entry : undefined;
    const locator = await this.getLocator(
      identity,
      'result-generation',
      generationLocatorKey(runGeneration),
      head,
    );
    if (!locator || locator.sequence > highWater) return undefined;
    return this.readByLocator(
      identity,
      'result-generation',
      generationLocatorKey(runGeneration),
      head,
    );
  }

  public async generationEntry(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptGenerationEntry | undefined> {
    const identity = requestIdentity(input, [
      'chatId',
      'delegationId',
      'runGeneration',
    ]);
    if (!isSafeCount(input.runGeneration))
      fail('invalid_request', 'Invalid run generation');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const pending = this.overlays
      .get(identityKey(identity))
      ?.byGeneration.get(input.runGeneration);
    if (pending) return pending;
    return this.readByLocator(
      identity,
      'generation',
      generationLocatorKey(input.runGeneration),
      head,
    );
  }

  public async generation(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptGeneration | undefined> {
    const entry = await this.generationEntry(input);
    if (!entry) return undefined;
    const result = await this.resultByGeneration(input);
    return { entry, stream: null, result: result ?? null };
  }

  public async itemAdmission(
    input: DelegationAdmissionRequest,
  ): Promise<DelegationItemAdmissionMetadata | undefined> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['target', 'messageId', 'itemRevision'])
    )
      fail('invalid_request', 'Invalid item admission request');
    validateIdentity({
      chatId: input.target.chatId,
      delegationId: input.target.delegationId,
    });
    validateTarget(input.target, input.target.chatId);
    if (!isId(input.messageId) || !isSafeCount(input.itemRevision))
      fail('invalid_request', 'Invalid item admission lookup');
    const identity = {
      chatId: input.target.chatId,
      delegationId: input.target.delegationId,
    };
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const key = admissionLocatorKey(
      input.target.runGeneration,
      input.messageId,
      input.itemRevision,
    );
    const pending = this.overlays
      .get(identityKey(identity))
      ?.admissions.get(key);
    if (pending) return pending;
    return this.readByLocator(identity, 'admission', key, head);
  }

  public async readPage(
    identity: DelegationTranscriptRegistryIdentity,
    kind: 'results',
    position: number,
    highWater: number,
    limit: number,
  ): Promise<DelegationRegistryPageSlice<DelegationTranscriptResultEntry>>;
  public async readPage(
    identity: DelegationTranscriptRegistryIdentity,
    kind: 'generations',
    position: number,
    highWater: number,
    limit: number,
  ): Promise<DelegationRegistryPageSlice<DelegationTranscriptGenerationEntry>>;
  public async readPage(
    identity: DelegationTranscriptRegistryIdentity,
    kind: 'generations' | 'results',
    position: number,
    highWater: number,
    limit: number,
  ): Promise<
    DelegationRegistryPageSlice<
      DelegationTranscriptGenerationEntry | DelegationTranscriptResultEntry
    >
  > {
    validateIdentity(identity);
    if (
      !isSafeCount(position) ||
      !isSafeCount(highWater) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail('invalid_request', 'Invalid registry page range');
    const head = await this.loadHead(identity);
    await this.pendingFor(identity);
    const overlay = this.overlays.get(identityKey(identity));
    const isResult = kind === 'results';
    const category = isResult ? 'result-ordinal' : 'generation-ordinal';
    const persistedCount = isResult ? head.resultCount : head.generationCount;
    const pendingEvents = isResult
      ? (overlay?.resultOrdinals ?? [])
      : (overlay?.generationOrdinals ?? []);
    const count = persistedCount + pendingEvents.length;
    if (position > count)
      fail('invalid_request', 'Registry page cursor is out of range');
    const entries: (
      | DelegationTranscriptGenerationEntry
      | DelegationTranscriptResultEntry
    )[] = [];
    let ordinal = position;
    while (ordinal < count && entries.length < limit) {
      if (ordinal < persistedCount) {
        const locator = await this.getLocator(
          identity,
          category,
          String(ordinal).padStart(16, '0'),
          head,
        );
        if (!locator) fail('corruption', 'Missing registry page locator');
        if (locator.sequence > highWater) break;
        const record = await this.readRecord(identity, locator);
        if (isResult && record.effect.kind === 'delegation-result')
          entries.push(record.effect.entry);
        else if (!isResult && record.effect.kind === 'delegation-generation')
          entries.push(record.effect.entry);
        else fail('corruption', 'Registry page locator kind mismatch');
      } else {
        const pendingEvent = pendingEvents[ordinal - persistedCount];
        if (!pendingEvent || pendingEvent.sequence > highWater) break;
        entries.push(pendingEvent.entry);
      }
      ordinal += 1;
    }
    let hasMore = false;
    if (ordinal < count) {
      if (ordinal < persistedCount) {
        const nextLocator = await this.getLocator(
          identity,
          category,
          String(ordinal).padStart(16, '0'),
          head,
        );
        hasMore = Boolean(nextLocator && nextLocator.sequence <= highWater);
      } else {
        const nextPending = pendingEvents[ordinal - persistedCount];
        hasMore = Boolean(nextPending && nextPending.sequence <= highWater);
      }
    }
    if (kind === 'results') {
      const results = entries.filter(
        (entry): entry is DelegationTranscriptResultEntry =>
          entry.kind === 'result',
      );
      return { entries: results, position: ordinal, highWater, hasMore };
    }
    const generations = entries.filter(
      (entry): entry is DelegationTranscriptGenerationEntry =>
        entry.kind === 'generation',
    );
    return { entries: generations, position: ordinal, highWater, hasMore };
  }

  public async resultsPage(
    input: DelegationTranscriptRegistryIdentity & {
      readonly cursor?: string;
      readonly limit: number;
    },
    context: DelegationRegistryCursorContext,
  ): Promise<{
    readonly results: readonly DelegationTranscriptResultEntry[];
    readonly cursor?: string;
  }> {
    const identity = { chatId: input.chatId, delegationId: input.delegationId };
    const current = await this.highWater(identity);
    const page = await this.readPage(
      identity,
      'results',
      0,
      current.highWater,
      input.limit,
    );
    void context;
    return { results: page.entries };
  }

  public async generationsPage(
    input: DelegationTranscriptRegistryIdentity & {
      readonly cursor?: string;
      readonly limit: number;
    },
    context: DelegationRegistryCursorContext,
  ): Promise<{
    readonly generations: readonly DelegationTranscriptGeneration[];
    readonly cursor?: string;
  }> {
    const identity = { chatId: input.chatId, delegationId: input.delegationId };
    const current = await this.highWater(identity);
    const page = await this.readPage(
      identity,
      'generations',
      0,
      current.highWater,
      input.limit,
    );
    const generations: DelegationTranscriptGeneration[] = [];
    for (const entry of page.entries) {
      const result = await this.resultByGeneration({
        chatId: input.chatId,
        delegationId: input.delegationId,
        runGeneration: entry.runGeneration,
      });
      generations.push({ entry, stream: null, result: result ?? null });
    }
    void context;
    return { generations };
  }

  public resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptContentRange> {
    void input;
    void signal;
    return Promise.reject(
      new DelegationRegistryOperationError({
        code: 'unsupported_format',
        message: 'Answer range reads require the transcript reader adapter',
        retryable: false,
      }),
    );
  }

  public async *answerReferences(
    chatId: string,
  ): AsyncGenerator<PersistedToolOutputReference> {
    validateChatId(chatId);
    await this.loadPendingChat(chatId);
    for await (const reference of enumerateDelegationRegistryAnswerReferences(
      this.transcriptsRoot,
      chatId,
    ))
      yield reference;
    for (const overlay of Array.from(this.overlays.values())) {
      if (overlay.identity.chatId !== chatId) continue;
      for (const effect of overlay.effects) {
        if (
          effect.kind === 'delegation-result' &&
          effect.entry.answer.kind === 'body'
        )
          yield effect.entry.answer.ref;
      }
    }
  }
}

export async function* enumerateDelegationRegistryAnswerReferences(
  transcriptsRoot: string,
  chatId: string,
): AsyncGenerator<PersistedToolOutputReference> {
  for await (const reference of scanDelegationRegistryAnswerReferences(
    transcriptsRoot,
    chatId,
  ))
    if (reference) yield reference;
}

/**
 * Every committed record, in order: its answer reference, or null when it
 * has none, so a bounded caller can charge records that yield nothing.
 */
export async function* scanDelegationRegistryAnswerReferences(
  transcriptsRoot: string,
  chatId: string,
): AsyncGenerator<PersistedToolOutputReference | null> {
  validateChatId(chatId);
  const root = chatRoot(transcriptsRoot, chatId);
  let delegationDirs: string[];
  try {
    delegationDirs = await readdir(root);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of delegationDirs) {
    if (!/^(?:receipts-)?[a-f0-9]{64}$/.test(name)) continue;
    const directory = join(root, name);
    const headValue = await readJson(join(directory, 'head.json'));
    if (!isRecord(headValue))
      fail('corruption', 'Registry directory has no high-water identity');
    const identityValue = headValue.owner ?? headValue.identity;
    let identity: RegistryIdentity;
    if (
      isRecord(identityValue) &&
      identityValue.kind === 'chat_receipts' &&
      isId(identityValue.chatId)
    )
      identity = { kind: 'chat_receipts', chatId: identityValue.chatId };
    else if (
      isRecord(identityValue) &&
      isId(identityValue.chatId) &&
      isId(identityValue.delegationId)
    )
      identity = {
        chatId: identityValue.chatId,
        delegationId: identityValue.delegationId,
      };
    else return fail('corruption', 'Invalid registry directory identity');
    validateChatId(identity.chatId);
    assertHead(headValue, identity);
    if (identity.chatId !== chatId || identityDigest(identity) !== name)
      fail('corruption', 'Registry directory identity mismatch');
    let previousDigest = EMPTY_DIGEST;
    let expectedSequence = 1;
    for (
      let segment = 0;
      expectedSequence <= headValue.highWater;
      segment += 1
    ) {
      let bytes: Buffer;
      try {
        bytes = await readFile(segmentPath(directory, segment));
      } catch {
        return fail('corruption', 'Missing committed registry segment');
      }
      if (
        bytes.length >
        SEGMENT_ENTRY_LIMIT * (DELEGATION_REGISTRY_MAX_ENTRY_BYTES + 1024)
      )
        fail('corruption', 'Registry segment exceeds bounded size');
      let offset = 0;
      while (expectedSequence <= headValue.highWater) {
        const newline = bytes.indexOf(10, offset);
        if (newline < 0) fail('corruption', 'Torn committed registry segment');
        let record: unknown;
        try {
          record = JSON.parse(utf8.decode(bytes.subarray(offset, newline)));
        } catch {
          return fail('corruption', 'Invalid committed registry record');
        }
        if (
          !isSegmentRecord(record, chatId) ||
          record.sequence !== expectedSequence ||
          record.previousDigest !== previousDigest ||
          identityKey(effectIdentity(record.effect)) !== identityKey(identity)
        )
          fail('corruption', 'Committed registry segment chain mismatch');
        yield record.effect.kind === 'delegation-result' &&
        record.effect.entry.answer.kind === 'body'
          ? record.effect.entry.answer.ref
          : null;
        previousDigest = record.entriesSha256;
        expectedSequence += 1;
        offset = newline + 1;
        if (offset >= bytes.length) break;
      }
    }
    if (
      expectedSequence !== headValue.highWater + 1 ||
      previousDigest !== headValue.entriesSha256
    )
      fail(
        'corruption',
        'Registry answer-reference scan did not reach high-water',
      );
  }
}

export async function registrySnapshotDigest(
  transcriptsRoot: string,
  chatId: string,
): Promise<string> {
  validateChatId(chatId);
  const value = await readJson(
    join(chatRoot(transcriptsRoot, chatId), 'manifest.json'),
  );
  if (value === undefined) return EMPTY_DIGEST;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.chatId !== chatId ||
    !isSafeCount(value.revision) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    fail('corruption', 'Invalid delegation registry snapshot manifest');
  return value.digest;
}
