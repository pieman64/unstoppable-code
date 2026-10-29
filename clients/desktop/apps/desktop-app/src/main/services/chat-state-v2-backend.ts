import {
  estimateTranscriptWindowBytes,
  type TranscriptViewRequest,
} from '@canopy/agent-transcript/transcript-storage';
import { settlePersistedForkMessages } from '../lib/persisted-chat-settle';
import {
  recordChatStorageCommit,
  recordChatStorageIndexClone,
  recordChatStorageMutations,
} from '@canopy/desktop-shared/node/work-counters';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
  promoteToDeltaJournal,
  removeStrayDeltaJournal,
  type DeltaJournalDiagnostic,
  type DeltaJournalWrite,
} from '../lib/chat-delta-journal/writer';
import {
  LARGE_JOURNAL_RECORD_BYTES,
  PromotionRetry,
  estimateJournalBytes,
  journalWritesFor,
  type JournalWriteForms,
  type PromotionRetryOptions,
} from '../lib/chat-delta-journal/backend-policy';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import { DELTA_JOURNAL_FILE_NAME } from '../lib/chat-delta-journal/format';
import {
  ChatTranscriptLog,
  type CapturedTranscriptPreview,
} from '../lib/chat-transcript-log';
import { storedArtifactRefsOf } from '../lib/chat-artifact-references';
import { CreatedArtifacts } from '../lib/chat-transcript-artifacts';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import { delegationChildMessages } from '@canopy/agent-transcript';
import {
  reportChatTranscriptFullRewrite,
  type ChatTranscriptFullRewrite,
} from './chat-transcript-rewrite-diagnostics';
import {
  ChatArtifactMaintenance,
  type ArtifactMaintenanceProgress,
} from '../lib/chat-artifact-maintenance';
import type {
  ChatCoreMutation,
  ChatJournalRecord,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  ChatMutationOptions,
  ChatStateTransactionContext,
} from './chat-state-contracts';
import { reduceChatState, type CanonicalChatState } from './chat-state-reducer';
import {
  ChatStorageTransactions,
  withTranscriptDescriptor,
  type ChatStorageIndexes,
  type ChatTranscriptWrite,
} from '../lib/chat-storage-transactions';
import type {
  ChatStorageV2,
  ChatIndexEntry,
  ChatRecoveryIndex,
} from '../lib/chat-storage-v2';
import type { TranscriptDescriptor } from '../lib/chat-transcript-log';
import {
  VISUAL_STAGING_RETENTION_MS,
  type ExternalizeVisualContext,
  type LinkedToolCall,
  type ProviderVisualAdmission,
  type PromotedVisual,
  type VisualOwnerFence,
} from '../lib/chat-visual-contracts';
import {
  beginMainTranscriptPerformanceStage,
  mainTranscriptPerformanceEnabled,
} from '../lib/transcript-performance';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type {
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import { isErrnoException } from '../lib/type-guards';
import { ChatVisualReadError } from '../lib/chat-visual-read-errors';

/** Messages `ChatTranscriptArtifacts` uses when visual bytes fail validation. */
const VISUAL_INTEGRITY_FAILURES: ReadonlySet<string> = new Set([
  'Visual artifact failed integrity validation',
  'Visual artifact changed during validation',
  'Unexpected end of visual artifact',
]);

export interface ChatStorageImportOptions {
  merge?: boolean;
  mutationId?: string;
  sourceChatIds?: Readonly<Record<string, string>>;
  settleFork?: boolean;
  /** Destination chat id to inclusive canonical source-message anchor. */
  throughMessageIds?: Readonly<Record<string, string>>;
  transformMessage?: (
    message: PersistedChatMessage,
    chatId: string,
  ) => PersistedChatMessage;
  /** Refreshes asynchronous authorization inputs before the final sync check. */
  preparePublish?: () => Promise<void>;
  /** Final authorization check after payload preparation, before publication. */
  beforePublish?: () => void;
}

export interface ChatReadSelection {
  chatIds?: readonly string[];
  fullTranscript?: boolean;
  pageOnly?: boolean;
  /** Retained reducer anchor, or its parent when the anchor is not yet stored. */
  messageAnchor?: {
    messageId: string;
    fallbackMessageId: string;
    previousRunMessageId?: string;
  };
}
export interface V2MutationOptions
  extends ChatMutationOptions, ChatReadSelection {}
export interface V2Commit {
  baseRevision: number;
  revision: number;
  state: CanonicalChatState;
  record: ChatJournalRecord;
  applied: boolean;
  promotedVisuals?: PromotedVisual[];
}
/** A commit admitted for group commit ({@link ChatStateV2Backend.admit}). */
export interface V2Admission {
  commit: V2Commit;
  /**
   * Present while the commit's delta-journal record is not durable: it
   * resolves when the record's batch is synced and rejects when that batch
   * failed. Absent when the commit is durable already.
   */
  durable?: Promise<void>;
}
type TransactionBuilder = (
  current: CanonicalChatState,
  revision: number,
  context: ChatStateTransactionContext,
) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>;
export interface TranscriptConsumeOptions {
  /**
   * Follow each card whose children are in the chat's delegate log with
   * those children as rows, and drop the card's `transcriptStore`: the form
   * cards had before delegate logs. For copies that leave this scope's chat
   * storage (publication, a resumed archive), which carry no delegate logs.
   */
  readonly inlineDelegationChildren?: boolean;
}

interface Delta {
  replacement?: readonly PersistedChatMessage[];
  upserts: Map<string, PersistedChatMessage>;
  insertions: Map<string, string>;
  removed: Set<string>;
  artifactSource?: string;
}

type VisualOwnerIndex = NonNullable<ChatRecoveryIndex['visualOwnersByChatId']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVisualOwnerFence(value: unknown): value is VisualOwnerFence {
  return (
    isRecord(value) &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.toolUseId === 'string' &&
    value.toolUseId.length > 0 &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt) &&
    (!Object.prototype.hasOwnProperty.call(value, 'codexCallId') ||
      typeof value.codexCallId === 'string')
  );
}

function readVisualOwnerIndex(value: unknown): VisualOwnerIndex | undefined {
  if (!isRecord(value)) return undefined;
  const index: VisualOwnerIndex = {};
  for (const chatId of Object.keys(value)) {
    const rawOwners = value[chatId];
    if (!isRecord(rawOwners)) return undefined;
    const owners: Record<string, VisualOwnerFence> = {};
    for (const visualId of Object.keys(rawOwners)) {
      const owner = rawOwners[visualId];
      if (!isVisualOwnerFence(owner)) return undefined;
      owners[visualId] = owner;
    }
    index[chatId] = owners;
  }
  return index;
}

function sameVisualOwner(
  left: VisualOwnerFence,
  right: Pick<VisualOwnerFence, 'messageId' | 'toolUseId'>,
): boolean {
  return (
    left.messageId === right.messageId && left.toolUseId === right.toolUseId
  );
}

function sameVisualOwnerMessage(
  owner: VisualOwnerFence,
  message: PersistedChatMessage,
  toolUseId: string,
): boolean {
  return owner.messageId === message.id && owner.toolUseId === toolUseId;
}

/** Transaction-local copy-on-write state for one recovery index ledger. */
class VisualOwnerLedgerView {
  private readonly original: VisualOwnerIndex | undefined;
  private readonly edited = new Map<string, Map<string, VisualOwnerFence>>();
  private readonly reservations = new Map<
    string,
    Map<string, VisualOwnerFence>
  >();
  private readonly promotions = new Map<
    string,
    Map<string, VisualOwnerFence>
  >();

  public readonly unknown: boolean;

  public constructor(recovery: ChatRecoveryIndex) {
    const hasLedger = Object.prototype.hasOwnProperty.call(
      recovery,
      'visualOwnersByChatId',
    );
    const raw: unknown = Reflect.get(recovery, 'visualOwnersByChatId');
    const parsed = readVisualOwnerIndex(raw);
    this.unknown = hasLedger && !parsed;
    this.original = parsed;
  }

  public ownerOf(
    chatId: string,
    visualId: string,
  ): VisualOwnerFence | undefined {
    return (
      this.reservations.get(chatId)?.get(visualId) ??
      this.ownerMap(chatId).get(visualId)
    );
  }

  public reserve(
    chatId: string,
    visualId: string,
    owner: VisualOwnerFence,
  ): boolean {
    if (this.unknown) return false;
    const existing = this.ownerOf(chatId, visualId);
    if (existing && !sameVisualOwner(existing, owner)) return false;
    if (!existing)
      this.mutableMap(this.reservations, chatId).set(visualId, owner);
    this.mutableMap(this.promotions, chatId).set(visualId, owner);
    return true;
  }

  public promotionOwner(
    chatId: string,
    visualId: string,
  ): VisualOwnerFence | undefined {
    return this.promotions.get(chatId)?.get(visualId);
  }

  public commitClaim(chatId: string, visualId: string): void {
    const owner = this.reservations.get(chatId)?.get(visualId);
    if (!owner) return;
    this.mutableMap(this.edited, chatId).set(visualId, owner);
    this.reservations.get(chatId)?.delete(visualId);
  }

  public prune(stagedIds: ReadonlySet<string>, now: number): void {
    if (this.unknown) return;
    const cutoff = now - VISUAL_STAGING_RETENTION_MS;
    this.chatIds().forEach((chatId: string) =>
      this.ownerEntries(chatId).forEach((entry: [string, VisualOwnerFence]) => {
        const visualId: string = entry[0];
        const fence: VisualOwnerFence = entry[1];
        if (fence.claimedAt < cutoff && !stagedIds.has(visualId))
          this.mutableMap(this.edited, chatId).delete(visualId);
      }),
    );
  }

  public removeChat(chatId: string): void {
    if (this.unknown) return;
    if (this.ownerEntries(chatId).length > 0)
      this.edited.set(chatId, new Map());
    this.reservations.delete(chatId);
    this.promotions.delete(chatId);
  }

  public toIndex(): VisualOwnerIndex | undefined {
    if (this.unknown) return undefined;
    if (
      this.edited.size === 0 &&
      this.original &&
      Object.values(this.original).every(
        (owners) => Object.keys(owners).length > 0,
      )
    )
      return this.original;
    const next: VisualOwnerIndex = {};
    for (const chatId of Object.keys(this.original ?? {})) {
      const owners = this.original?.[chatId];
      if (owners && Object.keys(owners).length > 0) next[chatId] = owners;
    }
    this.edited.forEach(
      (owners: Map<string, VisualOwnerFence>, chatId: string) => {
        if (owners.size === 0) delete next[chatId];
        else {
          const nextOwners: Record<string, VisualOwnerFence> = {};
          owners.forEach((owner: VisualOwnerFence, visualId: string) => {
            nextOwners[visualId] = owner;
          });
          next[chatId] = nextOwners;
        }
      },
    );
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private ownerMap(chatId: string): ReadonlyMap<string, VisualOwnerFence> {
    const edited = this.edited.get(chatId);
    if (edited) return edited;
    const owners = new Map<string, VisualOwnerFence>();
    const source = this.original?.[chatId];
    if (source)
      for (const visualId of Object.keys(source)) {
        const owner = source[visualId];
        if (owner) owners.set(visualId, owner);
      }
    return owners;
  }

  private ownerEntries(chatId: string): Array<[string, VisualOwnerFence]> {
    const edited = this.edited.get(chatId);
    if (edited) return Array.from(edited.entries());
    const owners = this.original?.[chatId];
    const entries: Array<[string, VisualOwnerFence]> = [];
    if (owners)
      for (const visualId of Object.keys(owners)) {
        const owner = owners[visualId];
        if (owner) entries.push([visualId, owner]);
      }
    return entries;
  }

  private mutableMap(
    target: Map<string, Map<string, VisualOwnerFence>>,
    chatId: string,
  ): Map<string, VisualOwnerFence> {
    let owners = target.get(chatId);
    if (!owners) {
      owners = new Map(this.ownerEntries(chatId));
      target.set(chatId, owners);
    }
    return owners;
  }

  private chatIds(): Set<string> {
    const chatIds = new Set<string>();
    for (const chatId of Object.keys(this.original ?? {})) chatIds.add(chatId);
    const editedChatIds: string[] = Array.from(this.edited.keys());
    for (const chatId of editedChatIds) chatIds.add(chatId);
    return chatIds;
  }
}

function installVisualOwnerLedger(
  recovery: ChatRecoveryIndex,
  ledger: VisualOwnerLedgerView,
): void {
  if (ledger.unknown) return;
  const owners = ledger.toIndex();
  if (owners) recovery.visualOwnersByChatId = owners;
  else delete recovery.visualOwnersByChatId;
}

function codexCallId(toolUseId: string): string | undefined {
  const prefix = 'codex-';
  return toolUseId.startsWith(prefix) && toolUseId.length > prefix.length
    ? toolUseId.slice(prefix.length)
    : undefined;
}

function linkedToolCallFromBlock(
  block: Extract<PersistedChatMessage['blocks'][number], { type: 'tool_use' }>,
): LinkedToolCall {
  const callId = codexCallId(block.toolUseId);
  return {
    toolUseId: block.toolUseId,
    ...(block.toolName.length > 0 ? { toolName: block.toolName } : {}),
    ...(callId ? { codexCallId: callId } : {}),
  };
}

function sameLinkedToolCall(
  left: LinkedToolCall,
  right: LinkedToolCall,
): boolean {
  return (
    left.toolName === right.toolName && left.codexCallId === right.codexCallId
  );
}

function addToolCalls(
  lookup: Map<string, LinkedToolCall | null>,
  messages: readonly PersistedChatMessage[],
): void {
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const call = linkedToolCallFromBlock(block);
      if (!lookup.has(call.toolUseId)) lookup.set(call.toolUseId, call);
      else {
        const previous = lookup.get(call.toolUseId);
        if (previous && !sameLinkedToolCall(previous, call))
          lookup.set(call.toolUseId, null);
      }
    }
}

function messagesOnTab(
  tab: PersistedChatTab | undefined,
): PersistedChatMessage[] {
  return tab && Object.prototype.propertyIsEnumerable.call(tab, 'messages')
    ? tab.messages
    : [];
}

function messagesFromMutation(
  mutation: ChatCoreMutation,
  chatId: string,
): readonly PersistedChatMessage[] {
  if (mutation.type === 'message.upserted')
    return mutation.chatId === chatId ? [mutation.message] : [];
  if (mutation.type === 'messages.replaced')
    return mutation.chatId === chatId ? mutation.messages : [];
  if (mutation.type === 'tab.created')
    return mutation.tab.id === chatId ? messagesOnTab(mutation.tab) : [];
  if (mutation.type === 'archive.upserted')
    return mutation.entry.tab.id === chatId
      ? messagesOnTab(mutation.entry.tab)
      : [];
  return [];
}

function erroredToolUseIds(
  messages: readonly PersistedChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === 'tool_result' && block.isError)
        ids.add(block.toolUseId);
  return ids;
}

function lookupToolCall(
  lookup: ReadonlyMap<string, LinkedToolCall | null>,
  toolUseId: string,
): LinkedToolCall | undefined {
  return lookup.get(toolUseId) ?? undefined;
}

function externalizeVisualContext(
  chatId: string,
  admission: ProviderVisualAdmission,
  ledger: VisualOwnerLedgerView,
  incomingMessages: readonly PersistedChatMessage[],
  currentMessages: readonly PersistedChatMessage[],
): ExternalizeVisualContext {
  const incoming = new Map<string, LinkedToolCall | null>();
  const current = new Map<string, LinkedToolCall | null>();
  addToolCalls(incoming, incomingMessages);
  addToolCalls(current, currentMessages);
  const blockedToolUseIds = erroredToolUseIds(incomingMessages);
  return {
    kind: 'provider',
    chatId,
    hasStagedEntries: () => !ledger.unknown && admission.staging.hasEntries(),
    linkedToolCall: (toolUseId): LinkedToolCall | undefined => {
      if (blockedToolUseIds.has(toolUseId)) return undefined;
      if (incoming.has(toolUseId)) return lookupToolCall(incoming, toolUseId);
      return lookupToolCall(current, toolUseId);
    },
    resolveToolKey: admission.resolveToolKey,
    ownerOf: (visualId) => ledger.ownerOf(chatId, visualId),
    reserve: (visualId, owner) => ledger.reserve(chatId, visualId, owner),
    readStaged: (visualId) => admission.staging.readCandidate(chatId, visualId),
    now: () => admission.now(),
  };
}

function preserveVisualReferences(
  previous: PersistedChatMessage | undefined,
  incoming: PersistedChatMessage,
): PersistedChatMessage {
  if (!previous) return incoming;
  const references = new Map<string, PersistedVisualReference>();
  for (const block of previous.blocks)
    if (block.type === 'tool_result' && block.visualRef)
      references.set(block.toolUseId, block.visualRef);
  let changed = false;
  const blocks = incoming.blocks.map((block) => {
    if (block.type !== 'tool_result' || block.visualRef) return block;
    const visualRef = references.get(block.toolUseId);
    if (!visualRef) return block;
    changed = true;
    return { ...block, visualRef };
  });
  return changed ? { ...incoming, blocks } : incoming;
}

function messagesFromMutations(
  mutations: readonly ChatCoreMutation[],
  chatId: string,
): PersistedChatMessage[] {
  const messages: PersistedChatMessage[] = [];
  for (const mutation of mutations)
    messages.push(...messagesFromMutation(mutation, chatId));
  return messages;
}

function messageIdsFromMutation(mutation: ChatCoreMutation): string[] {
  if (mutation.type === 'message.upserted') return [mutation.message.id];
  if (mutation.type === 'messages.replaced')
    return mutation.messages.map((message) => message.id);
  if (mutation.type === 'tab.created')
    return messagesOnTab(mutation.tab).map((message) => message.id);
  if (mutation.type === 'archive.upserted')
    return messagesOnTab(mutation.entry.tab).map((message) => message.id);
  return [];
}

function previousMessagesForMutations(
  mutations: readonly ChatCoreMutation[],
  tabs: ReadonlyMap<string, PersistedChatTab>,
): Map<string, Map<string, PersistedChatMessage>> {
  const requested = new Map<string, Set<string>>();
  for (const mutation of mutations) {
    const chatId =
      mutation.type === 'message.upserted' ||
      mutation.type === 'message.removed' ||
      mutation.type === 'messages.replaced'
        ? mutation.chatId
        : mutation.type === 'tab.created'
          ? mutation.tab.id
          : mutation.type === 'archive.upserted'
            ? mutation.entry.tab.id
            : undefined;
    if (!chatId) continue;
    const ids = messageIdsFromMutation(mutation);
    if (ids.length === 0) continue;
    const wanted = requested.get(chatId) ?? new Set<string>();
    for (const id of ids) wanted.add(id);
    requested.set(chatId, wanted);
  }
  const previous = new Map<string, Map<string, PersistedChatMessage>>();
  requested.forEach((ids: Set<string>, chatId: string) => {
    const messages = new Map<string, PersistedChatMessage>();
    messagesOnTab(tabs.get(chatId)).forEach((message) => {
      if (ids.has(message.id)) messages.set(message.id, message);
    });
    previous.set(chatId, messages);
  });
  return previous;
}

/** Rows a mutation writes into an existing chat's transcript. */
function rowsCarriedBy(
  mutation: ChatCoreMutation,
): { chatId: string; messages: readonly PersistedChatMessage[] } | undefined {
  if (mutation.type === 'message.upserted')
    return { chatId: mutation.chatId, messages: [mutation.message] };
  if (mutation.type === 'archive.upserted')
    return {
      chatId: mutation.entry.tab.id,
      messages: messagesOnTab(mutation.entry.tab),
    };
  if (mutation.type === 'tab.created')
    return { chatId: mutation.tab.id, messages: messagesOnTab(mutation.tab) };
  return undefined;
}

/** A result row whose existing visual reference must be carried forward. */
function needsPreviousResult(message: PersistedChatMessage): boolean {
  return message.blocks.some(
    (block) => block.type === 'tool_result' && !block.visualRef,
  );
}

function currentToolMessagesForMutations(
  mutations: readonly ChatCoreMutation[],
  tabs: ReadonlyMap<string, PersistedChatTab>,
): Map<string, readonly PersistedChatMessage[]> {
  const chatIds = new Set<string>();
  for (const mutation of mutations)
    if (mutation.type === 'message.upserted') chatIds.add(mutation.chatId);
  const messages = new Map<string, readonly PersistedChatMessage[]>();
  chatIds.forEach((chatId: string) => {
    messages.set(chatId, messagesOnTab(tabs.get(chatId)));
  });
  return messages;
}

function externalizeVisualContexts(
  mutations: readonly ChatCoreMutation[],
  currentMessagesByChatId: ReadonlyMap<string, readonly PersistedChatMessage[]>,
  admission: ProviderVisualAdmission | undefined,
  ledger: VisualOwnerLedgerView,
): Map<string, ExternalizeVisualContext> {
  const contexts = new Map<string, ExternalizeVisualContext>();
  if (!admission) return contexts;
  const chatIds = new Set<string>();
  for (const mutation of mutations)
    if (mutation.type === 'message.upserted') chatIds.add(mutation.chatId);
  chatIds.forEach((chatId: string) => {
    contexts.set(
      chatId,
      externalizeVisualContext(
        chatId,
        admission,
        ledger,
        messagesFromMutations(mutations, chatId),
        currentMessagesByChatId.get(chatId) ?? [],
      ),
    );
  });
  return contexts;
}

function promotedVisualsInWrites(
  projectedMessages: ReadonlyMap<ChatCoreMutation, PersistedChatMessage>,
  deltas: ReadonlyMap<string, Delta>,
  writes: readonly ChatTranscriptWrite[],
  ledger: VisualOwnerLedgerView,
): PromotedVisual[] {
  const writableChats = new Set(
    writes
      .filter((write) => write.kind !== 'delete')
      .map((write) => write.chatId),
  );
  const emittedByChat = new Map<string, Set<string>>();
  const promoted: PromotedVisual[] = [];
  projectedMessages.forEach(
    (message: PersistedChatMessage, mutation: ChatCoreMutation) => {
      if (mutation.type !== 'message.upserted') return;
      const delta = deltas.get(mutation.chatId);
      if (
        !writableChats.has(mutation.chatId) ||
        delta?.upserts.get(message.id) !== message
      )
        return;
      for (const block of message.blocks) {
        if (block.type !== 'tool_result' || !block.visualRef) continue;
        const owner = ledger.promotionOwner(
          mutation.chatId,
          block.visualRef.visualId,
        );
        if (!owner || !sameVisualOwnerMessage(owner, message, block.toolUseId))
          continue;
        const emitted = emittedByChat.get(mutation.chatId) ?? new Set<string>();
        if (emitted.has(block.visualRef.visualId)) continue;
        emitted.add(block.visualRef.visualId);
        emittedByChat.set(mutation.chatId, emitted);
        ledger.commitClaim(mutation.chatId, block.visualRef.visualId);
        promoted.push({
          chatId: mutation.chatId,
          visualId: block.visualRef.visualId,
          reference: block.visualRef,
        });
      }
    },
  );
  return promoted;
}

/** A checkpoint replaced the journal file without changing committed state. */
export interface DeltaJournalCheckpointRotation {
  previousMtimeNs: string;
  mtimeNs: string;
}

async function journalMtimeNs(path: string): Promise<string | undefined> {
  try {
    return (await stat(path, { bigint: true })).mtimeNs.toString();
  } catch {
    return undefined;
  }
}

export interface ChatStateV2BackendOptions {
  /**
   * Admit version 3 (delta-journal) scopes and write them through the
   * journal. Only the chat state repository sets it. A backend constructed
   * without it fails closed on a version 3 scope, as every writer outside
   * the repository must: its version 2 transactions refuse the format.
   */
  deltaJournal?: {
    onDiagnostic?: (diagnostic: DeltaJournalDiagnostic) => void;
    /** Lets journal-mtime fingerprints follow a checkpoint's rotation. */
    onCheckpointed?: (rotation: DeltaJournalCheckpointRotation) => void;
    checkpointJournalBytes?: number;
    /** Overrides {@link LARGE_JOURNAL_RECORD_BYTES}; tests use it. */
    largeRecordBytes?: number;
    promotionRetry?: PromotionRetryOptions;
  };
  /** Content-free report for an unrecognized or malformed visual owner ledger. */
  onVisualOwnerLedgerInvalid?: (detail: { reason: string }) => void;
}

const ACTIVE = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);
const TOOL_OUTPUT_OWNERSHIP_CHAT_CACHE_LIMIT = 64;
const TOOL_OUTPUT_OWNERSHIP_KEY_CACHE_LIMIT = 64;
const EMPTY_DESCRIPTOR: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 0,
  committedByteLength: 0,
  transcriptRevision: 0,
  hasActiveSidecar: false,
};

/** Unloaded history is an explicit programming error, never an empty array. */
export class ChatTranscriptNotLoadedError extends Error {
  public constructor(public readonly chatId: string) {
    super(`Transcript ${chatId} was not selected for this operation`);
  }
}

function metadataTab(
  entry: ChatIndexEntry,
  guarded: boolean,
): PersistedChatTab {
  const { transcript, ...metadata } = entry;
  const tab: PersistedChatTab = normalizeLegacyPersistedChatTab({
    ...metadata,
    messages: [],
  });
  Object.defineProperty(
    tab,
    'messages',
    guarded
      ? {
          enumerable: false,
          configurable: true,
          get: (): never => {
            throw new ChatTranscriptNotLoadedError(entry.id);
          },
        }
      : { enumerable: true, configurable: true, writable: true, value: [] },
  );
  // Internal readers can inspect counts without loading the body. Transport
  // snapshots attach this explicitly rather than serializing a guarded tab.
  Object.defineProperty(tab, 'transcript', {
    enumerable: true,
    value: transcript,
  });
  return tab;
}

function metadataState(
  indexes: ChatStorageIndexes,
  guarded: boolean,
): CanonicalChatState {
  const { tabs, runtimeByChatId, ...live } = indexes.live;
  return {
    tabsFile: {
      ...live,
      version: 1,
      tabs: tabs.map((tab) => metadataTab(tab, guarded)),
    },
    archivesFile: {
      version: 1,
      revision: indexes.archive.revision,
      archived: indexes.archive.archived.map((entry) => ({
        ...entry,
        tab: metadataTab(entry.tab, guarded),
      })),
    },
    runtimeByChatId,
  };
}

function allEntries(indexes: ChatStorageIndexes): ChatIndexEntry[] {
  return [
    ...indexes.live.tabs,
    ...indexes.archive.archived.map((entry) => entry.tab),
  ];
}
function boundedIds(
  values: readonly string[],
  additions: readonly string[],
  limit: number,
): string[] {
  const set = new Set(values);
  for (const id of additions) {
    set.delete(id);
    set.add(id);
  }
  return Array.from(set).slice(-limit);
}

/** Canonical metadata ownership plus explicit per-chat transcript views. */
export class ChatStateV2Backend {
  public readonly storage: ChatStorageTransactions;
  private readonly artifactMaintenance: ChatArtifactMaintenance;
  private indexes?: ChatStorageIndexes;
  private tail: Promise<unknown> = Promise.resolve();
  /** The open delta journal while the scope is version 3. */
  private journal?: ChatDeltaJournalWriter;
  /**
   * A large import or replacement demoted the scope for one version 2
   * transaction; it is promoted again at its next idle point.
   */
  private repromote = false;
  private readonly promotionRetry: PromotionRetry;
  // Cache only successful ownership proofs. Transcript revision changes force
  // revalidation, while caps keep occasional artifact reads from accumulating.
  private readonly verifiedArtifactOwnership = new Map<
    string,
    { transcriptRevision: number; keys: Set<string> }
  >();
  public constructor(
    private readonly store: ChatStorageV2,
    private readonly options: ChatStateV2BackendOptions = {},
  ) {
    this.storage = new ChatStorageTransactions(store);
    this.promotionRetry = new PromotionRetry(
      options.deltaJournal?.promotionRetry,
    );
    this.artifactMaintenance = new ChatArtifactMaintenance(
      this.storage,
      store.directory,
    );
  }

  /** Whether the scope is version 3 and committed through its journal. */
  public isDeltaJournal(): boolean {
    return this.journal !== undefined;
  }

  /**
   * Whether promotion is wanted at this idle point: after a temporary
   * demotion, or a failed promotion's bounded retry is due.
   */
  public wantsRepromotion(): boolean {
    return this.repromote || this.promotionRetry.due();
  }

  /** Records after the last checkpoint, or 0 for a version 2 scope. */
  public pendingJournalRecords(): number {
    try {
      return this.journal?.isOpen() ? this.journal.pendingRecordCount : 0;
    } catch {
      return 0;
    }
  }

  /** The journal reached its size threshold (P1 §A). */
  public journalCheckpointDue(): boolean {
    try {
      return this.journal?.isOpen() === true && this.journal.needsCheckpoint();
    } catch {
      return false;
    }
  }

  /**
   * Whether the idle trigger should checkpoint: not while an in-progress
   * turn's active rows live only in the journal (phase 10). Its turn-end
   * record checkpoints them, through the append, without a sidecar rewrite.
   */
  public journalIdleCheckpointWanted(): boolean {
    try {
      return this.journal?.isOpen() === true && !this.journal.holdsActiveTurn();
    } catch {
      return false;
    }
  }

  private async openJournal(): Promise<ChatDeltaJournalWriter> {
    // A previous writer (poisoned, or retired by a demotion) must not stay
    // wired into the log the new writer recovers through.
    this.closeJournal();
    const settings = this.options.deltaJournal ?? {};
    const journal = await ChatDeltaJournalWriter.open(this.store, {
      log: this.storage.transcripts,
      ...(settings.onDiagnostic ? { onDiagnostic: settings.onDiagnostic } : {}),
      ...(settings.checkpointJournalBytes !== undefined
        ? { checkpointJournalBytes: settings.checkpointJournalBytes }
        : {}),
    });
    this.journal = journal;
    this.storage.transcripts.setActiveProjection((chatId) =>
      this.journal === journal && journal.isOpen()
        ? journal.activeProjection(chatId)
        : undefined,
    );
    this.storage.setDeltaJournalClear(() => {
      try {
        return (
          this.journal === journal &&
          journal.isOpen() &&
          journal.pendingRecordCount === 0
        );
      } catch {
        return false;
      }
    });
    return journal;
  }

  private closeJournal(): void {
    this.journal = undefined;
    this.storage.transcripts.setActiveProjection(undefined);
    this.storage.setDeltaJournalClear(undefined);
  }

  /**
   * Detach the writer and forget the cached indexes, so the next operation
   * reloads from the manifest on disk after a compatibility demotion.
   */
  public releaseJournal(): void {
    this.closeJournal();
    this.indexes = undefined;
  }

  /** A failed removal leaves a journal version 2 never reads; retried on load. */
  private async removeStrayJournal(): Promise<void> {
    try {
      await removeStrayDeltaJournal(this.store);
    } catch {
      // The next load tries again.
    }
  }

  /**
   * The committed indexes: version 2 files, or for a delta-journal scope the
   * journal's metadata with each journaled chat's descriptor projected from
   * its files plus its journaled active rows.
   */
  private async loadIndexes(): Promise<ChatStorageIndexes> {
    if (this.options.deltaJournal && (await this.store.format()) === 'v3') {
      const journal = this.journal?.isOpen()
        ? this.journal
        : await this.openJournal();
      // A crash between a record changing committed rows and its checkpoint:
      // finish the checkpoint before anything reads those rows.
      if (journal.hasCommittedRowChanges()) await journal.checkpoint();
      const indexes = await this.projectedIndexes(journal);
      this.reportInvalidVisualOwnerLedger(indexes);
      return indexes;
    }
    if (this.journal) this.closeJournal();
    if (this.options.deltaJournal) await this.removeStrayJournal();
    const indexes = await this.storage.load();
    this.reportInvalidVisualOwnerLedger(indexes);
    return indexes;
  }

  private reportInvalidVisualOwnerLedger(indexes: ChatStorageIndexes): void {
    const hasLedger = Object.prototype.hasOwnProperty.call(
      indexes.recovery,
      'visualOwnersByChatId',
    );
    if (
      hasLedger &&
      !readVisualOwnerIndex(
        Reflect.get(indexes.recovery, 'visualOwnersByChatId'),
      )
    ) {
      try {
        this.options.onVisualOwnerLedgerInvalid?.({
          reason: 'malformed_visual_owner_ledger',
        });
      } catch {
        // A diagnostic sink must not make a valid storage load fail.
      }
    }
  }

  private async projectedIndexes(
    journal: ChatDeltaJournalWriter,
  ): Promise<ChatStorageIndexes> {
    let indexes = journal.indexes();
    for (const chatId of journal.journaledChatIds())
      indexes = withTranscriptDescriptor(
        indexes,
        chatId,
        await this.storage.transcripts.descriptor(chatId),
      );
    return indexes;
  }

  private async checkpointJournal(
    journal: ChatDeltaJournalWriter,
  ): Promise<ChatStorageIndexes> {
    const onCheckpointed = this.options.deltaJournal?.onCheckpointed;
    if (!onCheckpointed) {
      await journal.checkpoint();
      return journal.indexes();
    }
    // Admitted records reach the journal first, so the rotation below covers
    // exactly the committed state the earlier modification time stamped.
    await journal.pendingDurability()?.catch(() => undefined);
    const path = join(this.store.directory, DELTA_JOURNAL_FILE_NAME);
    const previousMtimeNs = await journalMtimeNs(path);
    await journal.checkpoint();
    const mtimeNs = await journalMtimeNs(path);
    if (
      previousMtimeNs !== undefined &&
      mtimeNs !== undefined &&
      mtimeNs !== previousMtimeNs
    )
      onCheckpointed({ previousMtimeNs, mtimeNs });
    return journal.indexes();
  }

  /**
   * Checkpoint a delta-journal scope. The repository holds the scope lease.
   * False when nothing was pending, or, for the repository's idle and size
   * timers (`trigger: 'timer'`), while an in-progress turn is journaled and
   * the size trigger is not due.
   */
  public async checkpointPendingJournal(trigger?: 'timer'): Promise<boolean> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      const journal = this.journal;
      if (!journal || journal.pendingRecordCount === 0) return false;
      if (
        trigger === 'timer' &&
        journal.holdsActiveTurn() &&
        !journal.needsCheckpoint()
      )
        return false;
      this.indexes = await this.checkpointJournal(journal);
      return true;
    });
  }

  /**
   * Promote a settled version 2 scope to the delta journal: recover any
   * pending version 2 transaction, write a fresh journal segment and publish
   * the version 3 manifest. The repository holds the scope lease and decides
   * which scopes promote. False when the scope is not version 2.
   */
  public async promoteToDeltaJournal(): Promise<boolean> {
    return this.serial(async () => {
      this.repromote = false;
      if (!this.options.deltaJournal) return false;
      if ((await this.store.format()) !== 'v2') return false;
      try {
        const current = await this.storage.load();
        this.reportInvalidVisualOwnerLedger(current);
        await promoteToDeltaJournal(this.store);
      } catch (error) {
        this.promotionRetry.failed();
        throw error;
      }
      this.promotionRetry.reset();
      this.indexes = await this.loadIndexes();
      return true;
    });
  }

  /**
   * Demote a delta-journal scope to version 2: a full checkpoint, the version
   * 2 manifest restored, the journal removed. A failure leaves it version 3
   * and still writable through the journal. False when it was version 2.
   */
  public async demoteFromDeltaJournal(): Promise<boolean> {
    return this.serial(async () => this.demoteLocked());
  }

  private async demoteLocked(): Promise<boolean> {
    this.repromote = false;
    this.promotionRetry.reset();
    if ((await this.store.format()) !== 'v3') {
      if (this.journal) this.closeJournal();
      await this.removeStrayJournal();
      return false;
    }
    const settings = this.options.deltaJournal ?? {};
    const writer = this.journal?.isOpen() ? this.journal : undefined;
    // A writer that cannot be used must not answer the log's reads while the
    // demotion opens its own.
    if (!writer) this.closeJournal();
    try {
      await demoteFromDeltaJournal(this.store, {
        ...(writer ? { writer } : {}),
        log: this.storage.transcripts,
        ...(settings.onDiagnostic
          ? { onDiagnostic: settings.onDiagnostic }
          : {}),
      });
    } catch (error) {
      // The manifest on disk decides: once version 2 is published, no write
      // may reach the journal again, whatever failed after it.
      this.releaseJournal();
      if ((await this.store.format().catch(() => 'v3')) !== 'v2') throw error;
    }
    this.closeJournal();
    this.indexes = await this.storage.load();
    this.reportInvalidVisualOwnerLedger(this.indexes);
    return true;
  }

  /**
   * A large import or replacement uses one version 2 transaction: demote
   * now, while this transaction holds the scope's write order, and promote
   * at the next idle point.
   */
  private async demoteForLargeMutation(): Promise<void> {
    if (!this.journal) return;
    await this.demoteLocked();
    this.repromote = true;
  }

  /** The repository must hold the scope lease around this bounded chunk. */
  public async maintainArtifacts(
    chatId: string,
    maxBytes = 64 * 1024,
  ): Promise<ArtifactMaintenanceProgress> {
    return this.serialDerived(async () =>
      this.artifactMaintenance.maintain(chatId, maxBytes, () =>
        Promise.resolve(this.indexedChat(chatId).transcript),
      ),
    );
  }

  public async pendingArtifactMaintenanceChats(
    hints?: readonly string[],
  ): Promise<string[]> {
    const indexes = this.indexes ?? (await this.load());
    // Journal records may reference any artifact; maintenance waits for the
    // checkpoint that writes them, after which the repository asks again.
    if (this.pendingJournalRecords() > 0) return [];
    // Provider commits mostly hint an actively streaming chat. Check its
    // cached runtime before traversing the whole live/archive catalog.
    const inactiveHints = hints
      ? Array.from(new Set(hints)).filter(
          (id) =>
            !ACTIVE.has(indexes.live.runtimeByChatId[id]?.status ?? 'idle'),
        )
      : undefined;
    if (inactiveHints?.length === 0) return [];
    const existing = new Set(allEntries(indexes).map((entry) => entry.id));
    const chats = inactiveHints
      ? inactiveHints.filter((id) => existing.has(id))
      : Array.from(existing);
    const pending: string[] = [];
    for (const chatId of chats) {
      if (ACTIVE.has(indexes.live.runtimeByChatId[chatId]?.status ?? 'idle'))
        continue;
      if (await this.artifactMaintenance.hasWork(chatId)) pending.push(chatId);
    }
    return pending;
  }

  public artifactMaintenanceEligible(chatId: string): boolean {
    if (!this.indexes) return false;
    if (!allEntries(this.indexes).some((entry) => entry.id === chatId))
      return false;
    return !ACTIVE.has(
      this.indexes.live.runtimeByChatId[chatId]?.status ?? 'idle',
    );
  }

  /** An absent index means recovery may still be pending, not chat deletion. */
  public artifactMaintenanceChatRetired(chatId: string): boolean {
    return (
      this.indexes !== undefined &&
      !allEntries(this.indexes).some((entry) => entry.id === chatId)
    );
  }

  public async abandonArtifactMaintenance(chatId: string): Promise<void> {
    await this.serialDerived(async () =>
      this.artifactMaintenance.abandon(chatId),
    );
  }

  public async disposeArtifactMaintenance(): Promise<void> {
    await this.artifactMaintenance.dispose();
  }

  public onArtifactMaintenanceCapacityAvailable(
    listener: () => void,
  ): () => void {
    return this.artifactMaintenance.onCapacityAvailable(listener);
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail
      .catch(() => undefined)
      .then(() => {
        this.dropUndurableIndexes();
        return work();
      });
    this.tail = next;
    try {
      return await next;
    } catch (error) {
      this.indexes = undefined;
      throw error;
    }
  }
  /** Derived cleanup shares ordering without invalidating canonical indexes. */
  private async serialDerived<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail
      .catch(() => undefined)
      .then(() => {
        this.dropUndurableIndexes();
        return work();
      });
    this.tail = next;
    return next;
  }

  /**
   * A group-committed batch that failed leaves the cached indexes ahead of
   * the journal, with no failing operation to drop them. Its writer is then
   * no longer open: forget the indexes, so the next operation reloads from
   * the files and the records that are durable.
   */
  private dropUndurableIndexes(): void {
    if (this.journal && !this.journal.isOpen()) this.indexes = undefined;
  }

  /**
   * Settles when every commit admitted for group commit ({@link admit}) is
   * durable; rejects when its batch failed. Undefined when nothing is
   * pending. Until then this backend's state is ahead of the journal: the
   * repository lets only the next admission run, and every other operation
   * under the scope lease waits.
   */
  public pendingJournalDurability(): Promise<void> | undefined {
    return this.journal?.pendingDurability();
  }
  public async load(): Promise<ChatStorageIndexes> {
    return this.serial(async () => {
      const indexes = (this.indexes ??= await this.loadIndexes());
      recordChatStorageIndexClone();
      return structuredClone(indexes);
    });
  }
  public async state(
    selection: ChatReadSelection = {},
  ): Promise<CanonicalChatState> {
    return this.serial(async () =>
      this.view((this.indexes ??= await this.loadIndexes()), selection),
    );
  }

  public async revision(): Promise<number> {
    return this.serial(
      async () => (this.indexes ??= await this.loadIndexes()).live.revision,
    );
  }

  /**
   * Make the files the complete state: reload a version 2 scope, checkpoint
   * a delta-journal one. Capture, copy, export, eviction and drain call it
   * under the scope lease before they read the files.
   */
  public async flush(): Promise<void> {
    await this.serial(async () => {
      this.indexes = await this.loadIndexes();
      if (this.journal && this.journal.pendingRecordCount > 0)
        this.indexes = await this.checkpointJournal(this.journal);
    });
  }

  /** Restore uses the ordinary durable transaction, with one streamed payload
   * per chat. The captured source remains intact until the caller commits the
   * surrounding container restore.
   */
  public async importScope(
    source: ChatStorageV2,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    options: ChatStorageImportOptions = {},
  ): Promise<V2Commit> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      const mutationId = options.mutationId ?? randomUUID();
      // A restore streams whole transcripts of any size: one version 2
      // transaction, with the scope promoted again at its next idle point.
      if (
        this.journal &&
        !this.indexes.recovery.mutationIds.includes(mutationId)
      )
        await this.demoteForLargeMutation();
      const current = (this.indexes ??= await this.loadIndexes());
      const visualOwners = new VisualOwnerLedgerView(current.recovery);
      if (current.recovery.mutationIds.includes(mutationId))
        return {
          baseRevision: current.live.revision,
          revision: current.live.revision,
          applied: false,
          state: await this.view(current, {}),
          record: {
            v: 1,
            revision: current.live.revision,
            mutationId,
            source: 'import',
            occurredAt: new Date().toISOString(),
            mutations: [],
          },
        };
      const incomingIds = new Set(
        [
          ...metadata.tabsFile.tabs,
          ...metadata.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id),
      );
      if (
        options.merge &&
        allEntries(current).some((tab) => incomingIds.has(tab.id))
      )
        throw new Error('Import would overwrite an existing chat');
      if (
        !options.merge &&
        (allEntries(current).some(
          (tab) =>
            (tab.transcript.messageCount ??
              tab.transcript.committedMessageCount) > 0 ||
            tab.pendingSystemInstructions?.length,
        ) ||
          current.live.pendingQuestions?.length ||
          Object.values(current.live.runtimeByChatId).some(
            (runtime) =>
              ACTIVE.has(runtime.status) || runtime.queuedMessageIds.length,
          ))
      )
        throw new Error('Restore destination contains existing chat data');
      const captured = await source.indexes();
      if (
        !options.settleFork &&
        Object.values(captured.live.runtimeByChatId).some(
          (runtime) =>
            ACTIVE.has(runtime.status) || runtime.queuedMessageIds.length,
        )
      )
        throw new Error('Restore source requires all active turns to settle');
      const sourceEntries = new Map(
        allEntries(captured).map((tab) => [tab.id, tab]),
      );
      const capturedEntries = new Map<string, ChatIndexEntry>();
      for (const id of options.merge
        ? Array.from(incomingIds)
        : Array.from(sourceEntries.keys())) {
        const entry = sourceEntries.get(options.sourceChatIds?.[id] ?? id);
        if (!entry) throw new Error('Restore metadata targets an unknown chat');
        capturedEntries.set(id, entry);
      }
      const convert = (tab: PersistedChatTab): ChatIndexEntry => {
        const entry = capturedEntries.get(tab.id);
        if (!entry) throw new Error('Restore metadata targets an unknown chat');
        const copy = { ...tab };
        Reflect.deleteProperty(copy, 'messages');
        Reflect.deleteProperty(copy, 'transcriptLoaded');
        Reflect.deleteProperty(copy, 'transcriptWindow');
        return { ...copy, transcript: entry.transcript };
      };
      const revision = current.live.revision + 1;
      const indexes: ChatStorageIndexes = {
        live: {
          ...metadata.tabsFile,
          version: 2,
          revision,
          tabs: metadata.tabsFile.tabs.map(convert),
          runtimeByChatId: {},
        },
        archive: {
          version: 2,
          revision,
          archived: metadata.archivesFile.archived.map((entry) => ({
            ...entry,
            tab: convert(entry.tab),
          })),
        },
        recovery: { ...current.recovery },
      };
      if (
        allEntries(indexes).length !== capturedEntries.size ||
        new Set(allEntries(indexes).map((tab) => tab.id)).size !==
          capturedEntries.size
      )
        throw new Error('Restore must preserve every captured chat');
      const importedEntries = allEntries(indexes);
      if (options.merge) {
        indexes.live.tabs.unshift(...current.live.tabs);
        indexes.archive.archived.unshift(...current.archive.archived);
        indexes.live.runtimeByChatId = { ...current.live.runtimeByChatId };
        indexes.live.pendingQuestions = [
          ...(current.live.pendingQuestions ?? []),
          ...(indexes.live.pendingQuestions ?? []),
        ];
      }
      indexes.recovery.mutationIds = boundedIds(
        current.recovery.mutationIds,
        [mutationId],
        4096,
      );
      const evidence = await source.copyRecoveryEvidenceTo(
        this.store,
        current.recovery.legacyEvidence ?? [],
      );
      if (evidence.length) indexes.recovery.legacyEvidence = evidence;
      const sourceLog = new ChatTranscriptLog(
        join(source.directory, 'transcripts'),
        undefined,
        { readOnly: true },
      );
      const targetArtifacts = this.storage.transcripts.artifacts;
      const targetDelegations = this.storage.transcripts.delegations;
      const created = new CreatedArtifacts();
      const writes: ChatTranscriptWrite[] = (
        options.merge ? [] : allEntries(current)
      )
        .filter((tab) => !capturedEntries.has(tab.id))
        .map((tab) => ({ chatId: tab.id, kind: 'delete' }));
      for (const tab of importedEntries) {
        const sourceId = capturedEntries.get(tab.id)?.id ?? tab.id;
        writes.push({
          chatId: tab.id,
          kind: 'replace',
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            const throughMessageId = options.throughMessageIds?.[tab.id];
            const copy = async (
              message: PersistedChatMessage,
            ): Promise<PersistedChatMessage> => {
              for (const block of message.blocks) {
                for (const ref of storedArtifactRefsOf(block))
                  await sourceLog.artifacts.copyArtifactToChat(
                    sourceId,
                    tab.id,
                    ref,
                    targetArtifacts,
                    created,
                  );
                // A card's child transcript lives beside the transcript, not
                // in it: carry the run's delegate log with its card.
                if (
                  block.type === 'delegated_agent_call' &&
                  block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG
                )
                  await sourceLog.delegations.copyRun(
                    sourceId,
                    tab.id,
                    block,
                    targetDelegations,
                    created,
                  );
              }
              return options.transformMessage?.(message, tab.id) ?? message;
            };
            for await (const message of sourceLog.iterate(sourceId)) {
              yield await copy(message);
              if (message.id === throughMessageId) return;
            }
            const active = await sourceLog.activeMessages(sourceId);
            for (const message of options.settleFork
              ? settlePersistedForkMessages(active, Date.now())
              : active) {
              yield await copy(message);
              if (message.id === throughMessageId) return;
            }
            if (throughMessageId !== undefined)
              throw new Error('Canonical branch message anchor was not found');
          })(),
        });
      }
      for (const tab of importedEntries) visualOwners.removeChat(tab.id);
      for (const write of writes)
        if (write.kind === 'delete') visualOwners.removeChat(write.chatId);
      installVisualOwnerLedger(indexes.recovery, visualOwners);
      this.indexes = await this.storage.commit(
        current.live.revision,
        indexes,
        writes,
        created,
        options.beforePublish,
        options.preparePublish,
      );
      const state = await this.view(this.indexes, {
        chatIds: [indexes.live.activeTabId],
        pageOnly: true,
      });
      const mutations: ChatCoreMutation[] = [
        ...(options.merge ? [] : current.live.tabs).map(
          (tab): ChatCoreMutation => ({ type: 'tab.removed', tabId: tab.id }),
        ),
        ...(options.merge ? [] : current.archive.archived).map(
          (entry): ChatCoreMutation => ({
            type: 'archive.removed',
            archiveEntryId: entry.tab.id,
            chatId: entry.tab.id,
          }),
        ),
        ...state.tabsFile.tabs
          .filter((tab) => incomingIds.has(tab.id))
          .map(
            (tab): ChatCoreMutation => ({
              type: 'tab.created',
              tab: {
                ...tab,
                messages:
                  tab.id === indexes.live.activeTabId ? tab.messages : [],
                transcriptLoaded: tab.id === indexes.live.activeTabId,
              },
            }),
          ),
        ...state.archivesFile.archived
          .filter((entry) => incomingIds.has(entry.tab.id))
          .map(
            (entry): ChatCoreMutation => ({
              type: 'archive.upserted',
              entry: {
                ...entry,
                tab: { ...entry.tab, messages: [], transcriptLoaded: false },
              },
            }),
          ),
        { type: 'tab.active_changed', activeTabId: indexes.live.activeTabId },
      ];
      recordChatStorageMutations(mutations.length, this.store.directory);
      return {
        baseRevision: current.live.revision,
        revision,
        applied: true,
        state,
        record: {
          v: 1,
          revision,
          mutationId,
          source: 'import',
          occurredAt: new Date().toISOString(),
          mutations,
        },
      };
    });
  }

  private indexedChat(chatId: string): ChatIndexEntry {
    const indexes = this.indexes;
    if (!indexes)
      throw new Error('Artifact maintenance requires loaded canonical indexes');
    const entry =
      indexes.live.tabs.find((candidate) => candidate.id === chatId) ??
      indexes.archive.archived.find((candidate) => candidate.tab.id === chatId)
        ?.tab;
    if (!entry) throw new Error(`Unknown chat: ${chatId}`);
    return entry;
  }

  /** Whether an index lists the chat, so its delegate log may be written. */
  public async listsDelegationChat(chatId: string): Promise<boolean> {
    return this.serial(async () => {
      this.indexes ??= await this.loadIndexes();
      return allEntries(this.indexes).some((tab) => tab.id === chatId);
    });
  }

  /**
   * Writes delegated runs' new and changed child transcript items to the
   * chat's delegate logs, each run's file in parallel. Not serialized with
   * the scope: the log store orders writes per file and drops writes for a
   * chat whose logs were removed.
   */
  public async appendDelegationLog(
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<void> {
    await Promise.all(
      runs.map(({ run, items }) =>
        this.storage.transcripts.delegations.append(chatId, run, items),
      ),
    );
  }

  /**
   * Appends delegated runs' items to the chat's delegate logs. Returns false,
   * writing nothing, when no index lists the chat (it was deleted): a late
   * append never recreates its directory.
   */
  public async appendDelegationItems(
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    if (!(await this.listsDelegationChat(chatId))) return false;
    await this.appendDelegationLog(chatId, runs);
    return true;
  }

  /** A delegated run's child transcript items from the chat's delegate log. */
  public async readDelegationItems(
    chatId: string,
    run: DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      return this.storage.transcripts.delegations.read(chatId, run);
    });
  }

  private async requireChat(chatId: string): Promise<ChatIndexEntry> {
    this.indexes ??= await this.loadIndexes();
    return this.indexedChat(chatId);
  }

  public async page(
    chatId: string,
    before?: number,
    expectedRevision?: number,
    options: TranscriptViewRequest = {},
  ): Promise<TranscriptPage> {
    return this.serial(async () => {
      const entry = await this.requireChat(chatId);
      const page = await this.storage.transcripts.page(chatId, before, options);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== page.transcriptRevision
      )
        throw new Error("Couldn't load messages.");
      if (mainTranscriptPerformanceEnabled()) {
        const finishSerialization = beginMainTranscriptPerformanceStage(
          'payload_bytes_estimate',
          chatId,
          { loadedRows: page.messages.length },
        );
        finishSerialization({
          serializedBytes: estimateTranscriptWindowBytes(
            entry.transcript,
            page.messages.length,
          ),
        });
      }
      return page;
    });
  }

  /** Point lookup for one message id in a live or auto-archived chat: the
   * active tail plus the committed per-message locator. It never iterates or
   * pages the committed transcript. An unknown chat contains no messages.
   */
  public async hasMessage(chatId: string, messageId: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.indexes) {
        this.indexes = await this.storage.load();
        this.reportInvalidVisualOwnerLedger(this.indexes);
      }
      if (!allEntries(this.indexes).some((entry) => entry.id === chatId))
        return false;
      const transcript = this.storage.transcripts;
      const active = await transcript.activeMessages(chatId);
      if (active.some((message) => message.id === messageId)) return true;
      return transcript.hasCommittedMessage(chatId, messageId);
    });
  }

  public async toolOutput(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; nextOffset?: number; byteLength: number }> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      signal?.throwIfAborted();
      const ownsReference = await this.verifyArtifactOwnership(
        chatId,
        `tool:${JSON.stringify([
          messageId,
          toolUseId,
          reference.version,
          reference.artifactId,
          reference.byteLength,
          reference.sha256,
          reference.encoding,
          reference.mediaType,
        ])}`,
        () =>
          this.storage.transcripts.ownsToolOutputReference(
            chatId,
            messageId,
            toolUseId,
            reference,
          ),
        signal,
      );
      if (!ownsReference)
        throw new Error('Transcript block does not own tool output reference');
      return this.storage.transcripts.artifacts.readRange(
        chatId,
        reference,
        offset,
        length,
        signal,
      );
    });
  }

  public async visual(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    offset: number;
    length: number;
    byteLength: number;
    sha256: string;
  }> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      signal?.throwIfAborted();
      const ownsReference = await this.verifyArtifactOwnership(
        chatId,
        `visual:${JSON.stringify([
          messageId,
          toolUseId,
          reference.version,
          reference.visualId,
          reference.artifactId,
          reference.byteLength,
          reference.sha256,
          reference.mediaType,
          reference.title,
          reference.maxHeight,
          reference.heights,
        ])}`,
        () =>
          this.storage.transcripts.ownsVisualReference(
            chatId,
            messageId,
            toolUseId,
            reference,
          ),
        signal,
      );
      if (!ownsReference) throw new ChatVisualReadError('not_found');
      try {
        return await this.storage.transcripts.artifacts.readVisualRange(
          chatId,
          reference,
          offset,
          limit,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isErrnoException(error) && error.code === 'ENOENT')
          throw new ChatVisualReadError('not_found');
        if (
          error instanceof Error &&
          VISUAL_INTEGRITY_FAILURES.has(error.message)
        )
          throw new ChatVisualReadError('invalid_state');
        // Other I/O failures are not integrity failures; the adapter reports
        // them as `internal` with a fixed message.
        throw error;
      }
    });
  }

  private async verifyArtifactOwnership(
    chatId: string,
    ownershipKey: string,
    verify: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { transcriptRevision } =
      await this.storage.transcripts.descriptor(chatId);
    let ownership = this.verifiedArtifactOwnership.get(chatId);
    if (!ownership || ownership.transcriptRevision !== transcriptRevision) {
      if (
        !ownership &&
        this.verifiedArtifactOwnership.size >=
          TOOL_OUTPUT_OWNERSHIP_CHAT_CACHE_LIMIT
      ) {
        const oldest = this.verifiedArtifactOwnership.keys().next();
        if (!oldest.done) this.verifiedArtifactOwnership.delete(oldest.value);
      }
      ownership = { transcriptRevision, keys: new Set() };
      this.verifiedArtifactOwnership.set(chatId, ownership);
    }
    let ownsReference = ownership.keys.has(ownershipKey);
    if (!ownsReference) {
      ownsReference = await verify();
      signal?.throwIfAborted();
      if (ownsReference) {
        if (ownership.keys.size >= TOOL_OUTPUT_OWNERSHIP_KEY_CACHE_LIMIT) {
          const oldest = ownership.keys.values().next();
          if (!oldest.done) ownership.keys.delete(oldest.value);
        }
        ownership.keys.add(ownershipKey);
      }
    }
    return ownsReference;
  }

  /** Capture preview file handles while the repository owns its short scope
   * lease. No callback or transcript projection runs in this serializer.
   */
  public async captureTranscriptPreview(
    chatId: string,
  ): Promise<CapturedTranscriptPreview> {
    return this.serial(async () => {
      const entry = await this.requireChat(chatId);
      if (!entry.transcript)
        throw new Error(`Chat ${chatId} has no transcript descriptor`);
      return this.storage.transcripts.capturePreview(chatId, entry.transcript);
    });
  }

  /**
   * The rows a chat's in-progress turn changed since transcript revision
   * `since`, with the chat's descriptor at the same point, for chat search's
   * incremental projection. Undefined for a version 2 scope, or when only a
   * full read of the active rows can answer.
   */
  public async activeTurnDelta(
    chatId: string,
    since: number,
  ): Promise<
    { descriptor: TranscriptDescriptor; delta: ActiveTurnDelta } | undefined
  > {
    return this.serial(async () => {
      await this.requireChat(chatId);
      const journal = this.journal;
      if (!journal?.isOpen()) return undefined;
      const delta = journal.activeTurnDelta(chatId, since);
      if (!delta) return undefined;
      const descriptor = await this.storage.transcripts.descriptor(chatId);
      if (descriptor.transcriptRevision !== delta.transcriptRevision)
        return undefined;
      return { descriptor, delta };
    });
  }

  /** The consumer completes while the scope lease excludes reset/delete.
   * Streaming exports/reconstruction opt into full outputs one message at a
   * time; preview-only search never reads artifact bodies.
   */
  public async consumeTranscript<T>(
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options: TranscriptConsumeOptions = {},
  ): Promise<T> {
    return this.serial(async () => {
      await this.requireChat(chatId);
      const transcript = this.storage.transcripts;
      const active = await transcript.activeMessages(chatId);
      const stored = async function* (): AsyncGenerator<PersistedChatMessage> {
        yield* transcript.iterate(chatId);
        yield* active;
      };
      const rows = async function* (): AsyncGenerator<PersistedChatMessage> {
        if (!options.inlineDelegationChildren) {
          yield* stored();
          return;
        }
        // Read under this lease directly: the chat's log reads would wait
        // for it through the repository.
        const inlined = new Set<string>();
        for await (const message of stored()) {
          if (message.parentBlockId && inlined.has(message.parentBlockId))
            continue;
          const cards = message.blocks.filter(
            (block) =>
              block.type === 'delegated_agent_call' &&
              block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG,
          );
          if (cards.length === 0) {
            yield message;
            continue;
          }
          yield {
            ...message,
            blocks: message.blocks.map((block) => {
              if (block.type !== 'delegated_agent_call') return block;
              const { transcriptStore: _store, ...card } = block;
              void _store;
              return card;
            }),
          };
          for (const card of cards) {
            if (card.type !== 'delegated_agent_call') continue;
            inlined.add(card.agentBlockId);
            yield* delegationChildMessages(
              card.agentBlockId,
              await transcript.delegations.read(chatId, card),
            );
          }
        }
      };
      return consume(
        (async function* (): AsyncGenerator<PersistedChatMessage> {
          for await (const message of rows()) {
            if (!fullOutputs) {
              yield message;
              continue;
            }
            const blocks = [];
            for (const block of message.blocks) {
              if (block.type !== 'tool_result' || !block.fullOutputRef) {
                blocks.push(block);
                continue;
              }
              const parts: string[] = [];
              let offset = 0;
              do {
                const part = await transcript.artifacts.readRange(
                  chatId,
                  block.fullOutputRef,
                  offset,
                  65_536,
                );
                parts.push(part.text);
                if (part.nextOffset === undefined) break;
                offset = part.nextOffset;
              } while (offset < block.fullOutputRef.byteLength);
              const {
                fullOutputRef: _ref,
                outputTruncated: _truncated,
                ...rest
              } = block;
              void _ref;
              void _truncated;
              blocks.push({ ...rest, output: parts.join('') });
            }
            yield { ...message, blocks };
          }
        })(),
      );
    });
  }
  private async view(
    indexes: ChatStorageIndexes,
    selection: ChatReadSelection,
  ): Promise<CanonicalChatState> {
    recordChatStorageIndexClone();
    const state = metadataState(structuredClone(indexes), true);
    const selected = new Set(selection.chatIds ?? []);
    for (const tab of [
      ...state.tabsFile.tabs,
      ...state.archivesFile.archived.map((entry) => entry.tab),
    ]) {
      if (!selected.has(tab.id)) continue;
      let messages: PersistedChatMessage[];
      if (selection.fullTranscript) {
        const active = await this.storage.transcripts.activeMessages(tab.id);
        messages = [];
        for await (const message of this.storage.transcripts.iterate(tab.id))
          messages.push(message);
        const ids = new Set(messages.map((message) => message.id));
        messages.push(...active.filter((message) => !ids.has(message.id)));
      } else {
        const { page, activeMessages: active } =
          await this.storage.transcripts.pageWithActiveMessages(
            tab.id,
            undefined,
            selection.pageOnly ? { view: 'turns' } : {},
          );
        if (selection.pageOnly) {
          const { messages: _messages, ...window } = page;
          void _messages;
          tab.transcriptWindow = window;
        }
        const activeIds = new Set(active.map((message) => message.id));
        messages = selection.pageOnly
          ? page.messages
          : [
              ...page.messages.filter((message) => !activeIds.has(message.id)),
              ...active,
            ];
        if (
          page.latestHumanMessage &&
          !messages.some(
            (message) => message.id === page.latestHumanMessage?.id,
          )
        )
          messages.unshift(page.latestHumanMessage);
        if (!selection.pageOnly && selection.messageAnchor) {
          const { messageId, fallbackMessageId, previousRunMessageId } =
            selection.messageAnchor;
          if (!messages.some((message) => message.id === messageId)) {
            const anchor = await this.storage.transcripts.readMessage(
              tab.id,
              messageId,
            );
            if (anchor) messages.unshift(anchor);
            else {
              if (
                !messages.some((message) => message.id === fallbackMessageId)
              ) {
                const parent = await this.storage.transcripts.readMessage(
                  tab.id,
                  fallbackMessageId,
                );
                if (parent) messages.unshift(parent);
              }
              if (
                previousRunMessageId &&
                !messages.some((message) => message.id === previousRunMessageId)
              ) {
                const previous = await this.storage.transcripts.readMessage(
                  tab.id,
                  previousRunMessageId,
                );
                if (previous) {
                  const parentIndex = messages.findIndex(
                    (message) => message.id === fallbackMessageId,
                  );
                  messages.splice(
                    parentIndex < 0 ? 0 : parentIndex + 1,
                    0,
                    previous,
                  );
                }
              }
            }
          }
        }
      }
      Object.defineProperty(tab, 'messages', {
        enumerable: true,
        configurable: true,
        writable: true,
        value: messages,
      });
    }
    return state;
  }

  /** Commit one transaction; resolves once it is durable. */
  public async transact(
    build: TransactionBuilder,
    options: V2MutationOptions,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Commit> {
    return (await this.runTransaction(build, options, false, visualAdmission))
      .commit;
  }

  /**
   * Commit one transaction, letting a delta-journal record share its sync
   * with the commits admitted around it (group commit). The transaction is
   * validated and applied in memory before this resolves, so the next one
   * is built against it. When `durable` is returned the commit must not be
   * acknowledged or published before it resolves; if it rejects, the commit
   * was not made durable and the scope reloads on its next operation.
   *
   * Without `durable` the commit is durable already: a version 2 scope, a
   * commit with publish hooks, and a record that changes committed rows,
   * which is checkpointed before this resolves.
   */
  public admit(
    build: TransactionBuilder,
    options: V2MutationOptions,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Admission> {
    return this.runTransaction(build, options, true, visualAdmission);
  }

  /**
   * A re-reported result whose row is outside the loaded window, or in a
   * chat the transaction did not load, is read from storage so its visual
   * reference is carried forward rather than dropped.
   */
  private async addUnloadedPreviousResults(
    mutations: readonly ChatCoreMutation[],
    previous: Map<string, Map<string, PersistedChatMessage>>,
    existingChatIds: ReadonlySet<string>,
    loadedChatIds: ReadonlySet<string>,
  ): Promise<void> {
    const activeByChatId = new Map<string, PersistedChatMessage[]>();
    for (const mutation of mutations) {
      const carried = rowsCarriedBy(mutation);
      if (!carried || !existingChatIds.has(carried.chatId)) continue;
      const { chatId } = carried;
      const known =
        previous.get(chatId) ?? new Map<string, PersistedChatMessage>();
      for (const message of carried.messages) {
        if (known.has(message.id) || !needsPreviousResult(message)) continue;
        const existing = await this.unloadedMessage(
          chatId,
          message.id,
          loadedChatIds.has(chatId),
          activeByChatId,
        );
        if (existing) known.set(message.id, existing);
      }
      if (known.size > 0) previous.set(chatId, known);
    }
  }

  private async unloadedMessage(
    chatId: string,
    messageId: string,
    activeLoaded: boolean,
    activeByChatId: Map<string, PersistedChatMessage[]>,
  ): Promise<PersistedChatMessage | undefined> {
    const transcripts = this.storage.transcripts;
    const committed = await transcripts.committedMessage(chatId, messageId);
    if (committed || activeLoaded) return committed;
    let active = activeByChatId.get(chatId);
    if (!active) {
      active = await transcripts.activeMessages(chatId);
      activeByChatId.set(chatId, active);
    }
    return active.find((row) => row.id === messageId);
  }

  private async runTransaction(
    build: TransactionBuilder,
    options: V2MutationOptions,
    group: boolean,
    visualAdmission?: ProviderVisualAdmission,
  ): Promise<V2Admission> {
    return this.serial(async () => {
      const current = (this.indexes ??= await this.loadIndexes());
      const baseRevision = current.live.revision;
      const mutationId = options.mutationId ?? randomUUID();
      const view = await this.view(current, options);
      const empty: ChatJournalRecord = {
        v: 1,
        revision: baseRevision,
        mutationId,
        source: options.source,
        occurredAt: new Date().toISOString(),
        mutations: [],
      };
      // Nothing is written, but `view` may hold commits admitted ahead of
      // this one that are not durable yet: wait for them before answering.
      const unapplied = (): V2Admission => {
        const pending = group ? this.pendingJournalDurability() : undefined;
        return {
          commit: {
            baseRevision,
            revision: baseRevision,
            state: view,
            record: empty,
            applied: false,
          },
          ...(pending ? { durable: pending } : {}),
        };
      };
      if (current.recovery.mutationIds.includes(mutationId)) return unapplied();
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== baseRevision
      )
        throw new Error(
          `Chat revision conflict: expected ${options.expectedRevision}, current ${baseRevision}`,
        );
      const mutations = await build(view, baseRevision, {
        getPortalSendReceipt: (userMessageId) =>
          current.recovery.receipts.find(
            (receipt) => receipt.portalSend?.userMessageId === userMessageId,
          ),
        hasRemovedTab: (id) => current.recovery.removedTabIds.includes(id),
        hasRemovedArchiveEntry: (id) =>
          current.recovery.removedArchiveEntryIds.includes(id),
        hasRemovedMessage: (id, chatId) =>
          chatId === undefined
            ? current.recovery.removedMessageIds.includes(id)
            : (current.recovery.removedMessageKeys ?? []).includes(
                JSON.stringify([chatId, id]),
              ),
      });
      if (!mutations.length) return unapplied();
      const revision = baseRevision + 1;
      const oldEntries = new Map(
        allEntries(current).map((tab) => [tab.id, tab]),
      );
      const viewTabs = new Map(
        [
          ...view.tabsFile.tabs,
          ...view.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => [tab.id, tab]),
      );
      const currentMessagesByChatId = previousMessagesForMutations(
        mutations,
        viewTabs,
      );
      await this.addUnloadedPreviousResults(
        mutations,
        currentMessagesByChatId,
        new Set(oldEntries.keys()),
        new Set(options.chatIds ?? []),
      );
      const visualOwners = new VisualOwnerLedgerView(current.recovery);
      if (visualAdmission)
        visualOwners.prune(
          visualAdmission.staging.stagedIds(),
          visualAdmission.now(),
        );
      const visualContexts = externalizeVisualContexts(
        mutations,
        currentToolMessagesForMutations(mutations, viewTabs),
        visualAdmission,
        visualOwners,
      );
      const deltas = new Map<string, Delta>();
      const projectedMessages = new Map<
        ChatCoreMutation,
        PersistedChatMessage
      >();
      const delta = (id: string): Delta => {
        let value = deltas.get(id);
        if (!value) {
          value = {
            upserts: new Map(),
            insertions: new Map(),
            removed: new Set(),
          };
          deltas.set(id, value);
        }
        return value;
      };
      const metadataMutations: ChatCoreMutation[] = [];
      // Artifacts are externalized while preparing the writes, before the
      // scope transaction publishes its journal record. Track the files this
      // transaction created so a failure before publication reclaims exactly
      // those and nothing an earlier commit or pending payload references.
      const created = new CreatedArtifacts();
      let committing = false;
      /** Pending while the commit's journal record waits for its batch. */
      let durable: Promise<void> | undefined;
      let commandResult: V2Commit['record']['commandResult'];
      let promotedVisuals: PromotedVisual[] = [];
      try {
        for (const mutation of mutations) {
          if (mutation.type === 'message.upserted') {
            const incoming = preserveVisualReferences(
              currentMessagesByChatId
                .get(mutation.chatId)
                ?.get(mutation.message.id),
              mutation.message,
            );
            const stored = await this.storage.transcripts.artifacts.externalize(
              mutation.chatId,
              incoming,
              created,
              visualContexts.get(mutation.chatId),
            );
            projectedMessages.set(mutation, stored);
            const change = delta(mutation.chatId);
            change.upserts.set(stored.id, stored);
            if (mutation.afterMessageId)
              change.insertions.set(stored.id, mutation.afterMessageId);
            change.removed.delete(mutation.message.id);
            // The real body is carried only by the per-chat delta below.
            metadataMutations.push({
              ...mutation,
              message: { ...mutation.message, blocks: [] },
            });
          } else if (mutation.type === 'message.removed') {
            const change = delta(mutation.chatId);
            change.upserts.delete(mutation.messageId);
            change.insertions.delete(mutation.messageId);
            change.removed.add(mutation.messageId);
            metadataMutations.push(mutation);
          } else if (mutation.type === 'messages.replaced') {
            if (oldEntries.has(mutation.chatId) && !options.fullTranscript)
              throw new Error(
                'Replacing existing history requires an explicit full-transcript operation',
              );
            const change = delta(mutation.chatId);
            const previous = currentMessagesByChatId.get(mutation.chatId);
            change.replacement = mutation.messages.map((message) =>
              preserveVisualReferences(previous?.get(message.id), message),
            );
            change.upserts.clear();
            change.insertions.clear();
            change.removed.clear();
            metadataMutations.push({ ...mutation, messages: [] });
          } else if (
            mutation.type === 'tab.created' ||
            mutation.type === 'archive.upserted'
          ) {
            const incoming =
              mutation.type === 'tab.created'
                ? mutation.tab
                : mutation.entry.tab;
            if (mutation.type === 'archive.upserted') delta(incoming.id);
            if (mutation.transcriptSourceChatId) {
              if (!oldEntries.has(mutation.transcriptSourceChatId))
                throw new Error('Unknown source transcript');
              delta(incoming.id).artifactSource =
                mutation.transcriptSourceChatId;
            }
            if (mutation.replaceTranscript) {
              if (
                !options.fullTranscript ||
                !Object.prototype.propertyIsEnumerable.call(
                  incoming,
                  'messages',
                )
              )
                throw new Error(
                  'Replacing existing history requires an explicit full-transcript operation',
                );
              if (
                incoming.transcriptLoaded === false ||
                incoming.transcriptWindow?.view === 'turns' ||
                incoming.transcriptWindow?.before !== undefined ||
                (incoming.transcript?.messageCount ?? 0) >
                  incoming.messages.length
              )
                throw new Error(
                  'Replacing history requires a complete transcript',
                );
              delta(incoming.id).replacement = incoming.messages;
            }
            if (
              Object.prototype.propertyIsEnumerable.call(incoming, 'messages')
            ) {
              const previous = viewTabs.get(incoming.id);
              const sameArray =
                previous &&
                Object.prototype.propertyIsEnumerable.call(
                  previous,
                  'messages',
                ) &&
                previous.messages === incoming.messages;
              if (!sameArray) {
                // An archived update carries its whole reduced view. Keep a
                // new row where the view puts it when retained rows follow.
                const known =
                  mutation.type === 'archive.upserted' &&
                  previous &&
                  Object.prototype.propertyIsEnumerable.call(
                    previous,
                    'messages',
                  )
                    ? new Set(previous.messages.map((message) => message.id))
                    : undefined;
                let lastKnown = -1;
                if (known)
                  incoming.messages.forEach((message, index) => {
                    if (known.has(message.id)) lastKnown = index;
                  });
                incoming.messages.forEach((message, index) => {
                  const change = delta(incoming.id);
                  change.upserts.set(
                    message.id,
                    preserveVisualReferences(
                      currentMessagesByChatId.get(incoming.id)?.get(message.id),
                      message,
                    ),
                  );
                  const afterMessageId = incoming.messages[index - 1]?.id;
                  if (
                    known &&
                    afterMessageId &&
                    index < lastKnown &&
                    !known.has(message.id)
                  )
                    change.insertions.set(message.id, afterMessageId);
                });
              }
            }
            const stripped = { ...incoming, messages: [] };
            metadataMutations.push(
              mutation.type === 'tab.created'
                ? { ...mutation, tab: stripped }
                : { ...mutation, entry: { ...mutation.entry, tab: stripped } },
            );
          } else {
            if (mutation.type === 'runtime.patched') delta(mutation.chatId);
            metadataMutations.push(mutation);
          }
        }
        const nextState = reduceChatState(
          metadataState(current, false),
          metadataMutations,
        );
        const convert = ({
          messages: _messages,
          transcriptLoaded: _loaded,
          transcriptWindow: _window,
          ...tab
        }: PersistedChatTab): ChatIndexEntry => {
          void _messages;
          void _loaded;
          void _window;
          return {
            ...tab,
            transcript: oldEntries.get(tab.id)?.transcript ?? {
              ...EMPTY_DESCRIPTOR,
            },
          };
        };
        const indexes: ChatStorageIndexes = {
          live: {
            ...nextState.tabsFile,
            version: 2,
            revision,
            tabs: nextState.tabsFile.tabs.map(convert),
            runtimeByChatId: nextState.runtimeByChatId,
          },
          archive: {
            version: 2,
            revision,
            archived: nextState.archivesFile.archived.map((entry) => ({
              ...entry,
              tab: convert(entry.tab),
            })),
          },
          // Every recovery field this commit changes is reassigned below, never
          // mutated in place, so a shallow copy keeps `current` intact.
          recovery: { ...current.recovery },
        };
        indexes.recovery.mutationIds = boundedIds(
          indexes.recovery.mutationIds,
          [mutationId],
          4096,
        );
        for (const mutation of mutations) {
          const removedIds =
            mutation.type === 'message.removed'
              ? [mutation.messageId]
              : mutation.type === 'messages.replaced'
                ? mutation.removedMessageIds
                : [];
          if (
            removedIds.length > 0 &&
            (mutation.type === 'message.removed' ||
              mutation.type === 'messages.replaced')
          ) {
            indexes.recovery.removedMessageKeys = boundedIds(
              indexes.recovery.removedMessageKeys ?? [],
              removedIds.map((id) => JSON.stringify([mutation.chatId, id])),
              1024,
            );
          }
          if (mutation.type === 'tab.removed')
            indexes.recovery.removedTabIds = boundedIds(
              indexes.recovery.removedTabIds,
              [mutation.tabId],
              1024,
            );
          if (mutation.type === 'archive.removed')
            indexes.recovery.removedArchiveEntryIds = boundedIds(
              indexes.recovery.removedArchiveEntryIds,
              [mutation.archiveEntryId],
              1024,
            );
          if (mutation.type === 'message.removed')
            indexes.recovery.removedMessageIds = boundedIds(
              indexes.recovery.removedMessageIds,
              [mutation.messageId],
              1024,
            );
          if (mutation.type === 'messages.replaced')
            indexes.recovery.removedMessageIds = boundedIds(
              indexes.recovery.removedMessageIds,
              mutation.removedMessageIds,
              1024,
            );
        }
        const receipt = options.commandResult
          ? { ...options.commandResult, revision }
          : undefined;
        commandResult = receipt;
        if (receipt)
          indexes.recovery.receipts = [
            ...indexes.recovery.receipts.filter(
              (existing) => existing.commandId !== receipt.commandId,
            ),
            receipt,
          ].slice(-256);
        const previousActive = new Map<string, PersistedChatMessage[]>();
        const forms: JournalWriteForms = {
          patches: new Map(),
          active: new Map(),
        };
        const fullRewrites: ChatTranscriptFullRewrite[] = [];
        const writes = await this.writes(
          current,
          indexes,
          deltas,
          created,
          previousActive,
          this.journal ? forms : undefined,
          fullRewrites,
          currentMessagesByChatId,
        );
        for (const write of writes)
          if (write.kind === 'delete') visualOwners.removeChat(write.chatId);
        promotedVisuals = promotedVisualsInWrites(
          projectedMessages,
          deltas,
          writes,
          visualOwners,
        );
        installVisualOwnerLedger(indexes.recovery, visualOwners);
        let journalWrites: DeltaJournalWrite[] | undefined;
        if (
          this.journal &&
          Array.from(deltas.values()).some((delta) => delta.insertions.size > 0)
        ) {
          // The delta patch format cannot express insertion into committed
          // history. Use the V2 ordered rewrite for this uncommon recovery.
          await this.demoteForLargeMutation();
        } else if (this.journal) {
          journalWrites = journalWritesFor(writes, forms);
          if (
            estimateJournalBytes(journalWrites) >
            (this.options.deltaJournal?.largeRecordBytes ??
              LARGE_JOURNAL_RECORD_BYTES)
          ) {
            // Too large for one record: this transaction is version 2.
            await this.demoteForLargeMutation();
            journalWrites = undefined;
          }
        }
        const beforeArtifactIdentities = new Map<string, string>();
        if (!journalWrites)
          for (const write of writes)
            try {
              const identity = await this.artifactMaintenance.identityIfCached(
                write.chatId,
              );
              if (identity)
                beforeArtifactIdentities.set(write.chatId, identity);
            } catch {
              // Derived accounting cannot reject the canonical transaction.
            }
        committing = true;
        const journal = this.journal;
        if (journal && journalWrites) {
          const committed = await this.commitToJournal(
            journal,
            baseRevision,
            indexes,
            journalWrites,
            mutationId,
            created,
            options,
            group,
          );
          this.indexes = committed.indexes;
          durable = committed.durable;
        } else
          this.indexes = await this.storage.commit(
            baseRevision,
            indexes,
            writes,
            created,
            options.beforePublish,
            options.preparePublish,
          );
        const markCommitted = (): void => {
          recordChatStorageMutations(mutations.length, this.store.directory);
          this.promotionRetry.activity();
          // Durable now; report the rewrites this commit performed. A
          // journaled commit is no exception: a record that changes committed
          // rows is checkpointed before it is acknowledged, and that
          // checkpoint runs the same committed replacement.
          for (const rewrite of fullRewrites)
            reportChatTranscriptFullRewrite(rewrite);
        };
        if (durable) {
          // Group commit: counted and reported once, when the commit's batch
          // is durable. Batches settle in commit order.
          durable = durable.then(markCommitted);
          // The caller observes the outcome; a failure before it does must
          // not surface as an unhandled rejection.
          durable.catch(() => undefined);
        } else markCommitted();
        for (const write of writes)
          try {
            // A journaled write leaves the files as they were; the next scan
            // after its checkpoint rebuilds the chat's references.
            if (journalWrites)
              await this.artifactMaintenance.invalidate(write.chatId);
            else
              await this.artifactMaintenance.committed(
                write.chatId,
                write,
                previousActive.get(write.chatId) ?? [],
                beforeArtifactIdentities.get(write.chatId),
              );
          } catch {
            try {
              await this.artifactMaintenance.invalidate(write.chatId);
            } catch {
              // Never turn a durable acknowledgement into a cleanup failure.
            }
          }
      } catch (error) {
        // The scope transaction owns reclamation once it starts; it knows
        // whether its journal record published.
        if (!committing) await created.discard();
        throw error;
      }
      // Publish the same lossless reference/preview representation that was
      // durably committed. A write must never stream its raw artifact body to
      // every renderer subscriber after the disk layer has externalized it.
      const projected: ChatCoreMutation[] = [];
      for (const mutation of mutations) {
        if (mutation.type === 'message.upserted') {
          const message = projectedMessages.get(mutation);
          if (!message) throw new Error('Missing prepared message projection');
          projected.push({
            ...mutation,
            message,
          });
        } else if (
          mutation.type === 'tab.created' ||
          mutation.type === 'archive.upserted'
        ) {
          const id =
            mutation.type === 'tab.created'
              ? mutation.tab.id
              : mutation.entry.tab.id;
          const entry = allEntries(this.indexes).find((tab) => tab.id === id);
          if (!entry) {
            projected.push(mutation);
            continue;
          }
          // A raw tail can start inside a long turn, losing its owning prompt
          // and timer. Publish the same bounded, framed view as initial loads.
          const page = await this.storage.transcripts.page(id, undefined, {
            view: 'turns',
          });
          const { messages, ...window } = page;
          const tab: PersistedChatTab = {
            ...entry,
            messages: [
              ...(page.latestHumanMessage &&
              !messages.some(
                (message) => message.id === page.latestHumanMessage?.id,
              )
                ? [page.latestHumanMessage]
                : []),
              ...messages,
            ],
            transcriptLoaded: true,
            transcriptWindow: window,
          };
          projected.push(
            mutation.type === 'tab.created'
              ? { ...mutation, tab }
              : { ...mutation, entry: { ...mutation.entry, tab } },
          );
        } else if (mutation.type === 'messages.replaced') {
          const page = await this.storage.transcripts.page(mutation.chatId);
          projected.push({
            ...mutation,
            messages: [
              ...(page.latestHumanMessage &&
              !page.messages.some(
                (message) => message.id === page.latestHumanMessage?.id,
              )
                ? [page.latestHumanMessage]
                : []),
              ...page.messages,
            ],
          });
        } else projected.push(mutation);
      }

      return {
        commit: {
          baseRevision,
          revision,
          state: await this.view(this.indexes, options),
          applied: true,
          record: {
            ...empty,
            revision,
            mutations: projected,
            ...(commandResult ? { commandResult } : {}),
          },
          ...(promotedVisuals.length > 0 ? { promotedVisuals } : {}),
        },
        ...(durable ? { durable } : {}),
      };
    });
  }

  /**
   * Commit through the delta journal: artifacts were published while the
   * writes were prepared; the writer appends one record and syncs the
   * journal once. A record that changes committed rows (an append, a
   * rewrite, a chat created or deleted) is checkpointed before this returns,
   * so committed rows are always read from the files; metadata and active
   * rows stay journaled until a later checkpoint.
   *
   * With `group`, the record is admitted for group commit instead: it shares
   * one append and one sync with the records admitted while a sync is in
   * flight. A record that stays journaled returns at once with `durable`;
   * one that must be checkpointed waits for its batch here, then checkpoints,
   * as before. A commit with publish hooks is always written alone, so its
   * check stays at the write boundary.
   */
  private async commitToJournal(
    journal: ChatDeltaJournalWriter,
    baseRevision: number,
    next: ChatStorageIndexes,
    writes: readonly DeltaJournalWrite[],
    mutationId: string,
    created: CreatedArtifacts,
    options: V2MutationOptions,
    group: boolean,
  ): Promise<{ indexes: ChatStorageIndexes; durable?: Promise<void> }> {
    const startedAt = performance.now();
    const input = {
      expectedRevision: baseRevision,
      next,
      writes,
      mutationIds: [mutationId],
      created,
    };
    const recordCommit = (): void =>
      recordChatStorageCommit({
        scopeDirectory: this.store.directory,
        durationMs: performance.now() - startedAt,
        queueWaitMs: 0,
      });
    if (!group || options.preparePublish || options.beforePublish) {
      const result = await journal.commit({
        ...input,
        ...(options.preparePublish
          ? { preparePublish: options.preparePublish }
          : {}),
        ...(options.beforePublish
          ? { beforePublish: options.beforePublish }
          : {}),
      });
      if (!result.applied)
        throw new Error('Delta journal already holds this mutation');
      recordCommit();
      if (options.checkpoint === true || journal.hasCommittedRowChanges())
        return { indexes: await this.checkpointJournal(journal) };
      return { indexes: await this.projectedIndexes(journal) };
    }
    const admitted = await journal.admit(input);
    if (!admitted.result.applied)
      throw new Error('Delta journal already holds this mutation');
    if (options.checkpoint === true || journal.hasCommittedRowChanges()) {
      // A checkpoint applies records the journal holds durably.
      await admitted.durable;
      recordCommit();
      return { indexes: await this.checkpointJournal(journal) };
    }
    const indexes = await this.projectedIndexes(journal);
    return { indexes, durable: admitted.durable.then(recordCommit) };
  }

  private async writes(
    current: ChatStorageIndexes,
    next: ChatStorageIndexes,
    deltas: Map<string, Delta>,
    created: CreatedArtifacts,
    previousActive?: Map<string, PersistedChatMessage[]>,
    forms?: JournalWriteForms,
    fullRewrites?: ChatTranscriptFullRewrite[],
    currentMessagesByChatId?: ReadonlyMap<
      string,
      ReadonlyMap<string, PersistedChatMessage>
    >,
  ): Promise<ChatTranscriptWrite[]> {
    const previous = new Map(allEntries(current).map((tab) => [tab.id, tab]));
    const remaining = new Map(allEntries(next).map((tab) => [tab.id, tab]));
    const writes: ChatTranscriptWrite[] = [];
    for (const id of Array.from(previous.keys()))
      if (!remaining.has(id)) writes.push({ chatId: id, kind: 'delete' });
    for (const id of Array.from(remaining.keys())) {
      const change = deltas.get(id);
      const old = previous.get(id);
      if (!change && old) continue;
      if (change?.artifactSource) {
        for (const message of [
          ...(change.replacement ?? []),
          ...Array.from(change.upserts.values()),
        ]) {
          for (const block of message.blocks) {
            for (const ref of storedArtifactRefsOf(block))
              await this.storage.transcripts.artifacts.copyArtifactToChat(
                change.artifactSource,
                id,
                ref,
                this.storage.transcripts.artifacts,
                created,
              );
            // A card's child transcript lives beside the transcript, not in
            // it: a copy of the chat (a fork) carries the run's delegate log.
            if (
              block.type === 'delegated_agent_call' &&
              block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG
            )
              await this.storage.transcripts.delegations.copyRun(
                change.artifactSource,
                id,
                block,
                this.storage.transcripts.delegations,
                created,
              );
          }
        }
      }
      const isActive = ACTIVE.has(
        next.live.runtimeByChatId[id]?.status ?? 'idle',
      );
      const existingMessages = currentMessagesByChatId?.get(id);
      if (change?.replacement) {
        const rows = new Map<string, PersistedChatMessage>();
        for (const message of change.replacement)
          rows.set(
            message.id,
            preserveVisualReferences(
              existingMessages?.get(message.id),
              message,
            ),
          );
        if (rows.size !== change.replacement.length)
          throw new Error('Duplicate replacement message id');
        for (const message of Array.from(change.upserts.values()))
          rows.set(
            message.id,
            preserveVisualReferences(
              existingMessages?.get(message.id),
              message,
            ),
          );
        for (const removed of Array.from(change.removed)) rows.delete(removed);
        writes.push({
          chatId: id,
          kind: 'replace',
          messages: Array.from(rows.values()),
          ...(isActive ? { activeTailCount: rows.size } : {}),
        });
        continue;
      }
      const active = old
        ? await this.storage.transcripts.activeMessages(id)
        : [];
      previousActive?.set(id, active);
      const mutable = new Map(active.map((message) => [message.id, message]));
      const patches = new Map<string, PersistedChatMessage>();
      const removed = change?.removed ?? new Set<string>();
      const changedActive = new Set<string>();
      // Positions apply only to rows this write adds; stored rows keep theirs.
      const added = new Set<string>();
      let rewrite = false;
      let removedFromActive = false;
      let removedCommittedRows = 0;
      let changed = !old;
      for (const message of Array.from(change?.upserts.values() ?? [])) {
        const preserved = preserveVisualReferences(
          existingMessages?.get(message.id),
          message,
        );
        const stored = await this.storage.transcripts.artifacts.externalize(
          id,
          preserved,
          created,
        );
        if (mutable.has(stored.id)) {
          mutable.set(stored.id, stored);
          changedActive.add(stored.id);
          changed = true;
          continue;
        }
        const status = old
          ? await this.storage.transcripts.committedMessageState(id, stored)
          : 'absent';
        if (status === 'identical') continue;
        changed = true;
        if (status === 'different') {
          patches.set(stored.id, stored);
          rewrite = true;
        } else {
          mutable.set(stored.id, stored);
          changedActive.add(stored.id);
          added.add(stored.id);
        }
      }
      for (const messageId of Array.from(removed)) {
        const removedActiveMessage = mutable.delete(messageId);
        const removedFromCommitted = old
          ? await this.storage.transcripts.hasCommittedMessage(id, messageId)
          : false;
        if (removedActiveMessage) removedFromActive = true;
        if (removedActiveMessage || removedFromCommitted) changed = true;
        if (removedFromCommitted) {
          rewrite = true;
          removedCommittedRows += 1;
        }
      }
      const committedInsertions = new Map<string, PersistedChatMessage[]>();
      const committedInsertionIds = new Set<string>();
      for (const [messageId, afterMessageId] of Array.from(
        change?.insertions ?? [],
      )) {
        if (!added.has(messageId)) {
          change?.insertions.delete(messageId);
          continue;
        }
        const inserted = mutable.get(messageId);
        if (!inserted || messageId === afterMessageId)
          throw new Error(
            `Invalid positioned message insertion ${messageId} after ${afterMessageId}`,
          );
        if (mutable.has(afterMessageId)) {
          const ordered = Array.from(mutable.values()).filter(
            (message) => message.id !== messageId,
          );
          const anchorIndex = ordered.findIndex(
            (message) => message.id === afterMessageId,
          );
          let insertAt = anchorIndex + 1;
          while (
            insertAt < ordered.length &&
            ordered[insertAt]?.parentBlockId === afterMessageId
          )
            insertAt += 1;
          ordered.splice(insertAt, 0, inserted);
          mutable.clear();
          for (const message of ordered) mutable.set(message.id, message);
        } else if (
          committedInsertionIds.has(afterMessageId) ||
          (old &&
            (await this.storage.transcripts.hasCommittedMessage(
              id,
              afterMessageId,
            )))
        ) {
          mutable.delete(messageId);
          const siblings = committedInsertions.get(afterMessageId) ?? [];
          siblings.push(inserted);
          committedInsertions.set(afterMessageId, siblings);
          committedInsertionIds.add(messageId);
          rewrite = true;
        } else {
          throw new Error(
            `Positioned message anchor is missing: ${afterMessageId}`,
          );
        }
      }
      const tail = Array.from(mutable.values());
      const firstMutable = isActive
        ? tail.findIndex((message) => message.role !== 'user')
        : -1;
      const committedPrefixCount = isActive
        ? firstMutable === -1
          ? tail.length
          : firstMutable
        : tail.length;
      const activeTailCount = isActive ? tail.length - committedPrefixCount : 0;
      const mixedCommittedAndActive =
        committedPrefixCount > 0 && activeTailCount > 0;
      const canReplaceOnlyActive =
        removedFromActive &&
        ((isActive && committedPrefixCount === 0) || tail.length === 0);
      if (removedFromActive && !canReplaceOnlyActive) rewrite = true;
      if (rewrite || mixedCommittedAndActive) {
        const committed = old?.transcript;
        if (committed && committed.committedMessageCount > 0)
          fullRewrites?.push({
            chatId: id,
            reason:
              patches.size > 0 ? 'patch' : rewrite ? 'removal' : 'mixed_active',
            committedRows: committed.committedMessageCount,
            committedBytes: committed.committedByteLength,
            patchedRows: patches.size,
            removedRows: removedCommittedRows,
            patchedBlockTypes: Array.from(patches.values()).flatMap((message) =>
              message.blocks.map((block) => block.type),
            ),
            activeTail: isActive,
          });
        const transcript = this.storage.transcripts;
        const insertedAfter = (anchorId: string): PersistedChatMessage[] => {
          const rows: PersistedChatMessage[] = [];
          const collect = (id: string): void => {
            for (const inserted of committedInsertions.get(id) ?? []) {
              rows.push(inserted);
              collect(inserted.id);
            }
          };
          collect(anchorId);
          return rows;
        };
        if (old)
          forms?.patches.set(id, {
            patches: Array.from(patches.values()),
            removedMessageIds: Array.from(removed),
            tail,
            activeTailCount,
          });
        writes.push({
          chatId: id,
          kind: 'replace',
          ...(isActive ? { activeTailCount } : {}),
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            let pendingGroup: string | undefined;
            if (old)
              for await (const message of transcript.iterate(id)) {
                if (pendingGroup && message.parentBlockId !== pendingGroup) {
                  yield* insertedAfter(pendingGroup);
                  pendingGroup = undefined;
                }
                if (!removed.has(message.id)) {
                  yield patches.get(message.id) ?? message;
                  if (committedInsertions.has(message.id))
                    pendingGroup = message.id;
                }
              }
            if (pendingGroup) yield* insertedAfter(pendingGroup);
            yield* tail;
          })(),
        });
      } else if (changed || (!isActive && active.length)) {
        if (old)
          forms?.active.set(id, {
            previous: active,
            next: tail,
            changed: changedActive,
          });
        writes.push({
          chatId: id,
          kind: canReplaceOnlyActive
            ? 'active-replace'
            : isActive && committedPrefixCount === 0
              ? 'active'
              : 'append',
          messages: tail,
        });
      }
    }
    return writes;
  }
}
import { normalizeLegacyPersistedChatTab } from '@canopy/desktop-shared/persisted-chat-state';
