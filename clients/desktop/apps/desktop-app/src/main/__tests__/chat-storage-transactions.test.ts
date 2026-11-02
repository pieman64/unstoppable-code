import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { Buffer } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatStorageTransactions,
  type ChatStorageIndexes,
  type ChatStorageTransactionsOptions,
  type ChatTranscriptWrite,
} from '../lib/chat-storage-transactions';
import {
  ChatTranscriptLog,
  type TranscriptDescriptor,
} from '../lib/chat-transcript-log';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { isRecord } from '../lib/type-guards';
import * as directorySync from '../lib/fsync-directory';
import * as cooperativeJson from '../lib/cooperative-json';
import type * as FsPromises from 'node:fs/promises';
import { DELTA_JOURNAL_V2_FILE_NAME } from '../lib/chat-delta-journal/format';
import {
  activeSidecarMessageRecordBytes,
  type ActiveRowAnchor,
  type ActiveSidecarMessageRecord,
} from '../lib/chat-transcript-live-positions';
import { MAX_TRANSCRIPT_ROW_BYTES } from '../lib/chat-transcript-prefix-replace';
import { isPersistedChatMessage } from '../lib/persisted-chat-message-validation';
import {
  indexChecksum as frozenBaselineIndexChecksum,
  isSparseIndexWithChecksum as isFrozenBaselineSparseIndex,
} from './fixtures/active-anchor-golden/sparse-index-validator.baseline-339153a';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');
const ACTIVE_ANCHOR_GOLDEN_DIRECTORY = join(
  __dirname,
  'fixtures',
  'active-anchor-golden',
);
const FROZEN_BASELINE_TRANSACTION_SHA256 =
  'f71268cecbd77aa6cccc33f39f4417b8497533fb7d0005ae42ba5cf97b3395fc';
const FROZEN_BASELINE_TRANSCRIPT_LOG_SHA256 =
  'ce2bc15a62b8fc2acdad03cece60a877e9e0ce1f5cea3dd811c79f3555a78905';
const FROZEN_BASELINE_INDEX_VALIDATOR_SHA256 =
  'a115652b2d8db997f16967a67bdf36d791c4bfd5f028228f5543128e1384f90b';

interface FrozenBaselineTranscriptLogInstance {
  activeMessages(chatId: string): Promise<PersistedChatMessage[]>;
  descriptor(chatId: string): Promise<TranscriptDescriptor>;
  initialize(chatId: string): Promise<void>;
  page(chatId: string): Promise<{ messages: PersistedChatMessage[] }>;
  append(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void>;
  capturePreview(
    chatId: string,
    canonical: TranscriptDescriptor,
  ): Promise<{
    descriptor: TranscriptDescriptor;
    messages(): AsyncGenerator<PersistedChatMessage>;
    close(): Promise<void>;
  }>;
  artifactReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
    expected?: TranscriptDescriptor,
  ): Promise<{
    identity: string;
    nextOffset: number;
    complete: boolean;
    scannedBytes: number;
    artifactIds: string[];
  }>;
  artifactActiveReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
  ): Promise<{
    identity: string;
    nextOffset: number;
    complete: boolean;
    scannedBytes: number;
    artifactIds: string[];
    activeHeaderFinalizing?: boolean;
    activeFinalizingRows: number;
  }>;
  remove(chatId: string): Promise<void>;
  writeActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void>;
}

interface FrozenBaselineTranscriptLogExports {
  ChatTranscriptLog: new (
    root: string,
    onAppendBoundary?: (boundary: string) => Promise<void>,
  ) => FrozenBaselineTranscriptLogInstance;
}

interface FrozenBaselineTransactionInstance {
  transcripts: FrozenBaselineTranscriptLogInstance;
  load(): Promise<ChatStorageIndexes>;
  commit(
    expectedRevision: number,
    next: ChatStorageIndexes,
    writes: readonly ChatTranscriptWrite[],
  ): Promise<ChatStorageIndexes>;
}

interface FrozenBaselineTransactionExports {
  ChatStorageTransactions: new (
    store: ChatStorageV2,
  ) => FrozenBaselineTransactionInstance;
}

function isFrozenBaselineTranscriptLogExports(
  value: unknown,
): value is FrozenBaselineTranscriptLogExports {
  return isRecord(value) && typeof value.ChatTranscriptLog === 'function';
}

function isFrozenBaselineTransactionExports(
  value: unknown,
): value is FrozenBaselineTransactionExports {
  return isRecord(value) && typeof value.ChatStorageTransactions === 'function';
}

/** Execute the whole unchanged baseline chat-transcript-log.ts source. */
async function loadFrozenBaselineTranscriptLog(): Promise<FrozenBaselineTranscriptLogExports> {
  const source = await readFile(
    join(
      ACTIVE_ANCHOR_GOLDEN_DIRECTORY,
      'chat-transcript-log.baseline-339153a.ts.txt',
    ),
    'utf8',
  );
  const sourceHash = createHash('sha256').update(source).digest('hex');
  if (sourceHash !== FROZEN_BASELINE_TRANSCRIPT_LOG_SHA256)
    throw new Error('Frozen baseline transcript log source hash mismatch');
  const compiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  });
  const baselineModule: { exports: Record<string, unknown> } = {
    exports: {},
  };
  runInNewContext(compiled.outputText, {
    exports: baselineModule.exports,
    module: baselineModule,
    Buffer,
    AbortController,
    TextDecoder,
    TextEncoder,
    structuredClone,
    require: (specifier: string): unknown =>
      jest.requireActual(
        specifier.startsWith('./') ? `../lib/${specifier.slice(2)}` : specifier,
      ),
  });
  if (!isFrozenBaselineTranscriptLogExports(baselineModule.exports))
    throw new Error('Frozen baseline transcript log module did not load');
  return baselineModule.exports;
}

/**
 * Execute the complete, source-frozen baseline transaction module. Its
 * transaction and log implementations are frozen to their baseline source;
 * unrelated relative imports are bound to current shared dependencies.
 */
async function loadFrozenBaselineTransaction(
  store: ChatStorageV2,
): Promise<FrozenBaselineTransactionInstance> {
  const sourcePath = join(
    ACTIVE_ANCHOR_GOLDEN_DIRECTORY,
    'chat-storage-transactions.baseline-339153a.ts.txt',
  );
  const source = await readFile(sourcePath, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  if (sourceHash !== FROZEN_BASELINE_TRANSACTION_SHA256)
    throw new Error('Frozen baseline transaction source hash mismatch');
  const compiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  });
  const baselineModule: { exports: Record<string, unknown> } = {
    exports: {},
  };
  const frozenTranscriptLog = await loadFrozenBaselineTranscriptLog();
  runInNewContext(compiled.outputText, {
    exports: baselineModule.exports,
    module: baselineModule,
    require: (specifier: string): unknown => {
      if (specifier === './chat-transcript-log') return frozenTranscriptLog;
      return jest.requireActual(
        specifier.startsWith('./') ? `../lib/${specifier.slice(2)}` : specifier,
      );
    },
  });
  if (!isFrozenBaselineTransactionExports(baselineModule.exports))
    throw new Error('Frozen baseline transaction module did not load');
  return new baselineModule.exports.ChatStorageTransactions(store);
}

async function recoverWithFrozenBaselineTransaction(
  store: ChatStorageV2,
): Promise<{
  indexes: ChatStorageIndexes;
  transcripts: FrozenBaselineTranscriptLogInstance;
}> {
  const transaction = await loadFrozenBaselineTransaction(store);
  const indexes = await transaction.load();
  return { indexes, transcripts: transaction.transcripts };
}

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text: id }],
});

/**
 * Observe the real transcript lookup path while a commit validates admission.
 * Reflection lets this test observe the upcoming transcript API without
 * replacing its implementation or adding a source-level dependency on it.
 */
function observeAdmissionLookups(
  transaction: ChatStorageTransactions,
  isAdmission: () => boolean,
): {
  scopeChatIds: string[];
  loadedChatIds: string[];
  locatedMessageIds: string[];
  loadsInScope: number[];
  restore(): void;
} {
  const scopeChatIds: string[] = [];
  const loadedChatIds: string[] = [];
  const locatedMessageIds: string[] = [];
  const loadsInScope: number[] = [];
  const firstPrototype = Reflect.getPrototypeOf(transaction.transcripts);
  if (firstPrototype === null)
    throw new Error('Transcript prototype is missing');
  // The log's methods may live on a shared base store's prototype.
  const ownerOf = (name: string): object => {
    for (
      let candidate: object | null = firstPrototype;
      candidate !== null;
      candidate = Reflect.getPrototypeOf(candidate)
    )
      if (Object.getOwnPropertyDescriptor(candidate, name)) return candidate;
    return firstPrototype;
  };
  const descriptors = new Map<string, [object, PropertyDescriptor]>();
  let insideScope = false;
  let scopedLoads = 0;
  type ReflectedMethod = (this: unknown, ...args: unknown[]) => unknown;

  const wrap = (
    name: string,
    replacement: (invoke: ReflectedMethod) => ReflectedMethod,
  ): void => {
    const prototype = ownerOf(name);
    const original: unknown = Reflect.get(prototype, name);
    if (typeof original !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor) return;
    descriptors.set(name, [prototype, descriptor]);
    const invoke: ReflectedMethod = function (
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    };
    Reflect.set(prototype, name, replacement(invoke));
  };

  wrap(
    'load',
    (invoke) =>
      function (this: unknown, ...args: unknown[]): unknown {
        if (isAdmission() && typeof args[0] === 'string') {
          loadedChatIds.push(args[0]);
          if (insideScope) scopedLoads += 1;
        }
        return Reflect.apply(invoke, this, args);
      },
  );
  wrap(
    'readCommittedMessage',
    (invoke) =>
      function (this: unknown, ...args: unknown[]): unknown {
        if (
          isAdmission() &&
          typeof args[0] === 'string' &&
          typeof args[1] === 'string'
        )
          locatedMessageIds.push(args[1]);
        return Reflect.apply(invoke, this, args);
      },
  );
  wrap(
    'withCommittedMessageStates',
    (invoke) =>
      async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        const observedScope =
          isAdmission() && typeof args[0] === 'string' ? args[0] : undefined;
        const observesScope = observedScope !== undefined;
        if (observesScope) {
          scopeChatIds.push(observedScope);
          scopedLoads = 0;
          insideScope = true;
        }
        try {
          return await Reflect.apply(invoke, this, args);
        } finally {
          if (observesScope) {
            insideScope = false;
            loadsInScope.push(scopedLoads);
          }
        }
      },
  );

  return {
    scopeChatIds,
    loadedChatIds,
    locatedMessageIds,
    loadsInScope,
    restore(): void {
      descriptors.forEach(
        (
          [prototype, descriptor]: [object, PropertyDescriptor],
          name: string,
        ): void => {
          Object.defineProperty(prototype, name, descriptor);
        },
      );
    },
  };
}

function transactionWithAdmissionTrace(
  store: ChatStorageV2,
  options: ChatStorageTransactionsOptions = {},
): {
  transaction: ChatStorageTransactions;
  observations: ReturnType<typeof observeAdmissionLookups>;
  restore(): void;
} {
  let validatingAdmission = false;
  const transaction = new ChatStorageTransactions(
    store,
    (point) => {
      if (point === 'prepared') validatingAdmission = true;
      if (point === 'journal') validatingAdmission = false;
      return Promise.resolve();
    },
    options,
  );
  const observations = observeAdmissionLookups(
    transaction,
    () => validatingAdmission,
  );
  return {
    transaction,
    observations,
    restore(): void {
      validatingAdmission = false;
      observations.restore();
    },
  };
}

async function* rows(
  messages: PersistedChatMessage[],
): AsyncGenerator<PersistedChatMessage> {
  for (const message of messages) yield await Promise.resolve(message);
}
const toolMessage = (id: string, output: string): PersistedChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  blocks: [
    {
      type: 'tool_result',
      toolUseId: `${id}-tool`,
      toolName: 'shell',
      output,
      isError: false,
    },
  ],
});
/** Spied fs calls receive paths as strings here; handles are not locators. */
const pathText = (path: unknown): string =>
  typeof path === 'string' ? path : '';
const artifactName = (output: string): string =>
  `sha256-v1-${createHash('sha256').update(output, 'utf8').digest('hex')}.txt`;

function activeAnchor(
  runId: string,
  after: string | null,
  tie = 0,
): ActiveRowAnchor {
  return { version: 1, runId, after, tie };
}

function anchorTuple(
  id: string,
  anchor: ActiveRowAnchor,
): [string, ActiveRowAnchor] {
  return [id, anchor];
}

function delegatedCard(delegationId: string): PersistedChatMessage {
  const event: AgentDelegationTranscript = {
    delegationId,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'parent-harness',
    parentTurnId: 'a',
    parentToolCallId: 'parent-tool-call',
    createdAt: 2,
    task: {
      description: 'A deterministic delegated task',
      prompt: 'Return a deterministic result.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      runGeneration: 1,
      requestedModelId: 'test-model',
      status: 'pending',
      outputTruncated: false,
    },
    transcript: [],
  };
  const card = delegationTranscriptMessages(event)[0];
  if (!card) throw new Error('Missing generated delegation card');
  if (!isPersistedChatMessage(card))
    throw new Error(`Invalid generated card: ${JSON.stringify(card)}`);
  return card;
}

function delegatedChild(id: string, runId: string): PersistedChatMessage {
  return {
    ...message(id),
    parentBlockId: runId,
  };
}

/** Seed the anchor-bearing v2 JSONL sidecar without using the new log API. */
async function seedActiveSidecar(
  store: ChatStorageV2,
  chatId: string,
  messages: readonly {
    message: PersistedChatMessage;
    anchor?: unknown;
    finalizing?: true;
  }[],
  transcriptRevision: number,
): Promise<void> {
  const header = {
    version: 2,
    transcriptRevision,
    updatedAt: '2026-10-08T12:00:00.000Z',
  };
  const records: Record<string, unknown>[] = messages.map((row) => ({
    version: 2,
    kind: 'message',
    message: row.message,
    ...(row.anchor !== undefined ? { anchor: row.anchor } : {}),
    ...(row.finalizing ? { finalizing: true } : {}),
  }));
  await writeFile(
    join(store.directory, 'transcripts', `${chatId}.active.json`),
    `${[header, ...records].map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

async function commitDelegationCard(
  transaction: ChatStorageTransactions,
  card: PersistedChatMessage,
): Promise<void> {
  const next = await transaction.load();
  const revision = next.live.revision;
  next.live.revision = revision + 1;
  next.archive.revision = revision + 1;
  await transaction.commit(revision, next, [
    { chatId: 'chat', kind: 'append', messages: [message('a'), card] },
  ]);
}

function parseActiveSidecarRecords(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split('\n').filter(Boolean).slice(1)) {
    const parsed: unknown = JSON.parse(line);
    records.push(parsed);
  }
  return records;
}

async function activeSidecarAnchor(
  store: ChatStorageV2,
  chatId: string,
  messageId: string,
): Promise<unknown> {
  const text = await readFile(
    join(store.directory, 'transcripts', `${chatId}.active.json`),
    'utf8',
  );
  for (const record of parseActiveSidecarRecords(text))
    if (
      isRecord(record) &&
      isRecord(record.message) &&
      record.message.id === messageId
    )
      return record.anchor;
  return undefined;
}

function exactBudgetMessage(
  id: string,
  anchor: ActiveRowAnchor,
  finalizing: boolean,
  ceiling: number,
): PersistedChatMessage {
  const baseMessage = message(id);
  const base: ActiveSidecarMessageRecord = {
    version: 2,
    kind: 'message',
    message: { ...baseMessage, blocks: [{ type: 'text', text: '' }] },
    anchor,
    ...(finalizing ? { finalizing: true } : {}),
  };
  let fillerLength = ceiling - activeSidecarMessageRecordBytes(base);
  if (fillerLength < 0) throw new Error('Active sidecar base exceeds ceiling');
  let candidate: PersistedChatMessage = {
    ...baseMessage,
    parentBlockId: anchor.runId,
    blocks: [{ type: 'text', text: 'x'.repeat(fillerLength) }],
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: ActiveSidecarMessageRecord = {
      version: 2,
      kind: 'message',
      message: candidate,
      anchor,
      ...(finalizing ? { finalizing: true } : {}),
    };
    const delta = ceiling - activeSidecarMessageRecordBytes(record);
    if (delta === 0) return candidate;
    fillerLength += delta;
    candidate = {
      ...baseMessage,
      parentBlockId: anchor.runId,
      blocks: [{ type: 'text', text: 'x'.repeat(fillerLength) }],
    };
  }
  return candidate;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('v2 scope transactions', () => {
  let root: string;
  let store: ChatStorageV2;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-transaction-'));
    store = new ChatStorageV2(root, 'scope');
    await store.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: { id: 'chat', title: 'Chat', createdAt: '2026-09-05' },
            messages: rows([message('a')]),
          });
        })(),
      }),
    );
  });

  it('defers maintenance when a format-4 journal has uncheckpointed records', async () => {
    const transactions = new ChatStorageTransactions(store);
    jest
      .spyOn(store, 'journalFile')
      .mockResolvedValue(DELTA_JOURNAL_V2_FILE_NAME);
    transactions.setDeltaJournalClear(() => false);
    expect(await transactions.journalIsClear()).toBe(false);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }, 30_000); // Full transaction fixtures include a disk-backed 300-row history.

  it('publishes a metadata-only commit without staging a transcript directory or syncing each index separately', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Runtime metadata';
    next.live.revision = next.archive.revision = 1;
    const syncDirectory = directorySync.fsyncDirectory;
    const synced: string[] = [];
    jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        synced.push(directory);
        await syncDirectory(directory);
      });

    await transaction.commit(0, next, []);

    expect(
      synced.filter((directory) => directory === store.directory),
    ).toHaveLength(3);
    expect(
      synced.some((directory) => directory.includes('pending-transcripts')),
    ).toBe(false);
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Runtime metadata');
  });

  it('loads admission state once while streaming payload and omitted-active checks', async () => {
    const traced = transactionWithAdmissionTrace(store, {
      retainedPayloadBytes: 0,
    });
    const { transaction, observations } = traced;
    try {
      // The active row is already committed. A complete-empty append may omit
      // it only after admission confirms its committed state.
      await seedActiveSidecar(store, 'chat', [{ message: message('a') }], 1);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;

      const committed = await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: rows([message('b'), message('c')]),
          activeTailCount: 0,
        },
      ]);

      // One active snapshot and one admission scope load. The two new payload
      // identities are answered from the complete inventory; the committed
      // omitted active row still gets its digest-checked locator read.
      expect(committed.live.revision).toBe(1);
      expect(committed.archive.revision).toBe(1);
      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
        message('b'),
        message('c'),
      ]);
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([]);
      expect(observations.loadedChatIds).toEqual(['chat', 'chat']);
      expect(observations.scopeChatIds).toEqual(['chat']);
      expect(observations.loadsInScope).toEqual([1]);
      expect(observations.locatedMessageIds).toEqual(['a']);
    } finally {
      traced.restore();
    }
  });

  it('keeps conflicting committed-message rejection inside the one admission scope', async () => {
    const traced = transactionWithAdmissionTrace(store, {
      retainedPayloadBytes: 0,
    });
    const { transaction, observations } = traced;
    const conflicting = {
      ...message('a'),
      blocks: [{ type: 'text' as const, text: 'conflicting content' }],
    };
    try {
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;

      await expect(
        transaction.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: [conflicting] },
        ]),
      ).rejects.toThrow('Conflicting committed message a');
      traced.restore();

      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect((await transaction.load()).live.revision).toBe(0);
      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
      ]);
      expect(observations.scopeChatIds).toEqual(['chat']);
      expect(observations.loadsInScope).toEqual([1]);
      expect(observations.locatedMessageIds).toEqual(['a']);
    } finally {
      traced.restore();
    }
  });

  it('keeps uncommitted active rows from being discarded by an empty append suffix', async () => {
    const traced = transactionWithAdmissionTrace(store, {
      retainedPayloadBytes: 0,
    });
    const { transaction, observations } = traced;
    try {
      await transaction.transcripts.writeActive('chat', [message('pending')]);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;

      await expect(
        transaction.commit(0, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: rows([message('b')]),
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow('Active update would discard uncommitted messages');
      traced.restore();

      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect((await transaction.load()).live.revision).toBe(0);
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([
        message('pending'),
      ]);
      expect(observations.loadedChatIds).toEqual(['chat', 'chat']);
      expect(observations.scopeChatIds).toEqual(['chat']);
      expect(observations.loadsInScope).toEqual([1]);
      expect(observations.locatedMessageIds).toEqual([]);
    } finally {
      traced.restore();
    }
  });

  it('does not remove temporary files that were already renamed into place', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Renamed';
    next.live.revision = next.archive.revision = 1;
    const removeFile = fsPromises.rm;
    const removedTemporaries: string[] = [];
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (String(path).endsWith('.tmp')) removedTemporaries.push(String(path));
      await removeFile(path, options);
    });

    await transaction.commit(0, next, []);

    // Each successful atomic write used to end with an `rm` of a path its own
    // rename had already consumed: one failed `lstat` and one ENOENT error per
    // index and journal write on every commit.
    expect(removedTemporaries).toEqual([]);
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Renamed');
  });

  it('returns the committed index snapshot without rereading every index file', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Committed snapshot';
    next.live.revision = next.archive.revision = 1;
    const indexes = jest.spyOn(store, 'indexes');
    const summary = jest.spyOn(store, 'committedIndexSummary');

    const committed = await transaction.commit(0, next, []);

    // The loaded indexes are unchanged on disk, so the commit checks them
    // from memory instead of reading the files back.
    expect(indexes).not.toHaveBeenCalled();
    expect(summary).toHaveBeenCalledTimes(1);
    expect(committed.live.tabs[0].title).toBe('Committed snapshot');
    committed.live.tabs[0].title = 'Caller mutation';
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Committed snapshot');
  });

  it.each([
    {
      label: 'runtime map',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.live, 'runtimeByChatId', []);
      },
      error: 'Invalid v2 chat indexes',
    },
    {
      label: 'recovery ids',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.recovery, 'mutationIds', [42]);
      },
      error: 'Invalid v2 recovery metadata',
    },
    {
      label: 'transcript descriptor',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.live.tabs[0].transcript, 'format', 'invalid');
      },
      error: 'Invalid or duplicate chat index entry',
    },
  ])(
    'rejects a malformed $label index after publication validation',
    async ({ corrupt, error }) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      corrupt(next);
      await expect(transaction.commit(0, next, [])).rejects.toThrow(error);
    },
  );

  it.each(['numeric', 'missing'] as const)(
    'rejects a %s tab ID before publishing an index',
    async (kind) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      next.live.activeTabId = '';
      if (kind === 'numeric') Reflect.set(next.live.tabs[0], 'id', 123);
      else Reflect.deleteProperty(next.live.tabs[0], 'id');

      await expect(transaction.commit(0, next, [])).rejects.toThrow(
        /index entry/,
      );
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect((await store.indexes()).live.tabs[0].id).toBe('chat');
    },
  );

  it('removes an old metadata-only WAL payload directory during recovery', async () => {
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.revision = next.archive.revision = 1;
    await expect(interrupted.commit(0, next, [])).rejects.toThrow('interrupt');
    const pending: unknown = JSON.parse(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    );
    if (!isRecord(pending) || typeof pending.transactionId !== 'string')
      throw new Error('Missing pending transaction');
    const directory = join(
      store.directory,
      'pending-transcripts',
      pending.transactionId,
    );
    await mkdir(directory, { recursive: true });

    expect(
      (await new ChatStorageTransactions(store).load()).live.revision,
    ).toBe(1);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains replay payloads when the published journal directory sync fails', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    const sync = directorySync.fsyncDirectory;
    let injected = false;
    jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (
          !injected &&
          directory === store.directory &&
          (
            await readFile(join(directory, 'metadata-journal.jsonl'), 'utf8')
          ).trim()
        ) {
          injected = true;
          throw new Error('journal directory sync failed');
        }
        await sync(directory);
      });
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: [message('b')] },
      ]),
    ).rejects.toThrow('journal directory sync failed');
    expect(injected).toBe(true);

    const recovered = new ChatStorageTransactions(store);
    await expect(recovered.load()).resolves.toMatchObject({
      live: { revision: 1 },
    });
    expect((await recovered.transcripts.page('chat')).messages).toEqual([
      message('a'),
      message('b'),
    ]);
    await recovered.load();
    expect((await recovered.transcripts.page('chat')).messages).toHaveLength(2);
  });

  it('checks authorization after preparing the atomic journal write', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    let authorized = true;
    let authorityRefreshed = false;
    const writeValues = cooperativeJson.writeJsonValuesCooperatively;
    jest
      .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
      .mockImplementation(async (path, values, options) => {
        const bytesWritten = await writeValues(path, values, options);
        if (path.includes('metadata-journal.jsonl.')) authorized = false;
        return bytesWritten;
      });

    await expect(
      transaction.commit(
        0,
        next,
        [{ chatId: 'chat', kind: 'append', messages: [message('b')] }],
        undefined,
        () => {
          expect(authorityRefreshed).toBe(true);
          if (!authorized) throw new Error('approval changed during write');
        },
        () => {
          expect(authorized).toBe(false);
          authorityRefreshed = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow('approval changed during write');
    expect((await transaction.load()).live.revision).toBe(0);
    expect((await transaction.transcripts.page('chat')).messages).toEqual([
      message('a'),
    ]);
  });

  describe('artifacts of a commit that fails before publication', () => {
    const committedOutput = 'committed output 🌲\n'.repeat(8000);
    let artifactDirectory: string;
    beforeEach(async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('b', committedOutput)],
        },
      ]);
      artifactDirectory = join(
        store.directory,
        'transcripts',
        'tool-output',
        'chat',
      );
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
    });
    const failBeforePublication = async (
      output: string,
    ): Promise<ChatStorageTransactions> => {
      const failing = new ChatStorageTransactions(store, (point) =>
        point === 'prepared'
          ? Promise.reject(new Error('interrupt'))
          : Promise.resolve(),
      );
      const next = await failing.load();
      next.live.revision = next.archive.revision = 2;
      await expect(
        failing.commit(1, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [toolMessage('c', output)],
          },
        ]),
      ).rejects.toThrow('interrupt');
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      return failing;
    };
    const committedReference = async (
      transaction: ChatStorageTransactions,
    ): Promise<void> => {
      const page = await transaction.transcripts.page('chat');
      expect(page.messages.map((message) => message.id)).toEqual(['a', 'b']);
      const block = page.messages[1].blocks[0];
      if (block.type !== 'tool_result' || !block.fullOutputRef)
        throw new Error('Missing committed artifact reference');
      await transaction.transcripts.artifacts.verify(
        'chat',
        block.fullOutputRef,
      );
      expect(
        (
          await transaction.transcripts.artifacts.readRange(
            'chat',
            block.fullOutputRef,
          )
        ).text,
      ).toContain('committed output 🌲');
    };

    it('removes exactly the artifacts the failed commit created', async () => {
      const failing = await failBeforePublication(
        'orphan output 🌲\n'.repeat(8000),
      );
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
      await committedReference(failing);
      expect(
        (await new ChatStorageTransactions(store).load()).live.revision,
      ).toBe(1);
    });

    it('keeps an artifact that an earlier committed row already shares', async () => {
      const failing = await failBeforePublication(committedOutput);
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
      await committedReference(failing);
    });
  });

  it.each(['prepared', 'journal', 'transcripts', 'indexes'] as const)(
    'recovers a scope transaction interrupted at %s',
    async (boundary) => {
      const transaction = new ChatStorageTransactions(store, (point) =>
        point === boundary
          ? Promise.reject(new Error('interrupt'))
          : Promise.resolve(),
      );
      const next = await store.indexes();
      next.live.tabs[0].title = 'Changed';
      next.live.revision = next.archive.revision = 1;
      await expect(
        transaction.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
        ]),
      ).rejects.toThrow('interrupt');
      const resumed = new ChatStorageTransactions(store);
      const recovered = await resumed.load();
      expect(recovered.live.revision).toBe(boundary === 'prepared' ? 0 : 1);
      expect(recovered.live.tabs[0].title).toBe(
        boundary === 'prepared' ? 'Chat' : 'Changed',
      );
      expect((await resumed.transcripts.page('chat')).messages).toEqual(
        boundary === 'prepared' ? [message('a')] : [message('a'), message('b')],
      );
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
    },
  );

  it.each([
    'live-index.json',
    'archive-index.json',
    'recovery-index.json',
  ] as const)(
    'replays a durable journal after an interrupted %s rename',
    async (name) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.tabs[0].title = 'Recovered title';
      next.live.revision = next.archive.revision = 1;
      const rename = fsPromises.rename;
      let injected = false;
      const spy = jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (!injected && destination === join(store.directory, name)) {
            injected = true;
            throw new Error('interrupted index rename');
          }
        });
      await expect(transaction.commit(0, next, [])).rejects.toThrow(
        'interrupted index rename',
      );
      expect(injected).toBe(true);
      spy.mockRestore();

      const recovered = await new ChatStorageTransactions(store).load();
      expect(recovered.live.revision).toBe(1);
      expect(recovered.archive.revision).toBe(1);
      expect(recovered.live.tabs[0].title).toBe('Recovered title');
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
    },
  );

  it('replays a durable journal if the shared index directory sync fails', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Recovered after sync';
    next.live.revision = next.archive.revision = 1;
    const rename = fsPromises.rename;
    let indexRenames = 0;
    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (
          ['live-index.json', 'archive-index.json', 'recovery-index.json'].some(
            (name) => destination === join(store.directory, name),
          )
        )
          indexRenames += 1;
      });
    const syncDirectory = directorySync.fsyncDirectory;
    let injected = false;
    const syncSpy = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (!injected && directory === store.directory && indexRenames === 3) {
          injected = true;
          throw new Error('index directory sync failed');
        }
        await syncDirectory(directory);
      });
    await expect(transaction.commit(0, next, [])).rejects.toThrow(
      'index directory sync failed',
    );
    expect(injected).toBe(true);
    renameSpy.mockRestore();
    syncSpy.mockRestore();

    const recovered = await new ChatStorageTransactions(store).load();
    expect(recovered.live.revision).toBe(1);
    expect(recovered.archive.revision).toBe(1);
    expect(recovered.live.tabs[0].title).toBe('Recovered after sync');
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
  });

  it.each(['append', 'active'] as const)(
    'rejects an invalid %s before admitting it into the durable scope journal',
    async (kind) => {
      const transaction = new ChatStorageTransactions(store);
      await transaction.transcripts.writeActive('chat', [message('pending')]);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await expect(
        transaction.commit(0, next, [
          { chatId: 'chat', kind, messages: [message('unrelated')] },
        ]),
      ).rejects.toThrow();
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect(
        (await new ChatStorageTransactions(store).load()).live.revision,
      ).toBe(0);
      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
        message('pending'),
      ]);
    },
  );

  it('admits removal of a non-trailing mutable message as an active replacement', async () => {
    const transaction = new ChatStorageTransactions(store);
    await transaction.transcripts.writeActive('chat', [
      message('pending-first'),
      message('pending-second'),
    ]);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;

    await expect(
      transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'active-replace',
          messages: [message('pending-second')],
        },
      ]),
    ).resolves.toBeDefined();

    expect((await transaction.transcripts.page('chat')).messages).toEqual([
      message('a'),
      message('pending-second'),
    ]);
  });

  it('archives and restores without rewriting the continuous transcript', async () => {
    const transaction = new ChatStorageTransactions(store);
    const original = await readFile(
      join(store.directory, 'transcripts', 'chat.jsonl'),
    );
    const archived = await transaction.load();
    const [tab] = archived.live.tabs;
    archived.live.tabs = [];
    archived.live.activeTabId = '';
    archived.archive.archived = [
      { tab, turnCount: 1, archivedAt: '2026-09-05' },
    ];
    archived.live.revision = archived.archive.revision = 1;
    await transaction.commit(0, archived, []);
    const restored = await transaction.load();
    restored.live.tabs = [restored.archive.archived[0].tab];
    restored.live.activeTabId = 'chat';
    restored.archive.archived = [];
    restored.live.revision = restored.archive.revision = 2;
    await transaction.commit(1, restored, []);
    expect(
      await readFile(join(store.directory, 'transcripts', 'chat.jsonl')),
    ).toEqual(original);
  });

  it.each([
    ['at a row boundary', 2],
    ['to zero bytes', 0],
  ])(
    'fails closed instead of loading a transcript truncated %s',
    async (_label, keep) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: rows([message('b'), message('c'), message('d')]),
        },
      ]);
      const path = join(store.directory, 'transcripts', 'chat.jsonl');
      const lines = (await readFile(path, 'utf8')).split('\n');
      expect(lines.filter(Boolean)).toHaveLength(4);
      await truncate(
        path,
        Buffer.byteLength(lines.slice(0, keep).join('\n') + (keep ? '\n' : '')),
      );
      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        'shorter',
      );
      await expect(
        new ChatStorageTransactions(store).transcripts.page('chat'),
      ).rejects.toThrow('shorter');
      // A rebuilt sparse index must not launder the truncation either.
      await rm(join(store.directory, 'transcripts', 'chat.index.json'));
      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        'shorter',
      );
    },
  );

  it('never recreates a missing existing transcript as empty', async () => {
    await rm(join(store.directory, 'transcripts', 'chat.jsonl'));
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
      ]),
    ).rejects.toThrow();
    await expect(
      readFile(join(store.directory, 'transcripts', 'chat.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // Rejected input must not install an unreplayable scope WAL that prevents
    // metadata work or use of other chats in the same scope.
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
    expect((await transaction.load()).live.revision).toBe(0);
  });

  it('rejects invalid replacement suffixes before durable admission', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: [message('b')],
          activeTailCount: 2,
        },
      ]),
    ).rejects.toThrow('suffix');
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
    expect((await transaction.load()).live.revision).toBe(0);
  });

  it('refuses a stale durable journal instead of rolling newer metadata backward', async () => {
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.revision = next.archive.revision = 1;
    await expect(interrupted.commit(0, next, [])).rejects.toThrow('interrupt');
    const journalPath = join(store.directory, 'metadata-journal.jsonl');
    const staleJournal = await readFile(journalPath, 'utf8');
    const recovered = new ChatStorageTransactions(store);
    const newer = await recovered.load();
    newer.live.revision = newer.archive.revision = 2;
    newer.live.tabs[0].title = 'Newer durable title';
    await recovered.commit(1, newer, []);
    // An old journal restored independently of the newer canonical indexes.
    await writeFile(journalPath, staleJournal);
    await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
      'revision',
    );
    expect((await store.indexes()).live.tabs[0].title).toBe(
      'Newer durable title',
    );
    expect(await readFile(journalPath, 'utf8')).toBe(staleJournal);
  });

  describe('replacement of a committed message', () => {
    const history = Array.from({ length: 300 }, (_, i) => message(`row-${i}`));
    const committed = [message('a'), ...history];
    const transcriptDirectory = (): string =>
      join(store.directory, 'transcripts');
    const locatorPath = (id: string): string =>
      join(
        transcriptDirectory(),
        'message-index',
        'chat',
        `${createHash('sha256').update(id).digest('hex')}.json`,
      );
    const patch = (
      rows: readonly PersistedChatMessage[],
      id: string,
    ): PersistedChatMessage[] =>
      rows.map((row) =>
        row.id === id
          ? { ...row, blocks: [{ type: 'text', text: `${id} was patched` }] }
          : row,
      );
    const commitReplace = async (
      transaction: ChatStorageTransactions,
      replacement: PersistedChatMessage[],
      activeTailCount?: number,
    ): Promise<void> => {
      const next = await transaction.load();
      const revision = next.live.revision;
      next.live.revision = next.archive.revision = revision + 1;
      await transaction.commit(revision, next, [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: rows(replacement),
          ...(activeTailCount !== undefined ? { activeTailCount } : {}),
        },
      ]);
    };
    /** Each derived locator must describe exactly its committed JSONL row. */
    const expectLocatorsMatchLog = async (
      expected: readonly PersistedChatMessage[],
    ): Promise<void> => {
      const log = await readFile(
        join(transcriptDirectory(), 'chat.jsonl'),
        'utf8',
      );
      const lines = log.split('\n').filter(Boolean);
      expect(lines).toEqual(expected.map((row) => JSON.stringify(row)));
      let offset = 0;
      for (let ordinal = 0; ordinal < lines.length; ordinal += 1) {
        const line = lines[ordinal];
        const end = offset + Buffer.byteLength(line) + 1;
        const id = expected[ordinal].id;
        expect(JSON.parse(await readFile(locatorPath(id), 'utf8'))).toEqual({
          version: 1,
          messageId: id,
          offset,
          end,
          digest: createHash('sha256').update(line).digest('hex'),
        });
        offset = end;
      }
      expect(
        await readdir(join(transcriptDirectory(), 'message-index', 'chat')),
      ).toHaveLength(expected.length);
    };
    beforeEach(async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows(history) },
      ]);
    }, 30_000); // Disk-backed setup seeds 300 rows for each replacement case.

    it('rewrites only the locators of the changed suffix', async () => {
      const transaction = new ChatStorageTransactions(store);
      const prefixLocator = await stat(locatorPath('row-10'), {
        bigint: true,
      });
      const writeFile = fsPromises.writeFile;
      const locatorWrites: string[] = [];
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index'))
            locatorWrites.push(pathText(path));
          await writeFile(path, data, options);
        });
      const replacement = patch(committed, 'row-295');
      await commitReplace(transaction, replacement);
      // The patched row and the four rows that moved after it.
      expect(locatorWrites).toHaveLength(5);
      const after = await stat(locatorPath('row-10'), { bigint: true });
      expect(after.ino).toBe(prefixLocator.ino);
      expect(after.mtimeNs).toBe(prefixLocator.mtimeNs);
      jest.restoreAllMocks();
      const reloaded = new ChatStorageTransactions(store);
      expect((await reloaded.load()).live.revision).toBe(2);
      expect((await reloaded.transcripts.page('chat')).messages).toEqual(
        replacement,
      );
      await expectLocatorsMatchLog(replacement);
    });

    it('keeps an unchanged committed prefix when the caller splits an active tail', async () => {
      const transaction = new ChatStorageTransactions(store);
      const writeFile = fsPromises.writeFile;
      let locatorWrites = 0;
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index')) locatorWrites += 1;
          await writeFile(path, data, options);
        });
      const live = [message('live-1'), message('live-2')];
      await commitReplace(transaction, [...committed, ...live], live.length);
      expect(locatorWrites).toBe(0);
      jest.restoreAllMocks();
      const reloaded = new ChatStorageTransactions(store);
      const indexes = await reloaded.load();
      expect(indexes.live.tabs[0].transcript).toMatchObject({
        committedMessageCount: committed.length,
        hasActiveSidecar: true,
        messageCount: committed.length + live.length,
      });
      expect((await reloaded.transcripts.page('chat')).messages).toEqual([
        ...committed,
        ...live,
      ]);
      await expectLocatorsMatchLog(committed);
    });

    // Coverage-green-first: compare the 301-row fault path against unchanged
    // transaction and log source, with a justified timeout for full rebuild.
    it('replays a 301-row replacement interrupted before the sparse index on frozen baseline sources', async () => {
      // This case performs a full-log replacement, locator rebuild, sparse
      // index rebuild, and recovery across 301 committed rows; allow the
      // deliberately heavy disk-backed fixture more than Jest's 5s default.
      const transaction = await loadFrozenBaselineTransaction(store);
      const next = await transaction.load();
      const revision = next.live.revision;
      next.live.revision = revision + 1;
      next.archive.revision = revision + 1;
      const replacement = patch(
        committed.filter((row) => row.id !== 'row-297'),
        'row-294',
      );
      const rename = fsPromises.rename;
      jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, destination) => {
          if (String(destination).endsWith('chat.index.json'))
            throw new Error('injected frozen baseline failure');
          await rename(source, destination);
        });
      await expect(
        transaction.commit(revision, next, [
          { chatId: 'chat', kind: 'replace', messages: rows(replacement) },
        ]),
      ).rejects.toThrow('injected frozen baseline failure');
      jest.restoreAllMocks();

      const recovered = await loadFrozenBaselineTransaction(store);
      const indexes = await recovered.load();
      expect(indexes.live.revision).toBe(revision + 1);
      expect((await recovered.transcripts.page('chat')).messages).toEqual(
        replacement,
      );
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
    }, 30_000);

    it('commits a turn start without rewriting the committed history', async () => {
      // The planner commits the new prompt and keeps its open timer active in
      // one replacement, so the whole committed log is a shared prefix.
      const transaction = new ChatStorageTransactions(store);
      const logPath = join(transcriptDirectory(), 'chat.jsonl');
      const before = await stat(logPath, { bigint: true });
      const prefixLocator = await stat(locatorPath('row-299'), {
        bigint: true,
      });
      const writeFile = fsPromises.writeFile;
      const locatorWrites: string[] = [];
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index'))
            locatorWrites.push(pathText(path));
          await writeFile(path, data, options);
        });
      const copy = jest.spyOn(fsPromises, 'copyFile');
      const prompt = message('next-prompt');
      const timer: PersistedChatMessage = {
        id: 'next-timer',
        role: 'system',
        timestamp: 2,
        blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: null }],
      };
      await commitReplace(transaction, [...committed, prompt, timer], 1);

      // The committed prefix is cloned, not serialized, and published by an
      // atomic rename; only the prompt's locator is written.
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0][0]).toBe(logPath);
      expect(locatorWrites).toEqual([locatorPath('next-prompt')]);
      const after = await stat(logPath, { bigint: true });
      expect(after.ino).not.toBe(before.ino);
      expect(after.size).toBe(
        before.size + BigInt(Buffer.byteLength(JSON.stringify(prompt)) + 1),
      );
      const locator = await stat(locatorPath('row-299'), { bigint: true });
      expect(locator.ino).toBe(prefixLocator.ino);
      expect(locator.mtimeNs).toBe(prefixLocator.mtimeNs);
      jest.restoreAllMocks();

      const reloaded = new ChatStorageTransactions(store);
      const indexes = await reloaded.load();
      expect(indexes.live.tabs[0].transcript).toMatchObject({
        committedMessageCount: committed.length + 1,
        hasActiveSidecar: true,
        messageCount: committed.length + 2,
      });
      expect((await reloaded.transcripts.page('chat')).messages).toEqual([
        ...committed,
        prompt,
        timer,
      ]);
      await expectLocatorsMatchLog([...committed, prompt]);
    });

    it('keeps the old log readable when a turn start fails before publication, then replays it', async () => {
      const transaction = new ChatStorageTransactions(store);
      const logPath = join(transcriptDirectory(), 'chat.jsonl');
      const committedBytes = await readFile(logPath);
      const write = cooperativeJson.writeJsonValuesCooperatively;
      jest
        .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
        .mockImplementation(async (path, values, options) => {
          const written = await write(path, values, options);
          if (path.endsWith('.rewrite.tmp'))
            throw new Error('injected failure');
          return written;
        });
      const replacement = [...committed, message('next-prompt')];
      await expect(commitReplace(transaction, replacement)).rejects.toThrow(
        'injected failure',
      );
      jest.restoreAllMocks();

      // The crash left the committed log byte for byte, readable without
      // replay, and no temporary log.
      expect(await readFile(logPath)).toEqual(committedBytes);
      expect(await readdir(transcriptDirectory())).not.toContainEqual(
        expect.stringMatching(/\.tmp$/),
      );
      expect(
        (await new ChatStorageTransactions(store).transcripts.page('chat'))
          .messages,
      ).toEqual(committed);

      const recovered = new ChatStorageTransactions(store);
      expect((await recovered.load()).live.revision).toBe(2);
      expect((await recovered.transcripts.page('chat')).messages).toEqual(
        replacement,
      );
      await expectLocatorsMatchLog(replacement);
    });

    it.each([
      [
        'after publishing the log',
        (fail: () => Error): void => {
          const rename = fsPromises.rename;
          jest
            .spyOn(fsPromises, 'rename')
            .mockImplementation(async (source, destination) => {
              await rename(source, destination);
              if (String(destination).endsWith('chat.jsonl')) throw fail();
            });
        },
      ],
      [
        'midway through locator updates',
        (fail: () => Error): void => {
          const writeFile = fsPromises.writeFile;
          let written = 0;
          jest
            .spyOn(fsPromises, 'writeFile')
            .mockImplementation(async (path, data, options) => {
              if (pathText(path).includes('message-index') && ++written === 2)
                throw fail();
              await writeFile(path, data, options);
            });
        },
      ],
      [
        'before writing the sparse index',
        (fail: () => Error): void => {
          const rename = fsPromises.rename;
          jest
            .spyOn(fsPromises, 'rename')
            .mockImplementation(async (source, destination) => {
              if (String(destination).endsWith('chat.index.json')) throw fail();
              await rename(source, destination);
            });
        },
      ],
    ])(
      'replays a replacement interrupted %s into a valid log',
      async (_label, install) => {
        const transaction = new ChatStorageTransactions(store);
        const replacement = patch(
          committed.filter((row) => row.id !== 'row-297'),
          'row-294',
        );
        let fired = false;
        install(() => {
          fired = true;
          return new Error('injected failure');
        });
        await expect(commitReplace(transaction, replacement)).rejects.toThrow(
          'injected failure',
        );
        expect(fired).toBe(true);
        jest.restoreAllMocks();

        const recovered = new ChatStorageTransactions(store);
        const indexes = await recovered.load();
        expect(indexes.live.revision).toBe(2);
        expect(
          await readFile(
            join(store.directory, 'metadata-journal.jsonl'),
            'utf8',
          ),
        ).toBe('');
        expect((await recovered.transcripts.page('chat')).messages).toEqual(
          replacement,
        );
        expect(indexes.live.tabs[0].transcript).toEqual(
          await recovered.transcripts.descriptor('chat'),
        );
        await expect(
          recovered.transcripts.hasCommittedMessage('chat', 'row-297'),
        ).resolves.toBe(false);
        for (const row of replacement.slice(-8))
          await expect(
            recovered.transcripts.committedMessageState('chat', row),
          ).resolves.toBe('identical');
        await expectLocatorsMatchLog(replacement);
      },
      30_000, // These crash cases replace and rebuild indexes for 301 rows.
    );
  });

  describe('active-row anchors in transcript transactions', () => {
    const anchorPath = (): string =>
      join(store.directory, 'transcripts', 'chat.active.json');
    const logPath = (): string =>
      join(store.directory, 'transcripts', 'chat.jsonl');
    const journalPath = (): string =>
      join(store.directory, 'metadata-journal.jsonl');
    const seedAnchoredChat = async (
      delegationId = 'card',
      childId = 'child',
      childRunId?: string,
      rowAnchor?: ActiveRowAnchor,
    ): Promise<{
      card: PersistedChatMessage;
      child: PersistedChatMessage;
      transaction: ChatStorageTransactions;
    }> => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard(delegationId);
      await commitDelegationCard(transaction, card);
      const effectiveRunId = childRunId ?? card.id;
      const child = delegatedChild(childId, effectiveRunId);
      await seedActiveSidecar(
        store,
        'chat',
        [
          {
            message: child,
            anchor: rowAnchor ?? activeAnchor(effectiveRunId, 'a'),
          },
        ],
        1,
      );
      return { card, child, transaction };
    };

    const nextRevision = (indexes: ChatStorageIndexes): number => {
      const revision = indexes.live.revision;
      indexes.live.revision = revision + 1;
      indexes.archive.revision = revision + 1;
      return revision;
    };

    const readPending = async (): Promise<Record<string, unknown>> => {
      const pending: unknown = JSON.parse(
        await readFile(journalPath(), 'utf8'),
      );
      if (!isRecord(pending)) throw new Error('Missing pending transaction');
      return pending;
    };

    async function seedCompleteAppend(): Promise<{
      card: PersistedChatMessage;
      payload: PersistedChatMessage[];
    }> {
      const card = delegatedCard('complete-run');
      await commitDelegationCard(new ChatStorageTransactions(store), card);
      const first = message('ordinary-first');
      const second = message('ordinary-second');
      const runA = delegatedChild('run-a', card.id);
      const runB = delegatedChild('run-b', card.id);
      await seedActiveSidecar(
        store,
        'chat',
        [
          { message: runA, anchor: activeAnchor(card.id, second.id) },
          { message: first },
          { message: runB, anchor: activeAnchor(card.id, first.id) },
          { message: second },
        ],
        1,
      );
      return { card, payload: [first, runB, second, runA] };
    }

    it('admits an explicit-zero append with interleaved anchored rows and clears all active rows', async () => {
      const { card, payload } = await seedCompleteAppend();
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      await transaction.commit(nextRevision(next), next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: payload,
          activeTailCount: 0,
        },
      ]);
      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
        card,
        ...payload,
      ]);
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([]);
      expect(await transaction.transcripts.activeRowAnchors('chat')).toEqual(
        new Map(),
      );
      await expect(stat(anchorPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('replays an empty explicit-zero append payload with the complete WAL encoding', async () => {
      const transaction = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await transaction.load();
      await expect(
        transaction.commit(nextRevision(next), next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [],
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing empty complete WAL');
      expect(pending.writes[0]).toMatchObject({
        kind: 'active-replace',
        count: 0,
        appendCommittedCount: 0,
      });
      expect(pending.writes[0]).not.toHaveProperty('activeTailCount');
      const recovered = new ChatStorageTransactions(store);
      await recovered.load();
      await recovered.load();
      expect((await recovered.transcripts.page('chat')).messages).toEqual([
        message('a'),
      ]);
      expect(await recovered.transcripts.activeMessages('chat')).toEqual([]);
    });

    it('keeps the absent-suffix physical-order rejection for the same interleaved payload', async () => {
      const { payload } = await seedCompleteAppend();
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      await expect(
        transaction.commit(nextRevision(next), next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: payload,
          },
        ]),
      ).rejects.toThrow(
        'Finalized messages must follow active transcript order',
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it('rejects an explicit-zero append omitting an uncommitted sidecar row before WAL publication', async () => {
      const { child, transaction } = await seedAnchoredChat();
      const first = message('ordinary-first');
      const anchors = await transaction.transcripts.activeRowAnchors('chat');
      await seedActiveSidecar(
        store,
        'chat',
        [{ message: first }, { message: child, anchor: anchors.get(child.id) }],
        1,
      );
      const next = await transaction.load();
      await expect(
        transaction.commit(nextRevision(next), next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [first],
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow('Active update would discard uncommitted messages');
      expect(await readFile(journalPath(), 'utf8')).toBe('');
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
    });

    it('rejects reordered ordinary rows in an explicit-zero append before WAL publication', async () => {
      const { payload } = await seedCompleteAppend();
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      await expect(
        transaction.commit(nextRevision(next), next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [payload[2], payload[1], payload[0], payload[3]],
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow(
        'Finalized messages must follow active transcript order',
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it.each(['prepared', 'journal', 'transcripts', 'indexes'] as const)(
      'recovers an explicit-zero append at the %s transaction boundary idempotently',
      async (boundary) => {
        const { card, payload } = await seedCompleteAppend();
        const transaction = new ChatStorageTransactions(store, (point) =>
          point === boundary
            ? Promise.reject(new Error(`interrupt at ${boundary}`))
            : Promise.resolve(),
        );
        const next = await transaction.load();
        const revision = nextRevision(next);
        const write: ChatTranscriptWrite = {
          chatId: 'chat',
          kind: 'append',
          messages: payload,
          activeTailCount: 0,
        };
        await expect(
          transaction.commit(revision, next, [write]),
        ).rejects.toThrow(`interrupt at ${boundary}`);
        if (boundary !== 'prepared') {
          const pending = await readPending();
          if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
            throw new Error('Missing complete append WAL');
          expect(pending.writes[0]).toMatchObject({
            kind: 'active-replace',
            appendCommittedCount: payload.length,
            count: payload.length,
          });
          expect(pending.writes[0]).not.toHaveProperty('activeTailCount');
          expect(pending.writes[0]).not.toHaveProperty('anchors');
        } else {
          expect(await readFile(journalPath(), 'utf8')).toBe('');
        }
        const recovered = new ChatStorageTransactions(store);
        const loaded = await recovered.load();
        if (boundary === 'prepared') {
          expect(loaded.live.revision).toBe(revision);
          await recovered.commit(revision, next, [write]);
        }
        await recovered.load();
        await new ChatStorageTransactions(store).load();
        expect((await recovered.transcripts.page('chat')).messages).toEqual([
          message('a'),
          card,
          ...payload,
        ]);
        expect(await recovered.transcripts.activeMessages('chat')).toEqual([]);
        expect(await recovered.transcripts.activeRowAnchors('chat')).toEqual(
          new Map(),
        );
        await expect(stat(anchorPath())).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(journalPath(), 'utf8')).toBe('');
        expect(
          await readdir(join(store.directory, 'pending-transcripts')),
        ).toEqual([]);
      },
    );

    it('replays the explicit-zero WAL on frozen old sources and commits every row on old parent settle', async () => {
      const { card, payload } = await seedCompleteAppend();
      const transaction = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await transaction.load();
      await expect(
        transaction.commit(nextRevision(next), next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: payload,
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');
      const old = await loadFrozenBaselineTransaction(store);
      const recovered = await old.load();
      expect(await old.transcripts.activeMessages('chat')).toEqual(payload);
      expect(
        (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean),
      ).toHaveLength(2);
      expect((await old.transcripts.page('chat')).messages).toEqual([
        message('a'),
        card,
        ...payload,
      ]);
      await old.commit(nextRevision(recovered), recovered, [
        { chatId: 'chat', kind: 'append', messages: payload },
      ]);
      expect(await old.transcripts.activeMessages('chat')).toEqual([]);
      expect((await old.transcripts.page('chat')).messages).toEqual([
        message('a'),
        card,
        ...payload,
      ]);
      expect(
        (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean),
      ).toHaveLength(2 + payload.length);
      expect(await readFile(journalPath(), 'utf8')).toBe('');
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
    });

    // Coverage-green-first: pin the unchanged reader's acceptance of both
    // optional descriptor states and the legacy anchor-free shape.
    it('accepts the frozen transcript index descriptor without hasOrdinaryActiveRows', async () => {
      const frozenIndexValidatorSource = await readFile(
        join(
          ACTIVE_ANCHOR_GOLDEN_DIRECTORY,
          'sparse-index-validator.baseline-339153a.ts',
        ),
        'utf8',
      );
      expect(
        createHash('sha256').update(frozenIndexValidatorSource).digest('hex'),
      ).toBe(FROZEN_BASELINE_INDEX_VALIDATOR_SHA256);
      const frozenLog = await loadFrozenBaselineTranscriptLog();
      const legacyDirectory = join(root, 'legacy-transcript-index');
      const oldReader = new frozenLog.ChatTranscriptLog(legacyDirectory);
      await oldReader.initialize('legacy');
      const legacyIndex = await readFile(
        join(ACTIVE_ANCHOR_GOLDEN_DIRECTORY, 'legacy-empty-index.json'),
        'utf8',
      );
      const legacyIndexValue: unknown = JSON.parse(legacyIndex);
      if (!isRecord(legacyIndexValue))
        throw new Error('Invalid frozen legacy transcript index');
      expect(legacyIndexValue).not.toHaveProperty('hasOrdinaryActiveRows');
      expect(isFrozenBaselineSparseIndex(legacyIndexValue)).toBe(true);
      await writeFile(join(legacyDirectory, 'legacy.index.json'), legacyIndex);

      const descriptor = await oldReader.descriptor('legacy');
      expect(descriptor).toMatchObject({
        committedMessageCount: 0,
        hasActiveSidecar: false,
      });
      expect(descriptor).not.toHaveProperty('hasOrdinaryActiveRows');

      for (const [file, ordinaryActive] of [
        ['anchored-index-with-ordinary-flag.json', false],
        ['anchored-index-with-ordinary-active-rows.json', true],
      ] as const) {
        const anchoredIndex: unknown = JSON.parse(
          await readFile(join(ACTIVE_ANCHOR_GOLDEN_DIRECTORY, file), 'utf8'),
        );
        if (!isFrozenBaselineSparseIndex(anchoredIndex))
          throw new Error(`Frozen baseline rejected ${file}`);
        expect(anchoredIndex.hasActiveSidecar).toBe(true);
        expect(anchoredIndex.hasOrdinaryActiveRows).toBe(ordinaryActive);
        const { checksum, ...candidate } = anchoredIndex;
        expect(checksum).toBe(frozenBaselineIndexChecksum(candidate));
        await writeFile(
          join(legacyDirectory, 'legacy.index.json'),
          JSON.stringify(anchoredIndex),
        );
        const actualOldReader = new frozenLog.ChatTranscriptLog(
          legacyDirectory,
        );
        await expect(
          actualOldReader.descriptor('legacy'),
        ).resolves.toMatchObject({
          committedMessageCount: 0,
        });
      }
    });

    // Coverage-green-first: verify old source drops unknown anchor fields.
    it('runs the anchored sidecar fixture through the unchanged old reader and writer', async () => {
      const frozenLog = await loadFrozenBaselineTranscriptLog();
      const directory = join(root, 'frozen-sidecar-reader');
      const oldReader = new frozenLog.ChatTranscriptLog(directory);
      await oldReader.initialize('chat');
      const input = await readFile(
        join(ACTIVE_ANCHOR_GOLDEN_DIRECTORY, 'active-sidecar.input.jsonl'),
        'utf8',
      );
      await writeFile(join(directory, 'chat.active.json'), input);

      const accepted = await oldReader.activeMessages('chat');
      expect(accepted.map((row) => row.id)).toEqual([
        'delegated-agent-anchor-golden',
        'delegated-agent-anchor-golden:child-answer',
      ]);
      await oldReader.writeActive('chat', accepted);

      const rewritten = await readFile(
        join(directory, 'chat.active.json'),
        'utf8',
      );
      expect(rewritten).not.toContain('"anchor"');
      expect(
        (await oldReader.activeMessages('chat')).map((row) => row.id),
      ).toEqual(accepted.map((row) => row.id));
    });

    // Coverage-green-first: use the old source's capture and artifact-scan APIs.
    it('runs capture and maintenance reads through the unchanged old transcript source', async () => {
      const frozenLog = await loadFrozenBaselineTranscriptLog();
      const oldReader = new frozenLog.ChatTranscriptLog(
        join(root, 'frozen-capture'),
      );
      await oldReader.initialize('chat');
      await oldReader.append('chat', [message('captured-row')]);
      const canonical = await oldReader.descriptor('chat');
      const captured = await oldReader.capturePreview('chat', canonical);
      const capturedRows: PersistedChatMessage[] = [];
      try {
        for await (const row of captured.messages()) capturedRows.push(row);
      } finally {
        await captured.close();
      }
      expect(capturedRows.map((row) => row.id)).toEqual(['captured-row']);

      // The unchanged maintenance APIs must inspect the same committed index
      // and active sidecar the frozen capture path just read.
      await oldReader.writeActive('chat', [message('active-row')]);
      await expect(
        oldReader.artifactReferenceSlice('chat', 0, 1024 * 1024, canonical),
      ).resolves.toMatchObject({ complete: true, artifactIds: [] });
      await expect(
        oldReader.artifactActiveReferenceSlice('chat', 0, 1024 * 1024),
      ).resolves.toMatchObject({
        complete: true,
        artifactIds: [],
        activeHeaderFinalizing: false,
        activeFinalizingRows: 0,
      });
    });

    // Coverage-green-first: pin the bounded known-effect encoding and payload.
    it('pins the frozen old-reader active-replace WAL encoding and payload', async () => {
      const fixtureValue: unknown = JSON.parse(
        await readFile(
          join(
            ACTIVE_ANCHOR_GOLDEN_DIRECTORY,
            'append-active-tail.intent.json',
          ),
          'utf8',
        ),
      );
      if (
        !isRecord(fixtureValue) ||
        !isRecord(fixtureValue.write) ||
        !Array.isArray(fixtureValue.payload)
      )
        throw new Error('Invalid frozen append-active-tail fixture');
      const write = fixtureValue.write;
      expect(write.kind).toBe('active-replace');
      expect(write.appendCommittedCount).toBe(1);
      expect(write).not.toHaveProperty('activeTailCount');

      const payload: PersistedChatMessage[] = [];
      const hash = createHash('sha256');
      for (const row of fixtureValue.payload) {
        if (!isPersistedChatMessage(row))
          throw new Error('Invalid frozen append-active-tail row');
        payload.push(row);
        hash.update(JSON.stringify(row)).update('\n');
      }
      expect(payload.map((row) => row.id)).toEqual([
        'ready-run',
        'ordinary-parent-tail',
      ]);
      expect(write.sha256).toBe(hash.digest('hex'));
      expect(payload.map((row) => row.id)).toEqual([
        'ready-run',
        'ordinary-parent-tail',
      ]);
    });

    // Coverage-green-first: exercise old transaction validation, apply, and
    // settle with both anchor-bearing and ordinary-only suffixes.
    it.each(['anchored', 'unanchored'] as const)(
      'completes the %s suffix WAL through the exact frozen transaction recovery path',
      async (suffixKind) => {
        const readyRun = message(`ready-run-${suffixKind}`);
        const parentTail = message(`parent-tail-${suffixKind}`);
        let payload: PersistedChatMessage[];
        let anchors: [string, ActiveRowAnchor][] | undefined;
        if (suffixKind === 'anchored') {
          const card = delegatedCard('frozen-card');
          const cardTransaction = new ChatStorageTransactions(store);
          await commitDelegationCard(cardTransaction, card);
          const child = delegatedChild('frozen-child', card.id);
          await seedActiveSidecar(
            store,
            'chat',
            [
              {
                message: child,
                anchor: activeAnchor(card.id, 'a'),
              },
            ],
            1,
          );
          payload = [parentTail, child];
          anchors = [[child.id, activeAnchor(card.id, 'a')]];
        } else {
          await seedActiveSidecar(store, 'chat', [{ message: parentTail }], 1);
          payload = [readyRun, parentTail];
        }

        const transaction = new ChatStorageTransactions(store, (point) =>
          point === 'journal'
            ? Promise.reject(new Error('interrupt after WAL publish'))
            : Promise.resolve(),
        );
        const next = await transaction.load();
        const expectedRevision = nextRevision(next);
        await expect(
          transaction.commit(expectedRevision, next, [
            {
              chatId: 'chat',
              kind: 'append',
              messages: payload,
              activeTailCount: 1,
            },
          ]),
        ).rejects.toThrow('interrupt after WAL publish');

        const pending = await readPending();
        if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
          throw new Error('Missing prepared append');
        expect(pending.writes[0]).toMatchObject({
          kind: 'active-replace',
          appendCommittedCount: 1,
        });
        expect(pending.writes[0]).not.toHaveProperty('activeTailCount');
        if (anchors) expect(pending.writes[0].anchors).toEqual(anchors);
        else expect(pending.writes[0]).not.toHaveProperty('anchors');

        const recovered = await recoverWithFrozenBaselineTransaction(store);
        expect(recovered.indexes.live.revision).toBe(expectedRevision + 1);
        expect(await readFile(journalPath(), 'utf8')).toBe('');
        const activeIds = (
          await recovered.transcripts.activeMessages('chat')
        ).map((row) => row.id);
        expect(activeIds.sort()).toEqual(payload.map((row) => row.id).sort());
        const pageIds = (await recovered.transcripts.page('chat')).messages.map(
          (row) => row.id,
        );
        expect(pageIds.sort()).toEqual(
          [
            message('a').id,
            ...(suffixKind === 'anchored'
              ? [delegatedCard('frozen-card').id]
              : []),
            ...payload.map((row) => row.id),
          ].sort(),
        );
        expect(new Set(pageIds).size).toBe(pageIds.length);
        expect(
          await readdir(join(store.directory, 'pending-transcripts')),
        ).toEqual([]);

        // Coverage-green-first: the unchanged parent settle must commit the
        // entire downgraded active payload, for anchored and ordinary suffixes.
        const oldParentSettle = await loadFrozenBaselineTransaction(store);
        const settleIndexes = await oldParentSettle.load();
        const settleRevision = settleIndexes.live.revision;
        settleIndexes.live.revision = settleRevision + 1;
        settleIndexes.archive.revision = settleRevision + 1;
        await oldParentSettle.commit(settleRevision, settleIndexes, [
          { chatId: 'chat', kind: 'append', messages: payload },
        ]);
        expect(
          await oldParentSettle.transcripts.activeMessages('chat'),
        ).toEqual([]);
        const settledIds = (
          await oldParentSettle.transcripts.page('chat')
        ).messages.map((row) => row.id);
        expect(settledIds.sort()).toEqual(pageIds.sort());
        expect(new Set(settledIds).size).toBe(settledIds.length);
        expect(await readFile(journalPath(), 'utf8')).toBe('');
      },
    );

    // Coverage-green-first: ensure the frozen old source replays reordered
    // anchored survivors after new apply has partially committed.
    it.each(['index-published', 'survivors-published'] as const)(
      'keeps reordered anchored suffix rows replayable by frozen recovery after %s',
      async (boundary) => {
        const card = delegatedCard('reordered-card');
        const setup = new ChatStorageTransactions(store);
        await commitDelegationCard(setup, card);
        const runA = delegatedChild('run-a', card.id);
        const ordinary = message('ordinary-middle');
        const runB = delegatedChild('run-b', card.id);
        const runAAnchor = activeAnchor(card.id, card.id, 0);
        const runBAnchor = activeAnchor(card.id, card.id, 2);
        await seedActiveSidecar(
          store,
          'chat',
          [
            { message: runA, anchor: runAAnchor },
            { message: ordinary },
            { message: runB, anchor: runBAnchor },
          ],
          1,
        );

        const transaction = new ChatStorageTransactions(store);
        const next = await transaction.load();
        const expectedRevision = nextRevision(next);
        const directory = join(store.directory, 'transcripts');
        jest
          .spyOn(transaction.transcripts, 'append')
          .mockImplementation(
            async (chatId, messages, anchors, activeTailCount) =>
              new ChatTranscriptLog(directory, (point) =>
                point === boundary
                  ? Promise.reject(new Error(`interrupt at ${boundary}`))
                  : Promise.resolve(),
              ).append(chatId, messages, anchors, activeTailCount),
          );

        await expect(
          transaction.commit(expectedRevision, next, [
            {
              chatId: 'chat',
              kind: 'append',
              messages: [ordinary, runB, runA],
              activeTailCount: 2,
            },
          ]),
        ).rejects.toThrow(`interrupt at ${boundary}`);

        const pending = await readPending();
        if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
          throw new Error('Missing prepared reordered append');
        expect(pending.writes[0]).toMatchObject({
          kind: 'active-replace',
          appendCommittedCount: 1,
        });
        expect(pending.writes[0].anchors).toEqual([
          [runB.id, runBAnchor],
          [runA.id, runAAnchor],
        ]);

        const recovered = await recoverWithFrozenBaselineTransaction(store);
        expect(recovered.indexes.live.revision).toBe(expectedRevision + 1);
        expect(await readFile(journalPath(), 'utf8')).toBe('');
        const recoveredRows = (await recovered.transcripts.page('chat'))
          .messages;
        const recoveredIds = recoveredRows.map((row) => row.id);
        expect(recoveredIds.sort()).toEqual(
          [message('a').id, card.id, ordinary.id, runB.id, runA.id].sort(),
        );
        expect(new Set(recoveredIds).size).toBe(recoveredIds.length);
        expect(
          await readdir(join(store.directory, 'pending-transcripts')),
        ).toEqual([]);
      },
    );

    // Coverage-green-first: start from each new append checkpoint, then use
    // only frozen transaction/log code for old recovery and parent settle.
    it.each([
      'prepared',
      'appended',
      'index-published',
      'survivors-published',
    ] as const)(
      'replays the unanchored suffix WAL through frozen recovery after new-append %s',
      async (boundary) => {
        const parentTail = message('ordinary-parent-tail');
        const readyRun = message('ready-run');
        await seedActiveSidecar(store, 'chat', [{ message: parentTail }], 1);
        const transaction = new ChatStorageTransactions(store);
        const next = await transaction.load();
        const expectedRevision = nextRevision(next);
        const directory = join(store.directory, 'transcripts');
        jest
          .spyOn(transaction.transcripts, 'append')
          .mockImplementation(
            async (chatId, messages, anchors, activeTailCount) =>
              new ChatTranscriptLog(directory, (point) =>
                point === boundary
                  ? Promise.reject(new Error(`interrupt at ${boundary}`))
                  : Promise.resolve(),
              ).append(chatId, messages, anchors, activeTailCount),
          );

        await expect(
          transaction.commit(expectedRevision, next, [
            {
              chatId: 'chat',
              kind: 'append',
              messages: [readyRun, parentTail],
              activeTailCount: 1,
            },
          ]),
        ).rejects.toThrow(`interrupt at ${boundary}`);

        const recovered = await recoverWithFrozenBaselineTransaction(store);
        expect(recovered.indexes.live.revision).toBe(expectedRevision + 1);
        expect(await readFile(journalPath(), 'utf8')).toBe('');
        // Old load recovers the v2 active-sidecar append intent first, so even
        // the staged/prepared boundary may commit this prefix before WAL apply.
        const expectedActiveIds = [parentTail.id];
        expect(
          (await recovered.transcripts.activeMessages('chat')).map(
            (row) => row.id,
          ),
        ).toEqual(expectedActiveIds);
        await expect(
          recovered.transcripts.artifactActiveReferenceSlice(
            'chat',
            0,
            1024 * 1024,
          ),
        ).resolves.toMatchObject({
          complete: true,
          activeHeaderFinalizing: false,
          activeFinalizingRows: 0,
        });
        const recoveredPageIds = (
          await recovered.transcripts.page('chat')
        ).messages.map((row) => row.id);
        expect(recoveredPageIds.sort()).toEqual(
          [message('a').id, readyRun.id, parentTail.id].sort(),
        );
        expect(new Set(recoveredPageIds).size).toBe(recoveredPageIds.length);
        expect(
          await readdir(join(store.directory, 'pending-transcripts')),
        ).toEqual([]);

        if (boundary === 'prepared') {
          const oldParentSettle = await loadFrozenBaselineTransaction(store);
          const settleIndexes = await oldParentSettle.load();
          const settleRevision = settleIndexes.live.revision;
          settleIndexes.live.revision = settleRevision + 1;
          settleIndexes.archive.revision = settleRevision + 1;
          await oldParentSettle.commit(settleRevision, settleIndexes, [
            {
              chatId: 'chat',
              kind: 'append',
              messages: [readyRun, parentTail],
            },
          ]);
          expect(
            (await oldParentSettle.transcripts.page('chat')).messages.map(
              (row) => row.id,
            ),
          ).toEqual([message('a').id, readyRun.id, parentTail.id]);
          expect(
            await oldParentSettle.transcripts.activeMessages('chat'),
          ).toEqual([]);
          expect(await readFile(journalPath(), 'utf8')).toBe('');
        }
      },
    );

    // Coverage-green-first: prove the unchanged transaction applies an active
    // clear through the unchanged transcript log's replaceActive/remove path.
    it('clears the active sidecar through the frozen old transaction and log sources', async () => {
      const oldTransaction = await loadFrozenBaselineTransaction(store);
      await oldTransaction.transcripts.writeActive('chat', [
        message('old-active-row'),
      ]);
      const next = await oldTransaction.load();
      const expectedRevision = next.live.revision;
      next.live.revision = expectedRevision + 1;
      next.archive.revision = expectedRevision + 1;

      await oldTransaction.commit(expectedRevision, next, [
        { chatId: 'chat', kind: 'active-replace', messages: [] },
      ]);

      await expect(stat(anchorPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        oldTransaction.transcripts.activeMessages('chat'),
      ).resolves.toEqual([]);
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    // Coverage-green-first: the old delete effect must continue to remove the
    // complete transcript closure after recovery.
    it('deletes a pending transcript through the unchanged old transaction and log sources', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      next.live.tabs = [];
      next.live.activeTabId = '';

      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'delete' },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const recovered = await recoverWithFrozenBaselineTransaction(store);
      expect(recovered.indexes.live.revision).toBe(expectedRevision + 1);
      expect(recovered.indexes.live.tabs).toEqual([]);
      expect(await readFile(journalPath(), 'utf8')).toBe('');
      await expect(
        stat(join(store.directory, 'transcripts', 'chat.jsonl')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
    });

    it('rejects active replacement that would discard journal-projected rows', async () => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(transaction, card);
      const projected = message('projected-active');
      transaction.transcripts.setActiveProjection(() => ({
        messages: [projected],
        transcriptRevision: 1,
      }));
      const snapshot = jest.spyOn(transaction.transcripts, 'activeSnapshot');
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await expect(
        transaction.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'active',
            messages: [message('replacement')],
          },
        ]),
      ).rejects.toThrow('Active update would discard uncommitted messages');
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    it('checks append ordering against journal-projected active rows', async () => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(transaction, card);
      const projected = message('projected-active');
      transaction.transcripts.setActiveProjection(() => ({
        messages: [projected],
        transcriptRevision: 1,
      }));
      const snapshot = jest.spyOn(transaction.transcripts, 'activeSnapshot');
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await expect(
        transaction.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'append', messages: [message('later')] },
        ]),
      ).rejects.toThrow(
        'Finalized messages must follow active transcript order',
      );
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    // Red-first: before the fix, current log rejected only after the WAL had
    // been published; admission now rejects without a durable journal.
    it('rejects reordered ordinary active rows before publishing an append WAL', async () => {
      const first = message('ordinary-first');
      const second = message('ordinary-second');
      await seedActiveSidecar(
        store,
        'chat',
        [{ message: first }, { message: second }],
        1,
      );
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await expect(
        transaction.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [second, first],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow(
        'Finalized messages must follow active transcript order',
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
      expect(
        (await transaction.transcripts.activeMessages('chat')).map(
          (row) => row.id,
        ),
      ).toEqual([first.id, second.id]);
    });

    // Coverage-green-first: guard against rejecting a genuinely new ready row
    // while preserving the existing ordinary-row order check.
    it('allows a new ready prefix before a retained ordinary active tail', async () => {
      const first = message('ordinary-first');
      const second = message('ordinary-second');
      const ready = message('ready-prefix');
      await seedActiveSidecar(
        store,
        'chat',
        [{ message: first }, { message: second }],
        1,
      );
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await transaction.commit(expectedRevision, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [ready, first, second],
          activeTailCount: 1,
        },
      ]);

      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
        ready,
        first,
        second,
      ]);
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([
        second,
      ]);
    });

    it('preserves an existing anchor across replacement of the active suffix', async () => {
      const { card, child, transaction } = await seedAnchoredChat();
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await transaction.commit(expectedRevision, next, [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: [message('a'), card, child],
          activeTailCount: 1,
        },
      ]);

      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
      // Anchor metadata is a sidecar projection, never part of message JSONL.
      expect(
        (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean),
      ).toEqual([message('a'), card].map((row) => JSON.stringify(row)));
    });

    // Red-first: this positive anchored-suffix case first failed admission
    // before append learned the complete active-tail contract.
    it('commits an ordinary append prefix while retaining its complete anchored suffix', async () => {
      const { card, child } = await seedAnchoredChat();
      const ordinary = message('parent-tail');
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);

      await expect(
        interrupted.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [ordinary, child],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      expect(pending.writes[0]).toMatchObject({
        kind: 'active-replace',
        appendCommittedCount: 1,
      });
      expect(pending.writes[0]).not.toHaveProperty('activeTailCount');
      expect(pending.writes[0].anchors).toEqual([
        [child.id, activeAnchor(card.id, 'a')],
      ]);

      const recovered = new ChatStorageTransactions(store);
      await expect(recovered.load()).resolves.toMatchObject({
        live: { revision: 2 },
      });
      expect((await recovered.transcripts.page('chat')).messages).toEqual([
        message('a'),
        child,
        card,
        ordinary,
      ]);
      expect(await recovered.transcripts.activeMessages('chat')).toEqual([
        child,
      ]);
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
    });

    // Coverage-green-first: pin replay through both transaction checkpoints.
    it.each(['transcripts', 'indexes'] as const)(
      'replays the anchored append suffix after the %s transaction checkpoint',
      async (boundary) => {
        const { card, child } = await seedAnchoredChat();
        const ordinary = message(`parent-tail-${boundary}`);
        const interrupted = new ChatStorageTransactions(store, (point) =>
          point === boundary
            ? Promise.reject(new Error(`interrupt at ${boundary}`))
            : Promise.resolve(),
        );
        const next = await interrupted.load();
        const expectedRevision = nextRevision(next);

        await expect(
          interrupted.commit(expectedRevision, next, [
            {
              chatId: 'chat',
              kind: 'append',
              messages: [ordinary, child],
              activeTailCount: 1,
            },
          ]),
        ).rejects.toThrow(`interrupt at ${boundary}`);

        const recovered = new ChatStorageTransactions(store);
        await expect(recovered.load()).resolves.toMatchObject({
          live: { revision: 2 },
        });
        const committed = (await readFile(logPath(), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const row: unknown = JSON.parse(line);
            if (!isRecord(row) || typeof row.id !== 'string')
              throw new Error('Invalid committed transcript row');
            return row.id;
          });
        expect(committed).toEqual([message('a').id, card.id, ordinary.id]);
        expect(await recovered.transcripts.activeMessages('chat')).toEqual([
          child,
        ]);
        expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
          activeAnchor(card.id, 'a'),
        );
      },
    );

    // Coverage-green-first: assert the no-crash path materializes only prefix.
    it('successfully commits an anchored append while retaining its suffix', async () => {
      const { card, child, transaction } = await seedAnchoredChat();
      const ordinary = message('successful-parent-tail');
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await transaction.commit(expectedRevision, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [ordinary, child],
          activeTailCount: 1,
        },
      ]);

      expect(
        (await readFile(logPath(), 'utf8')).split('\n').filter(Boolean),
      ).toHaveLength(3);
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([
        child,
      ]);
      expect(await transaction.transcripts.descriptor('chat')).toMatchObject({
        hasOrdinaryActiveRows: false,
      });
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
    });

    // Coverage-green-first: complete suffix membership must retain every row.
    it('rejects an append suffix that would omit an uncommitted active row', async () => {
      const { child, transaction } = await seedAnchoredChat();
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);

      await expect(
        transaction.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [message('replacement-tail')],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('Active update would discard uncommitted messages');
      expect(await readFile(journalPath(), 'utf8')).toBe('');
      expect(await transaction.transcripts.activeMessages('chat')).toEqual([
        child,
      ]);
    });

    // Red-first: the unanchored ready-prefix case exposed the log append
    // prefix-order failure before the fourth append argument was implemented.
    it('keeps an unanchored parent tail active after committing a ready-run prefix', async () => {
      const readyRun = delegatedCard('ready-run');
      const parentTail = message('ordinary-parent-tail');
      await seedActiveSidecar(store, 'chat', [{ message: parentTail }], 1);
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);

      await expect(
        interrupted.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [readyRun, parentTail],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      expect(pending.writes[0]).toMatchObject({
        kind: 'active-replace',
        appendCommittedCount: 1,
      });
      expect(pending.writes[0]).not.toHaveProperty('activeTailCount');
      expect(pending.writes[0]).not.toHaveProperty('anchors');

      const recovered = new ChatStorageTransactions(store);
      await expect(recovered.load()).resolves.toMatchObject({
        live: { revision: 1 },
      });
      expect((await recovered.transcripts.page('chat')).messages).toEqual([
        message('a'),
        readyRun,
        parentTail,
      ]);
      expect(await recovered.transcripts.activeMessages('chat')).toEqual([
        parentTail,
      ]);
      expect(await recovered.transcripts.descriptor('chat')).not.toHaveProperty(
        'hasOrdinaryActiveRows',
      );
    });

    it('captures existing anchors as JSON tuples in the WAL and replays them with zero payload retention', async () => {
      const { card, child } = await seedAnchoredChat();
      const interrupted = new ChatStorageTransactions(
        store,
        (point) =>
          point === 'journal'
            ? Promise.reject(new Error('interrupt after WAL publish'))
            : Promise.resolve(),
        { retainedPayloadBytes: 0 },
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      const expectedAnchor = activeAnchor(card.id, 'a');

      await expect(
        interrupted.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'replace',
            messages: [message('a'), card, child],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const journalBytes = await readFile(journalPath(), 'utf8');
      const pending = await readPending();
      const writes = pending.writes;
      if (!Array.isArray(writes) || !isRecord(writes[0]))
        throw new Error('Missing prepared transcript write');
      expect(writes[0].anchors).toEqual([[child.id, expectedAnchor]]);
      expect(Array.isArray(writes[0].anchors)).toBe(true);
      expect(writes[0].anchors).not.toBeInstanceOf(Map);
      expect(journalBytes).toBe(`${JSON.stringify(pending)}\n`);

      // Recovery uses a different transaction instance and must not rely on
      // retaining the payload rows parsed during admission.
      const recovered = new ChatStorageTransactions(store, undefined, {
        retainedPayloadBytes: 0,
      });
      await expect(recovered.load()).resolves.toMatchObject({
        live: { revision: 2 },
      });
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        expectedAnchor,
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it('lets explicit anchors override captured anchors for surviving rows', async () => {
      const { card, child, transaction } = await seedAnchoredChat();
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);
      const explicit: [string, ActiveRowAnchor][] = [
        [child.id, activeAnchor(card.id, card.id, -1)],
      ];
      const write = {
        chatId: 'chat',
        kind: 'replace' as const,
        messages: [message('a'), card, child],
        activeTailCount: 1,
        anchors: explicit,
      };

      await transaction.commit(expectedRevision, next, [write]);

      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        explicit[0]?.[1],
      );
    });

    it.each([
      [
        'malformed anchor shape',
        { version: 1, runId: 'card', after: 'a', tie: 0.5 },
        'child',
        /anchor/i,
      ],
      [
        'unknown run card context',
        activeAnchor('missing-card', 'a'),
        'missing-card',
        /anchor|run|card/i,
      ],
    ] as const)(
      'rejects %s before WAL publication without changing transcript files',
      async (_label, invalidAnchor, childRunId, reason) => {
        const { child, transaction } = await seedAnchoredChat();
        const beforeSidecar = await readFile(anchorPath());
        const beforeLog = await readFile(logPath());
        const beforeIndex = await readFile(
          join(store.directory, 'live-index.json'),
        );
        const next = await transaction.load();
        const expectedRevision = nextRevision(next);

        const write = {
          chatId: 'chat',
          kind: 'active' as const,
          messages: [child],
          anchors: [anchorTuple(child.id, invalidAnchor)],
        };
        const candidate =
          childRunId === 'missing-card'
            ? {
                ...write,
                anchors: [anchorTuple(child.id, activeAnchor(childRunId, 'a'))],
              }
            : write;
        await expect(
          transaction.commit(expectedRevision, next, [candidate]),
        ).rejects.toThrow(reason);

        expect(await readFile(anchorPath())).toEqual(beforeSidecar);
        expect(await readFile(logPath())).toEqual(beforeLog);
        expect(
          await readFile(join(store.directory, 'live-index.json')),
        ).toEqual(beforeIndex);
        expect(await readFile(journalPath(), 'utf8')).toBe('');
      },
    );

    it('keeps only surviving anchors when an active replacement removes a row', async () => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(transaction, card);
      const first = delegatedChild('first', card.id);
      const removed = delegatedChild('removed', card.id);
      await seedActiveSidecar(
        store,
        'chat',
        [
          { message: first, anchor: activeAnchor(card.id, 'a') },
          { message: removed, anchor: activeAnchor(card.id, 'a', -1) },
        ],
        1,
      );
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);
      const snapshot = jest.spyOn(transaction.transcripts, 'activeSnapshot');

      await transaction.commit(expectedRevision, next, [
        { chatId: 'chat', kind: 'active-replace', messages: [first] },
      ]);
      expect(snapshot).toHaveBeenCalledTimes(1);

      expect(await activeSidecarAnchor(store, 'chat', first.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
      expect(
        parseActiveSidecarRecords(await readFile(anchorPath(), 'utf8')),
      ).toHaveLength(1);
    });

    it('carries an anchor through append finalization in WAL then removes it from the active sidecar', async () => {
      const { card, child } = await seedAnchoredChat();
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      const write = {
        chatId: 'chat',
        kind: 'append' as const,
        messages: [child],
        anchors: [anchorTuple(child.id, activeAnchor(card.id, 'a'))],
      };

      await expect(
        interrupted.commit(expectedRevision, next, [write]),
      ).rejects.toThrow('interrupt after WAL publish');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      expect(pending.writes[0].anchors).toEqual([
        [child.id, activeAnchor(card.id, 'a')],
      ]);

      const recovered = new ChatStorageTransactions(store);
      await expect(recovered.load()).resolves.toMatchObject({
        live: { revision: 2 },
      });
      await expect(stat(anchorPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await recovered.transcripts.page('chat')).messages).toEqual([
        message('a'),
        card,
        child,
      ]);
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it('captures append survivors absent from the payload and applies explicit survivor overrides', async () => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(transaction, card);
      const finalizing = delegatedChild('finalizing', card.id);
      const survivor = delegatedChild('survivor', card.id);
      const survivorAnchor = activeAnchor(card.id, 'a', -1);
      const explicitSurvivorAnchor = activeAnchor(card.id, 'a', -2);
      await seedActiveSidecar(
        store,
        'chat',
        [
          { message: finalizing, anchor: activeAnchor(card.id, 'a') },
          { message: survivor, anchor: survivorAnchor },
        ],
        1,
      );
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);

      await expect(
        interrupted.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [finalizing],
            anchors: [anchorTuple(survivor.id, explicitSurvivorAnchor)],
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      expect(pending.writes[0].anchors).toEqual([
        [finalizing.id, activeAnchor(card.id, 'a')],
        [survivor.id, explicitSurvivorAnchor],
      ]);

      await new ChatStorageTransactions(store).load();
      expect(await activeSidecarAnchor(store, 'chat', survivor.id)).toEqual(
        explicitSurvivorAnchor,
      );
      expect(await activeSidecarAnchor(store, 'chat', finalizing.id)).toBe(
        undefined,
      );
    });

    it('omits committed idempotent append payload anchors from the WAL', async () => {
      const initial = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(initial, card);
      const child = delegatedChild('already-committed', card.id);
      const committed = await initial.load();
      const committedRevision = nextRevision(committed);
      await initial.commit(committedRevision, committed, [
        { chatId: 'chat', kind: 'append', messages: [child] },
      ]);
      const childAnchor = activeAnchor(card.id, 'a');
      await seedActiveSidecar(
        store,
        'chat',
        [{ message: child, anchor: childAnchor }],
        2,
      );
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);

      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'append', messages: [child] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      expect(pending.writes[0]).not.toHaveProperty('anchors');

      await new ChatStorageTransactions(store).load();
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        childAnchor,
      );
    });

    const mutableWriteKinds: Array<'active' | 'active-replace'> = [
      'active',
      'active-replace',
    ];
    it.each(mutableWriteKinds)(
      'omits committed %s payload anchors from the WAL',
      async (kind) => {
        const { card, child, transaction } = await seedAnchoredChat();
        const finalized = await transaction.load();
        const finalizeRevision = nextRevision(finalized);
        await transaction.commit(finalizeRevision, finalized, [
          { chatId: 'chat', kind: 'append', messages: [child] },
        ]);
        const interrupted = new ChatStorageTransactions(store, (point) =>
          point === 'journal'
            ? Promise.reject(new Error('interrupt after WAL publish'))
            : Promise.resolve(),
        );
        const next = await interrupted.load();
        const revision = nextRevision(next);
        await expect(
          interrupted.commit(revision, next, [
            {
              chatId: 'chat',
              kind,
              messages: [child],
              anchors: [[child.id, activeAnchor(card.id, 'a')]],
            },
          ]),
        ).rejects.toThrow('interrupt after WAL publish');
        const pending = await readPending();
        if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
          throw new Error('Missing prepared active write');
        expect(pending.writes[0]).not.toHaveProperty('anchors');
      },
    );

    it('fails closed on a malformed append survivor sidecar before recovery effects', async () => {
      const transaction = new ChatStorageTransactions(store);
      const card = delegatedCard('card');
      await commitDelegationCard(transaction, card);
      const finalizing = delegatedChild('finalizing', card.id);
      const survivor = delegatedChild('survivor', card.id);
      await seedActiveSidecar(
        store,
        'chat',
        [
          { message: finalizing, anchor: activeAnchor(card.id, 'a') },
          { message: survivor, anchor: activeAnchor(card.id, 'a', -1) },
        ],
        1,
      );
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'append', messages: [finalizing] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const malformedSidecar = '{"version":2}\nnot-json\n';
      await writeFile(anchorPath(), malformedSidecar);
      const beforeLog = await readFile(logPath());
      const beforeLiveIndex = await readFile(
        join(store.directory, 'live-index.json'),
      );
      const beforeJournal = await readFile(journalPath());

      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow();
      expect(await readFile(anchorPath(), 'utf8')).toBe(malformedSidecar);
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(join(store.directory, 'live-index.json'))).toEqual(
        beforeLiveIndex,
      );
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });

    // The exact 16 MiB UTF-8 boundary fixture takes longer than Jest's 5 s default.
    it.each([0, 1])(
      'checks the complete escaped-ID finalizing row at ceiling delta %s before WAL publication',
      async (delta) => {
        const delegationId = '🌲"\\'.repeat(123);
        const childId = `child-${'🌲"\\'.repeat(120)}`;
        const card = delegatedCard(delegationId);
        const transaction = new ChatStorageTransactions(store);
        await commitDelegationCard(transaction, card);
        const predecessor = message('🌲"\\'.repeat(128));
        const withPredecessor = await transaction.load();
        const predecessorRevision = nextRevision(withPredecessor);
        await transaction.commit(predecessorRevision, withPredecessor, [
          { chatId: 'chat', kind: 'append', messages: [predecessor] },
        ]);
        const rowAnchor = activeAnchor(card.id, predecessor.id);
        const ceiling = MAX_TRANSCRIPT_ROW_BYTES + 1024;
        const child = exactBudgetMessage(
          childId,
          rowAnchor,
          true,
          ceiling + delta,
        );
        const expectedBytes = activeSidecarMessageRecordBytes({
          version: 2,
          kind: 'message',
          message: child,
          anchor: rowAnchor,
          finalizing: true,
        });
        expect(
          expectedBytes -
            activeSidecarMessageRecordBytes({
              version: 2,
              kind: 'message',
              message: child,
            }),
        ).toBeGreaterThan(1024);
        expect(expectedBytes).toBe(ceiling + delta);
        expect(
          Buffer.byteLength(JSON.stringify(child), 'utf8'),
        ).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);
        const next = await transaction.load();
        const expectedRevision = nextRevision(next);
        const write = {
          chatId: 'chat',
          kind: 'append' as const,
          messages: [child],
          anchors: [anchorTuple(childId, rowAnchor)],
        };

        if (delta === 0) {
          await expect(
            transaction.commit(expectedRevision, next, [write]),
          ).resolves.toBeDefined();
        } else {
          const beforeLog = await readFile(logPath());
          await expect(
            transaction.commit(expectedRevision, next, [write]),
          ).rejects.toThrow(/active.*row|sidecar.*size|budget/i);
          await expect(stat(anchorPath())).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readFile(logPath())).toEqual(beforeLog);
          expect(await readFile(journalPath(), 'utf8')).toBe('');
        }
      },
      30_000,
    );

    it('keeps the legacy anchor-free WAL keys, omissions, order, and bytes', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      next.live.revision = next.archive.revision = 1;
      const messagePayload = message('b');

      await expect(
        interrupted.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: [messagePayload] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const journalBytes = await readFile(journalPath(), 'utf8');
      const pending = await readPending();
      const writes = pending.writes;
      if (!Array.isArray(writes) || !isRecord(writes[0]))
        throw new Error('Missing prepared transcript write');
      expect(Object.keys(pending)).toEqual([
        'v',
        'transactionId',
        'expectedRevision',
        'indexes',
        'writes',
      ]);
      expect(Object.keys(writes[0])).toEqual([
        'chatId',
        'kind',
        'create',
        'count',
        'sha256',
      ]);
      const expected = {
        v: 2,
        transactionId: pending.transactionId,
        expectedRevision: 0,
        indexes: pending.indexes,
        writes: [
          {
            chatId: 'chat',
            kind: 'append',
            create: false,
            count: 1,
            sha256: createHash('sha256')
              .update(JSON.stringify(messagePayload))
              .update('\n')
              .digest('hex'),
          },
        ],
      };
      expect(journalBytes).toBe(`${JSON.stringify(expected)}\n`);
    });

    // Red-first: explicit zero uses the same downgrade-compatible effect as a positive suffix.
    it('encodes an explicit zero append suffix as a complete active-replace WAL', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      next.live.revision = next.archive.revision = 1;
      const messagePayload = message('b');

      await expect(
        interrupted.commit(0, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [messagePayload],
            activeTailCount: 0,
          },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const journalBytes = await readFile(journalPath(), 'utf8');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared transcript write');
      const expected = {
        v: 2,
        transactionId: pending.transactionId,
        expectedRevision: 0,
        indexes: pending.indexes,
        writes: [
          {
            chatId: 'chat',
            kind: 'active-replace',
            create: false,
            count: 1,
            sha256: createHash('sha256')
              .update(JSON.stringify(messagePayload))
              .update('\n')
              .digest('hex'),
            appendCommittedCount: 1,
          },
        ],
      };
      expect(Object.keys(pending.writes[0])).toEqual([
        'chatId',
        'kind',
        'create',
        'count',
        'sha256',
        'appendCommittedCount',
      ]);
      expect(journalBytes).toBe(`${JSON.stringify(expected)}\n`);
    });

    it('omits an explicitly empty anchor tuple array from the inert WAL shape', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      next.live.revision = next.archive.revision = 1;
      const messagePayload = message('b');
      const emptyAnchors: [string, ActiveRowAnchor][] = [];
      const write = {
        chatId: 'chat',
        kind: 'append' as const,
        messages: [messagePayload],
        anchors: emptyAnchors,
      };

      await expect(interrupted.commit(0, next, [write])).rejects.toThrow(
        'interrupt after WAL publish',
      );

      const journalBytes = await readFile(journalPath(), 'utf8');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared transcript write');
      expect(Object.keys(pending.writes[0])).toEqual([
        'chatId',
        'kind',
        'create',
        'count',
        'sha256',
      ]);
      const expected = {
        v: 2,
        transactionId: pending.transactionId,
        expectedRevision: 0,
        indexes: pending.indexes,
        writes: [
          {
            chatId: 'chat',
            kind: 'append',
            create: false,
            count: 1,
            sha256: createHash('sha256')
              .update(JSON.stringify(messagePayload))
              .update('\n')
              .digest('hex'),
          },
        ],
      };
      expect(journalBytes).toBe(`${JSON.stringify(expected)}\n`);
    });

    it('recovers from a fault immediately after replacing the active sidecar and preserves its captured anchor', async () => {
      const { card, child, transaction } = await seedAnchoredChat();
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);
      const remove = fsPromises.rm;
      let injected = false;
      jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
        await remove(path, options);
        if (!injected && pathText(path).endsWith('chat.active.json')) {
          injected = true;
          throw new Error('after active sidecar deletion');
        }
      });

      await expect(
        transaction.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'replace',
            messages: [message('a'), card, child],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('after active sidecar deletion');
      expect(injected).toBe(true);
      jest.restoreAllMocks();

      const recovered = new ChatStorageTransactions(store);
      await expect(recovered.load()).resolves.toMatchObject({
        live: { revision: 2 },
      });
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it('preserves replacement anchors through a suffix-restore fault and repeated recovery replay', async () => {
      const { card, child, transaction } = await seedAnchoredChat();
      const next = await transaction.load();
      const expectedRevision = nextRevision(next);
      const rename = fsPromises.rename;
      let injected = false;
      jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (!injected && pathText(destination).endsWith('chat.active.json')) {
            injected = true;
            throw new Error('during active suffix restoration');
          }
        });

      await expect(
        transaction.commit(expectedRevision, next, [
          {
            chatId: 'chat',
            kind: 'replace',
            messages: [message('a'), card, child],
            activeTailCount: 1,
          },
        ]),
      ).rejects.toThrow('during active suffix restoration');
      expect(injected).toBe(true);
      jest.restoreAllMocks();

      const interruptedReplay = new ChatStorageTransactions(store, (point) =>
        point === 'transcripts'
          ? Promise.reject(new Error('interrupt after suffix replay'))
          : Promise.resolve(),
      );
      await expect(interruptedReplay.load()).rejects.toThrow(
        'interrupt after suffix replay',
      );
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
      expect(await readFile(journalPath(), 'utf8')).not.toBe('');

      const replayedAgain = new ChatStorageTransactions(store);
      await expect(replayedAgain.load()).resolves.toMatchObject({
        live: { revision: 2 },
      });
      expect(await activeSidecarAnchor(store, 'chat', child.id)).toEqual(
        activeAnchor(card.id, 'a'),
      );
      expect(await readFile(journalPath(), 'utf8')).toBe('');
    });

    it('uses the replacement payload committed prefix, not stale old history, to validate replay anchors', async () => {
      const transaction = new ChatStorageTransactions(store);
      const oldCard = delegatedCard('old-card');
      await commitDelegationCard(transaction, oldCard);
      const newCard = delegatedCard('new-card');
      const child = delegatedChild('child', newCard.id);
      await seedActiveSidecar(
        store,
        'chat',
        [
          {
            message: delegatedChild('child', oldCard.id),
            anchor: activeAnchor(oldCard.id, 'a'),
          },
        ],
        1,
      );
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      const validAnchors: [string, ActiveRowAnchor][] = [
        [child.id, activeAnchor(newCard.id, 'a')],
      ];
      const write = {
        chatId: 'chat',
        kind: 'replace' as const,
        messages: [message('a'), newCard, child],
        activeTailCount: 1,
        anchors: validAnchors,
      };
      await expect(
        interrupted.commit(expectedRevision, next, [write]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared replacement');
      const writeRecord = pending.writes[0];
      const changedPayload = [
        message('a'),
        delegatedChild('child', oldCard.id),
      ];
      const payloadPath = join(
        store.directory,
        'pending-transcripts',
        String(pending.transactionId),
        '0.jsonl',
      );
      await writeFile(
        payloadPath,
        `${changedPayload.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
      Reflect.set(writeRecord, 'count', changedPayload.length);
      Reflect.set(
        writeRecord,
        'sha256',
        createHash('sha256')
          .update(changedPayload.map((row) => JSON.stringify(row)).join('\n'))
          .update('\n')
          .digest('hex'),
      );
      Reflect.set(writeRecord, 'anchors', [
        ['child', activeAnchor(oldCard.id, 'a')],
      ]);
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);
      const beforeLog = await readFile(logPath());
      const beforeSidecar = await readFile(anchorPath());
      const beforeJournal = await readFile(journalPath());

      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        /anchor|run|card/i,
      );
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(anchorPath())).toEqual(beforeSidecar);
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });

    it('rejects malformed WAL anchors during recovery without mutating files', async () => {
      const { child } = await seedAnchoredChat();
      const interrupted = new ChatStorageTransactions(
        store,
        (point) =>
          point === 'journal'
            ? Promise.reject(new Error('interrupt after WAL publish'))
            : Promise.resolve(),
        { retainedPayloadBytes: 0 },
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'active', messages: [child] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared active write');
      Reflect.set(pending.writes[0], 'anchors', [
        ['child', { version: 1, runId: 'card', after: 'a', tie: 0.5 }],
      ]);
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);
      const beforeSidecar = await readFile(anchorPath());
      const beforeLog = await readFile(logPath());
      const beforeIndex = await readFile(
        join(store.directory, 'live-index.json'),
      );
      const beforeJournal = await readFile(journalPath());

      await expect(
        new ChatStorageTransactions(store, undefined, {
          retainedPayloadBytes: 0,
        }).load(),
      ).rejects.toThrow(/anchor|tuple/i);
      expect(await readFile(anchorPath())).toEqual(beforeSidecar);
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(join(store.directory, 'live-index.json'))).toEqual(
        beforeIndex,
      );
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });

    it('rejects WAL anchors with invalid active/card context during recovery', async () => {
      const { child } = await seedAnchoredChat();
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'active', messages: [child] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared active write');
      Reflect.set(pending.writes[0], 'anchors', [
        ['child', activeAnchor('missing-card', 'missing-predecessor')],
      ]);
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);
      const beforeSidecar = await readFile(anchorPath());
      const beforeLog = await readFile(logPath());
      const beforeJournal = await readFile(journalPath());

      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        /anchor|run|card|predecessor/i,
      );
      expect(await readFile(anchorPath())).toEqual(beforeSidecar);
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });

    // The exact 16 MiB UTF-8 boundary fixture takes longer than Jest's 5 s default.
    it('rejects an over-budget finalizing anchor record during recovery before any durable effects', async () => {
      const delegationId = '🌲"\\'.repeat(123);
      const card = delegatedCard(delegationId);
      const transaction = new ChatStorageTransactions(store);
      await commitDelegationCard(transaction, card);
      const predecessor = message('🌲"\\'.repeat(128));
      const withPredecessor = await transaction.load();
      const predecessorRevision = nextRevision(withPredecessor);
      await transaction.commit(predecessorRevision, withPredecessor, [
        { chatId: 'chat', kind: 'append', messages: [predecessor] },
      ]);
      const rowAnchor = activeAnchor(card.id, predecessor.id);
      const child = exactBudgetMessage(
        'overflow-child',
        rowAnchor,
        true,
        MAX_TRANSCRIPT_ROW_BYTES + 1025,
      );
      expect(
        activeSidecarMessageRecordBytes({
          version: 2,
          kind: 'message',
          message: child,
          anchor: rowAnchor,
          finalizing: true,
        }),
      ).toBe(MAX_TRANSCRIPT_ROW_BYTES + 1025);
      expect(
        activeSidecarMessageRecordBytes({
          version: 2,
          kind: 'message',
          message: child,
          anchor: rowAnchor,
          finalizing: true,
        }) -
          activeSidecarMessageRecordBytes({
            version: 2,
            kind: 'message',
            message: child,
          }),
      ).toBeGreaterThan(1024);
      expect(
        Buffer.byteLength(JSON.stringify(child), 'utf8'),
      ).toBeLessThanOrEqual(MAX_TRANSCRIPT_ROW_BYTES);

      const interrupted = new ChatStorageTransactions(
        store,
        (point) =>
          point === 'journal'
            ? Promise.reject(new Error('interrupt after WAL publish'))
            : Promise.resolve(),
        { retainedPayloadBytes: 0 },
      );
      const next = await interrupted.load();
      const expectedRevision = nextRevision(next);
      await expect(
        interrupted.commit(expectedRevision, next, [
          { chatId: 'chat', kind: 'append', messages: [child] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');

      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared append');
      Reflect.set(pending.writes[0], 'anchors', [[child.id, rowAnchor]]);
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);

      const beforeLog = await readFile(logPath());
      const beforeLiveIndex = await readFile(
        join(store.directory, 'live-index.json'),
      );
      const beforeArchiveIndex = await readFile(
        join(store.directory, 'archive-index.json'),
      );
      const beforeRecoveryIndex = await readFile(
        join(store.directory, 'recovery-index.json'),
      );
      const beforeJournal = await readFile(journalPath());

      await expect(
        new ChatStorageTransactions(store, undefined, {
          retainedPayloadBytes: 0,
        }).load(),
      ).rejects.toThrow(/active.*row|sidecar.*size|budget/i);
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(join(store.directory, 'live-index.json'))).toEqual(
        beforeLiveIndex,
      );
      expect(
        await readFile(join(store.directory, 'archive-index.json')),
      ).toEqual(beforeArchiveIndex);
      expect(
        await readFile(join(store.directory, 'recovery-index.json')),
      ).toEqual(beforeRecoveryIndex);
      await expect(stat(anchorPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    }, 30_000);

    it('rejects recovery effect kinds outside the durable transcript-effect set', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      next.live.revision = next.archive.revision = 1;
      await expect(
        interrupted.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: [message('b')] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared write');
      Reflect.set(pending.writes[0], 'kind', 'unknown-effect');
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);
      const beforeLog = await readFile(logPath());
      const beforeIndex = await readFile(
        join(store.directory, 'live-index.json'),
      );
      const beforeJournal = await readFile(journalPath());

      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        /journal|effect/i,
      );
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(join(store.directory, 'live-index.json'))).toEqual(
        beforeIndex,
      );
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });

    it('rejects duplicate per-chat transcript effects in recovery before replay', async () => {
      const interrupted = new ChatStorageTransactions(store, (point) =>
        point === 'journal'
          ? Promise.reject(new Error('interrupt after WAL publish'))
          : Promise.resolve(),
      );
      const next = await interrupted.load();
      next.live.revision = next.archive.revision = 1;
      await expect(
        interrupted.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: [message('b')] },
        ]),
      ).rejects.toThrow('interrupt after WAL publish');
      const pending = await readPending();
      if (!Array.isArray(pending.writes) || !isRecord(pending.writes[0]))
        throw new Error('Missing prepared write');
      const transactionId = pending.transactionId;
      if (typeof transactionId !== 'string')
        throw new Error('Missing pending transaction ID');
      await writeFile(
        join(store.directory, 'pending-transcripts', transactionId, '1.jsonl'),
        await readFile(
          join(
            store.directory,
            'pending-transcripts',
            transactionId,
            '0.jsonl',
          ),
        ),
      );
      pending.writes.push({ ...pending.writes[0] });
      await writeFile(journalPath(), `${JSON.stringify(pending)}\n`);
      const beforeLog = await readFile(logPath());
      const beforeIndex = await readFile(
        join(store.directory, 'live-index.json'),
      );
      const beforeJournal = await readFile(journalPath());

      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        /one transcript effect|duplicate/i,
      );
      expect(await readFile(logPath())).toEqual(beforeLog);
      expect(await readFile(join(store.directory, 'live-index.json'))).toEqual(
        beforeIndex,
      );
      expect(await readFile(journalPath())).toEqual(beforeJournal);
    });
  });

  it('validates prepared message bytes before replaying a durable journal', async () => {
    const transaction = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
      ]),
    ).rejects.toThrow('interrupt');
    const pending: unknown = JSON.parse(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    );
    if (!isRecord(pending) || typeof pending.transactionId !== 'string')
      throw new Error('Missing pending transaction id');
    await writeFile(
      join(
        store.directory,
        'pending-transcripts',
        pending.transactionId,
        '0.jsonl',
      ),
      JSON.stringify(message('wrong')) + '\n',
    );
    await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
      'integrity',
    );
    expect((await store.indexes()).live.revision).toBe(0);
  });

  describe('work counters', () => {
    const readIndex = async (name: string): Promise<string> =>
      readFile(join(store.directory, name), 'utf8');

    it('counts a metadata-only commit exactly', async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.tabs[0].title = 'Counted';
      next.live.revision = next.archive.revision = 1;
      resetWorkCounters();

      await transaction.commit(0, next, []);

      const live = await readIndex('live-index.json');
      const archive = await readIndex('archive-index.json');
      const recovery = await readIndex('recovery-index.json');
      const parsed = (text: string): unknown => JSON.parse(text);
      // The cleared journal held one record: the three whole indexes and the
      // transaction id. Clearing it writes no bytes.
      const journal =
        Buffer.byteLength(
          JSON.stringify({
            v: 2,
            transactionId: '00000000-0000-4000-8000-000000000000',
            expectedRevision: 0,
            indexes: {
              live: parsed(live),
              archive: parsed(archive),
              recovery: parsed(recovery),
            },
            writes: [],
          }),
        ) + 1;
      expect(snapshotWorkCounters().chatStorage).toEqual({
        commits: 1,
        // The journal record and each of the three index files.
        indexSerializations: 6,
        // Journal publish, three index renames, journal clear.
        atomicReplacements: 5,
        'syncs.file': 5,
        // After the journal, after the indexes, after the journal clear.
        'syncs.directory': 3,
        'serialized.journal.bytes': journal,
        'written.journal.bytes': journal,
        'serialized.liveIndex.bytes': Buffer.byteLength(live),
        'written.liveIndex.bytes': Buffer.byteLength(live),
        'serialized.archiveIndex.bytes': Buffer.byteLength(archive),
        'written.archiveIndex.bytes': Buffer.byteLength(archive),
        'serialized.recoveryIndex.bytes': Buffer.byteLength(recovery),
        'written.recoveryIndex.bytes': Buffer.byteLength(recovery),
      });
    });

    it('attributes payload, staging, transcript, and artifact bytes by file class', async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      const transcript = join(store.directory, 'transcripts', 'chat.jsonl');
      const before = (await stat(transcript)).size;
      const output = 'counted output 🌲\n'.repeat(8000);
      resetWorkCounters();

      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('b', output)],
        },
      ]);

      const appended = (await stat(transcript)).size - before;
      const artifact = await stat(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          artifactName(output),
        ),
      );
      const counters = snapshotWorkCounters().chatStorage;
      expect(counters).toMatchObject({
        commits: 1,
        artifactsPublished: 1,
        // The prepared payload and the staged append hold the same rows the
        // log grew by; the log itself is extended by copying staged bytes.
        'serialized.payload.bytes': appended,
        'written.payload.bytes': appended,
        'serialized.appendStaging.bytes': appended,
        'written.appendStaging.bytes': appended,
        'written.transcript.bytes': appended,
        'written.artifact.bytes': artifact.size,
      });
      expect(counters['serialized.transcript.bytes']).toBeUndefined();
      expect(counters['serialized.artifact.bytes']).toBeUndefined();
      expect(counters['syncs.file']).toBeGreaterThan(5);
      expect(counters['syncs.directory']).toBeGreaterThan(3);
    });
  });
});
