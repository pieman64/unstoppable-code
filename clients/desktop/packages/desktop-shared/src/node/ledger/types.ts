import type {
  LedgerActorKind,
  LedgerActorRef,
  LedgerAddEntryParams,
  LedgerAttribution,
  LedgerAttributionKind,
  LedgerAuthorDetails,
  LedgerCommandReceipt,
  LedgerContainer,
  LedgerEntriesSearchResult,
  LedgerEntry,
  LedgerEntryType,
  LedgerMutation,
  LedgerGlobalOwner,
  LedgerOrigin,
  LedgerPublishSummaryParams,
  LedgerScopeRef,
  LedgerSourceKind,
  LedgerSearchSort,
  LedgerSourceAvailability,
  LedgerStatus,
  LedgerUpdateEntryParams,
  LedgerRootChatFilter,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerScopeAudience,
  LedgerSyncEventKind,
} from '@canopy/protocol/ledger-sync';

export const LEDGER_SCOPE_LIFECYCLE_STATES = [
  'active',
  'archived',
  'retirement_pending',
] as const;

/**
 * `active` scopes accept ordinary writes. `archived` scopes are read-only to
 * ordinary commands but accept session-end handbacks; `retirement_pending`
 * scopes await purge and reject writes. `lifecycle.ts` holds the transitions.
 */
export type LedgerScopeLifecycleState =
  (typeof LEDGER_SCOPE_LIFECYCLE_STATES)[number];

/** Operations that run as one `BEGIN IMMEDIATE` command transaction. */
export type LedgerStoreOperation =
  | 'bindScope'
  | 'bindGlobalScope'
  | 'registerActor'
  | 'addEntry'
  | 'updateEntry'
  | 'handBackEntry'
  | 'publishSummary'
  | 'recordPendingTitleAttempt'
  | 'resolvePendingTitle'
  | 'setScopeLifecycle'
  | 'rebindScope'
  | 'purgeScope'
  | 'acknowledgeOutbox'
  | 'recordMirrorAudience'
  | 'setScopeRepair'
  | 'rebindAccount';

export interface LedgerCommitHookContext {
  readonly operation: LedgerStoreOperation;
}

export interface LedgerRepositoryOptions {
  /** Database file, normally `<dataDir>/ledger/ledger.sqlite`. */
  readonly databasePath: string;
  /** Clock for entry, receipt and cursor times. Defaults to `new Date()`. */
  readonly now?: () => Date;
  /** UUID source for ledger, actor, entry, mutation and event IDs. */
  readonly randomUUID?: () => string;
  /**
   * How long opening may wait for another connection to release the database,
   * so a relaunch can outlast a quitting instance. Applies only while taking
   * the lock at open; afterwards the busy timeout is zero. Defaults to 2000.
   */
  readonly openBusyTimeoutMs?: number;
  /**
   * Test-only fault injection. Runs inside every command transaction after
   * all of its writes and immediately before `COMMIT`; throwing rolls the
   * whole command back. Production callers must not set it.
   */
  readonly beforeCommit?: (context: LedgerCommitHookContext) => void;
}

/** Schema state found at open. */
export interface LedgerSchemaStatus {
  /** Schema version recorded in the database. */
  readonly version: number;
  /** True when the database is newer than this build; every write fails. */
  readonly readOnly: boolean;
}

export interface LedgerScopeRecord {
  readonly scope: LedgerScopeRef;
  /** Canonical UTC form of the container's creation time. */
  readonly containerCreatedAt: string;
  /** Account registered at first use; null when first used signed out. */
  readonly accountId: string | null;
  readonly lifecycleState: LedgerScopeLifecycleState;
  /** Current scope sequence as a decimal string. */
  readonly sequence: string;
  readonly createdAt: string;
}

export interface LedgerBindScopeInput {
  readonly authorityId: string;
  readonly container: LedgerContainer;
  /** The container's own creation time (RFC 3339). */
  readonly containerCreatedAt: string;
  /** Signed-in account at first use; ignored when the scope already exists. */
  readonly accountId: string | null;
}

export interface LedgerBindScopeResult {
  readonly scope: LedgerScopeRecord;
  readonly created: boolean;
}

export interface LedgerFindScopeInput {
  readonly container: LedgerContainer;
  readonly containerCreatedAt: string;
}

/**
 * Identifies one global Ledger: an owner's, for one account. The account is
 * part of the identity, so two accounts never share a global Ledger.
 */
export interface LedgerFindGlobalScopeInput {
  readonly owner: LedgerGlobalOwner;
  /** The signed-in account; null for signed-out use, its own Ledger. */
  readonly accountId: string | null;
}

export interface LedgerBindGlobalScopeInput extends LedgerFindGlobalScopeInput {
  readonly authorityId: string;
}

export interface LedgerSetScopeLifecycleInput {
  readonly ledgerId: string;
  /** `archived`, `active` again after an archive, or `retirement_pending`. */
  readonly state: LedgerScopeLifecycleState;
}

export interface LedgerRebindScopeInput {
  /** An `archived` scope. */
  readonly ledgerId: string;
  /** The restored container, of the same kind as the scope's current one. */
  readonly container: LedgerContainer;
  /** The restored container's own creation time (RFC 3339). */
  readonly containerCreatedAt: string;
}

export interface LedgerPurgeScopeResult {
  /** False when no scope with that ID existed. */
  readonly purged: boolean;
}

export interface LedgerActorRecord {
  readonly actor: LedgerActorRef;
  readonly ledgerId: string;
  /** Stable host origin locator, unique within the ledger. */
  readonly originKey: string;
  /** Display snapshot captured at registration. */
  readonly displayName: string;
  readonly createdAt: string;
}

export interface LedgerRegisterActorInput {
  readonly ledgerId: string;
  readonly kind: LedgerActorKind;
  readonly authorityId: string;
  readonly originKey: string;
  readonly displayName: string;
}

export interface LedgerRegisterActorResult {
  readonly actor: LedgerActorRecord;
  readonly created: boolean;
}

export interface LedgerAddEntryInput {
  readonly ledgerId: string;
  /** The caller's effective actor; must equal `attribution.effectiveActor`. */
  readonly author: LedgerActorRef;
  readonly authorDetails: LedgerAuthorDetails;
  readonly origin: LedgerOrigin;
  readonly attribution: LedgerAttribution;
  /**
   * Owner resolved by the host. When `params.owner` is omitted or `'self'` it
   * must be the author; otherwise it must be the actor named in
   * `params.owner`.
   */
  readonly owner: LedgerActorRef;
  /**
   * The host's eligibility verdict for an explicit owner (for example, its
   * eligibility-token check). Defaults to true. The store applies it after
   * the receipt lookup, and only when the owner is not the author, so an exact
   * replay still returns its receipt after the token has gone stale.
   */
  readonly ownerEligible?: boolean;
  readonly params: LedgerAddEntryParams;
  /** Scoped by ledger, `attribution.recordedBy` and operation. */
  readonly idempotencyKey: string;
}

export interface LedgerUpdateEntryInput {
  readonly ledgerId: string;
  /** `effectiveActor` is the acting identity; `recordedBy` is the caller. */
  readonly attribution: LedgerAttribution;
  /** Where this mutation was invoked from, recorded in its history. */
  readonly invocationOrigin: LedgerOrigin;
  readonly params: LedgerUpdateEntryParams;
  /**
   * Owner resolved by the host: required exactly when `params.owner` is
   * present (`'self'` resolves to the effective actor).
   */
  readonly newOwner: LedgerActorRef | null;
  /**
   * The host's eligibility verdict for `newOwner`. Defaults to true. Applied
   * after the receipt lookup and the revision, terminal and permission checks,
   * and only when the owner actually changes.
   */
  readonly ownerEligible?: boolean;
  /** Host-resolved owner actors for this chat's managed delegation subtree. */
  readonly delegateOwnerActorIds?: readonly string[];
  /** User UI only: may update any open entry, not just its own. */
  readonly mayUpdateAnyOpenEntry: boolean;
  /** Scoped by ledger, `attribution.recordedBy` and operation. */
  readonly idempotencyKey: string;
}

/** Bounded actor set used to read one managed delegation's work summary. */
export interface LedgerWorkSummaryInput {
  readonly ledgerId: string;
  readonly actorIds: readonly string[];
}

/**
 * Store-internal ownership handback after an actor session ends. The store
 * derives the system attribution from registered actors and records the
 * reason on the resulting mutation.
 */
export interface LedgerHandBackEntryInput {
  readonly ledgerId: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly endedActorId: string;
  readonly newOwner: LedgerActorRef;
  /** The actor transition's time fence; later entry revisions are not handed back. */
  readonly transitionAt: string;
  readonly reason: NonNullable<LedgerMutation['leftOpen']>;
  readonly idempotencyKey: string;
}

/** Another entry revised in the same transaction as a command's entry. */
export interface LedgerRelatedEntryChange {
  readonly entryId: string;
  readonly revision: number;
}

/**
 * A command's receipt as the store returns it. `relatedChanges` lists, in
 * commit order, the other entries the command revised (close cascades and
 * operation auto-start); it is absent when there are none and on replays.
 * It is store-internal: the host announces those changes and strips the
 * field, so callers only ever see the protocol `LedgerCommandReceipt`.
 */
export type LedgerStoreCommandReceipt = LedgerCommandReceipt & {
  readonly relatedChanges?: readonly LedgerRelatedEntryChange[];
};

export interface LedgerPublishSummaryInput {
  readonly ledgerId: string;
  /** The generating helper invocation (kind `background`); author and owner. */
  readonly helper: LedgerActorRef;
  /** Helper details captured before the provider was invoked. */
  readonly helperDetails: LedgerAuthorDetails;
  readonly params: LedgerPublishSummaryParams;
  /** Normally `summary:<ledgerId>:<snapshotId>`. */
  readonly idempotencyKey: string;
}

export interface LedgerListReceiptKeysInput {
  readonly ledgerId: string;
  /** A command operation, such as `core.ledger.summary.publish`. */
  readonly operation: string;
  /** At most `LEDGER_RECEIPT_KEYS_MAX` idempotency keys. */
  readonly idempotencyKeys: readonly string[];
}

/**
 * Resolves where an entry's source can be opened. It runs synchronously after
 * the page is read, never inside a transaction. When omitted, every result
 * reports `'available'` and the host is expected to overwrite it.
 */
export type LedgerSourceAvailabilityResolver = (
  entry: LedgerEntry,
) => LedgerSourceAvailability;

export interface LedgerGetEntryInput {
  readonly ledgerId: string;
  readonly entryId: string;
  /** Include a page of mutation history, oldest first. */
  readonly includeHistory?: boolean;
  readonly historyLimit?: number;
  /** Continues a history page; implies `includeHistory`. */
  readonly historyCursor?: string;
  readonly resolveSourceAvailability?: LedgerSourceAvailabilityResolver;
}

/** A local marker that an entry's provisional title still needs generation. */
export interface LedgerPendingTitleRecord {
  readonly entryId: string;
  readonly ledgerId: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
}

export interface LedgerRecordPendingTitleAttemptInput {
  readonly entryId: string;
}

export interface LedgerResolvePendingTitleInput {
  readonly entryId: string;
  readonly title: string | null;
}

export interface LedgerResolvePendingTitleResult {
  readonly resolved: boolean;
  readonly entry: LedgerEntry | null;
}

/**
 * Search filters with `'self'` already resolved to actor IDs by the caller.
 * Omitted filters mean all values; supplied arrays must be non-empty.
 */
export interface LedgerSearchEntriesInput {
  readonly ledgerId: string;
  /** Internal store-only owner set; omitted means unrestricted, empty means no matches. */
  readonly ownerIn?: readonly string[];
  /** Internal store-only filter for every non-terminal status. */
  readonly openOnly?: true;
  /** Literal, case-insensitive words, each matching the start of a word; all must match. */
  readonly query?: string;
  readonly entryIds?: readonly string[];
  readonly ownerActorId?: string;
  readonly authorActorId?: string;
  /** Parent id; `null` selects top-level entries. */
  readonly parentEntryId?: string | null;
  /** Top-level root whose membership contains the entry at the snapshot. */
  readonly rootEntryId?: string;
  /** Match any of these authors, resolved to actor IDs by the caller. */
  readonly authorIn?: readonly string[];
  /** Match entries whose source resolves to one of these kinds. */
  readonly sourceKinds?: readonly LedgerSourceKind[];
  /** Work from one line of agents (the Feed panel's root chat filter). */
  readonly rootChat?: LedgerRootChatFilter;
  /**
   * Internal store-only owners under `rootChat.chatId`, resolved by the
   * caller: without `rootOnly`, an entry any of them owns matches too.
   */
  readonly rootChatOwnerIn?: readonly string[];
  readonly types?: readonly LedgerEntryType[];
  readonly statuses?: readonly LedgerStatus[];
  /** Creation attribution kinds. */
  readonly attribution?: readonly LedgerAttributionKind[];
  /** Inclusive lower bound (RFC 3339). */
  readonly createdAfter?: string;
  /** Exclusive upper bound (RFC 3339). */
  readonly createdBefore?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly sort?: LedgerSearchSort;
  readonly limit?: number;
  readonly cursor?: string;
  readonly resolveSourceAvailability?: LedgerSourceAvailabilityResolver;
}

/**
 * The protocol search result without the host-owned owner candidates, with
 * each entry's origin: provenance a search item leaves out, which the host
 * needs to say where the entry's source opens.
 */
export type LedgerSearchEntriesResult = Omit<
  LedgerEntriesSearchResult,
  'owners'
> & {
  /** One origin per entry, in the order of `entries`. */
  readonly origins: readonly LedgerOrigin[];
};

export interface LedgerListChangesInput {
  readonly ledgerId: string;
  /** Decimal scope sequence; changes strictly after it are returned. */
  readonly afterSequence: string;
  readonly limit?: number;
}

/**
 * Why a scope stopped syncing until it is repaired. Each names what the
 * mirror refused, never an entry.
 */
export const LEDGER_SYNC_REPAIR_REASONS = [
  /** Another writer session registered the scope. */
  'stale_writer',
  /** The mirror holds less than this device saw acknowledged. */
  'sequence_gap',
  /** The mirror holds another event where this device sent one. */
  'divergent_event',
  /** The mirror refused an event's order or content. */
  'illegal_event',
  /** The mirror refused the request itself. */
  'invalid_request',
  /** The mirror holds events this device never wrote. */
  'mirror_ahead',
] as const;

export type LedgerSyncRepairReason =
  (typeof LEDGER_SYNC_REPAIR_REASONS)[number];

/** A scope and how far its sync has come. */
export interface LedgerScopeSyncRecord {
  readonly scope: LedgerScopeRecord;
  /** Highest scope sequence the mirror acknowledged, as a decimal string. */
  readonly acknowledgedSequence: string;
  /** The audience the mirror last confirmed; null before any registration. */
  readonly mirrorAudience: LedgerScopeAudience | null;
  readonly audienceConfirmedAt: string | null;
  readonly repairReason: LedgerSyncRepairReason | null;
}

/** One replication event still in the outbox. */
export interface LedgerOutboxEventRecord {
  readonly eventId: string;
  /** Decimal scope sequence. */
  readonly scopeSequence: string;
  readonly kind: LedgerSyncEventKind;
  readonly entryId: string | null;
  readonly entryRevision: number | null;
  readonly occurredAt: string;
  /** SHA-256 of `payloadJson`. */
  readonly payloadHash: string;
  /** The payload as canonical JSON text. */
  readonly payloadJson: string;
}

export interface LedgerReadOutboxInput {
  readonly ledgerId: string;
  /** Decimal scope sequence; events strictly after it are returned. */
  readonly afterSequence: string;
  /** At most the mirror's batch size. */
  readonly limit: number;
  /**
   * UTF-8 bytes of payload the batch may hold. The first event is returned
   * whatever its size.
   */
  readonly maxPayloadBytes?: number;
}

export interface LedgerAcknowledgeOutboxInput {
  readonly ledgerId: string;
  /** The decimal scope sequence the mirror acknowledged. */
  readonly sequence: string;
}

export interface LedgerRecordMirrorAudienceInput {
  readonly ledgerId: string;
  /** The audience the mirror answered a registration with. */
  readonly audience: LedgerScopeAudience;
}

export interface LedgerSetScopeRepairInput {
  readonly ledgerId: string;
  /** Null once the scope syncs again. */
  readonly reason: LedgerSyncRepairReason | null;
}

/**
 * A server-confirmed merge of a guest account into another account. Signed-out
 * use has no account, so a merge never moves it (LD02).
 */
export interface LedgerRebindAccountInput {
  readonly fromAccountId: string;
  readonly toAccountId: string;
}

export interface LedgerRebindAccountResult {
  /**
   * Scopes that were bound to `fromAccountId`. Global Ledgers count once each,
   * whether their binding moved or gave way to the destination's.
   */
  readonly rebound: number;
}

/** Content-free row counts for health diagnostics and tests. */
export interface LedgerStorageCounts {
  readonly scopes: number;
  readonly actors: number;
  readonly entries: number;
  readonly entryVersions: number;
  readonly mutations: number;
  readonly receipts: number;
  readonly outbox: number;
  readonly searchRows: number;
}
