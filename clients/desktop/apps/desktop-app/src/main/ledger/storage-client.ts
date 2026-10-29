import type {
  LedgerActorRecord,
  LedgerBindScopeResult,
  LedgerOutboxEventRecord,
  LedgerPendingTitleRecord,
  LedgerRebindAccountResult,
  LedgerRegisterActorResult,
  LedgerResolvePendingTitleResult,
  LedgerScopeRecord,
  LedgerScopeSyncRecord,
  LedgerSearchEntriesResult,
  LedgerStorageCounts,
} from '@canopy/desktop-shared/node/ledger';
// Only the constants: the store itself runs in the storage worker.
import {
  LEDGER_SCOPE_LIFECYCLE_STATES,
  LEDGER_SYNC_REPAIR_REASONS,
} from '@canopy/desktop-shared/node/ledger/types';
import {
  LEDGER_LIMITS,
  LedgerActorRefSchema,
  LedgerChangesListResultSchema,
  LedgerCommandReceiptSchema,
  LedgerDisplayNameSchema,
  LedgerEntriesSearchResultSchema,
  LedgerEntryGetResultSchema,
  LedgerEntrySchema,
  LedgerOpaqueIdSchema,
  LedgerOriginSchema,
  LedgerScopeRefSchema,
  LedgerSequenceSchema,
  LedgerTimestampSchema,
  LedgerUuidSchema,
  type CanopyJsonValue,
  type LedgerChangesListResult,
  type LedgerCommandReceipt,
  type LedgerEntryGetResult,
} from '@canopy/protocol/canopy-core';
import {
  LedgerScopeAudienceSchema,
  LedgerSyncEventKindSchema,
} from '@canopy/protocol/ledger-sync';
import { z } from 'zod';
import type {
  LedgerStorageClient,
  LedgerStorePurgeScopeResult,
} from './ledger-store-client';
import {
  getLedgerStorageHost,
  LedgerStorageHostError,
  type LedgerStorageHost,
} from './storage-host';
import type {
  LedgerStorageArguments,
  LedgerStorageMethod,
} from './storage-worker-contract';

/*
 * Results cross a thread boundary as structured clones, so each one is parsed
 * before it is returned: protocol-shaped results with the protocol schemas,
 * the store-only records with the schemas below. Parsing also rebuilds every
 * object in this realm.
 */

const UNEXPECTED_RESULT_MESSAGE =
  'Ledger storage returned an unexpected result';

/** The store's writer authority: a lowercase UUID minted with the database. */
const AuthorityIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const ScopeRecordSchema: z.ZodType<LedgerScopeRecord> = z.strictObject({
  scope: LedgerScopeRefSchema,
  containerCreatedAt: LedgerTimestampSchema,
  accountId: LedgerOpaqueIdSchema.nullable(),
  lifecycleState: z.enum(LEDGER_SCOPE_LIFECYCLE_STATES),
  sequence: LedgerSequenceSchema,
  createdAt: LedgerTimestampSchema,
});

const ActorRecordSchema: z.ZodType<LedgerActorRecord> = z.strictObject({
  actor: LedgerActorRefSchema,
  ledgerId: LedgerUuidSchema,
  originKey: z.string().min(1),
  displayName: LedgerDisplayNameSchema,
  createdAt: LedgerTimestampSchema,
});

const ScopeRecordListSchema = z.array(ScopeRecordSchema);

const BindScopeResultSchema: z.ZodType<LedgerBindScopeResult> = z.strictObject({
  scope: ScopeRecordSchema,
  created: z.boolean(),
});

const PurgeScopeResultSchema: z.ZodType<LedgerStorePurgeScopeResult> =
  z.strictObject({ purged: z.boolean() });

const RegisterActorResultSchema: z.ZodType<LedgerRegisterActorResult> =
  z.strictObject({ actor: ActorRecordSchema, created: z.boolean() });

const PendingTitleRecordSchema: z.ZodType<LedgerPendingTitleRecord> =
  z.strictObject({
    entryId: LedgerUuidSchema,
    ledgerId: LedgerUuidSchema,
    createdAt: LedgerTimestampSchema,
    attempts: z.int().min(0),
    lastAttemptAt: LedgerTimestampSchema.nullable(),
  });

const ResolvePendingTitleResultSchema: z.ZodType<LedgerResolvePendingTitleResult> =
  z.strictObject({
    resolved: z.boolean(),
    entry: LedgerEntrySchema.nullable(),
  });

const ScopeSyncRecordSchema: z.ZodType<LedgerScopeSyncRecord> = z.strictObject({
  scope: ScopeRecordSchema,
  acknowledgedSequence: LedgerSequenceSchema,
  mirrorAudience: LedgerScopeAudienceSchema.nullable(),
  audienceConfirmedAt: LedgerTimestampSchema.nullable(),
  repairReason: z.enum(LEDGER_SYNC_REPAIR_REASONS).nullable(),
});

const OutboxEventRecordSchema: z.ZodType<LedgerOutboxEventRecord> =
  z.strictObject({
    eventId: LedgerUuidSchema,
    scopeSequence: LedgerSequenceSchema,
    kind: LedgerSyncEventKindSchema,
    entryId: LedgerUuidSchema.nullable(),
    entryRevision: z.int().min(1).nullable(),
    occurredAt: LedgerTimestampSchema,
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    payloadJson: z.string().min(2),
  });

const RebindAccountResultSchema: z.ZodType<LedgerRebindAccountResult> =
  z.strictObject({ rebound: z.int().min(0) });

const RowCountSchema = z.int().min(0);

const StorageCountsSchema: z.ZodType<LedgerStorageCounts> = z.strictObject({
  scopes: RowCountSchema,
  actors: RowCountSchema,
  entries: RowCountSchema,
  entryVersions: RowCountSchema,
  mutations: RowCountSchema,
  receipts: RowCountSchema,
  outbox: RowCountSchema,
  searchRows: RowCountSchema,
});

/**
 * The protocol search result without the host-owned owner candidates, with
 * each entry's origin beside it.
 */
const SearchEntriesResultSchema: z.ZodType<LedgerSearchEntriesResult> =
  LedgerEntriesSearchResultSchema.omit({ owners: true }).extend({
    origins: z.array(LedgerOriginSchema).max(LEDGER_LIMITS.searchPageMax),
  });

function invalidResult(
  method: LedgerStorageMethod,
  error: z.ZodError,
): LedgerStorageHostError {
  // Issue paths name fields and indexes only, never stored values.
  const field = (error.issues[0]?.path ?? []).map(String).join('.');
  const details: CanopyJsonValue =
    field.length > 0 ? { method, field } : { method };
  return new LedgerStorageHostError(
    'INTERNAL',
    UNEXPECTED_RESULT_MESSAGE,
    details,
  );
}

/**
 * A `LedgerStorageClient` over a storage host. Each call runs in the host's
 * worker, which starts on the first call, not when the client is created.
 * Arguments travel as the positional array `storage-worker-contract.ts`
 * defines, and every result is validated before it is returned: a result that
 * does not match rejects with `LedgerStorageHostError('INTERNAL', …)`.
 */
export function createWorkerLedgerStoreClient(
  host: LedgerStorageHost,
): LedgerStorageClient {
  async function call<Method extends LedgerStorageMethod, Result>(
    method: Method,
    args: LedgerStorageArguments[Method],
    schema: z.ZodType<Result>,
  ): Promise<Result> {
    const parsed = schema.safeParse(await host.call(method, args));
    if (!parsed.success) throw invalidResult(method, parsed.error);
    return parsed.data;
  }

  return {
    getAuthorityId: (): Promise<string> =>
      call('getAuthorityId', [], AuthorityIdSchema),
    bindScope: (input): Promise<LedgerBindScopeResult> =>
      call('bindScope', [input], BindScopeResultSchema),
    findScope: (input): Promise<LedgerScopeRecord | null> =>
      call('findScope', [input], ScopeRecordSchema.nullable()),
    getScope: (ledgerId): Promise<LedgerScopeRecord | null> =>
      call('getScope', [ledgerId], ScopeRecordSchema.nullable()),
    registerActor: (input): Promise<LedgerRegisterActorResult> =>
      call('registerActor', [input], RegisterActorResultSchema),
    listActors: (ledgerId): Promise<LedgerActorRecord[]> =>
      call('listActors', [ledgerId], z.array(ActorRecordSchema)),
    addEntry: (input): Promise<LedgerCommandReceipt> =>
      call('addEntry', [input], LedgerCommandReceiptSchema),
    listPendingTitles: (): Promise<LedgerPendingTitleRecord[]> =>
      call('listPendingTitles', [], z.array(PendingTitleRecordSchema)),
    recordPendingTitleAttempt: (
      input,
    ): Promise<LedgerPendingTitleRecord | null> =>
      call(
        'recordPendingTitleAttempt',
        [input],
        PendingTitleRecordSchema.nullable(),
      ),
    resolvePendingTitle: (input): Promise<LedgerResolvePendingTitleResult> =>
      call('resolvePendingTitle', [input], ResolvePendingTitleResultSchema),
    updateEntry: (input): Promise<LedgerCommandReceipt> =>
      call('updateEntry', [input], LedgerCommandReceiptSchema),
    publishSummary: (input): Promise<LedgerCommandReceipt> =>
      call('publishSummary', [input], LedgerCommandReceiptSchema),
    listReceiptKeys: (input): Promise<string[]> =>
      call('listReceiptKeys', [input], z.array(z.string())),
    getEntry: (input): Promise<LedgerEntryGetResult> =>
      call('getEntry', [input], LedgerEntryGetResultSchema),
    searchEntries: (input): Promise<LedgerSearchEntriesResult> =>
      call('searchEntries', [input], SearchEntriesResultSchema),
    listChanges: (input): Promise<LedgerChangesListResult> =>
      call('listChanges', [input], LedgerChangesListResultSchema),
    getStorageCounts: (): Promise<LedgerStorageCounts> =>
      call('getStorageCounts', [], StorageCountsSchema),
    listScopes: (): Promise<LedgerScopeRecord[]> =>
      call('listScopes', [], ScopeRecordListSchema),
    findContainerScopes: (container): Promise<LedgerScopeRecord[]> =>
      call('findContainerScopes', [container], ScopeRecordListSchema),
    setScopeLifecycle: (input): Promise<LedgerScopeRecord> =>
      call('setScopeLifecycle', [input], ScopeRecordSchema),
    rebindScope: (input): Promise<LedgerScopeRecord> =>
      call('rebindScope', [input], ScopeRecordSchema),
    purgeScope: (ledgerId): Promise<LedgerStorePurgeScopeResult> =>
      call('purgeScope', [ledgerId], PurgeScopeResultSchema),
    listSyncScopes: (): Promise<LedgerScopeSyncRecord[]> =>
      call('listSyncScopes', [], z.array(ScopeSyncRecordSchema)),
    getScopeSync: (ledgerId): Promise<LedgerScopeSyncRecord | null> =>
      call('getScopeSync', [ledgerId], ScopeSyncRecordSchema.nullable()),
    readOutbox: (input): Promise<LedgerOutboxEventRecord[]> =>
      call('readOutbox', [input], z.array(OutboxEventRecordSchema)),
    acknowledgeOutbox: (input): Promise<LedgerScopeSyncRecord> =>
      call('acknowledgeOutbox', [input], ScopeSyncRecordSchema),
    recordMirrorAudience: (input): Promise<LedgerScopeSyncRecord> =>
      call('recordMirrorAudience', [input], ScopeSyncRecordSchema),
    setScopeRepair: (input): Promise<LedgerScopeSyncRecord> =>
      call('setScopeRepair', [input], ScopeSyncRecordSchema),
    rebindAccount: (input): Promise<LedgerRebindAccountResult> =>
      call('rebindAccount', [input], RebindAccountResultSchema),
  };
}

let defaultClient: LedgerStorageClient | undefined;

/**
 * The app's Ledger store client, over the app's storage host. Getting it
 * starts nothing: the worker starts, and creates the database, on the first
 * call.
 */
export function getLedgerStoreClient(): LedgerStorageClient {
  defaultClient ??= createWorkerLedgerStoreClient(getLedgerStorageHost());
  return defaultClient;
}
